import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import {
  buildReviewDecisionPayloadForReview,
  getDocumentAnnotationCountForDocument,
  getReviewAnnotationCount,
} from "./AnnotationStore.js";
import { ensureReviewComponents } from "../../../app/lazy-review.js";
import type {
  ReviewDecision,
  ReviewDecisionEventDetail,
  ReviewDocumentModel,
  ReviewFileModel,
  ReviewGroupModel,
  ReviewSource,
} from "./review-types.js";
import "./review-pane.css";

let overflowMenuSequence = 0;

// Final comments are review-level drafts. Keep them outside individual pane
// instances so eager mobile panes and desktop/mobile remounts share one exact
// owner keyed by session + review identity.
const finalCommentsByReview = new Map<string, string>();

function finalCommentKey(sessionId: string, reviewId: string): string {
  return `${sessionId}\u0000${reviewId}`;
}

export function reviewFinalComment(sessionId: string, reviewId: string): string {
  return finalCommentsByReview.get(finalCommentKey(sessionId, reviewId)) || "";
}

export function reviewFinalCommentCount(sessionId: string, reviewId: string): number {
  return reviewFinalComment(sessionId, reviewId).trim() ? 1 : 0;
}

export function discardReviewFinalComment(sessionId: string, reviewId: string): void {
  finalCommentsByReview.delete(finalCommentKey(sessionId, reviewId));
}

/**
 * <review-pane> renders one selected review. The app workspace owns primary
 * review tabs; this component only renders the review's navigation-only files.
 */
export class ReviewPane extends LitElement {
  /** Canonical grouped-review input. */
  @property({ attribute: false })
  review: ReviewGroupModel | null = null;

  /** Compatibility inputs for the original single-document/group mirror. */
  @property({ attribute: false })
  documents: Map<string, ReviewDocumentModel> = new Map();
  @property({ type: String }) activeTab = "";
  @property({ type: String }) sessionId = "";

  @state() private _overflowOpen = false;
  @state() private _visibleFileCount = 5;
  @state() private _validationError = "";

  private readonly _overflowMenuId = `review-file-overflow-${++overflowMenuSequence}`;
  private _restoreOverflowFocus = false;
  private _overflowListenersInstalled = false;
  private _overflowResizeObserver: ResizeObserver | null = null;
  private _observedTabBar: HTMLElement | null = null;
  private _overflowMeasurementQueued = false;

  createRenderRoot() {
    return this;
  }

  private _boundCacheReady = (event: Event) => {
    const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
    if (!detail?.sessionId || detail.sessionId === this.sessionId) this.requestUpdate();
  };
  private _boundOutsidePointer = (event: Event) => this._onOutsidePointer(event);
  private _boundDocumentKeydown = (event: Event) => this._onDocumentKeydown(event as KeyboardEvent);

  connectedCallback(): void {
    super.connectedCallback();
    void ensureReviewComponents();
    window.addEventListener("annotation-cache-ready", this._boundCacheReady);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("annotation-cache-ready", this._boundCacheReady);
    this._removeOverflowListeners();
    this._overflowResizeObserver?.disconnect();
    this._overflowResizeObserver = null;
    this._observedTabBar = null;
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("review") || changed.has("activeTab")) {
      this._validationError = "";
      if (this._overflowOpen) this._closeOverflow(false);
    }
    this._syncOverflowMeasurement();
    if (changed.has("_overflowOpen")) {
      if (this._overflowOpen) this._openRenderedOverflow();
      else {
        this._removeOverflowListeners();
        if (this._restoreOverflowFocus) {
          this._restoreOverflowFocus = false;
          this.querySelector<HTMLButtonElement>(".review-tab-overflow-trigger")?.focus();
        }
      }
    }
  }

  private _compatibilityReview(): ReviewGroupModel | null {
    if (this.review) return this.review;
    const entries = [...this.documents.entries()];
    if (entries.length === 0) return null;
    const first = entries[0]![1];
    const files: ReviewFileModel[] = entries.map(([key, document]) => ({
      fileId: document.fileId || document.documentId || key,
      title: document.title || key,
      markdown: document.markdown,
    }));
    const active = this.documents.get(this.activeTab);
    const activeFileId = active?.fileId || active?.documentId || (this.documents.has(this.activeTab) ? this.activeTab : files[0]!.fileId);
    const source: ReviewSource = first.source || { kind: "markdown-review", sessionId: this.sessionId };
    return {
      reviewId: first.reviewId || first.documentId || files[0]!.fileId,
      title: first.title || "Review",
      files,
      activeFileId,
      source,
    };
  }

  private _activeFile(review: ReviewGroupModel | null): ReviewFileModel | null {
    if (!review) return null;
    return review.files.find((file) => file.fileId === review.activeFileId) || review.files[0] || null;
  }

  private _documentFor(review: ReviewGroupModel, file: ReviewFileModel): ReviewDocumentModel {
    return {
      title: file.title,
      markdown: file.markdown,
      source: review.source,
      documentId: file.fileId,
      fileId: file.fileId,
      reviewId: review.reviewId,
    };
  }

  private _annotationCountFor(review: ReviewGroupModel, file: ReviewFileModel): number {
    return getDocumentAnnotationCountForDocument(
      this.sessionId,
      file.fileId,
      this._documentFor(review, file),
      new Map(review.files.map((candidate) => [candidate.fileId, this._documentFor(review, candidate)])),
    );
  }

  private _finalCommentFor(reviewId: string): string {
    return reviewFinalComment(this.sessionId, reviewId);
  }

  private _setFinalComment(reviewId: string, comment: string): void {
    const key = finalCommentKey(this.sessionId, reviewId);
    if (comment) finalCommentsByReview.set(key, comment);
    else finalCommentsByReview.delete(key);
    this.requestUpdate();
  }

  private _deleteFinalComment(reviewId: string): void {
    discardReviewFinalComment(this.sessionId, reviewId);
    this.requestUpdate();
  }

  private _reviewUnsentCommentCount(review: ReviewGroupModel): number {
    return getReviewAnnotationCount(this.sessionId, review)
      + (this._finalCommentFor(review.reviewId).trim() ? 1 : 0);
  }

  /** Exact seam used by primary workspace close confirmation. */
  _unsentCommentCountForReview(reviewOrId: ReviewGroupModel | string): number {
    const mountedReview = this._compatibilityReview();
    const review = typeof reviewOrId === "string"
      ? (mountedReview?.reviewId === reviewOrId ? mountedReview : null)
      : reviewOrId;
    return review ? this._reviewUnsentCommentCount(review) : Number.NaN;
  }

  /** Remove only one successfully closed review's in-memory final draft. */
  _discardFinalCommentForReview(reviewId: string): void {
    this._deleteFinalComment(reviewId);
  }

  /** Compatibility seam for legacy file-keyed workspace tabs. */
  _unsentCommentCountForDocument(identity: string): number {
    const review = this._compatibilityReview();
    if (!review) return 0;
    const matches = review.reviewId === identity
      || review.files.some((file) => file.fileId === identity || file.title === identity);
    return matches ? this._reviewUnsentCommentCount(review) : 0;
  }

  private _onAnnotationChange(): void {
    this._validationError = "";
    this.requestUpdate();
  }

  private _switchFile(reviewId: string, fileId: string): void {
    this._closeOverflow(true);
    this._validationError = "";
    this.dispatchEvent(new CustomEvent("review-file-change", {
      detail: { reviewId, fileId },
      bubbles: true,
      composed: true,
    }));
  }

  private _onFinalCommentInput(event: Event): void {
    const review = this._compatibilityReview();
    if (!review) return;
    const finalComment = (event.target as HTMLTextAreaElement).value;
    this._setFinalComment(review.reviewId, finalComment);
    if (finalComment.trim()) this._validationError = "";
  }

  private _submitDecision(decision: ReviewDecision): void {
    const review = this._compatibilityReview();
    const activeFile = this._activeFile(review);
    if (!review || !activeFile) return;

    const finalComment = this._finalCommentFor(review.reviewId).trim();
    const inlineCount = getReviewAnnotationCount(this.sessionId, review);
    if (decision === "reject" && inlineCount === 0 && !finalComment) {
      this._validationError = "Add a final comment or at least one inline comment before rejecting.";
      return;
    }

    this._validationError = "";
    const payload = buildReviewDecisionPayloadForReview(this.sessionId, review, decision, finalComment);
    const activeDocument = this._documentFor(review, activeFile);
    const detail: ReviewDecisionEventDetail & { reviewId: string; fileId: string; sessionId: string } = {
      review,
      reviewId: review.reviewId,
      fileId: activeFile.fileId,
      sessionId: this.sessionId,
      document: activeDocument,
      source: review.source,
      payload,
      decision: payload.decision,
      finalComment: payload.finalComment,
      inlineComments: payload.inlineComments,
      feedback: payload.feedback,
    };

    const wasNotCanceled = this.dispatchEvent(new CustomEvent("review-decision", {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    }));

    // Preserve arbitrary Markdown review routing until the app-level grouped
    // handler owns the event by preventing its default action.
    if (wasNotCanceled && review.source.kind === "markdown-review") {
      this.dispatchEvent(new CustomEvent("review-submit", {
        detail: { review, reviewId: review.reviewId, sessionId: this.sessionId, feedback: payload.feedback, payload },
        bubbles: true,
        composed: true,
      }));
    }
  }

  private _dismiss(): void {
    const review = this._compatibilityReview();
    if (!review) return;
    const unsentCommentCount = this._reviewUnsentCommentCount(review);
    if (unsentCommentCount > 0
      && !confirm(`Dismiss "${review.title}"? ${unsentCommentCount} unsent comment${unsentCommentCount !== 1 ? "s" : ""} will be lost.`)) return;
    // The app discards this draft only after authoritative workspace cleanup.
    // A terminal close failure must leave it available for a manual retry.
    this.dispatchEvent(new CustomEvent("review-dismiss", {
      detail: { review, reviewId: review.reviewId, sessionId: this.sessionId, unsentCommentCount },
      bubbles: true,
      composed: true,
    }));
  }

  private _toggleOverflow(event: Event): void {
    event.stopPropagation();
    if (this._overflowOpen) this._closeOverflow(true);
    else this._overflowOpen = true;
  }

  private _syncOverflowMeasurement(): void {
    const bar = this.querySelector<HTMLElement>(".review-tab-bar");
    if (bar !== this._observedTabBar) {
      this._overflowResizeObserver?.disconnect();
      this._overflowResizeObserver = null;
      this._observedTabBar = bar;
      if (bar && typeof ResizeObserver !== "undefined") {
        this._overflowResizeObserver = new ResizeObserver(() => this._queueOverflowMeasurement());
        this._overflowResizeObserver.observe(bar);
      }
    }
    if (bar) this._queueOverflowMeasurement();
  }

  private _queueOverflowMeasurement(): void {
    if (this._overflowMeasurementQueued) return;
    this._overflowMeasurementQueued = true;
    queueMicrotask(() => {
      this._overflowMeasurementQueued = false;
      if (this.isConnected) this._measureVisibleFileCount();
    });
  }

  private _measureVisibleFileCount(): void {
    const review = this._compatibilityReview();
    const bar = this._observedTabBar;
    if (!review || !bar || review.files.length < 2) return;

    const barWidth = bar.getBoundingClientRect().width || bar.clientWidth;
    // DOM-only test environments have no layout engine. Preserve the historical
    // five-item fallback there; real layout always follows the measured prefix.
    if (!(barWidth > 0)) {
      const fallback = Math.min(5, review.files.length);
      if (fallback !== this._visibleFileCount) this._visibleFileCount = fallback;
      return;
    }

    const style = getComputedStyle(bar);
    const measuredPadding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    // Match the component's authored bounds even during the brief stylesheet
    // loading race (and in CSS-free fixture shells).
    const padding = Math.max(24, measuredPadding);
    const gap = Math.max(2, Number.parseFloat(style.columnGap || style.gap) || 0);
    const availableWidth = Math.max(0, barWidth - padding);
    const measurements = [...bar.querySelectorAll<HTMLElement>(".review-tab-measure")];
    const widths = review.files.map((file, index) => {
      const measured = measurements[index]?.getBoundingClientRect().width || measurements[index]?.offsetWidth || 0;
      const badgeWidth = this._annotationCountFor(review, file) > 0 ? 24 : 0;
      const naturalWidth = measured || 24 + file.title.length * 7 + badgeWidth;
      return Math.min(168, Math.max(128, naturalWidth));
    });
    const allTabsWidth = widths.reduce((total, width) => total + width, 0) + gap * Math.max(0, widths.length - 1);
    let nextVisibleCount = review.files.length;

    if (allTabsWidth > availableWidth) {
      const moreMeasure = bar.querySelector<HTMLElement>(".review-tab-overflow-measure");
      const measuredMoreWidth = moreMeasure?.getBoundingClientRect().width || moreMeasure?.offsetWidth || 0;
      const moreWidth = Math.max(40, measuredMoreWidth);
      let usedWidth = 0;
      nextVisibleCount = 0;
      for (const width of widths) {
        const candidateTabsWidth = usedWidth + (nextVisibleCount > 0 ? gap : 0) + width;
        const candidateTotal = candidateTabsWidth + gap + moreWidth;
        if (candidateTotal > availableWidth) break;
        usedWidth = candidateTabsWidth;
        nextVisibleCount += 1;
      }
    }

    if (nextVisibleCount !== this._visibleFileCount) {
      if (nextVisibleCount >= review.files.length && this._overflowOpen) this._closeOverflow(false);
      this._visibleFileCount = nextVisibleCount;
    }
  }

  private _closeOverflow(restoreFocus: boolean): void {
    if (!this._overflowOpen) return;
    this._restoreOverflowFocus = restoreFocus;
    const menu = this.querySelector<HTMLElement>(`#${this._overflowMenuId}`);
    try {
      if (menu && typeof (menu as HTMLElement & { hidePopover?: () => void }).hidePopover === "function") {
        (menu as HTMLElement & { hidePopover: () => void }).hidePopover();
      }
    } catch { /* render removal is the fallback */ }
    this._overflowOpen = false;
  }

  private _openRenderedOverflow(): void {
    const trigger = this.querySelector<HTMLButtonElement>(".review-tab-overflow-trigger");
    const menu = this.querySelector<HTMLElement>(`#${this._overflowMenuId}`);
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = 240;
    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    menu.style.top = `${Math.max(0, rect.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.right - menuWidth, viewportWidth - menuWidth - 8))}px`;
    try {
      if (typeof (menu as HTMLElement & { showPopover?: () => void }).showPopover === "function") {
        (menu as HTMLElement & { showPopover: () => void }).showPopover();
      }
    } catch { /* already open or unsupported; authored CSS remains the fallback */ }
    this._installOverflowListeners();
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    (items.find((item) => item.dataset.active === "true") || items[0])?.focus();
  }

  private _installOverflowListeners(): void {
    if (this._overflowListenersInstalled) return;
    this._overflowListenersInstalled = true;
    document.addEventListener("click", this._boundOutsidePointer);
    document.addEventListener("keydown", this._boundDocumentKeydown);
  }

  private _removeOverflowListeners(): void {
    if (!this._overflowListenersInstalled) return;
    this._overflowListenersInstalled = false;
    document.removeEventListener("click", this._boundOutsidePointer);
    document.removeEventListener("keydown", this._boundDocumentKeydown);
  }

  private _onOutsidePointer(event: Event): void {
    if (!this._overflowOpen) return;
    const path = event.composedPath();
    const trigger = this.querySelector(".review-tab-overflow-trigger");
    const menu = this.querySelector(`#${this._overflowMenuId}`);
    if (path.includes(trigger as EventTarget) || path.includes(menu as EventTarget)) return;
    this._closeOverflow(false);
  }

  private _onDocumentKeydown(event: KeyboardEvent): void {
    if (!this._overflowOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this._closeOverflow(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const menu = this.querySelector<HTMLElement>(`#${this._overflowMenuId}`);
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowUp" ? (current <= 0 ? items.length - 1 : current - 1)
          : (current + 1) % items.length;
    items[next]?.focus();
  }

  render() {
    const review = this._compatibilityReview();
    const activeFile = this._activeFile(review);
    const activeFinalComment = review ? this._finalCommentFor(review.reviewId) : "";
    const totalCount = review ? getReviewAnnotationCount(this.sessionId, review) : 0;
    const annotationCounts = new Map<string, number>();
    if (review) {
      for (const file of review.files) annotationCounts.set(file.fileId, this._annotationCountFor(review, file));
    }
    const files = review?.files || [];
    const visibleFiles = files.slice(0, Math.min(this._visibleFileCount, files.length));
    const overflowFiles = files.slice(visibleFiles.length);

    return html`
      <div class="review-pane">
        ${review && files.length > 1 ? html`
          <div class="review-tab-bar" role="tablist" aria-label="Files in ${review.title}">
            ${visibleFiles.map((file) => html`
              <button
                type="button"
                role="tab"
                aria-selected=${file.fileId === activeFile?.fileId ? "true" : "false"}
                class="review-tab ${file.fileId === activeFile?.fileId ? "review-tab--active" : ""}"
                @click=${() => this._switchFile(review.reviewId, file.fileId)}
                title=${file.title}
              >
                <span class="review-tab-label">${file.title}</span>
                ${(annotationCounts.get(file.fileId) || 0) > 0
                  ? html`<span class="review-tab-badge">${annotationCounts.get(file.fileId)}</span>`
                  : ""}
              </button>
            `)}
            ${overflowFiles.length > 0 ? html`
              <button
                type="button"
                class="review-tab review-tab-overflow-trigger"
                @click=${this._toggleOverflow}
                aria-label="More tabs"
                title="More tabs"
                aria-haspopup="menu"
                aria-expanded=${this._overflowOpen ? "true" : "false"}
                aria-controls=${this._overflowMenuId}
              >…</button>
            ` : ""}
            <div class="review-tab-measurements" aria-hidden="true">
              ${files.map((file) => html`
                <span class="review-tab-measure">
                  <span class="review-tab-label">${file.title}</span>
                  ${(annotationCounts.get(file.fileId) || 0) > 0
                    ? html`<span class="review-tab-badge">${annotationCounts.get(file.fileId)}</span>`
                    : ""}
                </span>
              `)}
              <span class="review-tab-overflow-measure">…</span>
            </div>
          </div>
          ${this._overflowOpen ? html`
            <div
              id=${this._overflowMenuId}
              class="review-tab-overflow"
              role="menu"
              aria-label="More files in ${review.title}"
              popover="auto"
            >
              ${overflowFiles.map((file) => html`
                <button
                  type="button"
                  role="menuitem"
                  class="review-tab-overflow-item ${file.fileId === activeFile?.fileId ? "review-tab--active" : ""}"
                  data-active=${file.fileId === activeFile?.fileId ? "true" : "false"}
                  @click=${() => this._switchFile(review.reviewId, file.fileId)}
                >
                  <span class="review-tab-label">${file.title}</span>
                  ${(annotationCounts.get(file.fileId) || 0) > 0
                    ? html`<span class="review-tab-badge">${annotationCounts.get(file.fileId)}</span>`
                    : ""}
                </button>
              `)}
            </div>
          ` : ""}
        ` : ""}

        <div class="review-document-area">
          ${activeFile ? html`
            <review-document
              .markdown=${activeFile.markdown}
              .sessionId=${this.sessionId}
              .docTitle=${activeFile.fileId}
              @annotation-change=${this._onAnnotationChange}
            ></review-document>
          ` : html`<div class="review-empty"><p>No review selected.</p></div>`}
        </div>

        <div class="review-submit-bar">
          <div class="review-submit-summary">
            <span class="review-submit-count">
              ${totalCount > 0
                ? `${totalCount} inline comment${totalCount !== 1 ? "s" : ""} across this review`
                : "No inline comments on this review"}
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
            <button class="review-submit-btn review-submit-btn--compat" disabled hidden aria-hidden="true" tabindex="-1" type="button"></button>
            <button class="review-dismiss-btn" ?disabled=${!review} @click=${this._dismiss}>Dismiss</button>
            <button class="review-reject-btn" ?disabled=${!activeFile} @click=${() => this._submitDecision("reject")}>Reject</button>
            <button class="review-approve-btn" ?disabled=${!activeFile} @click=${() => this._submitDecision("approve")}>Approve</button>
          </div>
        </div>
      </div>
    `;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("review-pane")) {
  customElements.define("review-pane", ReviewPane);
}

declare global {
  interface HTMLElementTagNameMap {
    "review-pane": ReviewPane;
  }
}
