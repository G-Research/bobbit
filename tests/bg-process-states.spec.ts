/**
 * PI-20: Background process pill states and log popup interactions.
 *
 * Tests: running vs exited indicators, dropdown toggle, log output display,
 * kill/dismiss buttons, outside-click close, Escape close, exit code display.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/bg-process-states.html").replace(/\\/g, "/")}`;

const RUNNING_PROCESS = {
	id: "bg-run-1",
	name: "dev server",
	command: "node server.js --port 3000",
	pid: 12345,
	status: "running" as const,
	exitCode: null,
	startTime: Date.now(),
};

const EXITED_OK_PROCESS = {
	id: "bg-exit-0",
	name: "build",
	command: "npm run build",
	pid: 12346,
	status: "exited" as const,
	exitCode: 0,
	startTime: Date.now() - 5000,
};

const EXITED_ERROR_PROCESS = {
	id: "bg-exit-1",
	name: "test runner",
	command: "npm test",
	pid: 12347,
	status: "exited" as const,
	exitCode: 1,
	startTime: Date.now() - 10000,
};

async function ready(page: Page) {
	await page.waitForFunction(() => (window as any)._testReady === true);
}

async function createPill(page: Page, processInfo: typeof RUNNING_PROCESS) {
	return page.evaluate((p) => {
		const pill = (window as any).createPill(p);
		return pill !== null;
	}, processInfo);
}

async function cleanup(page: Page) {
	await page.evaluate(() => (window as any).clearPills());
}

test.describe("BgProcessPill status indicators", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await ready(page);
	});

	test.afterEach(async ({ page }) => {
		await cleanup(page);
	});

	test("running process shows blue pulsing indicator dot", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);

		const dot = page.locator("bg-process-pill [data-status='running']");
		await expect(dot).toBeVisible();
		// Blue background, animate-pulse class
		await expect(dot).toHaveClass(/bg-blue-600/);
		await expect(dot).toHaveClass(/animate-pulse/);
	});

	test("exited process (code 0) shows green indicator dot", async ({ page }) => {
		await createPill(page, EXITED_OK_PROCESS);

		const dot = page.locator("bg-process-pill [data-status='exited-ok']");
		await expect(dot).toBeVisible();
		await expect(dot).toHaveClass(/bg-green-600/);
		// Should NOT pulse
		const classes = await dot.getAttribute("class");
		expect(classes).not.toContain("animate-pulse");
	});

	test("exited process (code 1) shows red error indicator", async ({ page }) => {
		await createPill(page, EXITED_ERROR_PROCESS);

		const indicator = page.locator("bg-process-pill [data-status='exited-error']");
		await expect(indicator).toBeVisible();
		await expect(indicator).toHaveClass(/text-red-600/);
		await expect(indicator).toHaveText("!");
	});

	test("pill displays process name", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);

		const name = page.locator("bg-process-pill [data-pill-name]");
		await expect(name).toHaveText("dev server");
	});

	test("pill uses id as fallback when name is missing", async ({ page }) => {
		const noNameProc = { ...RUNNING_PROCESS, name: "", id: "bg-unnamed" };
		await createPill(page, noNameProc);

		const name = page.locator("bg-process-pill [data-pill-name]");
		await expect(name).toHaveText("bg-unnamed");
	});
});

test.describe("BgProcessPill dropdown toggle", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await ready(page);
	});

	test.afterEach(async ({ page }) => {
		await cleanup(page);
	});

	test("click pill toggle opens dropdown portaled to body", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);

		// No dropdown initially
		expect(await page.locator("#bg-process-dropdown").count()).toBe(0);

		// Click toggle
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		// Dropdown appears
		const dropdown = page.locator("#bg-process-dropdown");
		await expect(dropdown).toBeVisible();

		// Portal is a direct child of body
		const isPortaled = await dropdown.evaluate((el) => {
			return el.closest("[data-bg-portal]")?.parentElement === document.body;
		});
		expect(isPortaled).toBe(true);
	});

	test("clicking toggle again closes dropdown", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);

		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await expect(page.locator("#bg-process-dropdown")).toBeVisible();

		// Click toggle again to close
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		// Wait for close animation
		await page.waitForTimeout(350);
		expect(await page.locator("#bg-process-dropdown").count()).toBe(0);
	});

	test("dropdown shows log output from fetch", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const dropdown = page.locator("#bg-process-dropdown");
		await expect(dropdown).toBeVisible();

		// Log lines should be rendered
		const logLines = dropdown.locator("[data-log-line]");
		await expect(logLines).toHaveCount(3);

		// Check content
		await expect(logLines.nth(0)).toContainText("Starting server...");
		await expect(logLines.nth(1)).toContainText("Listening on port 3000");
		await expect(logLines.nth(2)).toContainText("Ready.");
	});

	test("dropdown shows (no output yet) when logs empty", async ({ page }) => {
		await page.evaluate(() => (window as any).setMockLogs([]));
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const noOutput = page.locator("#bg-process-dropdown [data-no-output]");
		await expect(noOutput).toBeVisible();
		await expect(noOutput).toContainText("(no output yet)");
	});

	test("dropdown shows command text", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const cmd = page.locator("#bg-process-dropdown [data-command]");
		await expect(cmd).toHaveText("node server.js --port 3000");
	});

	test("fetch is called with correct URL when dropdown opens", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.evaluate(() => (window as any).clearFetchCalls());
		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await expect(page.locator("#bg-process-dropdown")).toBeVisible();

		const calls = await page.evaluate(() => (window as any).getFetchCalls());
		const logCall = calls.find((c: any) => c.url.includes("/logs"));
		expect(logCall).toBeDefined();
		expect(logCall.url).toContain(`/api/sessions/test-session/bg-processes/${RUNNING_PROCESS.id}/logs`);
	});
});

test.describe("BgProcessPill kill and dismiss", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await ready(page);
	});

	test.afterEach(async ({ page }) => {
		await cleanup(page);
	});

	test("dropdown shows Kill button for running process", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const killBtn = page.locator("#bg-process-dropdown [data-kill-btn]");
		await expect(killBtn).toBeVisible();
		await expect(killBtn).toHaveText("Kill");

		// No Remove button
		expect(await page.locator("#bg-process-dropdown [data-dismiss-btn]").count()).toBe(0);
	});

	test("dropdown shows Remove button for exited process", async ({ page }) => {
		await createPill(page, EXITED_OK_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const removeBtn = page.locator("#bg-process-dropdown [data-dismiss-btn]");
		await expect(removeBtn).toBeVisible();
		await expect(removeBtn).toHaveText("Remove");

		// No Kill button
		expect(await page.locator("#bg-process-dropdown [data-kill-btn]").count()).toBe(0);
	});

	test("Kill button fires onKill callback", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__killCalls = [];
			pill.onKill = (id) => (window as any).__killCalls.push(id);
		}, RUNNING_PROCESS);

		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await page.locator("#bg-process-dropdown [data-kill-btn]").click();

		const killCalls = await page.evaluate(() => (window as any).__killCalls);
		expect(killCalls).toEqual([RUNNING_PROCESS.id]);
	});

	test("Remove button fires onDismiss callback", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__dismissCalls = [];
			pill.onDismiss = (id) => (window as any).__dismissCalls.push(id);
		}, EXITED_OK_PROCESS);

		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await page.locator("#bg-process-dropdown [data-dismiss-btn]").click();

		const dismissCalls = await page.evaluate(() => (window as any).__dismissCalls);
		expect(dismissCalls).toEqual([EXITED_OK_PROCESS.id]);
	});

	test("pill X button kills running process", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__killCalls = [];
			pill.onKill = (id) => (window as any).__killCalls.push(id);
		}, RUNNING_PROCESS);

		await page.locator("bg-process-pill [data-x-btn]").click();

		const killCalls = await page.evaluate(() => (window as any).__killCalls);
		expect(killCalls).toEqual([RUNNING_PROCESS.id]);
	});

	test("pill X button dismisses exited process", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__dismissCalls = [];
			pill.onDismiss = (id) => (window as any).__dismissCalls.push(id);
		}, EXITED_OK_PROCESS);

		await page.locator("bg-process-pill [data-x-btn]").click();

		const dismissCalls = await page.evaluate(() => (window as any).__dismissCalls);
		expect(dismissCalls).toEqual([EXITED_OK_PROCESS.id]);
	});
});

test.describe("BgProcessPill dropdown close behaviors", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await ready(page);
	});

	test.afterEach(async ({ page }) => {
		await cleanup(page);
	});

	test("clicking outside closes dropdown", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await expect(page.locator("#bg-process-dropdown")).toBeVisible();

		// Click on body outside the pill and dropdown
		await page.mouse.click(5, 5);

		// Wait for close animation
		await page.waitForTimeout(350);
		expect(await page.locator("#bg-process-dropdown").count()).toBe(0);
	});

	test("Escape key closes dropdown", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await expect(page.locator("#bg-process-dropdown")).toBeVisible();

		await page.keyboard.press("Escape");

		// Wait for close animation
		await page.waitForTimeout(350);
		expect(await page.locator("#bg-process-dropdown").count()).toBe(0);
	});

	test("clicking inside dropdown does NOT close it", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await expect(page.locator("#bg-process-dropdown")).toBeVisible();

		// Click inside the dropdown content
		await page.locator("#bg-process-dropdown [data-command]").click();

		// Dropdown should still be open
		await expect(page.locator("#bg-process-dropdown")).toBeVisible();
	});
});

test.describe("BgProcessPill exit code display", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await ready(page);
	});

	test.afterEach(async ({ page }) => {
		await cleanup(page);
	});

	test("exited process (code 0) shows 'exit 0' in green in dropdown", async ({ page }) => {
		await createPill(page, EXITED_OK_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const exitCode = page.locator("#bg-process-dropdown [data-exit-code]");
		await expect(exitCode).toBeVisible();
		await expect(exitCode).toHaveText("exit 0");
		await expect(exitCode).toHaveClass(/text-green-700/);
	});

	test("exited process (code 1) shows 'exit 1' in red in dropdown", async ({ page }) => {
		await createPill(page, EXITED_ERROR_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const exitCode = page.locator("#bg-process-dropdown [data-exit-code]");
		await expect(exitCode).toBeVisible();
		await expect(exitCode).toHaveText("exit 1");
		await expect(exitCode).toHaveClass(/text-red-700/);
	});

	test("running process does NOT show exit code in dropdown", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		expect(await page.locator("#bg-process-dropdown [data-exit-code]").count()).toBe(0);
	});

	test("dropdown header shows process id and pid", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const dropdown = page.locator("#bg-process-dropdown");
		await expect(dropdown).toContainText("bg-run-1");
		await expect(dropdown).toContainText("pid 12345");
	});
});
