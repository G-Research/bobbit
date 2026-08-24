import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Clock, TimerHandle } from "../../src/server/gateway-deps.js";
import {
	GithubHostCredentialTrust,
	type SpawnLike,
} from "../../src/server/github-host-credential-trust.js";

interface FakeHelper {
	spawn: SpawnLike;
	calls: Array<{ file: string; args: string[]; options: SpawnOptions }>;
	requests: string[];
	kills: string[];
}

function fakeHelper(
	output: string | Buffer | readonly (string | Buffer)[],
	options: { close?: boolean; code?: number; spawnError?: Error; stdoutError?: Error } = {},
): FakeHelper {
	const calls: FakeHelper["calls"] = [];
	const requests: string[] = [];
	const kills: string[] = [];
	return {
		calls,
		requests,
		kills,
		spawn(file, args, spawnOptions) {
			if (options.spawnError) throw options.spawnError;
			calls.push({ file, args: [...args], options: spawnOptions });
			const child = new EventEmitter() as ChildProcess;
			const stdout = new PassThrough();
			const stdin = new PassThrough();
			stdin.on("data", chunk => requests.push(String(chunk)));
			Object.assign(child, {
				stdout,
				stdin,
				kill(signal?: string) {
					kills.push(signal ?? "SIGTERM");
					return true;
				},
			});
			setImmediate(() => {
				for (const chunk of Array.isArray(output) ? output : [output]) stdout.write(chunk);
				if (options.stdoutError) {
					stdout.emit("error", options.stdoutError);
					child.emit("close", 1, null);
					return;
				}
				if (options.close === false) return;
				stdout.end();
				child.emit("close", options.code ?? 0, null);
			});
			return child;
		},
	};
}

function subject(helper: FakeHelper, clock?: Clock): GithubHostCredentialTrust {
	return new GithubHostCredentialTrust({ resolveSpawn: () => helper.spawn, clock, getEnv: () => ({}) });
}

function credential(host = "git.example.com", password = "fixture-secret"): string {
	return `protocol=https\nhost=${host}\nusername=operator\npassword=${password}\n`;
}

function manualClock(): Clock & { runPending(): void } {
	let next = 1;
	let pending: Array<{ handle: TimerHandle; handler: () => void }> = [];
	return {
		now: () => 0,
		setTimeout(handler) {
			const handle = next++ as unknown as TimerHandle;
			pending.push({ handle, handler });
			return handle;
		},
		setInterval: () => 0 as unknown as TimerHandle,
		clearTimeout(handle) { pending = pending.filter(item => item.handle !== handle); },
		clearInterval() {},
		runPending() {
			const due = pending;
			pending = [];
			for (const item of due) item.handler();
		},
	};
}

describe("GithubHostCredentialTrust cache", () => {
	it("single-flights normalized hosts and retains positive verdicts across refresh", async () => {
		let release!: (value: boolean) => void;
		const probe = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
		const trust = new GithubHostCredentialTrust({ probe, getEnv: () => ({}) });

		const first = trust.isTrusted(" GIT.Example.Com. ");
		const joined = trust.isTrusted("git.example.com");
		expect(probe).toHaveBeenCalledTimes(1);
		release(true);
		await expect(Promise.all([first, joined])).resolves.toEqual([true, true]);

		trust.forgetUnverified();
		await expect(trust.isTrusted("git.example.com")).resolves.toBe(true);
		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("clears negatives only on refresh and fences stale pending completions", async () => {
		let firstRelease!: (value: boolean) => void;
		let calls = 0;
		const probe = vi.fn(async () => {
			calls++;
			if (calls === 1) return new Promise<boolean>(resolve => { firstRelease = resolve; });
			return true;
		});
		const trust = new GithubHostCredentialTrust({ probe, getEnv: () => ({}) });

		const stale = trust.isTrusted("git.example.com");
		trust.forgetUnverified();
		const fresh = trust.isTrusted("git.example.com");
		firstRelease(false);
		await expect(stale).resolves.toBe(false);
		await expect(fresh).resolves.toBe(true);
		await expect(trust.isTrusted("git.example.com")).resolves.toBe(true);
		expect(probe).toHaveBeenCalledTimes(2);
	});

	it("caches thrown probes as negative until refresh and rejects malformed authorities", async () => {
		const probe = vi.fn(async () => { throw new Error("secret-bearing helper failure"); });
		const trust = new GithubHostCredentialTrust({ probe, getEnv: () => ({}) });
		await expect(trust.isTrusted("git.example.com")).resolves.toBe(false);
		await expect(trust.isTrusted("git.example.com")).resolves.toBe(false);
		expect(probe).toHaveBeenCalledTimes(1);
		for (const host of ["", "bad.example\nhost=evil", "user@host", "host/path", "host:99999"]) {
			await expect(trust.isTrusted(host)).resolves.toBe(false);
		}
		expect(probe).toHaveBeenCalledTimes(1);
	});
});

describe("Git credential probe", () => {
	it("uses only injected spawn from a dedicated neutral directory with prompting disabled, then cleans up", async () => {
		const inherited = {
			GIT_ASKPASS: process.env.GIT_ASKPASS,
			SSH_ASKPASS: process.env.SSH_ASKPASS,
			DISPLAY: process.env.DISPLAY,
			GIT_DIR: process.env.GIT_DIR,
			GIT_WORK_TREE: process.env.GIT_WORK_TREE,
			GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
		};
		process.env.GIT_ASKPASS = "configured-core-askpass-sentinel";
		process.env.SSH_ASKPASS = "configured-ssh-askpass-sentinel";
		process.env.DISPLAY = "gui-prompt-sentinel";
		process.env.GIT_DIR = "/repository/.git";
		process.env.GIT_WORK_TREE = "/repository";
		process.env.GIT_COMMON_DIR = "/repository/.git";
		try {
			const helper = fakeHelper(credential());
			await expect(subject(helper).isTrusted("git.example.com")).resolves.toBe(true);
			expect(helper.calls).toHaveLength(1);
			const call = helper.calls[0];
			expect(call.file).toBe("git");
			expect(call.args).toEqual(["credential", "fill"]);
			expect(call.options.cwd).not.toBe(tmpdir());
			expect(String(call.options.cwd).startsWith(tmpdir())).toBe(true);
			expect(existsSync(String(call.options.cwd))).toBe(false);
			expect(call.options.stdio).toEqual(["pipe", "pipe", "ignore"]);
			expect(call.options.windowsHide).toBe(true);
			const env = call.options.env as NodeJS.ProcessEnv;
			expect(env.GIT_TERMINAL_PROMPT).toBe("0");
			expect(env.GCM_INTERACTIVE).toBe("never");
			expect(env.GIT_CEILING_DIRECTORIES).toBe(tmpdir());
			// Empty values override both inherited variables and Git's core.askPass;
			// deleting GIT_ASKPASS here would allow the configured fallback to run.
			expect(env.GIT_ASKPASS).toBe("");
			expect(env.SSH_ASKPASS).toBe("");
			expect(env.DISPLAY).toBeUndefined();
			expect(env.GIT_DIR).toBeUndefined();
			expect(env.GIT_WORK_TREE).toBeUndefined();
			expect(env.GIT_COMMON_DIR).toBeUndefined();
			expect(helper.requests.join("")).toBe("url=https://git.example.com\n\n");
			expect(helper.kills).toEqual([]);
		} finally {
			for (const [name, value] of Object.entries(inherited)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("fails closed without spawn support or when injected spawn throws", async () => {
		await expect(new GithubHostCredentialTrust({ getEnv: () => ({}) }).isTrusted("git.example.com")).resolves.toBe(false);
		const helper = fakeHelper("", { spawnError: new Error("fenced") });
		await expect(subject(helper).isTrusted("git.example.com")).resolves.toBe(false);
	});

	it("never logs credential output or helper error values", async () => {
		const stdoutSecret = "stdout-password-must-not-escape";
		const errorSecret = "helper-error-must-not-escape";
		const spies = [
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
		];
		try {
			await expect(subject(fakeHelper(credential("git.example.com", stdoutSecret))).isTrusted("git.example.com"))
				.resolves.toBe(true);
			await expect(subject(fakeHelper("host=git.example.com\npassword=partial-secret", {
				stdoutError: new Error(errorSecret),
			})).isTrusted("git.example.com")).resolves.toBe(false);

			const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
			expect(logged).not.toContain(stdoutSecret);
			expect(logged).not.toContain("partial-secret");
			expect(logged).not.toContain(errorSecret);
			expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("requires one exact echoed normalized authority and a non-empty password", async () => {
		const cases: Array<[string, string | Buffer, boolean]> = [
			["exact record", credential(), true],
			["authority with exact port", credential("git.example.com:8443"), true],
			["wrong host", credential("other.example.com"), false],
			["missing host", "protocol=https\npassword=secret\n", false],
			["missing password", "protocol=https\nhost=git.example.com\n", false],
			["empty password", "host=git.example.com\npassword=\n", false],
			["duplicate host", "host=git.example.com\nhost=git.example.com\npassword=secret\n", false],
			["contradictory host", "host=git.example.com\nhost=other.example.com\npassword=secret\n", false],
			["duplicate password", "host=git.example.com\npassword=one\npassword=two\n", false],
			["malformed line", "host=git.example.com\nnot-a-field\npassword=secret\n", false],
			["trailing record", "host=git.example.com\npassword=secret\n\nhost=git.example.com\npassword=other\n", false],
			["malformed UTF-8", Buffer.from([0x68, 0x6f, 0x73, 0x74, 0x3d, 0xff]), false],
		];
		for (const [label, output, expected] of cases) {
			const helper = fakeHelper(output);
			await expect(subject(helper).isTrusted(label.includes("port") ? "git.example.com:8443" : "git.example.com"), label)
				.resolves.toBe(expected);
		}
	});

	it("waits for successful close and rejects nonzero exit or malformed trailing output", async () => {
		const nonzero = fakeHelper(credential(), { code: 1 });
		await expect(subject(nonzero).isTrusted("git.example.com")).resolves.toBe(false);
		expect(nonzero.kills).toEqual([]);

		const trailing = fakeHelper([credential(), "\nmalformed"]);
		await expect(subject(trailing).isTrusted("git.example.com")).resolves.toBe(false);
	});

	it("rejects output beyond the byte cap in one chunk or across chunks", async () => {
		const padding = "field=" + "x".repeat(9 * 1024);
		for (const output of [
			`${credential()}${padding}\n`,
			["host=git.example.com\npassword=secret\n", "field=", "x".repeat(9 * 1024)],
		]) {
			const helper = fakeHelper(output);
			await expect(subject(helper).isTrusted("git.example.com")).resolves.toBe(false);
			expect(helper.kills).toEqual(["SIGTERM"]);
		}
	});

	it("times out, sends TERM, escalates a wedged process to KILL, and never kills normal success", async () => {
		const clock = manualClock();
		const wedged = fakeHelper("host=git.example.com\n", { close: false });
		const verdict = subject(wedged, clock).isTrusted("git.example.com");
		await new Promise(resolve => setImmediate(resolve));
		clock.runPending();
		await expect(verdict).resolves.toBe(false);
		expect(wedged.kills).toEqual(["SIGTERM"]);
		clock.runPending();
		expect(wedged.kills).toEqual(["SIGTERM", "SIGKILL"]);

		const normalClock = manualClock();
		const normal = fakeHelper(credential());
		await expect(subject(normal, normalClock).isTrusted("git.example.com")).resolves.toBe(true);
		normalClock.runPending();
		expect(normal.kills).toEqual([]);
	});
});

describe("ambient gh token refusal", () => {
	it("resolves the live environment before cache/probe and warns once without retaining the value", async () => {
		const secret = "ghp_secret_must_not_escape";
		let env: Record<string, string | undefined> = {};
		const warnings: string[] = [];
		const probe = vi.fn(async () => true);
		const trust = new GithubHostCredentialTrust({ probe, getEnv: () => env, warn: line => warnings.push(line) });

		await expect(trust.isTrusted("git.example.com")).resolves.toBe(true);
		env = { GH_ENTERPRISE_TOKEN: secret };
		await expect(trust.isTrusted("git.example.com")).resolves.toBe(false);
		await expect(trust.isTrusted("git.example.com")).resolves.toBe(false);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("git.example.com");
		expect(warnings[0]).toContain("GH_ENTERPRISE_TOKEN");
		expect(warnings[0]).not.toContain(secret);
		expect(JSON.stringify(trust)).not.toContain(secret);

		env = {};
		await expect(trust.isTrusted("git.example.com")).resolves.toBe(true);
	});

	it("matches gh GitHub-token host classes without admitting near-misses", async () => {
		for (const [host, variable] of [
			["github.com", "GH_TOKEN"],
			["pages.github.com", "GH_TOKEN"],
			["github.localhost", "GITHUB_TOKEN"],
			["api.github.localhost", "GH_TOKEN"],
			["api.github.localhost:8443", "GITHUB_TOKEN"],
			["tenant.ghe.com", "GITHUB_TOKEN"],
			["tenant.ghe.com:8443", "GH_TOKEN"],
			["ghe.com", "GH_ENTERPRISE_TOKEN"],
			["notgithub.com", "GITHUB_ENTERPRISE_TOKEN"],
			["github.com.evil.test", "GH_ENTERPRISE_TOKEN"],
			["notghe.com", "GITHUB_ENTERPRISE_TOKEN"],
			["ghe.com.evil.test", "GH_ENTERPRISE_TOKEN"],
		] as const) {
			const probe = vi.fn(async () => true);
			const trust = new GithubHostCredentialTrust({
				probe,
				getEnv: () => ({ [variable]: "secret" }),
				warn: () => {},
			});
			await expect(trust.isTrusted(host), host).resolves.toBe(false);
			expect(probe, host).not.toHaveBeenCalled();
		}
	});

	it("treats a whitespace-only gh token as set and redacts its value", async () => {
		const warnings: string[] = [];
		const probe = vi.fn(async () => true);
		const trust = new GithubHostCredentialTrust({
			probe,
			getEnv: () => ({ GH_ENTERPRISE_TOKEN: " \t" }),
			warn: line => warnings.push(line),
		});

		await expect(trust.isTrusted("git.example.com")).resolves.toBe(false);
		expect(probe).not.toHaveBeenCalled();
		expect(warnings).toEqual([
			"[github-trust] Not trusting git.example.com from the local Git credential configuration because GH_ENTERPRISE_TOKEN is set. "
			+ "Trust git.example.com explicitly with githubTrustedHosts or unset GH_ENTERPRISE_TOKEN.",
		]);
		expect(warnings[0]).not.toContain("\t");
	});

	it("keeps token classes independent and honors variable precedence", async () => {
		const warnings: string[] = [];
		const enterprise = new GithubHostCredentialTrust({
			probe: async () => true,
			getEnv: () => ({ GH_TOKEN: "github-only" }),
			warn: line => warnings.push(line),
		});
		await expect(enterprise.isTrusted("git.example.com")).resolves.toBe(true);

		const refused = new GithubHostCredentialTrust({
			probe: async () => true,
			getEnv: () => ({ GH_ENTERPRISE_TOKEN: "first", GITHUB_ENTERPRISE_TOKEN: "second" }),
			warn: line => warnings.push(line),
		});
		await expect(refused.isTrusted("git.example.com")).resolves.toBe(false);
		expect(warnings.at(-1)).toContain("GH_ENTERPRISE_TOKEN");
		expect(warnings.at(-1)).not.toContain("first");
		expect(warnings.at(-1)).not.toContain("second");
	});
});
