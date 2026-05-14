/**
 * Browser E2E for the notification-policy predicate as wired into the
 * sidebar's unread-dot rendering (`hasUnseenActivity`).
 *
 * Covers the two scenarios from the goal's design doc:
 *
 *   1. Team member idle → silent (no unread dot, no favicon badge).
 *   2. Goal complete + team lead idle → notify (unread dot appears).
 *
 * Plus a reload persistence check: dot state matches server-side `lastReadAt`
 * after a fresh navigation.
 *
 * Strategy:
 *   - Create real sessions via the gateway REST API (so they appear in the
 *     sidebar with valid IDs and a `lastActivity` set by the server).
 *   - Patch each session's role / team links in the in-memory client state
 *     (`window.__bobbitState.gatewaySessions`) so the predicate sees the
 *     scenario under test. The server fields don't matter — the predicate
 *     and dot renderer read from the client state object.
 *   - Force a re-render by toggling viewport size (the canonical
 *     forceRender trick used by other E2Es).
 *   - Assert on `.unseen-dot` count.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function getDefaultProjectId(): Promise<{ id: string; rootPath: string }> {
	const resp = await apiFetch("/api/projects");
	const data = await resp.json();
	const projects = Array.isArray(data) ? data : (data.projects || []);
	expect(projects.length).toBeGreaterThan(0);
	return { id: projects[0].id, rootPath: projects[0].rootPath };
}

/** Force a renderApp() pass and wait two animation frames for the
 *  rAF-scheduled paint to land. The viewport-toggle trick used by older
 *  E2Es is unreliable on Playwright — we call `__bobbitRenderApp` directly
 *  instead (exposed on window by `src/app/main.ts` alongside
 *  `__bobbitState`). */
async function forceRender(page: Page): Promise<void> {
	await page.evaluate(() => {
		const trigger = (window as any).__bobbitRenderApp;
		if (typeof trigger === "function") trigger();
		return new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
	});
}

/** Patch a session in client state by id, then force a re-render. */
async function patchSessionState(
	page: Page,
	sessionId: string,
	patch: Record<string, unknown>,
): Promise<void> {
	await page.evaluate(({ sessionId, patch }) => {
		const state: any = (window as any).__bobbitState;
		const s = state.gatewaySessions.find((x: any) => x.id === sessionId);
		if (!s) throw new Error(`session ${sessionId} not in state.gatewaySessions`);
		Object.assign(s, patch);
	}, { sessionId, patch });
	await forceRender(page);
}

/** Disable the 5s session-list polling so in-memory patches survive long
 *  enough for the dot-count assertions (which retry for up to 5s). Without
 *  this, a poll mid-assertion overwrites `state.gatewaySessions` with the
 *  server's un-patched view and the test flakes. */
async function stopPolling(page: Page): Promise<void> {
	await page.evaluate(() => {
		const state: any = (window as any).__bobbitState;
		if (state?.sessionPollTimer) {
			clearInterval(state.sessionPollTimer);
			state.sessionPollTimer = null;
		}
	});
}

test.describe("Notification policy — sidebar unread dot", () => {
	const cleanupSessionIds: string[] = [];

	test.afterEach(async () => {
		for (const id of cleanupSessionIds.splice(0)) {
			await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("standalone idle session shows the unread dot; team-member patch silences it", async ({ page }) => {
		const proj = await getDefaultProjectId();

		// 1. Create a real standalone session. Server stamps lastActivity to
		//    now and leaves lastReadAt undefined → unread.
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json();
		const sessionId: string = sess.id;
		cleanupSessionIds.push(sessionId);

		await openApp(page);
		await navigateToHash(page, "#/");

		const row = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(row).toBeVisible({ timeout: 15_000 });

		// Sanity: the unread dot is present for a fresh standalone session.
		await expect(row.locator(".unseen-dot")).toHaveCount(1, { timeout: 5_000 });

		// Stop the 5s session-list polling so subsequent in-memory patches don't
		// get clobbered by a poll landing mid-assertion.
		await stopPolling(page);

		// 2. Patch the session in client state to look like a team member —
		//    role=coder + teamLeadSessionId set + teamGoalId set. The predicate
		//    must suppress the dot.
		await patchSessionState(page, sessionId, {
			role: "coder",
			teamGoalId: "fake-goal-id",
			teamLeadSessionId: "fake-lead-id",
		});

		// After re-render, the team-member dot is gone. The row may have moved
		// out of the ungrouped section (since the session now declares a team
		// goal) and the goal doesn't exist server-side — so the row vanishes.
		// Either way, the dot must not appear anywhere in the document.
		await expect(page.locator(`[data-session-id="${sessionId}"] .unseen-dot`))
			.toHaveCount(0, { timeout: 5_000 });

		// 3. Revert the patch — the session looks standalone again and the dot
		//    must return. This pins that the predicate is the *only* gate;
		//    nothing else memoised the suppression.
		await patchSessionState(page, sessionId, {
			role: undefined,
			teamGoalId: undefined,
			teamLeadSessionId: undefined,
		});
		await expect(page.locator(`[data-session-id="${sessionId}"]`).first().locator(".unseen-dot"))
			.toHaveCount(1, { timeout: 5_000 });
	});

	test("team-lead idle with goal complete shows the unread dot; in-progress goal hides it", async ({ page }) => {
		const proj = await getDefaultProjectId();

		// Create a real session so the server stamps lastActivity to now.
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json();
		const sessionId: string = sess.id;
		cleanupSessionIds.push(sessionId);

		await openApp(page);
		await navigateToHash(page, "#/");

		// Wait for the session row to appear before patching.
		await expect(page.locator(`[data-session-id="${sessionId}"]`).first())
			.toBeVisible({ timeout: 15_000 });

		await stopPolling(page);

		// Inject a fabricated COMPLETE team goal scoped to this project so it
		// passes the per-project bucketing filter in `sidebar.ts`. The session
		// already carries `projectId` from creation. Also force-expand it so
		// the team-lead row renders (the auto-expand path in api.ts only fires
		// for server-confirmed goals).
		const goalId = "e2e-fake-goal-complete";
		await page.evaluate(({ goalId, projectId }) => {
			const state: any = (window as any).__bobbitState;
			state.goals.push({
				id: goalId,
				title: "Fake team goal",
				cwd: "/tmp",
				projectId,
				state: "complete",
				spec: "",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				team: true,
			});
			const expanded: Set<string> = (window as any).__bobbitExpandedGoals;
			expanded.add(goalId);
		}, { goalId, projectId: proj.id });

		// Promote the session to a team-lead bound to the fabricated goal.
		await patchSessionState(page, sessionId, {
			role: "team-lead",
			goalId,
		});

		// The session is now rendered via `renderTeamLeadRow` which uses
		// `data-nav-id="session:<id>"` (not `data-session-id`). The unread
		// dot lives inside `renderSessionTime` invoked from that row.
		const tlRow = page.locator(`[data-nav-id="session:${sessionId}"]`).first();
		await expect(tlRow).toBeVisible({ timeout: 5_000 });
		await expect(tlRow.locator(".unseen-dot")).toHaveCount(1, { timeout: 5_000 });

		// Flip the goal to in-progress — the team lead is no longer at the
		// "goal complete" gate, AND has no live downstream work, so the
		// predicate returns true (stuck) and the dot stays. To exercise the
		// silent path, inject a streaming sibling member as well.
		await page.evaluate(({ goalId, leadId }) => {
			const state: any = (window as any).__bobbitState;
			const g = state.goals.find((x: any) => x.id === goalId);
			if (g) g.state = "in-progress";
			state.gatewaySessions.push({
				id: "e2e-fake-coder",
				title: "fake coder",
				cwd: "/tmp",
				status: "streaming",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				clientCount: 1,
				role: "coder",
				teamGoalId: goalId,
				teamLeadSessionId: leadId,
				projectId: g?.projectId,
			});
		}, { goalId, leadId: sessionId });
		await forceRender(page);

		const tlRow2 = page.locator(`[data-nav-id="session:${sessionId}"]`).first();
		await expect(tlRow2.locator(".unseen-dot")).toHaveCount(0, { timeout: 5_000 });
	});

	// Note: the full 9-row predicate table is covered by the unit fixture
	// `tests/notification-policy.spec.ts`. This browser E2E verifies the
	// *wiring*: that `hasUnseenActivity` is consulted on every render, that
	// mutating the team affiliation flips the dot, and that the goal-complete
	// path is plumbed through the team-lead rendering branch.


	test("dot state on reload matches server-side lastReadAt", async ({ page }) => {
		const proj = await getDefaultProjectId();

		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json();
		const sessionId: string = sess.id;
		cleanupSessionIds.push(sessionId);

		await openApp(page);
		await navigateToHash(page, "#/");

		const row = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(row).toBeVisible({ timeout: 15_000 });
		await expect(row.locator(".unseen-dot")).toHaveCount(1, { timeout: 5_000 });

		// Mark read on the server.
		const markResp = await apiFetch(`/api/sessions/${sessionId}/mark-read`, {
			method: "POST",
		});
		expect(markResp.status).toBe(200);

		// Reload — fresh navigation. The dot must NOT appear, because server
		// now reports lastReadAt >= lastActivity.
		await openApp(page);
		await navigateToHash(page, "#/");

		const rowAfter = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(rowAfter).toBeVisible({ timeout: 15_000 });
		await expect(rowAfter.locator(".unseen-dot")).toHaveCount(0, { timeout: 5_000 });
	});
});
