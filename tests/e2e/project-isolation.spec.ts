/**
 * E2E tests: Project isolation — no default project fallback.
 *
 * Verifies that:
 * 1. Sessions are created with correct projectId and only visible via the correct project filter.
 * 2. Terminating a session removes it from the correct project's store (not the default).
 * 3. Goals with workflows have gates scoped to the correct project.
 * 4. Multi-project session lifecycle keeps data isolated per project.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd, waitForSessionStatus } from "./e2e-setup.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let _counter = 0;

/** Create a unique temp dir for a project root. */
function uniqueProjectDir(): string {
	const dir = join(nonGitCwd(), `proj-isolation-${Date.now()}-${++_counter}`);
	mkdirSync(dir, { recursive: true });
	// Create .bobbit/state so the project context can initialise stores
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	return dir;
}

/** Register a project via the REST API. */
async function registerProject(name: string): Promise<{ id: string; rootPath: string }> {
	const rootPath = uniqueProjectDir();
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath }),
	});
	expect(resp.status).toBe(201);
	const project = await resp.json();
	return { id: project.id, rootPath };
}

/** Remove a project (best-effort). */
async function removeProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Create a session in a specific project. */
async function createSessionInProject(
	projectRootPath: string,
	projectId: string,
): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: projectRootPath, projectId }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return data.id;
}

/** Get live sessions from the list endpoint. */
async function listSessions(projectId?: string): Promise<any[]> {
	let url = "/api/sessions";
	if (projectId) url += `?projectId=${projectId}`;
	const resp = await apiFetch(url);
	expect(resp.status).toBe(200);
	const body = await resp.json();
	return body.sessions ?? body;
}

/** Get the default project (server CWD project). */
async function getDefaultProject(): Promise<{ id: string; name: string }> {
	const resp = await apiFetch("/api/projects");
	expect(resp.status).toBe(200);
	const data = await resp.json();
	expect(data.length).toBeGreaterThan(0);
	return data[0];
}

test.describe("Project isolation — no default fallback", () => {
	test("session created in project B has correct projectId and is filtered correctly @smoke", async () => {
		const defaultProject = await getDefaultProject();
		const projectB = await registerProject(`isolation-B-${Date.now()}`);

		try {
			const sessionId = await createSessionInProject(projectB.rootPath, projectB.id);

			// Verify the session detail has the correct projectId
			const detailResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(detailResp.status).toBe(200);
			const detail = await detailResp.json();
			expect(detail.projectId).toBe(projectB.id);

			// Verify the session appears in project B's filtered list
			const sessionsB = await listSessions(projectB.id);
			expect(sessionsB.some((s: any) => s.id === sessionId)).toBe(true);

			// Verify the session does NOT appear in the default project's filtered list
			const sessionsDefault = await listSessions(defaultProject.id);
			expect(sessionsDefault.some((s: any) => s.id === sessionId)).toBe(false);

			// Clean up
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		} finally {
			await removeProject(projectB.id);
		}
	});

	test("terminated session is removed from the correct project store", async () => {
		const defaultProject = await getDefaultProject();
		const projectB = await registerProject(`isolation-term-${Date.now()}`);

		try {
			const sessionId = await createSessionInProject(projectB.rootPath, projectB.id);

			// Verify session is live and in project B
			const sessionsBeforeB = await listSessions(projectB.id);
			expect(sessionsBeforeB.some((s: any) => s.id === sessionId)).toBe(true);

			// Terminate
			const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			expect(delResp.status).toBe(200);

			// Verify session is no longer in project B's live list
			const sessionsAfterB = await listSessions(projectB.id);
			expect(sessionsAfterB.some((s: any) => s.id === sessionId)).toBe(false);

			// Verify session is not in the default project's live list either
			const sessionsAfterDefault = await listSessions(defaultProject.id);
			expect(sessionsAfterDefault.some((s: any) => s.id === sessionId)).toBe(false);

			// Verify the session doesn't appear in any project's list (it was fully removed)
			const allSessions = await listSessions();
			expect(allSessions.some((s: any) => s.id === sessionId)).toBe(false);

			// Verify no cross-contamination: archived/removed session must NOT appear
			// in the default project's archived list
			const archivedDefaultResp = await apiFetch(`/api/sessions?projectId=${defaultProject.id}&include=archived`);
			expect(archivedDefaultResp.status).toBe(200);
			const archivedDefaultBody = await archivedDefaultResp.json();
			const archivedDefault = archivedDefaultBody.sessions ?? archivedDefaultBody;
			expect(archivedDefault.some((s: any) => s.id === sessionId)).toBe(false);

			// If the session was archived (has agentSessionFile), verify it's in project B
			const archivedBResp = await apiFetch(`/api/sessions?projectId=${projectB.id}&include=archived`);
			expect(archivedBResp.status).toBe(200);
			const archivedBBody = await archivedBResp.json();
			const archivedB = archivedBBody.sessions ?? archivedBBody;
			const archivedInB = archivedB.some((s: any) => s.id === sessionId);
			// Session may have been removed (no agentSessionFile) rather than archived
			// — either way, it must not be in the default project
			if (archivedInB) {
				// If it was archived, verify it has the correct projectId
				const archivedSession = archivedB.find((s: any) => s.id === sessionId);
				expect(archivedSession.projectId).toBe(projectB.id);
			}
		} finally {
			await removeProject(projectB.id);
		}
	});

	test("goal creation and retrieval respects project isolation", async () => {
		const defaultProject = await getDefaultProject();
		const projectB = await registerProject(`isolation-goal-${Date.now()}`);

		let goalId: string | undefined;
		try {
			// Create a goal in project B
			const createResp = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `Isolation test goal ${Date.now()}`,
					spec: "Test spec for isolation",
					cwd: projectB.rootPath,
					projectId: projectB.id,
					team: false,
					worktree: false,
				}),
			});
			expect(createResp.status).toBe(201);
			const goal = await createResp.json();
			goalId = goal.id;
			expect(goal.projectId).toBe(projectB.id);

			// Verify the goal appears when filtered by project B
			const goalsB = await apiFetch(`/api/goals?projectId=${projectB.id}`);
			const goalsBBody = await goalsB.json();
			const goalsBList = goalsBBody.goals ?? goalsBBody;
			const foundInB = goalsBList.find((g: any) => g.id === goalId);
			expect(foundInB).toBeTruthy();
			expect(foundInB.projectId).toBe(projectB.id);

			// Verify the goal does NOT appear when filtered by default project
			const goalsDefault = await apiFetch(`/api/goals?projectId=${defaultProject.id}`);
			const goalsDefaultBody = await goalsDefault.json();
			const goalsDefaultList = goalsDefaultBody.goals ?? goalsDefaultBody;
			const notFoundInDefault = goalsDefaultList.find((g: any) => g.id === goalId);
			expect(notFoundInDefault).toBeUndefined();
		} finally {
			if (goalId) {
				await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
			}
			await removeProject(projectB.id);
		}
	});

	test("goal with workflow — gates resolve to correct project", async () => {
		const projectB = await registerProject(`isolation-gates-${Date.now()}`);

		let goalId: string | undefined;
		try {
			// Create a goal with a workflow in project B
			const createResp = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: `Gate isolation test ${Date.now()}`,
					cwd: projectB.rootPath,
					projectId: projectB.id,
					team: false,
					worktree: false,
					workflowId: "general",
				}),
			});
			expect(createResp.status).toBe(201);
			const goal = await createResp.json();
			goalId = goal.id;

			// Verify gates exist for this goal
			const gatesResp = await apiFetch(`/api/goals/${goalId}/gates`);
			expect(gatesResp.status).toBe(200);
			const { gates } = await gatesResp.json();
			expect(gates.length).toBeGreaterThan(0);

			const gateIds = gates.map((g: any) => g.gateId);
			expect(gateIds).toContain("design-doc");

			// Signal the design-doc gate
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: test isolation\n\nFiles: a.ts\n\nCriteria: works",
				}),
			});
			expect(signalResp.status).toBe(201);

			// Wait for gate to process
			const start = Date.now();
			let gateStatus = "pending";
			while (Date.now() - start < 15_000 && gateStatus === "pending") {
				const resp = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
				const data = await resp.json();
				gateStatus = data.status;
				if (gateStatus === "pending") {
					await new Promise(r => setTimeout(r, 500));
				}
			}

			// Gate should have been processed (passed or failed — the point is it resolved)
			expect(gateStatus).not.toBe("pending");

			// Verify the goal is still scoped to project B
			const goalResp = await apiFetch(`/api/goals/${goalId}`);
			const goalData = await goalResp.json();
			expect(goalData.projectId).toBe(projectB.id);
		} finally {
			if (goalId) {
				await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
			}
			await removeProject(projectB.id);
		}
	});

	test("multi-project session lifecycle — no cross-contamination", async () => {
		const defaultProject = await getDefaultProject();
		const projectB = await registerProject(`isolation-multi-B-${Date.now()}`);
		const projectC = await registerProject(`isolation-multi-C-${Date.now()}`);

		const sessionIds: string[] = [];
		try {
			// Create sessions in projects B and C
			const sessionB = await createSessionInProject(projectB.rootPath, projectB.id);
			const sessionC = await createSessionInProject(projectC.rootPath, projectC.id);
			sessionIds.push(sessionB, sessionC);

			// Verify live sessions have correct projectIds
			const detailB = await apiFetch(`/api/sessions/${sessionB}`);
			expect((await detailB.json()).projectId).toBe(projectB.id);

			const detailC = await apiFetch(`/api/sessions/${sessionC}`);
			expect((await detailC.json()).projectId).toBe(projectC.id);

			// Verify project-filtered lists are correct
			const sessionsB = await listSessions(projectB.id);
			expect(sessionsB.some((s: any) => s.id === sessionB)).toBe(true);
			expect(sessionsB.some((s: any) => s.id === sessionC)).toBe(false);

			const sessionsC = await listSessions(projectC.id);
			expect(sessionsC.some((s: any) => s.id === sessionC)).toBe(true);
			expect(sessionsC.some((s: any) => s.id === sessionB)).toBe(false);

			// Default project should have neither
			const sessionsDefault = await listSessions(defaultProject.id);
			expect(sessionsDefault.some((s: any) => s.id === sessionB)).toBe(false);
			expect(sessionsDefault.some((s: any) => s.id === sessionC)).toBe(false);
		} finally {
			for (const id of sessionIds) {
				await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
			}
			await removeProject(projectB.id);
			await removeProject(projectC.id);
		}
	});

	test("session creation without projectId defaults to the default project", async () => {
		const defaultProject = await getDefaultProject();

		// Create a session without passing projectId — should default to the server's project
		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(201);
		const data = await resp.json();
		const sessionId = data.id;

		try {
			// Verify the session got the default project's ID
			const detailResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(detailResp.status).toBe(200);
			const detail = await detailResp.json();
			expect(detail.projectId).toBe(defaultProject.id);

			// Verify it appears in the default project's filtered list
			const sessionsDefault = await listSessions(defaultProject.id);
			expect(sessionsDefault.some((s: any) => s.id === sessionId)).toBe(true);
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("session list filtering by non-existent project returns empty", async () => {
		const projectB = await registerProject(`isolation-filter-${Date.now()}`);

		let sessionId: string | undefined;
		try {
			sessionId = await createSessionInProject(projectB.rootPath, projectB.id);

			// List sessions filtered by project B — should include our session
			const sessionsB = await listSessions(projectB.id);
			expect(sessionsB.some((s: any) => s.id === sessionId)).toBe(true);

			// List sessions filtered by a non-existent project — should not include our session
			const sessionsNone = await listSessions("nonexistent-project-id");
			expect(sessionsNone.some((s: any) => s.id === sessionId)).toBe(false);
		} finally {
			if (sessionId) {
				await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			}
			await removeProject(projectB.id);
		}
	});
});
