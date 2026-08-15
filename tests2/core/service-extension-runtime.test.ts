import { describe, expect, it } from "vitest";
import {
	ServiceExtensionRuntimeManager,
	type ActiveServiceExtension,
	type ServiceExtensionProcess,
} from "../../src/server/extension-host/service-extension-runtime.ts";
import type { ServiceInstancePublicRef, ServiceInstanceRef } from "../../src/server/extension-host/service-extension-contract.ts";

const spec = {
	id: "service",
	runMode: "local" as const,
	readiness: { url: "http://127.0.0.1:8080/health", timeoutMs: 200 },
	stopGraceMs: 100,
	restart: "on-failure" as const,
	ports: [8080],
	dataDir: "service",
};

function instance(overrides: Partial<ServiceInstanceRef> = {}): ServiceInstanceRef {
	return {
		projectId: "project-a",
		component: ".",
		canonicalWorktreeRoot: "/worktree/a",
		worktreeKey: "1234567890123456789012",
		packId: "pack",
		serviceId: "service",
		discriminator: "default",
		...overrides,
	};
}

function publicRef(ref: ServiceInstanceRef): ServiceInstancePublicRef {
	const { canonicalWorktreeRoot: _root, ...safe } = ref;
	return safe;
}

function fixture(overrides: {
	active?: ActiveServiceExtension[];
	ready?: boolean;
	portAvailable?: boolean;
	authorized?: boolean;
	listActive?: (projectId: string) => Promise<readonly ActiveServiceExtension[]> | readonly ActiveServiceExtension[];
} = {}) {
	let active = overrides.active ?? [{ packId: "pack", spec }];
	let now = 0;
	let ready = overrides.ready ?? true;
	let portAvailable = overrides.portAvailable ?? true;
	let authorized = overrides.authorized ?? true;
	const launches: Array<{ mode: string; ref: ServiceInstanceRef; workingDirectory: string; settings?: unknown }> = [];
	const stops: number[] = [];
	const releases: number[] = [];
	const processes: Array<{ process: ServiceExtensionProcess; exit: () => void }> = [];
	const manager = new ServiceExtensionRuntimeManager({
		listActive: projectId => overrides.listActive?.(projectId) ?? active,
		authorize: () => ({ allowed: authorized }),
		launchers: {
			local: async request => makeProcess("local", request),
			docker: async request => makeProcess("docker", request),
			compose: async request => makeProcess("compose", request),
		},
		probe: async () => ready,
		ports: { lease: async () => portAvailable ? { release: async () => { releases.push(1); } } : undefined },
		filesystem: { ensureDirectory: async () => {} },
		clock: { now: () => new Date(now), sleep: async (ms: number) => { now += ms; } },
		resolveDataDir: (ref, path) => `/owned/${ref.worktreeKey}/${path}`,
	});

	function makeProcess(mode: string, request: { ref: ServiceInstanceRef; workingDirectory: string; settings?: unknown }): ServiceExtensionProcess {
		launches.push({ mode, ref: request.ref, workingDirectory: request.workingDirectory, ...(request.settings === undefined ? {} : { settings: request.settings }) });
		let listener: (() => void) | undefined;
		const process: ServiceExtensionProcess = {
			stop: async grace => { stops.push(grace); },
			onExit: callback => { listener = callback; return () => { listener = undefined; }; },
		};
		processes.push({ process, exit: () => listener?.() });
		return process;
	}
	return {
		manager, launches, stops, releases, processes,
		setActive: (value: ActiveServiceExtension[]) => { active = value; },
		setReady: (value: boolean) => { ready = value; },
		setPortAvailable: (value: boolean) => { portAvailable = value; },
		setAuthorized: (value: boolean) => { authorized = value; },
	};
}

async function turn(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(settle => { resolve = settle; });
	return { promise, resolve };
}

describe("service extension runtime", () => {
	it("selects adapters, passes only core-derived roots, and projects no host path", async () => {
		for (const runMode of ["local", "docker", "compose"] as const) {
			const f = fixture({ active: [{ packId: "pack", spec: { ...spec, runMode } }] });
			const ref = instance();
			await f.manager.reconcile(ref);
			expect(f.launches).toMatchObject([{ mode: runMode, workingDirectory: "/worktree/a" }]);
			const status = f.manager.status(publicRef(ref));
			expect(status).toMatchObject({ state: "ready", ref: publicRef(ref) });
			expect(JSON.stringify(status)).not.toContain("/worktree/a");
		}
	});

	it("does not launch without exact pack service.manage authorization and stops after revoke", async () => {
		const f = fixture({ authorized: false });
		const ref = instance();
		await f.manager.reconcile(ref);
		expect(f.launches).toEqual([]);
		f.setAuthorized(true);
		await f.manager.reconcile(ref);
		f.setAuthorized(false);
		await f.manager.reconcile(ref);
		expect(f.stops).toEqual([100]);
		expect(f.manager.status(publicRef(ref))).toMatchObject({ state: "stopped" });
	});

	it("does not launch on collision and bounds readiness failures", async () => {
		const collision = fixture({ portAvailable: false });
		const collisionRef = instance();
		await collision.manager.reconcile(collisionRef);
		expect(collision.launches).toEqual([]);
		expect(collision.manager.status(publicRef(collisionRef))).toMatchObject({ state: "unhealthy", detail: "port-conflict" });

		const timeout = fixture({ ready: false });
		const timeoutRef = instance();
		await timeout.manager.reconcile(timeoutRef);
		expect(timeout.manager.status(publicRef(timeoutRef))).toMatchObject({ state: "unhealthy", detail: "readiness-timeout" });
		expect(timeout.stops).toEqual([100]);
		expect(timeout.releases).toHaveLength(1);
	});

	it("restarts a failed active service once", async () => {
		const f = fixture();
		const ref = instance();
		await f.manager.reconcile(ref);
		f.processes[0].exit();
		await turn();
		expect(f.launches).toHaveLength(2);
		f.processes[1].exit();
		await turn();
		expect(f.launches).toHaveLength(2);
		expect(f.manager.status(publicRef(ref))).toMatchObject({ state: "failed", detail: "process-exited" });
	});

	it("isolates same project/pack/service across roots, components, and discriminators", async () => {
		const f = fixture();
		const rootA = instance();
		const rootB = instance({ canonicalWorktreeRoot: "/worktree/b", worktreeKey: "abcdefghijklmnopqrstuv", component: "api", discriminator: "typescript" });
		await Promise.all([f.manager.reconcile(rootA), f.manager.reconcile(rootB)]);
		expect(f.launches).toHaveLength(2);
		await f.manager.stop(rootA);
		expect(f.stops).toEqual([100]);
		expect(f.manager.status(publicRef(rootA))).toMatchObject({ state: "stopped" });
		expect(f.manager.status(publicRef(rootB))).toMatchObject({ state: "ready" });
		f.processes[1].exit();
		await turn();
		expect(f.launches).toHaveLength(3);
	});

	it("fences a stopped instance without blocking another worktree's pending reconcile", async () => {
		const a = deferred<readonly ActiveServiceExtension[]>();
		const b = deferred<readonly ActiveServiceExtension[]>();
		const f = fixture({ listActive: projectId => projectId === "project-a" ? a.promise : b.promise });
		const rootA = instance({ projectId: "project-a" });
		const rootB = instance({ projectId: "project-b", canonicalWorktreeRoot: "/worktree/b", worktreeKey: "abcdefghijklmnopqrstuv" });
		const reconcileA = f.manager.reconcile(rootA);
		const reconcileB = f.manager.reconcile(rootB);
		await f.manager.stop(rootA);
		a.resolve([{ packId: "pack", spec }]);
		b.resolve([{ packId: "pack", spec }]);
		await Promise.all([reconcileA, reconcileB]);
		expect(f.launches).toHaveLength(1);
		expect(f.manager.status(publicRef(rootA))).toBeUndefined();
		expect(f.manager.status(publicRef(rootB))).toMatchObject({ state: "ready" });
	});

	it("abandons an awaited launch after authorization changes", async () => {
		const pendingLaunch = deferred<ServiceExtensionProcess>();
		let authorized = true;
		const stops: number[] = [];
		const manager = new ServiceExtensionRuntimeManager({
			listActive: () => [{ packId: "pack", spec }],
			authorize: () => ({ allowed: authorized }),
			launchers: {
				local: async () => pendingLaunch.promise,
				docker: async () => { throw new Error("not selected"); },
				compose: async () => { throw new Error("not selected"); },
			},
			probe: async () => true,
			ports: { lease: async () => ({ release: async () => {} }) },
			filesystem: { ensureDirectory: async () => {} },
			clock: { now: () => new Date(0), sleep: async () => {} },
			resolveDataDir: () => "/owned/service",
		});
		const ref = instance();
		const reconcile = manager.reconcile(ref);
		await turn();
		authorized = false;
		pendingLaunch.resolve({ stop: async grace => { stops.push(grace); }, onExit: () => () => {} });
		await reconcile;
		expect(stops).toEqual([100]);
		expect(manager.status(publicRef(ref))).toMatchObject({ state: "stopped" });
	});

	it("passes settings only to core launch seams and never status", async () => {
		let received: unknown;
		const process: ServiceExtensionProcess = { stop: async () => {}, onExit: () => () => {} };
		const manager = new ServiceExtensionRuntimeManager({
			listActive: () => [{ packId: "pack", spec }],
			authorize: () => ({ allowed: true }),
			launchers: { local: async request => { received = request.settings; return process; }, docker: async () => process, compose: async () => process },
			probe: async () => true,
			ports: { lease: async () => ({ release: async () => {} }) },
			filesystem: { ensureDirectory: async () => {} },
			clock: { now: () => new Date(0), sleep: async () => {} },
			resolveDataDir: () => "/owned/service",
			resolveSettings: () => ({ apiKey: "MUST_NEVER_APPEAR" }),
		});
		const ref = instance();
		await manager.reconcile(ref);
		expect(received).toEqual({ apiKey: "MUST_NEVER_APPEAR" });
		expect(JSON.stringify(manager.status(publicRef(ref)))).not.toContain("MUST_NEVER_APPEAR");
	});
});
