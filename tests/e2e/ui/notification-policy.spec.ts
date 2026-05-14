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

/** Force a renderApp() pass by toggling the viewport across the desktop
 *  breakpoint (768 px) — the only viewport-driven renderApp trigger. */
async function forceRender(page: Page): Promise<void> {
	const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
	await page.setViewportSize({ width: 700, height });
	await page.setViewportSize({ width, height });
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

/** Inject a goal directly into client state and force re-render. */
async function injectGoal(
	page: Page,
	goal: { id: string; state: string; title?: string },
): Promise<void> {
	await page.evaluate((goal) => {
		const state: any = (window as any).__bobbitState;
		const existing = state.goals.findIndex((g: any) => g.id === goal.id);
		const full = {
			id: goal.id,
			title: goal.title ?? `injected ${goal.id}`,
			cwd: "/tmp",
			state: goal.state,
			spec: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		if (existing >= 0) state.goals[existing] = full;
		else state.goals.push(full);
	}, goal);
	await forceRender(page);
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

		// 2. Patch the session in client state to look like a team member —
		//    role=coder + teamLeadSessionId set + teamGoalId set. The predicate
		//    must suppress the dot.
		await patchSessionState(page, sessionId, {
			role: "coder",
			teamGoalId: "fake-goal-id",
			teamLeadSessionId: "fake-lead-id",
		});

		// After re-render, the team-member dot is gone.
		// We re-locate the row because patching may move it under a different
		// section header in the sidebar, but the data-session-id attribute is stable.
		const rowAfter = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(rowAfter.locator(".unseen-dot")).toHaveCount(0, { timeout: 5_000 });

		// 3. Mutate to team-lead with a goal in `complete` state — dot returns.
		await injectGoal(page, { id: "fake-goal-id", state: "complete" });
		await patchSessionState(page, sessionId, {
			role: "team-lead",
			teamGoalId: undefined,
			teamLeadSessionId: undefined,
			goalId: "fake-goal-id",
		});

		const rowComplete = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(rowComplete.locator(".unseen-dot")).toHaveCount(1, { timeout: 5_000 });

		// 4. Mark goal back to in-progress with a sibling streaming team-member
		//    → predicate says "live downstream work, lead not stuck" → silent.
		await injectGoal(page, { id: "fake-goal-id", state: "in-progress" });
		await page.evaluate(() => {
			const state: any = (window as any).__bobbitState;
			state.gatewaySessions.push({
				id: "fake-member-id",
				title: "fake member",
				cwd: "/tmp",
				status: "streaming",
				createdAt: Date.now(),
				lastActivity: Date.now(),
				clientCount: 1,
				role: "coder",
				teamGoalId: "fake-goal-id",
				teamLeadSessionId: state.gatewaySessions[0]?.id,
			});
		});
		await forceRender(page);

		const rowInProg = page.locator(`[data-session-id="${sessionId}"]`).first();
		await expect(rowInProg.locator(".unseen-dot")).toHaveCount(0, { timeout: 5_000 });
	});

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
