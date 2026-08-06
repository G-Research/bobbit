import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import { ContextTraceStore } from "../../src/server/agent/context-trace-store.js";
import { DecisionHookDispatcher, DecisionRequestManager } from "../../src/server/agent/decision-request-manager.js";
import { DecisionRequestStore } from "../../src/server/agent/decision-request-store.js";
import { LifecycleHub } from "../../src/server/agent/lifecycle-hub.js";
import type { ValidatedExtensionDecisionRequest } from "../../src/server/agent/decision-hook-contract.js";
import type { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.js";
import type { ModuleHost } from "../../src/server/extension-host/module-host-worker.js";
import { createMemFs } from "../harness/mem-fs.js";

function request(key = "choice"): ValidatedExtensionDecisionRequest {
	return {
		version: 1, key, title: "Choose", question: "Choose one",
		options: [{ value: "safe", label: "Safe" }, { value: "fast", label: "Fast" }],
		other: { maxLength: 20 }, default: { kind: "option", value: "safe" },
		scope: "session", deadlineAt: new Date(Date.now() + 60_000).toISOString(), effect: { kind: "none" },
	};
}

function origin(overrides: Record<string, unknown> = {}) {
	return { projectId: "project", sessionId: "session", goalId: "goal", cwd: "/work", event: "beforePrompt" as const, packId: "pack", hookId: "hook", ...overrides };
}

describe("extension decision gateway seams", () => {
	it("isolates malformed answers and session-owned records without a prompt transport", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-integration-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const invalidations: string[] = [];
		const manager = new DecisionRequestManager({ storeForProject: () => store, invalidateSession: id => invalidations.push(id) });
		const created = await manager.create(origin(), request());
		assert.equal(created.status, "created");
		assert.equal(manager.get("project", created.requestId!)?.sessionId, "session");
		assert.equal((await manager.answer("project", created.requestId!, { kind: "option", value: "nope" })).status, "invalid");
		assert.equal(store.get(created.requestId!)?.status, "pending");
		assert.equal((await manager.answer("project", created.requestId!, { kind: "option", value: "fast" })).status, "resolved");
		assert.deepEqual(invalidations, ["session", "session"]);
	});

	it("requires a fresh decide grant before both dispatch and continuation", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-grant-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const manager = new DecisionRequestManager({ storeForProject: () => store });
		let granted = false;
		const hook = {
			id: "hook", mode: "decide", events: ["beforePrompt"], packRoot: "/packs/pack",
			sourceFile: "/packs/pack/hooks.yaml", module: "hook.mjs", capabilities: [], budget: { timeoutMs: 100, maxTokens: 1 },
		};
		const dispatcher = new DecisionHookDispatcher({
			manager,
			registry: { listHooks: () => [hook] } as unknown as PackContributionRegistry,
			moduleHost: { invoke: async () => ({ kind: "request", request: request() }) } as unknown as ModuleHost,
			grantsForProject: () => granted ? [{ packId: "pack", hookId: "hook", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" }] : [],
		});
		assert.equal((await dispatcher.dispatch("beforePrompt", origin())).at(0)?.outcome, "denied");
		granted = true;
		await dispatcher.dispatch("beforePrompt", origin());
		const pending = store.listPending()[0]!;
		granted = false;
		assert.equal((await dispatcher.deliver({ ...pending, status: "resolved", resolution: { value: { kind: "option", value: "safe" }, actor: "user", reason: "answered" } })).toString(), "skipped");
	});

	it("persists detached grant-denied and budget-exhausted dispatch outcomes without delaying provider output", async () => {
		const fs = createMemFs();
		const dir = path.join("/memfs", `decision-lifecycle-trace-${Date.now()}`);
		fs.mkdirSync(dir, { recursive: true });
		const store = new DecisionRequestStore(dir, fs);
		const trace = new ContextTraceStore(dir, fs);
		const manager = new DecisionRequestManager({ storeForProject: () => store });
		let granted = false;
		let releaseDecision: (() => void) | undefined;
		let delayDecision = false;
		const waitForDecision = new Promise<void>(resolve => { releaseDecision = resolve; });
		const hook = {
			id: "decision-hook", mode: "decide", events: ["beforePrompt"], packRoot: "/packs/decision-pack",
			sourceFile: "/packs/decision-pack/hooks.yaml", module: "decision.mjs", capabilities: [], budget: { timeoutMs: 100, maxTokens: 1 },
		};
		const provider = {
			id: "provider-output", kind: "memory", module: "provider.mjs", hooks: ["beforePrompt"],
			budget: { timeoutMs: 100, maxTokens: 100 }, config: {}, listName: "provider-output",
			sourceFile: "/packs/provider-pack/pack.yaml", packRoot: "/packs/provider-pack",
		};
		const registry = {
			listHooks: () => [hook],
			listProviders: () => [provider],
		} as unknown as PackContributionRegistry;
		const moduleHost = {
			invoke: async (input: { exportKind: string }) => {
				if (input.exportKind === "providers") return { blocks: [{ id: "provider-output", title: "Provider", authority: "memory", content: "provider output", reason: "test", priority: 1 }] };
				if (delayDecision) await waitForDecision;
				return { kind: "request", request: { ...request("trace-choice"), question: "DECISION_TRACE_SECRET" } };
			},
		} as unknown as ModuleHost;
		const dispatcher = new DecisionHookDispatcher({
			manager, registry, moduleHost,
			grantsForProject: () => granted ? [{ packId: "decision-pack", hookId: "decision-hook", capability: "decide", grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" }] : [],
		});
		const lifecycleHub = new LifecycleHub({
			registry, moduleHost, trace,
			gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
		});
		lifecycleHub.setDecisionDispatcher(dispatcher);

		const lifecycleContext = (sessionId: string) => ({ sessionId, projectId: "project", goalId: "goal", cwd: "/work", scope: "project" as const });
		const waitForOutcome = async (sessionId: string, outcome: "denied" | "dropped", reason: "Grant required" | "Budget exhausted") => {
			for (let attempt = 0; attempt < 20; attempt++) {
				const rows = trace.readTrace(sessionId);
				if (rows.some(row => row.outcomes?.some(entry => entry.outcome === outcome && entry.reason === reason))) return rows;
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			assert.fail(`missing ${outcome} (${reason}) trace outcome for ${sessionId}`);
		};
		const denied = await lifecycleHub.dispatch("beforePrompt", lifecycleContext("grant-denied"));
		assert.deepEqual(denied.blocks.map(block => block.id), ["provider-output"], "provider output is delivered while the detached decision branch is denied");
		const deniedRows = await waitForOutcome("grant-denied", "denied", "Grant required");

		granted = true;
		await manager.create(origin({ sessionId: "budget-exhausted", hookId: "seed-a" }), request("seed-a"));
		await manager.create(origin({ sessionId: "budget-exhausted", hookId: "seed-b" }), request("seed-b"));
		delayDecision = true;
		const budgeted = await lifecycleHub.dispatch("beforePrompt", lifecycleContext("budget-exhausted"));
		assert.deepEqual(budgeted.blocks.map(block => block.id), ["provider-output"], "a pending decision hook cannot delay provider delivery");
		releaseDecision!();
		const budgetRows = await waitForOutcome("budget-exhausted", "dropped", "Budget exhausted");
		assert.ok(!JSON.stringify([...deniedRows, ...budgetRows]).includes("DECISION_TRACE_SECRET"), "decision prose never reaches the trace");
	});
});
