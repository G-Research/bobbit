/**
 * Regression coverage for the generic DefaultRenderer payload sections.
 * Uses a file:// fixture with a tiny test-only <code-block> implementation so
 * raw payload visibility can be asserted without depending on the app shell.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/default-tool-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/default-tool-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/default-tool-renderer-entry.ts");

const RENDERER_FILES = [
	"src/ui/tools/index.ts",
	"src/ui/tools/renderers/DefaultRenderer.ts",
	"src/ui/tools/renderers/McpDefaultRenderer.ts",
	"src/ui/tools/renderers/payload-section.ts",
	"src/ui/tools/renderer-registry.ts",
	"src/ui/components/ExpandableSection.ts",
].map(f => path.resolve(f));

const PAGE = `file://${FIXTURE}`;
const INPUT_SENTINEL = "alpha-input-payload-sentinel";
const OUTPUT_SENTINEL = "omega-output-payload-sentinel";
const ERROR_SENTINEL = "critical-error-output-sentinel";
const LARGE_ARG_SENTINEL = "large-mcp-argument-sentinel";

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, ...RENDERER_FILES] });
});

async function gotoAndWait(page: Page) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

async function renderDefaultTool(page: Page, options: { isError?: boolean } = {}) {
	await page.evaluate(({ input, output, isError }) => {
		(window as any).__renderDefaultTool(
			"diagnostic_tool",
			{ query: input, nested: { count: 2, flag: true } },
			{ ok: !isError, output, nested: { items: ["one", "two"] } },
			Boolean(isError),
		);
	}, { input: INPUT_SENTINEL, output: options.isError ? ERROR_SENTINEL : OUTPUT_SENTINEL, isError: options.isError });
}

function payloadControl(page: Page, label: "Input" | "Output") {
	return page.locator("#container").getByRole("button", { name: new RegExp(label, "i") }).first();
}

async function renderMcpTool(page: Page, toolName = "mcp__playwright__browser_navigate") {
	await page.evaluate(({ toolName, large }) => {
		(window as any).__renderMcpTool(
			toolName,
			{ url: "https://example.test", waitUntil: "load", payload: large },
			{ ok: true, output: "mcp-output-sentinel" },
			false,
		);
	}, { toolName, large: `${LARGE_ARG_SENTINEL}:${"x".repeat(220)}` });
}

async function payloadTextIsVisiblyPainted(page: Page, text: string): Promise<boolean> {
	return page.evaluate((needle) => {
		const container = document.getElementById("container");
		if (!container) return false;

		const hasUsableRect = (rect: DOMRect) => rect.width > 0 && rect.height > 0;
		const intersects = (a: DOMRect, b: DOMRect) =>
			Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
			Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);

		const isPainted = (el: Element): boolean => {
			let rect = el.getBoundingClientRect();
			if (!hasUsableRect(rect)) return false;

			for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
				const style = window.getComputedStyle(node);
				if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
				if (node instanceof HTMLDetailsElement && !node.open && !el.closest("summary")) return false;

				const clips = /(hidden|clip|auto|scroll)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`);
				if (clips) {
					const ancestorRect = node.getBoundingClientRect();
					if (!hasUsableRect(ancestorRect) || !intersects(rect, ancestorRect)) return false;
					rect = new DOMRect(
						Math.max(rect.left, ancestorRect.left),
						Math.max(rect.top, ancestorRect.top),
						Math.max(0, Math.min(rect.right, ancestorRect.right) - Math.max(rect.left, ancestorRect.left)),
						Math.max(0, Math.min(rect.bottom, ancestorRect.bottom) - Math.max(rect.top, ancestorRect.top)),
					);
				}
			}
			return true;
		};

		return Array.from(container.querySelectorAll("code-block, pre"))
			.filter(el => el.textContent?.includes(needle))
			.some(isPainted);
	}, text);
}

async function expectPayloadVisible(page: Page, text: string, visible: boolean) {
	expect(await payloadTextIsVisiblyPainted(page, text)).toBe(visible);
}

test.describe("DefaultRenderer payload collapse", () => {
	test("keeps the header/status visible while JSON input and output are collapsed by default", async ({ page }) => {
		await gotoAndWait(page);
		await renderDefaultTool(page);

		await expect(page.locator("#container")).toContainText("Diagnostic Tool");
		await expect(page.locator("#container span[class*='text-green']").first()).toBeVisible();
		await expect(payloadControl(page, "Input")).toBeVisible();
		await expect(payloadControl(page, "Output")).toBeVisible();

		await expectPayloadVisible(page, INPUT_SENTINEL, false);
		await expectPayloadVisible(page, OUTPUT_SENTINEL, false);
	});

	test("allows keyboard and click expansion of full JSON input and output payloads", async ({ page }) => {
		await gotoAndWait(page);
		await renderDefaultTool(page);

		await expect(payloadControl(page, "Input").getByText("Expand", { exact: true })).toHaveClass(/underline/);
		await payloadControl(page, "Input").focus();
		await page.keyboard.press("Enter");
		await expect(payloadControl(page, "Input").getByText("Collapse", { exact: true })).toHaveClass(/underline/);
		await expectPayloadVisible(page, INPUT_SENTINEL, true);
		await expectPayloadVisible(page, OUTPUT_SENTINEL, false);

		await payloadControl(page, "Output").click();
		await expectPayloadVisible(page, INPUT_SENTINEL, true);
		await expectPayloadVisible(page, OUTPUT_SENTINEL, true);
		await expect(page.locator("#container code-block")).toHaveCount(2);
	});

	test("does not hide error status indicators behind collapsed raw output", async ({ page }) => {
		await gotoAndWait(page);
		await renderDefaultTool(page, { isError: true });

		await expect(page.locator("#container")).toContainText("Diagnostic Tool");
		await expect(page.locator("#container span[class*='text-destructive']").first()).toBeVisible();
		await expect(payloadControl(page, "Output")).toBeVisible();
		await expectPayloadVisible(page, ERROR_SENTINEL, false);

		await payloadControl(page, "Output").click();
		await expectPayloadVisible(page, ERROR_SENTINEL, true);
	});

	test("promotes action before operation in the default renderer title row", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderDefaultTool(
				"bobbit_admin",
				{ operation: "custom_providers", action: "list", scope: "server", projectId: "headquarters", config: { large: true } },
				{ ok: true },
				false,
			);
		});

		await expect(page.locator("#container")).toContainText("Bobbit Admin");
		await expect(page.locator("#container")).toContainText("action=list");
		await expect(page.locator("#container")).toContainText("operation=custom_providers");
		await expect(page.locator("#container")).toContainText("scope=server");
		await expect(page.locator("#container")).toContainText("projectId=headquarters");
		await expect(page.locator("#container")).toContainText("+1 more");
		const headerText = await page.locator("#container").textContent();
		const actionIndex = headerText?.indexOf("action=list") ?? -1;
		const operationIndex = headerText?.indexOf("operation=custom_providers") ?? -1;
		expect(actionIndex).toBeGreaterThanOrEqual(0);
		expect(actionIndex).toBeLessThan(operationIndex);
		await expect(payloadControl(page, "Input")).toBeVisible();
	});

	test("MCP fallback renderer shows invoked tool and omits large args from the summary", async ({ page }) => {
		await gotoAndWait(page);
		await renderMcpTool(page);

		await expect(page.locator("#container")).toContainText("MCP:");
		await expect(page.locator("#container")).toContainText("playwright");
		await expect(page.locator("#container")).toContainText("browser_navigate");
		await expect(page.locator("[data-mcp-arg-summary]")).toContainText("url");
		await expect(page.locator("[data-mcp-arg-summary]")).toContainText("https://example.test");
		await expect(page.locator("[data-mcp-arg-summary]")).not.toContainText(LARGE_ARG_SENTINEL);
		await expect(page.locator("[data-mcp-arg-summary]")).toContainText("large argument");
		await expectPayloadVisible(page, LARGE_ARG_SENTINEL, false);

		await payloadControl(page, "Input").click();
		await expectPayloadVisible(page, LARGE_ARG_SENTINEL, true);
	});

	test("renderTool cascade uses the MCP fallback for unregistered meta tools", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderCascadeTool(
				"mcp_playwright",
				{ operation: "browser_click", args: { selector: "#submit" } },
				{ ok: true },
				false,
			);
		});

		await expect(page.locator("#container")).toContainText("MCP:");
		await expect(page.locator("#container")).toContainText("mcp_playwright");
		await expect(page.locator("#container")).toContainText("browser_click");
		await expect(page.locator("[data-mcp-arg-summary]")).toContainText("selector");
	});
});
