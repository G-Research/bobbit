/**
 * E2E API tests for server-side review annotation REST endpoints.
 *
 * Endpoints under test:
 *   GET    /api/sessions/:id/review/annotations           — get all annotations + submitted flag
 *   POST   /api/sessions/:id/review/annotations           — add/upsert an annotation
 *   DELETE /api/sessions/:id/review/annotations/:annId     — remove one annotation
 *   DELETE /api/sessions/:id/review/annotations            — clear all (or by docTitle)
 *   GET    /api/sessions/:id/review/submitted              — get submitted flag
 *   PUT    /api/sessions/:id/review/submitted              — set submitted flag
 *   POST   /api/sessions/:id/review/annotations/bulk       — bulk overwrite
 *
 * User story references: RP-05, RP-08, RP-09, RP-16, RP-18
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createSession, deleteSession } from "./e2e-setup.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeAnnotation(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		quote: "selected text",
		comment: `comment for ${id}`,
		start: 10,
		end: 23,
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────

let sessionId: string;

test.beforeAll(async () => {
	sessionId = await createSession();
});

test.afterAll(async () => {
	await deleteSession(sessionId);
});

test.describe("Review Annotations API", () => {
	test("RP-08 API: GET returns empty initially, POST adds annotation, GET returns it", async () => {
		// GET — should be empty
		const getResp1 = await apiFetch(`/api/sessions/${sessionId}/review/annotations`);
		expect(getResp1.status).toBe(200);
		const data1 = await getResp1.json();
		expect(data1.annotations).toEqual({});
		expect(data1.submitted).toBe(false);

		// POST — add an annotation
		const ann = makeAnnotation("test-ann-1");
		const postResp = await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
			method: "POST",
			body: JSON.stringify({ docTitle: "Review", annotation: ann }),
		});
		expect(postResp.status).toBe(200);
		const postData = await postResp.json();
		expect(postData.ok).toBe(true);

		// GET — should contain the annotation
		const getResp2 = await apiFetch(`/api/sessions/${sessionId}/review/annotations`);
		expect(getResp2.status).toBe(200);
		const data2 = await getResp2.json();
		expect(data2.annotations["Review"]).toHaveLength(1);
		expect(data2.annotations["Review"][0].id).toBe("test-ann-1");
		expect(data2.annotations["Review"][0].comment).toBe("comment for test-ann-1");
	});

	test("RP-05 API: DELETE specific annotation by ID, verify gone on GET", async () => {
		// Add two annotations
		const ann1 = makeAnnotation("del-1");
		const ann2 = makeAnnotation("del-2", { comment: "second" });
		await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
			method: "POST",
			body: JSON.stringify({ docTitle: "Doc1", annotation: ann1 }),
		});
		await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
			method: "POST",
			body: JSON.stringify({ docTitle: "Doc1", annotation: ann2 }),
		});

		// Verify both exist
		const before = await (await apiFetch(`/api/sessions/${sessionId}/review/annotations`)).json();
		expect(before.annotations["Doc1"]).toHaveLength(2);

		// DELETE specific annotation
		const delResp = await apiFetch(
			`/api/sessions/${sessionId}/review/annotations/del-1?docTitle=Doc1`,
			{ method: "DELETE" },
		);
		expect(delResp.status).toBe(200);

		// Verify only ann2 remains
		const after = await (await apiFetch(`/api/sessions/${sessionId}/review/annotations`)).json();
		expect(after.annotations["Doc1"]).toHaveLength(1);
		expect(after.annotations["Doc1"][0].id).toBe("del-2");
	});

	test("RP-18 API: annotations for session A do not appear in session B (isolation)", async () => {
		const sessionA = await createSession();
		const sessionB = await createSession();

		try {
			// Add annotation to session A
			await apiFetch(`/api/sessions/${sessionA}/review/annotations`, {
				method: "POST",
				body: JSON.stringify({ docTitle: "Iso", annotation: makeAnnotation("iso-1") }),
			});

			// Session B should have no annotations
			const dataB = await (await apiFetch(`/api/sessions/${sessionB}/review/annotations`)).json();
			expect(dataB.annotations).toEqual({});

			// Session A should still have it
			const dataA = await (await apiFetch(`/api/sessions/${sessionA}/review/annotations`)).json();
			expect(dataA.annotations["Iso"]).toHaveLength(1);
		} finally {
			await deleteSession(sessionA);
			await deleteSession(sessionB);
		}
	});

	test("RP-09 API: PUT submitted=true, GET confirms, clear annotations does not reset submitted", async () => {
		const sid = await createSession();

		try {
			// Add an annotation first
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "POST",
				body: JSON.stringify({ docTitle: "Sub", annotation: makeAnnotation("sub-1") }),
			});

			// Set submitted = true
			const putResp = await apiFetch(`/api/sessions/${sid}/review/submitted`, {
				method: "PUT",
				body: JSON.stringify({ submitted: true }),
			});
			expect(putResp.status).toBe(200);

			// GET submitted confirms
			const getResp = await (await apiFetch(`/api/sessions/${sid}/review/submitted`)).json();
			expect(getResp.submitted).toBe(true);

			// Also visible via the annotations GET
			const annData = await (await apiFetch(`/api/sessions/${sid}/review/annotations`)).json();
			expect(annData.submitted).toBe(true);

			// Clear all annotations
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "DELETE",
			});

			// Submitted flag should still be true
			const afterClear = await (await apiFetch(`/api/sessions/${sid}/review/submitted`)).json();
			expect(afterClear.submitted).toBe(true);

			// Annotations should be empty
			const afterClearAnn = await (await apiFetch(`/api/sessions/${sid}/review/annotations`)).json();
			expect(afterClearAnn.annotations).toEqual({});
		} finally {
			await deleteSession(sid);
		}
	});

	test("bulk endpoint: POST overwrites all annotations + submitted flag", async () => {
		const sid = await createSession();

		try {
			// Add initial annotations via individual POST
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "POST",
				body: JSON.stringify({ docTitle: "A", annotation: makeAnnotation("old-1") }),
			});

			// Bulk overwrite
			const bulkResp = await apiFetch(`/api/sessions/${sid}/review/annotations/bulk`, {
				method: "POST",
				body: JSON.stringify({
					annotations: {
						"B": [makeAnnotation("new-1"), makeAnnotation("new-2")],
					},
					submitted: true,
				}),
			});
			expect(bulkResp.status).toBe(200);

			// Verify bulk replaced everything
			const data = await (await apiFetch(`/api/sessions/${sid}/review/annotations`)).json();
			// "A" should be gone, "B" should have 2
			expect(data.annotations["A"]).toBeUndefined();
			expect(data.annotations["B"]).toHaveLength(2);
			expect(data.submitted).toBe(true);
		} finally {
			await deleteSession(sid);
		}
	});

	test("DELETE with docTitle body clears only that document", async () => {
		const sid = await createSession();

		try {
			// Add annotations to two documents
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "POST",
				body: JSON.stringify({ docTitle: "DocX", annotation: makeAnnotation("x-1") }),
			});
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "POST",
				body: JSON.stringify({ docTitle: "DocY", annotation: makeAnnotation("y-1") }),
			});

			// Verify both docs exist
			const before = await (await apiFetch(`/api/sessions/${sid}/review/annotations`)).json();
			expect(before.annotations["DocX"]).toHaveLength(1);
			expect(before.annotations["DocY"]).toHaveLength(1);

			// DELETE only DocX
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "DELETE",
				body: JSON.stringify({ docTitle: "DocX" }),
			});

			// DocX should be gone, DocY should remain
			const after = await (await apiFetch(`/api/sessions/${sid}/review/annotations`)).json();
			expect(after.annotations["DocX"]).toBeUndefined();
			expect(after.annotations["DocY"]).toHaveLength(1);
		} finally {
			await deleteSession(sid);
		}
	});

	test("POST with missing body fields returns 400", async () => {
		// Missing annotation
		const r1 = await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
			method: "POST",
			body: JSON.stringify({ docTitle: "X" }),
		});
		expect(r1.status).toBe(400);

		// Missing docTitle
		const r2 = await apiFetch(`/api/sessions/${sessionId}/review/annotations`, {
			method: "POST",
			body: JSON.stringify({ annotation: makeAnnotation("bad") }),
		});
		expect(r2.status).toBe(400);
	});

	test("POST upserts annotation with same ID", async () => {
		const sid = await createSession();

		try {
			const ann = makeAnnotation("upsert-1", { comment: "original" });
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "POST",
				body: JSON.stringify({ docTitle: "Up", annotation: ann }),
			});

			// Upsert with updated comment
			const updated = makeAnnotation("upsert-1", { comment: "updated" });
			await apiFetch(`/api/sessions/${sid}/review/annotations`, {
				method: "POST",
				body: JSON.stringify({ docTitle: "Up", annotation: updated }),
			});

			// Should have only 1 annotation, with updated comment
			const data = await (await apiFetch(`/api/sessions/${sid}/review/annotations`)).json();
			expect(data.annotations["Up"]).toHaveLength(1);
			expect(data.annotations["Up"][0].comment).toBe("updated");
		} finally {
			await deleteSession(sid);
		}
	});
});
