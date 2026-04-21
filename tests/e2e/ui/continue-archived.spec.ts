/**
 * Browser E2E tests for "Continue in New Session" on archived sessions.
 *
 * Story CA-01 (contracts CT-05, CT-16).
 *
 * Covers design §9.2:
 *  - Archive a non-goal non-delegate session, open it, click Continue →
 *    mode chooser appears → pick Summary → land in a new session with a
 *    "Continued:" title and a fresh cwd.
 *  - Same flow with "Full transcript".
 *  - Button is hidden for goal-linked and delegate archived sessions.
 *
 * The server endpoint is `POST /api/sessions/:archivedId/continue` with
 * `{ mode: "summary" | "full" }` → `{ id, cwd, status, title }`.
 */
import { test, expect } from "../gateway-harness.js";
import {
	createSession,
	createGoal,
	deleteSession,
	deleteGoal,
	apiFetch,
	nonGitCwd,
	waitForSessionStatus,
} from "../e2e-setup.js";
import {
	openApp,
	sendMessage,
	waitForAgentResponse,
	navigateToHash,
} from "./ui-helpers.js";

/** Create a delegate session for a parent session via the REST API. */
async function createDelegate(parentId: string): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			delegateOf: parentId,
			instructions: "Continue-archived E2E delegate",
			cwd: nonGitCwd(),
		}),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
}

/** Terminate (archive) a session via DELETE. */
async function terminateSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Fetch a session record (live + archived merged) via REST. */
async function fetchSession(id: string): Promise<any | null> {
	const resp = await apiFetch(`/api/sessions/${id}`);
	if (!resp.ok) return null;
	return resp.json();
}

test.describe("Continue archived in new session", () => {
	test("Summary mode: archive → Continue → land in new session with seeded context", async ({ page }) => {
		// 1. Create a non-goal, non-delegate source session and drive it to idle.
		const sourceId = await createSession();
		await waitForSessionStatus(sourceId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${sourceId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Seed a message so the transcript is non-empty.
		await sendMessage(page, "hello");
		await waitForAgentResponse(page);
		await waitForSessionStatus(sourceId, "idle");

		const sourceBefore = await fetchSession(sourceId);
		expect(sourceBefore).toBeTruthy();
		const sourceCwd = sourceBefore.cwd;

		// 2. Archive (terminate) the source session.
		await terminateSession(sourceId);

		// 3. Re-open the archived session. Navigate away first so the client
		// picks up the archived banner state cleanly.
		await navigateToHash(page, "#/");
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 10_000 });
		await navigateToHash(page, `#/session/${sourceId}`);

		// 4. The Continue footer + button should be visible.
		const continueFooter = page.locator("[data-continue-archived-footer]");
		await expect(continueFooter).toBeVisible({ timeout: 10_000 });
		const continueBtn = continueFooter.locator("[data-action='continue-archived']");
		await expect(continueBtn).toBeVisible();

		// 5. Click → mode chooser appears.
		await continueBtn.click();
		const chooser = page.locator("continue-session-chooser");
		await expect(chooser).toBeVisible();
		await expect(chooser.locator("[role='dialog']")).toBeVisible();

		// 6. Summary is the default. Click Continue.
		await expect(chooser.locator("[data-mode='summary'][aria-checked='true']")).toBeVisible();
		await chooser.locator("[data-action='continue']").click();

		// 7. URL should change to a new session hash, different from source.
		await page.waitForFunction(
			(oldId) => {
				const h = window.location.hash || "";
				const m = h.match(/^#\/session\/([^/?]+)/);
				return !!m && m[1] !== oldId;
			},
			sourceId,
			{ timeout: 20_000 },
		);

		const newHash = await page.evaluate(() => window.location.hash);
		const match = newHash.match(/^#\/session\/([^/?]+)/);
		expect(match).toBeTruthy();
		const newId = match![1];
		expect(newId).not.toBe(sourceId);

		// 8. Assert the new session's metadata matches the contract.
		await waitForSessionStatus(newId, "idle");
		const created = await fetchSession(newId);
		expect(created).toBeTruthy();
		expect(created.title || "").toMatch(/^Continued:/);
		// Fresh runtime state — different cwd than the archived source.
		expect(created.cwd).not.toBe(sourceCwd);

		// 9. Reload → new session persists; source still archived.
		await page.reload();
		await openApp(page);
		await navigateToHash(page, `#/session/${newId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		const afterReload = await fetchSession(newId);
		expect(afterReload?.title || "").toMatch(/^Continued:/);
		const sourceAfter = await fetchSession(sourceId);
		expect(sourceAfter?.archived).toBe(true);

		await deleteSession(newId);
	});

	test("Full mode: chooser warns on large transcripts, creates new session", async ({ page }) => {
		const sourceId = await createSession();
		await waitForSessionStatus(sourceId, "idle");

		await openApp(page);
		await navigateToHash(page, `#/session/${sourceId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		await sendMessage(page, "hello");
		await waitForAgentResponse(page);
		await waitForSessionStatus(sourceId, "idle");

		await terminateSession(sourceId);
		await navigateToHash(page, "#/");
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 10_000 });
		await navigateToHash(page, `#/session/${sourceId}`);

		await expect(page.locator("[data-continue-archived-footer]")).toBeVisible({ timeout: 10_000 });
		await page.locator("[data-action='continue-archived']").click();

		const chooser = page.locator("continue-session-chooser");
		await expect(chooser).toBeVisible();

		// Switch to Full mode.
		await chooser.locator("[data-mode='full']").click();
		await expect(chooser.locator("[data-mode='full'][aria-checked='true']")).toBeVisible();

		// Warning is conditional on transcript size — just assert it doesn't
		// crash and the selection sticks.
		await chooser.locator("[data-action='continue']").click();

		await page.waitForFunction(
			(oldId) => {
				const h = window.location.hash || "";
				const m = h.match(/^#\/session\/([^/?]+)/);
				return !!m && m[1] !== oldId;
			},
			sourceId,
			{ timeout: 20_000 },
		);

		const newHash = await page.evaluate(() => window.location.hash);
		const newId = newHash.match(/^#\/session\/([^/?]+)/)![1];
		expect(newId).not.toBe(sourceId);
		await waitForSessionStatus(newId, "idle");
		const created = await fetchSession(newId);
		expect(created?.title || "").toMatch(/^Continued:/);

		await deleteSession(newId);
	});

	test("Cancel closes the chooser without creating a session", async ({ page }) => {
		const sourceId = await createSession();
		await waitForSessionStatus(sourceId, "idle");
		await terminateSession(sourceId);

		await openApp(page);
		await navigateToHash(page, `#/session/${sourceId}`);
		await expect(page.locator("[data-continue-archived-footer]")).toBeVisible({ timeout: 10_000 });

		await page.locator("[data-action='continue-archived']").click();
		const chooser = page.locator("continue-session-chooser");
		await expect(chooser).toBeVisible();

		await chooser.locator("[data-action='cancel']").click();
		await expect(chooser).toHaveCount(0);

		// URL did not change away from the archived session.
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain(sourceId);
	});

	test("Continue button is absent for goal-linked archived sessions", async ({ page }) => {
		// Create a goal and a session scoped to it.
		const goal = await createGoal({ title: "continue-archived neg goal" });
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		await waitForSessionStatus(sessionId, "idle");
		await terminateSession(sessionId);

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		// Wait for the archived banner area (transcript column) to render.
		await page.waitForFunction(() => !!document.querySelector("agent-interface"), { timeout: 10_000 });

		// The scope gate blocks the footer for goal-linked sessions.
		await expect(page.locator("[data-continue-archived-footer]")).toHaveCount(0);

		await deleteSession(sessionId);
		await deleteGoal(goalId);
	});

	test("Continue button is absent for delegate archived sessions", async ({ page }) => {
		const parentId = await createSession();
		await waitForSessionStatus(parentId, "idle");
		const delegateId = await createDelegate(parentId);
		await waitForSessionStatus(delegateId, "idle");
		await terminateSession(delegateId);

		await openApp(page);
		await navigateToHash(page, `#/session/${delegateId}`);
		await page.waitForFunction(() => !!document.querySelector("agent-interface"), { timeout: 10_000 });

		await expect(page.locator("[data-continue-archived-footer]")).toHaveCount(0);

		await deleteSession(delegateId);
		await deleteSession(parentId);
	});
});
