# Project import decisions

**Status:** implementation design. **Scope:** run granted extension decision hooks while a project is registered, before any ordinary agent session exists.

## Decision

Add a `projectImported` hook event and a project-import delivery target to the existing extension decision system. `POST /api/projects` remains the sole import boundary: after `ProjectRegistry.register()` has persisted a new normal project and the handler has persisted its components, it creates/reconciles one durable import run and dispatches eligible hooks. It does not create an agent session, synthesize an ask envelope, or apply configuration.

The work composes the existing owners:

- schema-2 hook metadata and active-pack precedence: `src/server/agent/pack-contributions.ts` and `src/server/extension-host/pack-contribution-registry.ts`;
- exact live `decide` grants: `src/server/agent/extension-grant-policy.ts`;
- typed request validation, deadlines, dedupe, defaults/consent, continuation, redacted trace, and proposal-only effects: `decision-hook-contract.ts`, `decision-request-manager.ts`, and `decision-request-store.ts`;
- non-waking advisories: `InboxManager.enqueue(..., { wake: false })`;
- choice rendering: `AskUserChoicesWidget` through a thin decision renderer; and
- editable proposal creation/acceptance: `ProposalSeedService` and the normal proposal route.

A project import is not a session lifecycle event. Do not fake a `sessionId`, call `SessionManager.enqueuePrompt()`, append `ask-user_choices` envelopes, create a hidden agent, or expose a separate extension callback/HTTP channel. In particular, silence is never approval: a deferrable request may only take its already validated safe default; a consent-required import request has no default and times out/headless-denies its protected operation.

## Current seams

At parent head `abaa642bc`:

| Owner | Current public seam | Import extension |
|---|---|---|
| `src/server/server.ts::handleApiRoute()` | `POST /api/projects` registers the project, initializes `ProjectContext`, persists supplied/default components, pins `base_ref`, initializes the worktree pool, wires goal resolvers, then returns `201`. | Invoke the coordinator only after components have been persisted and before the `201` response. Upsert resumes a durably marked incomplete configuration or reconciles its already-created run; it never starts a new run. |
| `src/server/agent/pack-contributions.ts` | `HookEvent` has only session/tool/goal events; active hooks remain inert metadata. | Add `"projectImported"` as an inert declaration event. It is dispatchable only by the new import coordinator, only for `mode: "decide"`. |
| `src/server/agent/decision-request-manager.ts::DecisionHookDispatcher` | Builds a session-bearing `DecisionRequestOrigin`, invokes `decide`, validates output, uses `DecisionRequestManager.create()`, and rechecks grants before apply/continuation. | Factor its active-hook, invocation, validation, grant fences, advisory, and outcome logic into a shared dispatcher kernel; add `dispatchProjectImport()`. Keep `LifecycleHub` unchanged. |
| `src/server/agent/decision-request-store.ts` | One atomic project JSON snapshot owns requests, memories, first-terminal-write, continuation retry, and 30-day request retention. | Add project-import run/delivery records to the same snapshot, so registration/restart replay and decision terminal state share a project durability owner. |
| `src/server/proposals/proposal-seed-service.ts` | `seedFromDecision(originSessionId, ...)` requires an existing session and writes a normal editable proposal draft. | Generalize the *owner* argument so project-import decisions use the same parser, draft/revision, side-panel broadcast, and acceptance path without inventing a direct config write. |

## Contract

### Hook declaration and module

Extend the existing union, not a second hook catalogue:

```ts
// src/server/agent/pack-contributions.ts
export type HookEvent =
  | "sessionSetup" | "beforePrompt" | "beforeToolCall" | "afterToolResult"
  | "afterTurn" | "beforeCompact" | "sessionShutdown" | "goalProvisioned"
  | "projectImported";
```

A `projectImported` hook must be `mode: "decide"`; no `selectors`, schedule, request-mutation output, or provider path is valid for it. Its module uses the existing direct/default `hooks` export kind, with one additive member:

```ts
// src/server/agent/decision-hook-contract.ts
export interface ProjectImportDecisionHookContext {
  readonly event: "projectImported";
  readonly projectId: string;
  readonly importId: string;
  readonly projectRoot: string;
  readonly ownedRoots: readonly string[];
  readonly components: readonly ProjectImportComponent[];
}

export interface ProjectImportComponent {
  readonly id: string;
  readonly root: string;
  readonly languages: readonly DetectedProjectLanguage[];
}

export interface DecisionHookModule {
  decide(ctx: DecisionHookContext | ProjectImportDecisionHookContext):
    Promise<DecisionHookOutput | null | undefined> | DecisionHookOutput | null | undefined;
  onDecision?(ctx: DecisionResolutionContext | ProjectImportDecisionResolutionContext): Promise<void> | void;
}

export interface ProjectImportDecisionResolutionContext extends ProjectImportDecisionHookContext {
  readonly requestId: string;
  readonly resolution: ValidatedDecisionResolution;
}
```

`DecisionHookOutput`, `ExtensionDecisionRequest`, `ExtensionAdvisory`, the strict unknown-key validator, text/JSON bounds, option/Other validation, and `decide` grant all remain the current contracts. An import request may use only `scope: "project"`; a submitted session/goal scope is rejected with `DECISION_SCOPE_UNAVAILABLE` before persistence. `priorDecision` is the existing exact project-scoped memory only. No `cwd`, goal, role, prompt, transcript, `gateway`, raw configuration, Host API, environment, user input, or arbitrary filesystem path is added.

`onDecision` is best-effort and must recheck the active declaration plus the exact `decide` grant immediately before import, exactly as today. It receives the persisted import-context snapshot, not a freshly scanned filesystem context.

### Bounded, server-derived import context

Add `src/server/agent/project-import-decision-context.ts`:

```ts
export const DETECTED_PROJECT_LANGUAGES = [
  "c", "cpp", "csharp", "dart", "elixir", "go", "haskell", "java",
  "javascript", "kotlin", "lua", "php", "python", "ruby", "rust",
  "scala", "shell", "sql", "swift", "typescript",
] as const;
export type DetectedProjectLanguage = typeof DETECTED_PROJECT_LANGUAGES[number];

export interface ProjectImportDecisionContext extends ProjectImportDecisionHookContext {}

export function buildProjectImportDecisionContext(input: {
  project: Pick<RegisteredProject, "id" | "rootPath">;
  components: readonly Component[];
  fs?: Pick<typeof fs, "realpathSync" | "readdirSync" | "existsSync">;
}): ProjectImportDecisionContext;
```

The builder is the only source of this context. It resolves `project.rootPath` once with `realpathSync`; failure is `PROJECT_IMPORT_CONTEXT_UNAVAILABLE`. Every component root is calculated from the persisted `Component.repo` and optional `relativePath`, resolved with `realpathSync`, and retained only when it is equal to or a descendant of that canonical project root using `path.relative` containment. It never follows a component path outside the project or passes a lexical/config-supplied root through.

`projectRoot` is that canonical project root. `ownedRoots` is the sorted, deduplicated project root plus accepted component roots. A component has a deterministic safe `id` derived from its persisted component index and a SHA-256/base32 fingerprint of `{ name, repo, relativePath }`; the hook does not receive the unbounded display name. Component count is capped at 30; a registration with more configured components is represented by the first 30 in deterministic `(root, id)` order and has no unbounded overflow field.

Language detection is deliberately shallow, bounded, and not Code Intelligence:

- inspect at most 256 direct entries per accepted root; never recurse, execute a command, read source contents, inspect dependencies, or follow symlinks;
- map only fixed file names/extensions to `DetectedProjectLanguage` (for example `package.json`/`.ts` → `typescript`, `.py` → `python`, `go.mod`/`.go` → `go`, `Cargo.toml`/`.rs` → `rust`);
- return a sorted unique list of at most 12 identifiers per component; and
- reject anything outside `DETECTED_PROJECT_LANGUAGES` during context snapshot load as well as construction.

Paths are absolute canonical paths of at most 4,096 UTF-16 code units; import and component ids use the existing safe-identifier grammar and 128-character cap. The persisted snapshot is frozen/defensively copied before each module invocation. No language confidence, framework label, manifest content, command, package name, file list, byte count, or scanner diagnostic is exposed.

## Durable delivery and replay

### Import run and delivery target

Add an optional registration marker to `RegisteredProject`, written by `ProjectRegistry.register()` only for a newly created normal project:

```ts
interface RegisteredProject {
  // existing fields
  importDecisionRun?: {
    version: 1;
    id: string;
    createdAt: number;
    state: "configuring" | "ready";
  };
}

function markImportDecisionRunReady(projectId: string, importId: string): RegisteredProject;
```

The registration writes `state: "configuring"`. The project route writes components/default component configuration first, then atomically calls `markImportDecisionRunReady()`, and only then dispatches. A retrying `upsert` for a `configuring` marker resumes that same configuration stage from the supplied body before marking it ready; it does not create a second marker. Gateway boot skips configuring markers rather than guessing lost request data. Legacy projects have no marker and are never backfilled or dispatched. This marker closes the cross-store crash gap without silently importing incomplete configuration.

Add a delivery union rather than abusing a synthetic session id:

```ts
// decision-request-store.ts
export type DecisionDelivery =
  | { kind: "session"; sessionId: string }
  | { kind: "project-import"; importId: string };

export type ImportDecisionOutcomeCode =
  | "applied" | "superseded" | "denied" | "dropped" | "error";

export interface StoredProjectImportRun {
  id: string;
  projectId: string;
  context: ProjectImportDecisionContext;
  createdAt: string;
  completedAt?: string;
  hooks: Record<string, {
    state: "pending" | "completed";
    completedAt?: string;
    outcome?: ImportDecisionOutcomeCode;
  }>;
}

export interface DecisionRequestStoreState {
  version: 2;
  requests: Record<string, StoredDecisionRequest>;
  memories: Record<string, DecisionMemory>;
  importRuns: Record<string, StoredProjectImportRun>;
}
```

`StoredDecisionRequest` gains `delivery: DecisionDelivery`; legacy records normalize to `{ kind: "session", sessionId: record.sessionId }` and retain their old `sessionId` field for route/file compatibility. A `project-import` record has no session or goal id and requires project scope. `DecisionRequestStore` adds atomic primitives:

```ts
ensureImportRun(run: StoredProjectImportRun): { created: boolean; run: StoredProjectImportRun };
completeImportHook(runId: string, hookKey: string, outcome: ImportDecisionOutcomeCode, at: string): boolean;
listPendingImportRequests(importId: string): StoredDecisionRequest[];
```

A run cannot be overwritten when its id/context fingerprint differs. A failed atomic write leaves the old snapshot authoritative and produces `DECISION_STORE_UNAVAILABLE`; providers and registration persistence are not rolled back.

Use the existing request dedupe/fingerprint, terminal CAS, scoped memories, retention, default timer, continuation attempt limit, trace outcomes, and proposal failure record. For project-import delivery, reuse the session numeric limits under the logical delivery id: at most two pending and six accepted new requests per import run in 24 hours. Project scope memory remains keyed by `(projectId, packId, hookId, key)`, never by import id, so it follows the existing project-scope semantics. Budget exhaustion is loud (`DECISION_BUDGET_EXHAUSTED` trace/outcome), never an implicit `null`.

### Coordinator and replay order

Add `src/server/agent/project-import-decision-coordinator.ts`:

```ts
export class ProjectImportDecisionCoordinator {
  dispatch(projectId: string, importId: string): Promise<readonly TraceDecisionOutcomeRow[]>;
  reconcile(projectId: string): Promise<void>;
  reconcileAll(): Promise<void>;
}
```

`dispatch()` loads the persisted run first. For a new run it builds and atomically stores the bounded context snapshot, enumerates active `projectImported` hooks in registry order, and records a per-hook completion outcome after the result has been admitted. Before each `decide()` call and before every post-await application/continuation it repeats the current active-pack and grant check. A missing/revoked grant does not import the module and records fixed `denied / Grant required` metadata.

A crash before a hook outcome is committed permits that pure declaration call to run again; it cannot duplicate a request, default, memory, proposal, or continuation because all of those have durable request-id/dedupe/CAS boundaries. A hook must treat `decide()` as declaration-only, not an external side-effect callback. A committed hook outcome is skipped on replay. `onDecision` replay remains the manager's existing bounded durable continuation replay.

Gateway startup calls `reconcileAll()` after `ProjectContextManager.initAll()` and before serving normal work. It inspects only registered projects with a `ready` `importDecisionRun`; it creates/reconciles the matching store run and invokes outstanding hooks. `POST /api/projects` calls `dispatch()` after project configuration has been saved; an upsert first resumes a `configuring` marker if necessary, otherwise reconciles only its ready run. Thus an HTTP retry, process crash, restart, and duplicate post-import dispatch converge on one immutable context and one set of durable request records.

Hook throws, timeout, malformed output, corrupt decision store, context-build failure, trace failure, inbox failure, proposal-seed failure, or one project’s replay failure is contained to that hook/project. Registration remains durable and usable; errors are safe codes/logs/outcomes, not pack-controlled text.

## HTTP/UI, proposal, and audit boundaries

Project import has no conversation to mount a session card in. Add project-owned projection routes:

```text
GET  /api/projects/:projectId/import-decision-requests?state=pending
POST /api/projects/:projectId/import-decision-requests/:requestId/answer
```

The GET route reads only durable records with `delivery.kind === "project-import"` for the project's registered run. The POST route derives the project and actor, verifies the record/project/delivery/status/deadline, validates `{ value: DecisionValue }` against the stored request, and calls the same `DecisionRequestManager.answer()` terminal CAS. It accepts no actor, reason, class, scope, context, effect, proposal args, or timestamp. Races/retries return the stored terminal record; invalid values return 400; missing/mismatched records return 404.

Add metadata-only WS invalidation:

```ts
{ type: "project_import_decision_requests_updated"; projectId: string; ts: number }
```

It carries no context, question, answer, language, root, effect, or proposal data. REST is authoritative.

`src/app/dialogs.ts` keeps the Add Project flow on an import-decision step after successful registration and before `createProjectAssistantSession()`. New `src/app/project-import-decisions.ts` owns one active project projection; `src/ui/tools/renderers/ProjectImportDecisionRenderer.ts` adapts the stored question to the existing `AskUserChoicesWidget` and the new POST route. It shares `DecisionRequestRenderer`'s answer conversion/read-only handling, but no agent envelope or session transport. Reloading the dialog/project route re-fetches the durable pending projection. An import response with no pending decision proceeds to the existing assistant handoff unchanged.

Advisories continue through `InboxManager` with `{ wake: false }`; they are noninteractive staff work, not an import question. No new inbox state machine or modal is introduced.

A proposal effect routes through an additive project-owned owner in `ProposalSeedService`:

```ts
seedFromDecision(owner: ProposalDraftOwner, proposalType: ProposalType, args: Record<string, unknown>): Promise<ProposalSeedResult>;
type ProposalDraftOwner =
  | { kind: "session"; sessionId: string }
  | { kind: "project-import"; projectId: string; importId: string; requestId: string };
```

The project-import owner writes the same validated, revisioned editable draft and opens the same proposal workspace projection, keyed by the durable import id rather than a fabricated session. Existing proposal parsing, target-project resolution, side-panel notification, and acceptance remain authoritative. Proposal creation failure records only `PROPOSAL_SEED_FAILED`; it does not undo the answer/default/memory and has no direct-configuration fallback. Consent-required import effects use the existing forced class/default stripping and can only create a proposal after a real user answer—timeout/headless denial cannot create one.

Import dispatch and delayed resolution append the existing bounded/redacted `ContextTraceStore` outcome rows. Add only the fixed event label `projectImported` and safe `importId`/request fingerprint fields; never write roots, component ids, languages, question prose, labels, Other text, proposal args, package content, or errors/stacks to trace JSONL.

## File map and tests

| Slice | Files |
|---|---|
| Contract/context | `src/server/agent/pack-contributions.ts`, `decision-hook-contract.ts`, new `project-import-decision-context.ts` |
| Durable manager/replay | `project-registry.ts`, `decision-request-store.ts`, `decision-request-manager.ts`, new `project-import-decision-coordinator.ts`, `project-context.ts`, `server.ts` |
| Projection/UI | `server.ts`, `src/server/ws/protocol.ts`, `src/app/project-import-decisions.ts`, `src/app/dialogs.ts`, new `ProjectImportDecisionRenderer.ts` |
| Proposal owner | `src/server/proposals/proposal-seed-service.ts`, proposal draft/workspace owner plumbing only |

New focused tests belong in `tests2/` and `tests2/tests-map.json`:

1. `core/project-import-decision-context.test.ts`: canonical containment, symlink escape rejection, deterministic component ids/order, fixed language vocabulary, all size/entry caps, and no recursive/content scan.
2. `core/project-import-decision-coordinator.test.ts`: active/granted filtering, dual grant fence, malformed/timeout isolation, project-only scope, logical-delivery budgets, immutable run/context, request dedupe, and replay after each durable boundary.
3. Extend `core/decision-request-store.test.ts` and `core/decision-request-manager.test.ts`: v1 session-record migration, import delivery terminal race/default/consent semantics, exact project memory isolation, continuation retry, and failed atomic writes.
4. `integration/project-import-decisions.test.ts`: real `POST /api/projects` creates one run after component persistence; retry/upsert/restart do not re-ask; project GET/POST routes reject cross-project answers; headless deferrable default vs consent deny; advisory does not wake staff; proposal effect remains a draft; no session/prompt is created.
5. `dom/project-import-decision-renderer.test.ts` and `browser/e2e/project-import-decision.spec.ts`: project registration shows the existing choice/Other behavior, reload preserves a pending card, answer is idempotent, no ask endpoint/transcript/agent wake occurs, and assistant handoff starts only after pending import decisions are cleared.

## Exclusions

This slice does not implement Code Intelligence consumers, deep language/framework analysis, a recursive scanner, new extension capabilities or grants, settings/Marketplace work, direct configuration application, a new question/inbox system, project/session auto-creation, service/sandbox changes, or migration/replay for projects registered before the marker exists.
