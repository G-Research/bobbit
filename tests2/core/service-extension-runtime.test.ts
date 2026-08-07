import { describe, expect, it } from "vitest";
import {
	ServiceExtensionRuntimeManager,
	type ActiveServiceExtension,
	type ServiceExtensionProcess,
} from "../../src/server/extension-host/service-extension-runtime.ts";

const spec = {
	id: "service",
	runMode: "local" as const,
	readiness: { url: "http://127.0.0.1:8080/health", timeoutMs: 200 },
	stopGraceMs: 100,
	restart: "on-failure" as const,
	ports: [8080],
	dataDir: "service",
};

function fixture(overrides: {
	active?: ActiveServiceExtension[];
	ready?: boolean;
	portAvailable?: boolean;
	granted?: boolean;
	listActive?: (projectId: string) => Promise<readonly ActiveServiceExtension[]> | readonly ActiveServiceExtension[];
} = {}) {
	let active = overrides.active ?? [{ packId: "pack", spec }];
	let now = 0;
	let ready = overrides.ready ?? true;
	let portAvailable = overrides.portAvailable ?? true;
	let granted = overrides.granted ?? true;
	const launches: string[] = [];
	const stops: number[] = [];
	const releases: number[] = [];
	const processes: Array<{ process: ServiceExtensionProcess; exit: () => void }> = [];
	const manager = new ServiceExtensionRuntimeManager({
		listActive: projectId => overrides.listActive?.(projectId) ?? active,
		grantResolver: () => ({ allowed: granted }),
		launchers: {
			local: async request => makeProcess("local", request.spec.stopGraceMs),
			docker: async request => makeProcess("docker", request.spec.stopGraceMs),
			compose: async request => makeProcess("compose", request.spec.stopGraceMs),
		},
		probe: async () => ready,
		ports: { lease: async () => portAvailable ? { release: async () => { releases.push(1); } } : undefined },
		filesystem: { ensureDirectory: async () => {} },
		clock: { now: () => new Date(now), sleep: async (ms: number) => { now += ms; } },
		resolveDataDir: ({ projectId }, path) => `/owned/${projectId}/${path}`,
	});

	function makeProcess(mode: string, _grace: number): ServiceExtensionProcess {
		launches.push(mode);
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
		setGranted: (value: boolean) => { granted = value; },
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
	it("selects the local, Docker, and Compose adapters and publishes readiness", async () => {
		for (const runMode of ["local", "docker", "compose"] as const) {
			const f = fixture({ active: [{ packId: "pack", spec: { ...spec, runMode } }] });
			await f.manager.reconcile("project-a");
			expect(f.launches).toEqual([runMode]);
			expect(f.manager.status("project-a", "service")).toMatchObject({ state: "ready" });
		}
	});

	it("does not launch without the exact pack service.manage grant", async () => {
		const f = fixture({ granted: false });
		await f.manager.reconcile("project-a");
		expect(f.launches).toEqual([]);
		expect(f.manager.status("project-a", "service")).toBeUndefined();
	});

	it("stops a previously allowed service when a later reconcile sees revocation", async () => {
		const f = fixture();
		await f.manager.reconcile("project-a");
		f.setGranted(false);
		await f.manager.reconcile("project-a");

		expect(f.stops).toEqual([100]);
		expect(f.manager.status("project-a", "service")).toMatchObject({ state: "stopped" });
	});

	it("does not launch on a port collision and publishes a bounded status", async () => {
		const f = fixture({ portAvailable: false });
		await f.manager.reconcile("project-a");
		expect(f.launches).toEqual([]);
		expect(f.manager.status("project-a", "service")).toMatchObject({ state: "unhealthy", detail: "port-conflict" });
	});

	it("times out readiness, stops using the declared grace, and releases leases", async () => {
		const f = fixture({ ready: false });
		await f.manager.reconcile("project-a");
		expect(f.manager.status("project-a", "service")).toMatchObject({ state: "unhealthy", detail: "readiness-timeout" });
		expect(f.stops).toEqual([100]);
		expect(f.releases).toHaveLength(1);
	});

	it("restarts one failed active service once and ignores further exits", async () => {
		const f = fixture();
		await f.manager.reconcile("project-a");
		f.processes[0].exit();
		await turn();
		expect(f.launches).toEqual(["local", "local"]);
		f.processes[1].exit();
		await turn();
		expect(f.launches).toEqual(["local", "local"]);
		expect(f.manager.status("project-a", "service")).toMatchObject({ state: "failed", detail: "process-exited" });
	});

	it("stops services removed by reconciliation and on shutdown", async () => {
		const f = fixture();
		await f.manager.reconcile("project-a");
		f.setActive([]);
		await f.manager.reconcile("project-a");
		expect(f.stops).toEqual([100]);
		expect(f.manager.status("project-a", "service")).toMatchObject({ state: "stopped" });
	});

	it("does not allow an older delayed active snapshot to supersede a newer reconcile", async () => {
		const first = deferred<readonly ActiveServiceExtension[]>();
		const second = deferred<readonly ActiveServiceExtension[]>();
		let calls = 0;
		const f = fixture({ listActive: () => (++calls === 1 ? first.promise : second.promise) });

		const reconcileA = f.manager.reconcile("project-a");
		const reconcileB = f.manager.reconcile("project-a");
		second.resolve([{ packId: "pack", spec: { ...spec, runMode: "docker" } }]);
		await reconcileB;
		first.resolve([{ packId: "pack", spec }]);
		await reconcileA;

		expect(f.launches).toEqual(["docker"]);
		expect(f.manager.status("project-a", "service")).toMatchObject({ state: "ready" });
	});

	it("closes globally before a pending active snapshot can launch", async () => {
		const pending = deferred<readonly ActiveServiceExtension[]>();
		let calls = 0;
		const f = fixture({ listActive: () => { calls++; return pending.promise; } });

		const reconcile = f.manager.reconcile("project-a");
		await f.manager.stop();
		pending.resolve([{ packId: "pack", spec }]);
		await reconcile;
		await f.manager.reconcile("project-a");

		expect(calls).toBe(1);
		expect(f.launches).toEqual([]);
		expect(f.manager.status("project-a", "service")).toBeUndefined();
	});

	it("fences a stopped project without blocking another project's pending reconcile", async () => {
		const projectA = deferred<readonly ActiveServiceExtension[]>();
		const projectB = deferred<readonly ActiveServiceExtension[]>();
		const f = fixture({ listActive: projectId => projectId === "project-a" ? projectA.promise : projectB.promise });

		const reconcileA = f.manager.reconcile("project-a");
		const reconcileB = f.manager.reconcile("project-b");
		await f.manager.stop("project-a");
		projectA.resolve([{ packId: "pack", spec }]);
		projectB.resolve([{ packId: "pack", spec }]);
		await Promise.all([reconcileA, reconcileB]);

		expect(f.launches).toEqual(["local"]);
		expect(f.manager.status("project-a", "service")).toBeUndefined();
		expect(f.manager.status("project-b", "service")).toMatchObject({ state: "ready" });
	});

	it("abandons an awaited launch when service.manage is revoked before publication", async () => {
		const pendingLaunch = deferred<ServiceExtensionProcess>();
		let granted = true;
		const stops: number[] = [];
		const manager = new ServiceExtensionRuntimeManager({
			listActive: () => [{ packId: "pack", spec }],
			grantResolver: () => ({ allowed: granted }),
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
		const reconcile = manager.reconcile("project-a");
		await turn();
		granted = false;
		pendingLaunch.resolve({ stop: async grace => { stops.push(grace); }, onExit: () => () => {} });
		await reconcile;

		expect(stops).toEqual([100]);
		expect(manager.status("project-a", "service")).toMatchObject({ state: "stopped" });
	});

	it("passes resolved settings only to core launch seams, never status", async () => {
		let received: unknown;
		const process: ServiceExtensionProcess = { stop: async () => {}, onExit: () => () => {} };
		const manager = new ServiceExtensionRuntimeManager({
			listActive: () => [{ packId: "pack", spec }],
			grantResolver: () => ({ allowed: true }),
			launchers: { local: async request => { received = request.settings; return process; }, docker: async () => process, compose: async () => process },
			probe: async () => true,
			ports: { lease: async () => ({ release: async () => {} }) },
			filesystem: { ensureDirectory: async () => {} },
			clock: { now: () => new Date(0), sleep: async () => {} },
			resolveDataDir: () => "/owned/service",
			resolveSettings: () => ({ apiKey: "MUST_NEVER_APPEAR" }),
		});
		await manager.reconcile("project-a");
		expect(received).toEqual({ apiKey: "MUST_NEVER_APPEAR" });
		expect(JSON.stringify(manager.status("project-a", "service"))).not.toContain("MUST_NEVER_APPEAR");
	});
});
