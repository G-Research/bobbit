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
remains the UX reference for the ready-state review surface.

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
- **Launch.** A pack **entrypoint** — a git-widget button, a composer-slash
  launcher, a command-palette launcher, and a `kind:"route"` deep-link — opens
  the pack panel. The entrypoints carry **no** hard-coded `jobId`; opening a
  launcher just navigates to the panel.
- **Run.** When no walkthrough has been submitted for the session yet, the panel
  shows a **"Run PR walkthrough"** action. On the user's click it calls
  **`host.session.postMessage`** to direct the **current** session's agent to run
  the walkthrough using the kept agent tools (`readonly_bash`,
  `read_pr_walkthrough_bundle`, `submit_pr_walkthrough_yaml`). The walkthrough
  runs **in the session you launched it from**, not in a nested child session.
- **Job + SHAs from the submitted YAML.** The panel derives the real job id and
  the base/head SHAs from the agent's submitted YAML (`pr.owner` / `pr.repo` /
  `pr.number` → canonical job id; `pr.base_sha` / `pr.head_sha` → the SHAs it
  hands the `bundle` route). It reads that submission by scanning the current
  session's transcript for the `submit_pr_walkthrough_yaml` tool call
  (`host.session.readTranscript` → `host.session.readToolCall`).
- **Data via pack routes.** The panel never makes a raw `fetch`. It calls the
  pack's own routes (`market-packs/pr-walkthrough/lib/routes.mjs`, registered in
  `pack.yaml` `routes:`) through `host.callRoute`:
  - **`publish`** validates the submitted YAML and persists the synthesized cards
    in the pack-namespaced `host.store`.
  - **`bundle`** recomputes the changeset **live** via `git` inside the confined
    worker (the git working dir is always the session worktree, server-derived —
    never caller-supplied) and serves it together with any persisted cards.
- **YAML → cards.** The synthesis that turns the agent's validated YAML into
  review cards is shared at **`src/shared/pr-walkthrough/yaml-to-cards.ts`** and
  bundled into the pack's `publish` route, so the pack maps the YAML to cards
  itself.
- **Persistence.** On reload (or re-opening `#/ext/pr-walkthrough`) the panel
  re-reads state through the `bundle` route, which recomputes the changeset live
  and reads any persisted cards from `host.store`; a stamped-once `persistedAt`
  keeps the cards stable across reloads.

The **agent-side lifecycle** that actually produces the YAML — the three
read-only tools, `WalkthroughAgentManager`, and the
`/api/pr-walkthrough/launch` · `/resolve` · `/export/*` routes — is **retained**
in the codebase (see [Agent-side walkthrough lifecycle](#agent-side-walkthrough-lifecycle-retained)).
What changed is only that those routes are **no longer reached from a built-in UI
launcher**: the git-widget button and the `/walkthrough-pr` client intercept that
called `/launch` were deleted.

For the pack model, see
[docs/marketplace.md § Built-in (first-party) packs](marketplace.md#built-in-first-party-packs),
[docs/design/built-in-first-party-packs.md](design/built-in-first-party-packs.md),
and [docs/design/pr-walkthrough-pack-deletion.md](design/pr-walkthrough-pack-deletion.md).

## Panel sizing: fullscreen, collapse, and shortcuts

The pack panel opened at `#/ext/pr-walkthrough` uses the **same** resize logic as
the HTML preview panel — there is no walkthrough-specific resize code path. It
renders the shared unified toolbar with a fullscreen (wide review) button and a
collapse button, and it honors `state.previewPanelFullscreen` plus the per-session
collapse key (`bobbit-preview-collapsed-<id>`) identically to the preview panel.
The same keyboard shortcuts drive it: `toggle-sidebar` (Ctrl+[, expand one level),
`toggle-preview` (Ctrl+], collapse one level), and `toggle-fullscreen-preview`
(Ctrl+#, jump to fullscreen or collapsed). State persists across reload.

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
collapses/expands the review rail *within* the walkthrough, not the window-level
panel.

### Pinning tests

The pack-served viewer is covered end-to-end by
`tests/e2e/ui/pr-walkthrough-pack.spec.ts` (install-free built-in-band resolution
→ launcher → live `bundle` recompute → render → `publish` → reload persistence →
disable). HTML-preview-panel sizing is independently pinned by
`tests/e2e/ui/preview-fullscreen-controls.spec.ts` (the panel-sizing logic does
not touch the preview panel). See
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

- **Like** records an approval decision and advances.
- **Dislike** is disabled until the card has at least one non-empty supporting line or card comment.
- **Prev** moves back so reviewers can revise comments or decisions.

If the last supporting comment for a disliked card is deleted, the invalid disliked
decision is cleared. This prevents unsupported change requests from appearing in the
audit draft.

### Audit draft

The audit draft is assembled from current state:

- changeset title and base/head metadata;
- liked cards under approved context;
- disliked cards and supporting comments under concerns;
- queued line comments grouped with file/line anchors;
- broad card-level comments.

The draft can always be copied, even when provider export is unavailable.

## Persistence and reload

The pack panel's reviewable state has two durable layers plus browser-local
interaction state:

- **Persisted cards (pack store)** — on a successful `submit_pr_walkthrough_yaml`, the pack's `publish` route validates the YAML, synthesizes cards via `yaml-to-cards.ts`, and persists them in the pack-namespaced `host.store` keyed by changeset id, with a stamped-once `persistedAt`. The persisted job pointer also records the base/head SHAs so a deep-link carrying only the `jobId` can recompute the same changeset.
- **Live changeset (recomputed)** — the changeset itself is **not** stored as a frozen payload; the `bundle` route recomputes it live via `git` from the session worktree on every open, then overlays the persisted cards.
- **Reviewer interaction state (browser-local)** — the browser stores active card, diff mode, comments, decisions, completed cards, dismissed suggestions, and collapsed diff blocks under `bobbit:pr-walkthrough:<tab-id>`. This is local to the browser/tab and is not synchronized across browsers or devices.

When the app reloads or the user re-opens `#/ext/pr-walkthrough`, the panel re-reads
its state through the `bundle` route (live `git` recompute + persisted cards from
`host.store`); the stamped `persistedAt` keeps the cards stable across reloads.

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

Warnings are shown at the top of the panel and again in export preview when they
affect submission.

## Agent-side walkthrough lifecycle (retained)

The agent that produces the walkthrough YAML, the read-only tool surface it uses,
and the `WalkthroughAgentManager` + `/api/pr-walkthrough/launch` · `/resolve` ·
`/export/*` routes are **retained in the codebase**. What was removed is only the
*built-in UI launcher* that called `/launch` (the git-widget button and the
`/walkthrough-pr` client intercept — see
[Historical](#historical-pre-pack-migration--retained-for-rationale)). In the
current pack model the panel drives the **current** session's agent via
`host.session.postMessage` instead of spawning a dedicated child session, but the
underlying agent capabilities and routes below are unchanged.

### Read-only investigation tools

A walkthrough agent uses a narrow tool set:

- `read_pr_walkthrough_bundle` for bounded reads of the scoped persisted launch-time PR metadata and diff bundle;
- `readonly_bash` for additional read-only PR/diff/file inspection;
- `submit_pr_walkthrough_yaml` for publishing the completed walkthrough.

The agent prompt tells the agent to start with `read_pr_walkthrough_bundle` in
manifest mode, then request bounded file/hunk reads as needed. The bundle tool
validates the current `sessionId` and job id, reads only that walkthrough job's
artifact, and does not loosen `readonly_bash` path or command policy.

These agents do not receive unrestricted `bash`, file write/edit tools,
build/test/install commands, commit/push tools, or GitHub review/comment submission
tools.

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

The agent tool runtime receives scoped environment variables for the launched GitHub
target, including provider, owner, repo, and number. `readonly_bash` uses those
values to reject cross-repo and cross-PR GitHub reads. The submit tool also receives a
per-job submit proof; only its hash is persisted.

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

- `POST /api/pr-walkthrough/launch` — agent-side route that resolves and persists the analysis bundle for a GitHub PR target and records the walkthrough job. Returns the job, `changesetId`, status, and whether the job was newly created. **No built-in UI surface calls this route any more**; the pack panel drives the current session's agent via `host.session.postMessage` instead.
- `GET /api/internal/pr-walkthrough/bundle` / `POST /api/internal/pr-walkthrough/bundle` — internal endpoint used only by `read_pr_walkthrough_bundle`; requires scoped session/job access and returns bounded manifest/file reads from the persisted launch bundle. `/api/internal/pr-walkthrough/analysis-bundle` is the compatibility alias.
- `POST /api/internal/pr-walkthrough/submit-yaml` — internal tool endpoint used only by `submit_pr_walkthrough_yaml`; requires scoped session access and submit proof and maps against the stored launch bundle.
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

- Agent-hosted walkthroughs currently support GitHub PRs only.
- Number-only launch depends on the launching session worktree having a GitHub `origin` remote.
- Browser interaction state is local to the browser storage for the tab id; it is not synchronized between browsers or devices.
- GitHub line-comment export can only submit comments with valid GitHub review anchors. Card-level and unmappable comments remain in the review body/preview.
- Binary files and files without text patches cannot receive line comments on GitHub.
- Large diffs may show representative hunks and truncation warnings rather than every changed line.
- Unauthenticated public PR resolution is best-effort and subject to GitHub's lower anonymous API rate limits.

## Troubleshooting

- **Cannot find the repository for a number-only target** — select a session whose worktree has a GitHub `origin` remote, or use the full PR URL.
- **Local changeset is unsupported by the agent** — use the compatibility resolver flow for `baseSha` / `headSha` walkthroughs; agent-hosted walkthroughs are GitHub-only.
- **Panel stays empty** — the agent has not successfully called `submit_pr_walkthrough_yaml`; check the session transcript and validation state.
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
- job persistence, submit-proof restore, and submit/validation behavior;
- the agent-side launch/resolve/export routes;
- browser behavior for the pack-served viewer at `#/ext/pr-walkthrough` — launcher entrypoint, empty waiting panel, validation retry state, final cards, reload persistence, and explicit export confirmation (`tests/e2e/ui/pr-walkthrough-pack.spec.ts`);
- panel sizing: user-initiated fullscreen/collapse via the shared preview-panel toolbar and shortcuts, no auto-fullscreen on ready, persistence across reload, while keeping its internal rail toggle (see [Panel sizing](#panel-sizing-fullscreen-collapse-and-shortcuts));
- compatibility resolver coverage for local SHA resolution, stored payload reload, large diff warnings, empty diffs, GitHub errors, and export mapping.

Use these tests as the pinning contract when changing the pack viewer, agent-side
launch/resolver behavior, YAML mapping, persistence, readonly policy, or panel UX.

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

That entire client launch path was deleted. The `/launch` route, the child-session
model, and `WalkthroughAgentManager` still exist
([Agent-side walkthrough lifecycle](#agent-side-walkthrough-lifecycle-retained)), but no
built-in surface calls them. In the current pack model the panel's "Run PR walkthrough"
action drives the **current** session's agent via `host.session.postMessage` rather than
spawning a child.

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
