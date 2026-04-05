/**
 * E2E tests for slash skill expansion mismatch across projects.
 *
 * Reproduces the bug: when `/api/slash-skills` is called WITHOUT `projectId`,
 * skills from non-default projects with custom `config_directories` are not
 * found — because the server falls back to the default project's config store.
 * But the WS handler correctly uses `session.projectId` to resolve skills.
 *
 * This proves that the autocomplete (which omits projectId) and the expansion
 * (which uses session.projectId) see different skill sets.
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
	test("skill from non-default project is NOT found without projectId (reproduces bug)", async () => {
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
			// Fetch slash-skills WITHOUT projectId — simulates the current buggy
			// autocomplete behavior in MessageEditor
			const withoutPid = await apiFetch(
				`/api/slash-skills?cwd=${encodeURIComponent(sessionCwd)}`,
			);
			expect(withoutPid.status).toBe(200);
			const withoutPidData = await withoutPid.json();
			const withoutPidNames = withoutPidData.skills.map((s: any) => s.name);

			// The custom skill should NOT be found because the default project's
			// config store doesn't have the custom config_directories entry.
			// This is the core of the bug: autocomplete misses the skill.
			expect(
				withoutPidNames,
				`Expected skill "${SKILL_NAME}" to NOT be found without projectId (proves autocomplete bug)`,
			).not.toContain(SKILL_NAME);

			// Fetch slash-skills WITH projectId — the correct behavior
			const withPid = await apiFetch(
				`/api/slash-skills?cwd=${encodeURIComponent(sessionCwd)}&projectId=${encodeURIComponent(secondProjectId)}`,
			);
			expect(withPid.status).toBe(200);
			const withPidData = await withPid.json();
			const withPidNames = withPidData.skills.map((s: any) => s.name);

			// With projectId, the skill SHOULD be found
			expect(
				withPidNames,
				`Expected skill "${SKILL_NAME}" to be found with projectId`,
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
