// CLF-W1b: trace-row integration — proves the REAL registered thinking
// router (not a fake classifier, see `registerThinkingRouterClassifier`)
// lands a Decision in `ContextTraceStore`'s persisted `TraceEntry.decisions[]`
// when consulted through `LifecycleHub.dispatchDecision` during an active
// turn, and that the "not a registered pair" throw never fires once
// `registerThinkingRouterClassifier` has run (this is what `server.ts` does
// at gateway construction). See
// ~/Documents/dev/bobbit-fable-refactor/design/classifier-framework.md §9
// (F14 unification row) and §12 ("trace rows == decisions applied" pinning
// invariant — here: trace rows == decisions RECORDED, since W1b is
// observe-mode only).
//
// A per-turn `TraceEntry` only exists for a session once `dispatch()` has run
// at least once for it (e.g. `beforePrompt`/`sessionSetup`) — see
// `ContextTraceStore.appendDecision`'s "attaches to the LATEST entry" contract
// (CLF-W1a) and tests/lifecycle-hub-decision-trace.test.ts. Mirrors that
// file's `dispatch("sessionSetup", ...)` setup idiom to synthesize an active
// turn before consulting the REAL router.
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
	registerThinkingRouterClassifier,
	THINKING_ROUTER_CLASSIFIER_ID,
	THINKING_ROUTER_POINT,
	THINKING_ROUTER_KIND,
} from "../src/server/agent/thinking-router-classifier.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "thinking-router-trace-")));
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

describe("Thinking router — real registration + trace-row integration (CLF-W1b)", () => {
	it("dispatchDecision never throws once registerThinkingRouterClassifier has run", async () => {
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

			registerThinkingRouterClassifier(hub);

			// No `dispatch()` has run for this session — no active TraceEntry —
			// so this is exactly the "unregistered pair would throw" case CLF-W0b
			// pinned; registration must make it resolve instead.
			const decision = await hub.dispatchDecision(THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, { sessionId: "no-turn-sess", cwd: tmp }, { text: "hello" });
			assert.deepEqual(decision, { kind: "abstain" });
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a real 'ultrathink' decision persists into TraceEntry.decisions[] during an active turn", async () => {
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

			registerThinkingRouterClassifier(hub);

			// Synthesize an active turn (a real dispatch() call, same as
			// production's beforePrompt/sessionSetup hooks would do) so a
			// TraceEntry exists to attach into.
			await hub.dispatch("sessionSetup", base(tmp, "turn-sess"));

			const decision = await hub.dispatchDecision(
				THINKING_ROUTER_POINT,
				THINKING_ROUTER_KIND,
				{ sessionId: "turn-sess", cwd: tmp },
				{ text: "ultrathink: redesign the auth flow" },
			);
			assert.deepEqual(decision, { kind: "select", choice: "xhigh", confidence: 1, rationale: "matched deterministic rule 'ultrathink'" });

			const rows = trace.readTrace("turn-sess");
			assert.equal(rows.length, 1, "decision attaches to the existing entry, no new trace line");
			assert.equal(rows[0].decisions?.length, 1);
			const recorded = rows[0].decisions?.[0];
			assert.equal(recorded?.point, "user-prompt-submit");
			assert.equal(recorded?.decisionKind, "thinking");
			assert.deepEqual(recorded?.consulted, [THINKING_ROUTER_CLASSIFIER_ID]);
			assert.equal(recorded?.decision.kind, "select");
			assert.equal((recorded?.decision as { choice: string }).choice, "xhigh");

			// The in-memory fallback ring stays empty — the outcome was durably
			// attached, not left in the fallback (CLF-W1a invariant).
			assert.deepEqual(hub.getDecisionTrace(), []);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("an ordinary prompt during an active turn abstains and still lands the abstain outcome in the trace", async () => {
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
			registerThinkingRouterClassifier(hub);
			await hub.dispatch("sessionSetup", base(tmp, "quiet-sess"));

			const decision = await hub.dispatchDecision(
				THINKING_ROUTER_POINT,
				THINKING_ROUTER_KIND,
				{ sessionId: "quiet-sess", cwd: tmp },
				{ text: "fix this typo in the README" },
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
