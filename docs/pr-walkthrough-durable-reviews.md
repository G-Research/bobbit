# PR Walkthrough durable reviews

PR Walkthrough runs as a built-in first-party Extension Host pack. A launch creates a read-only reviewer child session, the reviewer saves analysis through pack tools, and the pack panel renders the finalized review cards beside that child session.

Durable reviews make that flow resilient to compaction, page reloads, reviewer restarts, and old pack-store data. The key change is that review analysis is no longer one large YAML blob written at the end into a global pack namespace. Reviewers save stable chunks as they work, and finalization assembles those chunks into the canonical walkthrough payload under a review-scoped namespace.

See also:

- [PR Walkthrough Panel](pr-walkthrough-panel.md) for launch and panel behavior.
- [Extension Host authoring](extension-host-authoring.md#stores--implicit-pack-scoped-persistence-hoststore) for pack-store APIs and quota scopes.
- [Lifecycle Hub](lifecycle-hub.md) for provider hook dispatch.

## Moving parts

| Area | Main implementation |
|---|---|
| Pack routes and store keys | `market-packs/pr-walkthrough/lib/routes.mjs` |
| Durable progress provider | `market-packs/pr-walkthrough/lib/provider.mjs` and `providers/pr-walkthrough-durable.yaml` |
| Reviewer tools | `market-packs/pr-walkthrough/tools/pr-walkthrough/` |
| Reviewer role prompt | `market-packs/pr-walkthrough/roles/pr-reviewer.yaml` |
| Pack store API | `src/server/extension-host/pack-store.ts`, server/client Host API adapters |
| Panel error states | `market-packs/pr-walkthrough/src/panel.js` and built `lib/panel.js` |

## Reviewer tool output contract

Reviewer tools are model-facing wrappers over the pack routes and internal bundle route. They keep the server and pack-store payloads authoritative, but shape tool text so the reviewer spends context on code and findings instead of repeated envelopes.

### Bundle reads: legacy by default, compact by opt-in

`read_pr_walkthrough_bundle` accepts `format` in addition to the existing bounded read parameters:

- Omitted `format` preserves the legacy JSON result exactly. This is the compatibility path for existing callers.
- `format="legacy"` is an explicit spelling of the same legacy output.
- `format="compact"` returns a unified-diff-like text view generated inside the extension after it reads the existing internal bundle JSON. The compact formatter does not change the internal route, store schema, or source-of-truth payload.

Use compact mode for normal review work:

```text
read_pr_walkthrough_bundle mode=manifest format=compact limit=50
read_pr_walkthrough_bundle mode=file path=src/example.ts format=compact hunkOffset=0 hunkLimit=20
```

For non-windowed content, compact output preserves the diff information reviewers need: file identity/status, hunk headers, context lines, additions, deletions, and truncation indicators. It omits redundant per-line addressing fields such as line object ids, `old_line`, and `new_line`. Request `format="legacy"` only when exact legacy anchors or per-line metadata are required.

The compact manifest remains the authoritative envelope read: target metadata, SHAs, stats, warnings, limits, export metadata, file summaries, and hunk planning metadata appear there. V2 reviewers use manifest hunk ids, file categories, generated/truncated flags, hunk counts, and offsets to plan logical cards before reading code bodies. Compact follow-up reads (`summary`, `files`, and `file`) include only a short bundle reference plus the requested file or hunk data, so repeated target/changeset/limits blocks do not re-enter the model context.

### Compact file read bounds

`mode=file format=compact` is bounded in two layers so a reviewer cannot accidentally paste a generated bundle into its context window:

1. **Server-side bundle read windowing.** The bundle store first applies the requested `hunkOffset`/`hunkLimit`, then windows the selected hunk bodies by bytes and lines before returning JSON to the tool. Long hunk headers and diff lines are clipped with inline markers; very large hunks stop after the read window is exhausted.
2. **Compact formatter hard cap.** The extension formatter renders that windowed JSON to unified-diff-like text and enforces a final **64KiB** hard cap before returning model-facing text. It also caps individual compact diff lines and hunk line counts as defense in depth.

Windowing is explicit in the response:

- `truncated=true` means either the hunk page was partial or the read window changed the returned file body.
- `hunk_truncated=true` is only hunk pagination (`hunkOffset`/`hunkLimit`), so callers can distinguish pagination from byte/line clipping.
- `read_window` reports whether windowing applied, the configured budgets, returned/omitted line and byte counts, reasons such as `line-bytes`, `line-window`, or `content-bytes`, and guidance for a narrower follow-up read.
- Windowed files, hunks, and long lines carry `is_truncated` / `truncated` markers plus inline text such as `bundle-store read window` or `bytes omitted`.
- Manifest and file-list summaries surface the same state: `is_truncated` becomes true when either source truncation or read-window truncation applies, while `source_is_truncated` preserves whether the original parsed diff was already truncated.

If a file needs more inspection, request a more specific slice instead of rereading a broad range:

```text
read_pr_walkthrough_bundle mode=file path=market-packs/terminal/lib/terminal-panel.js format=compact hunkOffset=0 hunkLimit=1
```

Use `format="legacy"` only for exact line ids or `old_line` / `new_line` fields; it is not the normal review path.

### Generated and minified artifacts

PR Walkthrough marks generated or low-signal files before they reach reviewer prompts. The generated-path classifier includes:

- built marketplace pack output such as `market-packs/<pack>/lib/**`, including `market-packs/terminal/lib/terminal-panel.js`;
- minified filenames containing `.min.` across extensions;
- lockfiles such as npm, pnpm, Yarn, Bun, Cargo, Composer, Gem, Poetry, and similar ecosystem locks;
- common build/output/generated directories such as `dist`, `build`, `coverage`, `.next`, `generated`, `__generated__`, and snapshots;
- source names that conventionally indicate generated code, such as protobuf, grpc, designer, generated, or source-map files.

Generated files get `is_generated=true` in manifest/file summaries and a warning that they may be low-signal for review. Path classification is separate from read-window truncation: a normal source file can be `is_truncated=true` because it is too large to return safely, and a generated file can also be windowed if it contains long minified lines.

### Reviewer guidance for low-signal files

Reviewer agents should spend context on source changes that can affect behavior:

- Start with `read_pr_walkthrough_bundle mode=manifest format=compact` and use manifest `generated` / `truncated` flags to plan coverage.
- Avoid generated, minified, lockfile, build, and bundle artifacts unless they are necessary to prove a user-facing change.
- Prefer listing those files in the audit `generated_or_binary_files` section over reading their contents.
- If inspection is necessary, use a path-specific compact read with a very small hunk window, usually `hunkLimit=1`, and stop once there is enough evidence.
- Do not repeatedly reread large generated/truncated output. Treat `read_window` guidance and inline truncation markers as instructions to narrow the slice, not as a reason to request a broader one.

### Logical review chunks and V2 narrative

Durable chunks now describe the review as logical cards instead of file dumps. A `chunk:<id>` record is one functional, architectural, risk, or verification theme. The chunk still lists `files` for navigation, but `files` does not render code by itself; rendered diffs come only from explicit hunk references or the derived completion sweep.

A V2 review chunk uses ordered `narrative` entries so the panel can interleave short explanation, diff blocks, notes, and suggested comments:

```yaml
id: auth-flow
phase: significant
title: Auth flow
files: [src/auth/session.ts]
narrative:
  - id: setup
    type: text
    body: Session creation and refresh now share the expiry guard.
  - id: create-session-expiry
    type: diff
    hunks:
      - hunk_id: block:1:src__auth__session.ts:h0
        placement: primary
        why_relevant: Expiry is validated before the session is stored.
  - id: skew-question
    type: suggested_comment
    severity: question
    intent: inline
    anchor: { hunk_id: block:1:src__auth__session.ts:h0, line_range: "+15..+22" }
    body: Should this tolerate bounded clock skew before rejecting the token?
```

Supported narrative entry types are `text`, `diff`, `note`, `suggested_comment`, and `checklist`. Entries must have stable ids unique within the chunk. Narrative entries never embed raw diff bodies; they reference hunk ids/headers and concise commentary, and the finalizer pulls code from the bundle.

A chunk's top-level `relevant_hunks` and its `narrative[].diff` entries share the same hunk universe. If a non-`skip` top-level hunk reference is never placed in a `narrative[].diff` entry, the finalizer appends a deterministic `additional-referenced-hunks` diff entry so narrative-first rendering cannot silently hide a hunk the reviewer explicitly cited. This keeps referenced code visible and counted in coverage even when the author forgets to interleave it.

### Hunk placement and coverage

Every hunk reference can declare `placement`:

- `primary` is the default and means the hunk's main expanded card. A hunk can have only one primary placement.
- `secondary` is a later mention of an already-primary hunk. It renders collapsed by default with a pointer to the primary card and does not change the hunk's primary coverage state.
- `skip` marks a generated, binary, mechanical, unread, superseded, or otherwise low-signal hunk as intentionally not rendered. It requires `skip_reason`.

Prefer manifest `hunk_id` values. Legacy `file` + `hunk_header` references remain compatibility fallbacks only when they resolve to exactly one hunk after any supplied index or coordinates are considered. Ambiguous references fail closed so reviewers do not accidentally assign ownership to the wrong hunk.

A `placement: skip` reference may name just a `file` with no `hunk_header`, index, or coordinates. This is the only way to reference a hunkless changed block (see below) that exposes no header to anchor on. The resolver stays strict for that shortcut: a file-only reference that matches more than one hunk still fails closed with `PRW_HUNK_REF_UNRESOLVED`, so it can only skip a file whose change is a single (or synthetic block-level) hunk.

Finalization derives coverage from the manifest, read receipts, and normalized hunk placements. Each changed hunk is classified as primary-reviewed, secondary-referenced, skipped with reason, unread, or completion-sweep remaining. Repeated secondary references are tracked separately from primary coverage so the same hunk can be reviewed once and cited later without duplicating full diffs.

### Hunkless and binary blocks

Some changed files produce no textual hunks: binary files, pure mode or rename changes, and empty diffs. These still represent a change the reviewer is accountable for, so finalization indexes a **synthetic block-level hunk** for every hunkless changed block. Without it, the diff-reference mapper — which builds its hunk index from a block's textual hunks — would drop these files from the coverage universe entirely, so a binary change could vanish from finalization coverage and the completion-sweep audit card.

The synthetic hunk carries the block's own flags (binary, generated, truncated) and a descriptive header (`Binary file (no textual diff)` or `File change (no textual hunks)`) with zero changed lines. Because it has `changed_lines: 0` and inherits the binary/generated flags, it is never a completion-sweep `major_remaining` candidate. It is therefore classified as:

- `completion-sweep-remaining` by default — it appears on the derived audit/completion card as a low-signal remaining item; or
- `skipped` with a reason when a reviewer names it with a file-only `placement: skip` — it then shows in the audit skip list (for example `assets/logo.png (binary)`) with its `skip_reason`.

Either way the changed file stays visible in coverage and audit metadata rather than disappearing.

Read receipts are written for successful bundle reads. Manifest receipts prove planning context was read; file/hunk receipts prove code bodies were returned to the reviewer. Windowed or truncated receipts remain visible in status so reviewers can decide whether a narrower read is needed.

The completion sweep is deterministic and derived. Non-major remaining hunks can appear on the final audit card as plumbing/shrapnel/completeness. The first-pass major-remaining policy blocks unassigned reviewable hunks with `changed_lines >= 8` unless they are generated, binary, source-truncated, explicitly skipped, or in low-risk categories such as tests, docs, lockfiles, assets, vendor, or generated output. Major remaining hunks that would first appear in the sweep block finalization with `PRW_MAJOR_REMAINING_HUNKS`; the reviewer must promote them to a logical card or explicitly skip them with a reason.

### Chunk saves and status

`submit_pr_walkthrough_chunk` still persists one idempotent section record, but successful tool output is intentionally small:

```json
{ "saved": true, "section_id": "context", "nextRequired": "merge_assessment", "missing": ["audit"] }
```

The save result is a progress hint, not the complete draft state. Call `read_pr_walkthrough_submission_status` after compaction, retry, restart, compact chunk saves, or before finalization to read the full saved chunk list, missing required sections, validation issues, read-receipt summaries, coverage counts, repeated references, skipped/remaining hunks, and finalization status. This prevents chunk saves from growing with every prior section while keeping durable status available on demand.

### Read-only shell guidance

The persisted bundle is the authoritative source for the launched PR metadata and diff. `readonly_bash` exists only for narrow follow-up checks the bundle cannot answer, such as a targeted `git show` or a scoped search in a known file area.

Do not use `readonly_bash` for broad repository exploration. Its policy intentionally rejects many expensive or unsafe shell patterns: multi-line commands, heredocs, pipes/chaining, command substitution, mutating commands, tests/builds/installs/servers, recursive searches from the repo root, hidden/ignore bypass flags, cross-PR or cross-repo GitHub reads, and reads of secrets or dot-directories. Treat a policy rejection as a boundary and return to the bundle/status tools instead of probing variants.

## Review-scoped store layout

New PR Walkthrough writes are rooted by `jobId`:

| Key | Purpose | Lifetime |
|---|---|---|
| `reviewers/<childSessionId>` | Small O(1) reviewer-session index used by tools and lifecycle hooks to find the job. | Removed on reviewer shutdown/archive. |
| `reviews/<jobId>/binding/<childSessionId>` | Binding for the reviewer child: job, target, parent, changeset, base/head SHAs. | Removed with the review prefix. |
| `reviews/<jobId>/draft/chunks/<sectionId>` | Idempotent durable chunk records written as analysis completes. | Removed after successful finalization or shutdown. |
| `reviews/<jobId>/draft/read-receipts/<receiptId>` | Bounded records of manifest/file/hunk reads used to avoid broad rereads and compute coverage. | Removed with draft cleanup. |
| `reviews/<jobId>/draft/status` | Bounded chunk summary/readback cache. | Removed with draft cleanup. |
| `reviews/<jobId>/draft/checkpoint` | Bounded `beforeCompact` safety checkpoint. | Removed with draft cleanup. |
| `reviews/<jobId>/staging/...` | Optional finalization staging space. Readers ignore it. | Best-effort deleted after final commit; otherwise shutdown cleanup removes it. |
| `reviews/<jobId>/final/payload` | Commit record and source of truth for rendered cards. Written last. | Kept while the reviewer session exists; removed on shutdown/archive. |

Legacy keys still have read/cleanup fallbacks for migration:

- `binding/<childSessionId>`
- `submitted/<jobId>`
- `job/<jobId>`
- `cards/<base64url(changesetId)>`

New normal launches write `reviewers/<childSessionId>` and `reviews/<jobId>/binding/<childSessionId>` instead of the legacy binding. Legacy publish paths may still write old aliases when there is no authorized review-scoped binding; they cannot overwrite an existing review-scoped final payload.

## Pack-store delete and quota behavior

The pack store now exposes:

```ts
host.store.get(key)
host.store.put(key, value, { quotaScope })
host.store.list(prefix)
host.store.delete(key)
host.store.deletePrefix(prefix)
host.store.stats(prefix)
```

`delete` and `deletePrefix` unlink encoded `.json` key files. They do not write tombstones, so bytes and key count are actually freed. The server derives the caller's `packId`; packs never pass a pack id and cannot delete another pack's keys.

Scoped quota writes keep old reviews from blocking new ones:

- Unscoped writes still count against the legacy per-pack total.
- Scoped writes count against a server-owned profile for the requested prefix.
- The written key must start with `quotaScope.prefix`; invalid scopes fail before writing.
- Unknown profiles fail with `STORE_QUOTA_PROFILE_INVALID`.
- Per-value and global key-count limits still apply.
- An emergency per-pack byte ceiling still applies to all scoped writes, so a pack cannot shard prefixes indefinitely.

The broad legacy per-pack quota is unchanged. A scoped write bypasses only that legacy
cumulative cap; it still goes through `PackStore.put` validation, prefix/profile checks,
per-value/key limits, and the emergency per-pack ceiling. A later generic unscoped write
can still fail with `STORE_QUOTA_EXCEEDED` if the total pack directory is over the legacy
cap; PR Walkthrough avoids that for first-party durable review state by supplying scoped
quota options on those writes.

PR Walkthrough uses these scoped profiles:

| Data | Key or prefix | Profile |
|---|---|---|
| Draft chunks, read receipts, status, checkpoints | `reviews/<jobId>/draft/` | `review-draft` |
| Final payload | `reviews/<jobId>/final/` via `FINAL_QUOTA(jobId)` | `review-final` |
| Reviewer index | exact `reviewers/<childSessionId>` key | `default` |
| Review-scoped binding | `reviews/<jobId>/` via `REVIEW_BINDING_QUOTA(jobId)` | `default` |
| Panel interaction state | exact `review-state/<panel>/<job>` key | `default` |
| Finalize legacy binding marker | exact `binding/<childSessionId>` key | `default` |
| Legacy publish artifacts | exact `cards/<base64url(changesetId)>` and `job/<jobId>` keys | `default` |

Exact-key default scopes are for small first-party metadata that should remain writable
after draft and final review payloads push total pack bytes over the legacy unscoped cap.
They do not raise the draft/final review limits or remove disk-exhaustion protection.

Draft and final scopes are intentionally separate. A review can finalize while the final payload temporarily duplicates draft data, then draft cleanup frees the draft scope. An oversized single review is still rejected with a structured `STORE_QUOTA_EXCEEDED` error, and existing chunks remain intact because `put` rejects before replacing the previous value. Because finalization runs inside a `ModuleHost` worker, the worker proxy preserves the third `host.store.put` argument so `FINAL_QUOTA(jobId)` reaches the parent pack store.

## Incremental chunk submission

The reviewer role is instructed to save work immediately with `submit_pr_walkthrough_chunk(section_id, yaml)`, check progress with `read_pr_walkthrough_submission_status()`, and finish with `finalize_pr_walkthrough_submission()`.

Valid `section_id` values are:

```text
metadata
context
merge_assessment
omissions_and_followups
audit
display
document
decision:<id>  # id matches [A-Za-z0-9_.-]+
chunk:<id>     # id matches [A-Za-z0-9_.-]+
```

Each chunk is stored as one record under `reviews/<jobId>/draft/chunks/<sectionId>`:

```ts
{
  schemaVersion: 1,
  id: string,
  kind: "metadata" | "context" | "merge_assessment" | "omissions" | "audit" | "display" | "document" | "decision" | "review_chunk",
  yaml: string,
  updatedAt: number,
  bytes: number,
}
```

Chunk writes are idempotent. Re-sending the same `section_id` overwrites that one key and status lists it once. This makes retries and post-compaction resumes safe.

Chunk validation is intentionally light:

- `document` must be a full valid PR Walkthrough YAML document.
- `omissions_and_followups` must parse as a YAML array.
- `metadata`, `context`, `merge_assessment`, `audit`, and `display` must parse as YAML mappings.
- `decision:*` and `chunk:*` must parse as YAML mappings.

Full schema validation remains part of finalization.

Section chunks should stay concise:

- `metadata`, `context`, `merge_assessment`, and `audit` provide orientation and assessment inputs; the finalizer derives trusted PR identity, display defaults, stats overlays, coverage summaries, and completion-sweep boilerplate.
- `decision:<id>` records one design decision and can reference hunks with the same `hunk_id`/placement fields used by review chunks.
- `chunk:<id>` records one logical card. Use ordered `narrative` entries for interleaved text, diff, note, suggested comment, and checklist content. Do not create one chunk per file unless that file is the logical change.
- `omissions_and_followups` covers expected artifacts that were checked and still need attention. It is separate from hunk skips; skipped hunks remain visible through placement/coverage metadata.
- `display` is optional. Prefer deterministic defaults unless the authored order needs to differ from the finalizer's derived order.

## Finalization flow

`finalize_pr_walkthrough_submission()` resolves the caller's reviewer binding, reads chunks from `reviews/<jobId>/draft/chunks/`, validates the assembled document, synthesizes cards, and commits the final payload.

There are two source modes:

1. **Document mode** — a `document` chunk is the complete canonical YAML. It cannot be mixed with any other chunk; mixed chunks fail with `PRW_CHUNK_CONFLICT`.
2. **Section mode** — named chunks are assembled into the canonical YAML document:
   - `schema_version: 1`
   - `pr` from `metadata`, with trusted binding fields taking precedence for provider, owner, repo, PR number, URL, base SHA, and head SHA
   - `walkthrough.context` from `context`
   - `walkthrough.merge_assessment` from `merge_assessment`
   - `walkthrough.design_decisions` from sorted `decision:*` chunks
   - `walkthrough.review_chunks` from sorted `chunk:*` chunks
   - `walkthrough.omissions_and_followups` from the optional chunk or `[]`
   - `walkthrough.audit` from `audit`
   - `walkthrough.display` from the optional chunk or deterministic defaults

Minimum section-mode input is `metadata`, `context`, `merge_assessment`, `audit`, and either at least one `chunk:*` review chunk or an audit `reviewer_checklist`. Missing input fails with `PRW_FINALIZE_INCOMPLETE` and includes the missing sections.

Validation is layered:

1. Schema validation checks section shape, ids, enum values, launch identity, navigation labels, and V2 narrative entry shape.
2. Hunk resolution normalizes each reference to a stable hunk id, preferring `hunk_id` and only using file/header/index/coordinate fallbacks when they resolve to exactly one hunk.
3. Placement validation rejects duplicate primary ownership, secondary references without a primary owner, and skips without a reason.
4. Coverage derivation combines normalized placements with read receipts, repeated references, explicit skips, unread primary references, and completion-sweep remaining hunks.
5. Completion-sweep validation blocks deterministic major remaining hunks before publication.

Finalization is commit-record atomic:

1. Validate YAML, hunk references, placement ownership, coverage, and completion-sweep policy.
2. Build the final record, including canonical YAML, job/change metadata, synthesized changeset/cards, ordered narrative, hunk-sliced diff blocks, warnings, coverage summaries, `persistedAt`, `finalizedAt`, and `cardCount`.
3. Write `reviews/<jobId>/final/payload` last with `FINAL_QUOTA(jobId)`, where the
   quota scope prefix is `reviews/<jobId>/final/` and the profile is `review-final`.
4. Best-effort delete `reviews/<jobId>/staging/` and `reviews/<jobId>/draft/`.

Readers treat only `reviews/<jobId>/final/payload` as submitted/finalized. Staging and draft data are invisible to `bundle`, `status`, and `recover` until that commit record exists.

## Compatibility paths

`submit_pr_walkthrough_yaml(yaml)` remains available for older reviewer prompts. It is a wrapper around the durable path:

1. Resolve the reviewer binding.
2. Reject with `PRW_CHUNK_CONFLICT` if section chunks already exist.
3. Save the full YAML as the `document` chunk.
4. Finalize through the same validation path as `finalize_pr_walkthrough_submission()`, including V2 hunk placement, duplicate-primary rejection, read-receipt-aware coverage, and completion-sweep policy.

The `publish` route is compatibility-only for panel and legacy callers. When called by an authorized review-scoped caller, it writes the same final payload. When called without an authorized scoped binding, it falls back to legacy `cards/<changesetId>` and `job/<jobId>` artifacts so older direct flows continue to work, but it does not overwrite a review-scoped final payload. Those legacy artifact writes use exact-key `default` quota scopes because they are still first-party durable review metadata.

## Route and panel states

The pack panel calls routes through `host.callRoute`, never raw `fetch`.

- `run` spawns a fresh reviewer child, writes `reviewers/<childSessionId>` and `reviews/<jobId>/binding/<childSessionId>`, then prompts the child. If a post-spawn binding write fails, it compensates by deleting written keys and dismissing the spawned reviewer where possible.
- `status` returns `running`, `draft`, `submitted`, or `error`. It reports `submitted` only when a final payload exists, with legacy `submitted/<jobId>` as a migration fallback. If chunks exist but no final payload exists, it returns `draft` with chunk summary.
- `recover` is child-self reload recovery. It reads the caller's binding, returns finalized YAML when present, returns bounded draft state when chunks exist, and returns `PRW_REVIEW_MISSING` when data expired or was cleaned up.
- `bundle` prefers `reviews/<jobId>/final/payload`. If no final payload exists, it can fall back to live diff plus legacy card artifacts where authorized.

The panel persists interaction state such as completed cards, comments, collapsed files, and context expansions under `review-state/<panel>/<job>`. It writes both localStorage and best-effort host-store copies; the host-store copy uses an exact-key `default` quota scope so normal interaction state can persist even when review-scoped payloads have already pushed total pack bytes over the legacy unscoped cap. If host persistence fails, localStorage remains the fallback.

Known route failures return structured data with `code`, `error`, and optional `details`. Client `host.callRoute` preserves JSON error bodies on non-2xx responses, and the panel renders actionable messages for schema, quota, missing/expired, unauthorized, and incomplete-finalization states instead of a bare `callRoute publish HTTP 500`.

Common codes include:

- `PRW_CHUNK_INVALID`
- `PRW_CHUNK_ID_INVALID`
- `PRW_CHUNK_CONFLICT`
- `PRW_FINALIZE_INCOMPLETE`
- `PRW_SCHEMA_INVALID`
- `PRW_DUPLICATE_PRIMARY_HUNK`
- `PRW_HUNK_REF_UNRESOLVED`
- `PRW_SECONDARY_WITHOUT_PRIMARY`
- `PRW_SKIP_REASON_REQUIRED`
- `PRW_MAJOR_REMAINING_HUNKS`
- `PRW_COVERAGE_INCOMPLETE`
- `PRW_MISSING_BINDING`
- `PRW_REVIEW_MISSING`
- `PRW_REVIEW_DRAFT`
- `PRW_REVIEW_UNAUTHORIZED`
- `STORE_QUOTA_EXCEEDED`
- `STORE_QUOTA_PROFILE_INVALID`
- `STORE_QUOTA_SCOPE_INVALID`

## Operational recovery for draft-saved reviewers

After deploying or restarting a gateway that includes the `ModuleHost` proxy fix, a reviewer
that previously saved all chunks but failed final publication can retry from the same reviewer
session if it still exists:

1. Call `read_pr_walkthrough_submission_status()` to confirm saved chunks and missing sections.
2. Call `finalize_pr_walkthrough_submission()` again, or use the panel's submit action if it
   routes through the same reviewer session.

The panel has no finalized UI state until `reviews/<jobId>/final/payload` exists. If the
reviewer was archived or shutdown cleanup already removed the review prefix, start a new
walkthrough.

## Lifecycle provider behavior

`pr-walkthrough-durable` is a schema-2 provider declared in `pack.yaml` and `providers/pr-walkthrough-durable.yaml`. It uses only `ctx.host.store.*`; it does not read raw state directories.

The provider no-ops unless the session is a PR reviewer or `reviewers/<ctx.sessionId>` resolves a job.

### `beforePrompt`

Before reviewer prompts, the provider injects one small `ContextBlock` with authority `tool`:

- job id and changeset id when known;
- whether `reviews/<jobId>/final/payload` exists;
- saved chunk IDs, bounded to avoid prompt bloat;
- read-receipt and coverage summaries when present;
- draft status/checkpoint details if present;
- the next required step;
- a reminder to call `read_pr_walkthrough_submission_status` before resuming.

This is what lets a compacted or restarted reviewer see durable progress without relying on preserved chat context.

### `beforeCompact`

Before compaction, if the review is not finalized, the provider writes a bounded checkpoint to `reviews/<jobId>/draft/checkpoint` using the `review-draft` quota scope. It prefers `ctx.summary` and falls back to a capped `ctx.span`. This is a safety net; normal progress should be saved as chunks.

Finalized reviews do not overwrite checkpoints during compaction.

### `sessionShutdown`

When the reviewer session is archived or terminated, the provider deletes:

- `reviews/<jobId>/` via `deletePrefix`;
- `reviewers/<childSessionId>`;
- tied legacy aliases: `binding/<childSessionId>`, `submitted/<jobId>`, `job/<jobId>`;
- old `cards/<changesetId>` records tied to the binding, final payload, or legacy job pointer.

Unrelated review prefixes and unrelated card keys are left intact. Cleanup aligns product lifetime with the reviewer session: finalized data remains available while the reviewer exists, but archiving/terminating the reviewer frees review-scoped bytes. If a panel is opened after cleanup, it renders the bounded missing/expired state.

## Migration and legacy fallbacks

Durable reviews are forward-only for new normal launches, but readers keep migration fallback behavior:

- Binding resolution tries `reviewers/<sessionId>` and `reviews/<jobId>/binding/<sessionId>`, then legacy `binding/<sessionId>`.
- `status` and `recover` prefer final payloads, then legacy `submitted/<jobId>` when present.
- `bundle` prefers final payloads, then authorized legacy card artifacts.
- Shutdown cleanup removes legacy aliases tied to the same reviewer/job so old data does not keep consuming quota.

These fallbacks exist for already-running or restored reviewers. New code should write review-scoped keys and scoped quota options.

## Test coverage pointers

Durable behavior is pinned by focused unit and browser tests:

- `tests/extension-host-pack-store.test.ts` — real delete/deletePrefix, scoped quotas, PR Walkthrough panel state after scoped review payloads exceed the legacy cap, unscoped-write rejection, invalid quota scopes/profiles, emergency ceiling, overwrite rejection before corruption.
- `tests/extension-host-server-host-api.test.ts` — server host store delegation for scoped `put`, `delete`, `deletePrefix`, and `stats` with server-derived pack ids.
- `tests/extension-host-module-isolation.test.ts` — `ModuleHost` worker proxy forwarding of `host.store.put` quota options to the parent host.
- `tests/client-host-api.spec.ts` — client `host.store` methods and structured `host.callRoute` error preservation.
- `tests/pr-walkthrough-durable-routes.test.ts` — review-scoped run writes, chunk idempotency, finalization, trusted metadata overlay, authorization, compatibility conflicts, audit checklist minimum, coverage/read-receipt status, repeated references, completion-sweep behavior, and large-card-count publication.
- `tests/pr-walkthrough-lifecycle-provider.test.ts` — provider registration, `beforePrompt` durable progress blocks, `beforeCompact` checkpointing, shutdown cleanup.
- `tests/pr-walkthrough-role-tools-policy.test.ts` and `tests/pr-walkthrough-tool-metadata.test.ts` — reviewer prompt/tool metadata for the durable V2 chunk flow, hunk placement contract, status coverage, and exact PRW tool boundary.
- `tests/pr-walkthrough-compact-bundle-format.test.ts` — compact bundle formatting, preserved legacy/default output, envelope suppression, hunk identity in compact reads, compact chunk-save output, read receipts, and full status readback.
- `tests/pr-walkthrough-panel-parity.spec.ts` and `tests/e2e/ui/pr-walkthrough-pack.spec.ts` — panel draft/missing/quota error states and pack launch/render behavior.
