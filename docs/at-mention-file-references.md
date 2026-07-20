# `@`-Mention File References

Type `@` in the prompt composer to reference a file by path. At send time,
Bobbit turns a token into a file reference only when it appears outside Markdown
code and its filesystem target exists. Existing text files are inlined into the
model-facing prompt; images and other binaries use the attachment pipeline.

This distinction keeps ordinary text ordinary. A missing token such as
`@variableName` or `@missing/path.ts` remains literal text with no mention
metadata, warning, attachment, sidecar entry, or chip. The same is true for any
`@` token inside Markdown code.

## Why it works this way

Three design choices define the feature:

- **Respect Markdown intent.** Code examples often contain `@` identifiers and
  paths that are not requests to attach a file. Excluding Markdown code also
  preserves pasted examples byte-for-byte.
- **Classify existence before delivery.** Missing paths are ordinary prose, but
  an existing target that fails a later access or safety check remains visible
  as an unresolved reference. This avoids false-positive chips without hiding a
  real delivery failure.
- **Snapshot at send time.** Bobbit captures delivered content or bytes with the
  message. Reloading a transcript therefore shows what the model received even
  if the source file later changes or disappears.

Whole-send admission limits are separate from per-reference delivery limits.
Admission overflow rejects the send atomically to bound work; a delivery failure
within those bounds preserves the send and records an unresolved reference.

## Autocomplete UX

Typing `@` at a word boundary (start of input, or after whitespace/newline)
opens a file-picker menu, mirroring the slash-skill menu:

- The query is the path fragment after `@` (no whitespace, no further `@`).
- The menu lists files under the session's worktree, ranked so basename matches
  (exact > prefix > substring) sort ahead of full-path matches, then by shorter
  path, then lexicographically.
- Keyboard: ↑/↓ move the selection, Enter/Tab select, Escape dismisses; mouse
  hover/click also select.
- Selecting a file inserts `@<relative-path>` followed by a space.

The menu is query-scoped against the server (debounced ~120 ms) because the file
tree can be large or remote, so the server does the filtering and ranking. A
local cache provides an instant filter between fetches.

### What's listed

The menu enumerates **all files** under the session's host worktree —
**including gitignored and untracked files** — because those branch-local files
are exactly what you often want to reference. Bobbit does *not* consult
`.gitignore`. A short, fixed exclusion list keeps obvious noise out:

```
.git  node_modules  dist  .bobbit  .next  coverage  build
```

Symlinks are skipped during the walk to avoid loops and escapes.

Two hard caps keep large trees from blocking the event loop:

- **Walk cap** — max directory entries visited (~20k) before the walk stops.
- **Result cap** — max files returned (`limit`, default 500, clamped to 1000;
  the autocomplete requests 50).

Source: `src/server/skills/file-enumeration.ts` (`enumerateFiles`).

## REST endpoint

```
GET /api/file-mentions?cwd=&projectId=&q=&sessionId=&limit=
```

Returns `{ files: [{ path }] }` — relative forward-slash paths scoped to the
resolved working directory. Modeled on `GET /api/slash-skills`.

The endpoint enumerates the **session's host worktree**, not the project root.
This matters: the project-root redirect used for *skill discovery* is wrong here
because a goal/session worktree has its own branch-local, untracked, and
gitignored files that the project root does not see. When `sessionId` is
provided, the server prefers the session's `worktreePath` (the host path —
required for sandboxed sessions, whose `cwd` is a container path), then falls
back through the session `cwd` and raw `cwd`. The resolved project root is only
a final defensive fallback when none of those host paths is available; it is not
the normal skill-discovery redirect.

## Resolution on send

Resolution runs against the user's original text and records source ranges
without rewriting the text during scanning.

### Candidate scanning and Markdown code

A candidate begins at the start of the prompt or after whitespace. It continues
until whitespace or another `@`. Bobbit removes trailing `.`, `,`, `)`, `:`, and
`;` from the candidate, leaving that punctuation outside the mention and chip
range.

The scanner excludes candidates in Markdown code recognized from the original
source:

- backtick or tilde fenced code blocks, including unterminated fences;
- matched inline backtick code spans, including multi-backtick delimiters;
- four-space or tab-indented code blocks; and
- fenced or indented code nested inside blockquotes, lists, or combinations of
  those containers.

Excluded code remains byte-for-byte literal in both the original and
model-facing text. It produces no mention metadata, warning, attachment, inline
content, chip, or filesystem probe. Code-contained tokens also consume neither
the candidate budget nor the distinct-target budget.

### Existence first

Candidates outside code are deduplicated into lexical filesystem targets for
admission, then classified with a bounded metadata-only existence probe. A
classification of genuinely missing (`ENOENT` or `ENOTDIR`) omits every matching
token from the mention result. Its literal bytes remain unchanged and it does
not consume the existing-reference delivery limit. There is no failed-reference
record or content I/O: a missing target is never canonicalized, opened, or read.

On Windows, network/device namespace paths and reserved DOS-device tokens are
also always ordinary text. They consume the non-code candidate budget, but are
not probed and do not consume the distinct-target budget.

A non-missing target proceeds through delivery checks. If any later check fails,
the literal token stays in the model-facing text and Bobbit records an
`unresolved` mention with a warning and chip. These failures include:

- access, canonicalization, stat, open, or read errors;
- lexical or canonical containment failure, including a symlink escape;
- a directory, FIFO, socket, device, or other non-regular target;
- a per-file, existing-mention-count, or aggregate delivery limit; and
- a target that disappears, grows beyond an applicable cap, or fails a
  containment, type, or identity check during a race between existence
  classification and its descriptor-bound snapshot.

This separation is intentional: absence means the user wrote ordinary text;
failure after existence means Bobbit found a real target but could not deliver
it safely.

### Delivery kinds

| Kind | Detection | Snapshot and routing | Model-facing text |
|---|---|---|---|
| `text` | readable content recognized as UTF-8 text | snapshotted content in a `<file-reference>` block | `@path` is replaced by the block |
| `image` | supported image extension (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`, and others) | snapshotted base64 bytes through `images[]` | literal `@path` remains |
| `binary` | readable non-image content not recognized as text | snapshotted base64 document attachment | literal `@path` remains |
| `unresolved` | existing or otherwise non-missing target fails a later delivery check | no content or bytes delivered | literal `@path` remains |

Binary document attachments preserve the UI chip and send-time snapshot in the
same shape as uploaded documents. The current agent prompt RPC forwards text and
images, not document bytes; model-side binary delivery remains an attachment
pipeline concern outside this feature.

A text block names and delimits the snapshot:

```xml
<file-reference path="src/foo.ts">
…file content…
</file-reference>
```

The path is XML-attribute-escaped so filename characters cannot break the
delimiter. Multiple text references are spliced right-to-left, preserving all
source indices and surrounding literal text.

### Overlap with a prefix slash skill

A prefix-only slash skill can claim the whole message range and therefore
overlap an `@file` token. The skill expansion wins the overlapping splice so its
body is not corrupted. A resolved text snapshot is appended as a
`<file-reference>` block after the skill body; image and binary snapshots keep
using their attachment frames. The chip still uses the token's original range.

## Whole-send admission limits

An authenticated send is admitted only when all three bounds hold:

| Admission bound | Maximum | Structured error when exceeded |
|---|---:|---|
| Authenticated prompt text | 8 MiB (8,388,608 UTF-8 bytes) | `PROMPT_TOO_LARGE` |
| Candidate tokens outside Markdown code | 8,192 | `FILE_MENTION_CANDIDATE_LIMIT` |
| Distinct lexical filesystem targets | 4,096 | `FILE_MENTION_PROBE_LIMIT` |

The text-size check runs before Markdown processing or session command queuing.
Candidate and distinct-target preflight runs before slash-skill discovery,
filesystem classification, or prompt enqueue. Repeated candidates count toward
the candidate bound but a repeated lexical target counts once toward the target
bound. Markdown-code-contained tokens count toward neither.

Exceeding any admission bound rejects the whole send. Bobbit returns the
structured error without partially resolving, persisting, or enqueueing the
prompt and without probing candidate targets. This is different from the
following delivery limits, which apply only after the whole send has been
admitted.

## Delivery limits and unresolved references

| Delivery limit | Maximum | Existing-reference result when exceeded |
|---|---:|---|
| Inline text per file | 256 KiB | `unresolved` (`too-large`) |
| Image or binary per file | 10 MiB | `unresolved` (`too-large`) |
| Snapshotted bytes across one send | 20 MiB | `unresolved` (`aggregate-cap`) |
| Existing mention occurrences per send | 50 | `unresolved` (`too-many-mentions`) |

Missing tokens do not consume the existing-mention or aggregate limits.
Existing references beyond a delivery limit are still classified and recorded;
they are not silently converted to plain text. After distinct targets are
classified, occurrences are processed in source order. Every non-missing
occurrence, including one that fails a later check, consumes the 50-occurrence
limit; repeated paths count separately. Successful snapshots consume aggregate
bytes in the same order. Size limits are checked against metadata and against
the bounded descriptor read so growth between checks cannot bypass them.

## Bounded work, cancellation, and ordering

Markdown scanning and existence classification use process-wide permits and
fixed worker pools rather than unbounded work per candidate. Every admitted
distinct target is still classified, so a long run of missing paths cannot hide
a later existing reference.

Enqueue-producing commands for the same session share an ordered FIFO boundary,
so a later command cannot overtake a prompt still resolving file mentions. The
pending queue is bounded; overload is returned as the structured
`SESSION_COMMAND_QUEUE_FULL` error rather than silently reordering or dropping a
command.

Stop remains available while preprocessing is waiting or running. It cancels
the active admission/resolution path and prevents that send from enqueueing;
cancellation never returns a partial mention result. Filesystem operations that
have already reached the OS are observed to completion under their global
permit, while cancellation prevents queued follow-up work from starting.

## Path and snapshot safety

Existence classification precedes delivery validation so a missing traversal is
still ordinary text, while an existing outside target becomes an unresolved
reference. Existing targets then pass layered checks:

1. A lexical containment check rejects paths outside the permitted working
   directory.
2. Canonical paths for the working directory and target are compared before any
   payload read, blocking symlinks that escape the worktree.
3. Non-regular targets are rejected before open. Regular targets are opened with
   no-follow and non-blocking protections where supported.
4. The opened descriptor is revalidated for canonical containment, type, and
   size before bytes are read. Platforms without direct descriptor-path
   verification also compare stable pathname identity. The snapshot is read
   only from the descriptor, which closes path-swap race windows.

Any validation, stat, open, read, close, or race failure leaves an unresolved
chip and warning without exposing file bytes. Canonical host paths remain
resolver-internal and are removed before data crosses the wire or reaches the
sidecar.

## Chips, persistence, and replay

Every resolved or unresolved existing reference renders an inline
`<file-mention-chip>` at the original token range. Missing and code-contained
tokens have no mention record, so they render as ordinary literal text with no
chip.

Clicking a chip shows the send-time result:

- `text` — the captured content;
- `image` — the captured image bytes;
- `binary` — the captured filename and size; or
- `unresolved` — the failure reason.

Mention ranges are UTF-16 code-unit offsets into the original text, matching
JavaScript string slicing. Astral characters before a mention therefore do not
displace its chip, and trimmed trailing punctuation remains outside the range.
Right-to-left model-text replacement and left-to-right chip splicing preserve
multiple references and all untouched source text.

Persistence reuses the skill sidecar because the transcript owner does not
support file-mention fields directly. Each user message stores its file
references and snapshots out of band, then reattaches them on reload. Chips,
UTF-16 ranges, original literal text, and captured content remain stable across
reloads even if the source file changes or disappears. A missing or unreadable
sidecar degrades to the original plain text for backward compatibility.

## Key source files

| Concern | File |
|---|---|
| Send-time admission and resolver | `src/server/skills/resolve-file-mentions.ts` |
| Skill and mention merge into model text | `src/server/skills/merge-mentions.ts` |
| Bounded file enumeration | `src/server/skills/file-enumeration.ts` |
| REST endpoint | `GET /api/file-mentions` in `src/server/server.ts` |
| Send-time routing and persistence | `src/server/ws/handler.ts` |
| Same-session command ordering | `src/server/ws/session-command-serialiser.ts` |
| Sidecar persistence and replay | `src/server/skills/skill-sidecar.ts` |
| Composer autocomplete | `src/ui/components/MessageEditor.ts` |
| Chip component | `src/ui/components/FileMentionChip.ts` |
| Chip splicing | `src/ui/components/Messages.ts` |

## Related

- [Skills (slash commands)](features.md#skills) — the sibling `/` feature.
- [Skill chip rendering and sidecar persistence](internals.md#skill-chip-rendering--autonomous-activation)
  — the shared chip and replay machinery.
- [Slash-skill UX design](design/skill-ux-and-autonomous-activation.md).
