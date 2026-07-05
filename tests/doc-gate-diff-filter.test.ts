/**
 * Integration test for the VER-06 / W3.4 deterministic doc-gate skip filter,
 * exercised against a real git repo (not just the pure `evaluateDocGateSkip`
 * unit tests in verification-logic.test.ts).
 *
 * Pins:
 *   - a diff that touches only test/fixture paths is auto-skipped with a
 *     logged "test-fixture-only" rule.
 *   - a diff that also touches a src/ path always runs the full review
 *     ("fail toward reviewing").
 *   - `BOBBIT_DOC_GATE_FILTER=off` disables the filter entirely, regardless
 *     of the diff shape.
 *
 * See:
 *   - `src/server/agent/verification-logic.ts::evaluateDocGateSkip`
 *   - `src/server/agent/verification-harness.ts::_maybeSkipDocGateReview`
 *   - `tests/verification-basebranch-regression.test.ts` (fixture pattern this mirrors)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

function makeTempStateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-gate-filter-state-"));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Bare remote + working clone on `master`, with a `goalBranch` checked out
 * locally so `_getDocGateChangedPaths` can diff `origin/master...goalBranch`
 * without needing to push (the harness call itself is offline-safe).
 */
function makeRepoWithGoalBranch(): { repoDir: string; goalBranch: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-gate-filter-repo-"));
	const remoteDir = path.join(root, "remote.git");
	const repoDir = path.join(root, "repo");
	const goalBranch = "goal/doc-gate-filter-test";

	execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: remoteDir, stdio: "ignore" });
	execFileSync("git", ["clone", remoteDir, repoDir], { stdio: "ignore" });
	git(repoDir, ["checkout", "-B", "master"]);
	fs.writeFileSync(path.join(repoDir, "README.md"), "base\n");
	git(repoDir, ["add", "README.md"]);
	git(repoDir, ["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test", "commit", "-m", "Initial commit"]);
	git(repoDir, ["push", "-u", "origin", "master"]);
	git(repoDir, ["checkout", "-b", goalBranch]);

	return { repoDir, goalBranch };
}

function commitFiles(repoDir: string, files: Record<string, string>, message: string): void {
	for (const [rel, contents] of Object.entries(files)) {
		const full = path.join(repoDir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, contents);
		git(repoDir, ["add", rel]);
	}
	git(repoDir, ["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test", "commit", "-m", message]);
}

function makeHarness() {
	return new VerificationHarness(
		makeTempStateDir(),
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
	);
}

function withDocGateFilterEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
	const original = process.env.BOBBIT_DOC_GATE_FILTER;
	if (value === undefined) delete process.env.BOBBIT_DOC_GATE_FILTER;
	else process.env.BOBBIT_DOC_GATE_FILTER = value;
	return fn().finally(() => {
		if (original === undefined) delete process.env.BOBBIT_DOC_GATE_FILTER;
		else process.env.BOBBIT_DOC_GATE_FILTER = original;
	});
}

test("doc-gate step is auto-skipped when the diff touches only test/fixture paths", async () => {
	const { repoDir, goalBranch } = makeRepoWithGoalBranch();
	commitFiles(repoDir, {
		"tests/new-thing.test.ts": "// a new unit test\n",
		"tests/fixtures/sample.json": "{}\n",
	}, "Add tests only");

	const harness = makeHarness();
	await withDocGateFilterEnv(undefined, async () => {
		const decision = await (harness as any)._maybeSkipDocGateReview(
			{ docGate: true, name: "Documentation coverage" },
			repoDir, "master", goalBranch,
		);
		assert.ok(decision, "expected the doc-gate step to be skipped for a test-only diff");
		assert.equal(decision.skip, true);
		assert.match(decision.rule, /test-fixture-only/);
	});
});

test("doc-gate step is NOT skipped when the diff touches a src/ path (fail toward reviewing)", async () => {
	const { repoDir, goalBranch } = makeRepoWithGoalBranch();
	commitFiles(repoDir, {
		"tests/new-thing.test.ts": "// a new unit test\n",
		"src/server/agent/widget.ts": "export const widget = 1;\n",
	}, "Add test + src change");

	const harness = makeHarness();
	await withDocGateFilterEnv(undefined, async () => {
		const decision = await (harness as any)._maybeSkipDocGateReview(
			{ docGate: true, name: "Documentation coverage" },
			repoDir, "master", goalBranch,
		);
		assert.equal(decision, null, "a src/-touching diff must always run the full doc review");
	});
});

test("doc-gate step is NOT skipped for a docs-only diff (the gate exists to review exactly this)", async () => {
	const { repoDir, goalBranch } = makeRepoWithGoalBranch();
	commitFiles(repoDir, {
		"docs/new-feature.md": "# New feature\n\nDocs for the new feature.\n",
	}, "Add docs only");

	const harness = makeHarness();
	await withDocGateFilterEnv(undefined, async () => {
		const decision = await (harness as any)._maybeSkipDocGateReview(
			{ docGate: true, name: "Documentation coverage" },
			repoDir, "master", goalBranch,
		);
		assert.equal(decision, null, "a docs-only diff must still run the doc review");
	});
});

test("a non-docGate llm-review step is never subject to the filter", async () => {
	const { repoDir, goalBranch } = makeRepoWithGoalBranch();
	commitFiles(repoDir, { "tests/new-thing.test.ts": "// test\n" }, "Add test only");

	const harness = makeHarness();
	await withDocGateFilterEnv(undefined, async () => {
		const decision = await (harness as any)._maybeSkipDocGateReview(
			{ docGate: false, name: "Code quality review" },
			repoDir, "master", goalBranch,
		);
		assert.equal(decision, null, "non-docGate steps must never be auto-skipped by this filter");
	});
});

test("BOBBIT_DOC_GATE_FILTER=off disables the filter even for a test-only diff", async () => {
	const { repoDir, goalBranch } = makeRepoWithGoalBranch();
	commitFiles(repoDir, { "tests/new-thing.test.ts": "// test\n" }, "Add test only");

	const harness = makeHarness();
	await withDocGateFilterEnv("off", async () => {
		const decision = await (harness as any)._maybeSkipDocGateReview(
			{ docGate: true, name: "Documentation coverage" },
			repoDir, "master", goalBranch,
		);
		assert.equal(decision, null, "BOBBIT_DOC_GATE_FILTER=off must force the full review to run");
	});
});
