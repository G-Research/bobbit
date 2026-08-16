import { afterEach, describe, expect, it } from "vitest";
import provider, { __setClientFactory } from "../../market-packs/hindsight/src/provider.ts";
import {
	decodePendingKey, documentId, pendingKey, pendingPrefix, RETAIN_SWEEP_INTERVAL_MS, sweepDue, sweepKey,
	type HindsightIdentity, type PendingEnvelope, type StoreReadResult,
} from "../../market-packs/hindsight/src/shared.ts";

type MutateResult<T> = { status: "committed"; committed: true; value: T; version: number } | { status: "error"; committed: false; diagnostic: { code: string } };

function fakeStore() {
	const values = new Map<string, unknown>();
	const versions = new Map<string, number>();
	const mutations: string[] = [];
	let lists = 0;
	let failMutation: ((key: string) => boolean) | undefined;
	return {
		values, mutations,
		get lists() { return lists; },
		setFailMutation: (predicate?: (key: string) => boolean) => { failMutation = predicate; },
		seed: <T>(key: string, value: T) => { values.set(key, structuredClone(value)); versions.set(key, (versions.get(key) ?? 0) + 1); },
		get: async <T = unknown>(key: string): Promise<T | null> => values.has(key) ? structuredClone(values.get(key)) as T : null,
		read: async <T = unknown>(key: string): Promise<StoreReadResult<T>> => values.has(key)
			? { state: "present", value: structuredClone(values.get(key)) as T, version: versions.get(key) }
			: { state: "absent" },
		put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
		list: async (prefix = "") => { lists++; return [...values.keys()].filter(key => key.startsWith(prefix)); },
		mutate: async <T>(key: string, value: T, opts?: { expectedVersion?: number | null }): Promise<MutateResult<T>> => {
			mutations.push(key);
			if (failMutation?.(key)) return { status: "error", committed: false, diagnostic: { code: "TEST_MUTATION_FAILURE" } };
			if (opts?.expectedVersion !== undefined && opts.expectedVersion !== (versions.get(key) ?? null)) return { status: "error", committed: false, diagnostic: { code: "TEST_CONFLICT" } };
			const version = (versions.get(key) ?? 0) + 1;
			values.set(key, structuredClone(value)); versions.set(key, version);
			return { status: "committed", committed: true, value, version };
		},
	};
}

function pending(scope: { projectId: string; goalId: string; sessionId: string; role: string }, bank: string, namespace: string, capturedAt: number): PendingEnvelope {
	const identity: HindsightIdentity = { projectId: scope.projectId, goalId: scope.goalId, sessionId: scope.sessionId, bank, namespace, kind: "pending" };
	return { version: 2, identity, scope, turns: [{ summary: `private ${scope.projectId}`, capturedAt }], overlap: [], updatedAt: capturedAt, flushSeq: 0 };
}

function setup(store: ReturnType<typeof fakeStore>, projectId: string, now: number, extra: Record<string, unknown> = {}) {
	return provider.sessionSetup({
		config: { externalUrl: "https://memory.test", bank: "sweeper-bank", namespace: "sweeper-ns", retainMaxDelayMs: 1_000, timeoutMs: 10_000 },
		host: { store, memory: { requireCapability: () => {} } }, scopeContext: { project: { id: projectId }, goal: { id: "sweeper-goal" }, role: "sweeper" }, sessionId: "sweeper-session", now,
		...extra,
	});
}

afterEach(() => __setClientFactory(null));

describe("Hindsight v2 identity codec", () => {
	it("keeps adversarial project prefixes and target tuples disjoint", () => {
		const a: HindsightIdentity = { projectId: "p/a", goalId: "g:1", sessionId: "same", bank: "bank/a", namespace: "ns:a", kind: "pending" };
		const b: HindsightIdentity = { ...a, projectId: "p/ab" };
		const aKey = pendingKey(a);
		const bKey = pendingKey(b);
		expect(aKey).not.toBe(bKey);
		expect(bKey.startsWith(pendingPrefix(a.projectId))).toBe(false);
		expect(decodePendingKey(aKey)).toEqual(a);
		expect(documentId(a)).not.toBe(documentId({ ...a, bank: "other-bank" }));
	});

	it("does not decode malformed or near-match pending keys", () => {
		const identity: HindsightIdentity = { projectId: "project", sessionId: "session", bank: "bank", namespace: "namespace", kind: "pending" };
		const key = pendingKey(identity);
		expect(decodePendingKey(`${key}/extra`)).toBeUndefined();
		expect(decodePendingKey(key.replace("/spending/", "/soutcome/"))).toBeUndefined();
	});
});

describe("Hindsight stranded sweep", () => {
	it("uses the injected clock for due cadence and admits only one concurrent lease", async () => {
		const store = fakeStore();
		const now = 1_000_000;
		const record = pending({ projectId: "project-a", goalId: "goal-a", sessionId: "crashed", role: "owner" }, "bank-a", "namespace-a", now - 400_000);
		store.seed(pendingKey(record.identity), record);
		let releaseRetain!: () => void;
		let enteredRetain!: () => void;
		const retained = new Promise<void>(resolve => { releaseRetain = resolve; });
		const entered = new Promise<void>(resolve => { enteredRetain = resolve; });
		let calls = 0;
		__setClientFactory(() => ({
			health: async () => ({ ok: true }), ensureBank: async () => {}, recall: async () => ({ memories: [] }),
			retain: async () => { calls++; enteredRetain(); await retained; }, reflect: async () => ({ text: "" }), listBanks: async () => ({ banks: [] }),
		}));

		const first = setup(store, "project-a", now);
		await entered;
		const second = await setup(store, "project-a", now);
		expect(second).toEqual({ blocks: [] });
		expect(store.lists).toBe(1);
		expect(calls).toBe(1);
		releaseRetain();
		await first;

		const controlKey = sweepKey("project-a");
		const control = await store.get<{ active?: unknown; lastCompletedAt?: number; checkpoint?: { recordKey: string } }>(controlKey);
		expect(control?.active).toBeUndefined();
		expect(control).toMatchObject({ lastCompletedAt: now, checkpoint: { recordKey: pendingKey(record.identity) } });
		const advancedAt = store.mutations.indexOf(pendingKey(record.identity));
		const checkpointAt = store.mutations.findIndex((key, index) => key === controlKey && index > advancedAt);
		expect(advancedAt).toBeGreaterThan(-1);
		expect(checkpointAt).toBeGreaterThan(advancedAt);

		await setup(store, "project-a", now + RETAIN_SWEEP_INTERVAL_MS - 1);
		expect(store.lists).toBe(1);
		await setup(store, "project-a", now + RETAIN_SWEEP_INTERVAL_MS);
		expect(store.lists).toBe(2);
		expect(sweepDue({ version: 2, lastCompletedAt: now }, now + RETAIN_SWEEP_INTERVAL_MS - 1)).toBe(false);
		expect(sweepDue({ version: 2, lastCompletedAt: now }, now + RETAIN_SWEEP_INTERVAL_MS)).toBe(true);
	});

	it("takes over expired leases but never checkpoints after deadline or failed pending advancement", async () => {
		const now = 2_000_000;
		const expired = fakeStore();
		const expiredRecord = pending({ projectId: "project-a", goalId: "goal-a", sessionId: "expired", role: "owner" }, "bank-a", "namespace-a", now - 400_000);
		expired.seed(pendingKey(expiredRecord.identity), expiredRecord);
		expired.seed(sweepKey("project-a"), { version: 2, active: { runId: "dead-worker", startedAt: now - 2_000, deadlineEpochMs: now - 1 } });
		let retains = 0;
		__setClientFactory(() => ({ health: async () => ({ ok: true }), ensureBank: async () => {}, recall: async () => ({ memories: [] }), retain: async () => { retains++; }, reflect: async () => ({ text: "" }), listBanks: async () => ({ banks: [] }) }));
		await setup(expired, "project-a", now);
		expect(retains).toBe(1);
		const expiredControl = await expired.get<{ active?: unknown; lastCompletedAt?: number }>(sweepKey("project-a"));
		expect(expiredControl?.active).toBeUndefined();
		expect(expiredControl).toMatchObject({ lastCompletedAt: now });

		const deadline = fakeStore();
		const deadlineRecord = pending({ projectId: "project-a", goalId: "goal-a", sessionId: "deadline", role: "owner" }, "bank-a", "namespace-a", now - 400_000);
		deadline.seed(pendingKey(deadlineRecord.identity), deadlineRecord);
		await setup(deadline, "project-a", now, { deadline: { deadlineEpochMs: now } });
		expect(deadline.lists).toBe(0);
		expect(await deadline.get(sweepKey("project-a"))).toBeNull();

		const rejected = fakeStore();
		const rejectedRecord = pending({ projectId: "project-a", goalId: "goal-a", sessionId: "mutation-failed", role: "owner" }, "bank-a", "namespace-a", now - 400_000);
		const rejectedKey = pendingKey(rejectedRecord.identity);
		rejected.seed(rejectedKey, rejectedRecord);
		rejected.setFailMutation(key => key === rejectedKey);
		await setup(rejected, "project-a", now);
		expect(await rejected.get(rejectedKey)).toMatchObject({ turns: [{ summary: "private project-a" }] });
		const rejectedControl = await rejected.get<{ checkpoint?: unknown; lastCompletedAt?: unknown }>(sweepKey("project-a"));
		expect(rejectedControl?.checkpoint).toBeUndefined();
		expect(rejectedControl?.lastCompletedAt).toBeUndefined();
	});

	it("replays only complete original provenance and target, never the sweeping session configuration", async () => {
		const store = fakeStore();
		const now = 3_000_000;
		const privateRecord = pending({ projectId: "project-a", goalId: "original-goal", sessionId: "original-session", role: "original-role" }, "private-bank", "private-namespace", now - 400_000);
		store.seed(pendingKey(privateRecord.identity), privateRecord);
		// These keys deliberately satisfy the project-A list prefix but must fail
		// complete identity/provenance validation before a client is constructed.
		const foreign = pending({ projectId: "project-b", goalId: "foreign-goal", sessionId: "foreign", role: "foreign-role" }, "foreign-bank", "foreign-namespace", now - 400_000);
		store.seed(`${pendingPrefix("project-a")}forged-foreign`, foreign);
		store.seed(`${pendingPrefix("project-a")}malformed`, { version: 1, turns: [{ summary: "legacy private data", capturedAt: 0 }] });
		const factoryConfigs: Array<{ namespace?: string }> = [];
		const retains: Array<{ bank: string; opts?: { tags?: Record<string, string>; id?: string } }> = [];
		__setClientFactory(cfg => {
			factoryConfigs.push(cfg);
			return { health: async () => ({ ok: true }), ensureBank: async () => {}, recall: async () => ({ memories: [] }), retain: async (bank, _content, opts) => { retains.push({ bank, opts }); }, reflect: async () => ({ text: "" }), listBanks: async () => ({ banks: [] }) };
		});
		await setup(store, "project-a", now);
		expect(retains).toHaveLength(1);
		expect(retains[0]).toMatchObject({ bank: "private-bank", opts: { tags: { kind: "turn", project: "project-a", goal: "original-goal", agent: "original-role", session: "original-session" } } });
		expect(factoryConfigs.map(config => config.namespace)).toContain("private-namespace");
		expect(JSON.stringify({ factoryConfigs, retains })).not.toContain("foreign-bank");
		expect(JSON.stringify({ factoryConfigs, retains })).not.toContain("sweeper-bank");
	});
});
