import "../../src/ui/components/AgentInterface.js";

type Listener = (event: any) => void | Promise<void>;
type FixtureMessage = Record<string, any>;

let activeSession: FixtureSession | null = null;
let logicalClock = 0;

function nextClock(): number {
	logicalClock += 1;
	return logicalClock;
}

function textChunk(text: string): Array<{ type: "text"; text: string }> {
	return [{ type: "text", text }];
}

function makeTurn(prefix: string, index: number): FixtureMessage[] {
	const t = nextClock();
	return [
		{ id: `${prefix}-u-${index}`, role: "user", content: `Prompt ${prefix} ${index}`, timestamp: t, _order: t },
		{
			id: `${prefix}-a-${index}`,
			role: "assistant",
			content: textChunk(`Assistant ${prefix} ${index}\n\n${"tail-follow fixture line\n".repeat(4)}`),
			timestamp: t + 0.1,
			_order: t + 0.1,
		},
	];
}

function buildTranscript(prefix: string, turns: number): FixtureMessage[] {
	const messages: FixtureMessage[] = [];
	for (let i = 0; i < turns; i++) messages.push(...makeTurn(prefix, i + 1));
	return messages;
}

class FixtureSession {
	sessionId = "chat-scroll-fixture";
	streamFn = async () => { throw new Error("chat-scroll fixture streamFn should be replaced by AgentInterface"); };
	getApiKey = async () => "fixture-key";
	private listeners = new Set<Listener>();
	state: any = {
		messages: [],
		isStreaming: false,
		status: "idle",
		model: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
		thinkingLevel: "off",
		tools: [],
		pendingToolCalls: new Set<string>(),
		streamingMessage: null,
		usage: null,
		cost: 0,
	};

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: any): void {
		for (const listener of this.listeners) void listener(event);
	}

	replaceTranscript(prefix: string, turns: number): void {
		this.state.messages = buildTranscript(prefix, turns);
		this.state.streamingMessage = null;
		this.state.isStreaming = false;
		this.state.status = "idle";
		this.emit({ type: "state_update" });
	}

	appendTurn(prefix: string, index = Math.floor(nextClock())): void {
		this.state.messages = [...this.state.messages, ...makeTurn(prefix, index)];
		this.emit({ type: "state_update" });
	}

	updateStreaming(prefix: string, lineCount: number): void {
		const id = `${prefix}-streaming`;
		const t = nextClock();
		const message = {
			id,
			role: "assistant",
			content: textChunk(`Streaming ${prefix}\n\n${Array.from({ length: lineCount }, (_, i) => `stream line ${i + 1}`).join("\n")}`),
			timestamp: t,
			_order: t,
		};
		this.state.isStreaming = true;
		this.state.status = "running";
		this.state.streamingMessage = message;
		this.emit({ type: "message_update", message });
	}

	finishStreaming(prefix: string): void {
		const msg = this.state.streamingMessage ?? {
			id: `${prefix}-streaming`,
			role: "assistant",
			content: textChunk(`Streaming ${prefix} complete`),
			timestamp: nextClock(),
			_order: nextClock(),
		};
		this.state.messages = [...this.state.messages, msg];
		this.state.streamingMessage = null;
		this.state.isStreaming = false;
		this.state.status = "idle";
		this.emit({ type: "message_end", message: msg });
		this.emit({ type: "state_update" });
	}

	async prompt(_input: string): Promise<void> {}
	abort(): void {}
	getQueue(): any[] { return []; }
}

let currentAgentInterface: any = null;

function installCss(): void {
	if (document.getElementById("chat-scroll-fixture-css")) return;
	const style = document.createElement("style");
	style.id = "chat-scroll-fixture-css";
	style.textContent = `
		:root { --background:#fff; --foreground:#111; --muted:#f3f4f6; --border:#d1d5db; --input:#d1d5db; --card:#fff; }
		html, body, #app { height: 100%; margin: 0; overflow: hidden; }
		body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		#app { width: 100vw; height: 100vh; }
		agent-interface { display:flex; flex-direction:column; height:100%; min-height:0; }
		.flex { display:flex; } .inline-flex { display:inline-flex; } .flex-col { flex-direction:column; }
		.flex-1 { flex:1 1 0%; } .shrink-0 { flex-shrink:0; } .min-h-0 { min-height:0; } .min-w-0 { min-width:0; }
		.h-full { height:100%; } .relative { position:relative; } .absolute { position:absolute; } .inset-0 { inset:0; }
		.overflow-y-auto { overflow-y:auto; } .overflow-x-hidden { overflow-x:hidden; } .overflow-hidden { overflow:hidden; }
		.max-w-5xl { max-width:64rem; } .mx-auto { margin-left:auto; margin-right:auto; }
		.p-2 { padding:8px; } .p-4, .sm\:p-4 { padding:16px; } .pb-0 { padding-bottom:0; }
		.px-1 { padding-left:4px; padding-right:4px; } .px-1\.5 { padding-left:6px; padding-right:6px; }
		.px-2 { padding-left:8px; padding-right:8px; } .px-3 { padding-left:12px; padding-right:12px; }
		.py-0\.5 { padding-top:2px; padding-bottom:2px; } .py-1\.5 { padding-top:6px; padding-bottom:6px; }
		.pt-0 { padding-top:0; } .pb-1 { padding-bottom:4px; }
		.left-1\/2 { left:50%; } .-translate-x-1\/2 { transform:translateX(-50%); }
		.right-2 { right:8px; } .bottom-full { bottom:100%; } .mb-3 { margin-bottom:12px; }
		.z-10 { z-index:10; } .z-50 { z-index:50; } .items-center { align-items:center; } .items-stretch { align-items:stretch; } .items-start { align-items:flex-start; }
		.justify-end { justify-content:flex-end; } .justify-center { justify-content:center; }
		.flex-wrap { flex-wrap:wrap; } .flex-nowrap { flex-wrap:nowrap; }
		.gap-1 { gap:4px; } .gap-1\.5 { gap:6px; }
		.text-xs, .text-\[12px\] { font-size:12px; } .leading-tight { line-height:1.25; }
		.rounded-full { border-radius:9999px; } .rounded-l-full { border-top-left-radius:9999px; border-bottom-left-radius:9999px; }
		.rounded-r-full { border-top-right-radius:9999px; border-bottom-right-radius:9999px; }
		.border { border:1px solid var(--border); } .border-l { border-left:1px solid var(--border); }
		.border-border, .border-input { border-color:var(--border); } .bg-card, .bg-background { background:var(--background); }
		.text-foreground { color:var(--foreground); } .text-muted-foreground, .text-muted-foreground\/50 { color:#4b5563; }
		.hover\:bg-muted:hover { background:var(--muted); } .hover\:text-foreground:hover { color:var(--foreground); }
		.shadow-sm { box-shadow:0 1px 2px rgba(0,0,0,.08); } .whitespace-nowrap { white-space:nowrap; }
		.pointer-events-auto { pointer-events:auto; } .cursor-pointer { cursor:pointer; } .transition-colors { transition:color 150ms ease; }
		.font-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
		.truncate { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		button { font:inherit; }
		message-list, streaming-message-container { display:block; }
		user-message, assistant-message, tool-message { display:block; margin:8px; padding:12px; border-radius:8px; background:#eef2ff; box-sizing:border-box; }
		tool-message { background:#ecfeff; }
		#__tail_chat_pre_spacer, #__jtb_spacer, #__pre_spacer { background:linear-gradient(#eef, #fee); }
		[data-pill-strip] { box-sizing:border-box; }
		[data-pill-content] { min-height:var(--pill-h, 22px); }
		[data-more-btn] button { white-space:nowrap; }
		.pill-more-popover { align-items:flex-start; }
	`;
	document.head.appendChild(style);
}

function getAi(): any {
	if (!currentAgentInterface) throw new Error("agent-interface not mounted");
	return currentAgentInterface;
}

function getScrollContainer(): HTMLElement {
	const el = document.querySelector("agent-interface .overflow-y-auto") as HTMLElement | null;
	if (!el) throw new Error("scroll container not found");
	return el;
}

function getMessageRoot(): HTMLElement {
	const root = document.querySelector("agent-interface message-list") as HTMLElement | null;
	if (!root) throw new Error("message-list root not found");
	return root;
}

function nextFrames(frames = 2): Promise<void> {
	return new Promise<void>((resolve) => {
		const step = (remaining: number) => remaining <= 0 ? resolve() : requestAnimationFrame(() => step(remaining - 1));
		step(frames);
	});
}

async function refreshJumpButtons(): Promise<void> {
	const ai = getAi();
	ai._refreshJumpButton?.();
	await ai.updateComplete;
	await nextFrames(1);
}

async function setPromptTranscript(options: {
	prompts?: number;
	fillerBefore?: number;
	fillerAfter?: number;
	promptHeight?: number;
	scrollTop?: number | "bottom";
} = {}): Promise<void> {
	const prompts = options.prompts ?? 3;
	const fillerBefore = options.fillerBefore ?? 320;
	const fillerAfter = options.fillerAfter ?? 520;
	const promptHeight = options.promptHeight ?? 56;
	const root = getMessageRoot();
	root.replaceChildren();
	for (let i = 0; i < prompts; i++) {
		const before = document.createElement("div");
		before.setAttribute("data-fixture-filler", `before-${i}`);
		before.style.height = `${i === 0 ? fillerBefore : fillerAfter}px`;
		before.style.background = i % 2 === 0 ? "#f8fafc" : "#f1f5f9";
		root.appendChild(before);

		const prompt = document.createElement("user-message");
		prompt.setAttribute("data-fixture-prompt", String(i));
		prompt.textContent = `fixture prompt ${i + 1}`;
		prompt.style.display = "block";
		prompt.style.height = `${promptHeight}px`;
		prompt.style.margin = "0 8px";
		prompt.style.padding = "12px";
		prompt.style.boxSizing = "border-box";
		root.appendChild(prompt);
	}
	const tail = document.createElement("div");
	tail.setAttribute("data-fixture-filler", "tail");
	tail.style.height = `${fillerAfter}px`;
	tail.style.background = "#eef2ff";
	root.appendChild(tail);

	const scroller = getScrollContainer();
	const ai = getAi();
	if (options.scrollTop === "bottom") {
		ai._isAtBottom = true;
		ai._escapedFromLock = false;
		scroller.scrollTop = scroller.scrollHeight;
	} else if (typeof options.scrollTop === "number") {
		ai._isAtBottom = false;
		ai._escapedFromLock = true;
		scroller.scrollTop = options.scrollTop;
	}
	scroller.dispatchEvent(new Event("scroll"));
	await refreshJumpButtons();
}

function classifyPrompts(): { above: number; inView: number; below: number; userCount: number } {
	const scroller = getScrollContainer();
	const cr = scroller.getBoundingClientRect();
	let above = 0;
	let inView = 0;
	let below = 0;
	for (const node of Array.from(scroller.querySelectorAll("user-message")) as HTMLElement[]) {
		const r = node.getBoundingClientRect();
		if (r.bottom < cr.top) above++;
		else if (r.top > cr.bottom) below++;
		else inView++;
	}
	return { above, inView, below, userCount: above + inView + below };
}

function readJumpState(): {
	upVisible: boolean;
	bottomVisible: boolean;
	splitPresent: boolean;
	upTop: string | null;
	bottomStyleBottom: string | null;
} {
	const visible = (el: HTMLElement | null | undefined) => !!el && el.style.opacity === "1";
	const up = document.querySelector('[data-testid="jump-to-previous-prompt"]') as HTMLElement | null;
	const split = document.querySelector('[data-testid="jump-to-bottom-split"]') as HTMLElement | null;
	const bottomEls = Array.from(document.querySelectorAll('[data-testid="jump-to-bottom"]')) as HTMLElement[];
	const standalone = bottomEls.find((el) => !el.closest('[data-testid="jump-to-bottom-split"]'));
	const inSplit = bottomEls.find((el) => el.closest('[data-testid="jump-to-bottom-split"]'));
	return {
		upVisible: visible(up),
		bottomVisible: visible(standalone) || visible(inSplit),
		splitPresent: !!split,
		upTop: up?.style.top ?? null,
		bottomStyleBottom: (split ?? standalone)?.style.bottom ?? null,
	};
}

async function setScrollerTop(scrollTop: number | "bottom"): Promise<void> {
	const scroller = getScrollContainer();
	const ai = getAi();
	ai._isAtBottom = scrollTop === "bottom";
	ai._escapedFromLock = scrollTop !== "bottom";
	scroller.scrollTop = scrollTop === "bottom" ? scroller.scrollHeight : scrollTop;
	scroller.dispatchEvent(new Event("scroll"));
	await refreshJumpButtons();
}

function promptOffset(index: number): number {
	const scroller = getScrollContainer();
	const prompt = scroller.querySelector(`user-message[data-fixture-prompt="${index}"]`) as HTMLElement | null;
	if (!prompt) throw new Error(`prompt ${index} not found`);
	return Math.round(prompt.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
}

function installMobileHeader(height = 60): void {
	let header = document.getElementById("app-header");
	if (!header) {
		header = document.createElement("div");
		header.id = "app-header";
		header.textContent = "Mobile header";
		document.body.prepend(header);
	}
	document.documentElement.style.setProperty("--mobile-header-height", `${height}px`);
	header.style.position = "fixed";
	header.style.top = "0";
	header.style.left = "0";
	header.style.right = "0";
	header.style.height = `${height}px`;
	header.style.zIndex = "30";
	header.style.background = "var(--background)";
}

async function seedPills(count: number): Promise<string[]> {
	await customElements.whenDefined("bg-process-pill");
	const startTime = Date.now();
	const processes = Array.from({ length: count }, (_, i) => ({
		id: `fixture-pill-${i + 1}`,
		name: `qa-pill-xxxxxx-${String(i + 1).padStart(2, "0")}`,
		command: "fixture long-running command",
		pid: 20_000 + i,
		status: "running" as const,
		exitCode: null,
		terminalReason: null,
		startTime: startTime + i,
		endTime: null,
	}));
	const ai = getAi();
	ai.bgProcesses = processes;
	ai.requestUpdate();
	await ai.updateComplete;
	await Promise.all(Array.from(document.querySelectorAll("bg-process-pill")).map((el: any) => el.updateComplete ?? Promise.resolve()));
	ai._measurePillOverflow?.();
	await ai.updateComplete;
	await nextFrames(2);
	return processes.map((p) => p.id);
}

async function dismissPills(ids: string[]): Promise<void> {
	const ai = getAi();
	ai.bgProcesses = (ai.bgProcesses ?? []).filter((p: { id: string }) => !ids.includes(p.id));
	ai.requestUpdate();
	await ai.updateComplete;
	ai._measurePillOverflow?.();
	await ai.updateComplete;
	await nextFrames(2);
}

function visibleStripPillIds(): string[] {
	const content = document.querySelector("[data-pill-content]");
	if (!content) return [];
	return Array.from(content.children)
		.filter((child) => !(child as HTMLElement).querySelector(".pill-more-popover") && !(child as HTMLElement).hasAttribute("data-more-btn"))
		.flatMap((child) => Array.from(child.querySelectorAll("bg-process-pill[data-id]")))
		.map((el) => el.getAttribute("data-id") || "")
		.filter(Boolean);
}

function pillMetrics(): {
	visible: number;
	hidden: number;
	stripHeight: number;
	moreButtonHeight: number;
	contentFlexWrap: string;
	stripMaxWidth: string;
	popoverAlignItems: string | null;
} {
	const strip = document.querySelector("[data-pill-strip]") as HTMLElement | null;
	const content = document.querySelector("[data-pill-content]") as HTMLElement | null;
	const more = document.querySelector("[data-more-btn] button") as HTMLElement | null;
	const popover = document.querySelector(".pill-more-popover") as HTMLElement | null;
	const visible = visibleStripPillIds().length;
	return {
		visible,
		hidden: Math.max(0, (getAi().bgProcesses?.length ?? 0) - visible),
		stripHeight: strip?.offsetHeight ?? 0,
		moreButtonHeight: more?.offsetHeight ?? 0,
		contentFlexWrap: content ? getComputedStyle(content).flexWrap : "",
		stripMaxWidth: strip ? getComputedStyle(strip).maxWidth : "",
		popoverAlignItems: popover ? getComputedStyle(popover).alignItems : null,
	};
}

async function mount(opts: { prefix?: string; turns?: number } = {}): Promise<void> {
	installCss();
	(window as any).fetch = async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
	(window as any).WebSocket = class FixtureWebSocket {
		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;
		readyState = FixtureWebSocket.OPEN;
		addEventListener(): void {}
		send(): void {}
		close(): void { this.readyState = FixtureWebSocket.CLOSED; }
	};
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.replaceChildren();
	activeSession = new FixtureSession();
	if (opts.turns) activeSession.replaceTranscript(opts.prefix ?? "mount", opts.turns);
	const ai = document.createElement("agent-interface") as any;
	ai.session = activeSession;
	ai.readOnly = true;
	ai.nonInteractive = false;
	ai.gitRepoKnown = "no";
	ai.enableAttachments = false;
	ai.enableModelSelector = false;
	ai.enableThinkingSelector = false;
	app.appendChild(ai);
	currentAgentInterface = ai;
	await customElements.whenDefined("agent-interface");
	await ai.updateComplete;
	await nextFrames(2);
	const scroll = document.querySelector("agent-interface .overflow-y-auto");
	if (!scroll) throw new Error("scroll container not mounted");
}

function session(): FixtureSession {
	if (!activeSession) throw new Error("chat scroll fixture is not mounted");
	return activeSession;
}

(window as any).__mountChatScrollFixture = mount;
(window as any).__chatScrollFixture = {
	replaceTranscript: (prefix: string, turns: number) => session().replaceTranscript(prefix, turns),
	appendTurn: (prefix: string, index?: number) => session().appendTurn(prefix, index),
	updateStreaming: (prefix: string, lineCount: number) => session().updateStreaming(prefix, lineCount),
	finishStreaming: (prefix: string) => session().finishStreaming(prefix),
	messageCount: () => session().state.messages.length,
	setPromptTranscript,
	classifyPrompts,
	readJumpState,
	refreshJumpButtons,
	setScrollerTop,
	promptOffset,
	installMobileHeader,
	seedPills,
	dismissPills,
	pillMetrics,
	settle: nextFrames,
};
(window as any).__chatScrollReady = true;
