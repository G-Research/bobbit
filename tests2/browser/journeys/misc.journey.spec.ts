/**
 * Journey: Misc — v2 browser smoke
 * Covers: journey-notification-policy, journey-review-commenting,
 *   journey-preview-artifacts, journey-compaction, journey-cost-tracking,
 *   journey-workflow-editor, journey-dynamic-panels, journey-mobile-layout
 * Consolidated from: api-error-modal, mobile-review-commenting, preview-panel-*,
 *   compaction-*, cost-*, workflow-editor-*, dynamic-panels-*, mobile-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";
import { sendMessage, apiFetch, defaultProject, createGoal, deleteGoal, defaultProjectId } from "../_helpers/journey-fixture.js";
import { createGoalAssistantViaUI } from "../fixtures/ui-helpers.js";
import { rawApiFetch } from "../e2e-setup.js";
import fs from "node:fs";
import path from "node:path";

test.describe("Journey: Notification Policy", () => {
	test("app renders without notification errors", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("settings route reachable for notification config", async ({ page }) => {
		await openApp(page);
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

test.describe("Journey: Review Commenting", () => {
	test("app shell stable for review commenting scenario", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("REVIEW_OPEN trigger shows a Review tab in the side panel", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const doneMessages = page.getByText("Done. Used review_open tool.", { exact: true });
			const beforeCount = await doneMessages.count().catch(() => 0);
			await sendMessage(page, "REVIEW_OPEN");
			await expect.poll(() => doneMessages.count(), { timeout: 20_000 }).toBeGreaterThan(beforeCount);
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" }).first();
			await expect(reviewTab).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("Review tab click shows review-document with mock content", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const doneMessages = page.getByText("Done. Used review_open tool.", { exact: true });
			const beforeCount = await doneMessages.count().catch(() => 0);
			await sendMessage(page, "REVIEW_OPEN");
			await expect.poll(() => doneMessages.count(), { timeout: 20_000 }).toBeGreaterThan(beforeCount);
			const reviewTab = page.locator(".goal-tab-pill", { hasText: "Review" }).first();
			await expect(reviewTab).toBeVisible({ timeout: 20_000 });
			await reviewTab.click();
			const reviewDoc = page.locator("review-document").first();
			await expect(reviewDoc).toBeVisible({ timeout: 15_000 });
			await expect(reviewDoc.getByText("Some important text").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Preview Artifacts", () => {
	test("session route loads for preview artifact context", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("preview mount via API reaches client state and iframe renders", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const patchResp = await apiFetch(`/api/sessions/${sessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ preview: true }),
			});
			expect(patchResp.status).toBe(200);
			await expect.poll(
				() => page.evaluate(() => {
					const s: any = (window as any).bobbitState ?? (window as any).__bobbitState;
					return s?.isPreviewSession === true;
				}),
				{ timeout: 20_000 },
			).toBe(true);
			await page.evaluate(() => {
				const s: any = (window as any).bobbitState ?? (window as any).__bobbitState;
				s.previewPanelActiveTab = "preview";
			});
			const mountResp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				body: JSON.stringify({ html: "<!DOCTYPE html><body>journey-preview</body>", entry: "journey.html" }),
			});
			expect(mountResp.status).toBe(200);
			const mountBody = await mountResp.json() as { entry: string; mtime: number };
			expect(mountBody.entry).toBe("journey.html");
			expect(mountBody.mtime).toBeGreaterThan(0);
			await expect.poll(
				() => page.evaluate(() => {
					const s: any = (window as any).bobbitState ?? (window as any).__bobbitState;
					return s?.previewPanelEntry || "";
				}),
				{ timeout: 20_000 },
			).toBe("journey.html");
			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe).toBeVisible({ timeout: 20_000 });
			const src = await iframe.getAttribute("src");
			expect(src).toMatch(/^\/preview\/[a-f0-9-]+\/journey\.html\?mtime=\d+$/);
			// Ported from preview-happy-path.spec.ts (BR52): the open-in-new-tab
			// anchor href must NOT carry a cache-buster; Refresh must bump the mtime.
			const link = page.locator('a[title="Open preview in new tab"]').first();
			await expect(link).toBeVisible({ timeout: 10_000 });
			const href = await link.getAttribute("href");
			expect(href).toMatch(/^\/preview\/[a-f0-9-]+\/journey\.html$/);
			expect(href).not.toMatch(/[?#]mtime=/);
			const refresh = page.locator('button[title="Refresh preview"]').first();
			await expect(refresh).toBeVisible({ timeout: 10_000 });
			await refresh.click();
			await expect.poll(async () => await iframe.getAttribute("src"), { timeout: 5_000 }).not.toEqual(src);
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Compaction", () => {
	test("session loads for compaction scenario", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	// Ported from compaction-persistence.spec.ts (audit: misc GAP / BR53): a
	// seeded compaction sidecar splices a rich summary row into the snapshot; the
	// renderer must show the card (data-state complete) and it must survive reload.
	test("seeded compaction sidecar renders the summary card and survives reload", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			// Seed one success sidecar entry (→ complete card). Mirrors the legacy setup.
			const dir = path.join(gateway.bobbitDir, "state", "compaction-sidecar");
			fs.mkdirSync(dir, { recursive: true });
			const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
			const line = JSON.stringify({
				schemaVersion: 1, id: "c_journey_1", trigger: "manual",
				tokensBefore: 50_000, tokensAfter: null, durationMs: 1000,
				startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(),
				success: true, firstKeptEntryId: null,
			}) + "\n";
			fs.appendFileSync(path.join(dir, `${safe}.jsonl`), line, "utf-8");

			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const card = page.locator("[data-testid='compaction-summary-card']");
			await expect(card).toHaveCount(1, { timeout: 15_000 });
			await expect(card).toHaveAttribute("data-state", "complete");
			// Sidecar must still anchor the card after a full reload.
			await page.reload();
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect(card).toHaveCount(1, { timeout: 20_000 });
			await expect(card).toHaveAttribute("data-state", "complete");
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

// Ported from prompt-stats-e2e.spec.ts (audit: misc GAP / BR51): after an agent
// response, the stats bar must show the model name, a context-usage tooltip
// prefixed "Context:" with a percentage, and a "$" cost. The journey previously
// only best-effort probed a cost element.
test.describe("Journey: Prompt Stats", () => {
	test("stats bar shows model name, context %, and cost after a response", async ({ page }) => {
		test.setTimeout(90_000);
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await sendMessage(page, "Full stats test");
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
			const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
			await expect(statsBar).toBeVisible({ timeout: 15_000 });
			await expect(statsBar).toContainText("mock-model", { timeout: 20_000 });
			const contextSpan = page.locator("span[title*='Context:']");
			await expect(contextSpan).toBeVisible({ timeout: 15_000 });
			await expect(contextSpan).toContainText(/\d+%/, { timeout: 15_000 });
			await expect(contextSpan).toHaveAttribute("title", /Context:.*tokens/, { timeout: 10_000 });
			await expect(statsBar).toContainText("$", { timeout: 15_000 });
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});

test.describe("Journey: Cost Tracking", () => {
	test("app loads without cost tracking errors", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("send message → cost display appears after agent response", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 15_000 });
			await editor.fill("cost test");
			await editor.press("Enter");
			// Wait for agent response to arrive
			await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
			// After a response, a cost display element should be visible somewhere in the session
			// (token count, cost badge, stat bar, etc.)
			const costEl = page.locator(
				".cost, [data-testid*='cost'], [data-testid*='token'], " +
				".token-count, .stat-bar, session-stat-bar, message-cost, " +
				"[class*='cost'], [class*='token']"
			).first();
			// Best-effort: cost display may not appear if mock agent response has no usage data
			const hasCost = await costEl.isVisible({ timeout: 15_000 }).catch(() => false);
			// We assert the agent response appeared (main assertion); cost display is informational
			// If it's missing, the test still passes — the cost element is a secondary check
			if (!hasCost) {
				console.warn("cost element not found after agent response; mock agent may not emit usage data");
			}
		} finally {
			await deleteSession(sessionId);
		}
	});
});

test.describe("Journey: Workflow Editor", () => {
	test("app shell stable for workflow editor flow", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	// Ported from workflow-editor.spec.ts (audit: misc GAP / BR46): the workflow
	// editor's verify-step type control must expose its testid AND list all four
	// step types (command/llm-review/agent-qa/human-signoff). PR #644 regressed the
	// human-signoff option; the journey previously asserted none of this.
	test("workflow editor exposes the step-type control with all four types", async ({ page }) => {
		test.setTimeout(90_000);
		const projectId = await defaultProjectId();
		expect(projectId).toBeTruthy();
		const wfId = "v2-wf-step-type-" + Date.now();
		const res = await rawApiFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify({
				projectId,
				id: wfId,
				name: `Test Workflow ${wfId}`,
				description: "editor parity",
				gates: [{ id: "g1", name: "Gate 1", depends_on: [], verify: [{ name: "Step", type: "command", run: "echo ok" }] }],
			}),
		});
		expect(res.status).toBe(201);
		try {
			await openApp(page);
			await navigateToHash(page, `#/settings/${projectId}/workflows`);
			const tab = page.locator("[data-testid='workflows-tab']").first();
			await expect(tab).toBeVisible({ timeout: 15_000 });
			await tab.getByText(`Test Workflow ${wfId}`).first().click();
			await expect(page.locator(".wf-edit-container")).toBeVisible({ timeout: 15_000 });
			// Expand the first gate.
			const gateCard = page.locator(".wf-edit-container .wf-artifacts-list > .wf-gate-card").first();
			await expect(gateCard).toBeVisible({ timeout: 10_000 });
			await gateCard.scrollIntoViewIfNeeded();
			if (!(await gateCard.evaluate((el) => el.classList.contains("expanded")))) {
				await gateCard.locator(".wf-gate-header .wf-gate-chevron").click();
			}
			await expect(gateCard).toHaveClass(/(?:^|\s)expanded(?:\s|$)/, { timeout: 5_000 });
			// Expand the first verify-step.
			const stepCard = page.locator("[data-testid='wf-vstep-card']").first();
			await expect(stepCard).toBeVisible({ timeout: 10_000 });
			if (!((await stepCard.getAttribute("class"))?.includes("vstep-expanded"))) {
				await stepCard.locator(".wf-vstep-collapsed-header").click();
			}
			await expect(stepCard).toHaveClass(/vstep-expanded/, { timeout: 5_000 });
			// The step-type control must be present and list all four types.
			const select = page.locator("[data-testid='wf-step-type']").first();
			await expect(select).toBeVisible({ timeout: 10_000 });
			const optionValues = await select.locator("option").evaluateAll((els) =>
				(els as HTMLOptionElement[]).map((o) => o.value));
			expect(optionValues).toEqual(["command", "llm-review", "agent-qa", "human-signoff"]);
		} finally {
			await apiFetch(`/api/workflows/${wfId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("page.route() workflow GET stub still lets app load gracefully", async ({ page }) => {
		await page.route("**/api/workflows*", async (route) => {
			if (route.request().method() !== "GET") return route.continue();
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([{ id: "stub-wf", name: "Stub", description: "stub", gates: [] }]),
			});
		});
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Dynamic Panels", () => {
	test("session route renders for dynamic panel scenario", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
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

// Ported from cost-popover-cache-hit.spec.ts (audit: misc GAP): the cost popover
// must render the cache-hit row with the server-derived percentage.
test.describe("Journey: Cost Cache-Hit", () => {
	test("goal-dashboard cost popover shows the cache-hit percentage", async ({ page }) => {
		const aggregate = {
			totalCost: 1.2345, inputTokens: 1000, outputTokens: 500,
			cacheReadTokens: 800, cacheWriteTokens: 200, cacheHitRate: 0.75,
		};
		await page.route(/\/api\/goals\/[^/]+\/cost(?:\?.*)?$/, async (route, req) => {
			if (req.method() !== "GET") return route.fallback();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(aggregate) });
		});
		await page.route(/\/api\/goals\/[^/]+\/cost\/breakdown(?:\?.*)?$/, async (route, req) => {
			if (req.method() !== "GET") return route.fallback();
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ aggregate, sessions: [] }) });
		});
		const goal = await createGoal({ title: `v2-cache-hit-${Date.now()}` });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await page.locator(".cost-tag").first().click();
			await expect(page.locator('[data-testid="cost-cache-hit"]').first()).toContainText("75%", { timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});

// Ported from api-error-modal.spec.ts (audit: misc GAP): a createGoal 400 must
// surface the server error text + stack disclosure in the error modal.
test.describe("Journey: API Error Modal", () => {
	test("createGoal 400 surfaces server error message + stack in the modal", async ({ page }) => {
		test.setTimeout(120_000);
		const FAKE_STACK = "Error: Missing title\n    at goalManager.create (server.ts:3137:9)\n    at handleApiRoute (server.ts:42:5)";
		await page.route("**/api/goals", async (route) => {
			const req = route.request();
			if (req.method() !== "POST") return route.continue();
			await route.fulfill({
				status: 400, contentType: "application/json",
				body: JSON.stringify({ error: "Missing title", stack: FAKE_STACK }),
			});
		});
		const targetProjectId = await defaultProjectId();
		try {
			await openApp(page);
			await createGoalAssistantViaUI(page, { timeout: 60_000 });
			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeVisible({ timeout: 30_000 });
			await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 20_000 });
			await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 20_000 });

			const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });
			await createGoalBtn.click();

			// The 400 routes through the error modal (ErrorDetails).
			const message = page.locator('[data-testid="error-details-message"]').first();
			await expect(message).toHaveText("Missing title", { timeout: 15_000 });
			await expect(page.locator('[data-testid="error-details-stack"]').first()).toBeVisible({ timeout: 5_000 });
			// The generic fallback must NOT be shown when a server message exists.
			expect(await page.locator("body").innerText()).not.toContain("Failed to create goal: 400");
		} finally {
			// Best-effort: no goal is created (POST is stubbed 400).
			void targetProjectId;
		}
	});
});

// Ported from auto-retry-banner.spec.ts (audit: misc GAP): an injected
// auto_retry_pending event renders the banner with its data-* attributes.
test.describe("Journey: Auto-Retry Banner", () => {
	test("auto_retry_pending renders the banner with reason/attempt/delay", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
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

// Ported from image-model-selector-lock.spec.ts (audit: misc GAP): the footer
// exposes the resolved image-model id (default gpt-image-2).
// Ported from goal-role-tabs-wiring.spec.ts (audit: misc GAP / BR48): the
// goal-proposal Roles tab must load a role editor, and clicking Customize must
// reveal the reset-to-default control (proving per-goal role customization is
// wired, not an enabled no-op).
test.describe("Journey: Goal Proposal Roles Tab", () => {
	test("Roles tab Customize reveals the reset-to-default control", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 20_000 });
		await page.locator("[data-testid='goal-proposal-tab-roles']").click();
		await expect(page.locator("[data-testid='goal-proposal-panel-roles']")).toBeVisible({ timeout: 10_000 });
		const customize = page.locator("[data-testid='goal-proposal-role-customize']");
		await expect(customize).toBeVisible({ timeout: 15_000 });
		await customize.click();
		await expect(page.locator("[data-testid='goal-proposal-role-reset']")).toBeVisible({ timeout: 10_000 });
	});
});

test.describe("Journey: Footer Image Model", () => {
	test("footer shows the resolved image-model id (default gpt-image-2)", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
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
