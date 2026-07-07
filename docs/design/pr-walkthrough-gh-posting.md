# PR Walkthrough — Post via local `gh` + trust-prompt unknown remote hosts

Status: design (implement from this doc). Goal: **PR Walkthrough gh Posting** (items 4a + 4b).

This design makes the PR Walkthrough able to **post review comments to a real PR by
shelling out to the local `gh` CLI on the gateway host** (4a), and to **prompt the user
to trust an unknown git-remote domain when a walkthrough is launched** instead of
silently failing later (4b).

Scope (as constrained by the goal): `src/server/pr-walkthrough/` (`routes.ts`,
`github-adapter.ts`, `export-mapper.ts`), the pack panel client
(`market-packs/pr-walkthrough/{src,lib}/panel.js`) and pack `run`/`submit` routes
(`market-packs/pr-walkthrough/lib/routes.mjs`), the client launch flow
(`src/app/pack-entrypoints.ts`, a new `src/app/pr-walkthrough-trust.ts`), and tests.
No changes to the Host API contract, `src/shared/extension-host/*`, or the marketplace.

---

## 0. Background — the three moving parts

Two orthogonal properties gate posting today; keeping them separate is the crux of the
whole design:

| Property | Question | Needs | Where it can run |
| --- | --- | --- | --- |
| **Auth availability** | Is `gh` (or an env token) *authenticated* for the host? | `gh auth token [--hostname]` (or `GITHUB_TOKEN`/`GH_TOKEN`) — **no gateway prefs** | anywhere with `gh` on PATH (server route **or** confined worker) |
| **Host trust** | Is the host *allowed* to be contacted? | the `githubTrustedHosts` preference | **server only** (`deps.preferencesStore`) |
| **The POST itself** | Actually create the review | `gh` + a trusted host | server-side, behind the trust gate |

The confined pack worker (`routes.mjs`) already shells out to `git`/`gh` (see
`resolveCurrentBranchTarget`), so it *can* compute **auth availability**. It **cannot**
read `githubTrustedHosts`, so **host-trust enforcement and the trust-gated POST stay
server-side** — mirroring the existing `assertTrustedBindingTarget`
(`src/server/pr-walkthrough/routes.ts`).

Relevant anchors (current tree):
- `github-adapter.ts`: `resolveGithubToken` (env → `gh auth token`), `githubCliAuthToken`
  (`gh auth token [--hostname]`, honours `BOBBIT_GH_COMMAND`), `resolveGithubPr` sets
  `exportAvailable = Boolean(token)` and the `"Set GITHUB_TOKEN or GH_TOKEN…"` reason.
- `export-mapper.ts`: `submitGithubReview` (POSTs via `fetch` with a bearer token),
  `createGithubReviewPayload`, `buildGithubReviewPreview`.
- `routes.ts`: `submitExport` (gates on `export.available === true`), `resolveWalkthrough`
  and `resolveDiffForBindingTarget` (both hardcode `export:{available:false,previewOnly:true}`
  for the with-SHA GitHub path), `assertTrustedBindingTarget`, `bindingTargetHost`,
  `verifyCallerSession`, `resolvePrwReviewerBinding`, the internal `submit-yaml`/`bundle`
  binding-routed routes.
- `routes.mjs` (worker): `run` → `resolveCurrentBranchTarget`/`canonicalizeTarget`
  (sets `target.host`) → `launchReviewer`; `bundle`; `status`; `recover`.
- `url-safety.ts`: `DEFAULT_TRUSTED_HOSTS`, `isTrustedExternalHost`, `normalizeTrustedHost`,
  `normalizeTrustedHosts`.
- client: `pack-entrypoints.ts::runSpawnLauncher` (single spawn-dispatch chokepoint),
  `settings-page.ts::persistGithubTrustedHosts`/`addTrustedHost` (PUT `/api/preferences`).

---

## Item 4a — Post review comments via local `gh`

### 4a.1 `github-adapter.ts` — one auth resolver, gh-aware availability, honest reason

`resolveGithubToken` already tries env tokens (github.com only) then falls through to
`githubCliAuthToken` — so **`export.available` is already gh-aware**. Two fixes:

1. **Refactor the token cascade into a reusable, exported availability helper** so
   `routes.ts` can reuse the exact same logic (single source of truth):

   ```ts
   // github-adapter.ts (exported)
   export const GITHUB_EXPORT_NEEDS_AUTH_REASON =
     "No GitHub credentials found. Run `gh auth login` (or set GITHUB_TOKEN/GH_TOKEN) to post a review.";

   export interface GithubExportAuth { token?: string; available: boolean; reason?: string }

   /** Resolve the credential AND the availability/reason for posting to `host`.
    *  Reuses the env→gh cascade (explicit token → GITHUB_TOKEN/GH_TOKEN for github.com →
    *  `gh auth token --hostname`). Never forwards the github.com env token to an
    *  enterprise host (unchanged invariant). */
   export async function resolveGithubExportAuth(
     options: { cwd?: string; token?: string }, host: string,
   ): Promise<GithubExportAuth> {
     const token = await resolveGithubToken(options, host);   // existing private fn, unchanged
     return token
       ? { token, available: true }
       : { available: false, reason: GITHUB_EXPORT_NEEDS_AUTH_REASON };
   }
   ```

   Keep `resolveGithubToken` private and unchanged; `resolveGithubExportAuth` wraps it.

2. **`resolveGithubPr`** — keep `exportAvailable = Boolean(token)` (already gh-aware) but
   swap the reason to the new constant:

   ```ts
   // was: reason: exportAvailable ? undefined : "Set GITHUB_TOKEN or GH_TOKEN to submit a review back to GitHub.",
   reason: exportAvailable ? undefined : GITHUB_EXPORT_NEEDS_AUTH_REASON,
   ```

No other adapter changes; the `resolveGithubToken` enterprise-scoping invariant
(never forward the github.com env token to another host) is preserved by reuse.

### 4a.2 `routes.ts` — with-SHA GitHub paths report real availability (no blanket `previewOnly`)

Both with-SHA GitHub resolution paths currently deny submission unconditionally. Replace
the hardcoded denial with the shared availability helper. **Auth availability does not
need prefs**, so this is safe to run in the server route (it also already has `cwd`).

**`resolveDiffForBindingTarget` (with-SHA github branch):**

```ts
// derive the host from the shared helper (see below); "github.com" fallback
const host = hostFromTarget(target) ?? "github.com";
const auth = await resolveGithubExportAuth({ cwd }, host);
return {
  changeset: { ...resolved.changeset, provider: "github", externalUrl: target.prUrl, prUrl: target.prUrl,
               prNumber: target.number, prTitle, prBody, ...(prTitle ? { title } : {}) },
  files: resolved.files,
  warnings: resolved.warnings,
  limits: resolved.limits as ...,
  export: { provider: "github", available: auth.available, ...(auth.reason ? { reason: auth.reason } : {}) },
  // NOTE: previewOnly removed.
};
```

**`resolveWalkthrough` (with-SHA github branch, the `/api/pr-walkthrough/resolve` route):**
apply the same change — compute `auth = await resolveGithubExportAuth({ cwd }, host)` from
`gh?.host ?? "github.com"`, set `export: { provider:"github", available: auth.available,
...(auth.reason?{reason:auth.reason}:{}) }`, and **remove `previewOnly: true`**.

**Do NOT introduce a parallel `normalizeGithubHostFromTarget`** (finding: duplicate host
semantics risk divergence). Instead **extract the host-derivation already inside
`bindingTargetHost(target)`** (routes.ts ~1224 — normalized `target.host`, else parsed from
`target.prUrl`) into a shared `hostFromTarget(target): string | undefined`, and have
`bindingTargetHost` call it. Reuse `hostFromTarget` in `resolveDiffForBindingTarget`,
`resolveWalkthrough` (via `gh?.host`), the new submit route, and `submitExport`, so all host
derivation stays single-source.

The no-SHA path (`resolveGithubPr`) is already correct after 4a.1.

Export a testing hook next to the existing `resolveAndReadBindingBundleForTesting`:

```ts
export const resolveDiffForBindingTargetForTesting = resolveDiffForBindingTarget;
```

**Latency caveat (design-review [low]).** `resolveDiffForBindingTarget` runs on every
`bundle` recompute; adding `await resolveGithubExportAuth({ cwd }, host)` there adds one
`gh auth token` subprocess per recompute. `gh auth token` is fast (~tens of ms) and this is
acceptable; if it ever shows up in profiling, memoize per `(host, cwd)` for a short TTL
(e.g. 30 s) inside the adapter. The pack `bundle` route computes availability separately via
its own in-worker `ghAuthAvailable` (below); the two are independent by design (worker has no
prefs) and both are advisory — the authoritative gate is the server submit route.

### 4a.3 `export-mapper.ts` — `submitGithubReview` posts through `gh`

`submitGithubReview` gains a `gh` POST path. **Decision: keep the `fetch` path when an
explicit or env token is available; otherwise post via `gh`.** Rationale:

- Backwards-compatible: every existing `submit*` test passes a `token`/env token and asserts
  the `fetch` URL + body — those stay green with **zero** test churn.
- Enterprise + gh-only github.com accounts have **no** env token, so they take the `gh`
  path (`gh` carries the host-scoped credential the user logged in with, incl. enterprise
  via `--hostname`). This satisfies "works for whatever host/account the user authenticated
  with `gh auth login`".
- `gh` is the fallback exactly where a raw bearer token would be missing — no behaviour
  regressions for token-configured callers.

```ts
export interface SubmitGithubReviewOptions {
  fetch?: FetchLike;
  apiBaseUrl?: string;
  token?: string;
  ghHost?: string;   // NEW: host for `gh --hostname` (omit/`github.com` → no flag)
  cwd?: string;      // NEW: git cwd for gh (server route worktree)
}
```

Body of `submitGithubReview` after the `confirm` + `target` guards:

```ts
const payload = createGithubReviewPayload(preview, confirmation.event ?? "COMMENT");
const token = cleanString(confirmation.token) ?? cleanString(options.token)
  ?? cleanString(process.env.GITHUB_TOKEN) ?? cleanString(process.env.GH_TOKEN);

if (token) {
  // ── existing fetch path (unchanged) ── (BOBBIT_TEST_NO_EXTERNAL guard stays here)
  ...
}

// ── no bearer token → post via local gh ──
return submitGithubReviewViaGh(payload, preview.target, {
  ghHost: cleanString(options.ghHost), cwd: cleanString(options.cwd), warnings: preview.warnings,
});
```

New helper (imports `execFileSafe` from `../exec-file-safe.js`, mirrors
`githubCliAuthToken`'s spawn options + `BOBBIT_GH_COMMAND`):

```ts
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function submitGithubReviewViaGh(
  payload: Record<string, unknown>,
  target: GithubReviewTarget,
  opts: { ghHost?: string; cwd?: string; warnings?: WalkthroughExportWarning[] },
): Promise<GithubReviewSubmitResult> {
  const command = cleanString(process.env.BOBBIT_GH_COMMAND) || "gh";
  const host = cleanString(opts.ghHost);
  const dir = await mkdtemp(join(tmpdir(), "bobbit-ghreview-"));
  const file = join(dir, "review.json");
  await writeFile(file, JSON.stringify(payload), "utf8");
  const args = ["api",
    `repos/${target.owner}/${target.repo}/pulls/${target.prNumber}/reviews`,
    "--method", "POST", "--input", file];
  if (host && host !== "github.com" && host !== "www.github.com") args.push("--hostname", host);
  try {
    const { stdout } = await execFileSafe(command, args, {
      cwd: opts.cwd, encoding: "utf8",
      timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      ...(process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command) ? { shell: true } : {}),
    });
    let json: unknown = {}; try { json = JSON.parse(stdout || "{}"); } catch { /* non-JSON success */ }
    return { ok: true, status: 200, submitted: true, message: "GitHub review submitted via gh.",
             reviewUrl: reviewUrlFromResponse(json), response: json, warnings: opts.warnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // gh missing / not authenticated → actionable auth reason; other failures → the gh stderr.
    const notAuthed = /not (?:logged in|authenticated)|no accounts|command not found|ENOENT/i.test(message);
    return { ok: false, status: notAuthed ? 401 : 502, submitted: false,
             message: notAuthed
               ? "GitHub review submission failed: run `gh auth login` to post reviews."
               : `GitHub review submission via gh failed: ${message}`,
             warnings: opts.warnings };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => { /* temp cleanup best-effort */ });
  }
}
```

Notes:
- **No `execFileSafe` change (RESOLVED design decision).** `execFileSafe` wraps
  `promisify(execFileCb)`, which returns only `{stdout,stderr}` and does **not** expose the
  child process — there is no `.stdin` to pipe to, and `child_process.execFile` has no
  built-in stdin mechanism. So the design uses the **temp-file** approach shown above:
  `mkdtemp` a dir, write `JSON.stringify(payload)` to `review.json`, invoke
  `gh api … --input <file>`, and `rm` the dir in a `finally`. `execFileSafe` stays untouched.
- The `BOBBIT_TEST_NO_EXTERNAL` guard stays on the **fetch** path only; the `gh` path never
  hits the network in tests because tests stub `BOBBIT_GH_COMMAND` with a fake `gh`.
- Local (non-GitHub) changesets are unreachable here (`preview.target` is undefined → the
  existing `"No GitHub pull request target…"` guard returns first). Unchanged.

### 4a.4 `routes.ts` — trust-gated, server-side submit for the pack flow

The existing REST `POST /api/pr-walkthrough/:id/export/submit` (→ `submitExport` →
`submitGithubReview`) serves the **standalone `/resolve`** flow; wire `gh` into it by
passing the host + cwd:

```ts
// submitExport(...)  — derive host from the stored changeset's prUrl/externalUrl
const host = hostFromUrl(payload.changeset.prUrl ?? payload.changeset.externalUrl); // undefined ⇒ github.com
return submitGithubReview(preview, { confirm: true, event: body.event },
                          { ghHost: host, cwd: body.cwd /* optional */ });
```

The **pack flow** needs a trust-gated submit the sandboxed panel can reach.

**Auth constraint (VERIFIED — resolves the design-review [high] finding):** the pack route
worker (`src/server/extension-host/module-host-worker.ts`, ~line 229) is a `worker_threads`
Worker created **with no `env` option — it inherits the GATEWAY process env, NOT the reviewer
session's env**. Therefore `process.env.BOBBIT_SESSION_SECRET` is *not* the reviewer's secret
in `routes.mjs`, and the session-secret-gated `/api/internal/*` routes (which use
`verifyCallerSession`) **cannot be authenticated from the worker**. (The reviewer's *agent*
tools in `extension.ts` do have the secret because they run in the agent process spawned by
`rpc-bridge.ts` with `-e BOBBIT_SESSION_SECRET=…`; the route worker is a different process.)

So add a **bearer-authenticated PUBLIC route** — same auth tier as the existing
`/api/pr-walkthrough/:id/export/submit`, which *already* posts to GitHub with only the
gateway bearer token — routed by **`jobId`** (which the worker legitimately holds from its own
binding). `verifyCallerSession` is documented in `routes.ts` as routing-only, not a security
boundary (single-user trust domain); jobId + the single-user bearer token are sufficient here,
and `assertTrustedBindingTarget` remains the real gate.

**`POST /api/pr-walkthrough/submit-review`**

```
body: { jobId: string, draft: PrWalkthroughReviewDraft, event?: GithubReviewEvent, confirm?: boolean, probe?: boolean }
```

Handler (in `handlePrWalkthroughApiRoute`, a public `/api/pr-walkthrough/…` branch):

1. `const jobId = stringValue(body.jobId);` → 400 if missing.
2. Resolve the **authoritative** binding + target from the pack store BY jobId (do **not**
   trust a caller-supplied target). Add a server helper `resolveBindingByJobId(store, jobId)`
   that lists `reviews/<jobId>/binding/*` (mirroring routes.mjs `authorizeReviewAccess`'s
   scoped-key scan) and returns the first binding carrying a `target`; else the legacy
   `binding/*` scan. → 404 `WALKTHROUGH_NOT_BOUND` if none.
3. **`if (!assertTrustedBindingTarget(binding, deps, fail)) return true;`** — the trust
   chokepoint (reads `githubTrustedHosts` via `deps.preferencesStore`). Only place trust is
   enforced for the pack post.
4. `if (binding.target?.provider !== "github")` → 400 `EXPORT_UNAVAILABLE`
   ("Local changesets can be previewed but not submitted to GitHub.").
5. `const host = hostFromTarget(binding.target);` (shared helper from §4a.2).
6. `const cwd = await resolveBindingCwd(deps, binding.parentSessionId ?? binding.childSessionId);`
   — `resolveBindingCwd` already exists (routes.ts ~1328).
7. **Probe mode** (`body.probe === true`): return
   `json(await resolveGithubExportAuth({ cwd }, host ?? "github.com"))` → `{ available, reason? }`.
   NOTE: the probe runs *after* the trust gate, so a **403 from probe means the host is
   UNTRUSTED** (a hard server error the panel surfaces distinctly) — not the soft
   `{ available:false }` "gh not authenticated" state. The panel treats a 403 as "needs trust"
   and a `{available:false,reason}` body as "needs `gh auth login`".
8. **Submit mode**: require `body.confirm === true` (else 400 `CONFIRMATION_REQUIRED`).
   - Cards + changeset: prefer the pack-stored finalized payload
     (`getPackStore().get(PRW_PACK_ID, prwFinalPayloadKey(jobId))` → `{ changeset, cards }`);
     else `resolveDiffForBindingTarget(binding.target, cwd, deps)` + `synthesizeFallbackCards`.
   - `const { buildGithubReviewPreview, submitGithubReview } = await optionalPrModule("export-mapper");`
   - `const preview = buildGithubReviewPreview(body.draft, cards, changeset);`
   - `const result = await submitGithubReview(preview, { confirm: true, event: body.event },
       { ghHost: host, cwd });`
   - `json(result, result.ok ? 200 : (typeof result.status === "number" ? result.status : 400));`

This runs `gh` **server-side** (via `submitGithubReview`'s gh path), behind
`assertTrustedBindingTarget` (prefs-backed) — exactly per the goal's "gh invocation and
trusted-host enforcement stay server-side". No session secret is needed.

### 4a.5 Pack worker (`routes.mjs`) — availability on `bundle`, proxy `submitReview`

The panel reads dynamic data only through `host.callRoute` (pack routes). Two additions:

- **`bundle` result carries `export`** so the panel can enable/label the button without a
  round trip. Availability needs no prefs, so compute it in-worker:

  ```js
  // in `bundle`, for a github target (finalAccess.binding?.target?.provider === "github"):
  const host = normalizeGithubHost(target.host) /* already inlined helper */;
  const available = await ghAuthAvailable(routeCwd(ctx), host); // `gh auth token [--hostname]` exit 0 & non-empty
  return { ...existing, export: { provider: "github", available,
           ...(available ? {} : { reason: "Run `gh auth login` to post a review." }) } };
  ```

  `ghAuthAvailable` = a tiny worker helper that runs `gh auth token [--hostname host]`
  (honouring `BOBBIT_GH_COMMAND`, `--hostname` for non-github.com) and returns
  `exit 0 && stdout.trim().length > 0`. Note: this is **availability only** — the
  authoritative trust gate is still `assertTrustedBindingTarget` at submit.

- **`submitReview` route** (new) — the panel's submit entry point. `routes.mjs` is
  **hand-authored and served as-is (NOT bundled** — see `scripts/build-market-packs.mjs`,
  which bundles `panel.js`/`yaml-to-cards.js` but explicitly leaves `lib/routes.mjs`
  hand-authored), so it **cannot import `tools/_shared/gateway.ts`**. It reads gateway creds
  itself with ambient `node:fs` (a ~10-line `readGatewayCredsFromDisk()` helper added to
  `routes.mjs`, mirroring `readGatewayCreds`: disk `state/token` + `state/gateway-url`, env
  `BOBBIT_TOKEN`/`BOBBIT_GATEWAY_URL` fallback), then calls the **bearer-gated public** route
  with the jobId from its own binding — **no session secret**:

  ```js
  submitReview: async (ctx, req) => {
    const body = (req && req.body) || {};
    const binding = await loadReviewerBinding(ctx.host.store, strOf(ctx.sessionId));
    if (!binding || !strOf(binding.jobId)) return { ok: false, code: "PRW_MISSING_BINDING", error: "Caller is not a bound PR-walkthrough reviewer." };
    const creds = readGatewayCredsFromDisk();        // ambient node:fs helper defined in routes.mjs
    if ("error" in creds) return { ok: false, error: creds.error, code: "NO_GATEWAY" };
    const res = await fetch(`${creds.baseUrl}/api/pr-walkthrough/submit-review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.token}` },
      body: JSON.stringify({ jobId: binding.jobId, draft: body.draft, event: body.event,
                            confirm: body.confirm === true, probe: body.probe === true }),
    });
    return await res.json();
  },
  ```

  `fetch` is available in the Node worker (Node ≥18). The bearer token is the single-user
  gateway token — the same credential the reviewer's tools already read from disk. The worker
  never reads prefs or runs `gh`; the server route does both. The "packs never raw-fetch the
  gateway" rule constrains the **client panel** (which still only uses `host.callRoute`); the
  trusted worker making a loopback gateway call is consistent with existing pack-server code.

### 4a.6 Panel (`market-packs/pr-walkthrough/{src,lib}/panel.js`)

Edit `src/panel.js` (source of truth; `lib/panel.js` is the built artifact — rebuild via
`npm run build:packs` or the repo's pack-build step):

- The **"Submit review"** button (`data-testid="pr-walkthrough-submit-review"`) currently
  only opens the export preview dialog. Keep the preview; add a **"Post to GitHub"** action
  (`data-testid="pr-walkthrough-post-github"`) inside `renderExportDialog` that is:
  - **enabled** iff `entry.bundle.export?.available === true` (from the enriched `bundle`);
  - **disabled with the reason** (`entry.bundle.export?.reason`) otherwise. The existing
    `pr-walkthrough-export-unavailable` warning slot renders the reason text.
- On click: `await host.callRoute("submitReview", { method: "POST", body: { draft, event: "COMMENT", confirm: true } })`
  where `draft` is the panel's assembled `PrWalkthroughReviewDraft` (decisions + comments the
  panel already tracks for `exportPreviewRowsFor`). Render `result.message` / `result.reviewUrl`
  in the existing `export-result` slot; render `result.message` in `export-error` on failure.
- Keep the "Copy draft" affordance untouched (offline fallback).
- Optionally probe availability on mount via `host.callRoute("submitReview", { method:"POST",
  body:{ probe:true } })` when `bundle.export` is absent (legacy bundles).

Reason text surfaced to the user is always the actionable
`GITHUB_EXPORT_NEEDS_AUTH_REASON` / "Run `gh auth login`…" — never the old env-only message.

---

## Item 4b — Prompt to trust an unknown remote domain at launch

### 4b.1 The mechanism — chosen option and justification

**Constraint:** only the **server** can read `githubTrustedHosts`; the confined `run`
worker cannot. The target host is only known **after** `run` resolves the current-branch
PR (or parses an explicit target) — i.e. the client does not know it before launch.

Options considered:

- **(a) `run` returns the resolved host + a `needsTrust` result; the client (which has the
  prefs UI) decides, prompts, persists, and re-invokes `run`.** ✅ chosen.
- (b) A new server-side pre-check route that resolves the host *and* checks trust. ✗ It would
  duplicate the worker's `gh`/`git` current-branch resolution server-side (heavy, divergent).
- (c) Pure client-side check. ✗ The client cannot resolve the current-branch PR host without
  the worker; it only knows the host after `run` returns it.

**Chosen: (a).** The `run` route already computes `target.host` in `canonicalizeTarget`
before spawning. For any **non-default** host it returns a `HOST_NOT_TRUSTED` result
**without spawning** (echoing the host + resolved `prUrl`). The client checks the host
against the user's trusted list (which it manages via `/api/preferences`); if already
trusted it silently re-invokes; otherwise it prompts, and on accept **persists to
`githubTrustedHosts` then re-invokes** `run` with an ack.

**Why acking the spawn is safe (honours the CONFINED constraint):** the ack only governs
whether a *reviewer child is spawned*. Spawning a reviewer for an untrusted host is
**harmless** (documented on `assertTrustedBindingTarget`): the server-side bundle + submit
routes 403 for untrusted hosts, resolving/posting **nothing**, and the child is reaped on
cleanup. The **real** security boundary — reading the diff, posting the review — remains the
server-side, prefs-backed `assertTrustedBindingTarget`. The client's trusted-list copy is
therefore only a UX affordance; a stale/forged ack cannot widen data access. `github.com`
(and `www.github.com`, which `canonicalizeTarget` normalises to `github.com`) never prompt.

### 4b.2 `run` route (`routes.mjs`) — trust pre-check + ack

In `run`, after `target = await canonicalizeTarget(targetInput, cwd)` and the existing
`provider !== "github"` rejection, insert the pre-check **before** `launchReviewer`:

```js
const DEFAULT_TRUSTED_PR_HOSTS = new Set(["github.com"]); // www.github.com already normalized here
const host = normalizeGithubHost(target.host);
if (!DEFAULT_TRUSTED_PR_HOSTS.has(host) && strOf(body.trustedHostAck) !== host) {
  // Do NOT spawn. Hand the resolved host back to the client to make the trust decision.
  return { ok: false, code: "HOST_NOT_TRUSTED", retryable: true,
           host, prUrl: target.prUrl,
           error: `The remote host "${host}" is not in your trusted list.` };
}
// (unchanged) spawn a fresh reviewer
return await launchReviewer(ctx, parent, target, canonicalKey);
```

- `HOST_NOT_TRUSTED` is a distinct code (not `INVALID_TARGET`/`NO_PR`), `retryable: true`.
- The ack (`body.trustedHostAck === host`) governs only the spawn; it is **not** a trust
  claim about prefs (see 4b.1). Re-invoking with the resolved `prUrl` avoids a second
  `gh pr view` (an explicit target short-circuits `resolveCurrentBranchTarget`).

### 4b.3 Client — trust prompt, persist, retry

New module **`src/app/pr-walkthrough-trust.ts`**:

```ts
import { normalizeTrustedHost, normalizeTrustedHosts, isTrustedExternalHost } from "../shared/pr-walkthrough/url-safety.js";
import { gatewayFetch } from "./api.js";
import { confirmAction } from "./dialogs-lazy.js";

/** Returns true when `host` is trusted (already, or after the user accepts + persist);
 *  false when the user declines. */
export async function ensureGithubHostTrusted(host: string): Promise<boolean> {
  const normalized = normalizeTrustedHost(host);
  if (!normalized) return false;

  // Current managed list (authoritative server copy).
  let managed: string[] = [];
  try {
    const res = await gatewayFetch("/api/preferences");
    if (res.ok) managed = normalizeTrustedHosts((await res.json()).githubTrustedHosts);
  } catch { /* fall through — prompt anyway */ }
  if (isTrustedExternalHost(normalized, managed)) return true; // default baseline or already trusted

  const ok = await confirmAction(
    "Trust this domain?",
    `Add “${normalized}” to your trusted GitHub hosts so this walkthrough can read and post to its pull requests? You can remove it later in Settings.`,
    "Trust domain",
  );
  if (!ok) return false;

  const next = normalizeTrustedHosts([...managed, normalized]);
  // PUT is the persist step: only a PUT failure aborts. A readback failure must NOT abort
  // (the host is already persisted — fixes the design-review [medium] finding).
  try {
    const put = await gatewayFetch("/api/preferences", { method: "PUT", body: JSON.stringify({ githubTrustedHosts: next }) });
    if (!put.ok) return false;
  } catch { return false; }
  // Best-effort readback to catch a server-side normalize drop; on readback error, trust the PUT.
  try {
    const res = await gatewayFetch("/api/preferences");
    if (res.ok) return isTrustedExternalHost(normalized, normalizeTrustedHosts((await res.json()).githubTrustedHosts));
  } catch { /* readback failed but PUT succeeded */ }
  return true;
}
```

This reuses the exact write path `settings-page.ts::persistGithubTrustedHosts` uses
(`PUT /api/preferences { githubTrustedHosts }`, then a readback), and the shared
normalisers — no duplication of trust semantics.

**Wire into `pack-entrypoints.ts::runSpawnLauncher`** (the single spawn dispatch
chokepoint, so both the composer-slash and session-menu launchers are covered). Capture the
extra fields and handle `HOST_NOT_TRUSTED` with one bounded retry:

```ts
let res = await host.callRoute<{ ok?: boolean; childSessionId?: string; error?: string; code?: string; host?: string; prUrl?: string }>(
  target.route, { method: "POST", body: options?.body ?? {} });

if (res?.code === "HOST_NOT_TRUSTED" && typeof res.host === "string") {
  const { ensureGithubHostTrusted } = await import("./pr-walkthrough-trust.js");
  const trusted = await ensureGithubHostTrusted(res.host);
  if (!trusted) {
    onResult?.({ ok: false, error: `Walkthrough cancelled — “${res.host}” was not added to your trusted hosts.` });
    return;
  }
  res = await host.callRoute(target.route, {
    method: "POST",
    body: { ...(options?.body ?? {}), prUrl: res.prUrl, trustedHostAck: res.host },
  });
}
if (!res || res.ok === false) { onResult?.({ ok: false, error: res?.error, code: res?.code }); return; }
// (unchanged) open the child panel + onResult({ ok:true })
```

The `HOST_NOT_TRUSTED` handling is generic-enough to live in the shared dispatcher but
delegates all GitHub-specific trust semantics to `pr-walkthrough-trust.ts` (lazy-imported,
so non-walkthrough packs never load it). No change to the within-gesture double-spawn guard.

`launcherFailureMessage` (session-actions.ts) already prefers `result.error`; add a friendly
mapping for `HOST_NOT_TRUSTED` only if a result ever reaches it unhandled (it should not,
since `runSpawnLauncher` resolves it).

### 4b.4 Edge cases

- `github.com` / `www.github.com`: `canonicalizeTarget` normalises `www` → `github.com`; the
  `run` pre-check treats `github.com` as default-trusted → **no prompt** ever.
- Decline: `run` never spawns (no ack), the client reports a clean, readable cancel message.
- Already-trusted enterprise host: `ensureGithubHostTrusted` returns `true` from the prefs
  readback without prompting → transparent re-invoke.
- Deep-link / explicit target to an untrusted host: same path — `run` returns
  `HOST_NOT_TRUSTED`, the client prompts.

---

## Test plan

Verify with: `npm run check`, `npm run test:unit`, `npm run test:e2e`.

### Unit — `github-adapter.ts` (`tests/pr-walkthrough-export-mapper.test.ts` + `tests/pr-walkthrough-trusted-hosts.test.ts`)

1. **Reason text**: `resolveGithubPr` with a failing fake `gh` and no env token →
   `export.available === false` and `export.reason` matches `/gh auth login/`. (Extend the
   existing "uses unauthenticated GitHub API silently" case, which already asserts
   `available === false`.)
2. **`resolveGithubExportAuth`** (new export): with `withGithubAuthEnv(fakeGhBin("t"))` →
   `{ available: true, token: "t" }`; with `fakeGhBin(undefined, 1)` + no env →
   `{ available: false, reason: /gh auth login/ }`; enterprise host + github.com env token →
   `available` reflects the **gh** path only (env token never forwarded). Reuse the existing
   `fakeGhBin`/`withGithubAuthEnv` helpers.

### Unit — `export-mapper.ts` (`tests/pr-walkthrough-export-mapper.test.ts`)

3. **`submitGithubReview` gh path**: with a fake `gh` (via `BOBBIT_GH_COMMAND`, extend
   `fakeGhBin` to echo a `{ "html_url": ... }` and capture stdin), no token →
   `submitted === true`, `reviewUrl` parsed, and the captured stdin JSON matches
   `createGithubReviewPayload` (path/side/line/body). Assert the invoked args include
   `api repos/SuuBro/bobbit/pulls/42/reviews --method POST --input -` and **no** `--hostname`
   for github.com.
4. **Enterprise `gh --hostname`**: `ghHost: "github.example.com"`, no token → args include
   `--hostname github.example.com`.
5. **gh not authenticated**: fake `gh` exits non-zero → `{ ok:false, status:401 }`,
   `message` matches `/gh auth login/`.
6. **Test-churn from removing the no-token 401 guard (design-review [medium] — be explicit).**
   Removing the `if (!token) return 401` short-circuit means any "no credentials" case now
   falls through to the `gh` path and would invoke the REAL `gh` (ENOENT/real network) unless
   `BOBBIT_GH_COMMAND` is stubbed. So:
   - Token/env-token cases stay on the **fetch** path unchanged: "submits only after
     confirm=true with credentials", "never submits without explicit confirmation" (confirm
     guard is *before* the token check — unaffected), "BOBBIT_TEST_NO_EXTERNAL blocks unmocked
     GitHub review submission" (token present → fetch), "route submit builds a preview before
     mocked GitHub submission".
   - **Any existing test that previously asserted the 401 "Set GITHUB_TOKEN or GH_TOKEN…"
     message with NO token MUST be updated**: stub `BOBBIT_GH_COMMAND` to a failing fake and
     assert the new message matches `/gh auth login/` (status 401), OR, if it must stay a pure
     no-subprocess unit, stub `BOBBIT_GH_COMMAND` to a non-existent binary and assert the
     ENOENT-classified 401. Enumerate and fix each such case; do not claim "zero churn".

### Unit — `routes.ts`

7. **`resolveDiffForBindingTargetForTesting`** (new export): with-SHA github target +
   `withGithubAuthEnv(fakeGhBin("t"))` → `export.available === true`,
   `export.previewOnly === undefined`; with failing gh → `available === false`,
   `reason` matches `/gh auth login/`; local target → `available === false` with the local
   reason. Uses a small git fixture (as `pr-walkthrough-api.spec.ts` does) or a stubbed
   `resolveLocalChangeset`.
8. **`submitExport`** (existing `submitExportForTesting` test) updated: keep the token/fetch
   case; add a **gh** case (no `GITHUB_TOKEN`, stub `BOBBIT_GH_COMMAND`) asserting the review
   posts via gh with `ghHost` derived from the changeset `prUrl`.

### Unit — pack worker `run` trust gate (`tests/pr-walkthrough-trusted-hosts.test.ts` or new)

9. Import `routes.run` from `market-packs/pr-walkthrough/lib/routes.mjs` with a **mock `ctx`**
   (`{ sessionId, host: { store: <in-mem>, agents: { spawn, prompt, dismiss } } }`):
   - explicit `prUrl` on **enterprise** host, no ack → returns
     `{ ok:false, code:"HOST_NOT_TRUSTED", host, prUrl }`, and `host.agents.spawn` **not**
     called.
   - same body **with `trustedHostAck: <host>`** → `host.agents.spawn` called, returns
     `{ ok:true, created:true, ... }`.
   - `github.com` prUrl, no ack → spawns (no `HOST_NOT_TRUSTED`).

### Unit — client trust helper (`tests/*.spec.ts`, file:// or node)

10. `ensureGithubHostTrusted` (mock `gatewayFetch` + `confirmAction`):
    - default host (`github.com`) → `true`, no PUT, no prompt.
    - already-managed host → `true`, no prompt.
    - unknown host + accept → PUT `{ githubTrustedHosts: [...,"h"] }`, readback confirms → `true`.
    - unknown host + decline → `false`, no PUT.
11. `runSpawnLauncher` (mock host `callRoute`): first call returns `HOST_NOT_TRUSTED`; on
    accept → second `callRoute` carries `trustedHostAck`+`prUrl` and the panel opens; on
    decline → `onResult({ ok:false })`, no second call.

### Server E2E — `tests/e2e/pr-walkthrough-api.spec.ts`

12. **Update** "GitHub PR resolve can be faked from local SHAs and remains preview-only
    without credentials": rename/repurpose — **without** gh/env creds assert
    `export.available === false`, `export.reason` matches `/gh auth login/`, and
    `export.previewOnly === undefined`; submit → `EXPORT_UNAVAILABLE`. Add a companion case
    with `BOBBIT_GH_COMMAND` stubbed → `export.available === true`.
13. **New**: bearer-gated public `POST /api/pr-walkthrough/submit-review` (seed a reviewer
    binding under `reviews/<jobId>/binding/*` in the pack store; authenticate with the gateway
    bearer token — **no `X-Bobbit-Session-Secret`**; route by `jobId` in the body). Assert:
    untrusted host → 403 `untrusted_github_host`; trusted host + stubbed `gh` + `confirm:true`
    → `submitted:true` and the fake `gh` recorded a `pulls/42/reviews POST` (assert it read the
    `--input <file>` payload); `confirm` omitted → `CONFIRMATION_REQUIRED`; `probe:true` on a
    trusted host → `{ available, reason }`; missing `jobId` → 400; unknown `jobId` → 404
    `WALKTHROUGH_NOT_BOUND`. Also cover the worker `submitReview` route resolving jobId from
    its binding + `readGatewayCredsFromDisk` (unit, mocking `fetch`).

### Browser E2E — trust prompt (`tests/e2e/ui/*.spec.ts`)

14. Launch a walkthrough (via the launcher hook) whose resolved target is an **untrusted**
    host: assert the confirm dialog appears; **accept** → the host is added (verify via
    Settings / `/api/preferences`) and the launch proceeds (a reviewer child opens);
    **decline** → no reviewer child, a readable cancel message, and the host is **not**
    persisted. `github.com` launches never prompt.

### Invariants to keep green

- `tests/pr-walkthrough-no-submit-proof.test.ts` — introduce no forbidden submit-proof
  tokens (this design uses only the session-secret pattern already in the tree).
- `tests/pr-walkthrough-trusted-hosts.test.ts` — env token never forwarded to enterprise
  hosts (unchanged; `resolveGithubExportAuth` reuses `resolveGithubToken`).
- `tests/tool-description-budget.test.ts` — if a `submit_pr_walkthrough_review` tool yaml is
  added, keep its description within budget.
- Panel parity spec (`tests/pr-walkthrough-panel-parity.spec.ts`) — rebuild `lib/panel.js`
  from `src/panel.js`; keep existing `data-testid`s.

---

## Summary of the two key decisions

- **4b mechanism:** `run` returns `HOST_NOT_TRUSTED` (host + resolved `prUrl`, **no spawn**)
  for non-default hosts; the client checks its managed trusted list, prompts on unknown
  hosts, persists via `PUT /api/preferences`, and re-invokes `run` with `trustedHostAck`. The
  ack only governs the (harmless) spawn; the server-side prefs-backed `assertTrustedBindingTarget`
  remains the real gate — which is why the confined worker never needs to read prefs.
- **`submitGithubReview` gh vs fetch:** **fetch when an explicit/env token is present, else
  `gh`** (`gh api …/reviews --method POST --input -`, `--hostname` for enterprise). This
  preserves every existing token-based test and routes enterprise / gh-only github.com
  accounts through `gh`, satisfying "works for whatever host/account the user authenticated
  with `gh auth login`". The actual POST always runs **server-side** behind the trusted-host
  gate (REST `submitExport` for the standalone flow; the new bearer-gated public
  `/api/pr-walkthrough/submit-review` (jobId-routed, no session secret — the pack route worker
  inherits the gateway env, not the reviewer's, so it authenticates with the disk bearer token)
  for the pack flow).

### Resolved design-review findings

- **[high] `execFileSafe` stdin** → temp-file (`gh api … --input <file>`); `execFileSafe`
  untouched (§4a.3).
- **[high] `BOBBIT_SESSION_SECRET` in the worker** → confirmed absent (worker inherits gateway
  env); switched the pack submit to a bearer-gated public route routed by jobId (§4a.4/§4a.5).
- **[medium] test churn** → enumerated the no-token cases and the `BOBBIT_GH_COMMAND` stub
  requirement (test-plan item 6).
- **[medium] client readback** → PUT-failure aborts, readback-failure trusts the PUT (§4b.3).
- **[medium] duplicate host helper** → reuse/extract `hostFromTarget` from `bindingTargetHost`
  (§4a.2).
- **[low] `bundle` gh latency / probe-403 semantics / post-button `data-testid` /
  `resolveBindingCwd` exists** → noted inline (§4a.2 latency caveat, §4a.4 probe, §4a.6).
