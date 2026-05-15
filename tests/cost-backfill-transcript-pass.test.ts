/**
 * Tests for the transcript-pass cost goalId backfill (second pass after the
 * live-session/sidecar pass). Wrong attribution is worse than leaving an
 * entry unattributable, so these tests pin the confidence gates.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-backfill-transcript-"));
process.env.BOBBIT_DIR = tmpDir;
const stateDir = path.join(tmpDir, "state");
const COSTS_FILE = path.join(stateDir, "session-costs.json");
const AGENT_SESSIONS_ROOT = path.join(stateDir, "agent-sessions");
fs.mkdirSync(AGENT_SESSIONS_ROOT, { recursive: true });

const { CostTracker } = await import("../src/server/agent/cost-tracker.ts");
const {
	backfillLegacyCostGoalIdsFromTranscripts,
	extractTranscriptGoalId,
} = await import("../src/server/agent/cost-backfill.ts");

const GOAL_A = "deadbeef-1111-2222-3333-444455556666";
const GOAL_B = "cafebabe-aaaa-bbbb-cccc-ddddeeeeffff";
const GOAL_UNKNOWN = "00000000-9999-9999-9999-000000000000";

function seedCosts(entries: Record<string, { totalCost?: number; inputTokens?: number; outputTokens?: number; goalId?: string }>): void {
	const out: Record<string, unknown> = {};
	for (const [sid, e] of Object.entries(entries)) {
		out[sid] = {
			inputTokens: e.inputTokens ?? 0,
			outputTokens: e.outputTokens ?? 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: e.totalCost ?? 0,
			...(e.goalId ? { goalId: e.goalId } : {}),
		};
	}
	fs.writeFileSync(COSTS_FILE, JSON.stringify(out), "utf-8");
}

function seedTranscript(slug: string, sessionId: string, body: string): string {
	const slugDir = path.join(AGENT_SESSIONS_ROOT, slug);
	fs.mkdirSync(slugDir, { recursive: true });
	const p = path.join(slugDir, `${sessionId}.jsonl`);
	fs.writeFileSync(p, body, "utf-8");
	return p;
}

function silentLogger() {
	return { log: () => {}, warn: () => {} };
}

function reset(): void {
	try { fs.unlinkSync(COSTS_FILE); } catch { /* ok */ }
	try { fs.rmSync(AGENT_SESSIONS_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
	fs.mkdirSync(AGENT_SESSIONS_ROOT, { recursive: true });
}

beforeEach(reset);
after(() => {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("extractTranscriptGoalId — pure confidence rules", () => {
	it("returns undefined when no known UUID appears", () => {
		assert.equal(extractTranscriptGoalId("hello world no uuid here", new Set([GOAL_A])), undefined);
	});

	it("returns undefined when UUID exists but is not in knownGoalIds", () => {
		assert.equal(extractTranscriptGoalId(`BOBBIT_GOAL_ID=${GOAL_UNKNOWN}`, new Set([GOAL_A])), undefined);
	});

	it("returns undefined when multiple distinct known UUIDs appear", () => {
		const text = `BOBBIT_GOAL_ID=${GOAL_A} also see ${GOAL_B}`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A, GOAL_B])), undefined);
	});

	it("returns the single known UUID near BOBBIT_GOAL_ID", () => {
		assert.equal(extractTranscriptGoalId(`env: BOBBIT_GOAL_ID=${GOAL_A}`, new Set([GOAL_A])), GOAL_A);
	});

	it("returns the single known UUID in --goal CLI arg", () => {
		assert.equal(extractTranscriptGoalId(`agent --goal ${GOAL_A} --foo`, new Set([GOAL_A])), GOAL_A);
	});

	it("returns the single known UUID when worktree goal-<slug>-<id8> matches", () => {
		const text = `Working Directory: /repos/proj-wt/goal-my-feature-${GOAL_A.slice(0, 8)}/src ${GOAL_A}`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), GOAL_A);
	});

	it("returns the single known UUID near goal-context markers", () => {
		const text = `# Goal\n\n**Title** ...\nGoal id: ${GOAL_A}\n\n## Spec`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), GOAL_A);
	});

	it("returns undefined for prose-only references", () => {
		const text = `some chatter ... see goal ${GOAL_A} for background ... more chatter ...`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), undefined);
	});
});

describe("backfillLegacyCostGoalIdsFromTranscripts", () => {
	it("high-confidence Working Directory + system prompt hit stamps matching real goal", async () => {
		seedCosts({ s1: { totalCost: 0.001, inputTokens: 100, outputTokens: 50 } });
		const body = [
			JSON.stringify({ type: "system", subtype: "init", cwd: `/wt/goal-slug-${GOAL_A.slice(0, 8)}` }),
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [{ type: "text", text: `Working Directory: /wt/goal-slug-${GOAL_A.slice(0, 8)}\nBOBBIT_GOAL_ID=${GOAL_A}\n# Goal\nspec: ...` }],
				},
			}),
		].join("\n") + "\n";
		seedTranscript("slug-a", "s1", body);

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }, { id: GOAL_B }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 1);
		assert.equal(res.unattributable, 0);
		assert.equal(tracker.getSessionCost("s1")?.goalId, GOAL_A);
	});

	it("two distinct real goal ids in same transcript stays unmapped", async () => {
		seedCosts({ s_amb: { totalCost: 0.002 } });
		seedTranscript("slug-amb", "s_amb", [
			JSON.stringify({ type: "system", cwd: `/wt/goal-x-${GOAL_A.slice(0, 8)}` }),
			JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: `# Goal\nBOBBIT_GOAL_ID=${GOAL_A}\nSibling reference: ${GOAL_B}` }] } }),
		].join("\n") + "\n");

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }, { id: GOAL_B }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("s_amb")?.goalId, undefined);
	});

	it("UUID hit that is not in knownGoalIds stays unmapped", async () => {
		seedCosts({ s_unk: { totalCost: 0.003 } });
		seedTranscript("slug-unk", "s_unk", JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: `Working Directory: /wt/goal-foo-${GOAL_UNKNOWN.slice(0, 8)}\nBOBBIT_GOAL_ID=${GOAL_UNKNOWN}` }] },
		}) + "\n");

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }, { id: GOAL_B }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("s_unk")?.goalId, undefined);
	});

	it("truncated mid-line jsonl survives without crashing", async () => {
		seedCosts({ s_trunc: { totalCost: 0.004 } });
		const truncated =
			JSON.stringify({ type: "system", cwd: `/wt/goal-trunc-${GOAL_A.slice(0, 8)}` }) +
			"\n" +
			`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"BOBBIT_GOAL_ID=${GOAL_A} half-`;
		seedTranscript("slug-trunc", "s_trunc", truncated);

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 1);
		assert.equal(res.unattributable, 0);
		assert.equal(tracker.getSessionCost("s_trunc")?.goalId, GOAL_A);
	});

	it("missing jsonl for sessionId leaves entry unmapped without crash", async () => {
		seedCosts({ s_missing: { totalCost: 0.005 } });
		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("s_missing")?.goalId, undefined);
	});

	it("already-stamped entries are not revisited by transcript pass", async () => {
		seedCosts({
			s_done: { totalCost: 0.010, goalId: "goal-prior" },
			s_todo: { totalCost: 0.001 },
		});
		const body = JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "text", text: `Working Directory: /wt/goal-z-${GOAL_A.slice(0, 8)}\nBOBBIT_GOAL_ID=${GOAL_A}` }] },
		}) + "\n";
		seedTranscript("slug-z", "s_todo", body);
		seedTranscript("slug-z", "s_done", body);

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 1);
		assert.equal(tracker.getSessionCost("s_done")?.goalId, "goal-prior");
		assert.equal(tracker.getSessionCost("s_todo")?.goalId, GOAL_A);
	});

	it("empty unmapped set is a no-op", async () => {
		seedCosts({ s_done: { totalCost: 0.001, goalId: "goal-x" } });
		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 0);
	});

	it("knownGoalIds empty leaves entries unattributable", async () => {
		seedCosts({ s_empty: { totalCost: 0.001 } });
		seedTranscript("slug-empty", "s_empty", `BOBBIT_GOAL_ID=${GOAL_A}`);
		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("s_empty")?.goalId, undefined);
	});
});
