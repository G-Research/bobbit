/**
 * SWARM-W1 — deterministic best-of-N verifier.
 *
 * design/swarm-orchestration.md §4/§5.3: "a separate deterministic verifier
 * (test/tool/grep) scores them → pick best passing." Copies Anthropic's
 * second structural guardrail verbatim: verification is a COMMAND (test /
 * tool / grep exit code), NEVER an LLM grading its own (or a sibling's)
 * output. This module contains no model call of any kind.
 *
 * Reuses `spawnTracked` (spawn-tree.ts) for process-tree-safe execution
 * (SIGTERM→grace→SIGKILL, same primitive `verification-harness.ts`'s own
 * `runCommandStep` uses for workflow gate verify-steps) rather than
 * reinventing child-process handling.
 *
 * Escalation, never silent resolution (critique fix, carried from SWARM-W0):
 * an `allFailed` group (barrier fired, no `done` artifact) or a barrier-fired
 * group where NO candidate's command passes is surfaced for HUMAN
 * escalation — this module never invents or auto-picks a winner in either
 * case.
 */
import { getVerificationShell } from "./shell-util.js";
import { spawnTracked } from "./spawn-tree.js";
import type { SwarmArtifact, SwarmGroupRecord } from "./swarm-group-store.js";

export interface SwarmCandidateScore {
	goalId: string;
	passed: boolean;
	/** Numeric score — defaults to 1 for a bare pass / 0 for a fail. A `SCORE: <number>` line anywhere in stdout overrides this (higher wins the tie-break among passing candidates). */
	score: number;
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

export type SwarmVerifyOutcome = "not-ready" | "all-failed" | "no-passing-candidate" | "picked";

export interface SwarmVerifyResult {
	outcome: SwarmVerifyOutcome;
	winnerGoalId?: string;
	scores: SwarmCandidateScore[];
}

const SCORE_LINE_RE = /^\s*SCORE:\s*(-?\d+(?:\.\d+)?)\s*$/m;

/**
 * Run `verifyCommand` in each `done` candidate's worktree and pick the best
 * PASSING one (highest `SCORE:` value if present, else earliest `capturedAt`
 * as the deterministic tie-break — never random, never LLM-judged).
 *
 * Returns `not-ready` (barrier hasn't fired yet) or `all-failed` (barrier
 * fired but the group's `allFailed` flag is set — SWARM-W0's escalate-only
 * contract) WITHOUT running any command in either case.
 *
 * SWARM-W4.1 (design/swarm-orchestration-w4.md §1.3): `opts.onlyGoalId` scopes
 * verification to exactly ONE `done` candidate and bypasses the barrier/
 * all-failed gates above — this is what lets an early-kill trigger verify a
 * single sibling the instant it lands, without waiting for every other
 * sibling to also go terminal. It is a purely ADDITIVE opt-in: omitted (the
 * only way the REST `/verify` route ever calls this today), behavior is
 * byte-identical to before this wave. `onlyGoalId` is for the internal
 * early-kill signal ONLY — it is never wired to the REST `/verify` endpoint,
 * never persisted via `SwarmGroupStore.recordVerifyResult`, and never mints
 * an operator-confirmation token; the human-gated pick-a-winner verify
 * remains exactly the unmodified full-barrier call it always was.
 */
export async function verifyBestOfNGroup(
	group: SwarmGroupRecord,
	resolveCwd: (goalId: string) => string | undefined,
	verifyCommand: string,
	opts?: { timeoutMs?: number; onlyGoalId?: string },
): Promise<SwarmVerifyResult> {
	if (!opts?.onlyGoalId) {
		if (!group.barrierFired) return { outcome: "not-ready", scores: [] };
		if (group.allFailed) return { outcome: "all-failed", scores: [] };
	}

	const candidates = group.artifacts.filter(a => a.status === "done" && (!opts?.onlyGoalId || a.goalId === opts.onlyGoalId));
	const scores: SwarmCandidateScore[] = [];
	for (const candidate of candidates) {
		const cwd = resolveCwd(candidate.goalId);
		scores.push(await runVerifyCommand(candidate, cwd, verifyCommand, opts));
	}

	const passing = scores.filter(s => s.passed);
	if (passing.length === 0) return { outcome: "no-passing-candidate", scores };

	const byGoalId = new Map(candidates.map(a => [a.goalId, a]));
	passing.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score; // higher score wins
		const ca = byGoalId.get(a.goalId)?.capturedAt ?? 0;
		const cb = byGoalId.get(b.goalId)?.capturedAt ?? 0;
		return ca - cb; // earlier terminal wins ties — deterministic, never random
	});
	return { outcome: "picked", winnerGoalId: passing[0].goalId, scores };
}

async function runVerifyCommand(
	candidate: SwarmArtifact,
	cwd: string | undefined,
	verifyCommand: string,
	opts?: { timeoutMs?: number },
): Promise<SwarmCandidateScore> {
	if (!cwd) {
		return { goalId: candidate.goalId, passed: false, score: 0, exitCode: null, output: "(no worktree cwd resolvable for this candidate)", timedOut: false };
	}
	const { shell, args } = getVerificationShell(verifyCommand);
	return new Promise<SwarmCandidateScore>((resolve) => {
		let output = "";
		const tracked = spawnTracked(shell, [...args, verifyCommand], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			timeoutMs: opts?.timeoutMs ?? 5 * 60_000,
			onTimeout: () => { output += "\n[swarm-verifier] verify command timed out\n"; },
		});
		tracked.child.stdout?.on("data", (d) => { output += d.toString(); });
		tracked.child.stderr?.on("data", (d) => { output += d.toString(); });
		tracked.child.on("close", (code) => {
			const timedOut = tracked.timedOut();
			const exitCode = timedOut ? null : code;
			const passed = !timedOut && code === 0;
			const scoreMatch = output.match(SCORE_LINE_RE);
			const score = scoreMatch ? Number(scoreMatch[1]) : (passed ? 1 : 0);
			resolve({ goalId: candidate.goalId, passed, score, exitCode, output, timedOut });
		});
		tracked.child.on("error", (err) => {
			resolve({ goalId: candidate.goalId, passed: false, score: 0, exitCode: null, output: `${output}\n[swarm-verifier] spawn error: ${String(err)}`, timedOut: false });
		});
	});
}
