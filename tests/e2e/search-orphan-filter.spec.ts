/**
 * API E2E tests for the server-side search orphan filter and weak-match drop.
 *
 * Covers Coder A acceptance criteria from the design doc:
 *  - orphan goal dropped
 *  - orphan session dropped
 *  - orphan staff dropped
 *  - orphan message dropped (parent session deleted)
 *  - weak-match message row (snippet has no <b>) dropped
 *  - weak-match goal row kept, with matchedOn === "metadata"
 *
 * Strategy: reach into the in-process gateway to index orphan rows directly
 * against a live FlexSearchStore, then query via the normal search path
 * (projectContextManager.searchAll) and assert the filter did its job.
 * This avoids racing the fire-and-forget indexer and keeps the tests fast
 * and deterministic.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

async function getProjectId(): Promise<string> {
	const resp = await apiFetch("/api/projects");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	const list = Array.isArray(body) ? body : body.projects;
	return list[0].id;
}

/**
 * Upsert a raw FlexDoc into the project's search store.
 * Returning once the store has the row visible via count() ensures the
 * subsequent searchAll() call sees it deterministically.
 */
function pcm(gw: any): any {
	const m = gw.sessionManager.getProjectContextManager();
	expect(m).toBeTruthy();
	return m;
}

async function indexOrphan(gw: any, projectId: string, doc: Record<string, unknown>): Promise<void> {
	const ctx = pcm(gw).getOrCreate(projectId);
	expect(ctx).toBeTruthy();
	await ctx.searchIndex.whenReady();
	const store = ctx.searchIndex.getStore();
	expect(store).toBeTruthy();
	await store.upsert([doc]);
}

function searchAll(gw: any, query: string, projectId: string) {
	return pcm(gw).searchAll(query, {
		type: "all",
		limit: 50,
		offset: 0,
		projectId,
	});
}

test.describe("search orphan filter & weak-match drop", () => {
	let projectId: string;

	test.beforeAll(async () => {
		projectId = await getProjectId();
	});

	test("orphan goal is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = "zzorphgoal" + Date.now();
		await indexOrphan(gw, projectId, {
			id: `goal:ghost-${Date.now()}`,
			source_id: "goals",
			title: `Ghost goal ${token}`,
			text: `spec body mentioning ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.5,
			role: "title",
			goal_id: "ghost-does-not-exist",
		});

		const out = await searchAll(gw, token, projectId);
		const hits = out.results.filter((r: any) => r.type === "goal");
		expect(hits.length).toBe(0);
		// total tracks filtered length (may still include non-goal hits if any).
		expect(out.total).toBe(out.results.length);
	});

	test("orphan session is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = "zzorphsess" + Date.now();
		await indexOrphan(gw, projectId, {
			id: `session:ghost-${Date.now()}`,
			source_id: "sessions",
			title: `Ghost session ${token}`,
			text: `session body ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.2,
			role: "title",
			session_id: "ghost-session-does-not-exist",
		});

		const out = await searchAll(gw, token, projectId);
		const hits = out.results.filter((r: any) => r.type === "session");
		expect(hits.length).toBe(0);
	});

	test("orphan staff is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = "zzorphstaff" + Date.now();
		await indexOrphan(gw, projectId, {
			id: `staff:ghost-${Date.now()}`,
			source_id: "staff",
			title: `Ghost staff ${token}`,
			text: `profile body ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.5,
			role: "profile",
		});

		const out = await searchAll(gw, token, projectId);
		const hits = out.results.filter((r: any) => r.type === "staff");
		expect(hits.length).toBe(0);
	});

	test("orphan message (parent session missing) is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = "zzorphmsg" + Date.now();
		await indexOrphan(gw, projectId, {
			id: `message:ghost-sess:0:assistant:0`,
			source_id: "messages",
			title: "Ghost session",
			text: `user talked about ${token} in a now-deleted session`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.0,
			role: "assistant",
			session_id: "ghost-sess-does-not-exist",
		});

		const out = await searchAll(gw, token, projectId);
		const hits = out.results.filter((r: any) => r.type === "message");
		expect(hits.length).toBe(0);
	});

	test("weak-match message row (no <b> highlight) is dropped", async ({ gateway }) => {
		const gw: any = gateway;
		// Create a real session so the orphan filter doesn't drop the row first.
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId }),
		});
		expect(sessResp.status).toBe(201);
		const sessionId = (await sessResp.json()).id;

		const weakToken = "zzweakmsg" + Date.now();
		// Body text does NOT contain weakToken. The match will come from
		// identifier_text (which is derived from title+text; we include the
		// token in title only to force that path). The highlighter scans
		// `text` for the token and fails → head-of-text preview → no <b>.
		await indexOrphan(gw, projectId, {
			id: `message:${sessionId}:0:assistant:weak`,
			source_id: "messages",
			title: `title with ${weakToken}`,
			text: `this body has nothing matching the query whatsoever`,
			identifier_text: weakToken,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.0,
			role: "assistant",
			session_id: sessionId,
		});

		const out = await searchAll(gw, weakToken, projectId);
		const msgHits = out.results.filter((r: any) => r.type === "message");
		expect(msgHits.length).toBe(0);

		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
	});

	test("weak-match goal row is kept and tagged matchedOn=metadata", async ({ gateway }) => {
		const gw: any = gateway;
		// Create a real goal so existence check passes.
		const goalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Weak Match Goal", projectId }),
		});
		expect(goalResp.status).toBe(201);
		const goal = await goalResp.json();

		const weakToken = "zzweakgoal" + Date.now();
		// Index a goal doc where the token sits past the 300-char snippet
		// window — title tokenizer still matches it via identifier_text, but
		// highlight() centres on the first match in `text` and finds none,
		// returning a head-of-text preview with no <b>.
		const filler = "lorem ipsum dolor sit amet ".repeat(40); // ~1080 chars
		await indexOrphan(gw, projectId, {
			id: `goal:${goal.id}`,
			source_id: "goals",
			title: "Weak Match Goal",
			// Body text does NOT contain the token — the index hit comes
			// from identifier_text only, and highlight() can't find the
			// token in `text` so it falls back to a head-of-text preview
			// with no <b>. That's the weak-match contract we're testing.
			text: filler,
			identifier_text: weakToken,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.5,
			role: "title",
			goal_id: goal.id,
		});

		const out = await searchAll(gw, weakToken, projectId);
		const goalHits = out.results.filter((r: any) => r.type === "goal" && r.id === `goal:${goal.id}`);
		expect(goalHits.length).toBe(1);
		expect(goalHits[0].matchedOn).toBe("metadata");
		// Snippet should have no <b> tag — it's a head-of-text preview.
		expect(/<b>/i.test(goalHits[0].snippet)).toBe(false);

		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("total equals filtered length (orphans don't inflate count)", async ({ gateway }) => {
		const gw: any = gateway;
		const token = "zztotalcount" + Date.now();
		// Two orphan rows + nothing real.
		await indexOrphan(gw, projectId, {
			id: `goal:ghost-total-1-${Date.now()}`,
			source_id: "goals",
			title: `ghost 1 ${token}`,
			text: `body ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.5,
			role: "title",
			goal_id: "ghost-total-1",
		});
		await indexOrphan(gw, projectId, {
			id: `goal:ghost-total-2-${Date.now()}`,
			source_id: "goals",
			title: `ghost 2 ${token}`,
			text: `body ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now() + 1,
			weight: 1.5,
			role: "title",
			goal_id: "ghost-total-2",
		});

		const out = await searchAll(gw, token, projectId);
		expect(out.total).toBe(out.results.length);
		expect(out.results.length).toBe(0);
	});
});
