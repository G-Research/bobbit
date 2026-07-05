import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/verification-result-renderer.spec.ts (v2-dom tier).
//
// Pure-logic port: the legacy file:// fixture inlined plain-JS mirrors of the
// VerificationResultRenderer rendering decisions (getToolState / getResult /
// verdictBadge / renderDecision). There is no exported real symbol matching this
// decision-object shape, so we reproduce the exact helpers and assert the same
// user-visible facts (branch, state, header text, verdict badge, collapse
// heuristic, HTML-report handling).
import { describe, expect, it } from "vitest";

interface McpResult {
	isError?: boolean;
	content?: { type: string; text: string }[];
}

function getToolState(result: McpResult | undefined, isStreaming?: boolean): string {
	if (!result) return isStreaming ? "inprogress" : "complete";
	if (result.isError) {
		const text = (result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
		if (text.includes("Skipped due to queued user message")) return "warning";
		return "error";
	}
	return "complete";
}

function getResult(result: McpResult | undefined): { text: string; data: any } {
	const text = ((result && result.content) || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") || "";
	let data: any = null;
	try {
		data = JSON.parse(text);
	} catch {
		/* not JSON */
	}
	return { text, data };
}

function verdictBadge(verdict: string | undefined): { isPass: boolean; cls: string; label: string } {
	const isPass = (verdict || "").toLowerCase() === "pass";
	return {
		isPass,
		cls: isPass
			? "bg-green-500/20 text-green-600 dark:text-green-400"
			: "bg-red-500/20 text-red-600 dark:text-red-400",
		label: isPass ? "✓ PASS" : "✗ FAIL",
	};
}

function renderDecision(params: any, result: McpResult | undefined, isStreaming?: boolean): any {
	const state = getToolState(result, isStreaming);

	if (!result) {
		return {
			branch: "streaming",
			state,
			headerText: "Submitting verification…",
			hasVerdictBadge: !!(params && params.verdict),
			verdictBadge: params && params.verdict ? verdictBadge(params.verdict) : null,
			hasSummaryMarkdown: !!(params && params.summary),
			summaryContent: (params && params.summary) || "",
			hasReportNote: !!(params && params.report_html),
		};
	}

	if (result.isError) {
		const { text } = getResult(result);
		const skipped = text.includes("Skipped due to queued user message");
		return {
			branch: "error",
			state,
			isSkipped: skipped,
			headerText: skipped ? "Aborted verification" : "Verification failed",
			errorText: text,
			errorClass: skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive",
		};
	}

	const { data, text } = getResult(result);
	const verdict = (data && data.verdict) || (params && params.verdict) || "";
	const summary = (data && data.summary) || (params && params.summary) || text || "";
	const reportHtml = (data && data.report_html) || (params && params.report_html) || "";
	const collapsed = summary.length > 300;

	return {
		branch: "complete",
		state,
		verdict,
		verdictBadge: verdictBadge(verdict),
		summary,
		collapsed,
		hasReportHtml: !!reportHtml,
		reportHtml,
		hasMarkdownBlock: true,
		hasIframe: !!reportHtml,
	};
}

describe("VerificationResultRenderer", () => {
	it("pass verdict renders green badge with ✓ PASS label", () => {
		const badge = verdictBadge("pass");
		expect(badge.isPass).toBe(true);
		expect(badge.label).toBe("✓ PASS");
		expect(badge.cls).toContain("text-green");
	});

	it("fail verdict renders red badge with ✗ FAIL label", () => {
		const badge = verdictBadge("fail");
		expect(badge.isPass).toBe(false);
		expect(badge.label).toBe("✗ FAIL");
		expect(badge.cls).toContain("text-red");
	});

	it("verdict badge is case-insensitive for PASS", () => {
		const badge = verdictBadge("PASS");
		expect(badge.isPass).toBe(true);
		expect(badge.label).toBe("✓ PASS");
	});

	it("streaming state shows 'Submitting verification…' header", () => {
		const params = { verdict: "pass", summary: "## All good\n\n- No issues" };
		const result = renderDecision(params, undefined, true);
		expect(result.branch).toBe("streaming");
		expect(result.state).toBe("inprogress");
		expect(result.headerText).toBe("Submitting verification…");
		expect(result.hasVerdictBadge).toBe(true);
		expect(result.hasSummaryMarkdown).toBe(true);
		expect(result.summaryContent).toBe("## All good\n\n- No issues");
	});

	it("streaming without params shows header only", () => {
		const result = renderDecision(undefined, undefined, true);
		expect(result.branch).toBe("streaming");
		expect(result.hasVerdictBadge).toBe(false);
		expect(result.hasSummaryMarkdown).toBe(false);
		expect(result.hasReportNote).toBe(false);
	});

	it("streaming with report_html shows attached note", () => {
		const params = { verdict: "pass", summary: "Done", report_html: "<h1>Report</h1>" };
		const result = renderDecision(params, undefined, true);
		expect(result.hasReportNote).toBe(true);
	});

	it("complete pass renders success with markdown and verdict badge", () => {
		const params = { verdict: "pass" };
		const mockResult = {
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: "## All good\n\n- No issues" }) }],
		};
		const result = renderDecision(params, mockResult, false);
		expect(result.branch).toBe("complete");
		expect(result.state).toBe("complete");
		expect(result.verdict).toBe("pass");
		expect(result.verdictBadge.isPass).toBe(true);
		expect(result.verdictBadge.label).toBe("✓ PASS");
		expect(result.summary).toBe("## All good\n\n- No issues");
		expect(result.hasMarkdownBlock).toBe(true);
		expect(result.collapsed).toBe(false);
	});

	it("complete fail renders fail badge", () => {
		const mockResult = {
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "fail", summary: "## Issues found\n\n- Bug at line 42" }) }],
		};
		const result = renderDecision(undefined, mockResult, false);
		expect(result.branch).toBe("complete");
		expect(result.verdict).toBe("fail");
		expect(result.verdictBadge.isPass).toBe(false);
		expect(result.verdictBadge.label).toBe("✗ FAIL");
		expect(result.verdictBadge.cls).toContain("text-red");
	});

	it("long summary is collapsed by default (>300 chars)", () => {
		const longSummary = "A".repeat(301);
		const mockResult = {
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: longSummary }) }],
		};
		const result = renderDecision(undefined, mockResult, false);
		expect(result.collapsed).toBe(true);
	});

	it("short summary is expanded by default (<=300 chars)", () => {
		const shortSummary = "A".repeat(300);
		const mockResult = {
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: shortSummary }) }],
		};
		const result = renderDecision(undefined, mockResult, false);
		expect(result.collapsed).toBe(false);
	});

	it("error result renders error branch with text-destructive class", () => {
		const mockResult = { isError: true, content: [{ type: "text", text: "Connection timed out" }] };
		const result = renderDecision(undefined, mockResult, false);
		expect(result.branch).toBe("error");
		expect(result.state).toBe("error");
		expect(result.isSkipped).toBe(false);
		expect(result.headerText).toBe("Verification failed");
		expect(result.errorText).toBe("Connection timed out");
		expect(result.errorClass).toBe("text-destructive");
	});

	it("skipped error renders warning with amber styling", () => {
		const mockResult = { isError: true, content: [{ type: "text", text: "Skipped due to queued user message" }] };
		const result = renderDecision(undefined, mockResult, false);
		expect(result.branch).toBe("error");
		expect(result.state).toBe("warning");
		expect(result.isSkipped).toBe(true);
		expect(result.headerText).toBe("Aborted verification");
		expect(result.errorClass).toContain("text-amber");
	});

	it("HTML report present in result shows iframe/details section", () => {
		const mockResult = {
			isError: false,
			content: [{ type: "text", text: JSON.stringify({
				verdict: "pass",
				summary: "All tests passed",
				report_html: "<html><body><h1>Test Report</h1><img src='screenshot.png'></body></html>",
			}) }],
		};
		const result = renderDecision(undefined, mockResult, false);
		expect(result.branch).toBe("complete");
		expect(result.hasReportHtml).toBe(true);
		expect(result.hasIframe).toBe(true);
		expect(result.reportHtml).toContain("<h1>Test Report</h1>");
	});

	it("complete without report_html has no iframe", () => {
		const mockResult = {
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ verdict: "pass", summary: "Good" }) }],
		};
		const result = renderDecision(undefined, mockResult, false);
		expect(result.hasReportHtml).toBe(false);
		expect(result.hasIframe).toBe(false);
	});

	it("getToolState returns correct states", () => {
		expect(getToolState(undefined, true)).toBe("inprogress");
		expect(getToolState(undefined, false)).toBe("complete");
		expect(getToolState({ isError: false, content: [] }, false)).toBe("complete");
		expect(getToolState({ isError: true, content: [{ type: "text", text: "Error" }] }, false)).toBe("error");
		expect(getToolState({ isError: true, content: [{ type: "text", text: "Skipped due to queued user message" }] }, false)).toBe("warning");
	});

	it("verdict falls back to params when result has no verdict", () => {
		const params = { verdict: "fail", summary: "Bad" };
		const mockResult = { isError: false, content: [{ type: "text", text: "plain text no json" }] };
		const result = renderDecision(params, mockResult, false);
		expect(result.branch).toBe("complete");
		expect(result.verdict).toBe("fail");
		expect(result.verdictBadge.isPass).toBe(false);
	});
});
