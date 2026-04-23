# Reopenable Preview Widgets — Design Doc

## Problem

`preview_open` writes HTML into a single, session-scoped preview panel. Every subsequent call overwrites the panel — historical payloads are lost. Users cannot re-load a past preview (e.g. an earlier mockup variant) without asking the agent to regenerate it.

## Goal

Add an **Open in preview panel** button to the `preview_open` widget in `PreviewRenderer` that works for both live and archived tool calls. Clicking it hydrates the original HTML snapshot from the session transcript and POSTs it to the existing `/api/preview` endpoint — no new panels, no tabs, no server architectural changes.

## Architecture summary

Three-legged change:

1. **Extension** (`defaults/tools/html/extension.ts`) — capture the resolved HTML into `tool_result.content` as a second text block, tagged with a sentinel prefix so renderers can extract it without a schema change.
2. **Truncation** (`src/server/agent/truncate-large-content.ts`) — extend to also scan `tool_result` content blocks (both streaming events and persisted messages) so the snapshot doesn't re-enter the agent's context window.
3. **Renderer** (`src/ui/tools/renderers/PreviewRenderer.ts`) — add an Open button. Click → lazy-load full snapshot via extended `/api/sessions/:id/tool-content/:messageIndex/:blockIndex` → POST to `/api/preview?sessionId=...`.

The existing `/api/preview` GET/POST pipeline and `preview-panel.ts` polling loop stay untouched — we're just giving the UI a second way to publish HTML into the same single-slot panel.

## File-level plan

### 1. `defaults/tools/html/extension.ts`

Change `execute()` to return a snapshot text block in addition to the status line. Snapshot is prefixed with a sentinel so renderers / truncation can identify it cheaply:

```ts
const SNAPSHOT_MARKER = "__preview_snapshot_v1__\n";

// After successful POST to /api/preview:
return {
  content: [
    { type: "text", text: "Preview panel is open and will auto-update." },
    { type: "text", text: SNAPSHOT_MARKER + content }, // full HTML
  ],
};
```

Error paths keep returning a single text block — no snapshot on failure.

Export `SNAPSHOT_MARKER` from a small shared module (`defaults/tools/html/snapshot.ts`) so the renderer and truncation can import the same constant rather than duplicate-defining it.

**Why a second text block, not a new field or block type?** pi-ai's `ToolResultMessage` schema is `{ role: "toolResult", content: Array<{type:"text",text:string}> }`. Adding a novel block type risks serialization/validation failures in the agent loop and upstream pi-ai machinery. A text block with a prefix is schema-inert — the agent sees two text blocks (or one, once truncated) and that's it.

### 2. `defaults/tools/html/snapshot.ts` (new, ~10 lines)

```ts
export const PREVIEW_SNAPSHOT_MARKER = "__preview_snapshot_v1__\n";

export function isSnapshotBlock(text: string): boolean {
  return typeof text === "string" && text.startsWith(PREVIEW_SNAPSHOT_MARKER);
}

export function extractSnapshot(text: string): string {
  return text.slice(PREVIEW_SNAPSHOT_MARKER.length);
}
```

Imported by the renderer (via `src/ui/tools/renderers/PreviewRenderer.ts`) and by `truncate-large-content.ts`. Lives under `defaults/` because that's where the source of truth for the format is; both sides import it.

### 3. `src/server/agent/truncate-large-content.ts`

Today `truncateLargeToolContent` and `truncateLargeToolContentInMessages` only walk `toolCall`/`tool_use` blocks and only truncate `arguments.content` / `input.content`. They do **not** touch `toolResult` messages.

Extend both functions to also:

- For message-level iteration: when a message has `role === "toolResult"`, walk its `content` array.
- For each text block whose `text` starts with `PREVIEW_SNAPSHOT_MARKER` **and** whose length exceeds `LARGE_CONTENT_THRESHOLD`, replace it with `{ type: "text", text: PREVIEW_SNAPSHOT_MARKER + "<TruncatedContent JSON marker>" }` — OR, to stay consistent with existing `TruncatedContent` shape used for `write`, replace the block's `text` with `JSON.stringify({ _truncated: true, _originalLength: n, preview: text.slice(0, 512) })`.

**Recommended approach**: keep snapshot truncation symmetric with existing write-truncation — the renderer already understands the shape:

```ts
// new helper
function truncateToolResultContent(block: any, threshold: number): any | null {
  if (block?.type !== "text" || typeof block.text !== "string") return null;
  if (!block.text.startsWith(PREVIEW_SNAPSHOT_MARKER)) return null;
  if (block.text.length <= threshold) return null;
  const originalLength = block.text.length;
  return {
    ...block,
    text: PREVIEW_SNAPSHOT_MARKER,        // stripped — full HTML fetched on demand
    _truncated: true,
    _originalLength: originalLength,
    preview: block.text.slice(PREVIEW_SNAPSHOT_MARKER.length, PREVIEW_SNAPSHOT_MARKER.length + 512),
  };
}
```

The field names mirror `TruncatedContent` so UI code can pattern-match either shape. Truncation must apply in **both** the streaming path (`truncateLargeToolContent` on `message_update`/`message_end` events carrying tool_result messages) and the history-replay path (`truncateLargeToolContentInMessages`).

**Gating:** only prefix-matching text blocks are truncated. Ordinary tool_result text (status lines, error messages) is left alone — we don't want to nuke short error bodies under 32KB, and we don't want to accidentally truncate unrelated large tool_result payloads from other tools.

### 4. `src/server/server.ts` — extend `/api/sessions/:id/tool-content/:messageIndex/:blockIndex`

Current handler (line ~5273) reads `block.arguments?.content ?? block.input?.content` — those fields are undefined for tool_result text blocks, so the endpoint 404s today.

Extend the handler to also return `block.text` when the block is a text block in a tool_result message:

```ts
const toolContent =
  block.arguments?.content ??
  block.input?.content ??
  (block.type === "text" && typeof block.text === "string" ? block.text : undefined);
```

No new route needed. The `(messageIndex, blockIndex)` pair already uniquely addresses a tool_result text block in the outer message array since `role: "toolResult"` messages are first-class entries with their own index.

**Sandbox guard** (`src/server/auth/sandbox-guard.ts`): the existing tool-content endpoint is already allowed for sandboxed agents implicitly through the general session endpoints; confirm during implementation that no new allowlist entry is needed.

### 5. `src/ui/tools/renderers/PreviewRenderer.ts`

Rewrite `render()` to emit an Open button on every successful `preview_open` tool call. Outline:

```ts
interface PreviewOpenResult {
  // result.content: [{type:"text", text:"Preview panel is open..."}, snapshotBlock?]
  // snapshotBlock.text starts with PREVIEW_SNAPSHOT_MARKER (may be truncated or full)
}

render(params, result, isStreaming, ctx): ToolRenderResult {
  const state = getToolState(result, isStreaming);
  const label = params?.file
    ? html`Preview: <span class="font-mono">${params.file}</span>`
    : "Preview: inline HTML";

  const snapshotInfo = findSnapshotBlock(result); // returns { blockIndex, truncated, inlineHtml? } | null
  const canOpen = !isStreaming && result && !result.isError && snapshotInfo !== null;
  const openButton = this.renderOpenButton(canOpen, snapshotInfo, ctx);

  return {
    content: html`
      ${renderHeader(state, PanelRight, label)}
      <div class="mt-2">${openButton}</div>
    `,
    isCustom: false,
  };
}
```

`findSnapshotBlock()` walks `result.content` for the first block with a `text` value starting with `PREVIEW_SNAPSHOT_MARKER`, returns its index and whether the stored text indicates truncation (by checking for the `_truncated` field on the block — same mechanism used for write). The full inline HTML is returned when the block is untruncated.

**Click handler sequence** (pseudo):

```ts
async function onOpenClick(ev: Event) {
  const btn = ev.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Opening…";
  try {
    let html = snapshotInfo.inlineHtml;
    if (!html) {
      // Truncated — lazy-load via existing endpoint
      const { sessionId } = ctx;
      const { messageIndex, blockIndex } = locateBlock(result, snapshotInfo.blockIndex);
      const full = await fetchToolContent(sessionId, messageIndex, blockIndex);
      html = full.startsWith(PREVIEW_SNAPSHOT_MARKER)
        ? full.slice(PREVIEW_SNAPSHOT_MARKER.length)
        : full;
    }
    // Enable preview session and push the HTML
    await gatewayFetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ preview: true }),
    });
    await gatewayFetch(`/api/preview?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      body: JSON.stringify({ html }),
    });
    btn.textContent = "Opened ✓";
    setTimeout(() => { btn.textContent = "Open in preview panel"; btn.disabled = false; }, 1500);
  } catch (err) {
    btn.textContent = "Failed — retry";
    btn.disabled = false;
  }
}
```

The renderer relies on `ctx.sessionId` (already threaded via `ToolRenderContext` — see `src/ui/tools/types.ts`). Locating `(messageIndex, blockIndex)` follows the pattern already established in `Messages.ts` `_loadFullContent()` — walk `appState.remoteAgent.state.messages` for the matching tool-result message by `toolCallId`. Simpler path: mirror `WriteRenderer`'s dispatch of a `load-full-content` CustomEvent and extend the `_onLoadFullContent` handler in `Messages.ts` to understand tool_result lookups. **Recommended**: duplicate the small locate-and-fetch logic inline in `PreviewRenderer` rather than generalizing `Messages.ts` — the two flows have different post-fetch actions (replace-in-place vs POST-to-preview), so factoring them is premature.

**Disabled state (backwards compat):**

- `result` is error or `isSkippedToolResult`: don't show the button at all (or show it dim and unclickable with tooltip "Preview failed").
- `snapshotInfo === null` (historical tool calls from before this feature): render the button disabled with `title="Snapshot not captured — reopen unavailable for this historical preview"`. Recommendation per goal spec: **disabled state**, not file-fallback — simpler, no filesystem-permission surprises, no divergence if the file-on-disk was edited since the call.
- `isStreaming === true`: button disabled with `title="Waiting for preview_open to complete…"`.

### 6. No change: `src/ui/tools/index.ts`

`PreviewOpenRenderer` is already registered. No registry edits.

### 7. No change: `/api/preview` GET/POST, `src/app/preview-panel.ts`, `state.isPreviewSession` plumbing

The polling loop already observes `/api/preview` and republishes into `state.previewPanelHtml`. The session-scoped `preview: true` flag is already set by the extension during the original call — clicking Open just re-asserts it via PATCH for safety (handles edge case of preview session having been toggled off manually).

## Data shape

### Tool result content array

**Before (current):**
```json
{
  "role": "toolResult",
  "toolName": "preview_open",
  "content": [
    { "type": "text", "text": "Preview panel is open and will auto-update." }
  ]
}
```

**After (full snapshot, <32KB):**
```json
{
  "role": "toolResult",
  "toolName": "preview_open",
  "content": [
    { "type": "text", "text": "Preview panel is open and will auto-update." },
    { "type": "text", "text": "__preview_snapshot_v1__\n<!DOCTYPE html>..." }
  ]
}
```

**After broadcast/history (snapshot >32KB, truncated):**
```json
{
  "content": [
    { "type": "text", "text": "Preview panel is open and will auto-update." },
    {
      "type": "text",
      "text": "__preview_snapshot_v1__\n",
      "_truncated": true,
      "_originalLength": 174823,
      "preview": "<!DOCTYPE html><html>..."
    }
  ]
}
```

The full HTML lives only in `.jsonl` on disk. Broadcast frames and history-replay RPC responses carry only the truncated stub. On click, the renderer hits `/api/sessions/:id/tool-content/:msg/:blk` → server calls `session.rpcClient.getMessages()` → the **untruncated** on-disk content is returned.

### Mirrors WriteRenderer pattern

WriteRenderer handles the identical flow for `write` tool calls: `params.content` arrives as `TruncatedContent | string`, the renderer detects via `isTruncated()`, shows a "Load full content" button, and dispatches `load-full-content` which hits the same `/api/sessions/:id/tool-content/...` endpoint. We deliberately reuse this pattern; the only deltas are (a) we're looking at a tool_result block not a tool_use block, (b) we POST the loaded content to `/api/preview` instead of re-rendering it in the code block.

## Truncation integration

Read of `truncate-large-content.ts` confirms:

- `isToolBlock()` checks `type === "toolCall" || type === "tool_use"` — tool_result is **not** currently covered.
- `getToolContent()` reads `block.arguments?.content ?? block.input?.content` — no text-block path.
- The message-level walk (`truncateLargeToolContentInMessages`) iterates each message's `content` array but only acts on tool blocks.

Therefore, `preview_open` snapshots will **bypass the existing truncation** unless extended. Concrete changes:

1. Add a helper `truncateSnapshotBlock(block, threshold)` that recognizes `{type:"text"}` blocks starting with `PREVIEW_SNAPSHOT_MARKER`.
2. In `truncateLargeToolContent(event)`: after the existing tool-block scan, also walk content blocks for snapshot text blocks in `message_update`/`message_end` events where the message role is `toolResult`. The function already detects "needs truncation" via a pre-scan; extend the scan predicate.
3. In `truncateLargeToolContentInMessages(messages)`: for messages with `role === "toolResult"`, walk `content` and apply the helper per block.

**Threshold**: reuse `LARGE_CONTENT_THRESHOLD = 32 * 1024`. HTML mockups with charts/images often exceed 32KB; small mockups stay inline. This matches `write` behavior exactly.

**Token accounting**: the agent only ever sees either the full HTML (<32KB — acceptable; the agent asked for it) or the truncated stub (>32KB — `PREVIEW_SNAPSHOT_MARKER` + zero-length plus 512-byte `preview`). On subsequent turns, the agent's context is assembled from the transcript via the same broadcast/history path, so the stub is what ends up in its context window. Large HTML never re-enters the prompt.

## Renderer plan — DOM

```html
<div class="p-2.5 border border-border rounded-md bg-card ...">
  <!-- existing header from renderHeader(state, PanelRight, label) -->
  <div class="flex items-center gap-2">
    <svg>…PanelRight…</svg>
    <span>Preview: <span class="font-mono">mockups/dashboard.html</span></span>
  </div>

  <!-- new: Open button row -->
  <div class="mt-2 flex items-center gap-2">
    <button
      class="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
      ?disabled=${!canOpen}
      title=${openTooltip}
      @click=${onOpenClick}
    >
      <!-- icon + label -->
      Open in preview panel
    </button>
    ${truncatedBadge}
  </div>
</div>
```

The button lives inside the standard card wrapper (isCustom: false). No style custom-elements; plain lit + Tailwind consistent with other renderers.

## Edge cases

- **Multiple rapid clicks**: `btn.disabled = true` immediately on click. Re-enabled on error or 1.5s after success.
- **Sandboxed sessions**: both `/api/preview` POST and `/api/sessions/:id/tool-content/...` already work for sandboxed callers through normal gateway auth — no sandbox-guard additions needed (confirmed by reading `src/server/auth/sandbox-guard.ts` which allows `/api/preview` POST explicitly).
- **Concurrent opens from different history rows**: last-write-wins at the panel; fine — that's the single-slot semantic.
- **Session not a preview session**: PATCH `preview: true` before POST. This mirrors what the extension already does on first call.
- **Snapshot marker collision**: an agent-generated HTML document starting with the literal string `__preview_snapshot_v1__\n` would be mistakenly re-extracted. Probability is negligible, but make the marker a content prefix rather than a content substring to keep false positives to zero. Future-proofed by the `_v1_` version segment.
- **Live call in flight**: button disabled with "Waiting…" tooltip until `result` arrives. Matches `write`'s streaming behavior.
- **Archived/old sessions**: tool calls predating this feature have only one text block — no snapshot. `findSnapshotBlock()` returns null, button renders disabled with the "Snapshot not captured" tooltip. No server-side migration needed.

## Test plan

### Unit tests (Playwright `file://` fixtures — `tests/preview-renderer.spec.ts`, new)

1. **Renders Open button for completed tool call with inline snapshot** — mount `<tool-message>` with a synthetic `preview_open` toolCall + toolResult containing two text blocks (status + `PREVIEW_SNAPSHOT_MARKER + "<h1>hi</h1>"`). Assert button visible + enabled.
2. **Renders disabled Open button for historical tool call (no snapshot)** — toolResult has only the status block. Assert button present, `disabled` attribute set, title contains "Snapshot not captured".
3. **Click on inline snapshot posts to /api/preview** — mock `window.fetch`. Click the button. Assert two fetches: PATCH to `/api/sessions/{id}` with `{preview:true}`, then POST to `/api/preview?sessionId={id}` with `{html: "<h1>hi</h1>"}` (marker stripped).
4. **Click on truncated snapshot lazy-loads then posts** — snapshot block has `_truncated: true`. Mock fetch: first GET to `/api/sessions/{id}/tool-content/{mi}/{bi}` returns `{content: "__preview_snapshot_v1__\n<h1>big</h1>"}`, then PATCH + POST as above. Assert call order: GET → PATCH → POST, POST body strips marker.
5. **Streaming (no result yet): button disabled** — `isStreaming: true`, no result. Assert disabled.
6. **Error result: no Open button** — `result.isError: true`. Assert button not rendered or rendered disabled with error tooltip.

### Truncation unit test (`tests/truncate-large-content.spec.ts`, extend)

7. `truncateLargeToolContentInMessages` truncates a toolResult text block carrying a >32KB snapshot; leaves short snapshots and non-marker text blocks alone.
8. `truncateLargeToolContent` on a `message_end` event with a toolResult message + large snapshot returns a shallow-cloned event with truncated block; returns original when no truncation needed (referential equality).

### Extension unit test (`tests/preview-extension.spec.ts`, new — light)

9. `execute()` with inline `html` returns a 2-block content array: status + snapshot with marker prefix + original HTML verbatim.
10. `execute()` with a `file` param reads the file and stores its contents (not the file path) in the snapshot block.
11. `execute()` error path (unreadable file) returns single-block content with no snapshot.

### API E2E (`tests/e2e/preview-snapshot.spec.ts`, new)

12. Record a synthetic `preview_open` tool call in a session's `.jsonl` with a large snapshot. GET `/api/sessions/:id/tool-content/:mi/:bi` for the snapshot block returns the full untruncated text (verifies handler extension for text-block fallback).
13. `GET /api/sessions/:id` and history-replay path returns the truncated stub for the same block (verifies `truncateLargeToolContentInMessages` runs).

### Browser E2E (`tests/e2e/ui/preview-reopen.spec.ts`, new)

14. **Two-preview-swap**: create a session, send two user messages that each trigger a mock `preview_open` with distinct HTML (`<h1>A</h1>` and `<h1>B</h1>`). Assert the preview panel shows B (latest). Click the Open button on the first widget. Assert the panel flips to A. Click Open on the second widget. Assert it flips back to B. Mirror the canonical E2E pattern — navigate, happy path, persistence across reload (reload page, click Open on first widget again, assert panel shows A), cleanup unnecessary here (single-slot).
15. **Archived session fallback**: load a session fixture whose `.jsonl` contains a pre-feature `preview_open` call with only one content block. Assert the widget renders the Open button in disabled state with the correct tooltip. (Manual sanity is also part of the goal spec; this test automates it.)

### Manual sanity

- Open a real session with dozens of `preview_open` calls, scroll through history, verify buttons work and panel flips reliably. Watch Chrome devtools for any 413/500 responses on large-payload POSTs.
- Check token counts in the agent's context across a turn that follows several large `preview_open` calls — confirm no bloat vs. baseline.

## Out of scope

- Tabs / multi-panel preview UI.
- Preview thumbnails or inline mini-iframes in the chat row.
- Server-side persistence of previews outside the `.jsonl` (the transcript is the canonical store).
- Rewriting historical tool calls to backfill snapshots — disabled-button UX is the contract for legacy calls.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Agent's context bloats from snapshots on subsequent turns | High | Truncation extension covers tool_result text blocks matching the marker. Unit test enforces. |
| Marker collision with user-authored HTML | Low | Prefix-only match + versioned marker (`_v1_`). Future-proofed. |
| Lazy-load endpoint returns 404 for text-block lookups | High pre-fix | Extend handler to fall back to `block.text`. Covered by API E2E test 12. |
| Race between PATCH(preview:true) and POST(/api/preview) | Low | Extension already does PATCH-then-POST sequentially; we mirror that order. |
| pi-ai validation rejects 2-block tool_result content | Low | `ToolResultMessage.content` is already `Array<TextContent>`; two text blocks are valid. Confirmed by existing multi-block tool results in the codebase. |
| Broadcast path misses truncation (e.g. new event type added later) | Medium | `session-manager.ts` already funnels every broadcast through `truncateLargeToolContent()` at 5+ sites. Extension to cover tool_result applies uniformly. |

## Rollout

- Single PR: extension + snapshot module + truncation extension + server endpoint tweak + renderer + tests.
- No migrations. No new config flags. No feature gate — the capability is additive and degrades gracefully (disabled button) on historical data.
