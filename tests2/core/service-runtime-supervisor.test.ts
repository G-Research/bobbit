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
			HOST: { value: "127.0.0.1" },
		},
		modes: {
			local: { command: "fixture", args: [], portEnv: "PORT", hostEnv: "HOST" },
			docker: { image: "fixture:latest" },
			compose: { file: "compose.yaml", service: "fixture", projectName: "fixture-${serverIdentity}" },
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
	generatedSecretCalls = 0;
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
		this.generatedSecretCalls += 1;
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

function runner(mode: ServiceRunner["mode"], hooks: Partial<Pick<ServiceRunner, "start" | "inspect" | "stop" | "remove">> = {}): ServiceRunner {
	return {
		mode,
		start: vi.fn(hooks.start ?? (async () => ({ endpoint, runnerIdentity: { kind: mode, id: `${mode}-1` }, services: [] }))),
		inspect: vi.fn(hooks.inspect ?? (async () => undefined)),
		stop: vi.fn(hooks.stop ?? (async () => {})),
		remove: vi.fn(hooks.remove ?? (async () => {})),
	};
}

function supervisor(input: {
	store?: FakeStore;
	contribution?: RuntimeContribution | null;
	runners?: ServiceRunner[];
	clock?: ServiceRuntimeClock;
	probe?: ReturnType<typeof vi.fn>;
	settings?: { mode: "local" | "docker" | "compose"; revision: string; values: Record<string, string | undefined>; storageIdentity?: string; storageContinuity?: "verified" | "unsupported"; resolvedSecrets?: Readonly<Record<string, string | undefined>> };
	resolve?: ReturnType<typeof vi.fn>;
	authorize?: ReturnType<typeof vi.fn>;
	resolveSecret?: ReturnType<typeof vi.fn>;
} = {}) {
	const store = input.store ?? new FakeStore();
	const authorize = input.authorize ?? vi.fn(async () => true);
	const resolve = input.resolve ?? vi.fn(async () => input.settings ?? { mode: "local" as const, revision: "revision-1", values: { configValue: "configured" } });
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
		assert.deepEqual(events, ["persist:none", "environment", "start", "persist:none", `persist:${endpoint}`]);
		assert.deepEqual(store.environmentCalls, [{ FIXED: "fixed", CONFIG: "configured", USER_SECRET: "user-secret", GENERATED_SECRET: "generated-TOKEN", PORT: "8080", HOST: "127.0.0.1" }]);
		assert.equal(resolveSecret.mock.calls.length, 1);
		assert.ok(!JSON.stringify(store.replaceCalls).includes("user-secret"));
		assert.ok(!JSON.stringify(store.replaceCalls).includes("generated-TOKEN"));
		assert.deepEqual(store.logCalls, [{ output: "USER_SECRET=user-secret generated-TOKEN", redactions: ["user-secret", "generated-TOKEN"] }]);
	});

	it("materializes only the resolved secret snapshot and redacts it without a second secret lookup", async () => {
		const local = runner("local", { start: async (input) => {
			assert.equal(input.environment.USER_SECRET, "snapshot-secret");
			assert.deepEqual(input.redactions, ["snapshot-secret", "generated-TOKEN"]);
			return { endpoint, runnerIdentity: { kind: "local", id: "local-snapshot" }, services: [] };
		} });
		const resolveSecret = vi.fn(async () => "newly-rotated-secret");
		const { instance, store } = supervisor({
			runners: [local],
			resolveSecret,
			settings: {
				mode: "local", revision: "revision-snapshot", values: { configValue: "configured" },
				resolvedSecrets: { apiKey: "snapshot-secret" },
			},
		});

		await expect(instance.start({ ...identity, mode: "local" })).resolves.toMatchObject({ state: "ready" });
		assert.equal(resolveSecret.mock.calls.length, 0, "a control uses its immutable settings/secret snapshot");
		assert.deepEqual(store.environmentCalls[0], { FIXED: "fixed", CONFIG: "configured", USER_SECRET: "snapshot-secret", GENERATED_SECRET: "generated-TOKEN", PORT: "8080", HOST: "127.0.0.1" });
		assert.ok(!JSON.stringify(store.replaceCalls).includes("snapshot-secret"));
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

	it("never projects a persisted ready endpoint after its contribution disappears", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "local-1" } }));
		const { instance } = supervisor({ store, contribution: null, runners: [runner("local")] });
		assert.deepEqual(await instance.status(identity), {
			identity,
			desired: "running",
			mode: "local",
			state: "unavailable",
			diagnostic: { code: "SERVICE_RUNTIME_NOT_FOUND" },
		});
		assert.deepEqual(await instance.context(identity), {
			state: "unavailable",
			diagnostic: { code: "SERVICE_RUNTIME_NOT_FOUND" },
		});
	});

	for (const mode of ["local", "docker", "compose"] as const) {
		it(`removes the owned ${mode} resource before contribution removal without purging durable state`, async () => {
			const store = new FakeStore();
			store.records.set(store.key(identity), record({
				selectedMode: mode,
				endpoint,
				runnerIdentity: { kind: mode, id: `${mode}-1`, ...(mode === "compose" ? { composeProject: "fixture-server-1" } : {}) },
			}));
			const ownedRunner = runner(mode);
			const { instance, authorize } = supervisor({ store, runners: [ownedRunner] });

			assert.deepEqual(await instance.removeOwnedResource(identity), {
				identity, desired: "stopped", mode, state: "stopped",
			});
			assert.equal((ownedRunner.remove as ReturnType<typeof vi.fn>).mock.calls.length, 1);
			assert.equal((ownedRunner.stop as ReturnType<typeof vi.fn>).mock.calls.length, 0);
			assert.equal(authorize.mock.calls.length, 2, "authorization is live at both cleanup side-effect boundaries");
			const persisted = await store.load(identity);
			assert.equal(persisted?.desired, "stopped");
			assert.equal(persisted?.selectedMode, mode);
			assert.equal(persisted?.endpoint, undefined);
			assert.equal(persisted?.runnerIdentity, undefined);
			assert.equal(persisted?.lastDiagnostic, undefined);
			assert.equal(store.generated.size, 0, "runner cleanup never purges generated secrets");
		});
	}

	it("fails closed before contribution cleanup when the live stop grant is denied", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "local-1" } }));
		const local = runner("local");
		const { instance } = supervisor({ store, runners: [local], authorize: vi.fn(async () => false) });

		await assert.rejects(instance.removeOwnedResource(identity), (error: unknown) => error instanceof ServiceRuntimeError && error.code === "SERVICE_AUTHORIZATION_DENIED");
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.deepEqual(await store.load(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "local-1" } }));
	});

	it("keeps ownership durable and retryable when contribution cleanup fails", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "docker", id: "docker-1" } }));
		const remove = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error("daemon unavailable"), { code: "SERVICE_DOCKER_UNAVAILABLE" }))
			.mockResolvedValueOnce(undefined);
		const docker = runner("docker", { remove });
		const { instance } = supervisor({ store, runners: [docker] });

		await assert.rejects(instance.removeOwnedResource(identity), (error: unknown) => error instanceof ServiceRuntimeError && error.code === "SERVICE_UNAVAILABLE");
		const failed = await store.load(identity);
		assert.equal(failed?.desired, "stopped");
		assert.equal(failed?.endpoint, undefined);
		assert.deepEqual(failed?.runnerIdentity, { kind: "docker", id: "docker-1" });
		assert.deepEqual(failed?.lastDiagnostic, { code: "SERVICE_UNAVAILABLE" });
		await expect(instance.removeOwnedResource(identity)).resolves.toMatchObject({ desired: "stopped", state: "stopped" });
		assert.equal(remove.mock.calls.length, 2);
		assert.equal((await store.load(identity))?.runnerIdentity, undefined);
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

	it("deduplicates matching starts but rejects an overlapping restart or selected-mode conflict", async () => {
		let release!: () => void;
		let started!: () => void;
		const launched = new Promise<void>((resolve) => { release = resolve; });
		const enteredStart = new Promise<void>((resolve) => { started = resolve; });
		const local = runner("local", { start: async () => {
			started();
			await launched;
			return { endpoint, runnerIdentity: { kind: "local", id: "local-1" }, services: [] };
		} });
		const { instance, store } = supervisor({ runners: [local], probe: vi.fn(async () => true) });
		const first = instance.start({ ...identity, mode: "local" });
		await enteredStart;
		const duplicate = instance.start({ ...identity, mode: "local" });
		await expect(instance.restart({ ...identity, mode: "local" })).rejects.toMatchObject({ code: "SERVICE_START_CONFLICT" });
		await expect(instance.start({ ...identity, mode: "docker" })).rejects.toMatchObject({ code: "SERVICE_START_CONFLICT" });
		release();
		await expect(first).resolves.toMatchObject({ state: "ready", endpoint });
		await expect(duplicate).resolves.toMatchObject({ state: "ready", endpoint });
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 0, "a rejected restart never inherits or mutates the start lifecycle");
		expect(await store.load(identity)).toMatchObject({
			desired: "running", selectedMode: "local", endpoint, runnerIdentity: { kind: "local", id: "local-1" },
		});
	});

	it("deduplicates matching restarts into one stop-then-start lifecycle", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "old-resource" } }));
		let releaseStop!: () => void;
		let stopping!: () => void;
		const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
		const enteredStop = new Promise<void>((resolve) => { stopping = resolve; });
		const restartedEndpoint = `${endpoint}/restarted`;
		const local = runner("local", {
			stop: async () => { stopping(); await stopped; },
			start: async () => ({ endpoint: restartedEndpoint, runnerIdentity: { kind: "local", id: "new-resource" }, services: [] }),
		});
		const { instance } = supervisor({ store, runners: [local], probe: vi.fn(async () => true) });

		const first = instance.restart({ ...identity, mode: "local" });
		await enteredStop;
		const duplicate = instance.restart({ ...identity, mode: "local" });
		releaseStop();

		await expect(first).resolves.toMatchObject({ state: "ready", endpoint: restartedEndpoint });
		await expect(duplicate).resolves.toMatchObject({ state: "ready", endpoint: restartedEndpoint });
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		expect(await store.load(identity)).toMatchObject({
			desired: "running", selectedMode: "local", endpoint: restartedEndpoint, runnerIdentity: { kind: "local", id: "new-resource" },
		});
	});

	it("authorizes every public caller before allowing it to join a start", async () => {
		let release!: () => void;
		const launched = new Promise<void>((resolve) => { release = resolve; });
		const local = runner("local", { start: async () => {
			await launched;
			return { endpoint, runnerIdentity: { kind: "local", id: "local-1" }, services: [] };
		} });
		const authorize = vi.fn(async () => authorize.mock.calls.length !== 6);
		const { instance } = supervisor({ authorize, runners: [local], probe: vi.fn(async () => true) });

		const permitted = instance.start({ ...identity, mode: "local" });
		await flush();
		await expect(instance.start({ ...identity, mode: "local" })).rejects.toMatchObject({ code: "SERVICE_AUTHORIZATION_DENIED" });
		assert.equal(authorize.mock.calls.length, 6);
		release();
		await expect(permitted).resolves.toMatchObject({ state: "ready", endpoint });
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
	});

	it("re-reads the live grant when applying a queued public start", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "local-1" } }));
		let releaseStop!: () => void;
		const stopping = new Promise<void>((resolve) => { releaseStop = resolve; });
		let allowed = true;
		const authorize = vi.fn(async (_request: unknown) => allowed);
		const local = runner("local", { stop: async () => stopping });
		const { instance } = supervisor({ store, authorize, runners: [local] });

		const stop = instance.stop({ ...identity, mode: "local" });
		await flush();
		const start = instance.start({ ...identity, mode: "local" });
		await flush();
		allowed = false;
		releaseStop();
		await stop;
		await expect(start).rejects.toMatchObject({ code: "SERVICE_AUTHORIZATION_DENIED" });

		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal(authorize.mock.calls.length, 3);
	});

	it("fails closed after deferred settings revoke without applying any start side effects", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ runnerIdentity: { kind: "local", id: "stale-resource" } }));
		let releaseSettings!: () => void;
		let settingsResolving!: () => void;
		const settingsReady = new Promise<void>((resolve) => { releaseSettings = resolve; });
		const settingsResolvingPromise = new Promise<void>((resolve) => { settingsResolving = resolve; });
		const resolve = vi.fn(async () => {
			settingsResolving();
			await settingsReady;
			return { mode: "local" as const, revision: "revision-2", values: { configValue: "configured" } };
		});
		let allowed = true;
		const authorize = vi.fn(async () => allowed);
		const local = runner("local");
		const { instance } = supervisor({ store, resolve, authorize, runners: [local] });

		const start = instance.start({ ...identity, mode: "local" });
		await settingsResolvingPromise;
		allowed = false;
		releaseSettings();

		await expect(start).rejects.toMatchObject({ code: "SERVICE_AUTHORIZATION_DENIED" });
		assert.equal(store.replaceCalls.length, 0, "revocation before desired persistence leaves the record untouched");
		assert.equal(store.environmentCalls.length, 0);
		assert.equal(store.generatedSecretCalls, 0);
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal(authorize.mock.calls.length, 3, "the application grant fence runs after settings resolve");
	});

	it("continues a start when the grant remains live through deferred settings", async () => {
		let releaseSettings!: () => void;
		let settingsResolving!: () => void;
		const settingsReady = new Promise<void>((resolve) => { releaseSettings = resolve; });
		const settingsResolvingPromise = new Promise<void>((resolve) => { settingsResolving = resolve; });
		const resolve = vi.fn(async () => {
			settingsResolving();
			await settingsReady;
			return { mode: "local" as const, revision: "revision-2", values: { configValue: "configured" } };
		});
		const authorize = vi.fn(async () => true);
		const local = runner("local");
		const { instance, store } = supervisor({ resolve, authorize, runners: [local] });

		const start = instance.start({ ...identity, mode: "local" });
		await settingsResolvingPromise;
		releaseSettings();

		await expect(start).resolves.toMatchObject({ state: "ready", endpoint });
		assert.equal(authorize.mock.calls.length, 5, "each start application boundary reads the current grant");
		assert.equal(store.environmentCalls.length, 1);
		assert.equal(store.generatedSecretCalls, 1);
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
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 1);
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

	it("re-reads the live grant when applying a queued crash restart", async () => {
		const clock = new ManualClock();
		let allowed = true;
		const authorize = vi.fn(async (_request: unknown) => allowed);
		const failing = runner("local", { start: async () => { throw Object.assign(new Error("unhealthy"), { code: "SERVICE_LAUNCH_FAILED" }); } });
		const { instance, store } = supervisor({
			clock,
			authorize,
			contribution: contribution(manifest({ lifecycle: { startPolicy: "manual", restart: { policy: "on-failure", maxAttempts: 1, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 10 } } })),
			runners: [failing],
		});

		await instance.start({ ...identity, mode: "local" });
		assert.deepEqual(clock.waits.map((wait) => wait.ms), [10]);
		allowed = false;
		clock.advance();
		await flush();

		assert.equal((failing.start as ReturnType<typeof vi.fn>).mock.calls.length, 1, "revocation prevents the queued restart launch");
		assert.equal(authorize.mock.calls.length, 6);
		assert.deepEqual(authorize.mock.calls[5]?.[0], { ...identity, action: "start" });
		assert.deepEqual(store.replaceCalls.at(-1)?.lastDiagnostic, { code: "SERVICE_DEGRADED", retryAt: "1970-01-01T00:00:00.010Z" });
	});

	it("does not let a denied stop cancel an authorized queued restart", async () => {
		const clock = new ManualClock();
		let allowed = true;
		const authorize = vi.fn(async () => allowed);
		const failing = runner("local", { start: async () => { throw Object.assign(new Error("unhealthy"), { code: "SERVICE_LAUNCH_FAILED" }); } });
		const { instance } = supervisor({
			clock,
			authorize,
			contribution: contribution(manifest({ lifecycle: { startPolicy: "manual", restart: { policy: "on-failure", maxAttempts: 2, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 10 } } })),
			runners: [failing],
		});

		await instance.start({ ...identity, mode: "local" });
		allowed = false;
		await expect(instance.stop({ ...identity, mode: "local" })).rejects.toMatchObject({ code: "SERVICE_AUTHORIZATION_DENIED" });
		allowed = true;
		clock.advance();
		await flush();

		assert.equal((failing.start as ReturnType<typeof vi.fn>).mock.calls.length, 2, "the denied stop did not alter restart scheduling");
	});

	it("does not let a denied purge cancel an authorized queued restart", async () => {
		const clock = new ManualClock();
		let allowed = true;
		const authorize = vi.fn(async () => allowed);
		const failing = runner("local", { start: async () => { throw Object.assign(new Error("unhealthy"), { code: "SERVICE_LAUNCH_FAILED" }); } });
		const { instance } = supervisor({
			clock,
			authorize,
			contribution: contribution(manifest({ lifecycle: { startPolicy: "manual", restart: { policy: "on-failure", maxAttempts: 2, windowMs: 100, initialBackoffMs: 10, maxBackoffMs: 10 } } })),
			runners: [failing],
		});

		await instance.start({ ...identity, mode: "local" });
		allowed = false;
		await expect(instance.purge({ ...identity, confirmation: identity })).rejects.toMatchObject({ code: "SERVICE_AUTHORIZATION_DENIED" });
		allowed = true;
		clock.advance();
		await flush();

		assert.equal((failing.start as ReturnType<typeof vi.fn>).mock.calls.length, 2, "the denied purge did not alter restart scheduling");
	});

	it("preflights restart continuity before mutating an existing resource", async () => {
		const store = new FakeStore();
		const old = record({
			endpoint,
			runnerIdentity: { kind: "local", id: "old-resource" },
			storageIdentity: "hindsight-managed:old-bank",
		});
		store.records.set(store.key(identity), old);
		const local = runner("local");
		const { instance, resolve } = supervisor({
			store,
			runners: [local],
			settings: { mode: "docker", revision: "revision-2", values: { configValue: "configured" }, storageIdentity: "hindsight-external:new-bank" },
		});
		const before = JSON.stringify(store.records.get(store.key(identity)));

		await expect(instance.restartWithResult({ ...identity, mode: "docker" })).rejects.toMatchObject({ code: "SERVICE_CONTINUITY_REQUIRED" });
		assert.equal(resolve.mock.calls.length, 1, "restart resolves one snapshot before continuity preflight");
		assert.equal(JSON.stringify(store.records.get(store.key(identity))), before, "mismatch leaves the persisted record byte-for-byte unchanged");
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		const status = await instance.status(identity);
		assert.deepEqual(status, { identity, desired: "running", mode: "local", state: "degraded", diagnostic: { code: "SERVICE_DOWN" } });
		assert.ok(!JSON.stringify(status).includes("new-bank"), "continuity identities never surface in status");
	});

	it("blocks an unverified managed backing before a restart removes it", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({
			endpoint,
			runnerIdentity: { kind: "local", id: "ephemeral-hindsight" },
			storageIdentity: "hindsight-unverified-managed:local",
		}));
		const local = runner("local");
		const { instance } = supervisor({
			store,
			runners: [local],
			settings: {
				mode: "local", revision: "revision-2", values: { configValue: "configured" },
				storageIdentity: "hindsight-unverified-managed:local", storageContinuity: "unsupported",
			},
		});

		await expect(instance.restart({ ...identity, mode: "local" })).rejects.toMatchObject({ code: "SERVICE_CONTINUITY_REQUIRED" });
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal(store.records.get(store.key(identity))?.storageIdentity, "hindsight-unverified-managed:local");
	});

	it("uses the established stop-then-start path when restart continuity matches", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({
			endpoint,
			runnerIdentity: { kind: "local", id: "old-resource" },
			storageIdentity: "hindsight-managed:stable-bank",
		}));
		const local = runner("local", {
			start: async () => ({ endpoint: `${endpoint}/restarted`, runnerIdentity: { kind: "local", id: "new-resource" }, services: [] }),
		});
		const { instance } = supervisor({
			store,
			runners: [local],
			settings: { mode: "local", revision: "revision-2", values: { configValue: "configured" }, storageIdentity: "hindsight-managed:stable-bank" },
			probe: vi.fn(async () => true),
		});

		await expect(instance.restart({ ...identity, mode: "local" })).resolves.toMatchObject({ state: "ready", endpoint: `${endpoint}/restarted` });
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1, "restart keeps the normal stop phase after preflight");
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 1, "restart keeps normal stale ownership removal");
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal(store.records.get(store.key(identity))?.storageIdentity, "hindsight-managed:stable-bank");
	});

	it("restarts from one immutable settings snapshot despite a concurrent save", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({
			endpoint,
			runnerIdentity: { kind: "local", id: "old-resource" },
			storageIdentity: "hindsight-managed:stable-bank",
		}));
		let resolvedSnapshot!: () => void;
		const snapshotRead = new Promise<void>((resolve) => { resolvedSnapshot = resolve; });
		let releaseResolution!: () => void;
		const release = new Promise<void>((resolve) => { releaseResolution = resolve; });
		let current = {
			mode: "local" as const, revision: "revision-2", values: { configValue: "old-public" },
			resolvedSecrets: { apiKey: "old-secret" }, storageIdentity: "hindsight-managed:stable-bank",
		};
		const resolve = vi.fn(async () => {
			const captured = structuredClone(current);
			resolvedSnapshot();
			await release;
			return captured;
		});
		const local = runner("local", {
			start: async (input) => {
				assert.equal(input.environment.CONFIG, "old-public");
				assert.equal(input.environment.USER_SECRET, "old-secret");
				return { endpoint: `${endpoint}/restarted`, runnerIdentity: { kind: "local", id: "new-resource" }, services: [] };
			},
		});
		const { instance, resolveSecret } = supervisor({ store, runners: [local], resolve, probe: vi.fn(async () => true) });

		const restarting = instance.restartWithResult({ ...identity, mode: "local" });
		await snapshotRead;
		current = {
			mode: "local", revision: "revision-3", values: { configValue: "new-public" },
			resolvedSecrets: { apiKey: "new-secret" }, storageIdentity: "hindsight-managed:stable-bank",
		};
		releaseResolution();

		await expect(restarting).resolves.toMatchObject({ settingsRevision: "revision-2", status: { state: "ready", endpoint: `${endpoint}/restarted` } });
		assert.equal(resolve.mock.calls.length, 1, "restart never resolves a second generation after stop");
		assert.equal(resolveSecret.mock.calls.length, 0, "the captured EP-7 secret pair is never mixed with a later generation");
		assert.deepEqual(store.environmentCalls.at(-1), {
			FIXED: "fixed", CONFIG: "old-public", USER_SECRET: "old-secret", GENERATED_SECRET: "generated-TOKEN", PORT: "8080", HOST: "127.0.0.1",
		});
		assert.equal(store.records.get(store.key(identity))?.settingsRevision, "revision-2");
	});

	it("rechecks a live grant after stop before launching a restart", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({
			endpoint,
			runnerIdentity: { kind: "local", id: "old-resource" },
			storageIdentity: "hindsight-managed:stable-bank",
		}));
		let stopped = false;
		const authorize = vi.fn(async ({ action }: { action: string }) => action !== "start" || !stopped);
		const local = runner("local", { stop: async () => { stopped = true; } });
		const { instance } = supervisor({
			store,
			runners: [local],
			authorize,
			settings: { mode: "local", revision: "revision-2", values: { configValue: "configured" }, storageIdentity: "hindsight-managed:stable-bank" },
		});

		await expect(instance.restartWithResult({ ...identity, mode: "local" })).rejects.toMatchObject({ code: "SERVICE_AUTHORIZATION_DENIED" });
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal((local.remove as ReturnType<typeof vi.fn>).mock.calls.length, 0, "revocation prevents stale-resource removal and launch");
		assert.equal((local.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		assert.equal(store.environmentCalls.length, 0);
		const persisted = store.records.get(store.key(identity));
		assert.equal(persisted?.desired, "stopped", "stopped ownership stays durable for an authorized retry");
		assert.equal(persisted?.endpoint, undefined);
		assert.deepEqual(persisted?.runnerIdentity, { kind: "local", id: "old-resource" });
	});

	it("blocks a legacy runtime without an identity when a settings owner now resolves one", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "legacy-resource" } }));
		const local = runner("local");
		const { instance } = supervisor({
			store,
			runners: [local],
			settings: { mode: "local", revision: "revision-2", values: { configValue: "configured" }, storageIdentity: "hindsight-managed:known-bank" },
		});

		await expect(instance.restart({ ...identity, mode: "local" })).rejects.toMatchObject({ code: "SERVICE_CONTINUITY_REQUIRED" });
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 0, "legacy records require explicit migration rather than replacement");
		assert.equal(store.records.get(store.key(identity))?.storageIdentity, undefined);
	});

	it("keeps legacy generic records compatible when no settings owner opts into continuity", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "legacy-resource" } }));
		const local = runner("local", {
			start: async () => ({ endpoint: `${endpoint}/legacy-restarted`, runnerIdentity: { kind: "local", id: "new-resource" }, services: [] }),
		});
		const { instance } = supervisor({ store, runners: [local], probe: vi.fn(async () => true) });

		await expect(instance.restart({ ...identity, mode: "local" })).resolves.toMatchObject({ state: "ready", endpoint: `${endpoint}/legacy-restarted` });
		assert.equal((local.stop as ReturnType<typeof vi.fn>).mock.calls.length, 1);
		assert.equal(store.records.get(store.key(identity))?.storageIdentity, undefined);
	});

	it("persists stopped intent before teardown and cancels a pending restart", async () => {
		const store = new FakeStore();
		store.records.set(store.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "local-1" } }));
		const local = runner("local", { stop: async () => {
			const persisted = await store.load(identity);
			assert.equal(persisted?.desired, "stopped");
			assert.equal(persisted?.endpoint, undefined);
			assert.deepEqual(persisted?.runnerIdentity, { kind: "local", id: "local-1" });
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

	it("retains ownership and a diagnostic when stop or stale removal fails", async () => {
		const stopStore = new FakeStore();
		stopStore.records.set(stopStore.key(identity), record({ endpoint, runnerIdentity: { kind: "local", id: "owned" } }));
		const failingStop = runner("local", { stop: async () => { throw Object.assign(new Error("still running"), { code: "SERVICE_STOP_FAILED" }); } });
		const { instance: stopping } = supervisor({ store: stopStore, runners: [failingStop] });
		await expect(stopping.stop({ ...identity, mode: "local" })).rejects.toMatchObject({ code: "SERVICE_DEGRADED" });
		expect(stopStore.records.get(stopStore.key(identity))).toEqual(expect.objectContaining({
			desired: "stopped", endpoint: undefined, runnerIdentity: { kind: "local", id: "owned" }, lastDiagnostic: { code: "SERVICE_DEGRADED" },
		}));

		const replacementStore = new FakeStore();
		replacementStore.records.set(replacementStore.key(identity), record({ runnerIdentity: { kind: "local", id: "stale" } }));
		const failingRemove = runner("local");
		(failingRemove.remove as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error("remove failed"), { code: "SERVICE_LAUNCH_FAILED" }));
		const { instance: replacing } = supervisor({ store: replacementStore, runners: [failingRemove], probe: vi.fn(async () => true) });
		const status = await replacing.start({ ...identity, mode: "local" });
		assert.equal(status.state, "degraded");
		assert.equal((failingRemove.start as ReturnType<typeof vi.fn>).mock.calls.length, 0);
		expect(replacementStore.records.get(replacementStore.key(identity))).toEqual(expect.objectContaining({
			desired: "running", endpoint: undefined, runnerIdentity: { kind: "local", id: "stale" }, lastDiagnostic: { code: "SERVICE_DEGRADED" },
		}));
	});

	it("reconciles only durable local desired-running records and only inspects Docker and Compose", async () => {
		const store = new FakeStore();
		const dockerIdentity = { packId: "pack", runtimeId: "docker" };
		const composeIdentity = { packId: "pack", runtimeId: "compose" };
		store.records.set(store.key(identity), record({ selectedMode: "local" }));
		store.records.set(store.key(dockerIdentity), record({ selectedMode: "docker", endpoint, runnerIdentity: { kind: "docker", id: "docker-1" } }));
		store.records.set(store.key(composeIdentity), record({ selectedMode: "compose", endpoint, runnerIdentity: { kind: "compose", id: "compose-1", composeProject: "fixture-server-1" } }));
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
