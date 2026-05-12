# Compaction E2E + Rich Summary — Design Doc

Goal: `Compaction E2E + Rich Summary` (id `goal-compaction-20bc17a9`).

Three deliverables: (1) a real‑LLM Playwright e2e, (2) a manual‑integration
pressure test, (3) a rich HTML compaction‑summary card that replaces the plain
`"Context compacted from Xk tokens."` assistant message and round‑trips across
navigation and reload.

This doc is the **only** thing the implementer needs to read besides the cited
files. Every claim has a file:line.

---

## 1. Current state

### 1.1 Dangling Playwright config — `tests/playwright-e2e.config.ts`

```
tests/playwright-e2e.config.ts:18  testMatch: [
tests/playwright-e2e.config.ts:19    "session-rename.spec.ts",
tests/playwright-e2e.config.ts:20    "image-attachment.spec.ts",
tests/playwright-e2e.config.ts:21    "compaction.spec.ts",
tests/playwright-e2e.config.ts:22    "goals.spec.ts",
tests/playwright-e2e.config.ts:23    "team-lifecycle.spec.ts",
tests/playwright-e2e.config.ts:24  ],
```

`find tests -maxdepth 1` confirms **none** of those five files exist. The file
sets `BOBBIT_DIR=.e2e-real-bobbit`, gateway on port 3097, vite proxy on 5174
(`tests/playwright-e2e.config.ts:18–67`). It is *not* invoked by any npm script
— the script `test:e2e` (`package.json`) runs the **repo‑root**
`./playwright-e2e.config.ts`, which is a different file. `grep -rn
'tests/playwright-e2e.config'` returns zero hits across `package.json`,
`.bobbit/`, `defaults/`, `docs/`. So today this config is dead code with a
clear *intent* documented in the file's header: "E2E config for tests that
need a real LLM (session‑rename, image‑attachment, compaction)".

We **claim the `compaction.spec.ts` slot** for this goal and prune the four
other dangling entries (they reference files that do not and will not exist as
part of this work). We also add an `npm run test:e2e:real` script so the
config is actually executable — without that the test never runs in CI or via
the existing `test:e2e` script. Without the script entry the test would
*pass* by being unreachable.

### 1.2 Compaction events on the client — `src/app/remote-agent.ts`

`compaction_start` / `auto_compaction_start` (lines 1850–1862):

```ts
case "compaction_start":
case "auto_compaction_start":
    this._isCompacting = true;
    this.onCompactionChange?.(true);
    this._addCompactingPlaceholder();
    if (event.type === "auto_compaction_start") {
        this.emit({ type: "compaction_start" } as any);
        return;
    }
    break;
```

`compaction_end` / `auto_compaction_end` (lines 1875–1909):

```ts
case "compaction_end":
case "auto_compaction_end": {
    this._isCompacting = false;
    this.onCompactionChange?.(false);
    const success = event.type === "compaction_end" ? event.success : !event.aborted;
    const tokensBefore = (event as any).tokensBefore;
    let resultText = "Context compacted.";
    if (tokensBefore) {
        const fmt = tokensBefore < 1000 ? `${tokensBefore}` : tokensBefore < 1_000_000
            ? `${(tokensBefore / 1000).toFixed(1)}k`
            : `${(tokensBefore / 1_000_000).toFixed(1)}M`;
        resultText = `Context compacted from ${fmt} tokens.`;
    }
    const resultMsg = success
        ? { role: "assistant", content: [{ type: "text", text: resultText }],
            timestamp: Date.now(), id: `compact_done_${Date.now()}` }
        : { role: "assistant", content: [{ type: "text",
            text: `Compaction failed: ${(event as any).error || ((event as any).aborted ? "Compaction aborted" : "Unknown error")}` }],
            timestamp: Date.now(), id: `compact_err_${Date.now()}` };
    this.apply({ type: "compaction-result", message: resultMsg, success });
    if (event.type === "auto_compaction_end") {
        this.emit({ type: "compaction_end", success } as any);
        return;
    }
    break;
}
```

The placeholder is added by `_addCompactingPlaceholder()` at
`src/app/remote-agent.ts:732–743` and re‑added on reconnect at line 1075.

### 1.3 Server emission — `src/server/ws/handler.ts`

`compaction_start` broadcast on `/compact` RPC (lines 552–566):

```
ws/handler.ts:553  session.isCompacting = true;
ws/handler.ts:554  broadcast(session.clients, { type: "event", data: { type: "compaction_start" } });
…
ws/handler.ts:565  const tokensBefore = compactResult?.data?.tokensBefore ?? null;
ws/handler.ts:566  broadcast(session.clients, { type: "event", data: { type: "compaction_end", success: true, tokensBefore } });
ws/handler.ts:568  await sessionManager.refreshAfterCompaction(session);
```

`auto_compaction_*` arrive from the agent subprocess and are handled in
`src/server/agent/session-manager.ts:1910–1914`:

```
1910  } else if (event.type === "auto_compaction_start") {
1911      session.isCompacting = true;
1912  } else if (event.type === "auto_compaction_end") {
1913      session.isCompacting = false;
1914      if (!event.aborted) this.refreshAfterCompaction(session);
```

Server‑side **does not store a "Context compacted from …" marker of its
own** — `grep "Context compacted" src/server` returns nothing. The
post‑compaction snapshot that `refreshAfterCompaction` pulls
(`session-manager.ts:3267–3290`) reflects the underlying agent's transcript;
whatever marker text appears there is supplied by the pi‑coding‑agent process
itself. That fact constrains the round‑trip story below — we cannot
unilaterally make the server hand back a richer payload without an upstream
agent change.

`compaction_end` is also synthesised on a `response: { success: false }`
frame (the "agent error with id:undefined" workaround), `remote-agent.ts:1869–1874`.

### 1.4 Reducer — `src/app/message-reducer.ts`

`compaction-result` action (lines 454–467):

```ts
case "compaction-result": {
    const tick = state.nextTick;
    const order = state.highestSeq + 0.5;
    const messages = state.messages.filter(
        (m) => m.id !== "compacting_placeholder",
    );
    messages.push(stamp(action.message, "synthetic", order, tick));
    return {
        messages: sortMessages(messages),
        nextTick: tick + 1,
        highestSeq: state.highestSeq,
    };
}
```

The **snapshot‑dedup invariant** lives in the `snapshot` case at
`message-reducer.ts:257–261, 346–354`:

```ts
const serverHasCompactionMarker = snapshotRows.some((m) => {
    if (m.role !== "assistant") return false;
    const t = extractText(m);
    return typeof t === "string" && t.startsWith("Context compacted");
});
…
if (m._origin === "synthetic") {
    if (typeof m.id === "string" && serverIds.has(m.id)) continue;
    // Drop synthetic compaction marker when server has its own.
    if (m.role === "assistant" && serverHasCompactionMarker) {
        const t = extractText(m);
        if (typeof t === "string" && t.startsWith("Context compacted")) continue;
    }
    survivors.push(m);
    continue;
}
```

This is what test case (12) and "snapshot drops trailing synthetic compaction
marker" (`tests/message-reducer.test.ts:249–292, 297–323`) pin. The invariant
is: when a fresh snapshot from the server contains a row whose text starts
with `"Context compacted"`, any client‑side synthetic compaction marker is
dropped to avoid the visible double. Without this, the user briefly sees two
identical compaction lines.

Documented in `docs/internals.md:2406` and
`docs/design/unified-message-ordering-reducer.md:183, 400`.

### 1.5 Unit coverage — `tests/message-reducer.test.ts`

- Case (12) "compaction placeholder + server marker — server wins, no double"
  (lines 249–278). Sequence:
  1. `compaction-placeholder` adds the synthetic spinner row.
  2. `compaction-result` replaces it with a `compact_done_1` synthetic.
  3. `snapshot` arrives with an `asst_compact_server_1` text marker.
  4. Asserts the synthetic is dropped and only the server row survives.
- "snapshot drops trailing synthetic compaction marker" (lines 297–323) — same
  invariant from the original `snapshot-merge.test` regression.

### 1.6 Sidebar / status‑indicator unit coverage

`tests/sidebar-session-rendering.spec.ts:197–203` pins the
`getSessionIndicatorType({ status: "idle", isCompacting: true })` → `"compacting"`
mapping. Touched only if we relabel the indicator (we are not).

### 1.7 Renderer patterns — `src/ui/tools/renderers/`

Tool renderers are registered in `src/ui/tools/index.ts:33–67` via
`registerToolRenderer(name, instance)`. Each renderer implements
`ToolRenderer<Params, Details>` from `src/ui/tools/types.ts` and emits a
`ToolRenderResult { content: TemplateResult, isCustom: boolean }`. They use
the shared `renderHeader` / `renderCollapsibleHeader` helpers
(`src/ui/tools/renderer-registry.ts`).

Cards are dispatched by `renderTool(toolName, params, result, isStreaming)` in
`src/ui/tools/index.ts:125–142`. The dispatcher looks the tool up by **the
`name` field of an assistant `toolCall` block** (`MessageList.ts` →
`AssistantMessage` → tool‑call iteration in `src/ui/components/Messages.ts:577–600`).

`HtmlRenderer` (`src/ui/tools/renderers/HtmlRenderer.ts:23–235`) and
`DelegateRenderer` (`src/ui/tools/renderers/DelegateRenderer.ts:42–`) are
canonical examples: a collapsible card with an icon header, an inline body,
and the raw payload tucked behind a chevron.

There is also a separate **message‑role** registry
(`src/ui/components/message-renderer-registry.ts`, dispatched at
`MessageList.ts:126–131`) that lets us render an entire message by role
without going through the tool‑call path. We will **not** use that path —
keeping the synthetic message shape as `role: "assistant"` is important so
existing dedup/ordering rules continue to apply uniformly.

### 1.8 Slash command path

`src/ui/components/AgentInterface.ts:1069–1101` shows `/compact`:
appends a `compact_cmd_*` user message via the reducer's `appendMessage`,
triggers `_streamingContainer.startCompacting()` (blob squash animation),
then calls `(session as any).compact()` which RPC‑calls the server's
`compactRpc` (`src/server/agent/rpc-bridge.ts:426`).

### 1.9 Manual‑integration scaffolding

Existing pattern: `tests/manual-integration/restart-minimal.spec.ts:1–60` is
the smallest viable scaffold — spawns a gateway with a temp BOBBIT_DIR via
`spawn(node, [SERVER_CLI, …])`, waits for the token file, then drives the
gateway via REST + a Playwright browser. `session-resilience.spec.ts:1–80`
shows the richer multi‑project / sandboxed‑goal version. The pressure test
will follow the minimal pattern.

### 1.10 Tool description budget

`tests/tool-description-budget.test.ts:1–40` budgets every registered tool
description. The new rich‑summary "tool" is a **UI‑only synthetic** — it is
not registered with the LLM via `defaults/tools/*/extension.ts` and therefore
**does not affect the budget**. (We will explicitly assert this in the doc so
the next reviewer does not panic.)

---

## 2. Proposed design

### 2.1 Payload shape

Define a typed payload that travels on the synthetic assistant message and
through the reducer:

```ts
// src/app/compaction-types.ts (new file)
export interface CompactionSummaryPayload {
    /** v1 — bump if the renderer adds new fields that break older snapshots. */
    schemaVersion: 1;
    /** "manual" → /compact slash command;   "auto" → agent auto‑compaction. */
    trigger: "manual" | "auto";
    success: boolean;
    /** ISO‑8601 of compaction_end on the client. */
    timestamp: string;
    /** Token count reported in compaction_end.tokensBefore (may be null). */
    tokensBefore: number | null;
    /** Best‑effort post‑compaction usage from session.state after refresh.
     *  Null when not known (e.g. error path, or refresh hasn't landed yet). */
    tokensAfter: number | null;
    /** Derived. Null if either count is null. Range 0–100, one decimal. */
    reductionPct: number | null;
    /** Failure detail, only set when success === false. */
    error?: string;
}
```

`tokensAfter` is a best‑effort read of
`session.state.contextTokens` (or equivalent — implementer should
`grep contextTokens src/app` first) sampled at the moment we apply the
`compaction-result`. If the server's `refreshAfterCompaction` has not yet
landed, `tokensAfter` stays `null` and the renderer shows an em‑dash for the
"after" row plus "reduction unknown". On the next snapshot it can be patched
in by a follow‑up `compaction-result-amend` action — but to keep scope tight
we accept `null` in v1 and rely on the user noticing the context bar.

### 2.2 Synthetic message envelope

Reuse the **toolCall** routing path so the existing tool‑renderer registry
does the rendering. Synthesise an assistant message whose only content block
is a fake `toolCall`:

```ts
const id = `compact_done_${Date.now()}`;        // success
// or
const id = `compact_err_${Date.now()}`;          // failure
const toolCallId = `compaction-summary:${id}`;

const resultMsg = {
    role: "assistant" as const,
    id,
    timestamp: Date.now(),
    content: [{
        type: "toolCall" as const,
        id: toolCallId,
        name: "__compaction_summary",
        arguments: payload,                     // CompactionSummaryPayload
    }],
};

// Paired synthetic toolResult so the renderer's "completed" branch fires.
const resultRow = {
    role: "toolResult" as const,
    toolCallId,
    toolName: "__compaction_summary",
    isError: !payload.success,
    content: [{ type: "text", text: payload.success ? "ok" : (payload.error || "compaction failed") }],
    timestamp: Date.now(),
    details: payload,                            // mirrored into details for the renderer
};
```

Two reducer actions per compaction end (the second is **append‑only**, no
new reducer case is needed because `toolResult` rows are handled by the
existing `live-message-end` path — implementer to verify with
`src/app/message-reducer.ts` apply‑message helpers; if the synthetic
toolResult cannot be inserted via existing actions, add a sibling
`compaction-result-tool-result` action that mirrors `compaction-result`).

The leading underscore on `__compaction_summary` makes it visually distinct
from real tools and signals "synthetic / never invokable by the LLM" — the
same convention the codebase already uses for internal slots.

### 2.3 Reducer changes

`message-reducer.ts:454–467` — extend `compaction-result` to also accept the
paired toolResult:

```ts
| { type: "compaction-result"; message: any; success: boolean; toolResult?: any }
```

```ts
case "compaction-result": {
    const tick = state.nextTick;
    const order = state.highestSeq + 0.5;
    const messages = state.messages.filter(
        (m) => m.id !== "compacting_placeholder",
    );
    messages.push(stamp(action.message, "synthetic", order, tick));
    if (action.toolResult) {
        messages.push(stamp(action.toolResult, "synthetic", order + 0.001, tick + 1));
    }
    return {
        messages: sortMessages(messages),
        nextTick: tick + (action.toolResult ? 2 : 1),
        highestSeq: state.highestSeq,
    };
}
```

**Snapshot dedup invariant** — `message-reducer.ts:257–261, 346–354`. The
text‑prefix probe (`startsWith("Context compacted")`) was the *only* way to
recognise the synthetic before; now the synthetic carries a toolCall block and
no top‑level text. We extend both probes:

```ts
function hasCompactionToolCall(m: any): boolean {
    if (m.role !== "assistant") return false;
    const cs = (m as any).content;
    if (!Array.isArray(cs)) return false;
    return cs.some((c: any) => c?.type === "toolCall" && c?.name === "__compaction_summary");
}
function isCompactionToolResult(m: any): boolean {
    return m?.role === "toolResult" && (m as any).toolName === "__compaction_summary";
}
function isSyntheticCompactionMarker(m: any): boolean {
    if (m._origin !== "synthetic") return false;
    if (hasCompactionToolCall(m) || isCompactionToolResult(m)) return true;
    // Legacy text‑form, kept so older sessions still dedup correctly.
    if (m.role === "assistant") {
        const t = extractText(m);
        return typeof t === "string" && t.startsWith("Context compacted");
    }
    return false;
}
```

Snapshot path:

```ts
const serverHasCompactionMarker = snapshotRows.some((m) => {
    if (m.role !== "assistant") return false;
    const t = extractText(m);
    return typeof t === "string" && t.startsWith("Context compacted");
});
…
if (m._origin === "synthetic") {
    if (typeof m.id === "string" && serverIds.has(m.id)) continue;
    if (serverHasCompactionMarker && isSyntheticCompactionMarker(m)) continue;
    survivors.push(m);
    continue;
}
```

Result: cases (12) and "snapshot drops trailing synthetic compaction marker"
in `tests/message-reducer.test.ts:249–292, 297–323` continue to pass
**unchanged**, because the text‑form they construct still matches
`isSyntheticCompactionMarker` via the legacy branch.

### 2.4 Round‑trip across reload

After a successful compaction the server's snapshot contains the agent's own
plain‑text marker (the row whose text starts with `"Context compacted"`).
That row is the *authoritative* persisted artefact — we cannot easily change
it from this PR. So the round‑trip strategy is:

1. **In the live session**, the synthetic rich card wins. The snapshot dedup
   above keeps it: the rich synthetic is `_origin: "synthetic"` and is **not**
   dropped by the server marker unless the server's text also begins with
   `"Context compacted"` (which it does). To resolve, flip the priority — when
   both exist, **drop the server's text marker** in favour of the synthetic
   rich row.

   Replace the simple "drop synthetic when server has marker" logic with a
   *two‑way* decision:

   ```ts
   if (serverHasCompactionMarker) {
       // Locate the server row (text‑prefix match) and drop it iff there
       // is a surviving synthetic rich marker for the same compaction.
       const richSyntheticPresent = survivors.some((m) =>
           m._origin === "synthetic" && hasCompactionToolCall(m));
       if (richSyntheticPresent) {
           // Filter out the server text marker from the merged result.
           // (Implementation: post-filter snapshotRows in the merged array.)
       } else {
           // Legacy path — server row wins, synthetic dropped.
           // (Existing behaviour, used after reload when no synthetic exists yet.)
       }
   }
   ```

2. **After a hard reload** there is no live synthetic. The reducer sees the
   server's plain‑text marker and *materialises* a rich synthetic in its
   place. Add a small adapter in the `snapshot` action: when a server row's
   text starts with `"Context compacted"` and no rich synthetic exists yet,
   replace that row in‑place with an upgraded one whose content is the
   `__compaction_summary` toolCall + payload derived from the text
   (`tokensBefore` parsed back out of the formatted "from Xk tokens" string;
   `tokensAfter`/`reductionPct` left `null`; `trigger`/`success`/`timestamp`
   inferred — see "Risks" §3.2).

   This adapter lives next to `serverHasCompactionMarker` in
   `message-reducer.ts` and is unit‑tested as case (12b) below.

### 2.5 Emission in `remote-agent.ts`

`src/app/remote-agent.ts:1875–1909` — replace the `resultMsg` construction
with a builder that produces both the synthetic assistant + toolResult:

```ts
case "compaction_end":
case "auto_compaction_end": {
    this._isCompacting = false;
    this.onCompactionChange?.(false);
    const success = event.type === "compaction_end" ? event.success : !event.aborted;
    const tokensBefore = (event as any).tokensBefore ?? null;
    const tokensAfter = this._readContextTokens();   // helper, may return null
    const reductionPct = (tokensBefore && tokensAfter && tokensBefore > 0)
        ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 1000) / 10
        : null;
    const trigger: "manual" | "auto" =
        event.type === "auto_compaction_end" ? "auto" : "manual";
    const payload: CompactionSummaryPayload = {
        schemaVersion: 1,
        trigger,
        success,
        timestamp: new Date().toISOString(),
        tokensBefore,
        tokensAfter,
        reductionPct,
        error: success ? undefined :
            ((event as any).error || ((event as any).aborted ? "Compaction aborted" : "Unknown error")),
    };
    const { message, toolResult } = buildCompactionSummaryMessages(payload);
    this.apply({ type: "compaction-result", message, success, toolResult });
    if (event.type === "auto_compaction_end") {
        this.emit({ type: "compaction_end", success } as any);
        return;
    }
    break;
}
```

`_readContextTokens()` is a new private that reads from `this._state`
(implementer: confirm exact field by `grep 'contextTokens\|usage\.' src/app/remote-agent.ts`).

`buildCompactionSummaryMessages` lives in
`src/app/compaction-types.ts` alongside the payload type.

### 2.6 Renderer — `src/ui/tools/renderers/CompactionSummaryRenderer.ts`

New file, registered in `src/ui/tools/index.ts` near
`registerToolRenderer("delegate", new DelegateRenderer())` (around
`tools/index.ts:47`):

```ts
import { CompactionSummaryRenderer } from "./renderers/CompactionSummaryRenderer.js";
registerToolRenderer("__compaction_summary", new CompactionSummaryRenderer());
```

Visual spec — a small theme‑aware card, mirroring the dimensions of
`HtmlRenderer`'s completed branch but without the iframe. All colours via
Bobbit CSS tokens (`docs/html-rendering.md` enumerates the palette; the
renderer is inside the app, so we use Tailwind utility classes that bind to
those tokens, same as `DelegateRenderer.ts`):

```
┌──────────────────────────────────────────────────────────────────┐
│  [icon]  Context compacted            [auto|manual]  [✓|✕]       │  ← header
├──────────────────────────────────────────────────────────────────┤
│  before   12,480 tok                                              │
│  after     2,910 tok          ▓▓▓▓░░░░░░  −76.7%                  │
├──────────────────────────────────────────────────────────────────┤
│  17:02:54 · local                                       [details] │  ← footer
└──────────────────────────────────────────────────────────────────┘
```

Concrete bindings:

| Slot | Element | Token / class |
|---|---|---|
| Icon | `lucide/PackageOpen` (success) or `lucide/AlertTriangle` (fail) | `text-primary` / `text-destructive` |
| Border | card outer | `border-border` |
| Background | card outer | `bg-card` |
| "before"/"after" labels | small caps | `text-muted-foreground` |
| Token numbers | mono | `text-foreground font-mono` |
| Reduction badge | tint | `color-mix(in oklch, var(--chart-1) 14%, transparent)` background, `var(--chart-1)` text |
| Trigger pill | rounded‑full tag | `bg-muted text-muted-foreground` |
| Verdict tick/cross | icon, right of trigger pill | `text-positive` / `text-negative` |
| Footer timestamp | x-small | `text-xs text-muted-foreground` |

If `payload.reductionPct === null`, omit the bar and badge; show
`after  —` with `text-muted-foreground`. If `success === false`, hide the
bar entirely and show the `error` string in the body using `text-destructive`.

The renderer is small (~120 lines) and follows the
`renderCollapsibleHeader / renderHeader` pattern from
`src/ui/tools/renderers/HtmlRenderer.ts:115–125`. The collapsed body contains
a JSON pretty‑print of the payload behind a chevron.

`isCustom: false` so the chrome (group spacing, header strip) matches every
other tool render.

### 2.7 No description‑budget impact

`__compaction_summary` is never registered via
`defaults/tools/*/extension.ts`, never reaches the LLM, never shows up in any
role's tool list. `tests/tool-description-budget.test.ts:1–40` walks
extensions, not renderers — so no budget pin change. We add a one‑line
comment to `tools/index.ts` near the registration explaining this so the
reviewer doesn't ask.

---

## 3. Test plan

### 3.1 Real‑LLM e2e — `tests/compaction.spec.ts`

Claims the `compaction.spec.ts` slot in
`tests/playwright-e2e.config.ts:21`. Prune the other four dangling entries
in that same `testMatch` block — they reference files that this goal does
not produce and that have been missing since the file's creation.

Add npm script so the config is reachable:

```json
"test:e2e:real": "npm run build && npx playwright test --config tests/playwright-e2e.config.ts"
```

`tests/compaction.spec.ts` shape:

```ts
import { test, expect } from "@playwright/test";

test.describe("compaction — real LLM @real", () => {
  test("/compact emits rich summary, persists across nav and reload", async ({ page, request }) => {
    // 1. Create a project + session via REST against http://localhost:3097.
    //    Use the BOBBIT_DIR=.e2e-real-bobbit token written by webServer.
    //    Pattern: lift the helper used in tests/e2e/in-process-harness.ts
    //    (createProject + createSession) but pointing at port 3097.

    // 2. Open page → /session/<id> via baseURL http://localhost:5174.
    await page.goto(`/session/${sessionId}`);
    await page.waitForSelector("message-list");

    // 3. Fill context. Two options, pick the cheap one:
    //    (a) Use the model picker to select a model with a tiny context
    //        window, then send 2–3 large pasted prompts. The pattern for
    //        applying a model override is in
    //        tests/e2e/context-window-overrides.spec.ts (config‑side only —
    //        the new test uses the UI model picker instead).
    //    (b) Drive multiple short turns. Reliable but slow.
    //    We use (a). Aim for >70 % context fill so /compact is a no‑op-
    //    proof exercise of the codepath, not a stress test.

    // 4. Trigger /compact via the prompt box.
    await page.locator("textarea[placeholder^='Ask']").fill("/compact");
    await page.keyboard.press("Enter");

    // 5. Blob squashes — wait for the body class or canvas data attr the
    //    StreamingContainer sets when isCompacting=true.
    //    Implementer: confirm exact selector via
    //    grep "startCompacting\|isCompacting" src/ui --glob='*.ts'.
    await expect(page.locator(".bobbit-blob.is-compacting, [data-compacting='true']")).toBeVisible({ timeout: 15_000 });

    // 6. Wait for the rich card to render in the transcript.
    //    The CompactionSummaryRenderer emits a stable test hook
    //    data-testid="compaction-summary-card" on the card root.
    const card = page.locator("[data-testid='compaction-summary-card']");
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText("Context compacted")).toBeVisible();

    // 7. No errors leaked.
    const consoleErrors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await expect(page.locator(".error-toast, [role='alert']")).toHaveCount(0);

    // 8. Persistence across session navigation:
    //    Navigate to a second session, then back. Card still there.
    await page.goto(`/session/${otherSessionId}`);
    await page.goto(`/session/${sessionId}`);
    await expect(card).toBeVisible({ timeout: 15_000 });

    // 9. Persistence across reload.
    await page.reload();
    await expect(card).toBeVisible({ timeout: 15_000 });
    // The reload path is materialised from the server text marker → confirm
    // tokens-before is rendered even though tokensAfter may be null.
    await expect(card.locator("[data-test='tokens-before']")).toContainText(/tok/);
  });
});
```

Key selector contract introduced by this PR:

- `data-testid="compaction-summary-card"` on the card root.
- `data-test="tokens-before"`, `data-test="tokens-after"`,
  `data-test="reduction-pct"`, `data-test="trigger"`, `data-test="verdict"`.

These are stable assertion targets — no flaky text matching.

Flake avoidance:

- We never sleep. Every wait is a `waitForSelector` / `expect.toBeVisible`
  with explicit `timeout`.
- The blob‑animation assertion uses the CSS class / data attribute the
  renderer sets — not a frame‑timed canvas screenshot.
- The "after" token count is **not** asserted at any specific value — we only
  assert the card renders and `tokensBefore` is present. Token counts depend
  on the actual model response and would be flaky.

### 3.2 Manual‑integration — `tests/manual-integration/compaction-pressure.spec.ts`

Follow `tests/manual-integration/restart-minimal.spec.ts:1–60` for the
gateway scaffold:

1. `mkdirSync` a fresh temp BOBBIT_DIR, spawn `dist/server/cli.js` on a free
   port, wait for the token file.
2. Create a project, then a session, with a model whose **real** context
   window is small enough to actually trigger auto‑compaction in a few
   prompts. Default candidate: `anthropic/claude-haiku-4-5` with the
   `contextWindow` override knocked down via
   `~/.bobbit/agent/models.json` (the same overrides that
   `tests/e2e/context-window-overrides.spec.ts` documents — write a tiny
   value before starting the gateway). Implementer: pick whatever Bobbit's
   default tier‑0 model is at branch HEAD by reading the `naming_model` in
   `.bobbit/config/project.yaml`; **do not** hardcode model IDs.
3. Drive 3–4 large pasted prompts via the browser to push past 90 % usage.
4. Send one more prompt with enough payload that the pre‑turn budget check
   forces an `auto_compaction_start`. Wait for `auto_compaction_end` via the
   network log (`WebSocket` frame with `data.type === "auto_compaction_end"`).
5. Assertions:
   - No `error` toast.
   - `compaction-summary-card[data-test="trigger"]` reads `auto`.
   - **Post‑compact turn succeeds**: send `"reply with the word OK"`, expect
     `"OK"` in the next assistant message within 60 s.

Sandbox: no Docker requirement — this test exercises the agent process, not
the sandbox. The existing `playwright-manual.config.ts` worker spawns the
gateway directly. Wall time target ≤ 5 min.

### 3.3 Unit tests — `tests/message-reducer.test.ts`

Edits required:

- **Case (12)** (lines 249–278) keeps its text‑form server marker — already
  exercises the legacy branch of `isSyntheticCompactionMarker`. **No edit.**
- **New case (12b)** "rich compaction synthetic + server text marker — rich
  synthetic wins, server text dropped":

  ```ts
  it("(12b) rich synthetic compaction wins over server text marker", () => {
      const placeholder = { id: "compacting_placeholder", role: "assistant",
          content: [{ type: "text", text: "Compacting context…" }], timestamp: 0 };
      const richMsg = {
          id: "compact_done_2", role: "assistant", timestamp: 0,
          content: [{ type: "toolCall", id: "compaction-summary:compact_done_2",
                      name: "__compaction_summary",
                      arguments: { schemaVersion: 1, trigger: "manual", success: true,
                                   timestamp: "2026-05-12T00:00:00Z",
                                   tokensBefore: 12_000, tokensAfter: 3_000,
                                   reductionPct: 75 } }],
      };
      const richResult = {
          role: "toolResult", toolCallId: "compaction-summary:compact_done_2",
          toolName: "__compaction_summary", isError: false,
          content: [{ type: "text", text: "ok" }], timestamp: 0,
      };
      const serverText = {
          id: "asst_compact_server_2", role: "assistant",
          content: [{ type: "text", text: "Context compacted from 12k tokens." }],
          timestamp: 0,
      };
      const s = applyAll([
          { type: "compaction-placeholder", message: placeholder },
          { type: "compaction-result", message: richMsg, toolResult: richResult, success: true },
          { type: "snapshot", messages: [userMsg("u1","x"), serverText] },
      ]);
      const ids = s.messages.map(m => m.id);
      assert.ok(ids.includes("compact_done_2"));      // rich kept
      assert.ok(!ids.includes("asst_compact_server_2")); // server text dropped
      assert.ok(!ids.includes("compacting_placeholder"));
  });
  ```

- **New case (12c)** "reload‑style snapshot with only server text materialises
  rich synthetic":

  ```ts
  it("(12c) snapshot with only server text marker is upgraded to a rich synthetic", () => {
      const serverText = {
          id: "asst_compact_server_3", role: "assistant",
          content: [{ type: "text", text: "Context compacted from 9.4k tokens." }],
          timestamp: 0,
      };
      const s = applyAll([
          { type: "snapshot", messages: [userMsg("u1","x"), serverText] },
      ]);
      const compaction = s.messages.find(m =>
          (m as any).content?.some?.((c: any) => c?.name === "__compaction_summary"));
      assert.ok(compaction, "upgrade should produce a rich synthetic");
      const call = (compaction as any).content[0];
      assert.equal(call.arguments.tokensBefore, 9_400);
      assert.equal(call.arguments.tokensAfter, null);
      assert.equal(call.arguments.reductionPct, null);
  });
  ```

- **"snapshot drops trailing synthetic compaction marker"** (lines 297–323) —
  **no edit**. It uses the text‑form synthetic; covered by the legacy branch.

### 3.4 Description‑budget test

`tests/tool-description-budget.test.ts` — **no change**. Confirmed in §2.7.

---

## 4. Risks and open questions

1. **Server snapshot text format is upstream.** §2.4 parses
   `"Context compacted from Xk tokens."` back into a number. If
   pi‑coding‑agent ever changes that string, the reload‑path upgrade in
   case (12c) silently falls back to no‑tokens. Mitigation: case (12c)'s
   token assertion `tokensBefore === 9_400` catches a parse regression as a
   unit test, and the e2e's reload step asserts the *card* still renders even
   when tokens are null. Document the parsing function with a `// Coupled to
   pi-coding-agent transcript format — see docs/design/compaction-e2e-rich-summary.md §2.4`
   comment.

2. **Ordering: `compaction_end` vs subsequent snapshot.** Server emits
   `compaction_end` *before* `refreshAfterCompaction`
   (`src/server/ws/handler.ts:564–568`). The client therefore applies
   `compaction-result` first (live event), then a snapshot lands. The new
   "rich wins over server text" rule §2.3 keeps order‑independence because
   the snapshot's filter looks at the *current* survivors list. Unit case
   (12b) pins this order. Inverted order — snapshot first, then live event —
   is theoretically possible (e.g. reconnect during compaction) and is
   covered implicitly: on reconnect the placeholder is re‑added at
   `remote-agent.ts:1075`, then the eventual `compaction_end` arrives and
   replaces it; this matches the existing case (12) shape with a rich payload.

3. **`tokensAfter` may be `null` indefinitely.** Server doesn't broadcast a
   post‑compaction usage count alongside `compaction_end`. We sample
   `session.state.contextTokens` at apply time — usually populated by the
   immediately preceding state refresh, but no guarantee. Acceptable for v1
   per spec ("tokens‑after (if available)"). Follow‑up could add a
   `compaction-result-amend` action driven off the next `state_update`.

4. **`auto_compaction_start` placeholder race.** The agent subprocess emits
   `auto_compaction_start` directly to clients via the event forwarder; the
   client normalises to `compaction_start` (`remote-agent.ts:1858–1860`)
   *but returns early*, so the default `this.emit(event)` doesn't fire. The
   rich‑summary work doesn't change this — but the e2e's `auto` branch in
   §3.2 should listen for the normalised `compaction_start` and not the
   `auto_*` form. Document in the test header.

5. **Renderer registry collision with future real tool named
   `__compaction_summary`.** Trivially avoided by the underscore prefix —
   real tools never start with `__`. Add an assertion in
   `tests/tool-description-budget.test.ts` that no registered tool name
   starts with `__`? Out of scope; flag for follow‑up.

6. **Dangling `tests/playwright-e2e.config.ts` entries other than
   `compaction.spec.ts`.** Pruning them is technically a side‑effect of this
   goal. If the team prefers to leave them in place (to claim later), the
   prune commit can be split. Default: prune.

---

## 5. File touch list

| File | Edit |
|---|---|
| `tests/playwright-e2e.config.ts` | Prune dangling entries; keep `compaction.spec.ts`. |
| `package.json` | Add `test:e2e:real` script. |
| `tests/compaction.spec.ts` | **New** — §3.1. |
| `tests/manual-integration/compaction-pressure.spec.ts` | **New** — §3.2. |
| `src/app/compaction-types.ts` | **New** — payload + `buildCompactionSummaryMessages`. |
| `src/app/remote-agent.ts` (1875–1909) | Swap plain‑text construction for rich payload. Add `_readContextTokens` private. |
| `src/app/message-reducer.ts` (50–53, 257–261, 346–354, 454–467) | Extend action type with `toolResult?`; extend dedup with `isSyntheticCompactionMarker`; add reload‑path upgrade. |
| `src/ui/tools/renderers/CompactionSummaryRenderer.ts` | **New** renderer. |
| `src/ui/tools/index.ts` (~47) | Register `__compaction_summary`. |
| `tests/message-reducer.test.ts` (after case 12) | Add cases (12b), (12c). |

No changes required in `src/server/` or `defaults/tools/`. No description
budget impact. No new MCP / agent‑facing tool.
