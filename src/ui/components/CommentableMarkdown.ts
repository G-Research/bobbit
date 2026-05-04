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
import "./review/ReviewDocument.js";

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

  render() {
    return html`<review-document
      .markdown=${this.markdown}
      .sessionId=${this.sessionId}
      .docTitle=${this.bucket}
      .backend=${proposalBackend}
      @annotation-change=${this._onChange}
    ></review-document>`;
  }

  private _onChange = () => {
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
