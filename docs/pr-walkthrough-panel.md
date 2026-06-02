# PR Walkthrough Panel

The PR walkthrough panel is Bobbit's guided review surface for pull requests and local changesets. For GitHub PRs launched from chat, Bobbit now hosts the walkthrough in a dedicated read-only child agent session so the reviewer can watch progress, inspect the generated review cards, and ask follow-up questions in the same PR-aware chat.

The panel model remains changeset-oriented rather than GitHub-specific. GitHub PRs, local SHA pairs, and fixtures all resolve into the same renderable payload: a changeset reference, diff blocks with hunks and line anchors, logical review cards, warnings, and export capability metadata. The session-hosted agent is the primary GitHub PR ingestion path; the older resolver remains for fixture/local compatibility and standalone restore.

The checked-in prototype in [`docs/design/pr-walkthrough-panel-prototype.html`](design/pr-walkthrough-panel-prototype.html) remains the UX reference for the ready-state review surface. This document describes the production launch, agent, persistence, export, and troubleshooting behavior around that UI.

## Launch paths and surfaces

Users can open a walkthrough from these entry points:

- **Slash command** — `/walkthrough-pr <url|number>` in chat.
  - The composer exposes `/walkthrough-pr` as a built-in slash-command autocomplete entry with the hint `<GitHub PR URL or #>`.
  - GitHub PR URLs carry the owner, repository, host, and PR number.
  - Numbers, with or without `#`, resolve against the launching session's GitHub `origin` remote.
  - Re-launching the same PR from the same parent focuses the existing walkthrough child when it is still usable.
- **Git Status Widget / custom event** — when the widget has PR metadata/status, its expanded Pull Request section shows a **Walkthrough** button. Clicking it dispatches `open-pr-walkthrough` with the detected PR number/URL/title/status plus branch, file stats, and local base/head metadata.
- **Standalone route** — `/walkthrough?session=<id>&tab=<walkthrough-tab-id>` opens an already-created walkthrough tab in a wide review surface.
- **Compatibility resolver** — fixture and local SHA walkthroughs can still be resolved directly into a tab by the standalone/local resolver paths. Session-hosted walkthrough agents currently support GitHub PR targets only.

For GitHub PR launches, the tab belongs to the child walkthrough session, not the launcher. Before that child exists, launch resolves and persists a sanitized analysis bundle containing the PR metadata, body, stats, diff hunks, warnings, limits, and export capability. The stored launch-time bundle is authoritative for the job; YAML submission maps against that bundle instead of re-fetching PR diff data.

The UI switches/focuses the child session, expands the needed sidebar containers, and shows the child underneath the launching session using first-class `parentSessionId` / `childKind: "pr-walkthrough"` metadata, not delegate-session metadata. This nesting applies to ordinary sessions, goal sessions, team member sessions, and team-lead rows, and it is restored after reload from persisted session metadata and sidebar expansion state. Terminated or archived walkthrough children are hidden while **Show Archived** is off and reappear nested under their parent when it is on.

The same ready walkthrough can be reviewed in:

- the child session side panel beside chat (with user-initiated fullscreen /
  collapse via the shared preview-panel toolbar — see [Panel sizing](#panel-sizing-fullscreen-collapse-and-shortcuts));
- the standalone `/walkthrough?...` route opened from the toolbar's
  open-in-new-tab control (no panel-level resize chrome — it fills the window).

### Untrusted-host launch dialog

A launch against a host that is neither in the always-trusted baseline nor the managed [trusted-host allowlist](#trusted-github-hosts) is rejected **before** any job, child session, or tab is created, so a failed launch never leaves a stale waiting tab. The host trust check is synchronous: `POST /api/pr-walkthrough/launch` returns HTTP `400` with body `{ code: "untrusted_github_host", host }`.

The UI detects the `untrusted_github_host` code (carried through `fetchWalkthroughJson` error handling, with the offending host taken from the response body and a message-regex fallback) and, instead of toasting the raw error, shows a security-aware confirmation dialog that:

- names the specific host that is not trusted;
- warns that adding it lets Bobbit fetch repository and pull-request content (metadata and diffs) from that host, and to continue only if the host is trusted;
- offers **Add & continue** and **Cancel**.

On **Add & continue**, Bobbit normalizes the host, persists it to `githubTrustedHosts` via `PUT /api/preferences`, and retries the launch once with the same input (a one-shot guard prevents retry loops if it still fails). Because the allowlist is read live per request, the retry succeeds without a server restart or re-entering the PR. On **Cancel**, the launch aborts cleanly — no walkthrough child, no tab. A defensive path also catches a `201` launch whose job is already in the `untrusted_github_host` error state and routes it through the same dialog rather than rendering an error tab.

## Panel sizing: fullscreen, collapse, and shortcuts

The in-app walkthrough side panel uses the **same** resize logic as the HTML
preview panel — there is no walkthrough-specific resize code path. When a
walkthrough is open beside chat it renders the shared unified toolbar with a
fullscreen (wide review) button and a collapse button, and it honors
`state.previewPanelFullscreen` plus the per-session collapse key
(`bobbit-preview-collapsed-<id>`) identically to the preview panel. The same
keyboard shortcuts drive it: `toggle-sidebar` (Ctrl+[, expand one level),
`toggle-preview` (Ctrl+], collapse one level), and `toggle-fullscreen-preview`
(Ctrl+#, jump to fullscreen or collapsed). State persists across reload.

The panel **never auto-enters fullscreen**. Fullscreen is strictly
user-initiated, via a toolbar button or one of those shortcuts. This matches the
preview panel and is the behaviour the rest of the app expects — a panel that
seizes the whole window on its own (for example when a walkthrough becomes ready)
is disruptive and was the source of the original "dead controls" bug. See
[design/walkthrough-panel-resize-fix.md](design/walkthrough-panel-resize-fix.md)
for the full root-cause analysis and the special-casing that was removed.

The walkthrough panel's **own internal rail sidebar toggle**
(`data-testid="pr-walkthrough-rail-toggle"`, rendered inside
`<pr-walkthrough-panel>` in `src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts`)
is a different control — it collapses/expands the review rail *within* the
walkthrough, not the window-level panel. It works on every surface and is
unaffected by the panel-level sizing logic.

### Standalone `/walkthrough` route has no panel-level chrome

A popped-out standalone walkthrough (opened with the toolbar's open-in-new-tab
control) IS the whole browser window — there is no adjacent chat pane to hide —
so "fullscreen", "collapse", and "expand" are meaningless there. The standalone
branch (`standaloneWalkthroughPanel()` in `src/app/render.ts`) renders no
panel-level fullscreen/collapse/expand chrome and does not read
`state.previewPanelFullscreen` or the collapse flag; the walkthrough simply
fills the window. The component's internal rail toggle still works.

### Single-source-of-truth session key (never bare `activeSessionId()`)

The in-app shortcut/detection gate (`hasActiveWalkthroughPanel()` in
`src/app/main.ts`), the collapse `localStorage` key, and the `canFullscreen`
predicate all key off **`workspaceSessionId()`** (in `src/app/render.ts`) rather
than a bare `activeSessionId()`. `workspaceSessionId()` is route-aware: on the
standalone `/walkthrough` route `activeSessionId()` is `undefined`, so it falls
back to the walkthrough's owning session id carried in the URL
(`route.walkthroughSessionId`). This keeps the standalone branch's lazy payload
restore reading the same session key the panel tab is stored under, so the
walkthrough hydrates correctly even with no connected session.

### Pinning tests

These behaviours are pinned by browser E2E and must not regress:

- **In-app controls are user-driven** — `tests/e2e/ui/pr-walkthrough-panel.spec.ts`
  ("in-app ready walkthrough panel resize controls are user-driven"): a ready
  panel does not auto-enter fullscreen, the fullscreen/collapse buttons and the
  `Ctrl+]` shortcut operate on it, and the collapsed state persists across
  reload.
- **Fullscreen is user-initiated, including on live children** — same file
  ("fullscreen toolbar control enters fullscreen on live child walkthroughs
  (user-initiated)") and `tests/e2e/ui/pr-walkthrough-real.spec.ts`.
- **Standalone has no panel-level chrome but keeps its rail toggle** — same file
  ("standalone ready walkthrough has no panel-level resize chrome but keeps its
  internal rail toggle").
- **HTML preview panel sizing unchanged** —
  `tests/e2e/ui/preview-fullscreen-controls.spec.ts` (this fix does not touch the
  preview panel).

See [design/walkthrough-panel-resize-fix.md](design/walkthrough-panel-resize-fix.md)
for the root-cause analysis and the corrected design (this supersedes the
incorrect first attempt in PR #677).

## Session-hosted GitHub PR flow

### 1. Launch or focus a child session

`/walkthrough-pr <url|number>` calls `POST /api/pr-walkthrough/launch` with the launching `sessionId` and target. The server:

1. resolves the parent session and cwd;
2. canonicalizes the GitHub target;
3. checks for an existing job for the same `(parentSessionId, canonicalKey)`;
4. creates a `starting` job record with stable job and child-session ids;
5. resolves PR metadata and diff data, sanitizes it, and persists the launch-time analysis bundle;
6. creates a normal read-only child session with role `pr-walkthrough` only after the bundle is usable;
7. marks the job `waiting_for_yaml`, opens the walkthrough tab in the child session, and prompts the agent to investigate.

The child title is `PR #<number> Walkthrough` when the PR number is known. If launch-time target or bundle resolution fails, Bobbit returns the structured job error before child creation/focus so no waiting child is left without input.

### 2. Empty waiting panel

The child session initially looks like a goal assistant: chat on one side, PR walkthrough panel on the other. The panel is intentionally empty while the agent investigates. It shows a waiting state explaining that cards appear only after the read-only walkthrough agent calls `submit_pr_walkthrough_yaml` with valid YAML.

Progress is reported in chat by the agent, not by a panel progress bar. The panel may also show validation or runtime errors from the job record, but it does not scrape chat messages into cards.

### 3. Read-only investigation

Walkthrough sessions receive a narrow tool set:

- `read_pr_walkthrough_bundle` for bounded reads of the scoped persisted launch-time PR metadata and diff bundle;
- `readonly_bash` for additional read-only PR/diff/file inspection;
- `submit_pr_walkthrough_yaml` for publishing the completed walkthrough.

The agent prompt tells the agent to start with `read_pr_walkthrough_bundle` in manifest mode, then request bounded file/hunk reads as needed. The bundle tool validates the current `sessionId` and job id, reads only that walkthrough job's artifact, and does not loosen `readonly_bash` path or command policy.

They do not receive unrestricted `bash`, file write/edit tools, build/test/install commands, commit/push tools, or GitHub review/comment submission tools.

`readonly_bash` enforces policy before execution. At a high level it allows commands such as:

- `gh pr view` and `gh pr diff` for the launched PR;
- scoped `gh api` reads for the launched repository and PR;
- read-only `git diff`, `git show`, `git log`, `git grep`, `git rev-parse`, `git status`, and `git for-each-ref` for ref inspection/search;
- bounded file/search commands such as `rg`, `grep`, `find`, `ls`, `cat`, `head`, `tail`, `pwd`, and `sed`.

It blocks mutating commands, tests/builds, dependency installs, server starts, shell chaining/redirection, long-running follow modes, hidden/ignore override flags, unsafe `git grep` pager/editor or untracked/ignore-bypass flags, sensitive path reads, repo-local executable spoofing, cross-repository or cross-PR GitHub reads, and `gh` actions that would create reviews or comments. `git for-each-ref` is allowed only as read-only ref inspection; escape/output flags such as `--git-dir`, `--work-tree`, `--output`, `--shell`, `--perl`, `--python`, and `--tcl` remain blocked.

### 4. YAML submission is the completion path

The walkthrough panel is populated only through `submit_pr_walkthrough_yaml`. The agent must submit exactly one YAML document matching the PR walkthrough schema. A final chat answer is never treated as completion.

The agent prompt includes the schema as a fenced `yaml` block for readability. That fence is documentation only: the `submit_pr_walkthrough_yaml` tool argument must be raw YAML with no Markdown fences, backticks, blockquotes, commentary, or extra YAML documents.

The tool posts to the internal submit endpoint with the child `sessionId`, job id, YAML text, and a scoped submit proof. The gateway validates:

- YAML syntax and single-document shape;
- required fields, enum values, size limits, and cross-field target consistency;
- authoritative PR identity against the launched target;
- hunk/file references against the stored launch-time analysis bundle where possible.

On validation failure, the job moves to `validation_failed`, the panel remains unpopulated, and the tool returns field-level retry feedback such as `path` plus `message`. The agent can fix the YAML and call the tool again. If the stored bundle is missing, corrupt, or unusable, submission fails deterministically with retryable `PR_WALKTHROUGH_BUNDLE_MISSING`; Bobbit does not silently re-fetch the PR at submit time. Relaunch the walkthrough so launch can resolve and persist a fresh bundle. If the agent becomes idle without a valid submission, Bobbit steers it to call `submit_pr_walkthrough_yaml`; after a failed submission, the reminder includes the last validation errors.

On success, Bobbit maps the YAML into the existing `WalkthroughStorePayload`, persists it, marks the job `ready`, broadcasts the update, and selects the child walkthrough tab. It does **not** auto-enter fullscreen — the panel shares the preview panel's user-initiated resize semantics, so the reviewer enters fullscreen only by an explicit action (see [Panel sizing](#panel-sizing-fullscreen-collapse-and-shortcuts)). The tool response tells the agent to stay available for follow-up questions.

### 5. Follow-up chat remains live

A successful YAML submission does not terminate the child session. The user can ask follow-up questions in the walkthrough chat while the PR context, previous investigation, and tool results remain loaded. The child session may carry `readOnly: true` metadata for tool/file policy, but live walkthrough children are still promptable; only archived or terminated walkthrough sessions render as non-interactive. Further `submit_pr_walkthrough_yaml` calls are rejected once the job is `ready`; the published payload is immutable for that job.

## Target scoping and canonicalization

GitHub PR targets are canonicalized so repeated launches focus the same child instead of duplicating work:

- Full PR URL: `github:<owner>/<repo>#<number>` for github.com, or `github:<host>/<owner>/<repo>#<number>` for a trusted enterprise host.
- Number-only launch: Bobbit infers `<owner>/<repo>` from the launching session's GitHub `origin` remote and then uses the same canonical key (host-qualified for non-github.com remotes).

The host is included in the canonical key for non-github.com hosts so two trusted enterprise hosts sharing the same owner/repo/PR number do not collide into one job; github.com keeps its legacy unqualified key. See [Enterprise host identity and token scoping](#enterprise-host-identity-and-token-scoping).

A number-only target fails with an actionable error when the session worktree has no GitHub `origin` remote. Passing a full PR URL avoids that dependency.

The child tool runtime receives scoped environment variables for the launched GitHub target, including provider, owner, repo, and number. `readonly_bash` uses those values to reject cross-repo and cross-PR GitHub reads. The submit tool also receives a per-job submit proof; only its hash is persisted.

## Local changesets and standalone behavior

Session-hosted walkthrough agents currently support GitHub PRs only. Launching an agent for a local `baseSha` / `headSha` changeset returns `LOCAL_WALKTHROUGH_AGENT_UNSUPPORTED` and tells the caller to use the standalone local walkthrough resolver.

The existing standalone/local resolver behavior remains relevant for:

- fixtures and development compatibility;
- local SHA-pair walkthroughs;
- restoring already-persisted walkthrough payloads by `changesetId`;
- the standalone `/walkthrough?...` route for an existing tab.

Local walkthroughs can produce review drafts and export previews, but they cannot submit to GitHub because there is no provider review target.

## Changeset and card model

The shared walkthrough model lives under `src/shared/pr-walkthrough/` and is consumed by both server and UI.

Key concepts:

- **Changeset** — provider, base/head SHAs, title, PR URL/number/title when present, and summary stats.
- **Diff block** — one reviewable file block with `filePath`, optional `oldPath`, status, generated/binary/truncated flags, external links, and hunks.
- **Hunk** — original hunk header plus ordered line records.
- **Line** — stable id, kind (`context`, `add`, `del`), side (`context`, `new`, `old`), text, and old/new line numbers for review anchors.
- **Card** — a logical review unit in one of the walkthrough phases. A card can contain multiple diff blocks across one or more files. Each card also carries an optional `navLabel` (a compact ≤3-word sidebar label distinct from the full `title`) and the Orientation card carries optional `sections` (the guided "beats" — see [Guided orientation step-through](#guided-orientation-step-through)). Both are optional, so legacy/partial payloads still render.
- **Warning** — visible ingestion, mapping, validation, or export issue with a severity, code, message, and optional file path.

The UI never needs to know whether cards came from the session-hosted YAML flow or the compatibility resolver. It renders the same cards, warnings, comments, decisions, draft review, and export preview for every provider.

## YAML-to-card mapping

Validated YAML is mapped into the existing card model:

- `walkthrough.context`, `merge_assessment`, and `pr.original_description.body` become the Orientation card, including the six structured guided `sections` (see [Guided orientation step-through](#guided-orientation-step-through)).
- `design_decisions` become Key design choices cards with trade-offs, alternatives, suggested concerns, and linked hunks.
- `review_chunks` become significant, other, or audit review cards with diff-backed hunks and suggested concerns.
- Each card's `nav_label` (optional, supplied by the agent) becomes the card `navLabel`; when missing or empty/whitespace-only the server derives a compact label from the title, whereas a non-empty over-cap label (>3 words / >24 chars) is rejected with a validation error. See [Short navigation labels](#short-navigation-labels).
- `omissions_and_followups` feed Other + omissions guidance and card-level suggested comments.
- `audit` feeds the final Audit card and draft reviewer checklist.
- `display.phase_order` and `display.chunk_order` influence visible ordering while preserving the known phase set.

Hunk references are best-effort mapped to parsed diff blocks by normalized file path and hunk identity. Exact hunk-header matches are preferred, but Bobbit also maps by the numeric old/new hunk ranges when either side includes, omits, or changes the trailing context text after the closing `@@`. Unmapped references are preserved as warnings or card suggestions rather than silently disappearing, and fallback file-level mapping avoids duplicating diff blocks.

The older model-backed synthesis and deterministic grouping remain compatibility behavior for direct resolver paths. The session-hosted GitHub flow does not populate cards from chat text or from silent model synthesis in the launcher.

## Review flow

The walkthrough is organised into five phases:

1. **Orientation** — confirms scope, refs, provider metadata, stats, warnings, original PR body, inferred author intent, and merge assessment. Rendered as a guided six-beat step-through rather than a single card body (see [Guided orientation step-through](#guided-orientation-step-through)).
2. **Key design choices** — highlights architecture or product decisions and their trade-offs.
3. **Significant changes** — reviews high-signal implementation diffs.
4. **Other + omissions** — covers smaller changes, expected artifacts, and follow-up concerns.
5. **Audit** — checks remaining coverage and renders the final draft review.

Every phase can contain normal diff-backed cards. A card can span multiple files or hunks when that better matches the reviewer story. Audit cards use the same line comments, card comments, suggestions, diff expansion, and Like/Dislike controls as other cards, then render the copyable draft review.

## Guided orientation step-through

Phase 0 (Orientation) is rendered as a **guided step-through** rather than a single card body. This exists because the orientation card previously joined the structured context fields (`why_created`, `problem_solved`, `why_worth_merging`, `author_intent`, `reviewer_map`, `merge_assessment`, `merge_concerns`) into two `\n`-joined `<p>` blobs. CSS collapses those newlines into a single space, so the reviewer faced an intimidating wall of text with the verdict, concerns, and reviewer file-map all buried. The redesign breaks orientation into six single-idea **beats**, each readable in under ~20 seconds, with Back/Next navigation and a step counter.

The six beats are **server-defined** and sourced entirely from the existing YAML `walkthrough.context` + `merge_assessment` — no new agent fields are required:

1. **At a glance** — a verdict badge (`recommendation` + `confidence`, e.g. `APPROVE · medium confidence`), the one-line summary, and the diff stats.
2. **Why it exists** — `why_created` (eyebrow "The problem").
3. **What it changes** — `problem_solved` (eyebrow "The change").
4. **Should it be merged?** — reframed from "Why it's worth merging" to lead with the recommendation: an answer-first line (`Yes — approve, medium confidence.` / `Not yet — request changes, …` / `Maybe — comment, …` / `Recommendation unclear.`) followed by `why_worth_merging`.
5. **What to scrutinise** — blocking and non-blocking concerns as severity-tagged rows, with a `N blocking, M non-blocking` tally. Blocking and non-blocking are counted by explicit `severity`; `question`/`nit` rows (e.g. a `merge_concerns` note) are excluded from the non-blocking count.
6. **Where to look** — the reviewer map rendered as a file → role list (Core / Support / Verify / Docs, best-effort parsed from `reviewer_map` lines), plus the collapsible original PR description.

Navigation:

- **Back** is disabled on the first beat. **Next** advances one beat; on the last beat it reads **"Start review →"** and advances to the next card, marking the orientation card complete.
- **Per-section rail circles.** Under the Phase 0 rail entry, the panel renders one circle per beat with the beat's ≤3-word label below it. Visited beats show a filled `✓`, the current beat a ringed primary dot, and upcoming beats a hollow circle. Clicking a circle jumps to that beat; Back/Next keep the rail circles in sync. When orientation is not the active card, all circles render done if it was completed, else hollow.

Both `sections` and the per-beat model are **optional and backward-compatible**: an orientation card without `sections` (legacy or partial YAML) falls back to the legacy single card-button in the rail and the generic card body. The legacy `summary`/`rationale`/`checklist` fields are still populated so older renderers and stored payloads keep working; the redesigned panel prefers `sections`.

## Short navigation labels

Every sidebar rail entry uses a compact label distinct from the card's full descriptive title. This exists because full titles (e.g. `render.ts: fullscreen predicate and standalone panel simplification`) overflow and truncate badly in the ~240px rail. The full title is retained for the card `<h2>` header and the rail `title=` tooltip; the rail itself shows the short label.

- The rail renders `card.navLabel ?? deriveNavLabel(card.title)` for every card, and the beat's own `navLabel` for orientation circles.
- `deriveNavLabel` and `navLabelError` live in `src/shared/pr-walkthrough/nav-label.ts` (shared by server and UI). The cap is `NAV_LABEL_MAX_WORDS = 3` and `NAV_LABEL_MAX_CHARS = 24`. `deriveNavLabel` takes the text before the first `:` / `—` / ` - ` separator (when non-empty), keeps the first ≤3 words, and hard-truncates to 23 chars + `…` if still over the char cap. `navLabelError` rejects empty/whitespace-only, >3-word, or >24-char labels.
- The LLM review agent may supply an optional `nav_label` per card in its submitted YAML (see [PR walkthrough agent UX](design/pr-walkthrough-agent-ux.md)). In the `submit_pr_walkthrough_yaml` path the server derives a label from the title when `nav_label` is **missing or empty/whitespace-only**; a non-empty `nav_label` that exceeds the caps (>3 words or >24 chars) is **rejected with a validation error** rather than silently truncated, so the agent fixes it and resubmits. (The derive-on-invalid fallback applies only to the internal LLM card-synthesis path, not to submitted YAML.) Either way, existing and partial YAML always render a non-truncating rail label.

## Diff behaviour

Diffs render from the card/block/hunk model in two modes:

- **Split** — side-by-side old/new columns. This is the default in wide layouts.
- **Inline** — a single column. This is the default in narrow layouts.

The user can toggle either mode at any width. Split diffs use one shared horizontal overflow container per diff widget, so old and new columns scroll together.

Deleted old-side lines and added new-side lines each have their own suggestions, saved comments, and active editor below the row. Context rows share a single detail area because both columns represent the same logical line.

Diff rendering is defensive at two layers so a single malformed block can never blank the whole pane:

- **Header coercion.** `PrWalkthroughHunk.header` is a required `string`, but the panel still treats it defensively: `hunkSignature` coerces a non-string header to `""` (rendering no signature label) instead of dereferencing it. The producer honors the same contract — the bundle-reconstruction path (`diffBlockFromBundleFile` and the writer `bundleHunkFromDiffHunk` in `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts`) coerces `header` to a string, and the `isDiffBlock` guards require a string hunk `header` before admitting a block.
- **Per-block error boundary.** Each diff block renders through `renderDiffBlockSafe`, which wraps `renderDiffBlock` in a `try/catch`; on a render throw it logs a warning and renders a small local fallback (`data-testid="pr-walkthrough-diff-block-error"`) naming the file, so the rest of the card and panel stay interactive. See [docs/design/pr-walkthrough-hunk-header-fix.md](design/pr-walkthrough-hunk-header-fix.md) for the regression this guards against.

## Comments, decisions, and draft review

Review state is built from comments plus per-card decisions.

### Line comments

Diff lines are interactive. Hovering or clicking a line reveals the comment affordance; keyboard users can open it from the focused line. Line comments are anchored by card id, diff block id, and line id. Export mapping later resolves those anchors to provider-specific file/side/line coordinates.

Suggested line comments can appear beside matching lines. The reviewer can accept, accept and edit, or dismiss them. Accepted suggestions become normal queued comments.

### Card comments

Every card has a card-level comment area for broad concerns that do not belong on a specific line. Card-level comments are included in the audit/export body rather than submitted as GitHub line comments.

### Like, Dislike, and Prev

- **Like** records an approval decision and advances.
- **Dislike** is disabled until the card has at least one non-empty supporting line or card comment.
- **Prev** moves back so reviewers can revise comments or decisions.

If the last supporting comment for a disliked card is deleted, the invalid disliked decision is cleared. This prevents unsupported change requests from appearing in the audit draft.

### Audit draft

The audit draft is assembled from current state:

- changeset title and base/head metadata;
- liked cards under approved context;
- disliked cards and supporting comments under concerns;
- queued line comments grouped with file/line anchors;
- broad card-level comments.

The draft can always be copied, even when provider export is unavailable.

## Persistence and reload

Persistence has five layers:

- **Child session metadata** — the session store persists `parentSessionId`, `childKind: "pr-walkthrough"`, `readOnly`, `walkthroughJobId`, `walkthroughChangesetId`, and `walkthroughTargetKey` so reloads restore the visible child relationship and read-only tool identity. The sidebar renders these first-class children under their parent even when the parent is a team lead or the goal/team session list filters out child sessions from the top-level roster. Terminated or archived children are filtered out while **Show Archived** is off and shown again in the same nested location when it is on.
- **Walkthrough job record** — the PR walkthrough agent store persists status (`starting`, `waiting_for_yaml`, `validation_failed`, `ready`, or `error`), target, tab id, last validation error, warnings, submitted timestamp, payload timestamp, an `analysisBundle` metadata block, and a submit-proof hash. Sensitive values such as tokens and raw submit proofs are sanitized.
- **Analysis bundle store** — launch persists the sanitized, versioned PR metadata/diff bundle as a job artifact. The job's `analysisBundle` metadata records the artifact identity, schema/kind, checksum, generated timestamp, and file count; the full bundle remains separate from the final renderable payload.
- **Resolved walkthrough payload** — after valid YAML, the existing walkthrough store persists final changeset/cards/diff blocks/warnings/export metadata under the `changesetId`.
- **Reviewer interaction state** — the browser stores active card, diff mode, comments, decisions, completed cards, dismissed suggestions, and collapsed diff blocks under `bobbit:pr-walkthrough:<tab-id>`.

When the app reloads or the user selects a walkthrough child, the UI calls `GET /api/pr-walkthrough/session/<childSessionId>` to restore waiting, validation-failed, ready, or error job state. Ready tabs then call `GET /api/pr-walkthrough/<changeset-id>` if cards are not already loaded.

When a PR walkthrough child session is restored, Bobbit rotates the submit proof and rehydrates the tool environment with `BOBBIT_SESSION_ID`, `BOBBIT_WALKTHROUGH_JOB_ID`, `BOBBIT_WALKTHROUGH_SUBMIT_PROOF`, and target-scoping variables. Restored waiting sessions retain scoped `read_pr_walkthrough_bundle` access for their own job and can continue to use `submit_pr_walkthrough_yaml` without persisting the raw proof.

Because side panel, fullscreen, and standalone route all refer to the same tab id and persistence key, comments and decisions survive tab switching, wide review, standalone routing, and reload. Browser-local interaction state is not shared across browsers or devices.

## GitHub export

GitHub export is deliberately two-step and user-confirmed:

1. **Preview** — `POST /api/pr-walkthrough/<changeset-id>/export/preview` maps the current draft to a review body and per-line GitHub review comments.
2. **Confirmed submit** — `POST /api/pr-walkthrough/<changeset-id>/export/submit` requires `confirm: true`. The UI only sends this after the reviewer clicks **Confirm submit to GitHub** in the preview dialog.

The walkthrough analysis agent never submits comments or reviews to GitHub. `readonly_bash` also blocks GitHub review/comment actions during analysis.

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

Unavailable cases still show a safe preview/copy path. Local changesets, unauthenticated GitHub walkthroughs, missing adapters, invalid tokens, insufficient permissions, and unmappable-only drafts do not silently submit.

## Edge states and warnings

The panel renders waiting, validation-failed, loading, error, empty, and warning states instead of falling back to broken UI.

Common warning/error categories:

- **Missing PR** — GitHub `404` responses return a structured error and the panel shows the failure.
- **Authentication failure** — GitHub `401` indicates the configured token was rejected.
- **Permission failure** — GitHub `403` with remaining rate limit usually means the token cannot access the repository or PR.
- **Rate limit** — GitHub `403` with no remaining quota reports rate limiting; configure a token or retry later.
- **Validation failure** — invalid YAML keeps the panel empty and returns retryable field-level errors.
- **Missing or unusable analysis bundle** — missing, corrupt, or unreadable launch bundle artifacts return retryable `PR_WALKTHROUGH_BUNDLE_MISSING`; relaunch the walkthrough so launch resolves a fresh bundle before analysis.
- **Agent runtime failure** — launch or runtime failures before YAML publication become job errors shown in the child session and panel.
- **Large/truncated diffs** — local diff output, GitHub patch bytes, per-file line counts, or changed-file pages can be truncated. Warnings identify the affected files when possible.
- **Generated files** — generated-looking paths are flagged as low-signal and grouped into edge-case cards.
- **Binary files** — binary changes have no reviewable text hunks and cannot receive GitHub line comments.
- **Renamed/deleted/copied files** — status and old paths are preserved so reviewers can understand the file movement and export can map valid line anchors.
- **Empty diffs** — resolve to an orientation-only walkthrough with zero changed files.
- **Untrusted PR hosts** — non-allowlisted hosts are rejected before fetching metadata or rendering clickable URLs. On launch the rejection is synchronous (before any job/tab is created) and surfaces the risk-warning [untrusted-host dialog](#untrusted-host-launch-dialog) that can add the host to the [trusted-host allowlist](#trusted-github-hosts) and retry.

Warnings are shown at the top of the panel and again in export preview when they affect submission.

## API summary

The walkthrough API is internal to the Bobbit UI but useful for tests and integrations:

- `POST /api/pr-walkthrough/launch` — create or focus a session-hosted GitHub PR walkthrough child. For new GitHub jobs, launch resolves and persists the analysis bundle before child creation/focus; if resolution fails, the response contains the structured job error and no waiting child is created. Returns the job, `childSessionId`, `changesetId`, tab id, status, and whether the job was newly created.
- `GET /api/pr-walkthrough/jobs/<jobId>` — return the sanitized persisted job record, including `analysisBundle` metadata when a bundle artifact exists.
- `GET /api/pr-walkthrough/session/<childSessionId>` — return the sanitized job for a child session so the UI can restore waiting/failed/ready/error state.
- `GET /api/internal/pr-walkthrough/bundle` / `POST /api/internal/pr-walkthrough/bundle` — internal endpoint used only by `read_pr_walkthrough_bundle`; requires scoped session/job access and returns bounded manifest/file reads from the persisted launch bundle. `/api/internal/pr-walkthrough/analysis-bundle` is the compatibility alias.
- `POST /api/internal/pr-walkthrough/submit-yaml` — internal tool endpoint used only by `submit_pr_walkthrough_yaml`; requires scoped session access and submit proof and maps against the stored launch bundle.
- `POST /api/pr-walkthrough/resolve` — compatibility resolver for fixture/local/direct walkthrough payloads. Stores the resolved payload.
- `GET /api/pr-walkthrough/<changeset-id>` — reload a stored ready payload.
- `POST /api/pr-walkthrough/<changeset-id>/export/preview` — build a provider review preview from a draft.
- `POST /api/pr-walkthrough/<changeset-id>/export/submit` — submit a provider review only when `confirm: true` and export is available.

Important launch fields:

- `sessionId` — launching session; required for child ownership, cwd/model inheritance, and number-only PR scoping.
- `prUrl` — full GitHub PR URL.
- `prNumber` — GitHub PR number; requires a GitHub `origin` remote in the launching session cwd.
- `owner`, `repo` — optional explicit GitHub target fields when a URL is not supplied.
- `cwd` — explicit repository path, mainly for tests or integrations.
- `baseSha`, `headSha` — local SHA hints. Agent-hosted local changesets are currently rejected; compatibility resolver paths can still use SHA pairs.

## Credentials and configuration

- `GITHUB_TOKEN` / `GH_TOKEN` — used for github.com API requests and required for review submission to github.com.
- `BOBBIT_GITHUB_API_BASE_URL` — overrides the GitHub API base URL, useful for GitHub Enterprise or tests.
- `BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER` — optional module path for compatibility resolver synthesis.

For compatibility resolver model synthesis without a custom adapter, Bobbit uses the selected session model when available, then the default review model, then the default session model. The session-hosted GitHub flow instead relies on the child walkthrough agent and validated YAML submission.

### Trusted GitHub hosts

A walkthrough fetches PR metadata and diffs over the network, so Bobbit only talks to an allowlist of trusted hosts. The allowlist is the **only** source for extra hosts; the former `BOBBIT_GITHUB_TRUSTED_HOSTS` env var is no longer read anywhere.

- **Always-trusted baseline.** `DEFAULT_TRUSTED_HOSTS` in `src/shared/pr-walkthrough/url-safety.ts` (`github.com`, `www.github.com`, `api.github.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com`) is trusted regardless of settings and cannot be removed. The managed list only adds **extra** hosts on top — typically GitHub Enterprise hosts.
- **Where it lives.** The extra hosts are managed in **System → General → Trusted GitHub hosts** and persisted in the server-side global preferences store under the key `githubTrustedHosts: string[]` — the same store behind `GET`/`PUT /api/preferences` that holds `skillsCatalogBudget`. Storing it server-side (rather than per-browser) means the allowlist is shared across clients and is readable by the server code that performs the fetches.
- **Live per request.** The server reads `githubTrustedHosts` from the preferences store on each launch/resolve, not at boot, so adding a host takes effect for the immediate retry **without a server restart**.
- **Normalization and validation on save.** `PUT /api/preferences` runs `normalizeTrustedHosts` over the submitted value. Each entry is lowercased, has any trailing dot stripped, and — if a full URL is pasted — reduced to its host. Entries with a path, whitespace, credentials, a port, or an invalid DNS label are rejected, the list is deduped (first-seen order preserved), and any baseline host is dropped so the managed list shows only true extras. Saving is lossy and never returns a 4xx: the server stores the accepted subset and the UI re-fetches because the `GET` readback is authoritative. An empty or all-invalid list removes the key entirely.
- **Adding a host from the failed launch.** Launching against an untrusted host surfaces a risk-warning confirmation dialog (see [Untrusted-host launch dialog](#untrusted-host-launch-dialog)) that can add the host and retry without re-entering the PR.

### Enterprise host identity and token scoping

Trusted non-`github.com` hosts are carried through identity and credentials differently from github.com:

- **Changeset / canonical identity includes the host.** For github.com the identity keeps its legacy unqualified shape (`github:<owner>/<repo>#<number>`); for any other trusted host the host is included (`github:<host>/<owner>/<repo>#<number>`). This prevents two trusted hosts that share the same owner/repo/PR number from colliding into the same job, tab, or stored changeset.
- **Tokens are host-scoped.** The global `GITHUB_TOKEN` / `GH_TOKEN` are github.com credentials and are **never** forwarded to a non-github.com host (that would leak a github.com secret to an enterprise server). Enterprise hosts authenticate only via the host-scoped GitHub CLI token (`gh auth token --hostname <host>`); github.com may still use the env tokens or the unscoped CLI token.

## Limitations

- Session-hosted walkthrough agents currently support GitHub PRs only.
- Number-only launch depends on the launching session worktree having a GitHub `origin` remote.
- Browser interaction state is local to the browser storage for the tab id; it is not synchronized between browsers or devices.
- GitHub line-comment export can only submit comments with valid GitHub review anchors. Card-level and unmappable comments remain in the review body/preview.
- Binary files and files without text patches cannot receive line comments on GitHub.
- Large diffs may show representative hunks and truncation warnings rather than every changed line.
- Unauthenticated public PR resolution is best-effort and subject to GitHub's lower anonymous API rate limits.

## Troubleshooting

- **`/walkthrough-pr 123` cannot find the repository** — select a session whose worktree has a GitHub `origin` remote, or use the full PR URL.
- **Local changeset launch is unsupported** — use the standalone/local resolver flow for `baseSha` / `headSha` walkthroughs; session-hosted agents are GitHub-only.
- **Panel stays empty** — the agent has not successfully called `submit_pr_walkthrough_yaml`; check the child transcript and validation state.
- **YAML validation failed** — fix the field-level errors returned by the tool and call `submit_pr_walkthrough_yaml` again from the same child session.
- **`PR_WALKTHROUGH_BUNDLE_MISSING` or unusable bundle** — the launch-time analysis bundle artifact is missing, corrupt, or no longer readable. This is retryable, but submission will not re-fetch the diff; relaunch the walkthrough so Bobbit resolves and persists a fresh bundle before creating a new waiting child.
- **Private PR fails or shows permission errors** — set `GITHUB_TOKEN` or `GH_TOKEN` with repository read and pull request review permissions, then retry.
- **Rate limited** — configure a token or wait for GitHub's rate limit reset.
- **Export button only shows copy/preview** — the walkthrough is local, unauthenticated, missing a GitHub target, or export capability was disabled by the resolver.
- **Some comments are unmappable** — check whether the comment is card-level, attached to a binary/truncated file, or anchored to a line GitHub cannot review.
- **Reload loses comments after a PR update** — the card checksum changed, so Bobbit intentionally avoids restoring comments onto a different diff. Re-resolve and review the updated cards.
- **GitHub Enterprise URL is rejected** — add the host under System → General → Trusted GitHub hosts (or confirm the risk-warning dialog on launch), and configure the matching API base URL.

## Testing notes

Coverage is split across unit, API E2E, and browser E2E tests:

- YAML schema validation and YAML-to-card mapping;
- read-only command policy and walkthrough tool metadata;
- session child metadata, submit proof restore, job persistence, and duplicate launch behavior;
- launch API, invalid/valid YAML submission, keeping the child alive after success, and job restore;
- browser behavior for child session launch/focus, empty waiting panel, validation retry state, final cards, reload persistence, standalone route, and explicit export confirmation;
- in-app panel sizing: user-initiated fullscreen/collapse via the shared preview-panel toolbar and shortcuts, no auto-fullscreen on ready, persistence across reload, and the standalone route having no panel-level resize chrome while keeping its internal rail toggle (see [Panel sizing](#panel-sizing-fullscreen-collapse-and-shortcuts));
- compatibility resolver coverage for local SHA resolution, stored payload reload, large diff warnings, empty diffs, GitHub errors, and export mapping.

Use these tests as the pinning contract when changing walkthrough launch, resolver compatibility, YAML mapping, persistence, readonly policy, or panel UX.
