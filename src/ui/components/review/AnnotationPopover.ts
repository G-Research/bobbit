import { html, LitElement, css } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { icon } from "@mariozechner/mini-lit";
import { Copy, Check } from "lucide";

/**
 * <annotation-popover> — A floating comment input popover for text annotations.
 *
 * **Mounted as a singleton in <body>**, not inside the consumer's template.
 *
 * Why: any ancestor with `transform`, `filter`, `perspective` or
 * `will-change: transform` becomes the containing block for `position:
 * fixed` descendants per CSS spec, *not* the viewport. The proposal panel
 * lives inside `.preview-slider__track` which uses `transform: translateX`
 * for its carousel — so a `fixed`-positioned popover inside that subtree
 * is trapped to the slider's bounding box and lands at its top-left.
 *
 * The fix is structural: keep the popover out of any transformed subtree
 * by mounting it directly under `<body>`. Consumers don't render
 * `<annotation-popover>` in their template; they call
 * `openAnnotationPopover({...})` which lazily creates the singleton,
 * forwards events back via the supplied callbacks, and tears down on
 * dismiss/submit. This mirrors the New-Session role-picker popover
 * pattern (see `renderRolePickerDropdown` in `src/app/sidebar.ts`),
 * which works because the sidebar is outside the slider.
 *
 * Positioning is plain viewport-clamp math (Math.min / Math.max against
 * window.innerWidth/innerHeight with an 8 px margin) so the popover never
 * overflows the viewport: it flips above the selection if there's no room
 * below and slides horizontally to stay on-screen. Mirrors the
 * `renderRolePickerDropdown` popover in `src/app/sidebar.ts`.
 *
 * Two display modes:
 *  - "popover" (default): desktop inline popover positioned via Floating UI.
 *  - "bottom-sheet": mobile bottom sheet that slides up from the bottom.
 */

export interface OpenPopoverOptions {
  referenceRect: DOMRect;
  selectedText: string;
  mode: "popover" | "bottom-sheet";
  existingComment?: string;
  /** Called when the user submits a comment. */
  onSubmit: (comment: string) => void;
  /** Called when the user cancels (Esc, swipe-down, click-Cancel). */
  onCancel: () => void;
  /** Called when the user deletes the existing comment (edit mode only). */
  onDelete?: () => void;
}

let _singleton: AnnotationPopover | null = null;

function getSingleton(): AnnotationPopover {
  if (_singleton && _singleton.isConnected) return _singleton;
  _singleton = document.createElement("annotation-popover") as AnnotationPopover;
  document.body.appendChild(_singleton);
  return _singleton;
}

/** Open the global annotation popover. Closes any prior open instance first. */
export function openAnnotationPopover(opts: OpenPopoverOptions): void {
  const el = getSingleton();
  el.referenceRect = opts.referenceRect;
  el.selectedText = opts.selectedText;
  el.mode = opts.mode;
  el.existingComment = opts.existingComment ?? "";
  el.onSubmit = opts.onSubmit;
  el.onCancel = opts.onCancel;
  el.onDelete = opts.onDelete ?? null;
  el.open = true;
}

/** Close the global annotation popover if it's open. */
export function closeAnnotationPopover(): void {
  if (_singleton && _singleton.isConnected) _singleton.open = false;
}

@customElement("annotation-popover")
export class AnnotationPopover extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  /** DOMRect of the selection range (viewport coordinates). */
  @property({ attribute: false }) referenceRect: DOMRect | null = null;
  @property({ type: String }) selectedText = "";
  @property({ type: String, reflect: true }) mode: "popover" | "bottom-sheet" = "popover";
  @property({ type: String }) existingComment = "";

  /** Imperative event sinks set by the singleton helper above. */
  onSubmit: ((comment: string) => void) | null = null;
  onCancel: (() => void) | null = null;
  onDelete: (() => void) | null = null;

  @query("textarea") private _textarea!: HTMLTextAreaElement;

  private _touchStartY = 0;
  private _vpResizeHandler: (() => void) | null = null;
  private _outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private _copied = false;
  private _copyResetTimer: number | undefined;

  static styles = css`
    :host {
      position: fixed;
      z-index: 1000;
      display: none;
      /* Initial top/left will be overridden in updated() based on the
         reference rect, with viewport-clamp math (mirrors the
         renderRolePickerDropdown popover in src/app/sidebar.ts). */
      top: 0;
      left: 0;
    }
    :host([open]) {
      display: block;
    }

    /* Bottom-sheet host docks to bottom of viewport. */
    :host([mode="bottom-sheet"]) {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      top: auto;
    }
    :host([mode="bottom-sheet"][open]) {
      display: block;
    }

    .review-popover {
      background: var(--background, #fff);
      color: var(--foreground, #1a1a1a);
      border: 1px solid var(--border, #ddd);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
      padding: 12px;
      width: 300px;
      font-family: inherit;
    }
    .review-popover-quote-row {
      display: flex;
      align-items: stretch;
      gap: 6px;
      margin-bottom: 8px;
    }
    .review-popover-quote {
      flex: 1;
      min-width: 0; /* allow ellipsis inside flex child */
      font-size: 12px;
      color: var(--muted-foreground, #888);
      padding: 4px 8px;
      border-left: 3px solid var(--primary, #6366f1);
      background: var(--muted, rgba(0, 0, 0, 0.04));
      border-radius: 0 4px 4px 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .review-popover-copy {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 10px;
      font-size: 11px;
      font-weight: 500;
      color: var(--muted-foreground, #888);
      background: var(--background, #fff);
      border: 1px solid var(--border, #ddd);
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      transition: color 120ms, border-color 120ms;
    }
    .review-popover-copy svg {
      width: 12px;
      height: 12px;
    }
    .review-popover-copy:hover {
      color: var(--foreground, #1a1a1a);
      border-color: var(--foreground, #1a1a1a);
    }
    .review-popover-copy.copied {
      color: var(--primary, #6366f1);
      border-color: var(--primary, #6366f1);
    }
    textarea {
      width: 100%;
      min-height: 60px;
      padding: 8px;
      border: 1px solid var(--border, #ddd);
      border-radius: 4px;
      background: var(--background, #fff);
      color: var(--foreground, #1a1a1a);
      font-family: inherit;
      font-size: 13px;
      resize: vertical;
      box-sizing: border-box;
    }
    textarea:focus {
      outline: none;
      border-color: var(--primary, #6366f1);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
    }
    .review-popover-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    button {
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 13px;
      cursor: pointer;
      border: 1px solid var(--border, #ddd);
      font-family: inherit;
    }
    .review-popover-cancel {
      background: var(--background, #fff);
      color: var(--foreground, #1a1a1a);
    }
    .review-popover-cancel:hover {
      background: var(--muted, rgba(0, 0, 0, 0.04));
    }
    .review-popover-submit {
      background: var(--primary, #6366f1);
      color: white;
      border-color: var(--primary, #6366f1);
    }
    .review-popover-submit:hover {
      opacity: 0.9;
    }
    .review-popover-delete {
      margin-right: auto;
      background: transparent;
      color: var(--negative, #dc2626);
      border-color: color-mix(in oklch, var(--negative, #dc2626) 40%, transparent);
    }
    .review-popover-delete:hover {
      background: color-mix(in oklch, var(--negative, #dc2626) 10%, transparent);
      color: var(--negative, #dc2626);
      border-color: var(--negative, #dc2626);
    }

    /* Bottom-sheet variant. */
    .review-popover--sheet {
      width: 100%;
      max-height: 50vh;
      border-radius: 12px 12px 0 0;
      box-sizing: border-box;
      animation: slide-up 200ms ease-out;
    }
    @keyframes slide-up {
      from { transform: translateY(100%); }
      to { transform: translateY(0); }
    }
    .review-sheet-handle {
      display: flex;
      justify-content: center;
      padding: 8px 0 4px;
      cursor: grab;
      touch-action: none;
    }
    .review-sheet-handle-pill {
      width: 40px;
      height: 4px;
      border-radius: 2px;
      background: var(--border, #ddd);
    }
    :host([mode="bottom-sheet"]) .review-popover-cancel,
    :host([mode="bottom-sheet"]) .review-popover-submit {
      min-height: 44px;
      font-size: 15px;
    }
    :host([mode="bottom-sheet"]) textarea {
      min-height: 80px;
      font-size: 15px;
    }
  `;

  protected updated(changed: Map<string, unknown>): void {
    const openChanged = changed.has("open");
    const refChanged = changed.has("referenceRect");

    if (openChanged && this.open) {
      if (this.mode === "popover") {
        this._reposition();
        this._attachOutsideClickHandler();
      } else {
        this.style.left = "";
        this.style.top = "";
        this._attachViewportListener();
      }
      requestAnimationFrame(() => {
        if (this._textarea) {
          if (this.existingComment) this._textarea.value = this.existingComment;
          this._textarea.focus();
        }
      });
    } else if (this.open && refChanged && this.mode === "popover") {
      this._reposition();
    }

    if (openChanged && !this.open) {
      this._detachViewportListener();
      this._detachOutsideClickHandler();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._detachViewportListener();
    this._detachOutsideClickHandler();
  }

  /**
   * Position via plain viewport-clamp math — the same approach used by the
   * working role-picker popover in `renderRolePickerDropdown`
   * (src/app/sidebar.ts).
   *
   * The host is `position: fixed` and the popover is mounted in <body>
   * (singleton pattern, see openAnnotationPopover). That guarantees the
   * containing block IS the viewport — no transformed-ancestor traps
   * because <body> has no transform on it.
   *
   * Algorithm:
   *  1. Anchor below the reference rect.
   *  2. Clamp the right edge inside the viewport (8 px margin), preferring
   *     to slide left rather than right — the rect's left edge is the
   *     natural anchor.
   *  3. If there isn't enough room below, flip above.
   */
  private _reposition(): void {
    if (!this.open || this.mode !== "popover" || !this.referenceRect) return;
    const r = this.referenceRect;
    const MARGIN = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Set a tentative position so the popover is laid out and we can measure
    // its actual size (width includes padding+border per its content-box).
    // We use offsetWidth/offsetHeight after first paint — if the host hasn't
    // been measured yet (first open), fall back to conservative estimates.
    let popW = this.offsetWidth;
    let popH = this.offsetHeight;
    if (popW === 0) popW = 326; // 300 content + 24 padding + 2 border
    if (popH === 0) popH = 200; // textarea + buttons + quote

    // Vertical: prefer below the selection; flip above if no room.
    const spaceBelow = vh - r.bottom - MARGIN;
    const placeAbove = spaceBelow < popH && r.top > popH + MARGIN;
    const top = placeAbove
      ? Math.max(MARGIN, r.top - popH - 4)
      : Math.min(r.bottom + 4, vh - popH - MARGIN);

    // Horizontal: anchor to the rect's left, clamped so right edge stays inside vw.
    const left = Math.min(
      Math.max(MARGIN, r.left),
      vw - popW - MARGIN,
    );

    this.style.left = `${left}px`;
    this.style.top = `${top}px`;

    // After first paint, re-measure once — the first call ran before layout
    // settled with the real popover content (textarea size, quote text wrap).
    // A second pass with the now-measured size lands the popover correctly.
    if (popW === 326 || popH === 200) {
      requestAnimationFrame(() => {
        if (this.open && this.offsetWidth > 0) this._reposition();
      });
    }
  }

  private _attachOutsideClickHandler(): void {
    if (this._outsideClickHandler) return;
    this._outsideClickHandler = (e: MouseEvent) => {
      const path = e.composedPath();
      if (!path.includes(this)) {
        this._cancel();
      }
    };
    // Defer one tick so the click that opened the popover doesn't immediately close it.
    setTimeout(() => {
      if (this._outsideClickHandler) {
        document.addEventListener("mousedown", this._outsideClickHandler, true);
      }
    }, 0);
  }

  private _detachOutsideClickHandler(): void {
    if (this._outsideClickHandler) {
      document.removeEventListener("mousedown", this._outsideClickHandler, true);
      this._outsideClickHandler = null;
    }
  }

  private _attachViewportListener(): void {
    if (!window.visualViewport || this._vpResizeHandler) return;
    this._vpResizeHandler = () => {
      if (this.mode !== "bottom-sheet" || !this.open) return;
      const offset = window.innerHeight - window.visualViewport!.height;
      this.style.bottom = `${offset}px`;
    };
    window.visualViewport.addEventListener("resize", this._vpResizeHandler);
    this._vpResizeHandler();
  }

  private _detachViewportListener(): void {
    if (this._vpResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this._vpResizeHandler);
    }
    this._vpResizeHandler = null;
    if (this.mode === "bottom-sheet") this.style.bottom = "0";
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this._cancel();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this._submit();
    }
  }

  private _onTouchStart(e: TouchEvent): void {
    this._touchStartY = e.touches[0].clientY;
  }

  private _onTouchMove(e: TouchEvent): void {
    e.preventDefault();
  }

  private _onTouchEnd(e: TouchEvent): void {
    const deltaY = e.changedTouches[0].clientY - this._touchStartY;
    if (deltaY > 50) this._cancel();
  }

  private _submit(): void {
    const comment = this._textarea?.value?.trim();
    if (!comment) return;
    const cb = this.onSubmit;
    this._reset();
    cb?.(comment);
  }

  private _cancel(): void {
    const cb = this.onCancel;
    this._reset();
    cb?.();
  }

  private _delete(): void {
    const cb = this.onDelete;
    this._reset();
    cb?.();
  }

  private _reset(): void {
    if (this._textarea) this._textarea.value = "";
    this.existingComment = "";
    this.open = false;
    this.onSubmit = null;
    this.onCancel = null;
    this.onDelete = null;
    this._copied = false;
  }

  private _copyText = async (e: Event): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    if (!this.selectedText) return;
    try {
      await navigator.clipboard.writeText(this.selectedText);
    } catch {
      // Fallback for older browsers / non-secure contexts.
      const ta = document.createElement("textarea");
      ta.value = this.selectedText;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    this._copied = true;
    this.requestUpdate();
    if (this._copyResetTimer != null) clearTimeout(this._copyResetTimer);
    this._copyResetTimer = window.setTimeout(() => {
      this._copied = false;
      this.requestUpdate();
      this._copyResetTimer = undefined;
    }, 1500);
  };

  render() {
    if (!this.open) return html``;
    const truncated =
      this.selectedText.length > 80
        ? this.selectedText.slice(0, 77) + "..."
        : this.selectedText;

    const copyBtn = html`<button
      class="review-popover-copy ${this._copied ? "copied" : ""}"
      title="Copy selected text"
      @click=${this._copyText}
    >${icon(this._copied ? Check : Copy, "xs")}<span>${this._copied ? "Copied" : "Copy"}</span></button>`;

    const quoteRow = html`
      <div class="review-popover-quote-row">
        <div class="review-popover-quote">${truncated}</div>
        ${copyBtn}
      </div>
    `;

    const isEditing = this.existingComment !== "";
    const primaryLabel = isEditing ? "Save" : "Add";
    const deleteBtn = isEditing && this.onDelete
      ? html`<button
          class="review-popover-delete"
          data-testid="annotation-delete"
          title="Delete comment"
          @click=${this._delete}
        >Delete</button>`
      : "";

    if (this.mode === "bottom-sheet") {
      return html`
        <div class="review-popover review-popover--sheet" @keydown=${this._onKeyDown}>
          <div class="review-sheet-handle"
            @touchstart=${this._onTouchStart}
            @touchmove=${this._onTouchMove}
            @touchend=${this._onTouchEnd}>
            <div class="review-sheet-handle-pill"></div>
          </div>
          ${quoteRow}
          <textarea placeholder="Add your comment..." @keydown=${this._onKeyDown}></textarea>
          <div class="review-popover-actions">
            ${deleteBtn}
            <button class="review-popover-cancel" @click=${this._cancel}>Cancel</button>
            <button class="review-popover-submit" @click=${this._submit}>${primaryLabel}</button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="review-popover" @keydown=${this._onKeyDown}>
        ${quoteRow}
        <textarea placeholder="Add your comment..." @keydown=${this._onKeyDown}></textarea>
        <div class="review-popover-actions">
          ${deleteBtn}
          <button class="review-popover-cancel" @click=${this._cancel}>Cancel</button>
          <button class="review-popover-submit" @click=${this._submit}>${primaryLabel}</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "annotation-popover": AnnotationPopover;
  }
}
