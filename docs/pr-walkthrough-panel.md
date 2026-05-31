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

For GitHub PR launches, the tab belongs to the child walkthrough session, not the launcher. The UI switches/focuses the child session, expands the needed sidebar containers, and shows the child underneath the launching session using first-class `parentSessionId` / `childKind: "pr-walkthrough"` metadata, not delegate-session metadata. This nesting applies to ordinary sessions, goal sessions, team member sessions, and team-lead rows, and it is restored after reload from persisted session metadata and sidebar expansion state.

The same ready walkthrough can be reviewed in:

- the child session side panel beside chat;
- fullscreen / wide review mode from the side-panel toolbar;
- the standalone `/walkthrough?...` route opened from the toolbar.

## Session-hosted GitHub PR flow

### 1. Launch or focus a child session

`/walkthrough-pr <url|number>` calls `POST /api/pr-walkthrough/launch` with the launching `sessionId` and target. The server:

1. resolves the parent session and cwd;
2. canonicalizes the GitHub target;
3. checks for an existing job for the same `(parentSessionId, canonicalKey)`;
4. creates a normal read-only child session with role `pr-walkthrough`;
5. persists a walkthrough job with status `starting`, then `waiting_for_yaml`;
6. opens the walkthrough tab in the child session and prompts the agent to investigate.

The child title is `PR #<number> Walkthrough` when the PR number is known. If launch preflight fails, the failure is surfaced in the child transcript and panel as a structured job error.

### 2. Empty waiting panel

The child session initially looks like a goal assistant: chat on one side, PR walkthrough panel on the other. The panel is intentionally empty while the agent investigates. It shows a waiting state explaining that cards appear only after the read-only walkthrough agent calls `submit_pr_walkthrough_yaml` with valid YAML.

Progress is reported in chat by the agent, not by a panel progress bar. The panel may also show validation or runtime errors from the job record, but it does not scrape chat messages into cards.

### 3. Read-only investigation

Walkthrough sessions receive a narrow tool set:

- `readonly_bash` for read-only PR/diff/file inspection;
- `submit_pr_walkthrough_yaml` for publishing the completed walkthrough.

They do not receive unrestricted `bash`, file write/edit tools, build/test/install commands, commit/push tools, or GitHub review/comment submission tools.

`readonly_bash` enforces policy before execution. At a high level it allows commands such as:

- `gh pr view` and `gh pr diff` for the launched PR;
- scoped `gh api` reads for the launched repository and PR;
- read-only `git diff`, `git show`, `git log`, `git rev-parse`, `git status`, and `git for-each-ref` for ref inspection;
- bounded file/search commands such as `rg`, `grep`, `find`, `ls`, `cat`, `head`, `tail`, `pwd`, and `sed`.

It blocks mutating commands, tests/builds, dependency installs, server starts, shell chaining/redirection, long-running follow modes, hidden/ignore override flags, sensitive path reads, repo-local executable spoofing, cross-repository or cross-PR GitHub reads, and `gh` actions that would create reviews or comments. `git for-each-ref` is allowed only as read-only ref inspection; escape/output flags such as `--git-dir`, `--work-tree`, `--output`, `--shell`, `--perl`, `--python`, and `--tcl` remain blocked.

### 4. YAML submission is the completion path

The walkthrough panel is populated only through `submit_pr_walkthrough_yaml`. The agent must submit exactly one YAML document matching the PR walkthrough schema. A final chat answer is never treated as completion.

The agent prompt includes the schema as a fenced `yaml` block for readability. That fence is documentation only: the `submit_pr_walkthrough_yaml` tool argument must be raw YAML with no Markdown fences, backticks, blockquotes, commentary, or extra YAML documents.

The tool posts to the internal submit endpoint with the child `sessionId`, job id, YAML text, and a scoped submit proof. The gateway validates:

- YAML syntax and single-document shape;
- required fields, enum values, size limits, and cross-field target consistency;
- authoritative PR identity against the launched target;
- hunk/file references against the fetched or local diff where possible.

On validation failure, the job moves to `validation_failed`, the panel remains unpopulated, and the tool returns field-level retry feedback such as `path` plus `message`. The agent can fix the YAML and call the tool again. If the agent becomes idle without a valid submission, Bobbit steers it to call `submit_pr_walkthrough_yaml`; after a failed submission, the reminder includes the last validation errors.

On success, Bobbit maps the YAML into the existing `WalkthroughStorePayload`, persists it, marks the job `ready`, broadcasts the update, selects the child walkthrough tab, and enters fullscreen review mode when the child is active. The tool response tells the agent to stay available for follow-up questions.

### 5. Follow-up chat remains live

A successful YAML submission does not terminate the child session. The user can ask follow-up questions in the walkthrough chat while the PR context, previous investigation, and tool results remain loaded. The child session may carry `readOnly: true` metadata for tool/file policy, but live walkthrough children are still promptable; only archived or terminated walkthrough sessions render as non-interactive. Further `submit_pr_walkthrough_yaml` calls are rejected once the job is `ready`; the published payload is immutable for that job.

## Target scoping and canonicalization

GitHub PR targets are canonicalized so repeated launches focus the same child instead of duplicating work:

- Full PR URL: `github:<owner>/<repo>#<number>`.
- Number-only launch: Bobbit infers `<owner>/<repo>` from the launching session's GitHub `origin` remote and then uses the same canonical key.

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
- **Card** — a logical review unit in one of the walkthrough phases. A card can contain multiple diff blocks across one or more files.
- **Warning** — visible ingestion, mapping, validation, or export issue with a severity, code, message, and optional file path.

The UI never needs to know whether cards came from the session-hosted YAML flow or the compatibility resolver. It renders the same cards, warnings, comments, decisions, draft review, and export preview for every provider.

## YAML-to-card mapping

Validated YAML is mapped into the existing card model:

- `walkthrough.context`, `merge_assessment`, and `pr.original_description.body` become the Orientation card.
- `design_decisions` become Key design choices cards with trade-offs, alternatives, suggested concerns, and linked hunks.
- `review_chunks` become significant, other, or audit review cards with diff-backed hunks and suggested concerns.
- `omissions_and_followups` feed Other + omissions guidance and card-level suggested comments.
- `audit` feeds the final Audit card and draft reviewer checklist.
- `display.phase_order` and `display.chunk_order` influence visible ordering while preserving the known phase set.

Hunk references are best-effort mapped to parsed diff blocks by normalized file path and hunk identity. Exact hunk-header matches are preferred, but Bobbit also maps by the numeric old/new hunk ranges when either side includes, omits, or changes the trailing context text after the closing `@@`. Unmapped references are preserved as warnings or card suggestions rather than silently disappearing, and fallback file-level mapping avoids duplicating diff blocks.

The older model-backed synthesis and deterministic grouping remain compatibility behavior for direct resolver paths. The session-hosted GitHub flow does not populate cards from chat text or from silent model synthesis in the launcher.

## Review flow

The walkthrough is organised into five phases:

1. **Orientation** — confirms scope, refs, provider metadata, stats, warnings, original PR body, inferred author intent, and merge assessment.
2. **Key design choices** — highlights architecture or product decisions and their trade-offs.
3. **Significant changes** — reviews high-signal implementation diffs.
4. **Other + omissions** — covers smaller changes, expected artifacts, and follow-up concerns.
5. **Audit** — checks remaining coverage and renders the final draft review.

Every phase can contain normal diff-backed cards. A card can span multiple files or hunks when that better matches the reviewer story. Audit cards use the same line comments, card comments, suggestions, diff expansion, and Like/Dislike controls as other cards, then render the copyable draft review.

## Diff behaviour

Diffs render from the card/block/hunk model in two modes:

- **Split** — side-by-side old/new columns. This is the default in wide layouts.
- **Inline** — a single column. This is the default in narrow layouts.

The user can toggle either mode at any width. Split diffs use one shared horizontal overflow container per diff widget, so old and new columns scroll together.

Deleted old-side lines and added new-side lines each have their own suggestions, saved comments, and active editor below the row. Context rows share a single detail area because both columns represent the same logical line.

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

Persistence has four layers:

- **Child session metadata** — the session store persists `parentSessionId`, `childKind: "pr-walkthrough"`, `readOnly`, `walkthroughJobId`, `walkthroughChangesetId`, and `walkthroughTargetKey` so reloads restore the visible child relationship and read-only tool identity. The sidebar renders these first-class children under their parent even when the parent is a team lead or the goal/team session list filters out child sessions from the top-level roster.
- **Walkthrough job record** — the PR walkthrough agent store persists status (`starting`, `waiting_for_yaml`, `validation_failed`, `ready`, or `error`), target, tab id, last validation error, warnings, submitted timestamp, payload timestamp, and a submit-proof hash. Sensitive values such as tokens and raw submit proofs are sanitized.
- **Resolved walkthrough payload** — after valid YAML, the existing walkthrough store persists final changeset/cards/diff blocks/warnings/export metadata under the `changesetId`.
- **Reviewer interaction state** — the browser stores active card, diff mode, comments, decisions, completed cards, dismissed suggestions, and collapsed diff blocks under `bobbit:pr-walkthrough:<tab-id>`.

When the app reloads or the user selects a walkthrough child, the UI calls `GET /api/pr-walkthrough/session/<childSessionId>` to restore waiting, validation-failed, ready, or error job state. Ready tabs then call `GET /api/pr-walkthrough/<changeset-id>` if cards are not already loaded.

When a PR walkthrough child session is restored, Bobbit rotates the submit proof and rehydrates the tool environment with `BOBBIT_SESSION_ID`, `BOBBIT_WALKTHROUGH_JOB_ID`, `BOBBIT_WALKTHROUGH_SUBMIT_PROOF`, and target-scoping variables. This lets an interrupted waiting session continue to use `submit_pr_walkthrough_yaml` without persisting the raw proof.

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
- **Agent runtime failure** — launch or runtime failures before YAML publication become job errors shown in the child session and panel.
- **Large/truncated diffs** — local diff output, GitHub patch bytes, per-file line counts, or changed-file pages can be truncated. Warnings identify the affected files when possible.
- **Generated files** — generated-looking paths are flagged as low-signal and grouped into edge-case cards.
- **Binary files** — binary changes have no reviewable text hunks and cannot receive GitHub line comments.
- **Renamed/deleted/copied files** — status and old paths are preserved so reviewers can understand the file movement and export can map valid line anchors.
- **Empty diffs** — resolve to an orientation-only walkthrough with zero changed files.
- **Untrusted PR hosts** — non-allowlisted hosts are rejected before fetching metadata or rendering clickable URLs.

Warnings are shown at the top of the panel and again in export preview when they affect submission.

## API summary

The walkthrough API is internal to the Bobbit UI but useful for tests and integrations:

- `POST /api/pr-walkthrough/launch` — create or focus a session-hosted GitHub PR walkthrough child. Returns the job, `childSessionId`, `changesetId`, tab id, status, and whether the job was newly created.
- `GET /api/pr-walkthrough/jobs/<jobId>` — return the sanitized persisted job record.
- `GET /api/pr-walkthrough/session/<childSessionId>` — return the sanitized job for a child session so the UI can restore waiting/failed/ready/error state.
- `POST /api/internal/pr-walkthrough/submit-yaml` — internal tool endpoint used only by `submit_pr_walkthrough_yaml`; requires scoped session access and submit proof.
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

- `GITHUB_TOKEN` / `GH_TOKEN` — used for GitHub API requests and required for review submission.
- `BOBBIT_GITHUB_API_BASE_URL` — overrides the GitHub API base URL, useful for GitHub Enterprise or tests.
- `BOBBIT_GITHUB_TRUSTED_HOSTS` — comma-separated allowlist for additional trusted GitHub hosts.
- `BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER` — optional module path for compatibility resolver synthesis.

For compatibility resolver model synthesis without a custom adapter, Bobbit uses the selected session model when available, then the default review model, then the default session model. The session-hosted GitHub flow instead relies on the child walkthrough agent and validated YAML submission.

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
- **Private PR fails or shows permission errors** — set `GITHUB_TOKEN` or `GH_TOKEN` with repository read and pull request review permissions, then retry.
- **Rate limited** — configure a token or wait for GitHub's rate limit reset.
- **Export button only shows copy/preview** — the walkthrough is local, unauthenticated, missing a GitHub target, or export capability was disabled by the resolver.
- **Some comments are unmappable** — check whether the comment is card-level, attached to a binary/truncated file, or anchored to a line GitHub cannot review.
- **Reload loses comments after a PR update** — the card checksum changed, so Bobbit intentionally avoids restoring comments onto a different diff. Re-resolve and review the updated cards.
- **GitHub Enterprise URL is rejected** — add the host to the trusted host allowlist and configure the matching API base URL.

## Testing notes

Coverage is split across unit, API E2E, and browser E2E tests:

- YAML schema validation and YAML-to-card mapping;
- read-only command policy and walkthrough tool metadata;
- session child metadata, submit proof restore, job persistence, and duplicate launch behavior;
- launch API, invalid/valid YAML submission, keeping the child alive after success, and job restore;
- browser behavior for child session launch/focus, empty waiting panel, validation retry state, final cards, fullscreen on success, reload persistence, standalone route, and explicit export confirmation;
- compatibility resolver coverage for local SHA resolution, stored payload reload, large diff warnings, empty diffs, GitHub errors, and export mapping.

Use these tests as the pinning contract when changing walkthrough launch, resolver compatibility, YAML mapping, persistence, readonly policy, or panel UX.
