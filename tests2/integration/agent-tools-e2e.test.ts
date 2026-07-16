/**
 * Agent tool invocation tests — uses the mock agent (included by default).
 *
 * Tests verify session lifecycle (streaming/idle/abort) and tool invocations
 * (Bash, Write, Read, Edit) via the mock agent's deterministic responses.
 */
import "./_e2e/fake-cmd-setup.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createSession,
	deleteSession,
	connectWs,
	statusPredicate,
	toolStartPredicate,
	agentEndPredicate,
} from "./_e2e/e2e-setup.js";
import { attachLocalMockAgentClock, type LocalMockAgentClock } from "./helpers/local-mock-agent-clock.js";

test.setTimeout(30_000);

// ═══════════════════════════════════════════════════════════════════════════
// Session lifecycle (streaming, idle, abort)
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Session lifecycle", () => {
	let sessionId: string;
	let agentClock: LocalMockAgentClock;

	test.beforeEach(async ({ gateway }) => {
		sessionId = await createSession();
		agentClock = attachLocalMockAgentClock(gateway, sessionId);
	});
	test.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		sessionId = "";
	});

	test("prompt triggers streaming then idle @smoke", async () => {
		const conn = await connectWs(sessionId);
		try {
			const cursor = conn.messageCount();
			const streaming = conn.waitForFrom(cursor, statusPredicate("streaming"));
			const idle = conn.waitForFrom(cursor, statusPredicate("idle"));
			conn.send({ type: "prompt", text: "Reply with just the word OK and nothing else." });
			await agentClock.advanceUntilSettled(streaming);
			await agentClock.advanceUntilSettled(idle);
		} finally {
			conn.close();
		}
	});

	test("abort stops a streaming session @smoke", async () => {
		const conn = await connectWs(sessionId);
		try {
			const cursor = conn.messageCount();
			const streaming = conn.waitForFrom(cursor, statusPredicate("streaming"));
			conn.send({ type: "prompt", text: "STAY_BUSY:2000 long essay" });
			await agentClock.advanceUntilSettled(streaming);
			const idle = conn.waitForFrom(conn.messageCount(), statusPredicate("idle"));
			conn.send({ type: "abort" });
			await agentClock.advanceUntilSettled(idle);
		} finally {
			conn.close();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Agent tool invocations — serial to avoid overwhelming the server
// ═══════════════════════════════════════════════════════════════════════════

test.describe.serial("Agent tools", () => {
	let sessionId: string;
	let agentClock: LocalMockAgentClock;
	let fixtureRoot: string;

	test.beforeAll(() => {
		fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-agent-tools-"));
	});
	test.afterAll(() => {
		rmSync(fixtureRoot, { recursive: true, force: true });
	});

	// A fresh mock instance per declaration prevents an unfinished prompt chain
	// or abort controller from poisoning the next tool assertion in this fork.
	test.beforeEach(async ({ gateway }) => {
		sessionId = await createSession();
		agentClock = attachLocalMockAgentClock(gateway, sessionId);
	});
	test.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		sessionId = "";
	});

	async function verifyToolUsed(prompt: string, toolName: string): Promise<void> {
		const conn = await connectWs(sessionId);
		try {
			const cursor = conn.messageCount();
			const toolStarted = conn.waitForFrom(cursor, toolStartPredicate(toolName));
			const agentEnded = conn.waitForFrom(cursor, agentEndPredicate());
			conn.send({ type: "prompt", text: prompt });
			const toolEvent = await agentClock.advanceUntilSettled(toolStarted);
			expect(toolEvent.data.toolName.toLowerCase()).toBe(toolName.toLowerCase());
			await agentClock.advanceUntilSettled(agentEnded);
		} finally {
			conn.close();
		}
	}

	test("Bash tool", async () => {
		await verifyToolUsed(
			'Run this exact bash command and show me the output: echo BOBBIT_TOOL_TEST_OK_12345',
			"Bash",
		);
	});

	test("Write tool", async () => {
		const testFile = join(fixtureRoot, "write.txt");
		await verifyToolUsed(
			`Use the Write tool to write the text "E2E_WRITE_TEST" to the file ${testFile}`,
			"Write",
		);
		expect(existsSync(testFile)).toBe(true);
		expect(readFileSync(testFile, "utf-8")).toContain("E2E_WRITE_TEST");
	});

	test("Read tool", async () => {
		const testFile = join(fixtureRoot, "read.txt");
		writeFileSync(testFile, "READ_THIS_CONTENT_E2E\n", "utf-8");
		await verifyToolUsed(
			`Use the Read tool to read the file ${testFile} and tell me what it contains.`,
			"Read",
		);
	});

	test("Edit tool", async () => {
		const testFile = join(fixtureRoot, "edit.txt");
		writeFileSync(testFile, "line1: ORIGINAL_VALUE\nline2: keep this\n", "utf-8");
		await verifyToolUsed(
			`Use the Edit tool to replace "ORIGINAL_VALUE" with "EDITED_VALUE" in the file ${testFile}. Do not use any other tool for the replacement.`,
			"Edit",
		);
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("EDITED_VALUE");
		expect(content).not.toContain("ORIGINAL_VALUE");
	});
});
