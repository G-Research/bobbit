/**
 * <deferred-code-block> — Phase 2 Opt-G defer-syntax-highlight wrapper.
 *
 * Hypothesis: after Opt-A (which renders only the bottom ~8 messages
 * eagerly), `paint.first` is dominated by syntax-highlighting the
 * `<code-block>` instances inside those visible eager-tail messages.
 * `<code-block>` from `@mariozechner/mini-lit` runs `hljs.highlight()`
 * synchronously on its first render — for a transcript heavy in
 * `read` / `write` / `bash` tool calls, that's many synchronous hljs
 * passes on the click → first-paint critical path.
 *
 * Strategy: when the `deferSyntaxHighlight` perf flag is on, this wrapper
 * renders a plain `<pre><code>` of the escaped source text synchronously
 * (no hljs work, no library load past mini-lit's existing eager pull-in)
 * and schedules `requestIdleCallback(...)` to swap in the real
 * `<code-block>` once the main thread is idle. The text is visually
 * approximately the right height from frame one (same monospace font),
 * so the upgrade does not shift layout and browser-find sees the source
 * text immediately.
 *
 * When the flag is off, the helper `codeBlock(code, language)` emits a
 * raw `<code-block>` element — byte-for-byte identical to today, zero
 * runtime cost.
 *
 * File ownership note: every transcript-path emission of `<code-block>`
 * routes through `codeBlock(...)`. The artifact viewer (`src/ui/tools/
 * artifacts/*`) uses `hljs.highlight()` directly via `unsafeHTML` and is
 * NOT covered — those panels are not on the sidebar-nav critical path.
 */
import { html, LitElement, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { isPerfFlagEnabled } from "../../app/perf-flags.js";

export const PERF_FLAG_DEFER_SYNTAX_HIGHLIGHT = "deferSyntaxHighlight";

type IdleHandle = number;
type IdleDeadline = { didTimeout: boolean; timeRemaining: () => number };
type IdleRequestCallback = (deadline: IdleDeadline) => void;
interface IdleAPI {
	requestIdleCallback?: (cb: IdleRequestCallback, opts?: { timeout: number }) => IdleHandle;
	cancelIdleCallback?: (id: IdleHandle) => void;
}

/**
 * `<deferred-code-block>` — render a plain `<pre><code>` synchronously,
 * upgrade to a real `<code-block>` (which runs hljs) on idle.
 *
 * Public API mirrors `<code-block>`: `code` (string source) + `language`
 * (highlight.js language name or `"text"`).
 */
export class DeferredCodeBlock extends LitElement {
	@property({ type: String }) code = "";
	@property({ type: String }) language = "text";

	@state() private _upgraded = false;

	private _idleHandle: IdleHandle | null = null;
	private _idleTimeout: ReturnType<typeof setTimeout> | null = null;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this._scheduleUpgrade();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._cancelUpgrade();
	}

	private _scheduleUpgrade(): void {
		if (this._upgraded || this._idleHandle !== null || this._idleTimeout !== null) return;
		const cb = (): void => {
			this._idleHandle = null;
			this._idleTimeout = null;
			this._upgraded = true;
		};
		const w = (typeof window !== "undefined" ? window : undefined) as unknown as IdleAPI | undefined;
		if (w && typeof w.requestIdleCallback === "function") {
			this._idleHandle = w.requestIdleCallback(cb, { timeout: 200 });
		} else {
			this._idleTimeout = setTimeout(cb, 0);
		}
	}

	private _cancelUpgrade(): void {
		if (this._idleHandle !== null) {
			const w = window as unknown as IdleAPI;
			w.cancelIdleCallback?.(this._idleHandle);
			this._idleHandle = null;
		}
		if (this._idleTimeout !== null) {
			clearTimeout(this._idleTimeout);
			this._idleTimeout = null;
		}
	}

	/** Resolve immediately. Exposed for testing / forced-resolve hooks. */
	forceUpgrade(): void {
		this._cancelUpgrade();
		this._upgraded = true;
	}

	override render(): TemplateResult {
		if (this._upgraded) {
			return html`<code-block .code=${this.code} language=${this.language}></code-block>`;
		}
		// Plain pre/code placeholder. We give it `hljs language-X` classes
		// (without any token spans) so that the eventual upgrade swaps DOM
		// in the same visual envelope — no font/size jump. We also set a
		// `data-pending-highlight` marker so tests / dev-tools can spot the
		// pending blocks.
		return html`<pre
			class="hljs language-${this.language}"
			data-pending-highlight=${this.language}
			style="margin:0;padding:0.75rem;overflow:auto;font-size:0.75rem;line-height:1.4;background:var(--card);color:var(--foreground);border-radius:0.375rem;"
		><code>${this.code}</code></pre>`;
	}
}

if (!customElements.get("deferred-code-block")) {
	customElements.define("deferred-code-block", DeferredCodeBlock);
}

/**
 * Helper for transcript-path renderers. Emit the deferred wrapper when
 * the flag is on; emit a raw `<code-block>` (byte-identical to today)
 * when the flag is off. Callers don't need to think about the flag.
 *
 * The flag is read per call (cheap — `isPerfFlagEnabled` is a Set lookup
 * over a cached load) so changes via the dev-tools `setPerfFlag` are
 * picked up on the next render without a reload.
 */
export function codeBlock(code: string, language: string): TemplateResult {
	if (isPerfFlagEnabled(PERF_FLAG_DEFER_SYNTAX_HIGHLIGHT)) {
		return html`<deferred-code-block .code=${code} language=${language}></deferred-code-block>`;
	}
	return html`<code-block .code=${code} language=${language}></code-block>`;
}
