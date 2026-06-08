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
 *
 * ## Test isolation (history note)
 *
 * The in-process gateway is **shared across the whole API E2E suite for
 * the worker's lifetime** — every test sees the same FlexSearchStore. That
 * has caused two distinct flake modes:
 *
 *  1. **Token collisions across tests.** `Date.now()` alone yields tokens
 *     that can collide when two tests run in the same millisecond, and
 *     under FlexSearch's `strict` tokenizer the `zz*` prefix occasionally
 *     matched leftover rows from prior tests via the `identifier_text`
 *     field. We now derive every token from a cryptographic nonce so each
 *     test's query is globally unique.
 *
 *  2. **Stale orphan rows leaking forward.** `_scheduleOpportunisticCleanup`
 *     in ProjectContextManager is fire-and-forget — by the time the next
 *     test runs, our row may or may not have been removed. We now track
 *     every doc id we insert and explicitly `deleteByIds` in afterEach so
 *     the index returns to a known-clean state before the next test.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { randomBytes } from "node:crypto";

async function getProjectId(): Promise<string> {
	const resp = await apiFetch("/api/projects");
	expect(resp.status).toBe(200);
	const body = await resp.json();
	const list = Array.isArray(body) ? body : body.projects;
	return list[0].id;
}

/** Generate a globally-unique alphanumeric token that won't collide with
 *  anything else in the shared in-process harness (other tests, stale rows
 *  from earlier tests, leftover indexer state). */
function uniqueToken(prefix: string): string {
	return `${prefix}${randomBytes(8).toString("hex")}`;
}

function pcm(gw: any): any {
	const m = gw.sessionManager.getProjectContextManager();
	expect(m).toBeTruthy();
	return m;
}

/** Tracks every FlexDoc id this test inserted so afterEach can purge them. */
type Inserted = { gw: any; projectId: string; ids: string[] };

async function indexOrphan(
	tracker: Inserted,
	doc: Record<string, unknown>,
): Promise<void> {
	const ctx = pcm(tracker.gw).getOrCreate(tracker.projectId);
	expect(ctx).toBeTruthy();
	await ctx.searchIndex.whenReady();
	const store = ctx.searchIndex.getStore();
	expect(store).toBeTruthy();
	await store.upsert([doc]);
	tracker.ids.push(String(doc.id));
}

async function purgeInserted(tracker: Inserted): Promise<void> {
	if (tracker.ids.length === 0) return;
	const ctx = pcm(tracker.gw).getOrCreate(tracker.projectId);
	const store = ctx?.searchIndex?.getStore();
	if (!store) return;
	try {
		await store.deleteByIds(tracker.ids);
	} catch {
		/* best-effort cleanup — don't mask the real test failure */
	}
	tracker.ids = [];
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
	let tracker: Inserted;

	test.beforeAll(async () => {
		projectId = await getProjectId();
	});

	test.beforeEach(async ({ gateway }) => {
		tracker = { gw: gateway, projectId, ids: [] };
	});

	test.afterEach(async () => {
		await purgeInserted(tracker);
	});

	test("orphan goal is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = uniqueToken("zzorphgoal");
		await indexOrphan(tracker, {
			id: `goal:ghost-${token}`,
			source_id: "goals",
			title: `Ghost goal ${token}`,
			text: `spec body mentioning ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.5,
			role: "title",
			goal_id: `ghost-${token}`,
		});

		const out = await searchAll(gw, token, projectId);
		const hits = out.results.filter((r: any) => r.type === "goal");
		// Diagnostic dump: if we ever see leakage again, the failure message
		// should tell us exactly which rows survived (and from where) so the
		// next person doesn't have to repro under load.
		if (hits.length !== 0) {
			console.error(
				"[orphan-goal-flake] leaked goal hits:",
				JSON.stringify(hits, null, 2),
			);
		}
		expect(hits.length).toBe(0);
		// total tracks filtered length (may still include non-goal hits if any).
		expect(out.total).toBe(out.results.length);
	});

	test("orphan session is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = uniqueToken("zzorphsess");
		await indexOrphan(tracker, {
			id: `session:ghost-${token}`,
			source_id: "sessions",
			title: `Ghost session ${token}`,
			text: `session body ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.2,
			role: "title",
			session_id: `ghost-session-${token}`,
		});

		const out = await searchAll(gw, token, projectId);
		const hits = out.results.filter((r: any) => r.type === "session");
		if (hits.length !== 0) {
			console.error("[orphan-sess-flake] leaked session hits:", JSON.stringify(hits, null, 2));
		}
		expect(hits.length).toBe(0);
	});

	test("orphan staff is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = uniqueToken("zzorphstaff");
		await indexOrphan(tracker, {
			id: `staff:ghost-${token}`,
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
		if (hits.length !== 0) {
			console.error("[orphan-staff-flake] leaked staff hits:", JSON.stringify(hits, null, 2));
		}
		expect(hits.length).toBe(0);
	});

	test("orphan message (parent session missing) is dropped server-side", async ({ gateway }) => {
		const gw: any = gateway;
		const token = uniqueToken("zzorphmsg");
		await indexOrphan(tracker, {
			id: `message:ghost-sess-${token}:0:assistant:0`,
			source_id: "messages",
			title: "Ghost session",
			text: `user talked about ${token} in a now-deleted session`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.0,
			role: "assistant",
			session_id: `ghost-sess-${token}`,
		});

		const out = await searchAll(gw, token, projectId);
		const hits = out.results.filter((r: any) => r.type === "message");
		if (hits.length !== 0) {
			console.error("[orphan-msg-flake] leaked message hits:", JSON.stringify(hits, null, 2));
		}
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

		const weakToken = uniqueToken("zzweakmsg");
		// Body text does NOT contain weakToken. The match will come from
		// identifier_text (which is derived from title+text; we include the
		// token in title only to force that path). The highlighter scans
		// `text` for the token and fails → head-of-text preview → no <b>.
		await indexOrphan(tracker, {
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

		const weakToken = uniqueToken("zzweakgoal");
		// Index a goal doc where the token sits past the 300-char snippet
		// window — title tokenizer still matches it via identifier_text, but
		// highlight() centres on the first match in `text` and finds none,
		// returning a head-of-text preview with no <b>.
		const filler = "lorem ipsum dolor sit amet ".repeat(40); // ~1080 chars
		await indexOrphan(tracker, {
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
		// SearchResult.id is emitted bare (the "goal:" source prefix on the
		// underlying FlexDoc row id is stripped in toSearchResult).
		const goalHits = out.results.filter((r: any) => r.type === "goal" && r.id === goal.id);
		expect(goalHits.length).toBe(1);
		expect(goalHits[0].matchedOn).toBe("metadata");
		// Snippet should have no <b> tag — it's a head-of-text preview.
		expect(/<b>/i.test(goalHits[0].snippet)).toBe(false);

		await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => {});
	});

	test("total equals filtered length (orphans don't inflate count)", async ({ gateway }) => {
		const gw: any = gateway;
		const token = uniqueToken("zztotalcount");
		// Two orphan rows + nothing real.
		await indexOrphan(tracker, {
			id: `goal:ghost-total-1-${token}`,
			source_id: "goals",
			title: `ghost 1 ${token}`,
			text: `body ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now(),
			weight: 1.5,
			role: "title",
			goal_id: `ghost-total-1-${token}`,
		});
		await indexOrphan(tracker, {
			id: `goal:ghost-total-2-${token}`,
			source_id: "goals",
			title: `ghost 2 ${token}`,
			text: `body ${token}`,
			project_id: projectId,
			archived: false,
			timestamp: Date.now() + 1,
			weight: 1.5,
			role: "title",
			goal_id: `ghost-total-2-${token}`,
		});

		const out = await searchAll(gw, token, projectId);
		// Primary contract: total must equal the filtered page length so
		// Load More pagination stays consistent. This must hold regardless
		// of how many rows (if any) surface for the token.
		expect(out.total).toBe(out.results.length);
		// Secondary: the two synthetic orphans we indexed should be dropped
		// by the existence filter — neither has a live goal store entry.
		const ourOrphanIds = new Set([
			`ghost-total-1-${token}`,
			`ghost-total-2-${token}`,
		]);
		const leakedOrphans = out.results.filter(
			(r: any) => r.type === "goal" && (ourOrphanIds.has(r.id) || ourOrphanIds.has(r.goalId)),
		);
		expect(leakedOrphans).toEqual([]);
	});
});
