import { describe, expect, it } from "vitest";
import {
	WorktreeServiceCoordinator,
	WorktreeServiceCoordinatorError,
	type ServiceInstanceRef,
	type WorktreeServiceCoordinatorDeps,
} from "../../src/server/extension-host/worktree-service-coordinator.ts";
import { ServiceToolAdapterRegistry, ServiceToolOperationScheduler } from "../../src/server/extension-host/service-extension-tool-rpc.ts";

const projectId = "3f7a1c2e-0000-4000-8000-000000000000";
const packId = "My_Pack.v2";
const root = "/work/project-wt/feature";
const session = { id: "session-a", projectId, worktreePath: root, repoWorktrees: { ".": root } };
const declaration = { packId, spec: { id: "service-a", dataDir: "cache" } };

function fixture(overrides: Partial<WorktreeServiceCoordinatorDeps> = {}) {
	let allowed = true;
	let settingsReadable = true;
	const reconciled: ServiceInstanceRef[] = [];
	const stopped: ServiceInstanceRef[] = [];
	const removed: string[] = [];
	let activeCalls = 0;
	let stateDir: string | undefined = "/state/project-a";
	let declarations: readonly typeof declaration[] = [declaration];
	const operations = new ServiceToolAdapterRegistry();
	const queryOperation = {
		validatePayload: (value: unknown) => value === undefined || (typeof value === "object" && value !== null && (value as { query?: unknown }).query === "ok"),
		validateResult: (value: unknown) => value === undefined || (typeof value === "object" && value !== null),
	};
	operations.register({ packId, serviceId: "service-a", operations: { query: queryOperation } });
	operations.register({ packId, serviceId: "service-a", discriminator: "typescript", operations: { query: queryOperation } });
	const runtime = {
		reconcile: async (ref: ServiceInstanceRef) => { reconciled.push(ref); },
		status: (): { state: "ready" } => ({ state: "ready" }),
		stop: async (ref?: ServiceInstanceRef) => { if (ref) stopped.push(ref); },
	};
	const deps: WorktreeServiceCoordinatorDeps = {
		sessions: { get: id => id === session.id ? session : undefined, list: id => id === projectId ? [session] : [] },
		components: () => [{ name: "default", repo: "." }],
		stateDir: () => stateDir,
		git: { topLevel: async cwd => cwd },
		filesystem: { realpath: async target => target, isDirectory: async () => true, removeDirectory: async target => { removed.push(target); } },
		listActive: async () => { activeCalls++; return declarations; },
		authorize: () => ({ allowed }),
		settingsReadable: () => settingsReadable,
		runtime,
		operations,
		scheduler: new ServiceToolOperationScheduler(),
		adapter: () => ({ request: async ({ ref, operation, payload }) => ({ ref: ref.worktreeKey, operation, ...(payload === undefined ? {} : { payload }) }) }),
		...overrides,
	};
	return {
		coordinator: new WorktreeServiceCoordinator(deps), reconciled, stopped, removed,
		activeCalls: () => activeCalls,
		setDeclarations: (value: readonly typeof declaration[]) => { declarations = value; },
		setAllowed: (value: boolean) => { allowed = value; },
		setSettingsReadable: (value: boolean) => { settingsReadable = value; },
		setStateDir: (value: string | undefined) => { stateDir = value; },
	};
}

function request(overrides: Record<string, unknown> = {}) {
	return { sessionId: session.id, packId, request: { component: ".", serviceId: "service-a", operation: "query", payload: { query: "ok" }, ...overrides } };
}

describe("worktree service coordinator", () => {
	it("accepts UUID project IDs and platform-valid pack identifiers throughout lifecycle operations", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		await expect(f.coordinator.request(request())).resolves.toMatchObject({ state: "ready" });
		await f.coordinator.stopWorktree(projectId, root);
		await f.coordinator.reconcileProject(projectId);
		await f.coordinator.stopProject(projectId);
		expect(f.reconciled).toHaveLength(3);
		expect(f.stopped).toHaveLength(2);
		expect(f.removed).toHaveLength(2);
	});

	it("derives a linked-worktree scope from Git and exposes only an opaque key", async () => {
		const f = fixture({
			git: { topLevel: async () => "/canonical/linked-worktree" },
			filesystem: { realpath: async target => target === root ? "/canonical/linked-worktree" : target, isDirectory: async () => true, removeDirectory: async () => {} },
		});
		await f.coordinator.reconcileProject(projectId);
		expect(f.reconciled[0]).toMatchObject({ component: ".", canonicalWorktreeRoot: "/canonical/linked-worktree" });
		expect(f.reconciled[0].worktreeKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(JSON.stringify({ ...f.reconciled[0], canonicalWorktreeRoot: undefined })).not.toContain("/canonical/linked-worktree");
	});

	it("rejects a component that is not mapped to the session's configured worktree", async () => {
		const f = fixture({
			components: () => [{ name: "Api_Component.v2", repo: "api" }, { name: "web", repo: "web" }],
			sessions: { get: () => ({ ...session, repoWorktrees: { api: "/work/api" } }), list: () => [{ ...session, repoWorktrees: { api: "/work/api" } }] },
		});
		await expect(f.coordinator.request({ ...request(), request: { component: "web", serviceId: "service-a", operation: "query" } }))
			.rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("uses a deterministic core-owned data directory and rejects traversal", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		const ref = f.reconciled[0];
		expect(f.coordinator.resolveDataDir(ref, "cache")).toMatch(/^\/state\/project-a\/managed-services\/v1\//);
		expect(() => f.coordinator.resolveDataDir(ref, "../escape")).toThrow("unavailable");
	});

	it("coalesces concurrent invalidations into one project pass", async () => {
		const f = fixture();
		await Promise.all([f.coordinator.reconcileProject(projectId), f.coordinator.reconcileProject(projectId)]);
		expect(f.activeCalls()).toBe(1);
		expect(f.reconciled).toHaveLength(1);
	});

	it("reconciles restored project scopes once each in a bounded sequence", async () => {
		const f = fixture();
		await f.coordinator.reconcileRestoredProjects([projectId, projectId]);
		expect(f.activeCalls()).toBe(1);
		expect(f.reconciled).toHaveLength(1);
	});

	it("does no scope discovery for empty declarations but non-destructively stops stale instances", async () => {
		let gitCalls = 0;
		const f = fixture({ git: { topLevel: async cwd => { gitCalls++; return cwd; } } });
		await f.coordinator.reconcileProject(projectId);
		f.setDeclarations([]);
		gitCalls = 0;
		await f.coordinator.reconcileProject(projectId);
		expect(gitCalls).toBe(0);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(0);
	});

	it("schema-gates closed operations before an adapter is invoked", async () => {
		let calls = 0;
		const f = fixture({ adapter: () => ({ request: async () => { calls++; return {}; } }) });
		await expect(f.coordinator.request({ ...request(), request: { component: ".", serviceId: "service-a", operation: "missing" } })).rejects.toMatchObject({ code: "operation_unavailable" });
		await expect(f.coordinator.request({ ...request(), request: { component: ".", serviceId: "service-a", operation: "query", payload: { query: "no" } } })).rejects.toMatchObject({ code: "invalid_payload" });
		expect(calls).toBe(0);
	});

	it("freshly rechecks authorization and settings before exact-instance RPC", async () => {
		const f = fixture();
		f.setSettingsReadable(false);
		await expect(f.coordinator.request(request())).rejects.toBeInstanceOf(WorktreeServiceCoordinatorError);
		f.setSettingsReadable(true);
		f.setAllowed(false);
		await expect(f.coordinator.request(request())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("keeps an in-flight RPC ready across a concurrent same-key reconciliation", async () => {
		let release!: () => void;
		let started!: () => void;
		const paused = new Promise<void>(resolve => { release = resolve; });
		const began = new Promise<void>(resolve => { started = resolve; });
		const f = fixture({ adapter: () => ({ request: async () => { started(); await paused; return { done: true }; } }) });
		const pending = f.coordinator.request(request());
		await began;
		await f.coordinator.reconcileProject(projectId);
		release();
		await expect(pending).resolves.toMatchObject({ state: "ready" });
	});

	it("aborts active RPC work and preserves data when a revoke reconciles the instance away", async () => {
		let aborted = false;
		let release!: () => void;
		const paused = new Promise<void>(resolve => { release = resolve; });
		const f = fixture({
			adapter: () => ({ request: async ({ signal }) => {
				signal.addEventListener("abort", () => { aborted = true; release(); }, { once: true });
				await paused;
				return { done: true };
			} }),
		});
		const active = f.coordinator.request(request());
		await new Promise(resolve => setImmediate(resolve));
		f.setAllowed(false);
		await f.coordinator.reconcileProject(projectId);
		await expect(active).rejects.toMatchObject({ code: "cancelled" });
		expect(aborted).toBe(true);
		expect(f.removed).toHaveLength(0);
	});

	it("retains non-default discriminators through reconciliation without deleting their data", async () => {
		const f = fixture();
		await f.coordinator.request({ ...request(), request: { component: ".", serviceId: "service-a", operation: "query", discriminator: "typescript" } });
		await f.coordinator.reconcileProject(projectId);
		expect(f.reconciled.some(ref => ref.discriminator === "typescript")).toBe(true);
		expect(f.removed).toHaveLength(0);
	});

	it("archives the final owner without deleting data, then cleans only after confirmed worktree removal", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		await f.coordinator.releaseSession(projectId, session.id);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(0);
		await f.coordinator.cleanupRemovedSessionWorktrees(projectId, session.id, [root]);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(1);
		expect(f.removed[0]).toContain("/managed-services/v1/");
	});

	it("retains a shared archived cleanup owner until its own worktree is confirmed removed", async () => {
		const shared = { ...session, id: "session-b" };
		const f = fixture({
			sessions: { get: id => id === session.id ? session : id === shared.id ? shared : undefined, list: () => [session, shared] },
		});
		await f.coordinator.reconcileProject(projectId);
		await f.coordinator.releaseSession(projectId, session.id);
		await f.coordinator.cleanupRemovedSessionWorktrees(projectId, session.id, [root]);
		expect(f.stopped).toHaveLength(0);
		expect(f.removed).toHaveLength(0);
		await f.coordinator.releaseSession(projectId, shared.id);
		await f.coordinator.cleanupRemovedSessionWorktrees(projectId, shared.id, [root]);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(1);
	});

	it("suspends old-root services without deleting data until replacement commits", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		await f.coordinator.suspendProject(projectId);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(0);

		// A failed replacement can reconcile the still-owned old scope.
		await f.coordinator.reconcileProject(projectId);
		expect(f.reconciled).toHaveLength(2);
		await f.coordinator.stopProject(projectId);
		expect(f.removed).toHaveLength(1);
	});

	it("removes a committed replacement's old state root, never the live new root", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		f.setStateDir("/state/project-b");

		await f.coordinator.suspendProject(projectId);
		await f.coordinator.stopProject(projectId);

		expect(f.removed).toHaveLength(1);
		expect(f.removed[0]).toMatch(/^\/state\/project-a\/managed-services\/v1\//);
		expect(f.removed[0]).not.toContain("/state/project-b/");
	});

	it("does not delete an incoming A root during an A-to-B-to-A replacement", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		f.setStateDir("/state/project-b");
		await f.coordinator.suspendProject(projectId);
		await f.coordinator.stopProject(projectId);

		await f.coordinator.reconcileProject(projectId);
		f.setStateDir("/state/project-a");
		await f.coordinator.suspendProject(projectId);
		await f.coordinator.stopProject(projectId);

		expect(f.removed).toHaveLength(2);
		expect(f.removed[0]).toMatch(/^\/state\/project-a\/managed-services\/v1\//);
		expect(f.removed[1]).toMatch(/^\/state\/project-b\/managed-services\/v1\//);
	});

	it("fails closed when a new instance has no state authority", async () => {
		const f = fixture();
		f.setStateDir(undefined);
		await f.coordinator.reconcileProject(projectId);
		expect(f.reconciled).toHaveLength(0);
		await expect(f.coordinator.request(request())).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("prunes purged shared-root owners before final cleanup", async () => {
		const shared = { ...session, id: "session-b" };
		let live = [session, shared];
		const f = fixture({
			sessions: {
				get: id => live.find(candidate => candidate.id === id),
				list: () => live,
			},
		});
		await f.coordinator.reconcileProject(projectId);

		// Session A was purged before its final worktree callback. Session B is
		// now the final confirmed cleanup and must not be blocked by A's stale row.
		live = [shared];
		await f.coordinator.cleanupRemovedSessionWorktrees(projectId, shared.id, [root]);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(1);
	});

	it("does not revive a root discovered after project deletion fenced it", async () => {
		let releaseGit!: () => void;
		let beganGit!: () => void;
		const gitBlocked = new Promise<void>(resolve => { releaseGit = resolve; });
		const gitBegan = new Promise<void>(resolve => { beganGit = resolve; });
		const f = fixture({ git: { topLevel: async cwd => { beganGit(); await gitBlocked; return cwd; } } });
		const pending = f.coordinator.reconcileProject(projectId);
		await gitBegan;
		await f.coordinator.stopProject(projectId);
		releaseGit();
		await pending;
		expect(f.reconciled).toHaveLength(0);
		expect(f.removed).toHaveLength(0);
	});

	it("keeps data on normal close or unconfirmed cleanup", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		await f.coordinator.close();
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(0);

		const afterDeletion = fixture();
		await afterDeletion.coordinator.reconcileProject(projectId);
		await afterDeletion.coordinator.releaseSession(projectId, session.id);
		await afterDeletion.coordinator.cleanupRemovedSessionWorktrees(projectId, session.id, ["/different/worktree"]);
		expect(afterDeletion.stopped).toHaveLength(1);
		expect(afterDeletion.removed).toHaveLength(0);
	});
});
