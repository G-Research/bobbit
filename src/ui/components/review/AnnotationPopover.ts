import { html, LitElement, css } from "lit";
import { customElement, property, query } from "lit/decorators.js";

/**
 * <annotation-popover> — A floating comment input popover for text annotations.
 *
 * Positioned absolutely at (x, y). Contains a textarea + Submit/Cancel buttons.
 * Dispatches `annotation-submit` (detail: { comment }) and `annotation-cancel`.
 *
 * Supports two modes:
 *  - "popover" (default): Desktop inline popover positioned at (x, y)
 *  - "bottom-sheet": Mobile bottom sheet that slides up from the bottom
 */
@customElement("annotation-popover")
export class AnnotationPopover extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) x = 0;
  @property({ type: Number }) y = 0;
  @property({ type: String }) selectedText = "";
  @property({ type: String, reflect: true }) mode: "popover" | "bottom-sheet" = "popover";
  @property({ type: String }) existingComment = "";

  @query("textarea") private _textarea!: HTMLTextAreaElement;

  private _touchStartY = 0;
  private _vpResizeHandler: (() => void) | null = null;

  static styles = css`
    :host {
      position: absolute;
      z-index: 1000;
      display: none;
    }
    :host([open]) {
      display: block;
    }

    /* --- Bottom Sheet host positioning --- */
    :host([mode="bottom-sheet"]) {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      top: auto;
      z-index: 1000;
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
    .review-popover-quote {
      font-size: 12px;
      color: var(--muted-foreground, #888);
      margin-bottom: 8px;
      padding: 4px 8px;
      border-left: 3px solid var(--primary, #6366f1);
      background: var(--muted, rgba(0, 0, 0, 0.04));
      border-radius: 0 4px 4px 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
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

    /* --- Bottom Sheet Styles --- */
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
    if (changed.has("open") && this.open) {
      if (this.mode === "popover") {
        // Update position for popover mode
        this.style.left = `${this.x}px`;
        this.style.top = `${this.y}px`;
      } else {
        // Bottom sheet: clear popover-style positioning
        this.style.left = "";
        this.style.top = "";
      }
      // Auto-focus textarea, pre-fill if editing existing
      requestAnimationFrame(() => {
        if (this._textarea) {
          if (this.existingComment) {
            this._textarea.value = this.existingComment;
          }
          this._textarea.focus();
        }
      });

      // Attach visualViewport listener in bottom-sheet mode
      if (this.mode === "bottom-sheet") {
        this._attachViewportListener();
      }
    }

    // Clean up viewport listener when closed
    if (changed.has("open") && !this.open) {
      this._detachViewportListener();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._detachViewportListener();
  }

  private _attachViewportListener(): void {
    if (!window.visualViewport || this._vpResizeHandler) return;
    this._vpResizeHandler = () => {
      if (this.mode !== "bottom-sheet" || !this.open) return;
      const offset = window.innerHeight - window.visualViewport!.height;
      this.style.bottom = `${offset}px`;
    };
    window.visualViewport.addEventListener("resize", this._vpResizeHandler);
    // Apply immediately in case keyboard is already up
    this._vpResizeHandler();
  }

  private _detachViewportListener(): void {
    if (this._vpResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this._vpResizeHandler);
    }
    this._vpResizeHandler = null;
    // Reset bottom offset
    if (this.mode === "bottom-sheet") {
      this.style.bottom = "0";
    }
  }

  private _onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this._cancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._submit();
    }
  }

  private _onTouchStart(e: TouchEvent): void {
    this._touchStartY = e.touches[0].clientY;
  }

  private _onTouchMove(e: TouchEvent): void {
    // Prevent scrolling while swiping the handle
    e.preventDefault();
  }

  private _onTouchEnd(e: TouchEvent): void {
    const deltaY = e.changedTouches[0].clientY - this._touchStartY;
    if (deltaY > 50) {
      this._cancel();
    }
  }

  private _submit(): void {
    const comment = this._textarea?.value?.trim();
    if (!comment) return;
    this.dispatchEvent(
      new CustomEvent("annotation-submit", {
        detail: { comment },
        bubbles: true,
        composed: true,
      }),
    );
    this._reset();
  }

  private _cancel(): void {
    this.dispatchEvent(
      new CustomEvent("annotation-cancel", {
        bubbles: true,
        composed: true,
      }),
    );
    this._reset();
  }

  private _reset(): void {
    if (this._textarea) this._textarea.value = "";
    this.existingComment = "";
    this.open = false;
  }

  render() {
    if (!this.open) return html``;
    const truncated =
      this.selectedText.length > 80
        ? this.selectedText.slice(0, 77) + "..."
        : this.selectedText;

    if (this.mode === "bottom-sheet") {
      return html`
        <div class="review-popover review-popover--sheet" @keydown=${this._onKeyDown}>
          <div class="review-sheet-handle"
            @touchstart=${this._onTouchStart}
            @touchmove=${this._onTouchMove}
            @touchend=${this._onTouchEnd}>
            <div class="review-sheet-handle-pill"></div>
          </div>
          <div class="review-popover-quote">${truncated}</div>
          <textarea
            placeholder="Add your comment..."
            @keydown=${this._onKeyDown}
          ></textarea>
          <div class="review-popover-actions">
            <button class="review-popover-cancel" @click=${this._cancel}>Cancel</button>
            <button class="review-popover-submit" @click=${this._submit}>Submit</button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="review-popover" @keydown=${this._onKeyDown}>
        <div class="review-popover-quote">${truncated}</div>
        <textarea
          placeholder="Add your comment..."
          @keydown=${this._onKeyDown}
        ></textarea>
        <div class="review-popover-actions">
          <button class="review-popover-cancel" @click=${this._cancel}>Cancel</button>
          <button class="review-popover-submit" @click=${this._submit}>Submit</button>
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
