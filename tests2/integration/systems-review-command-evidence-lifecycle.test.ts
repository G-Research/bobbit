// v2-native — genuine pre-review command-phase evidence through the normal gate lifecycle.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import { GateStore, type GateSignal } from "../../src/server/agent/gate-store.ts";
import { GoalManager } from "../../src/server/agent/goal-manager.ts";
import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.ts";
import {
	SYSTEMS_INTERACTION_REVIEW_PROMPT,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
	SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
} from "../../src/server/agent/systems-interaction-review-contract.ts";
import { SystemsReviewExecutionStore } from "../../src/server/agent/systems-review-store.ts";
import { FINAL_MUTATION_TARGET_CORRELATION_ENV } from "../../src/server/agent/systems-review-target-evidence.ts";
import type {
	SystemsReviewActionBehavior,
	SystemsReviewCoverageReadRecord,
	SystemsReviewEvidenceLocation,
	SystemsReviewStateBehavior,
	SystemsReviewTraceLayerName,
} from "../../src/server/agent/systems-review-types.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import type { VerificationCommandRunner, VerificationCommandSpawnSpec } from "../../src/server/agent/verification-command-runner.ts";
import type { Workflow, WorkflowGate } from "../../src/server/agent/workflow-store.ts";
import type { TrackedChild } from "../../src/server/agent/spawn-tree.ts";
import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.ts";
import { expect, test } from "./_e2e/in-process-harness.ts";

const temporaryRoots: string[] = [];
let sequence = 0;

function temporaryDirectory(prefix: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryRoots.push(directory);
	return directory;
}

async function git(runner: CommandRunner, cwd: string, ...args: string[]): Promise<string> {
	return (await runner.execFile("git", args, { cwd, encoding: "utf8" })).stdout.toString().trim();
}

function execOnly(runner: CommandRunner): CommandRunner {
	return { execFile: (file, args, options) => runner.execFile(file, args, options) };
}

async function repository(prefix: string): Promise<string> {
	await prepareGitTemplate();
	return copyGitTemplate(path.join(temporaryDirectory(prefix), "repo"));
}

async function commitFile(runner: CommandRunner, root: string, relativePath: string, content: string, message: string): Promise<void> {
	const target = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, "utf8");
	await git(runner, root, "add", "--", relativePath);
	await git(runner, root, "commit", "-m", message);
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class LifecycleChild extends EventEmitter {
	readonly stdout = Object.assign(new EventEmitter(), { destroy() {} });
	readonly stderr = Object.assign(new EventEmitter(), { destroy() {} });
	readonly pid = 980_000 + (++sequence);
	unref(): void {}
	kill(): boolean { return true; }
}

interface CommandOutcome {
	exitCode: number;
	stdout?: string;
	stderr?: string;
}

function lifecycleCommandRunner(
	execute: (spec: VerificationCommandSpawnSpec) => Promise<CommandOutcome>,
): VerificationCommandRunner {
	return {
		nonDurable: true,
		spawn(spec): TrackedChild {
			const child = new LifecycleChild();
			let killed = false;
			let closed = false;
			const close = (code: number | null, signal: NodeJS.Signals | null) => {
				if (closed) return;
				closed = true;
				child.emit("exit", code, signal);
				child.emit("close", code, signal);
			};
			setImmediate(async () => {
				try {
					const outcome = await execute(spec);
					if (outcome.stdout) child.stdout.emit("data", Buffer.from(outcome.stdout));
					if (outcome.stderr) child.stderr.emit("data", Buffer.from(outcome.stderr));
					close(outcome.exitCode, null);
				} catch (error) {
					child.stderr.emit("data", Buffer.from(error instanceof Error ? error.message : String(error)));
					close(1, null);
				}
			});
			const tracked: TrackedChild = {
				child: child as unknown as TrackedChild["child"],
				killed: () => killed,
				timedOut: () => false,
				markSurvival: () => undefined,
				killTree: () => {
					killed = true;
					setImmediate(() => close(null, "SIGTERM"));
				},
			};
			return tracked;
		},
	};
}

interface EffectFixture {
	goalManager: GoalManager;
	parentRoot: string;
	parentId: string;
	childId: string;
}

async function effectFixture(commandRunner: CommandRunner, conflict = false): Promise<EffectFixture> {
	const root = await repository("bobbit-systems-command-effect-");
	await git(commandRunner, root, "checkout", "-b", "child");
	if (conflict) {
		await commitFile(commandRunner, root, "README.md", "child version\n", "child conflicting change");
	} else {
		await commitFile(commandRunner, root, "child.txt", "child effect\n", "child effect");
	}
	await git(commandRunner, root, "checkout", "master");
	if (conflict) await commitFile(commandRunner, root, "README.md", "parent version\n", "parent conflicting change");

	const stateDir = temporaryDirectory("bobbit-systems-command-effect-state-");
	const store = new GoalStore(stateDir);
	const suffix = `${Date.now()}-${++sequence}`;
	const parentId = `effect-parent-${suffix}`;
	const childId = `effect-child-${suffix}`;
	const now = Date.now();
	store.put({
		id: parentId,
		title: "Effect parent",
		cwd: root,
		state: "in-progress",
		spec: "",
		createdAt: now,
		updatedAt: now,
		branch: "master",
		worktreePath: root,
		repoPath: root,
	});
	store.put({
		id: childId,
		title: "Effect child",
		cwd: root,
		state: "complete",
		spec: "",
		createdAt: now,
		updatedAt: now,
		branch: "child",
		worktreePath: root,
		repoPath: root,
		parentGoalId: parentId,
	});
	return {
		goalManager: new GoalManager(store, undefined, stateDir, { commandRunner }),
		parentRoot: root,
		parentId,
		childId,
	};
}

interface LifecycleScenario {
	label: string;
	commandName: "integration" | "unit";
	invoke: "success" | "conflict" | "none";
	commandExitCode?: number;
	expectFailure?: boolean;
	seedPassedCache?: boolean;
	expectEvidence: boolean;
}

interface LifecycleResult {
	stateDir: string;
	gateStatus: string;
	verification: NonNullable<GateSignal["verification"]>;
	order: string[];
	spawnCount: number;
	reviewerAssertionCount: number;
	executionId: string;
	execution: NonNullable<ReturnType<SystemsReviewExecutionStore["get"]>>;
	coverage: SystemsReviewCoverageReadRecord;
	effect?: EffectFixture;
}

function actionSource(): string {
	return [
		`import { FINAL_MUTATION_TARGET_ACTIONS, runWithFinalMutationTargetAction } from "./systems-review-target-evidence.js";`,
		`import { mergeChildBranchLocal } from "./git.js";`,
		`export async function mergeEveryRepo(repos: string[]) {`,
		`  return Promise.all(repos.map(repo => runWithFinalMutationTargetAction(`,
		`    FINAL_MUTATION_TARGET_ACTIONS.mergeChildGoal,`,
		`    { resolvedTarget: repo, resolvedScope: "branch:master" },`,
		`    () => mergeChildBranchLocal("master", "child", repo),`,
		`  )));`,
		`}`,
	].join("\n");
}

async function finalizeReview(
	harness: VerificationHarness,
	store: SystemsReviewExecutionStore,
	executionId: string,
	bootstrapSessionId: string,
	commandRunner: CommandRunner,
	assertionId?: string,
): Promise<{ verdict: "pass" | "fail"; report: string }> {
	const execution = store.get(executionId)!;
	const reader = store.reader(executionId, commandRunner);
	const patch = await reader.read({ operation: "patch", changeId: execution.snapshot.changes[0].id });
	const coveragePage = await reader.read({ operation: "coverage" });
	const coverage = (coveragePage.data as SystemsReviewCoverageReadRecord[])[0];
	const location: SystemsReviewEvidenceLocation = {
		repoId: execution.snapshot.repos[0].id,
		path: execution.snapshot.changes[0].newPath!,
		kind: "changed",
		receipts: [patch.receipt],
	};
	const layers: SystemsReviewTraceLayerName[] = ["control", "payload", "handler", "target-resolver", "final-side-effect"];
	const action: SystemsReviewActionBehavior = {
		kind: "action",
		id: "aggregate-merge",
		title: "Aggregate child merge",
		coverageItemIds: [coverage.id],
		layers: layers.map(layer => ({ layer, description: `${layer} target invariant`, locations: [location] })),
		change: "introduced",
		mutation: "destructive",
		aggregate: true,
		targetInvariant: "Every child merge reaches its resolved parent repository and branch.",
		tests: [{
			invariant: "The final Git adapter receives the exact parent repository and branch.",
			failureLayer: "final-side-effect",
			locations: [location],
			...(assertionId ? { exactTargetAssertionId: assertionId } : {}),
		}],
	};
	const stateLayers: SystemsReviewTraceLayerName[] = ["producer", "aggregation", "transport", "persistence", "consumer"];
	const state: SystemsReviewStateBehavior = {
		kind: "state",
		id: "aggregate-merge-state",
		title: "Aggregate child merge state",
		coverageItemIds: [coverage.id],
		layers: stateLayers.map(layer => ({ layer, description: `${layer} state invariant`, locations: [location] })),
		conservativeAggregateInvariant: "Positive aggregate state requires complete unanimous member results.",
		mixedStateMatrix: (["empty", "complete", "partial", "failed", "stale", "mixed-success"] as const)
			.map(value => ({ state: value, expected: `${value} remains explicit`, observed: `${value} remains explicit`, locations: [location] })),
		tests: [{ invariant: "All mixed aggregate states remain explicit.", failureLayer: "aggregation", locations: [location] }],
	};
	const checkpoint = await harness.submitSystemsReviewResult(bootstrapSessionId, {
		operation: "checkpoint",
		executionId,
		snapshotDigest: execution.snapshot.digest,
		contractDigest: execution.contractDigest,
		chunkId: execution.snapshot.chunks[0].id,
		coverageCursor: coveragePage.receipt,
		processedChangeIds: execution.snapshot.chunks[0].changeIds,
		receiptTokens: [patch.receipt, coveragePage.receipt],
		behaviors: [action, state],
		coverageMappings: [{ coverageItemId: coverage.id, behaviorIds: [action.id, state.id] }],
		findings: [],
		unresolvedLinks: [],
	});
	const accepted = await harness.submitSystemsReviewResult(bootstrapSessionId, {
		operation: "final",
		executionId,
		snapshotDigest: execution.snapshot.digest,
		contractDigest: execution.contractDigest,
		finalCheckpointDigest: checkpoint.checkpointDigest!,
		resolvedLinks: [],
	});
	const final = store.get(executionId)?.final;
	if (accepted.operation !== "final" || !accepted.verdict || !final) throw new Error("Systems finalization did not persist its report");
	return { verdict: accepted.verdict, report: final.report };
}

async function runLifecycle(commandRunner: CommandRunner, scenario: LifecycleScenario): Promise<LifecycleResult> {
	const snapshotRoot = await repository("bobbit-systems-command-snapshot-");
	await git(commandRunner, snapshotRoot, "checkout", "-b", "feature");
	await commitFile(commandRunner, snapshotRoot, "src/action.ts", `${actionSource()}\n`, "aggregate merge action");
	const headOid = await git(commandRunner, snapshotRoot, "rev-parse", "HEAD");
	const components = [{
		name: "app",
		repo: ".",
		commands: {
			integration: "node lifecycle-integration-command.mjs",
			unit: "node lifecycle-unit-command.mjs",
		},
	}];

	const stateDir = temporaryDirectory("bobbit-systems-command-state-");
	const goalStore = new GoalStore(stateDir);
	const gateStore = new GateStore(stateDir);
	const goalId = `review-goal-${Date.now()}-${++sequence}`;
	const signalId = `implementation-signal-${++sequence}`;
	const commandStep = {
		name: `Registered command — ${scenario.label}`,
		type: "command" as const,
		component: "app",
		command: scenario.commandName,
		phase: 0,
		...(scenario.expectFailure ? { expect: "failure" as const } : {}),
	};
	const systemsStep = {
		name: "Systems interaction review",
		type: "llm-review" as const,
		role: "systems-reviewer",
		reviewGroup: "specialist",
		phase: 1,
		promptRef: SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
		promptId: SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
		promptSha256: SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
		resolvedPrompt: SYSTEMS_INTERACTION_REVIEW_PROMPT,
	};
	const gate: WorkflowGate = {
		id: "implementation",
		name: "Implementation",
		dependsOn: [],
		verify: [commandStep, systemsStep],
	};
	const workflow: Workflow = {
		id: `systems-command-${scenario.label}`,
		name: "Systems command lifecycle",
		description: "Test-only frozen command evidence lifecycle.",
		gates: [gate],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	const goal: PersistedGoal = {
		id: goalId,
		title: "Systems command lifecycle",
		cwd: snapshotRoot,
		state: "in-progress",
		spec: "Exercise genuine command-phase exact-target evidence.",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		branch: "feature",
		worktreePath: snapshotRoot,
		repoPath: snapshotRoot,
		projectId: "systems-command-project",
		workflowId: workflow.id,
		workflow,
		enabledOptionalSteps: [],
	};
	goalStore.put(goal);
	gateStore.initGatesForGoal(goalId, [gate.id]);

	const effect = scenario.invoke === "none"
		? undefined
		: await effectFixture(commandRunner, scenario.invoke === "conflict");
	const order: string[] = [];
	let spawnCount = 0;
	let reviewerAssertionCount = -1;
	let executionId = "";
	let harness!: VerificationHarness;
	const projectConfigStore = {
		get: (key: string) => key === "base_ref" ? "master" : "",
		getWithDefaults: () => ({ base_ref: "master" }),
		getComponents: () => components,
	};
	const projectContext = {
		project: { id: "systems-command-project", name: "Systems command project", rootPath: snapshotRoot },
		goalStore,
		gateStore,
		projectConfigStore,
		goalManager: { resolveRootMaxConcurrentChildren: () => 3 },
	};
	const projectContextManager = {
		getContextForGoal: (candidate: string) => candidate === goalId ? projectContext : undefined,
	};
	const commandStepRunner = lifecycleCommandRunner(async spec => {
		spawnCount++;
		order.push("command:start");
		const active = harness.getActiveVerifications(goalId)[0];
		executionId = active.steps[1].systemsReviewExecutionId!;
		const token = spec.env?.[FINAL_MUTATION_TARGET_CORRELATION_ENV];
		if (scenario.commandName === "integration") expect(token).toBeTypeOf("string");
		else expect(token).toBeUndefined();

		if (effect) {
			const invoke = () => effect.goalManager.mergeChild(effect.parentId, effect.childId);
			const outcome = token
				? await harness.runWithSystemsReviewTargetCorrelation(token, invoke)
				: await invoke();
			if (scenario.invoke === "success") expect(outcome.merged || outcome.alreadyMerged).toBe(true);
			if (scenario.invoke === "conflict") expect(outcome.conflict).toBe(true);
		}
		order.push("command:end");
		const failed = scenario.commandExitCode === 1;
		return {
			exitCode: failed ? 1 : 0,
			stdout: failed ? undefined : "registered command completed\n",
			stderr: failed ? "EXPECTED_COMMAND_FAILURE\n" : undefined,
		};
	});

	harness = new VerificationHarness(
		stateDir,
		gateStore,
		() => undefined,
		{ get: () => undefined, getAll: () => [] } as any,
		undefined,
		undefined,
		undefined,
		projectConfigStore as any,
		projectContextManager as any,
		undefined,
		{ commandRunner, commandStepRunner },
	);
	const store = (harness as any).systemsReviewStore as SystemsReviewExecutionStore;
	(harness as any).runLlmReviewStep = async (
		_step: unknown,
		_cwd: string,
		_builtinVars: unknown,
		_signalContent: unknown,
		_signalMetadata: unknown,
		_goalSpec: unknown,
		_allGateStates: unknown,
		_goalId: string,
		reviewerSessionId: string,
	) => {
		order.push("reviewer:start");
		const coveragePage = await store.reader(executionId, commandRunner).read({ operation: "coverage" });
		const coverage = (coveragePage.data as SystemsReviewCoverageReadRecord[])[0];
		reviewerAssertionCount = coverage.eligibleTargetAssertions.length;
		expect(reviewerAssertionCount).toBe(scenario.expectEvidence ? 1 : 0);
		const final = await finalizeReview(
			harness,
			store,
			executionId,
			`systems-review-bootstrap-${signalId}`,
			commandRunner,
			coverage.eligibleTargetAssertions[0]?.assertionId,
		);
		expect(final.verdict).toBe(scenario.expectEvidence ? "pass" : "fail");
		return {
			passed: final.verdict === "pass",
			output: final.report,
			sessionId: reviewerSessionId,
		};
	};

	if (scenario.seedPassedCache) {
		gateStore.recordSignal({
			id: `cached-${signalId}`,
			goalId,
			gateId: gate.id,
			sessionId: "cached-owner",
			timestamp: Date.now() - 1,
			commitSha: headOid,
			verification: {
				status: "passed",
				steps: [
					{ name: commandStep.name, type: "command", passed: true, status: "passed", phase: 0, output: "cached command", duration_ms: 1 },
					{ name: systemsStep.name, type: "llm-review", passed: true, status: "passed", phase: 1, output: "cached review", duration_ms: 1 },
				],
			},
		});
	}
	const signal: GateSignal = {
		id: signalId,
		goalId,
		gateId: gate.id,
		sessionId: "signal-owner",
		timestamp: Date.now(),
		commitSha: headOid,
		metadata: scenario.expectFailure ? { error_pattern: "EXPECTED_COMMAND_FAILURE" } : {},
		verification: { status: "running", steps: [] },
	};
	signal.verification!.steps = harness.beginVerification(signal, gate);
	gateStore.recordSignal(signal);
	await harness.verifyGateSignal(signal, gate, snapshotRoot, "feature", "master", new Map(), goal.spec);

	const persistedSignal = gateStore.getGate(goalId, gate.id)!.signals.find(candidate => candidate.id === signal.id)!;
	if (!executionId) {
		throw new Error(`Command phase did not start: ${JSON.stringify(persistedSignal.verification)}`);
	}
	const execution = store.get(executionId)!;
	const coveragePage = await store.reader(executionId, commandRunner).read({ operation: "coverage" });
	const coverage = (coveragePage.data as SystemsReviewCoverageReadRecord[])[0];
	return {
		stateDir,
		gateStatus: gateStore.getGate(goalId, gate.id)!.status,
		verification: persistedSignal.verification!,
		order,
		spawnCount,
		reviewerAssertionCount,
		executionId,
		execution,
		coverage,
		effect,
	};
}

test("normal implementation-gate lifecycle captures the real GoalManager.mergeChild target before reviewer launch", async ({ gateway }) => {
	const commandRunner = execOnly(gateway.sessionManager.commandRunner as CommandRunner);
	const result = await runLifecycle(commandRunner, {
		label: "happy path",
		commandName: "integration",
		invoke: "success",
		seedPassedCache: true,
		expectEvidence: true,
	});

	expect(result.spawnCount).toBe(1);
	expect(result.order).toEqual(["command:start", "command:end", "reviewer:start"]);
	expect(result.gateStatus, JSON.stringify(result.verification)).toBe("passed");
	expect(result.verification).toMatchObject({
		status: "passed",
		steps: [
			{ status: "passed", output: expect.not.stringContaining("cached from prior signal") },
			{ status: "passed" },
		],
	});
	expect(result.coverage).toMatchObject({
		requiresActionTrace: true,
		requiresExactTargetEvidence: true,
		requiredTargetActionIds: ["bobbit.goal.merge-child"],
		requiredTargetAdapterIds: ["bobbit.git.merge-child"],
		requiredTargetEffectKinds: ["git-merge"],
	});
	expect(result.coverage.eligibleTargetAssertions).toHaveLength(1);
	const assertion = result.execution.targetAssertions[0];
	expect(assertion).toMatchObject({
		actionId: "bobbit.goal.merge-child",
		testKind: "integration",
		expectedTarget: fs.realpathSync.native(result.effect!.parentRoot),
		expectedScope: "branch:master",
		adapterIds: ["bobbit.git.merge-child"],
		effectKinds: ["git-merge"],
		effectOutcome: "succeeded",
	});
	expect(assertion.evidence.attempts).toEqual([
		expect.objectContaining({
			resolvedTarget: fs.realpathSync.native(result.effect!.parentRoot),
			resolvedScope: "branch:master",
			effectKind: "git-merge",
			attempt: 1,
		}),
	]);

	const restarted = new SystemsReviewExecutionStore(result.stateDir);
	const durableCoverage = await restarted.reader(result.executionId, commandRunner).read({ operation: "coverage" });
	expect((durableCoverage.data as SystemsReviewCoverageReadRecord[])[0].eligibleTargetAssertions)
		.toEqual(result.coverage.eligibleTargetAssertions);
});

test("normal lifecycle fails closed for unit, zero-action, and failed-command runs", async ({ gateway }) => {
	const commandRunner = execOnly(gateway.sessionManager.commandRunner as CommandRunner);
	const scenarios: LifecycleScenario[] = [
		{ label: "unit command", commandName: "unit", invoke: "success", expectEvidence: false },
		{ label: "zero action", commandName: "integration", invoke: "none", expectEvidence: false },
		{ label: "failed command", commandName: "integration", invoke: "success", commandExitCode: 1, expectEvidence: false },
	];

	for (const scenario of scenarios) {
		const result = await runLifecycle(commandRunner, scenario);
		expect(result.coverage.eligibleTargetAssertions, scenario.label).toEqual([]);
		expect(result.execution.targetAssertions, scenario.label).toEqual([]);
		expect(result.gateStatus, scenario.label).toBe("failed");
		if (scenario.commandExitCode === 1 && !scenario.expectFailure) {
			expect(result.verification.steps[0].status, scenario.label).toBe("failed");
			expect(result.verification.steps[1].status, scenario.label).toBe("skipped");
			expect(result.reviewerAssertionCount, scenario.label).toBe(-1);
			expect(result.execution.failure?.code, scenario.label).toBe("SYSTEMS_REVIEW_NOT_RUN");
		} else {
			expect(result.verification.steps[0].status, scenario.label).toBe("passed");
			expect(result.verification.steps[1].status, scenario.label).toBe("failed");
			expect(result.reviewerAssertionCount, scenario.label).toBe(0);
			expect(result.execution.final?.verdict, scenario.label).toBe("fail");
			expect(result.execution.final?.blockingFindingIds.length, scenario.label).toBeGreaterThan(0);
		}
	}
});
