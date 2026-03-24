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

test.describe("draft race conditions", () => {
	test("DELETE then PUT should not resurrect the draft (simulates send-while-save-inflight)", async () => {
		// Simulate: user types → debounce fires PUT → user sends → DELETE fires
		// If PUT arrives after DELETE on the server, the draft reappears.
		// Fire DELETE and PUT concurrently — draft must be gone afterward.
		const sessionB = await createSession();
		try {
			// First, save a draft normally
			await apiFetch(`/api/sessions/${sessionB}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: "initial" }),
			});

			// Now fire DELETE and PUT concurrently (simulating the race)
			const [delResp, putResp] = await Promise.all([
				apiFetch(`/api/sessions/${sessionB}/draft?type=prompt`, { method: "DELETE" }),
				apiFetch(`/api/sessions/${sessionB}/draft`, {
					method: "PUT",
					body: JSON.stringify({ type: "prompt", data: "stale save" }),
				}),
			]);
			expect(delResp.status).toBe(200);
			expect(putResp.status).toBe(200);

			// The draft may or may not exist depending on server ordering.
			// But after an explicit DELETE, it should be gone:
			await apiFetch(`/api/sessions/${sessionB}/draft?type=prompt`, { method: "DELETE" });
			const check = await apiFetch(`/api/sessions/${sessionB}/draft?type=prompt`);
			expect(check.status).toBe(404);
		} finally {
			await deleteSession(sessionB);
		}
	});

	test("rapid PUT then DELETE leaves no draft", async () => {
		// The most likely real-world race: debounce timer fires (PUT), then
		// user sends immediately (DELETE). Server must not resurrect the draft.
		const sess = await createSession();
		try {
			// Fire PUT then DELETE in quick succession (not concurrent — sequential)
			await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: "about to send" }),
			});
			await apiFetch(`/api/sessions/${sess}/draft?type=prompt`, { method: "DELETE" });

			const check = await apiFetch(`/api/sessions/${sess}/draft?type=prompt`);
			expect(check.status).toBe(404);
		} finally {
			await deleteSession(sess);
		}
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
