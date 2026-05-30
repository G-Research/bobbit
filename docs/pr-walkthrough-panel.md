# PR Walkthrough Panel

The PR walkthrough panel is Bobbit's guided review surface for pull requests and local changesets. It opens beside chat so the transcript stays available while the walkthrough owns review navigation, line comments, card decisions, the audit draft, and GitHub export preview.

The product is intentionally changeset-oriented rather than GitHub-specific. Local SHA pairs, GitHub PRs, and test fixtures all resolve into the same model: a changeset reference, diff blocks with hunks and line anchors, logical review cards, warnings, and export capability metadata. GitHub lookup and submission are adapters around that model, not assumptions inside the UI.

The checked-in prototype in [`docs/design/pr-walkthrough-panel-prototype.html`](design/pr-walkthrough-panel-prototype.html) remains the UX reference. This document describes the production ingestion, persistence, export, and troubleshooting behavior around that UI.

## Launch paths and surfaces

Users can open the walkthrough from these entry points:

- **Slash command** — `/walkthrough-pr <url|number>` in chat.
  - GitHub PR URLs resolve directly from the owner, repository, and PR number in the URL.
  - Numbers, with or without `#`, resolve against the selected session's `origin` remote.
  - Empty invocations use the fixture walkthrough for development and compatibility.
- **Git Status Widget / custom event** — the UI listens for `open-pr-walkthrough` events and accepts PR metadata, file stats, and local `baseSha` / `headSha` values.
- **Standalone route** — `/walkthrough?session=<id>&tab=<walkthrough-tab-id>` opens the same walkthrough tab in a wide review surface.

Launches create or focus a side-panel tab with a canonical `walkthrough:<changeset-id>` id. When the resolver returns the canonical changeset id, the tab is renamed to that id so reopening the same PR or SHA pair focuses the existing tab instead of duplicating state.

The same walkthrough can be used in:

- the normal Bobbit side panel beside chat;
- the fullscreen / wide review surface from the side-panel toolbar;
- the standalone `/walkthrough?...` route opened from the toolbar.

## Resolution pipeline

All real walkthroughs resolve through `POST /api/pr-walkthrough/resolve`. The client normally sends the active `sessionId`; callers may also pass an explicit `cwd` for tests or integrations.

### CWD and worktree selection

Resolution is session-aware:

1. An explicit request `cwd` wins.
2. Otherwise the server uses the live or persisted session worktree path.
3. If the session has no worktree, it uses the session cwd.
4. If no session path is available, it falls back to the gateway default cwd.

This matters because local SHAs and PR numbers are interpreted in the selected session's checkout, not in the primary project worktree. PR-number resolution also uses that checkout's `origin` remote to infer the GitHub owner and repository.

### Local SHA walkthroughs

Local walkthroughs require `baseSha` and `headSha`. The server verifies both refs, reads git shortstat and name-status metadata, and parses a unified diff with rename/copy detection enabled.

The result includes:

- full base/head SHAs and local provider metadata;
- changed file, addition, and deletion counts;
- one diff block per parsed file, with status, old path when applicable, hunk headers, stable line ids, old-line numbers, and new-line numbers;
- warnings for truncation, generated files, binary files, omitted files, and other parse limitations.

Local walkthroughs can produce review drafts and export previews, but they cannot submit to GitHub because there is no provider review target.

### GitHub PR walkthroughs

GitHub walkthroughs accept either a PR URL or a PR number:

- A URL carries owner, repository, host, and PR number.
- A number requires a GitHub `origin` remote in the resolved cwd so Bobbit can infer owner and repository.

The adapter fetches PR metadata and changed files from the GitHub API. If the base and head commits are available locally in the session worktree, Bobbit prefers local per-file patches so review hunks contain richer context than the GitHub files API often returns. Otherwise it uses the patch content returned by GitHub.

`GITHUB_TOKEN` or `GH_TOKEN` is optional for public PR resolution, but unauthenticated requests have lower rate limits and cannot submit reviews. Private PRs and review submission require a token with permission to read the repository and create pull request reviews.

For GitHub Enterprise or test environments, the adapter also honors the configured API base URL and trusted host allowlist. Untrusted hosts are rejected before any external request is made.

### GitHub metadata with local SHAs

If a request includes both GitHub metadata and local `baseSha` / `headSha`, Bobbit resolves the diff locally and decorates the changeset as GitHub. This is useful when the commits are already present in the worktree or when an integration provides PR metadata but export credentials are unavailable. Submission remains preview-only unless a real GitHub adapter target and credentials are available.

## Changeset and card model

The shared walkthrough model lives under `src/shared/pr-walkthrough/` and is consumed by both server and UI.

Key concepts:

- **Changeset** — provider, base/head SHAs, title, PR URL/number/title when present, and summary stats.
- **Diff block** — one reviewable file block with `filePath`, optional `oldPath`, status, generated/binary/truncated flags, external links, and hunks.
- **Hunk** — original hunk header plus ordered line records.
- **Line** — stable id, kind (`context`, `add`, `del`), side (`context`, `new`, `old`), text, and old/new line numbers for review anchors.
- **Card** — a logical review unit in one of the walkthrough phases. A card can contain multiple diff blocks across one or more files.
- **Warning** — visible ingestion or export issue with a severity, code, message, and optional file path.

The UI never needs to know whether a diff came from local git or GitHub. It renders the same cards, warnings, comments, decisions, draft review, and export preview for every provider.

## Logical card synthesis

After resolving files and diff blocks, the server attempts to create logical cards.

1. **Model-backed LLM attempt** — when a synthesis adapter or configured review/session model is available, Bobbit sends a bounded JSON description of the changeset, files, warnings, and diff block ids. The model must return JSON cards that reference only known diff block ids and valid line ids.
2. **Validation** — invalid phases, missing titles/summaries, unknown diff blocks, duplicate block assignments, and bad suggested-comment anchors are discarded.
3. **Deterministic fallback** — if the model is unavailable, times out, or returns no valid cards, Bobbit groups cards deterministically by path area, change weight, and special file category.

The fallback always starts with an orientation card. It then assigns representative diff blocks to design, significant, other, and audit phases where possible. Generated, binary, renamed, deleted, copied, and truncated files are grouped into lower-signal or edge-case cards so they are visible without overwhelming the main review path. Empty diffs resolve to an orientation-only walkthrough instead of a broken panel.

## Review flow

The walkthrough is organised into five phases:

1. **Orientation** — confirms scope, refs, provider metadata, stats, and warnings.
2. **Key design choices** — highlights the largest or most architecture-relevant path group.
3. **Significant changes** — reviews high-signal implementation diffs.
4. **Other + omissions** — covers smaller changes and special files.
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

Persistence has two layers:

- **Resolved walkthrough payload** — the server stores resolved changeset/cards/warnings/export metadata under Bobbit state by `changesetId`. Stored payloads are schema-versioned and sanitized so auth tokens or raw headers are not persisted.
- **Reviewer interaction state** — the browser stores active card, diff mode, comments, decisions, completed cards, dismissed suggestions, and collapsed diff blocks under `bobbit:pr-walkthrough:<tab-id>`.

When the app reloads, Bobbit restores the side-panel tab. If the tab has no cards yet, it calls `GET /api/pr-walkthrough/<changeset-id>` to reload the server payload. The component then restores browser interaction state only when the card checksum still matches, which avoids applying old comments to a changed diff.

Because side panel, fullscreen, and standalone route all refer to the same tab id and persistence key, comments and decisions survive tab switching, wide review, standalone routing, and reload. Browser-local interaction state is not shared across browsers or devices.

## GitHub export

GitHub export is deliberately two-step:

1. **Preview** — `POST /api/pr-walkthrough/<changeset-id>/export/preview` maps the current draft to a review body and per-line GitHub review comments.
2. **Confirmed submit** — `POST /api/pr-walkthrough/<changeset-id>/export/submit` requires `confirm: true`. The UI only sends this after the reviewer clicks **Confirm submit to GitHub** in the preview dialog.

Bobbit never submits comments to GitHub during resolution or preview.

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

The panel renders loading, error, empty, and warning states instead of falling back to broken UI.

Common warning/error categories:

- **Missing PR** — GitHub `404` responses return a structured error and the panel shows the resolver failure.
- **Authentication failure** — GitHub `401` indicates the configured token was rejected.
- **Permission failure** — GitHub `403` with remaining rate limit usually means the token cannot access the repository or PR.
- **Rate limit** — GitHub `403` with no remaining quota reports rate limiting; configure a token or retry later.
- **Large/truncated diffs** — local diff output, GitHub patch bytes, per-file line counts, or changed-file pages can be truncated. Warnings identify the affected files when possible.
- **Generated files** — generated-looking paths are flagged as low-signal and grouped into edge-case cards.
- **Binary files** — binary changes have no reviewable text hunks and cannot receive GitHub line comments.
- **Renamed/deleted/copied files** — status and old paths are preserved so reviewers can understand the file movement and export can map valid line anchors.
- **Empty diffs** — resolve to an orientation-only walkthrough with zero changed files.
- **Untrusted PR hosts** — non-allowlisted hosts are rejected before fetching metadata or rendering clickable URLs.

Warnings are shown at the top of the panel and again in export preview when they affect submission.

## API summary

The walkthrough API is internal to the Bobbit UI but useful for tests and integrations:

- `POST /api/pr-walkthrough/resolve` — resolve a fixture, local SHA pair, GitHub PR, or GitHub metadata plus local SHAs. Stores the resolved payload.
- `GET /api/pr-walkthrough/<changeset-id>` — reload a stored walkthrough payload.
- `POST /api/pr-walkthrough/<changeset-id>/export/preview` — build a provider review preview from a draft.
- `POST /api/pr-walkthrough/<changeset-id>/export/submit` — submit a provider review only when `confirm: true` and export is available.

Important request fields for resolve:

- `sessionId` — lets the server use the selected session worktree/cwd and session model.
- `cwd` — explicit repository path, mainly for tests and integrations.
- `baseSha`, `headSha` — required for local SHA resolution.
- `prUrl`, `prNumber`, `provider` — GitHub resolution inputs.
- `fixture` — explicit fixture fallback.

## Credentials and configuration

- `GITHUB_TOKEN` / `GH_TOKEN` — used for GitHub API requests and required for review submission.
- `BOBBIT_GITHUB_API_BASE_URL` — overrides the GitHub API base URL, useful for GitHub Enterprise or tests.
- `BOBBIT_GITHUB_TRUSTED_HOSTS` — comma-separated allowlist for additional trusted GitHub hosts.
- `BOBBIT_PR_WALKTHROUGH_SYNTHESIS_ADAPTER` — optional module path for a custom synthesis adapter.

For model-backed synthesis without a custom adapter, Bobbit uses the selected session model when available, then the default review model, then the default session model. If none are configured or the model output is invalid, deterministic fallback cards are used.

## Limitations

- Browser interaction state is local to the browser storage for the tab id; it is not synchronized between devices.
- GitHub line-comment export can only submit comments with valid GitHub review anchors. Card-level and unmappable comments remain in the review body/preview.
- Binary files and files without text patches cannot receive line comments on GitHub.
- Large diffs may show representative hunks and truncation warnings rather than every changed line.
- PR-number-only launch depends on the session worktree having a GitHub `origin` remote.
- Unauthenticated public PR resolution is best-effort and subject to GitHub's lower anonymous API rate limits.

## Troubleshooting

- **`/walkthrough-pr 123` cannot find the repository** — select a session whose worktree has a GitHub `origin` remote, or use the full PR URL.
- **Invalid base/head ref** — make sure both SHAs exist in the session worktree. Fetch the branch or use the correct session.
- **Private PR fails or shows permission errors** — set `GITHUB_TOKEN` or `GH_TOKEN` with repository read and pull request review permissions, then retry.
- **Rate limited** — configure a token or wait for GitHub's rate limit reset.
- **Export button only shows copy/preview** — the walkthrough is local, unauthenticated, missing a GitHub target, or export capability was disabled by the resolver.
- **Some comments are unmappable** — check whether the comment is card-level, attached to a binary/truncated file, or anchored to a line GitHub cannot review.
- **Reload loses comments after a PR update** — the card checksum changed, so Bobbit intentionally avoids restoring comments onto a different diff. Re-resolve and review the updated cards.
- **GitHub Enterprise URL is rejected** — add the host to the trusted host allowlist and configure the matching API base URL.

## Testing notes

Coverage is split across unit, API E2E, and browser E2E tests:

- diff parsing and changeset ids;
- card synthesis, LLM validation, deterministic fallback, and store sanitization;
- local SHA resolution, persisted reload, large diff warnings, empty diffs, GitHub errors, and export confirmation enforcement;
- browser behavior for loading states, real resolved cards, warning banners, persistence across reload/fullscreen/standalone, export preview, confirmed submit, error states, responsive layout, and the original MVP interaction contract.

Use these tests as the pinning contract when changing resolver behavior, card synthesis, persistence, or panel UX.
