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
import { QUEUE_KEY } from "../../market-packs/hindsight/src/shared.ts";
import { startHindsightStub } from "../../tests/e2e/hindsight-stub.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACK_ROOT = path.resolve(__dirname, "..", "..", "market-packs", "hindsight");
const BANK = "completion-integration";
const NAMESPACE = "worker-scope";

interface StubCall { method: string; path: string; body?: { tags?: string[]; items?: Array<{ tags?: string[] }> } }
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
		hooks: ["beforePrompt", "goalCompleted"],
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
		capabilityMask: { store: true, session: false, agents: false },
	});
	if (!rejectQueueWrite) return api;
	return {
		...api,
		store: {
			...api.store,
			mutate: async (key, value, options) => {
				if (key === QUEUE_KEY) throw new Error("HINDSIGHT_TEST_QUEUE_WRITE_FAILED");
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
		outcome: Object.freeze({ goal: Object.freeze({ title: "Worker-owned completion" }), tasks: [{ title: "bounded" }] }),
		completedAt: 1_700_000_000_000,
		completionRevision: "completion-revision-1",
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
		const queued = await store.read<unknown>("hindsight", QUEUE_KEY);
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
});
