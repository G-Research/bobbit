// Test entry — bundles <deferred-block> + <message-list> so we can exercise
// the Phase 2 Opt-A defer-offscreen-render flag from a file:// fixture.
//
// Helpers exposed on `window`:
//   __mountDeferredBlock(slotId, opts)    — render a single <deferred-block>
//   __mountMessageList(slotId, opts)      — render <message-list> with N msgs
//   __setPerfFlag(name, enabled)          — flip localStorage perf flag
//   __triggerIntersection(el, isIntersecting)
//                                         — synthetically poke an IO callback
//   __pressCtrlF()                        — dispatch a Ctrl+F keydown
//   __countDeferred()                     — number of <deferred-block> nodes
//   __countPlaceholders()                 — number of unresolved placeholder
//                                            divs (`.deferred-block-placeholder`)
import { html, render } from "lit";
import "../../src/ui/components/DeferredBlock.js";
import "../../src/ui/components/MessageList.js";
import { DeferredBlock } from "../../src/ui/components/DeferredBlock.js";
import { reloadPerfFlags, setPerfFlag } from "../../src/app/perf-flags.js";

// Synchronous-resolve IntersectionObserver shim — captures the latest
// callback per-element so `__triggerIntersection` can drive it.
const ioCallbacks = new WeakMap<Element, (e: any) => void>();
class TestIO {
	private cb: (entries: any[]) => void;
	constructor(cb: (entries: any[]) => void) {
		this.cb = cb;
	}
	observe(el: Element): void {
		ioCallbacks.set(el, (entry) => this.cb([entry]));
	}
	unobserve(_el: Element): void { /* noop */ }
	disconnect(): void { /* noop */ }
	takeRecords(): any[] { return []; }
}
(window as any).IntersectionObserver = TestIO;

(window as any).__mountDeferredBlock = (
	slotId: string,
	opts: { eager?: boolean; estHeight?: number; text?: string },
): void => {
	const slot = document.getElementById(slotId)!;
	const tpl = html`<span data-real-content>${opts.text ?? "REAL"}</span>`;
	render(
		html`<deferred-block
			.template=${tpl}
			.eager=${opts.eager ?? false}
			est-height=${opts.estHeight ?? 80}
		></deferred-block>`,
		slot,
	);
};

(window as any).__triggerIntersection = (selector: string, isIntersecting: boolean): boolean => {
	const el = document.querySelector(selector);
	if (!el) return false;
	const cb = ioCallbacks.get(el);
	if (!cb) return false;
	cb({ isIntersecting, target: el, intersectionRatio: isIntersecting ? 1 : 0 });
	return true;
};

(window as any).__pressCtrlF = (): void => {
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
};

(window as any).__forceResolveAll = (): void => {
	DeferredBlock.forceResolveAll();
};

(window as any).__setPerfFlag = (name: string, enabled: boolean): void => {
	setPerfFlag(name, enabled);
	reloadPerfFlags();
};

(window as any).__reloadPerfFlags = (): void => { reloadPerfFlags(); };

(window as any).__mountMessageList = (slotId: string, opts: { count: number }): void => {
	const slot = document.getElementById(slotId)!;
	const messages: any[] = [];
	for (let i = 0; i < opts.count; i++) {
		messages.push({
			role: "user",
			id: `m-${i}`,
			content: `message ${i}`,
		});
	}
	render(
		html`<message-list
			.messages=${messages}
			.tools=${[]}
			.isStreaming=${false}
		></message-list>`,
		slot,
	);
};

(window as any).__countDeferred = (): number =>
	document.querySelectorAll("deferred-block").length;
(window as any).__countEager = (): number =>
	document.querySelectorAll("deferred-block [data-real-content], deferred-block user-message").length;
(window as any).__countPlaceholders = (): number =>
	document.querySelectorAll("deferred-block .deferred-block-placeholder").length;
(window as any).__countUserMessages = (): number =>
	document.querySelectorAll("deferred-block user-message").length;

// Bypass requestIdleCallback so test assertions run synchronously after we
// drive intersection. We replace it with a microtask scheduler — the
// element's `scheduleResolve` calls this and the resolve happens before
// the next Lit render tick.
(window as any).requestIdleCallback = ((cb: any) => {
	queueMicrotask(() => cb({ didTimeout: false, timeRemaining: () => 50 }));
	return 0;
}) as any;
(window as any).cancelIdleCallback = (() => { /* noop */ }) as any;

(window as any).__ready = true;
