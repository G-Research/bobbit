import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { validateManifest } from "../src/server/agent/pack-manifest.ts";
import { loadPackContributions } from "../src/server/agent/pack-contributions.ts";
import { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import { ChannelPtyService } from "../src/server/extension-host/channel-pty-helper.ts";
import { terminal as terminalChannelHandler } from "../market-packs/terminal/src/terminal-channel.ts";
import type { PackEntry } from "../src/server/agent/pack-types.ts";

const repoRoot = process.cwd();

describe("built-in terminal pack", () => {
	it("declares a first-party sessionPty terminal channel, panel, and launchers", () => {
		const root = path.join(repoRoot, "market-packs", "terminal");
		const manifest = validateManifest(parse(fs.readFileSync(path.join(root, "pack.yaml"), "utf-8")))!;
		assert.ok(manifest, "terminal pack manifest should validate");
		assert.deepEqual(manifest.contents.channels, ["terminal"]);
		assert.deepEqual(manifest.contents.entrypoints, ["terminal-session-menu", "terminal-slash"]);
		const contributions = loadPackContributions(root, manifest);
		assert.equal(contributions.panels[0]?.id, "terminal.panel");
		const sessionMenu = contributions.entrypoints.find((e) => e.kind === "session-menu");
		assert.equal(sessionMenu?.label, "Open Terminal");
		assert.deepEqual(sessionMenu?.target, {
			action: "channel-panel",
			channel: "terminal",
			singletonKey: "session-terminal",
			panelId: "terminal.panel",
			params: { autoStart: true },
		});
		const channel = contributions.channels[0];
		assert.equal(channel?.name, "terminal");
		assert.equal(channel?.protocol, "terminal.v1");
		assert.deepEqual(channel?.capabilities, ["sessionPty"]);
		assert.equal(channel?.requiresUserGesture, true);
		assert.equal(channel?.quotas?.maxChannelsPerSessionPerPack, 1);
	});

	it("retains sessionPty only through first-party pack contribution resolution", () => {
		const root = path.join(repoRoot, "market-packs", "terminal");
		const manifest = validateManifest(parse(fs.readFileSync(path.join(root, "pack.yaml"), "utf-8")))!;
		const entry: PackEntry = {
			id: "builtin-pack:terminal",
			kind: "builtin",
			scope: "builtin",
			path: root,
			readOnly: true,
			manifest,
			layout: "defaults-tree",
			meta: { sourceUrl: "builtin:" },
		};
		const reg = new PackContributionRegistry(() => [entry]);
		assert.deepEqual(reg.getChannel(undefined, "terminal", "terminal")?.capabilities, ["sessionPty"]);
	});
});

describe("terminal channel handler", () => {
	it("bridges client text/resize/kill frames to PTY and emits output/status/exit frames", async () => {
		let dataCb: ((data: string) => void) | undefined;
		let exitCb: ((event: { code: number | null; signal?: string | number; reason?: string }) => void) | undefined;
		const writes: string[] = [];
		const resizes: Array<[number, number]> = [];
		const frames: unknown[] = [];
		let closed: string | undefined;
		const session = await terminalChannelHandler({
			init: { cols: 90, rows: 25 },
			host: {
				pty: {
					async openTerminal(opts?: { cols?: number; rows?: number }) {
						assert.deepEqual(opts, { cols: 90, rows: 25 });
						return {
							pid: 77,
							write: (data: string) => { writes.push(data); },
							resize: (cols: number, rows: number) => { resizes.push([cols, rows]); },
							kill: (reason?: string) => { exitCb?.({ code: 0, reason }); },
							onData: (cb: (data: string) => void) => { dataCb = cb; return () => {}; },
							onExit: (cb: (event: { code: number | null; signal?: string | number; reason?: string }) => void) => { exitCb = cb; return () => {}; },
						};
					},
				},
			},
			send: async (frame) => { frames.push(frame); },
			close: async (reason?: string) => { closed = reason; },
		});
		assert.deepEqual(frames.shift(), { kind: "json", data: { op: "status", state: "attached", pid: 77 } });
		dataCb?.("hello");
		assert.deepEqual(frames.shift(), { kind: "text", data: "hello" });
		await session.onClientFrame?.({ kind: "text", data: "pwd\n" });
		await session.onClientFrame?.({ kind: "json", data: { op: "resize", cols: 120, rows: 40 } });
		assert.deepEqual(writes, ["pwd\n"]);
		assert.deepEqual(resizes, [[120, 40]]);
		await session.onClientFrame?.({ kind: "json", data: { op: "kill", reason: "killed" } });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(frames.shift(), { kind: "json", data: { op: "exit", code: 0, signal: undefined, reason: "killed" } });
		assert.equal(closed, "killed");
	});

	it("awaits and reports rejected PTY proxy operations", async () => {
		const frames: unknown[] = [];
		const audits: unknown[] = [];
		let closed: string | undefined;
		const session = await terminalChannelHandler({
			host: {
				pty: {
					async openTerminal() {
						return {
							pid: 78,
							write: async () => { throw new Error("write failed"); },
							resize: async () => { throw new Error("resize failed"); },
							kill: async () => { throw new Error("kill failed"); },
							onData: () => () => {},
							onExit: () => () => {},
						};
					},
				},
			},
			send: async (frame) => { frames.push(frame); },
			close: async (reason?: string) => { closed = reason; },
			audit: (event) => { audits.push(event); },
		});
		assert.deepEqual(frames.shift(), { kind: "json", data: { op: "status", state: "attached", pid: 78 } });
		await session.onClientFrame?.({ kind: "json", data: { op: "resize", cols: 100, rows: 30 } });
		assert.deepEqual(frames.shift(), { kind: "json", data: { op: "error", operation: "resize", message: "resize failed" } });
		assert.equal(closed, undefined, "resize failures are reported without closing the terminal");
		await session.onClientFrame?.({ kind: "text", data: "pwd\n" });
		assert.deepEqual(frames.shift(), { kind: "json", data: { op: "error", operation: "write", message: "write failed" } });
		assert.equal(closed, "write failed");
		assert.ok(JSON.stringify(audits).includes("terminal_write_failed"));
	});
});

describe("ChannelPtyService", () => {
	it("exposes PTY only to channels declaring sessionPty", () => {
		const service = new ChannelPtyService();
		assert.deepEqual(service.buildHost({ contributionId: "c", name: "plain" }, "s1"), {});
		assert.equal(typeof service.buildHost({ contributionId: "c", name: "terminal", capabilities: ["sessionPty"] }, "s1").pty?.openTerminal, "function");
	});

	it("fails closed for read-only and sandboxed sessions before spawning", async () => {
		let spawned = 0;
		const ptyModule = { spawn: () => { spawned++; throw new Error("should not spawn"); } };
		const readOnly = new ChannelPtyService({ sessionManager: sessionManager({ readOnly: true }), ptyModule });
		await assert.rejects(() => readOnly.openTerminal("s1"), /read-only sessions/);
		const sandboxed = new ChannelPtyService({ sessionManager: sessionManager({ sandboxed: true }), ptyModule });
		await assert.rejects(() => sandboxed.openTerminal("s1"), /sandboxed sessions/);
		assert.equal(spawned, 0);
	});

	it("opens a narrow PTY handle in the session worktree cwd", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-pty-"));
		let spawnOpts: Record<string, unknown> | undefined;
		let onData: ((data: string) => void) | undefined;
		let onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
		const writes: string[] = [];
		const resizes: Array<[number, number]> = [];
		const ptyModule = {
			spawn(_file: string, _args: string[] | string, opts: Record<string, unknown>) {
				spawnOpts = opts;
				return {
					pid: 123,
					write: (data: string) => {
						writes.push(data);
						if (data.includes("exit")) onExit?.({ exitCode: 0 });
					},
					resize: (cols: number, rows: number) => { resizes.push([cols, rows]); },
					kill: () => { onExit?.({ exitCode: 0 }); },
					onData: (cb: (data: string) => void) => { onData = cb; return { dispose() {} }; },
					onExit: (cb: (event: { exitCode: number; signal?: number }) => void) => { onExit = cb; return { dispose() {} }; },
				};
			},
		};
		try {
			const service = new ChannelPtyService({ sessionManager: sessionManager({ worktreePath: cwd }), ptyModule });
			const pty = await service.openTerminal("s1", { cols: 100, rows: 30 });
			assert.equal(pty.pid, 123);
			assert.equal(spawnOpts?.cwd, cwd);
			assert.equal(spawnOpts?.cols, 100);
			assert.equal(spawnOpts?.rows, 30);
			let data = "";
			pty.onData((chunk) => { data += chunk; });
			onData?.("hello");
			assert.equal(data, "hello");
			pty.write("pwd\n");
			pty.resize(120, 40);
			assert.deepEqual(writes, ["pwd\n"]);
			assert.deepEqual(resizes, [[120, 40]]);
			let exitCode: number | null | undefined;
			pty.onExit((event) => { exitCode = event.code; });
			pty.kill("test");
			assert.equal(exitCode, 0);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes only terminal-safe environment variables to the PTY", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-pty-env-"));
		const envPatch: Record<string, string> = {
			OPENAI_API_KEY: "openai-secret",
			GITHUB_TOKEN: "github-secret",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			BOBBIT_TOKEN: "bobbit-secret",
			BOBBIT_GATEWAY_URL: "https://gateway.example.invalid",
			NPM_TOKEN: "npm-secret",
			LANG: "C.UTF-8",
			COLORTERM: "truecolor",
		};
		const original = new Map<string, string | undefined>();
		for (const key of Object.keys(envPatch)) {
			original.set(key, process.env[key]);
			process.env[key] = envPatch[key];
		}
		let spawnEnv: Record<string, string> | undefined;
		const ptyModule = {
			spawn(_file: string, _args: string[] | string, opts: Record<string, unknown>) {
				spawnEnv = opts.env as Record<string, string>;
				return {
					pid: 321,
					write() {},
					resize() {},
					kill() {},
					onData: () => ({ dispose() {} }),
					onExit: () => ({ dispose() {} }),
				};
			},
		};
		try {
			const service = new ChannelPtyService({ sessionManager: sessionManager({ worktreePath: cwd }), ptyModule });
			await service.openTerminal("s1");
			assert.ok(spawnEnv);
			assert.equal(spawnEnv!.TERM, "xterm-256color");
			assert.equal(spawnEnv!.COLORTERM, "truecolor");
			assert.equal(spawnEnv!.LANG, "C.UTF-8");
			assert.ok(spawnEnv!.PATH || spawnEnv!.Path, "PATH/Path should be preserved");
			for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "BOBBIT_TOKEN", "BOBBIT_GATEWAY_URL", "NPM_TOKEN"]) {
				assert.equal(spawnEnv![key], undefined, `${key} should be stripped from PTY env`);
			}
		} finally {
			for (const [key, value] of original) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

function sessionManager(overrides: { cwd?: string; worktreePath?: string; readOnly?: boolean; sandboxed?: boolean }) {
	const cwd = overrides.cwd ?? overrides.worktreePath ?? process.cwd();
	return {
		getSession: (id: string) => id === "s1" ? { id, cwd, ...overrides } : undefined,
		getPersistedSession: () => undefined,
	};
}
