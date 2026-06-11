/**
 * PI-20: Background process pill states and log popup interactions.
 *
 * Tests: running vs exited indicators, dropdown toggle, log output display,
 * kill/dismiss buttons, outside-click close, Escape close, exit code display.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = `file://${path.resolve("tests/bg-process-states.html").replace(/\\/g, "/")}`;
const TIMER_FIXTURE_PATH = path.resolve("tests/fixtures/bg-process-timer.html");
const TIMER_FIXTURE = `file://${TIMER_FIXTURE_PATH.replace(/\\/g, "/")}`;
const TIMER_ENTRY = path.resolve("tests/fixtures/bg-process-timer-entry.ts");
const TIMER_BUNDLE = path.resolve("test-results/bg-process-timer-bundle.js");
const BG_PROCESS_PILL_SRC = path.resolve("src/ui/components/BgProcessPill.ts");
const LIVE_TIMER_SRC = path.resolve("src/ui/components/LiveTimer.ts");

test.beforeAll(() => {
	fs.mkdirSync(path.dirname(TIMER_BUNDLE), { recursive: true });
	buildBundle({
		entry: TIMER_ENTRY,
		outfile: TIMER_BUNDLE,
		deps: [TIMER_ENTRY, BG_PROCESS_PILL_SRC, LIVE_TIMER_SRC],
	});
});

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

// Killed by the user: terminal "exited" record with no real exit code (terminalReason="killed").
const KILLED_PROCESS = {
	id: "bg-killed",
	name: "killed proc",
	command: "sleep 999",
	pid: 12348,
	status: "exited" as const,
	exitCode: null,
	terminalReason: "killed" as const,
	startTime: Date.now() - 8000,
	endTime: Date.now() - 2000,
};

// Lost across a gateway restart: widened "unrecoverable" status, exit code unknown (never fabricated).
const UNRECOVERABLE_PROCESS = {
	id: "bg-unrec",
	name: "lost proc",
	command: "npm run watch",
	pid: 12349,
	status: "unrecoverable" as const,
	exitCode: null,
	terminalReason: "unrecoverable" as const,
	startTime: Date.now() - 20000,
	endTime: Date.now() - 1000,
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

async function readyTimerFixture(page: Page) {
	await page.waitForFunction(() => (window as any).__bgTimerReady === true);
}

async function gotoTimerFixture(page: Page) {
	await page.goto(TIMER_FIXTURE);
	await page.addScriptTag({ path: TIMER_BUNDLE });
	await readyTimerFixture(page);
}

async function createTimerPill(page: Page, processInfo: Record<string, unknown>) {
	return page.evaluate((p) => {
		const pill = (window as any).createPill(p);
		return pill !== null;
	}, processInfo);
}

async function openTimerDropdown(page: Page) {
	await page.locator("bg-process-pill button").first().click();
	await expect(page.locator("#bg-process-dropdown")).toBeVisible();
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

	test("killed process shows a neutral (muted) indicator dot", async ({ page }) => {
		await createPill(page, KILLED_PROCESS);

		const dot = page.locator("bg-process-pill [data-status='killed']");
		await expect(dot).toBeVisible();
		// Not green/red and not pulsing — it's a known kill, not a normal exit.
		const classes = (await dot.getAttribute("class")) || "";
		expect(classes).not.toContain("animate-pulse");
		expect(classes).not.toContain("bg-green-600");
	});

	test("unrecoverable process shows an amber '?' indicator with a restart title", async ({ page }) => {
		await createPill(page, UNRECOVERABLE_PROCESS);

		const indicator = page.locator("bg-process-pill [data-status='unrecoverable']");
		await expect(indicator).toBeVisible();
		await expect(indicator).toHaveClass(/text-amber-600/);
		await expect(indicator).toHaveText("?");
		await expect(indicator).toHaveAttribute("title", /lost across a restart/i);
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

	test("dropdown shows Remove button (not Kill) for unrecoverable process", async ({ page }) => {
		await createPill(page, UNRECOVERABLE_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const removeBtn = page.locator("#bg-process-dropdown [data-dismiss-btn]");
		await expect(removeBtn).toBeVisible();
		await expect(removeBtn).toHaveText("Remove");
		expect(await page.locator("#bg-process-dropdown [data-kill-btn]").count()).toBe(0);
	});

	test("unrecoverable pill action button shows an X icon (dismiss, not kill)", async ({ page }) => {
		await createPill(page, UNRECOVERABLE_PROCESS);
		await expect(page.locator("bg-process-pill [data-x-btn]")).toHaveText("✕");
		expect(await page.locator("bg-process-pill [data-x-btn] svg").count()).toBe(0);
	});

	test("pill X button dismisses an unrecoverable process", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__dismissCalls = [];
			pill.onDismiss = (id) => (window as any).__dismissCalls.push(id);
		}, UNRECOVERABLE_PROCESS);

		await page.locator("bg-process-pill [data-x-btn]").click();

		const dismissCalls = await page.evaluate(() => (window as any).__dismissCalls);
		expect(dismissCalls).toEqual([UNRECOVERABLE_PROCESS.id]);
	});

	test("Kill button fires onKill callback after confirmation", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__killCalls = [];
			pill.onKill = (id) => (window as any).__killCalls.push(id);
		}, RUNNING_PROCESS);

		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await page.locator("#bg-process-dropdown [data-kill-btn]").click();

		// Confirmation modal appears; onKill must not fire until confirmed.
		await expect(page.locator("[data-kill-confirm]")).toBeVisible();
		expect(await page.evaluate(() => (window as any).__killCalls)).toEqual([]);

		await page.locator("[data-kill-confirm-yes]").click();
		const killCalls = await page.evaluate(() => (window as any).__killCalls);
		expect(killCalls).toEqual([RUNNING_PROCESS.id]);
	});

	test("cancelling the confirmation does not kill", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__killCalls = [];
			pill.onKill = (id) => (window as any).__killCalls.push(id);
		}, RUNNING_PROCESS);

		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await page.locator("#bg-process-dropdown [data-kill-btn]").click();
		await page.locator("[data-kill-confirm-no]").click();

		await expect(page.locator("[data-kill-confirm]")).toHaveCount(0);
		expect(await page.evaluate(() => (window as any).__killCalls)).toEqual([]);
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

	test("running pill action button shows a skull icon", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await expect(page.locator("bg-process-pill [data-x-btn] svg.lucide-skull")).toBeVisible();
	});

	test("exited pill action button shows an X icon", async ({ page }) => {
		await createPill(page, EXITED_OK_PROCESS);
		await expect(page.locator("bg-process-pill [data-x-btn]")).toHaveText("✕");
		expect(await page.locator("bg-process-pill [data-x-btn] svg").count()).toBe(0);
	});

	test("pill skull button kills running process after confirmation", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			(window as any).__killCalls = [];
			pill.onKill = (id) => (window as any).__killCalls.push(id);
		}, RUNNING_PROCESS);

		await page.locator("bg-process-pill [data-x-btn]").click();
		await expect(page.locator("[data-kill-confirm]")).toBeVisible();
		expect(await page.evaluate(() => (window as any).__killCalls)).toEqual([]);

		await page.locator("[data-kill-confirm-yes]").click();
		const killCalls = await page.evaluate(() => (window as any).__killCalls);
		expect(killCalls).toEqual([RUNNING_PROCESS.id]);
	});

	test("confirmation modal renders above the expanded popover", async ({ page }) => {
		await page.evaluate((p) => {
			const pill = (window as any).createPill(p);
			pill.onKill = () => {};
		}, RUNNING_PROCESS);

		// Expand the popover (z-50 portal), then trigger kill from inside it.
		await page.locator("bg-process-pill [data-toggle-btn]").click();
		await expect(page.locator("#bg-process-dropdown")).toBeVisible();
		await page.locator("#bg-process-dropdown [data-kill-btn]").click();

		const modal = page.locator("[data-kill-confirm]");
		await expect(modal).toBeVisible();

		// The modal's effective stacking must sit above the popover portal.
		const modalZ = await modal.evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
		const dropdownZ = await page
			.locator("#bg-process-dropdown")
			.evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
		expect(modalZ).toBeGreaterThan(dropdownZ);
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

	test("killed process shows 'killed' label (no fabricated exit code) in dropdown", async ({ page }) => {
		await createPill(page, KILLED_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const label = page.locator("#bg-process-dropdown [data-exit-code]");
		await expect(label).toBeVisible();
		await expect(label).toHaveText("killed");
		// Never an "exit N" code for a killed process.
		expect(await label.textContent()).not.toMatch(/exit\s+\d/);
	});

	test("unrecoverable process shows 'exit status unknown' in amber in dropdown", async ({ page }) => {
		await createPill(page, UNRECOVERABLE_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const label = page.locator("#bg-process-dropdown [data-exit-code]");
		await expect(label).toBeVisible();
		await expect(label).toHaveText("exit status unknown");
		await expect(label).toHaveClass(/text-amber-600/);
		await expect(label).toHaveAttribute("title", /lost across a restart/i);
		// No fabricated numeric exit code.
		expect(await label.textContent()).not.toMatch(/exit\s+\d/);
	});

	test("dropdown header shows process id and pid", async ({ page }) => {
		await createPill(page, RUNNING_PROCESS);
		await page.locator("bg-process-pill [data-toggle-btn]").click();

		const dropdown = page.locator("#bg-process-dropdown");
		await expect(dropdown).toContainText("bg-run-1");
		await expect(dropdown).toContainText("pid 12345");
	});
});

test.describe("BG timer regression", () => {
	test.beforeEach(async ({ page }) => {
		await gotoTimerFixture(page);
	});

	test.afterEach(async ({ page }) => {
		await page.evaluate(() => (window as any).clearPills());
	});

	test("exited process uses endTime runtime and stays fixed after re-render and reload", async ({ page }) => {
		const startTime = Date.now() - 24 * 60 * 60 * 1000;
		const processInfo = {
			id: "bg-fixed-runtime",
			name: "finished build",
			command: "npm run build",
			pid: 22222,
			status: "exited" as const,
			exitCode: 0,
			startTime,
			endTime: startTime + 120_000,
		};

		await createTimerPill(page, processInfo);
		await openTimerDropdown(page);

		const dropdown = page.locator("#bg-process-dropdown");
		await expect(dropdown).toContainText(/\b2m 00s\b/);
		const before = await dropdown.innerText();

		await page.waitForTimeout(1100);
		await page.evaluate(() => (window as any).forceBgTimerRerender());
		await expect(dropdown).toContainText(/\b2m 00s\b/);
		expect(await dropdown.innerText()).toBe(before);

		await page.reload();
		await page.addScriptTag({ path: TIMER_BUNDLE });
		await readyTimerFixture(page);
		await createTimerPill(page, processInfo);
		await openTimerDropdown(page);
		await expect(page.locator("#bg-process-dropdown")).toContainText(/\b2m 00s\b/);
	});

	test("legacy exited process without endTime does not show time since start", async ({ page }) => {
		const processInfo = {
			id: "bg-legacy-runtime",
			name: "legacy build",
			command: "npm run build",
			pid: 22223,
			status: "exited" as const,
			exitCode: 0,
			startTime: Date.now() - 24 * 60 * 60 * 1000,
		};

		await createTimerPill(page, processInfo);
		await openTimerDropdown(page);

		const text = await page.locator("#bg-process-dropdown").innerText();
		expect(text).not.toMatch(/\b(?:\d{3,}m\s+\d{2}s|\d+h\b|\d+d\b)/i);
	});

	test("running process timer increments while running", async ({ page }) => {
		const processInfo = {
			id: "bg-running-runtime",
			name: "dev server",
			command: "npm run dev",
			pid: 22224,
			status: "running" as const,
			exitCode: null,
			startTime: Date.now() - 1000,
			endTime: null,
		};

		await createTimerPill(page, processInfo);
		await openTimerDropdown(page);

		const timer = page.locator("#bg-process-dropdown live-timer");
		const initial = ((await timer.textContent()) || "").trim();
		await expect.poll(async () => ((await timer.textContent()) || "").trim(), { timeout: 2500 }).not.toBe(initial);
	});
});
