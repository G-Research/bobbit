/**
 * SWARM-W1 — deterministic best-of-N verifier (design/swarm-orchestration.md
 * §4/§5.3). Runs REAL shell commands (via `spawnTracked`) against tmp
 * "worktree" directories — no mocking of process spawning, so this
 * genuinely exercises exit-code handling, the `SCORE:` convention, and the
 * escalate-only contract (never picks anything for `all-failed` or
 * `no-passing-candidate`).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyBestOfNGroup } from "../src/server/agent/swarm-verifier.ts";
import type { SwarmArtifact, SwarmGroupRecord } from "../src/server/agent/swarm-group-store.ts";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w1-verifier-"));
});

function candidateDir(name: string): string {
	const dir = path.join(tmpRoot, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function artifact(goalId: string, status: SwarmArtifact["status"], capturedAt = Date.now()): SwarmArtifact {
	return { goalId, output: "", status, verifierScore: null, capturedAt };
}

function groupOf(artifacts: SwarmArtifact[], overrides?: Partial<SwarmGroupRecord>): SwarmGroupRecord {
	const expected = artifacts.map(a => a.goalId);
	return {
		swarmGroup: "grp",
		artifacts,
		barrierFired: true,
		allFailed: artifacts.every(a => a.status !== "done"),
		updatedAt: Date.now(),
		expectedSiblingIds: expected,
		...overrides,
	};
}

describe("verifyBestOfNGroup — escalate-only contract (never auto-resolve)", () => {
	it("not-ready when the barrier hasn't fired — runs NO command", async () => {
		const group = groupOf([artifact("a", "done")], { barrierFired: false });
		const result = await verifyBestOfNGroup(group, () => tmpRoot, "exit 0");
		assert.equal(result.outcome, "not-ready");
		assert.deepEqual(result.scores, []);
	});

	it("all-failed (SWARM-W0 critique fix) escalates without running any command", async () => {
		const group = groupOf([artifact("a", "failed"), artifact("b", "killed")], { allFailed: true });
		const result = await verifyBestOfNGroup(group, () => tmpRoot, "exit 0");
		assert.equal(result.outcome, "all-failed");
		assert.deepEqual(result.scores, []);
	});
});

describe("verifyBestOfNGroup — deterministic command verification (real spawn, no LLM)", () => {
	it("picks the ONLY passing candidate when others fail their command", async () => {
		const good = candidateDir("good");
		const bad = candidateDir("bad");
		fs.writeFileSync(path.join(good, "PASS"), "");
		const group = groupOf([artifact("winner", "done"), artifact("loser", "done")]);
		const result = await verifyBestOfNGroup(
			group,
			(goalId) => (goalId === "winner" ? good : bad),
			"test -f PASS",
		);
		assert.equal(result.outcome, "picked");
		assert.equal(result.winnerGoalId, "winner");
		assert.equal(result.scores.length, 2);
		assert.equal(result.scores.find(s => s.goalId === "winner")!.passed, true);
		assert.equal(result.scores.find(s => s.goalId === "loser")!.passed, false);
	});

	it("no-passing-candidate when every candidate's command fails — never invents a winner", async () => {
		const group = groupOf([artifact("a", "done"), artifact("b", "done")]);
		const result = await verifyBestOfNGroup(group, () => tmpRoot, "exit 1");
		assert.equal(result.outcome, "no-passing-candidate");
		assert.equal(result.winnerGoalId, undefined);
		assert.ok(result.scores.every(s => !s.passed));
	});

	it("parses a `SCORE:` line from stdout and records it on the score (verifyCommand is shared per-run — the numeric override is what a real per-candidate test/lint command would emit)", async () => {
		const group = groupOf([artifact("a", "done")]);
		const result = await verifyBestOfNGroup(group, () => tmpRoot, `echo "SCORE: 7"; exit 0`);
		assert.equal(result.outcome, "picked");
		assert.ok(result.scores.every(s => s.passed && s.score === 7));
	});

	it("tie-break among equal-score passing candidates: earliest capturedAt wins (deterministic, never random)", async () => {
		const early = artifact("early", "done", 1000);
		const late = artifact("late", "done", 2000);
		const group = groupOf([late, early]); // deliberately out of order
		const result = await verifyBestOfNGroup(group, () => tmpRoot, "exit 0");
		assert.equal(result.outcome, "picked");
		assert.equal(result.winnerGoalId, "early");
	});

	it("a candidate with no resolvable worktree cwd fails closed (never passes)", async () => {
		const group = groupOf([artifact("no-cwd", "done")]);
		const result = await verifyBestOfNGroup(group, () => undefined, "exit 0");
		assert.equal(result.outcome, "no-passing-candidate");
		assert.equal(result.scores[0].passed, false);
	});

	it("a candidate whose verify command times out is scored as a fail, not a crash", async () => {
		const group = groupOf([artifact("slow", "done")]);
		const result = await verifyBestOfNGroup(group, () => tmpRoot, "sleep 5", { timeoutMs: 100 });
		assert.equal(result.outcome, "no-passing-candidate");
		assert.equal(result.scores[0].passed, false);
		assert.equal(result.scores[0].timedOut, true);
	});
});
