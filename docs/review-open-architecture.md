# Durable review opening

`review_open` uses a session-owned server artifact instead of placing Markdown in
the tool result. This keeps large reviews reopenable after reload or reconnect
without raising the generic WebSocket, transcript, or tool-result limits. The
server-backed side-panel workspace remains the authority for whether the review
pane is open.

This document covers Markdown reviews opened by the `review_open` tool. Human
sign-off review behavior is documented separately in
[Review Pane Sign-Off](review-pane-signoff.md).

## End-to-end model

A new review crosses four boundaries:

1. The Review extension resolves inline and file-backed Markdown, validates the
   complete review, and computes UTF-8 byte counts.
2. It uploads one canonical review to the owning session's authenticated review
   payload route. The server reconciles replacement identity, persists an
   immutable artifact, and attempts the authoritative workspace open.
3. The tool returns a bounded v2 receipt containing identity and file metadata,
   the content hash, and the automatic-open outcome. It never returns Markdown.
4. The client correlates that receipt with the exact tool call. The shared
   coordinator validates the automatic outcome and hydrates content only for an
   existing authoritative workspace tab. Only an explicit renderer click asks
   the server to open or reopen the review before hydration.

The persisted artifact and workspace tab have different jobs. The artifact owns
content bytes; the workspace owns open/closed state, tab order, active panel,
and selected review file. Keeping those responsibilities separate allows a
closed review to stay closed while its originating tool card remains a valid
manual recovery path.

## Bounds and canonical identity

The content limit is exactly **10 MiB** (`10 * 1024 * 1024` bytes), summed over
the UTF-8 Markdown bytes of every file. Exactly 10 MiB succeeds; one additional
byte fails before the call persists a payload or mutates the workspace. Byte
accounting uses UTF-8 bytes rather than JavaScript character count, so multibyte
text consumes its encoded size.

File-backed input is read incrementally from one open descriptor. Reads stop at
the remaining review budget, use fatal UTF-8 decoding, and reject non-files,
invalid UTF-8, and NUL bytes. This prevents a growing or replaced file from
turning a bounded read into an unbounded allocation.

The canonical contract also enforces:

| Field | Bound |
|---|---:|
| Files per review | 64 |
| Review and file title | 320 UTF-8 bytes each |
| Receipt identity metadata | 24 KiB total |
| Tool-call identity | 200 UTF-8 bytes |
| Review identity | 300 UTF-8 bytes |
| File identity | 200 UTF-8 bytes |
| Payload identity | 20–64 URL-safe characters; generated ids are 24 characters |
| Content hash | 64 lowercase hexadecimal SHA-256 characters |

Identities must be non-empty, well-formed Unicode without control characters.
File identities must be unique, and `activeFileId` must name one of the ordered
files. V2 identities are rejected when invalid; they are never truncated,
normalized, inferred from a display title, or combined with legacy identities.
The shared identity contract is used by the extension, payload store, client
coordinator, and workspace canonicalizer so all boundaries address the same
review and files.

The SHA-256 hash covers the canonical owner, tool call, review identity, title,
ordered file identities/titles/Markdown/byte counts, active file, replacement
setting, and total bytes. It is therefore an integrity and addressing value,
not merely a content deduplication hint.

### Replacement semantics

`replace` defaults to `true`. If the owning workspace already has a review with
the same title, the server retains that review's stable `reviewId` and workspace
position. File identities are retained by title occurrence, including duplicate
titles, incoming file order is preserved, and the current active file survives
when it is still present. The receipt carries these server-authoritative
identities rather than the extension's provisional UUIDs.

With `replace: false`, a fresh review identity creates a separate review.
Replaying the same exact control remains idempotent.

## Payload-free receipts and bounded transport

A successful result is a single v2 control receipt shaped like:

```json
{
  "action": "review_open",
  "version": 2,
  "toolCallId": "...",
  "payloadId": "...",
  "reviewId": "...",
  "title": "Architecture",
  "activeFileId": "...",
  "replace": true,
  "totalBytes": 496640,
  "hash": "<sha256>",
  "files": [
    { "fileId": "...", "title": "Summary", "bytes": 24832 }
  ],
  "automaticOpen": { "ok": true, "status": "opened" }
}
```

The receipt contains no `markdown` or `content` field. Its closed metadata
schema and 24 KiB cap keep it below generic large-content truncation. Error
results use the same bounded v2 control shape with an allowlisted code,
retryability, and safe message; paths, credentials, URLs with tokens, stack
traces, and raw server errors are not copied into tool output.

Review arguments are protected separately. Before live/history egress, the
large-content projector replaces nested inline Markdown with byte/character
length descriptors while retaining bounded ordered metadata. This prevents the
original tool call from becoming a second large transport path. It does not
change executable validation or the canonical artifact.

## Authenticated API and sandbox boundary

Review payload routes pass through normal gateway authentication. In a remote
deployment that means a valid signed browser cookie or admin bearer credential;
localhost deployments retain the gateway's local-trust behavior.

| Method and route | Additional contract |
|---|---|
| `POST /api/sessions/:sessionId/review-payloads` | Upload only. Requires `X-Bobbit-Session-Secret` to resolve to the route's exact owning session. A sandbox token may reach only its own session collection route, and the session secret is still required. |
| `GET /api/sessions/:sessionId/review-payloads/:payloadId` | Browser/admin read. Requires the exact `toolCallId`, `reviewId`, and `hash` query tuple. Sandbox tokens cannot read payloads. |
| `POST /api/sessions/:sessionId/review-payloads/:payloadId/open` | Browser/admin explicit open. The body must repeat the exact `payloadId`, `toolCallId`, `reviewId`, and `hash`. Sandbox tokens cannot invoke workspace opens. |

The server also verifies that the session still exists and that the stored
payload's `sessionId` and `payloadId` match the route. Missing, partial,
multiple, stale, cross-session, or mismatched references fail closed. The
client accepts a receipt only from its own typed `review_open` result envelope,
with the envelope's tool-call identity matching the receipt and exactly one
valid receipt present. An unrelated tool result cannot forge a read or open.

The upload route has its own request-body ceiling: six times the 10 MiB Markdown
limit plus a fixed 256 KiB metadata allowance, enough for worst-case JSON string
escaping. Declared `Content-Length` is rejected early; chunked uploads are
stopped as soon as they cross the same ceiling. This narrow exception does not
increase the generic API body, WebSocket, event-buffer, transcript, or tool
result limits.

## Persistence, quota, and cleanup

Canonical payloads live under:

```text
<state>/review-payloads/<sessionId>/<payloadId>/payload.json
```

Persistence writes a private sibling temporary directory and file, then renames
the completed artifact into place. Reads reject symlinked or non-regular
artifact paths, revalidate the complete canonical schema and byte counts, and
recompute the hash before returning content. The server keeps no unbounded
payload catalog or body cache.

Each session may retain at most 64 payloads and 256 MiB of serialized payload
files, whichever limit is reached first. Existing historical payloads are never
evicted to admit a new upload; admission returns
`507 REVIEW_PAYLOAD_QUOTA_EXCEEDED` before creating an owner or temporary directory.
This preserves old tool-card recovery rather than silently changing what a
receipt addresses.

Uploads, explicit reopens, and purge are serialized per owning session. Quota
inspection and persistence occur inside that serialization boundary. A purge
installs a permanent fence, waits for accepted work, and then removes the
session's payload directory, so a late upload cannot recreate deleted state.
Workspace mutation uses its own per-session lock after payload validation.

Closing or submitting a review removes its workspace authority and review UI
state but deliberately retains the immutable payload. The originating card can
therefore explicitly reopen it. Archiving also retains payloads; normal session
purge removes them. Startup recovery removes incomplete temporary directories
and payload directories whose session no longer exists.

## Workspace authority and failure atomicity

An artifact-backed workspace tab is exactly:

```text
review:<encodeURIComponent(reviewId)>
```

Its source stores the bounded tuple `sessionId`, `reviewId`, `title`,
`toolCallId`, `payloadId`, and `contentHash`; its tab state stores
`activeFileId`. The server canonicalizes the tuple as one indivisible identity.
File navigation updates `activeFileId` on that exact workspace tab so reload
restores the selected file.

An open validates the immutable payload before mutating the workspace, then
upserts only the exact review tab through the authoritative workspace lock and
durable session store. A failure before commit does not create a review tab,
remove or overwrite sibling tabs, reorder unrelated reviews, change their
selection, or alter the foreground session. A failed automatic workspace open
may leave a complete immutable payload by design; that payload is the retry
source, not a partially opened review.

Close/submit tombstones are passive-replay suppression, not open authority.
Neither the upload-triggered open nor an explicit manual open erases tombstone
storage. Instead, the committed exact primary tab authorizes the review while
it exists. If an open fails, the prior tombstone remains byte-for-byte intact.
If the primary is absent, transcript rendering, reload hydration, caches, and
historical results continue to respect the tombstone and cannot recreate the
review.

Background opens mutate only the owning session's workspace and content cache.
They may select the review inside that owner's workspace, but they never switch
the application's foreground session or replace the visible foreground review.
Switching to the owner later hydrates the review only when its exact tab remains
authoritative.

## Automatic, manual, reload, and history behavior

The upload is the sole automatic workspace mutation and records its structured
`automaticOpen` success or failure in the receipt. The live client passes the
receipt through the same exact-key coordinator used by renderer clicks, but the
automatic path never calls `/open`: it validates the recorded outcome, refreshes
the authoritative workspace, and fetches and hydrates content only if the exact
tab still exists. Only an explicit renderer click posts to `/open`, so it alone
may reopen an absent review. Coordinator state is keyed by
`(sessionId, toolUseId, payloadId)` and deduplicates work already in flight. A
delayed receipt processed after close or submit therefore preserves workspace
absence and the replay tombstone.

The Review tool card is passive during render. It never opens a tab merely
because a receipt appears in live or historical transcript content. It exposes:

| State | Renderer action |
|---|---|
| Tool still streaming | Disabled **Open review** with a wait status |
| Valid receipt available | **Open review** |
| Open pending | Disabled **Opening…** with `aria-busy` |
| Confirmed open | **Re-open review** and **Review opened.** |
| Retryable failure | Inline `role=alert` message and **Retry open** |
| Terminal or malformed reference | Disabled **Open unavailable** with a safe reason |

The button is a native keyboard-operable button. Safe diagnostics include an
allowlisted code, while untrusted server text is discarded. Persistence,
workspace-conflict, unavailable-session, and client-open failures are retryable.
Missing payload, invalid reference, over-limit content, and unauthorized access
are terminal for that receipt and direct the user to rerun or reduce the review.
`REVIEW_PAYLOAD_QUOTA_EXCEEDED` is also terminal and non-retryable: the renderer
disables the action as **Open unavailable** and safely advises starting a new
session or removing saved reviews, without displaying raw server details. A
client render/hydration failure after a durable server commit remains retryable:
retry refetches the authoritative workspace rather than inventing a client tab
or rolling back server state.

On reload or reconnect, the client enumerates only complete artifact references
already present in the authoritative workspace. It performs an exact GET and
hydrates the group without issuing an open, focusing a tab, switching sessions,
or touching tombstones. Historical tool cards parse their own bounded receipt
and automatic outcome to restore the correct button/error presentation; only an
explicit click may reopen an absent review.

Artifact-backed Markdown is never duplicated into `localStorage`. The client
fetches the whole canonical review because the aggregate is already bounded to
10 MiB. This keeps persistence durable while avoiding another per-file staging
and fetch lifecycle.

## Legacy compatibility

The agent-facing input API is unchanged:

- one inline `markdown` value;
- one `file` path;
- an ordered `files` array mixing inline Markdown and file paths;
- optional `title` and `replace`.

All new successful calls, including small and one-file calls, use the v2
artifact receipt. The client retains a read-only compatibility path for trusted
**live** v1 inline controls and legacy one-file/document identities. Malformed v2
controls never downgrade into that path. Historical legacy tool results remain
passive and cannot recreate a closed review.

Existing bounded legacy review groups may still migrate from `localStorage`, and
legacy workspace review identities are canonicalized once. Artifact-backed v2
reviews use exact identities and server storage only; the lossy legacy
normalization rules are never applied to them.

## Operational checks

When a review does not open:

1. Inspect the owning session's side-panel workspace first. The exact
   `review:<encoded-reviewId>` tab and its full payload reference tuple determine
   whether hydration is allowed.
2. Check the Review card's allowlisted code. Retry only codes presented as
   retryable; rerun `review_open` for unavailable or invalid content, and reduce
   content for the 10 MiB error.
3. Check the session payload directory for count/serialized-size exhaustion,
   incomplete temporary directories, or an absent owner. Do not edit
   `payload.json`; its hash and identity binding intentionally make manual
   mutation invalid.
4. For startup/purge issues, inspect `[review-payloads]` logs. Cleanup failures
   are logged by the session termination or startup recovery owner.

Implementation is split across the Review extension, the server review-payload
store/routes, the shared artifact identity contract, the client review-open
coordinator, and the Review renderer. Registered Test Suite v2 coverage lives in
the review payload/receipt core tests, renderer/coordinator DOM tests,
authenticated payload integration tests, and the large-review browser journey.

Related docs: [Review payload artifact routes](rest-api.md#review-payload-artifacts),
[Side-panel workspace](side-panel-workspace.md),
[Review Pane Sign-Off](review-pane-signoff.md), and
[Large-content truncation](internals.md#large-content-truncation).
