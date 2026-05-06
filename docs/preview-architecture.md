# Embedded HTML preview — architecture

The preview side-panel renders agent-authored HTML alongside the chat. This
document covers the v3 architecture introduced by the embedded-html-preview
rewrite — a per-session content mount served from a cookie-authed origin path,
with SSE-driven hot reload.

## Mental model

Four pieces, one mount, one URL shape:

1. **Per-session mount on disk** — `<bobbitStateDir>/preview/<sid>/` holds the
   entry HTML and any sibling assets (images, CSS, video, …). Single source of
   truth for what the panel shows.
2. **Content origin** — the gateway serves the mount at `/preview/<sid>/<path>`.
   Same shape for the iframe `src`, the "Open in new tab" button, and any link
   the user clicks inside the preview.
3. **Cookie auth** — `bobbit_session` HttpOnly cookie issued on first
   authenticated request. iframe loads, link navigation, and new-tab opens all
   carry the cookie automatically; no token-in-URL hacks.
4. **SSE hot reload** — `GET /api/sessions/:sid/preview-events` streams a
   `preview-changed` event whenever the gateway repopulates the mount. The panel
   bumps `#mtime=<n>` on the iframe `src` to force a reload.

Old paths and concepts that are gone:

- `<stateDir>/preview-<sid>.html` (single inline file)
- `<stateDir>/preview-<sid>.meta.json` (file-mode sidecar)
- `BOBBIT_HOST_CWD` translation in the `preview_open` extension
- `/api/preview/render` and `/api/preview/asset` routes

## Per-session mount

Single source of truth: `src/server/preview/mount.ts`.

Layout:

```
<bobbitStateDir>/preview/<sid>/
    index.html              ← entry (or whatever the agent named)
    inline.html             ← when html=... is used
    videos/foo.webm
    thumbs/0001.jpg
    styles.css
```

| Constraint | Value | Source |
|---|---|---|
| Inline default entry | `inline.html` | `DEFAULT_INLINE_ENTRY` |
| Entry filename | single segment, no `/` `\` `..` `\0` | `validateEntry` |

Asset inclusion is **explicit opt-in**: `mountFile` copies only the named
entry plus caller-declared `assets[]` (literals or single-segment globs).
There is no BFS-of-the-parent-directory fallback and no size cap — the
agent is responsible for declaring only what it needs. Undeclared siblings
are never copied into the mount and never reach the content origin. See
[Mount endpoints — Explicit asset opt-in](#explicit-asset-opt-in-file-form)
for the full contract, validation rules, and rationale.

**Lifecycle.** Mount is created lazily on the first `preview_open` for a
session. `removeMount(sid)` is wired into the session-archive / cleanup path
and is idempotent on bad input.

**Atomic writes.** `writeInline` writes to a sibling tmp file in the mount and
`fs.renameSync`s into place — readers never see a half-written entry. Failures
unlink the tmp file before propagating.

**`mountFile` semantics.** Wipes the mount, copies the entry file, then
copies each declared asset — literals (`styles.css`, `sub/file.png`) or
single-segment globs (`img/*.png`, `chart.?.svg`). `**`, `[...]`, and
`{a,b}` are rejected. Each resolved asset's realpath must stay within the
entry's source directory; symlink escapes throw `PreviewMountError(403)`.
Literal assets that don't exist throw `404`; globs with no matches are not
an error. Hardlinks where supported, falls back to `copyFile`.

**Errors.** All failures throw `PreviewMountError` with `statusCode` (`400` /
`403` / `404` / `500`); the route handler maps directly to HTTP.

## Content origin: `/preview/<sid>/<rel-path>`

Single source of truth: `src/server/preview/content-route.ts`.

Routing inside the gateway happens before API auth so the iframe — which
cannot send `Authorization` — can authenticate via the session cookie.

Behaviour by path shape:

| Request | Response |
|---|---|
| `GET /preview/<sid>` | `301` redirect to `/preview/<sid>/` (so relative URLs resolve) |
| `GET /preview/<sid>/` | `302` to the picked entry — `index.html` → `inline.html` → first `*.html` alphabetically (`pickEntry`); `404` if mount is missing/empty |
| `GET /preview/<sid>/<file.html>` | `200 text/html`, body rewritten — `<base href="/preview/<sid>/">` injected and the shared theme/swipe bridge scripts appended |
| `GET /preview/<sid>/<asset>` | `200 <mime>` streamed as-is (no body rewrite) |
| `GET /preview/<sid>/../etc/passwd` | `403` — path-traversal rejected |
| `GET /preview/<sid>/missing` | `404` |
| Method other than `GET`/`HEAD` | `405` |

**Theme bridge.** `injectBaseAndScripts(body, baseTag, PREVIEW_BRIDGE_SCRIPTS)`
adds the `<base href>` and the bridge scripts only when the response is
`text/html`. Static assets pass through untouched.

**MIME lookup.** `src/server/preview/mime.ts`. Minimal table covering the
HTML-report long tail (HTML, CSS, JS, images, fonts, video, JSON, etc.); the
fallback is `application/octet-stream`.

**Path-traversal guard.** `src/server/preview/path-guard.ts::resolveAssetPath`
rejects backslashes, NULs, absolute paths, and any descendant whose realpath
escapes the per-session mount. `400` from the guard becomes `403` to the
caller (traversal); `404` becomes `404`. There is no size guard at read
time — asset size is the agent's responsibility (see "Explicit asset
opt-in" above).

**Cache headers.** All responses set `Cache-Control: no-store` plus
`X-Content-Type-Options: nosniff`. Browser caching never gets between the
agent and the user.

**Auth fallback for testing.** The route accepts an admin bearer token via
`Authorization: Bearer …` or `?token=…`. Iframe loads always go through the
cookie path; the bearer fallback is for `curl` and SSE callers.

## Cookie auth

Single source of truth: `src/server/auth/cookie.ts`.

```
Set-Cookie: bobbit_session=<32-byte hex>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000
```

`Secure` is added outside localhost mode (the browser would discard a
`Secure` cookie on plain HTTP).

- **Storage:** `<stateDir>/auth-cookies.json` (`mode 0o600`, debounced
  flushes). Survives gateway restart.
- **Value:** opaque 32-byte hex, minted server-side. The bearer token is
  never embedded — the cookie can be revoked independently.
- **Issued:** by the API request guard the first time a Bearer-authenticated
  request lands without a valid cookie (`issueIfMissing`).
- **Verified:** `tryAuth(req, store)` reads the `bobbit_session` cookie and
  checks it against the store.
- **Localhost short-circuit:** the content route honours `isLocalhost: true`
  and skips the cookie check, matching legacy behaviour.
- **Sandbox tokens** keep their existing scoped allow-list and do **not**
  mint cookies. The content route refuses sandbox-scoped requests.

The Bearer-token-in-URL flow stays as a one-shot bootstrap (mobile links,
OAuth callback). It does not authenticate per-request UI traffic any more.

## SSE — `GET /api/sessions/:sid/preview-events`

Single source of truth: route block in `src/server/server.ts`, channel in
`src/server/preview/events.ts`, client in `src/app/preview-panel.ts`.

- `200 text/event-stream` with `Cache-Control: no-cache`, `Connection: keep-alive`,
  `X-Accel-Buffering: no`.
- Initial frame: `event: hello\ndata: {ts}`.
- Live frame: `event: preview-changed\ndata: {entry, mtime, url, path}` —
  emitted by `broadcastPreviewChanged()` after every successful
  `POST /api/preview/mount`. The full payload is forwarded verbatim so the
  client can seed `entry` and `mtime` without a follow-up fetch.
- **Bootstrap on connect:** if a mount already exists for the session, the
  handler emits one `preview-changed` event synchronously after subscribing.
  This closes the race where a `broadcastPreviewChanged()` fires between
  EventSource open and listener registration. The bootstrap shape is
  identical to a live event, so the client doesn't distinguish them.
- 25 s `:keepalive` comments to defeat idle proxies.
- Cookie auth (or admin bearer); sandbox-token requests get `403`.

The client subscribes via the standard EventSource and bumps
`state.previewPanelMtime` on each `preview-changed` to force iframe reload.

## Mount endpoints

### `POST /api/preview/mount?sessionId=<sid>`

Accepts one of:

- `{ "html": "<…>", "entry"?: "report.html" }` — write inline. `entry` must
  be a single path segment. `assets`/`manifest` are not valid here and
  produce a `400`.
- `{ "file": "/abs/path/report.html", "assets"?: ["styles.css", "img/*.png"], "manifest"?: "preview-manifest.json" }`
  — copy entry plus declared assets (see below). `file` must be absolute
  and end in `.html` / `.htm`.

#### Explicit asset opt-in (`file` form)

Asset inclusion is **agent-driven** — the gateway never walks the parent
directory. `mountFile` copies *only* the named entry HTML, plus whatever
the caller explicitly declares via `assets[]` and/or a `manifest` file.
Undeclared siblings stay on the host filesystem and never enter the
per-session mount.

**Why explicit opt-in.** The original implementation BFS-walked the
parent directory of the entry file (capped at 25 MiB). This had two
problems:

- **Privacy / accidental exposure.** Anything sitting next to the entry
  HTML — drafts, `.env` files, uncommitted notes, other agents' work in
  progress — was copied into the mount and served over HTTP. The
  ergonomic default leaked sibling content.
- **Footgun on real worktrees.** Pointing `file` at an HTML report
  inside a project worktree typically tripped the 25 MiB cap and
  failed with `413`, forcing agents into ad-hoc workarounds like
  `cp report.html /tmp/x/`.

Making declaration explicit fixes both. The agent only copies what it
needs; the cap is no longer load-bearing and has been removed.

**Inline `assets[]`.** Each entry is a path relative to the entry
file's directory. Both literals and **single-segment** globs are
supported:

```json
{
  "file": "/.../report.html",
  "assets": ["styles.css", "logo.svg", "img/*.png", "chart.?.svg"]
}
```

**Manifest file.** `manifest` is a path (relative to the entry's
directory) pointing at a sibling JSON file of the form:

```json
{ "assets": ["styles.css", "img/*.png"] }
```

The manifest's array is concatenated with inline `assets[]` (de-duplicated
in order). Use whichever fits — they compose.

**Validation rules** (apply to both `assets[]` entries and the manifest's
resolved array, enforced in `mount.ts` and the path-guard):

| Rejected | Why |
|---|---|
| Absolute paths (`/etc/passwd`, `C:/...`) | Must be relative to the entry's directory |
| `..` segments | No escapes out of the entry directory |
| Backslash `\` | Forward-slash only; cross-platform consistency |
| NUL (`\0`) | Defence in depth against path smuggling |
| `**` recursive globs | Encourages over-broad inclusion |
| Character classes `[abc]` | Not implemented |
| Brace expansion `{a,b}` | Not implemented |
| Symlinks whose realpath escapes the entry directory | Realpath-based check, returns `403` |

Single-segment `*` and `?` globs match within one path segment only —
`img/*.png` matches `img/foo.png` but not `img/sub/foo.png`.

**Error matrix:**

| Status | When |
|---|---|
| `400` | invalid sessionId, missing body, bad entry, non-absolute `file` path, `file` not `.html`/`.htm`, `html` not a string, `assets`/`manifest` passed alongside `html`, non-string `assets[]` entry, invalid asset path (absolute / `..` / `\` / `\0` / `**` / `[...]` / `{a,b}`), manifest JSON parse error, manifest missing `assets[]` array |
| `403` | sandbox out of scope; symlink whose realpath escapes the entry's source directory |
| `404` | source `file` missing or not a regular file; `manifest` file missing; **literal** asset missing (a glob with zero matches is *not* an error) |
| `500` | unexpected copy failure |

**Response shape.** Returns `200` with:

```json
{
  "url":   "/preview/3f2c…/report.html",
  "path":  "C:/Users/.../bobbit/state/preview/3f2c…/report.html",
  "entry": "report.html",
  "mtime": 1775853741666,
  "assets": ["img/chart.png", "styles.css"]
}
```

The `assets[]` field is echoed back only on the `file` form, sorted, and
contains the resolved relative paths actually copied (after glob
expansion and de-duplication). The inline `html` form omits it. Renderer
reopen flows can round-trip this list back into a follow-up
`POST /api/preview/mount` to re-stamp the same mount.

After every success the server calls `broadcastPreviewChanged(sessionId, …)`
to fan out a `preview-changed` SSE event to every subscribed tab.

### `GET /api/preview/mount?sessionId=<sid>`

Bootstrap probe used by the panel after session-select. Returns the same
`{ url, path, entry, mtime }` shape as the `POST`, or `404 { error: "no
preview mount" }` when the mount is missing or empty. Resolves the entry via
the same `pickEntry()` helper the content route uses.

## Snapshot v3 marker

Single source of truth: `defaults/tools/html/snapshot.ts`.

The `preview_open` tool stamps the result with a constant-size marker block:

```
__preview_snapshot_v3__
{"kind":"preview","url":"/preview/<sid>/<entry>","path":"<host-abs>"}
```

≤ 250 bytes per block, regardless of HTML size. The renderer parses the
marker via `parseSnapshot()` and uses `url` / `path` to drive the **Open**
button on archived tool cards.

**Legacy markers** are preserved in the parser **only** for archived
sessions:

| Marker | Payload | Renderer behaviour |
|---|---|---|
| `__preview_snapshot_v1__` | raw inline HTML | Reopen via `POST /api/preview/mount {html}` |
| `__preview_snapshot_v2__` | `{kind:"file",path}` | Reopen via `POST /api/preview/mount {file}` |
| `__preview_snapshot_v3__` | `{kind:"preview",url,path}` | Mount already populated; SSE will deliver the entry |

The v1/v2 builder functions have been deleted — no new code path emits them.
The marker constants are tagged `Read-only legacy support … Do not extend`
in both `snapshot.ts` and `PreviewRenderer.ts`. Reopen flows for v1/v2 in
`PreviewRenderer.ts::onClick` route through the unified mount endpoint, so
WP-G's deletion of `/api/preview/render` and `/api/preview/asset` doesn't
break old archived sessions.

## Sandbox integration

Single source of truth: `src/server/agent/docker-args.ts`.

Per-container bind mounts:

| Container shape | Host path | Container path |
|---|---|---|
| Per-session container (`sessionId`, no `projectId`) | `<stateDir>/preview/<sid>/` | `/bobbit/preview` |
| Per-project container (`projectId` set) | `<stateDir>/preview/` | `/bobbit/preview-root` |

In the per-project case, every session sharing the long-lived container
resolves its own subtree via `BOBBIT_SESSION_ID`.

The agent does **not** translate paths. It always POSTs to
`/api/preview/mount` and the gateway resolves filesystem paths host-side.
The bind mount exists only for symmetry — so any in-container tool reading
back the preview tree sees the same bytes the gateway just wrote.

## File-by-file map

| File | Responsibility |
|---|---|
| `src/server/preview/mount.ts` | Per-session mount lifecycle, atomic writes, `mountFile` (explicit asset opt-in), watcher |
| `src/server/preview/content-route.ts` | `/preview/<sid>/<rel>` handler, entry pick, `<base>` + bridge injection |
| `src/server/preview/path-guard.ts` | Path-traversal defence (realpath-based) |
| `src/server/preview/mime.ts` | MIME-type lookup |
| `src/server/preview/events.ts` | Per-session `preview-changed` channel |
| `src/server/auth/cookie.ts` | `bobbit_session` cookie issuance + verification, on-disk store |
| `src/server/server.ts` | `POST/GET /api/preview/mount`, SSE route, broadcast on success |
| `src/server/agent/docker-args.ts` | Sandbox bind mounts (`/bobbit/preview`, `/bobbit/preview-root`) |
| `src/shared/preview-bridge-scripts.ts` | Theme/swipe bridge scripts injected into HTML responses |
| `defaults/tools/html/extension.ts` | `preview_open` tool — POSTs to `/api/preview/mount`, stamps v3 marker |
| `defaults/tools/html/snapshot.ts` | Marker constants, `buildPreviewSnapshotV3Block`, `parseSnapshot` |
| `src/ui/tools/renderers/PreviewRenderer.ts` | Open button on tool cards; v1/v2/v3 dispatch |
| `src/app/preview-panel.ts` | EventSource subscription, mount bootstrap, mtime bump |

## Acceptance properties

- Tool result is constant ~150 bytes regardless of HTML size — no HTML in the
  conversation transcript.
- Iframe link clicks navigate inside the preview origin; assets resolve via
  `<base href="/preview/<sid>/">`.
- "Open in new tab" works because the cookie has `Path=/`.
- Edits to the mount fan out via SSE within ~50 ms (debounce window in
  `watchMount`).
- Archived sessions with v1 / v2 markers continue to render an Open button
  that re-stamps the mount via `POST /api/preview/mount`.
