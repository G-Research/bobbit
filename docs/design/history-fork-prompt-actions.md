# History Fork Prompt Actions

> **Historical test-layout note:** Remaining non-canonical test paths in this record describe proposed, retired, or pre-migration locations; they are not current placement or execution guidance. Current pinning tests that still exist are named at canonical paths.

## Status and decision

This document is the implementation contract for **Fork From History**. It records the selected design and the alternatives considered during implementation.

The selected design is deliberately narrow:

1. Extend the existing `POST /api/sessions/:id/fork` request with an optional durable Pi transcript `entryId`.
2. For a history request, read the source JSONL **once** into an immutable string, apply Bobbit's existing parent-linked active-branch semantics, validate the selected entry, and materialize only the active ancestors strictly before it.
3. Feed that materialized transcript into the existing fork context builder and `launchSidebarSessionFork()` lifecycle.
4. Mount the real `SidebarActionsPopover` at the message-row boundary. Extend that component only with an optional sibling help stop/tooltip.
5. Preserve a Pi entry cursor on server-confirmed visible user rows. Never derive a cursor from a rendered index, client message id, text, DOM, or browser-supplied message array.

The design does **not** add a second endpoint, invoke a Pi fork/session-switch RPC on the source, append a synthetic leaf selector, introduce a general action-popover controller, or add rollback/replacement behavior.

## Scope ledger

| Area | In scope | Explicitly out of scope |
|---|---|---|
| Prompt rows | One always-visible compact overflow trigger on eligible durable user prompts, including the current prompt once its transcript cursor is confirmed, identical on desktop and mobile | Assistant/tool/synthetic/optimistic/pending actions; hover-only action bars; long press |
| Prompt actions | **Fork before this point** with a row tooltip, trailing **New worktree** toggle, **Copy prompt** | Resend, edit, retry, rollback, replacement, delete, branch switching |
| Copy | Original user-visible text only; preserve line breaks, typed slash-skill syntax, and `@path`; exclude attachments and private author prefixes | Copying rendered DOM, attachment labels/data, expanded model prompt, author badge text |
| Fork API | Optional durable `entryId` on the existing live-fork endpoint; authoritative active-branch validation; exact cut before the selected prompt | New clone endpoint; client index/message-array input; Pi mutating fork RPC |
| Transcript | One immutable raw source read; exact retained raw JSONL records; selected and later records physically absent | Rewriting source JSONL; leaving discarded entries behind a synthetic leaf marker |
| Worktree | Default history behavior reuses the exact source cwd/worktree/branch; opt-in uses the existing fresh-worktree lifecycle | Reset, clean, stash, checkout, registration of shared-tree ownership, bespoke worktree cleanup |
| Context | Existing fork project/goal/task/reattempt/staff/role/accessory/sandbox/tools/model/thinking/proposal/author context | New inheritance policy or session-cloning framework |
| Clients | Source remains live/listed; only the initiating client navigates on success | Moving all connected clients or stopping the source |
| Sidecars | Filter author, skill/file-mention, and compaction sidecars to retained entries; copy proposal drafts; omit positional tool cache | Copying any cache wholesale when it can refer to discarded entries |

## Existing seams to preserve

### Fork lifecycle

The route in `src/server/server.ts` already owns the complete live-fork policy and context assembly. History fork must stay inside it and reuse:

- `isUnsupportedForkSource(session, persisted)` for server eligibility;
- `resolveServerInitialModelTuple()` and `requireCurrentSessionModel()`;
- staff and role resolution plus `roleCreateOptions()`;
- `sessionFsContextForAgentFile()` and realm-aware session filesystem operations;
- `copyAuthorSidecar()` / `purgeAuthorSidecar()`;
- proposal-draft copy and failed-fork artifact cleanup;
- `launchSidebarSessionFork()` from `src/server/sidebar-actions.ts`;
- `sessionManager.createSession()`, generated-title assignment, refresh, and `switch_session` rehydration;
- the current `201` response and `connectToSession(fork.id, true, { refetchMessagesOnReady: true })` client path.

`launchSidebarSessionFork()` remains the only production fork launcher. It continues to own fresh-worktree discovery, create-session invocation, stale-cwd provenance, title, goal, and assistant context.

### Canonical action UI

`src/ui/components/SidebarActionsPopover.ts` remains the only menu implementation. Prompt actions must use its:

- `SidebarActionsPopoverItem` item model;
- row, icon, type, spacing, color, and compact `toggle-switch--sm` markup;
- `computeSidebarActionsPopoverPosition()` fixed positioning and viewport clamp;
- row/toggle roving focus, arrows, Home/End, Enter/Space behavior;
- outside-pointer, Escape, Tab, hash/popstate dismissal;
- focus restoration and reduced-motion behavior.

The prompt surface directly creates and body-mounts `<sidebar-actions-popover>` from `MessageList`; it does not extract or introduce an app-wide popover controller. The existing header and sidebar mount code remains unchanged.

### Clipboard and feedback

Reuse `copyTextToClipboard()` from `src/app/api.ts` and `showHeaderToast()` from `src/app/header-toast.ts`. Success copy is `Prompt copied`; failure is `Couldn't copy prompt`. The existing connection-error surface remains the clear fork failure path.

## Request and response contract

### Request

`POST /api/sessions/:id/fork`

```ts
interface ForkSessionRequest {
  /** Existing behavior: omitted means true for a whole-session fork. */
  newWorktree?: boolean;
  /** Optional durable Pi JSONL entry id. Presence selects history-fork mode. */
  entryId?: string;
}
```

Two modes share one handler:

| Body | Meaning |
|---|---|
| `{}` or `{ newWorktree: true | false }` | Existing whole-session fork; omission still defaults to a new worktree |
| `{ entryId, newWorktree }` | History fork immediately before `entryId`; the prompt client always sends the boolean explicitly and starts at `false` |

For history mode, `entryId` must be a trimmed, non-empty string no longer than 256 UTF-16 code units and must equal its trimmed form. The server does not accept `message`, `messages`, `index`, parent ids, text, or a browser-computed branch. `newWorktree`, when present, must be boolean. Unknown fields are ignored for forward compatibility but never influence the clone.

### Success

The existing `201` payload is unchanged:

```ts
interface ForkSessionResponse {
  id: string;
  cwd: string;
  status: string;
  projectId?: string;
  goalId?: string;
  title?: string;
}
```

### Error schema

All new history validation failures use the existing JSON error shape with a stable code:

```ts
interface ForkSessionError {
  error: string;
  code?:
    | "HISTORY_FORK_CURSOR_INVALID"
    | "HISTORY_FORK_CURSOR_NOT_FOUND"
    | "HISTORY_FORK_CURSOR_INACTIVE"
    | "HISTORY_FORK_CURSOR_NOT_USER"
    | "HISTORY_FORK_TRANSCRIPT_INVALID"
    | "HISTORY_FORK_IN_PROGRESS";
  stack?: string; // existing development/error forwarding only
}
```

| Status/code | Condition and user-facing `error` |
|---|---|
| `400 HISTORY_FORK_CURSOR_INVALID` | Missing/wrong-type/empty/overlong/non-normalized history cursor: `Invalid history fork entry id` |
| `409 HISTORY_FORK_CURSOR_NOT_FOUND` | No id-bearing record in the immutable read: `This prompt is no longer available` |
| `409 HISTORY_FORK_CURSOR_INACTIVE` | Entry exists but is not on the active branch: `This prompt is no longer on the active conversation branch` |
| `422 HISTORY_FORK_CURSOR_NOT_USER` | Entry is not an ordinary `type:"message"` accountable user prompt, or is tool-result-only: `History forks must start before a user prompt` |
| `409 HISTORY_FORK_TRANSCRIPT_INVALID` | Duplicate ids, cycle, missing parent, non-object JSON, malformed complete line, invalid header, or impossible ordering: `The session transcript changed or is not valid for history forking` |
| `409 HISTORY_FORK_IN_PROGRESS` | Same source/cursor/worktree tuple already reserved: `A fork from this prompt is already being created` |

Existing route errors retain their current statuses: missing persisted source `404`; unsupported/non-live/cross-realm `422`; missing project/goal `410`; model and launch failures as currently surfaced. Validation happens before fork id allocation, goal mutation, sidecar copy, or worktree/session creation.

## Cursor projection and provenance

### Wire shape

Add only Bobbit-owned, additive cursor metadata:

```ts
type BobbitMessage<T extends object> = T & {
  author?: MessageAuthor;
  entryId?: string;
  /** Present only when Bobbit proved entryId came from Pi's durable transcript. */
  _entryIdSource?: "pi-transcript";
};
```

The reducer's normal `message.id` is not a history cursor. It may be Pi message identity, an optimistic id, a compaction id, or a synthesized render key. The only eligible pair is a bounded `entryId` plus `_entryIdSource:"pi-transcript"` on a server-origin row.

### Authoritative cursor snapshots

Live Pi events do not prove transcript cursor identity, so `prepareVisibleAgentEvent()` strips any claimed `_entryIdSource`. Cursor projection instead pairs one immutable `get_messages` response with Pi's transcript cursor snapshot, correlates accountable user rows against the active branch, and stamps only proven rows with `{ entryId, _entryIdSource: "pi-transcript" }`.

Pi has appended the current user prompt by `agent_start`. Bobbit schedules this paired read behind that event's call stack and broadcasts a cursor-enriched replacement, making the ellipsis available while the assistant is working. The final `agent_end` refresh remains a fallback for transient persistence lag and is the only refresh that consumes pending skill-sidecar bindings.

Reload snapshots use the same paired projection. Weak, unresolved, unpersisted, or legacy rows fail closed and show no actions. The authoritative fork request still validates the cursor against its own immutable JSONL read, so a forged or stale browser field cannot select an invalid boundary.

`src/server/agent/transcript-reader.ts` already exposes `entryId` for raw transcript projections. Pre-compaction expanded rows are intentionally ineligible: they are orphaned history, not entries on the current active branch. They must not gain `_entryIdSource:"pi-transcript"` for this surface.

## Client eligibility

Add a pure predicate at the `MessageList` row boundary:

```ts
export function isEligibleHistoryPrompt(
  message: BobbitMessage<AgentMessage>,
  context: {
    canForkSource: boolean;
  },
): boolean;
```

It returns true only when all conditions hold:

1. `canForkSource` comes from `canForkSession()` in `src/app/session-actions.ts`.
2. `isAccountablePromptMessage(message)` is true (`user` or `user-with-attachments`, not a tool-result-only provider row).
3. Reducer provenance is `_origin === "server"`; `_origin:"optimistic"`, `"synthetic"`, or `"permission"` is rejected even if fields are malformed or injected.
4. `entryId` is a bounded non-empty string and `_entryIdSource === "pi-transcript"`.

A current streaming prompt is eligible as soon as the authoritative cursor refresh projects its durable entry id.

No action is rendered for archived/read-only/non-interactive/terminated/delegate/child/team sessions because `canForkSession()` already rejects them. The server repeats the source and entry checks authoritatively.

`MessageList` needs the source forkability as an explicit property from `AgentInterface`; nested pre-compaction `MessageList` instances receive `false`. Eligibility is computed before deferred rendering so offscreen deferral does not change the decision.

## Prompt text contract

Extract the existing user text rule in `src/ui/components/Messages.ts`:

```ts
export function userVisiblePromptText(
  message: UserMessageWithAttachments | UserMessageType,
): string;
```

It returns:

- `content` unchanged when it is a string;
- the text of the user message's text block(s), joined in source order without markdown rendering;
- `""` when there is no textual content.

Rendering and copying call the same helper. Copy captures this immutable string when opening the menu; it never reads `textContent`. Because visible snapshot projection has already removed a trusted private author prefix and applied the skill/file sidecar's `originalText`, copied text preserves the user's typed `/skill` and `@path` forms and all original line breaks. Image blocks, attachment tiles, filenames, author badges, timestamps, and action labels are excluded.

A textless attachment prompt may still expose Fork if it has a valid cursor, but **Copy prompt** copies the textual prompt only; for empty text it should fail clearly (`Couldn't copy prompt`) rather than copying an attachment label.

## Prompt-row and popover composition

### Trigger

`UserMessage` renders the same trigger for labelled and legacy bubbles. It sits after the bubble shell, bottom-aligned, and never overlays content or attachments. `src/ui/app.css` owns the responsive geometry:

- visible 28-by-28 button with a compact overflow icon;
- 32-by-32 reserved desktop wrapper;
- at least a 44-by-44 effective touch hit area on narrow/touch layouts without changing the visible button;
- transparent default, canonical hover/focus/expanded states;
- accessible name `Actions for prompt` (optionally followed by a short text prefix), `aria-haspopup="menu"`, and accurate `aria-expanded`.

There is no alternate desktop hover action and no long-press listener.

The trigger dispatches a composed `prompt-actions-open` detail containing only the validated projected cursor, captured visible text, and actual trigger element. It does not carry a message array or index.

### Direct `SidebarActionsPopover` mount

`MessageList` owns at most one open prompt popover. Its small local record is:

```ts
interface OpenPromptActions {
  element: SidebarActionsPopover;
  trigger: HTMLElement;
  entryId: string;
  promptText: string;
  newWorktree: boolean;
}
```

Opening performs a dynamic import of `SidebarActionsPopover`, checks an incrementing request token and `trigger.isConnected`, closes/removes any previous prompt popover, creates the element, appends it to `document.body`, and sets `open=true`. This is a direct, prompt-local adaptation of the existing mount pattern, not a reusable controller abstraction. Disconnect and route change remove the element.

`newWorktree` is set to `false` in the newly constructed record on **every** open, including reopening the same row. Refreshing items after a toggle preserves that record only while the menu remains open.

Items, in order:

1. `history-fork`: label `Fork before this point`, `GitFork` icon, row `title` set to **“The new session will include the conversation up to, but not including, this prompt.”**, trailing `New worktree` toggle.
2. `copy-prompt`: label `Copy prompt`, `Copy` icon.

There is no separate `(?)` help control or focus stop. Selecting Fork dispatches a composed `prompt-history-fork` event with `{ entryId, newWorktree }`. Selecting Copy dispatches `prompt-copy` with the captured string. `AgentInterface` resolves the current `GatewaySession`, calls `forkSession()` or `copyTextToClipboard()`, and shows existing feedback. No prompt is put in the composer, prefetched, or resent.

Pointer/touch activation of the toggle uses the existing `_handleToggle()` path. Its accessible label remains `New worktree (off) — reuse the source worktree` or `New worktree (on) — fork into a fresh worktree`; `aria-checked` is always current.

Escape/outside pointer returns focus to the prompt trigger. Tab dismisses without forcibly moving focus. Successful selection closes the menu.

## Immutable JSONL branch materialization

### Shared tree helper

Move the private parsing/tree logic from `src/server/agent/transcript-sanitizer.ts` into a focused pure module:

```ts
// src/server/agent/transcript-tree.ts
export interface ParsedTranscriptLine {
  lineIndex: number;
  raw: string;       // exact line bytes as decoded UTF-8, including its terminator
  entry: Record<string, unknown>;
  id: string | null;
  parentId: string | null;
}

export interface ParsedTranscript {
  records: ParsedTranscriptLine[];
  headers: ParsedTranscriptLine[];
  byId: Map<string, ParsedTranscriptLine>;
  activeBranch: ParsedTranscriptLine[];
  anomalies: TranscriptTreeAnomaly[];
}

export function parseTranscript(content: string): ParsedTranscript;
export function activeTranscriptBranch(parsed: ParsedTranscript): ParsedTranscriptLine[];
```

The sanitizer imports these helpers and retains its current lenient repair behavior. The history materializer uses the same leaf semantics in strict mode:

- session headers are not tree entries;
- the last id-bearing non-header record is normally the leaf;
- a terminal `type:"leaf"` harness control may select `targetId` and is not itself copied;
- branch order is the reverse parent walk from leaf;
- each parent must exist earlier in the file;
- duplicate ids, missing parents, cycles, and impossible ordering are anomalies.

Malformed non-empty complete lines fail history materialization. One malformed **unterminated final fragment** may be ignored as a concurrent append that had not completed when the immutable read finished; it can never supply the requested cursor or become a copied record. This is the only malformed-line exception.

### Focused materializer

Add:

```ts
// src/server/agent/history-fork.ts
export interface HistoryForkMaterialization {
  content: string;
  retainedEntryIds: Set<string>;
  retainedUserEntries: ParsedTranscriptLine[];
  retainedCompactions: ParsedTranscriptLine[];
  selected: ParsedTranscriptLine;
}

export class HistoryForkValidationError extends Error {
  code: ForkSessionError["code"];
  status: 400 | 409 | 422;
}

export function materializeHistoryForkTranscript(
  sourceContent: string,
  entryId: string,
): HistoryForkMaterialization;
```

Algorithm:

1. Parse the immutable source string and validate exactly one usable session header and a strict tree.
2. Resolve `entryId` in `byId`; distinguish missing from present-but-inactive.
3. Require the selected active record to be `type:"message"` whose `message` is an accountable ordinary user prompt and not tool-result-only.
4. Take the selected record's active-branch prefix; the selected record and every descendant are excluded. This boundary is stable even while descendants are being appended.
5. Emit the exact raw session header record(s), then exact raw records for those active ancestors in parent order. Preserve unknown/additive fields, model/thinking changes, assistant/tool records, compaction records, retained tails, timestamps, and each retained line's original terminator. Do not stringify parsed entries.
6. Return retained ids and typed subsets for sidecar filtering.

The destination for a first/root prompt therefore contains only the valid source session header. There is no user prompt prefill and no automatic dispatch.

### One source read and atomic destination write

History mode replaces the current copy-then-read sequence with exactly one:

```ts
const sourceContent = await sessionFileRead(srcCtx, sourceJsonl, sandboxManager);
```

No `sessionFileCopy()` is performed in history mode. The immutable string is the sole authority for validation, materialization, and all transcript-based sidecar filtering. Later source appends cannot enter the destination and the source file is never opened for write.

Add a generated-destination writer in `src/server/agent/session-fs.ts`:

```ts
export async function sessionFileWriteAtomic(
  ctx: SessionFsContext,
  filePath: string,
  content: string,
  sandboxManager: SandboxManager | null,
): Promise<void>;
```

It creates the destination directory, writes an exclusive same-directory temporary file with mode `0600`, fsyncs/closes it, then renames atomically. For sandbox sessions it targets the established sessions bind mount / same project realm; it must not shell-interpolate content. The route passes only a `formatAgentSessionFilePath()`-generated destination under the trusted sessions root. A staging failure removes only its temporary file.

Whole-session fork retains its current lossless `sessionFileCopy()` behavior.

## Sidecars and caches

All filtering uses the same `HistoryForkMaterialization` produced from the one source read.

| Data | History-fork rule | Reason |
|---|---|---|
| Author sidecar | `copyAuthorSidecar(sourceId, forkId, { transcript: materialized.content })` unchanged | Existing transcript confirmation copies only echoed bindings represented in retained JSONL; preserves trusted author metadata and prefix projection |
| Skill/file-mention sidecar | Add `copySkillSidecarForTranscript(sourceId, forkId, retainedUserEntries)`; occurrence-aware exact model text + timestamp matching, same FIFO contract as `mergeSidecarEntriesIntoMessages()` | Retains original typed slash/`@path` text without leaking entries for discarded prompts |
| Compaction sidecar | Add `copyCompactionSidecarForTranscript(sourceId, forkId, retainedCompactions, retainedEntryIds)`; retain only a record whose non-null `firstKeptEntryId` survives and whose matching compaction boundary survives; drop null/unprovable records | Prevents synthetic compaction cards/expand links from referring to removed history |
| Proposal drafts | `copyProposalDirIfPresent()` unchanged | Drafts are session-level and contain no transcript entry cursor/index |
| Tool-content directory | Do not copy in history mode | Its documented keys are message/block positions; branch materialization can shift positions. Full retained tool content remains in JSONL |
| EventBuffer/message snapshot cache | Create none/copy none | The new session builds fresh runtime caches from the materialized JSONL |
| Prompt queue, in-flight steer ledger, current proposal UI state | Copy none except durable proposal files | These are live source intent, not transcript history |

Add `purgeSkillSidecar()` and `purgeCompactionSidecar()` to failed-fork cleanup. A copied sidecar must never outlive a failed destination.

## Worktree, cwd, branch, sandbox, and ownership

### `newWorktree:false` — history default

Adjust the reuse branch in `launchSidebarSessionFork()` to select the source's exact active cwd:

```ts
sessionCwd = input.source.cwd
  || input.persisted.cwd
  || input.persisted.worktreePath
  || input.projectRoot;
```

`persisted.worktreePath` remains old-cwd provenance but must not replace a more specific live/nested cwd. In reuse mode:

- `worktreeOpts` is absent;
- no worktree or branch is created, checked out, registered, adopted, reset, cleaned, stashed, or deleted;
- do not attach goal/session worktree ownership metadata to the fork;
- terminating either session cannot remove the shared tree on behalf of this fork;
- source and destination agents intentionally share the exact filesystem state and branch;
- no source process, background command, project server, prompt queue, or agent is stopped or unwound.

For sandboxed sources, preserve `sandboxed:true`, project/sandbox realm, and the exact source container cwd. The current fallback:

```ts
if (ps.sandboxed && !worktreeOpts && !ps.goalId && !ps.assistantType) {
  createOpts.sandboxBranch = ...;
}
```

must additionally require `newWorktree === true`. A reuse fork must not allocate `sandboxBranch`, create a fresh container worktree, or claim teardown ownership.

### `newWorktree:true`

Keep existing session-level Fork semantics:

- `launchSidebarSessionFork()` resolves the project git repo and supplies `worktreeOpts`;
- normal `createSession()` / worktree-pool lifecycle creates and owns the fresh branch/worktree;
- the materialized JSONL is handed to the existing `preExistingAgentSessionFile` / `switch_session` path;
- `preExistingAgentSessionOldCwds` rebases only Bobbit/Pi runtime cwd metadata, never user or assistant message content;
- existing sandbox worktree provisioning applies.

No history-specific branch naming, registration, setup, teardown, or cleanup path is added.

## Preserved fork context

The history branch must use the same create-option block as whole-session fork and preserve:

- project id;
- goal id, task id, and reattempt goal id;
- assistant type;
- staff id, role prompt/name, accessory, and staff environment;
- allowed tools;
- sandboxed state and realm;
- selected/effective initial model and thinking level through `resolveServerInitialModelTuple()`;
- durable proposal drafts;
- transcript-confirmed author metadata;
- all retained tool content and unknown Pi JSONL fields.

Cursor validation/materialization must run before changing a todo goal to in-progress. Once validation succeeds, the existing goal transition behavior remains shared with full fork.

The source session object, persisted row, EventBuffer, JSONL bytes, sidecars, cwd, branch, process, clients, status, queue, and listing remain unchanged. Only destination artifacts and the existing applicable goal transition may change.

## Single-flight, races, and cleanup

### Client

Extend the existing client signature only:

```ts
export async function forkSession(
  source: GatewaySession,
  opts: { newWorktree: boolean; entryId?: string },
): Promise<void>;
```

It posts `entryId` only when supplied. The existing synchronous `state.creatingSession` guard is the client single-flight: the first pointer/keyboard event sets it before awaiting, so repeated activation cannot send a second request. Prompt triggers reflect disabled/busy state while it is true. Toggle and help never call `forkSession()`.

Navigation remains after a successful id-bearing `201` and session refresh. Any fetch, validation, clipboard, launch, or connect failure leaves the source route selected and shows a clear error. The source is not optimistically removed or replaced.

### Server reservation

History mode holds a small in-memory reservation keyed by:

```ts
`${sourceId}\0${entryId}\0${newWorktree ? "1" : "0"}`
```

Acquire it before the immutable read and release it in `finally`. A duplicate gets `HISTORY_FORK_IN_PROGRESS`. This closes double-click, retry, and multi-tab overlap without serializing different boundaries or changing whole-session fork behavior.

### Append and stale races

- The immutable `sessionFileRead()` snapshot defines the request. Appends completed after it are irrelevant.
- A final partial append is ignored only under the strict unterminated-fragment rule.
- If the selected entry is absent or inactive in that read, fail before allocating destination state.
- Source status is captured/rechecked around materialization for live-source eligibility, but streaming does not invalidate an exact cut before the selected prompt.
- Server validation never relies on browser streaming state.

### Failure cleanup

Expand the existing failed-fork cleanup helper to remove, best effort:

- generated destination JSONL and its staging file;
- destination tool-content and proposal directories;
- destination author, skill/file-mention, and compaction sidecars.

Run it for materialized-write, sidecar-copy, session-create, switch-session, and title failures. If `createSession()` acquired a fresh worktree, its established creation rollback remains the only owner allowed to release it. The route must not invent a second worktree removal. For reuse mode, cleanup must never touch cwd/worktree/branch because the fork owns none of them.

If a failed create left a destination persisted-session record, use the established session-creation rollback/purge path before returning. Cleanup errors are logged and do not mask the primary API error. The reservation always releases.

## File and symbol plan

| File | Exact change |
|---|---|
| `src/server/agent/transcript-tree.ts` (new) | Export raw-line parser, active-branch selection, and anomaly reporting extracted from sanitizer semantics |
| `src/server/agent/history-fork.ts` (new) | Export `materializeHistoryForkTranscript()` and typed validation error/result |
| `src/server/agent/transcript-sanitizer.ts` | Import shared parser/tree helpers; no sanitizer behavior change |
| `src/server/agent/session-fs.ts` | Add `sessionFileWriteAtomic()` for generated same-realm destinations |
| `src/server/server.ts` | Parse optional `entryId`; reservation; one-read materialization; validation/error mapping; sidecar filtering; existing launch/context call; expanded cleanup |
| `src/server/sidebar-actions.ts` | Prefer exact live source cwd in reuse mode; leave fresh lifecycle unchanged |
| `src/shared/message-author.ts` | Add optional `entryId` and `_entryIdSource` to `BobbitMessage` |
| `src/server/agent/session-manager.ts` | Stamp authoritative live terminal user cursor at `prepareVisibleAgentEvent()` |
| `src/server/agent/author-sidecar.ts` | Stamp settlement cursor during snapshot correlation; keep `copyAuthorSidecar()` transcript filter |
| `src/server/agent/visible-message-snapshot.ts` | Preserve cursor through existing author → truncate → skill projection order |
| `src/server/skills/skill-sidecar.ts` | Add filtered occurrence-aware copy helper; retain purge helper |
| `src/server/agent/compaction-sidecar.ts` | Add filtered copy helper; retain purge helper |
| `src/server/agent/continue-archived.ts` | Expand failed destination artifact cleanup without changing continue/full-fork semantics |
| `src/app/session-manager.ts` | Add optional `entryId` to `forkSession()` body; retain global single-flight, refresh, navigation, and failure UI |
| `src/ui/components/SidebarActionsPopover.ts` | Optional help descriptor, sibling help control/tooltip, `help` focus stop, positioning and non-bubbling interactions |
| `src/ui/components/Messages.ts` | Export `userVisiblePromptText()`; render one eligible prompt trigger in both user-row markup branches |
| `src/ui/components/MessageList.ts` | Pure durable-cursor eligibility; directly mount one canonical prompt popover; reset toggle off; dispatch fork/copy events |
| `src/ui/components/AgentInterface.ts` | Pass source eligibility; handle prompt fork/copy composed events using existing app helpers |
| `src/ui/app.css` | Trigger/bubble reservation and help hit-area styles; canonical variables/classes, same desktop/mobile content |
| `docs/rest-api.md` | Optional `entryId`, history semantics, errors, worktree defaults |
| `docs/session-actions.md` | Prompt action surface, help/toggle/copy behavior, canonical popover reuse |
| `scripts/testing/layout-policy.mjs` | Classify every new core, DOM, integration, and browser test by path and semantic suffix |

No change is needed in `src/app/render.ts` or `src/app/render-helpers.ts`; their existing session/header/sidebar popover mounting remains independent and canonical through the shared component.

## Comparative defect surface

### Transcript/server options

| Option | New concepts | Race/losslessness | Source safety | Decision |
|---|---:|---|---|---|
| One raw JSONL read + shared active-tree helper + exact materialization | One pure tree extraction, one materializer, one atomic writer | Immutable request snapshot; retains exact selected raw records; discarded records physically absent | Read-only source | **Selected** |
| Read-only Pi `get_entries` / `get_fork_messages` RPC + correlation | RPC wrappers, snapshot coalescing, reverse duplicate correlation, RPC/version failure policy, materializer | Potentially coherent, but creates a second cursor plane and new Pi compatibility dependency | Read-only if carefully limited | Rejected as unnecessary defect surface |
| Pi `fork` / `createBranchedSession` on live source | Small Bobbit clone code | Pi owns topology but may replace/switch the active manager/session file | Can mutate the live source runtime | Rejected |
| Full copy + appended synthetic `leaf` record | Minimal code | Discarded rows remain; real Pi persistence does not guarantee Bobbit harness leaf control semantics | Source read-only | Rejected |
| Browser rendered-message slicing | Superficially small | Loses model/tool/compaction/custom records; races UI; trusts browser index/text | Source read-only | Rejected |

### UI options

| Option | New concepts | Lifecycle/parity risk | Decision |
|---|---:|---|---|
| Direct prompt-local mount of canonical `SidebarActionsPopover` + help stop | One local open-record and one optional component extension | Low: prompt owns one menu; component owns visuals/focus/dismissal | **Selected** |
| General `ActionPopoverController` plus prompt controller and migration of existing mounts | Two controllers, adapter lifecycle, migration of header/sidebar state | Larger regression area and no acceptance need to refactor established mounts | Rejected |
| Prompt-specific lookalike menu/tooltip/toggle | Entire second style/focus/position implementation | Immediate desktop/mobile/session drift | Rejected |
| Desktop hover action + mobile overflow/long press | Multiple action models and gesture paths | Violates identical discoverable surface requirement | Rejected |

The selected design's unavoidable new state is limited to: optional projected cursor provenance, one prompt popover record, one help pinned/open state inside the canonical component, one server reservation set, and temporary destination artifacts. It adds no second endpoint, second fork launcher, second worktree owner, new Pi RPC, broad action abstraction, or rollback state.

## Focused verification plan

All new tests use canonical `tests/` semantic paths and suffixes so lane discovery is automatic.

### Core

`tests/unit/core/history-fork-transcript.unit.test.ts`

- straight active ancestry and exact root cut;
- selected prompt and every descendant absent;
- inactive branch present in source but absent in output;
- terminal leaf selection using existing semantics;
- exact raw line/additive-field preservation for header/model/thinking/assistant/tool/compaction/custom entries;
- duplicate text prompts selected by id, not text;
- missing/stale/inactive/non-message/non-user/tool-result-only errors; exact cut before newest streaming prompt;
- duplicate ids, missing parent, cycle, out-of-order parent, malformed complete line;
- safe ignore of only a final unterminated append fragment;
- input/source string immutability.

`tests/integration/gateway/history-fork-sidecars.gateway.test.ts`

- author bindings filtered by materialized transcript, including duplicate prompts;
- skill/file entries filtered occurrence-by-occurrence and original typed text retained;
- compaction records retained only with surviving exact boundary and `firstKeptEntryId`;
- null/stale compaction rows dropped;
- proposal copy retained and history tool-cache copy omitted;
- every destination sidecar purged on failure.

`tests2/core/history-fork-cursor-projection.test.ts`

- live terminal user event inherits outer Pi entry id and provenance;
- snapshots inherit echoed settlement id after exact/digest/FIFO author matching;
- duplicate prompt occurrences get the correct cursor;
- assistant/tool/update/keyless/optimistic/unsettled rows get none;
- skill/author visible projection does not change the cursor.

Existing `tests/unit/core/transcript-sanitizer.unit.test.ts` and orphan-tool-result coverage must remain green to prove the helper extraction did not change sanitizer tree semantics.

### Integration

`tests/integration/gateway/history-fork-*.gateway.test.ts`

- request schema and stable status/code matrix;
- exact active cut from real session JSONL and source bytes unchanged before/after;
- concurrent append cannot enter the immutable clone;
- same-tuple reservation rejects duplicates and releases on every failure;
- source remains live/listed with unchanged persisted row/status/cwd/branch;
- project/goal/task/reattempt/assistant/staff/role/accessory/tools/model/thinking/proposals/authors retained;
- default/off exact cwd shared after reload, no worktree metadata/teardown ownership, terminating fork leaves source tree;
- on uses existing fresh worktree branch/setup/cleanup lifecycle;
- sandbox off reuses exact realm/cwd without `sandboxBranch`; sandbox on uses established lifecycle;
- cross-realm, atomic-write, sidecar, create, switch, and title failure cleanup.

Extend `tests/integration/gateway/sidebar-actions-fork-github-link.gateway.test.ts` only where it already pins `launchSidebarSessionFork()` cwd/worktree behavior. Whole-session fork must keep default `newWorktree:true` and existing semantics.

### DOM

`tests/dom/prompt-history-actions.dom.test.ts`

- full eligible/ineligible role/origin/cursor/forkability matrix;
- absent on assistant, tool, synthetic, optimistic, pending, pre-compaction orphan, archived, child/team/read-only rows; present on the current streaming row once its cursor is proven;
- one always-visible trigger and identical desktop/mobile item contents;
- legacy and author-labelled bubble placement; no content/attachment overlap;
- canonical icon/row/type/toggle classes and menu position behavior;
- toggle off on every open/reset; click/Enter/Space toggles `aria-checked` without fork/dismiss;
- help exact copy on hover, focus, click/tap, Enter, and Space; sibling semantics; no fork/toggle/dismiss;
- roving order, Home/End, Escape/outside/Tab, route dismissal, focus restoration;
- exact multiline slash/`@path` copy, attachments excluded, private prefix excluded;
- `Prompt copied` and `Couldn't copy prompt` feedback;
- repeated activation while pending sends once and failure remains on source.

Extend `tests/dom/session-menu.dom.test.ts` to prove help-capable rows do not change existing session Fork toggle/focus behavior.

### Browser journey

Add and register `tests/browser/journeys/history-fork-prompt-actions.journey.spec.ts` covering one real end-to-end lifecycle:

1. Create a source, send at least three distinct prompts including multiline `/skill`, `@path`, and attachment text.
2. Verify desktop overflow is always visible; open it and reach help by hover and keyboard.
3. Verify touch/mobile open and tap-pinned help with identical actions.
4. Copy prompt on desktop and mobile and assert exact clipboard text.
5. Toggle **New worktree** without a fork request.
6. Fork with off/default; assert source still live/listed, selected/later prompts absent, no composer prefill/resend, exact source cwd/branch before and after reload.
7. Fork with on; assert fresh cwd/branch through the existing lifecycle and reload.
8. Inject a stale/error response; assert no navigation and clear failure.
9. Clean up both destination sessions, the opt-in worktree through normal ownership, and the source.

Run in the required sequence: `npm run check`, focused unit/DOM/integration projects, `npm run test:unit`, `npm run test:browser`, then `npm run test:e2e` where the real worktree/sandbox lifecycle coverage is registered.

## Acceptance invariants

Implementation is complete only if these remain simultaneously true:

- A browser can name only a candidate Pi entry; the server chooses and validates the branch and boundary.
- The destination ends immediately before that entry and physically contains neither it nor any later/inactive record.
- The source JSONL and live source session are never mutated or switched.
- Reuse mode shares the exact cwd/worktree/branch without ownership; fresh mode uses the existing owner/lifecycle.
- Prompt copying uses projected original text, never model-expanded or rendered DOM content.
- Desktop and mobile expose the same visible trigger and same canonical menu.
- Help and toggle are independent accessible stops that cannot activate Fork.
- A request is single-flight on client and server, and all destination-only artifacts are cleaned on failure.
- Whole-session Fork remains backward compatible, including its default `newWorktree:true` behavior.
