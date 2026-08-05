import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeContribution } from "../../src/server/agent/pack-contributions.js";
import type { ServiceRuntimeManifest } from "../../src/server/service-runtime/service-manifest.js";
import type { ServiceRunner, StartedService } from "../../src/server/service-runtime/service-runners.js";
import {
	ServiceRuntimeSupervisor,
	type ServiceRuntimeClock,
	type ServiceRuntimeProbe,
} from "../../src/server/service-runtime/service-supervisor.js";
import type {
	PersistedServiceRuntime,
	ServiceRuntimeIdentity,
} from "../../src/server/service-runtime/service-runtime-store.js";

const identity: ServiceRuntimeIdentity = { packId: "pack", runtimeId: "fixture" };
const endpoint = "http://127.0.0.1:45123";

const manifest: ServiceRuntimeManifest = {
	apiVersion: 1,
	id: "fixture",
	title: "Fixture",
	endpoint: {
		protocol: "http",
		servicePort: 8080,
		health: { path: "/health", expectedStatus: 200, requestTimeoutMs: 100, intervalMs: 10, startupTimeoutMs: 30 },
	},
	lifecycle: { startPolicy: "manual", restart: { policy: "never", maxAttempts: 0, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 10 } },
	environment: { PORT: { endpointPort: true } },
	modes: {
		local: { command: "fixture", args: [], portEnv: "PORT" },
		docker: { image: "fixture:latest" },
		compose: { file: "compose.yaml", service: "fixture", projectName: "fixture-${serverIdentity}" },
	},
};

const contribution: RuntimeContribution = {
	id: "fixture",
	listName: "fixture.yaml",
	sourceFile: "/pack/runtimes/fixture.yaml",
	packRoot: "/pack",
	manifest,
};

class Store {
	record?: PersistedServiceRuntime;
	readonly replacements: PersistedServiceRuntime[] = [];

	identity(packId: string, runtimeId: string): ServiceRuntimeIdentity { return { packId, runtimeId }; }
	async load(): Promise<PersistedServiceRuntime | undefined> { return this.record && structuredClone(this.record); }
	async list(): Promise<Array<{ identity: ServiceRuntimeIdentity; record: PersistedServiceRuntime }>> { return this.record ? [{ identity, record: structuredClone(this.record) }] : []; }
	async replace(_identity: ServiceRuntimeIdentity, record: PersistedServiceRuntime): Promise<void> {
		this.record = structuredClone(record);
		this.replacements.push(structuredClone(record));
	}
	async writeEnvironment(): Promise<void> {}
	async getOrCreateGeneratedSecret(): Promise<string> { return "generated"; }
	async resolveUserSecret(): Promise<string | undefined> { return undefined; }
	async writeLog(): Promise<void> {}
	async readLog(): Promise<string | undefined> { return undefined; }
}

class ManualClock implements ServiceRuntimeClock {
	nowValue = 0;
	readonly waits: Array<{ ms: number; resolve: () => void }> = [];
	now(): number { return this.nowValue; }
	sleep(ms: number): Promise<void> { return new Promise((resolve) => this.waits.push({ ms, resolve })); }
	advance(): void {
		const next = this.waits.shift();
		assert.ok(next, "expected scheduled work");
		this.nowValue += next.ms;
		next.resolve();
	}
}

function record(overrides: Partial<PersistedServiceRuntime> = {}): PersistedServiceRuntime {
	return {
		version: 1,
		serverIdentity: "server",
		desired: "running",
		selectedMode: "local",
		settingsRevision: "revision-1",
		restartAttempts: [],
		updatedAt: new Date(0).toISOString(),
		...overrides,
	};
}

function localRunner(hooks: Partial<Pick<ServiceRunner, "start" | "inspect" | "stop" | "remove">> = {}): ServiceRunner {
	const started = (): StartedService => ({ endpoint, runnerIdentity: { kind: "local", id: "local-1" }, services: [] });
	const start = hooks.start ?? (async (): Promise<StartedService> => started());
	const inspect = hooks.inspect ?? (async (): Promise<StartedService> => started());
	return {
		mode: "local",
		start: vi.fn(start),
		inspect: vi.fn(inspect),
		stop: vi.fn(hooks.stop ?? (async () => {})),
		remove: vi.fn(hooks.remove ?? (async () => {})),
	};
}

function createSupervisor(input: {
	clock: ManualClock;
	store?: Store;
	runner?: ServiceRunner;
	probe: ReturnType<typeof vi.fn>;
	restart?: ServiceRuntimeManifest["lifecycle"]["restart"];
	settingsRevision?: string;
}): { instance: ServiceRuntimeSupervisor; store: Store; runner: ServiceRunner } {
	const store = input.store ?? new Store();
	const runner = input.runner ?? localRunner();
	const runtime = input.restart ? { ...manifest, lifecycle: { ...manifest.lifecycle, restart: input.restart } } : manifest;
	const runtimeContribution = { ...contribution, manifest: runtime };
	return {
		instance: new ServiceRuntimeSupervisor({
			registry: { getRuntime: vi.fn(() => runtimeContribution) } as any,
			store: store as any,
			runners: [runner],
			authorizer: { authorize: async () => true },
			settings: { resolve: async () => ({ mode: "local", revision: input.settingsRevision ?? "revision-1", values: {} }) },
			serverIdentity: "server",
			clock: input.clock,
			probe: input.probe as unknown as ServiceRuntimeProbe,
		}),
		store,
		runner,
	};
}

async function flush(): Promise<void> {
	// Health work crosses the detached monitor, lifecycle queue, probe, durable
	// update, and owned-resource cleanup; drain every deterministic microtask.
	for (let index = 0; index < 16; index++) await Promise.resolve();
}

describe("ServiceRuntimeSupervisor health monitor", () => {
	it("persists a degraded health failure, clears the endpoint, and removes the owned resource", async () => {
		const clock = new ManualClock();
		let attempts = 0;
		const probe = vi.fn(async () => ++attempts === 1);
		const { instance, store, runner } = createSupervisor({ clock, probe });

		await instance.start({ ...identity, mode: "local" });
		assert.deepEqual(clock.waits.map((wait) => wait.ms), [10]);
		clock.advance();
		await flush();

		assert.equal(store.record?.desired, "running");
		assert.equal(store.record?.endpoint, undefined);
		assert.equal(store.record?.runnerIdentity, undefined);
		assert.deepEqual(store.record?.lastDiagnostic, { code: "SERVICE_DEGRADED" });
		assert.equal((runner.remove as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		await expect(instance.context(identity)).resolves.toEqual({ state: "degraded", diagnostic: { code: "SERVICE_DEGRADED" } });
	});

	it("classifies a missing inspected resource as persistently degraded without probing it", async () => {
		const clock = new ManualClock();
		const probe = vi.fn(async () => true);
		const runner = localRunner({ inspect: async () => undefined });
		const { instance, store } = createSupervisor({ clock, probe, runner });

		await instance.start({ ...identity, mode: "local" });
		clock.advance();
		await flush();

		assert.deepEqual(store.record?.lastDiagnostic, { code: "SERVICE_DOWN" });
		assert.equal(probe.mock.calls.length, 1, "only initial readiness may probe a missing resource");
		await expect(instance.context(identity)).resolves.toEqual({ state: "degraded", diagnostic: { code: "SERVICE_DOWN" } });
	});

	it("cancels periodic checks before stopped intent is persisted", async () => {
		const clock = new ManualClock();
		const probe = vi.fn(async () => true);
		const { instance, runner } = createSupervisor({ clock, probe });

		await instance.start({ ...identity, mode: "local" });
		await instance.stop({ ...identity, mode: "local" });
		clock.advance();
		await flush();

		assert.equal((runner.inspect as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal(probe.mock.calls.length, 1, "only readiness may probe after a cancelled monitor");
	});

	it("uses the existing bounded restart policy after a health failure", async () => {
		const clock = new ManualClock();
		let probes = 0;
		const probe = vi.fn(async () => ++probes !== 2);
		const { instance, store, runner } = createSupervisor({
			clock,
			probe,
			restart: { policy: "on-failure", maxAttempts: 1, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 10 },
		});

		await instance.start({ ...identity, mode: "local" });
		clock.advance();
		await flush();
		assert.deepEqual(store.record?.lastDiagnostic, { code: "SERVICE_DEGRADED", retryAt: "1970-01-01T00:00:00.020Z" });
		assert.deepEqual(clock.waits.map((wait) => wait.ms), [10]);
		clock.advance();
		await flush();

		assert.equal((runner.start as ReturnType<typeof vi.fn>).mock.calls.length, 2);
		assert.equal(store.record?.endpoint, endpoint);
		assert.equal(store.record?.lastDiagnostic, undefined);
	});

	it("does not reuse a stale ready record unless its settings revision and inspected identity match", async () => {
		const clock = new ManualClock();
		const store = new Store();
		store.record = record({ endpoint, runnerIdentity: { kind: "local", id: "stale-local" } });
		const runner = localRunner({ inspect: async () => undefined });
		const probe = vi.fn(async () => true);
		const { instance } = createSupervisor({ clock, store, runner, probe, settingsRevision: "revision-1" });

		await instance.reconcile();
		assert.equal((runner.inspect as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((runner.remove as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((runner.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);

		store.record = record({ endpoint, runnerIdentity: { kind: "local", id: "old-revision" } });
		const secondClock = new ManualClock();
		const { instance: revised, runner: revisedRunner } = createSupervisor({ clock: secondClock, store, runner: localRunner(), probe, settingsRevision: "revision-2" });
		await revised.reconcile();
		assert.equal((revisedRunner.inspect as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((revisedRunner.remove as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((revisedRunner.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});
});
