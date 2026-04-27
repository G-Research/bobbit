/**
 * E2E tests for autonomous skill activation:
 *   - POST /api/sessions/:id/activate-skill happy path
 *   - 404 on unknown skill
 *   - 403 on disable-model-invocation skill
 *   - System prompt includes "Available Skills" catalog
 */
import { test, expect } from "./in-process-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createSession,
	deleteSession,
	apiFetch,
	bobbitDir,
} from "./e2e-setup.js";

function freshCwd(label: string): string {
	const dir = path.join(os.tmpdir(), `bobbit-skill-e2e-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test.setTimeout(30_000);

function writeSkill(rootPath: string, name: string, body: string) {
	const dir = path.join(rootPath, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf-8");
}

test.describe.serial("activate_skill REST endpoint", () => {
	let sessionId: string;
	let projectRoot: string;

	test.beforeAll(() => {
		// Use a fresh cwd per describe block so the 5s TTL skill cache (keyed
		// on cwd+config) never returns stale data from a sibling test file.
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
	});

	test.beforeEach(async () => {
		sessionId = await createSession({ cwd: projectRoot });
	});
	test.afterEach(async () => {
		if (sessionId) { await deleteSession(sessionId); sessionId = ""; }
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

test.describe("system prompt skills catalog", () => {
	let sessionId: string;
	let projectRoot: string;

	test.beforeAll(() => {
		projectRoot = freshCwd("catalog");
		writeSkill(projectRoot, "catalog-skill-a",
			"---\nname: catalog-skill-a\ndescription: Visible alpha\n---\nA"
		);
		writeSkill(projectRoot, "catalog-skill-locked",
			"---\nname: catalog-skill-locked\ndescription: Hidden from catalog\ndisable-model-invocation: true\n---\nL"
		);
	});

	test.afterEach(async () => {
		if (sessionId) { await deleteSession(sessionId); sessionId = ""; }
	});

	test("Available Skills section contains model-invocable skills only", async () => {
		sessionId = await createSession({ cwd: projectRoot });
		// Hit the prompt-sections inspector REST endpoint
		const resp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
		// Endpoint may not exist on this build — fall back to checking the
		// raw assembled prompt file under state/session-prompts/<id>.md.
		if (resp.ok) {
			const data = await resp.json() as any;
			const sections = (data.sections || []) as Array<{ label: string; content: string }>;
			const skillsSection = sections.find(s => s.label === "Available Skills");
			expect(skillsSection, "expected an 'Available Skills' section in prompt").toBeDefined();
			expect(skillsSection!.content).toContain("catalog-skill-a");
			expect(skillsSection!.content).not.toContain("catalog-skill-locked");
		} else {
			// Fallback: inspect the assembled prompt file.
			const promptFile = path.join(bobbitDir(), "state", "session-prompts", `${sessionId}.md`);
			expect(fs.existsSync(promptFile), `prompt file should exist at ${promptFile}`).toBe(true);
			const text = fs.readFileSync(promptFile, "utf-8");
			expect(text).toContain("Available Skills");
			expect(text).toContain("catalog-skill-a");
			expect(text).not.toContain("catalog-skill-locked");
		}
	});
});
