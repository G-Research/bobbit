/**
 * Tests for the transcript-pass cost goalId backfill (second pass that
 * runs after the sidecar pass for entries with no live session and no
 * sidecar on disk).
 *
 * Covers:
 *   1. High-confidence transcript hit (working-directory path / system
 *      prompt with `BOBBIT_GOAL_ID`) stamps the entry.
 *   2. Two distinct known goal ids in the same transcript -> unmapped.
 *   3. Goal id not in the known-goal set -> unmapped.
 *   4. Truncated `.jsonl` survives without crashing.
 *   5. Missing `.jsonl` for a sessionId -> entry stays unmapped.
 *   6. Pure prose mention (no high/medium-confidence marker) -> unmapped.
 *
 * Pinning rule: a wrong attribution is worse than `unattributable`. If
 * any of these tests start passing-by-stamping, that's a regression.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-backfill-transcript-"));
process.env.BOBBIT_DIR = tmpDir;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });
const SESSIONS_ROOT = path.join(tmpDir, "agent-sessions");
fs.mkdirSync(SESSIONS_ROOT, { recursive: true });

const { CostTracker } = await import("../src/server/agent/cost-tracker.ts");
const {
	backfillLegacyCostGoalIdsFromTranscripts,
	extractTranscriptGoalId,
} = await import("../src/server/agent/cost-backfill.ts");

const GOAL_A = "11111111-2222-3333-4444-555555555555";
const GOAL_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GOAL_UNKNOWN = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";

function makeCostsFile(entries: Record<string, { totalCost?: number; inputTokens?: number; outputTokens?: number; goalId?: string }>): string {
	const file = path.join(stateDir, "session-costs.json");
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
	fs.writeFileSync(file, JSON.stringify(out, null, 2));
	return file;
}

function writeTranscript(sessionId: string, slug: string, contents: string): string {
	const slugDir = path.join(SESSIONS_ROOT, slug);
	fs.mkdirSync(slugDir, { recursive: true });
	const file = path.join(slugDir, `${sessionId}.jsonl`);
	fs.writeFileSync(file, contents);
	return file;
}

function silentLogger() {
	return { log: () => {}, warn: () => {} };
}

beforeEach(() => {
	try { fs.rmSync(path.join(stateDir, "session-costs.json"), { force: true }); } catch { /* ignore */ }
	try { fs.rmSync(SESSIONS_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
	fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
});

describe("extractTranscriptGoalId", () => {
	it("stamps on high-confidence BOBBIT_GOAL_ID env marker", () => {
		const text = `Working Directory: /tmp/x\nBOBBIT_GOAL_ID=${GOAL_A}\nrest of system prompt`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), GOAL_A);
	});

	it("stamps on worktree path segment goal-<slug>-<id8>", () => {
		const id8 = GOAL_A.slice(0, 8);
		const text = `Working Directory: /repo-wt/goal-deepe-feat-${id8}/\nGoalId is ${GOAL_A} somewhere`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), GOAL_A);
	});

	it("stamps on --goal CLI flag", () => {
		const text = `command: bobbit-agent --goal ${GOAL_A} --debug\n... ${GOAL_A}`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), GOAL_A);
	});

	it("stamps when id appears within a goal-context window", () => {
		const text = `# Goal\nFix the cost backfill ${GOAL_A}\n...rest of spec`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), GOAL_A);
	});

	it("does NOT stamp on prose-only mention", () => {
		const text = `Hello world, see ticket ${GOAL_A} for context. Nothing else here.`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), undefined);
	});

	it("does NOT stamp when two known ids appear", () => {
		const text = `BOBBIT_GOAL_ID=${GOAL_A}\nWorking Directory: /tmp/goal-x-${GOAL_B.slice(0, 8)}/\nref ${GOAL_B}`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A, GOAL_B])), undefined);
	});

	it("does NOT stamp when id is not in the known set", () => {
		const text = `BOBBIT_GOAL_ID=${GOAL_UNKNOWN}\nWorking Directory: /tmp/goal-x-${GOAL_UNKNOWN.slice(0, 8)}/`;
		assert.equal(extractTranscriptGoalId(text, new Set([GOAL_A])), undefined);
	});
});

describe("backfillLegacyCostGoalIdsFromTranscripts", () => {
	it("stamps an entry whose transcript has a high-confidence working-directory hit", async () => {
		makeCostsFile({ "sess-1": { totalCost: 0.5, inputTokens: 100 } });
		const tracker = new CostTracker(stateDir);
		writeTranscript("sess-1", "my-slug", [
			`{"type":"system","content":"Working Directory: /repo-wt/goal-feat-${GOAL_A.slice(0, 8)}/"}`,
			`{"type":"system","content":"BOBBIT_GOAL_ID=${GOAL_A}"}`,
			`{"type":"user","content":"# Goal\\nFix the thing\\nid: ${GOAL_A}"}`,
		].join("\n"));

		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: SESSIONS_ROOT,
			goals: [{ id: GOAL_A }, { id: GOAL_B }],
			logger: silentLogger(),
		});

		assert.equal(res.stamped, 1);
		assert.equal(res.unattributable, 0);
		assert.equal(tracker.getSessionCost("sess-1")?.goalId, GOAL_A);
	});

	it("leaves entry unmapped when transcript references two real goal ids", async () => {
		makeCostsFile({ "sess-2": { totalCost: 0.2 } });
		const tracker = new CostTracker(stateDir);
		writeTranscript("sess-2", "slug2", [
			`BOBBIT_GOAL_ID=${GOAL_A}`,
			`# Goal nesting context: parent ${GOAL_B}`,
		].join("\n"));

		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: SESSIONS_ROOT,
			goals: [{ id: GOAL_A }, { id: GOAL_B }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(tracker.getSessionCost("sess-2")?.goalId, undefined);
	});

	it("leaves entry unmapped when the only id is unknown", async () => {
		makeCostsFile({ "sess-3": {} });
		const tracker = new CostTracker(stateDir);
		writeTranscript("sess-3", "slug3", `BOBBIT_GOAL_ID=${GOAL_UNKNOWN}\nWorking Directory: /repo-wt/goal-x-${GOAL_UNKNOWN.slice(0, 8)}/`);

		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(tracker.getSessionCost("sess-3")?.goalId, undefined);
	});

	it("survives truncated jsonl", async () => {
		makeCostsFile({ "sess-4": {} });
		const tracker = new CostTracker(stateDir);
		// Line truncated mid-JSON, but contains a high-confidence id marker first.
		writeTranscript("sess-4", "slug4", `BOBBIT_GOAL_ID=${GOAL_A}\n{"type":"system","content":"truncated mid-line and never closed`);

		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 1);
		assert.equal(tracker.getSessionCost("sess-4")?.goalId, GOAL_A);
	});

	it("survives missing jsonl for an unmapped sessionId", async () => {
		makeCostsFile({ "sess-missing": {} });
		const tracker = new CostTracker(stateDir);
		// No transcript file written.
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("sess-missing")?.goalId, undefined);
	});

	it("no-op when there are no unstamped entries", async () => {
		makeCostsFile({ "sess-x": { goalId: GOAL_A } });
		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 0);
	});

	it("does not stamp when knownGoalIds is empty", async () => {
		makeCostsFile({ "sess-5": {} });
		const tracker = new CostTracker(stateDir);
		writeTranscript("sess-5", "slug5", `BOBBIT_GOAL_ID=${GOAL_A}`);
		const res = await backfillLegacyCostGoalIdsFromTranscripts({
			costTracker: tracker,
			agentSessionsRoot: SESSIONS_ROOT,
			goals: [],
			logger: silentLogger(),
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 1);
	});
});
