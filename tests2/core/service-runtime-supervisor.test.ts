import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeContribution } from "../../src/server/agent/pack-contributions.js";
import type { ServiceRuntimeManifest } from "../../src/server/service-runtime/service-manifest.js";
import type { ServiceRunner } from "../../src/server/service-runtime/service-runners.js";
import {
	ServiceRuntimeError,
	ServiceRuntimeSupervisor,
	type ServiceRuntimeClock,
} from "../../src/server/service-runtime/service-supervisor.js";
import type {
	PersistedServiceRuntime,
	ServiceRuntimeIdentity,
} from "../../src/server/service-runtime/service-runtime-store.js";

const identity: ServiceRuntimeIdentity = { packId: "pack", runtimeId: "fixture" };
const endpoint = "http://127.0.0.1:45123";

function manifest(overrides: Partial<ServiceRuntimeManifest> = {}): ServiceRuntimeManifest {
	return {
		apiVersion: 1,
		id: "fixture",
		title: "Fixture",
		endpoint: {
			protocol: "http",
			servicePort: 8080,
			health: { path: "/health", expectedStatus: 200, requestTimeoutMs: 100, intervalMs: 10, startupTimeoutMs: 30 },
		},
		lifecycle: { startPolicy: "manual", restart: { policy: "never", maxAttempts: 0, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 40 } },
		environment: {
			FIXED: { value: "fixed" },
			CONFIG: { setting: "configValue" },
			USER_SECRET: { secret: "apiKey" },
			GENERATED_SECRET: { generatedSecret: "TOKEN" },
			PORT: { endpointPort: true },
		},
		modes: {
			local: { command: "fixture", args: [], portEnv: "PORT" },
			docker: { image: "fixture:latest" },
			compose: { file: "compose.yaml", service: "fixture", projectName: "fixture" },
		},
		...overrides,
	};
}

function contribution(value = manifest()): RuntimeContribution {
	return { id: identity.runtimeId, listName: "fixture.yaml", sourceFile: "/pack/runtimes/fixture.yaml", packRoot: "/pack", manifest: value };
}

function record(overrides: Partial<PersistedServiceRuntime> = {}): PersistedServiceRuntime {
	return {
		version: 1,
		serverIdentity: "server-1",
		desired: "running",
		selectedMode: "local",
		settingsRevision: "revision-1",
		restartAttempts: [],
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

class FakeStore {
	readonly records = new Map<string, PersistedServiceRuntime>();
	readonly replaceCalls: PersistedServiceRuntime[] = [];
	readonly environmentCalls: Array<Record<string, string>> = [];
	readonly logCalls: Array<{ output: string; redactions: readonly string[] }> = [];
	readonly generated = new Map<string, string>();
	failReplace = false;
	failLoad = false;

	identity(packId: string, runtimeId: string): ServiceRuntimeIdentity { return { packId, runtimeId }; }
	key(value: ServiceRuntimeIdentity): string { return `${value.packId}\u0000${value.runtimeId}`; }
	async load(value: ServiceRuntimeIdentity): Promise<PersistedServiceRuntime | undefined> {
		if (this.failLoad) throw Object.assign(new Error("state unavailable"), { code: "SERVICE_RUNTIME_STORE_PERSIST_FAILED" });
		const found = this.records.get(this.key(value));
		return found && structuredClone(found);
	}
	async list(): Promise<Array<{ identity: ServiceRuntimeIdentity; record: PersistedServiceRuntime }>> {
		return [...this.records.entries()].map(([key, value]) => {
			const [packId, runtimeId] = key.split("\u0000");
			return { identity: { packId: packId!, runtimeId: runtimeId! }, record: structuredClone(value) };
		});
	}
	async replace(value: ServiceRuntimeIdentity, next: PersistedServiceRuntime): Promise<void> {
		if (this.failReplace) throw Object.assign(new Error("disk unavailable"), { code: "SERVICE_RUNTIME_STORE_PERSIST_FAILED" });
		this.records.set(this.key(value), structuredClone(next));
		this.replaceCalls.push(structuredClone(next));
	}
	async writeEnvironment(_value: ServiceRuntimeIdentity, environment: Record<string, string>): Promise<void> {
		this.environmentCalls.push(structuredClone(environment));
	}
	async getOrCreateGeneratedSecret(_value: ServiceRuntimeIdentity, name: string): Promise<string> {
		const existing = this.generated.get(name);
		if (existing) return existing;
		const created = `generated-${name}`;
		this.generated.set(name, created);
		return created;
	}
	async resolveUserSecret(name: string): Promise<string | undefined> { return name === "apiKey" ? "store-secret" : undefined; }
	async writeLog(_value: ServiceRuntimeIdentity, output: string, redactions: readonly string[]): Promise<void> {
		this.logCalls.push({ output, redactions });
	}
	async readLog(): Promise<string | undefined> { return "bounded diagnostic"; }
}

function runner(mode: ServiceRunner["mode"], hooks: Partial<Pick<ServiceRunner, "start" | "inspect" | "stop">> = {}): ServiceRunner {
	return {
		mode,
		start: vi.fn(hooks.start ?? (async () => ({ endpoint, runnerIdentity: { kind: mode, id: `${mode}-1` }, services: [] }))),
		inspect: vi.fn(hooks.inspect ?? (async () => undefined)),
		stop: vi.fn(hooks.stop ?? (async () => {})),
		remove: vi.fn(async () => {}),
	};
}

function supervisor(input: {
	store?: FakeStore;
	contribution?: RuntimeContribution | undefined;
	runners?: ServiceRunner[];
	clock?: ServiceRuntimeClock;
	probe?: ReturnType<typeof vi.fn>;
	settings?: { mode: "local" | "docker" | "compose"; revision: string; values: Record<string, string | undefined> };
	authorize?: ReturnType<typeof vi.fn>;
	resolveSecret?: ReturnType<typeof vi.fn>;
} = {}) {
	const store = input.store ?? new FakeStore();
	const authorize = input.authorize ?? vi.fn(async () => true);
	const resolve = vi.fn(async () => input.settings ?? { mode: "local" as const, revision: "revision-1", values: { configValue: "configured" } });
	const resolveSecret = input.resolveSecret ?? vi.fn(async () => "user-secret");
	const runners = input.runners ?? [runner("local"), runner("docker"), runner("compose")];
	const instance = new ServiceRuntimeSupervisor({
		registry: { getRuntime: vi.fn(() => input.contribution === undefined ? contribution() : input.contribution) } as any,
		store: store as any,
		runners,
		authorizer: { authorize: authorize as any },
		settings: { resolve: resolve as any, resolveSecret: resolveSecret as any },
		serverIdentity: "server-1",
		clock: input.clock,
		probe: (input.probe ?? vi.fn(async () => true)) as any,
	});
	return { instance, store, authorize, resolve, resolveSecret, runners };
}

class AdvancingClock implements ServiceRuntimeClock {
	nowValue = 0;
	readonly sleeps: number[] = [];
	now(): number { return this.nowValue; }
	async sleep(ms: number): Promise<void> { this.sleeps.push(ms); this.nowValue += ms; }
}

class ManualClock implements ServiceRuntimeClock {
	nowValue = 0;
	readonly waits: Array<{ ms: number; resolve: () => void }> = [];
	now(): number { return this.nowValue; }
	sleep(ms: number): Promise<void> { return new Promise((resolve) => this.waits.push({ ms, resolve })); }
	advance(): void {
		const next = this.waits.shift();
		assert.ok(next, "expected a scheduled retry");
		this.nowValue += next.ms;
		next.resolve();
	}
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ServiceRuntimeSupervisor", () => {
	it("durably records desired state before secrets or launch, then exposes an endpoint only when ready", async () => {
		const events: string[] = [];
		const store = new FakeStore();
		const originalReplace = store.replace.bind(store);
		store.replace = async (value, next) => { events.push(`persist:${next.endpoint ?? "none"}`); await originalReplace(value, next); };
		store.writeEnvironment = async (_value, environment) => { events.push("environment"); store.environmentCalls.push(structuredClone(environment)); };
		const local = runner("local", { start: async (input) => {
			events.push("start");
			input.onOutput?.("USER_SECRET=user-secret generated-TOKEN");
			assert.deepEqual(input.redactions, ["user-secret", "generated-TOKEN"]);
			assert.equal(store.replaceCalls[0]?.desired, "running");
			assert.equal(store.replaceCalls[0]?.endpoint, undefined);
			assert.equal(store.replaceCalls[0]?.runnerIdentity, undefined);
			return { endpoint, runnerIdentity: { kind: "local", id: "local-1" }, services: [] };
		} });
		const { instance, resolveSecret } = supervisor({ store, runners: [local], probe: vi.fn(async () => true) });

		const status = await instance.start({ ...identity, mode: "local" });
		assert.deepEqual(status, { identity, desired: "running", mode: "local", state: "ready", endpoint });
		assert.deepEqual(events, ["persist:none", "environment", "start", `persist:${endpoint}`]);
		assert.deepEqual(store.environmentCalls, [{ FIXED: "fixed", CONFIG: "configured", USER_SECRET: "user-secret", GENERATED_SECRET: "generated-TOKEN", PORT: "8080" }]);
		assert.equal(resolveSecret.mock.calls.length, 1);
		assert.ok(!JSON.stringify(store.replaceCalls).includes("user-secret"));
		assert.ok(!JSON.stringify(store.replaceCalls).includes("generated-TOKEN"));
		assert.deepEqual(store.logCalls, [{ output: "USER_SECRET=user-secret generated-TOKEN", redactions: ["user-secret", "generated-TOKEN"] }]);
	});

	it("keeps context, status, and diagnostics read-only while reporting a missing inspected service as degraded", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "local-1" } }));
		const local = runner("local", { inspect: async () => undefined });
		const { instance, authorize, resolve, resolveSecret } = supervisor({ store, runners: [local] });

		assert.deepEqual(await instance.status(identity), {
			identity, desired: "running", mode: "local", state: "degraded", diagnostic: { code: "SERVICE_DOWN" },
		});
		assert.deepEqual(await instance.context(identity), { state: "degraded", diagnostic: { code: "SERVICE_DOWN" } });
		assert.equal(await instance.diagnostics(identity), "bounded diagnostic");
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal(store.environmentCalls.length, 0);
		assert.equal(authorize.mock.calls.length, 0);
		assert.equal(resolve.mock.calls.length, 0);
		assert.equal(resolveSecret.mock.calls.length, 0);
		assert.equal((local.inspect as ReturnType<typeof vi.fn>).mock.calls.length, 2);
	});

	it("degrades a failed durable read to unavailable without allocating or launching", async () => {
		const store = new FakeStore();
		store.failLoad = true;
		const local = runner("local");
		const { instance } = supervisor({ store, runners: [local] });
		assert.deepEqual(await instance.status(identity), {
			identity, desired: "stopped", state: "unavailable", diagnostic: { code: "SERVICE_RUNTIME_STORE_PERSIST_FAILED" },
		});
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((local.inspect as ReturnType<typeof vi.fn>).mock.calls.length, 0);
	});

	it("maps durable records to stopped, starting, blocked, unavailable, and ready without inventing endpoints", async () => {
		const store = new FakeStore();
		const { instance } = supervisor({ store, contribution: undefined });
		assert.deepEqual(await instance.status(identity), { identity, desired: "stopped", state: "stopped" });

		for (const [runtimeId, lastDiagnostic, expected] of [
			["starting", undefined, "starting"],
			["blocked", { code: "SERVICE_BLOCKED" }, "blocked"],
			["unavailable", { code: "SERVICE_UNAVAILABLE" }, "unavailable"],
		] as const) {
			const current = { packId: "pack", runtimeId };
			store.records.set(store.key(current), record({ endpoint: undefined, lastDiagnostic }));
			const status = await instance.status(current);
			assert.equal(status.state, expected);
			assert.equal(status.endpoint, undefined);
		}
	});

	it("deduplicates matching starts and rejects a simultaneous selected-mode conflict", async () => {
		let release!: () => void;
		const launched = new Promise<void>((resolve) => { release = resolve; });
		const local = runner("local", { start: async () => {
			await launched;
			return { endpoint, runnerIdentity: { kind: "local", id: "local-1" }, services: [] };
		} });
		const { instance } = supervisor({ runners: [local], probe: vi.fn(async () => true) });
		const first = instance.start({ ...identity, mode: "local" });
		const duplicate = instance.start({ ...identity, mode: "local" });
		assert.strictEqual(duplicate, first);
		await expect(instance.start({ ...identity, mode: "docker" })).rejects.toMatchObject({ code: "SERVICE_START_CONFLICT" });
		release();
		await expect(first).resolves.toMatchObject({ state: "ready", endpoint });
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	it("bounds readiness retries, tears down the failed launch, and never leaks an endpoint outside ready", async () => {
		const clock = new AdvancingClock();
		const local = runner("local");
		const { instance, store } = supervisor({ clock, runners: [local], probe: vi.fn(async () => false) });

		const status = await instance.start({ ...identity, mode: "local" });
		assert.deepEqual(status, {
			identity, desired: "running", mode: "local", state: "degraded", diagnostic: { code: "SERVICE_DEGRADED" },
		});
		assert.deepEqual(clock.sleeps, [10, 10, 10]);
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal(store.replaceCalls.at(-1)?.endpoint, undefined);
	});

	it("limits exponential on-failure restarts and persists each bounded retry attempt", async () => {
		const clock = new ManualClock();
		const failing = runner("local", { start: async () => { throw Object.assign(new Error("port conflict"), { code: "SERVICE_LAUNCH_FAILED" }); } });
		const restartManifest = manifest({ lifecycle: { startPolicy: "manual", restart: { policy: "on-failure", maxAttempts: 2, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 15 } } });
		const { instance, store } = supervisor({ clock, contribution: contribution(restartManifest), runners: [failing] });

		const initial = await instance.start({ ...identity, mode: "local" });
		assert.deepEqual(initial.diagnostic, { code: "SERVICE_DEGRADED", retryAt: "1970-01-01T00:00:00.010Z" });
		assert.deepEqual(clock.waits.map((wait) => wait.ms), [10]);
		clock.advance();
		await flush();
		assert.deepEqual(clock.waits.map((wait) => wait.ms), [15]);
		clock.advance();
		await flush();
		assert.equal((failing.start as ReturnType<typeof vi.fn>).mock.calls.length, 3);
		assert.deepEqual(clock.waits, []);
		assert.deepEqual(store.replaceCalls.at(-1)?.restartAttempts, [0, 10]);
	});

	it("persists stopped intent before teardown and cancels a pending restart", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "local-1" } }));
		const local = runner("local", { stop: async () => {
			const persisted = await store.load(identity);
			assert.equal(persisted?.desired, "stopped");
			assert.equal(persisted?.endpoint, undefined);
			assert.equal(persisted?.runnerIdentity, undefined);
		} });
		const { instance } = supervisor({ store, runners: [local] });
		await expect(instance.stop({ ...identity, mode: "local" })).resolves.toMatchObject({ state: "stopped", desired: "stopped" });
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1);

		const retryClock = new ManualClock();
		const failing = runner("local", { start: async () => { throw Object.assign(new Error("unhealthy"), { code: "SERVICE_LAUNCH_FAILED" }); } });
		const { instance: retrying } = supervisor({
			clock: retryClock,
			contribution: contribution(manifest({ lifecycle: { startPolicy: "manual", restart: { policy: "on-failure", maxAttempts: 1, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 10 } } })),
			runners: [failing],
		});
		await retrying.start({ ...identity, mode: "local" });
		await retrying.stop({ ...identity, mode: "local" });
		retryClock.advance();
		await flush();
		assert.equal((failing.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	it("reconciles only durable local desired-running records and only inspects Docker and Compose", async () => {
		const store = new FakeStore();
		const dockerIdentity = { packId: "pack", runtimeId: "docker" };
		const composeIdentity = { packId: "pack", runtimeId: "compose" };
		store.records.set(store.key(identity), record({ selectedMode: "local" }));
		store.records.set(store.key(dockerIdentity), record({ selectedMode: "docker", endpoint, runnerIdentity: { kind: "docker", id: "docker-1" } }));
		store.records.set(store.key(composeIdentity), record({ selectedMode: "compose", endpoint, runnerIdentity: { kind: "compose", id: "compose-1", composeProject: "fixture" } }));
		const local = runner("local");
		const docker = runner("docker", { inspect: async () => ({ endpoint, runnerIdentity: { kind: "docker", id: "docker-1" }, services: [] }) });
		const compose = runner("compose", { inspect: async () => ({ endpoint, runnerIdentity: { kind: "compose", id: "compose-1" }, services: [] }) });
		const registry = { getRuntime: vi.fn((_projectId: string | undefined, _pack: string, runtimeId: string) => runtimeId === "fixture" ? contribution() : contribution(manifest({ id: runtimeId }))) };
		const resolve = vi.fn(async (input: { runtimeId: string }) => ({ mode: input.runtimeId === "fixture" ? "local" : input.runtimeId as "docker" | "compose", revision: "revision-1", values: { configValue: "configured" } }));
		const instance = new ServiceRuntimeSupervisor({ registry: registry as any, store: store as any, runners: [local, docker, compose], authorizer: { authorize: async () => true }, settings: { resolve: resolve as any, resolveSecret: async () => "secret" }, serverIdentity: "server-1", probe: async () => true });

		const statuses = await instance.reconcile();
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((docker.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((compose.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((docker.inspect as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((compose.inspect as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.deepEqual(statuses.map((status) => status.state), ["ready", "ready", "ready"]);
	});

	it("fails a start before side effects when durable desired-state persistence fails", async () => {
		const store = new FakeStore();
		store.failReplace = true;
		const local = runner("local");
		const { instance, resolveSecret } = supervisor({ store, runners: [local] });

		await expect(instance.start({ ...identity, mode: "local" })).rejects.toBeInstanceOf(ServiceRuntimeError);
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal(store.environmentCalls.length, 0);
		assert.equal(resolveSecret.mock.calls.length, 0);
	});
});
