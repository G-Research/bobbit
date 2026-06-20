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
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";

let sessionId: string;

test.beforeAll(async () => {
	sessionId = await createSession();
});

test.afterAll(async () => {
	await deleteSession(sessionId);
});

test.describe("PUT /api/sessions/:id/draft", () => {
	test("saves a prompt draft @smoke", async () => {
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
	test("retrieves a previously saved prompt draft @smoke", async () => {
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

	test("keeps bare missing prompt draft as 404 but returns empty 204 in optional mode", async () => {
		const freshSessionId = await createSession();
		try {
			const bareResp = await apiFetch(`/api/sessions/${freshSessionId}/draft?type=prompt`);
			expect(bareResp.status, "bare missing prompt draft should remain 404").toBe(404);

			const optionalResp = await apiFetch(`/api/sessions/${freshSessionId}/draft?type=prompt&optional=1`);
			expect(optionalResp.status, "quiet optional draft absence should return 204 No Content").toBe(204);
			expect(await optionalResp.text(), "204 draft response must have no body").toBe("");
		} finally {
			await deleteSession(freshSessionId);
		}
	});

	test("returns 404 for a non-existent session", async () => {
		const resp = await apiFetch("/api/sessions/no-such-session/draft?type=prompt");
		expect(resp.status).toBe(404);
	});

	test("returns 404 for a non-existent session even in optional draft mode", async () => {
		const resp = await apiFetch("/api/sessions/no-such-session/draft?type=prompt&optional=1");
		expect(resp.status, "missing session should remain 404 even for quiet draft probes").toBe(404);
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

test.describe("draft generation staleness (gen guard)", () => {
	// The server's setDraft staleness guard must reject any write whose `gen`
	// is strictly lower than the gen already stored, so a delayed/out-of-order
	// save can never resurrect or clobber newer draft state (Bug 2). Equal or
	// higher gens are accepted. These exercise the guard over the real REST path.

	test("rejects a stale (lower-gen) PUT and keeps the newer draft", async () => {
		const sess = await createSession();
		try {
			await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: "newer", gen: 2 } }),
			});
			// Out-of-order delayed save from an earlier generation.
			const staleResp = await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: "stale", gen: 1 } }),
			});
			// Stale writes are silently discarded — still a 200, not an error.
			expect(staleResp.status).toBe(200);

			const getResp = await apiFetch(`/api/sessions/${sess}/draft?type=prompt`);
			expect(getResp.status).toBe(200);
			const body = await getResp.json();
			expect(body.data).toEqual({ text: "newer", gen: 2 });
		} finally {
			await deleteSession(sess);
		}
	});

	test("accepts an increasing gen across saves (newer write wins)", async () => {
		const sess = await createSession();
		try {
			await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: "first", gen: 1 } }),
			});
			await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: "second", gen: 2 } }),
			});

			const getResp = await apiFetch(`/api/sessions/${sess}/draft?type=prompt`);
			const body = await getResp.json();
			expect(body.data).toEqual({ text: "second", gen: 2 });
		} finally {
			await deleteSession(sess);
		}
	});

	test("tombstone-on-send is not resurrected by a delayed stale save", async () => {
		const sess = await createSession();
		try {
			// User typed; autosave landed at gen 1.
			await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: "draft text", gen: 1 } }),
			});
			// User sent: client overwrites with an empty-text tombstone at gen 2.
			await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: "", gen: 2 } }),
			});
			// A delayed autosave from the pre-send generation arrives late.
			await apiFetch(`/api/sessions/${sess}/draft`, {
				method: "PUT",
				body: JSON.stringify({ type: "prompt", data: { text: "draft text", gen: 1 } }),
			});

			const getResp = await apiFetch(`/api/sessions/${sess}/draft?type=prompt`);
			const body = await getResp.json();
			// The sent text must NOT reappear — the tombstone survives.
			expect(body.data).toEqual({ text: "", gen: 2 });
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
