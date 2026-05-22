/** API coverage split out of tests/e2e/ui/project-assistant.spec.ts. */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, nonGitCwd, deleteSession } from "./e2e-setup.js";

/** Create a project assistant session via API and return session ID + provisional project info. */
async function createProjectAssistantSession(
	assistantType: "project" | "project-scaffolding",
	cwd?: string,
): Promise<{ sessionId: string; provisionalProjectId?: string }> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ assistantType, cwd: cwd || nonGitCwd() }),
	});
	expect(resp.status).toBe(201);
	const data = await resp.json();
	return { sessionId: data.id, provisionalProjectId: data.provisionalProjectId };
}

/** Get all projects from the API. */
async function getProjects(): Promise<any[]> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	return data.projects || data || [];
}

/** Clean up a project by ID (best-effort). */
async function cleanupProject(id: string): Promise<void> {
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Project assistant API", () => {
	test("session types and provisional flag", async () => {
		let detectionId: string | undefined;
		let scaffoldId: string | undefined;
		let pp1: string | undefined;
		let pp2: string | undefined;

		try {
			// Detection mode.
			const detection = await createProjectAssistantSession("project");
			detectionId = detection.sessionId;
			pp1 = detection.provisionalProjectId;
			const detResp = await apiFetch(`/api/sessions/${detectionId}`);
			const detData = await detResp.json();
			expect(detData.assistantType).toBe("project");

			// Scaffolding mode.
			const scaffold = await createProjectAssistantSession("project-scaffolding");
			scaffoldId = scaffold.sessionId;
			pp2 = scaffold.provisionalProjectId;
			const scfResp = await apiFetch(`/api/sessions/${scaffoldId}`);
			const scfData = await scfResp.json();
			expect(scfData.assistantType).toBe("project-scaffolding");

			// Verify provisional flag via projects API.
			if (pp1) {
				const projects = await getProjects();
				const provisional = projects.find((p: any) => p.id === pp1);
				expect(provisional).toBeTruthy();
				expect(provisional.provisional).toBe(true);
			}

			// Session terminate removes from active list.
			await deleteSession(detectionId);
			detectionId = undefined;
			const resp = await apiFetch("/api/sessions");
			const data = await resp.json();
			const sessions = data.sessions || [];
			expect(sessions.find((s: { id: string }) => s.id === detection.sessionId)).toBeFalsy();
		} finally {
			if (detectionId) await deleteSession(detectionId);
			if (scaffoldId) await deleteSession(scaffoldId);
			if (pp1) await cleanupProject(pp1);
			if (pp2) await cleanupProject(pp2);
		}
	});
});
