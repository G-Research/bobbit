/**
 * Unit tests for GateInspectRenderer rendering logic.
 *
 * Tests rendering decisions, verification step expand/collapse (DOM-direct),
 * signal field names (verdict/timestamp), and pluralization.
 *
 * Pattern: file:// fixture with window-exposed functions, evaluated in page context.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/gate-inspect-renderer.html")}`;

test.describe("GateInspectRenderer", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	// ── Loading / Error / Skipped states ─────────────────────────────

	test("loading state shows inprogress when streaming", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect({ gate_id: "design-doc" }, undefined, true),
		);
		expect(result.branch).toBe("loading");
		expect(result.state).toBe("inprogress");
		expect(result.gateId).toBe("design-doc");
	});

	test("error result shows error branch", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{ isError: true, content: [{ type: "text", text: "Gate not found" }] },
			),
		);
		expect(result.branch).toBe("error");
		expect(result.text).toContain("Gate not found");
	});

	test("skipped result shows skipped branch", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{ isError: true, content: [{ type: "text", text: "Skipped due to queued user message" }] },
			),
		);
		expect(result.branch).toBe("skipped");
	});

	// ── section="content" ────────────────────────────────────────────

	test("content section with text renders hasContent=true", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "design-doc" },
				{
					isError: false,
					content: [{ type: "text", text: JSON.stringify({ section: "content", signalIndex: 0, signalId: "sig-abc", text: "# Design\nHello" }) }],
				},
			),
		);
		expect(result.branch).toBe("content");
		expect(result.signalIndex).toBe(0);
		expect(result.signalId).toBe("sig-abc");
		expect(result.hasContent).toBe(true);
		expect(result.contentText).toBe("# Design\nHello");
	});

	test("content section with null text shows hasContent=false", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "design-doc" },
				{
					isError: false,
					content: [{ type: "text", text: JSON.stringify({ section: "content", signalIndex: 1, text: null }) }],
				},
			),
		);
		expect(result.branch).toBe("content");
		expect(result.hasContent).toBe(false);
	});

	// ── section="verification" ───────────────────────────────────────

	test("verification section derives step statuses correctly", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{
					isError: false,
					content: [{
						type: "text",
						text: JSON.stringify({
							section: "verification",
							signalIndex: 0,
							signalId: "sig-1",
							steps: [
								{ name: "typecheck", type: "command", passed: true, duration_ms: 5000, output: "OK" },
								{ name: "test", type: "command", passed: false, duration_ms: 12000, output: "FAIL: 2 errors" },
								{ name: "review", type: "agent", skipped: true },
							],
						}),
					}],
				},
			),
		);
		expect(result.branch).toBe("verification");
		expect(result.stepCount).toBe(3);
		expect(result.steps[0].status).toBe("passed");
		expect(result.steps[0].startsExpanded).toBe(false);
		expect(result.steps[1].status).toBe("failed");
		expect(result.steps[1].startsExpanded).toBe(true);
		expect(result.steps[2].status).toBe("skipped");
		expect(result.steps[2].hasOutput).toBe(false);
	});

	// ── Bug 1: Verification step expand/collapse (DOM-direct) ────────

	test("failed steps start expanded, passed steps start collapsed", async ({ page }) => {
		const states = await page.evaluate(() => {
			const dom = (window as any).buildVerificationDOM([
				{ name: "typecheck", passed: true, output: "all good" },
				{ name: "test", passed: false, output: "FAIL: 2 errors" },
				{ name: "lint", passed: true, output: "0 warnings" },
			]);
			const cards = dom.querySelectorAll(".border");
			return Array.from(cards).map((card: any) => {
				const output = card.querySelector("[data-step-output]");
				const chevron = card.querySelector("[data-step-chevron]");
				return {
					name: card.querySelector("span").textContent,
					outputHidden: output ? output.classList.contains("hidden") : null,
					chevronText: chevron ? chevron.textContent : null,
				};
			});
		});

		// Passed step: collapsed (hidden class, ▾ chevron)
		expect(states[0].outputHidden).toBe(true);
		expect(states[0].chevronText).toBe("▾");

		// Failed step: expanded (no hidden class, ▴ chevron)
		expect(states[1].outputHidden).toBe(false);
		expect(states[1].chevronText).toBe("▴");

		// Passed step: collapsed
		expect(states[2].outputHidden).toBe(true);
		expect(states[2].chevronText).toBe("▾");
	});

	test("clicking a collapsed step expands it via DOM toggle", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).buildVerificationDOM([
				{ name: "typecheck", passed: true, output: "all good" },
			]);
		});

		// Initially collapsed
		const beforeClick = await page.evaluate(() => {
			const card = document.querySelector("#container .border")!;
			const output = card.querySelector("[data-step-output]") as HTMLElement;
			return { hidden: output.classList.contains("hidden") };
		});
		expect(beforeClick.hidden).toBe(true);

		// Click the header
		await page.click("#container .border .cursor-pointer");

		// Now expanded
		const afterClick = await page.evaluate(() => {
			const card = document.querySelector("#container .border")!;
			const output = card.querySelector("[data-step-output]") as HTMLElement;
			const chevron = card.querySelector("[data-step-chevron]") as HTMLElement;
			return { hidden: output.classList.contains("hidden"), chevron: chevron.textContent };
		});
		expect(afterClick.hidden).toBe(false);
		expect(afterClick.chevron).toBe("▴");
	});

	test("clicking an expanded step collapses it", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).buildVerificationDOM([
				{ name: "test", passed: false, output: "FAIL" },
			]);
		});

		// Initially expanded (failed step)
		await page.click("#container .border .cursor-pointer");

		const afterClick = await page.evaluate(() => {
			const card = document.querySelector("#container .border")!;
			const output = card.querySelector("[data-step-output]") as HTMLElement;
			const chevron = card.querySelector("[data-step-chevron]") as HTMLElement;
			return { hidden: output.classList.contains("hidden"), chevron: chevron.textContent };
		});
		expect(afterClick.hidden).toBe(true);
		expect(afterClick.chevron).toBe("▾");
	});

	// ── Bug 2: Signal field names ────────────────────────────────────

	test("signals section uses verdict and timestamp fields", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{
					isError: false,
					content: [{
						type: "text",
						text: JSON.stringify({
							section: "signals",
							signals: [
								{ index: 0, verdict: "passed", timestamp: "2026-04-13T10:00:00Z", hasContent: true, sessionId: "abc12345-6789" },
								{ index: 1, verdict: "failed", timestamp: "2026-04-13T11:00:00Z", hasContent: false, sessionId: "def98765-4321" },
							],
						}),
					}],
				},
			),
		);
		expect(result.branch).toBe("signals");
		expect(result.rows[0].verdict).toBe("passed");
		expect(result.rows[0].timestamp).toBe("2026-04-13T10:00:00Z");
		expect(result.rows[1].verdict).toBe("failed");
		expect(result.rows[1].timestamp).toBe("2026-04-13T11:00:00Z");

		// Verify the old field names are NOT present
		expect(result.rows[0].status).toBeUndefined();
		expect(result.rows[0].signalledAt).toBeUndefined();
	});

	test("signals row includes hasContent and truncated sessionId", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{
					isError: false,
					content: [{
						type: "text",
						text: JSON.stringify({
							section: "signals",
							signals: [
								{ index: 0, verdict: "passed", timestamp: "2026-04-13T10:00:00Z", hasContent: true, sessionId: "abc12345-6789-full-id" },
							],
						}),
					}],
				},
			),
		);
		expect(result.rows[0].hasContent).toBe(true);
		expect(result.rows[0].sessionId).toBe("abc12345");
	});

	// ── Bug 3: Pluralization ─────────────────────────────────────────

	test("1 signal is singular", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{
					isError: false,
					content: [{
						type: "text",
						text: JSON.stringify({
							section: "signals",
							signals: [{ index: 0, verdict: "passed", timestamp: "2026-04-13T10:00:00Z" }],
						}),
					}],
				},
			),
		);
		expect(result.pluralized).toBe("1 signal");
		expect(result.isCollapsible).toBe(false);
	});

	test("0 signals is plural", async ({ page }) => {
		const result = await page.evaluate(() =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{
					isError: false,
					content: [{
						type: "text",
						text: JSON.stringify({ section: "signals", signals: [] }),
					}],
				},
			),
		);
		expect(result.pluralized).toBe("0 signals");
	});

	test("6 signals uses collapsible header with correct pluralization", async ({ page }) => {
		const signals = Array.from({ length: 6 }, (_, i) => ({
			index: i, verdict: "passed", timestamp: "2026-04-13T10:00:00Z",
		}));
		const result = await page.evaluate((sigs) =>
			(window as any).renderInspect(
				{ gate_id: "impl" },
				{
					isError: false,
					content: [{
						type: "text",
						text: JSON.stringify({ section: "signals", signals: sigs }),
					}],
				},
			),
		signals);
		expect(result.pluralized).toBe("6 signals");
		expect(result.isCollapsible).toBe(true);
	});
});
