# PR walkthrough agent session architecture

> **Superseded behaviour:** this doc's references to switching the child to
> fullscreen review mode "on success" / "on ready" describe the original design.
> That auto-fullscreen-on-ready plumbing has since been **removed** — the
> walkthrough panel now shares the HTML preview panel's resize logic and
> fullscreen is strictly user-initiated. See
> [walkthrough-panel-resize-fix.md](walkthrough-panel-resize-fix.md). The rest of
> this design (child session, bundle, YAML submission, persistence, export) is
> still accurate.

## Summary

Launching a PR walkthrough creates a first-class, read-only child agent session instead of resolving cards silently in the launching session. Before that child starts, the server resolves the PR metadata and diff once, sanitizes it, and persists a versioned analysis bundle for the job. The child session owns the walkthrough side panel, reports progress in chat, reads the persisted bundle through a scoped tool, submits one validated YAML document through a walkthrough-only tool, then stays alive for follow-up questions.

This design replaces the old `POST /api/pr-walkthrough/resolve` model-backed synthesis path with an asynchronous session-hosted workflow while preserving the existing walkthrough panel, persistence, standalone route, and explicit GitHub export flow. The launch-time analysis bundle is the authoritative source for YAML hunk mapping and final payload construction; submission-time PR diff re-fetch is not part of the model.

## Relevant modules

The session-hosted walkthrough path is split between launch/session ownership, launch-time bundle persistence, YAML mapping, and final payload/export storage:

- `src/app/pr-walkthrough.ts`
  - Parses `/walkthrough-pr`, launches or focuses the child session, restores job-backed panels, and reloads final payloads with `GET /api/pr-walkthrough/:changesetId`.
- `src/server/pr-walkthrough/routes.ts`
  - Handles launch, job/session restore, scoped bundle reads, YAML submission, legacy resolve compatibility, and export preview/submit routes.
- `src/server/pr-walkthrough/walkthrough-agent-manager.ts`
  - Owns job launch, duplicate detection, child session creation, bundle-first prompts, YAML submission, and job state transitions.
- `src/server/pr-walkthrough/walkthrough-analysis-bundle.ts`
  - Stores the sanitized launch-time analysis bundle and serves bounded `read_pr_walkthrough_bundle` reads for the owning job/session.
- `src/server/pr-walkthrough/walkthrough-store.ts`
  - Stores final `WalkthroughStorePayload` as JSON under `.bobbit/state/pr-walkthrough/v1/` keyed by `changesetId`.
- `src/shared/pr-walkthrough/types.ts`
  - Defines the final panel payload shape: `WalkthroughResolveResult`, `PrWalkthroughCard`, `PrWalkthroughDiffBlock`, comments/drafts/export types.
- `src/app/render.ts` and `src/app/panel-workspace.ts`
  - Side-panel tab ids already support `walkthrough:<changesetId>`.
  - Fullscreen rendering already supports walkthrough tabs through `state.previewPanelFullscreen`.
- `src/server/agent/session-manager.ts`
  - `createSession()` is the first-class session path used by normal, assistant, and team sessions.
  - `createDelegateSession()` creates hidden-ish child work but uses `delegateOf` semantics and should not be reused for this feature.
- `src/server/agent/team-manager.ts::spawnRole()`
  - Good model for first-class child lifecycle: create session, assign title/color/metadata, persist, send first prompt, subscribe to `agent_end`, broadcast/fan out state.

## Goals and non-goals

Goals:

1. `/walkthrough-pr <url|number>` or equivalent actions create or focus a dedicated PR walkthrough child session beneath the launching session.
2. The child session opens with chat plus an empty waiting walkthrough panel.
3. Launch resolves and persists a sanitized, versioned analysis bundle before the analysis child session is created or prompted.
4. The agent can only perform read-only PR investigation, starts from `read_pr_walkthrough_bundle`, and must submit valid YAML via `submit_pr_walkthrough_yaml` to populate the panel.
5. Invalid YAML gives actionable retry feedback; no partial cards are rendered.
6. Successful submission maps against the stored bundle, persists a YAML-derived payload, selects the child's walkthrough tab, and leaves the agent alive. A ready walkthrough does **not** auto-enter fullscreen (superseded — was: "switches the child to fullscreen review mode"); fullscreen is strictly user-initiated via the toolbar button or keyboard shortcut, matching the HTML preview panel.
7. Existing final review export remains explicit and user-confirmed.

Non-goals:

- No scraping final chat messages into cards.
- No panel progress bar during analysis.
- No automatic termination of the walkthrough agent after success.
- No GitHub review/comment submission by the analysis agent.
- No broad rewrite of the PR walkthrough component UI beyond new waiting/error states and session ownership.

## Proposed architecture

Add a small PR walkthrough job/session layer under `src/server/pr-walkthrough/`:

- `walkthrough-agent-manager.ts`
  - Creates/focuses walkthrough child sessions.
  - Owns job lifecycle state, dedupe, idle reminder, and event broadcasts.
  - Wraps `SessionManager.createSession()` rather than `createDelegateSession()`.
- `walkthrough-agent-store.ts`
  - Persists job/session metadata, analysis bundle metadata, and validation state separately from final card payloads.
- `walkthrough-analysis-bundle.ts`
  - Persists the sanitized launch-time PR metadata and parsed diff bundle under a versioned artifact path.
  - Serves bounded bundle reads for the scoped analysis tool and adapts the bundle back to the YAML mapper's parsed-diff shape.
- `walkthrough-yaml-schema.ts`
  - Parses and validates the submitted YAML document.
  - Maps validated YAML plus parsed diff data from the stored bundle into existing `WalkthroughStorePayload`.
- `walkthrough-readonly-policy.ts`
  - Shared command/tool allow/deny checks for the walkthrough role and tests.

Keep `walkthrough-store.ts` as the final payload store for already-renderable walkthroughs. It should gain optional source fields, not be replaced.

### Data model

Add shared/server types equivalent to:

```ts
export type PrWalkthroughJobStatus =
  | "starting"
  | "waiting_for_yaml"
  | "validation_failed"
  | "ready"
  | "error";

export interface PrWalkthroughJobRecord {
  schemaVersion: 1;
  jobId: string;
  parentSessionId: string;
  childSessionId: string;
  projectId?: string;
  cwd: string;
  target: {
    provider: "github" | "local" | string;
    prUrl?: string;
    owner?: string;
    repo?: string;
    number?: number;
    baseSha?: string;
    headSha?: string;
    canonicalKey: string;
  };
  changesetId: string;
  tabId: string;
  status: PrWalkthroughJobStatus;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastValidationError?: PrWalkthroughValidationSummary;
  submittedAt?: string;
  payloadUpdatedAt?: string;
  warnings?: WalkthroughWarning[];
  error?: { code: string; message: string; retryable?: boolean };
  analysisBundle?: {
    schemaVersion: 1;
    kind: "pr_walkthrough_analysis_bundle";
    artifactId: string;
    checksum: string;
    generatedAt: string;
    files: number;
  };
}
```

Persist under `.bobbit/state/pr-walkthrough-agents/v1/<jobId>.json`, plus an index by `(parentSessionId, canonicalKey)` for duplicate prevention. The record should be sanitized with the same sensitive-key discipline as `walkthrough-store.ts`. `analysisBundle` is metadata only; the full bundle lives in the bundle store and must not include tokens, auth headers, submission proofs, raw request headers, or other sensitive values.

Add `walkthroughAgent` metadata to persisted session info through `SessionManager.updateSessionMeta()`:

```ts
{
  role: "pr-walkthrough",
  accessory: "review",
  parentSessionId: launcherSessionId,
  walkthroughJobId: jobId,
  walkthroughChangesetId: changesetId,
  walkthroughTargetKey: canonicalKey,
  readOnly: true
}
```

This implementation must add a first-class `parentSessionId` / `childKind: "pr-walkthrough"` relationship for visible child sessions. `delegateOf` and `createDelegateSession()` are explicitly out of scope for PR walkthrough launch, sidebar nesting, lifecycle, cleanup, and persistence. Existing delegate rendering may be used only as a visual reference when implementing the new generic child-session renderer.

### Launch-time analysis bundle

Each job has one authoritative analysis bundle. Launch resolves the PR metadata, body, file stats, export capability, warnings, limits, and parsed diff/hunks once, then persists the sanitized bundle before the child session exists. This removes network and GitHub-rate-limit dependency from YAML submission, prevents diff drift between agent analysis and server mapping, and lets launch fail early before a waiting agent is created without usable input.

Bundle artifacts are versioned separately from the final walkthrough payload:

```ts
export interface PrWalkthroughAnalysisBundle {
  schema_version: 1;
  kind: "pr_walkthrough_analysis_bundle";
  generated_at: string;
  job_id: string;
  target: {
    provider: "github" | string;
    owner?: string;
    repo?: string;
    number?: number;
    url?: string;
  };
  changeset: {
    base_sha?: string;
    head_sha?: string;
    title?: string;
    body?: string;
    files_changed?: number;
    additions?: number;
    deletions?: number;
  };
  limits?: Record<string, unknown>;
  warnings: WalkthroughWarning[];
  export?: { provider: string; available: boolean; [key: string]: unknown };
  files: Array<{
    path: string;
    old_path?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    is_binary?: boolean;
    is_generated?: boolean;
    is_truncated?: boolean;
    hunks: Array<{
      header: string;
      old_start?: number;
      old_lines?: number;
      new_start?: number;
      new_lines?: number;
      lines: Array<{
        kind: "context" | "add" | "del";
        old_line?: number;
        new_line?: number;
        text: string;
      }>;
    }>;
  }>;
}
```

The implementation may store the bundle as one JSON artifact or split very large jobs into a manifest plus per-file artifacts, but the agent-facing contract stays versioned and bounded. `WalkthroughStorePayload` remains the final renderable/exportable review format and is still written only after valid YAML maps successfully.

## Launch API

Replace client direct resolve with a launch endpoint.

### `POST /api/pr-walkthrough/launch`

Request:

```json
{
  "sessionId": "launcher-session-id",
  "target": {
    "prUrl": "https://github.com/owner/repo/pull/123",
    "prNumber": 123,
    "provider": "github",
    "baseSha": "optional-local-base",
    "headSha": "optional-local-head",
    "title": "optional title/body/stat hints"
  },
  "focus": true
}
```

Response, `201` for new and `200` for existing:

```json
{
  "ok": true,
  "created": true,
  "jobId": "prw_...",
  "parentSessionId": "launcher-session-id",
  "childSessionId": "walkthrough-session-id",
  "changesetId": "github:owner/repo#123",
  "tabId": "walkthrough:github%3Aowner%2Frepo%23123",
  "status": "waiting_for_yaml",
  "title": "PR #123 Walkthrough",
  "message": "PR walkthrough started in \"PR #123 Walkthrough\"."
}
```

Errors:

- `400 INVALID_TARGET` for malformed PR URL/number/sha pair.
- `403 SESSION_SCOPE_DENIED` if a sandbox token launches for a session outside scope.
- `404 SESSION_NOT_FOUND` if the launcher is missing.
- `502 AGENT_CREATE_FAILED` if session creation fails before a child can be persisted.

The endpoint should be registered in `src/server/pr-walkthrough/routes.ts::handlePrWalkthroughApiRoute()`, but delegate creation to `WalkthroughAgentManager` injected through `PrWalkthroughRouteDeps` to keep routes thin and testable.

### `GET /api/pr-walkthrough/jobs/:jobId`

Returns the persisted job record with sensitive fields stripped. Used by UI reload and test assertions.

### `GET /api/pr-walkthrough/session/:childSessionId`

Returns the job for a child session. The UI can call this after selecting a session to restore the waiting panel even before final cards exist.

### Existing endpoints

Keep:

- `GET /api/pr-walkthrough/:changesetId`
- `POST /api/pr-walkthrough/:changesetId/export/preview`
- `POST /api/pr-walkthrough/:changesetId/export/submit`

Deprecate, then remove direct model synthesis from:

- `POST /api/pr-walkthrough/resolve`

For compatibility during migration, `resolve` can remain for fixture/local tests, but `/walkthrough-pr` should stop using it.

## Session creation lifecycle

`WalkthroughAgentManager.launch(parentSessionId, target)`:

1. Resolve the parent session from live or persisted session metadata.
2. Derive `cwd`, `projectId`, sandbox status, and model from the parent.
3. Canonicalize the target:
   - GitHub URL: `github:<owner>/<repo>#<number>`.
   - GitHub number without URL: `github:<parent repo owner>/<parent repo>#<number>` when inferable; otherwise `pr:<number>` scoped by parent.
   - Local sha pair: `local:<baseSha>..<headSha>`.
4. Check the job index for an active child with same `(parentSessionId, canonicalKey)` and return it if found.
5. Pre-generate `jobId` and `childSessionId` so scoped bundle and submission tool resolvers can bind to stable ids before the agent starts.
6. Persist a `starting` job record.
7. Resolve the full PR metadata and diff for the launch target, sanitize it, persist a versioned analysis bundle, and attach bundle metadata to the job record. If this resolution fails, return the existing structured launch error before creating or prompting the child session; do not leave a waiting agent with no bundle.
8. Create a normal session with `SessionManager.createSession(cwd, undefined, undefined, undefined, opts)`:
   - `sessionId: childSessionId`
   - `projectId`, `sandboxed`, and sandbox cwd inherited from the parent
   - `roleName: "pr-walkthrough"`, `role: "pr-walkthrough"`, `accessory: "review"`
   - `allowedTools` set to the explicit read-only list plus `read_pr_walkthrough_bundle` and `submit_pr_walkthrough_yaml`
   - `rolePrompt` containing the bundle-first analysis instructions and YAML contract
   - `skipAutoModel`/`initialModel` inherited from parent when appropriate
9. Set title to `PR #123 Walkthrough` / `PR Walkthrough` and persist metadata.
10. Create/update the child session panel tab to waiting state by broadcasting a WebSocket event.
11. Send the first prompt asynchronously with target details, allowed operations, required progress chat, bundle-read instructions, and the YAML schema.
12. Subscribe to `agent_end` or session status transitions. If no successful submission exists, enqueue a reminder prompt instead of marking complete.

The first prompt should explicitly say:

- Start by calling `read_pr_walkthrough_bundle` in `manifest` or `summary` mode.
- Treat the persisted bundle as authoritative for PR body, base/head SHA, stats, files, hunks, warnings, limits, and export capability.
- Use bounded `mode=file` reads by path or index for detailed hunk inspection.
- Use `readonly_bash` only for additional read-only investigation; never as a way to read arbitrary bundle files.
- Do not edit files, run tests/builds/checks, install dependencies, start servers, commit, push, or submit GitHub reviews/comments.
- Report rough percentage progress in chat.
- Finish only by calling `submit_pr_walkthrough_yaml` with one YAML document.
- After successful submission, remain available for follow-up questions.

## Child session panel lifecycle

The child session should have a walkthrough tab from creation time:

```ts
{
  id: walkthroughPanelTabId(changesetId),
  kind: "walkthrough",
  title,
  label: "PR #123",
  legacyTab: "walkthrough",
  source: {
    type: "walkthrough",
    sessionId: childSessionId,
    changesetId,
    prUrl,
    prNumber,
    prTitle
  },
  state: {
    status: "waiting_for_yaml",
    jobId,
    changesetId,
    warnings: []
  }
}
```

Implementation options:

- Preferred: server sends a `pr_walkthrough_job_updated` event and `src/app/pr-walkthrough.ts` upserts the tab for `childSessionId` using existing `panelTabsForSession()` and `setPanelTabsForSession()`.
- Fallback: UI calls `GET /api/pr-walkthrough/session/:childSessionId` when a selected session has `walkthroughJobId` metadata and upserts the tab on demand.

`PrWalkthroughStatus` in `src/app/pr-walkthrough.ts` should become:

```ts
export type PrWalkthroughStatus =
  | "fixture"
  | "loading"
  | "waiting_for_yaml"
  | "validation_failed"
  | "ready"
  | "error";
```

The UI component loaded by `ensurePrWalkthroughPanel()` should render:

- `waiting_for_yaml`: empty panel copy from `docs/design/pr-walkthrough-agent-ux.md`.
- `validation_failed`: same waiting panel plus latest validation summary and `View details in chat` affordance.
- `ready`: existing card UI.
- `error`: structured error with retry/follow-up guidance.

On successful submission, select the walkthrough tab only — never set fullscreen:

```ts
setActivePanelTabIdForSession(state, childSessionId, walkthroughPanelTabId(changesetId));
// Superseded — do NOT set state.previewPanelFullscreen here. Auto-fullscreen-on-ready
// was removed; the panel stays in split view until the user initiates fullscreen.
```

This should happen when the active UI session is the child. Do not persist any "desired fullscreen" flag — there is no auto-fullscreen behaviour to defer; the panel shares the HTML preview panel's resize logic and only enters fullscreen on explicit user action.

## Sidebar behavior

Add a first-class child relationship to session metadata and rendering:

- Server session metadata: `parentSessionId?: string`, `childKind?: "pr-walkthrough" | ...`.
- REST `/api/sessions` response should include these fields near `delegateOf`, `teamGoalId`, and `teamLeadSessionId`.
- `src/app/render-helpers.ts` should render `parentSessionId` children beneath the parent row with the same indentation as delegate children.
- Add a new `renderLiveChildSessions(parentSessionId)` path that filters sessions by `session.parentSessionId === parentSessionId`. Existing delegate rendering can call shared row components, but PR walkthrough children must not set or depend on `delegateOf`.
- Walkthrough child rows should show review accessory/read-only tooltip and should not be filtered out as hidden delegates.
- Launching/focusing should auto-expand the parent and make switching easy. The launch response gives `childSessionId`; `src/app/pr-walkthrough.ts` can call the existing session selection flow used by sidebar rows.



## Bundle read tool

### Tool registration

The walkthrough-only tool group includes `read_pr_walkthrough_bundle` alongside the YAML submit tool.

Tool name: `read_pr_walkthrough_bundle`.

The extension registers only when `BOBBIT_WALKTHROUGH_JOB_ID` and `BOBBIT_SESSION_ID` are present. It calls the internal bundle endpoint with those environment-derived ids and ignores caller-supplied identity fields. The gateway validates that the session owns the job before returning data.

Internal endpoint:

`GET /api/internal/pr-walkthrough/bundle` / `POST /api/internal/pr-walkthrough/bundle`

Compatibility alias: `/api/internal/pr-walkthrough/analysis-bundle`.

Request parameters:

```json
{
  "sessionId": "child-session-id",
  "jobId": "prw_...",
  "mode": "manifest",
  "path": "src/example.ts",
  "index": 0,
  "offset": 0,
  "limit": 50,
  "hunkOffset": 0,
  "hunkLimit": 50
}
```

Read modes:

- `summary` / `manifest`: return bundle header, changeset, limits, warnings, export capability, and a bounded file manifest.
- `files`: return a bounded page of file manifests.
- `file`: return one file by `path`, `old_path`, or `index`, with bounded hunk output.

The tool does not read arbitrary filesystem paths, does not expose raw artifact paths, and does not loosen `readonly_bash`. Large PRs should be explored by reading the manifest first, then bounded per-file/hunk slices.

## YAML submission tool

### Tool registration

Add a walkthrough-only tool group:

- `defaults/tools/pr-walkthrough/submit.yaml`
- `defaults/tools/pr-walkthrough/extension.ts`

Tool name: `submit_pr_walkthrough_yaml`.

The extension should register only when `BOBBIT_WALKTHROUGH_JOB_ID` and `BOBBIT_SESSION_ID` are present. It posts to an internal endpoint:

`POST /api/internal/pr-walkthrough/submit-yaml`

Request:

```json
{
  "sessionId": "child-session-id",
  "jobId": "prw_...",
  "yaml": "schema_version: 1\n..."
}
```

Response on success:

```json
{
  "ok": true,
  "status": "ready",
  "changesetId": "github:owner/repo#123",
  "cards": 8,
  "warnings": [
    { "code": "unmapped_hunk", "severity": "warning", "message": "2 hunk references could not be mapped." }
  ],
  "message": "Walkthrough YAML accepted and published. Stay available for follow-up questions."
}
```

Response on retryable validation failure should be a tool error with field-level detail:

```json
{
  "ok": false,
  "code": "YAML_SCHEMA_INVALID",
  "message": "Walkthrough YAML did not match schema.",
  "errors": [
    { "path": "walkthrough.review_chunks[0].relevant_hunks[0].file", "message": "Required string is missing." }
  ],
  "retryable": true
}
```

If the stored launch-time bundle is missing, corrupt, schema-incompatible, or otherwise unusable, submission returns a deterministic retryable error instead of fetching the PR diff again:

```json
{
  "ok": false,
  "code": "PR_WALKTHROUGH_BUNDLE_MISSING",
  "message": "PR walkthrough analysis bundle is missing or unusable. Relaunch the walkthrough so the PR diff can be resolved before analysis.",
  "retryable": true
}
```

The correct user action is to relaunch the walkthrough. The server must not silently recover by re-fetching GitHub/local diff data at submit time, because that can drift from the agent's analysis input.

Allow these internal endpoints in `src/server/auth/sandbox-guard.ts` only for the owning session/job. This mirrors `verification_result` but must not be goal-scoped.

### Validation implementation

Use the existing `yaml` package from `package.json` to parse exactly one YAML document. Reject:

- empty content;
- multiple YAML documents;
- non-object root;
- unknown `schema_version`;
- arrays/objects where scalars are required;
- invalid enums;
- missing required fields;
- strings over configured limits;
- total YAML over a configured byte limit, with clear guidance to prioritize chunks.

Implement schema validation in `src/server/pr-walkthrough/walkthrough-yaml-schema.ts` using TypeScript code or a JSON-schema validator if already available in the server stack. Avoid relying only on prompt instructions.

Required YAML shape is the goal spec shape:

```yaml
schema_version: 1
pr:
  provider: github
  owner: string
  repo: string
  number: 123
  title: string
  url: string
  base_sha: string
  head_sha: string
  original_description:
    body: string
    source: gh_api|gh_cli|unknown
    fetched_at: string
  stats:
    files_changed: 0
    additions: 0
    deletions: 0
walkthrough:
  context: { ... }
  merge_assessment: { ... }
  design_decisions: [ ... ]
  review_chunks: [ ... ]
  omissions_and_followups: [ ... ]
  audit: { ... }
  display:
    phase_order: [orientation, design, significant, other, audit]
    chunk_order: [chunk_id]
```

Validation rules beyond shape:

- `schema_version` must be `1`.
- `pr.provider` must be `github` for GitHub PR launches; local changesets can be added later with explicit provider enum expansion.
- `pr.number` must match launch target when known.
- `owner/repo/url` must match launch target when known.
- `base_sha` and `head_sha` must be 7-40 hex characters when present.
- `review_chunks[*].phase` must be `significant`, `other`, or `audit`.
- `omissions_and_followups[*].category` and severities must match the specified enums.
- All ids must be stable, unique within their array, and referenced `display.chunk_order` ids must exist.
- At least one orientation/context field and one review or audit chunk must be non-empty unless the job is in an unrecoverable error state.

### Mapping YAML to panel payload

Add mapper functions:

```ts
validatePrWalkthroughYaml(yamlText, job):
  | { ok: true; document: PrWalkthroughYamlDocument }
  | { ok: false; summary: PrWalkthroughValidationSummary };

mapYamlToWalkthroughPayload(document, parsedDiff, job): WalkthroughStorePayload;
```

Mapping strategy:

1. Load the stored launch-time analysis bundle for the job and adapt it to the existing parsed-diff mapper input. Do not fetch GitHub/local diff data during YAML submission.
2. If the bundle is missing or unusable, fail with retryable `PR_WALKTHROUGH_BUNDLE_MISSING` and tell the user to relaunch.
3. Build an Orientation card from `walkthrough.context`, `merge_assessment`, and the bundle's original PR body.
4. Build Design cards from `design_decisions`.
5. Build review cards from `review_chunks`, using `phase` to choose `phaseId`.
6. Build Other cards from `omissions_and_followups` where they are not already represented by a chunk.
7. Build Audit card from `walkthrough.audit`.
8. Map `relevant_hunks` to existing `PrWalkthroughDiffBlock`/`PrWalkthroughHunk` by file path and exact or normalized hunk header from the bundle.
9. For unmapped hunks, keep visible warnings in `warnings` and a card-level note instead of dropping them.
10. Map `suggested_concerns[*].anchors` to `PrWalkthroughSuggestedComment` when file+hunk+line can be resolved; otherwise demote to `cardSuggestions` with an `unmapped_anchor` warning.
11. Preserve the bundle's original PR body in `changeset.prBody` and optionally in card metadata so Orientation can show/collapse original PR text.

The existing `card-synthesis.ts` should remain as fallback/fixture code during migration but should not be the primary path for agent-hosted walkthroughs.

## Read-only enforcement

Prompt-only restrictions are insufficient. Enforce with both allowlisted tools and a command guard.

### Allowed tools

The walkthrough session should receive an explicit `allowedTools` list:

- primary PR input: `read_pr_walkthrough_bundle`;
- read/search/navigation: `read`, `grep`, `find`, `ls`, `read_session` only if needed;
- shell: dedicated `readonly_bash` only; do not register unrestricted `bash` for walkthrough sessions;
- web/GitHub read APIs if already available: `web_fetch`, `web_search`, `mcp_describe`, selected read-only GitHub MCP operations if configured;
- required publisher: `submit_pr_walkthrough_yaml`.

Do not allow:

- `write`, `edit`, `preview_open`, image generation, proposals, review submission, tasks/gates/team tools, `delegate`, `bash_bg`, browser automation, or any tool that can mutate host/project/GitHub state.

Because `computeToolActivationArgs()` currently registers all tools when `allowedTools` is undefined/empty, this session must always pass a non-empty explicit allowlist.

### Command guard

If `bash` is allowed, wrap it with a walkthrough command policy rather than relying on instructions. Add a session-specific policy checked before shell execution. It should allow only commands matching safe read-only argv prefixes, for example:

- `gh pr view ...`
- `gh pr diff ...`
- `gh api repos/:owner/:repo/pulls/:number ...` and `gh api repos/:owner/:repo/pulls/:number/files ...`
- `git diff ...`
- `git show ...`
- `git log ...`
- `git grep ...`
- `git rev-parse ...`
- `git status --short` / `git status --porcelain`
- `rg ...`, `grep ...`, `find ...`, `ls ...`, `cat ...`, `sed -n ...`, `head ...`, `tail ...`, `pwd`

Block commands by token and regex, including:

- filesystem mutation: `>`, `>>`, `tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `chmod`, `chown`;
- code modification: `git checkout`, `git switch`, `git reset`, `git stash`, `git add`, `git commit`, `git push`, `git merge`, `git rebase`, `gh pr review`, `gh pr comment`;
- package/build/test/server: `npm install`, `npm run build`, `npm run check`, `npm test`, `pnpm`, `yarn`, `bun`, `cargo test`, `go test`, `pytest`, `docker`, `node server`, `vite`, etc.;
- arbitrary scripts/interpreters with inline execution: `node -e`, `python -c`, shell heredocs.

Implement this at the gateway/tool-extension boundary so blocked commands return a tool error like:

`Command blocked by PR walkthrough read-only policy: npm run test. Use read-only PR/diff inspection instead.`

Also keep the existing `tool-guard-extension.ts` enforcement as a last-resort guard for disallowed tools that accidentally register.

## Idle reminder behavior

Mirror `VerificationHarness` reminder semantics without failing the session:

- `WalkthroughAgentManager` tracks successful `submit_pr_walkthrough_yaml` per job.
- On `agent_end`/idle transition with no success:
  - If the latest tool result was a YAML parse/schema error, enqueue a targeted retry prompt summarizing the latest errors.
  - Otherwise enqueue: `You went idle without publishing the walkthrough. Call submit_pr_walkthrough_yaml with valid YAML; the panel only populates through that tool.`
- Rate-limit reminders to avoid loops, e.g. max two automatic reminders per job until the user prompts again.
- Update job status to `validation_failed` or `waiting_for_yaml` and broadcast panel state.

After success, disable reminders but keep the session running.

## Persistence and reload

Persist four layers:

1. Session metadata through the existing session store.
2. Job status and bundle metadata through `walkthrough-agent-store.ts`.
3. Launch-time PR metadata/diff through the analysis bundle store.
4. Final renderable payload through `walkthrough-store.ts`.

Detailed ownership:

| Persisted state | Store/source of truth | Restore path |
| --- | --- | --- |
| Child relationship and read-only identity | Session store fields `parentSessionId`, `childKind`, `readOnly`, `walkthroughJobId` | `GET /api/sessions` and sidebar render |
| Waiting/error/validation/ready lifecycle | `walkthrough-agent-store.ts` job record | `/api/pr-walkthrough/session/:childSessionId` |
| Latest validation error details | Job record `lastValidationError` | Child panel job restore and chat tool result |
| Launch-time PR metadata, parsed files/hunks, limits, warnings, and export capability | Analysis bundle store plus job `analysisBundle` metadata | `read_pr_walkthrough_bundle` and YAML mapper |
| Final cards, parsed diff blocks, warnings, export capability | Existing `walkthrough-store.ts` payload | `GET /api/pr-walkthrough/:changesetId` |
| Original PR body | Final payload `changeset.prBody` plus Orientation card metadata | Existing payload restore |
| Active tab (no fullscreen-on-ready intent — superseded; ready never auto-fullscreens) | Panel workspace state plus job/session UI metadata | Session switch/job restore |
| Comments, decisions, completed cards, diff mode | Existing browser draft state keyed by walkthrough tab/checksum | Existing panel local storage restore |
| Agent transcript and follow-up context | Existing session transcript store | Normal child session restore |

Reload cases:

- Child exists, no YAML yet: UI selects child and calls `GET /api/pr-walkthrough/session/:childSessionId`; panel restores `waiting_for_yaml`.
- Last submission invalid: job record includes `lastValidationError`; panel restores `validation_failed` banner.
- Submitted successfully: `GET /api/pr-walkthrough/:changesetId` restores cards; job says `ready`.
- Bundle missing after launch: bundle reads or YAML submission return retryable `PR_WALKTHROUGH_BUNDLE_MISSING`; the UI should direct the user to relaunch instead of retrying hidden PR diff fetches.
- Server restarted while agent running: `WalkthroughAgentManager.restore()` scans job records, reconnects idle listeners for live sessions, and does not create duplicate sessions.
- Child archived/terminated: job remains for historical lookup; launcher dedupe should not reuse terminated children unless explicitly requested. Sidebar filtering hides terminated/archived walkthrough children while **Show Archived** is off and shows them nested under the parent when it is on.

Existing draft review state, comments, decisions, and standalone route should remain keyed by `sessionId + walkthrough tab id` in the current UI stores.

## UI changes by file

### `src/app/pr-walkthrough.ts`

- Change `openPrWalkthroughPanel(state, launcherSessionId, input)` to call `POST /api/pr-walkthrough/launch`.
- Do not create a walkthrough tab in the launcher.
- On response, refresh sessions and switch/focus to `childSessionId` when requested.
- Add `upsertWalkthroughJobPanel(state, childSessionId, job)` for server events/reload.
- Keep `restorePrWalkthroughPanel()` for final payloads, but add job restore for waiting states.

### `src/app/render.ts`

- Update `open-pr-walkthrough` event handling to use launch flow.
- Listen for `pr_walkthrough_job_updated` WebSocket/SSE messages and patch child session panel tabs.
- On `ready` update for active child, select the active walkthrough tab only. Do **not** touch `previewPanelFullscreen` (superseded — was: "set `previewPanelFullscreen = true`"); auto-fullscreen-on-ready was removed and fullscreen is user-initiated.

### `src/app/panel-workspace.ts`

- Keep `walkthroughPanelTabId()` and `walkthroughChangesetIdFromPanelTabId()` unchanged.
- Ensure `normalizeStoredPanelTab()` accepts new `waiting_for_yaml` and `validation_failed` tab states without stripping them.

### PR walkthrough UI component

The specific component is loaded through `ensurePrWalkthroughPanel()` and uses `PrWalkthroughStatus`. Update it to render waiting, validation-failed, and structured error states while preserving current ready/export behavior.

### Sidebar rendering

Update `src/app/render-helpers.ts` and session types to render `parentSessionId` children. PR walkthrough sessions must use `parentSessionId` and `childKind: "pr-walkthrough"`; they must not use `delegateOf` or delegate lifecycle APIs. The row label/accessory/read-only affordance and notification policy should treat them as user-visible child sessions.

## Server changes by file

### `src/server/pr-walkthrough/routes.ts`

- Add `/launch`, `/jobs/:jobId`, `/session/:childSessionId`, and internal `/api/internal/pr-walkthrough/bundle` plus `/api/internal/pr-walkthrough/submit-yaml` handling, or delegate the internal routes from `server.ts` to the manager.
- Keep export routes unchanged; export preview/submit continue to read the final `WalkthroughStorePayload`, not the analysis bundle.
- Move direct `resolveWalkthrough()` use behind a compatibility/fallback flag.

### `src/server/pr-walkthrough/walkthrough-store.ts`

- Allow optional metadata for source YAML and unmapped-reference warnings if needed.
- Continue sanitizing sensitive fields.

### `src/server/pr-walkthrough/card-synthesis.ts`

- No primary-path changes. Keep as fallback and fixture synthesizer.
- Consider sharing `validateSynthesisedCards()` helpers for final card normalization if useful.

### `src/shared/pr-walkthrough/types.ts`

- Add job status/API response types if the UI imports them.
- Avoid bloating the existing final card model with the full YAML document; store raw YAML only server-side if needed.

### `src/server/agent/session-manager.ts`

- Extend `SessionInfo`/persisted metadata with `parentSessionId`, `childKind`, `walkthroughJobId`, `readOnly`.
- Ensure `createSession()` opts can pass these fields or support setting immediately after creation with `updateSessionMeta()`.
- Include fields in `GET /api/sessions` serialization in `src/server/server.ts`.

### `src/server/agent/team-manager.ts`

- No direct dependency. Use `spawnRole()` as the lifecycle pattern, not as a shared implementation.

### Tool policy / MCP registration

- Add `defaults/tools/pr-walkthrough/*` and tool manager metadata so the new tool can be explicitly allowed.
- Add command policy hook for shell execution or a dedicated read-only shell extension.
- Update `src/server/auth/sandbox-guard.ts` to allow only `/api/internal/pr-walkthrough/submit-yaml` for the submitting scoped session.

## Failure behavior

- **Child creation fails before session exists:** launcher gets `502 AGENT_CREATE_FAILED`; no panel is opened. The launcher notice includes the target and retry guidance.
- **Child exists but prompt/model fails:** persist job `error`, keep the child row visible, write a chat/system error into the child transcript when possible, and show the error panel. The same child is reused after the user retries from the child unless the session is terminated.
- **Model unavailable before first prompt:** create the child/session record first when practical, then transition `starting` to `error` with code `MODEL_UNAVAILABLE`, provider/model name when safe, and guidance to select another model or retry. If session creation itself fails, return `502` to the launcher.
- **Agent startup/runtime crash:** transition `waiting_for_yaml` to `error` with code `AGENT_RUNTIME_FAILED`, keep transcript/panel available, and allow the user to prompt/retry in the same child after the runtime recovers.
- **Prompt dispatch failure:** transition `starting` to `error` with code `PROMPT_DISPATCH_FAILED`; the child remains visible and retrying launch focuses the existing child and resends the first prompt after clearing the error.
- **GitHub auth/rate limit/private PR during launch:** use explicit error codes (`GITHUB_AUTH_REQUIRED`, `GITHUB_FORBIDDEN`, `GITHUB_RATE_LIMITED`, `GITHUB_NOT_FOUND_OR_PRIVATE`). The panel must state whether a token is missing, permissions are insufficient, the PR may be private, or the reset time from GitHub rate-limit headers when available. These errors surface before the analysis child session starts; after auth/permission/rate-limit recovery, the user relaunches.
- **Invalid YAML:** tool returns retryable field errors, transitions or remains `validation_failed`, and keeps the panel unpopulated with a validation banner. A later valid tool call transitions to `ready`.
- **Large PR/truncation:** submission can succeed with `warnings` and `limits`; panel shows warnings in Orientation/Audit and the agent explains prioritization in chat.
- **Policy violation:** blocked tool/command result is visible in chat; manager does not fail the job unless the agent cannot recover. Repeated policy violations can trigger a reminder prompt that restates allowed read-only operations.
- **Duplicate launch:** return existing active job and focus child; do not replay first prompt unless the job is `error` and the user explicitly retries.

Status transitions and retry semantics:

| From | Event | To | Retry/reuse behavior |
| --- | --- | --- | --- |
| `starting` | analysis bundle resolved and persisted, then session and first prompt created | `waiting_for_yaml` | Existing child is active. |
| `starting` | metadata/diff resolution fails before child exists | `error` / launch error | User relaunches after auth/network/rate-limit recovery; no waiting child is created. |
| `starting` | session creation fails before child exists | no job / launch `502` | User retries launch; no child to reuse. |
| `starting` | model unavailable or prompt dispatch fails after child persisted | `error` | Reuse existing child; retry can resend prompt after config/auth fix. |
| `waiting_for_yaml` | invalid YAML tool call | `validation_failed` | Same child; agent retries tool call. |
| `validation_failed` | another invalid YAML tool call | `validation_failed` | Update latest summary and reminder context. |
| `waiting_for_yaml` or `validation_failed` | valid YAML tool call | `ready` | Persist payload, select walkthrough tab (no auto-fullscreen — user-initiated only), keep agent alive. |
| `waiting_for_yaml` or `validation_failed` | agent idle without successful tool call | same status | Enqueue rate-limited reminder; no cards rendered. |
| `waiting_for_yaml` or `validation_failed` | stored analysis bundle is missing or unusable during bundle read or YAML submission | `error` with `PR_WALKTHROUGH_BUNDLE_MISSING` | Retryable, but requires relaunch; no submit-time diff re-fetch. |
| `error` | duplicate launch of same parent/target | `error` or `waiting_for_yaml` after explicit retry | Focus existing child; do not create duplicate. |
| `ready` | duplicate launch of same parent/target | `ready` | Focus existing child and existing panel. |

## Migration plan

1. Add job store, analysis bundle store, schema validator, and mapper with unit coverage.
2. Add `read_pr_walkthrough_bundle` and `submit_pr_walkthrough_yaml` tools plus internal endpoints.
3. Add `WalkthroughAgentManager.launch()` and launch API with launch-time bundle resolution before child creation.
4. Update UI launch flow to create/focus child and show waiting panel.
5. Add sidebar child-session metadata/rendering.
6. Add idle reminder behavior. (Superseded — the original plan included "fullscreen-on-success"; that auto-fullscreen behaviour was removed. Ready walkthroughs never auto-enter fullscreen.)
7. Keep `/api/pr-walkthrough/resolve` tests passing while moving UI tests to launch/session flow.
8. Later remove direct synthesis or retain it only as fixture/development fallback.

## Test matrix

Unit tests:

- YAML parser rejects syntax errors, multiple docs, missing fields, bad enums, mismatched PR identity, and oversized docs.
- YAML parser accepts a minimal valid document and normalizes optional arrays to empty arrays.
- Mapper creates Orientation, Design, Review, Other, and Audit cards.
- Launch persists a sanitized versioned analysis bundle before child session creation.
- YAML submission maps from the stored analysis bundle and does not call submit-time GitHub/local diff resolution.
- Missing or unusable bundle returns retryable `PR_WALKTHROUGH_BUNDLE_MISSING`.
- Bundle read tool enforces owning `BOBBIT_SESSION_ID` / `BOBBIT_WALKTHROUGH_JOB_ID` and supports bounded manifest/file reads.
- Hunk mapping preserves unmapped references as warnings.
- Suggested comment anchors map to line ids when possible and demote cleanly when not.
- Read-only command policy allows `gh pr view`, `gh pr diff`, `gh api` read calls, `git diff/show/log/grep`, and read-only search/read commands.
- Read-only command policy blocks edits, commits, pushes, installs, builds, tests, servers, and GitHub review/comment commands.
- Idle reminder chooses generic vs YAML-validation retry prompts and rate-limits reminders.

API E2E:

- `POST /api/pr-walkthrough/launch` creates a child session, returns `childSessionId`, and persists a waiting job.
- Private PR, missing token, forbidden token, not-found/private ambiguity, and GitHub rate-limit responses produce structured launch errors before child session creation.
- Model unavailable, prompt dispatch failure, and agent runtime failure transition to deterministic `error` states without losing the child when one was persisted.
- Duplicate launch from same parent/target returns the existing child.
- Same target from a different parent creates a separate child.
- Invalid `submit_pr_walkthrough_yaml` returns structured errors and leaves job/panel unpopulated.
- Valid submission stores `WalkthroughStorePayload`, returns ready, and leaves the child session alive.
- Missing analysis bundle on read/submission returns `PR_WALKTHROUGH_BUNDLE_MISSING` and does not re-fetch PR diff data.
- `GET /api/pr-walkthrough/session/:childSessionId` restores waiting, failed, and ready states.
- Sandbox token cannot submit YAML or read a bundle for another session/job.
- Existing export preview/submit still requires explicit confirmation and works from final payloads.

Browser E2E:

- `/walkthrough-pr 123` in a launcher creates a nested child row and does not open a walkthrough panel in the launcher.
- Selecting the child shows chat plus an empty waiting panel.
- Agent progress chat text is visible while panel waits.
- Validation failure appears in chat and panel banner; cards do not render.
- Valid submission renders final cards in split view. Fullscreen is user-initiated only — the panel must **not** auto-enter fullscreen on becoming ready (superseded — was: "automatically enters fullscreen walkthrough review mode"). Pinning contract: assert no auto-fullscreen on ready, and that the toolbar button / keyboard shortcut still toggles fullscreen like the HTML preview panel.
- Reload preserves child nesting, waiting/validation/ready state, auth/rate-limit/model error states, and any user-initiated fullscreen state when applicable.
- Duplicate launch focuses the existing child.
- Export preview remains explicit user-confirmed flow.

Regression tests:

- Walkthrough session cannot call `write`, `edit`, `bash_bg`, review submit, task/gate/team/proposal tools.
- Walkthrough shell policy blocks `npm test`, `npm run build`, dependency installs, server starts, mutating git commands, and `gh pr review/comment`.
- Existing PR walkthrough panel ready-state navigation, comments, standalone route, and export tests still pass.

## Risks and mitigations

- **Tool leaks through extensions:** pass explicit `allowedTools`, keep `tool-guard-extension.ts`, and add regression tests that intentionally attempt forbidden tools.
- **Shell command parsing bypasses:** use the dedicated `readonly_bash` extension with argv parsing and reject shell metacharacters/inline interpreters before execution; unrestricted `bash` must not be registered for walkthrough sessions.
- **Sidebar relationship ambiguity:** implement `parentSessionId`/`childKind` as mandatory session metadata and add tests proving PR walkthrough rows do not depend on `delegateOf`.
- **Large PRs exceed YAML/tool limits:** enforce byte limits, instruct prioritization, and allow warnings/omissions rather than failing the whole job. Use bounded `read_pr_walkthrough_bundle` manifest/file reads so the agent does not need broad filesystem access.
- **Stale diff mapping:** persist the launch-time bundle and map YAML against it. If it is missing or unusable, return `PR_WALKTHROUGH_BUNDLE_MISSING` and require relaunch rather than silently re-fetching a potentially different diff.
- **Model finishes in prose:** idle reminder must be driven by missing successful tool call, not by chat content.
- **User loses child on reload:** persist job metadata before sending the first prompt and restore panel tabs from session/job metadata.

## Resolved implementation choices

1. Implement generic `parentSessionId` / `childKind` session nesting immediately. Do not use `delegateOf`, `createDelegateSession()`, delegate cleanup, or delegate hidden-session semantics for PR walkthroughs.
2. Expose a dedicated `readonly_bash` tool for walkthrough sessions instead of registering unrestricted `bash`. The tool parses argv, applies `walkthrough-readonly-policy.ts`, and rejects shell metacharacters/inline interpreters before execution.
3. Do not persist raw invalid YAML. Persist the latest validation summary, a content hash for diagnostics, and the final sanitized YAML-derived payload. If raw successful YAML is needed for debugging, store it in a separate sanitized job artifact behind an explicit debug flag, never in `walkthrough-store.ts`.
4. Resolve and persist the authoritative PR metadata/diff bundle at launch before child creation; YAML submission maps only from that stored bundle, and missing/unusable bundles return retryable `PR_WALKTHROUGH_BUNDLE_MISSING` with relaunch guidance.
