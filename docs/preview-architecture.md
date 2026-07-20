# Embedded HTML preview — architecture

The preview side-panel renders agent-authored HTML alongside the chat. This
document covers the v3 architecture introduced by the embedded-html-preview
rewrite — a per-session content mount served from a cookie-authed origin path,
with SSE-driven hot reload. The browser renders that mount inside the dynamic
per-session side-panel workspace shared by regular and assistant sessions.

## Mental model

Five pieces, one mount, one URL shape:

1. **Per-session mount on disk** — `<bobbitStateDir>/preview/<sid>/` holds the
   entry HTML and any sibling assets (images, CSS, video, …). Single source of
   truth for rendered bytes.
2. **Content origin** — the gateway serves the mount at `/preview/<sid>/<path>`.
   Same shape for the iframe `src`, the "Open in new tab" button, and any link
   the user clicks inside the preview.
3. **Cookie auth** — stateless signed `bobbit_session` HttpOnly cookie issued
   only by a qualifying browser-signaled API bootstrap or seven-day renewal.
   iframe loads, link navigation, and new-tab opens all carry the cookie
   automatically; no token-in-URL hacks.
4. **SSE hot reload** — `GET /api/sessions/:sid/preview-events` streams a
   `preview-changed` event whenever the gateway repopulates the mount. The panel
   bumps `#mtime=<n>` on the iframe `src` to force a reload.
5. **Server-backed workspace tab** — successful mount/open events persist the
   active preview tab identity and small render metadata. This is what restores
   the side-panel tab after a gateway restart; the mount/artifact files still
   serve the bytes.

Every populated mount also has a `contentHash`: a lowercase SHA-256 identity for
that mounted preview tree. The hash represents rendered content identity, not a
workspace-tab id or a host filesystem path. `POST /api/preview/mount`,
`GET /api/preview/mount`, and both bootstrap and live `preview-changed` SSE
events carry it so the UI can collapse duplicate preview artifacts that have the
same bytes.

Old paths and concepts that are gone:

- `<stateDir>/preview-<sid>.html` (single inline file)
- `<stateDir>/preview-<sid>.meta.json` (file-mode sidecar)
- `BOBBIT_HOST_CWD` translation in the `preview_open` extension
- `/api/preview/render` and `/api/preview/asset` routes

## Side-panel workspace integration

The UI treats the side pane as a server-backed Chrome-style tab strip beside the
chat (never above it). The shared strip can hold HTML preview, proposal, review,
pack/PR-walkthrough, artifact-viewer, and inbox tabs at the same time. Chat is
**not** a tab — there is no `chat` side-pane id, no Chat pill in the strip, and
the side pane hides entirely when a non-staff session has no side-pane tabs.

The side-panel workspace is authoritative for whether a preview tab is open. A
preview mount, immutable artifact, bootstrap response, or SSE event may update
content caches, but it must not resurrect a closed tab. Explicit preview tool
mount/open events and historical preview-card Open buttons create or focus tabs;
bootstrap and SSE updates patch only already-open tabs when they are not an
explicit open. After a gateway restart, the client renders the active preview
iframe from the hydrated server workspace tab, not from transient preview mirrors
or mount discovery. Full workspace rules live in
[`side-panel-workspace.md`](./side-panel-workspace.md).

Preview tab identity:

- The **current** preview tab for a filename is
  `preview:entry:<encoded-filename>`. Label is unversioned (e.g.
  `report.html`). Every `preview_open` for that filename updates this
  tab in place — no duplicate, no reorder. SSE `preview-changed` updates
  it the same way.
- **Historical** preview tabs are `preview:entry:<encoded-filename>:v:<N>`.
  Label is `report.html (vN)`. One per distinct past content version of
  that filename. Versions are per-filename and assigned in chronological
  content order (see
  [`PreviewVersionRecord`](./design/side-panel-tab-contract.md#42-version-assignment)).
- The live mount carries `contentHash`. When a v3 historical card's hash
  matches the current filename tab's hash, the workspace **collapses**
  to the current tab — no duplicate, no unnecessary remount. When hashes
  differ, the historical `:v:N` tab opens beside the current tab.
- Legacy v1/v2 markers (archived sessions) stay historical even when
  their remount response includes `contentHash`. Only v3 markers opt
  into same-content collapse.
- Desktop renders the strip horizontally; mobile renders the same tab
  set in the slide-pane header. There is no desktop-only preview
  capability.

Reopen failures stay local to the tab/card: missing file snapshots
disable with "File no longer available", parse or fetch errors leave the
button retryable and log `[PreviewRenderer] reopen failed`, and
background tab-remount failures log `[panel-workspace] preview tab
restore failed` without changing preview serving semantics.

### Immutable preview artifacts

A live preview mount (`<stateDir>/preview/<sid>/`) is mutable: every
`preview_open` overwrites it, and `preview_open(file=…)` mutates a file
on the host that the user may then edit out from under us. To make
"reopen this old `preview_open` card and see what was mounted *then*"
work, every successful mount is also captured into an immutable
artifact store at `<stateDir>/preview-artifacts/<sid>/<artifactId>/`.
Source of truth: `src/server/preview/artifacts.ts`.

What the store records:

```
<stateDir>/preview-artifacts/<sid>/<artifactId>/
    artifact.json       ← { artifactId, sessionId, entry, contentHash, files[], mtime, createdAt }
    mount/              ← byte-identical copy of the live mount tree
        report.html
        styles.css
        img/chart.png
```

- `artifactId` is 6 URL-safe random bytes (8 chars) — small enough to
  fit inside the 250-byte v3 marker cap while preserving 48 bits of
  entropy.
- `persistPreviewArtifact` re-hashes the staged copy and verifies the
  entry is present before committing the rename. A captured artifact is
  byte-identical to what was mounted at that moment.
- `findPreviewArtifactByHash(sessionId, contentHash)` deduplicates: a
  repeated mount of identical content reuses the existing artifact id.
- `removeArtifacts(sessionId)` runs when a session is purged.
  `sweepOrphanArtifacts(knownSessionIds)` is the explicit maintenance
  helper for removing artifact dirs whose session is gone.

New endpoint:

| Route | Behaviour |
|---|---|
| `POST /api/preview/artifacts/<artifactId>/restore?sessionId=<sid>` | `restorePreviewArtifact` rehydrates the named artifact into the single live mount and fires `broadcastPreviewChanged` so SSE subscribers see the restored content. Validation and staging happen before the live mount is touched, so missing / wrong-session / corrupt artifacts cannot alias to current content. Body may include `{ artifactId }` for symmetry but must match the route. |
| `GET /preview/<sid>/_artifact/<artifactId>/<rel-path>` | Direct read from the per-artifact mount directory. Bypasses the single live mount slot, so switching between artifact-backed preview tabs is a pure iframe `src` change — no POST round-trip, no iframe blanking, no mount swap. Same `<base>` + theme-snapshot + bridge-script rewrites as `/preview/<sid>/...` (the base href is the artifact-prefixed path). Authoritative dir: `artifactMountDir(sid, artifactId)`. |

Mount-endpoint extensions:

- `POST /api/preview/mount` with `{ artifactId }` is an alternative
  restore entry point that cannot be combined with `html` / `file` /
  `assets` / `manifest`.
- `POST /api/preview/mount` with `html` / `file` returns
  `artifactId` alongside the existing response fields. The mount is
  captured into the store atomically with the broadcast.
- `GET /api/preview/mount` looks up the artifact whose `contentHash`
  matches the current mounted content and includes that `artifactId`.
- SSE `preview-changed` events (bootstrap and live) include `artifactId`
  whenever a known artifact matches the broadcast `contentHash`.

The live mount stays single — the artifact store is an additional
immutable restore source, not a second live mount.

For artifact-backed preview tabs, the client now uses the per-artifact
URL (`/preview/<sid>/_artifact/<artifactId>/<entry>`) directly instead of
restoring into the live mount. This is what powers instant switching
between multiple preview tabs without re-mounting on every click. The
active tab's `artifactId` is read off the panel-tab itself, not mirrored
into global state, so SSE / bootstrap updates of `state.previewPanelEntry`
can never desync the iframe `src` from the visible tab. The live mount
slot remains the source for tabs without an `artifactId` (assistant /
live preview).

### Reopen-tab decision flow

When the user clicks **Open** on a historical `preview_open` tool card
(`src/ui/tools/renderers/PreviewRenderer.ts`):

| Marker shape | Restore source | Tab behaviour |
|---|---|---|
| v3 with `artifactId` | `POST /api/preview/artifacts/<id>/restore` | Always restorable. If `contentHash` matches the current filename tab, collapse to it; otherwise open / select `preview:entry:<file>:v:N`. |
| v3 without `artifactId`, with `html` / `file` original params | `POST /api/preview/mount {html\|file}` | Remount the original; the POST response's `artifactId` and `contentHash` are attached to the tab. Same collapse rule. |
| v3 without `artifactId` and no remount body | None (recorded entry / mtime / url) | Select the recorded entry; iframe points at the existing mount path. Best-effort. |
| Legacy v1 / v2 | `POST /api/preview/mount {html\|file}` | Stays historical even when the response includes `contentHash`. |

### Restart restore

A successful `POST /api/preview/mount` opens or updates the current preview
workspace tab unless the caller opts out with `workspaceTab: false`,
`openWorkspaceTab: false`, or an internal restore flag. The tab persists enough
small metadata to render after restart:

- source identity: `entry`, `contentHash`, `path`, `url`, and `artifactId` when a
  matching artifact exists;
- tab state: `entry`, `mtime`, `path`, `url`, `contentHash`, `artifactId`, and
  `origin: "preview-mount"`;
- workspace state: tab id/order and `activeTabId`.

On gateway restart, `sidePanelWorkspace` is loaded with the session. When the
browser reloads or returns to the session, the side-panel shell renders the
active preview tab and the iframe derives `entry`, `mtime`, and `artifactId` from
that tab before transient preview mirrors are repopulated. Live tabs point at
`/preview/<sid>/<entry>?mtime=<n>`; artifact-backed historical tabs point at
`/preview/<sid>/_artifact/<artifactId>/<entry>?mtime=<n>`.

Bootstrap (`GET /api/preview/mount`) and `preview-changed` SSE metadata may later
refresh already-open tabs, but they are not tab-creation sources. If the user
closed the preview tab before restart, the persisted workspace has no preview
tab, so reload/reconnect/bootstrap must leave the side panel closed until a new
explicit `preview_open` / mount event or historical-card **Open** action occurs.

The preview header follows the same restore source as the iframe. Its controls
are visible when the active workspace tab has preview metadata, even if the
transient preview mirrors have not been repopulated yet. This keeps direct
navigation/reload behavior consistent: the restored iframe, **Open preview in new
tab**, and **Refresh preview** all appear immediately from the persisted tab. The
new-tab action uses the tab-derived preview URL, so live and artifact-backed tabs
open the same URL the iframe is showing. Refresh remains a local cache-buster: it
bumps the preview mtime used in the iframe URL, but it does not create a tab or
revive one the user closed.

Pinned by `tests/e2e/ui/preview-durable-restart.spec.ts`, including the
regression that the refresh button is visible immediately after restoring an
active preview tab.

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

Sources of truth: `src/server/auth/cookie.ts` (wire format and in-memory
signing/verification), `src/server/auth/cookie-signing-key.ts` (startup-only
key persistence), and `src/server/auth/browser-cookie.ts` (central issuance
eligibility).

```
Set-Cookie: bobbit_session=v1.<iat>.<exp>.<nonce>.<signature>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000
```

The signed ASCII value has these canonical fields:

- `iat` and `exp` are unsigned base-10 Unix seconds represented as safe
  integers. The signer sets `exp = iat + 2592000` (30 days).
- `nonce` is exactly 16 random bytes encoded as canonical unpadded base64url.
- `signature` is the canonical unpadded base64url encoding of the 32-byte
  HMAC-SHA-256 tag over the exact ASCII prefix
  `v1.<iat>.<exp>.<nonce>`.

Verification rejects unsupported versions, malformed or non-canonical fields,
a changed key, a bad signature, non-positive or over-30-day lifetimes, an `iat`
more than five minutes in the future, and expiry at `now >= exp`. Parsing and
verification use bounded work and memory. The signature comparison uses
fixed-size buffers and `timingSafeEqual`; request authentication performs no
filesystem I/O. `Secure` is added outside localhost HTTP mode because a browser
would discard it on plain localhost HTTP.

Only the stable, exact 32-byte signing key is persisted at
`<serverSecretsDir>/cookie-signing-key`. The loader creates or reads it once
while the gateway starts, before request handling, and then passes an in-memory
copy to the signer/verifier. Reusing that key keeps signed cookies valid across
gateway restarts. On platforms with Unix permission semantics, the file is
`0o600` and the secrets directory is `0o700`. Safe first publication
uses a fully written, fsynced same-directory temporary file and a
create-if-absent hard link, so concurrent gateway starts converge on one
complete key. An unreadable, malformed, or non-regular existing key stops
startup rather than being silently replaced. The admin Bearer token is never a
key or payload field.

Any `<stateDir>/auth-cookies.json` is retired legacy data. The gateway never
opens, reads, parses, stats, migrates, prunes, rewrites, or deletes it, so even a
large or corrupt copy cannot affect startup or request handling. A legacy
64-hex cookie is simply invalid. An existing UI tab self-heals when its next
otherwise eligible Bearer-authenticated API request replaces that value with a
signed cookie; the legacy file remains byte-for-byte untouched.

### Issuance eligibility

Cookie authentication and cookie issuance are separate decisions. A valid
signed cookie continues to authenticate supported API, preview content, and
preview SSE requests without Fetch Metadata. Only the decision to emit
`Set-Cookie` uses the central browser classifier after credential
authentication; the classifier neither grants nor changes route authorization.

Every issuing request must satisfy all of these metadata rules:

- Exactly one `Sec-Fetch-Site` value normalizes to `same-origin`.
- Exactly one `Sec-Fetch-Mode` value normalizes to `cors` or `same-origin`.
- A non-`GET` request has exactly one `Origin`. `GET` may omit it. When present,
  it must be one serialized `http:` or `https:` origin with no credentials,
  resource path, query, or fragment.
- With the built UI served directly, `Origin` must match the request origin
  derived from the actual TLS socket and validated `Host`, including its port.
  In Vite development, the preserved browser Origin may use a different port
  when both sides use the configured host, or when both sides are loopback
  aliases. Non-loopback HTTP is always rejected.
- `Forwarded` and `X-Forwarded-*` are not trusted because the gateway has no
  configured trusted-proxy boundary.

After those rules pass:

- **Bootstrap:** admin Bearer authentication or localhost-trusted
  authentication may replace an absent, invalid, or legacy cookie.
- **Renewal:** a valid signed-cookie-authenticated API request may receive one
  replacement when `exp - now <= 604800` (the inclusive seven-day window). A
  fresh cookie is not reissued on later requests.

The following are ineligible. The identity and route exclusions still win when
a request authenticates successfully and presents browser-shaped headers:

- Bearer-only traffic without the Fetch Metadata above;
- any request carrying `X-Bobbit-Session-Id`,
  `X-Bobbit-Spawning-Session`, or `X-Bobbit-Session-Secret`;
- any request presenting a sandbox token in an Authorization or `?token=`
  credential, including a mixed admin-plus-sandbox request;
- `/api/internal` and its descendants;
- `POST /api/sessions/:id/provider-hooks/before-prompt`,
  `POST /api/sessions/:id/provider-hooks/before-compact`,
  `GET /api/sessions/:id/google-code-assist/token`, and
  `POST /api/sessions/:id/tool-grant-request`;
- preview content under `/preview/...` and
  `GET /api/sessions/:id/preview-events`.

These exclusions prevent CLI, agent, sandbox, and callback volume from
creating browser state. They do not alter Bearer validation, session and
sandbox route guards, or preview authorization. Sandbox tokens keep their
existing scoped allow-list, while the preview content route refuses them.
Localhost content serving keeps its existing trusted-local authentication
short-circuit.

Fetch Metadata and Origin are spoofable issuance-routing signals, not a new
security boundary or proof of a human caller. A holder of the shared admin token
can deliberately make an otherwise eligible browser-shaped request and obtain
the weak operator cookie. The Bearer-token-in-URL flow remains a one-shot UI
credential bootstrap (mobile links, OAuth callback); it does not authenticate
per-request UI traffic, and a query token alone does not bypass cookie
eligibility. Cookies are not independently revocable because there is no
registry; rotating the signing key invalidates all signed cookies.

## SSE — `GET /api/sessions/:sid/preview-events`

Single source of truth: route block in `src/server/server.ts`, channel in
`src/server/preview/events.ts`, client in `src/app/preview-panel.ts`.

- `200 text/event-stream` with `Cache-Control: no-cache`, `Connection: keep-alive`,
  `X-Accel-Buffering: no`.
- Initial frame: `event: hello\ndata: {ts}`.
- Live frame: `event: preview-changed\ndata: {entry, mtime, url, path, contentHash}` —
  emitted by `broadcastPreviewChanged()` after every successful
  `POST /api/preview/mount`. The full payload is forwarded verbatim so the
  client can seed `entry`, `mtime`, and content identity without a follow-up
  fetch. SSE does not include `relPath`; only the mount REST responses do.
- **Bootstrap on connect:** if a mount already exists for the session, the
  handler emits one `preview-changed` event synchronously after subscribing.
  This closes the race where a `broadcastPreviewChanged()` fires between
  EventSource open and listener registration. The bootstrap shape is
  identical to a live event, including `contentHash`, so the client doesn't
  distinguish bootstrap from live events.
- 25 s `:keepalive` comments to defeat idle proxies.
- Cookie auth (or admin bearer); sandbox-token requests get `403`.

The client subscribes via the standard EventSource, records
`state.previewPanelContentHash`, and bumps `state.previewPanelMtime` on each
`preview-changed` to force iframe reload. Preview-tab selection uses the hash to
collapse matching live/historical artifacts.

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
  "url": "/preview/3f2c…/report.html",
  "path": "C:/Users/.../bobbit/state/preview/3f2c…/report.html",
  "relPath": "3f2c…/report.html",
  "entry": "report.html",
  "mtime": 1775853741666,
  "contentHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "assets": ["img/chart.png", "styles.css"]
}
```

The `relPath` field is the host-invariant `<sessionId>/<entry>` identifier used
by new v3 snapshot blocks. `contentHash` is the mounted preview-tree SHA-256
identity used by the workspace for same-content collapse. The `assets[]` field
is echoed back only on the `file` form, sorted, and contains the resolved
relative paths actually copied (after glob expansion and de-duplication). The
inline `html` form omits it. Renderer reopen flows can round-trip this list back
into a follow-up `POST /api/preview/mount` to re-stamp the same mount.

After every success the server calls `broadcastPreviewChanged(sessionId, …)`
with `{entry, mtime, url, path, contentHash}` to fan out a `preview-changed` SSE
event to every subscribed tab.

### `GET /api/preview/mount?sessionId=<sid>`

Bootstrap probe used by the panel after session-select. Returns the same
`{ url, path, relPath, entry, mtime, contentHash }` shape as the `POST`, or
`404 { error: "no preview mount" }` when the mount is missing or empty. Resolves
the entry via the same `pickEntry()` helper the content route uses.

## Snapshot v3 marker

Single source of truth: `defaults/tools/html/snapshot.ts`.

The `preview_open` tool stamps the result with a constant-size marker block.
The marker identifies the preview artifact for reopenable tool-card tabs; it
does not create a second server mount.

```
__preview_snapshot_v3__
{"kind":"preview","url":"/preview/<sid>/<entry>","path":"<sid>/<entry>","entry":"<entry>","contentHash":"<sha256>","artifactId":"<id>"}
```

≤ 250 bytes per block, regardless of HTML size. All of `entry`,
`contentHash`, and `artifactId` are **optional** — the builder
(`buildPreviewSnapshotV3Block`) tries progressively more compact
payloads (long URL with full path, short URL with `entry` filename as
`path`, alias keys like `aid` for `artifactId`) and emits whichever
complete variant still fits the 250-byte cap. If even the compact form
blows the cap, the builder falls back to the bare
`{kind, url, path}` payload without identity fields. The cap is fixed
by `tests/e2e/preview-token-cost.spec.ts` and must not be raised to
make room for larger payloads.

`artifactId` is what makes historical reopen byte-accurate after the
user has overwritten the original source file: the renderer prefers
`POST /api/preview/artifacts/<artifactId>/restore` over re-reading
`html` / `file` params. See ["Immutable preview artifacts"](#immutable-preview-artifacts)
for the store layout and validation contract.

The renderer parses the marker via `parseSnapshot()` and uses `url` /
`path`, optional `entry`, optional `contentHash`, optional `artifactId`,
and the original tool params to drive the **Open** button on tool
cards. Opening a card selects a source-derived preview tab immediately,
keyed by filename via `previewEntryTabId(entry)` / `previewVersionedTabId(entry, N)`.
The restore source preference is `artifactId` → original `html` / `file`
params → recorded entry/mtime (best-effort). When the marker omitted
`contentHash` to preserve the 250-byte cap, a successful remount `POST`
returns the hash; the renderer attaches it to the tab so same-content
collapse can still fire.

**`path` is host-invariant.** The field carries the project-root-relative
`<sessionId>/<entry>` identifier (forward slashes on every OS), not the
host-absolute path on disk. The single source of truth is
`MountResult.relPath` in `src/server/preview/mount.ts`; the agent tool in
`defaults/tools/html/extension.ts` prefers `relPath` over the legacy
host-absolute `path` when calling `buildPreviewSnapshotV3Block`. Bounding the
payload by content shape (rather than by where `bobbitStateDir()` happens to
live on disk) is what keeps the 250 B per-block cap holding on macOS
(`/private/var/folders/...`) and Windows E2E harness paths, even when the
optional `contentHash` fits. Archived sessions that recorded the legacy
host-absolute form still parse — `parseSnapshot` only requires a non-empty
string — but new blocks always use the relative form. Per-block size is pinned by
`tests/e2e/preview-token-cost.spec.ts`.

**Legacy markers** are preserved in the parser **only** for archived
sessions:

| Marker | Payload | Renderer behaviour |
|---|---|---|
| `__preview_snapshot_v1__` | raw inline HTML | Create/select a historical preview tab and remount via `POST /api/preview/mount {html}`; the tab stays historical (does not collapse into the current filename tab) even when the remount response includes `contentHash` or `artifactId` |
| `__preview_snapshot_v2__` | `{kind:"file",path}` | Create/select a historical preview tab and remount via `POST /api/preview/mount {file}`; same historical-only rule as v1 |
| `__preview_snapshot_v3__` | `{kind:"preview",url,path,entry?,contentHash?,artifactId?}` | Create/select a tab keyed by filename. Prefer `POST /api/preview/artifacts/<artifactId>/restore` when present, else remount from original `html`/`file` params, else select by recorded entry/mtime. Collapse to the current filename tab when `contentHash` already matches; otherwise open / select `preview:entry:<file>:v:N`. |

The v1/v2 builder functions have been deleted — no new code path emits them.
The marker constants are tagged `Read-only legacy support … Do not extend`
in both `snapshot.ts` and `PreviewRenderer.ts`. Reopen flows for v1/v2 in
`PreviewRenderer.ts::onClick` route through the unified mount endpoint, so
WP-G's deletion of `/api/preview/render` and `/api/preview/asset` doesn't
break old archived sessions. Those legacy flows preserve historical-tab
semantics even though the unified mount endpoint now returns `contentHash`.
Only v3 markers opt into live-tab collapse by content identity.

## Theme-token snapshot for standalone tabs

Single source of truth: `src/server/preview/theme-snapshot.ts`.

Every preview HTML response carries an inline `<style>` block of the host
app's theme tokens, injected into `<head>` alongside the `<base>` tag by
`injectBaseAndScripts()` in `content-route.ts` (the pure-string contract is
preserved — no HTML parser).

**Why.** The runtime theme bridge in `src/shared/preview-bridge-scripts.ts`
(`PREVIEW_THEME_BRIDGE`) reads CSS custom properties from
`parent.document.documentElement`. Inside the embedded panel iframe that
works; in a standalone tab opened via "Open in new tab", `parent === window`
and the preview document has no theme vars of its own, so every
`var(--background)` / `var(--chart-N)` resolved to empty and the page
rendered unstyled.

**How.** At server startup `theme-snapshot.ts` parses the `:root` and `.dark`
blocks of `src/ui/app.css` once, extracts every `--*` declaration, and caches
a ready-to-emit `<style data-bobbit-preview-theme="snapshot">…</style>`
string. `content-route.ts` injects this snapshot for every served HTML
response — the `data-bobbit-preview-theme="snapshot"` marker is the debugging
handle (open devtools → Elements → search the `<head>`).

**Two semantics, one mechanism:**

| Surface | Behaviour |
|---|---|
| Standalone tab (`parent === window`) | `PREVIEW_THEME_BRIDGE` early-returns. The inline snapshot governs — colours and fonts are fixed at the moment the request was served. Live host-app theme toggles do **not** propagate. This is an explicit, accepted trade: standalone tabs are snapshots. |
| Embedded panel iframe (`parent !== window`) | Snapshot supplies defaults; the bridge runs and live-mirrors the host-app's `documentElement` custom properties on every theme toggle. |

No per-request CSS parsing in the hot path — the snapshot string is built
once and reused for every response.

## Atomic-swap mount lifecycle

Single source of truth: `mountFile()` in `src/server/preview/mount.ts`.

**Why.** The previous flow was wipe-then-copy: `wipeContents(destRoot)` ran
before the entry copy. Any source path whose realpath resolved inside
`destRoot` (e.g. an agent re-opening a file the previous `preview_open`
call had materialised into the mount) was deleted before being read —
`fs.copyFileSync` then ENOENT'd, or the OS short-circuited same-inode
operations and threw "cannot copy a file onto itself". Wipe-then-copy also
left a half-empty mount visible to any `/preview/<sid>/<entry>` GET that
hit during the window between wipe and final copy.

**How.** Stage everything into a sibling tmp directory under
`previewRoot()` first, then atomically swap:

1. Create `<previewRoot>/.<sid>.tmp-<pid>-<ms>-<rand6>/`.
2. Resolve and copy the entry plus all declared `assets[]` (literals and
   single-segment globs) into the tmp dir. **All source data is read
   before `destRoot` is touched** — the same-mount-source race is gone.
3. On staging error: `rmSync(tmp, { recursive: true, force: true })` and
   leave `destRoot` untouched.
4. On success: `wipeContents(destRoot)` (see inode note below) followed
   by per-entry `renameSync` from tmp into `destRoot`. The tmp dir is
   removed once empty.

**Inode preservation.** The wipe step deliberately uses `wipeContents`
(remove the contents of `destRoot`) rather than `rmSync(destRoot)`
(remove the directory itself). The directory's inode survives, so the
long-lived `fs.watch` handle held by `watchMount()` keeps firing for SSE
consumers across mount swaps.

**`writeInline()` is unaffected.** It already writes the single entry to
a sibling tmp file and `renameSync`s into place — atomic by construction.

**SSE.** `broadcastPreviewChanged()` still fires on every successful
mount, including identical re-opens, so the iframe reload path (`?mtime=`
cache-buster) sees every call.

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
| `src/server/preview/mount.ts` | Per-session mount lifecycle, atomic writes, `mountFile` (explicit asset opt-in), `contentHash` calculation, watcher |
| `src/server/preview/content-route.ts` | `/preview/<sid>/<rel>` handler (live mount) and `/preview/<sid>/_artifact/<id>/<rel>` (per-artifact stable URL), entry pick, `<base>` + bridge injection |
| `src/server/preview/path-guard.ts` | Path-traversal defence (realpath-based) |
| `src/server/preview/mime.ts` | MIME-type lookup |
| `src/server/preview/events.ts` | Per-session `preview-changed` channel carrying mount identity payloads |
| `src/server/auth/cookie.ts` | Stateless `bobbit_session` v1 signing + constant-memory verification (no filesystem capability) |
| `src/server/auth/cookie-signing-key.ts` | Startup-only load/create of `<serverSecretsDir>/cookie-signing-key` |
| `src/server/auth/browser-cookie.ts` | Central browser bootstrap/renewal eligibility classifier |
| `src/server/server.ts` | `POST/GET /api/preview/mount`, SSE route, broadcast on success |
| `src/server/agent/docker-args.ts` | Sandbox bind mounts (`/bobbit/preview`, `/bobbit/preview-root`) |
| `src/shared/preview-bridge-scripts.ts` | Theme/swipe bridge scripts injected into HTML responses |
| `defaults/tools/html/extension.ts` | `preview_open` tool — POSTs to `/api/preview/mount`, stamps v3 marker with optional `contentHash` |
| `defaults/tools/html/snapshot.ts` | Marker constants, `buildPreviewSnapshotV3Block`, `parseSnapshot`, 250-byte v3 cap |
| `src/server/preview/artifacts.ts` | Immutable artifact store — capture, restore, hash-based dedupe, orphan sweep |
| `src/ui/tools/renderers/PreviewRenderer.ts` | Open button on tool cards; artifact restore → source remount → recorded-entry fallback; live-hash remount skip; filename-keyed tab dispatch |
| `src/shared/side-panel-workspace.ts` | Server/client workspace model shared by preview and other panel kinds |
| `src/app/side-panel-workspace.ts` | Server hydrate/mutate controller, optimistic in-memory updates, localStorage migration, popout URL helper |
| `src/app/panel-workspace.ts` | Preview/proposal/review/pack tab id helpers and per-filename preview version ledger; file-fixture fallback only |
| `src/app/preview-panel.ts` | EventSource subscription, mount bootstrap, explicit preview tab open/update, older-version-rehydration guard |
| `src/app/render.ts` | Shared side-panel shell, tab strip, mobile slider, shared controls, active-content lookup by server workspace tab id |

## Acceptance properties

- Tool result is constant ≤250 bytes regardless of HTML size — no HTML in the
  conversation transcript. Optional v3 `entry`, `contentHash`, and
  `artifactId` fields are omitted (or compacted via the builder's progressive
  fallback) rather than raising the cap.
- Mount `POST` / `GET` responses and bootstrap/live `preview-changed` SSE events
  expose a 64-hex `contentHash` for the current mounted preview tree, plus an
  `artifactId` when a captured artifact matches the current content.
- Every successful `POST /api/preview/mount` (html or file form) atomically
  captures the mounted bytes into an immutable artifact under
  `<stateDir>/preview-artifacts/<sid>/`.
- `POST /api/preview/artifacts/<artifactId>/restore` rehydrates the named
  artifact into the single live mount, validates and stages before touching the
  live mount, and rolls back on failure.
- Iframe link clicks navigate inside the preview origin; assets resolve via
  `<base href="/preview/<sid>/">`.
- "Open in new tab" works because the cookie has `Path=/`.
- Edits to the mount fan out via SSE within ~50 ms (debounce window in
  `watchMount`).
- The side-pane tab strip never contains a Chat pill; chat is rendered outside
  the strip (see [`side-panel-workspace.md`](./side-panel-workspace.md)).
- The current preview tab for a filename is updated in place by explicit
  preview open events; bootstrap/SSE metadata updates patch only already-open
  tabs and do not resurrect closed tabs.
- Opening a historical v3 card whose `contentHash` matches the current
  filename tab collapses to that tab and skips the remount POST; otherwise it
  opens `preview:entry:<file>:v:N` keyed off the per-filename version ledger.
- Historical artifacts with different `contentHash` values remain separate
  and independently restorable through the one live server mount.
- Archived sessions with v1 / v2 markers continue to render an Open button that
  re-stamps the mount via `POST /api/preview/mount` but stays historical even
  when that response includes `contentHash` or `artifactId`.
