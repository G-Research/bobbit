import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  buildReviewDecisionPayloadForDocument,
  getAnnotations,
  getDocumentAnnotationCount,
  getTotalAnnotationCount,
} from "./AnnotationStore.js";
import { ensureReviewComponents } from "../../../app/lazy-review.js";
import type {
  ReviewDecision,
  ReviewDecisionEventDetail,
  ReviewDocumentModel,
} from "./review-types.js";
import "./review-pane.css";

/**
 * <review-pane> — Tabbed container for review documents with review decision controls.
 *
 * Renders a horizontal tab bar, the active `<review-document>`, and a bottom
 * action bar. Uses light DOM for consistent styling with the app theme.
 */
@customElement("review-pane")
export class ReviewPane extends LitElement {
  @property({ attribute: false })
  documents: Map<string, ReviewDocumentModel> = new Map();

  @property({ type: String }) activeTab = "";
  @property({ type: String }) sessionId = "";

  @state() private _overflowOpen = false;
  @state() private _annotationCounts: Map<string, number> = new Map();
  @state() private _finalCommentsByTitle: Map<string, string> = new Map();
  @state() private _validationError = "";

  createRenderRoot() {
    return this;
  }

  private _boundCacheReady = () => this._refreshCounts();

  connectedCallback(): void {
    super.connectedCallback();
    // Trigger the heavy review-document chunk on first mount; the
    // <review-document> tag below stays unknown until the chunk lands
    // and customElements upgrades it. Lit preserves the property
    // bindings across upgrade.
    void ensureReviewComponents();
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
    if (changed.has("documents")) {
      this._pruneFinalCommentDrafts();
    }
    if (changed.has("activeTab")) {
      this._validationError = "";
    }
  }

  private _refreshCounts(): void {
    const counts = new Map<string, number>();
    for (const [title] of this.documents) {
      counts.set(title, getAnnotations(this.sessionId, title).length);
    }
    this._annotationCounts = counts;
  }

  private _pruneFinalCommentDrafts(): void {
    let changed = false;
    const next = new Map<string, string>();
    for (const [title, comment] of this._finalCommentsByTitle) {
      if (this.documents.has(title)) next.set(title, comment);
      else changed = true;
    }
    if (changed) this._finalCommentsByTitle = next;
  }

  private _finalCommentFor(title: string): string {
    return this._finalCommentsByTitle.get(title) || "";
  }

  private _setFinalComment(title: string, comment: string): void {
    const next = new Map(this._finalCommentsByTitle);
    if (comment) next.set(title, comment);
    else next.delete(title);
    this._finalCommentsByTitle = next;
  }

  private _deleteFinalComment(title: string): void {
    if (!this._finalCommentsByTitle.has(title)) return;
    const next = new Map(this._finalCommentsByTitle);
    next.delete(title);
    this._finalCommentsByTitle = next;
  }

  private _hasFinalComment(title: string): boolean {
    return this._finalCommentFor(title).trim().length > 0;
  }

  private _unsentCommentCountForDocument(title: string): number {
    return getDocumentAnnotationCount(this.sessionId, title) + (this._hasFinalComment(title) ? 1 : 0);
  }

  private _totalUnsentCommentCount(): number {
    let total = getTotalAnnotationCount(this.sessionId, this.documents);
    for (const [title] of this.documents) {
      if (this._hasFinalComment(title)) total += 1;
    }
    return total;
  }

  private _onAnnotationChange(): void {
    this._validationError = "";
    this._refreshCounts();
  }

  private _displayTitle(key: string): string {
    return this.documents.get(key)?.title || key;
  }

  private _switchTab(title: string): void {
    this._overflowOpen = false;
    this._validationError = "";
    this.dispatchEvent(
      new CustomEvent("review-tab-change", {
        detail: { title },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _onFinalCommentInput(e: Event): void {
    const activeDoc = this.documents.get(this.activeTab) || null;
    if (!activeDoc) return;
    const finalComment = (e.target as HTMLTextAreaElement).value;
    this._setFinalComment(this.activeTab, finalComment);
    if (finalComment.trim()) this._validationError = "";
  }

  private _submitDecision(decision: ReviewDecision): void {
    const activeDoc = this.documents.get(this.activeTab) || null;
    if (!activeDoc) return;

    const finalComment = this._finalCommentFor(this.activeTab).trim();
    const activeCount = getDocumentAnnotationCount(this.sessionId, this.activeTab);
    if (decision === "reject" && activeCount === 0 && !finalComment) {
      this._validationError = "Add a final comment or at least one inline comment before rejecting.";
      return;
    }

    this._validationError = "";
    const payload = buildReviewDecisionPayloadForDocument(
      this.sessionId,
      this.activeTab,
      activeDoc,
      decision,
      finalComment,
    );
    const detail: ReviewDecisionEventDetail = {
      document: activeDoc,
      source: activeDoc.source,
      payload,
      decision: payload.decision,
      finalComment: payload.finalComment,
      inlineComments: payload.inlineComments,
      feedback: payload.feedback,
    };

    const decisionEvent = new CustomEvent<ReviewDecisionEventDetail>("review-decision", {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    const wasNotCanceled = this.dispatchEvent(decisionEvent);

    // Compatibility bridge for the existing markdown review flow. New app-level
    // review-decision handlers can call preventDefault() to own routing without
    // receiving a duplicate legacy review-submit event.
    if (wasNotCanceled && (!activeDoc.source || activeDoc.source.kind === "markdown-review")) {
      this.dispatchEvent(
        new CustomEvent("review-submit", {
          detail: { feedback: payload.feedback, payload },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private _closeTab(title: string, e: Event): void {
    e.stopPropagation();
    const count = this._unsentCommentCountForDocument(title);
    const displayTitle = this._displayTitle(title);
    if (count > 0) {
      if (!confirm(`Close "${displayTitle}"? ${count} unsent comment${count !== 1 ? "s" : ""} will be lost.`)) return;
    }
    this._deleteFinalComment(title);
    this.dispatchEvent(
      new CustomEvent("review-close-tab", {
        detail: { title },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _dismiss(): void {
    const totalCount = this._totalUnsentCommentCount();
    if (totalCount > 0) {
      if (!confirm(`Dismiss review? ${totalCount} unsent comment${totalCount !== 1 ? "s" : ""} will be lost.`)) return;
    }
    this._finalCommentsByTitle = new Map();
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
    const activeCount = activeDoc ? getDocumentAnnotationCount(this.sessionId, this.activeTab) : 0;
    const activeFinalComment = activeDoc ? this._finalCommentFor(this.activeTab) : "";

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
                title=${this._displayTitle(title)}
              >
                <span class="review-tab-label">${this._displayTitle(title)}</span>
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
                                ${this._displayTitle(title)}
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
          <div class="review-submit-summary">
            <span class="review-submit-count">
              ${activeCount > 0
                ? `${activeCount} comment${activeCount !== 1 ? "s" : ""} on active document`
                : "No inline comments on active document"}
            </span>
          </div>

          <label class="review-final-comment">
            <span class="review-final-comment-label">Final comment</span>
            <textarea
              class="review-final-comment-input"
              .value=${activeFinalComment}
              placeholder="Optional for approval; required to reject without inline comments."
              rows="3"
              @input=${this._onFinalCommentInput}
              aria-invalid=${this._validationError ? "true" : "false"}
              aria-describedby="review-decision-error"
            ></textarea>
          </label>

          ${this._validationError
            ? html`<div id="review-decision-error" class="review-validation-error" role="alert">${this._validationError}</div>`
            : ""}

          <div class="review-submit-actions">
            <button
              class="review-submit-btn review-submit-btn--compat"
              disabled
              hidden
              aria-hidden="true"
              tabindex="-1"
              type="button"
            ></button>
            <button
              class="review-dismiss-btn"
              @click=${this._dismiss}
            >Dismiss</button>
            <button
              class="review-reject-btn"
              ?disabled=${!activeDoc}
              @click=${() => this._submitDecision("reject")}
            >Reject</button>
            <button
              class="review-approve-btn"
              ?disabled=${!activeDoc}
              @click=${() => this._submitDecision("approve")}
            >Approve</button>
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
