/**
 * Shared test fixture for `runSubgoalStep` unit tests.
 *
 * Builds a VerificationHarness with a stubbed projectContextManager whose
 * getContextForGoal() returns an in-memory {goalStore, goalManager, gateStore}.
 *
 * The fixture exposes:
 *   - harness     — VerificationHarness instance
 *   - goalManager — real GoalManager wired to an in-memory GoalStore
 *   - goalStore   — direct access to the persisted-goals layer
 *   - gateStore   — for stubbing ready-to-merge state
 *   - calls       — recorded createGoal / updateGoal / mergeChild / etc. call list
 *                   in order (used by stamp-immediately invariant test)
 *   - mockTeamManager — captures teardownTeam calls
 *
 * The harness's `_subgoalHooks` are wired by default to a stubbed
 * waitForReadyToMerge that resolves to "passed" after one tick (so the
 * default happy-path tests don't poll the real gate).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../../src/server/agent/goal-store.ts";
import { GoalManager } from "../../src/server/agent/goal-manager.ts";
import { GateStore } from "../../src/server/agent/gate-store.ts";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../../src/server/agent/workflow-store.ts";
import { VerificationHarness } from "../../src/server/agent/verification-harness.ts";
import type { GoalCandidateDeps } from "../../src/server/agent/goal-candidate-validator.ts";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";

export type OwnedSubgoalRunResult = Awaited<ReturnType<VerificationHarness["runSubgoalStep"]>>;

export type CallRecord =
	| { kind: "createGoal"; title: string; opts: any }
	| { kind: "updateGoal"; id: string; updates: any }
	| { kind: "mergeChild"; parentId: string; childId: string }
	| { kind: "archiveGoalAfterMerge"; childId: string }
	| { kind: "teardownTeam"; goalId: string }
	| { kind: "_persistActive" };

export interface Fixture {
	harness: VerificationHarness;
	goalManager: GoalManager;
	goalStore: GoalStore;
	gateStore: GateStore;
	calls: CallRecord[];
	mockTeamManager: {
		teardownTeam: (goalId: string) => Promise<void>;
		registerReviewerSession: (...args: any[]) => Promise<void>;
		unregisterReviewerSession: (...args: any[]) => Promise<void>;
	};
	parent: PersistedGoal;
	tmpRoot: string;
	cleanup: () => void;
	/**
	 * Launch and immediately observe a run owned by this fixture. Consumers still
	 * receive the original promise, while settleRuns retains rejection visibility.
	 */
	launchRun: (
		step: any,
		run: ReturnType<typeof buildActive>,
		afterSettled?: () => void,
	) => Promise<OwnedSubgoalRunResult>;
	/** Mark every active fixture-owned run cancelled. */
	cancelRuns: () => void;
	/** Join every fixture-owned run without turning a rejection into an unhandled promise. */
	settleRuns: () => Promise<PromiseSettledResult<OwnedSubgoalRunResult>[]>;
	/** Override the default ready-to-merge hook (returns "passed" by default). */
	setReadyToMergeHook: (
		fn: (childGoalId: string, signal: { aborted: boolean }) => Promise<"passed" | "archived-complete" | "archived-other" | "cancelled" | "timeout">,
	) => void;
	setSetupHook: (fn: (childGoalId: string) => Promise<void>) => void;
	/** Override mergeChild's outcome (default merged=true). */
	setMergeOutcome: (outcome: { merged?: boolean; alreadyMerged?: boolean; conflict?: boolean; output?: string }) => void;
}

export interface FixtureOptions {
	parentOver?: Partial<PersistedGoal>;
	/** Skip auto-creating a parent goal (used by tests that want a custom tree). */
	skipParent?: boolean;
}

export async function buildFixture(opts: FixtureOptions = {}): Promise<Fixture> {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-subgoal-step-"));
	const stateDir = path.join(tmpRoot, "state");
	const configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));

	const goalStore = new GoalStore(stateDir, undefined, { persistence: "json" });
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([
		{
			id: "feature", name: "Feature", description: "",
			gates: [
				{ id: "design-doc", name: "Design", dependsOn: [], content: true, injectDownstream: true },
				{ id: "implementation", name: "Implementation", dependsOn: ["design-doc"] },
				{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["implementation"] },
			],
			createdAt: 0, updatedAt: 0,
		},
		{
			id: "general", name: "General", description: "",
			gates: [{ id: "g", name: "G", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		},
	]);
	// The fixture root is deliberately not a repository. Avoid spawning a real
	// git probe so this unit fixture behaves identically under load and on every OS.
	const nonGitCommandRunner: CommandRunner = {
		execFile: async () => { throw Object.assign(new Error("fixture path is not a git repository"), { code: 128 }); },
	};
	const realGm = new GoalManager(goalStore, wf, undefined, { commandRunner: nonGitCommandRunner });

	const calls: CallRecord[] = [];
	let mergeOutcome: { merged?: boolean; alreadyMerged?: boolean; conflict?: boolean; output?: string } = { merged: true, alreadyMerged: false, conflict: false, output: "" };

	// Snapshot the originals — we'll install the wrappers AFTER the parent
	// goal is created so its createGoal call doesn't pollute the recorded
	// call sequence. The wrappers route through the realGm.
	const realCreate = realGm.createGoal.bind(realGm);
	const realCreateFromPreflight = realGm.createGoalFromPreflight.bind(realGm);
	const realUpdate = realGm.updateGoal.bind(realGm);
	const realArchiveAfterMerge = realGm.archiveGoalAfterMerge.bind(realGm);
	const installWrappers = () => {
		const wrappedGm = realGm as any;
		wrappedGm.createGoal = async (title: string, cwd: string, options?: any) => {
			calls.push({ kind: "createGoal", title, opts: options });
			return realCreate(title, cwd, options);
		};
		wrappedGm.createGoalFromPreflight = (title: string, cwd: string, options: any) => {
			calls.push({ kind: "createGoal", title, opts: options });
			return realCreateFromPreflight(title, cwd, options);
		};
		wrappedGm.updateGoal = async (id: string, updates: any) => {
			calls.push({ kind: "updateGoal", id, updates });
			return realUpdate(id, updates);
		};
		wrappedGm.mergeChild = async (parentId: string, childId: string) => {
			calls.push({ kind: "mergeChild", parentId, childId });
			return { ...mergeOutcome, pushed: false } as any;
		};
		wrappedGm.archiveGoalAfterMerge = async (childId: string) => {
			calls.push({ kind: "archiveGoalAfterMerge", childId });
			return realArchiveAfterMerge(childId);
		};
	};

	const gateStore = new GateStore(stateDir);

	const ctx = {
		goalStore,
		goalManager: realGm,
		gateStore,
		workflowStore: wf,
		project: { id: "p" } as any,
		projectConfigStore: cfg,
	};
	const projectContextManager: any = {
		getContextForGoal: (_id: string) => ctx,
		all: () => [ctx],
	};
	const goalCandidateDeps: GoalCandidateDeps = {
		registry: {
			get: (projectId: string) => projectId === "p" ? {
				id: "p", name: "Project", rootPath: tmpRoot, createdAt: 0,
				colorLight: "", colorDark: "",
			} : undefined,
		} as any,
		projectContextManager,
		workflows: () => wf.getAll(),
		workflow: (_projectId, workflowId) => wf.get(workflowId),
		defaultWorkflows: () => wf.getAll(),
		components: () => cfg.getComponents(),
		getGoal: (goalId) => goalStore.get(goalId),
		nestingPrefs: () => ({ subgoalsEnabled: true, maxNestingDepth: 5 }),
	};

	const mockTeamManager = {
		teardownTeam: async (goalId: string) => { calls.push({ kind: "teardownTeam", goalId }); },
		registerReviewerSession: async () => {},
		unregisterReviewerSession: async () => {},
	};

	const harness = new VerificationHarness(
		stateDir,
		undefined,
		() => {},
		{ get: () => null, getAll: () => [] } as any,
		// Stub preferencesStore — enable subgoals by default so the
		// nesting-limit gate in runSubgoalStep does not block fixture-driven
		// spawn tests. (Production callers carry a real PreferencesStore.)
		{ get: (k: string) => k === "subgoalsEnabled" ? true : null } as any,
		undefined,
		mockTeamManager as any,
		undefined,
		projectContextManager,
		undefined,
		{ goalCandidateDeps },
	);
	// Default: ready-to-merge passes immediately.
	let readyHook: (childGoalId: string, signal: { aborted: boolean }) => Promise<"passed" | "archived-complete" | "archived-other" | "cancelled" | "timeout"> =
		async () => "passed";
	let setupHook: ((childGoalId: string) => Promise<void>) | undefined = async () => {};
	(harness as any)._subgoalHooks = {
		get waitForReadyToMerge() { return readyHook; },
		get setupChildAndStartTeam() { return setupHook; },
	};

	let parent: PersistedGoal;
	if (!opts.skipParent) {
		parent = await realGm.createGoal("Parent", tmpRoot, {
			workflowId: "feature",
			projectId: "p",
			...(opts.parentOver?.spec !== undefined ? { spec: opts.parentOver.spec } : {}),
		});
		// Stamp projectId on the persisted record (createGoal accepts the field
		// in opts but doesn't write it onto the goal — the REST handler does).
		// Apply any other overrides via store.update.
		const { spec: _spec, ...restOver } = opts.parentOver ?? {};
		goalStore.update(parent.id, { projectId: "p", ...restOver } as any);
		parent = goalStore.get(parent.id)!;
	} else {
		parent = undefined as any;
	}

	// Install wrappers AFTER the parent has been created — otherwise the
	// parent's createGoal would pollute the call sequence used by stamp-immediately invariant.
	installWrappers();

	const ownedRuns: Array<{
		active: ReturnType<typeof buildActive>["active"];
		settlement: Promise<PromiseSettledResult<OwnedSubgoalRunResult>>;
	}> = [];

	return {
		harness,
		goalManager: realGm,
		goalStore,
		gateStore,
		calls,
		mockTeamManager,
		parent,
		tmpRoot,
		cleanup() {
			goalStore.dispose();
			gateStore.dispose();
			try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
		},
		launchRun(step, run, afterSettled) {
			const launched = harness.runSubgoalStep(step, run.signal, run.active, run.stepIndex);
			// Preserve the caller's direct-settlement callback ordering (some tests
			// use it to delimit semaphore occupancy) while observing both branches.
			const promise = afterSettled
				? launched.then(
					value => { afterSettled(); return value; },
					reason => { afterSettled(); throw reason; },
				)
				: launched;
			// Attach rejection observation in the launch turn. A later assertion or
			// retry must not abandon a rejection until suite cleanup eventually joins it.
			const settlement = Promise.allSettled([promise]).then(([result]) => result);
			ownedRuns.push({ active: run.active, settlement });
			return promise;
		},
		cancelRuns() {
			for (const run of ownedRuns) run.active.cancelled = true;
		},
		settleRuns() {
			return Promise.all(ownedRuns.map(run => run.settlement));
		},
		setReadyToMergeHook(fn) { readyHook = fn; },
		setSetupHook(fn) { setupHook = fn; },
		setMergeOutcome(out) { mergeOutcome = { merged: false, alreadyMerged: false, conflict: false, output: "", ...out }; },
	};
}

/**
 * Build a synthetic ActiveVerification with one subgoal step. Mirrors the
 * shape produced by `verifyGateSignal`'s init block.
 */
export function buildActive(parentId: string, _planId = "p1"): {
	signal: any;
	active: any;
	stepIndex: number;
} {
	const signal = {
		id: "sig-1",
		gateId: "execution",
		goalId: parentId,
		sessionId: "team-lead",
		timestamp: Date.now(),
		commitSha: "abc",
		verification: { status: "running" as const, steps: [] },
	};
	const active = {
		goalId: parentId,
		gateId: "execution",
		signalId: "sig-1",
		steps: [{ name: "Subgoal", type: "subgoal", status: "running" as const, startedAt: Date.now() }],
		overallStatus: "running" as const,
		startedAt: Date.now(),
	};
	return { signal, active, stepIndex: 0, };
}

/**
 * Build a default subgoal step.
 */
export function buildSubgoalStep(over: Partial<{ planId: string; title: string; spec: string; workflowId: string; suggestedRole: string; dependsOn: string[] }> = {}): any {
	return {
		name: "Subgoal: build feature X",
		type: "subgoal",
		subgoal: {
			planId: over.planId ?? "p1",
			title: over.title ?? "Build feature X",
			spec: over.spec ?? "Implement and verify feature X as described in the parent goal spec.\n\n## Acceptance criteria\n- foo",
			...(over.workflowId !== undefined ? { workflowId: over.workflowId } : {}),
			...(over.suggestedRole !== undefined ? { suggestedRole: over.suggestedRole } : {}),
			...(over.dependsOn !== undefined ? { dependsOn: over.dependsOn } : {}),
		},
	};
}
