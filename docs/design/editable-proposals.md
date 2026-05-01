# Design — Editable Proposals

Status: design-doc gate
Goal: `Editable Proposals`
Branch: `goal/goal-editable-p-1ee1e84f`

This document is the implementation blueprint. It is structured for parallel
work — Section 10 carves out non-overlapping slices.

## 1. Summary

Three concurrent changes, gated in dependency order:

1. **Part 0** — total removal of `propose_setup` and the setup assistant.
2. **Part 1+2** — proposals become files on disk under
   `.bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}`. The file IS the
   proposal. Two new tools (`view_proposal`, `edit_proposal`) let the agent
   tweak proposals without re-emitting the entire payload.
3. **Part 3** — UX-unification refactor: collapse six per-type proposal slots
   into one `state.activeProposals` keyed by `ProposalType`; one
   `onProposal(type, fields, streaming)` callback; `ProposalTypeRegistry`
   plugs in per-type parser/validator/renderer; unified draft + dismissal
   helpers. Goal-proposal UX is the reference and must be preserved exactly.

The existing per-type renderers (project's Components/Workflows/Diff,
workflow's gate graph, goal's spec markdown, etc.) are NOT touched — only the
plumbing around them.

## 2. File layout

### New files

| Path | Purpose |
|---|---|
| `src/server/proposals/proposal-files.ts` | Read/write/edit/parse on-disk proposal files. Atomic writes with rollback. |
| `src/server/proposals/proposal-types.ts` | Server-side per-type metadata: filename, file format (md+frontmatter / yaml), parser, validator. |
| `src/app/proposal-registry.ts` | Client-side per-type plugin registry: `ProposalType` union, `ProposalSlot`, file-format plugin (parse fields → typed projection), renderer hookup. |
| `src/app/proposal-helpers.ts` | Unified `loadProposalDraft` / `deleteProposalDraft` / `markProposalDismissed` / `clearProposalDismissed`, generalised from the goal-proposal helpers. |
| `defaults/tools/proposals/view_proposal.yaml` | Tool descriptor. |
| `defaults/tools/proposals/edit_proposal.yaml` | Tool descriptor. |
| `tests/proposal-files.test.ts` | Unit: read/write/edit/parse-error round-trip per type. |
| `tests/e2e/proposal-edit-api.spec.ts` | API E2E: edit-before-propose, restart survival, malformed rollback. |
| `tests/e2e/ui/proposal-edit-flow.spec.ts` | Browser E2E: project propose→edit→accept happy path. |
| `tests/e2e/ui/proposal-types-uX-parity.spec.ts` | Per-type UX-parity matrix: dismissal stickiness, "Open proposal", first-emit auto-select, restart survival. |

### Files to delete (Part 0 — total)

| Path | Reason |
|---|---|
| `defaults/tools/proposals/propose_setup.yaml` | Tool gone. |
| `src/server/agent/setup-assistant.ts` | Assistant module gone. |
| `defaults/roles/assistant/setup.yaml` | Role override gone. |

### Files modified — central touch list

`src/app/state.ts`, `src/app/session-manager.ts`, `src/app/render.ts`,
`src/app/sidebar.ts`, `src/app/remote-agent.ts`, `src/app/proposal-parsers.ts`,
`src/app/api.ts`, `src/server/agent/assistant-registry.ts`,
`src/server/server.ts`, `src/server/ws/protocol.ts`, `src/server/ws/handler.ts`,
`src/ui/tools/index.ts`, `src/ui/tools/renderers/ProposalRenderer.ts`,
`defaults/tools/proposals/extension.ts`.

## 3. On-disk proposal format

Path: `.bobbit/state/proposal-drafts/<sessionId>/<type>.<ext>` where `<type>`
is one of `goal | project | workflow | role | tool | staff` and `<ext>` is
`md` for goal and `yaml` for the rest.

### 3.1 `goal.md` — markdown with YAML frontmatter

```markdown
---
title: Editable Proposals
cwd: /home/jane/proj
workflow: feature
options: QA testing,Code review
---

The body below the frontmatter is the goal `spec` (markdown).
Multi-paragraph specs go here verbatim.
```

| `propose_goal` arg | File location |
|---|---|
| `title` | frontmatter `title` |
| `cwd` | frontmatter `cwd` (omit when absent) |
| `workflow` | frontmatter `workflow` (omit when absent) |
| `options` | frontmatter `options` (CSV string) |
| `spec` | body after frontmatter |

### 3.2 `project.yaml`

Matches the on-disk `project.yaml` shape from `propose_project` —
the same arguments the assistant currently emits, serialised as native YAML
(no JSON-stringification of structured fields, see "Native-YAML
project.yaml fields" rule in AGENTS.md):

```yaml
name: bobbit
root_path: /home/jane/bobbit
build_command: npm run build
test_command: npm test
typecheck_command: npm run check
worktree_setup_command: npm ci
qa_start_command: npm run dev
sandbox: docker
worktree_root: /home/jane/bobbit-wt
session_model: anthropic/claude-opus-4-6
review_model: anthropic/claude-opus-4-6
naming_model: anthropic/claude-haiku-4-5
components:
  - name: bobbit
    repo: "."
    relative_path: ""
    worktree_setup_command: npm ci
    commands:
      build: npm run build
      test: npm test
workflows:
  feature:
    name: Feature
    description: …
    gates: […]
config_directories: []
qa_env: {}
sandbox_tokens: []
qa_max_duration_minutes: 30
qa_max_scenarios: 8
```

Mapping is 1:1 from the `propose_project` parameter object in
`defaults/tools/proposals/extension.ts`.

### 3.3 `workflow.yaml`

```yaml
id: feature
name: Feature
description: |
  Long-form description.
gates:
  - id: design-doc
    name: Design Document
    dependsOn: []
  - id: implementation
    name: Implementation
    dependsOn: [design-doc]
    verify:
      - { name: typecheck, type: command, run: npm run check }
```

`propose_workflow` arg `gates` is currently a JSON-or-YAML string; we parse
on write (accept either; canonicalise to YAML) so `edit_proposal` works on
human-readable YAML.

### 3.4 `role.yaml`

```yaml
name: architect
label: Architect
prompt: |
  You review code from an architectural perspective…
tools: read,grep,bash,gate_*
accessory: hat
```

### 3.5 `tool.yaml`

```yaml
tool: my_custom_tool
action: create        # one of: create, update, docs, renderer, tests, config, access, new-tool
content: |
  # Full YAML body or markdown for docs
```

### 3.6 `staff.yaml`

```yaml
name: nightly-builder
description: Runs the nightly QA loop.
prompt: |
  You wake at 02:00 every night…
triggers: |
  [{"type":"cron","cron":"0 2 * * *"}]
cwd: /home/jane/proj
```

## 4. Server module — `src/server/proposals/proposal-files.ts`

Exclusively responsible for the on-disk lifecycle. No knowledge of WebSocket,
no session-manager imports.

```ts
export type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

export interface TypedProposal {
  type: ProposalType;
  /** Parsed projection — flat key/value plus structured side-tables.
   *  For `project`, `components` and `workflows` may appear as objects/arrays. */
  fields: Record<string, unknown>;
}

export interface ParseError {
  ok: false;
  code:
    | "FILE_NOT_FOUND"
    | "FRONTMATTER_MALFORMED"
    | "YAML_PARSE_ERROR"
    | "MISSING_REQUIRED_FIELD"
    | "STRUCTURAL_VALIDATION_FAILED";
  /** Human-readable error suitable for return to the agent (≤ 1 KB). */
  message: string;
  /** Optional: line/col when YAML parser supplies them. */
  line?: number;
  col?: number;
  /** Field name that failed validation (when applicable). */
  field?: string;
}

export interface ParseSuccess { ok: true; value: TypedProposal; }
export type ParseResult = ParseSuccess | ParseError;

/** Public API — pure. All disk paths derived from sessionId+type. */
export function proposalFilePath(stateDir: string, sessionId: string, type: ProposalType): string;
export function writeProposalFile(stateDir: string, sessionId: string, type: ProposalType, fields: Record<string, unknown>): Promise<void>;
export function readProposalFile(stateDir: string, sessionId: string, type: ProposalType): Promise<string | undefined>;
export function editProposalFile(
  stateDir: string,
  sessionId: string,
  type: ProposalType,
  oldText: string,
  newText: string,
): Promise<{ ok: true; newContent: string; parsed: TypedProposal } | ParseError | { ok: false; code: "OLD_TEXT_NOT_FOUND" | "OLD_TEXT_NOT_UNIQUE"; message: string }>;
export function parseProposalFile(stateDir: string, sessionId: string, type: ProposalType): Promise<ParseResult>;
export function deleteProposalFile(stateDir: string, sessionId: string, type: ProposalType): Promise<void>;
```

Internal mechanics:

- **Atomic write with rollback:** `editProposalFile` reads current content,
  applies exact-string replacement (first-and-only-occurrence rule, identical
  semantics to the builtin `edit` tool), writes to a `<file>.tmp`, parses the
  new content, validates per-type via `proposal-types.ts`. On parse/validate
  failure: unlink `.tmp`, return the ParseError, file on disk untouched. On
  success: `fs.rename` `.tmp` → final path.
- **Per-session directory:** created lazily on first write. Cleaned by
  `deleteProposalFile` and by session archive (`session-manager.ts::terminateSession`
  fire-and-forgets `rm -rf .bobbit/state/proposal-drafts/<sessionId>`).
- **Path safety:** `sessionId` is validated against `/^[A-Za-z0-9_-]+$/`; `type`
  against the union literal. No traversal possible.
- **Writes also fire the WS broadcast** — but `proposal-files.ts` does not
  import the session manager. The caller (extension handler / propose_*
  handler) parses and broadcasts.

`src/server/proposals/proposal-types.ts` exports a per-type plugin:

```ts
export interface ProposalTypeServerPlugin {
  type: ProposalType;
  filename: string;          // "goal.md" | "project.yaml" | …
  /** Render `propose_*` args → file body. */
  serialize(args: Record<string, unknown>): string;
  /** Parse file body → typed projection. May return ParseError. */
  parse(body: string): ParseResult;
  /** Required field whitelist (after parse). Empty array = no required fields. */
  requiredFields: string[];
}
```

## 5. WebSocket protocol changes

Today there is no per-type proposal WS event — proposals reach the client
inline as `propose_*` tool_use blocks inside assistant `message_update` /
`message_end` frames, which `RemoteAgent._checkToolProposals` scans. We
preserve that path because it gives us streaming for free.

We **add** one new event for `edit_proposal` results and for explicit
re-broadcast on session-rehydrate (after restart). The fall-through from
`propose_*` is unchanged.

### `src/server/ws/protocol.ts`

Add to `ServerMessage`:

```ts
| {
    type: "proposal_update";
    sessionId: string;
    proposalType: ProposalType;          // imported from proposals/proposal-files
    fields: Record<string, unknown>;     // typed projection
    streaming: false;                    // edit_proposal results are never streaming
    source: "edit" | "rehydrate";        // for diagnostics
  }
| {
    type: "proposal_cleared";
    sessionId: string;
    proposalType: ProposalType;
  }
```

No new `ClientMessage` types — `view_proposal` / `edit_proposal` go through
the regular tool-call channel.

### `src/server/ws/handler.ts`

On WS `auth_ok` / session attach: enumerate `.bobbit/state/proposal-drafts/<sessionId>/`,
parse each, and emit one `proposal_update { source: "rehydrate" }` per file
to the freshly-attached client. This is the restart-survival path.

### Client — `src/app/remote-agent.ts`

Subscribe handler dispatches `proposal_update` to the unified callback:

```ts
case "proposal_update":
  this.onProposal?.(event.proposalType, event.fields, event.streaming);
  break;
case "proposal_cleared":
  this.onProposal?.(event.proposalType, null, false);
  break;
```

Live `propose_*` tool-use scanning (`_checkToolProposals`) is rewritten to
call the same `onProposal(type, fields, streaming)` callback — see §6.

## 6. Tool surface

### 6.1 `defaults/tools/proposals/view_proposal.yaml`

```yaml
name: view_proposal
description: "Read the current draft of a proposal file for the active session"
summary: "View the current proposal draft. Returns the file contents (markdown or YAML), or a structured error if no proposal of this type has been emitted yet."
provider:
  type: bobbit-extension
  extension: extension.ts
group: Proposals
docs: >-
  Parameters: type (required) — one of "goal", "project", "workflow", "role",
  "tool", "staff". Returns the raw file contents on success; on missing-file,
  returns a clean error pointing at the corresponding propose_* tool.
```

### 6.2 `defaults/tools/proposals/edit_proposal.yaml`

```yaml
name: edit_proposal
description: "Surgically edit the current proposal draft via exact-string replacement"
summary: "Edit a proposal draft by replacing old_text with new_text. Same semantics as the builtin edit tool — old_text must match exactly and uniquely. Empty new_text deletes the matched span."
provider:
  type: bobbit-extension
  extension: extension.ts
group: Proposals
docs: >-
  Parameters: type (required, same union as view_proposal), old_text (required),
  new_text (required, may be empty). On success returns the post-edit file
  contents. On failure returns one of: FILE_NOT_FOUND, OLD_TEXT_NOT_FOUND,
  OLD_TEXT_NOT_UNIQUE, FRONTMATTER_MALFORMED, YAML_PARSE_ERROR,
  MISSING_REQUIRED_FIELD, STRUCTURAL_VALIDATION_FAILED. Failed edits do NOT
  modify the file on disk.
```

### 6.3 `defaults/tools/proposals/extension.ts`

Add (alongside the existing `propose_*` registrations):

```ts
const PROPOSAL_TYPES = ["goal","project","workflow","role","tool","staff"] as const;

pi.registerTool({
  name: "view_proposal",
  label: "View Proposal Draft",
  description: "Read the current proposal draft for the active session",
  promptSnippet: "View the current proposal draft (markdown or YAML).",
  parameters: Type.Object({
    type: Type.Union(PROPOSAL_TYPES.map(t => Type.Literal(t))),
  }),
  async execute(args: { type: ProposalType }) {
    const sid = process.env.BOBBIT_SESSION_ID!;
    const { ok, status, body } = await callGateway(`/api/sessions/${sid}/proposal/${args.type}`, "GET");
    if (status === 404) {
      return { content: [{ type: "text", text: `No ${args.type} proposal yet — call propose_${args.type} first.` }] };
    }
    if (!ok) return { content: [{ type: "text", text: `view_proposal failed: ${body}` }] };
    return { content: [{ type: "text", text: body }] };
  },
});

pi.registerTool({
  name: "edit_proposal",
  label: "Edit Proposal Draft",
  description: "Replace old_text with new_text in the proposal draft (exact match, single occurrence)",
  promptSnippet: "Edit a proposal via exact-string replacement.",
  parameters: Type.Object({
    type: Type.Union(PROPOSAL_TYPES.map(t => Type.Literal(t))),
    old_text: Type.String(),
    new_text: Type.String(),
  }),
  async execute(args) {
    const sid = process.env.BOBBIT_SESSION_ID!;
    const { ok, status, body } = await callGateway(
      `/api/sessions/${sid}/proposal/${args.type}/edit`, "POST",
      { old_text: args.old_text, new_text: args.new_text });
    // body is JSON: { ok: true, newContent } | ParseError | OldTextError
    return { content: [{ type: "text", text: body }] };
  },
});
```

`callGateway()` reuses `getGatewayUrl()` / `getGatewayToken()` from
`defaults/tools/_shared/gateway.ts`.

### 6.4 New REST endpoints (`src/server/server.ts`)

| Route | Auth | Body | Returns |
|---|---|---|---|
| `GET /api/sessions/:id/proposal/:type` | `Bearer` | — | `200 text/markdown\|text/yaml` body, `404` if no draft |
| `POST /api/sessions/:id/proposal/:type/edit` | `Bearer` | `{old_text, new_text}` | `200 {ok:true, newContent}` / `400 {ok:false, code, message}` |
| `DELETE /api/sessions/:id/proposal/:type` | `Bearer` | — | `204` |

The edit endpoint, on success: writes the parsed projection, then calls
`broadcastToSession({ type: "proposal_update", sessionId, proposalType, fields, streaming: false, source: "edit" })`.

### 6.5 Existing `propose_*` extension — minimal change

Each existing `execute()` currently returns `ack()`. They become:

```ts
async execute(args) {
  await postJson(`/api/sessions/${process.env.BOBBIT_SESSION_ID}/proposal/${THIS_TYPE}/seed`,
                 { args });
  return ack();
}
```

Adding a single new endpoint `POST /api/sessions/:id/proposal/:type/seed` that
takes the args, runs the per-type `serialize()`, calls
`writeProposalFile()`, parses, broadcasts `proposal_update { source: "seed" }`.
This is on top of the existing live `_checkToolProposals` path — both paths
fire the same callback shape, so the UI receives the streaming partials AND
the final canonical file-derived projection.

## 7. Client refactor

### 7.1 Types

```ts
// src/app/proposal-registry.ts
export type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

export interface ProposalSlot {
  sessionId: string;
  /** Parsed projection from the file. Flat string fields plus structured
   *  side-tables (e.g. project's components/workflows). */
  fields: Record<string, unknown>;
  /** True between first streaming delta and matching block-finish event.
   *  Mirrors current `proposalStreamingByTag[<tag>_proposal]` semantics. */
  streaming: boolean;
  /** "provisional" / "registered" only meaningful for `project`. */
  mode?: "provisional" | "registered";
  /** Monotonic counter — incremented on every onProposal fire. UI-only. */
  rev: number;
}

export interface ProposalTypePlugin {
  type: ProposalType;
  /** Auto-select rule on first emit (chat → preview, or set previewPanelActiveTab). */
  onFirstEmit(slot: ProposalSlot, opts: { isAssistant: boolean; isMobile: boolean }): void;
  /** Field-level shallow-merge: incoming fields win, structured side-tables
   *  carry forward when the partial omits them. (Project rule generalised.) */
  mergeFields(prev: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown>;
  /** Render the proposal panel — delegates to the existing per-type panel function. */
  renderPanel(): unknown;
  /** Validate before accept; returns errors to disable the submit button. */
  validate(fields: Record<string, unknown>): string[];
  /** Submit: POST to the per-type accept endpoint. */
  accept(slot: ProposalSlot): Promise<void>;
}
```

### 7.2 `state.ts` deltas

| Removed | Replaced by |
|---|---|
| `activeGoalProposal` | `activeProposals.goal?.fields` |
| `activeProjectProposal` | `activeProposals.project?.fields` (keeps `mode`) |
| `activeRoleProposal` | `activeProposals.role?.fields` |
| `activeStaffProposal` | `activeProposals.staff?.fields` |
| (no `activeToolProposal` today — tool slot folds checklist into `fields`) | `activeProposals.tool?.fields` |
| (no `activeWorkflowProposal` today) | `activeProposals.workflow?.fields` |
| `activeSetupProposal`-style state — see Part 0 deletion list | — |

Added:

```ts
activeProposals: {} as Partial<Record<ProposalType, ProposalSlot>>,
proposalDismissedFingerprint: {} as Partial<Record<ProposalType, Record<string, string>>>,
// (the existing per-tag streaming flag is folded into ProposalSlot.streaming;
//  proposalStreamingByTag stays for the streamingBadge() / STREAMING_BORDER
//  helpers in render.ts that don't have a slot in scope — same writer rules.)
```

The form-mirror state (`previewTitle`, `previewSpec`, `rolePreviewName`, etc.)
stays put for now — this refactor does not rewrite the bespoke per-type
preview forms. They continue to read from `activeProposals[type]?.fields`.

### 7.3 `RemoteAgent` callback collapse

Six `onXProposal` callbacks → one:

```ts
onProposal?: (type: ProposalType, fields: Record<string, unknown> | null, streaming: boolean) => void;
```

`null` fields = "proposal cleared" (used by `proposal_cleared` event after
accept).

`_checkToolProposals` (in `remote-agent.ts`) currently has a
`PROPOSAL_TOOL_MAP` keyed by suffix → callbackName. That table is replaced
with a flat list of allowed types; the dispatch becomes
`this.onProposal?.(type as ProposalType, input, streaming)`.

`PROPOSAL_PARSERS` in `src/app/proposal-parsers.ts` loses the `setup_proposal`
entry and its `callbackName` field (no longer needed — `_checkProposals`
is the legacy XML fallback and routes through the same union).

### 7.4 `session-manager.ts` collapse

The seven `remote.onXProposal = …` blocks (`onGoalProposal`, `onRoleProposal`,
`onToolProposal`, `onSetupProposal`, `onWorkflowProposal`, `onStaffProposal`,
`onProjectProposal`) collapse into one:

```ts
remote.onProposal = (type, fields, streaming) => {
  if (activeSessionId() !== sessionId) return;
  if (fields === null) { delete state.activeProposals[type]; renderApp(); return; }

  const plugin = PROPOSAL_TYPE_REGISTRY[type];
  const prev = state.activeProposals[type];
  const merged = plugin.mergeFields(prev?.fields ?? {}, fields);
  const isFirstEmit = prev == null;
  const slot: ProposalSlot = {
    sessionId,
    fields: merged,
    streaming,
    mode: type === "project" ? resolveProjectMode(sessionId) : undefined,
    rev: (prev?.rev ?? 0) + 1,
  };
  state.activeProposals[type] = slot;
  state.assistantHasProposal = true;

  if (isFirstEmit) plugin.onFirstEmit(slot, { isAssistant: state.assistantType === type, isMobile: !isDesktop() });

  // Per-type bespoke side effects (kept inline for goal/project until
  // the bespoke preview forms are themselves refactored — out of scope).
  applyTypeSideEffects(type, slot, { sessionId, isFirstEmit });

  loadProposalDraft.save(sessionId, type);   // unified draft persist
  renderApp();
};
```

The `proposal-open` DOM-event handler is similarly collapsed: dispatch to
`remote.onProposal(type as ProposalType, fields, false)` after clearing the
type-scoped dismissal.

### 7.5 Unified draft helpers — `src/app/proposal-helpers.ts`

```ts
export const proposalDraft = createDraftManager<{type: ProposalType; fields: any}>({
  type: "proposal",
  serialize: (sessionId) => /* per-type slot serialisation */,
  restore:   (sessionId, draft) => /* per-type slot restore */,
});

export function loadProposalDraft(sessionId: string, type: ProposalType): Promise<boolean>;
export function saveProposalDraft(sessionId: string, type: ProposalType): void;
export function deleteProposalDraft(sessionId: string, type: ProposalType): void;

export function isProposalDismissed(sessionId: string, type: ProposalType, fields: any): boolean;
export function markProposalDismissed(sessionId: string, type: ProposalType, fields: any): void;
export function clearProposalDismissed(sessionId: string, type: ProposalType): void;
```

The legacy `goalDraft`, `roleDraft`, `projectDraft` `createDraftManager`
calls in `session-manager.ts` are removed. Existing exports (`saveGoalDraft`,
`saveProjectDraft`, `saveRoleDraft`, `deleteGoalDraft`, …) become thin
shims to `saveProposalDraft(sid, "goal")` etc. for one release cycle, then
deleted.

The fingerprint key is generalised:
`bobbit-${type}-proposal-dismissed-${sessionId}`. The current
`bobbit-goal-proposal-dismissed-<sessionId>` key is read on first load and
migrated to the new key once.

## 8. UX-preservation matrix

Reference behaviour = goal proposal today. Each behaviour must work for ALL
six post-refactor types.

| Behaviour | Today (goal) | After refactor — all 6 types |
|---|---|---|
| Draft persistence across reload | `goalDraft.save/restore` (`session-manager.ts:233`) writes server-side draft via `/api/sessions/:id/draft?type=goal`. | Replaced by file-on-disk + `saveProposalDraft`. The draft table also keeps the per-type form-mirror fields (assistantTab, edited flags) keyed by `(sessionId, type)` to preserve current UX. Restore on session resume. |
| Dismissal stickiness | `markProposalDismissed/isProposalDismissed` (`session-manager.ts:118-130`) keyed by `bobbit-goal-proposal-dismissed-<sid>`, fingerprint `(title+spec)`. | `markProposalDismissed(sid, type, fields)` in `proposal-helpers.ts`; per-type fingerprint = stable `JSON.stringify(fields)` hash. |
| "Open proposal" tool-card button | `proposal-open` CustomEvent → `callbackMap[type]` in session-manager:1222. | Same DOM event, dispatch goes to `remote.onProposal(type, fields, false)`. Each type's plugin handles tab-switch in `onFirstEmit`. |
| First-proposal auto-select | goal: sets `previewPanelActiveTab="goal"`, mobile flips `previewPanelTab="goal"`. project: sets `="project"`. role/tool/staff/workflow: rely on `assistantTab="preview"`. | `plugin.onFirstEmit` per type — implementations lifted verbatim from current code. Centralised guard `isFirstEmit = prev == null`. |
| Streaming shallow-merge | Project-only today (`session-manager.ts:1185-1192` shallow-merge for `components` / `workflows`). | `plugin.mergeFields()` — project keeps the components/workflows carry-forward; other types use a plain object spread by default; goal-spec body is preserved by frontmatter-aware merge in the goal plugin. |
| Streaming flag + scroll preservation | `state.proposalStreamingByTag[<tag>_proposal]` written in `_checkToolProposals`; bulk-cleared on `agent_end`/`reset()`. `reconcileFollowTail` handles scroll. | Unchanged. The new `ProposalSlot.streaming` is a per-slot mirror; `proposalStreamingByTag` continues to drive `streamingBadge()` / `STREAMING_BORDER` for legacy panels that read by tag. Sole writer is still `_checkToolProposals` so the existing E2E (`proposal-panel-streaming.spec.ts`, `proposal-panel-subsection-diff.spec.ts`) passes unchanged. |
| Per-session scoping | `if (activeSessionId() !== sessionId) return;` guard in every `onXProposal`; `state.activeProjectProposal.sessionId` carry. | Single guard at top of `onProposal`. The on-disk file path is per-session by construction; switching sessions clears the in-memory slot via `setupSessionSubscription` reset (already does this for goal/project/role today). |
| Accept / dismiss / re-emit | Goal: `createGoal()` POST; project: `acceptProjectProposal`; role/staff/etc: own endpoints. After accept, `deleteGoalDraft` / `deleteProjectDraft`. | `plugin.accept(slot)` — implementations lifted. After 2xx, fire `DELETE /api/sessions/:id/proposal/:type` (deletes file + broadcasts `proposal_cleared`) AND `deleteProposalDraft(sid, type)`. |

The verification harness for this matrix is the new
`tests/e2e/ui/proposal-types-uX-parity.spec.ts` — see §9.

## 9. Test plan

### 9.1 Acceptance-criterion tests (new)

| Test | File | Asserts |
|---|---|---|
| Project propose → edit → accept happy path | `tests/e2e/ui/proposal-edit-flow.spec.ts` | Mock agent calls `propose_project` then `edit_proposal type=project old=… new=…`; UI panel updates between the two calls; accept submits the edited config; `PUT /api/projects/:id/config` payload reflects the edit. |
| Edit-before-propose returns clean error | `tests/e2e/proposal-edit-api.spec.ts` | `POST /api/sessions/:id/proposal/goal/edit` with no prior `propose_goal` returns `404 {code:"FILE_NOT_FOUND"}` with a message that names the right `propose_*` tool. |
| Edit survives server restart | `tests/e2e/proposal-edit-api.spec.ts` | Seed file via `propose_*`; restart in-process gateway via harness; `GET /api/sessions/:id/proposal/<type>` returns the same body; on reattach, client receives `proposal_update { source: "rehydrate" }`. |
| Malformed-edit rolls back the file write | `tests/e2e/proposal-edit-api.spec.ts` | Seed valid `project.yaml`; call edit_proposal with `new_text` that breaks YAML; assert response is `400 {code:"YAML_PARSE_ERROR"}`; assert the file on disk is byte-for-byte identical to pre-edit (compare SHA-256). Repeat for `MISSING_REQUIRED_FIELD` (delete the `name:` line) and `STRUCTURAL_VALIDATION_FAILED`. |
| Per-type UX parity matrix | `tests/e2e/ui/proposal-types-uX-parity.spec.ts` | For each of the six types: dismissal sticks across reload; "Open proposal" reopens cleanly; first-emit auto-selects right tab; streaming partial does not clobber prior structured fields. |
| `proposal-files.ts` unit | `tests/proposal-files.test.ts` | write/read/parse/edit/delete round-trip per type; atomic-write rollback on parse failure (forced via fault-injected parser); path-traversal rejection. |

### 9.2 Existing tests that MUST pass unchanged

- `tests/goal-proposal-dismiss.spec.ts` — dismissal stickiness reference.
- `tests/e2e/ui/project-assistant.spec.ts` — three-view panel, `[data-panel="project-proposal"]`.
- `tests/e2e/ui/mid-session-project-proposal.spec.ts` — mid-session edits.
- `tests/e2e/ui/proposal-panel-streaming.spec.ts` — streaming flag + scroll.
- `tests/e2e/ui/proposal-panel-subsection-diff.spec.ts` — diff view.
- `tests/e2e/ui/proposal-tools.spec.ts` — `propose_*` tool-card rendering.
- `tests/project-proposal-views.spec.ts` — components/workflows/diff views.

### 9.3 Tests to delete (Part 0)

- `tests/setup-wizard-visibility.spec.ts`
- `tests/setup-wizard-visibility.html`
- `tests/e2e/setup-wizard-bugs.spec.ts`
- `tests/e2e/setup-status.spec.ts` test cases #4 (assistantType:"setup")
  and #5 (session metadata) — keep #1–#3 (which test
  `/api/setup-status` GET/POST and the `setupComplete` health field; the
  sentinel mechanism stays for the "Setup Wizard" sidebar banner —
  see §10 caveat below).

### 9.4 Test runtime

Unit suites must remain <30s. New E2E specs follow `gateway-harness.ts` /
`in-process-harness.ts` patterns from AGENTS.md.

## 10. Part 0 deletion checklist (concrete grep-derived)

Delete entire file:

- `defaults/tools/proposals/propose_setup.yaml`
- `src/server/agent/setup-assistant.ts`
- `defaults/roles/assistant/setup.yaml`
- `tests/setup-wizard-visibility.spec.ts`
- `tests/setup-wizard-visibility.html`
- `tests/e2e/setup-wizard-bugs.spec.ts`

Remove specific lines/blocks:

| File | Lines / symbol |
|---|---|
| `defaults/tools/proposals/extension.ts` | `propose_setup` block (lines 84–106). Adjust `console.log("[proposal-tools] Registered 8 proposal tools")` → 7 (or 9 once `view_proposal`/`edit_proposal` land — coordinate with §6.3). |
| `src/server/agent/assistant-registry.ts` | `import { SETUP_ASSISTANT_PROMPT } from "./setup-assistant.js"` (line 24); `setup` entry in `FALLBACK_DEFAULTS` (lines ~58–63). |
| `src/app/proposal-parsers.ts` | `setup_proposal` parser entry (lines 40–45). |
| `src/app/remote-agent.ts` | `setup: "onSetupProposal"` in `PROPOSAL_TOOL_MAP` (line 18); `onSetupProposal?` callback declaration (line 195). |
| `src/app/session-manager.ts` | `remote.onSetupProposal = …` block (lines 1098–1132); `setup: remote.onSetupProposal,` entry in `callbackMap` (line 1226); the `state.setupForm*` reset block (lines 1261–1269). |
| `src/app/render.ts` | `setupPreviewPanel()` (line 1594 + body through ~1737); `case "setup": return setupPreviewPanel();` (line 2035); `setupAssistantSwipe()` (line 2428 + body); call site `setupAssistantSwipe();` (line 3175). |
| `src/app/sidebar.ts` | `launchSetupWizard()` (lines 645–658); `isSetupWizardActive()` (lines 660–662); `renderSetupBanner()` (lines 664+ — entire function). All call sites: `render.ts:167, 183, 190, 3082, 3090`; `sidebar.ts:911`. |
| `src/app/state.ts` | `setupFormStack`, `setupFormCommands`, `setupFormModels`, `setupFormSystemPrompt`, `setupFormSystemPromptEdited`, `setupFormCommandsEdited`, `setupFormModelsEdited`, `setupFormSaving`, `setupFormSaved`, `setupPreviewAction` (lines 316–333); `setup_proposal` literal in the `proposalStreamingByTag` doc-comment (line 347). Leave `setupComplete: true` — the sentinel banner still exists (see caveat). |
| `src/app/api.ts` | `dismissSetup()` — keep, still used by sidebar Setup Wizard banner removal flow (caveat). |
| `src/ui/tools/index.ts` | Remove `"propose_setup"` from the proposal-tool list (line 80). |
| `src/ui/tools/renderers/ProposalRenderer.ts` | Remove `propose_setup: { … }` row (line 18). |
| `src/server/server.ts` | The `/api/setup-status` and `/api/setup-status/dismiss` endpoints (lines 1492–1503) — KEEP. They drive the dormant Setup Wizard banner concept which is independent of the now-removed setup assistant; we just sever the assistant-launch wiring. The `setupComplete` field in `/api/health` stays. The sidebar banner becomes a no-op until/unless we add a different launch path; for now, remove the banner UI entirely (`renderSetupBanner` deletion above). |

**Caveat — sentinel kept, banner gone:** the `setup-complete` sentinel file
mechanism (lines 1202, 1453, 1492–1503 in `server.ts`) is left in place so
existing test infra (`tests/e2e/setup-status.spec.ts` cases #1–#3 and the
in-process harness's setup) continues to work, but the sidebar Setup Wizard
banner that used to launch the setup assistant is removed entirely. Cases
#4 and #5 of `setup-status.spec.ts` (which test
`assistantType:"setup"` session creation) are deleted.

## 11. Parallel work-slice plan

Six disjoint slices, ordered by dependency. Each slice corresponds to one
implementation task that can be assigned to one coder. Slices A and B have
no dependency on each other and can run in parallel; C depends on B; D
depends on B; E depends on C+D; F runs in parallel with A.

### Slice A — Part 0 deletion (independent)

**Files:** all of §10. Plus delete the corresponding tests.
**Dependency:** none.
**Description:** Total removal of `propose_setup` and the setup assistant.
Delete tool YAML, extension block, assistant module, fallback registry entry,
parser entry, `PROPOSAL_TOOL_MAP` row, `onSetupProposal` callback,
session-manager handler, `state.setupForm*`, `setupPreviewPanel`,
`setupAssistantSwipe`, sidebar banner+launcher, ProposalRenderer row, ui/tools
list entry, role YAML, tests. Keep `/api/setup-status` endpoints and
`setupComplete` sentinel (see caveat). Run `npm run check && npm test:unit`
to confirm no orphan refs.

### Slice B — Server proposal-files module + REST endpoints

**Files:** `src/server/proposals/proposal-files.ts` (new),
`src/server/proposals/proposal-types.ts` (new), `src/server/server.ts`
(add 3 REST handlers + WS rehydrate hook), `src/server/ws/protocol.ts`
(`proposal_update` / `proposal_cleared`), `src/server/ws/handler.ts`
(rehydrate emit), `tests/proposal-files.test.ts` (new),
`tests/e2e/proposal-edit-api.spec.ts` (new).
**Dependency:** none (touches no UI files).
**Description:** Build the on-disk source-of-truth layer per §3, §4, §5, §6.4.
Atomic write/rollback semantics. Path safety. Per-session directory cleanup
on session archive. WS rehydrate on attach. Full unit-test coverage for
write/read/edit/parse/delete + ParseError shape.

### Slice C — `view_proposal` / `edit_proposal` tool extensions + propose_* seeding

**Files:** `defaults/tools/proposals/view_proposal.yaml` (new),
`defaults/tools/proposals/edit_proposal.yaml` (new),
`defaults/tools/proposals/extension.ts` (modify — register the two new tools,
extend the seven existing `propose_*` `execute()` to POST to `/seed`),
`defaults/tools/_shared/gateway.ts` (no change required — verify the helper
suffices).
**Dependency:** Slice B (REST endpoints must exist).
**Description:** Tool-side wiring per §6. One `callGateway` helper added at
the top of `extension.ts` (module-private) reusing
`getGatewayUrl/getGatewayToken`. Note `extension.ts`'s registered-count log
must be updated (Slice A subtracts 1, Slice C adds 2).

### Slice D — Client `ProposalTypeRegistry` + state collapse

**Files:** `src/app/proposal-registry.ts` (new),
`src/app/proposal-helpers.ts` (new), `src/app/state.ts` (replace 6 slot
fields with `activeProposals`), `src/app/proposal-parsers.ts` (drop
`callbackName` field; keep parser tags as-is for legacy XML fallback),
`src/app/remote-agent.ts` (collapse 7 callbacks → `onProposal`; keep
`_checkToolProposals` dispatch shape; add `proposal_update` /
`proposal_cleared` WS handlers).
**Dependency:** Slice B (WS protocol shape).
**Description:** §7. Pure-frontend refactor of state and dispatch. Does NOT
touch the per-type renderer functions (`goalPreviewPanel`,
`projectProposalPanel`, etc.). `goalDraft` / `projectDraft` /
`roleDraft` `createDraftManager` calls become thin shims to the unified
`saveProposalDraft(sid, type)`. Migrate the legacy
`bobbit-goal-proposal-dismissed-<sid>` key once on read.

### Slice E — `session-manager.ts` callback collapse + UX wiring

**Files:** `src/app/session-manager.ts` (replace 7 `onXProposal` blocks
with one `onProposal`; switch to `proposalDraft` helper; per-type
`onFirstEmit` plugin invocations), `src/app/render.ts` (existing per-type
panels read from `state.activeProposals[type]?.fields` instead of the
deleted slots — mechanical rename only), `src/app/api.ts` (`acceptProjectProposal`
etc. unchanged — Slice E only changes their inputs).
**Dependency:** Slice D (registry + state shape) AND Slice C (so the agent
side actually exercises the new path; can be developed in parallel with C
but integrated after).
**Description:** §7.4. The bespoke side-effects (project mode resolution,
goal title summarisation, role preview-edit flags, workflow gates JSON
parse → `populateFromProposal`) are lifted as-is into per-type
`applyTypeSideEffects` blocks invoked from the unified callback. No visual
changes; verify all goal-proposal E2E tests pass unchanged.

### Slice F — UX parity tests (independent of code)

**Files:** `tests/e2e/ui/proposal-types-uX-parity.spec.ts` (new),
`tests/e2e/ui/proposal-edit-flow.spec.ts` (new).
**Dependency:** none up-front (can be authored against the spec); CI run
gated on Slice E completion.
**Description:** Encode the §8 matrix as one parametrised E2E spec running
across all six types. Encode the project propose → edit → accept happy
path as a focused E2E. Both bench against `gateway-harness.ts` with mock
agents from `tests/manual-integration/`-style fixtures.

### Dependency graph

```
A (Part 0)   B (server files+REST+WS)   F (parity tests, dev-only)
                 |
                 +-> C (tools)
                 +-> D (client registry/state)
                          |
                          +-> E (session-manager wiring)
                                |
                          F integrated into CI here
```

## 12. Out of scope

- Diff/undo history of edits.
- Concurrent multi-agent edits (single-session model preserved).
- Refactoring the bespoke per-type preview forms (`goalPreviewPanel`,
  `projectProposalPanel`, etc.). Only the surrounding plumbing changes.
- The `setupComplete` sentinel banner (kept dormant — see §10 caveat).

## 13. Risks

- **Streaming + file-on-disk dual-source-of-truth window.** Live
  `_checkToolProposals` fires during streaming using the in-memory
  partial; the file is written on `propose_*/seed` POST after the call.
  If the agent calls `view_proposal` mid-stream, it sees the prior file,
  not the in-flight delta. Acceptable: the agent is expected to call
  `propose_*` first (which writes the file before returning) and only
  then `view_proposal` / `edit_proposal`.
- **Partial seed writes for project's complex YAML** could parse-fail on
  exotic inputs the proposal-types YAML schema doesn't anticipate. Mitigation:
  write the raw `propose_project` arg object straight through `js-yaml`
  with native types — the existing `PUT /api/projects/:id/config` validator
  already covers the structural rules, so we reuse it for
  `STRUCTURAL_VALIDATION_FAILED`.
- **Session purge race.** If a session is archived mid-edit, the per-session
  directory cleanup must happen after any in-flight `editProposalFile`
  promise resolves. We use the same fire-and-forget pattern as
  `eagerDeleteRemoteSessionBranch`; an `unlink` on a missing dir is harmless.

— end —
