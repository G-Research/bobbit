import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../../../src/server/gateway-deps.js";
import { GithubTrustedHostResolver } from "../../../src/server/github-trusted-hosts.js";
import { isTrustedExternalHost } from "../../../src/shared/pr-walkthrough/url-safety.js";

const tempRoots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bobbit-gh-hosts-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

function noCommandRunner(): CommandRunner {
	return {
		execFile: vi.fn(async () => {
			throw new Error("host discovery must not execute a command");
		}),
	};
}

function makeResolver(input: {
	runner?: CommandRunner;
	managed?: () => unknown;
	now?: () => number;
	cacheTtlMs?: number;
	env?: Readonly<Record<string, string | undefined>>;
	fileSystem?: Pick<typeof fs.promises, "open">;
	platform?: NodeJS.Platform;
} = {}): { resolver: GithubTrustedHostResolver; runner: CommandRunner } {
	const runner = input.runner ?? noCommandRunner();
	return {
		resolver: new GithubTrustedHostResolver({
			commandRunner: runner,
			clock: { now: input.now ?? (() => 0) },
			getManagedHosts: input.managed ?? (() => []),
			cacheTtlMs: input.cacheTtlMs,
			env: input.env ?? {},
			fileSystem: input.fileSystem,
			platform: input.platform,
		}),
		runner,
	};
}

async function writeHosts(configDir: string, contents: string | Buffer): Promise<void> {
	await fs.promises.mkdir(configDir, { recursive: true });
	await fs.promises.writeFile(path.join(configDir, "hosts.yml"), contents);
}

describe("GithubTrustedHostResolver", () => {
	it("reads only normalized top-level host keys from GH_CONFIG_DIR without invoking gh", async () => {
		const configDir = await tempRoot();
		const tokenSentinel = "github_pat_token_must_not_escape";
		await writeHosts(configDir, [
			"# oauth_token: ghp_comment_is_not_a_host",
			"GHE.Example.COM.:",
			"    user: octocat",
			`    oauth_token: ${tokenSentinel}`,
			"    git_protocol: https",
			"second.example.com: # configured host",
			"\tuser: nested",
			"github.com:",
			"    oauth_token: ghp_builtin",
			"ghe.example.com:",
		].join("\n"));
		const managed = ["Managed.Example.com", "ghe.example.com", "api.github.com"];
		const { resolver, runner } = makeResolver({ env: { GH_CONFIG_DIR: configDir }, managed: () => managed });

		const result = await resolver.resolve();

		expect(result).toEqual(["managed.example.com", "ghe.example.com", "second.example.com"]);
		expect(JSON.stringify(result)).not.toContain(tokenSentinel);
		expect(runner.execFile).not.toHaveBeenCalled();
	});

	it("does not trust token-looking indented values, comments, or environment-only authorization", async () => {
		const configDir = await tempRoot();
		await writeHosts(configDir, [
			"# env-only.example.com:",
			"configured.example.com:",
			"    oauth_token: env-only.example.com:",
			"    github_pat_secret.example.com: token",
		].join("\n"));
		const { resolver, runner } = makeResolver({
			env: {
				GH_CONFIG_DIR: configDir,
				GH_HOST: "env-only.example.com",
				GH_ENTERPRISE_TOKEN: "environment-token",
				GITHUB_TOKEN: "generic-token",
			},
		});

		await expect(resolver.resolve()).resolves.toEqual(["configured.example.com"]);
		expect(runner.execFile).not.toHaveBeenCalled();
	});

	it.each([
		["malformed top-level YAML", "good.example.com:\nnot a mapping\n"],
		["an invalid top-level hostname", "good.example.com:\nbad..example.com:\n"],
		["a top-level scalar value", "good.example.com: token-looking-value\n"],
	])("fails closed for %s", async (_label, contents) => {
		const configDir = await tempRoot();
		await writeHosts(configDir, contents);
		const { resolver, runner } = makeResolver({ env: { GH_CONFIG_DIR: configDir } });

		await expect(resolver.resolve()).resolves.toEqual([]);
		expect(runner.execFile).not.toHaveBeenCalled();
	});

	it("fails closed for oversized, missing, and unreadable config", async () => {
		const oversizedDir = await tempRoot();
		await writeHosts(oversizedDir, Buffer.alloc(64 * 1024 + 1, 0x61));
		await expect(makeResolver({ env: { GH_CONFIG_DIR: oversizedDir } }).resolver.resolve()).resolves.toEqual([]);

		const missingDir = await tempRoot();
		await expect(makeResolver({ env: { GH_CONFIG_DIR: missingDir } }).resolver.resolve()).resolves.toEqual([]);

		const unreadable = makeResolver({
			env: { GH_CONFIG_DIR: missingDir },
			fileSystem: { open: async () => { throw new Error("unreadable: token-sentinel"); } } as unknown as Pick<typeof fs.promises, "open">,
		});
		await expect(unreadable.resolver.resolve()).resolves.toEqual([]);
		expect(unreadable.runner.execFile).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "Windows APPDATA",
			platform: "win32" as NodeJS.Platform,
			envFor: (root: string) => ({ APPDATA: root }),
			configFor: (root: string) => path.join(root, "GitHub CLI"),
		},
		{
			name: "XDG config before platform defaults",
			platform: "win32" as NodeJS.Platform,
			envFor: (root: string) => ({ XDG_CONFIG_HOME: root, APPDATA: path.join(root, "unused-appdata") }),
			configFor: (root: string) => path.join(root, "gh"),
		},
		{
			name: "macOS home fallback",
			platform: "darwin" as NodeJS.Platform,
			envFor: (root: string) => ({ HOME: root }),
			configFor: (root: string) => path.join(root, ".config", "gh"),
		},
		{
			name: "Linux home fallback",
			platform: "linux" as NodeJS.Platform,
			envFor: (root: string) => ({ HOME: root }),
			configFor: (root: string) => path.join(root, ".config", "gh"),
		},
	])("uses the documented $name path", async ({ platform, envFor, configFor }) => {
		const root = await tempRoot();
		await writeHosts(configFor(root), "configured.example.com:\n    oauth_token: sentinel\n");
		const { resolver, runner } = makeResolver({ platform, env: envFor(root) });

		await expect(resolver.resolve()).resolves.toEqual(["configured.example.com"]);
		expect(runner.execFile).not.toHaveBeenCalled();
	});

	it("caches only discovery while reading managed hosts live", async () => {
		const configDir = await tempRoot();
		await writeHosts(configDir, "configured.example.com:\n");
		let managed: unknown = ["first-managed.example.com"];
		let opens = 0;
		const fileSystem: Pick<typeof fs.promises, "open"> = {
			open: async (...args: Parameters<typeof fs.promises.open>) => {
				opens += 1;
				return fs.promises.open(...args);
			},
		};
		const { resolver } = makeResolver({ env: { GH_CONFIG_DIR: configDir }, managed: () => managed, fileSystem });

		await expect(resolver.resolve()).resolves.toEqual(["first-managed.example.com", "configured.example.com"]);
		managed = ["second-managed.example.com"];
		await expect(resolver.resolve()).resolves.toEqual(["second-managed.example.com", "configured.example.com"]);
		expect(opens).toBe(1);
	});

	it("refreshes at expiry and drops stale discovered hosts when the refresh fails", async () => {
		const configDir = await tempRoot();
		await writeHosts(configDir, "stale.example.com:\n");
		let now = 0;
		const { resolver } = makeResolver({ env: { GH_CONFIG_DIR: configDir }, now: () => now, cacheTtlMs: 10 });

		await expect(resolver.resolve()).resolves.toEqual(["stale.example.com"]);
		now = 9;
		await expect(resolver.resolve()).resolves.toEqual(["stale.example.com"]);
		await fs.promises.rm(path.join(configDir, "hosts.yml"));
		now = 10;
		await expect(resolver.resolve()).resolves.toEqual([]);
		now = 19;
		await expect(resolver.resolve()).resolves.toEqual([]);
	});

	it("coalesces concurrent config reads", async () => {
		const configDir = await tempRoot();
		await writeHosts(configDir, "configured.example.com:\n");
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		let opens = 0;
		const fileSystem: Pick<typeof fs.promises, "open"> = {
			open: async (...args: Parameters<typeof fs.promises.open>) => {
				opens += 1;
				await pending;
				return fs.promises.open(...args);
			},
		};
		const { resolver } = makeResolver({ env: { GH_CONFIG_DIR: configDir }, fileSystem });

		const first = resolver.resolve();
		const second = resolver.resolve();
		expect(opens).toBe(1);
		release();
		await expect(Promise.all([first, second])).resolves.toEqual([
			["configured.example.com"],
			["configured.example.com"],
		]);
		expect(opens).toBe(1);
	});

	it("fails closed to built-in plus live managed trust and never logs read failures", async () => {
		const spies = ["log", "error", "warn", "info", "debug"].map(method =>
			vi.spyOn(console, method as "log").mockImplementation(() => undefined),
		);
		let managed: unknown = ["managed.example.com"];
		try {
			const { resolver, runner } = makeResolver({
				env: { GH_CONFIG_DIR: "missing-token-sentinel" },
				managed: () => managed,
				fileSystem: { open: async () => { throw new Error("token-in-error"); } } as unknown as Pick<typeof fs.promises, "open">,
			});
			const first = await resolver.resolve();
			expect(first).toEqual(["managed.example.com"]);
			expect(isTrustedExternalHost("github.com", first)).toBe(true);
			expect(isTrustedExternalHost("unknown.example.com", first)).toBe(false);
			managed = ["changed.example.com"];
			await expect(resolver.resolve()).resolves.toEqual(["changed.example.com"]);
			expect(runner.execFile).not.toHaveBeenCalled();
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
