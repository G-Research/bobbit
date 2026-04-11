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

  // Mobile selection state
  @state() private _isMobile = false;
  @state() private _showFloatingBtn = false;
  @state() private _floatingBtnX = 0;
  @state() private _floatingBtnY = 0;
  @state() private _popoverMode: "popover" | "bottom-sheet" = "popover";
  @state() private _toastMessage = "";
  @state() private _existingComment = "";

  private _annotator: TextAnnotator | null = null;
  private _pendingSelection: { quote: string; prefix: string; suffix: string; start: number; end: number; isCode: boolean } | null = null;
  private _contentEl: HTMLDivElement | null = null;
  private _selectionDebounceTimer: number | undefined;
  private _boundSelectionChange: (() => void) | null = null;
  private _boundMobileAnnotationTap: ((e: Event) => void) | null = null;
  private _toastTimer: number | undefined;
  private _editingAnnotationId: string | null = null;
  private _pendingAnnId: string | null = null;

  // Render into light DOM so annotator can access elements
  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._isMobile = window.matchMedia("(pointer: coarse)").matches;
    if (this._isMobile) {
      this._boundSelectionChange = this._onSelectionChange.bind(this);
      document.addEventListener("selectionchange", this._boundSelectionChange);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._destroyAnnotator();
    // Clean up mobile listeners
    if (this._boundSelectionChange) {
      document.removeEventListener("selectionchange", this._boundSelectionChange);
      this._boundSelectionChange = null;
    }
    if (this._selectionDebounceTimer != null) {
      clearTimeout(this._selectionDebounceTimer);
      this._selectionDebounceTimer = undefined;
    }
    if (this._boundMobileAnnotationTap) {
      this._contentEl?.removeEventListener("click", this._boundMobileAnnotationTap);
      this._boundMobileAnnotationTap = null;
    }
    if (this._toastTimer != null) {
      clearTimeout(this._toastTimer);
      this._toastTimer = undefined;
    }
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

    // Escape HTML tags before markdown parsing (same pattern as MarkdownBlock)
    // to prevent XSS from agent-supplied content
    let safeContent = this.markdown;
    const codeBlocks: string[] = [];
    safeContent = safeContent.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
      const index = codeBlocks.length;
      codeBlocks.push(match);
      return `__CODE_BLOCK_${index}__`;
    });
    safeContent = safeContent
      .replace(/<(\w+)([^>]*)>/g, "&lt;$1$2&gt;")
      .replace(/<\/(\w+)>/g, "&lt;/$1&gt;")
      .replace(/<(\w+)([^>]*)\s*\/>/g, "&lt;$1$2/&gt;")
      .replace(/<(?![^\s])/g, "&lt;");
    codeBlocks.forEach((block, index) => {
      safeContent = safeContent.replace(`__CODE_BLOCK_${index}__`, block);
    });

    // Render markdown to HTML
    const htmlContent = marked.parse(safeContent, { async: false }) as string;
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

      // Listen for clicks on existing annotation highlights (edit/delete)
      this._boundMobileAnnotationTap = this._onMobileAnnotationTap.bind(this);
      this._contentEl?.addEventListener("click", this._boundMobileAnnotationTap);
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

  // --- Mobile selection flow ---

  private _onSelectionChange(): void {
    if (!this._isMobile) return;
    if (this._selectionDebounceTimer != null) clearTimeout(this._selectionDebounceTimer);
    this._selectionDebounceTimer = window.setTimeout(() => {
      this._handleMobileSelection();
    }, 300);
  }

  private _handleMobileSelection(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this._showFloatingBtn = false;
      return;
    }

    // Validate selection is inside our content element
    if (!this._contentEl || !this._contentEl.contains(sel.anchorNode)) {
      this._showFloatingBtn = false;
      return;
    }

    const text = sel.toString().trim();
    if (text.length < 3) {
      this._showFloatingBtn = false;
      return;
    }

    // Position floating button below the selection (avoids iOS native Copy menu above)
    const range = sel.getRangeAt(0);
    const rangeRect = range.getBoundingClientRect();
    const containerRect = this.getBoundingClientRect();

    this._floatingBtnX = rangeRect.left - containerRect.left + rangeRect.width / 2 - 50; // ~center the button
    this._floatingBtnY = rangeRect.bottom - containerRect.top + 8;

    // Clamp X to stay within bounds
    if (this._floatingBtnX < 4) this._floatingBtnX = 4;
    const maxX = containerRect.width - 120;
    if (this._floatingBtnX > maxX) this._floatingBtnX = maxX;

    this._showFloatingBtn = true;
  }

  private _onMobileAddComment(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      this._showToast("Selection lost \u2014 try again");
      this._showFloatingBtn = false;
      return;
    }

    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      this._showToast("Selection lost \u2014 try again");
      this._showFloatingBtn = false;
      return;
    }

    const quote = range.toString();
    const fullText = this._contentEl?.textContent || "";

    // Compute character offsets relative to _contentEl
    const preRange = document.createRange();
    preRange.selectNodeContents(this._contentEl!);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + quote.length;

    const prefix = fullText.slice(Math.max(0, start - 32), start);
    const suffix = fullText.slice(end, end + 32);
    const isCode = range.startContainer.parentElement?.closest("code, pre") != null;

    // Remove any auto-created annotation from annotator (defensive)
    try {
      this._annotator?.cancelSelected?.();
    } catch { /* ignore */ }

    this._pendingSelection = { quote, prefix, suffix, start, end, isCode };
    this._selectedText = quote;

    // Add highlight via annotator
    const annId = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._pendingAnnId = annId;
    if (this._annotator) {
      try {
        this._annotator.addAnnotation({
          id: annId,
          bodies: [],
          target: {
            annotation: annId,
            selector: [{ quote, start, end, range: document.createRange() }],
          },
        });
      } catch { /* fallback — highlight may not appear */ }
    }

    this._popoverMode = "bottom-sheet";
    this._existingComment = "";
    this._popoverOpen = true;
    this._showFloatingBtn = false;

    // Clear browser selection
    window.getSelection()?.removeAllRanges();
  }

  private _onMobileAnnotationTap(e: Event): void {
    const target = (e.target as HTMLElement).closest(".r6o-annotation");
    if (!target) {
      // Tapped outside annotation — hide floating button if visible
      if (this._showFloatingBtn) this._showFloatingBtn = false;
      return;
    }

    const annotationId = target.getAttribute("data-annotation");
    if (!annotationId) return;

    const ann = this._annotations.find((a) => a.id === annotationId);
    if (!ann) return;

    this._pendingSelection = {
      quote: ann.quote,
      prefix: ann.prefix || "",
      suffix: ann.suffix || "",
      start: ann.start ?? 0,
      end: ann.end ?? 0,
      isCode: ann.isCode || false,
    };
    this._selectedText = ann.quote;
    this._existingComment = ann.comment || "";
    this._editingAnnotationId = ann.id;
    this._popoverMode = this._isMobile ? "bottom-sheet" : "popover";
    this._popoverOpen = true;
    this._showFloatingBtn = false;

    // Position popover near the clicked highlight for desktop
    if (!this._isMobile) {
      const rect = target.getBoundingClientRect();
      const containerRect = this._contentEl?.getBoundingClientRect();
      if (containerRect) {
        this._popoverX = rect.left - containerRect.left;
        this._popoverY = rect.bottom - containerRect.top + 4;
      }
    }
  }

  private _showToast(message: string): void {
    this._toastMessage = message;
    if (this._toastTimer != null) clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => {
      this._toastMessage = "";
      this._toastTimer = undefined;
    }, 2000);
  }

  // --- End mobile selection flow ---

  private _onAnnotationSubmit(e: CustomEvent): void {
    const { comment } = e.detail;
    if (!comment || !this._pendingSelection) return;

    // If editing an existing annotation, remove the old one first
    if (this._editingAnnotationId) {
      removeAnnotation(this.sessionId, this.docTitle, this._editingAnnotationId);
      try { this._annotator?.removeAnnotation(this._editingAnnotationId); } catch { /* ignore */ }
    }

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
    this._popoverMode = "popover";
    this._existingComment = "";
    this._editingAnnotationId = null;
    if (this._pendingAnnId) {
      try { this._annotator?.removeAnnotation(this._pendingAnnId); } catch { /* ignore */ }
    }
    this._pendingAnnId = null;

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
    // Remove orphaned highlight from a cancelled "Add Comment" flow
    if (this._pendingAnnId) {
      try { this._annotator?.removeAnnotation(this._pendingAnnId); } catch { /* ignore */ }
      this._pendingAnnId = null;
    }
    this._pendingSelection = null;
    this._popoverOpen = false;
    this._popoverMode = "popover";
    this._existingComment = "";
    this._editingAnnotationId = null;
    window.getSelection()?.removeAllRanges();
    // Return focus to the message editor textarea (PI-24b)
    requestAnimationFrame(() => {
      const editor = document.querySelector("message-editor");
      const textarea = editor?.querySelector("textarea");
      if (textarea) (textarea as HTMLElement).focus();
    });
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
      ${this._showFloatingBtn && this._isMobile
        ? html`<button
            class="review-floating-btn"
            style="left:${this._floatingBtnX}px;top:${this._floatingBtnY}px"
            @click=${this._onMobileAddComment}
          >+ Comment</button>`
        : ""}
      ${this._toastMessage
        ? html`<div class="review-toast">${this._toastMessage}</div>`
        : ""}
      <annotation-popover
        .open=${this._popoverOpen}
        .x=${this._popoverX}
        .y=${this._popoverY}
        .selectedText=${this._selectedText}
        .mode=${this._popoverMode}
        .existingComment=${this._existingComment}
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
