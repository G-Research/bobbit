/**
 * E2E tests for persisted prompt sections.
 *
 * Verifies that prompt sections are persisted at session creation time and
 * served from GET /api/sessions/:id/prompt-sections. The persisted JSON
 * survives session termination but is deleted during archive purge.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	createSession,
	deleteSession,
	apiFetch,
	connectWs,
	statusPredicate,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

test.setTimeout(30_000);

interface PromptSectionsResponse {
	sections: Array<{ label: string; source: string; content: string; tokens: number }>;
	totalTokens: number;
	createdAt: string;
}

async function waitForPersistedPromptSections(sessionId: string): Promise<PromptSectionsResponse> {
	return await pollUntil(async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
		if (resp.status !== 200) return null;
		const data = await resp.json();
		// The reconstruct-on-demand fallback intentionally has no createdAt; requiring
		// it keeps this an observable persistence assertion without depending on the
		// harness's raw state/session-prompts path.
		if (typeof data.createdAt !== "string") return null;
		if (!Array.isArray(data.sections) || data.sections.length < 1) return null;
		if (typeof data.totalTokens !== "number" || data.totalTokens <= 0) return null;
		return data as PromptSectionsResponse;
	}, { timeoutMs: 10_000, intervalMs: 50, label: "persisted prompt sections" });
}

test.describe("Persisted prompt sections", () => {
	let sessionId: string;

	test.afterEach(async () => {
		if (sessionId) {
			await deleteSession(sessionId).catch(() => {});
			sessionId = "";
		}
	});

	test("prompt sections returned with createdAt after session creation", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: "Reply with OK" });
			await conn.waitForFrom(cursor, statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
		}

		const data = await waitForPersistedPromptSections(sessionId);

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

	test("persisted prompt sections are observable", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: "Reply with OK" });
			await conn.waitForFrom(cursor, statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
		}

		const data = await waitForPersistedPromptSections(sessionId);
		expect(data.sections.length).toBeGreaterThanOrEqual(1);
		expect(data.totalTokens).toBeGreaterThan(0);
		expect(new Date(data.createdAt).getTime()).not.toBeNaN();
	});

	test("prompt sections survive session termination", async () => {
		sessionId = await createSession();
		const conn = await connectWs(sessionId);
		try {
			const cursor = conn.messageCount();
			conn.send({ type: "prompt", text: "Reply with OK" });
			await conn.waitForFrom(cursor, statusPredicate("idle"), 15_000);
		} finally {
			conn.close();
		}

		// Capture the persisted sections before termination
		const beforeData = await waitForPersistedPromptSections(sessionId);
		expect(beforeData.sections.length).toBeGreaterThanOrEqual(1);

		// Terminate the session
		const delResp = await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		expect(delResp.status).toBe(200);

		// Prompt sections should still be available (persisted JSON survives termination)
		const afterResp = await apiFetch(`/api/sessions/${sessionId}/prompt-sections`);
		expect(afterResp.status).toBe(200);
		const afterData = await afterResp.json();

		// Same persisted data as before termination. After DELETE there is no live
		// session to reconstruct from, so a 200 with createdAt proves persisted data.
		expect(afterData.sections.length).toBe(beforeData.sections.length);
		expect(afterData.totalTokens).toBe(beforeData.totalTokens);
		expect(afterData.createdAt).toBe(beforeData.createdAt);
		expect(typeof afterData.createdAt).toBe("string");

		// Prevent afterEach from trying to delete already-terminated session
		sessionId = "";
	});
});
