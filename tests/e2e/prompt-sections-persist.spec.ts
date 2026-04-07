/**
 * E2E tests for persisted prompt sections.
 *
 * Verifies that prompt sections are written as a JSON file at session creation
 * time and served from GET /api/sessions/:id/prompt-sections. The persisted
 * JSON survives session termination but is deleted during archive purge.
 */
import { test, expect } from "./in-process-harness.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	createSession,
	deleteSession,
	apiFetch,
	connectWs,
	waitForSessionStatus,
	statusPredicate,
} from "./e2e-setup.js";

test.setTimeout(30_000);

test.describe("Persisted prompt sections", () => {
	let sessionId: string;

	test.afterEach(async () => {
		if (sessionId) {
			await deleteSession(sessionId).catch(() => {});
			sessionId = "";
		}
	});

	test("prompt sections returned with createdAt after session creation", async ({ gateway }) => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Reply with OK" });
			await conn.waitFor(statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
		}

		const resp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
		expect(resp.status).toBe(200);
		const data = await resp.json();

		// Must have sections array with at least one entry
		expect(Array.isArray(data.sections)).toBe(true);
		expect(data.sections.length).toBeGreaterThanOrEqual(1);

		// Each section must have the expected fields
		for (const section of data.sections) {
			expect(typeof section.label).toBe("string");
			expect(typeof section.source).toBe("string");
			expect(typeof section.content).toBe("string");
			expect(typeof section.tokens).toBe("number");
		}

		// Must have totalTokens as a positive number
		expect(typeof data.totalTokens).toBe("number");
		expect(data.totalTokens).toBeGreaterThan(0);

		// Must have createdAt as a valid ISO date string
		expect(typeof data.createdAt).toBe("string");
		const parsed = new Date(data.createdAt);
		expect(parsed.getTime()).not.toBeNaN();
		// Sanity check: createdAt is recent (within last 60 seconds)
		expect(Date.now() - parsed.getTime()).toBeLessThan(60_000);
	});

	test("prompt sections JSON file exists on disk", async ({ gateway }) => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Reply with OK" });
			await conn.waitFor(statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
		}

		const promptFile = join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-prompt.json`);
		expect(existsSync(promptFile)).toBe(true);
	});

	test("prompt sections survive session termination", async ({ gateway }) => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			conn.send({ type: "prompt", text: "Reply with OK" });
			await conn.waitFor(statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
		}

		// Capture the sections before termination
		const beforeResp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
		expect(beforeResp.status).toBe(200);
		const beforeData = await beforeResp.json();
		expect(beforeData.sections.length).toBeGreaterThanOrEqual(1);

		// Terminate the session
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(delResp.status).toBe(200);

		// Wait briefly for cleanup to complete
		await new Promise(r => setTimeout(r, 500));

		// Prompt sections should still be available
		const afterResp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
		expect(afterResp.status).toBe(200);
		const afterData = await afterResp.json();

		// Same data as before termination
		expect(afterData.sections.length).toBe(beforeData.sections.length);
		expect(afterData.totalTokens).toBe(beforeData.totalTokens);
		expect(afterData.createdAt).toBe(beforeData.createdAt);

		// The JSON file should still exist on disk
		const promptFile = join(gateway.bobbitDir, "state", "session-prompts", `${sessionId}-prompt.json`);
		expect(existsSync(promptFile)).toBe(true);

		// Prevent afterEach from trying to delete already-terminated session
		sessionId = "";
	});
});
