# `@`-Mention File References

Type `@` in the prompt composer to reference a file by path. On send, Bobbit
resolves each `@path` token into the referenced file's content: **text files are
inlined into the model-facing prompt**, while **images and other binaries are
attached** via the existing attachment pipeline. Each reference renders as a
clickable chip in the sent message that expands to show the exact content the
model saw.

## Why it works this way

The feature is built as a deliberate parallel to the [`/` slash-skill
feature](design/skill-ux-and-autonomous-activation.md) — same autocomplete UX,
same send-time resolution shape, same chip + sidecar persistence model. Reusing
those patterns keeps the two features consistent for users and lets the merge,
chip, and replay machinery be shared rather than duplicated.

Two design choices drive the rest of the behaviour:

- **Snapshot at send time.** When you send, the file content (or image/binary
  bytes) is captured into the message. Replaying the `.jsonl` transcript later
  renders exactly what the model originally saw, even if the file has since
  changed or been deleted on disk. This is the same stability guarantee skill
  expansions provide.
- **Never tear down a send.** Any reference that cannot be resolved — missing,
  unreadable, too large, outside the working directory, or over a count/size cap
  — degrades to the literal `@path` text plus a non-fatal warning. A bad
  reference never fails the whole message.

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
provided, the server resolves the session's `worktreePath` (the host path —
required for sandboxed sessions, whose `cwd` is a container path) and falls back
to the session `cwd`, then to the raw `cwd` query param. It never falls back to
the project root.

## Resolution on send (hybrid)

At send time the server runs the pure resolver
`resolveFileMentions(text, cwd)` (`src/server/skills/resolve-file-mentions.ts`)
against the verbatim text. It scans `@path` tokens with an inline,
word-boundary-anchored regex (`(^|\s)@([^\s@]+)`), trims trailing punctuation
(`. , ) : ;`) off each token, and classifies each reference into one of four
kinds:

| Kind | Detection | Model delivery | `modelText` |
|---|---|---|---|
| `text` | content sniffs as UTF-8 text | inlined as a `<file-reference>` block | rewritten |
| `image` | image extension (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`, …) | base64 via the `images[]` frame | unchanged (literal `@path` kept) |
| `binary` | non-text, non-image | base64 document via the attachment pipeline | unchanged (literal `@path` kept) |
| `unresolved` | failed any check below | not delivered | unchanged (literal `@path` kept) |

Text content is spliced into the model-facing prompt inside a delimiter that
names the path:

```
<file-reference path="src/foo.ts">
…file content…
</file-reference>
```

The path is XML-attribute-escaped so a quote or angle bracket in a filename
cannot break out of the `path="…"` delimiter. Text mentions are spliced
**right-to-left** by range so earlier indices stay valid.

For `image` and `binary` mentions, `modelText` is left untouched — the literal
`@path` stays so the model still sees the filename — and the bytes are routed
through the existing prompt frames: images into `images[]`, binaries as
`document` attachments. Binaries are attached primarily for UI chip + snapshot
parity with user-uploaded documents.

### Overlap with a prefix slash-skill

A *prefix-only* slash skill (e.g. `/mockup …`) claims the whole-message range,
which overlaps any `@file` token in the same message. On overlap, the skill
expansion wins: the file content is **appended** after the spliced skill body as
a `<file-reference>` block rather than spliced inline (which would corrupt the
skill body). The chip still renders at the original `@path` range either way.
The merge is handled by `buildMergedModelText`
(`src/server/skills/merge-mentions.ts`), which combines skill expansions and
text mentions into a single right-to-left splice over the original text.

## Caps and degradation

Caps are enforced in the resolver. Mention-count and per-file caps are checked
**before** any file read so an oversized or over-the-limit reference never loads
bytes into memory:

| Cap | Value | Over-cap kind |
|---|---|---|
| Inline text per file | 256 KiB | `too-large` |
| Image/binary per file | 10 MiB | `too-large` |
| Aggregate across one send | 20 MiB | `aggregate-cap` |
| Mentions per send | 50 | `too-many-mentions` |

The aggregate budget is pre-checked against each file's stat size before
reading, then re-validated against the actual bytes after reading to handle the
file growing between stat and read (TOCTOU). Every degraded reference is
recorded as kind `unresolved` with a human-readable `reason`
(`missing`, `unreadable`, `too-large`, `outside-cwd`, `aggregate-cap`,
`too-many-mentions`) and surfaces a non-fatal `console.warn` on the server; the
literal `@path` text is preserved in the prompt.

## Path safety

References are confined to the working directory:

1. **Lexical reject** — `path.resolve(cwd, rel)` followed by a containment check
   cheaply rejects obvious `..`/absolute escapes (and non-existent traversal
   paths).
2. **Canonical reject** — the target is canonicalized with `fs.realpathSync` and
   the containment check is re-run on the **canonical** paths **before any
   stat/read**. This defeats a symlink that lives inside `cwd` but points
   outside it — it cannot leak host files. A `realpath` failure is treated as
   `missing`.

The canonical absolute path is kept internally for the read but stripped
(`toWireMention`) before the mention crosses the wire or is persisted, so the
host filesystem layout is never exposed to the client.

## Chips, persistence, and replay

Each `@file` reference renders an inline `<file-mention-chip>` in the sent user
message (`src/ui/components/FileMentionChip.ts`), mirroring `SkillChip`.
Clicking the chip toggles a disclosure showing the snapshotted content:

- `text` → a `<pre>` of the captured content,
- `image` → an `<img>` of the snapshotted bytes,
- `binary` / `unresolved` → a note (size / reason).

Chips are spliced into the user bubble at the recorded `@path` range by the
shared chip-item builder in `src/ui/components/Messages.ts`, which handles both
`<skill-chip>` and `<file-mention-chip>`.

Persistence reuses the **skill sidecar**
(`src/server/skills/skill-sidecar.ts`). The pi-coding-agent CLI owns the
`.jsonl` transcript schema, so mentions are stored out-of-band in a sidecar
file (one JSON line per user message) under a `fileMentions` field alongside
`skillExpansions`. On replay, the sidecar entry is matched to the message by
`modelText` (with a small timestamp tolerance) and both `skillExpansions` and
`fileMentions` are re-attached so chips and the original `@path` text restore
correctly. A missing or unreadable sidecar degrades to plain text — old sessions
render with the literal `@path`, fully backward compatible.

## Key source files

| Concern | File |
|---|---|
| Pure send-time resolver | `src/server/skills/resolve-file-mentions.ts` |
| Skill + mention merge into model text | `src/server/skills/merge-mentions.ts` |
| Bounded file enumeration (autocomplete backend) | `src/server/skills/file-enumeration.ts` |
| REST endpoint | `GET /api/file-mentions` in `src/server/server.ts` |
| Send-time wiring (resolve, merge, route, persist) | `src/server/ws/handler.ts` |
| Sidecar persistence / replay | `src/server/skills/skill-sidecar.ts` |
| Composer autocomplete (`@` menu, keyboard nav, insertion) | `src/ui/components/MessageEditor.ts` |
| Chip component | `src/ui/components/FileMentionChip.ts` |
| Chip splicing into the user bubble | `src/ui/components/Messages.ts` |

## Related

- [Skills (slash commands)](features.md#skills) — the sibling `/` feature this
  one parallels.
- [Skill chip rendering & sidecar persistence](internals.md#skill-chip-rendering--autonomous-activation)
  — the shared chip + sidecar machinery.
- [Slash-skill UX design](design/skill-ux-and-autonomous-activation.md).
