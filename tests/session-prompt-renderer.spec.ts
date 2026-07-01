import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/session-prompt-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/session-prompt-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/session-prompt-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/SessionPromptRenderer.ts");
const DELEGATE_CARDS_SRC = path.resolve("src/ui/tools/renderers/delegate-cards.ts");
const REGISTRY_SRC = path.resolve("src/ui/tools/renderer-registry.ts");

const TARGET_ID = "12345678-90ab-cdef-1234-567890abcdef";

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, RENDERER_SRC, DELEGATE_CARDS_SRC, REGISTRY_SRC] });
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

function makeResult(data: any, isError = false) {
	return {
		role: "toolResult",
		toolCallId: "tool-session-prompt-1",
		toolName: "session_prompt",
		isError,
		content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
		details: typeof data === "string" ? undefined : data,
		timestamp: Date.now(),
	};
}

async function renderSessionPrompt(page: any, params: any, result: any, isStreaming = false) {
	await page.evaluate(
		([p, r, streaming]) => {
			(window as any).__renderSessionPrompt(document.getElementById("container")!, p, r, streaming);
		},
		[params, result, isStreaming],
	);
}

test.describe("SessionPromptRenderer", () => {
	test.beforeEach(async ({ page }) => {
		await gotoAndWait(page);
	});

	test("default prompt mode renders message icon, target title, session link, and delivery outcome", async ({ page }) => {
		await renderSessionPrompt(
			page,
			{ session_id: TARGET_ID, message: "Please review the queued work." },
			makeResult({
				ok: true,
				mode: "prompt",
				status: "dispatched",
				target: { sessionId: TARGET_ID, title: "Release Bot" },
			}),
		);

		await expect(page.locator("#container")).toContainText("Prompted");
		await expect(page.locator("#container")).toContainText("Release Bot");
		await expect(page.locator("#container")).toContainText("dispatched");
		await expect(page.locator("#container")).toContainText("Please review the queued work.");
		await expect(page.locator(`#container a[href="#/session/${TARGET_ID}"]`)).toHaveCount(1);
		await expect(page.locator("#container svg.lucide-message-square")).toHaveCount(1);
		await expect(page.locator("#container svg.lucide-zap")).toHaveCount(0);
		await expect(page.locator("#container")).not.toContainText('"ok"');
	});

	test("steer mode renders a distinct steer icon/label and live dispatch outcome", async ({ page }) => {
		await renderSessionPrompt(
			page,
			{ session_id: TARGET_ID, mode: "steer", message: "Redirect now." },
			makeResult({
				ok: true,
				mode: "steer",
				dispatched: true,
				target: { sessionId: TARGET_ID, title: "Live Agent" },
			}),
		);

		await expect(page.locator("#container")).toContainText("Steered");
		await expect(page.locator("#container")).toContainText("Live Agent");
		await expect(page.locator("#container")).toContainText("live steer dispatched");
		await expect(page.locator("#container")).toContainText("Redirect now.");
		await expect(page.locator("#container svg.lucide-zap")).toHaveCount(1);
		await expect(page.locator("#container svg.lucide-message-square")).toHaveCount(0);
	});

	test("multiline prompt body preserves line breaks and escapes message content", async ({ page }) => {
		const message = "First line\nSecond line\n  Indented <script>alert(1)</script>";
		await renderSessionPrompt(
			page,
			{ session_id: TARGET_ID, message },
			makeResult({
				ok: true,
				mode: "prompt",
				status: "queued",
				target: { sessionId: TARGET_ID, title: "Queue Target" },
			}),
		);

		const body = page.locator("#container .whitespace-pre-wrap");
		await expect(body).toHaveCount(1);
		await expect(body).toHaveText(message);
		await expect(page.locator("#container script")).toHaveCount(0);
		await expect(body).toContainText("<script>alert(1)</script>");
	});

	test("missing title falls back to a shortened session id while preserving the session link", async ({ page }) => {
		const untitledId = "0f3dfc9a-1111-4222-8333-abcdefabcdef";
		await renderSessionPrompt(
			page,
			{ session_id: untitledId, message: "No title here." },
			makeResult({
				ok: true,
				mode: "prompt",
				status: "queued",
				target: { sessionId: untitledId },
			}),
		);

		const renderedText = await page.locator("#container").innerText();
		expect(renderedText).toContain("0f3dfc9a");
		expect(renderedText).not.toContain(untitledId);
		await expect(page.locator(`#container a[href="#/session/${untitledId}"]`)).toHaveCount(1);
	});

	test("error state shows server error text with destructive styling", async ({ page }) => {
		const errorText = "target session is not live: terminated";
		await renderSessionPrompt(
			page,
			{ session_id: TARGET_ID, mode: "steer", message: "Try steering anyway." },
			makeResult(errorText, true),
		);

		await expect(page.locator("#container")).toContainText("Steer failed");
		await expect(page.locator("#container")).toContainText(errorText);
		await expect(page.locator("#container .text-destructive")).toContainText(errorText);
	});
});
