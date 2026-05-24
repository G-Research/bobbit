/**
 * Browser E2E for BashRenderer `description` param.
 *
 * Uses the same file:// fixture as tests/bash-renderer-description.spec.ts
 * — no gateway spawned, because `description` is pure passthrough UI metadata
 * with no server round-trip. The fixture harness pattern (bundle + file://)
 * gives full browser fidelity: real DOM, real CSS, real reload.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/bash-renderer.html");
const BUNDLE = path.resolve("tests/fixtures/bash-renderer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/bash-renderer-entry.ts");
const RENDERER_SRC = path.resolve("src/ui/tools/renderers/BashRenderer.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(RENDERER_SRC).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				'--alias:pdfjs-dist=./tests/fixtures/empty-shim',
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
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

test.describe("BashRenderer description (browser E2E)", () => {
	test("description replaces summarized command in collapsed header and has muted/italic style", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(([cmd, desc]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: desc });
		}, [MULTI_LINE_CMD, DESCRIPTION]);

		const header = page.locator("#container button").first();
		await expect(header).toContainText(DESCRIPTION);
		await expect(header).not.toContainText("python -c");

		const desc = page.locator("#container .bash-description");
		await expect(desc).toHaveCount(1);
		await expect(desc).toHaveText(DESCRIPTION);
		await expect(desc).toHaveClass(/italic/);
		await expect(desc).not.toHaveClass(/font-mono/);
	});

	test("backward compatibility: absent description uses summarizeCommand fallback", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((cmd) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd });
		}, MULTI_LINE_CMD);

		const header = page.locator("#container button").first();
		await expect(header).toContainText("python -c");
		await expect(page.locator("#container .bash-description")).toHaveCount(0);
	});

	test("backward compatibility: empty-string description falls back to summary", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((cmd) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: "" });
		}, MULTI_LINE_CMD);

		const header = page.locator("#container button").first();
		await expect(header).toContainText("python -c");
		await expect(page.locator("#container .bash-description")).toHaveCount(0);
	});

	test("expanded body shows full command verbatim (with and without description)", async ({ page }) => {
		await gotoAndWait(page);

		// With description
		await page.evaluate(([cmd, desc]) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd, description: desc });
		}, [MULTI_LINE_CMD, DESCRIPTION]);
		let cb = page.locator("#container console-block");
		let text = (await cb.textContent()) ?? "";
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");

		// Without description
		await page.evaluate((cmd) => {
			const el = document.getElementById("container")!;
			(window as any).__renderBash(el, { command: cmd });
		}, MULTI_LINE_CMD);
		cb = page.locator("#container console-block");
		text = (await cb.textContent()) ?? "";
		expect(text).toContain("import json, sys");
		expect(text).toContain("agent-qa total:");
	});

	test("collapsed header persists across reload (renderer is a pure function)", async ({ page }) => {
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
