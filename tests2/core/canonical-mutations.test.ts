import { expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectRegistry } from "../../src/server/agent/project-registry.js";
import {
	CANONICAL_MUTATION_KEY,
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
	const first = await createCanonicalGoal(input, deps);
	await Promise.resolve();
	const replay = await createCanonicalGoal(input, deps);
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
