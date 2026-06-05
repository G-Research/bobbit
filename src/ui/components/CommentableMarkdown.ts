/**
 * <commentable-markdown> — thin wrapper around <review-document> that
 * mounts the ephemeral `proposalBackend` for inline comments on goal,
 * role, and staff proposal panels.
 *
 * Light DOM (annotator needs DOM access). Selection capture, popover,
 * re-anchoring all flow through <review-document>; we only swap the
 * store backend and forward the annotation-change event with a count.
 */

import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  proposalBackend,
  composeProposalFeedback,
} from "./review/proposal-annotations.js";
import { ensureReviewComponents } from "../../app/lazy-review.js";

@customElement("commentable-markdown")
export class CommentableMarkdown extends LitElement {
  @property({ type: String }) markdown = "";
  @property({ type: String }) sessionId = "";
  /** Stable bucket key, e.g. "proposal:goal". */
  @property({ type: String }) bucket = "";

  // Light DOM — <review-document> needs DOM access for the annotator.
  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Kick off the heavy review-document chunk on first mount. The
    // <review-document> element rendered below stays as an
    // HTMLUnknownElement until the chunk lands and customElements
    // defines it — Lit's property bindings are preserved across the
    // upgrade, so no manual re-render is needed.
    void ensureReviewComponents();
  }

  render() {
    return html`<review-document
      .markdown=${this.markdown}
      .sessionId=${this.sessionId}
      .docTitle=${this.bucket}
      .backend=${proposalBackend}
      @annotation-change=${this._onChange}
    ></review-document>`;
  }

  private _onChange = (e: Event) => {
    // <review-document> dispatches `annotation-change` with NO detail to
    // signal a change. We catch it here, swallow the original (so it
    // doesn't bubble past us and reach our parent's handler with
    // detail=undefined — which would zero the count), and re-dispatch
    // an enriched event from `this` carrying the canonical count.
    e.stopPropagation();
    const count = proposalBackend.count({
      sessionId: this.sessionId,
      bucket: this.bucket,
    });
    this.dispatchEvent(
      new CustomEvent("annotation-change", {
        detail: { count },
        bubbles: true,
        composed: true,
      }),
    );
  };

  /**
   * Build the composed feedback string and clear the local bucket.
   * Returns an empty string when there are no annotations.
   */
  sendFeedback(): string {
    const text = composeProposalFeedback(
      this.sessionId,
      this.bucket,
      this.markdown,
    );
    proposalBackend.clear({ sessionId: this.sessionId, bucket: this.bucket });
    this.dispatchEvent(
      new CustomEvent("composed-feedback", {
        detail: { text },
        bubbles: true,
        composed: true,
      }),
    );
    return text;
  }

  /** Current annotation count for this bucket. */
  count(): number {
    return proposalBackend.count({
      sessionId: this.sessionId,
      bucket: this.bucket,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "commentable-markdown": CommentableMarkdown;
  }
}
