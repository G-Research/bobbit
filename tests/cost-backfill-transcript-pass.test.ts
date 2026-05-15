/**
 * Tests for the transcript-pass cost backfill (design: "transcript-pass cost
 * backfill + legacy-zero UI").
 *
 * Covers the second backfill pass that runs AFTER the existing sidecar pass
 * in `backfillLegacyCostGoalIds`. For any cost entry still missing `goalId`,
 * the helper opens the session's `.jsonl` transcript under
 * `<agentSessionsRoot>/<slug>/<sessionId>.jsonl`, scans the first ~50 lines
 * / 64 KiB, and stamps the entry only when a UUID hit passes the confidence
 * rules in the design doc:
 *
 *   1. UUID must appear in the caller-supplied `knownGoalIds` set (real goal).
 *   2. Exactly ONE distinct known goal id may appear — multi-hit = unsafe.
 *   3. Contextual confidence required:
 *      - high — near `BOBBIT_GOAL_ID`, `--goal <id>`, or
 *        `goal-<slug>-<id8>/` worktree path segments (id8 matches hit prefix).
 *      - medium — in goal-context block markers (`# Goal`, `Goal`, `Goal Spec`,
 *        `Goal nesting context`, `Current Goal`, `Working Directory`).
 *      - else — skip (prose references like "see goal abc12345-…").
 *
 * Defensive bounds the helper MUST honour:
 *   - cap scan at first 50 lines OR 64 KiB (whichever first)
 *   - try/catch every read — truncated / malformed jsonl must not throw
 *   - missing jsonl on disk leaves entry unmapped without crashing
 *   - 30 s per-pass deadline (not exercised here — too slow for unit suite)
 *
 * Helper signature this pins (per design):
 *
 *   import { backfillLegacyCostGoalIdsFromTranscripts, extractTranscriptGoalId }
 *     from "../src/server/agent/cost-backfill.ts";
 *
 *   await backfillLegacyCostGoalIdsFromTranscripts({
 *     costTracker, agentSessionsRoot, goals, logger?,
 *     maxLines?, maxBytes?, deadlineMs?,
 *   }): Promise<{ stamped: number; unattributable: number; skipped?: number }>;
 *
 *   extractTranscriptGoalId(text: string, knownGoalIds: Set<string>): string | undefined;
 *
 * These tests dynamic-import the helper and gracefully `skip` the suite when
 * the helper is not yet exported. Once the implementation task lands the
 * helper, every case must pass with no further test edits.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-backfill-transcript-"));
process.env.BOBBIT_DIR = tmpDir;
const stateDir = path.join(tmpDir, "state");
fs.mkdirSync(stateDir, { recursive: true });
const COSTS_FILE = path.join(stateDir, "session-costs.json");
const AGENT_SESSIONS_ROOT = path.join(stateDir, "agent-sessions");
fs.mkdirSync(AGENT_SESSIONS_ROOT, { recursive: true });

const { CostTracker } = await import("../src/server/agent/cost-tracker.ts");

// Real goal id constants used across tests. Format matches the design
// regex: [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}.
const GOAL_A = "deadbeef-1111-2222-3333-444455556666";
const GOAL_B = "cafebabe-aaaa-bbbb-cccc-ddddeeeeffff";
const GOAL_UNKNOWN = "00000000-9999-9999-9999-000000000000";

type TranscriptPassFn = (opts: {
	costTracker: InstanceType<typeof CostTracker>;
	agentSessionsRoot: string;
	goals: Array<{ id: string; title?: string; spec?: string }>;
	logger?: Pick<Console, "log" | "warn">;
	maxLines?: number;
	maxBytes?: number;
	deadlineMs?: number;
}) => Promise<{ stamped: number; unattributable: number; skipped?: number }>;

type ExtractFn = (text: string, knownGoalIds: Set<string>) => string | undefined;

// Top-level await so `importError` is set BEFORE `it()` calls are registered
// — node:test reads the `skip` option at registration time, not at run time.
let backfillLegacyCostGoalIdsFromTranscripts: TranscriptPassFn | undefined;
let extractTranscriptGoalId: ExtractFn | undefined;
let importError: string | undefined;
try {
	const mod = await import("../src/server/agent/cost-backfill.ts") as unknown as {
		backfillLegacyCostGoalIdsFromTranscripts?: TranscriptPassFn;
		extractTranscriptGoalId?: ExtractFn;
	};
	backfillLegacyCostGoalIdsFromTranscripts = mod.backfillLegacyCostGoalIdsFromTranscripts;
	extractTranscriptGoalId = mod.extractTranscriptGoalId;
	if (!backfillLegacyCostGoalIdsFromTranscripts || !extractTranscriptGoalId) {
		importError = "missing exports: backfillLegacyCostGoalIdsFromTranscripts and/or extractTranscriptGoalId";
	}
} catch (err) {
	importError = String(err);
}

function pendingReason(): string | false {
	return importError ? `pending impl — ${importError}` : false;
}

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

/** Write a transcript file at <agentSessionsRoot>/<slug>/<sessionId>.jsonl */
function seedTranscript(slug: string, sessionId: string, body: string): string {
	const slugDir = path.join(AGENT_SESSIONS_ROOT, slug);
	fs.mkdirSync(slugDir, { recursive: true });
	const p = path.join(slugDir, `${sessionId}.jsonl`);
	fs.writeFileSync(p, body, "utf-8");
	return p;
}

/** Wipe agent-sessions + costs between tests. */
function reset(): void {
	try { fs.unlinkSync(COSTS_FILE); } catch { /* ok */ }
	try {
		for (const slug of fs.readdirSync(AGENT_SESSIONS_ROOT)) {
			fs.rmSync(path.join(AGENT_SESSIONS_ROOT, slug), { recursive: true, force: true });
		}
	} catch { /* ok */ }
}

describe("backfillLegacyCostGoalIdsFromTranscripts — transcript pass", () => {
	beforeEach(reset);
	after(() => {
		try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
	});

	it("high-confidence: Working Directory + system prompt hit stamps matching real goal", { skip: pendingReason() }, async () => {
		seedCosts({ s1: { totalCost: 0.001, inputTokens: 100, outputTokens: 50 } });
		// First lines mimic the spawn prompt — Working Directory worktree path
		// (`goal-slug-<id8>` segment) plus an explicit `BOBBIT_GOAL_ID` env
		// reference. Either alone is high-confidence per design.
		const body = [
			JSON.stringify({ type: "system", subtype: "init", cwd: `/wt/goal-slug-${GOAL_A.slice(0, 8)}` }),
			JSON.stringify({
				type: "user",
				message: {
					role: "user",
					content: [
						{ type: "text", text: `Working Directory: /wt/goal-slug-${GOAL_A.slice(0, 8)}\nBOBBIT_GOAL_ID=${GOAL_A}\n# Goal\nspec: ...` },
					],
				},
			}),
		].join("\n") + "\n";
		seedTranscript("slug-a", "s1", body);

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts!({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A, title: "Goal A" }, { id: GOAL_B, title: "Goal B" }],
		});
		assert.equal(res.stamped, 1, "high-confidence single hit must stamp");
		assert.equal(res.unattributable, 0);
		assert.equal(tracker.getSessionCost("s1")?.goalId, GOAL_A);
	});

	it("two distinct real goal ids in same transcript stays unmapped (ambiguous)", { skip: pendingReason() }, async () => {
		seedCosts({ s_amb: { totalCost: 0.002 } });
		const body = [
			JSON.stringify({ type: "system", cwd: `/wt/goal-x-${GOAL_A.slice(0, 8)}` }),
			JSON.stringify({
				type: "user",
				message: { role: "user", content: [{ type: "text",
					text: `# Goal\nBOBBIT_GOAL_ID=${GOAL_A}\nSibling reference: ${GOAL_B} also active`,
				}]},
			}),
		].join("\n") + "\n";
		seedTranscript("slug-amb", "s_amb", body);

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts!({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }, { id: GOAL_B }],
		});
		assert.equal(res.stamped, 0, "multi-hit must NOT stamp — guess is worse than unattributable");
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("s_amb")?.goalId, undefined);
	});

	it("UUID hit that is not in knownGoalIds stays unmapped", { skip: pendingReason() }, async () => {
		seedCosts({ s_unk: { totalCost: 0.003 } });
		const body = JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "text",
				text: `Working Directory: /wt/goal-foo-${GOAL_UNKNOWN.slice(0, 8)}\nBOBBIT_GOAL_ID=${GOAL_UNKNOWN}`,
			}]},
		}) + "\n";
		seedTranscript("slug-unk", "s_unk", body);

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts!({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }, { id: GOAL_B }], // GOAL_UNKNOWN deliberately absent
		});
		assert.equal(res.stamped, 0, "unknown goalId must NOT stamp — no inventing parents");
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("s_unk")?.goalId, undefined);
	});

	it("truncated mid-line jsonl survives (defensive read; no crash)", { skip: pendingReason() }, async () => {
		seedCosts({ s_trunc: { totalCost: 0.004 } });
		// Valid first frame, then a truncated second frame (no terminating
		// brace, no newline). A naive JSON.parse-per-line would throw — the
		// helper must wrap reads in try/catch and treat lines as text.
		const truncated =
			JSON.stringify({ type: "system", cwd: `/wt/goal-trunc-${GOAL_A.slice(0, 8)}` }) +
			"\n" +
			`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"BOBBIT_GOAL_ID=${GOAL_A} half-`;
		seedTranscript("slug-trunc", "s_trunc", truncated);

		const tracker = new CostTracker(stateDir);
		// Helper must NOT throw — even if it cannot decide, it must return.
		const res = await backfillLegacyCostGoalIdsFromTranscripts!({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
		});
		// Result-agnostic: either stamped (because regex still matched the
		// raw text with high-confidence context) or unattributable. The
		// non-negotiable contract is "no crash".
		assert.ok(res.stamped + res.unattributable === 1, "exactly one entry processed");
	});

	it("missing jsonl for sessionId leaves entry unmapped without crash", { skip: pendingReason() }, async () => {
		seedCosts({ s_missing: { totalCost: 0.005 } });
		// Deliberately do NOT seed any transcript for s_missing.
		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts!({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 1);
		assert.equal(tracker.getSessionCost("s_missing")?.goalId, undefined);
	});

	it("already-stamped entries are not revisited by transcript pass", { skip: pendingReason() }, async () => {
		seedCosts({
			s_done: { totalCost: 0.010, goalId: "goal-prior" },
			s_todo: { totalCost: 0.001 },
		});
		const body = JSON.stringify({
			type: "user",
			message: { role: "user", content: [{ type: "text",
				text: `Working Directory: /wt/goal-z-${GOAL_A.slice(0, 8)}\nBOBBIT_GOAL_ID=${GOAL_A}`,
			}]},
		}) + "\n";
		seedTranscript("slug-z", "s_todo", body);
		// Also seed a transcript for the already-stamped entry — must be ignored.
		seedTranscript("slug-z", "s_done", body);

		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts!({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
		});
		assert.equal(res.stamped, 1, "only the previously-unstamped entry should be touched");
		assert.equal(tracker.getSessionCost("s_done")?.goalId, "goal-prior");
		assert.equal(tracker.getSessionCost("s_todo")?.goalId, GOAL_A);
	});

	it("empty unmapped set is a no-op (returns immediately, no crash)", { skip: pendingReason() }, async () => {
		seedCosts({ s_done: { totalCost: 0.001, goalId: "goal-x" } });
		const tracker = new CostTracker(stateDir);
		const res = await backfillLegacyCostGoalIdsFromTranscripts!({
			costTracker: tracker,
			agentSessionsRoot: AGENT_SESSIONS_ROOT,
			goals: [{ id: GOAL_A }],
		});
		assert.equal(res.stamped, 0);
		assert.equal(res.unattributable, 0);
	});
});

describe("extractTranscriptGoalId — pure confidence rules", () => {
	it("returns undefined when no known UUID appears", { skip: pendingReason() }, () => {
		const out = extractTranscriptGoalId!("hello world no uuid here", new Set([GOAL_A]));
		assert.equal(out, undefined);
	});

	it("returns undefined when UUID exists but is not in knownGoalIds", { skip: pendingReason() }, () => {
		const text = `BOBBIT_GOAL_ID=${GOAL_UNKNOWN}`;
		const out = extractTranscriptGoalId!(text, new Set([GOAL_A]));
		assert.equal(out, undefined);
	});

	it("returns undefined when multiple distinct known UUIDs appear", { skip: pendingReason() }, () => {
		const text = `BOBBIT_GOAL_ID=${GOAL_A} also see ${GOAL_B}`;
		const out = extractTranscriptGoalId!(text, new Set([GOAL_A, GOAL_B]));
		assert.equal(out, undefined);
	});

	it("returns the single known UUID when found near BOBBIT_GOAL_ID (high confidence)", { skip: pendingReason() }, () => {
		const text = `env: BOBBIT_GOAL_ID=${GOAL_A}\nother log line`;
		const out = extractTranscriptGoalId!(text, new Set([GOAL_A]));
		assert.equal(out, GOAL_A);
	});

	it("returns the single known UUID when found in `--goal <id>` CLI arg (high confidence)", { skip: pendingReason() }, () => {
		const text = `spawned with: agent --goal ${GOAL_A} --foo bar`;
		const out = extractTranscriptGoalId!(text, new Set([GOAL_A]));
		assert.equal(out, GOAL_A);
	});

	it("returns the single known UUID when worktree path goal-<slug>-<id8> matches (high confidence)", { skip: pendingReason() }, () => {
		const text = `Working Directory: /repos/proj-wt/goal-my-feature-${GOAL_A.slice(0, 8)}/src`;
		const out = extractTranscriptGoalId!(text, new Set([GOAL_A]));
		assert.equal(out, GOAL_A);
	});

	it("returns the single known UUID when adjacent to goal-context markers (medium confidence)", { skip: pendingReason() }, () => {
		const text = `# Goal\n\n**Title** ...\nGoal id: ${GOAL_A}\n\n## Spec`;
		const out = extractTranscriptGoalId!(text, new Set([GOAL_A]));
		assert.equal(out, GOAL_A);
	});

	it("returns undefined for prose-only reference with no confidence marker", { skip: pendingReason() }, () => {
		// Just the id buried in prose — design says skip.
		const text = `some chatter ... see goal ${GOAL_A} for background ... more chatter ...`;
		const out = extractTranscriptGoalId!(text, new Set([GOAL_A]));
		assert.equal(out, undefined,
			"prose-only reference must NOT stamp — confidence rule guard");
	});
});
