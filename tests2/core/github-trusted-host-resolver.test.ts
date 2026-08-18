import { describe, expect, it, vi } from "vitest";
import type { ExecFileOptions } from "node:child_process";
import type { CommandRunner, ExecFileResult } from "../../src/server/gateway-deps.js";
import { GithubTrustedHostResolver } from "../../src/server/github-trusted-hosts.js";
import { isTrustedExternalHost } from "../../src/shared/pr-walkthrough/url-safety.js";

interface CommandCall {
	file: string;
	args: readonly string[];
	options?: ExecFileOptions;
}

function makeResolver(input: {
	outputs?: Array<ExecFileResult | Error>;
	run?: CommandRunner["execFile"];
	managed?: () => unknown;
	now?: () => number;
	cacheTtlMs?: number;
	env?: Readonly<Record<string, string | undefined>>;
} = {}): { resolver: GithubTrustedHostResolver; calls: CommandCall[] } {
	const calls: CommandCall[] = [];
	const outputs = [...(input.outputs ?? [{ stdout: "", stderr: "" }])];
	const execFile: CommandRunner["execFile"] = input.run ?? (async (file, args, options) => {
		calls.push({ file, args, options });
		const output = outputs.shift() ?? { stdout: "", stderr: "" };
		if (output instanceof Error) throw output;
		return output;
	});
	const runner: CommandRunner = {
		execFile: async (file, args, options) => {
			if (input.run) calls.push({ file, args, options });
			return execFile(file, args, options);
		},
	};
	return {
		resolver: new GithubTrustedHostResolver({
			commandRunner: runner,
			clock: { now: input.now ?? (() => 0) },
			getManagedHosts: input.managed ?? (() => []),
			cacheTtlMs: input.cacheTtlMs,
			env: input.env ?? {},
		}),
		calls,
	};
}

describe("GithubTrustedHostResolver", () => {
	it("uses the token-free gh host-key query and returns normalized extra hosts", async () => {
		const { resolver, calls } = makeResolver({
			outputs: [{
				stdout: [
					"GHE.Example.COM.",
					"second.example.com\r",
					"ghe.example.com",
					"github.com",
					"host.example.com:443",
					"https://not-a-host-key.example.com/path",
					"github_pat_secret_value",
					"ghp_secret_value",
					"bad host.example.com",
				].join("\n"),
				stderr: "ignored diagnostics",
			}],
			managed: () => ["Managed.Example.com", "ghe.example.com", "api.github.com"],
			env: {
				PATH: "bin",
				GH_CONFIG_DIR: "/safe/gh-config",
				GH_TOKEN: "secret-1",
				github_token: "secret-2",
				Gh_Enterprise_Token: "secret-3",
				GITHUB_ENTERPRISE_TOKEN: "secret-4",
				gh_HOST: "env-only.example.com",
				Gh_RePo: "owner/repo",
			},
		});

		await expect(resolver.resolve()).resolves.toEqual([
			"managed.example.com",
			"ghe.example.com",
			"second.example.com",
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.file).toBe("gh");
		expect(calls[0]!.args).toEqual(["auth", "status", "--json", "hosts", "--jq", ".hosts | keys[]"]);
		expect(calls[0]!.options).toMatchObject({
			encoding: "utf8",
			maxBuffer: 64 * 1024,
			timeout: 5_000,
			windowsHide: true,
		});
		const childEnv = calls[0]!.options!.env!;
		expect(childEnv.PATH).toBe("bin");
		expect(childEnv.GH_CONFIG_DIR).toBe("/safe/gh-config");
		expect(Object.keys(childEnv).map(key => key.toUpperCase())).not.toEqual(expect.arrayContaining([
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"GH_ENTERPRISE_TOKEN",
			"GITHUB_ENTERPRISE_TOKEN",
			"GH_HOST",
			"GH_REPO",
		]));
	});

	it("cannot discover a host authorized only by generic enterprise environment variables", async () => {
		const { resolver, calls } = makeResolver({
			env: { GH_ENTERPRISE_TOKEN: "environment-token", GH_HOST: "env-only.example.com", GH_CONFIG_DIR: "/config" },
			managed: () => ["managed.example.com"],
			run: async (_file, _args, options) => ({
				stdout: options?.env?.GH_ENTERPRISE_TOKEN || options?.env?.GH_HOST ? "env-only.example.com\n" : "",
				stderr: "",
			}),
		});

		await expect(resolver.resolve()).resolves.toEqual(["managed.example.com"]);
		expect(calls[0]!.options?.env?.GH_CONFIG_DIR).toBe("/config");
	});

	it("caches only discovery while reading managed hosts live", async () => {
		let managed: unknown = ["first-managed.example.com"];
		const { resolver, calls } = makeResolver({
			outputs: [{ stdout: "configured.example.com\n", stderr: "" }],
			managed: () => managed,
		});

		await expect(resolver.resolve()).resolves.toEqual(["first-managed.example.com", "configured.example.com"]);
		managed = ["second-managed.example.com"];
		await expect(resolver.resolve()).resolves.toEqual(["second-managed.example.com", "configured.example.com"]);
		expect(calls).toHaveLength(1);
	});

	it("refreshes discovery at expiry", async () => {
		let now = 10;
		const { resolver, calls } = makeResolver({
			outputs: [
				{ stdout: "old.example.com\n", stderr: "" },
				{ stdout: "new.example.com\n", stderr: "" },
			],
			now: () => now,
			cacheTtlMs: 30,
		});

		await expect(resolver.resolve()).resolves.toEqual(["old.example.com"]);
		now = 39;
		await expect(resolver.resolve()).resolves.toEqual(["old.example.com"]);
		now = 40;
		await expect(resolver.resolve()).resolves.toEqual(["new.example.com"]);
		expect(calls).toHaveLength(2);
	});

	it("coalesces concurrent discovery into one in-flight command", async () => {
		let release!: (result: ExecFileResult) => void;
		const pending = new Promise<ExecFileResult>(resolve => { release = resolve; });
		const { resolver, calls } = makeResolver({ run: async () => pending });

		const first = resolver.resolve();
		const second = resolver.resolve();
		expect(calls).toHaveLength(1);
		release({ stdout: "configured.example.com\n", stderr: "" });
		await expect(Promise.all([first, second])).resolves.toEqual([
			["configured.example.com"],
			["configured.example.com"],
		]);
		expect(calls).toHaveLength(1);
	});

	it("fails closed to built-in plus live managed trust and caches the failure briefly", async () => {
		let managed: unknown = ["managed.example.com"];
		const { resolver, calls } = makeResolver({
			outputs: [new Error("gh is unavailable: secret-token")],
			managed: () => managed,
		});

		const first = await resolver.resolve();
		expect(first).toEqual(["managed.example.com"]);
		expect(isTrustedExternalHost("github.com", first)).toBe(true);
		expect(isTrustedExternalHost("unknown.example.com", first)).toBe(false);
		managed = ["changed.example.com"];
		await expect(resolver.resolve()).resolves.toEqual(["changed.example.com"]);
		expect(calls).toHaveLength(1);
	});

	it("drops stale discovered hosts when a refresh fails", async () => {
		let now = 0;
		const { resolver, calls } = makeResolver({
			outputs: [
				{ stdout: "stale.example.com\n", stderr: "" },
				new Error("refresh failed"),
			],
			now: () => now,
			cacheTtlMs: 10,
		});

		await expect(resolver.resolve()).resolves.toEqual(["stale.example.com"]);
		now = 10;
		await expect(resolver.resolve()).resolves.toEqual([]);
		now = 19;
		await expect(resolver.resolve()).resolves.toEqual([]);
		expect(calls).toHaveLength(2);
	});

	it("never logs discovery output, diagnostics, or errors", async () => {
		const spies = ["log", "error", "warn", "info", "debug"].map(method =>
			vi.spyOn(console, method as "log").mockImplementation(() => undefined),
		);
		try {
			const failed = makeResolver({ outputs: [new Error("token-in-error")] }).resolver;
			await failed.resolve();
			const succeeded = makeResolver({ outputs: [{ stdout: "configured.example.com\n", stderr: "token-in-stderr" }] }).resolver;
			await succeeded.resolve();
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
