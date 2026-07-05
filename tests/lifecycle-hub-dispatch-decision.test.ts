// CLF-W0b (EXT-05 core): pinning tests for `LifecycleHub.dispatchDecision` —
// the select-only decision seam. These pin the three invariants the wave
// exists to prove:
//
//   1. Zero classifiers registered anywhere ⇒ dispatchDecision is never
//      called by production code (no call sites exist yet), so behaviour is
//      byte-identical to today. We additionally pin that even a DIRECT call
//      with zero classifiers registered for an allow-listed pair abstains
//      safely (no throw, no side effect beyond the internal trace).
//   2. The allow-list rejects any (point, kind) pair that was never
//      registered — a caller typo can never silently go dark.
//   3. A registered ("fake") classifier's `select` is returned, traced, and
//      distinguishable from abstain.
//
// See the Fable program's classifier-framework design note
// §10 (Wave 0) and §12 (pinning-test invariants) for the design this
// implements a deliberately narrow slice of.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ContextTraceStore } from "../src/server/agent/context-trace-store.ts";
import { LifecycleHub, type DecisionClassifier, type DecisionDispatchCtx } from "../src/server/agent/lifecycle-hub.ts";
import type { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import type { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";

// dispatchDecision never touches `registry`/`moduleHost` — it has its own,
// independent in-hub classifier registry (see lifecycle-hub.ts's "Wave 0(b)
// decision seam" section) — so these can be inert stubs, matching the
// `registry()` stub idiom in tests/lifecycle-hub.test.ts.
function emptyRegistry(): PackContributionRegistry {
	return { listProviders: () => [] } as unknown as PackContributionRegistry;
}

function stubModuleHost(): ModuleHost {
	return {} as unknown as ModuleHost;
}

function hub(): LifecycleHub {
	return new LifecycleHub({
		registry: emptyRegistry(),
		moduleHost: stubModuleHost(),
		trace: new ContextTraceStore(path.join(process.cwd(), ".tmp-does-not-exist-and-is-never-written-by-these-tests")),
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
	});
}

const ctx: DecisionDispatchCtx = { sessionId: "sess-1", projectId: "project-1", cwd: "/tmp" };

describe("LifecycleHub.dispatchDecision (CLF-W0b, select-only)", () => {
	it("rejects an unregistered (point, kind) pair — the allow-list rejection", async () => {
		const h = hub();
		await assert.rejects(
			() => h.dispatchDecision("user-prompt-submit", "thinking", ctx),
			/not a registered decision point\/kind pair/,
		);
	});

	it("abstains when a pair is allow-listed but zero classifiers are registered (byte-identical case)", async () => {
		const h = hub();
		h.allowDecisionPoint("agent-prompt", "context");
		const decision = await h.dispatchDecision("agent-prompt", "context", ctx);
		assert.deepEqual(decision, { kind: "abstain" });

		const trace = h.getDecisionTrace();
		assert.equal(trace.length, 1);
		assert.equal(trace[0].point, "agent-prompt");
		assert.equal(trace[0].decisionKind, "context");
		assert.deepEqual(trace[0].consulted, []);
		assert.deepEqual(trace[0].decision, { kind: "abstain" });
	});

	it("returns a registered fake classifier's select decision", async () => {
		const h = hub();
		const fake: DecisionClassifier<string> = {
			id: "fake-classifier",
			evaluate: () => ({ kind: "select", choice: "xhigh", confidence: 0.9, rationale: "test" }),
		};
		h.registerDecisionClassifier("user-prompt-submit", "thinking", fake);

		const decision = await h.dispatchDecision<string>("user-prompt-submit", "thinking", ctx, { prompt: "ultrathink please" });
		assert.deepEqual(decision, { kind: "select", choice: "xhigh", confidence: 0.9, rationale: "test" });

		const trace = h.getDecisionTrace();
		assert.equal(trace.length, 1);
		assert.deepEqual(trace[0].consulted, ["fake-classifier"]);
		assert.equal(trace[0].decision.kind, "select");
	});

	it("polls past an abstaining classifier to a later selecting one", async () => {
		const h = hub();
		const abstainer: DecisionClassifier = { id: "abstainer", evaluate: () => ({ kind: "abstain" }) };
		const selector: DecisionClassifier<string> = { id: "selector", evaluate: () => ({ kind: "select", choice: "medium" }) };
		h.registerDecisionClassifier("user-prompt-submit", "thinking", abstainer);
		h.registerDecisionClassifier("user-prompt-submit", "thinking", selector);

		const decision = await h.dispatchDecision<string>("user-prompt-submit", "thinking", ctx);
		assert.deepEqual(decision, { kind: "select", choice: "medium" });
		assert.deepEqual(h.getDecisionTrace()[0].consulted, ["abstainer", "selector"]);
	});

	it("treats a thrown classifier as a non-fatal abstain and keeps polling", async () => {
		const h = hub();
		const thrower: DecisionClassifier = {
			id: "thrower",
			evaluate: () => {
				throw new Error("boom");
			},
		};
		const selector: DecisionClassifier<string> = { id: "selector", evaluate: () => ({ kind: "select", choice: "low" }) };
		h.registerDecisionClassifier("user-prompt-submit", "thinking", thrower);
		h.registerDecisionClassifier("user-prompt-submit", "thinking", selector);

		const decision = await h.dispatchDecision<string>("user-prompt-submit", "thinking", ctx);
		assert.deepEqual(decision, { kind: "select", choice: "low" });
	});

	it("treats a malformed classifier return as abstain rather than throwing", async () => {
		const h = hub();
		const malformed = { id: "malformed", evaluate: () => ({ notADecision: true }) } as unknown as DecisionClassifier;
		h.registerDecisionClassifier("user-prompt-submit", "thinking", malformed);

		const decision = await h.dispatchDecision("user-prompt-submit", "thinking", ctx);
		assert.deepEqual(decision, { kind: "abstain" });
	});

	it("unregister() removes a classifier from future consultation", async () => {
		const h = hub();
		const fake: DecisionClassifier<string> = { id: "fake", evaluate: () => ({ kind: "select", choice: "xhigh" }) };
		const unregister = h.registerDecisionClassifier("user-prompt-submit", "thinking", fake);

		unregister();

		// The pair stays allow-listed (registration allow-lists permanently in
		// Wave 0(b) — there is no unregister-the-allow-list-entry operation),
		// but with the classifier gone, dispatch abstains.
		const decision = await h.dispatchDecision("user-prompt-submit", "thinking", ctx);
		assert.deepEqual(decision, { kind: "abstain" });
	});
});
