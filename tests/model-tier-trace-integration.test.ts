// CLF-W4: trace-row integration — proves the REAL registered model-tier
// classifier (not a fake fixture) lands a Decision in `ContextTraceStore`'s
// persisted `TraceEntry.decisions[]` when consulted through
// `LifecycleHub.dispatchDecision` during an active turn, mirroring
// `thinking-router-trace-integration.test.ts`'s own shape for CLF-W1b. See
// `src/server/agent/model-tier-classifier.ts`'s header for the full
// design/scope — this classifier is OBSERVE-ONLY with no apply path at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextTraceStore } from "../src/server/agent/context-trace-store.ts";
import { LifecycleHub, type HookCtx } from "../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";
import {
	registerModelTierClassifier,
	MODEL_TIER_CLASSIFIER_ID,
	MODEL_TIER_POINT,
	MODEL_TIER_KIND,
} from "../src/server/agent/model-tier-classifier.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "model-tier-trace-")));
}

function registry(providers: ProviderContribution[]): PackContributionRegistry {
	return { listProviders: () => providers } as unknown as PackContributionRegistry;
}

let seq = 0;
function fixtureProvider(tmp: string): ProviderContribution {
	const file = path.join(tmp, `p-${seq++}.mjs`);
	fs.writeFileSync(file, `export default { async sessionSetup() { return { blocks: [] }; } };`);
	return {
		id: "p1",
		kind: "memory",
		module: path.basename(file),
		hooks: ["sessionSetup"],
		budget: { maxTokens: 400, timeoutMs: 30_000 },
		config: { enabled: true },
		listName: "p1",
		sourceFile: path.join(tmp, "pack.yaml"),
		packRoot: tmp,
	};
}

function base(tmp: string, sessionId: string): Omit<HookCtx, "budget" | "config" | "gateway"> {
	return { sessionId, projectId: "project-1", scope: "project", cwd: tmp };
}

describe("Model-tier classifier — real registration + trace-row integration (CLF-W4)", () => {
	it("dispatchDecision never throws once registerModelTierClassifier has run", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			const hub = new LifecycleHub({
				registry: registry([]),
				moduleHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
			});

			registerModelTierClassifier(hub);

			const decision = await hub.dispatchDecision(MODEL_TIER_POINT, MODEL_TIER_KIND, { sessionId: "no-turn-sess", cwd: tmp }, { roleName: "docs-writer" });
			assert.deepEqual(decision, { kind: "select", choice: "cheap", confidence: 1, rationale: "matched deterministic rule 'cheap-tier-role': role \"docs-writer\" is in docs/internals.md's VER-02 Cheap tier" });
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a real frontier-tier role decision persists into TraceEntry.decisions[] during an active turn", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			const provider = fixtureProvider(tmp);
			const hub = new LifecycleHub({
				registry: registry([provider]),
				moduleHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
			});

			registerModelTierClassifier(hub);

			// Synthesize an active turn (a real dispatch() call, mirroring what
			// session-setup.ts's resolveDynamicContext does immediately before its
			// own model-tier consult) so a TraceEntry exists to attach into.
			await hub.dispatch("sessionSetup", base(tmp, "turn-sess"));

			const decision = await hub.dispatchDecision(
				MODEL_TIER_POINT,
				MODEL_TIER_KIND,
				{ sessionId: "turn-sess", cwd: tmp },
				{ roleName: "architect" },
			);
			assert.equal(decision.kind, "select");
			assert.equal((decision as { choice: string }).choice, "frontier");

			const rows = trace.readTrace("turn-sess");
			assert.equal(rows.length, 1, "decision attaches to the existing entry, no new trace line");
			assert.equal(rows[0].decisions?.length, 1);
			const recorded = rows[0].decisions?.[0];
			assert.equal(recorded?.point, "session-spawn");
			assert.equal(recorded?.decisionKind, "model-tier");
			assert.deepEqual(recorded?.consulted, [MODEL_TIER_CLASSIFIER_ID]);
			assert.equal(recorded?.decision.kind, "select");
			assert.equal((recorded?.decision as { choice: string }).choice, "frontier");
			assert.deepEqual(recorded?.argSummary, { roleName: "architect" });
			// Pure telemetry this wave — never applied, never even attempted.
			assert.equal(recorded?.applied, undefined);

			assert.deepEqual(hub.getDecisionTrace(), []);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("an untiered role abstains and still lands the abstain outcome in the trace", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			const provider = fixtureProvider(tmp);
			const hub = new LifecycleHub({
				registry: registry([provider]),
				moduleHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
			});
			registerModelTierClassifier(hub);
			await hub.dispatch("sessionSetup", base(tmp, "quiet-sess"));

			const decision = await hub.dispatchDecision(
				MODEL_TIER_POINT,
				MODEL_TIER_KIND,
				{ sessionId: "quiet-sess", cwd: tmp },
				{ roleName: "assistant" },
			);
			assert.deepEqual(decision, { kind: "abstain" });

			const rows = trace.readTrace("quiet-sess");
			assert.equal(rows[0].decisions?.length, 1);
			assert.equal(rows[0].decisions?.[0].decision.kind, "abstain");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
