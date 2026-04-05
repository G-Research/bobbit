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
	statusPredicate,
	agentEndPredicate,
	type WsMsg,
} from "./e2e-setup.js";
import { mkdirSync, writeFileSync } from "node:fs";
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

test.describe("Slash skill E2E", () => {
	test("story 32: prefix slash skill expands to skill content", async () => {
		const sessionId = await createSession({ cwd: skillCwd });
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Send a prefix slash command: /e2e-test-skill some args
			conn.send({ type: "prompt", text: "/e2e-test-skill some args" });

			// Wait for the agent to receive the prompt and respond
			// The mock agent echoes back the user message — check it contains expanded content
			const userMsgEnd = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user",
			);

			// The user message text should contain the expanded skill content, not the raw "/e2e-test-skill"
			const userText = userMsgEnd.data.message.content
				?.map((c: any) => c.text || "")
				.join("");
			expect(userText).toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");
			// The raw slash command should be replaced
			expect(userText).not.toContain("/e2e-test-skill");
			// Args should be present (either via $ARGUMENTS substitution or appended)
			expect(userText).toContain("some args");

			await conn.waitFor(agentEndPredicate());
		} finally {
			conn.close();
		}
	});

	test("story 33: intra-prompt slash skill expands inline", async () => {
		const sessionId = await createSession({ cwd: skillCwd });
		const conn = await connectWs(sessionId);

		try {
			await conn.waitFor((m) => m.type === "queue_update");

			// Send a prompt with an inline slash skill reference
			conn.send({
				type: "prompt",
				text: "Analyse using /e2e-test-skill the code",
			});

			// Wait for the user message echo
			const userMsgEnd = await conn.waitFor(
				(m) =>
					m.type === "event" &&
					m.data?.type === "message_end" &&
					m.data?.message?.role === "user",
			);

			const userText = userMsgEnd.data.message.content
				?.map((c: any) => c.text || "")
				.join("");

			// The inline /e2e-test-skill should be expanded
			expect(userText).toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");
			// Surrounding text should be preserved
			expect(userText).toContain("Analyse using");
			expect(userText).toContain("the code");
			// The raw skill name should be replaced
			expect(userText).not.toContain("/e2e-test-skill");

			await conn.waitFor(agentEndPredicate());
		} finally {
			conn.close();
		}
	});
});
