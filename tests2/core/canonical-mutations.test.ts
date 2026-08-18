import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../../src/server/agent/project-registry.js";
import { SecretsStore } from "../../src/server/agent/secrets-store.js";
import { createGoalCreationLifecycle } from "../../src/server/proposals/goal-creation-lifecycle.js";
import {
	CANONICAL_MUTATION_KEY,
	applyCanonicalGoalProposal,
	applyCanonicalProjectProposal,
	createCanonicalGoal,
	validateProjectBaseRef,
} from "../../src/server/proposals/canonical-mutations.js";

test("canonical goal stamps a server key, overrides caller metadata, and replays one durable goal", async () => {
	const goals: Array<any> = [];
	const gates: string[][] = [];
	let flushed = 0;
	let lifecycle = 0;
	const deps = {
		findByApplicationKey: (key: string) => goals.find(goal => goal.metadata?.[CANONICAL_MUTATION_KEY] === key),
		create: async (_title: string, _cwd: string, options: any) => {
			const goal = { id: `goal-${goals.length}`, metadata: options.metadata, workflow: { gates: [{ id: "design" }] } };
			goals.push(goal);
			return goal;
		},
		update: () => undefined,
		initGates: (_id: string, ids: string[]) => gates.push(ids),
		flush: async () => { flushed++; },
		afterCreate: () => { lifecycle++; },
	};
	const input = {
		title: "Goal", cwd: "/project", projectId: "project", autoStartTeam: false,
		applicationKey: "server-key-1",
		options: { metadata: { [CANONICAL_MUTATION_KEY]: "caller-key", "example.keep": true } },
	};
	const [first, replay] = await Promise.all([
		createCanonicalGoal(input, deps),
		createCanonicalGoal(input, deps),
	]);
	await Promise.resolve();
	expect(first.replayed).toBe(false);
	expect(replay.replayed).toBe(true);
	expect(goals).toHaveLength(1);
	expect(goals[0].metadata).toEqual({ [CANONICAL_MUTATION_KEY]: "server-key-1", "example.keep": true });
	expect(gates).toEqual([["design"]]);
	expect(flushed).toBe(1);
	expect(lifecycle).toBe(1);

	const unkeyed = await createCanonicalGoal({
		title: "Unkeyed", cwd: "/project", autoStartTeam: false,
		options: { metadata: { [CANONICAL_MUTATION_KEY]: "forged" } },
	}, deps);
	expect(unkeyed.goal.metadata).toBeUndefined();
});

test("canonical proposal resolves registered workflow, inline roles, and optional steps before persisting", async () => {
	const goals: any[] = [];
	const gates: string[][] = [];
	let received: any;
	const workflow = { id: "registered", name: "Registered", description: "", gates: [{ id: "design", name: "Design", dependsOn: [], verify: [{ name: "lint", type: "command" as const, run: "echo lint", optional: true, optionalLabel: "Lint" }] }], createdAt: 1, updatedAt: 1 };
	const workflowStore = { get: (id: string) => id === workflow.id ? workflow : undefined, getAll: () => [workflow], put: () => undefined };
	const context: any = {
		goalManager: {
			getGoal: () => undefined,
			listGoals: () => goals,
			createGoal: async (_title: string, _cwd: string, options: any) => {
				received = options;
				const goal = { id: "proposal-goal", workflow: options.resolvedWorkflow, metadata: options.metadata };
				goals.push(goal);
				return goal;
			},
			updateGoal: () => undefined,
			getGoalStore: () => ({ flush: async () => undefined }),
		},
		gateStore: { initGatesForGoal: (_id: string, ids: string[]) => gates.push(ids), flush: async () => undefined },
		workflowStore,
		projectConfigStore: { getComponents: () => [] },
	};
	const result = await applyCanonicalGoalProposal({
		title: "Proposal", projectId: "project", cwd: "/project", workflowId: "registered",
		enabledOptionalSteps: ["lint", "stale hidden option"], inlineRoles: { reviewer: { name: "reviewer", label: "Reviewer", promptTemplate: "Review", accessory: "none", createdAt: 1, updatedAt: 1 } },
	}, {
		resolveProject: () => ({ id: "project", name: "Project", rootPath: "/project" }),
		validateCwd: () => undefined,
		getContext: () => context,
		findGoalAcrossProjects: () => undefined,
		getNestingPrefs: () => ({ subgoalsEnabled: false, maxNestingDepth: 3 }),
		findCascadeWorkflow: () => workflow,
		afterCreate: () => undefined,
	});
	await Promise.resolve();
	expect(result.replayed).toBe(false);
	expect(received).toMatchObject({ workflowId: "registered", enabledOptionalSteps: ["lint"] });
	expect(received.inlineRoles.reviewer.name).toBe("reviewer");
	expect(gates).toEqual([["design"]]);
});

test("canonical proposal ignores malformed optional steps", async () => {
	let received: any;
	const workflow = { id: "registered", name: "Registered", description: "", gates: [{ id: "gate", name: "Gate", dependsOn: [], verify: [] }], createdAt: 1, updatedAt: 1 };
	const context: any = {
		goalManager: { getGoal: () => undefined, listGoals: () => [], createGoal: async (_title: string, _cwd: string, options: any) => { received = options; return { id: "goal", workflow: options.resolvedWorkflow }; }, updateGoal: () => undefined, getGoalStore: () => ({ flush: async () => undefined }) },
		gateStore: { initGatesForGoal: () => undefined, flush: async () => undefined },
		workflowStore: { get: () => workflow, getAll: () => [workflow], put: () => undefined },
		projectConfigStore: { getComponents: () => [] },
	};
	await applyCanonicalGoalProposal({ title: "Proposal", cwd: "/project", workflowId: "registered", enabledOptionalSteps: ["valid", 1] }, {
		resolveProject: () => ({ id: "project", name: "Project", rootPath: "/project" }), validateCwd: () => undefined, getContext: () => context,
		findGoalAcrossProjects: () => undefined, getNestingPrefs: () => ({ subgoalsEnabled: false, maxNestingDepth: 3 }),
		findCascadeWorkflow: () => workflow, afterCreate: () => undefined,
	});
	expect(received.enabledOptionalSteps).toBeUndefined();
});

test("canonical goal rejects invalid creation input before persistence", async () => {
	const create = async () => ({ id: "goal", workflow: { gates: [] } });
	const deps = {
		findByApplicationKey: () => undefined,
		create,
		update: () => undefined,
		initGates: () => undefined,
		flush: async () => undefined,
		afterCreate: () => undefined,
	};
	await expect(createCanonicalGoal({ title: "", cwd: "/project", autoStartTeam: false, options: {} }, deps)).rejects.toThrow("title");
	await expect(createCanonicalGoal({ title: "Goal", cwd: "relative", autoStartTeam: false, options: {} }, deps)).rejects.toThrow("absolute");
});

test("canonical goal reports lifecycle scheduling failures instead of leaking an unhandled microtask", async () => {
	const errors: unknown[] = [];
	await createCanonicalGoal({ title: "Goal", cwd: "/project", autoStartTeam: false, options: {} }, {
		findByApplicationKey: () => undefined,
		create: async () => ({ id: "goal", workflow: { gates: [] } }),
		update: () => undefined,
		initGates: () => undefined,
		flush: async () => undefined,
		afterCreate: () => { throw new Error("lifecycle failure"); },
		onAfterCreateError: error => errors.push(error),
	});
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(errors).toHaveLength(1);
	expect(errors[0]).toBeInstanceOf(Error);
});

test("shared goal lifecycle reports setup scheduling failures and preserves ready worktrees", async () => {
	const broadcasts: Array<Record<string, unknown>> = [];
	const updates: Array<Record<string, unknown>> = [];
	let childStart = "started";
	let setupStatus = "ready";
	const goal = {
		id: "goal-lifecycle", projectId: "project", autoStartTeam: true,
		setupStatus: "preparing", state: "in-progress",
	} as any;
	const lifecycle = createGoalCreationLifecycle({
		getContextForGoal: () => ({ goalManager: {
			getGoal: () => ({ ...goal, setupStatus }),
			updateGoal: (_id, update) => { updates.push(update); },
			setupWorktree: async () => undefined,
			setupWorktreeAndStartTeam: async () => { throw new Error("team failed after worktree setup"); },
		} }),
		getContext: () => undefined,
		requestChildStart: () => childStart,
		startTeam: async () => undefined,
		broadcast: message => broadcasts.push(message),
		logLifecycleSchedulingError: () => undefined,
	});
	lifecycle.afterCreate(goal);
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(broadcasts).toEqual([{ type: "goal_setup_complete", goalId: goal.id }]);

	childStart = "capacity-blocked";
	broadcasts.length = 0;
	lifecycle.afterCreate(goal, "parent-goal");
	expect(updates).toEqual([{ state: "blocked" }]);
	expect(broadcasts).toEqual([{ type: "goal_state_changed", goalId: goal.id }]);

	setupStatus = "failed";
	broadcasts.length = 0;
	lifecycle.afterCreate(goal);
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(broadcasts).toEqual([{ type: "goal_setup_error", goalId: goal.id, error: "Error: team failed after worktree setup" }]);

	broadcasts.length = 0;
	lifecycle.onAfterCreateError(new Error("scheduler unavailable"), goal);
	expect(broadcasts).toEqual([{ type: "goal_setup_error", goalId: goal.id, error: "Error: scheduler unavailable" }]);
});

test("canonical goal single-flight shares failures and permits retry", async () => {
	const failure = new Error("create failed");
	let attempts = 0;
	const deps = {
		findByApplicationKey: () => undefined,
		create: async () => { attempts++; if (attempts === 1) throw failure; return { id: "goal", workflow: { gates: [] } }; },
		update: () => undefined, initGates: () => undefined, flush: async () => undefined, afterCreate: () => undefined,
	};
	const input = { title: "Goal", cwd: "/project", projectId: "project", autoStartTeam: false, applicationKey: "same-key", options: {} };
	const first = createCanonicalGoal(input, deps);
	const second = createCanonicalGoal(input, deps);
	await expect(first).rejects.toBe(failure);
	await expect(second).rejects.toBe(failure);
	expect(attempts).toBe(1);
	expect((await createCanonicalGoal(input, deps)).replayed).toBe(false);
	expect(attempts).toBe(2);
});

test("durable canonical goal replay does not re-run gates or lifecycle setup", async () => {
	const existing = { id: "goal", metadata: { [CANONICAL_MUTATION_KEY]: "key" }, workflow: { gates: [{ id: "gate" }] } };
	let gates = 0;
	let lifecycle = 0;
	const replay = await createCanonicalGoal({ title: "Goal", cwd: "/project", autoStartTeam: true, applicationKey: "key", options: {} }, {
		findByApplicationKey: () => existing, create: async () => { throw new Error("must not create"); }, update: () => undefined,
		initGates: () => { gates++; }, flush: async () => undefined, afterCreate: () => { lifecycle++; },
	});
	await Promise.resolve();
	expect(replay).toEqual({ goal: existing, replayed: true });
	expect(gates).toBe(0);
	expect(lifecycle).toBe(0);
});

test("project registry migrates legacy replay keys and keeps bounded append-only receipts", () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-canonical-key-"));
	const root = path.join(stateDir, "project");
	fs.mkdirSync(root);
	try {
		const registry = new ProjectRegistry(stateDir);
		const project = registry.register("project", root);
		registry.recordCanonicalMutationReceipt(project.id, "server-key:1");
		registry.recordCanonicalMutationReceipt(project.id, "server-key:2");
		const reloaded = new ProjectRegistry(stateDir);
		expect(reloaded.hasCanonicalMutationReceipt(project.id, "server-key:1")).toBe(true);
		expect(reloaded.hasCanonicalMutationReceipt(project.id, "server-key:2")).toBe(true);
		fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify([{ ...project, canonicalMutationKey: "legacy-key:1" }]));
		const migrated = new ProjectRegistry(stateDir);
		expect(migrated.hasCanonicalMutationReceipt(project.id, "legacy-key:1")).toBe(true);
		expect(migrated.get(project.id)?.canonicalMutationKey).toBeUndefined();

		// Legacy receipt migration is deliberately narrow: an old free-form field
		// must never become replay authority after a restart.
		fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify([{ ...project, canonicalMutationKey: "invalid legacy receipt with spaces" }]));
		const invalidLegacy = new ProjectRegistry(stateDir);
		expect(invalidLegacy.hasCanonicalMutationReceipt(project.id, "invalid legacy receipt with spaces")).toBe(false);
		expect(invalidLegacy.get(project.id)?.canonicalMutationKey).toBeUndefined();
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("ProjectRegistry exact snapshots restore provisional and import authority", () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-registry-snapshot-"));
	const root = path.join(stateDir, "project");
	fs.mkdirSync(root);
	try {
		const registry = new ProjectRegistry(stateDir);
		const provisional = registry.registerProvisional("Draft", root);
		registry.setCanonicalMutationKey(provisional.id, "draft-key");
		const snapshot = registry.captureExactRecord(provisional.id)!;
		registry.promote(provisional.id, { name: "Published" });
		registry.markImportDecisionRunReady(provisional.id, registry.get(provisional.id)!.importDecisionRun!.id);
		registry.restoreExactRecord(provisional.id, snapshot);
		expect(new ProjectRegistry(stateDir).get(provisional.id)).toEqual(snapshot);
	} finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test("canonical project proposal validates before registration, publishes full config, and replays one keyed application", async () => {
	const projects: any[] = [];
	let mutations = 0;
	const store = {
		components: [] as any[], workflows: undefined as any,
		getComponents() { return this.components; },
		captureRollbackSnapshot() { return { components: [...this.components], workflows: this.workflows }; },
		restoreRollbackSnapshot(snapshot: any) { this.components = [...snapshot.components]; this.workflows = snapshot.workflows; },
		mutate(fn: any) { mutations++; fn({ setComponents: (value: any) => { this.components = value; }, setWorkflows: (value: any) => { this.workflows = value; }, set: () => undefined, remove: () => undefined, setConfigDirectories: () => undefined, setSandboxTokens: () => undefined }); },
	};
	const deps: any = {
		findByApplicationKey: (key: string) => projects.find(project => project.key === key),
		register: (input: any) => { const project = { id: `project-${projects.length}`, name: input.name, rootPath: input.rootPath, key: input.applicationKey }; projects.push(project); return project; },
		get: (id: string) => projects.find(project => project.id === id), update: (id: string, updates: any) => Object.assign(projects.find(project => project.id === id), updates),
		promote: (id: string, updates: any) => Object.assign(projects.find(project => project.id === id), updates),
		removeRegistered: (project: any) => projects.splice(projects.indexOf(project), 1), removeContext: async () => undefined,
		openContext: async () => ({ projectConfigStore: store }), suspendServices: async () => undefined, stopServices: async () => undefined, reconcileServices: async () => undefined,
	};
	await expect(applyCanonicalProjectProposal({ mode: "register", name: "Bad", rootPath: "/project", components: [{ name: "bad", repo: "../escape" }] }, deps)).rejects.toThrow("unsafe");
	await expect(applyCanonicalProjectProposal({ mode: "register", name: "Forbidden", rootPath: "/project", config: { extension_grants: "[]" } }, deps)).rejects.toMatchObject({ code: "PROMPT_EXTENSION_CONFIG_FORBIDDEN", status: 422 });
	expect(projects).toHaveLength(0);
	const input = { mode: "register" as const, name: "Project", rootPath: "/project", applicationKey: "project-proposal-1", components: [{ name: "app", repo: ".", commands: { check: "npm run check" }, config: { qa_start_command: "npm start" } }] };
	const [first, replay] = await Promise.all([applyCanonicalProjectProposal(input, deps), applyCanonicalProjectProposal(input, deps)]);
	expect(first.replayed).toBe(false);
	expect(replay.replayed).toBe(true);
	expect(projects).toHaveLength(1);
	expect(store.components).toEqual([expect.objectContaining({ name: "app", commands: { check: "npm run check" } })]);
	expect(mutations).toBe(1);
});

test("canonical project proposal restores config and registry state after post-config failure", async () => {
	const project: any = { id: "project", name: "Old", rootPath: "/old", color: "old" };
	const store = {
		components: [{ name: "old", repo: "." }] as any[], getComponents() { return this.components; },
		captureRollbackSnapshot() { return { components: [...this.components] }; },
		restoreRollbackSnapshot(snapshot: any) { this.components = [...snapshot.components]; },
		mutate(fn: any) { fn({ setComponents: (value: any) => { this.components = value; }, set: () => undefined, remove: () => undefined, setWorkflows: () => undefined, setConfigDirectories: () => undefined, setSandboxTokens: () => undefined }); },
	};
	const deps: any = {
		findByApplicationKey: () => undefined, register: () => project, get: () => project, update: (_id: string, updates: any) => Object.assign(project, updates), promote: () => project, removeRegistered: () => undefined,
		removeContext: async () => undefined, openContext: async () => ({ projectConfigStore: store }), suspendServices: async () => undefined, stopServices: async () => undefined, reconcileServices: async () => undefined,
		afterConfigured: async () => { throw new Error("runtime failed"); },
	};
	await expect(applyCanonicalProjectProposal({ mode: "update", projectId: "project", name: "New", components: [{ name: "new", repo: "." }] }, deps)).rejects.toThrow("runtime failed");
	expect(project).toMatchObject({ name: "Old", rootPath: "/old", color: "old" });
	expect(store.components).toEqual([{ name: "old", repo: "." }]);
});

test("canonical project proposal restores config and exact secrets when secret publication fails", async () => {
	const project: any = { id: "project", name: "Old", rootPath: "/old", provisional: true, importDecisionRun: { id: "run", state: "configuring" }, canonicalMutationKey: "old-key" };
	const store: any = {
		components: [{ name: "old", repo: "." }], getComponents() { return this.components; }, getWithDefaults: () => ({ sandbox: "none" }),
		captureRollbackSnapshot() { return { components: structuredClone(this.components) }; }, restoreRollbackSnapshot(snapshot: any) { this.components = structuredClone(snapshot.components); },
		mutate(fn: any) { fn({ setComponents: (value: any) => { this.components = value; }, set: () => undefined, remove: () => undefined, setWorkflows: () => undefined, setConfigDirectories: () => undefined, setSandboxTokens: () => undefined }); },
	};
	const secrets = { data: { KEEP: "", OLD: "old" } as Record<string, string>, getAll() { return { ...this.data }; }, update: () => { throw new Error("secrets write failed"); }, restoreAll(snapshot: Record<string, string>) { this.data = { ...snapshot }; } };
	const deps: any = {
		findByApplicationKey: () => undefined, register: () => project, get: () => project, update: (_id: string, updates: any) => Object.assign(project, updates), promote: () => project, removeRegistered: () => undefined,
		captureRegistryRecord: () => structuredClone(project), restoreRegistryRecord: (_id: string, snapshot: any) => { Object.keys(project).forEach(key => delete project[key]); Object.assign(project, snapshot); },
		removeContext: async () => undefined, openContext: async () => ({ projectConfigStore: store, secretsStore: secrets }), suspendServices: async () => undefined, stopServices: async () => undefined, reconcileServices: async () => undefined,
	};
	await expect(applyCanonicalProjectProposal({ mode: "update", projectId: "project", components: [{ name: "new", repo: "." }], sandboxTokens: [{ key: "NEW", value: "secret" }] }, deps)).rejects.toThrow("Sandbox secret persistence failed");
	expect(store.components).toEqual([{ name: "old", repo: "." }]);
	expect(secrets.data).toEqual({ KEEP: "", OLD: "old" });
	expect(project).toEqual({ id: "project", name: "Old", rootPath: "/old", provisional: true, importDecisionRun: { id: "run", state: "configuring" }, canonicalMutationKey: "old-key" });
});

test("canonical project validates tag and missing base refs before any mutation", async () => {
	for (const scenario of [
		{ label: "tag", isTag: true, hasRef: true, expected: "not a tag" },
		{ label: "missing", isTag: false, hasRef: false, expected: "not present" },
	]) {
		const project: any = { id: `project-${scenario.label}`, name: "Old", rootPath: "/project" };
		let registryMutations = 0;
		let configMutations = 0;
		const store: any = {
			getComponents: () => [{ name: "app", repo: "." }],
			getWithDefaults: () => ({ sandbox: "none" }),
			captureRollbackSnapshot: () => ({}), restoreRollbackSnapshot: () => undefined,
			mutate: () => { configMutations++; },
		};
		const deps: any = {
			findByApplicationKey: () => undefined, register: () => project, get: () => project,
			update: (_id: string, updates: any) => { registryMutations++; Object.assign(project, updates); }, promote: () => project,
			removeRegistered: () => undefined, removeContext: async () => undefined,
			openContext: async () => ({ projectConfigStore: store }), suspendServices: async () => undefined,
			stopServices: async () => undefined, reconcileServices: async () => undefined,
			validateBaseRef: (input: any) => validateProjectBaseRef(input, {
				isGitRepo: async () => true,
				isTag: async () => scenario.isTag,
				hasRef: async () => scenario.hasRef,
			}),
		};
		await expect(applyCanonicalProjectProposal({ mode: "update", projectId: project.id, name: "New", config: { base_ref: "origin/develop" } }, deps))
			.rejects.toMatchObject({ message: expect.stringContaining(scenario.expected), status: 400 });
		expect(registryMutations, `${scenario.label} base_ref must not mutate the registry`).toBe(0);
		expect(configMutations, `${scenario.label} base_ref must not publish config`).toBe(0);
		expect(project.name).toBe("Old");
	}
});

test("rename-only canonical project updates do not touch a corrupt config store", async () => {
	const project: any = { id: "project", name: "Old", rootPath: "/project" };
	let captures = 0;
	const store: any = {
		getComponents: () => [{ name: "Old", repo: "." }], getWithDefaults: () => ({ sandbox: "none" }),
		captureRollbackSnapshot: () => { captures++; throw new Error("corrupt project.yaml at /private/project/project.yaml"); },
	};
	const deps: any = {
		findByApplicationKey: () => undefined, register: () => project, get: () => project,
		update: (_id: string, updates: any) => Object.assign(project, updates), promote: () => project,
		removeRegistered: () => undefined, removeContext: async () => undefined,
		openContext: async () => ({ projectConfigStore: store }), suspendServices: async () => undefined,
		stopServices: async () => undefined, reconcileServices: async () => undefined,
	};
	await expect(applyCanonicalProjectProposal({ mode: "update", projectId: "project", name: "Renamed" }, deps)).resolves.toMatchObject({ project: { name: "Renamed" } });
	expect(captures).toBe(0);
});

test("SecretsStore exact restore retains empty secret values", () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-secret-restore-"));
	try {
		const secrets = new SecretsStore(stateDir);
		secrets.set("empty", "");
		secrets.set("value", "before");
		const snapshot = secrets.getAll();
		secrets.update({ empty: "changed", added: "new" });
		secrets.restoreAll(snapshot);
		expect(secrets.getAll()).toEqual({ empty: "", value: "before" });
		expect(JSON.parse(fs.readFileSync(path.join(stateDir, "secrets.json"), "utf8"))).toEqual({ empty: "", value: "before" });
	} finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test("canonical project proposal restores the exact provisional registry row when mark-ready fails", async () => {
	const project: any = { id: "project", name: "Draft", rootPath: "/project", provisional: true, importDecisionRun: { id: "run", state: "configuring", createdAt: 1 }, canonicalMutationKey: "exact-key", color: "before", palette: "amber" };
	const store: any = { getComponents: () => [{ name: "draft", repo: "." }], getWithDefaults: () => ({ sandbox: "none" }), captureRollbackSnapshot: () => ({}), restoreRollbackSnapshot: () => undefined, mutate: () => undefined };
	const deps: any = {
		findByApplicationKey: () => undefined, register: () => project, get: () => project, update: (_id: string, updates: any) => Object.assign(project, updates),
		promote: (_id: string, updates: any) => { delete project.provisional; Object.assign(project, updates); project.importDecisionRun = { ...project.importDecisionRun, state: "configuring" }; return project; },
		markReady: () => { project.importDecisionRun.state = "ready"; throw new Error("marker failed"); }, removeRegistered: () => undefined,
		captureRegistryRecord: () => structuredClone(project), restoreRegistryRecord: (_id: string, snapshot: any) => { Object.keys(project).forEach(key => delete project[key]); Object.assign(project, snapshot); },
		removeContext: async () => undefined, openContext: async () => ({ projectConfigStore: store }), suspendServices: async () => undefined, stopServices: async () => undefined, reconcileServices: async () => undefined,
	};
	const before = structuredClone(project);
	await expect(applyCanonicalProjectProposal({ mode: "promote", projectId: "project", name: "Published" }, deps)).rejects.toThrow("marker failed");
	expect(project).toEqual(before);
});

test("canonical project proposal restores the old root when replacement services fail", async () => {
	const project: any = { id: "project", name: "Project", rootPath: "/old" };
	const store: any = { getComponents: () => [], captureRollbackSnapshot: () => ({}), restoreRollbackSnapshot: () => undefined, mutate: () => undefined };
	const deps: any = {
		findByApplicationKey: () => undefined, register: () => project, get: () => project,
		update: (_id: string, updates: any) => Object.assign(project, updates), promote: () => project, removeRegistered: () => undefined,
		removeContext: async () => undefined, openContext: async () => ({ projectConfigStore: store }), suspendServices: async () => undefined,
		stopServices: async () => { throw new Error("service failure"); }, reconcileServices: async () => undefined,
	};
	await expect(applyCanonicalProjectProposal({ mode: "update", projectId: "project", rootPath: "/new" }, deps)).rejects.toThrow("service failure");
	expect(project.rootPath).toBe("/old");
});
