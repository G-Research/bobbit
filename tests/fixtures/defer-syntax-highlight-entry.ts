// Test entry for Phase 2 Opt-G — defer syntax highlighting.
//
// Exposes helpers on `window` for the spec:
//   __mountCodeBlock(slotId, code, lang)   — render via the `codeBlock`
//                                              helper (flag-aware)
//   __setPerfFlag(name, enabled)           — flip a perf flag + reload cache
//   __reloadPerfFlags()                    — re-read localStorage
//   __idleFlush()                           — drain scheduled idle callbacks
//                                              (we intercept rIC below)
//   __countDeferred()                      — # of <deferred-code-block>
//   __countCodeBlock()                     — # of <code-block> elements
//   __countPending()                       — # of pending placeholder <pre>
//
// We don't pull in mini-lit's `<code-block>` (it imports highlight.js +
// the full prism bundle, which would dominate the test fixture). Instead
// we register a tiny stub so the upgrade target exists in the DOM under
// the same tag name.
import { html, render } from "lit";
import "../../src/ui/components/syntax-highlight.js";
import { reloadPerfFlags, setPerfFlag } from "../../src/app/perf-flags.js";
import { codeBlock } from "../../src/ui/components/syntax-highlight.js";

// Stub `<code-block>` so the upgrade target is a known element.
class StubCodeBlock extends HTMLElement {
	connectedCallback(): void {
		this.setAttribute("data-real-code-block", "");
		this.textContent = (this as any).code ?? "";
	}
}
if (!customElements.get("code-block")) {
	customElements.define("code-block", StubCodeBlock);
}

// Intercept rIC so the spec can drive the timing.
const pendingIdle: Array<() => void> = [];
(window as any).requestIdleCallback = ((cb: any) => {
	pendingIdle.push(() => cb({ didTimeout: false, timeRemaining: () => 50 }));
	return pendingIdle.length;
}) as any;
(window as any).cancelIdleCallback = ((handle: number) => {
	// Replace with noop; we don't need to actually cancel for spec purposes.
	if (handle >= 1 && handle <= pendingIdle.length) {
		pendingIdle[handle - 1] = () => {};
	}
}) as any;

(window as any).__idleFlush = (): void => {
	while (pendingIdle.length) {
		const cb = pendingIdle.shift();
		try { cb?.(); } catch (e) { console.error(e); }
	}
};

(window as any).__mountCodeBlock = (slotId: string, code: string, lang: string): void => {
	const slot = document.getElementById(slotId)!;
	render(html`<div>${codeBlock(code, lang)}</div>`, slot);
};

(window as any).__setPerfFlag = (name: string, enabled: boolean): void => {
	setPerfFlag(name, enabled);
	reloadPerfFlags();
};

(window as any).__reloadPerfFlags = (): void => { reloadPerfFlags(); };

(window as any).__countDeferred = (): number =>
	document.querySelectorAll("deferred-code-block").length;
(window as any).__countCodeBlock = (): number =>
	document.querySelectorAll("code-block[data-real-code-block]").length;
(window as any).__countPending = (): number =>
	document.querySelectorAll("[data-pending-highlight]").length;

(window as any).__ready = true;
