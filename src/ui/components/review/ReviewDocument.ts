import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { marked } from "marked";
import { createTextAnnotator, type TextAnnotator } from "@recogito/text-annotator";
import "@recogito/text-annotator/text-annotator.css";
import {
  reviewBackend,
  type AnnotationBackend,
  type ReviewAnnotation,
} from "./AnnotationStore.js";
import {
  openAnnotationPopover,
  closeAnnotationPopover,
} from "./AnnotationPopover.js";
import "./review-pane.css";

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const URL_ATTRIBUTES = new Set(["href", "src", "poster", "action", "formaction", "xlink:href", "data"]);
const DATA_IMAGE_URL_ATTRIBUTES = new Set(["src", "poster", "xlink:href"]);
const SAFE_DATA_URL_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|avif);/i;
const FORBIDDEN_HTML_TAGS = new Set([
  "base",
  "button",
  "embed",
  "fieldset",
  "form",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "object",
  "option",
  "select",
  "script",
  "style",
  "svg",
  "textarea",
  "template",
]);
const FORBIDDEN_ATTRIBUTES = new Set(["srcdoc", "style"]);
const CODE_PLACEHOLDER_PREFIX = "\uE000REVIEW_CODE_";
const CODE_PLACEHOLDER_SUFFIX = "\uE001";

function _normalizeUrlForSafety(value: string): string {
  return value.trim().replace(/[\u0000-\u001F\u007F\s]+/g, "");
}

function _isSafeMarkdownUrl(value: string, attrName?: string): boolean {
  const normalized = _normalizeUrlForSafety(value);
  if (!normalized) return true;

  const lower = normalized.toLowerCase();
  if (lower.startsWith("javascript:")) return false;
  if (lower.startsWith("data:")) {
    return attrName != null && DATA_IMAGE_URL_ATTRIBUTES.has(attrName) && SAFE_DATA_URL_PATTERN.test(lower);
  }

  try {
    const parsed = new URL(normalized, globalThis.location?.href ?? "http://localhost/");
    return SAFE_URL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function _escapeRawHtmlOutsideCode(markdown: string): string {
  const codeBlocks: string[] = [];
  const protectedMarkdown = markdown.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${CODE_PLACEHOLDER_PREFIX}${index}${CODE_PLACEHOLDER_SUFFIX}`;
  });

  let escaped = protectedMarkdown.replace(/</g, "&lt;");
  codeBlocks.forEach((block, index) => {
    escaped = escaped.replace(`${CODE_PLACEHOLDER_PREFIX}${index}${CODE_PLACEHOLDER_SUFFIX}`, block);
  });
  return escaped;
}

function _sanitizeSrcset(value: string): string | null {
  const candidates = value.split(",").map((candidate) => candidate.trim()).filter(Boolean);
  if (candidates.length === 0) return "";

  for (const candidate of candidates) {
    const [url] = candidate.split(/\s+/, 1);
    if (!_isSafeMarkdownUrl(url, "src")) return null;
  }

  return candidates.join(", ");
}

export function sanitizeReviewMarkdownHtml(htmlContent: string): string {
  const template = document.createElement("template");
  template.innerHTML = htmlContent;

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    if (FORBIDDEN_HTML_TAGS.has(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }

    for (const attr of Array.from(element.attributes)) {
      const attrName = attr.name.toLowerCase();
      if (attrName.startsWith("on") || FORBIDDEN_ATTRIBUTES.has(attrName)) {
        element.removeAttribute(attr.name);
        continue;
      }

      if (URL_ATTRIBUTES.has(attrName) && !_isSafeMarkdownUrl(attr.value, attrName)) {
        element.removeAttribute(attr.name);
        continue;
      }

      if (attrName === "srcset") {
        const sanitizedSrcset = _sanitizeSrcset(attr.value);
        if (sanitizedSrcset == null) {
          element.removeAttribute(attr.name);
        } else {
          element.setAttribute(attr.name, sanitizedSrcset);
        }
      }
    }

    if (element instanceof HTMLAnchorElement) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
  }

  return template.innerHTML;
}

export function renderReviewMarkdownToHtml(markdown: string): string {
  const safeContent = _escapeRawHtmlOutsideCode(markdown);
  const htmlContent = marked.parse(safeContent, { async: false }) as string;
  return sanitizeReviewMarkdownHtml(htmlContent);
}

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
  /**
   * Pluggable annotation store backend. Defaults to the REST-backed
   * review-pane store. <commentable-markdown> overrides this with the
   * ephemeral in-memory `proposalBackend`.
   */
  @property({ attribute: false }) backend: AnnotationBackend = reviewBackend;

  @state() private _popoverOpen = false;
  /** Selection (or anchor highlight) rect in viewport coordinates. Passed
   *  to <annotation-popover> as a virtual-reference rect for Floating UI. */
  @state() private _popoverReferenceRect: DOMRect | null = null;
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

  // Hover chip state (desktop affordance over an existing highlight)
  @state() private _hoverChipId: string | null = null;
  @state() private _hoverChipX = 0;
  @state() private _hoverChipY = 0;
  private _hoverChipHideTimer: number | undefined;

  private _annotator: TextAnnotator | null = null;
  private _annotationTitleObserver: MutationObserver | null = null;
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
      this._contentEl?.removeEventListener("click", this._boundMobileAnnotationTap, true);
      this._boundMobileAnnotationTap = null;
    }
    if (this._hoverChipHideTimer != null) {
      clearTimeout(this._hoverChipHideTimer);
      this._hoverChipHideTimer = undefined;
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
    if (
      changed.has("_popoverOpen") ||
      changed.has("_popoverReferenceRect") ||
      changed.has("_selectedText") ||
      changed.has("_popoverMode") ||
      changed.has("_existingComment")
    ) {
      this._syncPopover();
    }
  }

  private _renderMarkdown(): void {
    const container = this.querySelector(".review-document-content") as HTMLDivElement;
    if (!container) return;
    this._contentEl = container;

    // Destroy previous annotator before re-rendering content
    this._destroyAnnotator();

    // Escape raw HTML before markdown parsing, then sanitize generated
    // markdown HTML before inserting it into the live document.
    container.innerHTML = renderReviewMarkdownToHtml(this.markdown);

    // Restore and re-anchor existing annotations
    this._reanchorAnnotations();

    // Attach the text annotator
    this._attachAnnotator(container);
  }

  /**
   * Annotation highlight style. text-annotator sets `background-color`
   * and `border-*` as INLINE styles on each `.r6o-annotation` span, so
   * stylesheet overrides (even with `!important`) lose. The library
   * also runs a colour parser on `fill` whenever `fillOpacity` is set;
   * the parser only understands rgb/hex/hsl and silently falls back to
   * its default blue for `oklch()` — which is why `--primary` was being
   * thrown away.
   *
   * To produce a value the parser (and our pre-baked rgba string) can
   * use, we resolve `var(--primary)` via a 1×1 canvas: modern Chromium
   * preserves the declared colour space in `getComputedStyle().color`
   * (so probing returns `oklch(…)` verbatim), but the canvas pipeline
   * always converts to sRGB on `fillRect`. Reading back the pixel
   * gives us a guaranteed `[r, g, b]` tuple in 0–255.
   */
  private _resolvePrimaryRgb(): [number, number, number] {
    try {
      const probe = document.createElement("span");
      probe.style.color = "var(--primary)";
      probe.style.display = "none";
      (this._contentEl ?? document.body).appendChild(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (ctx && computed) {
        ctx.fillStyle = computed;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return [r, g, b];
      }
    } catch {
      // fall through to default
    }
    return [99, 102, 241]; // indigo-500 fallback
  }

  private _highlightStyle = (_ann: unknown, state?: { selected?: boolean }) => {
    const [r, g, b] = this._resolvePrimaryRgb();
    const alpha = state?.selected ? 0.55 : 0.45;
    return {
      fill: `rgba(${r}, ${g}, ${b}, ${alpha})` as
        `rgba(${number}, ${number}, ${number}, ${number})`,
      // Omit fillOpacity so `fill` passes through to backgroundColor verbatim.
      underlineStyle: "solid",
      underlineColor: `rgb(${r}, ${g}, ${b})` as
        `rgb(${number}, ${number}, ${number})`,
      underlineThickness: 2,
      underlineOffset: 0,
    };
  };

  private _attachAnnotator(container: HTMLElement): void {
    try {
      this._annotator = createTextAnnotator(container, {
        renderer: "SPANS",
        style: this._highlightStyle,
      });
      // Re-apply on every attach so HMR edits to _highlightStyle take
      // effect without recreating the annotator.
      this._annotator.setStyle?.(this._highlightStyle);

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

      // Click an existing highlight → reopen popover in edit mode. The
      // text-annotator emits its own `clickAnnotation` event with the
      // annotation object; we route that through `_openAnnotationForEdit`.
      this._annotator.on("clickAnnotation", (ann: any, originalEvent: PointerEvent) => {
        const anchor =
          ((originalEvent?.target as HTMLElement | undefined)?.closest?.(".r6o-annotation") as HTMLElement | null)
          ?? (this._contentEl?.querySelector(`[data-annotation="${ann.id}"]`) as HTMLElement | null);
        this._openAnnotationForEdit(ann.id, anchor);
      });

      // Hover affordance — show a small Edit/Delete chip anchored to the highlight.
      this._annotator.on("mouseEnterAnnotation", (ann: any) => {
        const span = this._contentEl?.querySelector(
          `.r6o-annotation[data-annotation="${ann.id}"]`,
        ) as HTMLElement | null;
        if (span) this._showHoverChip(ann.id, span);
      });
      this._annotator.on("mouseLeaveAnnotation", () => {
        this._scheduleHideHoverChip();
      });

      // Fallback DOM-level click handler — annotator's clickAnnotation event
      // doesn't fire in every browser/test environment. Capture phase so
      // it lands before any stopPropagation inside the annotator.
      // To avoid double-firing when both paths run, the handler bails out
      // if it sees the popover already open in edit mode for this id.
      this._boundMobileAnnotationTap = this._onMobileAnnotationTap.bind(this);
      this._contentEl?.addEventListener("click", this._boundMobileAnnotationTap, true);

      // Decorate Recogito-rendered .r6o-annotation spans with a `title`
      // tooltip so the affordance is discoverable (accessibility hint).
      // The spans are wrapped lazily as text-annotator decorates text
      // nodes; observe additions and tag them.
      const tagSpan = (el: Element): void => {
        if (el instanceof HTMLElement && !el.hasAttribute("title")) {
          el.setAttribute("title", "Click to edit \u00b7 hover for actions");
        }
      };
      this._annotationTitleObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of Array.from(m.addedNodes)) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.classList?.contains("r6o-annotation")) tagSpan(node);
            node.querySelectorAll?.(".r6o-annotation:not([title])").forEach(tagSpan);
          }
        }
      });
      this._annotationTitleObserver.observe(container, { childList: true, subtree: true });
      // Tag any spans that already exist (re-anchored on mount).
      container.querySelectorAll(".r6o-annotation:not([title])").forEach(tagSpan);
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

    // Remove the auto-created annotation from the annotator regardless of
    // whether we open in create or edit mode — we'll re-add after submit
    // (or, in edit mode, we never want a duplicate highlight).
    try {
      this._annotator?.removeAnnotation(annotation.id || annotation);
    } catch {
      // ignore
    }

    // Overlap detection — if this new selection overlaps any existing
    // annotation in the same bucket, treat it as an edit of that
    // annotation instead of stacking a new comment on top.
    const overlap = this._annotations.find(
      (a) =>
        a.start != null &&
        a.end != null &&
        a.start < end &&
        a.end > start,
    );
    if (overlap) {
      this._pendingSelection = {
        quote: overlap.quote,
        prefix: overlap.prefix || "",
        suffix: overlap.suffix || "",
        start: overlap.start ?? 0,
        end: overlap.end ?? 0,
        isCode: overlap.isCode || false,
      };
      this._selectedText = overlap.quote;
      this._existingComment = overlap.comment || "";
      this._editingAnnotationId = overlap.id;
      this._popoverMode = this._isMobile ? "bottom-sheet" : "popover";
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        this._popoverReferenceRect = sel.getRangeAt(0).getBoundingClientRect();
      } else {
        const span = this._contentEl?.querySelector(
          `.r6o-annotation[data-annotation="${overlap.id}"]`,
        ) as HTMLElement | null;
        if (span) this._popoverReferenceRect = span.getBoundingClientRect();
      }
      window.getSelection()?.removeAllRanges();
      this._popoverOpen = true;
      return;
    }

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

    this._pendingSelection = { quote, prefix, suffix, start, end, isCode };
    this._selectedText = quote;
    this._existingComment = "";
    this._editingAnnotationId = null;
    this._popoverMode = this._isMobile ? "bottom-sheet" : "popover";

    // Anchor popover to the selection rect. Floating UI clamps to the
    // viewport so the popover never overflows the screen.
    if (sel && sel.rangeCount > 0) {
      this._popoverReferenceRect = sel.getRangeAt(0).getBoundingClientRect();
    }
    this._popoverOpen = true;
  }

  /**
   * Open the annotation popover in edit mode for an existing annotation.
   * Shared by both the desktop click path (`clickAnnotation` event +
   * fallback DOM listener) and the mobile tap path.
   */
  private _openAnnotationForEdit(annotationId: string, anchor: HTMLElement | null): void {
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
    this._showFloatingBtn = false;
    this._hideHoverChipNow();
    if (anchor) {
      this._popoverReferenceRect = anchor.getBoundingClientRect();
    } else {
      // Best-effort fallback — anchor at viewport center. Required on
      // mobile too: the bottom-sheet path checks `_popoverReferenceRect`
      // before opening and would otherwise silently no-op on the first
      // tap of a session.
      this._popoverReferenceRect = new DOMRect(
        window.innerWidth / 2,
        window.innerHeight / 2,
        0,
        0,
      );
    }
    this._popoverOpen = true;
  }

  // --- Hover chip (Edit / Delete affordance over an existing highlight) ---

  private _showHoverChip(annotationId: string, anchor: HTMLElement): void {
    if (this._hoverChipHideTimer != null) {
      clearTimeout(this._hoverChipHideTimer);
      this._hoverChipHideTimer = undefined;
    }
    const rect = anchor.getBoundingClientRect();
    const hostRect = this.getBoundingClientRect();
    this._hoverChipId = annotationId;
    // Anchor above-right of the span, in element-relative coords.
    this._hoverChipX = rect.right - hostRect.left - 60;
    this._hoverChipY = rect.top - hostRect.top - 28;
    if (this._hoverChipY < 0) this._hoverChipY = rect.bottom - hostRect.top + 4;
  }

  private _scheduleHideHoverChip(): void {
    if (this._hoverChipHideTimer != null) clearTimeout(this._hoverChipHideTimer);
    this._hoverChipHideTimer = window.setTimeout(() => {
      this._hoverChipId = null;
      this._hoverChipHideTimer = undefined;
    }, 150);
  }

  private _hideHoverChipNow(): void {
    if (this._hoverChipHideTimer != null) {
      clearTimeout(this._hoverChipHideTimer);
      this._hoverChipHideTimer = undefined;
    }
    this._hoverChipId = null;
  }

  private _onHoverChipEnter(): void {
    if (this._hoverChipHideTimer != null) {
      clearTimeout(this._hoverChipHideTimer);
      this._hoverChipHideTimer = undefined;
    }
  }

  private _onHoverChipEdit(): void {
    const id = this._hoverChipId;
    if (!id) return;
    const span = this._contentEl?.querySelector(
      `.r6o-annotation[data-annotation="${id}"]`,
    ) as HTMLElement | null;
    this._openAnnotationForEdit(id, span);
  }

  private _onHoverChipDelete(): void {
    const id = this._hoverChipId;
    if (!id) return;
    this._hideHoverChipNow();
    this._removeAnnotation(id);
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

    // Capture the selection rect BEFORE clearing the selection. The popover
    // singleton requires a non-null reference rect (see _syncPopover); on
    // mobile bottom-sheet mode the rect itself is unused for positioning,
    // but it must be set or _syncPopover early-returns and the sheet never
    // opens. Mirrors the desktop _handleSelection path.
    this._popoverReferenceRect = range.getBoundingClientRect();
    this._popoverMode = "bottom-sheet";
    this._existingComment = "";
    // Anchor the popover to the selection rect before clearing the
    // selection. Bottom-sheet mode doesn't visually use the rect (it docks
    // to the viewport bottom), but `_syncPopover` returns early when the
    // rect is null and would otherwise leave the popover unmounted.
    this._popoverReferenceRect = range.getBoundingClientRect();
    this._popoverOpen = true;
    this._showFloatingBtn = false;

    // Clear browser selection
    window.getSelection()?.removeAllRanges();
  }

  private _onMobileAnnotationTap(e: Event): void {
    const target = (e.target as HTMLElement).closest(".r6o-annotation") as HTMLElement | null;
    if (!target) {
      // Tapped outside annotation — hide floating button if visible
      if (this._showFloatingBtn) this._showFloatingBtn = false;
      return;
    }

    const annotationId = target.getAttribute("data-annotation");
    if (!annotationId) return;

    // De-dupe with the annotator's own `clickAnnotation` event — if the
    // popover is already open in edit mode for this annotation, ignore
    // the DOM-level fallback so we don't re-enter the open path.
    if (this._popoverOpen && this._editingAnnotationId === annotationId) {
      return;
    }

    this._openAnnotationForEdit(annotationId, target);
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
      this.backend.remove({ sessionId: this.sessionId, bucket: this.docTitle }, this._editingAnnotationId);
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

    this.backend.add({ sessionId: this.sessionId, bucket: this.docTitle }, ann);
    this._annotations = this.backend.get({ sessionId: this.sessionId, bucket: this.docTitle });
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
    this.backend.remove({ sessionId: this.sessionId, bucket: this.docTitle }, annotationId);
    this._annotations = this.backend.get({ sessionId: this.sessionId, bucket: this.docTitle });
    this._detachedAnnotations = this._detachedAnnotations.filter(a => a.id !== annotationId);

    try {
      this._annotator?.removeAnnotation(annotationId);
    } catch {
      // ignore
    }

    this.dispatchEvent(new CustomEvent("annotation-change", { bubbles: true, composed: true }));
  }

  private _reanchorAnnotations(): void {
    const existing = this.backend.get({ sessionId: this.sessionId, bucket: this.docTitle });
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

  /**
   * Mirror local popover state into the singleton <annotation-popover>
   * mounted in <body>. We don't render the element in this component's
   * template because consumers can be nested inside transformed ancestors
   * (the carousel slider's `transform: translateX(...)`) which trap any
   * `position: fixed` descendant to that ancestor's bounding box. Mounting
   * the popover in <body> sidesteps the trap entirely.
   */
  private _syncPopover(): void {
    if (!this._popoverOpen) {
      closeAnnotationPopover();
      return;
    }
    const rect = this._popoverReferenceRect;
    if (!rect) return;
    const editingId = this._editingAnnotationId;
    openAnnotationPopover({
      referenceRect: rect,
      selectedText: this._selectedText,
      mode: this._popoverMode,
      existingComment: this._existingComment,
      onSubmit: (comment) => this._onAnnotationSubmit({ detail: { comment } } as CustomEvent),
      onCancel: () => this._onAnnotationCancel(),
      onDelete: editingId
        ? () => {
            this._removeAnnotation(editingId);
            this._onAnnotationCancel();
          }
        : undefined,
    });
  }

  private _destroyAnnotator(): void {
    if (this._annotationTitleObserver) {
      try { this._annotationTitleObserver.disconnect(); } catch { /* ignore */ }
      this._annotationTitleObserver = null;
    }
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
      ${this._hoverChipId && !this._isMobile
        ? html`<div
            class="review-hover-chip"
            style="left:${this._hoverChipX}px;top:${this._hoverChipY}px"
            @mouseenter=${this._onHoverChipEnter}
            @mouseleave=${this._scheduleHideHoverChip}
          >
            <button
              class="review-hover-chip-btn"
              data-testid="annotation-hover-edit"
              title="Edit comment"
              @click=${this._onHoverChipEdit}
            >Edit</button>
            <button
              class="review-hover-chip-btn review-hover-chip-btn--danger"
              data-testid="annotation-hover-delete"
              title="Delete comment"
              @click=${this._onHoverChipDelete}
            >Delete</button>
          </div>`
        : ""}
      <!-- Annotation popover is mounted as a singleton in <body>; see _syncPopover. -->
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-document": ReviewDocument;
  }
}
