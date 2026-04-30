/**
 * E2E tests for nested-goals REST routes (Phase 2 task 2.2):
 *   - POST /api/goals/:id/spawn-child
 *   - POST /api/goals/:id/integrate-child/:childGoalId
 *   - POST /api/goals/:id/pause
 *   - POST /api/goals/:id/resume
 *
 * Pre-Phase-5 contract: spawn-child does NOT consult the mutation
 * classifier. Single-project enforcement comes from `GoalManager.createGoal`.
 *
 * The integrate-child happy/conflict tests register a fresh git project so
 * goal worktrees are real on disk; pause/resume and the spawn-child shape
 * test stay worktree-less for speed.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, defaultProjectId, nonGitCwd, readE2EToken, wsBase } from "./e2e-setup.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { pollUntil } from "./test-utils/cleanup.js";

let _counter = 0;
function uniqueDir(label: string): string {
	return mkdtempSync(join(tmpdir(), `bobbit-spawn-child-${label}-${Date.now()}-${++_counter}-`));
}

function gitInit(dir: string): void {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet", "-b", "master"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@bobbit.local"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "x\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
}

async function registerGitProject(name: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = uniqueDir(name);
	gitInit(rootPath);
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, upsert: true }),
	});
	if (resp.status >= 300) {
		const text = await resp.text().catch(() => "");
		throw new Error(`registerGitProject ${name} failed: ${resp.status} ${text}`);
	}
	const proj = await resp.json();
	return { id: proj.id, rootPath };
}

async function createGoalRaw(body: Record<string, unknown>): Promise<Response> {
	return apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

async function getGoal(id: string): Promise<any> {
	const r = await apiFetch(`/api/goals/${id}`);
	return r.json();
}

async function pollGoalReady(id: string, timeoutMs = 60_000): Promise<any> {
	return pollUntil(async () => {
		const g = await getGoal(id);
		if (g?.setupStatus === "error") throw new Error(`Goal ${id} setup errored: ${JSON.stringify(g)}`);
		return g?.setupStatus === "ready" ? g : null;
	}, { timeoutMs, intervalMs: 250, label: `goal ${id} setup ready` });
}

/**
 * Open a viewer-only WebSocket and collect every event matching `predicate`.
 * Returns an `{ ready, finish }` pair so callers can: `await ready` (WS
 * authenticated), trigger their action, then `await finish()` to drain
 * matching events for `durationMs` and close.
 */
async function openWsCollector(
	predicate: (msg: any) => boolean,
): Promise<{ finish: (durationMs?: number) => Promise<any[]> }> {
	const events: any[] = [];
	const ws = new WebSocket(`${wsBase()}/ws/__viewer__`);
	await new Promise<void>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("WS auth timeout")), 5_000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "auth", token: readE2EToken(), sessionId: "__viewer__" }));
		});
		ws.on("message", (raw: Buffer) => {
			let msg: any;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			if (msg?.type === "auth_ok") { clearTimeout(t); resolve(); return; }
			if (msg && predicate(msg)) events.push(msg);
		});
		ws.on("error", (err) => { clearTimeout(t); reject(err); });
	});
	return {
		finish: async (durationMs = 500) => {
			await new Promise(r => setTimeout(r, durationMs));
			ws.close();
			return events;
		},
	};
}

test.describe("Nested-goals REST — spawn-child / integrate-child / pause / resume", () => {
	test("spawn-child happy path: child carries parentGoalId/rootGoalId/mergeTarget=parent", async () => {
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();

		const parentResp = await createGoalRaw({
			title: `Spawn Parent ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();

		try {
			const collector = await openWsCollector(m => m.type === "goal_child_spawned");
			const spawnResp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({
					title: `Child via spawn ${Date.now()}`,
					spec: "child spec",
					workflowId: "general",
					planId: "plan-step-1",
				}),
			});
			expect(spawnResp.status).toBe(201);
			const spawn = await spawnResp.json();
			expect(spawn.childGoalId).toBeTruthy();
			expect(spawn.planId).toBe("plan-step-1");

			const child = await getGoal(spawn.childGoalId);
			expect(child.parentGoalId).toBe(parent.id);
			expect(child.rootGoalId).toBe(parent.id);
			expect(child.mergeTarget).toBe("parent");
			expect(child.projectId).toBe(parent.projectId);

			const events = await collector.finish(800);
			const matching = events.find(e => e.parentGoalId === parent.id && e.childGoalId === spawn.childGoalId);
			expect(matching, `expected goal_child_spawned event for ${parent.id}/${spawn.childGoalId}`).toBeTruthy();
			expect(matching.planId).toBe("plan-step-1");

			await apiFetch(`/api/goals/${spawn.childGoalId}`, { method: "DELETE" }).catch(() => { });
		} finally {
			await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" }).catch(() => { });
		}
	});

	test("spawn-child rejects archived parent with 409", async () => {
		const projectId = await defaultProjectId();
		const parentResp = await createGoalRaw({
			title: `Archived Spawn Parent ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();

		const delResp = await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" });
		expect(delResp.status).toBe(200);

		const spawnResp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({ title: "Child", spec: "x" }),
		});
		expect(spawnResp.status).toBe(409);
		const body = await spawnResp.json();
		expect(String(body.error).toLowerCase()).toContain("archived");
	});

	test("spawn-child rejects unknown parent with 404", async () => {
		const resp = await apiFetch("/api/goals/00000000-0000-0000-0000-000000000000/spawn-child", {
			method: "POST",
			body: JSON.stringify({ title: "Orphan", spec: "x" }),
		});
		expect(resp.status).toBe(404);
	});

	test("spawn-child requires title — 400 when missing", async () => {
		const projectId = await defaultProjectId();
		const parentResp = await createGoalRaw({
			title: `No-title parent ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();
		try {
			const resp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
				method: "POST",
				body: JSON.stringify({ spec: "no title" }),
			});
			expect(resp.status).toBe(400);
			const body = await resp.json();
			expect(String(body.error).toLowerCase()).toContain("title");
		} finally {
			await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" }).catch(() => { });
		}
	});

	test("pause/resume flip the flag and broadcast WS events", async () => {
		const projectId = await defaultProjectId();
		const goalResp = await createGoalRaw({
			title: `Pause/Resume Goal ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			worktree: false,
			workflowId: "general",
			projectId,
			autoStartTeam: false,
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();
		try {
			expect(goal.paused).toBeFalsy();

			// Pause.
			const pauseCollector = await openWsCollector(m => m.type === "goal_paused" && m.goalId === goal.id);
			const pauseResp = await apiFetch(`/api/goals/${goal.id}/pause`, { method: "POST" });
			expect(pauseResp.status).toBe(200);
			expect(await pauseResp.json()).toEqual({ paused: true });
			const afterPause = await getGoal(goal.id);
			expect(afterPause.paused).toBe(true);
			const pauseEvents = await pauseCollector.finish(800);
			expect(pauseEvents.length).toBeGreaterThanOrEqual(1);
			expect(pauseEvents[0].by).toBe("user");

			// Resume.
			const resumeCollector = await openWsCollector(m => m.type === "goal_resumed" && m.goalId === goal.id);
			const resumeResp = await apiFetch(`/api/goals/${goal.id}/resume`, { method: "POST" });
			expect(resumeResp.status).toBe(200);
			expect(await resumeResp.json()).toEqual({ paused: false });
			const afterResume = await getGoal(goal.id);
			expect(afterResume.paused).toBe(false);
			const resumeEvents = await resumeCollector.finish(800);
			expect(resumeEvents.length).toBeGreaterThanOrEqual(1);
		} finally {
			await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => { });
		}
	});

	test("pause/resume return 404 for unknown goal", async () => {
		const fake = "00000000-0000-0000-0000-000000000000";
		const r1 = await apiFetch(`/api/goals/${fake}/pause`, { method: "POST" });
		expect(r1.status).toBe(404);
		const r2 = await apiFetch(`/api/goals/${fake}/resume`, { method: "POST" });
		expect(r2.status).toBe(404);
	});

	test("integrate-child happy path: clean merge of child branch into parent branch", async () => {
		const project = await registerGitProject("integrate-happy");
		// Parent goal needs a real worktree (team: true).
		const parentResp = await createGoalRaw({
			title: `Integrate Parent ${Date.now()}`,
			cwd: project.rootPath,
			team: true,
			worktree: true,
			workflowId: "general",
			projectId: project.id,
			autoStartTeam: false,
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();
		await pollGoalReady(parent.id);

		// Spawn a child — REST endpoint kicks off async worktree setup that
		// branches off the parent's tip.
		const spawnResp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				title: `Integrate Child ${Date.now()}`,
				spec: "child spec",
				workflowId: "general",
				planId: "merge-happy-1",
			}),
		});
		expect(spawnResp.status).toBe(201);
		const { childGoalId } = await spawnResp.json();
		const child = await pollGoalReady(childGoalId);
		expect(child.worktreePath).toBeTruthy();
		expect(child.branch).toBeTruthy();

		try {
			// Make a unique commit on the child worktree so the merge has
			// content to bring across.
			writeFileSync(join(child.worktreePath, "child.txt"), "from child\n");
			execFileSync("git", ["add", "child.txt"], { cwd: child.worktreePath });
			execFileSync("git", ["commit", "-m", "child commit", "--quiet"], { cwd: child.worktreePath });

			const integrateResp = await apiFetch(`/api/goals/${parent.id}/integrate-child/${childGoalId}`, {
				method: "POST",
			});
			expect(integrateResp.status).toBe(200);
			const result = await integrateResp.json();
			expect(result.merged).toBe(true);
			expect(typeof result.commitSha).toBe("string");
			expect(result.commitSha.length).toBeGreaterThan(0);

			// Verify the merge commit landed on parent.branch in parent.worktreePath.
			const log = execFileSync("git", ["log", "--format=%H %s", "-3"], { cwd: parent.worktreePath, encoding: "utf-8" });
			expect(log).toContain(`Merge child ${child.branch} into ${parent.branch}`);
		} finally {
			await apiFetch(`/api/goals/${childGoalId}`, { method: "DELETE" }).catch(() => { });
			await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" }).catch(() => { });
			rmSync(project.rootPath, { recursive: true, force: true });
		}
	});

	test("integrate-child conflict path returns 409 with conflict body", async () => {
		const project = await registerGitProject("integrate-conflict");
		const parentResp = await createGoalRaw({
			title: `Conflict Parent ${Date.now()}`,
			cwd: project.rootPath,
			team: true,
			worktree: true,
			workflowId: "general",
			projectId: project.id,
			autoStartTeam: false,
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();
		await pollGoalReady(parent.id);

		const spawnResp = await apiFetch(`/api/goals/${parent.id}/spawn-child`, {
			method: "POST",
			body: JSON.stringify({
				title: `Conflict Child ${Date.now()}`,
				spec: "child spec",
				workflowId: "general",
				planId: "merge-conflict-1",
			}),
		});
		expect(spawnResp.status).toBe(201);
		const { childGoalId } = await spawnResp.json();
		const child = await pollGoalReady(childGoalId);

		try {
			// Both branches modify CONFLICT.txt with incompatible content.
			writeFileSync(join(child.worktreePath, "CONFLICT.txt"), "child line\n");
			execFileSync("git", ["add", "CONFLICT.txt"], { cwd: child.worktreePath });
			execFileSync("git", ["commit", "-m", "child writes CONFLICT.txt", "--quiet"], { cwd: child.worktreePath });

			writeFileSync(join(parent.worktreePath, "CONFLICT.txt"), "parent line\n");
			execFileSync("git", ["add", "CONFLICT.txt"], { cwd: parent.worktreePath });
			execFileSync("git", ["commit", "-m", "parent writes CONFLICT.txt", "--quiet"], { cwd: parent.worktreePath });

			const integrateResp = await apiFetch(`/api/goals/${parent.id}/integrate-child/${childGoalId}`, {
				method: "POST",
			});
			expect(integrateResp.status).toBe(409);
			const body = await integrateResp.json();
			expect(body.merged).toBe(false);
			expect(body.conflict).toBe(true);
			expect(typeof body.output).toBe("string");
			expect(body.output.length).toBeGreaterThan(0);

			// Worktree should be clean after abort.
			const status = execFileSync("git", ["status", "--porcelain"], { cwd: parent.worktreePath, encoding: "utf-8" }).trim();
			expect(status).toBe("");
		} finally {
			await apiFetch(`/api/goals/${childGoalId}`, { method: "DELETE" }).catch(() => { });
			await apiFetch(`/api/goals/${parent.id}`, { method: "DELETE" }).catch(() => { });
			rmSync(project.rootPath, { recursive: true, force: true });
		}
	});
});
