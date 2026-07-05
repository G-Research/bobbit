/**
 * Unit tests for McpWiring (SessionManager decomposition cohort 2,
 * docs/design/session-manager-decomposition.md). Exercises the extracted MCP
 * client wiring directly against a fake McpWiringDeps — no SessionManager, no
 * sessions map, no RpcBridge, no sandbox — the same payoff
 * archived-worktree-manager.test.ts's own header comment cites for cohort 1.
 *
 * Several tests specifically pin the TEST-SEAM HAZARD design documented in
 * mcp-wiring.ts's header comment: `createMcpManager`, `ensureMcpManager`,
 * `ensureMcpManagerForContext`, and `refreshExternalMcpToolRegistrations`
 * round-trip through `deps.<name>()` instead of this class's own copy,
 * because SessionManager's real (non-test) delegating wrappers are exactly
 * what several pre-existing unit tests monkey-patch.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpWiring, type McpWiringDeps } from "../src/server/agent/mcp-wiring.ts";
import { McpManager } from "../src/server/mcp/mcp-manager.ts";

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
});

/** Minimal fake McpManager satisfying every method McpWiring calls. */
function makeFakeMcpManager(overrides: Record<string, unknown> = {}): any {
	return {
		connectAll: async () => {},
		disconnectAll: async () => {},
		getToolInfos: () => [],
		getToolRegistrationRefresh: () => ({ removePrefixes: ["mcp__"], toolInfos: [] }),
		getDiscoveryScope: () => ({ cwd: "/fake" }),
		getScopeKey: () => "fake",
		reloadDiscoveredServers: async () => ({ status: "ok", connected: [], disconnected: [], unchanged: [], skippedErrored: [], failed: [], statuses: [] }),
		currentReload: () => undefined,
		setMarketplaceResolver: () => {},
		setAdditionalProjects: () => {},
		...overrides,
	};
}

function makeDeps(overrides: Partial<McpWiringDeps> = {}): McpWiringDeps & { calls: Record<string, unknown[]> } {
	const calls: Record<string, unknown[]> = {
		createMcpManager: [],
		ensureMcpManager: [],
		ensureMcpManagerForContext: [],
		refreshExternalMcpToolRegistrations: [],
	};
	const base: McpWiringDeps = {
		toolManager: undefined,
		projectConfigStore: undefined,
		projectContextManager: null,
		resolveSessionScope: () => ({}),
		isCwdInUseByLiveSession: () => false,
		createMcpManager: (cwd, opts) => { calls.createMcpManager.push({ cwd, opts }); return makeFakeMcpManager(); },
		ensureMcpManager: async (scope) => { calls.ensureMcpManager.push(scope); return null; },
		ensureMcpManagerForContext: async (projectId, cwd) => { calls.ensureMcpManagerForContext.push({ projectId, cwd }); return null; },
		refreshExternalMcpToolRegistrations: () => { calls.refreshExternalMcpToolRegistrations.push(undefined); },
	};
	return Object.assign(base, overrides, { calls });
}

describe("McpWiring", () => {
	it("getMcpManager returns the default manager for no scope, and scoped managers by scopeKey", () => {
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		const defaultMgr = makeFakeMcpManager();
		const scopedMgr = makeFakeMcpManager();
		wiring.mcpManager = defaultMgr;
		wiring.scopedMcpManagers.set("project:p1", scopedMgr);

		assert.equal(wiring.getMcpManager(), defaultMgr);
		assert.equal(wiring.getMcpManager({ projectId: "p1" }), scopedMgr);
		assert.equal(wiring.getMcpManager({ projectId: "missing" }), null);
	});

	it("getActiveMcpManagers aggregates the default manager and every scoped manager", () => {
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		const defaultMgr = makeFakeMcpManager();
		const scoped1 = makeFakeMcpManager();
		const scoped2 = makeFakeMcpManager();
		wiring.mcpManager = defaultMgr;
		wiring.scopedMcpManagers.set("a", scoped1);
		wiring.scopedMcpManagers.set("b", scoped2);

		const active = wiring.getActiveMcpManagers();
		assert.deepEqual(active, [defaultMgr, scoped1, scoped2]);
	});

	it("refreshExternalMcpToolRegistrations no-ops without a toolManager and registers tool infos when one is present", () => {
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		// No toolManager wired — must not throw.
		wiring.refreshExternalMcpToolRegistrations();

		const registered: unknown[] = [];
		const removed: string[] = [];
		const withTools = makeDeps({
			toolManager: {
				removeExternalTools: (prefix: string) => removed.push(prefix),
				registerExternalTools: (infos: unknown[]) => registered.push(...infos),
			} as any,
		});
		const wiring2 = new McpWiring(withTools);
		wiring2.mcpManager = makeFakeMcpManager({
			getToolRegistrationRefresh: () => ({ removePrefixes: ["mcp__"], toolInfos: [{ name: "mcp__x__y", description: "d", serverName: "x", mcpToolName: "y" }] }),
		});
		wiring2.refreshExternalMcpToolRegistrations();
		assert.deepEqual(removed, ["mcp__"]);
		assert.equal(registered.length, 1);
		assert.equal((registered[0] as any).name, "mcp__x__y");
	});

	it("ensureMcpManager returns the cached default manager without calling deps.createMcpManager", async () => {
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		const defaultMgr = makeFakeMcpManager();
		wiring.mcpManager = defaultMgr;

		assert.equal(await wiring.ensureMcpManager(), defaultMgr);
		assert.deepEqual(deps.calls.createMcpManager, []);
	});

	it("ensureMcpManager creates, connects, and caches a new scoped manager via deps.createMcpManager", async () => {
		let connectCalls = 0;
		const fakeScoped = makeFakeMcpManager({ connectAll: async () => { connectCalls++; } });
		const deps = makeDeps({ createMcpManager: (cwd, opts) => { deps.calls.createMcpManager.push({ cwd, opts }); return fakeScoped; } });
		const wiring = new McpWiring(deps);

		const result = await wiring.ensureMcpManager({ cwd: "/tmp/x" });
		assert.equal(result, fakeScoped);
		assert.equal(connectCalls, 1);
		assert.equal(deps.calls.createMcpManager.length, 1);
		// Second call for the same scope must hit the cache, not create again.
		const cached = await wiring.ensureMcpManager({ cwd: "/tmp/x" });
		assert.equal(cached, fakeScoped);
		assert.equal(deps.calls.createMcpManager.length, 1);
	});

	it("ensureMcpManager returns null for a project scope with no projectContextManager and no cwd", async () => {
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		assert.equal(await wiring.ensureMcpManager({ projectId: "p1" }), null);
		assert.deepEqual(deps.calls.createMcpManager, []);
	});

	it("cleanupScopedMcpManagersForProject disconnects and removes matching scoped managers, refreshing tool registrations", async () => {
		let disconnected = 0;
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		const projectRoot = "/repo/project-a";
		const matching = makeFakeMcpManager({
			disconnectAll: async () => { disconnected++; },
			getDiscoveryScope: () => ({ cwd: projectRoot, projectId: "proj-a" }),
		});
		const unrelated = makeFakeMcpManager({ getDiscoveryScope: () => ({ cwd: "/repo/other" }) });
		wiring.scopedMcpManagers.set("project:proj-a", matching);
		wiring.scopedMcpManagers.set("cwd:/repo/other", unrelated);

		await wiring.cleanupScopedMcpManagersForProject("proj-a", projectRoot);

		assert.equal(disconnected, 1);
		assert.equal(wiring.scopedMcpManagers.has("project:proj-a"), false);
		assert.equal(wiring.scopedMcpManagers.has("cwd:/repo/other"), true);
		assert.equal(deps.calls.refreshExternalMcpToolRegistrations.length, 1);
	});

	it("cleanupScopedMcpManagersForSessionScope removes a scoped manager only when no live session still uses its cwd", async () => {
		const cwd = "/repo/session-cwd";
		let stillInUse = true;
		const deps = makeDeps({ isCwdInUseByLiveSession: () => stillInUse });
		const wiring = new McpWiring(deps);
		let disconnected = 0;
		wiring.scopedMcpManagers.set(`cwd:${path.resolve(cwd)}`, makeFakeMcpManager({ disconnectAll: async () => { disconnected++; } }));

		await wiring.cleanupScopedMcpManagersForSessionScope({ cwd });
		assert.equal(disconnected, 0, "must not disconnect while a live session still uses the cwd");

		stillInUse = false;
		await wiring.cleanupScopedMcpManagersForSessionScope({ cwd });
		assert.equal(disconnected, 1, "must disconnect once no live session uses the cwd");
	});

	it("getMcpManagerForContext/ensureMcpManagerForContext return null without a projectId", async () => {
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		assert.equal(wiring.getMcpManagerForContext(undefined, "/tmp/x"), null);
		assert.equal(await wiring.ensureMcpManagerForContext(undefined, "/tmp/x"), null);
		// ensureMcpManagerForContext with no projectId must short-circuit before
		// ever reaching deps.ensureMcpManager.
		assert.deepEqual(deps.calls.ensureMcpManager, []);
	});

	it("getMcpManagerForSession/ensureMcpManagerForSession/resolveMcpManagerForSession route session lookups through deps.resolveSessionScope", async () => {
		const scopesById: Record<string, { projectId?: string; cwd?: string }> = {
			"s-with-project": { projectId: "proj-1", cwd: "/repo/proj-1" },
			"s-no-project": {},
		};
		const deps = makeDeps({ resolveSessionScope: (id) => scopesById[id] ?? {} });
		const wiring = new McpWiring(deps);
		const scoped = makeFakeMcpManager();
		wiring.scopedMcpManagers.set("project:proj-1", scoped);

		assert.equal(wiring.getMcpManagerForSession("s-with-project"), scoped);
		assert.equal(wiring.getMcpManagerForSession("s-no-project"), null);

		await wiring.ensureMcpManagerForSession("s-with-project");
		assert.deepEqual(deps.calls.ensureMcpManagerForContext.at(-1), { projectId: "proj-1", cwd: "/repo/proj-1" });

		// resolveMcpManagerForSession with a matching scopeKey returns the cached scoped manager directly.
		assert.equal(await wiring.resolveMcpManagerForSession("s-with-project", "project:proj-1"), scoped);
		// A scopeKey that does not match the session's own project scope is refused.
		assert.equal(await wiring.resolveMcpManagerForSession("s-with-project", "project:other"), null);
	});

	it("reloadMcpAfterMarketplaceMutation aggregates statuses and defers the tool-registration refresh until a pending reload resolves", async () => {
		let releasePending!: () => void;
		const pending = new Promise<any>((resolve) => { releasePending = () => resolve({ status: "ok", connected: ["late"], disconnected: [], unchanged: [], skippedErrored: [], failed: [], statuses: [] }); });
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		wiring.mcpManager = makeFakeMcpManager({
			reloadDiscoveredServers: async () => ({ status: "pending", connected: [], disconnected: [], unchanged: [], skippedErrored: [], failed: [], statuses: [] }),
			currentReload: () => pending,
		});

		const result = await wiring.reloadMcpAfterMarketplaceMutation("server");
		assert.equal(result?.status, "pending");
		assert.equal(deps.calls.refreshExternalMcpToolRegistrations.length, 0, "must not refresh before the pending reload resolves");

		releasePending();
		await pending;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(deps.calls.refreshExternalMcpToolRegistrations.length, 1, "must refresh via deps once the pending reload resolves");
	});

	it("TEST-SEAM HAZARD pin: createMcpManager/ensureMcpManager/ensureMcpManagerForContext/refreshExternalMcpToolRegistrations round-trip through deps, never this class's own copy", async () => {
		// This is the load-bearing regression test for the design documented in
		// mcp-wiring.ts's header comment: several pre-existing unit tests
		// monkey-patch SessionManager's real delegating wrappers for exactly
		// these four names and expect McpWiring's OWN internal call graph to
		// observe the patch. Simulating that here with spy `deps` callbacks
		// (standing in for SessionManager's patched wrappers) pins the design
		// without needing a real SessionManager instance.
		const deps = makeDeps({
			createMcpManager: (cwd, opts) => { deps.calls.createMcpManager.push({ cwd, opts }); return makeFakeMcpManager(); },
			ensureMcpManager: async (scope) => { deps.calls.ensureMcpManager.push(scope); return makeFakeMcpManager(); },
		});
		const wiring = new McpWiring(deps);

		// ensureMcpManagerForContext(projectId, cwd) must call deps.ensureMcpManager, not this.ensureMcpManager.
		await wiring.ensureMcpManagerForContext("proj-1", "/repo/proj-1");
		assert.equal(deps.calls.ensureMcpManager.length, 1);

		// ensureMcpManager's own scoped-creation path must call deps.createMcpManager, not this.createMcpManager.
		await wiring.ensureMcpManager({ cwd: "/repo/other" });
		assert.equal(deps.calls.createMcpManager.length, 1);

		// removeScopedMcpManagerByKey (reached via cleanupScopedMcpManagersForProject)
		// must call deps.refreshExternalMcpToolRegistrations, not this.refreshExternalMcpToolRegistrations.
		wiring.scopedMcpManagers.set("cwd:/repo/other", makeFakeMcpManager({ getDiscoveryScope: () => ({ cwd: "/repo/other" }) }));
		await wiring.cleanupScopedMcpManagersForProject("unused", "/repo/other");
		assert.equal(deps.calls.refreshExternalMcpToolRegistrations.length, 1);
	});

	it("shutdownDisconnectAll disconnects every manager (default + scoped), tolerates managers without disconnectAll, and clears state", async () => {
		const deps = makeDeps();
		const wiring = new McpWiring(deps);
		let defaultDisconnected = false;
		let scopedDisconnected = false;
		wiring.mcpManager = makeFakeMcpManager({ disconnectAll: async () => { defaultDisconnected = true; } });
		wiring.scopedMcpManagers.set("a", makeFakeMcpManager({ disconnectAll: async () => { scopedDisconnected = true; } }));
		wiring.scopedMcpManagers.set("b", { marker: "test-double-without-disconnectAll" } as any);

		await wiring.shutdownDisconnectAll();

		assert.equal(defaultDisconnected, true);
		assert.equal(scopedDisconnected, true);
		assert.equal(wiring.mcpManager, null);
		assert.equal(wiring.scopedMcpManagers.size, 0);
	});

	it("real McpManager integration: ensureMcpManager connects a real (non-fake) McpManager against an empty cwd with zero ambient servers", async () => {
		// Mirrors tests/session-manager-ambient-mcp-isolation.test.ts's reliance
		// on BOBBIT_TEST_NO_EXTERNAL=1 (set by scripts/run-unit.mjs) to keep
		// McpManager's ambient ~/.claude.json/.mcp.json cascade out of this
		// test regardless of the host machine's real config.
		const cwd = makeTmpDir("mcp-wiring-real-manager-");
		const stateDir = makeTmpDir("mcp-wiring-real-manager-state-");
		const deps = makeDeps({
			createMcpManager: (cwd2) => new McpManager(cwd2, undefined, stateDir),
		});
		const wiring = new McpWiring(deps);

		const mgr = await wiring.ensureMcpManager({ cwd });
		assert.ok(mgr, "ensureMcpManager should create and connect a real McpManager");
		assert.deepEqual(mgr!.getToolInfos(), [], "an empty cwd with no ambient config discovers zero MCP tools");

		await wiring.shutdownDisconnectAll();
		assert.equal(wiring.mcpManager, null);
	});
});
