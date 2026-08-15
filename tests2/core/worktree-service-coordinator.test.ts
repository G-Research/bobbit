import { describe, expect, it } from "vitest";
import {
	WorktreeServiceCoordinator,
	WorktreeServiceCoordinatorError,
	type ServiceInstanceRef,
	type WorktreeServiceCoordinatorDeps,
} from "../../src/server/extension-host/worktree-service-coordinator.ts";

const root = "/work/project-wt/feature";
const session = { id: "session-a", projectId: "project-a", worktreePath: root, repoWorktrees: { ".": root } };
const declaration = { packId: "pack-a", spec: { id: "service-a", dataDir: "cache" } };

function fixture(overrides: Partial<WorktreeServiceCoordinatorDeps> = {}) {
	let allowed = true;
	let settingsReadable = true;
	const reconciled: ServiceInstanceRef[] = [];
	const stopped: ServiceInstanceRef[] = [];
	const removed: string[] = [];
	let activeCalls = 0;
	const runtime = {
		reconcile: async (ref: ServiceInstanceRef) => { reconciled.push(ref); },
		status: () => ({ state: "ready" }),
		stop: async (ref?: ServiceInstanceRef) => { if (ref) stopped.push(ref); },
	};
	const deps: WorktreeServiceCoordinatorDeps = {
		sessions: { get: id => id === session.id ? session : undefined, list: projectId => projectId === session.projectId ? [session] : [] },
		components: () => [{ name: "default", repo: "." }],
		stateDir: () => "/state/project-a",
		git: { topLevel: async cwd => cwd },
		filesystem: { realpath: async target => target, isDirectory: async () => true, removeDirectory: async target => { removed.push(target); } },
		listActive: async () => { activeCalls++; return [declaration]; },
		authorize: () => ({ allowed }),
		settingsReadable: () => settingsReadable,
		runtime,
		adapter: () => ({ request: async ({ ref, operation, payload }) => ({ ref: ref.worktreeKey, operation, payload }) }),
		...overrides,
	};
	return {
		coordinator: new WorktreeServiceCoordinator(deps), reconciled, stopped, removed,
		activeCalls: () => activeCalls,
		setAllowed: (value: boolean) => { allowed = value; },
		setSettingsReadable: (value: boolean) => { settingsReadable = value; },
	};
}

describe("worktree service coordinator", () => {
	it("derives a linked-worktree scope from Git and exposes only an opaque key", async () => {
		const f = fixture({
			git: { topLevel: async () => "/canonical/linked-worktree" },
			filesystem: { realpath: async target => target === root ? "/canonical/linked-worktree" : target, isDirectory: async () => true, removeDirectory: async () => {} },
		});
		await f.coordinator.reconcileProject("project-a");

		expect(f.reconciled).toHaveLength(1);
		expect(f.reconciled[0]).toMatchObject({ component: ".", canonicalWorktreeRoot: "/canonical/linked-worktree" });
		expect(f.reconciled[0].worktreeKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(JSON.stringify({ ...f.reconciled[0], canonicalWorktreeRoot: undefined })).not.toContain("/canonical/linked-worktree");
	});

	it("rejects a component that is not mapped to the session's configured worktree", async () => {
		const f = fixture({
			components: () => [{ name: "api", repo: "api" }, { name: "web", repo: "web" }],
			sessions: { get: () => ({ ...session, repoWorktrees: { api: "/work/api" } }), list: () => [{ ...session, repoWorktrees: { api: "/work/api" } }] },
		});
		await expect(f.coordinator.request({ sessionId: "session-a", packId: "pack-a", request: { component: "web", serviceId: "service-a", operation: "query" } }))
			.rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("uses a deterministic core-owned data directory and rejects traversal", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject("project-a");
		const ref = f.reconciled[0];
		expect(f.coordinator.resolveDataDir(ref, "cache")).toMatch(/^\/state\/project-a\/managed-services\/v1\//);
		expect(() => f.coordinator.resolveDataDir(ref, "../escape")).toThrow("unavailable");
	});

	it("coalesces concurrent invalidations into one project pass", async () => {
		const f = fixture();
		await Promise.all([f.coordinator.reconcileProject("project-a"), f.coordinator.reconcileProject("project-a")]);
		expect(f.activeCalls()).toBe(1);
		expect(f.reconciled).toHaveLength(1);
	});

	it("freshly rechecks authorization and settings before exact-instance RPC", async () => {
		const f = fixture();
		f.setSettingsReadable(false);
		await expect(f.coordinator.request({ sessionId: "session-a", packId: "pack-a", request: { component: ".", serviceId: "service-a", operation: "query" } }))
			.rejects.toBeInstanceOf(WorktreeServiceCoordinatorError);

		f.setSettingsReadable(true);
		f.setAllowed(false);
		await expect(f.coordinator.request({ sessionId: "session-a", packId: "pack-a", request: { component: ".", serviceId: "service-a", operation: "query" } }))
			.rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("stops only captured worktree instances and cleans their derived directory", async () => {
		const f = fixture();
		await f.coordinator.reconcileProject("project-a");
		await f.coordinator.stopWorktree("project-a", root);
		expect(f.stopped).toHaveLength(1);
		expect(f.removed).toHaveLength(1);
		expect(f.removed[0]).toContain("/managed-services/v1/");
	});
});
