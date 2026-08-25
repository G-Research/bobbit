import assert from "node:assert/strict";
import { describe, it } from "vitest";

interface CliArgs {
	basePath: string;
	[key: string]: unknown;
}

interface StartupUrls {
	listenUrl: string;
	peerUrl: string;
	uiUrl: string;
	openUrl: string;
}

interface CliModule {
	hasVersionFlag(argv: string[]): boolean;
	parseArgs(argv: string[], env?: NodeJS.ProcessEnv): CliArgs;
	buildStartupUrls(options: {
		protocol: "http" | "https";
		host: string;
		port: number;
		basePath: string;
		token: string;
		forceAuth?: boolean;
	}): StartupUrls;
	formatStartupBanner(options: {
		version: string;
		cwd: string;
		staticDir?: string;
		token: string;
		urls: StartupUrls;
	}): string;
}

async function cliModule(): Promise<CliModule> {
	return await import("../../../src/server/cli.ts") as unknown as CliModule;
}

describe("version CLI selection", () => {
	it("recognizes the exact standalone version flag", async () => {
		const { hasVersionFlag } = await cliModule();
		assert.equal(hasVersionFlag(["--version"]), true);
	});

	it("recognizes a standalone version flag mixed with normal options", async () => {
		const { hasVersionFlag } = await cliModule();
		assert.equal(hasVersionFlag(["--no-ui", "--host", "127.0.0.1", "--version", "--auth"]), true);
	});

	it.each(["--host", "--port", "--cwd", "--static", "--agent-cli", "--base-path"])(
		"does not treat --version as the value of %s as a version flag",
		async (option) => {
			const { hasVersionFlag } = await cliModule();
			assert.equal(hasVersionFlag([option, "--version"]), false);
		},
	);

	it("leaves a malformed base-path value for parseArgs to reject", async () => {
		const { hasVersionFlag, parseArgs } = await cliModule();
		const argv = ["--base-path", "--version"];
		assert.equal(hasVersionFlag(argv), false);
		assert.throws(() => parseArgs(argv, {}), /base.path.*value|value.*base.path/i);
	});
});

describe("base-path CLI selection", () => {
	it("defaults to root when neither flag nor environment is present", async () => {
		const { parseArgs } = await cliModule();
		assert.equal(parseArgs([], {}).basePath, "");
	});

	it("uses and normalizes BOBBIT_BASE_PATH when no flag is present", async () => {
		const { parseArgs } = await cliModule();
		assert.equal(parseArgs([], { BOBBIT_BASE_PATH: "team/bobbit/" }).basePath, "/team/bobbit");
	});

	it("uses the last explicit flag by presence, even over an invalid environment value", async () => {
		const { parseArgs } = await cliModule();
		assert.equal(
			parseArgs(["--base-path", "/ignored", "--base-path", "/team/bobbit/"], { BOBBIT_BASE_PATH: "/../unsafe" }).basePath,
			"/team/bobbit",
		);
	});

	it.each(["", "/"])("lets an explicit %j flag reset a non-root environment mount", async (value) => {
		const { parseArgs } = await cliModule();
		assert.equal(parseArgs(["--base-path", value], { BOBBIT_BASE_PATH: "/from-env" }).basePath, "");
	});

	it("rejects a missing value and does not consume the next option as one", async () => {
		const { parseArgs } = await cliModule();
		assert.throws(() => parseArgs(["--base-path"], {}), /base.path.*value|value.*base.path/i);
		assert.throws(() => parseArgs(["--base-path", "--no-tls"], {}), /base.path.*value|value.*base.path/i);
	});

	it.each([
		[[], { BOBBIT_BASE_PATH: "/../unsafe" }],
		[["--base-path", "/a//b"], {}],
		[["--base-path", "https://host/bobbit"], {}],
	] as Array<[string[], NodeJS.ProcessEnv]>)("rejects the selected unsafe value", async (argv, env) => {
		const { parseArgs } = await cliModule();
		assert.throws(() => parseArgs(argv, env), /invalid.*base.path|base.path.*invalid/i);
	});
});

describe("mounted startup URLs", () => {
	it("uses the actual bound port and mounted loopback peer for a wildcard bind", async () => {
		const { buildStartupUrls } = await cliModule();
		const urls = buildStartupUrls({
			protocol: "http",
			host: "0.0.0.0",
			port: 43127,
			basePath: "/team/bobbit",
			token: "real token",
		});
		assert.equal(urls.listenUrl, "http://0.0.0.0:43127/team/bobbit");
		assert.equal(urls.peerUrl, "http://127.0.0.1:43127/team/bobbit");
		assert.equal(urls.uiUrl, "http://127.0.0.1:43127/team/bobbit/?token=real%20token");
		assert.equal(urls.openUrl, urls.uiUrl);
	});

	it("omits token query state when loopback authentication is disabled", async () => {
		const { buildStartupUrls } = await cliModule();
		const urls = buildStartupUrls({
			protocol: "http",
			host: "localhost",
			port: 3001,
			basePath: "/bobbit",
			token: "generated-but-unused",
		});
		assert.equal(urls.peerUrl, "http://localhost:3001/bobbit");
		assert.equal(urls.uiUrl, "http://localhost:3001/bobbit/");
		assert.equal(urls.openUrl, "http://localhost:3001/bobbit/");
		assert.doesNotMatch(urls.uiUrl, /[?&]token=/);
	});

	it("retains backward-compatible root URL shapes", async () => {
		const { buildStartupUrls } = await cliModule();
		const urls = buildStartupUrls({
			protocol: "https",
			host: "gateway.example",
			port: 443,
			basePath: "",
			token: "secret",
		});
		assert.equal(urls.listenUrl, "https://gateway.example:443");
		assert.equal(urls.peerUrl, "https://gateway.example:443");
		assert.equal(urls.uiUrl, "https://gateway.example:443/?token=secret");
	});
});

describe("truthful authentication banner", () => {
	it("does not display a generated token or secrecy warning when auth is disabled", async () => {
		const { buildStartupUrls, formatStartupBanner } = await cliModule();
		const urls = buildStartupUrls({
			protocol: "http",
			host: "localhost",
			port: 3001,
			basePath: "/bobbit",
			token: "must-not-appear",
		});
		const banner = formatStartupBanner({
			version: "0.0.0-test",
			cwd: "/workspace",
			staticDir: "/dist/ui",
			token: "must-not-appear",
			urls,
		});
		assert.doesNotMatch(banner, /must-not-appear|grants full shell access|keep it secret/i);
		assert.match(banner, /token authentication is disabled/i);
		assert.match(banner, /local process/i);
		assert.match(banner, /--auth/);
	});

	it("retains the token and secrecy warning when auth is enforced", async () => {
		const { buildStartupUrls, formatStartupBanner } = await cliModule();
		const urls = buildStartupUrls({
			protocol: "https",
			host: "gateway.example",
			port: 3001,
			basePath: "/team/bobbit",
			token: "real-secret",
		});
		const banner = formatStartupBanner({
			version: "0.0.0-test",
			cwd: "/workspace",
			staticDir: "/dist/ui",
			token: "real-secret",
			urls,
		});
		assert.match(banner, /real-secret/);
		assert.match(banner, /keep it secret|grants full shell access/i);
		assert.match(banner, /https:\/\/gateway\.example:3001\/team\/bobbit/);
	});
});
