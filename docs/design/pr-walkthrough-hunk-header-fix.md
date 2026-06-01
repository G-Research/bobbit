# PR Walkthrough `hunkSignature` TypeError — Root-Cause Analysis

> Status: **fixed and merged.** Both defects below were resolved as described in
> **Proposed fix**; the analysis is retained for context. See **Resolution**
> immediately below for what landed and the regression tests that pin it.

## Resolution

Both fixes landed exactly as proposed; `PrWalkthroughHunk.header` stays required
`string`.

- **UI (`src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts`)** —
  `hunkSignature` coerces a non-string `header` to `""`
  (`const text = typeof header === "string" ? header : ""`), `sectionSignature`
  forwards `hunk.header ?? ""`, and a new per-block error boundary
  `renderDiffBlockSafe(card, block)` wraps `renderDiffBlock` in a `try/catch`.
  On throw it logs via `console.warn` and renders a local fallback
  (`data-testid="pr-walkthrough-diff-block-error"`) naming `block.filePath`, so
  one malformed block degrades locally instead of blanking the pane. `renderCard`
  maps blocks through `renderDiffBlockSafe`.
- **Producer (`src/server/pr-walkthrough/walkthrough-analysis-bundle.ts`)** —
  both `diffBlockFromBundleFile` and the bundle writer `bundleHunkFromDiffHunk`
  coerce `header` to a string (`typeof hunk.header === "string" ? hunk.header : ""`).
  The `isDiffBlock` guard now also requires every hunk to be a record with a
  string `header` (`value.hunks.every(hunk => isRecord(hunk) && typeof hunk.header === "string")`);
  the three duplicate guards (`walkthrough-analysis-bundle.ts`,
  `walkthrough-yaml-schema.ts`, `routes.ts`) were tightened in step.

### Regression tests

- **Server unit** — `tests/pr-walkthrough-bundle-hunk-header.test.ts`: feeds a
  persisted bundle whose hunk omits `header` and asserts every reconstructed
  hunk carries a string `header`; also pins that a present header is preserved
  verbatim. Fails before the producer fix.
- **Browser E2E** — `tests/e2e/ui/pr-walkthrough-panel.spec.ts`, test
  *"renders cards and stays interactive when a diff hunk header is undefined
  (hunkSignature regression)"*: clones the fixture cards in the test, blanks one
  hunk's `header`, and asserts the card and diff block still render with no
  `Cannot read properties of undefined (reading 'match')` / `hunkSignature`
  console or page errors.

## Symptom

Clicking **Walkthrough** in the Git Status Widget (Pull Request section), or
running `/walkthrough-pr <url>`, launches a walkthrough that reaches the `ready`
state and begins rendering diff cards. The review pane then throws a render-time
`TypeError` that aborts the entire Lit `render()`. Because `render()` never
completes, the panel never repaints and **nothing in the pane is interactive** —
card navigation, diff-mode toggles, comments/decisions, and export controls are
all dead.

## Confirmed stack trace

```
Uncaught (in promise) TypeError: Cannot read properties of undefined (reading 'match')
    at HTMLElement.hunkSignature (PrWalkthroughPanel.ts:1355)
    at HTMLElement.sectionSignature (PrWalkthroughPanel.ts:1360)
    at renderInlineHunk (PrWalkthroughPanel.ts:1325)
    at renderInlineDiff (PrWalkthroughPanel.ts:1317)
    at renderDiffBlock (PrWalkthroughPanel.ts:1271)
```

`hunkSignature(header)` calls `header.match(...)`, and `header` is `undefined`.
It is reached from `sectionSignature(...)` returning `this.hunkSignature(hunk.header)`
— i.e. a diff hunk whose `header` field is `undefined` at runtime.

This is two distinct defects: a **UI fragility** defect (one bad hunk blanks the
whole pane) and a **data/contract** defect (a `header`-less hunk exists at all).

---

## Defect 1 — Panel fragility (primary symptom)

`PrWalkthroughHunk.header` is declared required `string`
(`src/shared/pr-walkthrough/types.ts:35-39`), so every diff-render helper in the
panel treats it as a guaranteed string and dereferences it directly. The moment a
hunk arrives with `header === undefined`, the helper throws, and because the
render path has **no per-card / per-block error boundary**, the single throw
aborts the whole component render.

### Where the assumption lives (file:line)

All in `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts`:

| Helper | Line | Assumption / failure |
|---|---|---|
| `hunkSignature(header)` | 1354-1356 | `header.match(/^@@[^@]*@@\s*(.*)$/)` — **direct throw site** when `header` is `undefined`/non-string. |
| `sectionSignature(hunk, entry, prevCtx)` | 1358-1361 | returns `this.hunkSignature(hunk.header)`; forwards a possibly-`undefined` `hunk.header`. |
| `renderHunkHeader(header, controls)` | 1342-1352 | calls `this.hunkSignature(header)`; the typed `header: string` param can still receive `undefined` via `sectionSignature`. |
| `renderInlineHunk(...)` | 1323-1340 | computes `header = this.sectionSignature(...)` (line 1333) then renders; throw propagates. |
| `renderSplitHunk(...)` | 1286-1321 | computes `header = this.sectionSignature(...)` (line 1296); same propagation. |
| `scopeSignatureBeforeIndex(hunk, anchorIndex)` | 1363-1389 | iterates `hunk.lines`; reads `hunk.lines[i]?.text ?? ""` — already guarded, but feeds `scopeStartSignature`. |
| `scopeStartSignature(hunk, lineIndex)` | 1391-1400 | reads `hunk.lines[index]?.text ?? ""` — guarded; not a throw site. |
| `maskStringsAndLineComments(line)` | 1402-1424 | already coerces with `?? ""` upstream; not a throw site. |
| `diffRenderEntriesForHunk(...)` | 1436+ | works off `hunk.lines` only; not a throw site (but produces the entries that reach `sectionSignature`). |

The actual throw site is `hunkSignature` (line 1355). `scopeSignatureBeforeIndex`,
`scopeStartSignature`, and `maskStringsAndLineComments` are already defensive about
`hunk.lines[i]?.text` and would not throw on a missing header; they are listed
because they are part of the same diff-render path and should stay defensive.

### Why one bad hunk blanks the entire panel

There is **no error boundary** anywhere on the synchronous render path:

- `render()` (line 873) → `renderActiveContent`/`renderCard(active)` (line 1199).
- `renderCard` renders the diff with `card.diffBlocks.map(block => this.renderDiffBlock(card, block))` (**line 1219**) — a plain `.map`, no `try/catch`.
- `renderDiffBlock` (1259) → `renderInlineDiff`/`renderSplitDiff` (1311/1276) → `renderInlineHunk`/`renderSplitHunk` → `sectionSignature` → `hunkSignature`.

Lit builds the entire `TemplateResult` tree eagerly and synchronously. A `throw`
anywhere inside that expression tree unwinds the whole `render()` call, so the
component commits nothing — the pane goes blank/unresponsive even though only one
hunk in one block of one card was malformed.

---

## Defect 2 — Contract violation (the data defect)

`PrWalkthroughHunk.header` is typed required `string`
(`src/shared/pr-walkthrough/types.ts:35-39`), and every *live parser* sets it:

- `src/server/pr-walkthrough/diff-parser.ts:176-184` (`parseHunkHeader`) — `header` from the raw `@@` line.
- `src/server/pr-walkthrough/github-adapter.ts:480` — `header: rawLine`.
- `src/server/pr-walkthrough/routes.ts:614` — `header: raw`.

So the question is: which path emits a hunk that **bypasses** those parsers and
reaches the UI with `header === undefined`?

### The producing path (file:line)

**`diffBlockFromBundleFile()` — `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts:302-321`, specifically the hunk reconstruction at line 317 (`header: hunk.header`).**

This is the runtime reconstruction that builds the `PrWalkthroughDiffBlock`s the
panel actually renders on the live launch path. End-to-end trace of the Git
Status Widget → **Walkthrough** launch:

1. **Launch / bundle creation.** `WalkthroughAgentManager.resolveAndPersistLaunchBundle`
   (`walkthrough-agent-manager.ts:401-417`) resolves the PR diff
   (`resolveLaunchDiffForBundle`, 419-450 → `resolveGithubPr` / `localDiffForYaml`)
   and persists an **analysis bundle JSON** via `createAnalysisBundleFromParsedDiff`.
   Hunks are written by `bundleHunkFromDiffHunk` (`walkthrough-analysis-bundle.ts:285-300`,
   `header: hunk.header` at line 289).
2. **Agent produces YAML.** The read-only agent reads the persisted bundle and
   calls `submit_pr_walkthrough_yaml`.
3. **YAML → cards.** `WalkthroughAgentManager.mapYamlToPayload`
   (`walkthrough-agent-manager.ts:459-471`) calls `resolveDiffForYamlMapping`
   (473-478), which on the live path **reloads the persisted bundle** and runs
   `analysisBundleToParsedDiff(bundle)` (`walkthrough-analysis-bundle.ts` ~175-211).
   That maps every bundle file through **`diffBlockFromBundleFile`** (302-321),
   producing the `diffBlocks` that `mapYamlToWalkthroughPayload`
   (`walkthrough-yaml-schema.ts:231-303`) attaches to cards — both via
   `mapper.blocksForFiles(chunk.files)` (line 271) and `buildAuditCard`’s
   `remainingBlocks` (line 290). These blocks reach the panel verbatim as
   `card.diffBlocks[].hunks[]`.

### The mechanism — the contract is enforced *nowhere* at this boundary

`diffBlockFromBundleFile` copies the header straight from the re-read JSON with
**no coercion or default**:

```ts
hunks: file.hunks.map(hunk => ({
    id: hunk.id ?? `hunk-${hashText(`${file.path}\0${hunk.header}`).slice(0, 12)}`,
    header: hunk.header,            // <-- line 317: undefined survives unchanged
    lines: hunk.lines.map(...),
})),
```

The bundle is parsed by `parseBundle`/`sanitizeBundle`
(`walkthrough-analysis-bundle.ts` ~318-345 region): it validates `schema_version`,
`kind`, `job_id`, `target`, `changeset`, and that `files` is an array — but it
**never validates that each hunk carries a string `header`**. The
`sanitizeValue`/`isSensitiveKey` pass explicitly *preserves* `header` (it is not a
sensitive HTTP header), so a header-less hunk is neither stripped nor repaired.

Worse, the shared type guard used to admit blocks into the pipeline does not check
hunk shape at all:

```ts
function isDiffBlock(value): value is PrWalkthroughDiffBlock {
    return isRecord(value) && typeof value.id === "string"
        && typeof value.filePath === "string" && Array.isArray(value.hunks);
}
```

This guard is duplicated and used in three places to filter incoming blocks, and
**none of them inspect `hunks[].header`**:

- `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts:466`
- `src/server/pr-walkthrough/walkthrough-yaml-schema.ts:789` (used by `flattenDiffBlocks`, line 778-786)
- `src/server/pr-walkthrough/routes.ts:533`

Net result: any bundle whose hunk lacks a `header` — a bundle persisted by a code
revision that did not guarantee the field, a block that entered via `isDiffBlock`
with a header-less hunk, or any externally-shaped `files`/`diffBlocks` fed into
`bundleFileFromParsedFile` (`walkthrough-analysis-bundle.ts:239-263`) /
`flattenDiffBlocks` — flows unmodified through `diffBlockFromBundleFile:317` and
`mapYamlToWalkthroughPayload` into `card.diffBlocks`, violating the
`PrWalkthroughHunk.header: string` contract and crashing the panel.

> Note on why the server does not also crash first: the YAML *anchor* matcher
> `findHunk` → `normalizeHunkHeader(candidate.header)` (`walkthrough-yaml-schema.ts`)
> does `value.replace(...)` and *would* throw on an `undefined` header — but it is
> only invoked for hunks referenced by YAML `relevant_hunks`/`anchors`. Blocks
> attached via `blocksForFiles(chunk.files)` (line 271) and `buildAuditCard`’s
> `remainingBlocks` (line 290) bypass `findHunk` entirely, so a header-less hunk
> can ride a file-level / audit block all the way to the UI without the server
> ever touching its header. This is why the crash surfaces in the browser, not on
> the server.

---

## Proposed fix

Two independent fixes. Both are required: the UI must be defensive **and** the
producer must honor the contract. The `PrWalkthroughHunk.header: string` type must
**not** be weakened to `string | undefined`.

### Fix 1 — UI: defensive guard + per-block error boundary

`src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts`:

1. **Guard `hunkSignature`** so a missing/empty/non-string header degrades to an
   empty signature instead of throwing:

   ```ts
   private hunkSignature(header: unknown): string {
       const text = typeof header === "string" ? header : "";
       return text.match(/^@@[^@]*@@\s*(.*)$/)?.[1]?.trim() ?? text;
   }
   ```

   With an empty signature, `renderHunkHeader` (line 1344, `if (!signature && controls === nothing) return nothing;`) already renders nothing for that header — a sensible fallback (no hunk-header label, rest of the hunk renders normally).

2. **`sectionSignature`** (1358): coerce `hunk.header` to a string before
   forwarding (`this.hunkSignature(hunk.header ?? "")`), so the helper never
   forwards `undefined` even if called directly.

3. **Per-block error boundary** so a future render bug in one block degrades
   locally instead of blanking the pane. Wrap each block render at the `.map` in
   `renderCard` (line 1219) in a guard, e.g. a `renderDiffBlockSafe(card, block)`
   that `try`/`catch`es `renderDiffBlock` and returns a small inline fallback
   (`data-testid="pr-walkthrough-diff-block-error"`, naming `block.filePath`) on
   throw, logging via `console.warn`. This keeps card navigation, decisions, and
   export working even if one block is malformed.

### Fix 2 — Producer: guarantee `header` is always a string (without weakening the type)

`src/server/pr-walkthrough/walkthrough-analysis-bundle.ts`:

1. **`diffBlockFromBundleFile` (line 317)** — coerce on reconstruction so the
   emitted `PrWalkthroughHunk` always satisfies its declared type:

   ```ts
   header: typeof hunk.header === "string" ? hunk.header : "",
   ```

   (Optionally synthesize a minimal `@@ -0,0 +0,0 @@` when empty, but `""` is
   sufficient and renders as “no signature”.) Mirror the same coercion in
   `bundleHunkFromDiffHunk` (line 289) so bundles are *written* with a guaranteed
   string header too.

2. **Tighten the `isDiffBlock` guards** (`walkthrough-analysis-bundle.ts:466`,
   `walkthrough-yaml-schema.ts:789`, `routes.ts:533`) to additionally require that
   every hunk is a record with a string `header` (or to repair it), so a
   header-less hunk can never be admitted as a valid `PrWalkthroughDiffBlock`.
   Keep these three in sync (consider extracting one shared guard).

This preserves `PrWalkthroughHunk.header: string`: the producer now *honors* it at
the reconstruction/ingestion boundary, and the UI is additionally defensive.

---

## Test plan

### Reproducing test first (TDD, must fail before Fix 1)

Component/unit test rendering `PrWalkthroughPanel` with a card whose hunk has
`header: undefined`. Fixtures live in
`src/ui/components/pr-walkthrough/fixtures.ts` — clone
`getFixturePrWalkthroughCards()` and delete/blank the `header` on one hunk (e.g.
`orientation-panel-h1`), or build a minimal card inline.

- **Before Fix 1:** rendering throws `TypeError: Cannot read properties of undefined (reading 'match')` (or the panel commits nothing).
- **After Fix 1:** the panel renders the card, the malformed hunk shows no
  signature label (or the per-block fallback), and the rest of the card renders.
- Suggested command: `npm run test:unit`.
- Expected pre-fix `error_pattern`: `Cannot read properties of undefined \(reading 'match'\)`.

### Server unit test (pins the producer contract)

In a bundle/analysis test, feed `diffBlockFromBundleFile` (and/or
`analysisBundleToParsedDiff`) a bundle file whose hunk omits `header`, and assert
the reconstructed `PrWalkthroughDiffBlock.hunks[].header` is always a `string`.
Also assert the tightened `isDiffBlock` rejects/repairs a block with a header-less
hunk. Run via `npm run test:unit`.

### Browser E2E (pattern: `tests/e2e/ui/pr-walkthrough-panel.spec.ts`)

Drive a ready walkthrough that includes at least one header-less hunk in its
served cards and assert:

- The pane renders cards (`[data-testid="pr-walkthrough-card"]`, diff blocks).
- **No uncaught console errors** during render/interaction.
- Interaction works: card navigation (`pr-walkthrough-prev`/next),
  diff-mode toggles (`diff-mode-split`/`diff-mode-inline`), comments/decisions,
  and export controls.
- Happy path + persistence across reload (cards re-render, no console errors).

### Gate / commands

- `npm run check`
- `npm run test:unit`
- `npm run test:e2e`

---

## Constraints honored

- Fix the bug, not the test.
- `PrWalkthroughHunk.header` stays required `string`; the producer is made to
  honor it and the UI is additionally defensive.
- No change to `walkthrough-readonly-policy` or bundle submit-proof scoping; Fix 2
  only coerces the `header` field and tightens block validation, and the existing
  `sanitizeValue`/`isSensitiveKey` behaviour (which already preserves `header`) is
  unchanged.
