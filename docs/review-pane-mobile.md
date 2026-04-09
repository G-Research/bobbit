# Mobile Inline Commenting — Review Pane

The review pane's text annotation system supports mobile devices with a custom selection and commenting flow. On desktop, `@recogito/text-annotator` handles selection detection natively via mouse events. On mobile, its mouse-event model doesn't fire reliably, so the review pane implements its own selection layer on top of the annotator's programmatic `addAnnotation()` API — no upstream changes required.

## Detection strategy

Touch-primary devices are detected via `window.matchMedia('(pointer: coarse)')`:

| Device | `pointer` | Flow |
|---|---|---|
| Phone / tablet | `coarse` | Mobile (custom selection) |
| Desktop with mouse | `fine` | Desktop (annotator-native) |
| Desktop touch-only (rare) | `coarse` | Mobile |

No user-agent sniffing. The check runs once in `connectedCallback()` and sets `_isMobile`. All mobile code paths are gated behind this flag — **desktop behavior is completely unaffected**.

This pattern is reusable for other components that need mobile-specific interaction modes.

## Mobile annotation flow

### 1. Selection detection

`<review-document>` listens to `document.selectionchange` events (only when `_isMobile` is true). The handler is debounced at 300ms to wait for the user to finish adjusting drag handles. After debounce, the selection is validated:

- Must not be collapsed (no caret-only selections)
- `anchorNode` must be inside the review document's content element
- Selected text must be at least 3 characters (filters out accidental taps)

### 2. Floating "Add Comment" button

When a valid selection is detected, a floating button appears near the selection. The button is positioned below the selection to avoid conflicting with the native iOS "Copy / Look Up / Share" menu that appears above. Position is clamped to the container bounds.

CSS class: `.review-floating-btn` in `review-pane.css`. Minimum touch target: 44x44px (Apple HIG).

### 3. Range capture

When the user taps "Add Comment", the current `Range` is captured immediately from `window.getSelection().getRangeAt(0)`. This must happen synchronously — tapping the button may collapse the native selection on some browsers.

If the selection has already been lost (race condition), a toast message ("Selection lost — try again") appears for 2 seconds instead of creating an empty annotation.

Character offsets are computed via a `preRange` technique: a Range from the start of the content element to the selection start gives the start offset; adding the selected text length gives the end offset. Prefix (32 chars before) and suffix (32 chars after) are extracted for `TextQuoteSelector` context.

### 4. Annotation creation

The annotation is created programmatically via `this._annotator.addAnnotation()` using the same W3C Web Annotation format as desktop:

- `TextQuoteSelector` — exact text + prefix/suffix context (for re-anchoring)
- `TextPositionSelector` — character offsets (fast path)

A temporary highlight appears immediately. The annotation ID is tracked in `_pendingAnnId` so it can be cleaned up if the user cancels.

### 5. Bottom sheet comment input

Instead of the desktop inline popover, mobile opens a **bottom sheet** — `<annotation-popover mode="bottom-sheet">`. The sheet:

- Slides up from the bottom of the review pane (contained within the panel, not the viewport)
- Auto-focuses the textarea with keyboard
- Repositions above the virtual keyboard via `visualViewport.resize` listener
- Supports swipe-to-dismiss (swipe down > 50px on the drag handle)
- Has Cancel and Submit buttons with 44px minimum touch targets
- Max-height: 50vh to avoid covering the entire document

### 6. Viewing/editing existing comments

Tapping an annotation highlight on mobile opens the bottom sheet with the existing comment pre-filled via the `existingComment` property. The edit flow removes the old annotation (from both `AnnotationStore` and the annotator) before creating the replacement, tracked via `_editingAnnotationId`.

### 7. Gutter markers

On mobile (`@media (pointer: coarse)`), gutter markers are enlarged to 44x44px with a centered 8px dot indicator, meeting Apple HIG minimum tap target requirements.

## Component properties

### `<annotation-popover>`

| Property | Type | Default | Description |
|---|---|---|---|
| `mode` | `"popover"` \| `"bottom-sheet"` | `"popover"` | Reflected attribute. Controls positioning and animation. |
| `existingComment` | `string` | `""` | Pre-fills the textarea when editing an existing annotation on mobile. |

Both properties are used by `<review-document>` when opening the popover on mobile. The popover's internal rendering switches layout based on `mode` — popover mode is unchanged from the desktop implementation.

### `<review-document>` (internal state)

| Field | Type | Purpose |
|---|---|---|
| `_isMobile` | `boolean` | Set once from `matchMedia('(pointer: coarse)')`. Gates all mobile paths. |
| `_pendingAnnId` | `string \| null` | Tracks the temporary annotation ID during creation. Cleaned up on cancel. |
| `_editingAnnotationId` | `string \| null` | Tracks the annotation being edited. Old annotation removed on submit. |

## CSS classes (review-pane.css)

| Class | Purpose |
|---|---|
| `.review-floating-btn` | Floating "Add Comment" button. Absolute positioned, pill shape, 44x44px min. |
| `.review-toast` | Toast message for lost selection. Centered at bottom, 2s fade-out animation. |
| `@media (pointer: coarse) .review-gutter-marker` | Enlarged gutter markers (44x44px) with centered dot. |

## Data format

Mobile annotations use the **same format** as desktop annotations — the `AnnotationStore` is unchanged. Both flows produce W3C Web Annotation objects with `TextQuoteSelector` and `TextPositionSelector`, persisted to `sessionStorage`. Mobile and desktop annotations are interchangeable.

## Testing

- **Unit tests**: `tests/mobile-review-annotation.spec.ts` — 13 tests using a Playwright `file://` fixture (`tests/mobile-review-annotation.html`). Covers floating button visibility, bottom sheet open/close, comment submission, toast on lost selection, CSS touch targets.
- **E2E tests**: `tests/e2e/ui/mobile-review-commenting.spec.ts` — 7 tests covering full user journeys: mobile creation flow, desktop unaffected, submit review on mobile, persistence after reload, edit existing comment, cancel removes uncommitted highlight, toast on lost selection.
