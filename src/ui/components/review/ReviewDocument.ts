import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { marked } from "marked";
import { createTextAnnotator, type TextAnnotator } from "@recogito/text-annotator";
import "@recogito/text-annotator/text-annotator.css";
import {
  addAnnotation,
  removeAnnotation,
  getAnnotations,
  type ReviewAnnotation,
} from "./AnnotationStore.js";
import "./AnnotationPopover.js";
import "./review-pane.css";

/**
 * <review-document> — Renders markdown with text annotation support.
 *
 * Uses `marked` for markdown rendering and `@recogito/text-annotator` for
 * text selection and highlighting. Does NOT use Shadow DOM so the annotator
 * can access the rendered DOM directly.
 */
@customElement("review-document")
export class ReviewDocument extends LitElement {
  @property({ type: String }) markdown = "";
  @property({ type: String }) sessionId = "";
  @property({ type: String }) docTitle = "";

  @state() private _popoverOpen = false;
  @state() private _popoverX = 0;
  @state() private _popoverY = 0;
  @state() private _selectedText = "";
  @state() private _detachedAnnotations: ReviewAnnotation[] = [];
  @state() private _bannerMessage = "";
  @state() private _annotations: ReviewAnnotation[] = [];

  private _annotator: TextAnnotator | null = null;
  private _pendingSelection: { quote: string; prefix: string; suffix: string; start: number; end: number; isCode: boolean } | null = null;
  private _contentEl: HTMLDivElement | null = null;

  // Render into light DOM so annotator can access elements
  createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._destroyAnnotator();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("markdown") || changed.has("sessionId") || changed.has("docTitle")) {
      this._renderMarkdown();
    }
  }

  private _renderMarkdown(): void {
    const container = this.querySelector(".review-document-content") as HTMLDivElement;
    if (!container) return;
    this._contentEl = container;

    // Destroy previous annotator before re-rendering content
    this._destroyAnnotator();

    // Render markdown to HTML
    const htmlContent = marked.parse(this.markdown, { async: false }) as string;
    container.innerHTML = htmlContent;

    // Restore and re-anchor existing annotations
    this._reanchorAnnotations();

    // Attach the text annotator
    this._attachAnnotator(container);
  }

  private _attachAnnotator(container: HTMLElement): void {
    try {
      this._annotator = createTextAnnotator(container, {
        renderer: "SPANS",
      });

      // Re-add annotations that were successfully re-anchored
      for (const ann of this._annotations) {
        if (ann.start != null && ann.end != null) {
          try {
            this._annotator.addAnnotation({
              id: ann.id,
              bodies: [{ id: `${ann.id}-body`, annotation: ann.id, purpose: "commenting", value: ann.comment }],
              target: {
                annotation: ann.id,
                selector: [{
                  quote: ann.quote,
                  start: ann.start,
                  end: ann.end,
                  range: document.createRange(),
                }],
              },
            });
          } catch {
            // Annotation couldn't be placed — already in detached list
          }
        }
      }

      this._annotator.on("createAnnotation", (annotation: any) => {
        this._handleSelection(annotation);
      });
    } catch (e) {
      console.warn("[review-document] Failed to attach text annotator:", e);
    }
  }

  private _handleSelection(annotation: any): void {
    // Extract selection details from the annotation
    const target = annotation.target;
    const selectors = Array.isArray(target?.selector) ? target.selector : [target?.selector];
    const selector = selectors[0];
    if (!selector) return;

    const quote = selector.quote || "";
    const start = selector.start ?? 0;
    const end = selector.end ?? 0;

    // Get prefix/suffix from surrounding text
    const fullText = this._contentEl?.textContent || "";
    const prefix = fullText.slice(Math.max(0, start - 32), start);
    const suffix = fullText.slice(end, end + 32);

    // Detect if selection is inside a code block
    const sel = window.getSelection();
    let isCode = false;
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer.parentElement;
      if (node?.closest("code") || node?.closest("pre")) {
        isCode = true;
      }
    }

    // Remove the auto-created annotation from the annotator — we'll re-add after comment
    try {
      this._annotator?.removeAnnotation(annotation.id || annotation);
    } catch {
      // ignore
    }

    this._pendingSelection = { quote, prefix, suffix, start, end, isCode };
    this._selectedText = quote;

    // Position popover near the selection
    if (sel && sel.rangeCount > 0) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const containerRect = this.getBoundingClientRect();
      this._popoverX = rect.left - containerRect.left;
      this._popoverY = rect.bottom - containerRect.top + 8;
    }
    this._popoverOpen = true;
  }

  private _onAnnotationSubmit(e: CustomEvent): void {
    const { comment } = e.detail;
    if (!comment || !this._pendingSelection) return;

    const sel = this._pendingSelection;
    const ann: ReviewAnnotation = {
      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      quote: sel.quote,
      comment,
      prefix: sel.prefix,
      suffix: sel.suffix,
      start: sel.start,
      end: sel.end,
      isCode: sel.isCode,
    };

    addAnnotation(this.sessionId, this.docTitle, ann);
    this._annotations = getAnnotations(this.sessionId, this.docTitle);
    this._pendingSelection = null;
    this._popoverOpen = false;

    // Clear browser selection
    window.getSelection()?.removeAllRanges();

    // Add highlight via annotator
    if (this._annotator && ann.start != null && ann.end != null) {
      try {
        this._annotator.addAnnotation({
          id: ann.id,
          bodies: [{ id: `${ann.id}-body`, annotation: ann.id, purpose: "commenting", value: ann.comment }],
          target: {
            annotation: ann.id,
            selector: [{
              quote: ann.quote,
              start: ann.start,
              end: ann.end,
              range: document.createRange(),
            }],
          },
        });
      } catch {
        // fallback — annotation visuals may not appear but data is saved
      }
    }

    // Notify parent of annotation count change
    this.dispatchEvent(new CustomEvent("annotation-change", { bubbles: true, composed: true }));
  }

  private _onAnnotationCancel(): void {
    this._pendingSelection = null;
    this._popoverOpen = false;
    window.getSelection()?.removeAllRanges();
  }

  private _removeAnnotation(annotationId: string): void {
    removeAnnotation(this.sessionId, this.docTitle, annotationId);
    this._annotations = getAnnotations(this.sessionId, this.docTitle);
    this._detachedAnnotations = this._detachedAnnotations.filter(a => a.id !== annotationId);

    try {
      this._annotator?.removeAnnotation(annotationId);
    } catch {
      // ignore
    }

    this.dispatchEvent(new CustomEvent("annotation-change", { bubbles: true, composed: true }));
  }

  private _reanchorAnnotations(): void {
    const existing = getAnnotations(this.sessionId, this.docTitle);
    if (existing.length === 0) {
      this._annotations = [];
      this._detachedAnnotations = [];
      this._bannerMessage = "";
      return;
    }

    const fullText = this._contentEl?.textContent || "";
    const anchored: ReviewAnnotation[] = [];
    const detached: ReviewAnnotation[] = [];

    for (const ann of existing) {
      // Try position-based re-anchoring first
      if (ann.start != null && ann.end != null) {
        const textAtPosition = fullText.slice(ann.start, ann.end);
        if (textAtPosition === ann.quote) {
          anchored.push(ann);
          continue;
        }
      }

      // Try quote-based re-anchoring with prefix/suffix context
      let found = false;
      if (ann.prefix && ann.suffix) {
        const searchStr = ann.prefix + ann.quote + ann.suffix;
        const idx = fullText.indexOf(searchStr);
        if (idx >= 0) {
          const newStart = idx + ann.prefix.length;
          const newEnd = newStart + ann.quote.length;
          anchored.push({ ...ann, start: newStart, end: newEnd });
          found = true;
        }
      }

      if (!found) {
        // Try simple quote match
        const idx = fullText.indexOf(ann.quote);
        if (idx >= 0) {
          anchored.push({ ...ann, start: idx, end: idx + ann.quote.length });
        } else {
          detached.push(ann);
        }
      }
    }

    this._annotations = anchored;
    this._detachedAnnotations = detached;

    // Show re-anchoring banner if content changed
    const wasUpdated = existing.length > 0 && (anchored.length !== existing.length || detached.length > 0);
    if (wasUpdated) {
      this._bannerMessage =
        `Document updated — ${anchored.length} comment${anchored.length !== 1 ? "s" : ""} re-anchored` +
        (detached.length > 0 ? `, ${detached.length} orphaned` : "");
    } else {
      this._bannerMessage = "";
    }
  }

  private _destroyAnnotator(): void {
    if (this._annotator) {
      try {
        this._annotator.destroy();
      } catch {
        // ignore
      }
      this._annotator = null;
    }
  }

  render() {
    return html`
      ${this._bannerMessage
        ? html`<div class="review-banner">${this._bannerMessage}</div>`
        : ""}
      <div class="review-document-content"></div>
      ${this._detachedAnnotations.length > 0
        ? html`
            <div class="review-detached">
              <h4>Detached Comments</h4>
              <p class="review-detached-info">These comments could not be re-anchored after the document was updated.</p>
              ${this._detachedAnnotations.map(
                (ann) => html`
                  <div class="review-detached-item">
                    <div class="review-detached-quote">"${ann.quote}"</div>
                    <div class="review-detached-comment">${ann.comment}</div>
                    <button
                      class="review-detached-remove"
                      @click=${() => this._removeAnnotation(ann.id)}
                      title="Remove comment"
                    >×</button>
                  </div>
                `,
              )}
            </div>
          `
        : ""}
      <annotation-popover
        .open=${this._popoverOpen}
        .x=${this._popoverX}
        .y=${this._popoverY}
        .selectedText=${this._selectedText}
        @annotation-submit=${this._onAnnotationSubmit}
        @annotation-cancel=${this._onAnnotationCancel}
      ></annotation-popover>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-document": ReviewDocument;
  }
}
