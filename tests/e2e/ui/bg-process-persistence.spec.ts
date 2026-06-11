/**
 * Browser E2E — persistent `bash_bg` processes survive a gateway restart,
 * re-attach to still-running processes, and capture the real exit code.
 *
 * Design: docs/design/persistent-bg-processes.md §13 (Browser E2E). This is the
 * required end-to-end coverage for the acceptance criteria:
 *
 *   1. A bg process RUNNING at restart keeps streaming new output afterward
 *      (the re-attached tailer resumes), and its eventual REAL exit code is
 *      captured and shown in the pill.
 *   2. Dismissing a finished pill removes it AND deletes its persisted files,
 *      so it stays gone across a page reload and a subsequent restart.
 *   3. Killing a running process leaves an EXITED pill that survives a restart
 *      until the user explicitly dismisses it.
 *
 * Mechanics:
 *  - The worker-scoped `gateway` fixture (tests/e2e/gateway-harness.ts) runs the
 *    real in-process gateway with the real BgProcessManager (no SpawnFn mock),
 *    so `bash_bg` processes are real OS processes whose output + status live in
 *    durable per-process files under the isolated state dir. `gateway.crash()` +
 *    `gateway.restart()` re-boot the gateway on the SAME port and bobbitDir,
 *    which re-runs the boot restore path (restoreSessions → bgProcessManager
 *    .restoreSession) exactly as a real reboot does.
 *  - Processes are created via the same REST endpoint the production `bash_bg`
 *    extension uses (`POST /api/sessions/:id/bg-processes`); the WS
 *    `bg_process_*` events drive the pill strip in the active session.
 *  - Streaming is proven by polling the authoritative server log
 *    (`GET .../bg-processes/:pid/logs`) for the latest emitted line number and
 *    asserting it keeps advancing AFTER the restart — i.e. the re-attach is live.
 *
 * The host wrapper is POSIX (Git Bash on Windows / /bin/sh elsewhere), matching
 * the existing real-bg-process tests (BG_WAIT uses `sleep`).
 */
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// A finite POSIX loop that prints `<prefix>-N` every 250ms then exits 0. Long
// enough (≈12.5s) that it is still running when we crash+restart early, so we
// can observe streaming RESUME after the gateway comes back, then watch it
// finish with a real exit code.
function streamingCommand(prefix: string, count: number): string {
	return `i=1; while [ "$i" -le ${count} ]; do echo "${prefix}-$i"; i=$((i+1)); sleep 0.25; done; exit 0`;
}

// A long POSIX loop (≈60s) used for the kill flow — only needs to outlive the
// moment we kill it; the kill terminates it well before it completes.
function longRunnerCommand(prefix: string): string {
	return `i=1; while [ "$i" -le 300 ]; do echo "${prefix}-$i"; i=$((i+1)); sleep 0.2; done; exit 0`;
}

async function activeSessionId(page: Page): Promise<string> {
	return await page.evaluate(() => {
		const m = (window.location.hash || "").match(/#\/session\/([a-f0-9-]+)/i);
		return m ? m[1] : "";
	});
}

interface BgRecord { id: string; status: string; exitCode: number | null; terminalReason?: string | null }

async function listBgProcesses(sessionId: string): Promise<BgRecord[] | null> {
	const res = await apiFetch(`/api/sessions/${sessionId}/bg-processes`);
	if (!res.ok) return null;
	const data = await res.json();
	return (data.processes || []) as BgRecord[];
}

async function findBg(sessionId: string, bgId: string): Promise<BgRecord | null> {
	const list = await listBgProcesses(sessionId);
	if (!list) return null;
	return list.find((p) => p.id === bgId) ?? null;
}

/**
 * Highest `<prefix>-N` line number captured server-side so far, or -1 if the
 * logs aren't readable yet (e.g. mid-restart). Used as the streaming probe —
 * an increasing value means new output is being captured.
 */
async function latestLine(sessionId: string, bgId: string, prefix: string): Promise<number> {
	try {
		const res = await apiFetch(`/api/sessions/${sessionId}/bg-processes/${bgId}/logs?tail=200`);
		if (!res.ok) return -1;
		const data = await res.json();
		const re = new RegExp(`${prefix}-(\\d+)`);
		let max = -1;
		for (const entry of (data.log || [])) {
			const text = typeof entry === "string" ? entry : (entry?.text ?? "");
			const m = re.exec(text);
			if (m) max = Math.max(max, Number(m[1]));
		}
		return max;
	} catch {
		return -1;
	}
}

async function createBgProcess(sessionId: string, command: string, name: string): Promise<string> {
	const res = await apiFetch(`/api/sessions/${sessionId}/bg-processes`, {
		method: "POST",
		body: JSON.stringify({ command, name }),
	});
	expect(res.status, "bg-process create should return 201").toBe(201);
	const body = await res.json();
	expect(body.id, "bg-process create returns an id").toBeTruthy();
	return body.id as string;
}

/**
 * Crash + re-boot the gateway on the same port/bobbitDir and wait for the
 * client to reconnect — mirrors tests/e2e/ui/spec-framework.ts
 * `event.server_crash()` + `event.server_restart()`.
 */
async function crashAndRestart(gateway: GatewayInfo, page: Page): Promise<void> {
	await gateway.crash();
	if (!page.isClosed()) {
		await page.waitForFunction(() => {
			const s = (window as any).bobbitState;
			return !!s && s.connectionStatus !== "connected";
		}, undefined, { timeout: 5_000 }).catch(() => { /* best-effort */ });
	}
	await gateway.restart();
	// Strict half: the server is bound and serving again.
	await expect.poll(async () => {
		try { return (await apiFetch("/api/health")).ok; } catch { return false; }
	}, { timeout: 20_000, intervals: [250] }).toBe(true);
	// Best-effort: the active session's WebSocket reconnects.
	if (!page.isClosed()) {
		await page.waitForFunction(() => {
			const s = (window as any).bobbitState;
			return !!s && s.connectionStatus === "connected";
		}, undefined, { timeout: 15_000, polling: 250 }).catch(() => { /* best-effort */ });
	}
}

function pill(page: Page, bgId: string) {
	return page.locator(`bg-process-pill[data-id="${bgId}"]`);
}

async function openPillDropdown(page: Page, bgId: string) {
	await pill(page, bgId).locator("button").first().click();
	const dropdown = page.locator("#bg-process-dropdown");
	await expect(dropdown).toBeVisible({ timeout: 10_000 });
	return dropdown;
}

// The pill's trailing inline button: skull (kill) while running, ✕ (dismiss)
// once terminal. Driving these directly avoids the popover portal, keeping the
// kill/dismiss flows robust across a restart's reconnect re-render.
function pillActionButton(page: Page, bgId: string) {
	return pill(page, bgId).locator("button").nth(1);
}

test.describe("persistent bash_bg processes — restart re-attach, exit code, dismiss", () => {
	test("streams across a restart, shows the real exit code, and dismiss stays gone", async ({ page, gateway }) => {
		test.setTimeout(120_000);

		await openApp(page);
		await createSessionViaUI(page);
		const sessionId = await activeSessionId(page);
		expect(sessionId, "active session id resolved from hash").toBeTruthy();

		// Create a long-ish streaming process (≈12.5s) via the production REST path.
		const bgId = await createBgProcess(sessionId, streamingCommand("tick", 50), "stream-task");

		// Pill appears for the active session.
		await expect(pill(page, bgId)).toBeVisible({ timeout: 15_000 });

		// Pill is STREAMING before the restart (log grows past the first lines).
		await expect
			.poll(() => latestLine(sessionId, bgId, "tick"), { timeout: 15_000, intervals: [200] })
			.toBeGreaterThanOrEqual(2);

		// ── Crash + restart the gateway WHILE the process is still running. ──
		await crashAndRestart(gateway, page);

		// Pill is RESTORED after the restart (re-fetched on reconnect).
		await expect(pill(page, bgId)).toBeVisible({ timeout: 20_000 });

		// Still RUNNING (re-attached, not terminal) right after the reboot.
		await expect
			.poll(async () => (await findBg(sessionId, bgId))?.status ?? null, { timeout: 15_000, intervals: [200] })
			.toBe("running");

		// STILL STREAMING: capture the line count now, then assert NEW lines keep
		// arriving — proving the re-attached tailer resumed live streaming, not
		// merely that the orphan advanced during downtime.
		const afterReboot = await latestLine(sessionId, bgId, "tick");
		expect(afterReboot, "some output captured after reboot").toBeGreaterThanOrEqual(0);
		await expect
			.poll(() => latestLine(sessionId, bgId, "tick"), { timeout: 20_000, intervals: [250] })
			.toBeGreaterThan(afterReboot);

		// Let it finish — the REAL exit code (0) is captured from the status file.
		await expect
			.poll(async () => {
				const p = await findBg(sessionId, bgId);
				return p ? { status: p.status, exitCode: p.exitCode } : null;
			}, { timeout: 30_000, intervals: [300] })
			.toEqual({ status: "exited", exitCode: 0 });

		// The pill UI reflects the real exit code.
		const dropdown = await openPillDropdown(page, bgId);
		await expect(dropdown).toContainText(/exit\s*0/i, { timeout: 10_000 });

		// ── Dismiss removes the pill AND purges the persisted files. ──
		await dropdown.getByRole("button", { name: "Remove" }).click();
		await expect(pill(page, bgId)).toHaveCount(0, { timeout: 10_000 });
		await expect
			.poll(async () => (await listBgProcesses(sessionId))?.some((p) => p.id === bgId) ?? null,
				{ timeout: 10_000, intervals: [200] })
			.toBe(false);

		// Stays gone after a page reload (state re-fetched from the server).
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(pill(page, bgId)).toHaveCount(0, { timeout: 10_000 });

		// Stays gone after another restart — the persisted record was purged, so
		// restore finds nothing to rehydrate.
		await crashAndRestart(gateway, page);
		await expect
			.poll(async () => (await listBgProcesses(sessionId))?.some((p) => p.id === bgId) ?? null,
				{ timeout: 15_000, intervals: [250] })
			.toBe(false);
		await expect(pill(page, bgId)).toHaveCount(0, { timeout: 10_000 });
	});

	test("a killed process leaves an exited pill that survives a restart until dismissed", async ({ page, gateway }) => {
		test.setTimeout(120_000);

		await openApp(page);
		await createSessionViaUI(page);
		const sessionId = await activeSessionId(page);
		expect(sessionId, "active session id resolved from hash").toBeTruthy();

		// A long runner we will kill mid-flight.
		const bgId = await createBgProcess(sessionId, longRunnerCommand("ktick"), "kill-task");

		await expect(pill(page, bgId)).toBeVisible({ timeout: 15_000 });
		await expect
			.poll(async () => (await findBg(sessionId, bgId))?.status ?? null, { timeout: 15_000, intervals: [200] })
			.toBe("running");
		// Confirm it is actually streaming before we kill it.
		await expect
			.poll(() => latestLine(sessionId, bgId, "ktick"), { timeout: 15_000, intervals: [200] })
			.toBeGreaterThanOrEqual(1);

		// ── Kill via the pill UI: inline skull button → confirm dialog. ──
		await pillActionButton(page, bgId).click();
		await expect(page.getByText("This stops the running background process.")).toBeVisible({ timeout: 10_000 });
		// The destructive confirm button is labelled exactly "Kill" (the pill's own
		// skull button is "Kill process", so exact-name avoids ambiguity).
		await page.getByRole("button", { name: "Kill", exact: true }).click();

		// Becomes an EXITED (terminal) pill — no longer running.
		await expect
			.poll(async () => (await findBg(sessionId, bgId))?.status ?? null, { timeout: 15_000, intervals: [250] })
			.toBe("exited");
		await expect(pill(page, bgId)).toBeVisible();

		// ── Restart — the exited (killed) pill SURVIVES. ──
		await crashAndRestart(gateway, page);
		await expect(pill(page, bgId)).toBeVisible({ timeout: 20_000 });
		await expect
			.poll(async () => (await findBg(sessionId, bgId))?.status ?? null, { timeout: 15_000, intervals: [250] })
			.toBe("exited");

		// ── Dismiss it — now it's gone for good (inline ✕ on the terminal pill). ──
		await pillActionButton(page, bgId).click();
		await expect(pill(page, bgId)).toHaveCount(0, { timeout: 10_000 });
		await expect
			.poll(async () => (await listBgProcesses(sessionId))?.some((p) => p.id === bgId) ?? null,
				{ timeout: 15_000, intervals: [250] })
			.toBe(false);

		// Stays gone after a reload.
		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(pill(page, bgId)).toHaveCount(0, { timeout: 10_000 });
	});
});
