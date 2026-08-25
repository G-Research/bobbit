/**
 * Journey: Misc: session chrome, notifications, retry state, and responsive smoke.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { apiFetch, defaultProject } from "../_helpers/journey-fixture.js";

test.describe("Journey: Notification Policy", () => {
	test("app renders without notification errors and settings route is reachable", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 20_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("fresh session has unseen dot; mark-read via API removes it after reload", async ({ page }) => {
		const proj = await defaultProject();
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json() as { id: string };
		const sessionId = sess.id;
		try {
			await openApp(page);
			await navigateToHash(page, "#/");
			const row = page.locator(`[data-session-id="${sessionId}"]`).first();
			await expect(row).toBeVisible({ timeout: 15_000 });
			await expect(row.locator(".unseen-dot")).toHaveCount(1, { timeout: 15_000 });
			const markResp = await apiFetch(`/api/sessions/${sessionId}/mark-read`, { method: "POST" });
			expect(markResp.status).toBe(200);
			await openApp(page);
			await navigateToHash(page, "#/");
			const rowAfter = page.locator(`[data-session-id="${sessionId}"]`).first();
			await expect(rowAfter).toBeVisible({ timeout: 15_000 });
			await expect(rowAfter.locator(".unseen-dot")).toHaveCount(0, { timeout: 15_000 });
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("team-member session patch hides the unread dot", async ({ page }) => {
		const proj = await defaultProject();
		const sessResp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: proj.rootPath, projectId: proj.id }),
		});
		expect(sessResp.status).toBe(201);
		const sess = await sessResp.json() as { id: string };
		const sessionId = sess.id;
		try {
			await openApp(page);
			await navigateToHash(page, "#/");
			const row = page.locator(`[data-session-id="${sessionId}"]`).first();
			await expect(row).toBeVisible({ timeout: 15_000 });
			await expect(row.locator(".unseen-dot")).toHaveCount(1, { timeout: 15_000 });
			await page.evaluate(() => {
				const state: any = (window as any).__bobbitState;
				if (state?.sessionPollTimer) { clearInterval(state.sessionPollTimer); state.sessionPollTimer = null; }
			});
			await page.evaluate(({ sid }: { sid: string }) => {
				const state: any = (window as any).__bobbitState;
				const s = state?.gatewaySessions?.find((x: any) => x.id === sid);
				if (s) { s.role = "coder"; s.teamGoalId = "fake-goal"; s.teamLeadSessionId = "fake-lead"; }
				(window as any).__bobbitRenderApp?.();
				return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
			}, { sid: sessionId });
			await expect(page.locator(`[data-session-id="${sessionId}"] .unseen-dot`)).toHaveCount(0, { timeout: 15_000 });
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
test.describe("Journey: Footer Working Directory", () => {
	test.use({ permissions: ["clipboard-read", "clipboard-write"] });

	test("desktop footer shows the full path and copies it", async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		const project = await defaultProject();
		const sessionId = await createSession({ cwd: project.rootPath, projectId: project.id });
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const cwdPath = page.getByTestId("footer-cwd-path");
			await expect(cwdPath).toBeVisible({ timeout: 15_000 });
			await expect(cwdPath).toHaveText(project.rootPath);
			await expect(cwdPath).toHaveAttribute("title", project.rootPath);

			const copyButton = page.getByTestId("footer-cwd-copy");
			await copyButton.click();
			await expect(copyButton).toHaveAttribute("aria-label", "Working directory copied");
			await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 }).toBe(project.rootPath);

			await page.reload();
			await expect(page.getByTestId("footer-cwd-path")).toHaveText(project.rootPath, { timeout: 20_000 });
			await expect(page.getByTestId("footer-cwd-copy")).toBeVisible();
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
test.describe("Journey: Dynamic Panels", () => {
	test("session route renders for dynamic panel scenario", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Mobile Layout", () => {
	test("app renders at mobile viewport", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test.skip("sidebar-edge visible at mobile viewport", async ({ page }) => {
		// Skipped: .sidebar-edge is typically hidden/collapsed at mobile viewport width.
		// Mobile sidebar behaviour is tested by geometry-fixture specs.
		await page.setViewportSize({ width: 390, height: 844 });
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});
// Ported from auto-retry-banner.spec.ts (audit: misc GAP): an injected
// auto_retry_pending event renders the banner with its data-* attributes.
test.describe("Journey: Auto-Retry Banner", () => {
	test("auto_retry_pending renders the banner with reason/attempt/delay", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const banner = page.locator('[data-testid="auto-retry-banner"]');
			await expect(banner).toHaveCount(0);
			// Inject the same event the server broadcasts from maybeAutoRetryTransient.
			await page.evaluate(() => {
				(window as any).__bobbitState.remoteAgent.handleAgentEvent({
					type: "auto_retry_pending", reason: "provider-overload",
					retryDelayMs: 4000, attempt: 3, scheduledAt: Date.now(), error: "overloaded_error",
				});
			});
			await expect(banner).toBeVisible({ timeout: 10_000 });
			await expect(banner).toHaveAttribute("data-reason", "provider-overload");
			await expect(banner).toHaveAttribute("data-attempt", "3");
			await expect(banner).toHaveAttribute("data-retry-delay-ms", "4000");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

// A terminal non-retryable turn with queued work must visibly require a human
// retry, and the next turn must clear the parked-work state.
test.describe("Journey: Manual-Retry Required Banner", () => {
	test("survives a session reload and clears when the next turn starts", async ({ page, gateway }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");
			const session = gateway.sessionManager?.getSession(sessionId);
			expect(session, "manual-retry journey requires a live in-process session").toBeTruthy();
			session!.manualRetryRequired = true;
			session!.lastTurnErrorMessage = "provider request failed: api_key=sk-or-manualretrysecret";
			session!.promptQueue.enqueue("parked work");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });

			const banner = page.locator('[data-testid="manual-retry-required-banner"]');
			await expect(banner).toBeVisible({ timeout: 10_000 });
			await expect(banner).toContainText("Manual Retry is required.");

			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(banner).toBeVisible({ timeout: 10_000 });

			await navigateToHash(page, "#/");
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(banner).toBeVisible({ timeout: 10_000 });

			for (const listener of [...session!.rpcClient.eventListeners]) listener({ type: "agent_start" });
			await expect(banner).toHaveCount(0, { timeout: 10_000 });
			await expect.poll(() => session!.manualRetryRequired).toBe(false);
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
test.describe("Journey: Footer Image Model", () => {
	test("footer shows the resolved image-model id (default gpt-image-2)", async ({ page }) => {
		const sessionId = await createSession();
		try {
			await Promise.all([
				openApp(page),
				waitForSessionStatus(sessionId, "idle"),
			]);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const footer = page.locator("[data-testid='footer-image-model-id']").first();
			await expect(footer).toBeVisible({ timeout: 15_000 });
			await expect(footer).toHaveText("gpt-image-2", { timeout: 10_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
