/**
 * Reproducing E2E for the worker-scoped default-project loss flake.
 *
 * Current behavior: after a test deletes all visible projects in the same
 * worker, createSession()/createGoal() omit projectId and fail with the
 * project-resolution 400. After the harness fix, these helpers should
 * re-create or re-resolve the default project and succeed.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, createSession, deleteGoal, deleteSession } from "./e2e-setup.js";

test.describe.configure({ mode: "serial" });

async function listVisibleProjects(): Promise<Array<{ id: string; name?: string; hidden?: boolean }>> {
	const resp = await apiFetch("/api/projects");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	const projects: Array<{ id: string; hidden?: boolean }> = Array.isArray(body)
		? body
		: (body.projects ?? []);
	return projects.filter(p => !p.hidden);
}

async function drainVisibleProjects(): Promise<void> {
	for (const project of await listVisibleProjects()) {
		const resp = await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
		expect(resp.status, `delete project ${project.id}`).toBe(200);
	}
	expect(await listVisibleProjects(), "visible projects after drain").toEqual([]);
}

test("createSession without explicit projectId survives default project deletion", async () => {
	await drainVisibleProjects();

	let sessionId: string | undefined;
	try {
		sessionId = await createSession();
		expect(sessionId).toBeTruthy();
	} finally {
		if (sessionId) await deleteSession(sessionId);
	}
});

test("createGoal without explicit projectId survives default project deletion", async () => {
	await drainVisibleProjects();

	let goalId: string | undefined;
	try {
		const goal = await createGoal({ title: "Default Project Loss Repro" });
		goalId = goal.id as string;
		expect(goalId).toBeTruthy();
	} finally {
		if (goalId) await deleteGoal(goalId);
	}
});

test("one test may drain all visible projects", async () => {
	await drainVisibleProjects();
});

test("the next test sees a restored default project with workflows", async () => {
	const projects = await listVisibleProjects();
	const defaultProject = projects.find(p => p.name === "default");
	expect(defaultProject?.id, "harness default project should be restored between tests").toBeTruthy();

	let goalId: string | undefined;
	try {
		const goal = await createGoal({ title: "Default Project Restore Repro" });
		goalId = goal.id as string;
		expect(goalId).toBeTruthy();
	} finally {
		if (goalId) await deleteGoal(goalId);
	}
});
