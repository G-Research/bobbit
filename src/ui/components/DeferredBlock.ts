/**
 * <deferred-block> — render-deferral wrapper for transcript messages.
 *
 * Phase 2 Opt-A — when the `deferOffscreenRender` perf flag is on, the
 * `<message-list>` renderer wraps each off-screen item in this element.
 * The first paint costs only a single empty placeholder div per deferred
 * block. An `IntersectionObserver` (rootMargin: 2000px) detects when the
 * placeholder approaches the viewport, then schedules the real template
 * to render on the next `requestIdleCallback` tick (50ms timeout fallback
 * to `setTimeout(0)`).
 *
 * When `eager` is true (used for the bottom tail) the template is rendered
 * synchronously — no observer, no idle callback. This is also the only
 * code path used when the perf flag is off, because the caller passes
 * `eager: true` for every block in that case.
 *
 * Correctness — every block MUST eventually render its real content.
 *  - `forceResolveAll()` resolves every live instance immediately. Triggered
 *    by Ctrl+F / Cmd+F / F3 so the native browser-find dialogue sees the
 *    full transcript text. The keydown handler is installed once on module
 *    load (idempotent).
 *  - On `disconnectedCallback` we drop the instance from the registry and
 *    cancel pending observers / idle callbacks so detached blocks can't
 *    keep state alive.
 *
 * The placeholder uses `min-height` so the transcript total height stays
 * roughly stable across the resolve transition. Heights are estimates, so
 * resolve preserves the scroll anchor when an above-viewport placeholder
 * grows or shrinks after real content mounts.
 */
import { html, LitElement, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

type IdleHandle = number;
type IdleDeadline = { didTimeout: boolean; timeRemaining: () => number };
type IdleRequestCallback = (deadline: IdleDeadline) => void;
type ScrollAnchor = {
	scroller: HTMLElement;
	oldScrollTop: number;
	oldHeight: number;
};

interface IdleAPI {
	requestIdleCallback?: (cb: IdleRequestCallback, opts?: { timeout: number }) => IdleHandle;
	cancelIdleCallback?: (id: IdleHandle) => void;
}

const PRELOAD_MARGIN_PX = 2000;
const SCROLLABLE_OVERFLOW_RE = /(auto|scroll|overlay)/;

export class DeferredBlock extends LitElement {
	/** Real template to render once resolved. Passed via Lit property; the
	 *  caller (`<message-list>`) recomputes it on every parent render and
	 *  hands the latest version in. The element holds the reference and
	 *  renders it on demand. */
	@property({ attribute: false }) template?: TemplateResult;

	/** When true, render `template` synchronously and skip all observer /
	 *  idle-callback machinery. Used for the bottom-tail of the transcript
	 *  (always visible at first paint) and for every block when the perf
	 *  flag is OFF (zero overhead path). */
	@property({ type: Boolean }) eager = false;

	/** Estimated rendered height in CSS pixels, used as `min-height` on the
	 *  placeholder so the transcript total height doesn't snap when blocks
	 *  resolve. Heuristic; per-message-type estimates live in the caller. */
	@property({ type: Number, attribute: "est-height" }) estHeight = 80;

	@state() private resolved = false;

	private io: IntersectionObserver | null = null;
	private idleHandle: IdleHandle | null = null;
	private idleTimeout: ReturnType<typeof setTimeout> | null = null;

	/** Module-wide registry so `forceResolveAll` can iterate live instances. */
	static instances: Set<DeferredBlock> = new Set();

	/** Resolve every live deferred-block instance immediately. Called by the
	 *  Ctrl+F / Cmd+F / F3 keydown handler below so native browser-find sees
	 *  the full transcript text. Idempotent for already-resolved blocks. */
	static forceResolveAll(): void {
		// Snapshot the set — `forceResolve()` does not mutate it directly,
		// but be defensive against future changes.
		for (const inst of Array.from(DeferredBlock.instances)) {
			inst.forceResolve();
		}
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		DeferredBlock.instances.add(this);
		if (this.eager) {
			this.resolved = true;
			return;
		}
		// Defer observer setup to a microtask so paint.first finishes before
		// any IO bookkeeping work runs.
		queueMicrotask(() => {
			if (!this.isConnected || this.resolved) return;
			if (typeof IntersectionObserver !== "function") {
				// Older runtimes (jsdom, ancient embedded webviews): resolve
				// immediately so we don't strand the block as a placeholder.
				this.resolved = true;
				return;
			}
			const root = this.findScrollContainer();
			const rootForObserver = root === document.scrollingElement ? null : root;
			this.io = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							this.scheduleResolve();
							this.io?.disconnect();
							this.io = null;
							break;
						}
					}
				},
				{ root: rootForObserver, rootMargin: `${PRELOAD_MARGIN_PX}px 0px`, threshold: 0 },
			);
			this.io.observe(this);
		});
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		DeferredBlock.instances.delete(this);
		this.io?.disconnect();
		this.io = null;
		if (this.idleHandle !== null) {
			const w = window as unknown as IdleAPI;
			w.cancelIdleCallback?.(this.idleHandle);
			this.idleHandle = null;
		}
		if (this.idleTimeout !== null) {
			clearTimeout(this.idleTimeout);
			this.idleTimeout = null;
		}
	}

	override willUpdate(changed: Map<string, unknown>): void {
		// If a parent re-render flips us to eager (e.g. after force-resolve
		// flips the perf flag off, or a Ctrl+F path), surface it immediately.
		if (changed.has("eager") && this.eager) this.resolved = true;
	}

	private findScrollContainer(): HTMLElement | null {
		if (typeof window === "undefined") return null;
		let el = this.parentElement;
		while (el) {
			const style = window.getComputedStyle(el);
			if (
				SCROLLABLE_OVERFLOW_RE.test(style.overflowY)
				&& el.scrollHeight > el.clientHeight
			) {
				return el;
			}
			el = el.parentElement;
		}
		return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
	}

	private captureScrollAnchor(): ScrollAnchor | null {
		const scroller = this.findScrollContainer();
		if (!scroller) return null;
		const rect = this.getBoundingClientRect();
		const scrollerRect = scroller === document.scrollingElement
			? { top: 0 }
			: scroller.getBoundingClientRect();
		// Only compensate blocks fully above the visible viewport. If the block
		// is visible or below the viewport, changing its own size should not move
		// the user's current anchor.
		if (rect.bottom > scrollerRect.top) return null;
		return {
			scroller,
			oldScrollTop: scroller.scrollTop,
			oldHeight: rect.height,
		};
	}

	private restoreScrollAnchor(anchor: ScrollAnchor | null): void {
		if (!anchor || !anchor.scroller.isConnected) return;
		const newHeight = this.getBoundingClientRect().height;
		const delta = newHeight - anchor.oldHeight;
		if (Math.abs(delta) < 0.5) return;
		// If the browser's native scroll anchoring (or a real user scroll) already
		// moved the container, do not double-apply the correction.
		if (Math.abs(anchor.scroller.scrollTop - anchor.oldScrollTop) > 2) return;
		anchor.scroller.scrollTop = anchor.oldScrollTop + delta;
	}

	private resolvePreservingScroll(): void {
		if (this.resolved) return;
		const anchor = this.captureScrollAnchor();
		this.resolved = true;
		void this.updateComplete.then(() => this.restoreScrollAnchor(anchor));
	}

	private scheduleResolve(): void {
		if (this.resolved) return;
		if (this.idleHandle !== null || this.idleTimeout !== null) return;
		const cb = (): void => {
			this.idleHandle = null;
			this.idleTimeout = null;
			this.resolvePreservingScroll();
		};
		const w = window as unknown as IdleAPI;
		if (typeof w.requestIdleCallback === "function") {
			this.idleHandle = w.requestIdleCallback(cb, { timeout: 50 });
		} else {
			this.idleTimeout = setTimeout(cb, 0);
		}
	}

	/** Resolve this single block now. Safe to call repeatedly. */
	forceResolve(): void {
		this.io?.disconnect();
		this.io = null;
		if (this.idleHandle !== null) {
			const w = window as unknown as IdleAPI;
			w.cancelIdleCallback?.(this.idleHandle);
			this.idleHandle = null;
		}
		if (this.idleTimeout !== null) {
			clearTimeout(this.idleTimeout);
			this.idleTimeout = null;
		}
		this.resolvePreservingScroll();
	}

	override render(): unknown {
		if (this.eager || this.resolved) return html`${this.template}`;
		return html`<div
			class="deferred-block-placeholder"
			aria-hidden="true"
			style="min-height:${this.estHeight}px"
		></div>`;
	}
}

if (!customElements.get("deferred-block")) {
	customElements.define("deferred-block", DeferredBlock);
}

// Expose on `window` so E2E tests (e.g. transcript-fidelity) can call
// `DeferredBlock.forceResolveAll()` to flush every placeholder before
// asserting DOM equality. Cheap — single property assignment at module
// load. Tests are the only intended caller; production code references
// the class directly via the static import above.
if (typeof window !== "undefined") {
	(window as unknown as { DeferredBlock: typeof DeferredBlock }).DeferredBlock = DeferredBlock;
}

// ---------------------------------------------------------------------------
// Browser-find / Ctrl+F escape hatch
// ---------------------------------------------------------------------------
// `IntersectionObserver` only fires when the user scrolls a placeholder
// into / near the viewport. Native browser-find (`Ctrl+F` / `Cmd+F` / `F3`)
// scans the DOM text content directly and never triggers IO; without this
// escape hatch a user searching for text inside an unresolved placeholder
// would get zero matches.
//
// We catch the keystroke at the document level BEFORE the browser opens its
// find UI (keydown fires first), resolve every live block synchronously, and
// fall through so the browser still opens the find dialogue against the now-
// fully-rendered transcript. Single listener installed on module load —
// idempotent under HMR (guarded by a global symbol).
const KEY_LISTENER_FLAG = "__bobbitDeferredBlockKeyListener" as const;
type GlobalWithFlag = typeof globalThis & { [KEY_LISTENER_FLAG]?: boolean };
if (typeof document !== "undefined") {
	const g = globalThis as GlobalWithFlag;
	if (!g[KEY_LISTENER_FLAG]) {
		g[KEY_LISTENER_FLAG] = true;
		document.addEventListener(
			"keydown",
			(ev) => {
				const isFind =
					(ev.key === "f" || ev.key === "F") && (ev.ctrlKey || ev.metaKey);
				const isF3 = ev.key === "F3";
				if (isFind || isF3) {
					try {
						DeferredBlock.forceResolveAll();
					} catch { /* swallow — never block the keystroke */ }
				}
			},
			// `true` (capture phase) so we run before any per-element handler
			// or the browser's own find handling potentially blocks defaults.
			true,
		);
	}
}
