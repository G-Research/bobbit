/**
 * E2E tests for the server-side Draft Storage REST API.
 *
 * Endpoints under test:
 *   PUT    /api/sessions/:id/draft       — upsert a draft { type, data }
 *   GET    /api/sessions/:id/draft?type=  — retrieve a draft
 *   DELETE /api/sessions/:id/draft?type=  — clear a draft
 *
 * These endpoints do NOT exist yet (TDD). All tests should fail with 404.
 */
import { test, expect } from "@playwright/test";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";

let sessionId: string;

test.beforeAll(async () => {
	sessionId = await createSession();
});

test.afterAll(async () => {
	await deleteSession(sessionId);
});

test.describe("PUT /api/sessions/:id/draft", () => {
	test("saves a prompt draft", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "prompt", data: "hello world" }),
		});
		expect(resp.status).toBe(200);
	});

	test("saves a goal draft (object data)", async () => {
		const goalData = { title: "My goal", spec: "Do something" };
		const resp = await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "goal", data: goalData }),
		});
		expect(resp.status).toBe(200);
	});
});

test.describe("GET /api/sessions/:id/draft", () => {
	test("retrieves a previously saved prompt draft", async () => {
		// Save first
		await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "prompt", data: "draft text" }),
		});

		// Retrieve
		const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.type).toBe("prompt");
		expect(body.data).toBe("draft text");
	});

	test("returns 404 for a draft type that was never saved", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=nonexistent`);
		expect(resp.status).toBe(404);
	});

	test("returns 404 for a non-existent session", async () => {
		const resp = await apiFetch("/api/sessions/no-such-session/draft?type=prompt");
		expect(resp.status).toBe(404);
	});
});

test.describe("DELETE /api/sessions/:id/draft", () => {
	test("clears a saved draft", async () => {
		// Save
		await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "prompt", data: "to be deleted" }),
		});

		// Delete
		const delResp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`, {
			method: "DELETE",
		});
		expect(delResp.status).toBe(200);

		// Verify gone
		const getResp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
		expect(getResp.status).toBe(404);
	});

	test("delete is idempotent (no error if draft does not exist)", async () => {
		const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`, {
			method: "DELETE",
		});
		expect(resp.status).toBe(200);
	});
});

test.describe("draft isolation between types", () => {
	test("prompt and goal drafts do not interfere", async () => {
		// Save both types
		await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "prompt", data: "my prompt" }),
		});
		await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "goal", data: { title: "Goal A" } }),
		});

		// Retrieve each independently
		const promptResp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
		expect(promptResp.status).toBe(200);
		const promptBody = await promptResp.json();
		expect(promptBody.data).toBe("my prompt");

		const goalResp = await apiFetch(`/api/sessions/${sessionId}/draft?type=goal`);
		expect(goalResp.status).toBe(200);
		const goalBody = await goalResp.json();
		expect(goalBody.data).toEqual({ title: "Goal A" });

		// Delete prompt, goal should remain
		await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`, { method: "DELETE" });

		const promptAfter = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
		expect(promptAfter.status).toBe(404);

		const goalAfter = await apiFetch(`/api/sessions/${sessionId}/draft?type=goal`);
		expect(goalAfter.status).toBe(200);
		const goalAfterBody = await goalAfter.json();
		expect(goalAfterBody.data).toEqual({ title: "Goal A" });
	});
});

test.describe("draft overwrite", () => {
	test("PUT overwrites a previously saved draft of the same type", async () => {
		await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "prompt", data: "first" }),
		});
		await apiFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type: "prompt", data: "second" }),
		});

		const resp = await apiFetch(`/api/sessions/${sessionId}/draft?type=prompt`);
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.data).toBe("second");
	});
});
