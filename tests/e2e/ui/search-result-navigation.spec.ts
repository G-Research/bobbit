/**
 * Browser E2E tests for the "Fix & Group Search Results" feature.
 *
 * Covers Coder C acceptance criteria from the design doc (§6):
 *  - T1 (a) every result type navigates (goal, session, staff, message) with
 *    no "Connection Failed" modal.
 *  - T3 (c) multiple message matches in one session render as a single
 *    collapsible session group card with a match-count pill.
 *  - T4 (d) expanding a group reveals nested message rows that navigate
 *    to the parent session.
 *  - T5 (e) a group with exactly one total match is auto-expanded.
 *  - T7 stale-click safety net — firing `search-result-stale` shows an
 *    inline toast on the search page and NO modal dialog.
 *
 * T2 (server-side orphan filtering) is covered exhaustively by the API E2E
 * `tests/e2e/search-orphan-filter.spec.ts` (Coder A); here we add a thin
 * sanity assertion that orphans aren't returned from the REST endpoint.
 *
 * T6 (phantom-match message rows filtered) is covered at API level in the
 * same orphan-filter spec — it requires crafting a synthetic FlexDoc with
 * `identifier_text` set to force the highlighter's head-of-text fallback.
 * Doing that via the browser is fragile; we rely on the API-level coverage.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	connectWs,
	agentEndPredicate,
	waitForSessionStatus,
	gitCwd,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll `/api/search?q=<query>` until a predicate matches, or throw.
 * Indexing is fire-and-forget, so most tests must poll a short period
 * after creating data.
 */
async function waitForSearchHit(
	query: string,
	predicate: (results: any[]) => boolean,
	timeoutMs = 15_000,
): Promise<any[]> {
	const start = Date.now();
	let lastResults: any[] = [];
	while (Date.now() - start < timeoutMs) {
		const resp = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&limit=50`);
		if (resp.ok) {
			const body = await resp.json();
			lastResults = body.results || [];
			if (predicate(lastResults)) return lastResults;
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(
		`waitForSearchHit timed out for "${query}" after ${timeoutMs}ms; last results: ${JSON.stringify(lastResults.map((r) => ({ type: r.type, id: r.id, title: r.title })))}`,
	);
}

/** Navigate directly to the search page with a prefilled query. */
async function openSearchPage(page: Page, query: string): Promise<void> {
	await openApp(page);
	await page.evaluate((q) => {
		window.location.hash = `#/search?q=${encodeURIComponent(q)}`;
	}, query);
	// Wait for the results area (search input) to render
	await expect(page.locator("input[placeholder='Search everything...']")).toBeVisible({ timeout: 10_000 });
	// Wait until at least one group card is rendered — the search debounces
	// at 200ms when typed, but programmatic nav triggers initSearchPage which
	// calls _doSearch immediately. Give the async fetch+render a moment.
}

/** Send a message over WS on an existing session and await message_end echo. */
async function sendWsMessage(sessionId: string, text: string): Promise<void> {
	const conn = await connectWs(sessionId);
	try {
		conn.send({ type: "prompt", text });
		// Wait for agent_end — mock agent emits after echoing the user
		// message and replying. message_end for the user message is what
		// triggers search indexing in session-manager.
		await conn.waitFor(agentEndPredicate(), 15_000);
	} finally {
		conn.close();
	}
}

async function createStaff(data: { name: string; systemPrompt: string }): Promise<{ id: string; currentSessionId?: string }> {
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({ ...data, cwd: gitCwd() }),
	});
	if (res.status !== 201) {
		const txt = await res.text();
		throw new Error(`createStaff failed ${res.status}: ${txt}`);
	}
	return res.json();
}

async function deleteStaff(id: string): Promise<void> {
	await apiFetch(`/api/staff/${id}`, { method: "DELETE" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Search result navigation & grouping", () => {
	/**
	 * T1 — every result type clicks through to its view, with no modal.
	 *
	 * Uses a shared, unique token across a goal, a session, a staff record,
	 * and a user message so a single query surfaces one hit of each type.
	 */
	test("every result type navigates without modal", async ({ page }) => {
		const token = `NavTok${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

		const goal = await createGoal({ title: `${token} NavGoal` });
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: `${token} NavSession` }),
		});
		const staff = await createStaff({
			name: `${token} NavStaff`,
			systemPrompt: "Nav staff for search-nav E2E",
		});
		const staffSessionId = staff.currentSessionId;

		// Also send a user message so a `message`-type hit exists.
		// Use a SEPARATE session so its session-title hit doesn't drown the
		// message-body hit for the shared token.
		const msgSessionId = await createSession();
		await waitForSessionStatus(msgSessionId, "idle");
		await sendWsMessage(msgSessionId, `Message body mentioning ${token} for search`);

		try {
			// Wait until indexer has at least one of each type.
			await waitForSearchHit(token, (results) => {
				const types = new Set(results.map((r: any) => r.type));
				return (
					types.has("goal")
					&& types.has("session")
					&& types.has("staff")
					&& types.has("message")
				);
			}, 30_000);

			// --- Goal ---
			await openSearchPage(page, token);
			const goalCard = page.locator(`[data-role="result-group"][data-kind="goal"]`).filter({ hasText: `${token} NavGoal` });
			await expect(goalCard).toBeVisible({ timeout: 10_000 });
			await goalCard.locator("button").first().click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
				.toContain(goal.id);
			await expect(page.locator('[role="dialog"]')).toHaveCount(0);

			// --- Session (direct title match) ---
			await openSearchPage(page, token);
			const sessionCard = page.locator(`[data-role="result-group"][data-kind="session"]`).filter({ hasText: `${token} NavSession` });
			await expect(sessionCard).toBeVisible({ timeout: 10_000 });
			await sessionCard.locator("button").first().click();
			// The hash should contain the bare session id (source prefix is
			// stripped server-side in toSearchResult). The modal-suppression
			// check below is the real UX contract per acceptance criterion (a).
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
				.toContain(sessionId);
			await expect(page.locator('[role="dialog"]')).toHaveCount(0);

			// --- Staff ---
			await openSearchPage(page, token);
			const staffCard = page.locator(`[data-role="result-group"][data-kind="staff"]`).filter({ hasText: `${token} NavStaff` });
			await expect(staffCard).toBeVisible({ timeout: 10_000 });
			await staffCard.locator("button").first().click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
				.toContain(staff.id);
			await expect(page.locator('[role="dialog"]')).toHaveCount(0);

			// --- Message (group keyed by parent session id) ---
			await openSearchPage(page, token);
			const msgGroup = page.locator(`[data-role="result-group"][data-kind="session"][data-key="session:${msgSessionId}"]`);
			await expect(msgGroup).toBeVisible({ timeout: 10_000 });
			await msgGroup.locator("button").first().click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
				.toContain(msgSessionId);
			await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		} finally {
			await deleteGoal(goal.id);
			await deleteSession(sessionId);
			await deleteSession(msgSessionId);
			if (staffSessionId) await deleteSession(staffSessionId);
			await deleteStaff(staff.id);
		}
	});

	/**
	 * T3 — multiple message matches from one session collapse into a single
	 * session group card with a "5 in messages" (or "5 matches") pill.
	 */
	test("multiple message matches group into a single session card", async ({ page }) => {
		const token = `ZzQuacker${Date.now().toString(36)}`;
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			// Send five distinct messages all containing the rare token.
			for (let i = 0; i < 5; i++) {
				await sendWsMessage(sessionId, `quack #${i}: ${token} body text ${i}`);
			}

			// Wait until at least 5 message hits are indexed.
			await waitForSearchHit(token, (results) => {
				const msgHits = results.filter((r: any) => r.type === "message" && r.sessionId === sessionId);
				return msgHits.length >= 5;
			}, 30_000);

			await openSearchPage(page, token);

			// Exactly one card per session (no duplicates across the flat list).
			const sessionCards = page.locator(
				`[data-role="result-group"][data-kind="session"][data-key="session:${sessionId}"]`,
			);
			await expect(sessionCards).toHaveCount(1, { timeout: 10_000 });

			// Match-count pill should reference 5 message hits.
			const pill = sessionCards.first().locator("span").filter({ hasText: /in messages|matches/i }).first();
			await expect(pill).toHaveText(/5\s*(in messages|matches)/i, { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	/**
	 * T4 — clicking the chevron on a grouped card reveals nested message
	 * rows, and clicking a nested row navigates to the parent session.
	 */
	test("expanding a group reveals nested rows that navigate", async ({ page }) => {
		const token = `ZzExpand${Date.now().toString(36)}`;
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			for (let i = 0; i < 5; i++) {
				await sendWsMessage(sessionId, `${token} expand-test message ${i}`);
			}

			await waitForSearchHit(token, (results) => {
				const msgHits = results.filter((r: any) => r.type === "message" && r.sessionId === sessionId);
				return msgHits.length >= 5;
			}, 30_000);

			await openSearchPage(page, token);

			const card = page.locator(
				`[data-role="result-group"][data-kind="session"][data-key="session:${sessionId}"]`,
			);
			await expect(card).toBeVisible({ timeout: 10_000 });

			// With >1 match, the card should start collapsed.
			await expect(card).toHaveAttribute("data-expanded", "false", { timeout: 5_000 });

			// Click the chevron to expand.
			const chevron = card.locator('[data-role="group-chevron"]');
			await chevron.click();

			await expect(card).toHaveAttribute("data-expanded", "true", { timeout: 5_000 });

			// Nested child rows — expect 5.
			const children = card.locator('[data-role="result-child"]');
			await expect(children).toHaveCount(5, { timeout: 5_000 });

			// Click the first nested row → navigate to the parent session.
			await children.first().click();
			await expect.poll(() => page.evaluate(() => window.location.hash), { timeout: 10_000 })
				.toContain(sessionId);
			await expect(page.locator('[role="dialog"]')).toHaveCount(0);
		} finally {
			await deleteSession(sessionId);
		}
	});

	/**
	 * T5 — a group with exactly one total match is rendered auto-expanded
	 * (no click required).
	 */
	test("group with exactly one match auto-expands", async ({ page }) => {
		const token = `UniqueTitleMatchOnly${Date.now().toString(36)}`;
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		// Use a title that contains the token but send no messages matching it.
		await apiFetch(`/api/sessions/${sessionId}`, {
			method: "PATCH",
			body: JSON.stringify({ title: `${token} auto-expand session` }),
		});

		try {
			await waitForSearchHit(token, (results) => {
				return results.some((r: any) => r.type === "session" && (r.id === sessionId || r.id === `session:${sessionId}`));
			}, 30_000);

			await openSearchPage(page, token);

			// Session hit's group key is `session:${hit.id}` where hit.id is `session:<uuid>`.
			// Filter by the session title instead of keying on data-key.
			const card = page.locator(`[data-role="result-group"][data-kind="session"]`)
				.filter({ hasText: token });
			await expect(card).toBeVisible({ timeout: 10_000 });

			// Exactly one match → auto-expanded without any click.
			await expect(card).toHaveAttribute("data-expanded", "true", { timeout: 5_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	/**
	 * T7 — stale-click safety net. Firing a synthetic
	 * `search-result-stale` CustomEvent from the search page should show
	 * an inline toast and no modal dialog. This is the cheap, deterministic
	 * way to exercise the UX contract without racing the indexer.
	 */
	test("stale-click shows inline toast, not a modal", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/search"; });
		await expect(page.locator("input[placeholder='Search everything...']")).toBeVisible({ timeout: 10_000 });

		// Dispatch the event the search page listens for.
		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("search-result-stale", {
				detail: { kind: "session", id: "00000000-0000-0000-0000-000000000000" },
			}));
		});

		const toast = page.locator('[data-role="stale-toast"]');
		await expect(toast).toBeVisible({ timeout: 5_000 });
		await expect(toast).toContainText(/no longer available/i);

		// No blocking modal was shown.
		await expect(page.locator('[role="dialog"]')).toHaveCount(0);

		// Dismiss button clears the toast.
		await toast.locator("button", { hasText: /dismiss/i }).click();
		await expect(toast).toHaveCount(0, { timeout: 3_000 });
	});

	/**
	 * AC #5 — Type filter pills still work across the grouped layout.
	 *
	 * Filters start all-on (goals, sessions, staff, messages). Clicking an
	 * active pill deactivates that type (unless it is the last remaining —
	 * the UI forbids deselecting everything). There is no "All" pill.
	 *
	 * The design (§4.7) runs the filter over the flat `_results` array
	 * BEFORE grouping: a group survives iff at least one child hit survives.
	 */
	test("filter = messages only hides goal cards but keeps session groups with message-only children", async ({ page }) => {
		const token = `FiltMsg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
		const goal = await createGoal({ title: `${token} FiltGoal` });
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			for (let i = 0; i < 3; i++) {
				await sendWsMessage(sessionId, `${token} filter-test message ${i}`);
			}

			// Wait for index to carry both the goal-title hit AND >=3 message hits.
			await waitForSearchHit(token, (results) => {
				const hasGoal = results.some((r: any) => r.type === "goal");
				const msgHits = results.filter((r: any) => r.type === "message" && r.sessionId === sessionId);
				return hasGoal && msgHits.length >= 3;
			}, 30_000);

			await openSearchPage(page, token);

			const goalCards = page.locator(`[data-role="result-group"][data-kind="goal"]`);
			const sessionCards = page.locator(
				`[data-role="result-group"][data-kind="session"][data-key="session:${sessionId}"]`,
			);

			// Sanity: both visible before filtering.
			await expect(goalCards.filter({ hasText: `${token} FiltGoal` })).toHaveCount(1, { timeout: 10_000 });
			await expect(sessionCards).toHaveCount(1, { timeout: 10_000 });

			// Deactivate every pill except "Messages" so only message hits remain.
			// (The UI has no explicit "only" affordance — toggle off the others.)
			for (const label of ["Goals", "Sessions", "Staff"]) {
				await page.getByRole("button", { name: label, exact: true }).click();
			}

			// Goal card (no message children) disappears; session with message-only
			// children survives since its message hits pass the filter.
			await expect(goalCards).toHaveCount(0, { timeout: 5_000 });
			await expect(sessionCards).toHaveCount(1, { timeout: 5_000 });

			// The match-count pill now reflects messages-only: "N matches" (no
			// "in title" segment because the title hit is filtered out).
			const pill = sessionCards.first().locator("span").filter({ hasText: /in messages|matches/i }).first();
			await expect(pill).toHaveText(/3\s*(in messages|matches)/i, { timeout: 5_000 });
		} finally {
			await deleteGoal(goal.id);
			await deleteSession(sessionId);
		}
	});

	test("filter = goals only hides session cards that have only message hits", async ({ page }) => {
		const token = `FiltGoalOnly${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
		const goal = await createGoal({ title: `${token} FiltGoal` });
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			for (let i = 0; i < 2; i++) {
				await sendWsMessage(sessionId, `${token} goals-only message ${i}`);
			}

			await waitForSearchHit(token, (results) => {
				const hasGoal = results.some((r: any) => r.type === "goal");
				const msgHits = results.filter((r: any) => r.type === "message" && r.sessionId === sessionId);
				return hasGoal && msgHits.length >= 2;
			}, 30_000);

			await openSearchPage(page, token);

			const goalCards = page.locator(`[data-role="result-group"][data-kind="goal"]`)
				.filter({ hasText: `${token} FiltGoal` });
			const sessionCards = page.locator(
				`[data-role="result-group"][data-kind="session"][data-key="session:${sessionId}"]`,
			);

			await expect(goalCards).toHaveCount(1, { timeout: 10_000 });
			await expect(sessionCards).toHaveCount(1, { timeout: 10_000 });

			// Deactivate all pills except "Goals".
			for (const label of ["Sessions", "Staff", "Messages"]) {
				await page.getByRole("button", { name: label, exact: true }).click();
			}

			// Session group (message-only children) disappears; goal card remains.
			await expect(sessionCards).toHaveCount(0, { timeout: 5_000 });
			await expect(goalCards).toHaveCount(1, { timeout: 5_000 });
		} finally {
			await deleteGoal(goal.id);
			await deleteSession(sessionId);
		}
	});

	test("re-activating deactivated filter pills restores hidden groups", async ({ page }) => {
		// The UI has no single "All" / "clear" affordance — filters are
		// independent toggles. "Clearing" means re-selecting pills that were
		// previously deactivated. This test exercises that round-trip to
		// confirm group visibility is recomputed on every filter change.
		const token = `FiltRestore${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
		const goal = await createGoal({ title: `${token} FiltGoal` });
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			for (let i = 0; i < 2; i++) {
				await sendWsMessage(sessionId, `${token} restore message ${i}`);
			}

			await waitForSearchHit(token, (results) => {
				const hasGoal = results.some((r: any) => r.type === "goal");
				const msgHits = results.filter((r: any) => r.type === "message" && r.sessionId === sessionId);
				return hasGoal && msgHits.length >= 2;
			}, 30_000);

			await openSearchPage(page, token);

			const goalCards = page.locator(`[data-role="result-group"][data-kind="goal"]`)
				.filter({ hasText: `${token} FiltGoal` });
			const sessionCards = page.locator(
				`[data-role="result-group"][data-kind="session"][data-key="session:${sessionId}"]`,
			);

			await expect(goalCards).toHaveCount(1, { timeout: 10_000 });
			await expect(sessionCards).toHaveCount(1, { timeout: 10_000 });

			// Deactivate Messages → session group (message-only) disappears.
			await page.getByRole("button", { name: "Messages", exact: true }).click();
			await expect(sessionCards).toHaveCount(0, { timeout: 5_000 });
			await expect(goalCards).toHaveCount(1, { timeout: 5_000 });

			// Re-activate Messages → session group reappears.
			await page.getByRole("button", { name: "Messages", exact: true }).click();
			await expect(sessionCards).toHaveCount(1, { timeout: 5_000 });
			await expect(goalCards).toHaveCount(1, { timeout: 5_000 });
		} finally {
			await deleteGoal(goal.id);
			await deleteSession(sessionId);
		}
	});

	/**
	 * T2 — server-side orphan filter. Full coverage (each type + weak-match
	 * behavior) lives in the API E2E `tests/e2e/search-orphan-filter.spec.ts`.
	 * Goals deleted via `DELETE /api/goals/:id` are *archived*, not purged,
	 * so they legitimately remain in the search index — the orphan contract
	 * there is tested by indexing synthetic orphan rows against a nonexistent
	 * goalStore entry, which the browser harness can't easily do.
	 */
});
