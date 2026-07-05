/**
 * Regression tests for finding VER-04/W3.2 — "Shared diff artifact across
 * reviewers".
 *
 * Prior behavior: `buildReviewPrompt` instructed EVERY `llm-review` reviewer
 * to run `git diff` itself. A gate with 3-4 concurrent reviewers therefore
 * re-derived the identical branch diff 3-4x (verification-harness.ts, prior
 * `buildReviewPrompt` — see docs/goals-workflows-tasks.md "Gate verification
 * baselines" and the Fable program's finding VER-03).
 *
 * Fix: `computeReviewDiffArtifact` derives the diff ONCE per verification run
 * (`verifyGateSignal`, before the phase fan-out) and threads the same
 * `ReviewDiffArtifact` into every reviewer's `buildReviewPrompt` call via
 * `runLlmReviewStep`. This is a cost/latency fix, not a behavior change — the
 * embedded diff text must be byte-identical to what a fresh derivation would
 * produce for the same tree state, and every concurrent reviewer in a phase
 * must receive the SAME precomputed artifact rather than each deriving its own.
 *
 * Covers:
 *   T1 — computeReviewDiffArtifact equivalence: matches a fresh `git diff`
 *        derivation for the same tree state (byte-identical content pin).
 *   T2 — buildReviewPrompt embeds the precomputed diff and stops instructing
 *        the reviewer to derive it itself; baseline SHA is reused from the
 *        artifact instead of being re-resolved.
 *   T3 — buildReviewPrompt with no diffArtifact (undefined) preserves the
 *        legacy self-derive instructions unchanged (existing callers, e.g.
 *        `_rerunLlmReviewStep`, are unaffected).
 *   T4 — verifyGateSignal fan-out: two concurrent llm-review steps in the
 *        same phase both receive the IDENTICAL diffArtifact object — proving
 *        it was computed once and shared, not re-derived per reviewer.
 *   T5 — inline cap (REVIEW_DIFF_INLINE_CAP_BYTES, prompt-scale — distinct
 *        from the 10 MB buffer/persisted-file cap): an over-cap diff embeds
 *        the full stat + a capped head + pointer text to the persisted
 *        diff.patch and targeted `git diff -- <paths>` commands, and the
 *        prompt length stays bounded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
	buildReviewPrompt,
	computeReviewDiffArtifact,
	REVIEW_DIFF_INLINE_CAP_BYTES,
	VerificationHarness,
} = await import("../src/server/agent/verification-harness.js");

function makeTempStateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-shared-diff-state-"));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

/** A clone with origin/master plus one extra local (unpushed) commit on the goal branch. */
function makeRepoWithGoalBranchDiff(): { root: string; repoDir: string; goalBranch: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-shared-diff-repo-"));
	const remoteDir = path.join(root, "remote.git");
	const seedDir = path.join(root, "seed");
	const repoDir = path.join(root, "repo");
	const goalBranch = "goal/shared-diff";
	const gitEnv = ["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test"];

	execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: remoteDir, stdio: "ignore" });
	execFileSync("git", ["init", seedDir], { stdio: "ignore" });
	execFileSync("git", ["checkout", "-B", "master"], { cwd: seedDir, stdio: "ignore" });
	fs.writeFileSync(path.join(seedDir, "README.md"), "line one\nline two\n");
	execFileSync("git", ["add", "README.md"], { cwd: seedDir, stdio: "ignore" });
	execFileSync("git", [...gitEnv, "commit", "-m", "Initial commit"], { cwd: seedDir, stdio: "ignore" });
	execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: seedDir, stdio: "ignore" });
	execFileSync("git", ["push", "-u", "origin", "master"], { cwd: seedDir, stdio: "ignore" });

	execFileSync("git", ["clone", remoteDir, repoDir], { stdio: "ignore" });
	execFileSync("git", ["checkout", "-b", goalBranch], { cwd: repoDir, stdio: "ignore" });
	fs.writeFileSync(path.join(repoDir, "README.md"), "line one\nline two\nline three (goal change)\n");
	fs.writeFileSync(path.join(repoDir, "NEW_FILE.md"), "a new file added on the goal branch\n");
	execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
	execFileSync("git", [...gitEnv, "commit", "-m", "Goal branch change"], { cwd: repoDir, stdio: "ignore" });

	return { root, repoDir, goalBranch };
}

test("T1: computeReviewDiffArtifact matches a fresh git diff derivation for the same tree state", async () => {
	const { root, repoDir } = makeRepoWithGoalBranchDiff();
	try {
		const artifact = await computeReviewDiffArtifact(repoDir, "master");
		assert.ok(artifact, "expected computeReviewDiffArtifact to succeed against a real repo with origin/master");

		const freshStat = execFileSync(
			"git", ["diff", "--stat", "origin/master...HEAD", "--", ".", ":!package-lock.json"],
			{ cwd: repoDir, encoding: "utf8" },
		);
		const freshDiff = execFileSync(
			"git", ["diff", "origin/master...HEAD", "-M", "--", ".", ":!package-lock.json"],
			{ cwd: repoDir, encoding: "utf8" },
		);
		const freshSha = execFileSync("git", ["rev-parse", "origin/master"], { cwd: repoDir, encoding: "utf8" }).trim().slice(0, 12);

		assert.equal(
			artifact!.stat, freshStat,
			"VER-04_W3_2: precomputed --stat output must be byte-identical to a fresh derivation for the same tree state",
		);
		assert.equal(
			artifact!.diff, freshDiff,
			"VER-04_W3_2: precomputed diff output must be byte-identical to a fresh derivation for the same tree state",
		);
		assert.equal(artifact!.baselineSha, freshSha);
		assert.equal(artifact!.truncated, false);
		assert.match(artifact!.diff, /NEW_FILE\.md/);
		assert.match(artifact!.diff, /goal change/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("T1b: computeReviewDiffArtifact returns null (non-fatal) when origin is unresolvable", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-shared-diff-no-origin-"));
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["checkout", "-B", "master"], { cwd: root, stdio: "ignore" });
	fs.writeFileSync(path.join(root, "README.md"), "local only\n");
	execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test", "commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
	try {
		const artifact = await computeReviewDiffArtifact(root, "master");
		assert.equal(artifact, null, "no origin remote — computeReviewDiffArtifact must fail closed to null so callers fall back to self-derive instructions");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("T2: buildReviewPrompt embeds the precomputed diff and stops instructing the reviewer to derive it itself", async () => {
	const gate = { id: "implementation", depends_on: ["design-doc"] };
	const diffArtifact = {
		baselineSha: "abc123def456",
		stat: " README.md | 1 +\n 1 file changed, 1 insertion(+)\n",
		diff: "diff --git a/README.md b/README.md\n+++ line added by the shared artifact\n",
		truncated: false,
	};

	// cwd is a nonexistent path — if buildReviewPrompt tried to shell out to git
	// itself (rev-parse, diff, etc.), those commands would fail. The fact that
	// baselineLine still resolves from diffArtifact.baselineSha proves the
	// prompt is using the precomputed artifact, not re-deriving anything.
	const prompt = await buildReviewPrompt(
		{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
		{ name: "Code quality", prompt: "Review code." },
		"/nonexistent/cwd/for/this/test",
		{ branch: "goal/x", master: "main", cwd: "/nonexistent/cwd/for/this/test", commit: "abc", goal_spec: "" },
		undefined, undefined, "spec", new Map(),
		gate,
		diffArtifact as any,
	);

	assert.match(prompt, /## Branch Diff/, "VER-04_W3_2: precomputed diff must be embedded under a '## Branch Diff' section");
	assert.match(prompt, /line added by the shared artifact/, "VER-04_W3_2: embedded diff text must be the precomputed artifact's content");
	assert.match(prompt, /Baseline: diffed against origin\/main@abc123def456/, "VER-04_W3_2: baseline SHA must be reused from the shared artifact, not re-resolved");

	// Must NOT instruct the reviewer to derive the diff itself anymore.
	assert.doesNotMatch(prompt, /git diff --stat origin\/main\.\.\.HEAD/, "VER-04_W3_2: reviewer must not be told to re-derive --stat when a shared artifact is supplied");
	assert.doesNotMatch(prompt, /git diff origin\/main\.\.\.HEAD -M/, "VER-04_W3_2: reviewer must not be told to re-derive the full diff when a shared artifact is supplied");
});

test("T3: buildReviewPrompt without a diffArtifact preserves the legacy self-derive instructions", async () => {
	const gate = { id: "implementation", depends_on: ["design-doc"] };
	const prompt = await buildReviewPrompt(
		{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
		{ name: "Code quality", prompt: "Review code." },
		"/tmp/cwd",
		{ branch: "goal/x", master: "main", cwd: "/tmp/cwd", commit: "abc", goal_spec: "" },
		undefined, undefined, "spec", new Map(),
		gate,
		// diffArtifact intentionally omitted — mirrors existing callers like
		// _rerunLlmReviewStep that don't participate in the shared fan-out.
	);
	assert.match(prompt, /git diff --stat origin\/main\.\.\.HEAD/);
	assert.match(prompt, /git diff origin\/main\.\.\.HEAD -M/);
	assert.doesNotMatch(prompt, /## Branch Diff\n/);
});

test("T5: an artifact over the inline cap embeds the full stat + a capped diff head + a pointer to the persisted file, keeping prompt length bounded", async () => {
	const gate = { id: "implementation", depends_on: ["design-doc"] };
	// A "diff" 4x the inline cap. Line-structured so the head slice looks diff-like.
	const bigLine = "+" + "x".repeat(127) + "\n";
	const bigDiff = "diff --git a/big.txt b/big.txt\nHEAD_MARKER_LINE\n" + bigLine.repeat((REVIEW_DIFF_INLINE_CAP_BYTES * 4) / bigLine.length);
	const diffArtifact = {
		baselineSha: "abc123def456",
		stat: " big.txt | 4096 +++\n 1 file changed\n",
		diff: bigDiff,
		truncated: false, // under the 10MB buffer cap — only the INLINE cap fires
		path: "/state/verifications/sig-1/diff.patch",
	};

	const prompt = await buildReviewPrompt(
		{ promptTemplate: "role\n{{REVIEW_CONTEXT}}", name: "reviewer" },
		{ name: "Code quality", prompt: "Review code." },
		"/nonexistent/cwd/for/this/test",
		{ branch: "goal/x", master: "main", cwd: "/nonexistent/cwd/for/this/test", commit: "abc", goal_spec: "" },
		undefined, undefined, "spec", new Map(),
		gate,
		diffArtifact as any,
	);

	// The full --stat (always small) is embedded intact.
	assert.match(prompt, /big\.txt \| 4096/, "VER-04_W3_2_INLINE_CAP: the complete diffstat must always be embedded");
	// The diff head is present…
	assert.match(prompt, /HEAD_MARKER_LINE/, "VER-04_W3_2_INLINE_CAP: the head of the diff must be embedded");
	assert.match(prompt, /### Diff \(truncated — head only\)/);
	// …but the embed is capped: the prompt must NOT contain the full diff.
	assert.ok(
		!prompt.includes(bigDiff),
		"VER-04_W3_2_INLINE_CAP: the full over-cap diff must never be pasted verbatim into the prompt",
	);
	// Pointer text: persisted-file path + targeted git diff escape hatch.
	assert.match(prompt, /\/state\/verifications\/sig-1\/diff\.patch/, "VER-04_W3_2_INLINE_CAP: truncation notice must point at the persisted full-diff file");
	assert.match(prompt, /git diff origin\/main\.\.\.HEAD -- <paths>/, "VER-04_W3_2_INLINE_CAP: truncation notice must allow targeted per-file diffs");
	assert.match(prompt, new RegExp(`Inline diff truncated at ${REVIEW_DIFF_INLINE_CAP_BYTES} bytes`));

	// Prompt length stays bounded: inline cap + generous fixed overhead for the
	// role/instructions scaffolding — NOT proportional to the 4x-cap diff.
	const maxExpected = REVIEW_DIFF_INLINE_CAP_BYTES + 16 * 1024;
	assert.ok(
		prompt.length <= maxExpected,
		`VER-04_W3_2_INLINE_CAP: prompt length ${prompt.length} must stay within inline cap + scaffolding (${maxExpected}), independent of the ${bigDiff.length}-byte diff`,
	);
});

test("T4: verifyGateSignal computes the branch diff ONCE and shares it across every concurrent llm-review reviewer in a phase", async () => {
	const { root, repoDir, goalBranch } = makeRepoWithGoalBranchDiff();
	const stateDir = makeTempStateDir();
	try {
		const signal = {
			id: "signal-shared-diff",
			goalId: "goal-shared-diff",
			gateId: "implementation",
			sessionId: "session-shared-diff",
			timestamp: Date.now(),
			commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			content: "ready",
			metadata: {},
		};
		const gateState: any = { goalId: signal.goalId, gateId: signal.gateId, status: "pending", signals: [signal] };
		const gateStore = {
			getGate: () => gateState,
			getGatesForGoal: () => [gateState],
			updateSignalVerification: (signalId: string, verification: any) => {
				const target = gateState.signals.find((s: any) => s.id === signalId);
				if (target) target.verification = verification;
			},
			updateGateStatus: (_goalId: string, _gateId: string, status: string) => { gateState.status = status; },
			_gateState: gateState,
		};
		const projectConfigStore = {
			get: () => "",
			getWithDefaults: () => ({}),
			getComponents: () => [],
		};
		const goal = {
			id: signal.goalId,
			branch: goalBranch,
			cwd: repoDir,
			worktreePath: repoDir,
			spec: "Reproduce VER-04/W3.2 shared diff artifact",
			state: "in-progress",
			workflowId: "feature",
		};
		const projectContextManager = {
			getContextForGoal: (goalId: string) => goalId === signal.goalId ? {
				project: { id: "project-shared-diff" },
				goalStore: { get: (id: string) => id === signal.goalId ? goal : undefined },
				gateStore,
				projectConfigStore,
			} : null,
		};
		const roleStore = { get: () => undefined, getAll: () => [] };

		const harness = new VerificationHarness(
			stateDir,
			gateStore as any,
			() => {},
			roleStore as any,
			undefined,
			undefined,
			undefined,
			projectConfigStore as any,
			projectContextManager as any,
		);

		const capturedDiffArtifacts: unknown[] = [];
		(harness as any).runLlmReviewStep = async (
			_step: unknown, _cwd: string, _builtinVars: unknown,
			_signalContent: unknown, _signalMetadata: unknown,
			_goalSpec: unknown, _allGateStates: unknown, _goalId: unknown, _sessionId: unknown,
			_gate: unknown, diffArtifact: unknown,
		) => {
			capturedDiffArtifacts.push(diffArtifact);
			return { passed: true, output: "ok" };
		};

		await harness.verifyGateSignal(
			signal as any,
			{
				id: "implementation",
				name: "Implementation",
				dependsOn: ["design-doc"],
				verify: [
					{ name: "Code quality", type: "llm-review", prompt: "Review code.", phase: 0 },
					{ name: "Bug hunt", type: "llm-review", prompt: "Hunt bugs.", phase: 0 },
				],
			} as any,
			repoDir,
			goalBranch,
			"master",
			new Map(),
			"Reproduce VER-04/W3.2 shared diff artifact",
		);

		const verification = gateState.signals[0].verification;
		assert.equal(verification?.status, "passed");
		assert.equal(capturedDiffArtifacts.length, 2, "both llm-review steps in the phase must have run");

		for (const artifact of capturedDiffArtifacts) {
			assert.ok(artifact, "VER-04_W3_2: each reviewer must receive a computed diff artifact");
			assert.match((artifact as any).diff, /NEW_FILE\.md/, "VER-04_W3_2: the shared artifact must contain the real branch diff");
		}
		assert.strictEqual(
			capturedDiffArtifacts[0], capturedDiffArtifacts[1],
			"VER-04_W3_2: both concurrent reviewers in the same phase must receive the IDENTICAL diffArtifact object — proving it was computed ONCE per verification run and shared, not re-derived per reviewer",
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
