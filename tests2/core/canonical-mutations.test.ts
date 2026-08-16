import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../../src/server/agent/project-registry.js";
import {
	CANONICAL_MUTATION_KEY,
	applyCanonicalGoalProposal,
	createCanonicalGoal,
	mutateCanonicalProject,
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

test("canonical project registration replays by server key and rolls back rejected configuration", async () => {
	const projects: Array<any> = [];
	let removed = 0;
	const deps = {
		findByApplicationKey: (key: string) => projects.find(project => project.key === key),
		register: (key?: string) => { const project = { id: `project-${projects.length}`, rootPath: "/project", key }; projects.push(project); return project; },
		get: (id: string) => projects.find(project => project.id === id),
		update: (id: string, updates: any) => Object.assign(projects.find(project => project.id === id), updates),
		promote: (id: string) => projects.find(project => project.id === id),
		applyConfiguration: () => undefined,
		removeRegistered: (project: any) => { removed++; projects.splice(projects.indexOf(project), 1); },
		removeContext: async () => undefined,
		openContext: async () => true,
		suspendServices: async () => undefined,
		stopServices: async () => undefined,
		reconcileServices: async () => undefined,
	};
	const input = { mode: "register" as const, name: "Project", rootPath: "/project", applicationKey: "project-key" };
	expect((await mutateCanonicalProject(input, deps)).replayed).toBe(false);
	expect((await mutateCanonicalProject(input, deps)).replayed).toBe(true);
	expect(projects).toHaveLength(1);
	await expect(mutateCanonicalProject({ mode: "register", name: "Project", rootPath: "/project" }, { ...deps, applyConfiguration: () => { throw new Error("invalid config"); } })).rejects.toThrow("invalid config");
	expect(removed).toBe(1);
	await expect(mutateCanonicalProject({ mode: "register", name: "Project", rootPath: "relative" }, deps)).rejects.toThrow("absolute");
});

test("canonical project registration single-flights success and failure", async () => {
	let projects: Array<any> = [];
	let registrations = 0;
	let fail = false;
	const deps = {
		findByApplicationKey: (key: string) => projects.find(project => project.key === key),
		register: (key?: string) => { registrations++; const project = { id: `project-${registrations}`, rootPath: "/project", key }; projects.push(project); return project; },
		get: () => undefined, update: () => undefined, promote: () => { throw new Error("unused"); },
		applyConfiguration: async () => { if (fail) throw new Error("configuration failed"); },
		removeRegistered: (project: any) => { projects = projects.filter(candidate => candidate !== project); }, removeContext: async () => undefined,
		openContext: async () => true, suspendServices: async () => undefined, stopServices: async () => undefined, reconcileServices: async () => undefined,
	};
	const input = { mode: "register" as const, name: "Project", rootPath: "/project", applicationKey: "key" };
	const [first, second] = await Promise.all([mutateCanonicalProject(input, deps), mutateCanonicalProject(input, deps)]);
	expect(registrations).toBe(1);
	expect(first.replayed).toBe(false);
	expect(second).toMatchObject({ project: first.project, replayed: true });
	projects = [];
	registrations = 0;
	fail = true;
	const failed = await Promise.allSettled([mutateCanonicalProject(input, deps), mutateCanonicalProject(input, deps)]);
	expect(registrations).toBe(1);
	expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
	expect((failed[0] as PromiseRejectedResult).reason).toBe((failed[1] as PromiseRejectedResult).reason);
	fail = false;
	expect((await mutateCanonicalProject(input, deps)).replayed).toBe(false);
	expect(registrations).toBe(2);
});

test("project registry persists and reloads only a valid server-owned canonical mutation key", () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-canonical-key-"));
	const root = path.join(stateDir, "project");
	fs.mkdirSync(root);
	try {
		const registry = new ProjectRegistry(stateDir);
		const project = registry.register("project", root);
		registry.setCanonicalMutationKey(project.id, "server-key:1");
		expect(new ProjectRegistry(stateDir).get(project.id)?.canonicalMutationKey).toBe("server-key:1");
		fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify([{ ...project, canonicalMutationKey: "not allowed spaces" }]));
		expect(new ProjectRegistry(stateDir).get(project.id)?.canonicalMutationKey).toBeUndefined();
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("canonical root replacement restores the immutable old root after a service failure", async () => {
	const project = { id: "project", rootPath: "/old" };
	const deps = {
		findByApplicationKey: () => undefined,
		register: () => project,
		get: () => project,
		update: (_id: string, updates: any) => Object.assign(project, updates),
		promote: () => project,
		applyConfiguration: () => undefined,
		removeRegistered: () => undefined,
		removeContext: async () => undefined,
		openContext: async () => true,
		suspendServices: async () => undefined,
		stopServices: async () => { throw new Error("service failure"); },
		reconcileServices: async () => undefined,
	};
	await expect(mutateCanonicalProject({ mode: "update", updates: { id: "project", rootPath: "/new" } }, deps)).rejects.toThrow("service failure");
	expect(project.rootPath).toBe("/old");
});
