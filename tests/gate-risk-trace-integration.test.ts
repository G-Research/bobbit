// CLF-W5: trace-row integration — proves the REAL registered gate-risk
// classifier (not a fake fixture) lands a Decision in `ContextTraceStore`'s
// persisted `TraceEntry.decisions[]` when consulted through
// `LifecycleHub.dispatchDecision`, mirroring
// `tests/model-tier-trace-integration.test.ts`'s own shape for CLF-W4. See
// `src/server/agent/gate-risk-classifier.ts`'s header for the full
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
	registerGateRiskClassifier,
	GATE_RISK_CLASSIFIER_ID,
	GATE_RISK_POINT,
	GATE_RISK_KIND,
} from "../src/server/agent/gate-risk-classifier.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gate-risk-trace-")));
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

describe("Gate-risk classifier — real registration + trace-row integration (CLF-W5)", () => {
	it("dispatchDecision never throws once registerGateRiskClassifier has run", async () => {
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

			registerGateRiskClassifier(hub);

			const decision = await hub.dispatchDecision(GATE_RISK_POINT, GATE_RISK_KIND, { sessionId: "no-turn-sess", cwd: tmp }, { changedFiles: ["src/server/server.ts"] });
			assert.deepEqual(decision, {
				kind: "select",
				choice: "high",
				confidence: 1,
				rationale: `matched deterministic rule 'high-risk-surface': changed file "src/server/server.ts" is on the explicit high-risk surface list`,
			});
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a real high-risk decision persists into TraceEntry.decisions[] during an active turn", async () => {
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

			registerGateRiskClassifier(hub);

			// Synthesize an active turn (a real dispatch() call, mirroring what
			// the raising session's own earlier turn would have produced) so a
			// TraceEntry exists to attach into.
			await hub.dispatch("sessionSetup", base(tmp, "turn-sess"));

			const decision = await hub.dispatchDecision(
				GATE_RISK_POINT,
				GATE_RISK_KIND,
				{ sessionId: "turn-sess", cwd: tmp },
				{ changedFiles: ["src/server/agent/session-manager.ts"] },
			);
			assert.equal(decision.kind, "select");
			assert.equal((decision as { choice: string }).choice, "high");

			const rows = trace.readTrace("turn-sess");
			assert.equal(rows.length, 1, "decision attaches to the existing entry, no new trace line");
			assert.equal(rows[0].decisions?.length, 1);
			const recorded = rows[0].decisions?.[0];
			assert.equal(recorded?.point, "gate-verify");
			assert.equal(recorded?.decisionKind, "risk");
			assert.deepEqual(recorded?.consulted, [GATE_RISK_CLASSIFIER_ID]);
			assert.equal(recorded?.decision.kind, "select");
			assert.equal((recorded?.decision as { choice: string }).choice, "high");
			assert.deepEqual(recorded?.argSummary, { changedFileCount: 1 });
			// Pure telemetry this wave — never applied, never even attempted.
			assert.equal(recorded?.applied, undefined);

			assert.deepEqual(hub.getDecisionTrace(), []);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a low-risk changeset selects and still lands the select outcome in the trace", async () => {
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
			registerGateRiskClassifier(hub);
			await hub.dispatch("sessionSetup", base(tmp, "quiet-sess"));

			const decision = await hub.dispatchDecision(
				GATE_RISK_POINT,
				GATE_RISK_KIND,
				{ sessionId: "quiet-sess", cwd: tmp },
				{ changedFiles: ["docs/readme.md"] },
			);
			assert.equal(decision.kind, "select");
			assert.equal((decision as { choice: string }).choice, "low");

			const rows = trace.readTrace("quiet-sess");
			assert.equal(rows[0].decisions?.length, 1);
			assert.equal(rows[0].decisions?.[0].decision.kind, "select");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("an unavailable signal (no changedFiles) abstains and still lands the abstain outcome in the trace", async () => {
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
			registerGateRiskClassifier(hub);
			await hub.dispatch("sessionSetup", base(tmp, "abstain-sess"));

			const decision = await hub.dispatchDecision(
				GATE_RISK_POINT,
				GATE_RISK_KIND,
				{ sessionId: "abstain-sess", cwd: tmp },
				{},
			);
			assert.deepEqual(decision, { kind: "abstain" });

			const rows = trace.readTrace("abstain-sess");
			assert.equal(rows[0].decisions?.length, 1);
			assert.equal(rows[0].decisions?.[0].decision.kind, "abstain");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
