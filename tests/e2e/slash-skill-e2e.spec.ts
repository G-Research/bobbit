/**
 * E2E tests for slash skill resolution — both prefix-only and intra-prompt.
 *
 * Creates a test skill file in the session's cwd, then verifies the server
 * expands the skill content in the prompt text before dispatching to the agent.
 */
import { test, expect } from "./in-process-harness.js";
import {
	createSession,
	connectWs,
	waitForHealth,
	nonGitCwd,
	apiFetch,
	agentEndPredicate,
	type WsMsg,
} from "./e2e-setup.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Create a dedicated cwd with a slash skill for these tests
let skillCwd: string;

test.beforeAll(async () => {
	await waitForHealth();

	// Create skill in the nonGitCwd's .claude/skills/e2e-test-skill/ directory
	skillCwd = nonGitCwd();
	const skillDir = join(skillCwd, ".claude", "skills", "e2e-test-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
description: E2E test skill for slash command expansion
---
EXPANDED_SKILL_CONTENT_E2E_MARKER
`,
	);
});

/** Predicate for user message_end events. */
const userMessageEnd = (m: WsMsg) =>
	m.type === "event" &&
	m.data?.type === "message_end" &&
	m.data?.message?.role === "user";

/** Extract plain text from a message_end event's content blocks. */
function extractText(msg: WsMsg): string {
	return (msg.data.message.content ?? [])
		.map((c: any) => c.text || "")
		.join("");
}

test.describe("Slash skill E2E", () => {
	test.describe.configure({ mode: "serial" });
	test("story 32: prefix slash skill expands to skill content @smoke", async () => {
		const sessionId = await createSession({ cwd: skillCwd });
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update", 5_000);
			conn.send({ type: "prompt", text: "/e2e-test-skill some args" });

			const userMsgEnd = await conn.waitFor(userMessageEnd, 10_000);
			const userText = extractText(userMsgEnd);

			expect(userText).toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");
			expect(userText).not.toContain("/e2e-test-skill");
			expect(userText).toContain("some args");

			await conn.waitFor(agentEndPredicate(), 10_000);
		} finally {
			conn.close();
		}
	});

	test("story 33: intra-prompt slash skill expands inline", async () => {
		// Verify the skill file actually exists before sending the prompt.
		// The beforeAll should have created it, but a stale skillCwd or
		// missing file would cause silent non-expansion.
		const skillFile = join(skillCwd, ".claude", "skills", "e2e-test-skill", "SKILL.md");
		expect(existsSync(skillFile), `Skill file must exist at ${skillFile}`).toBe(true);

		// Verify the session's cwd matches where the skill was created.
		const sessionId = await createSession({ cwd: skillCwd });
		const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
		const session = await sessionResp.json();
		expect(session.cwd).toBe(skillCwd);

		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update", 5_000);
			conn.send({
				type: "prompt",
				text: "Analyse using /e2e-test-skill the code",
			});

			const userMsgEnd = await conn.waitFor(userMessageEnd, 10_000);
			const userText = extractText(userMsgEnd);

			expect(userText).toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");
			expect(userText).toContain("Analyse using");
			expect(userText).toContain("the code");
			expect(userText).not.toContain("/e2e-test-skill");

			await conn.waitFor(agentEndPredicate(), 10_000);
		} finally {
			conn.close();
		}
	});
});
