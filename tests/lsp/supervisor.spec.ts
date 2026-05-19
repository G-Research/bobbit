/**
 * Supervisor unit tests — LRU eviction, idle shutdown, refcount release.
 *
 * Uses a fake LspClientFactory so we never spawn a real language server.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LspSupervisor } from "../../src/server/lsp/supervisor.ts";
import type { LspClient, LspClientFactory, SpawnOpts } from "../../src/server/lsp/client.ts";
import type { Language, SymbolInformation } from "../../src/server/lsp/types.ts";
import { TypescriptNoProjectError } from "../../src/server/lsp/clients/typescript.ts";

interface FakeClient extends LspClient {
	id: string;
	shutdownCalls: number;
	/** Trigger a synthetic crash by invoking the supervisor's onClose callback. */
	crash(): void;
}

interface MakeFactoryOpts {
	spawnHook?: (opts: SpawnOpts) => void;
}

function makeFactory(language: Language, shutdowns: string[], spawnedClients?: FakeClient[], hookOpts?: MakeFactoryOpts): LspClientFactory {
	return {
		language,
		isInstalled: () => true,
		async spawn(opts: SpawnOpts): Promise<LspClient> {
			hookOpts?.spawnHook?.(opts);
			const onClose = opts.onClose;
			const c: FakeClient = {
				id: opts.worktreePath,
				shutdownCalls: 0,
				language,
				worktreePath: opts.worktreePath,
				state: "warm",
				async ensureDocOpen() {},
				async definition() { return null; },
				async references() { return []; },
				async hover() { return null; },
				async diagnostics() { return []; },
				async documentSymbols() { return []; },
				async workspaceSymbol() { return []; },
				async rename() { return { changes: {} }; },
				async shutdown() {
					this.shutdownCalls++;
					shutdowns.push(opts.worktreePath);
				},
				crash() { onClose?.(false); },
			};
			spawnedClients?.push(c);
			return c;
		},
	};
}

describe("LspSupervisor LRU eviction", () => {
	test("evicts least-recently-used entry when cap exceeded", async () => {
		const shutdowns: string[] = [];
		const sup = new LspSupervisor({
			maxServers: 2,
			idleTtlMs: 60_000,
			factories: [makeFactory("typescript", shutdowns)],
		});

		await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
		// Sleep to space lastActivityAt
		await new Promise(r => setTimeout(r, 5));
		await sup.ensure({ worktreePath: "/wt/b", language: "typescript" });
		await new Promise(r => setTimeout(r, 5));
		await sup.ensure({ worktreePath: "/wt/c", language: "typescript" });

		// LRU was /wt/a
		assert.deepEqual(shutdowns, ["/wt/a"]);
		assert.equal(sup.stats().evictedTotal, 1);
		assert.equal(sup.stats().entries.length, 2);

		await sup.shutdownAll();
	});
});

describe("LspSupervisor idle shutdown", () => {
	test("shuts down idle entry after ttl expires", async () => {
		const shutdowns: string[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 50,
			factories: [makeFactory("typescript", shutdowns)],
		});
		await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
		sup.release("/wt/a");
		await new Promise(r => setTimeout(r, 200));
		assert.equal(shutdowns.length, 1);
		assert.equal(sup.stats().entries.length, 0);
		await sup.shutdownAll();
	});
});

describe("LspSupervisor release / acquire refcount", () => {
	test("does not idle-shutdown while refcount > 0", async () => {
		const shutdowns: string[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 50,
			factories: [makeFactory("typescript", shutdowns)],
		});
		await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
		sup.acquire("/wt/a");
		await new Promise(r => setTimeout(r, 150));
		assert.equal(shutdowns.length, 0);
		sup.release("/wt/a");
		await new Promise(r => setTimeout(r, 150));
		assert.equal(shutdowns.length, 1);
		await sup.shutdownAll();
	});
});

describe("LspSupervisor shutdownForWorktree", () => {
	test("force-stops all entries for a worktree", async () => {
		const shutdowns: string[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeFactory("typescript", shutdowns)],
		});
		await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
		await sup.shutdownForWorktree("/wt/a");
		assert.deepEqual(shutdowns, ["/wt/a"]);
		assert.equal(sup.stats().entries.length, 0);
		await sup.shutdownAll();
	});
});

// ── Finding #3: crash detection ───────────────────────────────────
describe("LspSupervisor crash detection", () => {
	test("unexpected exit removes entry; next ensure() respawns", async () => {
		const shutdowns: string[] = [];
		const spawned: FakeClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeFactory("typescript", shutdowns, spawned)],
		});
		await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
		assert.equal(spawned.length, 1);
		// Trigger a synthetic crash.
		spawned[0].crash();
		assert.equal(sup.stats().entries.length, 0, "dead entry should be dropped");
		// Next ensure() respawns a fresh client.
		await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
		assert.equal(spawned.length, 2, "supervisor should have respawned");
		await sup.shutdownAll();
	});

	test("three crashes within 60s disables the key for cooldown", async () => {
		const shutdowns: string[] = [];
		const spawned: FakeClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeFactory("typescript", shutdowns, spawned)],
		});
		for (let i = 0; i < 3; i++) {
			await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
			spawned[spawned.length - 1].crash();
		}
		await assert.rejects(
			sup.ensure({ worktreePath: "/wt/a", language: "typescript" }),
			(err: any) => err?.code === "lsp_unavailable" && /crashes/i.test(err.message),
		);
		await sup.shutdownAll();
	});
});

// ── Finding #4: acquire cancels idle timer ────────────────────────
describe("LspSupervisor acquire/release idle timer", () => {
	test("acquire after release cancels idle timer", async () => {
		const shutdowns: string[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 50,
			factories: [makeFactory("typescript", shutdowns)],
		});
		await sup.ensure({ worktreePath: "/wt/a", language: "typescript" });
		sup.release("/wt/a");        // arms timer
		sup.acquire("/wt/a");        // should cancel
		await new Promise(r => setTimeout(r, 120));
		assert.equal(shutdowns.length, 0, "acquire must cancel the idle timer");
		assert.equal(sup.stats().entries.length, 1);
		await sup.shutdownAll();
	});
});

// ── Finding #5: tsconfig watcher triggers graceful restart ────────
describe("LspSupervisor config-file watcher", () => {
	test("touching tsconfig.json removes the entry (lazy respawn)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-watch-"));
		fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
		const shutdowns: string[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeFactory("typescript", shutdowns)],
			configChangeDebounceMs: 50,
		});
		await sup.ensure({ worktreePath: dir, language: "typescript" });
		assert.equal(sup.stats().entries.length, 1);
		fs.writeFileSync(path.join(dir, "tsconfig.json"), "{ \"compilerOptions\": {} }");
		// Wait for the debounce + shutdown.
		for (let i = 0; i < 50 && sup.stats().entries.length > 0; i++) {
			await new Promise(r => setTimeout(r, 50));
		}
		assert.equal(sup.stats().entries.length, 0, "watcher should drop the entry");
		assert.equal(shutdowns.length, 1);
		await sup.shutdownAll();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	});
});

// ── Finding #1: disabled kill switch ──────────────────────────────
describe("LspSupervisor disabled config", () => {
	test("ensure() and dispatch() reject when disabled=true", async () => {
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			disabled: true,
			factories: [makeFactory("typescript", [])],
		});
		await assert.rejects(
			sup.ensure({ worktreePath: "/wt/a", language: "typescript" }),
			(err: any) => err?.code === "lsp_unavailable",
		);
		assert.equal(sup.disabled, true);
	});
	test("preWarmEnabled=false makes preWarm a no-op", async () => {
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			preWarmEnabled: false,
			factories: [makeFactory("typescript", [])],
		});
		sup.preWarm("/wt/a");
		await new Promise(r => setTimeout(r, 50));
		assert.equal(sup.stats().entries.length, 0);
	});
});

// ── Finding #7: path containment in dispatch ──────────────────────
describe("LspSupervisor dispatch path containment", () => {
	test("rejects absolute paths", async () => {
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeFactory("typescript", [])],
		});
		await assert.rejects(
			sup.dispatch("definition", { cwd: "/wt/a", path: "/etc/passwd", line: 0, character: 0 }),
			(err: any) => err?.code === "lsp_unavailable" && /outside worktree/.test(err.message),
		);
	});
	test("rejects ../ traversal", async () => {
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeFactory("typescript", [])],
		});
		await assert.rejects(
			sup.dispatch("definition", { cwd: "/wt/a", path: "../../etc/passwd", line: 0, character: 0 }),
			(err: any) => err?.code === "lsp_unavailable" && /outside worktree/.test(err.message),
		);
	});
});

// ── TypeScript workspace_symbol `No Project` retry ────────────────
interface RecordingClient extends LspClient {
	workspaceSymbolCalls: number;
	ensureDocOpenCalls: string[];
	documentSymbolsCalls: string[];
	workspaceSymbolImpl: (query: string) => Promise<SymbolInformation[]>;
	documentSymbolsImpl?: (absPath: string) => Promise<unknown[]>;
}

function makeRecordingFactory(clients: RecordingClient[]): LspClientFactory {
	return {
		language: "typescript",
		isInstalled: () => true,
		async spawn(opts: SpawnOpts): Promise<LspClient> {
			const c: RecordingClient = {
				language: "typescript",
				worktreePath: opts.worktreePath,
				state: "warm",
				workspaceSymbolCalls: 0,
				ensureDocOpenCalls: [],
				documentSymbolsCalls: [],
				workspaceSymbolImpl: async () => [],
				async ensureDocOpen(absPath: string) { this.ensureDocOpenCalls.push(absPath); },
				async definition() { return null; },
				async references() { return []; },
				async hover() { return null; },
				async diagnostics() { return []; },
				async documentSymbols(absPath: string) {
					this.documentSymbolsCalls.push(absPath);
					return this.documentSymbolsImpl ? (await this.documentSymbolsImpl(absPath)) as any : [];
				},
				async workspaceSymbol(query: string) {
					this.workspaceSymbolCalls++;
					return this.workspaceSymbolImpl(query);
				},
				async rename() { return { changes: {} }; },
				async shutdown() {},
			};
			clients.push(c);
			return c;
		},
	};
}

function mkTsWorktree(opts: { withIndex?: boolean } = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-sup-noproj-"));
	fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
	if (opts.withIndex !== false) {
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
	}
	return fs.realpathSync(dir);
}

describe("LspSupervisor workspace_symbol No Project retry", () => {
	test("first call throws No Project, probes src/index.ts, retries once", async () => {
		const dir = mkTsWorktree();
		const clients: RecordingClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeRecordingFactory(clients)],
		});
		// Spawn the client up-front so we can configure its workspaceSymbol impl.
		await sup.ensure({ worktreePath: dir, language: "typescript" });
		const c = clients[0];
		let calls = 0;
		c.workspaceSymbolImpl = async () => {
			calls++;
			if (calls === 1) throw new TypescriptNoProjectError("No Project");
			return [{
				name: "x",
				kind: 13,
				path: path.join(dir, "src", "index.ts"),
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			}];
		};

		const out = (await sup.dispatch("workspace_symbol", { cwd: dir, query: "x" })) as Array<{ path: string }>;
		assert.equal(c.workspaceSymbolCalls, 2, "should call workspaceSymbol twice (initial + retry)");
		assert.deepEqual(c.documentSymbolsCalls, [path.join(dir, "src", "index.ts")]);
		assert.deepEqual(c.ensureDocOpenCalls, [path.join(dir, "src", "index.ts")]);
		assert.equal(out.length, 1);
		// Returned paths are relative to cwd.
		assert.equal(out[0].path, path.join("src", "index.ts"));
		await sup.shutdownAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("retry failure: workspaceSymbol called exactly twice, error propagates", async () => {
		const dir = mkTsWorktree();
		const clients: RecordingClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeRecordingFactory(clients)],
		});
		await sup.ensure({ worktreePath: dir, language: "typescript" });
		const c = clients[0];
		c.workspaceSymbolImpl = async () => { throw new TypescriptNoProjectError("No Project"); };

		await assert.rejects(
			sup.dispatch("workspace_symbol", { cwd: dir, query: "x" }),
			(err: any) => err instanceof TypescriptNoProjectError,
		);
		assert.equal(c.workspaceSymbolCalls, 2, "no loop — exactly two calls");
		assert.equal(c.documentSymbolsCalls.length, 1);
		await sup.shutdownAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("non-No-Project error is not retried and does not probe", async () => {
		const dir = mkTsWorktree();
		const clients: RecordingClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeRecordingFactory(clients)],
		});
		await sup.ensure({ worktreePath: dir, language: "typescript" });
		const c = clients[0];
		c.workspaceSymbolImpl = async () => { throw new Error("transient boom"); };

		await assert.rejects(
			sup.dispatch("workspace_symbol", { cwd: dir, query: "x" }),
			(err: any) => err?.message === "transient boom",
		);
		assert.equal(c.workspaceSymbolCalls, 1);
		assert.equal(c.documentSymbolsCalls.length, 0);
		assert.equal(c.ensureDocOpenCalls.length, 0);
		await sup.shutdownAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("already-ready: succeeds on first call, no probe", async () => {
		const dir = mkTsWorktree();
		const clients: RecordingClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeRecordingFactory(clients)],
		});
		await sup.ensure({ worktreePath: dir, language: "typescript" });
		const c = clients[0];
		c.workspaceSymbolImpl = async () => [{
			name: "x", kind: 13,
			path: path.join(dir, "src", "index.ts"),
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		}];

		const out = (await sup.dispatch("workspace_symbol", { cwd: dir, query: "x" })) as unknown[];
		assert.equal(out.length, 1);
		assert.equal(c.workspaceSymbolCalls, 1);
		assert.equal(c.documentSymbolsCalls.length, 0);
		assert.equal(c.ensureDocOpenCalls.length, 0);
		await sup.shutdownAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("no representative file: retries once and propagates without probe side effects", async () => {
		// Worktree with tsconfig but no .ts/.js files anywhere — probe finds nothing.
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lsp-sup-empty-")));
		fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
		const clients: RecordingClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeRecordingFactory(clients)],
		});
		await sup.ensure({ worktreePath: dir, language: "typescript" });
		const c = clients[0];
		c.workspaceSymbolImpl = async () => { throw new TypescriptNoProjectError("No Project"); };

		await assert.rejects(
			sup.dispatch("workspace_symbol", { cwd: dir, query: "x" }),
			(err: any) => err instanceof TypescriptNoProjectError,
		);
		assert.equal(c.workspaceSymbolCalls, 2);
		assert.equal(c.ensureDocOpenCalls.length, 0);
		assert.equal(c.documentSymbolsCalls.length, 0);
		await sup.shutdownAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("concurrent cold calls coalesce to a single documentSymbols probe", async () => {
		const dir = mkTsWorktree();
		const clients: RecordingClient[] = [];
		const sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [makeRecordingFactory(clients)],
		});
		await sup.ensure({ worktreePath: dir, language: "typescript" });
		const c = clients[0];
		let probeRelease: () => void = () => {};
		const probeGate = new Promise<void>(resolve => { probeRelease = resolve; });
		c.documentSymbolsImpl = async () => { await probeGate; return []; };
		const seenReady = { value: false };
		c.workspaceSymbolImpl = async () => {
			if (!seenReady.value) {
				// First call from each concurrent dispatch hits No Project.
				throw new TypescriptNoProjectError("No Project");
			}
			return [];
		};

		const p1 = sup.dispatch("workspace_symbol", { cwd: dir, query: "x" });
		const p2 = sup.dispatch("workspace_symbol", { cwd: dir, query: "y" });
		// Let both initial workspaceSymbol calls fire and queue on the probe.
		await new Promise(r => setTimeout(r, 20));
		seenReady.value = true;
		probeRelease();
		await Promise.all([p1, p2]);
		assert.equal(c.documentSymbolsCalls.length, 1, "only one probe should run");
		assert.equal(c.ensureDocOpenCalls.length, 1);
		assert.equal(c.workspaceSymbolCalls, 4, "two initial + two retries");
		await sup.shutdownAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe("LspSupervisor missing adapter", () => {
	test("ensure() throws lsp_unavailable when no factory matches", async () => {
		const sup = new LspSupervisor({ maxServers: 4, idleTtlMs: 1000, factories: [] });
		await assert.rejects(
			sup.ensure({ worktreePath: "/wt/x", language: "typescript" }),
			(err: any) => err?.code === "lsp_unavailable",
		);
	});
});
