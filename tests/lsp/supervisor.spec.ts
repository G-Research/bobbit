/**
 * Supervisor unit tests — LRU eviction, idle shutdown, refcount release.
 *
 * Uses a fake LspClientFactory so we never spawn a real language server.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { LspSupervisor } from "../../src/server/lsp/supervisor.ts";
import type { LspClient, LspClientFactory, SpawnOpts } from "../../src/server/lsp/client.ts";
import type { Language } from "../../src/server/lsp/types.ts";

interface FakeClient extends LspClient {
	id: string;
	shutdownCalls: number;
}

function makeFactory(language: Language, shutdowns: string[]): LspClientFactory {
	return {
		language,
		isInstalled: () => true,
		async spawn(opts: SpawnOpts): Promise<LspClient> {
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
			};
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

describe("LspSupervisor missing adapter", () => {
	test("ensure() throws lsp_unavailable when no factory matches", async () => {
		const sup = new LspSupervisor({ maxServers: 4, idleTtlMs: 1000, factories: [] });
		await assert.rejects(
			sup.ensure({ worktreePath: "/wt/x", language: "typescript" }),
			(err: any) => err?.code === "lsp_unavailable",
		);
	});
});
