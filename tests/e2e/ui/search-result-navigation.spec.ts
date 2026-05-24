/**
 * Browser E2E tests for the "Fix & Group Search Results" feature.
 *
 * Keeps the served-app navigation contract here: every result type navigates
 * (goal, session, staff, message) with no "Connection Failed" modal. Grouping,
 * filter-pill, auto-expand, and stale-toast rendering are covered by the
 * lightweight `tests/ui-fixtures/search-preview-search-page.spec.ts` fixture.
 *
 * T2 (server-side orphan filtering) is covered exhaustively by the API E2E
 * `tests/e2e/search-orphan-filter.spec.ts`.
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
	defaultProject,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { pollUntil } from "../test-utils/cleanup.js";

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
	let lastResults: any[] = [];
	try {
		return await pollUntil(
			async () => {
				const resp = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&limit=50`);
				if (!resp.ok) return null;
				const body = await resp.json();
				lastResults = body.results || [];
				return predicate(lastResults) ? lastResults : null;
			},
			{ timeoutMs, intervalMs: 150, label: `search hit for "${query}"` },
		);
	} catch (err) {
		throw new Error(
			`waitForSearchHit timed out for "${query}" after ${timeoutMs}ms; last results: ${JSON.stringify(lastResults.map((r) => ({ type: r.type, id: r.id, title: r.title })))} (${(err as Error).message})`,
		);
	}
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
	const project = await defaultProject();
	const res = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({ ...data, cwd: project.rootPath, projectId: project.id }),
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

test.describe("Search result navigation", () => {
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

});
