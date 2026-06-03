import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle";

const FIXTURE = path.resolve("tests/fixtures/bash-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/bash-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/bash-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/BashRenderer.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, RENDERER_SRC],
	});
});

const PAGE = `file://${FIXTURE}`;

const MULTI_LINE_CMD = `python -c "
import json, sys
data = json.load(open('session-costs.json'))
total = sum(s['cost'] for s in data if s['agent'] == 'agent-qa')
print(f'agent-qa total: \${total:.2f}')
"`;

const DESCRIPTION = "sum agent-qa costs from session-costs.json";

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
}

test.describe("BashRenderer description param", () => {
	test("collapsed header shows description when provided", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(([cmd, desc]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: desc });
		}, [MULTI_LINE_CMD, DESCRIPTION]);

		const header = page.locator("#container button").first();
		await expect(header).toContainText(DESCRIPTION);
		await expect(header).not.toContainText("python -c");

		// The description element has the distinguishing CSS class.
		const desc = page.locator("#container .bash-description");
		await expect(desc).toHaveCount(1);
		await expect(desc).toHaveText(DESCRIPTION);
		await expect(desc).toHaveClass(/italic/);
		// And is NOT monospace (the fallback uses font-mono).
		await expect(desc).not.toHaveClass(/font-mono/);
	});

	test("collapsed header falls back to summarized command when description is absent", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((cmd) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd });
		}, MULTI_LINE_CMD);

		const header = page.locator("#container button").first();
		// First line of the command, possibly truncated with …
		await expect(header).toContainText("python -c");
		await expect(page.locator("#container .bash-description")).toHaveCount(0);
		// Monospace fallback class is present on the header text.
		await expect(page.locator("#container .font-mono").first()).toBeVisible();
	});

	test("collapsed header falls back when description is empty string", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((cmd) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: "" });
		}, MULTI_LINE_CMD);

		const header = page.locator("#container button").first();
		await expect(header).toContainText("python -c");
		await expect(page.locator("#container .bash-description")).toHaveCount(0);
	});

	test("expanded body shows full command verbatim, with description", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(([cmd, desc]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: desc });
		}, [MULTI_LINE_CMD, DESCRIPTION]);

		// Streaming view shows the full command in the expanded console-block.
		const cb = page.locator("#container console-block");
		const text = (await cb.textContent()) ?? "";
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");
		expect(text).toContain("session-costs.json");
	});

	test("expanded body shows full command verbatim, without description", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((cmd) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd });
		}, MULTI_LINE_CMD);

		const cb = page.locator("#container console-block");
		const text = (await cb.textContent()) ?? "";
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");
	});

	test("description persists across page reload (pure render function)", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(([cmd, desc]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: desc });
		}, [MULTI_LINE_CMD, DESCRIPTION]);
		await expect(page.locator("#container .bash-description")).toHaveText(DESCRIPTION);

		await page.reload();
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
		await page.evaluate(([cmd, desc]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: desc });
		}, [MULTI_LINE_CMD, DESCRIPTION]);
		await expect(page.locator("#container .bash-description")).toHaveText(DESCRIPTION);
	});
});
