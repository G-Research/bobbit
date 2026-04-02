/**
 * Unit tests for VerificationResultRenderer rendering logic.
 *
 * Tests the rendering decisions, verdict badge generation, tool state resolution,
 * and output structure for pass/fail/streaming/error/html-report states.
 *
 * Pattern: file:// fixture with window-exposed functions, evaluated in page context.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/verification-result-renderer.html")}`;

test.describe("VerificationResultRenderer", () => {

	test("pass verdict renders green badge with ✓ PASS label", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const badge = await page.evaluate(() => {
			return (window as any).verdictBadge("pass");
		});

		expect(badge.isPass).toBe(true);
		expect(badge.label).toBe("✓ PASS");
		expect(badge.cls).toContain("text-green");
	});

	test("fail verdict renders red badge with ✗ FAIL label", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const badge = await page.evaluate(() => {
			return (window as any).verdictBadge("fail");
		});

		expect(badge.isPass).toBe(false);
		expect(badge.label).toBe("✗ FAIL");
		expect(badge.cls).toContain("text-red");
	});

	test("verdict badge is case-insensitive for PASS", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const badge = await page.evaluate(() => {
			return (window as any).verdictBadge("PASS");
		});

		expect(badge.isPass).toBe(true);
		expect(badge.label).toBe("✓ PASS");
	});

	test("streaming state shows 'Submitting verification…' header", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const params = { verdict: "pass", summary: "## All good\n\n- No issues" };
			return (window as any).renderDecision(params, undefined, true);
		});

		expect(result.branch).toBe("streaming");
		expect(result.state).toBe("inprogress");
		expect(result.headerText).toBe("Submitting verification…");
		expect(result.hasVerdictBadge).toBe(true);
		expect(result.hasSummaryMarkdown).toBe(true);
		expect(result.summaryContent).toBe("## All good\n\n- No issues");
	});

	test("streaming without params shows header only", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).renderDecision(undefined, undefined, true);
		});

		expect(result.branch).toBe("streaming");
		expect(result.hasVerdictBadge).toBe(false);
		expect(result.hasSummaryMarkdown).toBe(false);
		expect(result.hasReportNote).toBe(false);
	});

	test("streaming with report_html shows attached note", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const params = { verdict: "pass", summary: "Done", report_html: "<h1>Report</h1>" };
			return (window as any).renderDecision(params, undefined, true);
		});

		expect(result.hasReportNote).toBe(true);
	});

	test("complete pass renders success with markdown and verdict badge", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const params = { verdict: "pass" };
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: "## All good\n\n- No issues" }) }],
			};
			return (window as any).renderDecision(params, mockResult, false);
		});

		expect(result.branch).toBe("complete");
		expect(result.state).toBe("complete");
		expect(result.verdict).toBe("pass");
		expect(result.verdictBadge.isPass).toBe(true);
		expect(result.verdictBadge.label).toBe("✓ PASS");
		expect(result.summary).toBe("## All good\n\n- No issues");
		expect(result.hasMarkdownBlock).toBe(true);
		expect(result.collapsed).toBe(false); // short summary = not collapsed
	});

	test("complete fail renders fail badge", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "fail", summary: "## Issues found\n\n- Bug at line 42" }) }],
			};
			return (window as any).renderDecision(undefined, mockResult, false);
		});

		expect(result.branch).toBe("complete");
		expect(result.verdict).toBe("fail");
		expect(result.verdictBadge.isPass).toBe(false);
		expect(result.verdictBadge.label).toBe("✗ FAIL");
		expect(result.verdictBadge.cls).toContain("text-red");
	});

	test("long summary is collapsed by default (>300 chars)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const longSummary = "A".repeat(301);
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: longSummary }) }],
			};
			return (window as any).renderDecision(undefined, mockResult, false);
		});

		expect(result.collapsed).toBe(true);
	});

	test("short summary is expanded by default (<=300 chars)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const shortSummary = "A".repeat(300);
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: shortSummary }) }],
			};
			return (window as any).renderDecision(undefined, mockResult, false);
		});

		expect(result.collapsed).toBe(false);
	});

	test("error result renders error branch with text-destructive class", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: true,
				content: [{ type: "text", text: "Connection timed out" }],
			};
			return (window as any).renderDecision(undefined, mockResult, false);
		});

		expect(result.branch).toBe("error");
		expect(result.state).toBe("error");
		expect(result.isSkipped).toBe(false);
		expect(result.headerText).toBe("Verification failed");
		expect(result.errorText).toBe("Connection timed out");
		expect(result.errorClass).toBe("text-destructive");
	});

	test("skipped error renders warning with amber styling", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: true,
				content: [{ type: "text", text: "Skipped due to queued user message" }],
			};
			return (window as any).renderDecision(undefined, mockResult, false);
		});

		expect(result.branch).toBe("error");
		expect(result.state).toBe("warning");
		expect(result.isSkipped).toBe(true);
		expect(result.headerText).toBe("Aborted verification");
		expect(result.errorClass).toContain("text-amber");
	});

	test("HTML report present in result shows iframe/details section", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({
					verdict: "pass",
					summary: "All tests passed",
					report_html: "<html><body><h1>Test Report</h1><img src='screenshot.png'></body></html>",
				}) }],
			};
			return (window as any).renderDecision(undefined, mockResult, false);
		});

		expect(result.branch).toBe("complete");
		expect(result.hasReportHtml).toBe(true);
		expect(result.hasIframe).toBe(true);
		expect(result.reportHtml).toContain("<h1>Test Report</h1>");
	});

	test("complete without report_html has no iframe", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: "Good" }) }],
			};
			return (window as any).renderDecision(undefined, mockResult, false);
		});

		expect(result.hasReportHtml).toBe(false);
		expect(result.hasIframe).toBe(false);
	});

	test("getToolState returns correct states", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const states = await page.evaluate(() => {
			const fn = (window as any).getToolState;
			return {
				streaming: fn(undefined, true),
				noResultNoStream: fn(undefined, false),
				success: fn({ isError: false, content: [] }, false),
				error: fn({ isError: true, content: [{ type: "text", text: "Error" }] }, false),
				skipped: fn({ isError: true, content: [{ type: "text", text: "Skipped due to queued user message" }] }, false),
			};
		});

		expect(states.streaming).toBe("inprogress");
		expect(states.noResultNoStream).toBe("complete");
		expect(states.success).toBe("complete");
		expect(states.error).toBe("error");
		expect(states.skipped).toBe("warning");
	});

	test("verdict falls back to params when result has no verdict", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const params = { verdict: "fail", summary: "Bad" };
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: "plain text no json" }],
			};
			return (window as any).renderDecision(params, mockResult, false);
		});

		expect(result.branch).toBe("complete");
		expect(result.verdict).toBe("fail");
		expect(result.verdictBadge.isPass).toBe(false);
	});
});
