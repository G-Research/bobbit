import { test, expect } from "../gateway-harness.js";
import { apiFetch, deleteSession, waitForHealth } from "../e2e-setup.js";
import { createSessionViaUI, openApp } from "./ui-helpers.js";

// Browser E2E for the first-party terminal pack. The WebSocket send spy is a
// test-only observer: it does not feed data back into the app or expose transport
// to pack code, and it lets the spec prove resize travels through host.channels.
test.describe.configure({ mode: "serial" });

const tid = (id: string) => `[data-testid="${id}"]`;
const terminalPanel = () => `${tid("terminal-panel")}`;
const terminalHost = () => `${tid("terminal-xterm")}`;

test.describe("terminal pack panel", () => {
	let sessionId: string | undefined;

	test.afterEach(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		sessionId = undefined;
	});

	test("opens from session menu, runs commands, resizes, hides live without killing, reload-reattaches, kills, restarts, exits, and cleans up @smoke", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1400, height: 900 });
		await installChannelFrameSpy(page);

		const contributions = await listContributions();
		const terminal = contributions.find((p) => p.packId === "terminal");
		expect(terminal?.panels?.some((p) => p.id === "terminal.panel")).toBe(true);
		expect(terminal?.entrypoints?.some((e) => e.kind === "session-menu" && e.label === "Open Terminal")).toBe(true);

		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());

		await openTerminalFromSessionMenu(page);
		await expect(page.locator(terminalPanel())).toBeVisible({ timeout: 20_000 });
		await waitForTerminalReadyForInput(page);
		await assertTerminalLayoutStable(page, "initial terminal open");
		await expect.poll(() => channelSendCount(page, "ext_channel_open"), { timeout: 20_000 }).toBeGreaterThan(0);

		const marker1 = `bobbit_terminal_e2e_${Date.now()}`;
		await typeCommand(page, `echo ${marker1}`);
		await expect(page.locator(terminalHost())).toContainText(marker1, { timeout: 20_000 });
		await assertTerminalLayoutStable(page, "after first marker output");

		const resizeBefore = await resizeFrameCount(page);
		await page.setViewportSize({ width: 1200, height: 700 });
		await assertTerminalLayoutStable(page, "after shrinking viewport");
		await page.setViewportSize({ width: 1500, height: 950 });
		await assertTerminalLayoutStable(page, "after expanding viewport");
		await expect.poll(() => resizeFrameCount(page), { timeout: 15_000 }).toBeGreaterThan(resizeBefore);

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel()), "terminal panel should be restored after reload").toBeVisible({ timeout: 20_000 });
		await waitForTerminalReadyForInput(page);
		await expect.poll(() => channelSendCount(page, "ext_channel_attach"), { timeout: 20_000 }).toBeGreaterThan(0);
		await assertTerminalHistoryAndLayout(page, [marker1], "browser reload reattach should replay prior marker before follow-up input");

		const marker2 = `${marker1}_reattach`;
		await typeCommand(page, `echo ${marker2}`);
		await expect(page.locator(terminalHost())).toContainText(marker2, { timeout: 20_000 });

		const killBeforeHide = await killFrameCount(page);
		await page.locator(terminalPanel()).getByRole("button", { name: "Hide terminal panel without killing the process" }).click();
		await expect(page.locator(terminalPanel())).toHaveCount(0, { timeout: 10_000 });
		await openTerminalFromSessionMenu(page);
		await expect(page.locator(terminalPanel())).toBeVisible({ timeout: 20_000 });
		await waitForTerminalReadyForInput(page);
		await expect.poll(() => killFrameCount(page), { timeout: 5_000 }).toBe(killBeforeHide);
		await assertTerminalHistoryAndLayout(page, [marker1, marker2], "reopened live terminal should show existing markers before new input");
		const marker3 = `${marker1}_hidden_live`;
		await typeCommand(page, `echo ${marker3}`);
		await expect(page.locator(terminalHost())).toContainText(marker3, { timeout: 20_000 });
		await assertTerminalLayoutStable(page, "after hidden-panel reattach marker output");

		await typeCommand(page, "exit");
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /exited|disconnected|idle/, { timeout: 20_000 });

		const openBeforeRestart = await channelSendCount(page, "ext_channel_open");
		const startButton = page.locator(terminalPanel()).getByRole("button", { name: "Start or restart terminal" });
		await expect(startButton).toBeEnabled({ timeout: 20_000 });
		await startButton.click();
		await expect.poll(() => channelSendCount(page, "ext_channel_open"), { timeout: 20_000 }).toBeGreaterThan(openBeforeRestart);
		await waitForTerminalReadyForInput(page);

		const killBefore = await killFrameCount(page);
		await page.locator(terminalPanel()).getByRole("button", { name: "Terminate terminal process" }).click();
		await expect.poll(() => killFrameCount(page), { timeout: 10_000 }).toBeGreaterThan(killBefore);
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /killed|idle|disconnected/, { timeout: 20_000 });

		await page.locator(terminalPanel()).getByRole("button", { name: "Hide terminal panel without killing the process" }).click();
		await expect(page.locator(terminalPanel())).toHaveCount(0, { timeout: 10_000 });
	});

	test("keeps the latest prompt visible after large output, resize, and reattach", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1180, height: 560 });
		await installChannelFrameSpy(page);

		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());

		await openTerminalFromSessionMenu(page);
		await expect(page.locator(terminalPanel())).toBeVisible({ timeout: 20_000 });
		await waitForTerminalReadyForInput(page);
		await assertTerminalLayoutStable(page, "scroll regression initial terminal open");

		const run = `bobbit_scroll_${Date.now()}`;
		const burstDone = `${run}_BURST_DONE`;
		const followUp = `${run}_FOLLOWUP_VISIBLE`;
		const burstCommand = [
			...Array.from({ length: 90 }, (_, i) => `echo ${run}_LINE_${String(i).padStart(3, "0")}_abc123xyz`),
			`echo ${burstDone}`,
		].join(" && ");
		await typeCommand(page, burstCommand);
		await expect.poll(
			() => receivedTerminalTextIncludes(page, burstDone),
			{ message: "large-output regression setup: PTY should emit the burst completion marker", timeout: 20_000 },
		).toBe(true);

		await page.setViewportSize({ width: 980, height: 430 });
		await assertTerminalLayoutStable(page, "scroll regression after shrinking viewport");
		await page.setViewportSize({ width: 1280, height: 620 });
		await assertTerminalLayoutStable(page, "scroll regression after expanding viewport");

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel()), "terminal panel should restore for scroll regression reattach").toBeVisible({ timeout: 20_000 });
		await waitForTerminalReadyForInput(page);
		await expect.poll(() => channelSendCount(page, "ext_channel_attach"), { timeout: 20_000 }).toBeGreaterThan(0);
		await assertNoRepeatedTopRowGlyphArtifact(page, "scroll regression after reload reattach");

		await typeCommand(page, `echo ${followUp}`);
		await expect.poll(
			() => receivedTerminalTextIncludes(page, followUp),
			{ message: "scroll regression follow-up command should reach the PTY", timeout: 20_000 },
		).toBe(true);
		await assertLatestTerminalInputVisibleAtBottom(page, followUp, "scroll regression after large output, resize, and reattach");
		await assertNoRepeatedTopRowGlyphArtifact(page, "scroll regression after follow-up input");

		const cursorHome = `${run}_CURSOR_HOME_VISIBLE`;
		const cursorHomeCommand = process.platform === "win32" ? `prompt $E[H${cursorHome}$G` : `printf '\\033[H${cursorHome}'`;
		const beforeCursorHomeLayout = await terminalLayoutSnapshotAfterAnimationFrames(page);
		await typeCommand(page, cursorHomeCommand);
		await expect.poll(
			() => receivedTerminalTextIncludes(page, cursorHome),
			{ message: "cursor-positioning regression setup: PTY should emit the cursor-home marker", timeout: 20_000 },
		).toBe(true);
		await assertTerminalLayoutStable(page, "scroll regression after cursor-positioning output");
		const afterCursorHomeLayout = await terminalLayoutSnapshotAfterAnimationFrames(page);
		expect(
			afterCursorHomeLayout.renderedRows,
			"cursor-positioning output must not shrink xterm rows; rows are owned by FitAddon/host size",
		).toBeGreaterThanOrEqual(Math.max(10, beforeCursorHomeLayout.renderedRows - 1));
		await assertTerminalTextVisibleNearBottom(page, cursorHome, "scroll regression after cursor-positioning output");
	});

	test("renders a clear disconnected state after gateway restart while terminal is live", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1400, height: 900 });
		await installChannelFrameSpy(page);

		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());

		await openTerminalFromSessionMenu(page);
		await expect(page.locator(terminalPanel())).toBeVisible({ timeout: 20_000 });
		await waitForTerminalReadyForInput(page);
		const marker = `bobbit_terminal_restart_${Date.now()}`;
		await typeCommand(page, `echo ${marker}`);
		await expect(page.locator(terminalHost())).toContainText(marker, { timeout: 20_000 });

		await gateway.crash();
		await page.waitForFunction(() => (window as any).bobbitState?.connectionStatus !== "connected", undefined, { timeout: 5_000 }).catch(() => {});
		await gateway.restart();
		await waitForHealth(20_000);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel()), "terminal panel should restore after gateway restart").toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", /disconnected/, { timeout: 30_000 });
		await expect(page.locator(terminalPanel())).toContainText(/disconnected|closed|Restart/i, { timeout: 10_000 });
		await expect.poll(() => channelSendCount(page, "ext_channel_open"), { timeout: 5_000 }).toBe(0);
	});
});

async function listContributions(): Promise<Array<{ packId: string; panels: Array<{ id: string }>; entrypoints: Array<{ kind: string; label?: string }>; channelNames?: string[] }>> {
	const res = await apiFetch("/api/ext/contributions");
	expect(res.ok).toBe(true);
	return (await res.json()).packs;
}

async function installChannelFrameSpy(page: import("@playwright/test").Page): Promise<void> {
	await page.addInitScript(() => {
		const win = window as any;
		win.__terminalE2E = { sent: [] as any[], received: [] as any[] };
		const OriginalWebSocket = window.WebSocket;
		window.WebSocket = class BobbitTerminalSpyWebSocket extends OriginalWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols as any);
				this.addEventListener("message", (event: MessageEvent) => {
					if (typeof event.data !== "string") return;
					try {
						const msg = JSON.parse(event.data);
						if (msg?.type && String(msg.type).startsWith("ext_channel")) {
							win.__terminalE2E.received.push(msg);
						}
					} catch {
						// Non-JSON websocket payload; ignore.
					}
				});
			}

			send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
				if (typeof data === "string") {
					try {
						const msg = JSON.parse(data);
						if (msg?.type && String(msg.type).startsWith("ext_channel")) {
							win.__terminalE2E.sent.push(msg);
						}
					} catch {
						// Non-JSON websocket payload; ignore.
					}
				}
				return super.send(data as any);
			}
		} as typeof WebSocket;
	});
}

async function openTerminalFromSessionMenu(page: import("@playwright/test").Page): Promise<void> {
	const trigger = page.locator(tid("session-actions-trigger")).first();
	await expect(trigger, "chat header session-actions menu must be available").toBeVisible({ timeout: 10_000 });
	await trigger.click();
	await expect(page.locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
	const launcher = page.locator('sidebar-actions-popover [role="menuitem"]', { hasText: "Open Terminal" }).first();
	await expect(launcher, "the terminal launcher must render in the session menu").toBeVisible({ timeout: 10_000 });
	await launcher.click();
	await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });
}

async function waitForTerminalReadyForInput(page: import("@playwright/test").Page): Promise<void> {
	await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", "attached", { timeout: 20_000 });
	await expect(page.locator(`${terminalHost()} .xterm-helper-textarea`), "xterm input textarea must be mounted before typing").toHaveCount(1, { timeout: 10_000 });
	await focusTerminal(page);
}

async function focusTerminal(page: import("@playwright/test").Page): Promise<void> {
	const xterm = page.locator(`${terminalHost()} .xterm`).first();
	await expect(xterm, "xterm must be visible and focusable before typing").toBeVisible({ timeout: 10_000 });
	await xterm.click({ position: { x: 24, y: 24 } });
	await page.locator(`${terminalHost()} .xterm-helper-textarea`).focus();
	await page.evaluate(() => {
		(document.querySelector('[data-testid="terminal-xterm"] .xterm-helper-textarea') as HTMLTextAreaElement | null)?.focus();
	});
	await expect.poll(
		() => page.evaluate(() => {
			const active = document.activeElement as HTMLElement | null;
			return active?.classList.contains("xterm-helper-textarea") === true
				|| (active?.closest?.('[data-testid="terminal-xterm"] .xterm') ?? null) !== null;
		}),
		{ timeout: 10_000 },
	).toBe(true);
}

async function typeCommand(page: import("@playwright/test").Page, command: string): Promise<void> {
	await waitForTerminalReadyForInput(page);
	const textFramesBefore = await textFrameCount(page);
	await page.keyboard.insertText(command);
	await page.keyboard.press("Enter");
	await expect.poll(() => textFrameCount(page), { timeout: 5_000 }).toBeGreaterThan(textFramesBefore);
}

async function assertTerminalHistoryAndLayout(page: import("@playwright/test").Page, markers: string[], reason: string): Promise<void> {
	await assertTerminalLayoutStable(page, reason);
	for (const marker of markers) {
		await expect(page.locator(terminalHost()), `${reason}: marker ${marker} must be visible before typing`).toContainText(marker, { timeout: 10_000 });
	}
	await assertNoRepeatedTopRowGlyphArtifact(page, reason);
}

async function assertTerminalLayoutStable(page: import("@playwright/test").Page, reason: string): Promise<void> {
	await expect.poll(async () => {
		const before = await terminalLayoutSnapshot(page);
		const after = await terminalLayoutSnapshotAfterAnimationFrames(page);
		return before.visible
			&& before.hostWidth > 200
			&& before.hostHeight > 120
			&& before.xtermWidth > 200
			&& before.xtermHeight > 100
			&& before.screenWidth > 0
			&& before.screenHeight > 0
			&& before.renderedRows > 0
			&& Math.abs(before.xtermWidth - after.xtermWidth) <= 2
			&& Math.abs(before.xtermHeight - after.xtermHeight) <= 2
			&& Math.abs(before.screenWidth - after.screenWidth) <= 2
			&& Math.abs(before.screenHeight - after.screenHeight) <= 2;
	}, { message: `${reason}: terminal should have positive, stable xterm dimensions`, timeout: 10_000 }).toBe(true);
	await assertNoRepeatedTopRowGlyphArtifact(page, reason);
}

async function assertNoRepeatedTopRowGlyphArtifact(page: import("@playwright/test").Page, reason: string): Promise<void> {
	const artifact = await page.evaluate(() => {
		const rows = Array.from(document.querySelectorAll('[data-testid="terminal-xterm"] .xterm-rows > div'))
			.slice(0, 3)
			.map((row) => row.textContent ?? "");
		for (const row of rows) {
			const text = row.trim();
			if (text.length < 24) continue;
			const counts = new Map<string, number>();
			for (const ch of text.replace(/\s/g, "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
			const max = Math.max(0, ...counts.values());
			if (max >= 24 && max / Math.max(1, text.replace(/\s/g, "").length) >= 0.8) return text;
			const repeatedRun = text.match(/([^\s])\1{23,}/)?.[0];
			if (repeatedRun) return repeatedRun;
		}
		return "";
	});
	expect(artifact, `${reason}: xterm top rows should not contain a repeated glyph layout artifact`).toBe("");
}

async function assertLatestTerminalInputVisibleAtBottom(page: import("@playwright/test").Page, expected: string, reason: string): Promise<void> {
	const expectedTail = expected.slice(-32);
	let lastSnapshot: Awaited<ReturnType<typeof terminalViewportContent>> | undefined;
	try {
		await expect.poll(async () => {
			lastSnapshot = await terminalViewportContent(page);
			return latestTerminalInputVisibleAtBottom(lastSnapshot, expected, expectedTail);
		}, {
			message: `${reason}: latest prompt/input should settle in the near-bottom xterm rows after PTY echo and prompt pinning`,
			timeout: 10_000,
		}).toBe(true);
		return;
	} catch {
		const snapshot = lastSnapshot ?? await terminalViewportContent(page);
		const bottomRows = nearBottomRows(snapshot.rows);
		const bottomText = bottomRows.join("\n");
		const bottomSoftWrappedText = bottomRows.join("");
		expect(
			snapshot.atBottom,
			`${reason}: terminal scroll regression - xterm viewport should be pinned to the bottom for the active prompt/input. scrollTop=${snapshot.scrollTop}, maxScrollTop=${snapshot.maxScrollTop}`,
		).toBe(true);
		expect(
			bottomSoftWrappedText.includes(expected) || bottomSoftWrappedText.includes(expectedTail),
			`${reason}: terminal scroll regression - expected latest prompt/input "${expected}" or its unique tail "${expectedTail}" in the near-bottom xterm rows, allowing xterm soft wrapping and trailing blank rows. Bottom rows:\n${bottomText}\n\nVisible rows:\n${snapshot.rows.join("\n")}`,
		).toBe(true);
	}
}

function latestTerminalInputVisibleAtBottom(snapshot: Awaited<ReturnType<typeof terminalViewportContent>>, expected: string, expectedTail: string): boolean {
	const bottomSoftWrappedText = nearBottomRows(snapshot.rows).join("");
	return snapshot.atBottom && (bottomSoftWrappedText.includes(expected) || bottomSoftWrappedText.includes(expectedTail));
}

async function assertTerminalTextVisibleNearBottom(page: import("@playwright/test").Page, expected: string, reason: string): Promise<void> {
	const snapshot = await terminalViewportContent(page);
	const bottomRows = nearBottomRows(snapshot.rows);
	const bottomText = bottomRows.join("\n");
	expect(
		bottomRows.join(""),
		`${reason}: expected "${expected}" in the near-bottom xterm rows after viewport-only prompt pinning, allowing xterm soft wrapping and trailing blank rows. Bottom rows:\n${bottomText}\n\nVisible rows:\n${snapshot.rows.join("\n")}`,
	).toContain(expected);
}

function nearBottomRows(rows: string[]): string[] {
	const withoutTrailingBlankRows = [...rows];
	while (withoutTrailingBlankRows.length > 0 && withoutTrailingBlankRows[withoutTrailingBlankRows.length - 1]?.trim() === "") {
		withoutTrailingBlankRows.pop();
	}
	return withoutTrailingBlankRows.slice(-8);
}

async function terminalViewportContent(page: import("@playwright/test").Page): Promise<{ rows: string[]; atBottom: boolean; scrollTop: number; maxScrollTop: number }> {
	return page.evaluate(() => {
		const viewport = document.querySelector('[data-testid="terminal-xterm"] .xterm-viewport') as HTMLElement | null;
		const rows = Array.from(document.querySelectorAll('[data-testid="terminal-xterm"] .xterm-rows > div'))
			.map((row) => (row.textContent ?? "").trimEnd());
		const scrollTop = viewport?.scrollTop ?? 0;
		const maxScrollTop = viewport ? Math.max(0, viewport.scrollHeight - viewport.clientHeight) : 0;
		return { rows, atBottom: Math.abs(maxScrollTop - scrollTop) <= 2, scrollTop, maxScrollTop };
	});
}

type TerminalLayoutSnapshot = {
	visible: boolean;
	hostWidth: number;
	hostHeight: number;
	xtermWidth: number;
	xtermHeight: number;
	screenWidth: number;
	screenHeight: number;
	renderedRows: number;
};

async function terminalLayoutSnapshot(page: import("@playwright/test").Page, animationFrames = 0): Promise<TerminalLayoutSnapshot> {
	return page.evaluate(async (frames) => {
		for (let i = 0; i < frames; i += 1) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		}
		const host = document.querySelector('[data-testid="terminal-xterm"]') as HTMLElement | null;
		const xterm = host?.querySelector(".xterm") as HTMLElement | null;
		const screen = host?.querySelector(".xterm-screen") as HTMLElement | null;
		const hostRect = host?.getBoundingClientRect();
		const xtermRect = xterm?.getBoundingClientRect();
		const screenRect = screen?.getBoundingClientRect();
		return {
			visible: !!host && !!xterm && !!screen && hostRect!.width > 0 && hostRect!.height > 0,
			hostWidth: hostRect?.width ?? 0,
			hostHeight: hostRect?.height ?? 0,
			xtermWidth: xtermRect?.width ?? 0,
			xtermHeight: xtermRect?.height ?? 0,
			screenWidth: screenRect?.width ?? 0,
			screenHeight: screenRect?.height ?? 0,
			renderedRows: host?.querySelectorAll(".xterm-rows > div").length ?? 0,
		};
	}, animationFrames);
}

async function terminalLayoutSnapshotAfterAnimationFrames(page: import("@playwright/test").Page): Promise<TerminalLayoutSnapshot> {
	return terminalLayoutSnapshot(page, 2);
}

async function resizeFrameCount(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => ((window as any).__terminalE2E?.sent ?? []).filter((msg: any) => msg?.type === "ext_channel_send" && msg?.frame?.kind === "json" && msg.frame.data?.op === "resize").length);
}

async function killFrameCount(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => ((window as any).__terminalE2E?.sent ?? []).filter((msg: any) => msg?.type === "ext_channel_send" && msg?.frame?.kind === "json" && msg.frame.data?.op === "kill").length);
}

async function textFrameCount(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => ((window as any).__terminalE2E?.sent ?? []).filter((msg: any) => msg?.type === "ext_channel_send" && msg?.frame?.kind === "text").length);
}

async function receivedTerminalTextIncludes(page: import("@playwright/test").Page, text: string): Promise<boolean> {
	return page.evaluate((needle) => ((window as any).__terminalE2E?.received ?? [])
		.some((msg: any) => msg?.type === "ext_channel_frame" && msg?.frame?.kind === "text" && String(msg.frame.data ?? "").includes(needle)), text);
}

async function channelSendCount(page: import("@playwright/test").Page, type: string): Promise<number> {
	return page.evaluate((msgType) => ((window as any).__terminalE2E?.sent ?? []).filter((msg: any) => msg?.type === msgType).length, type);
}
