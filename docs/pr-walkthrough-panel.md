# PR Walkthrough Panel

The PR walkthrough is Bobbit's guided review surface for pull requests and local
changesets. A reviewer steps through logically-grouped review cards (orientation,
key design choices, significant changes, omissions, audit), comments on lines and
cards, and exports a draft GitHub review.

The model is **changeset-oriented**, not GitHub-specific: GitHub PRs, local SHA
pairs, and fixtures all resolve into the same renderable payload — a changeset
reference, diff blocks with hunks and line anchors, logical review cards,
warnings, and export-capability metadata. The reviewer UI never needs to know how
the cards were produced; it renders the same cards, comments, decisions, draft
review, and export preview for every provider.

The checked-in prototype in
[`docs/design/pr-walkthrough-panel-prototype.html`](design/pr-walkthrough-panel-prototype.html)
remains the UX reference for the ready-state review surface. The pack panel must
stay recognisably the same walkthrough experience as that prototype, not a
compact alternate rendering of the same data.

## How it works now (built-in first-party pack)

**The PR-walkthrough viewer ships as a built-in first-party pack**
(`market-packs/pr-walkthrough/`), auto-resolved **active-by-default** with no
manual install, and is the **sole provider** of the viewer panel, its data
routes, and its deep-link. The bespoke built-in viewer (the old
`PrWalkthroughPanel.ts` component, the standalone `/walkthrough?...` browser
route, the `/walkthrough-pr` client slash intercept, and the child-session
side-panel viewer) was **deleted**. The pre-migration surfaces are kept only as
[historical rationale](#historical-pre-pack-migration--retained-for-rationale) at
the end of this document; none of it is current.

The current end-to-end flow:

- **Route.** The viewer opens at the generic extension route **`#/ext/pr-walkthrough`**
  (via the pack's `host.ui.navigate` / `openPanel`). There is no `#/walkthrough`
  SPA route and no standalone `/walkthrough?...` pathname route.
- **Launch (spawn-on-click).** A pack **entrypoint** — a git-widget button, a
  composer-slash launcher, a command-palette launcher, and a `kind:"route"`
  deep-link — drives the feature. The launchers spawn a fresh read-only reviewer
  sub-agent and auto-switch the user's view to it. **No panel or tab is ever
  mounted in the current (owner) session** — there is no owner-session
  walkthrough surface at all. The launchers carry **no** hard-coded `jobId`.
  Selecting `/pr-walkthrough` from composer autocomplete/menu, using the
  git-widget button, or using the command-palette launcher calls `run` with an
  empty body and resolves the current branch's open PR. Typed composer forms can
  pass an explicit PR target: `/pr-walkthrough <github-pr-url>` or
  `/pr-walkthrough <pr-number>`. A no-PR / spawn failure surfaces as an inline
  error in the git-status-widget dropdown and spawns nothing (no session, no view
  switch). Every click is a **fresh** reviewer (there is no target dedup), so
  multiple reviewers per PR are allowed. See
  [Launch model: the isolated reviewer child](#launch-model-the-isolated-reviewer-child).
- **Run.** The launcher click calls the pack's **`run`** route, which mints a
  **real, isolated, read-only reviewer child** (`host.agents.spawn`) — it does
  **not** drive the user's own agent — and the platform opens the panel **in the
  returned child session**, switching the view to it. There are **no manual "Run
  PR walkthrough" / "Load walkthrough" buttons** anywhere; spawning is the only
  launch path. See
  [Launch model: the isolated reviewer child](#launch-model-the-isolated-reviewer-child)
  for the full flow, the run/status/recover routes, and the GitHub-PR-only
  scoping.
- **Poll + render (in the child session).** Inside the reviewer child session the
  panel auto-opens showing a pending state and **self-drives** the poll: it polls
  the **`status`** route (read-only) until the reviewer submits the production
  YAML, then runs the unchanged `publish`→`bundle` synthesis to render the same
  cards. A long-but-progressing reviewer is **never** errored by a short clock —
  past ~2 minutes the panel shows a non-error "still reviewing" hint and keeps
  polling; only a route-confirmed terminal child or a 30-minute hard cap ends the
  poll. See [Poll-loop robustness](#poll-loop-robustness).
- **Data via pack routes.** The panel never makes a raw `fetch`. It calls the
  pack's own routes (`market-packs/pr-walkthrough/lib/routes.mjs`, registered in
  `pack.yaml` `routes:`) through `host.callRoute`:
  - **`run`** launches the reviewer child and writes the pack-store routing
    binding; **`status`** polls it; **`recover`** re-reads a completed
    walkthrough on reload (see [Launch model](#launch-model-the-isolated-reviewer-child)).
  - **`publish`** validates the submitted YAML and persists the synthesized cards
    in the pack-namespaced `host.store`.
  - **`bundle`** recomputes the changeset **live** via `git` inside the confined
    worker (the git working dir is always the session worktree, server-derived —
    never caller-supplied) and serves it together with any persisted cards.
- **YAML → cards.** The synthesis that turns the agent's validated YAML into
  review cards is shared at **`src/shared/pr-walkthrough/yaml-to-cards.ts`** and
  bundled into the pack's `publish` route, so the pack maps the YAML to cards
  itself.
- **Persistence.** On reload of the reviewer child session, the panel re-reads
  state through the `bundle` route, which recomputes the changeset live and reads
  any persisted cards from `host.store`; a stamped-once `persistedAt` keeps the
  cards stable across reloads. Because the reviewer child's submit tool call lives
  in the child session (and there is no owner-session surface), a completed
  walkthrough is re-rendered after reload automatically through the **`recover`**
  route, keyed by the child's own `binding/<self>` — no user gesture and no owner
  pointer (see [Launch model](#launch-model-the-isolated-reviewer-child)).

The **agent-side toolchain** that actually produces the YAML — the three
read-only tools (`readonly_bash`, `read_pr_walkthrough_bundle`,
`submit_pr_walkthrough_yaml`) and the `/resolve` · `/export/*` routes — is
**retained**, but it now ships from the pack under
`market-packs/pr-walkthrough/tools/pr-walkthrough/` and runs inside a dedicated
**reviewer child session**, not the user's own agent (see
[Launch model: the isolated reviewer child](#launch-model-the-isolated-reviewer-child)
and [Agent-side walkthrough lifecycle](#agent-side-walkthrough-lifecycle-retained)).
`pack.yaml` advertises the `pr-walkthrough` tool group; Marketplace expands that
group into concrete tool toggles, and `DisabledRefs.tools` is keyed by concrete
tool name. The legacy `WalkthroughAgentManager` launcher, the
`/api/pr-walkthrough/launch` route, the `host.session.postMessage` launch gesture,
and the submit-proof secret were **deleted** by that migration.

For the pack model, see
[docs/marketplace.md § Built-in (first-party) packs](marketplace.md#built-in-first-party-packs),
[docs/design/built-in-first-party-packs.md](design/built-in-first-party-packs.md),
and [docs/design/pr-walkthrough-pack-deletion.md](design/pr-walkthrough-pack-deletion.md).

## Launch model: the isolated reviewer child

> **Launch UX correction.** This section describes the **shipped** spawn-on-click
> model. The earlier "navigate the owner session → autorun on mount → re-key to
> the child → server-dismiss on submit" journey it replaced is recorded in
> [docs/design/pr-walkthrough-launch-ux.md](design/pr-walkthrough-launch-ux.md);
> the older restore-UX design ([pr-walkthrough-restore-ux.md](design/pr-walkthrough-restore-ux.md))
> is superseded for the launch/lifecycle model.

**Clicking any launch surface mints a fresh, separate, visible, read-only reviewer
session and switches the view to it** — it never drives the user's current agent
and never mounts a panel in the owner session. This builds on the Extension Host's
[`host.agents`](extension-host-authoring.md#hostagents--launch-and-orchestrate-child-agents)
capability. The walkthrough **pane lives only with that reviewer child session** —
it shows a pending state while analysis runs and the ready cards after submit,
beside the child's chat. There is **no owner-session walkthrough surface** of any
kind (see [The pane lives only with the reviewer child](#the-pane-lives-only-with-the-reviewer-child)).

Because the reviewer is a normal visible session, launch also participates in the
gateway-wide session-list sync contract. `SessionManager.createSession` persists
the child and the server pushes `session_created` to authenticated clients; active
session sockets and the global `/ws/viewer` listener refresh `GET /api/sessions`.
That makes a walkthrough started on mobile promptly discoverable and selectable
from desktop, and vice versa, without waiting for the periodic poll. Selecting the
row opens the reviewer child session itself; the owner session never gains a
walkthrough pane.

### Spawn-on-click from every launch surface

All three launchers — the **git-widget button**, the **composer-slash** launcher,
and the **command-palette** launcher — carry the same declarative target
`{ action: "spawn", route: "run", panelId: "pr-walkthrough.panel" }`
(`entrypoints/pr-walkthrough-*.yaml`). The platform launcher dispatch
(`src/app/pack-entrypoints.ts`) calls the pack's **`run`** route (POST) through
the versioned Host API, and on `{ ok: true, childSessionId }` opens `panelId`
**in that child session** via `host.ui.openPanel({ panelId, sessionId })`
(contract-v2 `PanelTarget.sessionId`), which performs a real session switch so the
sidebar and main view follow. See
[docs/extension-host-authoring.md](extension-host-authoring.md#entrypoints--non-chat-launchers--deep-link-routes-hostuinavigate)
for the `SpawnLaunchTarget` entrypoint shape.

Composer slash supports two full-line typed forms that use the same spawn path but
provide an explicit target to `run`:

- `/pr-walkthrough <github-pr-url>` sends `{ prUrl: "<github-pr-url>" }`.
- `/pr-walkthrough <pr-number>` sends `{ prNumber: <pr-number> }`.

These forms only change target resolution; they still spawn a fresh isolated
reviewer child and switch the view to that child on success. Selecting
`/pr-walkthrough` from the composer autocomplete/menu, typing `/pr-walkthrough`
without an argument, clicking the git-widget launcher, and using the
command-palette launcher all keep the empty-body behavior (`{}`), so `run`
resolves the current branch's open GitHub PR.

**Why spawn-on-click and not navigate-then-autorun?** The previous model navigated
the *owner* session to the deep-link, transiently mounted the panel there, autoran
`run` on mount, then re-keyed and navigated to the child. That briefly polluted the
owner session with a walkthrough tab the user never asked for and made the
"no auto-invoke on mount" pack invariant murky. Spawning directly from the click —
which **is** the user gesture — keeps the owner session untouched and makes the
child session the single home of the walkthrough.

**No-PR / spawn failure → inline error, nothing spawned.** When the current branch
has no open GitHub PR (or the spawn otherwise fails), `run` returns `{ ok: false }`
(e.g. `code: "NO_PR"`); the launcher dispatch surfaces the message **inline in the
git-status-widget dropdown** (`data-testid="git-widget-launcher-error"`), keeps the
dropdown open, and spawns **no** session and performs **no** view switch.

**Always fresh — no dedup.** Every deliberate click creates a **new** reviewer,
even for the same PR (the old server-side `reviewerKey` idempotency is gone).
Multiple reviewers per PR are allowed; the user terminates extras. The only
double-spawn protection is a **within-gesture guard** (`inFlightSpawnLaunch` in the
launcher dispatch) so a single click cannot double-fire. See
[Lifecycle: no auto-dismiss, restart survival, and termination](#lifecycle-no-auto-dismiss-restart-survival-and-termination).

### Poll-loop robustness

The panel's poll loop polls **while the reviewer child is alive** rather than
erroring on a short clock. After the soft `SLOW_HINT_MS` (~2 minutes) of
`phase: "running"` it surfaces a non-error **"still reviewing"** hint and keeps
polling; only `phase: "submitted"` (publish) or `phase: "error"` (the route's
terminal-without-submit verdict) ends the loop. An absolute `HARD_CAP_MS`
(30 minutes) is the only "ran too long" outcome, and it surfaces a retry message
rather than a silent failure. A long-but-progressing review of a non-trivial PR is
never turned into an error by the clock.

**Why a separate principal, not the user's agent?** The earlier pack revision had
no way to mint a child principal, so its "Run" gesture called
`host.session.postMessage` to drive the **current** session's agent. That polluted
the user's session, blocked them from working while the walkthrough ran, and was
not an isolated reviewer. With `host.agents` now able to spawn a real,
sandbox-inherited child, the walkthrough runs as its own properly-scoped,
read-only principal again. See
[docs/design/pr-walkthrough-host-agents-migration.md](design/pr-walkthrough-host-agents-migration.md)
for the full design record, and
[docs/design/pr-walkthrough-launch-ux.md](design/pr-walkthrough-launch-ux.md)
for the launch-UX correction that put the pane **only** in the child session,
replaced autorun-on-mount with spawn-on-click, dropped the submit-time dismiss,
and finalised the `PanelTarget.sessionId` Host-API consumption.

### The run / status / recover routes

The panel drives three pack routes (`market-packs/pr-walkthrough/lib/routes.mjs`,
allow-listed in `pack.yaml`), all reached via `host.callRoute` — never a raw
`fetch`:

- **`run`** (the gesture-gated launch): resolves the changeset target, then calls
  `host.agents.spawn({ role: "pr-reviewer", readOnly: true, lifecycle: "full",
  deferInitialPrompt: true, title: "PR Walkthrough", … })` to create the
  **visible-but-not-yet-started** reviewer child. It then writes the
  `binding/<childSessionId>` routing record (carrying the job id, canonical target,
  and base/head SHAs) **before** prompting the child to start. Writing the binding
  before the child's first tool call closes a spawn/binding race (the reviewer's
  first `read_pr_walkthrough_bundle` can never 403 on a missing binding). On any
  post-spawn failure the route **compensates** (dismisses the child, deletes the
  binding) and returns `{ ok: false, retryable: true }` so a retry starts clean.
  **`run` always spawns a fresh reviewer** — there is no `reviewerKey` dedup index
  and no reuse of a live reviewer (see
  [Lifecycle: no auto-dismiss](#lifecycle-no-auto-dismiss-restart-survival-and-termination)). On success it
  returns `{ ok: true, childSessionId, jobId, … }`; a `NO_PR` /
  `LOCAL_UNSUPPORTED` / failure returns `{ ok: false, code, error }` for the
  launcher to render inline.
- **`status`** (the poll): input `{ childSessionId, jobId }`. It is
  **binding-authoritative** — it loads `binding/<childSessionId>` first and
  verifies the job id and that the caller is one of the binding's two named
  principals before reading anything else, so a caller cannot probe another job's
  state. The caller may be **either bound principal**: the bound owner
  (`binding.parentSessionId === ctx.sessionId`) **or** the reviewer child polling
  its own pane (`childSessionId === ctx.sessionId`). Right-job routing is preserved
  — the caller must match the binding's `jobId` AND be owner or child; a foreign
  session is still rejected. Completion is signalled by the pack-store
  **`submitted/<jobId>`** marker (the submitted YAML), not the reviewer's idle
  status — a read-only agent can go idle without submitting. Returns
  `{ phase: "running" | "submitted" | "error", … }`.
- **`recover`** (reload recovery): because the reviewer's
  `submit_pr_walkthrough_yaml` tool call lives in the child session — and there is
  no owner-session surface — a browser reload of the child session recovers a
  completed walkthrough through this route. `recover` is **child-self only**: when
  the caller is the bound reviewer child it resolves the submitted YAML directly
  from its own `binding/<childSessionId>` (`binding/<self>` → `submitted/<jobId>`),
  no extra store key. The old **owner** branch (the `last/<parentSessionId>`
  pointer) was removed along with the owner-session surface. The child pane invokes
  `recover` automatically on mount when its in-memory state is empty (the
  read-only auto-open carve-out, below) — there is no manual "Load walkthrough"
  gesture.

### The pane lives only with the reviewer child

The walkthrough pane renders **only inside the reviewer child session's view** —
the owner session never hosts a walkthrough tab. The platform launcher dispatch
opens the panel in the child session via the Host API
(`host.ui.openPanel({ panelId, sessionId: childSessionId })`, contract-v2
`PanelTarget.sessionId`), which is a real session switch (the same canonical
`connectToSession` path the sidebar drives), so the sidebar highlight, hash route,
and main view all follow. The pack touches **no** platform navigation code
directly — only the versioned Host API, preserving pack purity.

**The auto-open carve-out (read-only).** When the panel renders and its bound
session (`params.__sessionId`) has a `binding/<self>` in the pack store — i.e. this
view *is* a reviewer child — the pane **auto-opens and self-drives** with **no user
gesture**. This is a documented, deliberate exception to the pack-panel
"no auto-invoke on mount" invariant
([docs/extension-host-authoring.md](extension-host-authoring.md#panels--persistent-side-panels-hostuiopenpanel)),
scoped **strictly to a bound reviewer-child pane**. The carve-out is **read-only**:
the child pane only polls its own job's `status` route and renders — it never
spawns or mutates anything. It is safe precisely because it is the child's own
pane reading the child's own job; nothing about it can affect another session.

**Pending state.** Until a submitted YAML exists, the pane shows exactly
`PR Walkthrough: In Progress` with a spinner (`data-testid="prw-pending"`, no
progress %). The child pane self-drives the poll keyed off its own
`binding/<self>`: on mount, with a binding present and no rendered bundle yet, a
guarded one-shot starts the poll loop (single-flighted by a `polling` flag so a
re-render never stacks loops). The `status` child-self path returns
`phase: "running"` until the `submitted/<jobId>` marker appears — **without**
calling `host.agents.status`, so a read-only reviewer that goes idle without
submitting is not mistaken for done.

**Submitted → rendered, and reload.** On `phase: "submitted"` the pane flips the
pending state to the rendered walkthrough cards (the existing `publish`→`bundle`
seam). On a reload of the child session the pane finds its in-memory `byJob` state
empty and re-renders automatically via the **child-self `recover`** path
(`binding/<self>` → `submitted/<jobId>`); `publishAndLoad` is idempotent, so the
same cards re-render with the same `persistedAt`. The reviewer is **not** dismissed
on submit — it stays a live, selectable session (see
[Lifecycle: no auto-dismiss](#lifecycle-no-auto-dismiss-restart-survival-and-termination)).

### Ready-state shell parity contract

The production viewer is `market-packs/pr-walkthrough/src/panel.js` (built to
`lib/panel.js`). It remains a first-party pack panel; the deleted bespoke
`PrWalkthroughPanel.ts`, old `/walkthrough` routes, owner-session surfaces, and
manual Run/Load flows must not return. The shell parity work restored the
pre-migration review experience inside the pack instead of reintroducing those
surfaces.

The ready state is intentionally dense:

- Root layout uses the historical `.shell > .body > .content` structure with
  `13px/1.45 system-ui` typography scoped under the pack panel root.
- The header is a compact toolbar, not a hero card. It keeps the PR title,
  file/addition/deletion stats, GitHub link, reviewed-count progress, and disabled
  / enabled Submit button in one row.
- The sidebar is one review rail with labelled and collapsed presentations. It is
  user-collapsible, resizable on desktop, auto-collapses from the panel's observed
  container width, and preserves active/completed/liked/disliked state in both
  presentations.
- Orientation cards with `sections` render as a dedicated guided card with Back /
  Next / Start review navigation, rail beat entries, verdict, stats, concerns, and
  file-role map. Cards without `sections` still fall back to the generic card
  renderer.
- Review cards use the compact card shell: phase tag, title, summary, rationale,
  checklist, original PR-description disclosure, diff widgets, suggested comments,
  card comments, and sticky action footer.
- `Like` and `Dislike` are decisions, not simple navigation buttons. A decision
  marks the card reviewed, persists state, emits the draft/completion event, and
  advances to the next card. `Dislike` stays disabled until the card has at least
  one saved line or card comment.
- The audit card renders the generated draft and copy affordance. The Submit button
  unlocks only when all non-audit review cards are complete, then opens the
  export-preview dialog; when direct provider submission is unavailable, the dialog
  explains that clearly and keeps the GitHub submit button disabled while leaving
  copy/preview available.

Recovery is part of parity, not a separate fallback UI. Malformed or incomplete
hunk/header data must degrade to warnings or unmapped suggestions rather than
blanking the panel. Pending reviews remain in the in-progress state while the
reviewer is alive, completed reviews re-render through `recover` after reload, and
long-running reviews show non-error progress hints instead of timing out early.

### Ready-state DOM affordances

Keep these selectors stable unless the corresponding tests and docs are updated in
the same change. They are the maintenance contract for the compact shell:

| Area | Stable affordances |
|---|---|
| Root/header | `data-testid="pr-walkthrough-panel"`, `.shell`, `.body`, `.content`, `pr-walkthrough-header`, `pr-walkthrough-pr-title`, `pr-walkthrough-pr-stats`, `pr-walkthrough-pr-link`, `pr-walkthrough-progress`, `pr-walkthrough-submit-review` |
| Rail | `pr-walkthrough-labelled-rail`, `pr-walkthrough-collapsed-rail`, `pr-walkthrough-rail-toggle`, `pr-walkthrough-rail-resize`, `pr-walkthrough-phase-button`, `pr-walkthrough-card-step`, `data-card-id`, `complete`, `liked`, `disliked` |
| Orientation | `pr-walkthrough-orientation-rail`, `pr-walkthrough-orientation-step`, `data-state="current|visited|upcoming"`, `pr-walkthrough-orientation-guide`, `pr-walkthrough-guide-counter`, `pr-walkthrough-guide-back`, `pr-walkthrough-guide-next`, `pr-walkthrough-beat-heading`, `pr-walkthrough-beat-verdict`, `pr-walkthrough-beat-stats`, `pr-walkthrough-beat-concerns`, `pr-walkthrough-beat-filemap` |
| Cards/comments/actions | `pr-walkthrough-card`, `pr-walkthrough-card-phase-tag`, `pr-walkthrough-card-title`, `pr-walkthrough-card-summary`, `pr-walkthrough-add-card-comment`, `pr-walkthrough-comment-editor`, `pr-walkthrough-comment-input`, `pr-walkthrough-comment-save`, `pr-walkthrough-comment-delete`, `pr-walkthrough-prev`, `pr-walkthrough-dislike`, `pr-walkthrough-like`, `decision-selected` |
| Audit/export | `pr-walkthrough-audit`, `pr-walkthrough-draft`, `pr-walkthrough-copy-draft`, `pr-walkthrough-export-preview`, `pr-walkthrough-export-unavailable`, `pr-walkthrough-export-body`, `pr-walkthrough-export-row`, `pr-walkthrough-export-submit` |

The pack also retains legacy `prw-*` sentinels used by older parity fixtures. Do
not remove them as cleanup unless the compatibility tests are intentionally
retired.

### Target resolution — GitHub PRs only

When a launcher invokes `run` with an empty body (composer autocomplete/menu,
git-widget, command palette, or typed `/pr-walkthrough` without an argument), the
`run` route resolves **the current branch's open GitHub PR** from the
server-derived session worktree via `gh`/`git`. An explicit target in the body
(typed composer URL/number, a deep-link, or test) always wins.

The walkthrough is **GitHub-PR-only**. The route rejects two cases before any
spawn:

- **No PR for the branch** → `{ code: "NO_PR" }`; the launcher dispatch surfaces
  this as an **inline error in the git-status-widget dropdown** — no reviewer is
  spawned and the view does not switch (there is no owner-session panel).
- **A local-only target** (`baseSha`/`headSha` with no GitHub PR) →
  `{ code: "LOCAL_UNSUPPORTED" }`. A local target would spawn a reviewer that can
  never submit (the production YAML schema requires `pr.provider: github`), so it
  is rejected up front.

### The reviewer's toolset — a pack-shipped role, no secret

The reviewer child gets its tools from the pack-shipped **`pr-reviewer` role**
(`market-packs/pr-walkthrough/roles/pr-reviewer.yaml`), which resolves to
**exactly** the three walkthrough tools shipped in
`market-packs/pr-walkthrough/tools/pr-walkthrough/`.

**The role must resolve cascade-first.** Because `pr-reviewer` ships *in the pack*,
it lives in the config cascade, not the in-memory `RoleManager`. Every server path
that resolves the reviewer's role for a session must therefore consult
`configCascade.resolveRoles(projectId)` (falling back to `RoleManager` only when no
project cascade is available) — the same pattern the spawn-time allowlist already
used. Two paths previously looked the role up in `RoleManager` alone, got
`undefined`, and fell through to group defaults: the tool-**guard** generation
(`lookupRole` in `src/server/agent/session-setup.ts`) and the restore/respawn role
resolution (`resolveSessionRole(projectId)` in
`src/server/agent/session-manager.ts`). With the `PR Walkthrough` group now
default-deny, that fall-through hard-blocked all three walkthrough tools, so the
spawned reviewer held the right allowlist yet was rejected on every call ("Tool X
is not permitted for this role") — and, resolving the role's `promptTemplate`
through the same `RoleManager`-only lookup, it never received the submission YAML
schema. Resolving cascade-first in both paths (and threading the pack role's
`promptTemplate` into the child's system prompt via `resolveRolePromptTemplate` +
`createSession`'s `rolePrompt`) is what lets the reviewer actually **call** its
tools and know the schema. This is pinned by a unit test asserting the generated
guard carries no `never` entries for the three tools, plus
`tests/e2e/pr-walkthrough-host-agents.spec.ts`. See
[docs/design/pr-walkthrough-restore-ux.md](design/pr-walkthrough-restore-ux.md) § A.

The role `allow`s the `PR Walkthrough`
tool group and **denies every other fixed group plus all MCP servers** (an
`mcp__` wildcard deny), so a read-only reviewer holds no state-mutating or
orchestration tools. The `PR Walkthrough` group is **default-deny for every other
role**, so `submit_pr_walkthrough_yaml` is reachable **only** from the reviewer —
the "only the reviewer submits" boundary falls out of tool-granting, with **no
secret**. This is separate from pack-bound surface authorization: panels, routes,
and entrypoints are authorized by installed + active pack + own session, while
these three tools remain normal role/tool-policy-resolved tools.

**Submit / bundle authorization without a secret.** The reviewer's
`submit_pr_walkthrough_yaml` and `read_pr_walkthrough_bundle` tools call the
server endpoints (`src/server/pr-walkthrough/routes.ts`) with an
`X-Bobbit-Session-Secret` header. The server resolves the **authentic caller
session id** from that secret (`resolveSessionIdBySecret`) and routes the request
via the pack-store `binding/<childSessionId>` mapping. This is **right-job
routing**, not a security boundary: the YAML lands on exactly the job bound to the
caller, a cross-job request can't resolve another session's binding, and a
re-submit to a terminal job is rejected (409). Trusted-host enforcement
(`githubTrustedHosts`) is applied server-side for GitHub targets, because the
confined pack worker cannot read gateway preferences. **Why no secret is needed:**
in Bobbit's single-user trust domain the result only ever surfaces in the user's
own panel, so "fake review content" would be the user's own trusted agent writing
wrong text into the user's own UI — a bug, not an attack. The old
`BOBBIT_WALKTHROUGH_SUBMIT_PROOF` secret guarded a threat that does not exist
here, and it was deleted.

**Read-only scoping of `gh`.** The launched-PR identity reaches the reviewer's
`readonly_bash` policy as non-secret `BOBBIT_WALKTHROUGH_TARGET_*` environment
variables, passed through `host.agents.spawn`'s `toolEnv`. The policy uses them to
reject cross-PR / cross-repo `gh` reads, exactly as the legacy launcher's env did.
`toolEnv` is plain metadata and can never widen the child's owner-inherited
sandbox or credential scope.

### Lifecycle: no auto-dismiss, restart survival, and termination

The reviewer is a **normal, long-lived session**. Nothing in the walkthrough
reaps it automatically.

- **Always fresh — no dedup.** Each `run` spawns a brand-new reviewer; there is no
  `reviewer/<parent>/<key>` idempotency index, no live-reviewer reuse, and no
  `created: false` path. Multiple reviewers for the same PR are allowed by design.
  The only double-spawn protection is the client **within-gesture guard**
  (`inFlightSpawnLaunch`), which stops one click from firing twice — it does **not**
  dedup across separate clicks.
- **No auto-dismiss on submit.** The submit handler
  (`src/server/pr-walkthrough/routes.ts`) persists the submitted YAML
  (`submitted/<jobId>` + `binding.status = "submitted"`) and **stops there**. It no
  longer dismisses the reviewer, no longer stamps a `childTerminal` / `terminalAt`
  terminal marker, and no longer writes an owner `last/<owner>` pointer (there is
  no owner-session surface to recover into). The pack `status` route likewise no
  longer dismisses the child on either branch. After submit the reviewer posts a
  one-line "walkthrough ready" note, goes idle, and stays **read-only, selectable,
  and available for follow-up**.
- **Restart survival.** Because no `childTerminal` marker is stamped, a post-submit
  reviewer **survives a gateway restart** like any other session. It is reaped only
  by the standard `host.agents` **owner-gone** rule (`shouldReapChildOnBoot` in
  `OrchestrationCore` removes it when its owner is archived/gone) — never by a
  PR-walkthrough terminal marker. See
  [docs/orchestration.md](orchestration.md#hostagents--orchestration-for-extension-packs).
- **Termination is the user's call.** The user terminates the reviewer through the
  existing per-session terminate/dismiss control in the sidebar (the same archive
  action exposed for `host.agents` child sessions). Terminating discards the
  session — the walkthrough is **not** preserved anywhere else, which is fine: it
  is cheap to re-run. Archiving or terminating the **owner** still cascade-reaps the
  reviewer like any other `host.agents` child.

## Panel sizing: fullscreen, collapse, and shortcuts

The PR walkthrough is a normal `pack` tab in the server-backed side-panel
workspace. It uses the same shared controls as every side panel: fullscreen,
collapse/restore, split view, and popout. There is no walkthrough-specific resize
code path, and no preview-specific localStorage collapse key; size mode persists
as `sidePanelWorkspace.sizeMode` on the reviewer session and syncs across reloads
and browser contexts. The shared keyboard shortcuts expand one level
(`collapsed → split → fullscreen`), collapse one level (`fullscreen → split → collapsed`),
and toggle fullscreen/collapsed.

The panel **never auto-enters fullscreen**. Fullscreen is strictly user-initiated,
via a toolbar button or one of those shortcuts. This matches the preview panel and
is the behaviour the rest of the app expects — a panel that seizes the whole
window on its own (for example when a walkthrough becomes ready) is disruptive and
was the source of the original "dead controls" bug. See
[design/walkthrough-panel-resize-fix.md](design/walkthrough-panel-resize-fix.md)
for the full root-cause analysis and the special-casing that was removed.

The walkthrough panel's **own internal rail sidebar toggle**
(`data-testid="pr-walkthrough-rail-toggle"`, rendered inside the pack panel
`market-packs/pr-walkthrough/lib/panel.js`) is a different control — it
collapses/expands the single review rail *within* the walkthrough, not the
window-level panel. Desktop labelled rail width is user-resizable with
`pr-walkthrough-rail-resize` and clamped to the historical compact range; narrow
mode is based on the panel container observed by `ResizeObserver`, so an embedded
narrow side panel collapses even when the browser viewport is wide.

### Pinning tests

The pack-served viewer is covered end-to-end by
`tests/e2e/ui/pr-walkthrough-pack.spec.ts` (install-free built-in-band resolution
→ launcher → live `bundle` recompute → render → `publish` → reload persistence →
entrypoint and concrete-tool activation toggles). The launch-UX correction is pinned in the same spec: clicking the
git-widget launcher on a branch with no PR shows the inline
`git-widget-launcher-error` and spawns **no** session / performs **no** view switch
(the browser harness has no real PR, so a click resolves `NO_PR`); the child pane
auto-shows the pending `PR Walkthrough: In Progress` + spinner with **no** Run/Load
buttons; and on submit the child pane flips to rendered cards and **re-renders
across a reload** via the child-self `recover` (same `persistedAt`). The
launcher→spawn→select-child dispatch and the within-gesture guard are pinned by a
unit test of `runSpawnLauncher` (a mocked launcher host whose `run` returns
`{ ok: true, childSessionId }` → asserts `host.ui.openPanel({ sessionId })` and no
owner-session mount). The reviewer **spawn**, the **`magnifier` accessory** and
**`PR Walkthrough` session title**, the exactly-three-tool allowlist, the
child-side `status`/`recover` routing, the always-fresh (two clicks → two distinct
reviewers) behaviour, the **no-dismiss-on-submit** + restart-survival lifecycle,
and the user-terminate control are pinned in the API spec
`tests/e2e/pr-walkthrough-host-agents.spec.ts` (whose mock agent cannot resolve a
real PR through a click, so the spawn/lifecycle assertions live there, not in the
browser spec).
Preview panel sizing through the shared side-panel controls is independently pinned by
`tests/e2e/ui/preview-fullscreen-controls.spec.ts` (preview is one workspace
panel kind using the same sizing logic as pack, proposal, review, and inbox
panels). See
[design/walkthrough-panel-resize-fix.md](design/walkthrough-panel-resize-fix.md)
for the root-cause analysis and the corrected design.

## Changeset and card model

The shared walkthrough model lives under `src/shared/pr-walkthrough/` and is
consumed by both server and the pack panel.

Key concepts:

- **Changeset** — provider, base/head SHAs, title, PR URL/number/title when present, and summary stats.
- **Diff block** — one reviewable file block with `filePath`, optional `oldPath`, status, generated/binary/truncated flags, external links, and hunks.
- **Hunk** — original hunk header plus ordered line records.
- **Line** — stable id, kind (`context`, `add`, `del`), side (`context`, `new`, `old`), text, and old/new line numbers for review anchors.
- **Card** — a logical review unit in one of the walkthrough phases. A card can contain multiple diff blocks across one or more files. Each card also carries an optional `navLabel` (a compact ≤3-word sidebar label distinct from the full `title`) and the Orientation card carries optional `sections` (the guided "beats" — see [Guided orientation step-through](#guided-orientation-step-through)). Both are optional, so legacy/partial payloads still render.
- **Warning** — visible ingestion, mapping, validation, or export issue with a severity, code, message, and optional file path.

## YAML-to-card mapping

The agent submits exactly one YAML document matching the PR walkthrough schema.
That YAML is mapped into the card model by the shared synthesis at
`src/shared/pr-walkthrough/yaml-to-cards.ts` (bundled into the pack's `publish`
route):

- `walkthrough.context`, `merge_assessment`, and `pr.original_description.body` become the Orientation card, including the six structured guided `sections` (see [Guided orientation step-through](#guided-orientation-step-through)).
- `design_decisions` become Key design choices cards with trade-offs, alternatives, suggested concerns, and linked hunks.
- `review_chunks` become significant, other, or audit review cards with diff-backed hunks and suggested concerns.
- Each card's `nav_label` (optional, supplied by the agent) becomes the card `navLabel`; when missing or empty/whitespace-only the server derives a compact label from the title, whereas a non-empty over-cap label (>3 words / >24 chars) is rejected with a validation error. See [Short navigation labels](#short-navigation-labels).
- `omissions_and_followups` feed Other + omissions guidance and card-level suggested comments.
- `audit` feeds the final Audit card and draft reviewer checklist.
- `display.phase_order` and `display.chunk_order` influence visible ordering while preserving the known phase set.

Hunk references are best-effort mapped to parsed diff blocks by normalized file
path and hunk identity. Exact hunk-header matches are preferred, but Bobbit also
maps by the numeric old/new hunk ranges when either side includes, omits, or
changes the trailing context text after the closing `@@`. Unmapped references are
preserved as warnings or card suggestions rather than silently disappearing, and
fallback file-level mapping avoids duplicating diff blocks.

The older model-backed synthesis and deterministic grouping remain compatibility
behavior for direct resolver paths (see
[Agent-side walkthrough lifecycle](#agent-side-walkthrough-lifecycle-retained)).
The pack flow populates cards only from validated YAML, never from chat text or
silent model synthesis.

## Review flow

The walkthrough is organised into five phases:

1. **Orientation** — confirms scope, refs, provider metadata, stats, warnings, original PR body, inferred author intent, and merge assessment. Rendered as a guided six-beat step-through rather than a single card body (see [Guided orientation step-through](#guided-orientation-step-through)).
2. **Key design choices** — highlights architecture or product decisions and their trade-offs.
3. **Significant changes** — reviews high-signal implementation diffs.
4. **Other + omissions** — covers smaller changes, expected artifacts, and follow-up concerns.
5. **Audit** — checks remaining coverage and renders the final draft review.

Every phase can contain normal diff-backed cards. A card can span multiple files
or hunks when that better matches the reviewer story. Audit cards use the same
line comments, card comments, suggestions, diff expansion, and Like/Dislike
controls as other cards, then render the copyable draft review.

## Guided orientation step-through

Phase 0 (Orientation) is rendered as a **guided step-through** rather than a single
card body. This exists because the orientation card previously joined the
structured context fields (`why_created`, `problem_solved`, `why_worth_merging`,
`author_intent`, `reviewer_map`, `merge_assessment`, `merge_concerns`) into two
`\n`-joined `<p>` blobs. CSS collapses those newlines into a single space, so the
reviewer faced an intimidating wall of text with the verdict, concerns, and
reviewer file-map all buried. The redesign breaks orientation into six single-idea
**beats**, each readable in under ~20 seconds, with Back/Next navigation and a step
counter.

The six beats are **server-defined** and sourced entirely from the existing YAML
`walkthrough.context` + `merge_assessment` — no new agent fields are required:

1. **At a glance** — a verdict badge (`recommendation` + `confidence`, e.g. `APPROVE · medium confidence`), the one-line summary, and the diff stats.
2. **Why it exists** — `why_created` (eyebrow "The problem").
3. **What it changes** — `problem_solved` (eyebrow "The change").
4. **Should it be merged?** — reframed from "Why it's worth merging" to lead with the recommendation: an answer-first line (`Yes — approve, medium confidence.` / `Not yet — request changes, …` / `Maybe — comment, …` / `Recommendation unclear.`) followed by `why_worth_merging`.
5. **What to scrutinise** — blocking and non-blocking concerns as severity-tagged rows, with a `N blocking, M non-blocking` tally. Blocking and non-blocking are counted by explicit `severity`; `question`/`nit` rows (e.g. a `merge_concerns` note) are excluded from the non-blocking count.
6. **Where to look** — the reviewer map rendered as a file → role list (Core / Support / Verify / Docs, best-effort parsed from `reviewer_map` lines), plus the collapsible original PR description.

Navigation:

- **Back** is disabled on the first beat. **Next** advances one beat; on the last beat it reads **"Start review →"** and advances to the next card, marking the orientation card complete.
- **Per-section rail circles.** Under the Phase 0 rail entry, the panel renders one circle per beat with the beat's ≤3-word label below it. Visited beats show a filled `✓`, the current beat a ringed primary dot, and upcoming beats a hollow circle. Clicking a circle jumps to that beat; Back/Next keep the rail circles in sync. When orientation is not the active card, all circles render done if it was completed, else hollow.

Both `sections` and the per-beat model are **optional and backward-compatible**: an
orientation card without `sections` (legacy or partial YAML) falls back to the
legacy single card-button in the rail and the generic card body. The legacy
`summary`/`rationale`/`checklist` fields are still populated so older renderers and
stored payloads keep working; the redesigned panel prefers `sections`.

## Short navigation labels

Every sidebar rail entry uses a compact label distinct from the card's full
descriptive title. This exists because full titles (e.g. `render.ts: fullscreen
predicate and standalone panel simplification`) overflow and truncate badly in the
~240px rail. The full title is retained for the card `<h2>` header and the rail
`title=` tooltip; the rail itself shows the short label.

- The rail renders `card.navLabel ?? deriveNavLabel(card.title)` for every card, and the beat's own `navLabel` for orientation circles.
- `deriveNavLabel` and `navLabelError` live in `src/shared/pr-walkthrough/nav-label.ts` (shared by server and the pack panel). The cap is `NAV_LABEL_MAX_WORDS = 3` and `NAV_LABEL_MAX_CHARS = 24`. `deriveNavLabel` takes the text before the first `:` / `—` / ` - ` separator (when non-empty), keeps the first ≤3 words, and hard-truncates to 23 chars + `…` if still over the char cap. `navLabelError` rejects empty/whitespace-only, >3-word, or >24-char labels.
- The review agent may supply an optional `nav_label` per card in its submitted YAML (see [PR walkthrough agent UX](design/pr-walkthrough-agent-ux.md)). In the `submit_pr_walkthrough_yaml` path the server derives a label from the title when `nav_label` is **missing or empty/whitespace-only**; a non-empty `nav_label` that exceeds the caps (>3 words or >24 chars) is **rejected with a validation error** rather than silently truncated, so the agent fixes it and resubmits. (The derive-on-invalid fallback applies only to the internal model card-synthesis path, not to submitted YAML.) Either way, existing and partial YAML always render a non-truncating rail label.

## Diff behaviour

Diffs render from the card/block/hunk model in two modes:

- **Split** — side-by-side old/new columns. This is the default in wide layouts.
- **Inline** — a single column. This is the default in narrow layouts.

The user can toggle either mode at any width. Split diffs use one shared
horizontal overflow container per diff widget, so old and new columns scroll
together.

Deleted old-side lines and added new-side lines each have their own suggestions,
saved comments, and active editor below the row. Context rows share a single detail
area because both columns represent the same logical line.

Diff rendering is defensive at two layers so a single malformed block can never
blank the whole pane:

- **Header coercion.** `PrWalkthroughHunk.header` is a required `string`, but both the producer and the renderer treat it defensively. The synthesis at `src/shared/pr-walkthrough/yaml-to-cards.ts` and the pack panel (`market-packs/pr-walkthrough/lib/panel.js`) coerce a non-string header to `""` (rendering no signature label) instead of dereferencing it. The producer honors the same contract — the bundle-reconstruction path (`diffBlockFromBundleFile` and the writer `bundleHunkFromDiffHunk` in `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts`) coerces `header` to a string, and the `isDiffBlock` guards require a string hunk `header` before admitting a block.
- **Per-block error boundary.** Each diff block renders through a `try/catch` wrapper; on a render throw it logs a warning and renders a small local fallback (`data-testid="pr-walkthrough-diff-block-error"`) naming the file, so the rest of the card and panel stay interactive. See [docs/design/pr-walkthrough-hunk-header-fix.md](design/pr-walkthrough-hunk-header-fix.md) for the regression this guards against.

## Comments, decisions, and draft review

Review state is built from comments plus per-card decisions.

### Line comments

Diff lines are interactive. Hovering or clicking a line reveals the comment
affordance; keyboard users can open it from the focused line. Line comments are
anchored by card id, diff block id, and line id. Export mapping later resolves those
anchors to provider-specific file/side/line coordinates.

Suggested line comments can appear beside matching lines. The reviewer can accept,
accept and edit, or dismiss them. Accepted suggestions become normal queued
comments.

### Card comments

Every card has a card-level comment area for broad concerns that do not belong on a
specific line. Card-level comments are included in the audit/export body rather than
submitted as GitHub line comments.

### Like, Dislike, and Prev

- **Like** records an approval decision, marks the card complete, persists reviewer
  state, emits the draft/completion event, updates header/rail progress, and
  advances to the next card.
- **Dislike** is disabled until the card has at least one non-empty supporting line
  or card comment. Once enabled, it records the supporting comment ids, marks the
  card complete, persists state, and advances like Like.
- **Prev** moves back so reviewers can revise comments or decisions; selected
  decisions remain visible in the footer and in labelled/collapsed rail state.

If the last supporting comment for a disliked card is deleted, the invalid disliked
decision is cleared and the card is no longer complete. This prevents unsupported
change requests from appearing in the audit draft.

### Audit draft

The audit draft is assembled from current state:

- changeset title and base/head metadata;
- liked cards under approved context;
- disliked cards and supporting comments under concerns;
- queued line comments grouped with file/line anchors;
- broad card-level comments.

The draft can always be copied, even when provider export is unavailable.

## Persistence and reload

The pack panel's reviewable state has three durable layers:

- **Persisted cards (pack store)** — on a successful `submit_pr_walkthrough_yaml`, the pack's `publish` route validates the YAML, synthesizes cards via `yaml-to-cards.ts`, and persists them in the pack-namespaced `host.store` keyed by changeset id, with a stamped-once `persistedAt`. The persisted job pointer also records the base/head SHAs so a deep-link carrying only the `jobId` can recompute the same changeset.
- **Live changeset (recomputed)** — the changeset itself is **not** stored as a frozen payload; the `bundle` route recomputes it live via `git` from the session worktree on every open, then overlays the persisted cards.
- **Reviewer interaction state (pack store + local fallback)** — the panel persists active card, orientation beat, rail collapsed/width, diff mode, comments, decisions, completed review status, dismissed suggestions, collapsed diff blocks, and context expansion under `review-state/<panel>/<job>` in the pack-scoped `host.store`. It also mirrors the same payload to `localStorage` under `bobbit:pr-walkthrough:<review-state-key>` so a tab can recover when host-store persistence is unavailable. This state is per reviewer child/job; it is not an owner-session surface.

The walkthrough lives **only** in the reviewer child session, so reload recovery
happens there. The reviewer's `submit_pr_walkthrough_yaml` call lives in the child
session, not any owner transcript, and a full reload clears the in-memory poll
state — so the child pane rehydrates **automatically on mount** (the read-only
auto-open carve-out) by calling the **`recover`** route. `recover` is
**child-self only**: it resolves the submitted YAML from the child's own
`binding/<self>` (keyed by that binding's job id); the old owner-scoped
`last/<owner>` fallback was removed with the owner-session surface. The child pane
then re-reads the live changeset through the `bundle` route (live `git` recompute +
persisted cards from `host.store`). `publishAndLoad` is idempotent, so the *same*
persisted cards re-render (same `persistedAt`) on every reload of that child pane.
See [the run / status / recover routes](#the-run--status--recover-routes) for the
authorization detail.

## GitHub export

GitHub export is deliberately two-step and user-confirmed:

1. **Preview** — `POST /api/pr-walkthrough/<changeset-id>/export/preview` maps the current draft to a review body and per-line GitHub review comments.
2. **Confirmed submit** — `POST /api/pr-walkthrough/<changeset-id>/export/submit` requires `confirm: true`. The UI only sends this after the reviewer clicks **Confirm submit to GitHub** in the preview dialog.

The walkthrough analysis agent never submits comments or reviews to GitHub.
`readonly_bash` also blocks GitHub review/comment actions during analysis.

Preview behavior:

- Line comments with valid diff anchors map to GitHub `path`, `side`, and `line`.
- Deleted-side comments map to `LEFT`; added/context comments map to `RIGHT` when a new line number exists.
- Card-level comments are folded into the review body.
- Empty comments, missing anchors, binary files, and unreviewable/truncated lines are marked unmappable and shown in the preview warnings.

Submit behavior:

- Requires a GitHub walkthrough target and an available export capability.
- Requires `GITHUB_TOKEN` or `GH_TOKEN` at submit time.
- Uses the current draft event as **Request changes** when there are comments or disliked cards; otherwise it submits an approval.
- Returns the GitHub review URL when GitHub provides one.

Unavailable cases still show a safe preview/copy path. Local changesets,
unauthenticated GitHub walkthroughs, missing adapters, invalid tokens, insufficient
permissions, and unmappable-only drafts do not silently submit.

In the first-party pack shell, the compact header Submit button opens the same
visible preview/unavailable workflow after all non-audit cards are reviewed. Until
a pack-compatible direct submit route is available, that dialog renders the local
fallback draft, maps line/card rows as valid or unmappable, keeps `Submit to
GitHub` disabled, and leaves `Copy draft` available.

## Edge states and warnings

The panel renders waiting, validation-failed, loading, error, empty, and warning
states instead of falling back to broken UI.

Common warning/error categories:

- **Missing PR** — GitHub `404` responses return a structured error and the panel shows the failure.
- **Authentication failure** — GitHub `401` indicates the configured token was rejected.
- **Permission failure** — GitHub `403` with remaining rate limit usually means the token cannot access the repository or PR.
- **Rate limit** — GitHub `403` with no remaining quota reports rate limiting; configure a token or retry later.
- **Validation failure** — invalid YAML keeps the panel empty and returns retryable field-level errors.
- **Missing or unusable analysis bundle** — missing, corrupt, or unreadable launch bundle artifacts return retryable `PR_WALKTHROUGH_BUNDLE_MISSING`; rerun the walkthrough so Bobbit resolves a fresh bundle before analysis.
- **Agent runtime failure** — runtime failures before YAML publication become job errors shown in the session and panel.
- **Large/truncated diffs** — local diff output, GitHub patch bytes, per-file line counts, or changed-file pages can be truncated. Warnings identify the affected files when possible.
- **Generated files** — generated-looking paths are flagged as low-signal and grouped into edge-case cards.
- **Binary files** — binary changes have no reviewable text hunks and cannot receive GitHub line comments.
- **Renamed/deleted/copied files** — status and old paths are preserved so reviewers can understand the file movement and export can map valid line anchors.
- **Empty diffs** — resolve to an orientation-only walkthrough with zero changed files.
- **Untrusted PR hosts** — non-allowlisted hosts are rejected before fetching metadata or rendering clickable URLs (see [Trusted GitHub hosts](#trusted-github-hosts)).
- **No PR for the current branch** (`NO_PR`) — the `run` route found no open GitHub PR for the session's branch; the launcher dispatch shows an inline error in the git-status-widget dropdown and spawns nothing (no session, no view switch).
- **Local-only target** (`LOCAL_UNSUPPORTED`) — a base/head SHA pair with no GitHub PR is rejected before any reviewer is spawned (the run path is GitHub-PR-only — a local target could never submit the production YAML).

Warnings are shown at the top of the panel and again in export preview when they
affect submission.

## Agent-side walkthrough lifecycle (retained)

The agent that produces the walkthrough YAML, the read-only tool surface it uses,
and the `/resolve` · `/export/*` routes are **retained in the codebase**. The
legacy `WalkthroughAgentManager` launcher and its `/api/pr-walkthrough/launch`
route were **deleted** — the pack's `run` route mints the reviewer directly via
`host.agents.spawn` (see
[Launch model: the isolated reviewer child](#launch-model-the-isolated-reviewer-child)).
The walkthrough now runs in a **dedicated read-only reviewer child session**, not
the user's own agent; the read-only tool surface and the YAML-submission contract
below are otherwise unchanged.

### Read-only investigation tools

A walkthrough agent uses a narrow tool set:

- `read_pr_walkthrough_bundle` for bounded reads of the scoped persisted launch-time PR metadata and diff bundle;
- `readonly_bash` for additional read-only PR/diff/file inspection;
- `submit_pr_walkthrough_yaml` for publishing the completed walkthrough.

The agent prompt tells the agent to start with `read_pr_walkthrough_bundle` in
manifest mode, then request bounded file/hunk reads as needed. The bundle tool
authorizes by the reviewer's **verified caller session id** (sent as
`X-Bobbit-Session-Secret`, resolved server-side), resolves the job from the
reviewer's pack-store binding, reads only that walkthrough job's artifact, and
does not loosen `readonly_bash` path or command policy.

The reviewer holds **exactly** these three tools — granted by the pack-shipped
`pr-reviewer` role (see
[Launch model](#launch-model-the-isolated-reviewer-child)). It does not receive
unrestricted `bash`, file write/edit tools, build/test/install commands,
commit/push tools, GitHub review/comment submission tools, orchestration tools, or
any MCP server.

`readonly_bash` enforces policy before execution. At a high level it allows commands
such as:

- `gh pr view` and `gh pr diff` for the launched PR;
- scoped `gh api` reads for the launched repository and PR;
- read-only `git diff`, `git show`, `git log`, `git grep`, `git rev-parse`, `git status`, and `git for-each-ref` for ref inspection/search;
- bounded file/search commands such as `rg`, `grep`, `find`, `ls`, `cat`, `head`, `tail`, `pwd`, and `sed`.

It blocks mutating commands, tests/builds, dependency installs, server starts, shell
chaining/redirection, long-running follow modes, hidden/ignore override flags, unsafe
`git grep` pager/editor or untracked/ignore-bypass flags, sensitive path reads,
repo-local executable spoofing, cross-repository or cross-PR GitHub reads, and `gh`
actions that would create reviews or comments. `git for-each-ref` is allowed only as
read-only ref inspection; escape/output flags such as `--git-dir`, `--work-tree`,
`--output`, `--shell`, `--perl`, `--python`, and `--tcl` remain blocked.

### YAML submission is the completion path

The walkthrough is populated only through `submit_pr_walkthrough_yaml`. The agent
must submit exactly one YAML document matching the PR walkthrough schema. A final
chat answer is never treated as completion.

The agent prompt includes the schema as a fenced `yaml` block for readability. That
fence is documentation only: the `submit_pr_walkthrough_yaml` tool argument must be
raw YAML with no Markdown fences, backticks, blockquotes, commentary, or extra YAML
documents.

The gateway validates:

- YAML syntax and single-document shape;
- required fields, enum values, size limits, and cross-field target consistency;
- authoritative PR identity against the launched target;
- hunk/file references against the stored launch-time analysis bundle where possible.

On validation failure, the job moves to `validation_failed`, the panel remains
unpopulated, and the tool returns field-level retry feedback such as `path` plus
`message`. The agent can fix the YAML and call the tool again. If the stored bundle
is missing, corrupt, or unusable, submission fails deterministically with retryable
`PR_WALKTHROUGH_BUNDLE_MISSING`; Bobbit does not silently re-fetch the PR at submit
time. On success, Bobbit maps the YAML into the renderable payload, persists it,
marks the job `ready`, and broadcasts the update. Further `submit_pr_walkthrough_yaml`
calls are rejected once the job is `ready`; the published payload is immutable for
that job.

### Target scoping and canonicalization

GitHub PR targets are canonicalized so repeated launches focus the same job instead
of duplicating work:

- Full PR URL: `github:<owner>/<repo>#<number>` for github.com, or `github:<host>/<owner>/<repo>#<number>` for a trusted enterprise host.
- Number-only launch: Bobbit infers `<owner>/<repo>` from the launching session's GitHub `origin` remote and then uses the same canonical key (host-qualified for non-github.com remotes).

The host is included in the canonical key for non-github.com hosts so two trusted
enterprise hosts sharing the same owner/repo/PR number do not collide into one job;
github.com keeps its legacy unqualified key. See
[Enterprise host identity and token scoping](#enterprise-host-identity-and-token-scoping).

A number-only target fails with an actionable error when the session worktree has no
GitHub `origin` remote. Passing a full PR URL avoids that dependency.

The reviewer child receives the launched GitHub target — provider, owner, repo, and
number — as **non-secret** `BOBBIT_WALKTHROUGH_TARGET_*` environment variables,
passed through `host.agents.spawn`'s `toolEnv`. `readonly_bash` uses those values
to reject cross-repo and cross-PR GitHub reads. There is **no submit proof**: the
submit and bundle endpoints authorize by the reviewer's verified caller session id
and route via the pack-store binding (see
[Launch model](#launch-model-the-isolated-reviewer-child)). The legacy
`BOBBIT_WALKTHROUGH_SUBMIT_PROOF` secret was deleted.

### Local changesets and the compatibility resolver

Agent-hosted walkthroughs currently support GitHub PRs only. The
`POST /api/pr-walkthrough/resolve` compatibility resolver remains relevant for:

- fixtures and development compatibility;
- local SHA-pair walkthroughs;
- restoring already-persisted walkthrough payloads by `changesetId`.

Local walkthroughs can produce review drafts and export previews, but they cannot
submit to GitHub because there is no provider review target. The pack panel itself
recomputes the changeset live through the pack's `bundle` route rather than relying on
a standalone pathname route.

### API summary

The walkthrough API is internal to Bobbit but useful for tests and integrations:

- **Launch is the pack `run` route, not a REST endpoint.** The legacy
  `POST /api/pr-walkthrough/launch` route and its `WalkthroughAgentManager` were
  **deleted**. The reviewer child is minted by the pack's `run` route via
  `host.agents.spawn`; the analysis bundle is resolved lazily on first
  `read_pr_walkthrough_bundle` (see [Launch model](#launch-model-the-isolated-reviewer-child)).
- `GET /api/internal/pr-walkthrough/bundle` / `POST /api/internal/pr-walkthrough/bundle` — internal endpoint used only by `read_pr_walkthrough_bundle`; authorizes by the verified caller session id (`X-Bobbit-Session-Secret`), resolves the job + target from the reviewer's pack-store binding, lazily resolves and caches the analysis bundle, and returns bounded manifest/file reads. `/api/internal/pr-walkthrough/analysis-bundle` is the compatibility alias.
- `POST /api/internal/pr-walkthrough/submit-yaml` — internal tool endpoint used only by `submit_pr_walkthrough_yaml`; authorizes by the verified caller session id (`X-Bobbit-Session-Secret`) and routes to the job bound to that session (no submit proof). Cross-job and terminal-job submissions are rejected. It persists the submitted YAML (`submitted/<jobId>` + `binding.status = "submitted"`) and **stops there** — it does **not** dismiss the reviewer, stamp a `childTerminal` terminal marker, or write any owner `last/<sessionId>` pointer (the reviewer stays live; recovery is child-self only — see [Lifecycle](#lifecycle-no-auto-dismiss-restart-survival-and-termination)).
- `POST /api/pr-walkthrough/resolve` — compatibility resolver for fixture/local/direct walkthrough payloads. Stores the resolved payload.
- `POST /api/pr-walkthrough/<changeset-id>/export/preview` — build a provider review preview from a draft.
- `POST /api/pr-walkthrough/<changeset-id>/export/submit` — submit a provider review only when `confirm: true` and export is available.

The pack viewer's own data (the live `bundle` recompute and the `publish` card
persistence) is served by the pack's `lib/routes.mjs` over the pack-namespaced
`host.store`, reached via `host.callRoute` — **not** by any of the routes above. The
former bespoke viewer-feed routes (`GET /api/pr-walkthrough/jobs/:id`, `/session/:id`,
`/:id`) were **deleted**.

## Target scoping notes for credentials and configuration

- `GITHUB_TOKEN` / `GH_TOKEN` — used for github.com API requests and required for review submission to github.com.
- `BOBBIT_GITHUB_API_BASE_URL` — overrides the GitHub API base URL, useful for GitHub Enterprise or tests.
- `BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER` — optional module path for compatibility resolver synthesis.

For compatibility resolver model synthesis without a custom adapter, Bobbit uses the
selected session model when available, then the default review model, then the default
session model. The agent-hosted GitHub flow instead relies on the walkthrough agent and
validated YAML submission.

### Trusted GitHub hosts

A walkthrough fetches PR metadata and diffs over the network, so Bobbit only talks to
an allowlist of trusted hosts. The allowlist is the **only** source for extra hosts;
the former `BOBBIT_GITHUB_TRUSTED_HOSTS` env var is no longer read anywhere.

- **Always-trusted baseline.** `DEFAULT_TRUSTED_HOSTS` in `src/shared/pr-walkthrough/url-safety.ts` (`github.com`, `www.github.com`, `api.github.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com`) is trusted regardless of settings and cannot be removed. The managed list only adds **extra** hosts on top — typically GitHub Enterprise hosts.
- **Where it lives.** The extra hosts are managed in **System → General → Trusted GitHub hosts** and persisted in the server-side global preferences store under the key `githubTrustedHosts: string[]` — the same store behind `GET`/`PUT /api/preferences`. Storing it server-side (rather than per-browser) means the allowlist is shared across clients and is readable by the server code that performs the fetches.
- **Live per request.** The server reads `githubTrustedHosts` from the preferences store on each launch/resolve, not at boot, so adding a host takes effect immediately **without a server restart**.
- **Normalization and validation on save.** `PUT /api/preferences` runs `normalizeTrustedHosts` over the submitted value. Each entry is lowercased, has any trailing dot stripped, and — if a full URL is pasted — reduced to its host. Entries with a path, whitespace, credentials, a port, or an invalid DNS label are rejected, the list is deduped (first-seen order preserved), and any baseline host is dropped so the managed list shows only true extras. Saving is lossy and never returns a 4xx: the server stores the accepted subset and the UI re-fetches because the `GET` readback is authoritative. An empty or all-invalid list removes the key entirely.

The host trust check is enforced server-side on `/launch` and `/resolve`: a target on a
host that is neither in the baseline nor the managed allowlist is rejected **before**
any job is created, returning HTTP `400` with body `{ code: "untrusted_github_host", host }`.

### Enterprise host identity and token scoping

Trusted non-`github.com` hosts are carried through identity and credentials
differently from github.com:

- **Changeset / canonical identity includes the host.** For github.com the identity keeps its legacy unqualified shape (`github:<owner>/<repo>#<number>`); for any other trusted host the host is included (`github:<host>/<owner>/<repo>#<number>`). This prevents two trusted hosts that share the same owner/repo/PR number from colliding into the same job or stored changeset.
- **Tokens are host-scoped.** The global `GITHUB_TOKEN` / `GH_TOKEN` are github.com credentials and are **never** forwarded to a non-github.com host (that would leak a github.com secret to an enterprise server). Enterprise hosts authenticate only via the host-scoped GitHub CLI token (`gh auth token --hostname <host>`); github.com may still use the env tokens or the unscoped CLI token.

## Limitations

- The launch (spawn-on-click) gesture is **GitHub-PR-only**: it resolves the current branch's open PR (or an explicit GitHub target) and rejects local-only targets (`LOCAL_UNSUPPORTED`). Local SHA-pair walkthroughs are available only through the compatibility resolver, which cannot submit to GitHub.
- Running the walkthrough requires an open GitHub PR for the session's branch (else `NO_PR`).
- Number-only / current-branch launch depends on the launching session worktree having a GitHub `origin` remote.
- Reviewer interaction state is scoped to a reviewer child/job. It persists through reload via the pack store plus local fallback, but it is not an owner-session artifact and should not be treated as a shared project review record.
- GitHub line-comment export can only submit comments with valid GitHub review anchors. Card-level and unmappable comments remain in the review body/preview.
- Binary files and files without text patches cannot receive line comments on GitHub.
- Large diffs may show representative hunks and truncation warnings rather than every changed line.
- Unauthenticated public PR resolution is best-effort and subject to GitHub's lower anonymous API rate limits.

## Troubleshooting

- **Cannot find the repository for a number-only target** — select a session whose worktree has a GitHub `origin` remote, or use the full PR URL.
- **"No open GitHub PR for the current branch" (`NO_PR`)** — open a PR for the branch, then run the walkthrough again.
- **Local changeset is unsupported (`LOCAL_UNSUPPORTED`)** — the Run gesture is GitHub-PR-only; use the compatibility resolver flow for `baseSha` / `headSha` walkthroughs instead.
- **Panel stays empty** — the reviewer child has not successfully called `submit_pr_walkthrough_yaml`; check the reviewer session in the sidebar and its validation state.
- **YAML validation failed** — fix the field-level errors returned by the tool and call `submit_pr_walkthrough_yaml` again from the same session.
- **`PR_WALKTHROUGH_BUNDLE_MISSING` or unusable bundle** — the launch-time analysis bundle artifact is missing, corrupt, or no longer readable. This is retryable, but submission will not re-fetch the diff; rerun the walkthrough so Bobbit resolves and persists a fresh bundle.
- **Private PR fails or shows permission errors** — set `GITHUB_TOKEN` or `GH_TOKEN` with repository read and pull request review permissions, then retry.
- **Rate limited** — configure a token or wait for GitHub's rate limit reset.
- **Export button only shows copy/preview** — the walkthrough is local, unauthenticated, missing a GitHub target, or export capability was disabled by the resolver.
- **Some comments are unmappable** — check whether the comment is card-level, attached to a binary/truncated file, or anchored to a line GitHub cannot review.
- **Reload loses comments after a PR update** — the card checksum changed, so Bobbit intentionally avoids restoring comments onto a different diff. Re-run the walkthrough and review the updated cards.
- **GitHub Enterprise URL is rejected** — add the host under System → General → Trusted GitHub hosts, and configure the matching API base URL.
- **The PR-walkthrough viewer is missing entirely** — the built-in first-party pack may be disabled. Re-enable it from the Market built-in section (see [docs/marketplace.md](marketplace.md#built-in-first-party-packs)); a disabled pack removes the launcher, deep-link, and panel by design.

## Testing notes

Coverage is split across unit, API E2E, and browser E2E tests:

- YAML schema validation and YAML-to-card mapping (`src/shared/pr-walkthrough/yaml-to-cards.ts`);
- read-only command policy and walkthrough tool metadata;
- session-list synchronization: visible session creation emits `session_created` or `sessions_changed` before the polling fallback (`tests/e2e/session-created-sync.spec.ts`), and the mobile landing page keeps an authenticated `/ws/viewer` listener that refreshes the session list without creating a `RemoteAgent` (`tests/e2e/ui/session-created-push-sync.spec.ts`);
- the isolated reviewer child: `run` mints a `host-agents` / `pr-reviewer` read-only child with the `magnifier` accessory and the `PR Walkthrough` session title and the owner's agent is never prompted, the reviewer's allowlist is exactly the three walkthrough tools, always-fresh launch (two `run` calls for the same PR → two distinct reviewers), and owner-gone cascade cleanup (`tests/e2e/pr-walkthrough-host-agents.spec.ts`);
- binding-routed submit/bundle authorization by `X-Bobbit-Session-Secret` (no submit proof anywhere in the tree), and submit/validation behavior;
- the agent-side resolve/export routes;
- the isolated reviewer child at the API level: the spawned reviewer's tool **guard** blocks none of the three walkthrough tools and its system prompt carries the YAML schema, a restored reviewer re-resolves the pack role cascade-first (keeping its tools + schema across a gateway restart), `status`/`recover` authorize from the **child side** (`isChild`) with right-job routing preserved (a foreign session is rejected), and after submit the reviewer is **not** dismissed — it stays a live, selectable session that survives a simulated gateway restart (no `childTerminal` marker) until the user-facing terminate control archives it (`tests/e2e/pr-walkthrough-host-agents.spec.ts`);
- browser behavior for the pack-served viewer at `#/ext/pr-walkthrough` — the built-in-band pack resolution, spawn-on-click launchers, concrete tool/entrypoint activation toggles, no-PR inline `git-widget-launcher-error` (no session, no view switch), the **child-session pane** auto-opening in the pending `PR Walkthrough: In Progress` + spinner state with **no** Run/Load buttons, rendering ready cards on submit, and surviving reload via the child-self `recover`; plus validation retry state and explicit export confirmation (`tests/e2e/ui/pr-walkthrough-pack.spec.ts`);
- pack-panel shell parity with the prototype/reference UX: pending state, compact 58px-class header/stats/link/progress, single labelled/collapsed/resizable rail, container-based narrow collapse, guided orientation rail/card flow, compact cards, line/card comment workflows, `Prev` / `Like` / `Dislike` auto-advance, persisted reviewer state, audit draft, and export-preview unavailable/copy semantics (`tests/pr-walkthrough-panel-parity.spec.ts`);
- panel sizing: user-initiated fullscreen/collapse via the shared preview-panel toolbar and shortcuts, no auto-fullscreen on ready, persistence across reload, while keeping its internal rail toggle (see [Panel sizing](#panel-sizing-fullscreen-collapse-and-shortcuts));
- compatibility resolver coverage for local SHA resolution, stored payload reload, large diff warnings, empty diffs, GitHub errors, and export mapping.

When the visual PR walkthrough shell changes, QA should include side-by-side screenshots comparing the prototype/reference (`docs/design/pr-walkthrough-panel-prototype.html`) with the delivered pack panel. Cover desktop side-panel, wide/full panel, narrow/mobile, pending state, ready state with multiple cards/diffs/comments, and light/dark themes. Use these tests and screenshots as the pinning contract when changing the pack viewer, agent-side launch/resolver behavior, YAML mapping, persistence, readonly policy, or panel UX.

### Validation commands for this area

Use the narrowest command that covers the change, then broaden when launch/routes or
shared host behavior changed:

```bash
npm run build:packs
npx playwright test --config tests/playwright.config.ts tests/pr-walkthrough-panel-parity.spec.ts
npm run test:unit
npm run test:e2e
```

Run `npm run check` when TypeScript, shared synthesis, Host API, or server/client
code changes. Pure markdown-only updates do not require it.

## Historical (pre-pack-migration) — retained for rationale

> **None of the content in this section is current.** It describes the **deleted**
> bespoke built-in viewer and its client-driven launch flow, retained only to
> explain why the current pack model is shaped the way it is. For how the feature
> works today, see [How it works now](#how-it-works-now-built-in-first-party-pack).
> The historical design records under `docs/design/` are the fuller source of this
> rationale: [pr-walkthrough-agent-session.md](design/pr-walkthrough-agent-session.md),
> [pr-walkthrough-pack-deletion.md](design/pr-walkthrough-pack-deletion.md),
> [side-panel-tab-contract.md](design/side-panel-tab-contract.md), and
> [walkthrough-panel-resize-fix.md](design/walkthrough-panel-resize-fix.md).

### Deleted client viewer and routes

The viewer used to be a bespoke client component,
`src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts` (plus the surrounding dir),
wired through `src/app/pr-walkthrough.ts`. It rendered in two places: a side panel
beside chat in a dedicated child session, and a popped-out standalone
`/walkthrough?session=<id>&tab=<walkthrough-tab-id>` browser tab rendered by
`standaloneWalkthroughPanel()` in `src/app/render.ts` (with a route-aware
`workspaceSessionId()` / `route.walkthroughSessionId` session-key helper). It was
fed by the now-removed viewer routes `GET /api/pr-walkthrough/jobs/:id`,
`GET /api/pr-walkthrough/session/:id`, and `GET /api/pr-walkthrough/:id`.

All of the above were **deleted**. The viewer is now the built-in pack panel at the
generic `#/ext/pr-walkthrough` route, fed by the pack's own `bundle`/`publish`
routes. The header-coercion defensiveness that lived in `PrWalkthroughPanel.ts` now
lives in `src/shared/pr-walkthrough/yaml-to-cards.ts` and the pack panel
`market-packs/pr-walkthrough/lib/panel.js`.

### Deleted client launch flow

A walkthrough used to be launched from a built-in UI surface:

- a `/walkthrough-pr <url|number>` **client-side slash intercept** in the composer (with the hint `<GitHub PR URL or #>`), parsed and handled by `src/app/pr-walkthrough.ts`;
- a Git Status widget **Walkthrough** button that dispatched an `open-pr-walkthrough` event;

both of which routed to `launchPrWalkthroughAgent` → `POST /api/pr-walkthrough/launch`,
**spawning a dedicated read-only child walkthrough session** beneath the launching
session (`parentSessionId` + `childKind: "pr-walkthrough"`). The child started in a
`waiting_for_yaml` state with an empty panel until the agent called
`submit_pr_walkthrough_yaml`, and re-launching the same PR focused the existing child.

That entire client launch path was deleted.

> **Update:** this historical paragraph described an interim pack model in which
> the "Run PR walkthrough" action drove the **current** session's agent via
> `host.session.postMessage` (because minting a child principal was not
> pack-expressible at the time). That interim model is itself now superseded:
> the `/launch` route and `WalkthroughAgentManager` were **deleted**, and the pack
> mints a real isolated read-only reviewer child via `host.agents.spawn` (see
> [Launch model: the isolated reviewer child](#launch-model-the-isolated-reviewer-child)).

### Deleted child-session sidebar nesting

Because the launch flow spawned a first-class child session, the sidebar nested that
child under its parent with an expand/collapse chevron, governed by an opt-out
"first-class parent" expansion model (`collapsedFirstClassParents` in `src/app/state.ts`,
localStorage key `bobbit-collapsed-first-class-parents`) modeled on the team-lead
`collapsedTeamLeadSessions` set. This was deliberately distinct from the opt-in
delegate-parent model so a purposely-launched walkthrough child was visible by default
while still being collapsible. With the client launch flow deleted, no built-in surface
creates such a child, so this nesting behavior is no longer exercised by the feature.

### Deleted untrusted-host launch dialog

The deleted client launch flow also surfaced a security-aware confirmation dialog when a
user launched against a host that was not in the trusted allowlist. Instead of toasting
the raw `untrusted_github_host` error, it named the host, warned that adding it lets
Bobbit fetch repository and PR content from that host, and offered **Add & continue**
(which persisted the host via `PUT /api/preferences` and retried the launch once) or
**Cancel**. The server-side host trust check on `/launch` and `/resolve` is
[retained](#trusted-github-hosts); only this client dialog and its one-shot retry were
removed with the rest of the client launch flow.

### Deleted standalone-tab resize behavior

The bespoke viewer's standalone `/walkthrough?...` browser tab filled the window with no
panel-level fullscreen/collapse chrome. The corresponding `standaloneWalkthroughPanel()`
branch and the `workspaceSessionId()` / `route.walkthroughSessionId` helper were deleted.
The current pack panel renders only at `#/ext/pr-walkthrough` and shares the preview
panel's user-initiated resize semantics (see
[Panel sizing](#panel-sizing-fullscreen-collapse-and-shortcuts)).
