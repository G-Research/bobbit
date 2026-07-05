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

async function loadFixture(page: Page, options?: { sessionId?: string; runtime?: "pi" | "claude-code"; clearStorage?: boolean }): Promise<string[]> {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	if (options?.clearStorage) await page.evaluate(() => localStorage.clear());
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__agentInterfaceUsageReady === true, null, { timeout: 10_000 });
	await page.evaluate((fixtureOptions) => (window as any).__mountAgentInterfaceUsageFixture(fixtureOptions), options ?? {});
	await page.waitForSelector("agent-interface message-list", { timeout: 10_000 });
	return errors;
}

test.describe("AgentInterface usage hydration hardening", () => {
	test("renders hydrated Claude Code messages with raw snake_case usage and no cost", async ({ page }) => {
		const errors = await loadFixture(page, { clearStorage: true });

		await expect(page.locator("agent-interface").getByText("The file contains Bobbit project notes.").first()).toBeVisible({ timeout: 10_000 });
		// Scoped to visible matches only: the raw "Read" tool output also contains
		// this substring, but it renders inside a collapsed (`max-h-0`,
		// collapsed-by-default) disclosure per DefaultRenderer/ReadRenderer — a
		// contract that predates this fixture (see src/ui/tools/renderers/DefaultRenderer.ts,
		// "(collapsed; expand to inspect)", present since commit 94770a5b / 0ea446a3,
		// 2026-03-13). An unscoped `.first()` picks that hidden node by DOM order
		// and was never reliably testing anything; assert against the visible
		// assistant text instead.
		await expect(page.locator("agent-interface").getByText("Bobbit project notes").filter({ visible: true }).first()).toBeVisible({ timeout: 10_000 });

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

	test("shows Claude Code capability notice above existing messages and expands details", async ({ page }) => {
		await loadFixture(page, { sessionId: "notice-claude", runtime: "claude-code", clearStorage: true });

		const notice = page.locator("agent-interface [data-testid='claude-code-capability-notice']");
		await expect(notice).toBeVisible({ timeout: 10_000 });
		await expect(notice).toContainText("Claude Code local runtime");
		await expect(notice).toContainText("This session runs through your local Claude Code CLI");
		await expect(page.locator("agent-interface").getByText("The file contains Bobbit project notes.").first()).toBeVisible();
		expect(await page.evaluate(() => {
			const el = document.querySelector("agent-interface");
			const markup = el?.shadowRoot?.innerHTML ?? el?.innerHTML ?? "";
			return markup.indexOf("claude-code-capability-notice") >= 0
				&& markup.indexOf("claude-code-capability-notice") < markup.indexOf("<message-list");
		})).toBe(true);

		const toggle = page.locator("agent-interface [data-testid='claude-code-capability-details-toggle']");
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-details']")).toContainText("Claude Code handles");
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-details']")).toContainText("Bobbit handles");
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-details']")).toContainText("Still standard Bobbit runtime");
	});

	test("does not show Claude Code capability notice for Pi sessions", async ({ page }) => {
		await loadFixture(page, { sessionId: "notice-pi", runtime: "pi", clearStorage: true });

		await expect(page.locator("agent-interface [data-testid='claude-code-capability-notice']")).toHaveCount(0);
		await expect(page.locator("agent-interface").getByText("The file contains Bobbit project notes.").first()).toBeVisible({ timeout: 10_000 });
	});

	test("dismisses Claude Code capability notice per session and persists across reload", async ({ page }) => {
		await loadFixture(page, { sessionId: "notice-a", runtime: "claude-code", clearStorage: true });
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-notice']")).toBeVisible({ timeout: 10_000 });
		await page.getByLabel("Dismiss Claude Code runtime note for this session").click();
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-notice']")).toHaveCount(0);

		await page.evaluate(async () => {
			const el = (window as any).__agentInterfaceUsageEl;
			el.requestUpdate();
			await el.updateComplete;
		});
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-notice']")).toHaveCount(0);

		await page.evaluate(async () => (window as any).__mountAgentInterfaceUsageFixture({ sessionId: "notice-a", runtime: "claude-code" }));
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-notice']")).toHaveCount(0);

		await page.evaluate(async () => (window as any).__mountAgentInterfaceUsageFixture({ sessionId: "notice-b", runtime: "claude-code" }));
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-notice']")).toBeVisible({ timeout: 10_000 });

		await page.reload();
		await page.addScriptTag({ path: BUNDLE });
		await page.waitForFunction(() => (window as any).__agentInterfaceUsageReady === true, null, { timeout: 10_000 });
		await page.evaluate(async () => (window as any).__mountAgentInterfaceUsageFixture({ sessionId: "notice-a", runtime: "claude-code" }));
		await page.waitForSelector("agent-interface message-list", { timeout: 10_000 });
		await expect(page.locator("agent-interface [data-testid='claude-code-capability-notice']")).toHaveCount(0);
	});
});
