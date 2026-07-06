/**
 * Browser E2E — a11y sweep: gate-verification live-region announcements.
 *
 * The <gate-verification-live> widget renders live step cards driven by
 * `gate-verification-event` CustomEvents on `document`. The step cards are a
 * purely visual progress affordance, so the component mirrors status
 * transitions into a visually-hidden `role="status"` live region
 * (data-testid="gate-verification-live-region") — same idiom as the composer
 * queue announcer pinned by f17-a11y.spec.ts.
 *
 * This spec drives the real built component in the browser (no fixtures):
 * it injects the element, dispatches the same document-level events the
 * verification event bus emits, and asserts the announcer text tracks
 * running -> passed/failed transitions.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const GOAL_ID = "a11y-goal";
const GATE_ID = "a11y-gate";
const SIGNAL_ID = "a11y-signal";

/**
 * Mount a <gate-verification-live> element into the app page.
 *
 * The custom element is lazily registered: the gate_signal tool renderer
 * calls ensureGateVerificationLive() when it first renders. We drive that
 * exact production path via the app's exposed __bobbitRenderTool +
 * __bobbitLitRender hooks (same technique as other browser specs), polling
 * until the lazy renderer and custom element have both resolved.
 */
async function mountWidget(page: import("@playwright/test").Page): Promise<void> {
	await page.waitForFunction(() =>
		typeof (window as any).__bobbitRenderTool === "function" &&
		typeof (window as any).__bobbitLitRender === "function",
	undefined, { timeout: 15_000 });

	await page.evaluate(({ goalId, gateId, signalId }) => {
		const host = document.createElement("div");
		host.dataset.testid = "a11y-gvl-host";
		document.body.appendChild(host);
		(window as any).__a11yGvlRender = () => {
			const out = (window as any).__bobbitRenderTool(
				"gate_signal",
				{ gate_id: gateId },
				{
					role: "toolResult",
					isError: false,
					content: [{ type: "text", text: JSON.stringify({ signal: { id: signalId, goalId, status: "running", verification: { steps: [] } } }) }],
				},
				false,
			);
			(window as any).__bobbitLitRender(out.content, host);
		};
		(window as any).__a11yGvlRender();
	}, { goalId: GOAL_ID, gateId: GATE_ID, signalId: SIGNAL_ID });

	// First render returns a placeholder while the lazy gate renderer loads —
	// re-render until the real <gate-verification-live> element appears and
	// its custom-element definition has upgraded.
	await page.waitForFunction(() => {
		(window as any).__a11yGvlRender();
		const el = document.querySelector('[data-testid="a11y-gvl-host"] gate-verification-live');
		return !!el && !!customElements.get("gate-verification-live");
	}, undefined, { timeout: 15_000 });
}

/** Dispatch a gate-verification-event CustomEvent on document. */
async function dispatchVerificationEvent(
	page: import("@playwright/test").Page,
	detail: Record<string, unknown>,
): Promise<void> {
	await page.evaluate(
		({ goalId, gateId, signalId, rest }) => {
			document.dispatchEvent(
				new CustomEvent("gate-verification-event", {
					detail: { goalId, gateId, signalId, ...rest },
				}),
			);
		},
		{ goalId: GOAL_ID, gateId: GATE_ID, signalId: SIGNAL_ID, rest: detail },
	);
}

test.describe("gate verification live-region a11y", () => {
	test("announcer mirrors running -> passed transition", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await mountWidget(page);

			const region = page.locator('[data-testid="gate-verification-live-region"]');

			await dispatchVerificationEvent(page, {
				type: "gate_verification_started",
				startedAt: Date.now(),
				steps: [
					{ name: "typecheck", type: "command", phase: 0 },
					{ name: "unit tests", type: "command", phase: 0 },
				],
			});

			// Announcer exists, is a polite status region, and announces the
			// running state with the gate id.
			await expect(region).toHaveCount(1, { timeout: 10_000 });
			await expect(region).toHaveAttribute("role", "status");
			await expect(region).toHaveAttribute("aria-live", "polite");
			await expect(region).toHaveAttribute("aria-atomic", "true");
			await expect(region).toContainText(`Verifying gate ${GATE_ID}`);
			await expect(region).toContainText("2 running");

			// Visually hidden — screen-reader only, no layout impact.
			await expect(region).toHaveClass(/sr-only/);

			// Step completions update the announced summary.
			await dispatchVerificationEvent(page, {
				type: "gate_verification_step_complete",
				stepIndex: 0,
				status: "passed",
				durationMs: 1200,
			});
			await expect(region).toContainText("1 passed");

			await dispatchVerificationEvent(page, {
				type: "gate_verification_step_complete",
				stepIndex: 1,
				status: "passed",
				durationMs: 3400,
			});
			await dispatchVerificationEvent(page, {
				type: "gate_verification_complete",
				status: "passed",
			});
			await expect(region).toContainText(`Gate ${GATE_ID} verified`);
			await expect(region).toContainText("2 passed");
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});

	test("announcer reports failure and step cards are keyboard-operable", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			await mountWidget(page);

			const region = page.locator('[data-testid="gate-verification-live-region"]');

			await dispatchVerificationEvent(page, {
				type: "gate_verification_started",
				startedAt: Date.now(),
				steps: [{ name: "lint", type: "command", phase: 0 }],
			});
			await expect(region).toHaveCount(1, { timeout: 10_000 });

			await dispatchVerificationEvent(page, {
				type: "gate_verification_step_complete",
				stepIndex: 0,
				status: "failed",
				durationMs: 900,
				output: "lint exploded\nsecond line",
			});
			await dispatchVerificationEvent(page, {
				type: "gate_verification_complete",
				status: "failed",
			});

			await expect(region).toContainText(`Gate ${GATE_ID} verification failed`);
			await expect(region).toContainText("1 failed");

			// The failed step card has output, so its header row must be a
			// keyboard-operable button that toggles the inline output body.
			const host = page.locator('[data-testid="a11y-gvl-host"]');
			const row = host.locator('[role="button"]').first();
			await expect(row).toBeVisible();
			await expect(row).toHaveAttribute("tabindex", "0");
			await expect(row).toHaveAttribute("aria-expanded", "false");

			await row.focus();
			await page.keyboard.press("Enter");
			await expect(row).toHaveAttribute("aria-expanded", "true");
			await expect(host).toContainText("lint exploded");

			// Space collapses it again.
			await page.keyboard.press(" ");
			await expect(row).toHaveAttribute("aria-expanded", "false");
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
