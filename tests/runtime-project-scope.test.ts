import fs from "node:fs";
import path from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { makeTmpDir } from "./helpers/tmp.ts";

const tmpRoot = makeTmpDir("runtime-project-scope-");

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

const { ProjectRegistry } = await import("../src/server/agent/project-registry.ts");
const { resolveProjectForRequest, validateExecutionCwd } = await import("../src/server/agent/resolve-project.ts");

function freshDir(name: string): string {
	const dir = path.join(tmpRoot, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("runtime project scoping", () => {
	it("requires explicit projectId and never resolves from cwd", () => {
		const stateDir = freshDir("state");
		const projectRoot = freshDir("project");
		const registry = new ProjectRegistry(stateDir);
		const project = registry.register("Project", projectRoot);

		const missing = resolveProjectForRequest(registry, { cwd: projectRoot } as { projectId?: unknown });
		assert.equal(missing.ok, false);
		if (!missing.ok) {
			assert.equal(missing.status, 400);
			assert.equal(missing.code, "PROJECT_ID_REQUIRED");
			assert.match(missing.error, /projectId required/);
		}

		const explicit = resolveProjectForRequest(registry, { projectId: project.id });
		assert.equal(explicit.ok, true);
		if (explicit.ok) assert.equal(explicit.projectId, project.id);
	});

	it("rejects hidden/system projects unless the caller explicitly allows system scope", () => {
		const stateDir = freshDir("state");
		const systemRoot = freshDir("system-root");
		const registry = new ProjectRegistry(stateDir);
		registry.registerSystemProject(systemRoot);

		const rejected = resolveProjectForRequest(registry, { projectId: "system" });
		assert.equal(rejected.ok, false);
		if (!rejected.ok) assert.equal(rejected.code, "PROJECT_NOT_VISIBLE");

		const allowed = resolveProjectForRequest(registry, { projectId: "system" }, { allowSystem: true });
		assert.equal(allowed.ok, true);
		if (allowed.ok) assert.equal(allowed.projectId, "system");
	});

	it("validates fresh user cwd inside the selected project only", () => {
		const stateDir = freshDir("state");
		const projectRoot = freshDir("project");
		const sibling = freshDir("sibling");
		const registry = new ProjectRegistry(stateDir);
		const project = registry.register("Project", projectRoot);
		const pcm = {} as any;

		assert.equal(
			validateExecutionCwd(registry, pcm, project.id, path.join(projectRoot, "subdir"), { kind: "user-input" }).ok,
			true,
		);
		const outside = validateExecutionCwd(registry, pcm, project.id, sibling, { kind: "user-input" });
		assert.equal(outside.ok, false);
		if (!outside.ok) assert.equal(outside.code, "CWD_OUTSIDE_PROJECT");
	});

	it("allows normal-project worktree cwd only when owned by the selected goal", () => {
		const stateDir = freshDir("state");
		const projectRoot = freshDir("project");
		const worktreeRoot = freshDir("project-wt");
		const registry = new ProjectRegistry(stateDir);
		const project = registry.register("Project", projectRoot);
		const goal = {
			id: "goal-1",
			title: "Goal",
			cwd: worktreeRoot,
			state: "todo",
			spec: "",
			createdAt: 1,
			updatedAt: 1,
			projectId: project.id,
			worktreePath: worktreeRoot,
		};
		const pcm = {
			getContextForGoal: (goalId: string) => goalId === goal.id ? { project, goalStore: { get: () => goal } } : null,
		} as any;

		assert.equal(
			validateExecutionCwd(registry, pcm, project.id, path.join(worktreeRoot, "pkg"), { kind: "goal", goalId: "goal-1" }).ok,
			true,
		);
		const userInput = validateExecutionCwd(registry, pcm, project.id, worktreeRoot, { kind: "user-input" });
		assert.equal(userInput.ok, false);
		if (!userInput.ok) assert.equal(userInput.code, "CWD_OUTSIDE_PROJECT");
	});

	it("keeps Headquarters cwd constrained to its physical Headquarters root", () => {
		const stateDir = freshDir("state");
		const serverRoot = freshDir("server-root");
		const hqRoot = path.join(serverRoot, ".bobbit", "headquarters");
		fs.mkdirSync(hqRoot, { recursive: true });
		const registry = new ProjectRegistry(stateDir);
		const hq = registry.ensureHeadquartersProject(hqRoot, {
			stateDir: path.join(hqRoot, "state"),
			configDir: path.join(hqRoot, "config"),
		});
		const pcm = {} as any;

		assert.equal(
			validateExecutionCwd(registry, pcm, hq.id, path.join(hqRoot, "sessions"), { kind: "user-input" }).ok,
			true,
		);
		const serverCwd = validateExecutionCwd(registry, pcm, hq.id, serverRoot, { kind: "user-input" });
		assert.equal(serverCwd.ok, false);
		if (!serverCwd.ok) assert.equal(serverCwd.code, "CWD_OUTSIDE_PROJECT");
	});
});
