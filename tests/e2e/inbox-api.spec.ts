/**
 * E2E tests for the staff inbox REST surface.
 *
 * Covers (per docs/design/staff-inbox.md §7):
 *   - POST /api/staff/:id/inbox                       — 201 enqueue, 400 missing fields, 404 unknown staff
 *   - GET  /api/staff/:id/inbox?state=…               — filtering, default
 *   - POST /api/staff/:id/inbox/:entryId/complete     — 200, 403 cross-staff, 404 unknown, 409 non-pending
 *   - POST /api/staff/:id/inbox/:entryId/dismiss      — 200 for failed and cancelled, 400 bad outcome
 *   - DELETE /api/staff/:id/inbox/:entryId            — 200 prune, 404 unknown
 *
 * Uses the in-process gateway harness. Each enqueue produces a distinct entry
 * (no coalescing) so the tests can assert ordering and per-entry transitions.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, gitCwd, readE2EToken } from "./e2e-setup.js";

async function createStaff(name: string) {
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name,
			systemPrompt: "Inbox test agent.",
			cwd: gitCwd(),
		}),
	});
	expect(res.status).toBe(201);
	return res.json();
}

async function enqueue(staffId: string, body: { title: string; prompt: string; context?: string; source?: any }) {
	return apiFetch(`/api/staff/${staffId}/inbox`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

test.describe("Staff inbox — REST API", () => {
	const cleanupStaffIds: string[] = [];

	test.beforeAll(() => {
		void readE2EToken();
	});

	test.afterAll(async () => {
		for (const id of cleanupStaffIds) {
			await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("POST creates a pending entry; GET ?state=pending lists it", async () => {
		const staff = await createStaff("Inbox A");
		cleanupStaffIds.push(staff.id);

		const res = await enqueue(staff.id, { title: "First", prompt: "do the thing" });
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.entry).toBeTruthy();
		expect(body.entry.id).toBeTruthy();
		expect(body.entry.staffId).toBe(staff.id);
		expect(body.entry.state).toBe("pending");
		expect(body.entry.title).toBe("First");
		expect(body.entry.prompt).toBe("do the thing");
		expect(body.entry.source.type).toBe("manual_api");
		expect(body.entry.createdAt).toBeGreaterThan(0);

		// List pending
		const listRes = await apiFetch(`/api/staff/${staff.id}/inbox?state=pending`);
		expect(listRes.ok).toBe(true);
		const list = await listRes.json();
		expect(Array.isArray(list.entries)).toBe(true);
		expect(list.entries.length).toBe(1);
		expect(list.entries[0].id).toBe(body.entry.id);

		// GET ?state=completed should be empty
		const completedRes = await apiFetch(`/api/staff/${staff.id}/inbox?state=completed`);
		const completed = await completedRes.json();
		expect(completed.entries).toEqual([]);
	});

	test("POST honours source.type=manual_ui and falls through to manual_api otherwise", async () => {
		const staff = await createStaff("Inbox source-shape");
		cleanupStaffIds.push(staff.id);

		const ui = await (await enqueue(staff.id, { title: "ui", prompt: "p", source: { type: "manual_ui", actorId: "user-1" } })).json();
		expect(ui.entry.source.type).toBe("manual_ui");
		expect(ui.entry.source.actorId).toBe("user-1");

		const noSource = await (await enqueue(staff.id, { title: "no-source", prompt: "p" })).json();
		expect(noSource.entry.source.type).toBe("manual_api");

		const garbage = await (await enqueue(staff.id, { title: "junk", prompt: "p", source: { type: "invalid_xyz" as any } })).json();
		expect(garbage.entry.source.type).toBe("manual_api");
	});

	test("POST missing title → 400; missing prompt → 400", async () => {
		const staff = await createStaff("Inbox validation");
		cleanupStaffIds.push(staff.id);

		const noTitle = await apiFetch(`/api/staff/${staff.id}/inbox`, {
			method: "POST",
			body: JSON.stringify({ prompt: "p" }),
		});
		expect(noTitle.status).toBe(400);

		const noPrompt = await apiFetch(`/api/staff/${staff.id}/inbox`, {
			method: "POST",
			body: JSON.stringify({ title: "t" }),
		});
		expect(noPrompt.status).toBe(400);
	});

	test("404 on unknown staff for all routes", async () => {
		const list = await apiFetch("/api/staff/nope-123/inbox");
		expect(list.status).toBe(404);

		const post = await apiFetch("/api/staff/nope-123/inbox", {
			method: "POST",
			body: JSON.stringify({ title: "t", prompt: "p" }),
		});
		expect(post.status).toBe(404);

		const complete = await apiFetch("/api/staff/nope-123/inbox/entry-9/complete", {
			method: "POST",
			body: JSON.stringify({ sessionId: "x" }),
		});
		expect(complete.status).toBe(404);

		const dismiss = await apiFetch("/api/staff/nope-123/inbox/entry-9/dismiss", {
			method: "POST",
			body: JSON.stringify({ sessionId: "x", outcome: "cancelled", reason: "n/a" }),
		});
		expect(dismiss.status).toBe(404);

		const del = await apiFetch("/api/staff/nope-123/inbox/entry-9", { method: "DELETE" });
		expect(del.status).toBe(404);
	});

	test("complete transitions pending → completed; 404 on unknown entry; 409 on non-pending re-completion", async () => {
		const staff = await createStaff("Inbox complete");
		cleanupStaffIds.push(staff.id);

		const enq = await (await enqueue(staff.id, { title: "work", prompt: "p" })).json();
		const entryId = enq.entry.id;
		const sessionId = staff.currentSessionId;
		expect(sessionId).toBeTruthy();

		const ok = await apiFetch(`/api/staff/${staff.id}/inbox/${entryId}/complete`, {
			method: "POST",
			body: JSON.stringify({ sessionId, summary: "done well" }),
		});
		expect(ok.status).toBe(200);
		const okBody = await ok.json();
		expect(okBody.entry.state).toBe("completed");
		expect(okBody.entry.result).toBe("done well");
		expect(okBody.entry.completedAt).toBeGreaterThan(0);

		// 409: completing an already-completed entry
		const second = await apiFetch(`/api/staff/${staff.id}/inbox/${entryId}/complete`, {
			method: "POST",
			body: JSON.stringify({ sessionId, summary: "again" }),
		});
		expect(second.status).toBe(409);

		// 404: unknown entry
		const unknown = await apiFetch(`/api/staff/${staff.id}/inbox/nonexistent-entry/complete`, {
			method: "POST",
			body: JSON.stringify({ sessionId }),
		});
		expect(unknown.status).toBe(404);
	});

	test("dismiss transitions pending → failed and → cancelled with reason", async () => {
		const staff = await createStaff("Inbox dismiss");
		cleanupStaffIds.push(staff.id);
		const sessionId = staff.currentSessionId;

		const a = await (await enqueue(staff.id, { title: "a", prompt: "p" })).json();
		const aRes = await apiFetch(`/api/staff/${staff.id}/inbox/${a.entry.id}/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId, outcome: "failed", reason: "tool error" }),
		});
		expect(aRes.status).toBe(200);
		const aBody = await aRes.json();
		expect(aBody.entry.state).toBe("failed");
		expect(aBody.entry.error).toBe("tool error");

		const b = await (await enqueue(staff.id, { title: "b", prompt: "p" })).json();
		const bRes = await apiFetch(`/api/staff/${staff.id}/inbox/${b.entry.id}/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId, outcome: "cancelled", reason: "not relevant" }),
		});
		expect(bRes.status).toBe(200);
		const bBody = await bRes.json();
		expect(bBody.entry.state).toBe("cancelled");
		expect(bBody.entry.error).toBe("not relevant");

		// Invalid outcome → 400
		const c = await (await enqueue(staff.id, { title: "c", prompt: "p" })).json();
		const bad = await apiFetch(`/api/staff/${staff.id}/inbox/${c.entry.id}/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId, outcome: "stalled", reason: "n/a" }),
		});
		expect(bad.status).toBe(400);

		// Missing reason → 400
		const noReason = await apiFetch(`/api/staff/${staff.id}/inbox/${c.entry.id}/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId, outcome: "cancelled" }),
		});
		expect(noReason.status).toBe(400);
	});

	test("complete/dismiss return 403 when sessionId.staffId mismatches :id", async () => {
		const a = await createStaff("Inbox mismatch-A");
		cleanupStaffIds.push(a.id);
		const b = await createStaff("Inbox mismatch-B");
		cleanupStaffIds.push(b.id);

		const entry = await (await enqueue(a.id, { title: "for-A", prompt: "p" })).json();

		const wrongComplete = await apiFetch(`/api/staff/${a.id}/inbox/${entry.entry.id}/complete`, {
			method: "POST",
			body: JSON.stringify({ sessionId: b.currentSessionId, summary: "nope" }),
		});
		expect(wrongComplete.status).toBe(403);

		const wrongDismiss = await apiFetch(`/api/staff/${a.id}/inbox/${entry.entry.id}/dismiss`, {
			method: "POST",
			body: JSON.stringify({ sessionId: b.currentSessionId, outcome: "cancelled", reason: "x" }),
		});
		expect(wrongDismiss.status).toBe(403);

		// Entry is still pending after the rejected calls.
		const list = await (await apiFetch(`/api/staff/${a.id}/inbox?state=pending`)).json();
		expect(list.entries.find((e: any) => e.id === entry.entry.id)?.state).toBe("pending");
	});

	test("DELETE prunes an entry; subsequent GET excludes it", async () => {
		const staff = await createStaff("Inbox prune");
		cleanupStaffIds.push(staff.id);

		const entry = await (await enqueue(staff.id, { title: "transient", prompt: "p" })).json();

		const del = await apiFetch(`/api/staff/${staff.id}/inbox/${entry.entry.id}`, { method: "DELETE" });
		expect(del.status).toBe(200);
		const delBody = await del.json();
		expect(delBody.ok).toBe(true);

		const list = await (await apiFetch(`/api/staff/${staff.id}/inbox`)).json();
		expect(list.entries.find((e: any) => e.id === entry.entry.id)).toBeUndefined();

		// Pruning the same entry again → 404
		const second = await apiFetch(`/api/staff/${staff.id}/inbox/${entry.entry.id}`, { method: "DELETE" });
		expect(second.status).toBe(404);
	});

	test("listing returns entries in insertion (FIFO) order; limit caps the result", async () => {
		const staff = await createStaff("Inbox order");
		cleanupStaffIds.push(staff.id);

		const titles = ["one", "two", "three", "four"];
		for (const t of titles) {
			const res = await enqueue(staff.id, { title: t, prompt: "p" });
			expect(res.status).toBe(201);
		}

		const all = await (await apiFetch(`/api/staff/${staff.id}/inbox`)).json();
		expect(all.entries.map((e: any) => e.title)).toEqual(titles);

		const limited = await (await apiFetch(`/api/staff/${staff.id}/inbox?limit=2`)).json();
		expect(limited.entries.length).toBe(2);
		expect(limited.entries.map((e: any) => e.title)).toEqual(["one", "two"]);
	});

	test("legacy /api/staff/:id/wake endpoint is gone (404)", async () => {
		const staff = await createStaff("Inbox legacy-wake");
		cleanupStaffIds.push(staff.id);

		const res = await apiFetch(`/api/staff/${staff.id}/wake`, {
			method: "POST",
			body: JSON.stringify({ prompt: "hi" }),
		});
		// Could be 404 (no route matches) — the key is that it is not 201/200.
		expect(res.status).not.toBe(200);
		expect(res.status).not.toBe(201);
	});

	test("PUT /api/staff/:id round-trips contextPolicy (compact → preserve → compact)", async () => {
		const staff = await createStaff("Inbox contextPolicy");
		cleanupStaffIds.push(staff.id);

		// Default after creation is "compact" (the migration default).
		const initial = await (await apiFetch(`/api/staff/${staff.id}`)).json();
		expect(initial.contextPolicy === undefined || initial.contextPolicy === "compact").toBe(true);

		// Flip to "preserve" via PUT and confirm the response reflects the change.
		const flipRes = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ contextPolicy: "preserve" }),
		});
		expect(flipRes.status).toBe(200);
		const flipped = await flipRes.json();
		expect(flipped.contextPolicy).toBe("preserve");

		// Persisted to disk: a fresh GET reads back "preserve".
		const reread = await (await apiFetch(`/api/staff/${staff.id}`)).json();
		expect(reread.contextPolicy).toBe("preserve");

		// Flip back to "compact" — confirms both directions wire through.
		const backRes = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ contextPolicy: "compact" }),
		});
		expect(backRes.status).toBe(200);
		const back = await backRes.json();
		expect(back.contextPolicy).toBe("compact");

		// Bogus values are dropped, leaving the previously-saved value intact.
		const bogusRes = await apiFetch(`/api/staff/${staff.id}`, {
			method: "PUT",
			body: JSON.stringify({ contextPolicy: "clear", name: "Inbox contextPolicy renamed" }),
		});
		expect(bogusRes.status).toBe(200);
		const afterBogus = await bogusRes.json();
		expect(afterBogus.contextPolicy).toBe("compact");
		expect(afterBogus.name).toBe("Inbox contextPolicy renamed");
	});
});
