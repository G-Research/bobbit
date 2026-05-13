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
import type { Language } from "../../src/server/lsp/types.ts";

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

describe("LspSupervisor missing adapter", () => {
	test("ensure() throws lsp_unavailable when no factory matches", async () => {
		const sup = new LspSupervisor({ maxServers: 4, idleTtlMs: 1000, factories: [] });
		await assert.rejects(
			sup.ensure({ worktreePath: "/wt/x", language: "typescript" }),
			(err: any) => err?.code === "lsp_unavailable",
		);
	});
});
