// Ported from tests/e2e/activate-skill.spec.ts (v2-integration tier).
//
// Faithful port of the "activate_skill REST endpoint" describe: the REST
// status-code contract for POST /api/sessions/:id/activate-skill —
//   - 200 happy path (expanded body + substituted args; no-arg variant)
//   - 404 unknown skill
//   - 403 disable-model-invocation: true
//   - 400 missing name
//   - 404 nonexistent session
//
// The legacy spec's separate "system prompt skills catalog" describe (catalogue
// omission) is covered elsewhere in v2 (core/activate-skill-extension,
// integration/slash-skill-e2e); this file ports the lost REST status codes.
//
// Uses the v2-integration compat shim (fork-scoped gateway) so the body stays
// semantically identical to the legacy Playwright in-process harness.
import { test, expect } from "./_e2e/in-process-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createSession,
	deleteSession,
	apiFetch,
	registerProject,
} from "./_e2e/e2e-setup.js";

function freshCwd(label: string): string {
	const dir = path.join(os.tmpdir(), `bobbit-skill-v2-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	try { return fs.realpathSync(dir); } catch { return dir; }
}

function writeSkill(rootPath: string, name: string, body: string) {
	const dir = path.join(rootPath, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
}

test.describe.serial("activate_skill REST endpoint", () => {
	let sessionId: string;
	let projectRoot: string;
	let projectId: string;

	test.beforeAll(async () => {
		// Fresh registered project so the 5s TTL skill cache (keyed on cwd+config)
		// never returns stale data from a sibling test file, while projectId
		// remains the authoritative scope.
		projectRoot = freshCwd("activate");
		writeSkill(projectRoot, "skill-alpha",
			"---\nname: skill-alpha\ndescription: Alpha skill for E2E\nargument-hint: <thing>\n---\nALPHA-BODY $ARGUMENTS"
		);
		writeSkill(projectRoot, "skill-beta",
			"---\nname: skill-beta\ndescription: Beta skill (model-invocable)\n---\nBETA-BODY"
		);
		writeSkill(projectRoot, "skill-locked",
			"---\nname: skill-locked\ndescription: User-only skill\ndisable-model-invocation: true\n---\nLOCKED-BODY"
		);
		const project = await registerProject({
			name: `activate-skill-${Date.now()}`,
			rootPath: projectRoot,
			seedWorkflows: false,
		});
		projectId = project.id;
		// Endpoint cases are stateless reads of the same skill catalogue. Reuse one
		// worktree-free session instead of provisioning/deleting six agent records.
		sessionId = await createSession({ cwd: projectRoot, projectId });
	});

	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
	});

	test("happy path: returns expanded body with substituted arguments", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/activate-skill`, {
			method: "POST",
			body: JSON.stringify({ name: "skill-alpha", args: "hero card" }),
		});
		expect(resp.status).toBe(200);
		const data = await resp.json() as any;
		expect(data.ok).toBe(true);
		expect(data.expanded).toContain("ALPHA-BODY");
		expect(data.expanded).toContain("hero card");
		expect(typeof data.filePath).toBe("string");
		expect(data.source).toBeDefined();
	});

	test("happy path with no args (omitted)", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/activate-skill`, {
			method: "POST",
			body: JSON.stringify({ name: "skill-beta" }),
		});
		expect(resp.status).toBe(200);
		const data = await resp.json() as any;
		expect(data.expanded).toContain("BETA-BODY");
	});

	test("404 for unknown skill", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/activate-skill`, {
			method: "POST",
			body: JSON.stringify({ name: "does-not-exist" }),
		});
		expect(resp.status).toBe(404);
	});

	test("403 when skill has disable-model-invocation: true", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/activate-skill`, {
			method: "POST",
			body: JSON.stringify({ name: "skill-locked" }),
		});
		expect(resp.status).toBe(403);
	});

	test("400 when name is missing", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/activate-skill`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(resp.status).toBe(400);
	});

	test("404 for nonexistent session", async () => {
		const resp = await apiFetch(`/api/sessions/00000000-0000-0000-0000-000000000000/activate-skill`, {
			method: "POST",
			body: JSON.stringify({ name: "skill-alpha" }),
		});
		expect(resp.status).toBe(404);
	});
});
