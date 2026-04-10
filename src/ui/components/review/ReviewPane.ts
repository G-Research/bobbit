import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { getAnnotations, getTotalAnnotationCount, composeReviewFeedback } from "./AnnotationStore.js";
import "./ReviewDocument.js";
import "./review-pane.css";

/**
 * <review-pane> — Tabbed container for review documents with a Submit Review button.
 *
 * Renders a horizontal tab bar, the active `<review-document>`, and a bottom
 * action bar. Uses light DOM for consistent styling with the app theme.
 */
@customElement("review-pane")
export class ReviewPane extends LitElement {
  @property({ attribute: false })
  documents: Map<string, { title: string; markdown: string }> = new Map();

  @property({ type: String }) activeTab = "";
  @property({ type: String }) sessionId = "";

  @state() private _overflowOpen = false;
  @state() private _annotationCounts: Map<string, number> = new Map();

  createRenderRoot() {
    return this;
  }

  private _boundCacheReady = () => this._refreshCounts();

  connectedCallback(): void {
    super.connectedCallback();
    this._refreshCounts();
    window.addEventListener("annotation-cache-ready", this._boundCacheReady);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("annotation-cache-ready", this._boundCacheReady);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("documents") || changed.has("sessionId")) {
      this._refreshCounts();
    }
  }

  private _refreshCounts(): void {
    const counts = new Map<string, number>();
    for (const [title] of this.documents) {
      counts.set(title, getAnnotations(this.sessionId, title).length);
    }
    this._annotationCounts = counts;
  }

  private _onAnnotationChange(): void {
    this._refreshCounts();
  }

  private _switchTab(title: string): void {
    this._overflowOpen = false;
    this.dispatchEvent(
      new CustomEvent("review-tab-change", {
        detail: { title },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _submitReview(): void {
    const feedback = composeReviewFeedback(this.sessionId, this.documents);
    if (!feedback) return;
    this.dispatchEvent(
      new CustomEvent("review-submit", {
        detail: { feedback },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _closeTab(title: string, e: Event): void {
    e.stopPropagation();
    const count = this._annotationCounts.get(title) || 0;
    if (count > 0) {
      if (!confirm(`Close "${title}"? ${count} unsaved comment${count !== 1 ? "s" : ""} will be lost.`)) return;
    }
    this.dispatchEvent(
      new CustomEvent("review-close-tab", {
        detail: { title },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _dismiss(): void {
    const totalCount = getTotalAnnotationCount(this.sessionId, this.documents);
    if (totalCount > 0) {
      if (!confirm(`Dismiss review? ${totalCount} unsaved comment${totalCount !== 1 ? "s" : ""} will be lost.`)) return;
    }
    this.dispatchEvent(
      new CustomEvent("review-dismiss", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _toggleOverflow(e: Event): void {
    e.stopPropagation();
    this._overflowOpen = !this._overflowOpen;
  }

  render() {
    const titles = Array.from(this.documents.keys());
    const activeDoc = this.documents.get(this.activeTab);
    const totalCount = getTotalAnnotationCount(this.sessionId, this.documents);

    // Split tabs: visible (first 5) and overflow (rest)
    const MAX_VISIBLE = 5;
    const visibleTitles = titles.slice(0, MAX_VISIBLE);
    const overflowTitles = titles.slice(MAX_VISIBLE);

    return html`
      <div class="review-pane">
        <div class="review-tab-bar">
          ${visibleTitles.map((title) => {
            const count = this._annotationCounts.get(title) || 0;
            return html`
              <button
                class="review-tab ${title === this.activeTab ? "review-tab--active" : ""}"
                @click=${() => this._switchTab(title)}
                title=${title}
              >
                <span class="review-tab-label">${title}</span>
                ${count > 0
                  ? html`<span class="review-tab-badge">${count}</span>`
                  : ""}
                <span
                  class="review-tab-close"
                  @click=${(e: Event) => this._closeTab(title, e)}
                  title="Close tab"
                >×</span>
              </button>
            `;
          })}
          ${overflowTitles.length > 0
            ? html`
                <div class="review-tab-overflow-container">
                  <button
                    class="review-tab review-tab-overflow-trigger"
                    @click=${this._toggleOverflow}
                    title="More tabs"
                  >...</button>
                  ${this._overflowOpen
                    ? html`
                        <div class="review-tab-overflow">
                          ${overflowTitles.map((title) => {
                            const count = this._annotationCounts.get(title) || 0;
                            return html`
                              <button
                                class="review-tab-overflow-item ${title === this.activeTab ? "review-tab--active" : ""}"
                                @click=${() => this._switchTab(title)}
                              >
                                ${title}
                                ${count > 0
                                  ? html`<span class="review-tab-badge">${count}</span>`
                                  : ""}
                              </button>
                            `;
                          })}
                        </div>
                      `
                    : ""}
                </div>
              `
            : ""}
        </div>

        <div class="review-document-area">
          ${activeDoc
            ? html`
                <review-document
                  .markdown=${activeDoc.markdown}
                  .sessionId=${this.sessionId}
                  .docTitle=${this.activeTab}
                  @annotation-change=${this._onAnnotationChange}
                ></review-document>
              `
            : html`
                <div class="review-empty">
                  <p>No document selected.</p>
                </div>
              `}
        </div>

        <div class="review-submit-bar">
          <span class="review-submit-count">
            ${totalCount > 0
              ? `${totalCount} comment${totalCount !== 1 ? "s" : ""}`
              : "No comments yet"}
          </span>
          <div class="review-submit-actions">
            <button
              class="review-dismiss-btn"
              @click=${this._dismiss}
            >Dismiss</button>
            <button
              class="review-submit-btn"
              ?disabled=${totalCount === 0}
              @click=${this._submitReview}
            >Submit Review</button>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-pane": ReviewPane;
  }
}
