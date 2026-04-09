import { html, LitElement, css } from "lit";
import { customElement, property, query } from "lit/decorators.js";

/**
 * <annotation-popover> — A floating comment input popover for text annotations.
 *
 * Positioned absolutely at (x, y). Contains a textarea + Submit/Cancel buttons.
 * Dispatches `annotation-submit` (detail: { comment }) and `annotation-cancel`.
 */
@customElement("annotation-popover")
export class AnnotationPopover extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Number }) x = 0;
  @property({ type: Number }) y = 0;
  @property({ type: String }) selectedText = "";

  @query("textarea") private _textarea!: HTMLTextAreaElement;

  static styles = css`
    :host {
      position: absolute;
      z-index: 1000;
      display: none;
    }
    :host([open]) {
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
  `;

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      // Update position
      this.style.left = `${this.x}px`;
      this.style.top = `${this.y}px`;
      // Auto-focus textarea
      requestAnimationFrame(() => {
        this._textarea?.focus();
      });
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
    this.open = false;
  }

  render() {
    if (!this.open) return html``;
    const truncated =
      this.selectedText.length > 80
        ? this.selectedText.slice(0, 77) + "..."
        : this.selectedText;
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
