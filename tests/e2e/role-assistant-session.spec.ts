/**
 * POST /api/sessions for config-editing assistants.
 *
 * Role/Tool assistants edit server-scope config and do not require a project
 * — they create sessions with projectId === undefined when no projectId is
 * provided and cwd doesn't match a registered project.
 *
 * Staff and Goal assistants are project-scoped and MUST 400 without a
 * resolvable project (surface-staff-in-sessions design §5). Staff with both
 * projectId AND cwd creates successfully.
 *
 * Uses `rawApiFetch` so the harness's default-project auto-injection doesn't
 * mask the requirement. The cwd MUST exist on disk — otherwise the server's
 * spawn-ENOENT guard rewrites it to defaultCwd (which matches the harness's
 * "default" project and masks the failure).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "./in-process-harness.js";
import { rawApiFetch, readE2EToken } from "./e2e-setup.js";

let bogusCwd: string;
const createdSessionIds: string[] = [];

test.beforeAll(() => {
	readE2EToken();
	bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-role-assistant-"));
});

test.afterAll(async () => {
	for (const id of createdSessionIds) {
		await rawApiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
	}
	try { fs.rmSync(bogusCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test.describe("POST /api/sessions — server-scope vs project-scoped assistants", () => {
	for (const assistantType of ["role", "tool"] as const) {
		test(`${assistantType} assistant without projectId — 201 (server-scope, no project needed)`, async () => {
			const resp = await rawApiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ assistantType, cwd: bogusCwd }),
			});
			const text = await resp.text();
			expect(
				resp.status,
				`${assistantType} assistant should be created without projectId; expected 201, got ${resp.status} body=${text}`,
			).toBe(201);
			const session = JSON.parse(text);
			expect(session.assistantType).toBe(assistantType);
			expect(session.id).toBeTruthy();
			createdSessionIds.push(session.id);
		});
	}

	for (const assistantType of ["goal", "staff"] as const) {
		test(`${assistantType} assistant without projectId — 400 (project-scoped)`, async () => {
			const resp = await rawApiFetch("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ assistantType, cwd: bogusCwd }),
			});
			const text = await resp.text();
			expect(
				resp.status,
				`${assistantType} assistant must require a project; expected 400, got ${resp.status} body=${text}`,
			).toBe(400);
			expect(text).toMatch(/projectId required/);
		});
	}

	test("staff assistant WITH projectId+cwd — 201", async () => {
		const projResp = await rawApiFetch("/api/projects");
		const list = await projResp.json() as Array<{ id: string; rootPath: string; name: string }>;
		const defaultProject = list.find(p => p.name === "default") ?? list[0];
		expect(defaultProject, "harness must register a default project").toBeTruthy();

		const resp = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				assistantType: "staff",
				projectId: defaultProject.id,
				cwd: defaultProject.rootPath,
			}),
		});
		const text = await resp.text();
		expect(
			resp.status,
			`staff assistant with projectId+cwd should succeed; got ${resp.status} body=${text}`,
		).toBe(201);
		const session = JSON.parse(text);
		expect(session.assistantType).toBe("staff");
		createdSessionIds.push(session.id);
	});
});
