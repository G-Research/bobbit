/**
 * Agent tool invocation tests — uses the mock agent (included by default).
 *
 * Tests verify session lifecycle (streaming/idle/abort) and tool invocations
 * (Bash, Write, Read, Edit) via the mock agent's deterministic responses.
 */
import { test, expect } from "./gateway-harness.js";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createSession,
	deleteSession,
	connectWs,
	waitForSessionStatus,
	statusPredicate,
	toolStartPredicate,
	agentEndPredicate,
} from "./e2e-setup.js";

test.setTimeout(30_000);

// ═══════════════════════════════════════════════════════════════════════════
// Session lifecycle (streaming, idle, abort)
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Session lifecycle", () => {
	let sessionId: string;
	test.afterEach(async () => { if (sessionId) { await deleteSession(sessionId); sessionId = ""; } });

	test("prompt triggers streaming then idle", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Reply with just the word OK and nothing else." });
			await conn.waitFor(statusPredicate("streaming"));
			await conn.waitFor(statusPredicate("idle"));
		} finally {
			conn.close();
		}
	});

	test("abort stops a streaming session", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			// Use STAY_BUSY to keep agent streaming until we abort
			conn.send({ type: "prompt", text: "STAY_BUSY:10000 long essay" });
			await conn.waitFor(statusPredicate("streaming"));
			conn.send({ type: "abort" });
			await conn.waitFor(statusPredicate("idle"));
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

	test.beforeAll(async () => {
		sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		// Prime the session with a simple prompt
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Reply with just: ready" });
			await conn.waitFor(agentEndPredicate());
		} finally {
			conn.close();
		}

		await waitForSessionStatus(sessionId, "idle");
	});
	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId);
	});

	async function verifyToolUsed(prompt: string, toolName: string): Promise<void> {
		await waitForSessionStatus(sessionId, "idle");

		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: prompt });
			const toolEvent = await conn.waitFor(toolStartPredicate(toolName));
			expect(toolEvent.data.toolName.toLowerCase()).toBe(toolName.toLowerCase());
			await conn.waitFor(agentEndPredicate());
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
		const testFile = join(tmpdir(), `bobbit-e2e-write-${Date.now()}.txt`);
		try {
			await verifyToolUsed(
				`Use the Write tool to write the text "E2E_WRITE_TEST" to the file ${testFile}`,
				"Write",
			);
			expect(existsSync(testFile)).toBe(true);
			expect(readFileSync(testFile, "utf-8")).toContain("E2E_WRITE_TEST");
		} finally {
			try { unlinkSync(testFile); } catch { /* ignore */ }
		}
	});

	test("Read tool", async () => {
		const testFile = join(tmpdir(), `bobbit-e2e-read-${Date.now()}.txt`);
		writeFileSync(testFile, "READ_THIS_CONTENT_E2E\n", "utf-8");
		try {
			await verifyToolUsed(
				`Use the Read tool to read the file ${testFile} and tell me what it contains.`,
				"Read",
			);
		} finally {
			try { unlinkSync(testFile); } catch { /* ignore */ }
		}
	});

	test("Edit tool", async () => {
		const testFile = join(tmpdir(), `bobbit-e2e-edit-${Date.now()}.txt`);
		writeFileSync(testFile, "line1: ORIGINAL_VALUE\nline2: keep this\n", "utf-8");
		try {
			await verifyToolUsed(
				`Use the Edit tool to replace "ORIGINAL_VALUE" with "EDITED_VALUE" in the file ${testFile}. Do not use any other tool for the replacement.`,
				"Edit",
			);
			const content = readFileSync(testFile, "utf-8");
			expect(content).toContain("EDITED_VALUE");
			expect(content).not.toContain("ORIGINAL_VALUE");
		} finally {
			try { unlinkSync(testFile); } catch { /* ignore */ }
		}
	});
});
