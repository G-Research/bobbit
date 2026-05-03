# Preview panel — file mode

The `preview_open` tool supports two ways of opening an HTML preview in the
side-panel iframe:

1. **Inline mode** — `preview_open({ html: "<…>" })`. The agent already has
   the bytes; they round-trip through the gateway and the chat transcript.
2. **File mode** — `preview_open({ file: "/abs/path/report.html" })`. The
   agent points at a file on disk; the gateway serves it (and any sibling
   assets) over HTTP. Asset bytes never enter the agent context or the chat
   transcript.

File mode exists so reports can ship with sibling images, GIFs, CSS, and JS
without base64-inlining everything into a single HTML blob — which previously
bloated the on-disk snapshot, the agent's context window on read-back, and
the marker block stamped into the tool result.

The `html:` parameter semantics are unchanged. File mode is purely additive.

---

## Per-session preview state

State lives on disk under `<bobbitStateDir>/`:

- `preview-<sessionId>.html` — preview HTML body. In inline mode this is the
  literal HTML the agent posted. In file mode it is a stub
  (`<!-- file:<abs> -->`) so legacy clients polling the unchanged
  `GET /api/preview` endpoint get a no-op rather than a stale render.
- `preview-<sessionId>.meta.json` — sidecar describing the active mode.
  Absent ⇒ legacy inline mode (back-compat with sessions written before this
  feature). Schema:

  ```jsonc
  {
    "version": 1,
    "kind": "inline" | "file",
    // file-mode only:
    "baseDir": "/abs/path/to/dir-containing-html",
    "entry":   "report.html",   // relative to baseDir
    "mtime":   1714512345678
  }
  ```

The `mtime` field is what `src/app/preview-panel.ts` polls to detect changes;
the iframe is reloaded by bumping a `?v=<mtime>` cache-buster on its `src=`.

---

## Server routes

Two new routes live next to the existing `GET/POST /api/preview` and share
its auth (Bearer token, sandbox-token-aware). Allow-listed in
`src/server/auth/sandbox-guard.ts`.

### `GET /api/preview/render?sessionId=<uuid>`

Returns the active preview HTML for the session, with two server-side
rewrites applied:

- A `<base href="/api/preview/asset?sessionId=<uuid>&path=">` element is
  injected as the first child of `<head>` (or a synthetic `<head>` is
  prepended) so every relative `src=`/`href=` resolves to the asset endpoint.
- The shared theme-bridge and swipe scripts (`src/shared/preview-bridge-scripts.ts`)
  are appended before `</body>`. Client-side inline-mode rendering uses the
  same constants on `srcdoc`, so client and server always emit byte-equal
  bridge output.

Responses: `200` with `Content-Type: text/html; charset=utf-8`; `400` invalid
sessionId; `404` no preview state.

In file mode the entry HTML is re-read from `baseDir/entry` on every request
— edits to the file on disk show up on the next iframe load.

### `GET /api/preview/asset?sessionId=<uuid>&path=<rel>`

Serves a sibling asset relative to the session's `baseDir`. Only valid in
file mode.

Path-traversal defence lives in `src/server/preview/path-guard.ts` and runs
on every request:

1. Reject `null`, empty, NUL-containing, absolute, or backslash-containing
   paths.
2. `path.resolve(baseDir, raw)`, then `fs.realpathSync` on both sides — the
   resolved real path must equal `baseDir` or live strictly under it.
   Defends against symlink-based escapes inside `baseDir`.
3. Existence + `isFile()` check.
4. 25 MiB size cap per asset (`413`).

Content-Type lookup is a small built-in table in `src/server/preview/mime.ts`
covering the assets reports actually use (`.html .css .js .json .svg .png
.jpg .gif .webp .mp4 .webm .mp3 .woff .woff2` and a handful of others);
unknown extensions fall back to `application/octet-stream`. `Cache-Control:
no-store` — files are short-lived and we don't want stale GIFs after edits.

Responses: `200` asset bytes; `400` invalid sessionId / missing path /
traversal rejected; `404` no preview state, inline-mode session, or file
not found; `413` over the 25 MiB cap.

### `POST /api/preview?sessionId=<uuid>`

Accepts both shapes:

- `{ html: "<…>" }` — existing inline-mode behaviour. Deletes any
  pre-existing meta sidecar (mode reverts to inline).
- `{ kind: "file", path: "/abs/path/to/report.html" }` — file mode.
  Server validates that `path` is absolute, exists, is readable, and ends
  in `.html`/`.htm`. Resolves `baseDir = dirname(realpath(path))` and
  `entry = basename(...)`, writes the meta sidecar, writes the legacy
  stub. Returns `400 baseDir not host-visible` if the file isn't readable
  by the gateway — see "Sandbox host-visibility" below.

### `GET /api/preview?sessionId=<uuid>`

Extended response. Unknown fields are ignored by old clients:

```jsonc
{ "html": "<…>", "mtime": 1714…, "kind": "inline" }
// or
{ "html": "",    "mtime": 1714…, "kind": "file", "entry": "report.html" }
```

---

## Marker block — v1 vs v2

Every successful `preview_open` call appends a sentinel text block to the
tool result so `<preview-renderer>`'s "Open" button can re-open the preview
after a server restart, even if the original file is gone.

- **v1** (inline, unchanged):
  ```
  __preview_snapshot_v1__\n<full-html-bytes>
  ```
- **v2** (file mode, additive):
  ```
  __preview_snapshot_v2__\n{"kind":"file","path":"/abs/path/to/report.html"}\n
  ```

v2 carries only the file path (~250 bytes for a typical absolute path),
regardless of how big the report is. v1 markers are still recognised
verbatim — historical transcripts keep working.

Helpers live in `defaults/tools/html/snapshot.ts`:
`PREVIEW_SNAPSHOT_MARKER_V1`/`V2`, `isSnapshotBlock(text)` (true for either
prefix), `parseSnapshot(text)` returning a discriminated union of
`{ kind: "inline"; html }` or `{ kind: "file"; path }`.

### Reopen-after-restart flow

- **v1 / inline:** PreviewRenderer extracts the HTML from the marker, PATCHes
  the session with `{ preview: true }`, then POSTs `/api/preview` with
  `{ html }`.
- **v2 / file:** parse the JSON to get `path`, PATCH `{ preview: true }`,
  POST `/api/preview` with `{ kind: "file", path }`. On `200` the polling
  client picks up the new `mtime` and the iframe reloads. On `404` (file
  no longer on disk) PreviewRenderer flips its button to "File no longer
  available" and disables it — there is no inline fallback in this case
  because the bytes simply aren't anywhere.

`truncate-large-content.ts` strips snapshot blocks from agent-facing
context. v2 markers are far below the 32 KiB threshold so the lazy-load
hydration path is dead code for v2; v1 keeps using it.

---

## Sandbox host-visibility

When the agent runs **outside** a Docker sandbox, the path it sees is the
same path the gateway sees — file mode just works.

When the agent runs **inside** a Docker sandbox, the agent writes under a
bind-mounted in-container path (e.g. `/workspace/...`) while the gateway
needs the host equivalent (`<worktree>/...`). The translation is the
extension's job, not the gateway's:

1. The gateway sets `BOBBIT_HOST_CWD` on every sandboxed agent spawn
   (`src/server/agent/docker-args.ts`).
2. `defaults/tools/html/extension.ts` translates
   `agentPath → hostPath = path.join(BOBBIT_HOST_CWD, path.relative(process.cwd(), agentPath))`
   before POSTing.
3. If `BOBBIT_HOST_CWD` is unset, or the file is outside the bind-mounted
   cwd, the extension automatically falls back to inline mode (reads bytes
   itself) and emits a warning in the tool result so the agent can see
   why the preview isn't asset-aware.
4. As a defence in depth, the gateway re-checks `fs.existsSync(path)` on
   POST and returns `400 baseDir not host-visible` if it can't read the
   file — the extension catches that specific 400 and retries with inline.

This is the **single fallback decision point** — file mode is always tried
first when given `file:`, and only retries with `html` on a specific 400.

---

## File-by-file map

| Concern | Location |
|---|---|
| Marker constants, parser | `defaults/tools/html/snapshot.ts` |
| Tool extension (file/inline branch, host translation, fallback) | `defaults/tools/html/extension.ts` |
| Server routes, meta sidecar helpers | `src/server/server.ts` (search `previewMetaPath`, `/api/preview/render`, `/api/preview/asset`) |
| MIME lookup | `src/server/preview/mime.ts` |
| Path-traversal guard | `src/server/preview/path-guard.ts` |
| Auth allow-list | `src/server/auth/sandbox-guard.ts` |
| Theme-bridge + swipe scripts (shared) | `src/shared/preview-bridge-scripts.ts` |
| Iframe branching (`src=` vs `srcdoc=`) | `src/app/render.ts::htmlPreviewContent` |
| Mode/mtime polling | `src/app/preview-panel.ts` |
| Reopen UI (recognise both markers, file-not-found UX) | `src/ui/tools/renderers/PreviewRenderer.ts` |
| Tests | `tests/preview-path-guard.test.ts`, `tests/preview-extension.test.ts`, `tests/preview-renderer.spec.ts`, `tests/e2e/preview-sanitize.spec.ts`, `tests/e2e/preview-file-assets.spec.ts` |

See also: [docs/rest-api.md — Preview](rest-api.md#preview).
