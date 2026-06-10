/**
 * Browser E2E — Orchestration Core sub-goal A: the team_delegate tool card.
 *
 * Asserts the genuinely UI-specific surface: a `team_delegate` tool result
 * renders via the shared DelegateRenderer (registered for `team_delegate` /
 * `team_wait` in src/ui/tools/index.ts). The deterministic mock agent emits a
 * canned team_delegate tool_use + toolResult carrying `details.delegates` (see
 * the TEAM_DELEGATE_CARD trigger in tests/e2e/mock-agent-core.mjs) so the card
 * renders without a real LLM and the test stays in the e2e phase.
 *
 * The end-to-end orchestration mechanics (blocking one-shot, non-goal
 * spawn→prompt→wait→read→dismiss, model inheritance, team-lead parity, restart
 * reminder + re-collect) are exercised against the real `/orchestrate/*` routes
 * in the API specs tests/e2e/team-delegate.spec.ts, team-wait-semantics.spec.ts
 * and orchestrate-restart.spec.ts. This browser spec covers the render layer
 * those API specs cannot: the user-visible delegate card.
 */
import { test, expect } from "./fixtures.js";
import { createSession, waitForHealth, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, sendMessage } from "./ui-helpers.js";

test.describe("team_delegate tool card (DelegateRenderer)", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("blocking one-shot delegate renders a single completed card", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, "TEAM_DELEGATE_CARD please run a helper");

		// DelegateRenderer single-child header: "Delegated — <summary> (duration)".
		await expect(page.getByText("Delegated", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Summarise the design doc", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("parallel delegate renders a multi-child card", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);
		await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, "TEAM_DELEGATE_CARD_PARALLEL run two helpers");

		// DelegateRenderer multi-child header: "Delegated to N agents — all completed".
		await expect(page.getByText("Delegated to 2 agents", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
	});
});
