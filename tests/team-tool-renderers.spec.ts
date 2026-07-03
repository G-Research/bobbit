/**
 * Renderer-level regression tests for team tool cards.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/team-tool-renderers.html");
const BUNDLE = path.resolve("tests/fixtures/team-tool-renderers-bundle.js");
const ENTRY = path.resolve("tests/fixtures/team-tool-renderers-entry.ts");

const RENDERER_FILES = [
	"src/ui/tools/renderers/TeamToolRenderers.ts",
	"src/ui/tools/renderers/delegate-cards.ts",
	"src/ui/tools/renderer-registry.ts",
	"src/ui/components/LiveTimer.ts",
].map(f => path.resolve(f));

const PAGE = `file://${FIXTURE}`;

function makeResult(text: string, details?: any, isError = false) {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "team_dismiss",
		isError,
		content: [{ type: "text", text }],
		details,
		timestamp: 0,
	};
}

function mixedText(result: any): string {
	return [
		`team_dismiss ${result.status} for ${result.sessionId}`,
		result.message ? `message: ${result.message}` : undefined,
		`retryable: ${result.retryable === true ? "true" : "false"}`,
		"",
		JSON.stringify(result, null, 2),
	].filter(Boolean).join("\n");
}

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

async function renderDismiss(page: any, result: any, params: any = { session_id: "fallback-session-000" }) {
	await page.evaluate(({ result, params }) => {
		(window as any).__renderTeamDismiss(document.getElementById("container"), params, result, false);
	}, { result, params });
}

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, ...RENDERER_FILES] });
});

test.describe("TeamDismissRenderer", () => {
	test("prefers structured details over mixed human text plus JSON", async ({ page }) => {
		await gotoAndWait(page);
		const textBody = mixedText({ status: "dismissed", sessionId: "wrong-session-000", message: "Dismissed live agent.", retryable: false });
		await renderDismiss(page, makeResult(textBody, {
			ok: true,
			status: "already-dismissed",
			sessionId: "owned-session-1234567890",
			message: "Agent was already archived.",
			retryable: false,
		}));

		await expect(page.locator("#container")).toContainText("Agent already dismissed");
		await expect(page.locator("#container")).toContainText("owned-sessio");
		await expect(page.locator("#container")).toContainText("Agent was already archived.");
		await expect(page.locator("#container")).toContainText("Do not retry.");
		await expect(page.locator("#container")).not.toContainText("Dismissed agent");
	});

	for (const scenario of [
		{ status: "dismissed", label: "Dismissed agent", message: "Terminated and archived.", retryable: false },
		{ status: "already-dismissed", label: "Agent already dismissed", message: "No live process remains.", retryable: false },
		{ status: "not-owned", label: "Dismiss failed — not owned", message: "Session belongs to another owner.", retryable: false },
		{ status: "not-found", label: "Dismiss failed — not found", message: "No session exists for that id.", retryable: false },
		{ status: "failed", label: "Dismiss failed", message: "Archive failed.", retryable: true },
	]) {
		test(`renders ${scenario.status} from mixed text JSON block`, async ({ page }) => {
			await gotoAndWait(page);
			const result = {
				ok: scenario.status === "dismissed" || scenario.status === "already-dismissed",
				status: scenario.status,
				sessionId: `session-${scenario.status}-abcdef`,
				message: scenario.message,
				retryable: scenario.retryable,
			};
			await renderDismiss(page, makeResult(mixedText(result), undefined, scenario.status === "failed"));

			await expect(page.locator("#container")).toContainText(scenario.label);
			await expect(page.locator("#container")).toContainText(`session-${scenario.status}`.slice(0, 12));
			await expect(page.locator("#container")).toContainText(scenario.message);
			await expect(page.locator("#container")).toContainText(scenario.retryable ? "Retry may help." : "Do not retry.");
		});
	}
});
