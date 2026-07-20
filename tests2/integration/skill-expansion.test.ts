/**
 * E2E tests for slash skill expansion across projects.
 *
 * Verifies that the autocomplete API requires projectId to find per-project
 * skills, the WS handler expands skills using session.projectId, and that
 * default project sessions don't see non-default project skills.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	nonGitCwd,
	connectWs,
	defaultProjectId,
} from "./_e2e/e2e-setup.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

let ownerRoot: string;
let secondProjectId: string;
let secondProjectCwd: string;
let skillDir: string;
let secondProjectSessionId: string;
let secondProjectSessionCwd: string;
let defaultSessionId: string;
let defaultSessionCwd: string;

const SKILL_NAME = "cross-project-skill";
const SKILL_MARKER = "CROSS_PROJECT_SKILL_EXPANDED_MARKER_12345";

test.beforeAll(async () => {
	// 1. Create a process-owned root so concurrent Vitest parents cannot share
	// or clean up one another's project and skill fixtures.
	ownerRoot = mkdtempSync(join(tmpdir(), "bobbit-e2e-skill-"));
	secondProjectCwd = join(ownerRoot, "project");
	mkdirSync(secondProjectCwd, { recursive: true });

	// 2. Create a skill directory structure inside a custom config dir
	//    scanSkillDir expects: <configDir>/<skillName>/SKILL.md
	skillDir = join(secondProjectCwd, "custom-config", SKILL_NAME);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
description: Cross-project test skill for E2E
---
${SKILL_MARKER}
`,
	);

	// 3. Register the second project
	const projResp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({
			name: `e2e-skill-expansion-${basename(ownerRoot)}`,
			rootPath: secondProjectCwd,
			__e2e_seed_skip__: true,
		}),
	});
	expect(projResp.status).toBe(201);
	const project = await projResp.json();
	secondProjectId = project.id;

	// 4. Set config_directories on the second project to include our custom skill dir.
	//    Native-YAML migration: send structured array (server rejects JSON-strings).
	const configDirs = [
		{ path: join(secondProjectCwd, "custom-config"), types: ["skills"] },
	];
	const putResp = await apiFetch(`/api/projects/${secondProjectId}/config`, {
		method: "PUT",
		body: JSON.stringify({ config_directories: configDirs }),
	});
	expect(putResp.status).toBe(200);

	// The assertions are read-only apart from one prompt turn. Provision the two
	// worktree-free sessions once instead of repeating full entity registration in
	// each case; the file-level teardown remains the isolation boundary.
	const secondSessionResp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			cwd: secondProjectCwd,
			projectId: secondProjectId,
			worktree: false,
		}),
	});
	expect(secondSessionResp.status).toBe(201);
	({ id: secondProjectSessionId, cwd: secondProjectSessionCwd } = await secondSessionResp.json());

	const defaultSessionResp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), worktree: false }),
	});
	expect(defaultSessionResp.status).toBe(201);
	({ id: defaultSessionId, cwd: defaultSessionCwd } = await defaultSessionResp.json());
});

test.afterAll(async () => {
	// These are file-level fixtures, so the per-test scope deliberately does not
	// own them. Delete children before their project, then remove the temp tree.
	if (secondProjectSessionId) await apiFetch(`/api/sessions/${secondProjectSessionId}`, { method: "DELETE" }).catch(() => {});
	if (defaultSessionId) await apiFetch(`/api/sessions/${defaultSessionId}`, { method: "DELETE" }).catch(() => {});
	if (secondProjectId) await apiFetch(`/api/projects/${secondProjectId}`, { method: "DELETE" }).catch(() => {});
	try { rmSync(ownerRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test.describe("Slash skill expansion mismatch", () => {
	test("autocomplete requires projectId to find non-default project skills", async () => {
		// WITHOUT projectId — project-scoped autocomplete rejects instead of
		// inferring scope from cwd.
		const respWithout = await apiFetch(
			`/api/slash-skills?cwd=${encodeURIComponent(secondProjectSessionCwd)}`,
		);
		expect(respWithout.status).toBe(400);
		const bodyWithout = await respWithout.json().catch(() => ({}));
		expect(String(bodyWithout.code ?? bodyWithout.error ?? "").toLowerCase()).toContain("project");

		// WITH projectId — the API resolves the correct per-project config
		// store and finds the skill. This is what the fixed UI sends.
		const respWith = await apiFetch(
			`/api/slash-skills?cwd=${encodeURIComponent(secondProjectSessionCwd)}&projectId=${encodeURIComponent(secondProjectId)}`,
		);
		expect(respWith.status).toBe(200);
		const dataWith = await respWith.json();
		const namesWith = dataWith.skills.map((s: any) => s.name);
		expect(namesWith).toContain(SKILL_NAME);
	});

	test("WS handler expands skill using session.projectId", async () => {
		const conn = await connectWs(secondProjectSessionId);
		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Send a prompt containing the slash skill
			conn.send({ type: "prompt", text: `/cross-project-skill some args` });

			// Wait for the user message echo — the WS handler should have
			// expanded the skill using session.projectId
			const userMsgEnd = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user",
			);

			const userText = userMsgEnd.data.message.content
				?.map((c: any) => c.text || "")
				.join("");

			// New contract: the persisted user message retains the literal
			// slash invocation; the expanded body lives in skillExpansions[].
			expect(userText).toContain("/cross-project-skill");
			expect(userText).not.toContain(SKILL_MARKER);

			const expansions = userMsgEnd.data.message.skillExpansions;
			expect(Array.isArray(expansions)).toBe(true);
			expect(expansions.length).toBeGreaterThan(0);
			expect(expansions[0].name).toBe(SKILL_NAME);
			// The skill content should be expanded into the snapshot body
			// (WS handler uses session.projectId to resolve per-project skills).
			expect(expansions[0].expanded).toContain(SKILL_MARKER);
		} finally {
			conn.close();
		}
	});

	test("default project session does NOT see non-default project skills", async () => {
		// Fetch slash-skills for the default project
		const defaultProject = await defaultProjectId();
		expect(defaultProject).toBeTruthy();
		const resp = await apiFetch(
			`/api/slash-skills?cwd=${encodeURIComponent(defaultSessionCwd)}&projectId=${encodeURIComponent(defaultProject!)}`,
		);
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const names = data.skills.map((s: any) => s.name);

		// The cross-project skill should NOT appear in the default project
		expect(names).not.toContain(SKILL_NAME);
	});
});
