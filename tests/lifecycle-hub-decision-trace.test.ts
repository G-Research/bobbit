// CLF-W1a: pinning tests for the decisionTrace-ring → persisted
// `TraceEntry.decisions[]` migration (see the TODO(CLF-W1a) comment
// `LifecycleHub.recordDecisionOutcome` replaced, and `ContextTraceStore.appendDecision`).
//
// Design: ~/Documents/dev/bobbit-fable-refactor/design/classifier-framework.md
// Wave 1(a) — "Transparency first: TraceEntry.decisions[] + panel rows +
// browser E2E ... before any classifier."
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextTraceStore, type TraceEntry } from "../src/server/agent/context-trace-store.ts";
import { LifecycleHub, type DecisionClassifier, type DecisionDispatchCtx, type HookCtx } from "../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-hub-decision-trace-")));
}

let seq = 0;
function fixtureProvider(tmp: string, id: string, body: string): ProviderContribution {
	const file = path.join(tmp, `${id}-${seq++}.mjs`);
	fs.writeFileSync(file, body);
	return {
		id,
		kind: "memory",
		module: path.basename(file),
		hooks: ["sessionSetup"],
		budget: { maxTokens: 400, timeoutMs: 30_000 },
		config: { enabled: true },
		listName: id,
		sourceFile: path.join(tmp, "pack.yaml"),
		packRoot: tmp,
	};
}

function registry(providers: ProviderContribution[]): PackContributionRegistry {
	return { listProviders: () => providers } as unknown as PackContributionRegistry;
}

function base(tmp: string, sessionId: string): Omit<HookCtx, "budget" | "config" | "gateway"> {
	return { sessionId, projectId: "project-1", scope: "project", cwd: tmp };
}

describe("ContextTraceStore.appendDecision (CLF-W1a)", () => {
	it("attaches a decision outcome to the latest entry for the session", () => {
		const dir = tmpDir();
		try {
			const store = new ContextTraceStore(dir);
			store.appendTrace("sess-1", { ts: 1, hook: "beforePrompt", sessionId: "sess-1", providers: [] });

			const attached = store.appendDecision("sess-1", {
				ts: 2,
				point: "agent-prompt",
				decisionKind: "thinking",
				consulted: ["fake"],
				decision: { kind: "select", choice: "xhigh" },
				ms: 3,
			});

			assert.equal(attached, true);
			const rows = store.readTrace("sess-1");
			assert.equal(rows.length, 1);
			assert.equal(rows[0].decisions?.length, 1);
			assert.deepEqual(rows[0].decisions?.[0], {
				ts: 2,
				point: "agent-prompt",
				decisionKind: "thinking",
				consulted: ["fake"],
				decision: { kind: "select", choice: "xhigh" },
				ms: 3,
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accumulates multiple decisions on the same latest entry, in order", () => {
		const dir = tmpDir();
		try {
			const store = new ContextTraceStore(dir);
			store.appendTrace("sess-1", { ts: 1, hook: "beforePrompt", sessionId: "sess-1", providers: [] });
			store.appendDecision("sess-1", { ts: 2, point: "agent-prompt", decisionKind: "thinking", consulted: [], decision: { kind: "abstain" }, ms: 1 });
			store.appendDecision("sess-1", { ts: 3, point: "tool-call", decisionKind: "tool", consulted: [], decision: { kind: "abstain" }, ms: 1 });

			const rows = store.readTrace("sess-1");
			assert.equal(rows.length, 1, "decisions attach to the SAME entry, no new trace lines are created");
			assert.deepEqual(rows[0].decisions?.map((d) => d.point), ["agent-prompt", "tool-call"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns false (no attach) when no trace entry exists yet for the session", () => {
		const dir = tmpDir();
		try {
			const store = new ContextTraceStore(dir);
			const attached = store.appendDecision("never-dispatched", {
				ts: 1,
				point: "user-prompt-submit",
				decisionKind: "thinking",
				consulted: [],
				decision: { kind: "abstain" },
				ms: 0,
			});
			assert.equal(attached, false);
			assert.deepEqual(store.readTrace("never-dispatched"), []);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a later appendTrace call means subsequent decisions attach to the NEW entry, not the stale one", () => {
		const dir = tmpDir();
		try {
			const store = new ContextTraceStore(dir);
			store.appendTrace("sess-1", { ts: 1, hook: "beforePrompt", sessionId: "sess-1", providers: [] });
			store.appendDecision("sess-1", { ts: 2, point: "agent-prompt", decisionKind: "thinking", consulted: [], decision: { kind: "abstain" }, ms: 1 });
			store.appendTrace("sess-1", { ts: 3, hook: "beforePrompt", sessionId: "sess-1", providers: [] });
			store.appendDecision("sess-1", { ts: 4, point: "agent-prompt", decisionKind: "thinking", consulted: [], decision: { kind: "abstain" }, ms: 1 });

			const rows = store.readTrace("sess-1");
			assert.equal(rows.length, 2);
			assert.equal(rows[0].decisions?.length, 1, "first (now-stale) entry keeps its own decision");
			assert.equal(rows[1].decisions?.length, 1, "second (new latest) entry gets the later decision, not the first");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("backward-compat read: an old-shape TraceEntry line with no `decisions` field reads back with decisions undefined", () => {
		const dir = tmpDir();
		try {
			const store = new ContextTraceStore(dir);
			// Simulate an entry written by a pre-CLF-W1a build: no `decisions` key at all.
			const legacy: Omit<TraceEntry, "decisions"> = { ts: 1, hook: "beforePrompt", sessionId: "sess-legacy", providers: [{ id: "p1", ms: 5, blocks: 1, omitted: 0 }] };
			const traceDir = path.join(dir, "session-context-trace");
			fs.mkdirSync(traceDir, { recursive: true });
			fs.writeFileSync(path.join(traceDir, "sess-legacy.jsonl"), JSON.stringify(legacy) + "\n");

			const rows = store.readTrace("sess-legacy");
			assert.equal(rows.length, 1);
			assert.equal(rows[0].decisions, undefined);
			assert.equal(rows[0].providers.length, 1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("LifecycleHub decision-outcome recording (CLF-W1a migration)", () => {
	it("a decision fired during an active turn (a dispatch() already ran) persists into that TraceEntry, and the fallback ring stays empty", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			const provider = fixtureProvider(tmp, "p1", `export default { async sessionSetup() { return { blocks: [] }; } };`);
			const hub = new LifecycleHub({
				registry: registry([provider]),
				moduleHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
			});

			await hub.dispatch("sessionSetup", base(tmp, "turn-sess"));

			hub.allowDecisionPoint("agent-prompt", "thinking");
			const fake: DecisionClassifier<string> = { id: "fake", evaluate: () => ({ kind: "select", choice: "xhigh" }) };
			hub.registerDecisionClassifier("agent-prompt", "thinking", fake);
			const ctx: DecisionDispatchCtx = { sessionId: "turn-sess", cwd: tmp };
			await hub.dispatchDecision("agent-prompt", "thinking", ctx);

			const rows = trace.readTrace("turn-sess");
			assert.equal(rows.length, 1);
			assert.equal(rows[0].decisions?.length, 1);
			assert.equal(rows[0].decisions?.[0].decision.kind, "select");

			// The ring stays empty — the outcome was durably attached, not
			// left in the in-memory fallback.
			assert.deepEqual(hub.getDecisionTrace(), []);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a decision fired out-of-turn (no dispatch() has ever run for the session) falls back to the in-memory ring", async () => {
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

			hub.allowDecisionPoint("tool-call", "tool");
			const ctx: DecisionDispatchCtx = { sessionId: "out-of-turn-sess", cwd: tmp };
			await hub.dispatchDecision("tool-call", "tool", ctx);

			assert.deepEqual(trace.readTrace("out-of-turn-sess"), []);
			const ring = hub.getDecisionTrace();
			assert.equal(ring.length, 1);
			assert.equal(ring[0].point, "tool-call");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("a turn with zero decisions never gains a `decisions` field on its TraceEntry (byte-identical trace shape)", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const trace = new ContextTraceStore(path.join(tmp, "state"));
			const provider = fixtureProvider(tmp, "p1", `export default { async sessionSetup() { return { blocks: [] }; } };`);
			const hub = new LifecycleHub({
				registry: registry([provider]),
				moduleHost,
				trace,
				gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
			});

			await hub.dispatch("sessionSetup", base(tmp, "quiet-sess"));

			const rows = trace.readTrace("quiet-sess");
			assert.equal(rows.length, 1);
			assert.equal(rows[0].decisions, undefined);
			assert.deepEqual(Object.keys(rows[0]).sort(), ["hook", "providers", "sessionId", "ts"]);
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
