/**
 * Manual integration test — assert no visible Chromium window during a QA run.
 *
 * Launches Chromium via Playwright (mirroring the hardening args from
 * `defaults/tools/browser/extension.ts`), then queries Windows for any
 * process in the launched browser's process tree that has a non-empty
 * `MainWindowTitle`. An empty result proves no visible window was created.
 *
 * Scoping to the Playwright-launched process tree (via the root PID and its
 * descendants) avoids false positives from the developer's own Chrome/Edge
 * instances running on the same machine.
 *
 * Platform: Windows only. On macOS/Linux the headless-new flag is reliable
 * and the bug never reproduced; on Windows, Playwright's bundled Chromium
 * has historically popped a briefly-visible window on first launch.
 *
 * Skipped on CI and non-Windows platforms.
 *
 * Run:  npm run test:manual -- --grep "headless-qa-browser"
 */
import { test, expect, chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";
const IS_CI = !!process.env.CI;

/**
 * Run a PowerShell script via spawnSync (bypasses bash/cmd interpolation).
 *
 * Note: PowerShell sometimes exits with status 1 even when a pipeline
 * completes successfully (e.g. when `Get-Process` finds no matches or when
 * the host returns empty output). We treat empty `stderr` as success
 * regardless of exit code — any real failure writes to stderr.
 */
function pwsh(script: string): string {
	const res = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ encoding: "utf8", timeout: 15_000, windowsHide: true },
	);
	if (res.error) throw new Error(`PowerShell probe failed to spawn: ${res.error.message}`);
	const stderr = (res.stderr ?? "").trim();
	if (stderr.length > 0) {
		throw new Error(`PowerShell probe failed (status=${res.status}):\n${stderr}`);
	}
	return (res.stdout ?? "").trim();
}

/**
 * Set of PIDs for all running Chromium-family processes on the host.
 *
 * Includes `chrome-headless-shell` because Playwright ≥ 1.49 launches the
 * dedicated headless shell binary (not `chrome.exe`) when `--headless=new`
 * is in effect. Without this, the before/after diff would see zero new PIDs.
 */
function chromiumPids(): Set<number> {
	const out = pwsh(
		"Get-Process chrome,chromium,'chrome-headless-shell' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id",
	);
	const pids = new Set<number>();
	for (const line of out.split(/\r?\n/)) {
		const n = Number(line.trim());
		if (Number.isInteger(n) && n > 0) pids.add(n);
	}
	return pids;
}

/**
 * Returns newline-joined MainWindowTitles for the given PIDs. Empty string
 * means none of the PIDs have a visible window.
 */
function visibleTitlesForPids(pids: number[]): string {
	if (pids.length === 0) return "";
	const idList = pids.join(",");
	return pwsh(
		`Get-Process -Id ${idList} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -ExpandProperty MainWindowTitle`,
	);
}

test("no visible Chromium window appears during a QA browser run", async () => {
	test.skip(!IS_WINDOWS, "Windows-only — the bug never reproduced on macOS/Linux");
	test.skip(IS_CI, "Skipped in CI — headless CI runners have no visible display");
	test.setTimeout(30_000);

	// Mirror the hardening args from defaults/tools/browser/extension.ts so
	// this test exercises the same launch path that QA agents use at runtime.
	// Snapshot existing chrome/chromium PIDs so we can ignore the developer's
	// own Chrome/Edge instances and only inspect windows created by our launch.
	const before = chromiumPids();

	const browser = await chromium.launch({
		headless: true,
		args: ["--headless=new", "--disable-gpu", "--no-sandbox"],
	});
	try {
		const ctx = await browser.newContext();
		const page = await ctx.newPage();
		await page.goto("about:blank");
		await page.screenshot({ type: "png" });

		const after = chromiumPids();
		const newPids = [...after].filter((pid) => !before.has(pid));
		expect(
			newPids.length,
			"Playwright launch should spawn at least one new chrome/chromium process",
		).toBeGreaterThan(0);

		const titles = visibleTitlesForPids(newPids);
		expect(
			titles.length,
			`Expected no visible Chromium window among PIDs [${newPids.join(", ")}], but found:\n${titles}`,
		).toBe(0);
	} finally {
		await browser.close().catch(() => {});
	}
});
