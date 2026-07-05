// Test entry for UX-04: the bg-process pill strip's "N more" popover has no
// Escape/keyboard dismissal, and its deferred click-outside listener can leak
// when the popover is toggled open+closed within the same animation frame.
// Mounts the real <agent-interface> with mocked bgProcesses and forces
// _visiblePillCount directly (bypassing the ResizeObserver-driven overflow
// measurement, which depends on real layout timing) so the "N more" pill
// renders deterministically. This exercises the exact production code path —
// _toggleMore / _handleMoreClickOutside / _handleMoreKeyDown in
// src/ui/components/AgentInterface.ts — rather than a mock of it.
import "../../src/ui/components/AgentInterface.js";

type Listener = (event: any) => void | Promise<void>;

class FixtureSession {
	sessionId = "more-popover-fixture";
	streamFn: any = Object.assign(async function* () {}, { __isDefault: true });
	getApiKey = async () => "fixture-key";
	private listeners = new Set<Listener>();
	state: any;
	abortCallCount = 0;

	constructor(isStreaming: boolean) {
		this.state = {
			messages: [
				{ id: "u1", role: "user", content: [{ type: "text", text: "Do the thing" }] },
			],
			isStreaming,
			status: isStreaming ? "streaming" : "idle",
			model: { provider: "claude-code", id: "claude-opus-4-8", name: "Claude Code Opus 4.8", runtime: "claude-code", contextWindow: 200_000, reasoning: true },
			thinkingLevel: "off",
			tools: [],
			pendingToolCalls: new Set<string>(),
			streamingMessage: null,
			serverCost: { totalCost: 0 },
			runtime: "claude-code",
		};
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: any): void {
		for (const listener of this.listeners) void listener(event);
	}

	async prompt(_input: string): Promise<void> {}
	abort(): void {
		this.abortCallCount++;
	}
	getQueue(): any[] {
		return [];
	}
}

function installCss(): void {
	if (document.getElementById("agent-interface-more-popover-fixture-css")) return;
	const style = document.createElement("style");
	style.id = "agent-interface-more-popover-fixture-css";
	style.textContent = `
		:root { --background:#fff; --foreground:#111; --muted:#f3f4f6; --muted-foreground:#4b5563; --border:#d1d5db; --input:#d1d5db; --card:#fff; --popover:#fff; --popover-foreground:#111; --primary:#2563eb; --warning:#f59e0b; --destructive:#ef4444; }
		html, body, #app { height:100%; margin:0; overflow:hidden; }
		body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
		#app { width:100vw; height:100vh; }
		agent-interface { display:flex; flex-direction:column; height:100%; min-height:0; }
		.flex { display:flex; } .flex-col { flex-direction:column; } .flex-1 { flex:1 1 0%; } .shrink-0 { flex-shrink:0; } .min-h-0 { min-height:0; }
		message-list, streaming-message-container, user-message, assistant-message, tool-message { display:block; }
		button { font:inherit; }
	`;
	document.head.appendChild(style);
}

let session: FixtureSession | undefined;

function mockBgProcesses(count: number): any[] {
	const startTime = Date.now();
	return Array.from({ length: count }, (_, i) => ({
		id: `mock-bg-${i + 1}`,
		name: `proc-${i + 1}`,
		command: "sleep 999",
		pid: 10_000 + i,
		status: "running" as const,
		exitCode: null,
		terminalReason: null,
		startTime: startTime + i,
		endTime: null,
	}));
}

async function mountFixture(options: { isStreaming?: boolean; processCount?: number; visibleCount?: number } = {}): Promise<void> {
	installCss();
	const app = document.getElementById("app");
	if (!app) throw new Error("#app missing");
	app.replaceChildren();
	const el = document.createElement("agent-interface") as any;
	session = new FixtureSession(options.isStreaming === true);
	el.session = session;
	el.sessionRuntime = "claude-code";
	el.enableModelSelector = false;
	el.enableThinkingSelector = false;
	el.enableAttachments = false;
	el.gitRepoKnown = "no";
	el.bgProcesses = mockBgProcesses(options.processCount ?? 5);
	app.appendChild(el);
	await customElements.whenDefined("agent-interface");
	await el.updateComplete;
	// Force the overflow split directly instead of relying on the
	// ResizeObserver-driven real-layout measurement (_measurePillOverflow):
	// with a default viewport all 5 mock pills easily fit in one row, so the
	// real measurement (which is already scheduled via a queued rAF from the
	// bgProcesses-set render above) would recompute _visiblePillCount back up
	// and race with the override below. Neutralize it for this fixture — same
	// private-field access pattern used by
	// tests/e2e/ui/pill-overflow-promotion.spec.ts's forcePillOverflowMeasure(),
	// just pinned rather than driven by real layout.
	el._measurePillOverflow = () => {};
	el._visiblePillCount = options.visibleCount ?? 2;
	el.requestUpdate();
	await el.updateComplete;
	(window as any).__agentInterfaceEl = el;
}

(window as any).__mountAgentInterfaceMorePopoverFixture = mountFixture;
(window as any).__getAbortCallCount = () => session?.abortCallCount ?? 0;
(window as any).__clickMoreToggle = () => {
	const btn = document.querySelector("agent-interface [data-more-btn] button") as HTMLButtonElement | null;
	btn?.click();
};
(window as any).__isMorePopoverOpen = () => document.querySelector("agent-interface .pill-more-popover") !== null;
(window as any).__dispatchSyntheticDoubleClickOnMoreToggle = () => {
	// UX-04's claimed listener-leak reproduction: open then close the popover
	// via two synthetic clicks dispatched synchronously in the same tick —
	// before the deferred requestAnimationFrame that (in the old code)
	// unconditionally attached the click-outside/keydown listeners had a
	// chance to run. Not reachable via normal human interaction (a real click
	// pair is never sub-frame), but this is exactly the scenario the finding
	// describes, so we reproduce it directly via dispatchEvent.
	const btn = document.querySelector("agent-interface [data-more-btn] button") as HTMLButtonElement | null;
	if (!btn) return;
	btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};
// Listener-leak instrumentation: track actual DOM attachment state (not a
// signed add-minus-remove counter — a removeEventListener call on a listener
// that was never actually attached is a harmless real-DOM no-op, but would
// still decrement a naive counter and mask a genuine leak once a later add
// brings the count back to "net zero"). Matched by direct function-reference
// equality against the live <agent-interface> instance's bound handlers —
// NOT by Function.prototype.name, which esbuild's bundling of TS class
// fields does not reliably preserve.
const originalAdd = EventTarget.prototype.addEventListener;
const originalRemove = EventTarget.prototype.removeEventListener;
const attachedKeys = new Set<string>();
function keyFor(type: string, listener: any, capture: boolean): string | null {
	// Only track the two handlers this fixture cares about — anything else
	// (framework-internal listeners, etc.) is not our concern here and would
	// only add noise.
	const ai = (window as any).__agentInterfaceEl;
	if (!ai) return null;
	if (type === "click" && listener === ai._handleMoreClickOutside) return `click:${capture}`;
	if (type === "keydown" && listener === ai._handleMoreKeyDown) return `keydown:${capture}`;
	return null;
}
EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: any, options?: any) {
	if (this === document) {
		const capture = options === true || (options && options.capture) === true;
		const key = keyFor(type, listener, capture);
		if (key) attachedKeys.add(key);
	}
	return originalAdd.call(this, type, listener, options);
};
EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: any, options?: any) {
	if (this === document) {
		const capture = options === true || (options && options.capture) === true;
		const key = keyFor(type, listener, capture);
		if (key) attachedKeys.delete(key);
	}
	return originalRemove.call(this, type, listener, options);
};
(window as any).__getNetMoreListenerCount = () => attachedKeys.size;
(window as any).__agentInterfaceMorePopoverReady = true;
