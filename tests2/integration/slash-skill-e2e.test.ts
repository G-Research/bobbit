/**
 * E2E tests for slash skill resolution — both prefix-only and intra-prompt.
 *
 * Creates a test skill file in the session's cwd, then verifies the server
 * expands the skill content in the prompt text before dispatching to the agent.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	createSession,
	deleteSession,
	connectWs,
	apiFetch,
	defaultProjectId,
	harnessDefaultProjectRoot,
	type WsMsg,
} from "./_e2e/e2e-setup.js";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { attachLocalMockAgentClock, type LocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";

// Use a DEDICATED, unique cwd per worker (NOT the shared nonGitCwd) so the
// slash-skill discovery cache cannot return a previously-cached empty skill
// list for this directory. discoverSlashSkills() in src/server/skills/
// slash-skills.ts caches results for 5s keyed on cwd; if any earlier test in
// the same worker triggered discovery against nonGitCwd() before this
// beforeAll wrote SKILL.md, the cache would mask our skill until it expires.
let skillCwd: string;
let skillProjectId: string;
let sessionId: string;
let conn: Awaited<ReturnType<typeof connectWs>>;
let agentClock: LocalMockAgentClock;

test.beforeAll(async ({ gateway }) => {
	// A unique cwd under the immutable harness project avoids project
	// registration and the 5s discovery cache while preserving real discovery.
	skillCwd = join(harnessDefaultProjectRoot(), ".e2e-workspaces", `slash-skill-${process.pid}-${Date.now()}`);
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
	skillProjectId = (await defaultProjectId())!;
	sessionId = await createSession({ cwd: skillCwd, projectId: skillProjectId });
	agentClock = attachLocalMockAgentClock(gateway, sessionId);
	conn = await connectWs(sessionId);
	await conn.waitFor((m) => m.type === "queue_update", 5_000);
});

test.afterAll(async () => {
	conn.close();
	await deleteSession(sessionId).catch(() => {});
	rmSync(skillCwd, { recursive: true, force: true });
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
		const cursor = conn.messageCount();
		const agentEnded = conn.waitForFrom(cursor, (m) => m.type === "event" && m.data?.type === "agent_end", 10_000);
		conn.send({ type: "prompt", text: "/e2e-test-skill some args" });

		const userMsgEnd = await agentClock.advanceUntilSettled(conn.waitForFrom(cursor, userMessageEnd, 10_000));
		const userText = extractText(userMsgEnd);

		// New contract: persisted user message text is the literal slash
		// invocation; the expanded body lives in skillExpansions[].expanded.
		expect(userText).toBe("/e2e-test-skill some args");
		expect(userText).not.toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");

		const expansions = userMsgEnd.data.message.skillExpansions;
		expect(Array.isArray(expansions)).toBe(true);
		expect(expansions.length).toBe(1);
		expect(expansions[0].name).toBe("e2e-test-skill");
		expect(expansions[0].args).toBe("some args");
		expect(expansions[0].expanded).toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");

		await agentClock.advanceUntilSettled(agentEnded);
	});

	test("story 33: intra-prompt slash skill expands inline", async () => {
		// Verify the skill file actually exists before sending the prompt.
		// The beforeAll should have created it, but a stale skillCwd or
		// missing file would cause silent non-expansion.
		const skillFile = join(skillCwd, ".claude", "skills", "e2e-test-skill", "SKILL.md");
		expect(existsSync(skillFile), `Skill file must exist at ${skillFile}`).toBe(true);

		// Verify the session's cwd matches where the skill was created.
		const sessionResp = await apiFetch(`/api/sessions/${sessionId}`);
		const session = await sessionResp.json();
		expect(session.cwd).toBe(skillCwd);

		const cursor = conn.messageCount();
		const agentEnded = conn.waitForFrom(cursor, (m) => m.type === "event" && m.data?.type === "agent_end", 10_000);
		conn.send({
			type: "prompt",
			text: "Analyse using /e2e-test-skill the code",
		});

		const userMsgEnd = await agentClock.advanceUntilSettled(conn.waitForFrom(cursor, userMessageEnd, 10_000));
		const userText = extractText(userMsgEnd);

		// New contract: persisted text retains the literal slash; expansion
		// body is carried in skillExpansions[].expanded.
		expect(userText).toBe("Analyse using /e2e-test-skill the code");
		expect(userText).not.toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");

		const expansions = userMsgEnd.data.message.skillExpansions;
		expect(Array.isArray(expansions)).toBe(true);
		expect(expansions.length).toBe(1);
		expect(expansions[0].name).toBe("e2e-test-skill");
		expect(expansions[0].expanded).toContain("EXPANDED_SKILL_CONTENT_E2E_MARKER");
		// Range should point at the literal `/e2e-test-skill` token.
		const [start, end] = expansions[0].range;
		expect(userText.slice(start, end)).toBe("/e2e-test-skill");

		await agentClock.advanceUntilSettled(agentEnded);
	});
});
