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

Compact output is lossless for the diff content the legacy bundle returned: file identity/status, hunk headers, context lines, additions, deletions, and truncation indicators are preserved. It omits redundant per-line addressing fields such as line object ids, `old_line`, and `new_line`. Request `format="legacy"` only when exact legacy anchors or per-line metadata are required.

The compact manifest remains the authoritative envelope read: target metadata, SHAs, stats, warnings, limits, export metadata, and file summaries appear there. Compact follow-up reads (`summary`, `files`, and `file`) include only a short bundle reference plus the requested file or hunk data, so repeated target/changeset/limits blocks do not re-enter the model context.

### Chunk saves and status

`submit_pr_walkthrough_chunk` still persists one idempotent section record, but successful tool output is intentionally small:

```json
{ "saved": true, "section_id": "context", "nextRequired": "merge_assessment", "missing": ["audit"] }
```

The save result is a progress hint, not the complete draft state. Call `read_pr_walkthrough_submission_status` after compaction, retry, restart, or before finalization to read the full saved chunk list, missing required sections, validation issues, and finalization status. This prevents chunk saves from growing with every prior section while keeping durable status available on demand.

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
| Draft chunks, status, checkpoints | `reviews/<jobId>/draft/` | `review-draft` |
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

Finalization is commit-record atomic:

1. Validate the YAML.
2. Build the final record, including canonical YAML, job/change metadata, synthesized changeset/cards, warnings, `persistedAt`, `finalizedAt`, and `cardCount`.
3. Write `reviews/<jobId>/final/payload` last with `FINAL_QUOTA(jobId)`, where the
   quota scope prefix is `reviews/<jobId>/final/` and the profile is `review-final`.
4. Best-effort delete `reviews/<jobId>/staging/` and `reviews/<jobId>/draft/`.

Readers treat only `reviews/<jobId>/final/payload` as submitted/finalized. Staging and draft data are invisible to `bundle`, `status`, and `recover` until that commit record exists.

## Compatibility paths

`submit_pr_walkthrough_yaml(yaml)` remains available for older reviewer prompts. It is a wrapper around the durable path:

1. Resolve the reviewer binding.
2. Reject with `PRW_CHUNK_CONFLICT` if section chunks already exist.
3. Save the full YAML as the `document` chunk.
4. Finalize through the same path as `finalize_pr_walkthrough_submission()`.

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
- `tests/pr-walkthrough-durable-routes.test.ts` — review-scoped run writes, chunk idempotency, finalization, trusted metadata overlay, authorization, compatibility conflicts, audit checklist minimum.
- `tests/pr-walkthrough-lifecycle-provider.test.ts` — provider registration, `beforePrompt` durable progress blocks, `beforeCompact` checkpointing, shutdown cleanup.
- `tests/pr-walkthrough-role-tools-policy.test.ts` and `tests/pr-walkthrough-tool-metadata.test.ts` — reviewer prompt/tool metadata for the durable chunk flow.
- `tests/pr-walkthrough-compact-bundle-format.test.ts` — compact bundle formatting, preserved legacy/default output, envelope suppression, compact chunk-save output, and full status readback.
- `tests/pr-walkthrough-panel-parity.spec.ts` and `tests/e2e/ui/pr-walkthrough-pack.spec.ts` — panel draft/missing/quota error states and pack launch/render behavior.
