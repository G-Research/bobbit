import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

const { VerificationHarness } = await import("../src/server/agent/verification-harness.js");

function makeTempStateDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-basebranch-regression-"));
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return stateDir;
}

function makeLocalGitRepoWithoutOrigin(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-no-origin-regression-"));
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["checkout", "-B", "master"], { cwd: root, stdio: "ignore" });
	fs.writeFileSync(path.join(root, "README.md"), "local-only verification repo\n");
	execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test", "commit", "-m", "Initial commit"], { cwd: root, stdio: "ignore" });
	assert.throws(() => execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, stdio: "pipe" }));
	return root;
}

function makeCloneWithLocalOnlyGoalBranch(): { root: string; repoDir: string; goalBranch: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verif-local-only-origin-regression-"));
	const remoteDir = path.join(root, "remote.git");
	const seedDir = path.join(root, "seed");
	const repoDir = path.join(root, "repo");
	const goalBranch = "goal/local-only-regression";

	execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: remoteDir, stdio: "ignore" });
	execFileSync("git", ["init", seedDir], { stdio: "ignore" });
	execFileSync("git", ["checkout", "-B", "master"], { cwd: seedDir, stdio: "ignore" });
	fs.writeFileSync(path.join(seedDir, "README.md"), "published master only\n");
	execFileSync("git", ["add", "README.md"], { cwd: seedDir, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Bobbit Test", "-c", "user.email=bobbit@example.test", "commit", "-m", "Initial commit"], { cwd: seedDir, stdio: "ignore" });
	execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: seedDir, stdio: "ignore" });
	execFileSync("git", ["push", "-u", "origin", "master"], { cwd: seedDir, stdio: "ignore" });

	execFileSync("git", ["clone", remoteDir, repoDir], { stdio: "ignore" });
	execFileSync("git", ["checkout", "-b", goalBranch], { cwd: repoDir, stdio: "ignore" });
	assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).trim(), goalBranch);
	assert.throws(() => execFileSync("git", ["ls-remote", "--exit-code", "--heads", "origin", goalBranch], { cwd: repoDir, stdio: "pipe" }));
	return { root, repoDir, goalBranch };
}

function makeProjectConfigStore(baseRef: string) {
	return {
		get: (key: string) => key === "base_ref" ? baseRef : "",
		getWithDefaults: () => ({
			build_command: "npm run build",
			test_command: "npm test",
			typecheck_command: "npm run check",
			test_unit_command: "npm run test:unit",
			test_e2e_command: "npm run test:e2e",
			base_ref: baseRef,
		}),
		getComponents: () => [],
	};
}

function makeGateStore(signal: any) {
	const gateState: any = {
		goalId: signal.goalId,
		gateId: signal.gateId,
		status: "pending",
		signals: [signal],
	};
	return {
		getGate: () => gateState,
		getGatesForGoal: () => [gateState],
		updateSignalVerification: (signalId: string, verification: any) => {
			const target = gateState.signals.find((s: any) => s.id === signalId);
			assert.ok(target, `test fixture missing signal ${signalId}`);
			target.verification = verification;
		},
		updateGateStatus: (_goalId: string, _gateId: string, status: string) => {
			gateState.status = status;
		},
		_gateState: gateState,
	};
}

function makeHarnessFixture(baseRef = "origin/master") {
	const signal = {
		id: "signal-basebranch",
		goalId: "goal-basebranch",
		gateId: "ready-to-merge",
		sessionId: "session-basebranch",
		timestamp: Date.now(),
		commitSha: "abcdef1234567890",
		content: "ready",
		metadata: {},
	};
	const gateStore = makeGateStore(signal);
	const goal = {
		id: signal.goalId,
		branch: "goal/basebranch-regression",
		cwd: process.cwd(),
		worktreePath: process.cwd(),
		spec: "Reproduce baseBranch verification regression",
		state: "in-progress",
		workflowId: "feature",
	};
	const projectConfigStore = makeProjectConfigStore(baseRef);
	const projectContextManager = {
		getContextForGoal: (goalId: string) => goalId === signal.goalId ? {
			project: { id: "project-basebranch" },
			goalStore: { get: (id: string) => id === signal.goalId ? goal : undefined },
			gateStore,
			projectConfigStore,
		} : null,
	};
	const harness = new VerificationHarness(
		makeTempStateDir(),
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		projectConfigStore as any,
		projectContextManager as any,
	);
	return { harness, signal, gateStore, goal };
}

test("local-only verification does not warn when origin remote is absent", async () => {
	const repoDir = makeLocalGitRepoWithoutOrigin();
	const { harness, signal, gateStore } = makeHarnessFixture("origin/master");
	const warnings: string[] = [];
	const originalWarn = console.warn;
	(harness as any).runCommandStep = async (command: string) => ({ passed: true, output: `executed ${command}` });
	console.warn = (...args: any[]) => {
		warnings.push(args.map(arg => typeof arg === "string" ? arg : inspect(arg)).join(" "));
	};

	try {
		await harness.verifyGateSignal(
			signal as any,
			{
				id: "ready-to-merge",
				name: "Ready to Merge",
				dependsOn: [],
				verify: [{
					name: "Local command still runs",
					type: "command",
					run: "echo local-only-verification",
				}],
			} as any,
			repoDir,
			"goal/no-origin-regression",
			"master",
			new Map(),
			"Reproduce no-origin verification warning regression",
		);
	} finally {
		console.warn = originalWarn;
		fs.rmSync(repoDir, { recursive: true, force: true });
	}

	const verification = gateStore._gateState.signals[0].verification;
	const warningOutput = warnings.join("\n");
	assert.equal(verification?.status, "passed");
	assert.doesNotMatch(
		warningOutput,
		/Failed to sync worktree from origin\/|Failed to fetch origin\/|fatal: 'origin' does not appear to be a git repository|does not appear to be a git repository/i,
		`NO_ORIGIN_VERIFICATION_REPRO: local-only verification without origin emitted noisy git remote sync warnings:\n${warningOutput}`,
	);
});

test("local-only goal branch with origin does not warn when remote goal ref is missing", async () => {
	const { root, repoDir, goalBranch } = makeCloneWithLocalOnlyGoalBranch();
	const { harness, signal, gateStore } = makeHarnessFixture("origin/master");
	const warnings: string[] = [];
	const originalWarn = console.warn;
	(harness as any).runCommandStep = async (command: string) => ({ passed: true, output: `executed ${command}` });
	console.warn = (...args: any[]) => {
		warnings.push(args.map(arg => typeof arg === "string" ? arg : inspect(arg)).join(" "));
	};

	try {
		await harness.verifyGateSignal(
			signal as any,
			{
				id: "ready-to-merge",
				name: "Ready to Merge",
				dependsOn: [],
				verify: [{
					name: "Local command still runs",
					type: "command",
					run: "echo local-only-goal-branch-with-origin",
				}],
			} as any,
			repoDir,
			goalBranch,
			"master",
			new Map(),
			"Reproduce local-only goal branch remote-ref warning regression",
		);
	} finally {
		console.warn = originalWarn;
		fs.rmSync(root, { recursive: true, force: true });
	}

	const verification = gateStore._gateState.signals[0].verification;
	const warningOutput = warnings.join("\n");
	assert.equal(verification?.status, "passed");
	assert.doesNotMatch(
		warningOutput,
		/Failed to sync worktree from origin\/|couldn't find remote ref|fatal: couldn't find remote ref|remote ref .* not found/i,
		`LOCAL_ONLY_GOAL_BRANCH_ORIGIN_REPRO: verification of unpublished goal branch with origin emitted noisy remote-ref sync warnings:\n${warningOutput}`,
	);
});

test("ready-to-merge command templates resolve {{baseBranch}} from configured origin/master and execute", async () => {
	const { harness, signal, gateStore } = makeHarnessFixture("origin/master");
	let executedCommand: string | null = null;
	(harness as any).runCommandStep = async (command: string) => {
		executedCommand = command;
		return { passed: true, output: `executed ${command}` };
	};

	await harness.verifyGateSignal(
		signal as any,
		{
			id: "ready-to-merge",
			name: "Ready to Merge",
			dependsOn: [],
			verify: [{
				name: "Base branch must be normalized",
				type: "command",
				run: "node -e \"process.exit(process.argv[1] === 'master' ? 0 : 42)\" {{baseBranch}}",
			}],
		} as any,
		process.cwd(),
		undefined,
		"develop",
		new Map(),
		"Reproduce baseBranch verification regression",
	);

	const verification = gateStore._gateState.signals[0].verification;
	assert.ok(
		executedCommand,
		`BASE_BRANCH_REPRO: ready-to-merge command did not execute; {{baseBranch}} remained unresolved and was skipped. Verification output: ${verification?.steps?.[0]?.output ?? "<none>"}`,
	);
	assert.match(
		executedCommand,
		/\bmaster\b/,
		`BASE_BRANCH_REPRO: expected {{baseBranch}} to normalize project base_ref origin/master to bare branch "master", got command: ${executedCommand}`,
	);
	assert.doesNotMatch(
		executedCommand,
		/origin\/master|\bdevelop\b|\{\{baseBranch\}\}/,
		`BASE_BRANCH_REPRO: {{baseBranch}} must use normalized configured base_ref, not origin/master, detected primary, or an unresolved template. Command: ${executedCommand}`,
	);
	assert.equal(verification?.status, "passed");
});

test("ready-to-merge keeps {{master}} on detected primary when configured base_ref differs", async () => {
	const { harness, signal, gateStore } = makeHarnessFixture("origin/develop");
	let executedCommand: string | null = null;
	(harness as any).runCommandStep = async (command: string) => {
		executedCommand = command;
		return { passed: true, output: `executed ${command}` };
	};

	await harness.verifyGateSignal(
		signal as any,
		{
			id: "ready-to-merge",
			name: "Ready to Merge",
			dependsOn: [],
			verify: [{
				name: "Base branch and legacy master differ",
				type: "command",
				run: "echo base={{baseBranch}} master={{master}}",
			}],
		} as any,
		process.cwd(),
		undefined,
		"develop",
		new Map(),
		"Preserve legacy master template semantics",
	);

	const verification = gateStore._gateState.signals[0].verification;
	assert.equal(executedCommand, "echo base=develop master=master");
	assert.equal(verification?.status, "passed");
});

test("rerun verification context includes {{baseBranch}} from configured base_ref", async () => {
	const { harness, signal, gateStore } = makeHarnessFixture("origin/develop");
	gateStore._gateState.signals[0] = {
		...signal,
		verification: {
			status: "passed",
			steps: [{ name: "old", type: "command", passed: true, output: "ok", duration_ms: 1 }],
		},
	};

	const context = await (harness as any)._gatherRerunContext(signal.goalId, signal.gateId, signal.id);
	assert.ok(context, "BASE_BRANCH_REPRO: expected rerun context to resolve");
	assert.equal(
		context.builtinVars.baseBranch,
		"develop",
		`BASE_BRANCH_REPRO: rerun builtinVars must include baseBranch="develop" from base_ref origin/develop, got ${JSON.stringify(context.builtinVars)}`,
	);
	assert.equal(
		context.builtinVars.master,
		"master",
		`BASE_BRANCH_REPRO: legacy {{master}} must preserve detected-primary/fallback semantics instead of following configured base_ref origin/develop, got ${JSON.stringify(context.builtinVars)}`,
	);
});
