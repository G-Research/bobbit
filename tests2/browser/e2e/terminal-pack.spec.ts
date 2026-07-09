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

// Synthetic fixture based on the Windows cmd.exe/ConPTY startup shape observed
// in the terminal regression: private-mode enables, clear/home, OSC title,
// banner, prompt, and cursor visibility toggles. Escaped bytes keep the replay
// deterministic on every E2E platform.
const WINDOWS_CMD_CONPTY_STARTUP_STREAM = [
	"\x1b[?9001h",
	"\x1b[?1004h",
	"\x1b[?25l",
	"\x1b[2J",
	"\x1b[H",
	"\x1b]0;C:\\Windows\\System32\\cmd.exe\x07",
	"Microsoft Windows [Version 10.0.22631.4317]\r\n",
	"(c) Microsoft Corporation. All rights reserved.\r\n\r\n",
	"\x1b[?25h",
	"C:\\Users\\bobbit>",
].join("");

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

	test("touch pan over xterm-screen scrolls the xterm viewport; reproduces ambiguous marker assertion before touch pan hides the terminal tail @terminal-repro", async ({ page, browserName }) => {
		test.skip(browserName !== "chromium", "CDP touch event dispatch is Chromium-only");
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1220, height: 620 });
		const client = await page.context().newCDPSession(page);
		await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
		await installChannelFrameSpy(page);

		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());

		await openTerminalFromSessionMenu(page);
		await expect(page.locator(terminalPanel())).toBeVisible({ timeout: 20_000 });
		await waitForTerminalMountedForFrameInjection(page);
		await assertTerminalLayoutStable(page, "touch scroll setup initial terminal open");

		const run = `bobbit_touch_scroll_${Date.now()}`;
		await injectTerminalJsonFrame(page, { op: "status", state: "open" });
		const burstDone = `${run}_BURST_DONE`;
		const burst = Array.from({ length: 160 }, (_, i) => `${run}_LINE_${String(i).padStart(3, "0")}_abcdefghijklmnopqrstuvwxyz`)
			.join("\r\n") + `\r\n${burstDone}`;
		await injectTerminalTextFrame(page, burst);
		await expect(page.locator(terminalHost()), "touch scroll setup: deterministic injected burst should render at the terminal bottom before the touch pan").toContainText(burstDone, { timeout: 10_000 });
		await expect.poll(
			async () => (await terminalScrollMetrics(page)).maxScrollTop,
			{ message: "touch scroll setup: deterministic injected burst must create scrollback", timeout: 10_000 },
		).toBeGreaterThan(80);
		const before = await terminalVisibleTouchLines(page, run);
		expect(
			before.firstLine !== null && before.firstLine > 80,
			`touch scroll setup: deterministic scrollback should start near the injected burst tail; before=${JSON.stringify(before)}`,
		).toBe(true);

		await dispatchTouchDragOverXtermScreen(page, client, "down");
		const detached = await waitForStableDetachedTouchScroll(page, client, run, before, burstDone);

		const whileScrolledUp = `${run}_WHILE_SCROLLED_UP`;
		await injectTerminalTextFrame(page, `${whileScrolledUp}\r\n`);
		const afterScrolledUpOutput = await terminalVisibleTouchLines(page, run);
		const afterScrolledUpOutputScroll = await terminalScrollMetrics(page);
		const afterOutputDiagnostics = terminalTouchScrollDetachedDiagnosticsFromLines(afterScrolledUpOutput, afterScrolledUpOutputScroll, run, burstDone, whileScrolledUp);
		const noBottomJumpOnOutput =
			afterOutputDiagnostics.firstLine !== null &&
			detached.diagnostics.firstLine !== null &&
			afterOutputDiagnostics.firstLine <= detached.diagnostics.firstLine + 2 &&
			Math.abs(afterOutputDiagnostics.scroll.scrollTop - detached.diagnostics.scroll.scrollTop) <= 2;
		const diagnostics = {
			minDetachPx: detached.minDetachPx,
			detachAttempts: detached.attempts,
			stableDetachedState: true,
			noBottomJumpOnOutput,
			hiddenLiveMarkerAfterOutput: !afterOutputDiagnostics.whileScrolledUpMarkerVisible,
			after: detached.diagnostics,
			afterOutput: afterOutputDiagnostics,
		};
		expect(
			noBottomJumpOnOutput && !afterOutputDiagnostics.whileScrolledUpMarkerVisible,
			`TERMINAL_TOUCH_SCROLL: output while touch-detached must not force-follow or become visible; diagnostics=${JSON.stringify(diagnostics)}`,
		).toBe(true);

		let returnedToBottom = await terminalVisibleTouchLines(page, run);
		for (let i = 0; i < 12 && !returnedToBottom.compactText.includes(whileScrolledUp); i += 1) {
			await dispatchTouchDragOverXtermScreen(page, client, "up");
			returnedToBottom = await terminalVisibleTouchLines(page, run);
		}
		expect(returnedToBottom.compactText, `TERMINAL_TOUCH_SCROLL: returning to bottom should show output that arrived while scrolled up; returned=${JSON.stringify(returnedToBottom)}`).toContain(whileScrolledUp);
		const afterReturn = `${run}_AFTER_RETURN_TO_BOTTOM`;
		await injectTerminalTextFrame(page, `${afterReturn}\r\n`);
		await expect(page.locator(terminalHost()), "touch scroll follow-output should resume after returning to bottom").toContainText(afterReturn, { timeout: 10_000 });
	});

	test("reproduces Windows cmd ConPTY startup xterm layout artifact @terminal-repro", async ({ page }, testInfo) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1220, height: 620 });
		await installChannelFrameSpy(page);

		await openApp(page);
		sessionId = await createSessionViaUI(page);
		await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.());

		await openTerminalFromSessionMenu(page);
		await expect(page.locator(terminalPanel())).toBeVisible({ timeout: 20_000 });
		await waitForTerminalMountedForFrameInjection(page);
		await muteRealTerminalFrames(page);

		const run = `bobbit_windows_conpty_${Date.now()}`;
		const burstDone = `${run}_BURST_DONE`;
		const followUp = `${run}_FOLLOWUP_PROMPT_VISIBLE`;
		const cursorHome = `${run}_CURSOR_HOME_VISIBLE`;
		const burst = Array.from({ length: 70 }, (_, i) => `${run}_LINE_${String(i).padStart(3, "0")}_abcdefghijklmnopqrstuvwxyz`)
			.join("\r\n") + `\r\n${burstDone}\r\n`;
		const followUpPrompt = `C:\\Users\\bobbit>echo ${followUp}\r\n${followUp}\r\nC:\\Users\\bobbit>`;

		const snapshots: TerminalDebugSnapshot[] = [];
		const contentProblems: string[] = [];
		const collectPhase = async (phase: string, expectedNearBottom?: string) => {
			const snapshot = await collectTerminalDebugSnapshot(page, phase);
			snapshots.push(snapshot);
			contentProblems.push(...terminalContentProblems(snapshot, expectedNearBottom));
			await attachTerminalDebugArtifacts(testInfo, page, phase, snapshot);
			return snapshot;
		};

		await injectTerminalTextFrame(page, WINDOWS_CMD_CONPTY_STARTUP_STREAM);
		await injectTerminalJsonFrame(page, { op: "status", state: "open" });
		await expect(page.locator(terminalHost())).toContainText("Microsoft Windows", { timeout: 10_000 });
		await collectPhase("initial-startup");

		await injectTerminalTextFrame(page, burst);
		await expect.poll(
			() => receivedTerminalTextIncludes(page, burstDone),
			{ message: "Windows ConPTY reproducer should feed the large-output completion marker", timeout: 10_000 },
		).toBe(true);
		await injectTerminalTextFrame(page, followUpPrompt);
		await expect(page.locator(terminalHost())).toContainText(followUp, { timeout: 10_000 });
		await collectPhase("large-burst-follow-up", followUp);

		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
		await expect(page.locator(terminalPanel()), "terminal panel should restore for Windows ConPTY replay reproduction").toBeVisible({ timeout: 20_000 });
		await waitForTerminalMountedForFrameInjection(page);
		await expect.poll(() => channelSendCount(page, "ext_channel_attach"), { timeout: 20_000 }).toBeGreaterThan(0);
		await muteRealTerminalFrames(page);
		await injectTerminalTextFrame(page, WINDOWS_CMD_CONPTY_STARTUP_STREAM + burst + followUpPrompt);
		await injectTerminalJsonFrame(page, { op: "status", state: "open" });
		await expect(page.locator(terminalHost())).toContainText(followUp, { timeout: 10_000 });
		await collectPhase("reload-reattach-replay", followUp);

		await page.setViewportSize({ width: 940, height: 430 });
		await waitForTerminalAnimationFrames(page);
		await injectTerminalTextFrame(page, followUpPrompt);
		await expect(page.locator(terminalHost())).toContainText(followUp, { timeout: 10_000 });
		await collectPhase("resize-smaller", followUp);
		await page.setViewportSize({ width: 1320, height: 720 });
		await waitForTerminalAnimationFrames(page);
		await injectTerminalTextFrame(page, followUpPrompt);
		await expect(page.locator(terminalHost())).toContainText(followUp, { timeout: 10_000 });
		await collectPhase("resize-larger", followUp);

		const beforeCursorRows = snapshots.at(-1)?.renderedRowCount ?? 0;
		await injectTerminalTextFrame(page, `\x1b[H${cursorHome}\r\nC:\\Users\\bobbit>`);
		await expect(page.locator(terminalHost())).toContainText(cursorHome, { timeout: 10_000 });
		const cursorSnapshot = await collectPhase("cursor-control-home", cursorHome);
		if (cursorSnapshot.renderedRowCount < Math.max(10, beforeCursorRows - 1)) {
			contentProblems.push(`cursor-control-home: xterm rendered rows shrank from ${beforeCursorRows} to ${cursorSnapshot.renderedRowCount}`);
		}

		const cssProblems = snapshots.flatMap(requiredXtermCssProblems);
		const allProblems = [...cssProblems, ...contentProblems];
		try {
			expect(
				allProblems,
				`TERMINAL_XTERM_REQUIRED_CSS_MISSING: required xterm stylesheet/layout rules are absent or incomplete. Debug snapshots:\n${JSON.stringify(snapshots, null, 2)}`,
			).toEqual([]);
		} catch (err) {
			await attachTerminalDebugArtifacts(testInfo, page, "failure", snapshots.at(-1));
			throw err;
		}
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
		const liveChannelId = await latestTerminalChannelId(page);
		expect(liveChannelId, "gateway restart setup should have a live terminal channel before the crash").toBeTruthy();
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

		const openBeforeRestart = await channelSendCount(page, "ext_channel_open");
		const startButton = page.locator(terminalPanel()).getByRole("button", { name: "Start or restart terminal" });
		await expect(startButton, "restored disconnected terminal should offer an explicit Restart/Start action").toBeEnabled({ timeout: 20_000 });
		await startButton.click();
		await expect.poll(() => channelSendCount(page, "ext_channel_open"), { timeout: 20_000 }).toBeGreaterThan(openBeforeRestart);
		await waitForTerminalReadyForInput(page);
		await expect.poll(
			async () => {
				const restartedChannelId = await latestTerminalChannelId(page);
				return Boolean(restartedChannelId && restartedChannelId !== liveChannelId);
			},
			{ message: "Restart after gateway restart should attach a newly opened terminal channel", timeout: 20_000 },
		).toBe(true);

		const restartMarker = `${marker}_after_restart`;
		await typeCommand(page, `echo ${restartMarker}`);
		await expect(page.locator(terminalHost())).toContainText(restartMarker, { timeout: 20_000 });
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
		win.__terminalE2E = {
			sent: [] as any[],
			received: [] as any[],
			sockets: [] as WebSocket[],
			mutedRealFrameChannels: new Set<string>(),
		};
		const isMutedRealFrame = (data: unknown): boolean => {
			if (typeof data !== "string") return false;
			try {
				const msg = JSON.parse(data);
				return msg?.type === "ext_channel_frame"
					&& msg.__terminalE2EInjected !== true
					&& typeof msg.channelId === "string"
					&& win.__terminalE2E.mutedRealFrameChannels.has(msg.channelId);
			} catch {
				return false;
			}
		};
		win.__terminalE2E.muteRealFrames = (channelId: string) => win.__terminalE2E.mutedRealFrameChannels.add(channelId);
		win.__terminalE2E.unmuteRealFrames = (channelId: string) => win.__terminalE2E.mutedRealFrameChannels.delete(channelId);
		win.__terminalE2E.injectServerMessage = (msg: any) => {
			const tagged = msg && typeof msg === "object" && !Array.isArray(msg)
				? { ...msg, __terminalE2EInjected: true }
				: msg;
			const data = JSON.stringify(tagged);
			win.__terminalE2E.received.push(tagged);
			const sockets = [...win.__terminalE2E.sockets].filter((socket: WebSocket) => socket.readyState === WebSocket.OPEN);
			for (const socket of sockets) {
				const event = new MessageEvent("message", { data });
				const handler = (socket as any).onmessage;
				if (typeof handler === "function") handler.call(socket, event);
				else socket.dispatchEvent(event);
			}
		};
		const OriginalWebSocket = window.WebSocket;
		window.WebSocket = class BobbitTerminalSpyWebSocket extends OriginalWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols as any);
				win.__terminalE2E.sockets.push(this);
				this.addEventListener("message", (event: MessageEvent) => {
					if (isMutedRealFrame(event.data)) {
						event.stopImmediatePropagation();
						return;
					}
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

type TerminalDebugSnapshot = {
	phase: string;
	buffer: { baseY: number | null; viewportY: number | null; cursorY: number | null; cols: number | null; rows: number | null };
	renderedRowCount: number;
	selectors: Record<string, { exists: boolean; rect: Record<string, number> | null; css: Record<string, string> | null }>;
	rows: { top: string[]; banner: string[]; bottom: string[]; all: string[] };
	scroll: { scrollTop: number; scrollHeight: number; clientHeight: number; maxScrollTop: number; atBottom: boolean };
	recentFrames: Array<{ kind: string; escaped: string; hex: string }>;
};

async function injectTerminalTextFrame(page: import("@playwright/test").Page, data: string): Promise<void> {
	await injectTerminalFrame(page, { kind: "text", data });
}

async function injectTerminalJsonFrame(page: import("@playwright/test").Page, data: unknown): Promise<void> {
	await injectTerminalFrame(page, { kind: "json", data });
}

async function injectTerminalFrame(page: import("@playwright/test").Page, frame: { kind: "text"; data: string } | { kind: "json"; data: unknown }): Promise<void> {
	const channelId = await latestTerminalChannelId(page);
	expect(channelId, "terminal reproducer needs an attached terminal channel before injecting deterministic ConPTY frames").toBeTruthy();
	await page.evaluate(({ channelId: id, frame: injectedFrame }) => {
		(window as any).__terminalE2E?.injectServerMessage?.({ type: "ext_channel_frame", channelId: id, frame: injectedFrame });
	}, { channelId, frame });
	await waitForTerminalAnimationFrames(page);
}

async function muteRealTerminalFrames(page: import("@playwright/test").Page): Promise<string> {
	// The ConPTY reproducer injects deterministic bridge frames; live PTY repaint
	// frames can race with those fixtures on startup/resize and invalidate the fixture.
	const channelId = await latestTerminalChannelId(page);
	expect(channelId, "terminal reproducer needs an attached terminal channel before muting live PTY frames").toBeTruthy();
	await page.evaluate((id) => (window as any).__terminalE2E?.muteRealFrames?.(id), channelId);
	return channelId;
}

async function waitForTerminalAnimationFrames(page: import("@playwright/test").Page): Promise<void> {
	await page.evaluate(async () => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	});
}

type TerminalScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number; maxScrollTop: number; atBottom: boolean; scrollAreaHeight: string; rowCount: number; rowHeight: number | null; scrollElementClass: string };

async function terminalScrollMetrics(page: import("@playwright/test").Page): Promise<TerminalScrollMetrics> {
	return page.evaluate(() => {
		const host = document.querySelector('[data-testid="terminal-xterm"]') as HTMLElement | null;
		const scrollElement = (host?.querySelector(".xterm-scrollable-element") ?? host?.querySelector(".xterm-viewport")) as HTMLElement | null;
		const scrollArea = host?.querySelector(".xterm-scroll-area") as HTMLElement | null;
		const scrollTop = scrollElement?.scrollTop ?? 0;
		const scrollHeight = scrollElement?.scrollHeight ?? 0;
		const clientHeight = scrollElement?.clientHeight ?? 0;
		const scrollAreaHeight = scrollArea?.style.height || getComputedStyle(scrollArea ?? document.body).height;
		const scrollAreaHeightPx = Number.parseFloat(scrollAreaHeight) || 0;
		const rowElements = Array.from(host?.querySelectorAll(".xterm-rows > div") ?? []) as HTMLElement[];
		const firstRowRect = rowElements[0]?.getBoundingClientRect();
		const rowHeight = firstRowRect && firstRowRect.height > 0 ? firstRowRect.height : null;
		const effectiveScrollHeight = Math.max(scrollHeight, scrollAreaHeightPx, scrollTop + clientHeight);
		const maxScrollTop = Math.max(0, effectiveScrollHeight - clientHeight);
		return {
			scrollTop,
			scrollHeight,
			clientHeight,
			maxScrollTop,
			atBottom: Math.abs(maxScrollTop - scrollTop) <= 2,
			scrollAreaHeight,
			rowCount: rowElements.length,
			rowHeight,
			scrollElementClass: scrollElement?.className ?? "",
		};
	});
}

async function dispatchTouchDragOverXtermScreen(
	page: import("@playwright/test").Page,
	client: { send(method: string, params?: Record<string, unknown>): Promise<unknown> },
	direction: "down" | "up" = "down",
	travelOverridePx?: number,
): Promise<void> {
	const screen = page.locator(`${terminalHost()} .xterm-screen`).first();
	await expect(screen, "touch scroll reproducer needs a visible .xterm-screen target").toBeVisible({ timeout: 10_000 });
	const rect = await screen.boundingBox();
	if (!rect) throw new Error("touch scroll reproducer could not resolve .xterm-screen bounds");
	const x = Math.round(rect.x + rect.width / 2);
	const travel = travelOverridePx ?? Math.max(80, Math.min(220, rect.height * 0.45));
	const lowY = Math.round(rect.y + Math.min(rect.height - 10, Math.max(30, rect.height * 0.35)));
	const highY = Math.round(Math.min(rect.y + rect.height - 6, lowY + travel));
	const startY = direction === "down" ? lowY : highY;
	const endY = direction === "down" ? highY : lowY;
	const point = (y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 });
	await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(startY)] });
	const steps = 8;
	for (let i = 1; i <= steps; i += 1) {
		const y = Math.round(startY + ((endY - startY) * i) / steps);
		await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(y)] });
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
	}
	await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await waitForTerminalAnimationFrames(page);
}

async function terminalVisibleTouchLines(page: import("@playwright/test").Page, run: string): Promise<{ firstLine: number | null; lastLine: number | null; text: string; compactText: string; rows: string[] }> {
	await waitForTerminalAnimationFrames(page);
	return page.evaluate((prefix) => {
		const rows = Array.from(document.querySelectorAll('[data-testid="terminal-xterm"] .xterm-rows > div'))
			.map((row) => (row.textContent ?? "").trimEnd());
		const text = rows.join("\n");
		const lineNumbers = rows.flatMap((row) => {
			const match = row.match(new RegExp(`${prefix}_LINE_(\\d{3})`));
			return match ? [Number(match[1])] : [];
		});
		return {
			firstLine: lineNumbers.length > 0 ? lineNumbers[0] : null,
			lastLine: lineNumbers.length > 0 ? lineNumbers[lineNumbers.length - 1] : null,
			text,
			compactText: rows.join(""),
			rows,
		};
	}, run);
}

function terminalTouchScrollDetachedDiagnosticsFromLines(
	lines: { firstLine: number | null; lastLine: number | null; text: string; compactText: string; rows: string[] },
	scroll: TerminalScrollMetrics,
	run: string,
	tailMarker: string,
	whileScrolledUpMarker = "",
) {
	let lastIndexedRow = -1;
	for (let i = lines.rows.length - 1; i >= 0; i -= 1) {
		if (lines.rows[i]?.includes(`${run}_LINE_`)) {
			lastIndexedRow = i;
			break;
		}
	}
	const tailRowsAfterLastIndexedLine = lastIndexedRow >= 0 ? lines.rows.slice(lastIndexedRow + 1).filter((row) => row.trim().length > 0) : [];
	const promptLikeTailVisible = tailRowsAfterLastIndexedLine.some((row) => /Microsoft Windows|Corporation|[A-Z]:\\|[>$#]\s*$/i.test(row) && !row.includes(tailMarker) && (whileScrolledUpMarker.length === 0 || !row.includes(whileScrolledUpMarker)));
	return {
		...lines,
		scroll,
		distanceFromBottom: Math.max(0, scroll.maxScrollTop - scroll.scrollTop),
		tailMarkerVisible: lines.compactText.includes(tailMarker),
		whileScrolledUpMarkerVisible: whileScrolledUpMarker.length > 0 && lines.compactText.includes(whileScrolledUpMarker),
		promptLikeTailVisible,
		tailRowsAfterLastIndexedLine,
	};
}

type TerminalVisibleTouchLines = Awaited<ReturnType<typeof terminalVisibleTouchLines>>;
type TerminalTouchScrollDiagnostics = ReturnType<typeof terminalTouchScrollDetachedDiagnosticsFromLines>;

async function sampleTerminalTouchDetachedState(
	page: import("@playwright/test").Page,
	run: string,
	tailMarker: string,
): Promise<{ lines: TerminalVisibleTouchLines; scroll: TerminalScrollMetrics; diagnostics: TerminalTouchScrollDiagnostics }> {
	const lines = await terminalVisibleTouchLines(page, run);
	const scroll = await terminalScrollMetrics(page);
	return { lines, scroll, diagnostics: terminalTouchScrollDetachedDiagnosticsFromLines(lines, scroll, run, tailMarker) };
}

async function waitForStableDetachedTouchScroll(
	page: import("@playwright/test").Page,
	client: { send(method: string, params?: Record<string, unknown>): Promise<unknown> },
	run: string,
	before: TerminalVisibleTouchLines,
	tailMarker: string,
): Promise<{ lines: TerminalVisibleTouchLines; scroll: TerminalScrollMetrics; diagnostics: TerminalTouchScrollDiagnostics; minDetachPx: number; attempts: number }> {
	let lastDiagnostics: unknown;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const firstSample = await sampleTerminalTouchDetachedState(page, run, tailMarker);
		await waitForTerminalAnimationFrames(page);
		const secondSample = await sampleTerminalTouchDetachedState(page, run, tailMarker);
		const minDetachPx = Math.max(48, (secondSample.scroll.rowHeight ?? 16) * 3);
		const stableScrollTop = Math.abs(secondSample.scroll.scrollTop - firstSample.scroll.scrollTop) <= 2;
		const stableFirstLine =
			firstSample.diagnostics.firstLine !== null &&
			secondSample.diagnostics.firstLine !== null &&
			Math.abs(secondSample.diagnostics.firstLine - firstSample.diagnostics.firstLine) <= 1;
		const olderFirstLine =
			before.firstLine !== null &&
			secondSample.diagnostics.firstLine !== null &&
			secondSample.diagnostics.firstLine < before.firstLine;
		const stableDetachedState =
			stableScrollTop &&
			stableFirstLine &&
			olderFirstLine &&
			!secondSample.diagnostics.scroll.atBottom &&
			secondSample.diagnostics.distanceFromBottom >= minDetachPx &&
			!secondSample.diagnostics.tailMarkerVisible &&
			!secondSample.diagnostics.promptLikeTailVisible;
		lastDiagnostics = {
			attempt: attempt + 1,
			minDetachPx,
			stableScrollTop,
			stableFirstLine,
			olderFirstLine,
			stableDetachedState,
			firstSample: firstSample.diagnostics,
			secondSample: secondSample.diagnostics,
		};
		if (stableDetachedState) {
			return { ...secondSample, minDetachPx, attempts: attempt + 1 };
		}
		await dispatchTouchDragOverXtermScreen(page, client, "down", 96);
	}
	throw new Error(`TERMINAL_TOUCH_SCROLL_DETACHED_STATE: touch panning did not reach a stable hidden-tail detached state before marker injection; diagnostics=${JSON.stringify(lastDiagnostics)}`);
}

async function latestTerminalChannelId(page: import("@playwright/test").Page): Promise<string> {
	return page.evaluate(() => {
		const received = ((window as any).__terminalE2E?.received ?? []) as any[];
		for (const msg of [...received].reverse()) {
			const channel = msg?.type === "ext_channel_result" && msg?.ok ? msg.channel : undefined;
			if (channel?.name === "terminal" && typeof channel.id === "string") return channel.id;
		}
		return "";
	});
}

async function collectTerminalDebugSnapshot(page: import("@playwright/test").Page, phase: string): Promise<TerminalDebugSnapshot> {
	return page.evaluate((snapshotPhase) => {
		const host = document.querySelector('[data-testid="terminal-xterm"]') as HTMLElement | null;
		const selectors = {
			host: '[data-testid="terminal-xterm"]',
			xterm: '[data-testid="terminal-xterm"] .xterm',
			viewport: '[data-testid="terminal-xterm"] .xterm-viewport',
			screen: '[data-testid="terminal-xterm"] .xterm-screen',
			helpers: '[data-testid="terminal-xterm"] .xterm-helpers',
			helperTextarea: '[data-testid="terminal-xterm"] .xterm-helper-textarea',
			accessibility: '[data-testid="terminal-xterm"] .xterm-accessibility',
			liveRegion: '[data-testid="terminal-xterm"] .live-region',
			charMeasure: '[data-testid="terminal-xterm"] .xterm-char-measure-element',
		};
		const rectAndCss = (selector: string) => {
			const el = document.querySelector(selector) as HTMLElement | null;
			if (!el) return { exists: false, rect: null, css: null };
			const rect = el.getBoundingClientRect();
			const css = getComputedStyle(el);
			return {
				exists: true,
				rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
				css: {
					display: css.display,
					visibility: css.visibility,
					opacity: css.opacity,
					position: css.position,
					top: css.top,
					right: css.right,
					bottom: css.bottom,
					left: css.left,
					overflow: css.overflow,
					overflowY: css.overflowY,
					pointerEvents: css.pointerEvents,
					width: css.width,
					height: css.height,
					zIndex: css.zIndex,
				},
			};
		};
		const allRows = Array.from(document.querySelectorAll('[data-testid="terminal-xterm"] .xterm-rows > div'))
			.map((row) => (row.textContent ?? "").trimEnd());
		const bannerIndex = allRows.findIndex((row) => /Microsoft Windows/i.test(row));
		const viewport = host?.querySelector(".xterm-viewport") as HTMLElement | null;
		const scrollTop = viewport?.scrollTop ?? 0;
		const scrollHeight = viewport?.scrollHeight ?? 0;
		const clientHeight = viewport?.clientHeight ?? 0;
		const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
		const escaped = (value: string) => value
			.replace(/\\/g, "\\\\")
			.replace(/\x1b/g, "\\x1b")
			.replace(/\r/g, "\\r")
			.replace(/\n/g, "\\n")
			.replace(/\x07/g, "\\x07");
		const hex = (value: string) => Array.from(value).map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
		const recentFrames = (((window as any).__terminalE2E?.received ?? []) as any[])
			.filter((msg) => msg?.type === "ext_channel_frame")
			.slice(-8)
			.map((msg) => {
				const data = typeof msg?.frame?.data === "string" ? msg.frame.data : JSON.stringify(msg?.frame?.data ?? null);
				return { kind: String(msg?.frame?.kind ?? "unknown"), escaped: escaped(data).slice(0, 500), hex: hex(data).slice(0, 500) };
			});
		return {
			phase: snapshotPhase,
			buffer: {
				baseY: null,
				viewportY: null,
				cursorY: null,
				cols: null,
				rows: allRows.length || null,
			},
			renderedRowCount: allRows.length,
			selectors: Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, rectAndCss(selector)])),
			rows: {
				top: allRows.slice(0, 5),
				banner: bannerIndex >= 0 ? allRows.slice(Math.max(0, bannerIndex - 2), bannerIndex + 5) : [],
				bottom: allRows.slice(-8),
				all: allRows,
			},
			scroll: { scrollTop, scrollHeight, clientHeight, maxScrollTop, atBottom: Math.abs(maxScrollTop - scrollTop) <= 2 },
			recentFrames,
		};
	}, phase);
}

async function attachTerminalDebugArtifacts(testInfo: import("@playwright/test").TestInfo, page: import("@playwright/test").Page, phase: string, snapshot?: TerminalDebugSnapshot): Promise<void> {
	const safePhase = phase.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
	if (snapshot) {
		await testInfo.attach(`terminal-debug-${safePhase}.json`, {
			body: JSON.stringify(snapshot, null, 2),
			contentType: "application/json",
		});
	}
	const host = page.locator(terminalHost()).first();
	if (await host.count()) {
		const path = testInfo.outputPath(`terminal-${safePhase}.png`);
		await host.screenshot({ path }).catch(() => undefined);
		await testInfo.attach(`terminal-${safePhase}.png`, { path, contentType: "image/png" }).catch(() => undefined);
	}
}

function terminalContentProblems(snapshot: TerminalDebugSnapshot, expectedNearBottom?: string): string[] {
	const problems: string[] = [];
	for (const row of snapshot.rows.top.slice(0, 3)) {
		const text = row.trim();
		if (text.length < 24) continue;
		const dense = text.replace(/\s/g, "");
		const counts = new Map<string, number>();
		for (const ch of dense) counts.set(ch, (counts.get(ch) ?? 0) + 1);
		const max = Math.max(0, ...counts.values());
		const repeatedRun = text.match(/([^\s])\1{23,}/)?.[0];
		if ((max >= 24 && max / Math.max(1, dense.length) >= 0.8) || repeatedRun) {
			problems.push(`${snapshot.phase}: repeated glyph artifact in top xterm rows: ${JSON.stringify(text)}`);
		}
	}
	if (expectedNearBottom) {
		const bottomRows = nearBottomRows(snapshot.rows.all);
		const bottomText = bottomRows.join("");
		if (!snapshot.scroll.atBottom) {
			problems.push(`${snapshot.phase}: expected viewport at bottom after follow-up prompt; scrollTop=${snapshot.scroll.scrollTop} max=${snapshot.scroll.maxScrollTop}`);
		}
		if (!bottomText.includes(expectedNearBottom) && !bottomText.includes(expectedNearBottom.slice(-32))) {
			problems.push(`${snapshot.phase}: expected ${expectedNearBottom} near bottom rows; nearBottom=${JSON.stringify(bottomRows)} rawBottom=${JSON.stringify(snapshot.rows.bottom)}`);
		}
	}
	return problems;
}

function requiredXtermCssProblems(snapshot: TerminalDebugSnapshot): string[] {
	const problems: string[] = [];
	const selector = (name: string) => snapshot.selectors[name];
	const css = (name: string) => selector(name)?.css;
	const rect = (name: string) => selector(name)?.rect;
	const expectCss = (name: string, condition: boolean, detail: string) => {
		if (!condition) problems.push(`${snapshot.phase}: ${name} ${detail}`);
	};
	const viewportCss = css("viewport");
	expectCss(".xterm-viewport", !!viewportCss, "must exist");
	if (viewportCss) {
		expectCss(".xterm-viewport", viewportCss.position === "absolute", `must be position:absolute from xterm.css; actual=${viewportCss.position}`);
		expectCss(".xterm-viewport", viewportCss.top === "0px" && viewportCss.left === "0px", `must be inset to the xterm host; actual top=${viewportCss.top} left=${viewportCss.left}`);
	}
	const screenCss = css("screen");
	expectCss(".xterm-screen", !!screenCss, "must exist");
	if (screenCss) {
		expectCss(".xterm-screen", screenCss.position === "relative", `must be position:relative from xterm.css; actual=${screenCss.position}`);
	}
	const helpersCss = css("helpers");
	expectCss(".xterm-helpers", !!helpersCss, "must exist so xterm helper DOM can be hidden outside normal layout");
	if (helpersCss) {
		expectCss(".xterm-helpers", helpersCss.position === "absolute", `must be position:absolute from xterm.css; actual=${helpersCss.position}`);
	}
	const textareaCss = css("helperTextarea");
	expectCss(".xterm-helper-textarea", !!textareaCss, "must exist");
	if (textareaCss) {
		expectCss(".xterm-helper-textarea", textareaCss.position === "absolute", `must be position:absolute/off-screen from xterm.css; actual=${textareaCss.position}`);
		expectCss(".xterm-helper-textarea", textareaCss.opacity === "0", `must be transparent; actual opacity=${textareaCss.opacity}`);
	}
	for (const name of ["accessibility", "liveRegion", "charMeasure"] as const) {
		const node = selector(name);
		if (!node?.exists) continue;
		const nodeCss = node.css;
		const nodeRect = rect(name);
		expectCss(name, nodeCss?.position === "absolute" || nodeCss?.display === "none" || nodeCss?.visibility === "hidden", `must not participate in visible normal layout; css=${JSON.stringify(nodeCss)} rect=${JSON.stringify(nodeRect)}`);
	}
	return problems;
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
	await waitForTerminalMountedForFrameInjection(page);
	await focusTerminal(page);
}

async function waitForTerminalMountedForFrameInjection(page: import("@playwright/test").Page): Promise<void> {
	await expect(page.locator(terminalPanel())).toHaveAttribute("data-terminal-state", "attached", { timeout: 20_000 });
	await expect(page.locator(`${terminalHost()} .xterm-helper-textarea`), "xterm input textarea must be mounted before typing").toHaveCount(1, { timeout: 10_000 });
}

type TerminalFocusDiagnostics = {
	panelState: string | null;
	activeTag: string | null;
	activeClass: string;
	activeInTerminal: boolean;
	textareaExists: boolean;
	textareaDisabled: boolean;
	textareaReadOnly: boolean;
	xtermVisible: boolean;
	screenVisible: boolean;
	hostRect: { width: number; height: number } | null;
	xtermRect: { width: number; height: number } | null;
	screenRect: { width: number; height: number } | null;
	renderedRows: number;
};

async function focusTerminal(page: import("@playwright/test").Page): Promise<void> {
	const xterm = page.locator(`${terminalHost()} .xterm`).first();
	const helperTextarea = page.locator(`${terminalHost()} .xterm-helper-textarea`).first();
	await expect(xterm, "xterm must be visible and focusable before typing").toBeVisible({ timeout: 10_000 });

	let lastDiagnostics: TerminalFocusDiagnostics | undefined;
	let lastFocusError = "";
	try {
		await expect.poll(async () => {
			await waitForTerminalAnimationFrames(page).catch(() => undefined);
			lastDiagnostics = await terminalFocusDiagnostics(page);
			if (lastDiagnostics.panelState !== "attached" || !lastDiagnostics.textareaExists || !lastDiagnostics.xtermVisible || !lastDiagnostics.screenVisible) {
				return false;
			}
			try {
				await xterm.click({ position: { x: 24, y: 24 }, timeout: 2_000 });
				await helperTextarea.focus({ timeout: 2_000 });
				await page.evaluate(() => {
					(document.querySelector('[data-testid="terminal-xterm"] .xterm-helper-textarea') as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
				});
				lastFocusError = "";
			} catch (error) {
				lastFocusError = error instanceof Error ? error.message : String(error);
			}
			await waitForTerminalAnimationFrames(page).catch(() => undefined);
			lastDiagnostics = await terminalFocusDiagnostics(page);
			return terminalFocusedForInput(lastDiagnostics);
		}, {
			message: "terminal xterm should become focused/ready for input",
			timeout: 20_000,
			intervals: [100, 250, 500],
		}).toBe(true);
	} catch (error) {
		const detail = JSON.stringify(lastDiagnostics ?? await terminalFocusDiagnostics(page), null, 2);
		throw new Error(`terminal xterm did not become focused/ready for input within 20s; lastFocusError=${lastFocusError || "none"}; diagnostics=${detail}; assertion=${error instanceof Error ? error.message : String(error)}`);
	}
}

function terminalFocusedForInput(diagnostics: TerminalFocusDiagnostics): boolean {
	return diagnostics.panelState === "attached"
		&& diagnostics.textareaExists
		&& !diagnostics.textareaDisabled
		&& diagnostics.xtermVisible
		&& diagnostics.screenVisible
		&& diagnostics.renderedRows > 0
		&& diagnostics.activeInTerminal;
}

async function terminalFocusDiagnostics(page: import("@playwright/test").Page): Promise<TerminalFocusDiagnostics> {
	return page.evaluate(() => {
		const panel = document.querySelector('[data-testid="terminal-panel"]') as HTMLElement | null;
		const host = document.querySelector('[data-testid="terminal-xterm"]') as HTMLElement | null;
		const xterm = host?.querySelector(".xterm") as HTMLElement | null;
		const screen = host?.querySelector(".xterm-screen") as HTMLElement | null;
		const textarea = host?.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
		const active = document.activeElement as HTMLElement | null;
		const rectSize = (element: HTMLElement | null) => {
			if (!element) return null;
			const rect = element.getBoundingClientRect();
			return { width: rect.width, height: rect.height };
		};
		const visible = (element: HTMLElement | null) => {
			if (!element) return false;
			const rect = element.getBoundingClientRect();
			const css = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden";
		};
		return {
			panelState: panel?.getAttribute("data-terminal-state") ?? null,
			activeTag: active?.tagName ?? null,
			activeClass: active?.className ? String(active.className) : "",
			activeInTerminal: active?.classList.contains("xterm-helper-textarea") === true
				|| (active?.closest?.('[data-testid="terminal-xterm"] .xterm') ?? null) !== null,
			textareaExists: !!textarea,
			textareaDisabled: textarea?.disabled === true,
			textareaReadOnly: textarea?.readOnly === true,
			xtermVisible: visible(xterm),
			screenVisible: visible(screen),
			hostRect: rectSize(host),
			xtermRect: rectSize(xterm),
			screenRect: rectSize(screen),
			renderedRows: host?.querySelectorAll(".xterm-rows > div").length ?? 0,
		};
	});
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
