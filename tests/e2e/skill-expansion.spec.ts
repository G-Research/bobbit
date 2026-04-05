/**
 * E2E tests for slash skill expansion across projects.
 *
 * The "autocomplete returns correct skills with projectId" test reproduces the
 * bug: it asserts the DESIRED behavior (skill found with projectId param).
 * Before the fix, this test FAILS because the API without projectId misses
 * skills from non-default projects. After the fix, it passes.
 *
 * The other tests verify WS expansion and project isolation.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	nonGitCwd,
	connectWs,
	agentEndPredicate,
} from "./e2e-setup.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let secondProjectId: string;
let secondProjectCwd: string;
let skillDir: string;

const SKILL_NAME = "cross-project-skill";
const SKILL_MARKER = "CROSS_PROJECT_SKILL_EXPANDED_MARKER_12345";

test.beforeAll(async () => {
	// 1. Create a temp directory for the second project
	secondProjectCwd = join(tmpdir(), `bobbit-e2e-skill-project-${Date.now()}`);
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
			name: `e2e-skill-expansion-${Date.now()}`,
			rootPath: secondProjectCwd,
		}),
	});
	expect(projResp.status).toBe(201);
	const project = await projResp.json();
	secondProjectId = project.id;

	// 4. Set config_directories on the second project to include our custom skill dir
	const configDirs = JSON.stringify([
		{ path: join(secondProjectCwd, "custom-config"), types: ["skills"] },
	]);
	const putResp = await apiFetch(`/api/projects/${secondProjectId}/config`, {
		method: "PUT",
		body: JSON.stringify({ config_directories: configDirs }),
	});
	expect(putResp.status).toBe(200);
});

test.describe("Slash skill expansion mismatch", () => {
	test("autocomplete without projectId should find non-default project skill (fails before fix)", async () => {
		// Create a session in the second project
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: secondProjectCwd,
				projectId: secondProjectId,
				worktree: false,
			}),
		});
		expect(sessResp.status).toBe(201);
		const { id: sessionId, cwd: sessionCwd } = await sessResp.json();

		try {
			// Fetch slash-skills WITHOUT projectId — this simulates the current
			// buggy autocomplete in MessageEditor which omits projectId.
			// DESIRED behavior: the skill should be found (matching what the
			// WS handler sees via session.projectId).
			// ACTUAL behavior (before fix): skill not found — autocomplete bug.
			const resp = await apiFetch(
				`/api/slash-skills?cwd=${encodeURIComponent(sessionCwd)}`,
			);
			expect(resp.status).toBe(200);
			const data = await resp.json();
			const names = data.skills.map((s: any) => s.name);

			// This assertion FAILS before the fix — proving the autocomplete
			// mismatch bug. The skill exists in the non-default project but
			// is not found because projectId is not passed.
			expect(
				names,
				`skill not found in autocomplete without projectId — autocomplete bug: expected "${SKILL_NAME}" in [${names.join(", ")}]`,
			).toContain(SKILL_NAME);
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("WS handler expands skill using session.projectId", async () => {
		// Create a session in the second project
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				cwd: secondProjectCwd,
				projectId: secondProjectId,
				worktree: false,
			}),
		});
		expect(sessResp.status).toBe(201);
		const { id: sessionId } = await sessResp.json();

		const conn = await connectWs(sessionId);
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

			// The skill content should be expanded (WS handler uses session.projectId)
			expect(userText).toContain(SKILL_MARKER);
			// The raw slash command should be replaced
			expect(userText).not.toContain("/cross-project-skill");

			await conn.waitFor(agentEndPredicate());
		} finally {
			conn.close();
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("default project session does NOT see non-default project skills", async () => {
		// Create a session in the default project (no explicit projectId)
		const defaultCwd = nonGitCwd();
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: defaultCwd, worktree: false }),
		});
		expect(sessResp.status).toBe(201);
		const { id: sessionId, cwd: sessionCwd } = await sessResp.json();

		try {
			// Fetch slash-skills for the default project
			const resp = await apiFetch(
				`/api/slash-skills?cwd=${encodeURIComponent(sessionCwd)}`,
			);
			expect(resp.status).toBe(200);
			const data = await resp.json();
			const names = data.skills.map((s: any) => s.name);

			// The cross-project skill should NOT appear in the default project
			expect(names).not.toContain(SKILL_NAME);
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
