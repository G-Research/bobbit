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
		stateDir: () => "/state/project-a",
		git: { topLevel: async cwd => cwd },
		filesystem: { realpath: async target => target, isDirectory: async () => true, removeDirectory: async target => { removed.push(target); } },
		listActive: async () => { activeCalls++; return [declaration]; },
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
		setAllowed: (value: boolean) => { allowed = value; },
		setSettingsReadable: (value: boolean) => { settingsReadable = value; },
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

	it("stops only a final captured worktree owner and cleans its derived directory", async () => {
		const shared = { ...session, id: "session-b" };
		const f = fixture({
			sessions: { get: id => id === session.id ? session : id === shared.id ? shared : undefined, list: () => [session, shared] },
		});
		await f.coordinator.reconcileProject(projectId);
		await f.coordinator.stopSession(projectId, session.id);
		expect(f.stopped).toHaveLength(0);
		await f.coordinator.stopSession(projectId, shared.id);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(1);
		expect(f.removed[0]).toContain("/managed-services/v1/");
	});

	it("uses roots captured before worktree deletion and keeps data on normal close", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject(projectId);
		await f.coordinator.close();
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(0);

		const afterDeletion = fixture();
		await afterDeletion.coordinator.reconcileProject(projectId);
		await afterDeletion.coordinator.stopSession(projectId, session.id);
		expect(afterDeletion.stopped).toHaveLength(1);
		expect(afterDeletion.removed).toHaveLength(1);
	});
});
