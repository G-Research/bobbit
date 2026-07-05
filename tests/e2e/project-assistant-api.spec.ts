/** API coverage split out of tests/e2e/ui/project-assistant.spec.ts. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, rawApiFetch, nonGitCwd, deleteSession } from "./e2e-setup.js";

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

function samePath(a: string, b: string): boolean {
	const normalize = (value: string) => resolve(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return normalize(a) === normalize(b);
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

	test("reuses an existing normal project scope for the requested cwd", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "bobbit-project-assistant-existing-")));
		let sessionId: string | undefined;
		let projectId: string | undefined;
		try {
			const register = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: "existing-normal", rootPath: root, upsert: true, __e2e_seed_skip__: true }),
			});
			expect(register.status, await register.clone().text()).toBeLessThan(300);
			const project = await register.json();
			projectId = project.id;

			const assistantResp = await rawApiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ assistantType: "project", cwd: root }),
			});
			expect(assistantResp.status, await assistantResp.clone().text()).toBe(201);
			const assistant = await assistantResp.json();
			sessionId = assistant.id;
			expect(assistant.provisionalProjectId).toBe(projectId);

			const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessionResp.status, await sessionResp.clone().text()).toBe(200);
			const session = await sessionResp.json();
			expect(session.projectId).toBe(projectId);

			const projects = await getProjects();
			const sameRootProjects = projects.filter((p: any) => typeof p.rootPath === "string" && samePath(p.rootPath, root));
			expect(sameRootProjects.map((p: any) => p.id)).toEqual([projectId]);
			expect(sameRootProjects[0].provisional).not.toBe(true);
		} finally {
			if (sessionId) await deleteSession(sessionId);
			if (projectId) await cleanupProject(projectId);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
