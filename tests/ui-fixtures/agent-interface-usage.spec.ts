import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/agent-interface-usage-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "agent-interface-usage-bundle.js");
const AGENT_INTERFACE_SRC = path.resolve("src/ui/components/AgentInterface.ts");

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, AGENT_INTERFACE_SRC],
	});
});

async function loadFixture(page: Page): Promise<string[]> {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__agentInterfaceUsageReady === true, null, { timeout: 10_000 });
	await page.evaluate(() => (window as any).__mountAgentInterfaceUsageFixture());
	await page.waitForSelector("agent-interface message-list", { timeout: 10_000 });
	return errors;
}

test.describe("AgentInterface usage hydration hardening", () => {
	test("renders hydrated Claude Code messages with raw snake_case usage and no cost", async ({ page }) => {
		const errors = await loadFixture(page);

		await expect(page.locator("agent-interface").getByText("The file contains Bobbit project notes.").first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("agent-interface").getByText("Bobbit project notes").first()).toBeVisible({ timeout: 10_000 });

		await page.evaluate(async () => {
			const el = (window as any).__agentInterfaceUsageEl;
			if (!el) throw new Error("agent-interface not mounted");
			el.requestUpdate("session");
			await el.updateComplete;
		});

		const messageCount = await page.evaluate(() => ((window as any).__agentInterfaceUsageEl?.session?.state?.messages ?? []).length);
		expect(messageCount).toBe(4);
		expect(errors.filter((line) => !/favicon|ResizeObserver loop/i.test(line))).toEqual([]);
	});
});
