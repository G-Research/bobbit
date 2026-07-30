import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProjectRoot, resetAgentDirStateForTests, setProjectRoot } from "../../src/server/bobbit-dir.js";
import { runCli, type CliRunEffects } from "../../src/server/cli.js";
import type { GatewayConfig } from "../../src/server/server.js";

const ACTUAL_PORT = 43127;
const ORIGINAL_PROJECT_ROOT = getProjectRoot();
const ENV_KEYS = [
	"BOBBIT_DIR",
	"BOBBIT_SECRETS_DIR",
	"BOBBIT_AGENT_DIR",
	"BOBBIT_BASE_PATH",
	"BOBBIT_NO_OPEN",
	"NODE_ENV",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];

interface StartupCapture {
	config?: GatewayConfig;
	callbackUrl?: string;
	persistedWhenStartResumed?: string;
	output: string;
	stageCalls: number;
	openCalls: string[];
}

function tempRoot(label: string): string {
	const root = mkdtempSync(join(tmpdir(), `bobbit-base-path-${label}-`));
	roots.push(root);
	return root;
}

function restoreEnvironment(): void {
	for (const key of ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function configureEnvironment(root: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const values: Record<(typeof ENV_KEYS)[number], string | undefined> = {
		BOBBIT_DIR: join(root, ".bobbit"),
		BOBBIT_SECRETS_DIR: join(root, "secrets"),
		BOBBIT_AGENT_DIR: join(root, "agent"),
		BOBBIT_BASE_PATH: undefined,
		BOBBIT_NO_OPEN: "1",
		NODE_ENV: "test",
		...overrides,
	};
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetAgentDirStateForTests();
	return { ...process.env };
}

async function runInjectedStartup(
	root: string,
	args: string[],
	envOverrides: Record<string, string | undefined> = {},
): Promise<StartupCapture> {
	const output: string[] = [];
	const capture: StartupCapture = { output: "", stageCalls: 0, openCalls: [] };
	const statePath = join(root, ".bobbit", "state", "gateway-url");
	const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
		output.push(`${values.map(String).join(" ")}\n`);
	});
	const warn = vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
		output.push(`${values.map(String).join(" ")}\n`);
	});
	const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
		output.push(String(chunk));
		return true;
	}) as typeof process.stdout.write);

	const createGateway = ((config: GatewayConfig) => {
		capture.config = config;
		return {
			async start() {
				const callbackUrl = await config.onBound?.(ACTUAL_PORT);
				capture.callbackUrl = typeof callbackUrl === "string" ? callbackUrl : undefined;
				capture.persistedWhenStartResumed = readFileSync(statePath, "utf8").trim();
				return ACTUAL_PORT;
			},
			async shutdown() {},
		} as ReturnType<NonNullable<CliRunEffects["createGateway"]>>;
	}) as NonNullable<CliRunEffects["createGateway"]>;

	try {
		await runCli(args, configureEnvironment(root, envOverrides), {
			createGateway,
			stageBundledBinaries: stagingEffect(() => { capture.stageCalls++; }),
			openUrl: (url) => { capture.openCalls.push(url); },
			registerSignalHandlers: false,
		});
	} finally {
		capture.output = output.join("");
		stdout.mockRestore();
		warn.mockRestore();
		log.mockRestore();
	}
	return capture;
}

function stagingEffect(onCall: () => void): NonNullable<CliRunEffects["stageBundledBinaries"]> {
	return async () => {
		onCall();
		const skipped = { source: "missing" as const, path: null, expectedPackage: "test fixture", pathProbes: [] };
		return { fd: skipped, rg: skipped, binDir: null };
	};
}

function invalidEffects() {
	const calls = { createGateway: 0, writeGatewayUrl: 0, openUrl: 0, stageBundledBinaries: 0 };
	const effects: CliRunEffects = {
		createGateway: ((..._args: unknown[]) => {
			calls.createGateway++;
			throw new Error("createGateway must not run for invalid CLI input");
		}) as NonNullable<CliRunEffects["createGateway"]>,
		writeGatewayUrl: () => { calls.writeGatewayUrl++; },
		openUrl: () => { calls.openUrl++; },
		stageBundledBinaries: stagingEffect(() => { calls.stageBundledBinaries++; }),
		registerSignalHandlers: false,
	};
	return { calls, effects };
}

afterEach(() => {
	vi.restoreAllMocks();
	restoreEnvironment();
	resetAgentDirStateForTests();
	setProjectRoot(ORIGINAL_PROJECT_ROOT);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.sequential("production runCli base-path startup", () => {
	it("lets a valid flag override an unsafe environment value and publishes the mounted bound-port URL", async () => {
		const root = tempRoot("mounted");
		const capture = await runInjectedStartup(root, [
			"--cwd", root,
			"--host", "127.0.0.1",
			"--port", "0",
			"--no-tls",
			"--no-ui",
			"--base-path", "/team/cli",
		], { BOBBIT_BASE_PATH: "/unsafe%2fenv" });

		expect(capture.config).toMatchObject({
			host: "127.0.0.1",
			port: 0,
			portExplicit: true,
			defaultCwd: root,
			basePath: "/team/cli",
			forceAuth: false,
		});
		expect(capture.config?.tls).toBeUndefined();
		expect(capture.config?.staticDir).toBeUndefined();
		expect(capture.stageCalls).toBe(1);

		const expectedUrl = `http://127.0.0.1:${ACTUAL_PORT}/team/cli`;
		const gatewayUrlPath = join(root, ".bobbit", "state", "gateway-url");
		expect(capture.callbackUrl).toBe(expectedUrl);
		expect(capture.persistedWhenStartResumed).toBe(expectedUrl);
		expect(readFileSync(gatewayUrlPath, "utf8").trim()).toBe(expectedUrl);
		expect(capture.output).toMatch(new RegExp(`Listening:\\s+${expectedUrl.replaceAll(".", "\\.")}`));
		expect(capture.output).toMatch(/token auth(?:entication)? (?:is )?disabled/i);
		expect(capture.output).not.toMatch(/Auth token:/i);
		expect(capture.output).not.toMatch(/token grants full shell access/i);
		expect(capture.output).not.toContain("?token=");
		expect(capture.openCalls).toEqual([]);

		const stateNames = readdirSync(join(root, ".bobbit", "state"));
		expect(stateNames.some((name) => /^gateway-url\..*tmp/i.test(name))).toBe(false);
	});

	it.each(["", "/"])("lets an explicit %j flag reset an environment mount throughout GatewayConfig and startup URLs", async (flagValue) => {
		const root = tempRoot(flagValue === "" ? "empty-root" : "slash-root");
		const capture = await runInjectedStartup(root, [
			"--cwd", root,
			"--host", "127.0.0.1",
			"--port", "0",
			"--no-tls",
			"--no-ui",
			"--base-path", flagValue,
		], { BOBBIT_BASE_PATH: "/from-env" });

		const expectedUrl = `http://127.0.0.1:${ACTUAL_PORT}`;
		expect(capture.config?.basePath).toBe("");
		expect(capture.callbackUrl).toBe(expectedUrl);
		expect(capture.persistedWhenStartResumed).toBe(expectedUrl);
		expect(readFileSync(join(root, ".bobbit", "state", "gateway-url"), "utf8").trim()).toBe(expectedUrl);
		expect(capture.output).toContain(`Listening:  ${expectedUrl}`);
		expect(capture.output).not.toContain("/from-env");
	});

	it.each([
		{ label: "selected unsafe environment", args: ["--host", "127.0.0.1", "--port", "0", "--no-tls", "--no-ui"], env: { BOBBIT_BASE_PATH: "/bad%2fpath" } },
		{ label: "missing final flag value", args: ["--host", "127.0.0.1", "--port", "0", "--no-tls", "--no-ui", "--base-path"], env: {} },
		{ label: "next token is another option", args: ["--host", "127.0.0.1", "--port", "0", "--no-tls", "--no-ui", "--base-path", "--auth"], env: {} },
	])("rejects $label before state, token, gateway, writer, staging, or opener side effects", async ({ label, args, env }) => {
		const root = tempRoot(label.replaceAll(" ", "-"));
		const { calls, effects } = invalidEffects();
		const run = runCli(["--cwd", root, ...args], configureEnvironment(root, env), effects);

		await expect(run).rejects.toThrow(/base[ -]?path/i);
		expect(calls).toEqual({ createGateway: 0, writeGatewayUrl: 0, openUrl: 0, stageBundledBinaries: 0 });
		expect(existsSync(join(root, ".bobbit", "state", "gateway-url"))).toBe(false);
		expect(existsSync(join(root, "secrets", "token"))).toBe(false);
	});
});
