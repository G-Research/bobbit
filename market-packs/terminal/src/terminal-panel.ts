import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const SINGLETON_KEY = "session-terminal";
const MAX_SCROLLBACK = 5000;
const FIT_RETRY_DELAYS_MS = [0, 32, 80, 160, 320] as const;
const RESIZE_SEND_DEBOUNCE_MS = 120;
const SCROLL_BOTTOM_EPSILON = 1;
const TOUCH_SCROLL_INTENT_PX = 8;
const TOUCH_SCROLL_AXIS_RATIO = 1.2;

type HostChannelFrame = { kind: "text"; data: string } | { kind: "json"; data: unknown };
type HostChannel = {
	id: string;
	state: "open" | "closing" | "closed";
	send(frame: HostChannelFrame): Promise<void>;
	close(reason?: string): Promise<void>;
	onFrame(cb: (frame: HostChannelFrame) => void): () => void;
	onClose(cb: (event: { reason?: string; error?: string }) => void): () => void;
};
type HostApi = {
	capabilities?: { channels?: boolean };
	channels?: {
		open(name: string, init?: { data?: unknown; singletonKey?: string }): Promise<HostChannel>;
		attach(id: string): Promise<HostChannel>;
		list(opts?: { name?: string; includeClosed?: boolean }): Promise<Array<{ id: string; state: string; lastActiveAt: number; closeReason?: string }>>;
	};
	requestRender?: () => void;
};

type SessionState = {
	sid: string;
	root: HTMLElement;
	terminalHost: HTMLElement;
	statusEl: HTMLElement;
	startButton: HTMLButtonElement;
	killButton: HTMLButtonElement;
	closeButton: HTMLButtonElement;
	term?: Terminal;
	fit?: FitAddon;
	resizeObserver?: ResizeObserver;
	fitGeneration?: number;
	fitRetryTimer?: number;
	fitFrame?: number;
	resizeSendTimer?: number;
	scrollFrame?: number;
	lastResizeSent?: string;
	terminalDisposerCount?: number;
	followOutput: boolean;
	replayHydrating?: boolean;
	channel?: HostChannel;
	disposers: Array<() => void>;
	status: string;
	terminalState: "idle" | "connecting" | "attached" | "detached" | "exited" | "killed" | "disconnected" | "error";
	connecting?: boolean;
	autoStartAttempted?: boolean;
	autoStartLaunchId?: string;
	channelReadyId?: string;
	attachAttempted?: boolean;
	startupError?: string;
	host?: HostApi;
};

export default function createTerminalPanel() {
	installStyles();
	const sessions = new Map<string, SessionState>();
	return {
		render(params: Record<string, unknown> | undefined, host: HostApi | undefined) {
			const sid = typeof params?.__sessionId === "string" ? params.__sessionId : "default";
			const state = sessions.get(sid) ?? createSessionState(sid);
			sessions.set(sid, state);
			state.host = host;
			queueMicrotask(() => {
				ensureTerminalMounted(state);
				scheduleFitAndResize(state);
				const launchId = typeof params?.__channelLaunchId === "string" ? params.__channelLaunchId : undefined;
				const readyId = typeof params?.__channelReadyId === "string" ? params.__channelReadyId : undefined;
				const launcherOpening = params?.launcherOpening === true;
				const autoStartRequested = params?.autoStart === true;
				const startupError = typeof params?.startupError === "string" && params.startupError ? params.startupError : undefined;
				// A ready/error marker means the trusted launcher already attempted the
				// open. On reload/gateway restart, never replay that creation attempt from
				// restored panel params; v1 should show disconnected and wait for Restart.
				const autoStart = readyId || startupError || (!!launchId && !launcherOpening) ? false : shouldAutoStart(state, autoStartRequested, launchId);
				const restoredAutoStart = autoStartRequested && !autoStart;
				const restoredReadyChannel = !!readyId && !autoStart;
				const restoredStartupFailure = !!startupError && !launcherOpening && (/trusted launcher activation/i.test(startupError) || !!launchId);
				const restoredChannel = restoredAutoStart || restoredReadyChannel || restoredStartupFailure;
				if (readyId && state.channelReadyId !== readyId) {
					state.channelReadyId = readyId;
					state.attachAttempted = false;
				}
				if (restoredChannel) {
					state.startupError = undefined;
				} else if (startupError && startupError !== state.startupError) {
					state.startupError = startupError;
					setStatus(state, startupError, "error");
				}
				if (!state.startupError && (!state.attachAttempted || autoStart || launcherOpening)) {
					state.attachAttempted = true;
					void attachOrOfferStart(state, autoStart, restoredChannel, launcherOpening);
				}
			});
			return state.root;
		},
	};
}

function createSessionState(sid: string): SessionState {
	const root = document.createElement("section");
	root.className = "bb-terminal-panel";
	root.setAttribute("aria-label", "Terminal");
	root.setAttribute("data-testid", "terminal-panel");

	const toolbar = document.createElement("div");
	toolbar.className = "bb-terminal-toolbar";
	const title = document.createElement("div");
	title.className = "bb-terminal-title";
	title.textContent = "Terminal";
	const statusEl = document.createElement("div");
	statusEl.className = "bb-terminal-status";
	statusEl.setAttribute("role", "status");
	statusEl.setAttribute("aria-live", "polite");

	const startButton = button("Start", "Start or restart terminal");
	const killButton = button("Kill", "Terminate terminal process");
	const closeButton = button("Close panel", "Hide terminal panel without killing the process");
	const actions = document.createElement("div");
	actions.className = "bb-terminal-actions";
	actions.append(startButton, killButton, closeButton);
	toolbar.append(title, statusEl, actions);

	const terminalHost = document.createElement("div");
	terminalHost.className = "bb-terminal-host";
	terminalHost.setAttribute("aria-label", "Terminal output and input");
	terminalHost.setAttribute("data-testid", "terminal-xterm");
	root.append(toolbar, terminalHost);

	const state: SessionState = {
		sid,
		root,
		terminalHost,
		statusEl,
		startButton,
		killButton,
		closeButton,
		disposers: [],
		status: "Ready",
		terminalState: "idle",
		followOutput: true,
	};
	startButton.addEventListener("click", () => { void startTerminal(state, true); });
	killButton.addEventListener("click", () => { void killTerminal(state); });
	closeButton.addEventListener("click", () => closePanel(root));
	setStatus(state, "Ready. Start a terminal when you need an interactive shell.", "idle");
	return state;
}

function ensureTerminalMounted(state: SessionState): void {
	if (state.term || !state.root.isConnected) return;
	const computed = getComputedStyle(document.documentElement);
	const fg = cssVar(computed, "--foreground", "#d4d4d4");
	const bg = cssVar(computed, "--background", "#111111");
	const muted = cssVar(computed, "--muted-foreground", fg);
	const cursor = cssVar(computed, "--primary", fg);
	const term = new Terminal({
		convertEol: true,
		cursorBlink: true,
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
		fontSize: 13,
		scrollback: MAX_SCROLLBACK,
		theme: { foreground: fg, background: bg, cursor, selectionBackground: muted },
		allowProposedApi: false,
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(state.terminalHost);
	state.term = term;
	state.fit = fit;
	const inputDisposable = term.onData((data) => {
		reconcileActivePrompt(state);
		void state.channel?.send({ kind: "text", data }).catch((err) => setError(state, err));
	});
	const scrollDisposable = term.onScroll(() => updateFollowOutputFromViewport(state));
	state.disposers.push(() => inputDisposable.dispose(), () => scrollDisposable.dispose(), installTouchScrollBridge(state));
	state.terminalDisposerCount = state.disposers.length;
	state.resizeObserver = new ResizeObserver(() => scheduleFitAndResize(state));
	state.resizeObserver.observe(state.terminalHost);
	scheduleFitAndResize(state);
}

function shouldAutoStart(state: SessionState, requested: boolean, launchId?: string): boolean {
	if (!requested) return false;
	if (launchId) {
		if (state.autoStartLaunchId === launchId) return false;
		state.autoStartLaunchId = launchId;
		const key = `bb-terminal-autostart:${state.sid}:${launchId}`;
		try {
			if (sessionStorage.getItem(key)) return false;
			sessionStorage.setItem(key, "1");
		} catch {
			// If storage is unavailable, fall back to the page-lived launch guard.
		}
		return true;
	}
	// Trusted launchers always provide a one-shot launch id. A restored workspace
	// may still carry the declarative `autoStart` panel param, but after a reload or
	// gateway restart v1 must not silently create a fresh PTY without a new user
	// gesture. Treat id-less autoStart as restored intent and offer Restart instead.
	return false;
}

async function attachOrOfferStart(state: SessionState, autoStart: boolean, restoredAutoStart = false, launcherOpening = false): Promise<void> {
	if (state.channel || state.connecting) return;
	const disconnectedText = "Terminal disconnected or closed. Press Restart to create a new terminal.";
	const host = state.host;
	if (!host?.capabilities?.channels || !host.channels) {
		if (restoredAutoStart) {
			state.attachAttempted = false;
			state.startupError = undefined;
			setStatus(state, disconnectedText, "disconnected");
		} else {
			setStatus(state, "Terminal channels are unavailable in this host.", "error");
		}
		return;
	}
	state.connecting = true;
	try {
		setStatus(state, "Looking for an existing terminal…", "connecting");
		const channels = await host.channels.list({ name: "terminal" });
		const live = channels.filter((c) => c.state === "open" || c.state === "opening").sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
		if (live) {
			await attachChannel(state, await host.channels.attach(live.id), "Reattached to terminal.");
			return;
		}
		if (autoStart) {
			await startTerminal(state, false);
			return;
		}
		if (launcherOpening) {
			setStatus(state, "Opening terminal from launcher…", "connecting");
			return;
		}
		state.startupError = undefined;
		setStatus(
			state,
			restoredAutoStart ? disconnectedText : "No live terminal. Press Start to create one.",
			restoredAutoStart ? "disconnected" : "idle",
		);
	} catch (err) {
		state.startupError = undefined;
		setStatus(state, restoredAutoStart ? disconnectedText : messageOf(err, "Could not attach terminal."), "disconnected");
	} finally {
		state.connecting = false;
		updateButtons(state);
	}
}

async function startTerminal(state: SessionState, fromButton: boolean): Promise<void> {
	const host = state.host;
	if (!host?.channels) {
		setStatus(state, "Terminal channels are unavailable.", "error");
		return;
	}
	if (state.channel?.state === "open") return;
	state.connecting = true;
	state.startupError = undefined;
	try {
		ensureTerminalMounted(state);
		state.term?.clear();
		setStatus(state, fromButton ? "Starting terminal…" : "Opening terminal from launcher…", "connecting");
		const initialSize = fitNow(state) ?? currentTerminalSize(state) ?? { cols: 80, rows: 24 };
		state.lastResizeSent = sizeKey(initialSize);
		if (!canFitTerminal(state)) scheduleFitAndResize(state);
		const channel = await host.channels.open("terminal", {
			singletonKey: SINGLETON_KEY,
			data: initialSize,
		});
		await attachChannel(state, channel, "Terminal attached.");
	} catch (err) {
		const msg = messageOf(err, "Terminal failed to start.");
		setStatus(state, /user gesture/i.test(msg) ? "Press Start to create a terminal." : msg, /user gesture/i.test(msg) ? "idle" : "error");
	} finally {
		state.connecting = false;
		updateButtons(state);
	}
}

async function attachChannel(state: SessionState, channel: HostChannel, status: string): Promise<void> {
	cleanupChannelListeners(state);
	resetTerminalForAttach(state);
	state.startupError = undefined;
	state.replayHydrating = true;
	state.channel = channel;
	state.disposers.push(channel.onFrame((frame) => handleFrame(state, frame)));
	state.disposers.push(channel.onClose((event) => {
		state.channel = undefined;
		if (state.terminalState !== "exited" && state.terminalState !== "killed") {
			setStatus(state, event.error || event.reason || "Terminal disconnected.", "disconnected");
		}
		updateButtons(state);
	}));
	setStatus(state, status, "attached");
	updateButtons(state);
	scheduleFitAndResize(state);
}

function cleanupChannelListeners(state: SessionState): void {
	const terminalDisposerCount = state.terminalDisposerCount ?? 1;
	if (state.disposers.length <= terminalDisposerCount) return;
	const keep = state.disposers.slice(0, terminalDisposerCount);
	for (const dispose of state.disposers.slice(terminalDisposerCount)) {
		try { dispose(); } catch { /* ignore */ }
	}
	state.disposers = keep;
}

function resetTerminalForAttach(state: SessionState): void {
	ensureTerminalMounted(state);
	state.followOutput = true;
	state.term?.reset();
	state.term?.clear();
	keepPromptVisible(state);
}

function handleFrame(state: SessionState, frame: HostChannelFrame): void {
	if (frame.kind === "text") {
		state.term?.write(frame.data, () => {
			if (state.replayHydrating) keepPromptVisible(state);
			else reconcileActivePrompt(state);
		});
		return;
	}
	const data = objectOf(frame.data);
	if (!data) return;
	if (data.op === "status") {
		state.replayHydrating = false;
		setStatus(state, typeof data.state === "string" ? `Terminal ${data.state}.` : "Terminal attached.", "attached");
		reconcileActivePrompt(state);
		return;
	}
	if (data.op === "error") {
		setStatus(state, typeof data.message === "string" ? data.message : "Terminal error.", "error");
		return;
	}
	if (data.op === "exit") {
		const code = data.code == null ? "unknown" : String(data.code);
		const reason = typeof data.reason === "string" ? data.reason : "exited";
		setStatus(state, reason === "killed" ? "Terminal killed." : `Terminal exited (${code}).`, reason === "killed" ? "killed" : "exited");
		state.channel = undefined;
		updateButtons(state);
	}
}

async function killTerminal(state: SessionState): Promise<void> {
	const channel = state.channel;
	if (!channel) return;
	try {
		setStatus(state, "Killing terminal…", "killed");
		await channel.send({ kind: "json", data: { op: "kill", reason: "killed" } });
	} catch (err) {
		setError(state, err);
	}
}

function scheduleFitAndResize(state: SessionState): void {
	const generation = (state.fitGeneration ?? 0) + 1;
	state.fitGeneration = generation;
	if (state.fitRetryTimer !== undefined) {
		window.clearTimeout(state.fitRetryTimer);
		state.fitRetryTimer = undefined;
	}
	if (state.fitFrame !== undefined) {
		cancelAnimationFrame(state.fitFrame);
		state.fitFrame = undefined;
	}
	queueFitAttempt(state, generation, 0);
}

function queueFitAttempt(state: SessionState, generation: number, attempt: number): void {
	const delay = FIT_RETRY_DELAYS_MS[Math.min(attempt, FIT_RETRY_DELAYS_MS.length - 1)];
	state.fitRetryTimer = window.setTimeout(() => {
		state.fitRetryTimer = undefined;
		runFitAttempt(state, generation, attempt);
	}, delay);
}

function runFitAttempt(state: SessionState, generation: number, attempt: number): void {
	if (state.fitGeneration !== generation) return;
	state.fitFrame = requestAnimationFrame(() => {
		state.fitFrame = requestAnimationFrame(() => {
			state.fitFrame = undefined;
			if (state.fitGeneration !== generation) return;
			const size = fitNow(state);
			if (size) {
				queueResizeSend(state);
				reconcileActivePrompt(state);
			}
			if (attempt + 1 < FIT_RETRY_DELAYS_MS.length) {
				queueFitAttempt(state, generation, attempt + 1);
			}
		});
	});
}

function queueResizeSend(state: SessionState): void {
	if (state.resizeSendTimer !== undefined) {
		window.clearTimeout(state.resizeSendTimer);
		state.resizeSendTimer = undefined;
	}
	state.resizeSendTimer = window.setTimeout(() => {
		state.resizeSendTimer = undefined;
		const size = canFitTerminal(state) ? currentTerminalSize(state) : undefined;
		if (!size || state.channel?.state !== "open") return;
		const key = sizeKey(size);
		if (key === state.lastResizeSent) return;
		state.lastResizeSent = key;
		void state.channel.send({ kind: "json", data: { op: "resize", cols: size.cols, rows: size.rows } }).catch((err) => setError(state, err));
	}, RESIZE_SEND_DEBOUNCE_MS);
}

function fitNow(state: SessionState): { cols: number; rows: number } | undefined {
	if (!canFitTerminal(state)) return undefined;
	try {
		state.fit?.fit();
	} catch {
		return undefined;
	}
	reconcileActivePrompt(state);
	return currentTerminalSize(state);
}

function reconcileActivePrompt(state: SessionState): void {
	keepPromptVisible(state);
	pinPromptToPanelBottom(state);
}

function keepPromptVisible(state: SessionState): void {
	if (!state.term || state.followOutput === false) return;
	scrollToBottomNow(state);
	if (state.scrollFrame !== undefined) return;
	state.scrollFrame = requestAnimationFrame(() => {
		state.scrollFrame = requestAnimationFrame(() => {
			state.scrollFrame = undefined;
			if (state.followOutput !== false) {
				scrollToBottomNow(state);
				pinPromptToPanelBottom(state);
			}
		});
	});
}

function scrollToBottomNow(state: SessionState): void {
	try {
		state.term?.scrollToBottom();
	} catch {
		// Ignore scroll failures from a terminal that is mid-dispose or not fully mounted.
	}
	state.followOutput = true;
}

function pinPromptToPanelBottom(state: SessionState): void {
	const term = state.term;
	const buffer = term?.buffer?.active;
	if (!term || !buffer || state.followOutput === false || buffer.baseY <= 0) return;
	const slack = Math.floor(term.rows - 1 - buffer.cursorY);
	if (slack <= 3 || slack >= term.rows) return;
	const viewportY = promptPinnedViewportY(term, buffer);
	if (Math.abs(buffer.viewportY - viewportY) <= SCROLL_BOTTOM_EPSILON) return;
	try {
		term.scrollToLine(viewportY);
	} catch {
		// Ignore scroll failures from a terminal that is mid-dispose or not fully mounted.
	}
	state.followOutput = true;
}

function promptPinnedViewportY(term: Terminal, buffer: Terminal["buffer"]["active"]): number {
	const cursorLine = buffer.baseY + buffer.cursorY;
	return Math.max(0, Math.min(buffer.baseY, cursorLine - term.rows + 1));
}

function updateFollowOutputFromViewport(state: SessionState): void {
	const term = state.term;
	const buffer = term?.buffer?.active;
	if (!term || !buffer) {
		state.followOutput = true;
		return;
	}
	const atBottom = buffer.viewportY >= buffer.baseY - SCROLL_BOTTOM_EPSILON;
	const promptPinned = Math.abs(buffer.viewportY - promptPinnedViewportY(term, buffer)) <= SCROLL_BOTTOM_EPSILON;
	state.followOutput = atBottom || promptPinned;
}

function installTouchScrollBridge(state: SessionState): () => void {
	type TouchScrollTracking = {
		identifier: number;
		startX: number;
		startY: number;
		lastY: number;
		lineRemainder: number;
		scrolling: boolean;
	};
	let tracking: TouchScrollTracking | undefined;
	const findTouch = (touches: TouchList): Touch | undefined => {
		if (!tracking) return undefined;
		for (let i = 0; i < touches.length; i += 1) {
			const touch = touches.item(i);
			if (touch?.identifier === tracking.identifier) return touch;
		}
		return undefined;
	};
	const isScrollableTarget = (target: EventTarget | null): boolean => {
		return target instanceof Element && !!target.closest(".xterm-screen, .xterm-rows, .xterm-viewport");
	};
	const stopIfEnded = (touches: TouchList): void => {
		if (!tracking) return;
		for (let i = 0; i < touches.length; i += 1) {
			if (touches.item(i)?.identifier === tracking.identifier) {
				tracking = undefined;
				return;
			}
		}
	};
	const onTouchStart = (event: TouchEvent): void => {
		if (event.touches.length !== 1 || !isScrollableTarget(event.target)) {
			tracking = undefined;
			return;
		}
		const touch = event.touches.item(0);
		if (!touch) return;
		tracking = {
			identifier: touch.identifier,
			startX: touch.clientX,
			startY: touch.clientY,
			lastY: touch.clientY,
			lineRemainder: 0,
			scrolling: false,
		};
	};
	const onTouchMove = (event: TouchEvent): void => {
		const touch = findTouch(event.touches);
		if (!tracking || !touch) return;
		const totalX = touch.clientX - tracking.startX;
		const totalY = touch.clientY - tracking.startY;
		if (!tracking.scrolling) {
			const absX = Math.abs(totalX);
			const absY = Math.abs(totalY);
			if (absX < TOUCH_SCROLL_INTENT_PX && absY < TOUCH_SCROLL_INTENT_PX) return;
			if (absY <= absX * TOUCH_SCROLL_AXIS_RATIO) {
				tracking = undefined;
				return;
			}
			tracking.scrolling = true;
		}
		const deltaY = touch.clientY - tracking.lastY;
		tracking.lastY = touch.clientY;
		if (deltaY === 0) return;
		if (event.cancelable) event.preventDefault();
		scrollTerminalByTouchDelta(state, tracking, deltaY);
	};
	const onTouchEnd = (event: TouchEvent): void => stopIfEnded(event.changedTouches);
	state.terminalHost.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
	state.terminalHost.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
	state.terminalHost.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
	state.terminalHost.addEventListener("touchcancel", onTouchEnd, { capture: true, passive: true });
	return () => {
		state.terminalHost.removeEventListener("touchstart", onTouchStart, { capture: true });
		state.terminalHost.removeEventListener("touchmove", onTouchMove, { capture: true });
		state.terminalHost.removeEventListener("touchend", onTouchEnd, { capture: true });
		state.terminalHost.removeEventListener("touchcancel", onTouchEnd, { capture: true });
	};
}

function scrollTerminalByTouchDelta(state: SessionState, tracking: { lineRemainder: number }, deltaY: number): void {
	const term = state.term;
	if (!term) return;
	const rowHeight = terminalRowHeight(state);
	const rawLines = tracking.lineRemainder - (deltaY / rowHeight);
	const lines = rawLines < 0 ? Math.ceil(rawLines) : Math.floor(rawLines);
	tracking.lineRemainder = rawLines - lines;
	if (lines === 0) return;
	try {
		term.scrollLines(lines);
		updateFollowOutputFromViewport(state);
	} catch {
		// Ignore scroll failures from a terminal that is mid-dispose or not fully mounted.
	}
}

function terminalRowHeight(state: SessionState): number {
	const termRows = state.term?.rows ?? 0;
	const screen = state.terminalHost.querySelector(".xterm-screen") as HTMLElement | null;
	const screenHeight = screen?.getBoundingClientRect().height ?? 0;
	if (termRows > 0 && screenHeight > 0) return Math.max(1, screenHeight / termRows);
	const viewport = state.terminalHost.querySelector(".xterm-viewport") as HTMLElement | null;
	const viewportHeight = viewport?.clientHeight ?? 0;
	if (termRows > 0 && viewportHeight > 0) return Math.max(1, viewportHeight / termRows);
	return 16;
}

function canFitTerminal(state: SessionState): boolean {
	if (!state.term || !state.fit || !state.root.isConnected || !state.terminalHost.isConnected) return false;
	const rootStyle = getComputedStyle(state.root);
	const hostStyle = getComputedStyle(state.terminalHost);
	if (rootStyle.display === "none" || hostStyle.display === "none") return false;
	if (rootStyle.visibility === "hidden" || hostStyle.visibility === "hidden") return false;
	if (state.root.getClientRects().length === 0 || state.terminalHost.getClientRects().length === 0) return false;
	const rootRect = state.root.getBoundingClientRect();
	const hostRect = state.terminalHost.getBoundingClientRect();
	return isUsableRect(rootRect) && isUsableRect(hostRect);
}

function isUsableRect(rect: DOMRect): boolean {
	return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width >= 2 && rect.height >= 2;
}

function currentTerminalSize(state: SessionState): { cols: number; rows: number } | undefined {
	const cols = state.term?.cols ?? 0;
	const rows = state.term?.rows ?? 0;
	return cols > 0 && rows > 0 ? { cols, rows } : undefined;
}

function sizeKey(size: { cols: number; rows: number }): string {
	return `${size.cols}x${size.rows}`;
}

function setError(state: SessionState, err: unknown): void {
	setStatus(state, messageOf(err, "Terminal error."), "error");
}

function setStatus(state: SessionState, text: string, terminalState: SessionState["terminalState"]): void {
	state.status = text;
	state.terminalState = terminalState;
	state.statusEl.textContent = text;
	state.root.setAttribute("data-terminal-state", terminalState);
	updateButtons(state);
}

function updateButtons(state: SessionState): void {
	const open = state.channel?.state === "open";
	state.startButton.textContent = state.terminalState === "exited" || state.terminalState === "killed" || state.terminalState === "disconnected" || state.terminalState === "error" ? "Restart" : "Start";
	state.startButton.disabled = state.connecting === true || state.terminalState === "connecting" || open;
	state.killButton.disabled = !open;
}

function closePanel(root: HTMLElement): void {
	const pane = root.closest("[data-panel-tab-id]") as HTMLElement | null;
	const id = pane?.dataset?.panelTabId;
	const close = id ? document.querySelector(`[data-testid="side-panel-tab"][data-panel-tab-id="${cssEscape(id)}"] [data-testid="side-panel-close"]`) as HTMLElement | null : null;
	close?.click();
}

function button(label: string, title: string): HTMLButtonElement {
	const b = document.createElement("button");
	b.type = "button";
	b.textContent = label;
	b.title = title;
	b.setAttribute("aria-label", title);
	return b;
}

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
	return style.getPropertyValue(name).trim() || fallback;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function messageOf(err: unknown, fallback: string): string {
	return err instanceof Error && err.message ? err.message : typeof err === "string" && err ? err : fallback;
}

function cssEscape(value: string): string {
	return globalThis.CSS?.escape ? CSS.escape(value) : value.replace(/"/g, "\\\"");
}

function installStyles(): void {
	if (document.getElementById("bb-terminal-styles")) return;
	const style = document.createElement("style");
	style.id = "bb-terminal-styles";
	style.textContent = `
/* xterm.js required layout rules. Keep these before Bobbit theme overrides. */
.bb-terminal-host .xterm{cursor:text;position:relative;overflow:hidden;user-select:none;-ms-user-select:none;-webkit-user-select:none;}
.bb-terminal-host .xterm.focus,.bb-terminal-host .xterm:focus{outline:none;}
.bb-terminal-host .xterm .xterm-helpers{position:absolute;top:0;z-index:5;}
.bb-terminal-host .xterm .xterm-helper-textarea{padding:0;border:0;margin:0;position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-5;white-space:nowrap;overflow:hidden;resize:none;}
.bb-terminal-host .xterm .composition-view{background:var(--background);color:var(--foreground);display:none;position:absolute;white-space:nowrap;z-index:1;}
.bb-terminal-host .xterm .composition-view.active{display:block;}
.bb-terminal-host .xterm .xterm-viewport,.bb-terminal-host .xterm .xterm-scrollable-element{overscroll-behavior:contain;touch-action:pan-y;}
.bb-terminal-host .xterm .xterm-viewport{background-color:var(--background);overflow-y:scroll;cursor:default;position:absolute;right:0;left:0;top:0;bottom:0;}
.bb-terminal-host .xterm .xterm-screen{position:relative;touch-action:pan-y;}
.bb-terminal-host .xterm .xterm-rows,.bb-terminal-host .xterm .xterm-screen canvas{touch-action:pan-y;}
.bb-terminal-host .xterm .xterm-screen canvas{position:absolute;left:0;top:0;}
.bb-terminal-host .xterm-char-measure-element{display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;line-height:normal;}
.bb-terminal-host .xterm.enable-mouse-events{cursor:default;}
.bb-terminal-host .xterm.xterm-cursor-pointer,.bb-terminal-host .xterm .xterm-cursor-pointer{cursor:pointer;}
.bb-terminal-host .xterm.column-select.focus{cursor:crosshair;}
.bb-terminal-host .xterm .xterm-accessibility:not(.debug),.bb-terminal-host .xterm .xterm-message{position:absolute;left:0;top:0;bottom:0;right:0;z-index:10;color:transparent;pointer-events:none;}
.bb-terminal-host .xterm .xterm-accessibility-tree:not(.debug) *::selection{color:transparent;}
.bb-terminal-host .xterm .xterm-accessibility-tree{font-family:monospace;user-select:text;white-space:pre;}
.bb-terminal-host .xterm .xterm-accessibility-tree>div{transform-origin:left;width:fit-content;}
.bb-terminal-host .xterm .live-region{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;}
.bb-terminal-host .xterm-dim{opacity:1!important;}
.bb-terminal-host .xterm-underline-1{text-decoration:underline;}
.bb-terminal-host .xterm-underline-2{text-decoration:double underline;}
.bb-terminal-host .xterm-underline-3{text-decoration:wavy underline;}
.bb-terminal-host .xterm-underline-4{text-decoration:dotted underline;}
.bb-terminal-host .xterm-underline-5{text-decoration:dashed underline;}
.bb-terminal-host .xterm-overline{text-decoration:overline;}
.bb-terminal-host .xterm-overline.xterm-underline-1{text-decoration:overline underline;}
.bb-terminal-host .xterm-overline.xterm-underline-2{text-decoration:overline double underline;}
.bb-terminal-host .xterm-overline.xterm-underline-3{text-decoration:overline wavy underline;}
.bb-terminal-host .xterm-overline.xterm-underline-4{text-decoration:overline dotted underline;}
.bb-terminal-host .xterm-overline.xterm-underline-5{text-decoration:overline dashed underline;}
.bb-terminal-host .xterm-strikethrough{text-decoration:line-through;}
.bb-terminal-host .xterm-screen .xterm-decoration-container .xterm-decoration{z-index:6;position:absolute;}
.bb-terminal-host .xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer{z-index:7;}
.bb-terminal-host .xterm-decoration-overview-ruler{z-index:8;position:absolute;top:0;right:0;pointer-events:none;}
.bb-terminal-host .xterm-decoration-top{z-index:2;position:relative;}
.bb-terminal-host .xterm .xterm-scrollable-element>.scrollbar{cursor:default;}
.bb-terminal-host .xterm .xterm-scrollable-element>.scrollbar>.scra{cursor:pointer;font-size:11px!important;}
.bb-terminal-host .xterm .xterm-scrollable-element>.visible{opacity:1;background:transparent;transition:opacity 100ms linear;z-index:11;}
.bb-terminal-host .xterm .xterm-scrollable-element>.invisible{opacity:0;pointer-events:none;}
.bb-terminal-host .xterm .xterm-scrollable-element>.invisible.fade{transition:opacity 800ms linear;}
.bb-terminal-host .xterm .xterm-scrollable-element>.shadow{position:absolute;display:none;}
.bb-terminal-host .xterm .xterm-scrollable-element>.shadow.top{display:block;top:0;left:3px;height:3px;width:100%;box-shadow:var(--border) 0 6px 6px -6px inset;}
.bb-terminal-host .xterm .xterm-scrollable-element>.shadow.left{display:block;top:3px;left:0;height:100%;width:3px;box-shadow:var(--border) 6px 0 6px -6px inset;}
.bb-terminal-host .xterm .xterm-scrollable-element>.shadow.top-left-corner{display:block;top:0;left:0;height:3px;width:3px;}
.bb-terminal-host .xterm .xterm-scrollable-element>.shadow.top.left{box-shadow:var(--border) 6px 0 6px -6px inset;}
.bb-terminal-host .xterm-scroll-area{visibility:hidden;}
/* Bobbit panel/theme overrides. */
.bb-terminal-panel{display:flex;flex-direction:column;min-height:0;height:100%;background:var(--background);color:var(--foreground);}
.bb-terminal-toolbar{display:flex;align-items:center;gap:.75rem;padding:.5rem .75rem;border-bottom:1px solid var(--border);background:var(--card);}
.bb-terminal-title{font-weight:600;font-size:.875rem;white-space:nowrap;}
.bb-terminal-status{font-size:.75rem;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.bb-terminal-actions{display:flex;gap:.4rem;}
.bb-terminal-actions button{font:inherit;font-size:.75rem;border:1px solid var(--border);border-radius:.4rem;background:var(--background);color:var(--foreground);padding:.25rem .5rem;cursor:pointer;}
.bb-terminal-actions button:hover:not(:disabled){border-color:var(--primary);color:var(--primary);}
.bb-terminal-actions button:disabled{opacity:.45;cursor:not-allowed;}
.bb-terminal-host{flex:1;min-height:0;padding:.5rem;background:var(--background);overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;}
.bb-terminal-host .xterm{width:100%;height:100%;padding:0;}
.bb-terminal-host .xterm.focus,.bb-terminal-host .xterm:focus{outline:1px solid color-mix(in oklch,var(--primary) 55%,transparent);}
.bb-terminal-host .xterm .xterm-viewport{background:transparent!important;}
`;
	document.head.append(style);
}
