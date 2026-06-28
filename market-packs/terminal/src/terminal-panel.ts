import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const SINGLETON_KEY = "session-terminal";
const MAX_SCROLLBACK = 5000;

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
	channel?: HostChannel;
	disposers: Array<() => void>;
	status: string;
	terminalState: "idle" | "connecting" | "attached" | "detached" | "exited" | "killed" | "disconnected" | "error";
	connecting?: boolean;
	autoStartAttempted?: boolean;
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
			if (typeof params?.startupError === "string" && params.startupError && params.startupError !== state.startupError) {
				state.startupError = params.startupError;
				setStatus(state, params.startupError, "error");
			}
			queueMicrotask(() => {
				ensureTerminalMounted(state);
				const autoStart = params?.autoStart === true && !state.autoStartAttempted;
				if (autoStart) state.autoStartAttempted = true;
				if (!state.startupError && !state.attachAttempted) {
					state.attachAttempted = true;
					void attachOrOfferStart(state, autoStart);
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
	const inputDisposable = term.onData((data) => { void state.channel?.send({ kind: "text", data }).catch((err) => setError(state, err)); });
	state.disposers.push(() => inputDisposable.dispose());
	state.resizeObserver = new ResizeObserver(() => scheduleFitAndResize(state));
	state.resizeObserver.observe(state.terminalHost);
	scheduleFitAndResize(state);
}

async function attachOrOfferStart(state: SessionState, autoStart: boolean): Promise<void> {
	if (state.channel || state.connecting) return;
	const host = state.host;
	if (!host?.capabilities?.channels || !host.channels) {
		setStatus(state, "Terminal channels are unavailable in this host.", "error");
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
		setStatus(state, "No live terminal. Press Start to create one.", "idle");
	} catch (err) {
		setStatus(state, messageOf(err, "Could not attach terminal."), "disconnected");
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
		fitNow(state);
		const channel = await host.channels.open("terminal", {
			singletonKey: SINGLETON_KEY,
			data: { cols: state.term?.cols || 80, rows: state.term?.rows || 24 },
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
	if (state.disposers.length <= 1) return;
	const keep = state.disposers.slice(0, 1);
	for (const dispose of state.disposers.slice(1)) {
		try { dispose(); } catch { /* ignore */ }
	}
	state.disposers = keep;
}

function handleFrame(state: SessionState, frame: HostChannelFrame): void {
	if (frame.kind === "text") {
		state.term?.write(frame.data);
		return;
	}
	const data = objectOf(frame.data);
	if (!data) return;
	if (data.op === "status") {
		setStatus(state, typeof data.state === "string" ? `Terminal ${data.state}.` : "Terminal attached.", "attached");
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
	requestAnimationFrame(() => {
		const before = `${state.term?.cols}x${state.term?.rows}`;
		fitNow(state);
		const after = `${state.term?.cols}x${state.term?.rows}`;
		if (state.channel?.state === "open" && before !== after && state.term?.cols && state.term.rows) {
			void state.channel.send({ kind: "json", data: { op: "resize", cols: state.term.cols, rows: state.term.rows } }).catch((err) => setError(state, err));
		}
	});
}

function fitNow(state: SessionState): void {
	try { state.fit?.fit(); } catch { /* hidden or not yet measurable */ }
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
	state.startButton.disabled = state.connecting === true || open;
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
.bb-terminal-panel{display:flex;flex-direction:column;min-height:0;height:100%;background:var(--background);color:var(--foreground);}
.bb-terminal-toolbar{display:flex;align-items:center;gap:.75rem;padding:.5rem .75rem;border-bottom:1px solid var(--border);background:var(--card);}
.bb-terminal-title{font-weight:600;font-size:.875rem;white-space:nowrap;}
.bb-terminal-status{font-size:.75rem;color:var(--muted-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.bb-terminal-actions{display:flex;gap:.4rem;}
.bb-terminal-actions button{font:inherit;font-size:.75rem;border:1px solid var(--border);border-radius:.4rem;background:var(--background);color:var(--foreground);padding:.25rem .5rem;cursor:pointer;}
.bb-terminal-actions button:hover:not(:disabled){border-color:var(--primary);color:var(--primary);}
.bb-terminal-actions button:disabled{opacity:.45;cursor:not-allowed;}
.bb-terminal-host{flex:1;min-height:0;padding:.5rem;background:var(--background);overflow:hidden;}
.bb-terminal-host .xterm{height:100%;padding:0;position:relative;user-select:none;-ms-user-select:none;-webkit-user-select:none;}
.bb-terminal-host .xterm.focus,.bb-terminal-host .xterm:focus{outline:1px solid color-mix(in oklch,var(--primary) 55%,transparent);}
.bb-terminal-host .xterm-viewport{background:transparent!important;overflow-y:auto;cursor:default;position:absolute;inset:0;}
.bb-terminal-host .xterm-screen{position:relative;}
.bb-terminal-host .xterm-rows{position:absolute;left:0;top:0;white-space:nowrap;}
.bb-terminal-host .xterm-rows span{display:inline-block;}
.bb-terminal-host .xterm-cursor-layer,.bb-terminal-host .xterm-text-layer,.bb-terminal-host .xterm-selection-layer,.bb-terminal-host .xterm-link-layer{position:absolute;left:0;top:0;}
.bb-terminal-host .xterm-helper-textarea{position:absolute;opacity:0;left:-9999em;top:0;width:0;height:0;z-index:-10;white-space:nowrap;overflow:hidden;resize:none;}
.bb-terminal-host .xterm-accessibility,.bb-terminal-host .xterm-message{position:absolute;left:0;top:0;}
`;
	document.head.append(style);
}
