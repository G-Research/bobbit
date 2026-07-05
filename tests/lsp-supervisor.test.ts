/**
 * Unit tests for `TsServerSupervisor` (docs/design/lsp-product-tools.md §1,
 * §6): lazy spawn-per-worktree keying, idle-shutdown, crash fail-open,
 * missing-tsconfig/unspawnable-binary fail-open, didOpen-once, and result
 * cap+truncate behavior.
 *
 * The real `typescript-language-server` binary is never spawned here — a
 * stubbed fake LSP server process (a plain EventEmitter that parses the same
 * Content-Length framing `LspClient` writes, and answers `initialize`/
 * `shutdown` automatically) stands in via `TsServerSupervisorOptions.spawnProcess`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TsServerSupervisor } from "../src/server/lsp/supervisor.ts";

// ── Fake tsserver-like process ──────────────────────────────────────────────

interface FakeServerOpts {
	/** Never respond to `initialize` (and never emit an error) — used to exercise the init-timeout path. Mutually exclusive with `failToSpawn`. */
	hangOnInit?: boolean;
	/** Emit a process 'error' shortly after creation, before `initialize` completes — simulates an unspawnable binary (ENOENT). */
	failToSpawn?: boolean;
	/** Per-method response for query requests (`textDocument/definition`, `textDocument/references`, `textDocument/hover`, `textDocument/documentSymbol`, `workspace/symbol`). Methods not present here get `null`. */
	responses?: Record<string, unknown>;
	/** Called for every incoming message (request or notification) — used to count didOpen calls etc. */
	onMessage?: (msg: any) => void;
}

interface FakeServer {
	proc: any;
	killCount: number;
	requestCounts: Record<string, number>;
}

function makeFakeServer(opts: FakeServerOpts = {}): FakeServer {
	const proc: any = new EventEmitter();
	const stdout = new EventEmitter();
	proc.stdout = stdout;
	let buf = "";
	const state: FakeServer = { proc, killCount: 0, requestCounts: {} };

	function send(obj: unknown) {
		const json = JSON.stringify(obj);
		const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
		queueMicrotask(() => stdout.emit("data", Buffer.from(header + json)));
	}

	function handle(msg: any) {
		opts.onMessage?.(msg);
		if (opts.hangOnInit) return; // never answer anything
		if (msg.method === "initialize") {
			send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
			return;
		}
		if (msg.method === "shutdown") {
			send({ jsonrpc: "2.0", id: msg.id, result: null });
			return;
		}
		if (msg.id === undefined) return; // notification (initialized, didOpen, exit)
		state.requestCounts[msg.method] = (state.requestCounts[msg.method] ?? 0) + 1;
		const result = opts.responses?.[msg.method] ?? null;
		send({ jsonrpc: "2.0", id: msg.id, result });
	}

	proc.stdin = {
		write(data: string) {
			buf += data;
			for (;;) {
				const headerEnd = buf.indexOf("\r\n\r\n");
				if (headerEnd === -1) break;
				const header = buf.slice(0, headerEnd);
				const match = /Content-Length: (\d+)/i.exec(header);
				if (!match) break;
				const len = Number(match[1]);
				const bodyStart = headerEnd + 4;
				if (buf.length < bodyStart + len) break;
				const body = buf.slice(bodyStart, bodyStart + len);
				buf = buf.slice(bodyStart + len);
				handle(JSON.parse(body));
			}
			return true;
		},
	};
	proc.kill = () => {
		state.killCount++;
		queueMicrotask(() => proc.emit("exit", null));
	};

	if (opts.failToSpawn) {
		queueMicrotask(() => proc.emit("error", new Error("spawn typescript-language-server ENOENT")));
	}

	return state;
}

// ── Fixture worktree (real files — `prepare()` does real fs checks) ────────

function makeFixtureWorktree(): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-lsp-supervisor-"));
	fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
	const file = path.join(dir, "index.ts");
	fs.writeFileSync(file, "export const x = 1;\n");
	return { dir, file };
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

describe("TsServerSupervisor — keying + lazy spawn", () => {
	it("reuses one instance across repeated calls for the same worktree", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			let spawnCount = 0;
			const servers: FakeServer[] = [];
			const sup = new TsServerSupervisor({
				spawnProcess: () => {
					spawnCount++;
					const s = makeFakeServer({ responses: { "textDocument/definition": [{ uri: `file://${file}`, range: { start: { line: 0, character: 0 } } }] } });
					servers.push(s);
					return s.proc;
				},
			});
			const out1 = await sup.definition({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			const out2 = await sup.definition({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(spawnCount, 1);
			assert.equal(out1.available, true);
			assert.equal(out2.available, true);
			assert.equal(sup.hasInstance(dir), true);
			await sup.shutdownAll();
		} finally {
			cleanup(dir);
		}
	});

	it("keys separate instances per worktreeRoot", async () => {
		const a = makeFixtureWorktree();
		const b = makeFixtureWorktree();
		try {
			let spawnCount = 0;
			const sup = new TsServerSupervisor({
				spawnProcess: () => {
					spawnCount++;
					// A non-empty documentSymbol response — [] is treated as "still
					// loading, keep polling" by isEmptyResult, which would make this
					// test wait out the (60s default) cold timeout for no reason.
					return makeFakeServer({ responses: { "textDocument/documentSymbol": [{ name: "x", kind: 13, range: { start: { line: 0 } } }] } }).proc;
				},
			});
			await sup.symbols({ worktreeRoot: a.dir, absFile: a.file });
			await sup.symbols({ worktreeRoot: b.dir, absFile: b.file });
			assert.equal(spawnCount, 2);
			assert.equal(sup.instanceCount, 2);
			await sup.shutdownAll();
		} finally {
			cleanup(a.dir);
			cleanup(b.dir);
		}
	});

	it("opens a file at most once per instance (didOpen sent exactly once across repeated queries)", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			let didOpenCount = 0;
			const sup = new TsServerSupervisor({
				spawnProcess: () =>
					makeFakeServer({
						responses: { "textDocument/hover": { contents: "type X" } },
						onMessage: (msg) => {
							if (msg.method === "textDocument/didOpen") didOpenCount++;
						},
					}).proc,
			});
			await sup.hover({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			await sup.hover({ worktreeRoot: dir, absFile: file, line: 1, col: 5 });
			assert.equal(didOpenCount, 1);
			await sup.shutdownAll();
		} finally {
			cleanup(dir);
		}
	});
});

describe("TsServerSupervisor — fail-open", () => {
	it("missing tsconfig.json returns available:false without spawning", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-lsp-notsconfig-"));
		const file = path.join(dir, "index.ts");
		fs.writeFileSync(file, "export const x = 1;\n");
		try {
			let spawnCount = 0;
			const sup = new TsServerSupervisor({ spawnProcess: () => { spawnCount++; return makeFakeServer().proc; } });
			const out = await sup.definition({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(out.available, false);
			if (!out.available) assert.match(out.reason, /tsconfig\.json/);
			assert.equal(spawnCount, 0);
		} finally {
			cleanup(dir);
		}
	});

	it("non-existent file returns available:false without spawning", async () => {
		const { dir } = makeFixtureWorktree();
		try {
			let spawnCount = 0;
			const sup = new TsServerSupervisor({ spawnProcess: () => { spawnCount++; return makeFakeServer().proc; } });
			const out = await sup.definition({ worktreeRoot: dir, absFile: path.join(dir, "nope.ts"), line: 1, col: 1 });
			assert.equal(out.available, false);
			assert.equal(spawnCount, 0);
		} finally {
			cleanup(dir);
		}
	});

	it("an unspawnable binary (ENOENT-like) yields a retryable unavailable result, never a throw/hang", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			const sup = new TsServerSupervisor({ spawnProcess: () => makeFakeServer({ failToSpawn: true }).proc });
			const out = await sup.definition({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(out.available, false);
			if (!out.available) {
				assert.match(out.reason, /failed to spawn/i);
				assert.equal(out.retryable, true);
			}
		} finally {
			cleanup(dir);
		}
	});

	it("an init that never responds times out into a typed result instead of hanging forever", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			const sup = new TsServerSupervisor({ initTimeoutMs: 20, spawnProcess: () => makeFakeServer({ hangOnInit: true }).proc });
			const out = await sup.definition({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(out.available, false);
		} finally {
			cleanup(dir);
		}
	});

	it("a mid-session crash marks the instance dead; the next call gets a fresh spawn", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			let spawnCount = 0;
			const procs: any[] = [];
			const fakeLoc = [{ uri: `file://${file}`, range: { start: { line: 0, character: 0 } } }];
			const sup = new TsServerSupervisor({
				spawnProcess: () => {
					spawnCount++;
					const s = makeFakeServer({ responses: { "textDocument/definition": fakeLoc } });
					procs.push(s.proc);
					return s.proc;
				},
			});
			const first = await sup.definition({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(first.available, true);
			assert.equal(spawnCount, 1);
			assert.equal(sup.hasInstance(dir), true);

			// Simulate a tsserver crash.
			procs[0].emit("exit", 1);
			// Give the crash handler's synchronous work a tick.
			await new Promise((r) => setImmediate(r));
			assert.equal(sup.hasInstance(dir), false, "a crashed instance must never be silently reused");

			// The NEXT call must get a fresh spawn, not hang or throw against the dead one.
			const second = await sup.definition({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(spawnCount, 2);
			assert.equal(second.available, true);
		} finally {
			cleanup(dir);
		}
	});
});

describe("TsServerSupervisor — idle shutdown", () => {
	it("evicts an idle instance after idleMs and respawns on the next call", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			let spawnCount = 0;
			const killCounts: number[] = [];
			const sup = new TsServerSupervisor({
				idleMs: 15,
				spawnProcess: () => {
					spawnCount++;
					const s = makeFakeServer({ responses: { "textDocument/hover": { contents: "x" } } });
					killCounts.push(0);
					const origKill = s.proc.kill;
					s.proc.kill = () => { killCounts[killCounts.length - 1]++; origKill(); };
					return s.proc;
				},
			});
			await sup.hover({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(spawnCount, 1);
			await new Promise((r) => setTimeout(r, 60));
			assert.equal(sup.hasInstance(dir), false, "instance should have been idle-evicted");
			assert.equal(killCounts[0], 1);

			await sup.hover({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(spawnCount, 2);
		} finally {
			cleanup(dir);
		}
	});
});

describe("TsServerSupervisor — result caps", () => {
	it("caps references and marks truncated with the real totalCount", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			const fakeLocations = Array.from({ length: 5 }, (_, i) => ({
				uri: `file://${file}`,
				range: { start: { line: i, character: 0 } },
			}));
			const sup = new TsServerSupervisor({
				locationsCap: 3,
				spawnProcess: () => makeFakeServer({ responses: { "textDocument/references": fakeLocations } }).proc,
			});
			const out = await sup.references({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(out.available, true);
			if (out.available) {
				assert.equal(out.locations.length, 3);
				assert.equal(out.truncated, true);
				assert.equal(out.totalCount, 5);
			}
			await sup.shutdownAll();
		} finally {
			cleanup(dir);
		}
	});

	it("caps hover text and appends a truncation note", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			const longText = "x".repeat(100);
			const sup = new TsServerSupervisor({
				hoverCharCap: 10,
				spawnProcess: () => makeFakeServer({ responses: { "textDocument/hover": { contents: longText } } }).proc,
			});
			const out = await sup.hover({ worktreeRoot: dir, absFile: file, line: 1, col: 1 });
			assert.equal(out.available, true);
			if (out.available) {
				assert.equal(out.truncated, true);
				assert.equal(out.totalChars, 100);
				assert.ok(out.contents.startsWith("x".repeat(10)));
				assert.match(out.contents, /truncated/);
			}
			await sup.shutdownAll();
		} finally {
			cleanup(dir);
		}
	});

	it("does not truncate when the result fits under the cap", async () => {
		const { dir, file } = makeFixtureWorktree();
		try {
			const sup = new TsServerSupervisor({
				symbolsCap: 50,
				spawnProcess: () =>
					makeFakeServer({ responses: { "textDocument/documentSymbol": [{ name: "x", kind: 13, range: { start: { line: 0 } } }] } }).proc,
			});
			const out = await sup.symbols({ worktreeRoot: dir, absFile: file });
			assert.equal(out.available, true);
			if (out.available) {
				assert.equal(out.truncated, false);
				assert.equal(out.totalCount, 1);
				assert.equal(out.mode, "file");
			}
			await sup.shutdownAll();
		} finally {
			cleanup(dir);
		}
	});
});

describe("TsServerSupervisor — shutdownAll", () => {
	it("kills every live instance and clears the map", async () => {
		const a = makeFixtureWorktree();
		const b = makeFixtureWorktree();
		try {
			const killed: string[] = [];
			const sup = new TsServerSupervisor({
				spawnProcess: (root: string) => {
					// Non-empty documentSymbol response — see the "keys separate
					// instances" test above for why [] would hang this out to the
					// (60s default) cold timeout instead of resolving immediately.
					const s = makeFakeServer({ responses: { "textDocument/documentSymbol": [{ name: "x", kind: 13, range: { start: { line: 0 } } }] } });
					const origKill = s.proc.kill;
					s.proc.kill = () => { killed.push(root); origKill(); };
					return s.proc;
				},
			});
			await sup.symbols({ worktreeRoot: a.dir, absFile: a.file });
			await sup.symbols({ worktreeRoot: b.dir, absFile: b.file });
			assert.equal(sup.instanceCount, 2);
			await sup.shutdownAll();
			assert.equal(sup.instanceCount, 0);
			assert.equal(killed.length, 2);
		} finally {
			cleanup(a.dir);
			cleanup(b.dir);
		}
	});
});
