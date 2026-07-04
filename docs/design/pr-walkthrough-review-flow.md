# PR Walkthrough review flow design

## Scope

This design restructures PR Walkthrough output from file/block-oriented cards into logical review narrative cards. The design is additive where possible: keep the read-only `pr-reviewer` child, exact PR Walkthrough tool allowlist, durable chunk workflow, scoped pack-store quotas, panel reload recovery, compact bundle reads, and compatibility paths for existing finalized payloads.

Non-goals for the first implementation pass:

- Do not replace the pack-based architecture or move diff resolution into the confined pack worker.
- Do not let reviewer agents read arbitrary repo files outside the existing PR Walkthrough tool surface.
- Do not require model-generated YAML to reproduce raw diff bodies.
- Do not hide large-PR safety behind card-count caps; only individual reads and stored values may be bounded.

## Current data flow

### Launch and bundle resolution

1. `market-packs/pr-walkthrough/lib/routes.mjs::run` spawns a fresh read-only reviewer child through `host.agents.spawn` and writes review-scoped binding/index keys:
   - `reviewers/<childSessionId>`
   - `reviews/<jobId>/binding/<childSessionId>`
2. The reviewer role is `market-packs/pr-walkthrough/roles/pr-reviewer.yaml`. Its allowlist is exactly the PR Walkthrough tool group; all other fixed groups and `mcp__*` are denied.
3. `read_pr_walkthrough_bundle` in `market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts` calls `/api/internal/pr-walkthrough/bundle` with the session secret. The server resolves the reviewer binding from pack-store state, validates trusted-host/sandbox boundaries, lazily resolves the diff, and serves it through `WalkthroughAnalysisBundleStore`.
4. `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts` persists the launch-time analysis bundle under `.bobbit` state. Key functions/types:
   - `createAnalysisBundleFromParsedDiff(job, parsedDiff)` converts parsed GitHub/local diff output into `PrWalkthroughAnalysisBundle`.
   - `WalkthroughAnalysisBundleStore.read(job, request)` supports `summary`, `manifest`, `files`, and `file` reads.
   - `manifestForBundle()` returns bundle/change metadata plus file summaries.
   - `fileManifest()` currently exposes file path/status, generated/binary/truncated flags, read-window summary, and hunk count.
   - `windowFileRead()` applies server-side byte/line/hunk read windows before tool formatting.
5. Compact tool output is formatted in `extension.ts`:
   - `formatCompactManifest()` is the authoritative compact envelope read.
   - `formatCompactFileList()` suppresses repeated target/changeset/limits envelopes for follow-up reads.
   - `formatCompactFile()` renders unified-diff-like text under a 64 KiB hard cap.
   - Legacy JSON remains the default when `format` is omitted.

### Durable reviewer submission

1. The reviewer saves chunks using `submit_pr_walkthrough_chunk(section_id, yaml)`.
2. `routes.mjs::submitPrWalkthroughChunk()` resolves the reviewer binding, `validateChunkId()` checks the section id, `lightValidateChunk()` checks the chunk shape, then the chunk is stored at `reviews/<jobId>/draft/chunks/<sectionId>` with the `review-draft` quota scope.
3. `routes.mjs::summarizeChunks()` reports saved chunks, missing required chunks, and the next required item.
4. `routes.mjs::finalizePrWalkthroughSubmission()` calls:
   - `assembleSubmission()` to build canonical YAML from chunk records.
   - `buildFinalPayload()` to validate YAML, resolve live diff blocks where possible, synthesize cards, and prepare the final payload.
   - `host.store.put(finalPayloadKey(jobId), finalPayload, FINAL_QUOTA(jobId))` as the atomic publication point.
5. After final publication, draft/staging prefixes are best-effort deleted, and legacy markers are written only for compatibility.

### YAML synthesis and current card mapping

`src/shared/pr-walkthrough/yaml-to-cards.ts` is the shared source of truth, bundled into the pack as `lib/yaml-to-cards.mjs`. Important current types/functions:

- `PrWalkthroughYamlDocument`, `PrWalkthroughYamlWalkthrough`, `PrWalkthroughYamlDesignDecision`, `PrWalkthroughYamlReviewChunk`, `PrWalkthroughYamlRelevantHunk`, and `PrWalkthroughYamlAnchor` define the canonical YAML shape.
- `validatePrWalkthroughYaml()` validates schema, launch identity, display chunk references, nav labels, and basic minimum content.
- `mapYamlToWalkthroughPayload()` converts valid YAML plus parsed diff blocks into `PrWalkthroughCard[]`.
- `DiffReferenceMapper` indexes `PrWalkthroughDiffBlock[]` by current/old file path and maps relevant hunk/anchor references by exact hunk header, normalized header, numeric hunk coordinates, or sole-hunk fallback.
- `mapRelevantHunks()` currently maps a hunk reference to the whole containing `PrWalkthroughDiffBlock`.
- `mapSuggestedConcerns()` maps suggested comments to line anchors.
- `buildAuditCard()` receives remaining **diff blocks**, not remaining hunks.

The main structural issue is this line in current `mapYamlToWalkthroughPayload()`:

```ts
const fileBlocks = mapper.blocksForFiles(chunk.files);
const diffBlocksForCard = uniqueBlocks([...mappedHunks.blocks, ...fileBlocks]);
```

That makes `review_chunks[].files` an implicit file-wide diff expansion. If multiple logical cards mention the same file, the same full file block can expand in every card. `usedBlockIds` is also block-scoped, so audit coverage cannot distinguish hunk-level reviewed, repeated, skipped, or unread states.

### Current panel rendering

`market-packs/pr-walkthrough/src/panel.js` and built `lib/panel.js` render a card as:

1. card header, summary, rationale, checklist;
2. one diff toolbar for the card;
3. a flat `card.diffBlocks` list;
4. line-level suggested comments not anchored in the diff;
5. card-level suggestions/comments;
6. optional audit draft.

`renderDiffBlock()` has a manual collapsed state keyed by `blockKey(card, block)`, but there is no primary/secondary placement semantic. Repeated diff blocks are treated as normal blocks and expand unless the user toggles them. The panel has no representation for interleaved narrative and diff blocks inside a card.

## Design goals

- Cards are logical review themes: functional, architectural, risk, or verification areas.
- Code display is driven by explicit hunk/block references and a deterministic completion sweep, not by `files` metadata.
- A hunk has one primary expanded placement. Later mentions are secondary references, collapsed by default, with a link/hint to the primary card.
- Duplicate primary ownership is rejected before final payload publication with a structured, retryable error.
- The reviewer reads a compact hunk manifest first, then only bounded hunk slices for the current logical card.
- Durable status and finalization expose read receipts and coverage: primary-reviewed, secondary-referenced, skipped, completion-sweep remaining, unread, repeated.
- The panel renders cards as short narrative beats interleaved with diff blocks and nearby suggested comments.

## Proposed model

### Hunk identity

Keep existing stable IDs as the base identity:

- Local diff parser: `diffBlockIdForFile(filePath, index)` and `hunkIdForBlock(blockId, hunkIndex)`.
- GitHub adapter: stable file block id plus `:h<index>`.
- Bundle fallback: if older bundles omit `hunk.id`, derive `hunk-${hash(file.path + "\0" + hunk.header)}` as today.

Add an explicit manifest identity shape for every hunk:

```ts
type PrWalkthroughHunkManifest = {
  hunk_id: string;
  file: string;
  old_path?: string | null;
  file_id?: string;
  hunk_index: number;
  header: string;
  old_start?: number;
  old_lines?: number;
  new_start?: number;
  new_lines?: number;
  changed_lines: number;
  additions: number;
  deletions: number;
  is_binary: boolean;
  is_generated: boolean;
  is_truncated: boolean;
  source_is_truncated?: boolean;
  read_window?: { applied: boolean; reasons: string[] };
};
```

`WalkthroughAnalysisBundleStore.manifestForBundle()` should include file summaries plus bounded per-file hunk summaries. The manifest must be compact enough to plan from but rich enough to avoid broad reads:

```text
src/auth/session.ts modified +18/-4 generated=false truncated=false hunks=3
  h0 block:1:src__auth__session.ts:h0 @@ -12,7 +12,12 @@ createSession +6/-1
  h1 block:1:src__auth__session.ts:h1 @@ -58,6 +63,9 @@ refreshSession +3/-0
```

For large files, the manifest can cap hunk summary text per file output page, but it must not hide total counts. If summaries are paged, the status must show `hunk_manifest_truncated=true` and the requested `fileOffset`/`limit`/hunk summary window.

### YAML hunk references

Extend `relevant_hunks` additively for both `design_decisions[]` and `review_chunks[]`:

```yaml
relevant_hunks:
  - hunk_id: block:1:src__auth__session.ts:h0   # preferred stable reference
    file: src/auth/session.ts                   # compatibility/navigation fallback
    hunk_header: "@@ -12,7 +12,12 @@ createSession"
    line_range: "+15..+22"
    placement: primary                          # primary | secondary | skip
    why_relevant: Session creation now validates expiry before persisting.
    primary_card_id: auth-flow                  # required for explicit secondary if known
    skip_reason: generated|binary|mechanical|unread|superseded|other
```

Rules:

- `hunk_id` is preferred. `file` + `hunk_header` remains accepted for compatibility and is resolved to a hunk id during finalization.
- Omitted `placement` defaults to `primary` for new hunk references.
- `files` on a review chunk remains required metadata/navigation, but does not add rendered diffs.
- `placement: secondary` references an existing primary hunk. It may supply `primary_card_id`; finalization can fill it if exactly one primary exists.
- `placement: skip` requires `skip_reason` and no rendered diff body. It is for generated/binary/mechanical/low-signal hunks that should be visible in coverage without consuming review card space.
- Existing YAML without `hunk_id` is still accepted, but the mapper resolves to hunk identity before placement validation.

### Card payload shape

Keep `PrWalkthroughCard.diffBlocks` for existing panel/export compatibility, but add hunk-level placement metadata. The finalizer derives these fields from YAML and the bundle; the reviewer should not write raw diff bodies.

```ts
type PrWalkthroughHunkPlacement = {
  hunkId: string;
  blockId: string;
  filePath: string;
  hunkHeader: string;
  placement: "primary" | "secondary" | "skip" | "completion_sweep";
  defaultExpanded: boolean;
  primaryCardId?: string;
  primaryCardTitle?: string;
  whyRelevant?: string;
  skipReason?: string;
  readReceiptIds?: string[];
};

type PrWalkthroughNarrativeBlock =
  | { type: "text"; id: string; body: string }
  | { type: "diff"; id: string; hunkIds: string[]; note?: string }
  | { type: "suggested_comment"; id: string; severity: "blocking" | "non_blocking" | "question" | "nit"; intent: "inline" | "summary"; body: string; anchor?: { hunkId?: string; lineId?: string } }
  | { type: "checklist"; id: string; items: string[] };

type PrWalkthroughCardV2 = PrWalkthroughCard & {
  narrative?: PrWalkthroughNarrativeBlock[];
  hunkPlacements?: PrWalkthroughHunkPlacement[];
  coverage?: PrWalkthroughCardCoverageSummary;
};
```

`diffBlocks` should contain hunk-sliced block clones, not whole-file clones. If a card references two hunks from the same file, the finalizer groups only those hunks under one `PrWalkthroughDiffBlock`. If another card references the same hunk secondarily, that hunk may be present in the card payload for compatibility, but it must carry `placement: secondary` and `defaultExpanded: false`.

### Read receipts

Add read receipts in review-scoped draft state. The internal bundle route is the best place to record them because it already verifies the reviewer session and knows the exact returned hunk window.

Store key:

```text
reviews/<jobId>/draft/read-receipts/<receiptId>
```

Receipt shape:

```ts
type PrWalkthroughReadReceipt = {
  schemaVersion: 1;
  id: string;
  jobId: string;
  sessionId: string;
  readAt: number;
  format: "compact" | "legacy" | "json";
  mode: "manifest" | "files" | "file" | "summary";
  path?: string;
  fileIndex?: number;
  hunkOffset?: number;
  hunkLimit?: number;
  hunkIds: string[];
  returnedBytes?: number;
  readWindow?: unknown;
  truncated: boolean;
};
```

Receipt semantics:

- `manifest` receipts prove planning metadata was read, not code body review.
- `file` receipts prove the returned hunk slice was available to the reviewer. They should include only selected hunk IDs, not entire files unless the selected hunk window did include every hunk.
- Windowed/truncated reads still count as receipts, but coverage should record `truncated=true` so final status can show that a hunk was read under clipping.
- Re-reading a hunk creates another receipt or updates a per-hunk latest receipt summary; finalization only needs hunk-to-receipt coverage and counts.
- `read_pr_walkthrough_submission_status` should include bounded read-receipt summaries: total receipts, hunk IDs read, unread reviewable hunks, and truncated-read counts.

### Coverage states

Finalization computes coverage from the bundle manifest, read receipts, YAML hunk references, and deterministic completion sweep.

```ts
type HunkCoverageState =
  | "primary-reviewed"
  | "secondary-referenced"
  | "skipped"
  | "completion-sweep-remaining"
  | "unread";

type HunkCoverageRecord = {
  hunkId: string;
  filePath: string;
  hunkHeader: string;
  state: HunkCoverageState;
  primaryCardId?: string;
  secondaryCardIds: string[];
  skippedReason?: string;
  readReceiptIds: string[];
  generated: boolean;
  binary: boolean;
  truncated: boolean;
};
```

Coverage rules:

1. A reviewable hunk with exactly one primary placement and at least one file-slice read receipt is `primary-reviewed`.
2. A hunk with a secondary placement and an earlier primary placement is `secondary-referenced`; it is collapsed by default and points to the primary card.
3. A hunk with `placement: skip` is `skipped` and must expose its reason. Generated/binary/low-signal skips are visible in audit metadata.
4. A hunk with no explicit primary/secondary/skip placement is assigned to the completion sweep as `completion-sweep-remaining`.
5. A hunk referenced as primary but with no body read receipt is counted as `unread`. It can still render in the completion/audit summary, but status must make it visible.
6. Duplicate primary ownership is a hard validation error. Publication stops before writing `reviews/<jobId>/final/payload`.

The final audit card should be derived from coverage, not model-authored boilerplate. It is for remaining plumbing/shrapnel/generated/low-signal/completeness, not major behavior. If a non-generated, non-binary, non-truncated hunk remains in the completion sweep and is large enough to be behaviorally meaningful, the finalizer should flag it in `coverage.major_remaining` so the reviewer can split it into a real logical card.

## Validation and finalization semantics

### Validation stages

1. **Schema validation** (`validatePrWalkthroughYaml`): type checks, enum checks, stable ids, nav labels, launch identity, display references, and additive hunk-ref fields.
2. **Diff resolution validation** (`mapYamlToWalkthroughPayload` or a new shared helper): resolve every hunk ref to a stable hunk id using `hunk_id` first, then file/header/coordinate fallback.
3. **Placement validation**: compute hunk ownership and coverage. This is where duplicate primary ownership fails.
4. **Payload derivation**: derive orientation, boilerplate stats, default display ordering, hunk-sliced diff blocks, coverage summary, completion sweep, and repeated-reference metadata.
5. **Atomic write**: write only the final payload key after all validation passes.

### Structured duplicate-primary error

When more than one card claims the same hunk as primary, return a retryable structured error. Suggested code: `PRW_DUPLICATE_PRIMARY_HUNK`.

```json
{
  "ok": false,
  "code": "PRW_DUPLICATE_PRIMARY_HUNK",
  "error": "One or more hunks have multiple primary placements.",
  "retryable": true,
  "details": {
    "conflicts": [
      {
        "hunkId": "block:1:src__auth__session.ts:h0",
        "file": "src/auth/session.ts",
        "hunkHeader": "@@ -12,7 +12,12 @@ createSession",
        "primaryCards": [
          { "cardId": "significant-auth-flow", "title": "Auth flow" },
          { "cardId": "significant-session-expiry", "title": "Session expiry" }
        ]
      }
    ],
    "suggestedFix": "Keep one primary placement and mark later mentions placement: secondary."
  }
}
```

This error should be emitted by both durable finalization and compatibility `submit_pr_walkthrough_yaml` paths because both flow through the same synthesis/validation helper.

### Other structured errors/warnings

- `PRW_HUNK_REF_UNRESOLVED`: hunk id/header cannot be mapped. Retryable; names the path and card/chunk id.
- `PRW_SECONDARY_WITHOUT_PRIMARY`: a secondary reference has no primary owner. Retryable; suggest making it primary or adding the primary card.
- `PRW_SKIP_REASON_REQUIRED`: `placement: skip` has no reason.
- `PRW_COVERAGE_INCOMPLETE`: optional warning/error if policy decides non-generated reviewable hunks cannot remain unread or only completion-sweeped.
- Existing `PRW_SCHEMA_INVALID`, `PRW_FINALIZE_INCOMPLETE`, `PRW_CHUNK_CONFLICT`, and quota errors remain unchanged.

## Rendering semantics

### Interleaved card body

The panel should prefer `card.narrative` when present:

1. Render short setup text (`type: text`) as 1-3 sentence sections.
2. Render `type: diff` blocks inline at that point in the narrative.
3. Render `type: suggested_comment` immediately after the relevant diff block or line when anchored.
4. Fall back to current summary/rationale/checklist + flat `diffBlocks` rendering for old cards.

A typical card should look like:

```text
Auth flow
Short setup explaining the reviewer goal.

[diff: src/auth/session.ts h0 expanded]
Note: expiry is now checked before persistence.
Suggested inline comment (question): Should this reject clock-skewed tokens?

[diff: src/auth/session.ts h2 expanded]
Note: refresh path shares the new validation.
```

### Primary and secondary hunks

Panel rules:

- Primary placements render expanded by default.
- Secondary placements render collapsed by default, even if the same diff block would otherwise be open.
- The collapsed header must say where the hunk was first shown, for example: `Also shown in Card 2: Auth flow`.
- The user can expand secondary references on demand; expansion state remains local/persisted like current collapsed diff state.
- Secondary references should not count as additional review progress or duplicate coverage.
- Suggested comments attached to secondary hunks should still appear close to the collapsed block, but summary-level suggestions should not pretend to be inline if the anchor is not present.

Implementation detail: current `collapsedDiffBlocks` keys should include placement identity, not only card/block. A stable key such as `${card.id}::${hunkId}::${placement}` avoids collisions when a file block is split into multiple hunk slices.

### Completion sweep card

The final card should be derived and explicit:

- It lists completion-sweep remaining hunks by file/category.
- It surfaces generated/binary/low-signal skips with reasons.
- It shows coverage counts: primary reviewed, secondary repeated, skipped, unread, remaining.
- It can render remaining low-volume hunks, but major behavior should be promoted to logical cards when detected by coverage validation.
- It should not be the place where a primary functional change first appears silently.

## Token-efficiency changes

1. **Manifest-first planning**: compact manifest includes hunk IDs, categories, generated/truncated flags, counts, and hunk offsets. The reviewer can plan logical cards without reading broad diff bodies.
2. **Per-card hunk packets**: add either a `mode=hunks hunkIds=[...]` read or keep `mode=file` but make compact output show hunk IDs and offsets. The reviewer reads only hunks needed for the current card.
3. **Read receipts**: persisted receipts prevent compaction/resume from causing broad rereads. Status tells the reviewer which hunk bodies were already read.
4. **No YAML diff bodies**: reviewer chunks reference hunk IDs/headers and findings only. Finalizer pulls raw diff bodies from the bundle/store.
5. **Derived boilerplate**: finalizer derives PR metadata overlay, diff stats, default display order, coverage summary, repeated-reference hints, and completion sweep. The prompt should stop asking the model to regenerate those sections verbosely.
6. **Slimmer prompt/tool schema**: move the full canonical YAML example out of the static role prompt into concise chunk contracts and targeted validation errors. Keep only the fields the reviewer must author.
7. **No repeated envelope bloat**: keep compact follow-up reads envelope-light. Add hunk IDs to compact file output so reviewers can quote stable IDs without legacy JSON.
8. **No duplicate full diffs**: the final payload should not expand the same hunk in multiple cards. Secondary references are collapsed and can use the primary block body when possible.

## Compatibility constraints

- Existing finalized payloads with `cards[].diffBlocks` and no hunk placement metadata must still render.
- Omitted `format` on `read_pr_walkthrough_bundle` remains legacy JSON.
- Existing `submit_pr_walkthrough_yaml` remains as a wrapper, but it must share placement validation and duplicate-primary rejection.
- `review_chunks[].files` remains required for navigation/metadata, but no longer auto-expands file diffs.
- The finalizer may include compatibility `diffBlocks`, but they should be hunk-sliced and annotated with placement metadata.
- Pack source and built output must stay in sync: `market-packs/pr-walkthrough/src/panel.js` and `market-packs/pr-walkthrough/lib/panel.js` both need the rendering changes.
- The pack continues to import the bundled shared synthesis module; any shared changes must be reflected in pack build output.
- Scoped quota behavior remains: draft chunks/read receipts under `review-draft`, final payload under `review-final`.

## Suggested implementation partition

### Shared synthesis and types

Files:

- `src/shared/pr-walkthrough/types.ts`
- `src/shared/pr-walkthrough/yaml-to-cards.ts`
- bundled `market-packs/pr-walkthrough/lib/yaml-to-cards.mjs`

Work:

- Add hunk placement/read/coverage types.
- Extend YAML schema with additive hunk-ref fields.
- Replace block-level `mapRelevantHunks()` with hunk-level resolution.
- Stop using `review_chunks[].files` to call `mapper.blocksForFiles()`.
- Add placement validation and duplicate-primary structured errors.
- Derive hunk-sliced `diffBlocks`, narrative blocks, repeated-reference metadata, and completion sweep.

### Bundle identity, compact reads, and read receipts

Files:

- `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts`
- `src/server/pr-walkthrough/routes.ts`
- `market-packs/pr-walkthrough/tools/pr-walkthrough/extension.ts`
- `market-packs/pr-walkthrough/tools/pr-walkthrough/read_pr_walkthrough_bundle.yaml`

Work:

- Enrich manifest output with hunk IDs, hunk indexes, coordinates, flags, and changed-line counts.
- Ensure compact file output prints hunk IDs and offsets beside headers.
- Add read receipt writes after successful bundle reads.
- Add receipt summaries to internal bundle/status output without returning unbounded history.
- Consider `mode=hunks` by hunk IDs to avoid file-level hunk offset calculations in reviewer prompts.

### Durable routes and finalization status

Files:

- `market-packs/pr-walkthrough/lib/routes.mjs`
- `market-packs/pr-walkthrough/tools/pr-walkthrough/submission_status.yaml`
- `market-packs/pr-walkthrough/tools/pr-walkthrough/finalize_submission.yaml`

Work:

- Read placement validation output from shared synthesis.
- Return structured duplicate-primary and coverage errors.
- Include coverage/read-receipt summaries in `read_pr_walkthrough_submission_status`.
- Ensure finalization writes only after all placement validation passes.
- Preserve >12 logical cards; do not slice card arrays for publication.

### Reviewer prompt and tool docs

Files:

- `market-packs/pr-walkthrough/roles/pr-reviewer.yaml`
- `market-packs/pr-walkthrough/tools/pr-walkthrough/*.yaml`
- `docs/pr-walkthrough-durable-reviews.md`

Work:

- Replace the large static schema block with concise chunk contracts and examples using `hunk_id` and `placement`.
- Instruct reviewers: manifest first, then per-card hunk reads, save chunks, check status before resume, mark repeated hunks secondary, classify skips explicitly.
- Document read receipts, coverage status, and completion sweep semantics.

### Panel rendering

Files:

- `market-packs/pr-walkthrough/src/panel.js`
- `market-packs/pr-walkthrough/lib/panel.js`

Work:

- Prefer `card.narrative` when present.
- Render text/diff/comment blocks interleaved.
- Collapse secondary hunk references by default and show `Also shown in Card N: Title`.
- Render coverage summary on the audit/completion card.
- Keep old flat-card rendering path for legacy payloads.
- Persist expanded/collapsed state by card + hunk placement key.

## Focused test plan

| Acceptance criterion | Primary tests to add/update |
|---|---|
| Same-file multi-card PRs render intended hunks without file-wide duplication | `tests/pr-walkthrough-yaml-schema.test.ts`: two chunks with same file but different `hunk_id`s produce two cards with only their selected hunks. `tests/pr-walkthrough-panel-parity.spec.ts` or new browser fixture: same file appears on multiple cards with distinct visible hunks. |
| Repeated hunk appears collapsed with previous-card hint | Shared synthesis test for primary + secondary placement metadata. Browser fixture asserting secondary diff has `data-expanded="false"`, hint text `Also shown in Card 2: ...`, and can expand. |
| Duplicate primary ownership rejected before publication | `tests/pr-walkthrough-yaml-schema.test.ts` for shared validation error. `tests/pr-walkthrough-durable-routes.test.ts` for `finalizeSubmission` returning `PRW_DUPLICATE_PRIMARY_HUNK` and not writing `reviews/<jobId>/final/payload`. |
| More than 12 logical cards render | Durable route test with 13+ `chunk:*` records finalizing to all cards. Browser fixture asserts exact logical card count in the rail and navigation. |
| Token spend reduced by avoiding broad rereads/repeated diff bodies | `tests/pr-walkthrough-compact-bundle-format.test.ts`: compact manifest includes hunk IDs and file follow-up suppresses envelope. New read-receipt test: status after reads lists hunk IDs and avoids requiring reread after resume. Synthesis test asserts YAML/final chunks contain hunk refs, not diff bodies. |
| Final card focuses on completeness/plumbing/shrapnel | Shared synthesis test: unassigned hunks go to derived completion sweep; major explicitly primary hunks are not first shown only in audit. Durable route test checks coverage summary and generated/binary skips. |
| Status exposes saved chunks, read receipts, coverage, skipped, repeated, remaining | `tests/pr-walkthrough-durable-routes.test.ts`: `submissionStatus` includes bounded `readReceipts` and `coverage` summaries. Panel draft-state test asserts draft/missing state renders saved chunks and coverage hints without huge lists. |
| `review_chunks[].files` is metadata only | Shared synthesis test with `files: [src/a.ts]` and empty `relevant_hunks` produces no card diff blocks; remaining hunks appear in completion sweep. |
| Read receipt coverage distinguishes reviewed vs referenced | Bundle route/store test: file hunk read creates receipt for selected hunk only. Finalization test: primary hunk without receipt is counted unread, secondary hunk points to primary, skip with reason is skipped. |
| Large PR safety bounds outputs, not card count | Compact bundle read-window tests continue to pass. Add finalization test with many hunk refs/cards and no arbitrary `slice(0, N)` publication. |

Existing tests that should remain green and be extended rather than replaced:

- `tests/pr-walkthrough-yaml-schema.test.ts`
- `tests/pr-walkthrough-durable-routes.test.ts`
- `tests/pr-walkthrough-compact-bundle-format.test.ts`
- `tests/pr-walkthrough-bundle-store-read-window.test.ts`
- `tests/pr-walkthrough-panel-parity.spec.ts`
- `tests/e2e/ui/pr-walkthrough-pack.spec.ts`
- `tests/pr-walkthrough-role-tools-policy.test.ts`
- `tests/pr-walkthrough-tool-metadata.test.ts`

## Open decisions

1. Should unread primary reviewable hunks block finalization, or should they publish with a prominent `unread` coverage warning? The safer default is to block only duplicate-primary/unknown-reference errors and publish unread counts, then tighten later if reviewers still overclaim coverage.
2. Should `mode=hunks` be added now, or is `mode=file path + hunkOffset/hunkLimit` sufficient once manifests expose hunk IDs and offsets? `mode=hunks` is cleaner for reviewer prompts but touches the internal route/tool schema.
3. Should final payloads store only `diffRefs` plus a bundle pointer, or keep hunk-sliced `diffBlocks` for reload independence? The compatibility-first path keeps hunk-sliced `diffBlocks` while avoiding duplicate expanded hunks.
