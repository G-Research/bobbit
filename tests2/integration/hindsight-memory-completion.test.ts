import { afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enableTsWorkerResolver } from "../core/helpers/enable-ts-worker.js";
import { ContextTraceStore } from "../../src/server/agent/context-trace-store.ts";
import { LifecycleHub, goalCompletedDeliveryKey, type HookCtx, type HookScopeContext } from "../../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../../src/server/agent/pack-contributions.ts";
import { ModuleHost } from "../../src/server/extension-host/module-host-worker.ts";
import { createPackStore, type PackStore } from "../../src/server/extension-host/pack-store.ts";
import { createServerHostApi, type ServerHostApi } from "../../src/server/extension-host/server-host-api.ts";
import { lifecycleDeliveryMarkerKey } from "../../src/server/extension-host/lifecycle-delivery.ts";
import hindsightProviderSource from "../../market-packs/hindsight/src/provider.ts";
import { pendingKey, pendingPrefix, queueKey, type HindsightIdentity, type PendingEnvelope } from "../../market-packs/hindsight/src/shared.ts";
import { startHindsightStub } from "../../tests/e2e/hindsight-stub.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACK_ROOT = path.resolve(__dirname, "..", "..", "market-packs", "hindsight");
const BANK = "completion-integration";
const NAMESPACE = "worker-scope";

interface StubCall { method: string; path: string; bank?: string; namespace?: string; body?: { tags?: string[]; items?: Array<{ tags?: string[] }> } }
interface HindsightStub {
	url: string;
	calls: StubCall[];
	setHealthy(ok: boolean): void;
	seedMemories(bank: string, memories: Array<{ text: string; id?: string; tags?: string[] }>): void;
	retained(bank?: string): Array<{ content: string; tags: string[]; async: boolean }>;
	close(): Promise<void>;
}

beforeAll(() => { enableTsWorkerResolver(); });

function tempDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-memory-completion-")));
}

async function startStub(): Promise<HindsightStub> {
	// Keep a static source edge to the provider while the worker loads its built
	// pack module, so impacted-test selection covers both implementation forms.
	void hindsightProviderSource;
	return startHindsightStub({ port: 0 }) as Promise<HindsightStub>;
}

function scope(projectId: string, goalId?: string): HookScopeContext {
	return Object.freeze({
		project: Object.freeze({ id: projectId }),
		...(goalId ? { goal: Object.freeze({ id: goalId }) } : {}),
	});
}

function provider(stub: HindsightStub): ProviderContribution {
	return {
		id: "memory",
		kind: "memory",
		module: "../lib/provider.mjs",
		hooks: ["sessionSetup", "beforePrompt", "goalCompleted"],
		budget: { maxTokens: 1200, timeoutMs: 20_000 },
		config: {
			runtimeMode: "external",
			externalUrl: stub.url,
			bank: BANK,
			namespace: NAMESPACE,
			autoRecall: true,
			autoRetain: true,
			recallBudget: 1200,
			timeoutMs: 20_000,
		},
		listName: "memory",
		sourceFile: path.join(PACK_ROOT, "providers", "memory.yaml"),
		packRoot: PACK_ROOT,
	};
}

function hostApi(store: PackStore, rejectQueueWrite = false): ServerHostApi {
	const api = createServerHostApi({
		sessionId: "goal:integration",
		packId: "hindsight",
		contributionId: "providers/memory",
		packStore: store,
		memory: { requireCapability: () => {} },
		capabilityMask: { store: true, session: false, agents: false, memory: true },
	});
	if (!rejectQueueWrite) return api;
	return {
		...api,
		store: {
			...api.store,
			mutate: async (key, value, options) => {
				if (key.startsWith("retain-queue/v3/")) throw new Error("HINDSIGHT_TEST_QUEUE_WRITE_FAILED");
				return api.store.mutate(key, value, options);
			},
		},
	};
}

function hub(root: string, stub: HindsightStub, store: PackStore, scopeContextResolver?: (input: { projectId?: string; goalId?: string }) => HookScopeContext | undefined, rejectQueueWrite = false): { hub: LifecycleHub; worker: ModuleHost } {
	const worker = new ModuleHost({ timeoutMs: 20_000 });
	return {
		worker,
		hub: new LifecycleHub({
			registry: { listProviders: () => [provider(stub)] } as never,
			moduleHost: worker,
			trace: new ContextTraceStore(path.join(root, "trace")),
			gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "test-token" }),
			providerHostApi: () => hostApi(store, rejectQueueWrite),
			...(scopeContextResolver ? { scopeContextResolver } : {}),
		}),
	};
}

function beforePrompt(projectId: string, prompt: string): Omit<HookCtx, "budget" | "config" | "gateway" | "scopeContext" | "runtime"> {
	return { sessionId: `session-${projectId}`, projectId, scope: "project", cwd: PACK_ROOT, prompt };
}

function recallCalls(stub: HindsightStub): StubCall[] {
	return stub.calls.filter(call => call.method === "POST" && call.path.endsWith("/memories/recall"));
}

function completion(projectId: string, goalId: string) {
	return {
		goalId,
		projectId,
		cwd: PACK_ROOT,
		scopeContext: scope(projectId, goalId),
		outcome: Object.freeze({
			version: 1,
			goal: Object.freeze({ id: goalId, title: "Worker-owned completion", state: "complete", spec: "Deliver nested outcome content", updatedAt: 1_700_000_000_000 }),
			tasks: [{ id: "task-bounded", title: "bounded", state: "complete", resultSummary: "worker verified" }],
			gates: [{ id: "gate-bounded", status: "passed", content: "worker gate verified" }],
		}),
		completedAt: 1_700_000_000_000,
		completionRevision: "completion-revision-1",
	};
}

function stranded(projectId: string, goalId: string, sessionId: string, bank: string, namespace: string, capturedAt: number): PendingEnvelope {
	const identity: HindsightIdentity = { projectId, goalId, sessionId, bank, namespace, kind: "pending" };
	return {
		version: 2, identity, scope: { projectId, goalId, sessionId, role: "original-role" },
		turns: [{ summary: `private ${projectId} context`, capturedAt }], overlap: [], updatedAt: capturedAt, flushSeq: 0,
	};
}

describe("Hindsight completion worker boundary", () => {
	const cleanup: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const dispose of cleanup.splice(0).reverse()) await dispose();
	});

	it("uses only host scopeContext for narrow recall and makes no remote call without it", async () => {
		const root = tempDir();
		const stub = await startStub();
		const store = createPackStore({ rootDir: path.join(root, "state") });
		const hostScopes = new Map<string, HookScopeContext>([
			["project-a", scope("project-a", "goal-a")],
			["project-b", scope("project-b", "goal-b")],
		]);
		const { hub: lifecycleHub, worker } = hub(root, stub, store, input => hostScopes.get(input.projectId ?? ""));
		cleanup.push(() => worker.dispose(), () => stub.close(), () => fs.rmSync(root, { recursive: true, force: true }));
		stub.seedMemories(BANK, [
			{ id: "a", text: "project A only", tags: ["project:project-a", "goal:goal-a"] },
			{ id: "b", text: "project B only", tags: ["project:project-b", "goal:goal-b"] },
		]);

		const a = await lifecycleHub.dispatch("beforePrompt", beforePrompt("flat-forged-project", "recall A"), { projectId: "project-a", goalId: "goal-a", cwd: PACK_ROOT });
		expect(a.blocks.map(block => block.content).join("\n")).toContain("project A only");
		expect(a.blocks.map(block => block.content).join("\n")).not.toContain("project B only");
		expect(recallCalls(stub)[0]?.body?.tags).toEqual(["goal:goal-a", "project:project-a"]);

		const b = await lifecycleHub.dispatch("beforePrompt", beforePrompt("flat-forged-project", "recall B"), { projectId: "project-b", goalId: "goal-b", cwd: PACK_ROOT });
		expect(b.blocks.map(block => block.content).join("\n")).toContain("project B only");
		expect(recallCalls(stub)[1]?.body?.tags).toEqual(["goal:goal-b", "project:project-b"]);

		const callsBeforeMissingScope = recallCalls(stub).length;
		const missing = await lifecycleHub.dispatch("beforePrompt", beforePrompt("flat-forged-project", "must not call remote"), { projectId: "missing-project", cwd: PACK_ROOT });
		expect(missing.blocks).toEqual([]);
		expect(recallCalls(stub)).toHaveLength(callsBeforeMissingScope);
	});

	it("serializes the host nested completion snapshot before task and gate content in the worker", async () => {
		const root = tempDir();
		const stub = await startStub();
		const store = createPackStore({ rootDir: path.join(root, "state") });
		const active = hub(root, stub, store);
		cleanup.push(() => active.worker.dispose(), () => stub.close(), () => fs.rmSync(root, { recursive: true, force: true }));

		expect((await active.hub.dispatchGoalCompleted(completion("project-a", "goal-a")))[0]?.result.state).toBe("completed");
		const content = stub.retained(BANK)[0]?.content ?? "";
		expect(content).toContain("Goal title: Worker-owned completion");
		expect(content).toContain("Goal state: complete");
		expect(content).toContain("Goal spec: Deliver nested outcome content");
		expect(content).toContain("Task: bounded — complete — worker verified");
		expect(content).toContain("Gate: gate-bounded — passed — worker gate verified");
		expect(content.indexOf("Goal title:")).toBeLessThan(content.indexOf("Task:"));
		expect(content.indexOf("Goal spec:")).toBeLessThan(content.indexOf("Gate:"));
		expect(content.length).toBeLessThanOrEqual(8_000);
	});

	it("writes a durable queue before fencing a failed outcome delivery and suppresses restart replay", async () => {
		const root = tempDir();
		const stub = await startStub();
		const store = createPackStore({ rootDir: path.join(root, "state") });
		const first = hub(root, stub, store);
		cleanup.push(() => first.worker.dispose(), () => stub.close(), () => fs.rmSync(root, { recursive: true, force: true }));
		stub.setHealthy(false);
		const event = completion("project-a", "goal-a");

		const concurrent = await Promise.all([
			first.hub.dispatchGoalCompleted(event),
			first.hub.dispatchGoalCompleted(event),
		]);
		expect(concurrent.map(result => result[0]?.result.state).sort()).toEqual(["completed", "duplicate"]);
		const queued = await store.read<unknown>("hindsight", queueKey("project-a"));
		expect(queued.state).toBe("present");
		const entry = (queued as { value: Array<Record<string, unknown>> }).value[0]!;
		expect(entry).toMatchObject({
			version: 2,
			bank: BANK,
			namespace: NAMESPACE,
			scope: { projectId: "project-a", goalId: "goal-a" },
			tags: { kind: "outcome", project: "project-a", goal: "goal-a" },
		});

		const remoteCallsBeforeRestart = stub.calls.length;
		first.worker.dispose();
		const restarted = hub(root, stub, store);
		cleanup.push(() => restarted.worker.dispose());
		expect((await restarted.hub.dispatchGoalCompleted(event))[0]?.result.state).toBe("duplicate");
		expect(stub.calls).toHaveLength(remoteCallsBeforeRestart);
	});

	it("does not write a completion marker when remote retain and queue persistence both fail", async () => {
		const root = tempDir();
		const stub = await startStub();
		const store = createPackStore({ rootDir: path.join(root, "state") });
		const failed = hub(root, stub, store, undefined, true);
		cleanup.push(() => failed.worker.dispose(), () => stub.close(), () => fs.rmSync(root, { recursive: true, force: true }));
		stub.setHealthy(false);
		const event = completion("project-a", "goal-a");

		expect((await failed.hub.dispatchGoalCompleted(event))[0]?.result.state).toBe("retryable");
		const marker = lifecycleDeliveryMarkerKey(goalCompletedDeliveryKey("hindsight", "memory", event.projectId, event.goalId, event.completionRevision));
		expect(await store.read("hindsight", marker)).toMatchObject({ state: "absent" });

		stub.setHealthy(true);
		failed.worker.dispose();
		const retried = hub(root, stub, store);
		cleanup.push(() => retried.worker.dispose());
		expect((await retried.hub.dispatchGoalCompleted(event))[0]?.result.state).toBe("completed");
		expect(stub.retained(BANK)).toHaveLength(1);
	});

	it("replays only project-partitioned valid stranded records through the worker", async () => {
		const root = tempDir();
		const stub = await startStub();
		const store = createPackStore({ rootDir: path.join(root, "state") });
		const now = 2_000_000;
		const original = stranded("project-a", "original-goal", "original-session", "private-bank", "private-namespace", now - 400_000);
		await store.mutate("hindsight", pendingKey(original.identity), original, { expectedVersion: null });
		const foreign = stranded("project-b", "foreign-goal", "foreign-session", "foreign-bank", "foreign-namespace", now - 400_000);
		// A forged key can pass the project-A prefix filter but cannot pass the
		// complete decoded identity check. A legacy envelope is likewise inert.
		await store.mutate("hindsight", `${pendingPrefix("project-a")}forged-foreign`, foreign, { expectedVersion: null });
		await store.mutate("hindsight", `${pendingPrefix("project-a")}legacy`, { version: 1, turns: [{ summary: "do not replay", capturedAt: 0 }] }, { expectedVersion: null });
		const { hub: lifecycleHub, worker } = hub(root, stub, store, input => input.projectId === "project-a" ? scope("project-a", "sweeper-goal") : undefined);
		cleanup.push(() => worker.dispose(), () => stub.close(), () => fs.rmSync(root, { recursive: true, force: true }));

		const sessionSetup = {
			...beforePrompt("project-a", ""),
			sessionId: "sweeper-session",
			now,
		};
		await lifecycleHub.dispatch("sessionSetup", sessionSetup, { projectId: "project-a", goalId: "sweeper-goal", cwd: PACK_ROOT });
		const retains = stub.calls.filter(call => call.method === "POST" && /\/memories$/.test(call.path));
		expect(retains, JSON.stringify(stub.calls)).toHaveLength(1);
		expect(retains[0]).toMatchObject({ bank: "private-bank", namespace: "private-namespace", body: { items: [{ tags: ["agent:original-role", "goal:original-goal", "kind:turn", "project:project-a", "session:original-session"] }] } });
		expect(JSON.stringify(retains)).not.toContain("foreign-bank");
		expect(JSON.stringify(retains)).not.toContain("completion-integration");
	});
});
