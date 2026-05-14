# Bobbit - Internals Reference

Deep-dive documentation for subsystems. Agents: read this when working in the relevant area, not on every task.

## Multi-project architecture

A single Bobbit server manages N registered projects, each with its own `.bobbit/` directory, config, state, sessions, and goals. This enables teams to work across multiple codebases from one browser instance.

### Why multi-project?

Without multi-project support, running multiple Bobbit instances (one per project) means separate browser tabs, separate auth tokens, and no cross-project search. Multi-project lets a single server manage everything - sessions and goals are scoped per project, config cascades from global to project, and search works across all projects by default.

### Project Registry

`ProjectRegistry` (`project-registry.ts`) persists registered projects to `<server-cwd>/.bobbit/state/projects.json`. Each project is a `RegisteredProject`:

```typescript
interface RegisteredProject {
  id: string;        // UUID
  name: string;      // Display name (e.g. "my-api")
  rootPath: string;  // Absolute path to project directory
  createdAt: number; // Epoch ms
  color?: string;    // Optional accent color for sidebar grouping
}
```

Key behaviors:
- **No default project.** Bobbit has no "default" project concept. On startup, the registry loads `projects.json` as-is - whatever is on disk, including zero projects. A fresh install is a valid state: the sidebar shows an Add Project CTA, and the toolbar **+ New Goal** button is disabled with tooltip "Add a project first" until at least one project is registered. Bobbit never implicitly registers a project based on the server CWD. `ProjectRegistry.ensureDefaultProject()` has been removed.
- `register()` validates `rootPath` is absolute and exists on disk, checks for duplicate paths, and scaffolds `.bobbit/config/` and `.bobbit/state/` in the project directory if needed. `POST /api/projects` supports `upsert: true` - if a project already exists at the same `rootPath`, the existing project is returned (200) instead of a 400 error. This makes project registration idempotent.
- `remove()` only unregisters - it does not delete files.
- **Removal:** `DELETE /api/projects/:id` always succeeds for non-hidden projects — there is no last-project guard, and there is no carve-out for a "first" or "CWD" project. When the last visible project is removed, the UI falls back to the existing zero-project first-run state. The hidden "system" project is unaffected by this flow.
- The per-project settings page General tab exposes a "Remove Project" button in a Danger Zone section for every registered project. On confirmation, it calls `DELETE /api/projects/:id`, which invokes `remove()` and navigates the user back to system settings.
- Persistence is atomic (write to `.tmp` then rename).

### Symlinked project rootPath handling

<a id="symlinked-project-rootpath-handling"></a>

When a user registers a project whose `rootPath` is a Linux/macOS symlink (or a Windows directory junction), worktree creation, `.bobbit/state` scaffolding, and path-containment checks risk operating against both the symlink and its target inconsistently — the historical failure mode was state corruption and 400s on goal creation when an agent's `cwd` reached the server through the canonical path while the project was registered under the symlink path (or vice versa).

**Registration contract.** `detectSymlinkRoot(rootPath)` in `src/server/agent/project-registry.ts` returns `{ canonical }` whenever `realpathSync(rootPath) !== rootPath`. `ProjectRegistry.register(input, opts?)` accepts `acceptCanonical?: boolean`; when `detectSymlinkRoot` reports a mismatch and the caller has not opted in, `register()` throws `SymlinkProjectRootError` carrying both paths. `POST /api/projects` translates this throw into a 400 with envelope `{ error, code: "symlink_root", rootPath, canonical }`. The UI add-project dialog catches the matching `SymlinkRootError` (exported from `src/app/api.ts`), prompts the user *"`<rootPath>` is a symlink to `<canonical>`. Bobbit will register the canonical path to avoid worktree corruption. Continue?"*, and on accept re-submits with `acceptCanonical: true`.

`registerProvisional()` and `registerSystemProject()` pass `acceptCanonical: true` silently — they are assistant-internal callsites with no user-facing prompt, and the synthetic system project is anchored at a path Bobbit controls so a symlink there would be a config error worth resolving silently. The provisional path is similarly an internal staging step; rejecting it would surface as an opaque assistant failure rather than the actionable user prompt the API form provides.

**Lookup canonicalisation.** `findByCwd()` canonicalises both the registered `rootPath` and the incoming `cwd` through `realpathSync` (with a try/catch fallback to the textual path on EPERM/ENOENT — Windows raises EPERM on some junctions) before the prefix comparison. This is what closes the "400 on goal creation" bug class even for projects already registered under a symlinked path, because the comparison is post-canonicalisation on both sides.

`getByPath()` is intentionally **not** canonicalised. It serves a different role — it's the duplicate-path guard at registration time, answering "is there already a project registered at exactly this `rootPath` string?" Canonicalising both sides would let `register()` silently fold a symlinked re-registration onto the existing canonical entry, masking what the user thinks they did. The symlink check happens first via `detectSymlinkRoot`; `getByPath()` runs against the already-canonicalised path the caller resolved to.

**Migration policy.** Existing projects registered with a symlinked `rootPath` before this guard landed are **not migrated** — there is no startup sweep. They continue to work because `findByCwd` canonicalisation handles the runtime mismatch. Only new registrations are guarded. Migrating in place would require regenerating worktrees and state-dir paths, which is risky against running sessions and would surprise users; the runtime fix is sufficient.

### Synthetic system project

A hidden, synthetic project with id `system` is registered at server startup by `projectRegistry.registerSystemProject(<bobbitStateDir>/system-project)` (see `src/server/server.ts` startup hook calling `registerSystemProject()` in `src/server/agent/project-registry.ts`). Idempotent — safe to call repeatedly.

**Purpose.** System-scope tool authoring (editing `defaults/tools/` style configuration that isn't tied to any user project) needs a persistence anchor for its sessions. Without one, the tool-assistant flow would either force the user to register a real project before authoring system-wide tools, or hit `POST /api/sessions` with no resolvable project and 400. The synthetic system project gives those sessions a valid `projectId` (`"system"`) and a real `.bobbit/state/` directory to land in.

**Hidden flag.** `hidden: true` causes `GET /api/projects` to filter the project out, so it never reaches the client's `state.projects`. UI surfaces (sidebar grouping, project pickers, the splash-screen new-session gating) therefore behave as if it doesn't exist. Internal lookups by id still resolve normally; lookups by `rootPath` or `cwd` (`findByPath`, `findByCwd`) skip hidden projects so the install dir cannot accidentally match the system anchor.

**StateDir anchoring rule.** The system project's `rootPath` **must not** be a path whose derived `stateDir` (`<rootPath>/.bobbit/state/`) collides with any user project's `stateDir`. The startup hook anchors it at `<bobbitStateDir>/system-project/` precisely to avoid this: the install dir itself, and any user project rooted at the install dir, would otherwise share `goals.json` / `sessions.json` with the system context. The collision symptom is duplicate goals appearing in both contexts (this is the trap that was hit during qa-seed implementation — see [docs/debugging.md — Multi-project / per-project state](debugging.md#multi-project--per-project-state)).

**Iteration contract: `visible()` vs `all()`.** `ProjectContextManager` exposes two iterators. `all()` returns **every** context including the hidden system project — use this for callers that legitimately need it (`getContextForSession`, `findStoreForStaff`, MCP discovery, system-scope tool authoring resolution). `visible()` skips `hidden: true` contexts — use this for worktree sweepers, worktree-pool init, goal-manager pool-resolver wiring, the `/api/maintenance/orphaned-worktrees` endpoints, and the `/api/sessions` + `/api/goals` listing aggregations that back the UI. The cross-project aggregation methods on the manager (`getAllLiveGoals`, `getAllLiveSessions`, `getAllGoals`, `getAllSessions`, `searchAll`) filter hidden internally for the same reason. Iterating hidden via `all()` for worktree/pool flows was the root cause of `pool/_pool-*` branches being allocated in unrelated host repos when the bobbit state dir was nested inside one (pinned by `tests/system-project-pool-leak.test.ts`).

**Which UI surfaces produce sessions here.** Any server-scope config-editing assistant lands here when no project is selected: the Tools page "New Tool" with scope = System (passes `projectId: "system"` explicitly), and the Roles / Tools pages' "+ New …" buttons when their scope picker is at the server level (post the bare `{ assistantType: "role" | "tool" }` and let the server anchor them). The server side of this is the `isServerScopeAssistant` branch in `POST /api/sessions` (see [rest-api.md — `POST /api/sessions` assistantType carve-outs](rest-api.md#post-apisessions--assistanttype-carve-outs)): when `assistantType ∈ {role, tool}` and no `projectId` is supplied, the handler sets `resolvedProjectId = SYSTEM_PROJECT_ID` and skips `resolveProjectForRequest`. Explicit `projectId` from a project-scoped Roles/Tools page is still honoured. **Staff assistants are not included in this carve-out** — they are project-scoped permanent sessions (see [Staff agents in the sidebar](#staff-agents-in-the-sidebar)) and must resolve a real project the same way `goal` assistants do. Splash-screen "New Session" / "Quick Session" never lands here — those flows are gated on `state.projects.length` and either prompt for project creation, bind to the sole project, or open the splash project picker (`state.splashProjectPickerOpen` in `src/app/render.ts`). The 400 "projectId required" failure mode for those buttons is closed by gating, not by the system project.

### Per-project state isolation

Each registered project is a self-contained unit on disk. State (goals, sessions, tasks, teams, gates, search, costs) lives in `<project-root>/.bobbit/state/`, not in a central directory. The server aggregates across all projects.

```
<project-root>/.bobbit/
  config/          # Project config (roles, tools, etc.)
  state/
    goals.json     # Goals for THIS project
    sessions.json  # Sessions for THIS project
    tasks.json     # Tasks for THIS project's goals
    team-state.json # Team state
    gates.json     # Gate state and signals
    staff.json     # Staff agents
    search.flex/   # Lexical search index for THIS project (FlexSearch JSON)
    costs/         # Cost tracking

<server-cwd>/.bobbit/
  state/
    projects.json     # Global project registry (only truly global state)
    preferences.json  # Global UI preferences
    token             # Auth token
    gateway-url       # Gateway address
    colors.json       # Session colors
```

This means removing a project cleanly removes its state, and pointing a different Bobbit instance at a project directory gives access to its history.

### ProjectContext (scoped stores)

`ProjectContext` (`project-context.ts`) holds a complete set of stores scoped to one project. Every store constructor accepts a directory parameter (`stateDir` or `configDir`) instead of using module-level globals:

- **State stores** (stateDir): GoalStore, SessionStore, GateStore, TaskStore, TeamStore, StaffStore, ColorStore, SearchService, CostTracker
- **Config stores** (configDir): RoleStore, WorkflowStore, ToolManager, ProjectConfigStore, ToolGroupPolicyStore
- **Managers**: GoalManager (wraps GoalStore)

Directories derive from the project's `rootPath`:
- `stateDir` = `<rootPath>/.bobbit/state/`
- `configDir` = `<rootPath>/.bobbit/config/`

`ProjectContext.open()` initializes the search index and wires mutation hooks so goal/session changes are automatically indexed. `ProjectContext.close()` flushes the session store and closes the search index.

### ProjectContextManager

`ProjectContextManager` (`project-context-manager.ts`) is the central registry of `ProjectContext` instances. It initializes a context for each registered project on startup and provides aggregation methods for cross-project queries.

Key responsibilities:
- **Lazy creation**: `getOrCreate(projectId)` - creates and opens a context on first access
- **Store routing**: `getContextForGoal(goalId)` / `getContextForSession(sessionId)` - scans all contexts to find the owning project
- **Aggregation**: `getAllLiveGoals()`, `getAllLiveSessions()`, `searchAll()` - merge results across all projects
- **Generation counters**: Sums per-project generation counters so clients detect any change via a single `?since=N` parameter
- **Lifecycle**: `closeAll()` on shutdown, `remove(projectId)` when a project is unregistered

All API endpoints and WebSocket handlers resolve the correct per-project store through `ProjectContextManager` rather than accessing stores directly. Managers (`GoalManager`, `TaskManager`) accept store instances directly - they no longer create stores internally. `StaffManager` accepts `ProjectContextManager` and resolves the correct per-project `StaffStore` on each operation, matching the aggregation pattern used by goals and sessions.

#### Store resolution pattern

Store resolution **never falls back to a default project**. Every operation resolves its store through one of these paths:

1. **Entity-based resolution** - `getContextForGoal(goalId)`, `getContextForSession(sessionId)`: scans all project contexts to find the owning project. Returns `null` if not found; callers throw or return 404.
2. **Explicit projectId** - `getOrCreate(projectId)`: used when the caller already knows the target project (e.g. from a session's `projectId` field).
3. **Explicit-required on creation** - `POST /api/sessions`, `POST /api/goals`, and `POST /api/staff` resolve the target project at the top of the handler via the `resolveProjectForRequest` helper in `src/server/agent/resolve-project.ts`. Resolution order: explicit `body.projectId` → `body.cwd` matching a registered project's `rootPath` → **400 Bad Request**. There is no creation-time default. Once created, the entity's `projectId` is set and all subsequent operations resolve through paths 1 or 2.

`ProjectContextManager` no longer exposes `getDefault()`, `getDefaultOrNull()`, `getDefaultProjectId()`, or `getDefaultProjectIdOrNull()`; `ProjectRegistry` no longer exposes `ensureDefaultProject()`. Any code path that needs a project must either resolve it explicitly (via `resolveProjectForRequest`, an entity lookup, or a threaded `projectId` parameter) or return 400. The only remaining reference to a "first registered project" is in `state-migration.ts`, and it is migration-only - see the block comment on `migrateToPerProjectState()` and the State migration section below.

##### Project selection contract

`POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` share the following 400 contract:

| Condition | Body |
|---|---|
| Neither `projectId` nor `cwd` provided | `{"error":"projectId required: no projectId was provided and cwd (\"\") does not match any registered project"}` |
| `cwd` provided but no registered project has that `rootPath` | `{"error":"projectId required: no projectId was provided and cwd (\"<cwd>\") does not match any registered project"}` |
| `projectId` provided but unknown | `{"error":"Invalid project"}` (pre-existing) |

Callers should always pass an explicit `projectId` when one is available. `cwd`-only resolution exists to support agent tools and external scripts that only know a filesystem path.

`SessionManager` does not hold default store fields (`this.store`, `this.costTracker`, etc.). All store access goes through PCM resolution. `TeamManager`, `StaffManager`, and `VerificationHarness` follow the same pattern - they resolve stores per-goal or per-entity via PCM, with no fallback store references. `resolveStoreForId()` returns `null` instead of falling back, and callers use optional chaining.

**Verification harness project config resolution.** `VerificationHarness` resolves `ProjectConfigStore` per-goal via the private `resolveProjectConfigStore(goalId)` helper (alongside `resolveGateStore` etc.), not the server-level `projectConfigStore` injected at construction. This is what makes `{{project.*}}` substitution (e.g. `typecheck_command`, `test_unit_command`) and the `agent-qa` step's `qa_max_duration_minutes` lookup (now `getQaMaxDurationMinutes(componentName)`) pull from the **goal's owning project** config rather than the server's default. All four call sites - command-type verify steps in `runVerification`, LLM-review retry prompts in `_rerunLlmReviewStep`, agent-QA retry prompts in `_rerunAgentQaStep`, and the QA timeout lookup - go through the helper. If `projectContextManager` is unset (tests, legacy wiring) the helper silently falls back to the injected store; if it is set but the goal is not found in any context, the helper logs a `[verification]` warning and falls back, so the class of bug is diagnosable from logs.

This design prevents a class of data corruption bugs where missing `projectId` values silently route data to the wrong project's store.

**Per-project config directory scoping:** Config directories (for MCP servers, skills, and AGENTS.md/agent files) are resolved per-project. When a session is created for a project, the pipeline resolves that project's `ProjectConfigStore` to discover its custom config directories. This means each project can define its own MCP servers, slash skills, and agent instruction files via `config_directories` in its `project.yaml`, and sessions in that project will use them. MCP discovery additionally scans all registered projects so that MCP servers defined in any project are available to all sessions (with the primary project's configs taking priority on name conflicts).

### State migration

On first startup after upgrading to per-project state, `migrateToPerProjectState()` (`state-migration.ts`) distributes centralized state to per-project directories:

1. Reads central `goals.json`, `sessions.json`, `tasks.json`, `team-state.json`, `gates.json`, `staff.json`
2. Groups records by `projectId` (tasks/teams/gates resolve via their goal's project)
3. Merges into each project's `<rootPath>/.bobbit/state/` (avoids duplicates by ID)
4. Staff agents without a `projectId` are anchored to the migration target project (`projectRegistry.getByPath(serverCwd)` if registered, else `projects[0]`). This is **migration-only** behavior - it runs once, is guarded by `.migrated-to-per-project`, and does not imply a runtime default. The block comment on `migrateToPerProjectState()` explains why this anchor is safe and why it must not be reused elsewhere.
5. Renames central files with `.pre-migration` suffix (not deleted)
6. Writes `.bobbit/state/.migrated-to-per-project` marker to prevent re-running

The migration is idempotent and handles missing files gracefully (fresh installs have nothing to migrate). Any legacy central or per-project `search.db` is deleted on first startup under the new code - FlexSearch indexes rebuild automatically on first access (see [Semantic search](#semantic-search)).

**What stays global**: `projects.json`, auth token, gateway URL, preferences, session colors, PR status.

**Known limitations**: `active-verifications.json` stays in the central state dir (transient operational state).

### Verification architecture

The verification system is split into two modules:
- **`verification-harness.ts`** - orchestration: session lifecycle, WS event broadcasting, process spawning, retry logic, persistence. Also implements the **blocking-tool** contract used by `verification_result`: a tool extension POSTs a verdict, which resolves the Promise registered when the gate signal started verification. See [docs/blocking-tools.md](blocking-tools.md) for the pattern. The `ask_user_choices` tool uses a different, non-blocking shape - see [docs/non-blocking-ask.md](non-blocking-ask.md).
- **`verification-logic.ts`** - pure functions extracted for unit testability: `substituteVars` (template variable resolution), `matchExpectFailure` (expect:failure gate evaluation), `groupStepsByPhase`/`getSortedPhases` (phased execution ordering), `partitionOptionalSteps` (optional step filtering), `buildStepCache`/`canSkipAllSteps` (cache reuse for same-commit re-signals), `isTransientReviewError`/`isTransientQaError` (transient failure detection). These are tested in `tests/verification-logic.test.ts` (~65 tests, <1s) without requiring a running server.

#### Reviewer `kind` & restart resume

Reviewer (and QA) sub-sessions are owned by `VerificationHarness`, but the harness needs them persisted in the team store so a server restart can rebind a running gate signal to the still-alive agent process. `TeamManager.registerReviewerSession()` writes the reviewer's `sessionId` into `entry.agents` for that goal; `unregisterReviewerSession()` removes it on completion.

The persisted-agent shape (`PersistedTeamEntry.agents[]` in `team-store.ts`) carries a `kind: "worker" | "reviewer"` discriminator. Worker entries (regular team agents dispatched via `dispatchToRole`) are nudged on `agent_end` so the team lead learns that a delegate has finished; reviewer entries must never produce that nudge - the verification harness alone interprets reviewer completion. Two enforcement points:

- `resubscribeTeamEvents()` skips agents with `kind === "reviewer"` when re-attaching the `agent_end → notifyTeamLead()` listener after a restart. Pre-fix this listener was attached unconditionally and the live (non-restart) path never noticed because it subscribes only to `tool_execution_end`.
- `notifyTeamLead()` performs the same check before firing, so even a stray subscription cannot deliver a steer.

Back-compat: `team-state.json` entries written before the field existed have `kind === undefined` after load. The harness treats `undefined` as `"worker"` (the safer default for old records, all of which were workers in practice), but the defensive guard in both sites also accepts `role === "reviewer"` as a fallback discriminator. A persisted reviewer entry that was missing `kind` after a cross-version restart still gets correctly skipped.

Key files: `src/server/agent/team-manager.ts`, `src/server/agent/team-store.ts`. Regression test: `tests/team-manager-reviewer-resume.test.ts`.

#### Reminder race after restart-resume

When a server restart interrupts an in-flight reviewer turn, the harness tries to resume from the existing session rather than spawning a fresh one (`_tryResumeFromSession` in `verification-harness.ts`). Resume sends a reminder prompt asking the agent to call `verification_result`, then races the eventual tool call against an idle-detector so a stuck agent eventually fails rather than hanging the gate.

The race uses two `SessionManager` helpers:

- `waitForIdle(sessionId, timeoutMs)` - resolves when the session transitions to `idle` (or **synchronously** if it is already idle). This is the failure-detector edge of the race: "agent went quiet without calling `verification_result`".
- `waitForStreaming(sessionId, timeoutMs = 10_000)` - mirror of `waitForIdle` that resolves on `agent_start` (or rejects on `process_exit` / timeout). This confirms the prompt was actually picked up and a new turn has begun.

Both are needed because, after a restart, the resumed session is in `status === "idle"` at the moment the reminder is dispatched. `rpcClient.prompt()` is fire-and-forget on the RPC channel; the session does not synchronously transition to `streaming`. Without `waitForStreaming`, the `waitForIdle` half of the race resolves immediately on the *current* idle, the harness declares failure, and the `finally` block terminates the session before the agent has read the reminder - the user-visible signature is a reviewer archived within tens of milliseconds of restart, with the error string `"Agent did not call verification_result after server restart and reminder."`

The pattern is now applied at all four reminder sites in `verification-harness.ts`: `_tryResumeFromSession` (the original repro), `runLlmReviewViaSession`, the QA-tester reminder, and the legacy direct-`RpcBridge` reminder. The legacy site has no `SessionManager` injected and so reproduces the shape inline with an `agent_start` listener and the same 10s timeout. A `.catch(() => {})` on every `waitForStreaming` call ensures that an unresponsive agent still falls through to the existing `waitForIdle` race rather than blocking forever - the helper raises the floor without lowering the ceiling.

The live llm-review path is not actually affected by the bug (the kickoff prompt has already pushed the session into `streaming` before any race begins), but it carries the same `waitForStreaming` call for symmetry. Future reminder sites must follow the same pattern.

Key files: `src/server/agent/session-manager.ts` (`waitForStreaming`), `src/server/agent/verification-harness.ts`. Tests: `tests/verification-reminder-race.test.ts` (unit), `tests/e2e/gate-verification-resume.spec.ts` (API E2E that drives a full restart cycle).

#### Atomic step enumeration on `gate_signal`

The `gate_signal` REST handler enumerates the verification step list **synchronously** before recording the signal, so the persisted `signal.verification.steps[]` and the in-memory `activeVerifications` entry agree from the very first state any consumer can observe. Pre-fix the gate-store wrote `steps: []` and the harness populated the entry several `await`s later — a 15-30 s race window on multi-step gates during which the dashboard rendered no progress. Split via `VerificationHarness.beginVerification(signal, gate)` (synchronous enumeration + active-map seed, no WS broadcast) and `getActiveVerification(signalId)` (lookup for ordered broadcast). The handler order is `cancelStaleVerifications` → `beginVerification` → `recordSignal` → `gate_signal_received` → `gate_verification_started` → fire-and-forget `verifyGateSignal`. Full design and the symbol-level map are in [docs/gate-signal-step-enumeration.md](gate-signal-step-enumeration.md); symptom→fix lookup in [debugging.md — Empty `verification.steps[]` after `gate_signal`](debugging.md#empty-verificationsteps-after-gate_signal). Pinned by `tests/gate-signal-step-enumeration.test.ts`, `tests/e2e/gate-signal-progress.spec.ts`, and `tests/e2e/ui/verification-progress-indicator.spec.ts`.

#### Command-step restart survival

Command-type steps (`npm run test:e2e`, type-check, etc.) survive a gateway restart via a detached-spawn + atomic exit-file scheme, with a `bootEpoch`-based correctness floor so a step from a previous gateway lifetime can never falsely lock the gate behind HTTP 409 `Verification already in progress`. Full design and the symbol-level map are in [docs/verification-restart.md](verification-restart.md); symptom→fix lookup in [debugging.md — HTTP 409 after gateway restart](debugging.md#http-409-verification-already-in-progress-after-gateway-restart). Pinned by `tests/verification-harness-restart.test.ts` and `tests/e2e/verification-restart-resignal.spec.ts`.

### Config resolution (3-tier hierarchy)

`ConfigResolver` (`config-resolver.ts`) provides hierarchical config resolution across three tiers:

```
~/.bobbit/         (global)    - lowest priority
<server-cwd>/.bobbit/  (server)    - middle
<project>/.bobbit/     (project)   - highest priority (wins)
```

Two resolution modes:

**Entity resolution** (`resolveEntities`): For named entities (roles, tools, workflows), merge by name across tiers. A project-level entity with the same name fully overrides the server/global version - no field-level merge. Entities that only exist at a higher tier remain available in all projects.

**Scalar resolution** (`resolveScalarConfig`): For `project.yaml` keys (build_command, test_command, default models, etc.), first defined value wins: project → server → global → built-in default. Returns both the resolved value and its source scope.

### Config cascade

The config cascade handles resolution of named config entities (roles, tools, tool group policies) through a three-layer merge. This is separate from `ConfigResolver`'s scalar config resolution above - it resolves entire config objects by name, not individual settings keys.

The global `system-prompt.md` template participates in the same builtin → user-override pattern but via a dedicated path resolver rather than the `ConfigCascade` class. `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts` returns `<bobbitConfigDir()>/system-prompt.md` when present and falls back to the shipped `dist/server/defaults/system-prompt.md`. The file is **not** copied to `.bobbit/config/` on startup; users opt into customisation explicitly via the Settings → General → "Customise system prompt" button (which calls `POST /api/system-prompt/customise` to copy the default into place). Existence of `.bobbit/config/system-prompt.md` is itself the customisation signal used by `isSetupComplete()` (in `src/server/setup-status.ts`).

> **Workflows are NOT in the cascade.** Workflows live exclusively inline in each registered project's `project.yaml::workflows` block - there is no system-scope or builtin workflow layer. `ConfigCascade.resolveWorkflows(projectId)` reads only the project layer; without a `projectId` it returns `[]`. See [Workflows are project-scoped only](#workflows-are-project-scoped-only) below for the rationale.

#### Why a cascade?

Without it, every project got a full independent copy of all config YAML via scaffolding. Editing the "global" version didn't propagate to existing projects, new Bobbit releases couldn't update defaults, and users couldn't tell which items were stock vs customised. The cascade makes builtins always-current and overrides explicit.

#### Architecture

```
builtin (dist/server/defaults/)  →  server (<server-cwd>/.bobbit/config/)  →  project (<project>/.bobbit/config/)
       lowest priority                                                              highest priority
```

Two modules implement this:

- **`BuiltinConfigProvider`** (`builtin-config.ts`): Reads factory defaults from `dist/server/defaults/` at runtime. These are the same files copied by `scripts/copy-defaults.mjs` at build time. Read-only, lazy-loaded with caching (`reload()` clears the cache). Mirrors the YAML parsing logic of each store (RoleStore, etc.).

- **`ConfigCascade`** (`config-cascade.ts`): Merges the three layers. Constructor takes a `BuiltinConfigProvider`, explicit `ServerStores` accessors, and `ProjectContextManager`. Provides `resolveRoles()`, `resolveTools()`, and `resolveToolGroupPolicies()` - all accepting an optional `projectId`. `resolveWorkflows()` exists for shape compat but only reads the project layer (see callout above).

Each returned item is a `ResolvedItem<T>` with:
- `item: T` - the config object
- `origin: "builtin" | "server" | "project"` - which layer provided this item
- `overrides?: ConfigOrigin` - which lower layer this item shadows, if any

#### Resolution rules

For each cascaded config type (roles, tools, tool-group-policies), items are merged by a unique key (roles by `name`, tools by `name`). Later layers shadow earlier ones entirely - no field-level merge. Without `projectId`, returns system scope (builtins + server stores at `<server-cwd>/.bobbit/config/`). With `projectId`, the project layer is added on top.

Workflows are not cascaded - `resolveWorkflows(projectId)` reads only the project's inline `workflows:` block. Hidden workflows (e.g. `test-fast`) are filtered out by the resolver. Without `projectId` it returns `[]`.

**System-scope writes** (role customize + override endpoints with `scope=server` or no scope) route to the standalone server stores constructed at module top in `src/server/server.ts` (`roleStore`, `toolManager`), which are backed by `<server-cwd>/.bobbit/config/`. They are **never** written into any project's store. Zero-project installs can still customize system-scope roles because the server stores are independent of `ProjectContextManager`. Workflow mutations have no system-scope path - they always require a `projectId`.

#### Workflows are project-scoped only

Workflows are inlined per-project (in `project.yaml::workflows`) rather than cascaded because (a) every workflow step references project-specific `(component, command)` pairs that have no meaning outside the owning project, and (b) the project assistant generates a bespoke workflow set per project from [defaults/workflow-authoring-guide.md](../defaults/workflow-authoring-guide.md) - there is no useful "system default workflow" to inherit. A cascade would just be ceremony around an empty upper layer.

Consequences:

- `BuiltinConfigProvider.getWorkflows()` returns `[]` (kept only for `ServerStores` shape compat).
- No system-scope `WorkflowStore` or `WorkflowManager` is instantiated at server boot. `<server-cwd>/.bobbit/config/project.yaml::workflows` is **not** read at runtime.
- All `/api/workflows*` mutations require a `projectId` (400 otherwise - no `?scope=server` parameter).
- `GET /api/workflows` (no `projectId`) returns `{ workflows: [] }`; `GET /api/workflows/:id` (no `projectId`) returns 404. Reads are intentionally lenient (don't 400) to keep the Workflows page from crashing during scope transitions.
- New projects do **not** receive any default seed at `POST /api/projects` time - a `propose_project` call that omits `workflows` results in a project with zero workflows. The project assistant is solely responsible for designing the workflow set from the discovered components and commands. See [No default workflow scaffold](#no-default-workflow-scaffold). Legacy `<project>/.bobbit/config/workflows/*.yaml` files are still folded into the inline block on first boot by `migrate-project-yaml.ts` and the directory is removed.

#### No default workflow scaffold

Workflows must be a deliberate, project-specific design done by the project assistant. The server has **no fallback** - there is no path that silently seeds a canonical workflow set into a project. The previous fallback produced generic gates targeting a synthetic default component - gates that didn't match the project's real commands and which the assistant would have to redesign anyway, so the fallback hid rather than helped the design step. A project may legitimately persist with zero workflows; goal creation against such a project surfaces whatever existing flow shows for missing workflows (no silent backfill, no error banner from this layer).

**Removed seed sites** (all three previously seeded `general` / `feature` / `bug-fix` / `quick-fix` targeting a synthetic default component):

- `src/server/server.ts` after `POST /api/projects` when the proposal omitted `workflows`.
- `src/server/state-migration/migrate-project-yaml.ts::migrateProjectYaml` during the v1→v2 migration.
- `src/server/state-migration/migrate-project-yaml.ts::maybeSeedWorkflowsOnly` secondary pass; now a no-op for v2 projects with no workflows dir and no inline workflows. (The function still inlines a legacy `workflows/` dir on first boot - that path is unaffected.)

**`buildDefaultWorkflows`** (in `src/server/state-migration/seed-default-workflows.ts`) was kept but is **internal-only**. The only caller is `per-component-workflows.ts::buildPerComponentWorkflow`, which clones the `feature` shape and rewrites step refs to point at a specific component. No callsite invokes `buildDefaultWorkflows` as a fallback.

**Project assistant prompt** (`src/server/agent/project-assistant.ts`) carries a "Workflows are your responsibility" statement in both `PROJECT_ASSISTANT_PROMPT` and `PROJECT_ASSISTANT_SCAFFOLDING_PROMPT`. The G2 workflow-suggestion checklist no longer pre-checks generic options by component count - the assistant must justify every workflow it proposes against the project's actual components and commands. Per-component / all-components scaffolds (`buildPerComponentWorkflow`, `buildAllComponentsWorkflow`) remain available as adaptable starting points the assistant chooses explicitly.

**Tests:** `tests/e2e/projects-no-default-workflows.spec.ts` covers (a) `POST /api/projects` without `workflows` persists with no `workflows:` block, (b) supplied `workflows` is kept verbatim with no defaults merged in, (c) zero-workflows projects don't gain workflows from downstream side-effects. The migration test suite (`tests/migrate-project-yaml.test.ts`) asserts no seeding occurs in either migration path.

#### Server stores decoupling

`ConfigCascade` accepts explicit `ServerStores` accessors rather than reading from any project's stores. The standalone stores in `server.ts` are backed by `<server-cwd>/.bobbit/config/` (or `$BOBBIT_DIR/.bobbit/config/` in E2E tests). Using explicit accessors ensures PUT and GET use the same underlying stores and decouples the server layer from whether any project is registered.

#### Builtin seeding

On server startup, standalone stores (`roleStore`) are seeded with builtins that aren't already present. This ensures that code paths reading from standalone stores work even when scaffolding no longer copies these files. Tools are excluded from seeding because they're still copied by scaffolding. Workflows are not seeded at server scope at all, and (since the **No default workflow scaffold** change) they're no longer seeded at project-create time either - the project assistant designs them. See [No default workflow scaffold](#no-default-workflow-scaffold).

#### Scaffolding

`scaffoldBobbitDir()` creates an empty `config/roles/` directory. Roles resolve at runtime via the cascade - no files are copied. Workflows are not scaffolded as a directory because they live inline in `project.yaml::workflows`. Tools are still copied from defaults because they contain provider configs and `extension.ts` code that `updateToolMetadata()` modifies in-place. `system-prompt.md` is **no longer** copied or scaffolded - it resolves at runtime via `resolveSystemPromptPath()` (see [Config cascade](#config-cascade)) and is created on disk only when the user clicks "Customise system prompt" in Settings (`POST /api/system-prompt/customise`). The shipped `defaults/docs/` tree is similarly never copied or overwritten; consumers (e.g. the `/mockup` skill) read from `defaults/docs/` directly.

#### Session setup integration

The session setup pipeline (`session-setup.ts`) resolves roles and tools through `ConfigCascade` when a `plan.projectId` is available. A `lookupRole()` helper in the pipeline prefers cascade-resolved roles, falling back to the standalone store. This ensures sessions see the full three-layer resolution even when project config dirs are empty.

#### REST API

Config list endpoints accept `?projectId=` for project-scoped resolution:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/roles?projectId=X` | Resolved roles with `origin` and `overrides` fields |
| `GET` | `/api/workflows?projectId=X` | Project workflows (returns `[]` without `projectId`) |
| `GET` | `/api/tools?projectId=X` | Resolved tools |
| `POST` | `/api/roles/:name/customize?scope=project&projectId=X` | Copy resolved item to target scope for editing |
| `DELETE` | `/api/roles/:name/override?scope=project&projectId=X` | Remove override, revert to inherited |

The customize/override endpoints follow the same pattern for roles. Workflow CRUD endpoints (`POST`, `PUT`, `DELETE /api/workflows[/:id]`) **require** `projectId` (400 otherwise) - there is no system-scope path for workflows.

#### UI

The Roles, Tools, and Skills config pages display a project scope row (System + per-project tabs) when multiple projects are registered. Items show origin badges (grey=builtin, blue=server, green=project). In project scope, inherited items (origin != "project") appear at 70% opacity. Customize/revert buttons manage overrides. Shared UI helpers live in `config-scope.ts` and `config-scope.css`; the row accepts an optional `excludeSystem` flag.

The Workflows page is a special case - it has **no System tab** because workflows are project-scoped only. The page passes `excludeSystem: true` to the scope row, and visiting `/workflows` while the global scope is `system` auto-switches to the first registered project (or shows an empty state if none).

### Project assistant

The project assistant guides users through registering a new project directory. It operates in two modes, selected automatically by the smart Add Project flow based on directory detection (`POST /api/projects/detect`):

**Detection mode** (assistant type `"project"`): For directories with existing content but no `.bobbit/config/project.yaml` (the on-disk marker of a configured Bobbit project). The server creates a provisional project for the target directory and assigns the session to it. When the session connects, an auto-prompt is sent containing the directory path (e.g., "Start the project registration session. The project directory is: /path/to/my-project") - the assistant never needs to ask for it. The path is passed through `connectToSession()` via the `projectDirPath` option. The assistant explores the directory (package.json, build files, git config, CI config, README) and calls the `propose_project` tool with discovered settings: name, root_path, build_command, test_command, typecheck_command, test_unit_command, test_e2e_command, and worktree_setup_command. Because proposals are tool calls, they persist in message history and remain accessible on reconnect via the "Open proposal" button.

**Scaffolding mode** (assistant type `"project-scaffolding"`): For empty or non-existent directories. Like detection mode, a provisional project is created and the session is assigned to it. An auto-prompt is sent with the target directory path (e.g., "Start the new project setup session. The target directory is: /path/to/my-project"). The assistant acknowledges the directory, asks what the project is about, suggests tech stacks, and helps scaffold the project structure (directory layout, basic files, README). After the user accepts the proposal, the assistant uses bash/write tools to create the project files, then calls `propose_project` with the same settings.

**Provisional projects**: When a project assistant session is created (Path B or C), the server registers a **provisional project** via `ProjectRegistry.registerProvisional(name, rootPath)` with `provisional: true`. The assistant session is assigned to this provisional project's real `projectId` - so it has proper project isolation from the start, with its own store directory. The sidebar renders provisional projects as normal project folders but with a "(setting up)" badge, and suppresses action buttons (Add Goal, Add Staff, etc.) while the project remains provisional. Because this is server-side state, it survives page refreshes - unlike the previous `state.pendingProjects` client-side approach. If the session is terminated without accepting a proposal, the provisional project is cleaned up via `DELETE /api/projects/:id`.

When the agent calls `propose_project`, the client populates `state.activeProposals["project"]` and shows a **preview form** in the right panel (similar to goal proposals) with editable fields: project name, build/test/typecheck commands, and worktree setup command. The user reviews and clicks "Accept" - only then does the client promote the provisional project via `POST /api/projects/:id/promote` (which clears the `provisional` flag and updates the name) and write all config fields to `project.yaml` via `PUT /api/projects/:id/config`. The config write is atomic - all keys are validated before any are written, so a validation failure leaves the existing config unchanged. The client deduplicates proposal acceptance by tracking processed tool_use block IDs in `sessionStorage`, preventing re-fires on message re-scan (reconnect, refresh). This ensures goal workflows can run effectively with build, test, and type-check commands configured from the start.

**Auto-import path**: If `POST /api/projects/detect` reports `hasBobbit: true` — defined as `<path>/.bobbit/config/project.yaml` existing — the UI skips the assistant entirely and registers the project immediately with the auto-detected name (from `package.json` or directory basename). Existing `.bobbit/config/` settings are preserved as-is.

The marker is `.bobbit/config/project.yaml` rather than the mere presence of a `.bobbit/` directory entry. This matters because `.bobbit/` is routinely re-scaffolded with empty `config/` and `state/` subdirectories after the preflight archive flow (and may exist as a ghost from half-extracted archives, crashed installs, or manually-created stubs). Keying detection to the config file aligns with the project assistant's own EDIT-vs-NEW-mode discriminator (`src/server/agent/project-assistant.ts`) and with `ProjectConfigStore.configFile` (`src/server/agent/project-config-store.ts`) — three call sites agreeing on a single source of truth. The preflight `bobbit.existing` check answers a different question ("is there content to archive?") and is intentionally separate; see [add-project-preflight.md](add-project-preflight.md).

**Directory browsing**: The smart Add Project dialog includes a Browse button backed by `GET /api/browse-directory?path=<base>`. This endpoint returns directory-only listings (skips files, hidden dirs, `node_modules`, and symlinks). Defaults to the server's CWD when no path is provided.

**Pre-flight validation**: Before submit is enabled, the dialog runs a structured pass/warn/fail pre-flight against the candidate `rootPath` via `GET /api/projects/preflight`, and surfaces an inline "start fresh" archive action when an existing `.bobbit/` is detected. `projectRegistry.register()` re-runs the same checks server-side. See [add-project-preflight.md](add-project-preflight.md) for the check catalogue, the `GATEWAY_OWNED_FILES` allowlist that protects the running gateway from being archived, and the REST surface.

### Per-project config

Each registered project can override system-level settings (from `project.yaml`). This allows different projects to use different build commands, default models, sandbox settings, etc., while inheriting everything they don't explicitly override.

A notable config key is `base_ref` — the branch ref new worktrees branch off, used as upstream and as the `{{baseBranch}}` template variable. Empty/unset preserves today's `resolveRemotePrimary()` behaviour. PUT-time validation rejects tags, SHAs, invalid grammar, non-`origin` prefixes, and (for sandboxed projects) local refs, with a structured `{ field, error, details? }` payload. See [design/base-ref.md](design/base-ref.md).

**Resolution cascade**: For each config key, `resolveScalarConfig()` checks project → server → global → built-in default. The first defined value wins. This reuses the same `config-resolver.ts` infrastructure described in [Config resolution](#config-resolution-3-tier-hierarchy) above.

**Server-side caching**: `ProjectContextManager` lazily instantiates a `ProjectContext` per project via `getOrCreate()`. On startup, `initAll()` pre-creates contexts for all registered projects.

**REST API**:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/config` | Raw project-level overrides (only keys explicitly set) |
| `GET` | `/api/projects/:id/config/defaults` | Built-in defaults for all config keys |
| `PUT` | `/api/projects/:id/config` | Set/clear project-level overrides. Empty string or `null` clears an override. |
| `GET` | `/api/projects/:id/config/resolved` | Fully resolved values - each key returns `{ value, source }` where source is `"project"`, `"server"`, or `"default"` |

**Settings UI**: The settings page has a two-tier layout. The top scope row selects System or a specific project. Sub-tabs within each scope show the relevant settings. Per-project tabs show inherited system values as placeholders with an "(inherited)" badge; overrides show normal text with a "×" reset button. URL scheme: `#/settings/<scope>/<tab>` where scope is `system` or a project UUID (backwards-compatible: `#/settings/shortcuts` maps to `#/settings/system/shortcuts`).

**Per-component editors**: The project Settings tab renders one card per component with editable `commands` and `config` key-value tables (sibling editors with the same shape - add/delete row controls, key/value inputs). Both tables persist via the same `PUT /api/projects/:id/config` payload by sending the `components` array with the edited entry. There are no longer top-level `qa_*` fields on the Settings page - QA settings live exclusively under the relevant component's `config:` map (see [Multi-repo & components](#multi-repo--components)).

**Sidebar shortcut**: Project headers in the sidebar show a gear icon on hover that navigates directly to `#/settings/<project-id>/project`.

**Mid-session project proposals**: Any agent session - regular, goal, staff, or non-project assistant - can call the `propose_project` tool to suggest changes to the current project's config, not just the project-assistant flow. The motivation is that agents often discover a missing test command, a better worktree setup, or a stale model preference while working on a goal; forcing the user into a separate project-assistant session just to accept that fix loses context. When a proposal arrives, the preview panel grows a "Project" tab showing a diff of the proposed fields against the current `project.yaml` (loaded via `GET /api/projects/:id/config`) and registry record. Unchanged fields collapse into a "No changes" group; `root_path` is read-only. The accept handler branches on whether the project is provisional:

- **Provisional** (project-assistant flow, unchanged): promote via `POST /api/projects/:id/promote`, write config via `PUT /api/projects/:id/config`, then terminate the assistant session and navigate to landing.
- **Registered** (new path): `PUT /api/projects/:id/config` for project.yaml fields and `PUT /api/projects/:id` for the project name if it changed. The session stays connected and the agent continues where it left off - no navigation, no termination. The proposal panel switches to a **"Changes Saved"** confirmation view (heading + "Terminate Project Assistant" button) instead of falling back to the empty `"Waiting for project analysis…"` state, so the user gets visible feedback that the apply succeeded and a one-click way to end the still-running assistant. The flag (`state.projectProposalAcceptedBySessionId[sessionId]`) is persisted via the project draft so it survives reload, and is cleared symmetrically wherever `state.activeProposals.project` is cleared (new proposal arrives, session navigated away, terminated). See [design/project-proposal-saved-state.md](design/project-proposal-saved-state.md). The terminate path is shared with the provisional flow via `terminateProjectAssistantSession()` in `src/app/session-manager.ts`.

The generic `PUT /api/projects/:id/config` endpoint is a passthrough KV writer (validates keys contain no dots, clears on empty string / `null`, otherwise writes), so any scalar `project.yaml` field is accepted - `build_command`, `test_command`, `typecheck_command`, `test_unit_command`, `test_e2e_command`, `worktree_setup_command`, `sandbox`, plus project-defined custom keys. The seven legacy top-level QA keys (`qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios`) are **rejected** with 400 and a message pointing at `components[<name>].config[<key>]`. Model preferences (`session_model`, `review_model`, `naming_model`) live outside `project.yaml` in the preferences store and are handled by `propose_setup` rather than `propose_project`. Key modules: `session-manager.ts::acceptProjectProposal` (dispatcher), `render.ts::projectProposalPanel` (diff UI), `state.activeProposals["project"]` (proposal slot with `fields` + `mode` + `currentConfig` snapshot). Full spec: [design/mid-session-project-proposals.md](design/mid-session-project-proposals.md).

### Project-proposal panel structure

The `propose_project` preview panel (`src/app/render.ts::projectProposalPanel`, testid `data-panel="project-proposal"`) is shared by the project assistant and mid-session edit flows. It renders a fixed header (project name + `root_path`), a tab strip, the active tab's body, and a legacy editable-fields block at the bottom. The three tabs all live in `src/app/project-proposal-views.ts`:

| Tab (testid) | Renderer | Purpose |
|---|---|---|
| `view-tab-components` | `projectComponentsView` | One card per component (`component-card-${name}`): `repo`, `relative_path`, `worktree_setup_command`, `commands` chips, plus a per-component `Config` key-value table (`component-config-${name}`) listing entries from `components[*].config` (e.g. `qa_start_command`, `qa_max_duration_minutes`). Data-only components (no `commands` map) are flagged. |
| `view-tab-workflows` | `projectWorkflowsView` | One card per workflow (`workflow-card-${id}`) showing the gate DAG (`gate-node-${gateId}`) and each gate's verify steps with type-coloured badges (`step-badge-${type}` for `command` / `llm-review` / `agent-qa`, plus `expect:failure`). Step refs to `(component, command)` link back to the component card. |
| `view-tab-diff` | `projectDiffView` | When a previous proposal exists in the same session, shows added/changed/removed components and gates rather than raw YAML field diffs. Component diffs include per-key adds/removes/changes for `commands` and `config` (e.g. `+ web.config.qa_start_command`, `~ web.config.qa_max_scenarios: "3" → "5"`). |

The legacy field block at the bottom keeps the original editable-input rows (`name`, plus changed-vs-unchanged partition for `build_command` / `test_command` / etc.) for the small project-level scalar fields the diff views don't surface. `root_path` is read-only.

**Live-update guarantee.** Across repeated `propose_project` calls in one session, the panel must always reflect the latest payload. The mechanism is a shallow-merge in `session-manager.ts::onProjectProposal`: incoming flat fields win, but `components` and `workflows` carry over from the prior proposal when the new payload omits them (a streaming partial may not include both). The shallow-merge also runs **per component** - entries are matched by `name` and missing `commands` / `config` on the incoming entry are carried over from the prev entry, so a partial re-emit (e.g. updating only `commands` on `web`) does not clobber the previous `config` map on the same component. The render path treats `components`/`workflows` as structured side-tables, never as legacy `Input` rows - `onFieldInput` early-returns for those two keys to prevent a stray keystroke from clobbering the structured value (Bug B), and the proposal tool's serialisation never JSON-stringifies them onto the flat field map (Bug A). The shallow-merge is Bug C's fix.

**Workflow-suggestion checklist (G2).** After the assistant has settled on the components, the project-assistant prompt instructs it to present a single `ask_user_choices` multi-select of workflows it has designed for this specific project. **No options are pre-checked by component count or by canonical name** - the assistant must justify each suggestion against the discovered components and commands. The per-component and all-components scaffolds (`buildPerComponentWorkflow(componentName, allComponents)` and `buildAllComponentsWorkflow(components)` in `src/server/state-migration/per-component-workflows.ts`) are offered as adaptable starting points the assistant chooses explicitly when they fit; they reuse the canonical helpers and prompt strings (`readyToMergeGate()`, `DESIGN_REVIEW_PROMPT`, `GAP_ANALYSIS_DESIGN_PROMPT`, `GAP_ANALYSIS_IMPL_PROMPT`, `CODE_REVIEW_PROMPT`, `DOC_PROMPT`, `RALPH_LOOP_DESCRIPTION`) exported from `seed-default-workflows.ts` so gate semantics stay in one place. `buildDefaultWorkflows()` itself is internal to that module - no caller invokes it as a fallback. See [No default workflow scaffold](#no-default-workflow-scaffold).

**Ralph-loop framing.** The `implementation` gate's `verify` list is the agent's loop body: failures circle back to the implementing agent, which fixes and re-signals until verification passes. The `description` field on `implementation` gates produced by the canonical helpers carries `RALPH_LOOP_DESCRIPTION` so the gate cards in both the proposal panel and the goal dashboard remind reviewers it's a loop, not a checkpoint. The `general`, `feature`, and per-component templates in the authoring guide include gap-analysis steps at design-time (in `design-doc`) AND post-implementation (`implementation` phase 2) to bracket the loop - design-time catches missing requirements before iteration burn, post-impl catches drift between design and code. `quick-fix` skips both. Full authoring rules and worked examples live in [`defaults/workflow-authoring-guide.md`](../defaults/workflow-authoring-guide.md) §3.1 / §6.

**Monorepo subproject scan.** `src/server/agent/monorepo-scan.ts` detects workspace manifests at the candidate root path and expands their globs (one level deep) into a list of subprojects. Recognised manifests: `pnpm-workspace.yaml`, `package.json` `workspaces`, `nx.json`, `turbo.json`, `lerna.json`, `Cargo.toml` `[workspace]`, `go.work`, Gradle `settings.gradle[.kts]` `include(...)`. Output is capped at `MAX_CANDIDATES = 30` with an alphabetical truncation marker; pure detection - no network, no shell. The scan result is added to `POST /api/projects/scan` and consumed by the project-assistant prompt, which is instructed to emit one component per workspace package with `repo: "."` + distinct `relative_path` values (see authoring guide §2 "Monorepo subprojects").

**Assistant prompt construction.** `PROJECT_ASSISTANT_PROMPT` and `PROJECT_ASSISTANT_SCAFFOLDING_PROMPT` in `src/server/agent/project-assistant.ts` inline `defaults/workflow-authoring-guide.md` via `readFileSync` at module init, so prompt updates flow through automatically when the guide is edited. Workflow-design content is roughly half of what the assistant does, so the guide is in-context, not referenced.

### Native-YAML project.yaml fields

Two fields in `project.yaml` are stored as native YAML structures rather than JSON-encoded strings:

| Field | Shape |
|---|---|
| `config_directories` | `{ path: string; types: string[] }[]` |
| `sandbox_tokens` | `{ key: string; enabled: boolean }[]` (the secret `value` is split into `SecretsStore` on PUT - unchanged) |

(`qa_env`, `qa_max_duration_minutes`, and `qa_max_scenarios` used to live here too - they have moved into per-component `config:` maps, see [Multi-repo & components](#multi-repo--components).)

The motivation is editability and diff-friendliness: hand-editing a JSON-string-inside-YAML field is painful and produces noisy diffs in `propose_project` previews and PRs.

**Lazy-migration loader.** `ProjectConfigStore` accepts both the native shape and the legacy form (JSON-string for the array/map fields, quoted numeric strings for the two numeric fields). Legacy values are parsed transparently into structured side-tables; malformed legacy strings log a warning and fall back to the default. The store sets `isDirty()` on legacy load so the next save rewrites the file in native form - no separate migration step.

**Typed accessors.** Consumers read these fields via `ProjectConfigStore.getConfigDirectories()` and `getSandboxTokens()`, never by parsing the raw scalar. This keeps the legacy-vs-native distinction confined to the store. QA budgets and the start/health/browser-entry strings live on `Component.config: Record<string, string>` and are read via `getComponentConfig(name)`, `getQaMaxDurationMinutes(componentName)`, and `isQaConfiguredOnAnyComponent()`.

**Wire format is structured end-to-end.** `GET /api/projects/:id/config` returns these fields as structured types. `PUT /api/projects/:id/config` (and the server-level `PUT /api/project-config`) rejects legacy JSON-string payloads for these two keys with 400 - the settings UI, `propose_project`, and `acceptProjectProposal` all send structured types. This prevents silent regression back to the JSON-string form. The same endpoints reject the seven legacy top-level QA keys (`qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios`) with a migration message pointing at `components[<name>].config[<key>]`.

### Per-project palette

Projects can optionally be assigned one of the 10 built-in color palettes (`forest`, `ocean`, `dusk`, `ember`, `rose`, `slate`, `sand`, `teal`, `copper`, `mono`). This lets you visually distinguish projects - when you navigate to a session or goal belonging to a project with a palette, the entire UI switches to that palette.

**Data model** (`RegisteredProject` in `project-registry.ts`):

| Field | Type | Description |
|---|---|---|
| `palette` | `string \| undefined` | One of the 10 palette IDs, or undefined for no palette (use global default) |
| `colorLight` | `string` | Project accent color for light mode (always present, defaulted on creation) |
| `colorDark` | `string` | Project accent color for dark mode (always present, defaulted on creation) |

The deprecated `color` field is migrated on load: its value is copied to both `colorLight` and `colorDark`. Projects with no color get muted defaults from `DEFAULT_PROJECT_COLOR_LIGHT/DARK`.

**Auto-seeding**: When a palette is set via the REST API without explicit `colorLight`/`colorDark` values in the same request, the colors are seeded from the palette's primary color values. The constant map `PALETTE_PRIMARY_COLORS` in `src/shared/palette-colors.ts` maps each palette ID to its light and dark primary colors (extracted from the CSS `--primary` variable values).

**REST API**: `POST /api/projects` and `PUT /api/projects/:id` accept `palette`, `colorLight`, `colorDark` fields alongside existing project fields.

**Palette switching (UI)**: Applied via the `data-palette` attribute on `<html>`, the same mechanism as the global palette picker. On session/goal navigation, the UI resolves `activeSession → projectId → project.palette`. If a palette exists, it is applied; otherwise the global default from user preferences is restored. The switch is handled alongside session connection logic so the entire UI - sidebar, content area, headers - shifts palette together. In `connectToSession()`, the palette is applied twice: once immediately (using the session data already in `gatewaySessions`) and again after `refreshSessions()` completes. The second apply handles sessions (e.g. recently-spawned reviewer agents) that weren't yet in `gatewaySessions` at initial connect time - without it, `applyProjectPalette(undefined)` reverts to the global palette.

**Sidebar accent colors**: Project header folder icons and names use `colorLight` in light mode and `colorDark` in dark mode, selected reactively based on the current theme.

**Settings UI**: The per-project settings scope includes an "Appearance" tab (first tab) with:
1. A palette picker reusing the same palette preview cards from the global Color Palette tab, plus a "None (use global)" option.
2. Two color inputs side by side for light and dark mode accent colors, pre-filled from the palette seed or existing values.

Selecting a palette seeds the color fields from `PALETTE_PRIMARY_COLORS`; the user can then override colors independently.

### Session & goal scoping

- `PersistedSession` and `PersistedGoal` carry an optional `projectId` field.
- Session/goal list APIs accept `?projectId=` query parameter for filtering.
- Worktrees for goals are created relative to the project's `rootPath`, not the server CWD.
- Session CWD defaults to the project's `rootPath`.

### Multi-repo & components

A project can contain one or more **components** (apps, libraries, services, docs, infra) that each point at a single repo (or sub-path within one). The component is the unit that gets a worktree and that workflow steps reference for `(component, command)` lookups. Single-repo projects keep working unchanged - they simply have one component whose `repo: "."`. Full design: [design/multi-repo-components.md](design/multi-repo-components.md).

**Why this shape.** The earlier model special-cased command keys at the top level of `project.yaml` (`build_command`, `test_command`, ...) and assumed a single repo at `rootPath`. That made multi-repo and monorepo projects awkward and forced workflow steps to interpolate literal shell strings. Promoting components to first-class lets the runtime hold a single uniform collection (`components: []`), and lets workflow steps resolve a `(component, command)` pair structurally so renaming a command updates every workflow that uses it.

**Project model.**

```yaml
name: myapp
rootPath: /home/me/w/myapp
worktree_root: /home/me/wt    # optional override
sandbox: docker               # project-level
config_directories: [...]       # project-level

components:                   # the only collection in project.yaml
  - name: myapp               # default component is named after the project
    repo: "."                 # "." for single-repo; subfolder name for multi-repo
    relative_path: ""         # optional sub-path within the repo (monorepos)
    worktree_setup_command: npm ci --prefer-offline
    commands:                 # opaque flat map - no fixed schema
      build: npm run build
      check: npm run check
      unit:  npx playwright test ...
      e2e:   npx playwright test ...
    config:                   # opaque key→string map; consumed by skills like /qa-test
      qa_start_command:        "PORT=$PORT NODE_ENV=test node dist/server.js"
      qa_health_check:         "http://127.0.0.1:$PORT/api/health"
      qa_browser_entry:        "http://127.0.0.1:$PORT/?token=$TOKEN"
      qa_max_duration_minutes: "10"
      qa_max_scenarios:        "5"

workflows:                    # inline; replaces .bobbit/config/workflows/*.yaml
  general: { name: General, gates: [...] }
  feature: { ... }
```

- `components: []` is the only collection. There is no separate `repos:` field - the set of distinct `repo:` values across components determines worktree planning.
- Mode is **inferred**, not declared: any `component.repo !== "."` makes the project multi-repo. In multi-repo mode, `rootPath` is a container directory holding sibling git repos; in single-repo mode, `rootPath` is the repo itself.
- The default component's `name` matches the project's `name` (e.g. `bobbit` → `components[0].name == "bobbit"`). This keeps gate output, branch names, and UI labels meaningful from day one. `migrate-project-yaml.ts` enforces this on first boot for legacy single-repo projects.
- `commands` is an **opaque `{ name: shell }` map** with no fixed schema. The project assistant tends to use names like `build`/`test`/`check`/`e2e`/`lint` because those are the typical gate verb categories, but any name is allowed (`migrate`, `seed`, `bench`, `gen-types`, ...).
- `config` is a sibling **opaque `{ name: string }` map** on each component (max 100 entries; values are strict strings - numeric budgets are stringified). It carries arbitrary skill-consumed settings; the `/qa-test` skill reads `qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_max_duration_minutes`, and `qa_max_scenarios` from here. The `agent-qa` workflow step's `component:` field selects which component's `config` map is read at run time. Inline env vars directly into `qa_start_command` (e.g. `PORT=$PORT NODE_ENV=test npm start`) - there is no separate `qa_env` field; the server never spread `qa_env` into a child env, it was only ever inlined by agents at author time.

**Component schema** (`Component` in `project-config-store.ts`):

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique within the project. Default component named after project. |
| `repo` | yes | `"."` for single-repo; subfolder of `rootPath` for multi-repo. |
| `relative_path` | no | Sub-path within the repo. Default `""` (component at repo root). |
| `worktree_setup_command` | no | Per-component runtime hook (see below). |
| `commands` | no | Flat `{name: shell}` map. **Absent ⇒ data-only component.** |
| `config` | no | Opaque flat `{key: string}` map (max 100 entries). Consumed by skills like `/qa-test` (which reads `qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_max_duration_minutes`, `qa_max_scenarios`). Numeric budgets are stringified. |

**Data-only components** (a component with no `commands`) declare a repo as part of the project so it gets provisioned on every goal/session worktree set, even though it contributes no workflow steps. Use cases:

- An e2e harness that needs sibling repos (`api/`, `web/`, `shared/`) checked out at the same revision. The harness component owns the commands and shells into siblings via relative paths; the siblings can be data-only.
- Vendor data / fixtures repos pulled in for tests but never built or tested.
- Cross-repo build artifacts assembled from multiple repos.

The **multi-repo invariant** - every configured repo is checked out as a sibling worktree on the same branch (see [Session worktrees](#session-worktrees)) - is the contract that makes data-only components work. There is no special schema for cross-repo dependencies; a multi-repo-spanning component just owns the commands and uses relative paths.

| | has `commands` | no `commands` |
|---|---|---|
| **unique repo** | normal component (api, web) | data-only repo declaration (shared-fixtures, vendor data) |
| **shared repo (relative_path set)** | monorepo subdir (packages/api) | rare - usually a no-op |

**Workflow step references - structural, not literal shell.** Workflows live inline in `project.yaml::workflows` (no longer in `.bobbit/config/workflows/`). For `type: command` steps, three shapes are accepted; there is **no `cwd:` field** on any step:

| Step shape | Working directory | Command source |
|---|---|---|
| `{ component, command }` | `<branch-container>/<component.repo>/<component.relative_path>` | resolved from `components[name].commands[name]` |
| `{ component, run }` | same as above | literal `run` string |
| `{ run }` | `<branch-container>` (per-branch worktree set root) | literal `run` string |

Free-form `{ run }` steps that need a different working directory use `cd ... && ...` inside the `run` string. This keeps the schema small and the working-dir rule unambiguous: it is structurally derived from the component, or it is the per-branch container root.

`llm-review` and `agent-qa` step shapes are unchanged - they keep their `prompt:` body and runtime context tokens (`{{branch}}`, `{{master}}`, `{{goal_spec}}`) which are substituted by the gate runner before execution. `agent-qa` additionally carries an optional `component:` field that selects which component's `config:` map the `/qa-test` skill reads (and which workspace to start). When omitted, the verification harness falls back to the first component whose `config.qa_start_command` is set, then to a name-match against the project, then to `components[0]`.

The workflow validator (`workflow-validator.ts`) rejects, at load time:

- `type: command` with `command:` but no `component:`
- `type: command` with both `command:` and `run:`
- a `component:` referencing an unknown component name
- a `(component, command)` pair where the component has no such command name

It does **not** reject template tokens in free-form `run:` or `prompt:` strings. Runtime context tokens are required for workflows to function; any other tokens fail at shell time as ordinary typos.

**Helpers on `ProjectConfigStore`:**

- `getComponents()` - components in declared order.
- `getComponent(name)` - single component by name.
- `componentsByRepo()` - `Map<repoName, Component[]>` for worktree planning.
- `repoNames()` - distinct repo names; size > 1 ⇒ multi-repo project.
- `isMultiRepo()` - convenience boolean.
- `setComponents(components)` - replace the array, persists to `project.yaml`.

**Inline workflow store** (`InlineWorkflowStore` in `workflow-store.ts`): a thin facade over `ProjectConfigStore` that exposes the same `get / getAll / put / remove / update` API the legacy disk-backed `WorkflowStore` did, but reads from `project.yaml::workflows`. Builtins are layered in-memory underneath. The class is exported under both names (`WorkflowStore` and `InlineWorkflowStore`) for back-compat with existing imports.

If the `workflows:` block is empty or missing, goal creation surfaces a clear error rather than silently falling back - "This project has no workflows configured - run project setup or generate workflows from Settings."

**Project assistant context.** The assistant generates the inline `workflows:` block from a single Markdown reference, [defaults/workflow-authoring-guide.md](../defaults/workflow-authoring-guide.md). The MD guide is the source of truth for the project model, component schema, gate semantics (depends_on, optional, manual, content/signal contracts, phases, runtime context tokens), the full step grammar, and worked examples. The runtime never reads the MD guide; it is pure assistant context.

**Removed runtime concepts:**

- **`defaults/workflows/*.yaml`** is no longer the source of truth for shipped workflows. The project assistant generates a bespoke inline `workflows:` block per project from the MD authoring guide; `POST /api/projects` does **not** seed defaults when `workflows` is omitted (a project may persist with zero workflows - see [No default workflow scaffold](#no-default-workflow-scaffold)). `BuiltinConfigProvider.getWorkflows()` returns `[]` at runtime - there is no system-scope or builtin workflow layer.
- **`.bobbit/config/workflows/`** is no longer a runtime concept. `InlineWorkflowStore` reads only from `project.yaml::workflows`. The `migrate-project-yaml.ts` step folds any pre-existing per-project workflow files into the inline block on first boot and removes the directory.

### Session worktrees

Every non-goal, non-assistant session automatically gets its own git worktree branch. This eliminates conflicts between concurrent sessions that would otherwise all work on the same branch (usually master).

**Which sessions get worktrees:**

| Session type | Worktree? | Branch pattern |
|---|---|---|
| Pool pre-build (any session type) | Yes | `pool/_pool-{uuid8}` (temp; renamed at claim time) |
| Regular (host, after pool claim) | Yes | `session/<uuid8>` (immediately on claim - no first-prompt rename; see [Remove session worktree & branch renaming](design/remove-session-worktree-rename.md)) |
| Regular (sandbox) | Yes | `session/s-{uuid8}` |
| Goal sessions | Yes | `goal/<branch-name>` |
| Team agent sessions | Yes | Per-agent branch within goal |
| Assistant sessions (goal, project, tool) | No | N/A - conversational only, no code edits |

**Pool branch namespace.** Pool entries pre-create worktrees under the `pool/_pool-<id>` branch prefix (was `session/_pool-*` pre-Phase 3). The `pool/` namespace lets the boot sweeper distinguish pool entries from session worktrees by branch prefix alone, and prevents pool entries from polluting the user's session branch list. Both prefixes (`pool/_pool-*` and the legacy `session/_pool-*`) are recognised on startup so sweeping is idempotent across version upgrades.

**Multi-repo worktree set.** In multi-repo projects every configured component repo (including data-only ones) gets a sibling worktree on the same branch. Layout under the default worktree parent (`<rootPath>-wt/` unless `worktree_root` is set):

```
# Single-repo project (today, unchanged)
<rootPath>/                      # primary worktree
<rootPath>-wt/<branch>/          # session/goal/staff worktree

# Multi-repo project
<rootPath>/                      # container holding sibling repos
  api/  web/  shared/            # repos in primary
<rootPath>-wt/<branch>/          # per-branch container = agent's cwd
  api/  web/  shared/            # per-repo worktrees, all on the same branch
```

The agent's cwd in multi-repo mode is the per-branch container, mirroring the primary `rootPath` structure. Components with `relative_path:` resolve relative to their repo's worktree (e.g. monorepo `packages/api` is at `<branch>/<repo>/packages/api`). One branch name spans all repos in the set - there is no per-repo branch divergence.

**`worktree_root` override.** Optional project field, absolute path or relative to `rootPath`. When set, single-repo layout becomes `<worktree_root>/<branch>/` and multi-repo becomes `<worktree_root>/<branch>/<repo>/`. Same semantics, only the parent dir moves.

**Pool claim sequence (sessions and goals).** Both flows route through `WorktreePool.claim()`:

1. `git branch -m pool/_pool-<id> <target>` - atomic, ~10ms.
2. `git worktree move <pool-path> <target-path>` - atomic, updates both gitdir pointers (git ≥ 2.17). On directory-rename failure (e.g. Windows file lock) for **single-repo** sessions, `claim()` reverts the branch rename and returns null; the caller falls back to a fresh `createWorktree`. (Multi-repo claims may surface a transient `degraded` warning when only one of N repos fails to move - see `PoolClaimResult.degraded`.)
3. `git fetch origin` + `git reset --hard <remote-primary>` - backgrounded after handoff, so claim itself is fast.
4. `git push -u origin <target>` - fire-and-forget, non-blocking.

Multi-repo pool entries are sets: each pool slot pre-builds N worktrees (one per configured repo, including data-only-component repos) sharing a `pool/_pool-<id>` branch name across repos. Claim fans out steps 1-4 in parallel across all repos in the entry. Pool target size is configurable via `worktree_pool_size`.

**Goal flow (Phase 3 fix).** `goal-manager.setupWorktree()` calls `pool.claim(goal.branch)` first and falls back to `createWorktree` only if the pool is empty. Multi-repo goals get the worktree set in one claim. Previously goals bypassed the pool entirely and were observably slower than session start - they now share the same warm-pool benefit.

**Session flow.** Pool entries pre-build on `pool/_pool-<id>`. On claim, `pool.claim(targetBranch)` runs the single branch-rename + worktree-move to the final `session/<id8>` name and the session is persisted with that name immediately. There is no first-prompt rename. The display title is independent of the git ref - `PUT /api/sessions/:id/title` updates metadata only. Archive cleanup operates on the final branch. See [Remove session worktree & branch renaming](design/remove-session-worktree-rename.md) for the full rationale and the test plan.

**Boot sweeper.** `worktree-sweeper.ts` runs at server boot and reconciles `.git/worktrees/*` against persisted session/goal/staff records. It detects:

- `pool/_pool-<id>` worktrees not in the in-memory pool - reclaimed.
- Legacy `session/_pool-*` entries (pre-Phase 3) - also recognised.
- Orphaned `session-<id8>/` directories not owned by any persisted, non-archived session - scheduled for cleanup.
- Legacy `session-<slug>-<id8>/` and `session-new-session-<id8>/` directories left over from pre-rename-removal sessions - tolerated while a live session row still references them, otherwise treated as orphans (back-compat for sessions that survive an upgrade).

The pre-refactor "renamed-but-orphaned" branch (server died between branch-rename and row-persist) is gone - that race no longer exists because the rename happens synchronously inside `pool.claim()` before the session row is published. See [Remove session worktree & branch renaming](design/remove-session-worktree-rename.md) §13 for the full classification table.

This means crash recovery doesn't require the user to manually clean up pool detritus.

**Lifecycle:**

1. **Creation**: When `POST /api/sessions` creates a non-goal, non-assistant session in a git repo, the server auto-generates worktree options. For host sessions, the pool claim (or fallback `git worktree add`) creates the branch. For sandbox sessions, `ProjectSandbox.createWorktree()` creates it inside the container. In multi-repo projects, this provisions a worktree set (one per configured repo) at the `pool/_pool-<id>` branch; all repos share the same branch name; on first claim the pool entry's `pool/_pool-<id>` is renamed once to `session/<id8>` (or the goal/staff branch as appropriate). **Subdirectory projects**: When a project's `rootPath` is a subdirectory of a git repo (e.g. `/repo/packages/my-app`), worktrees are still created at the git repo root level (full checkout), but the session `cwd` is offset to the corresponding subdirectory within the worktree. The `worktreePath` remains the worktree root (for cleanup). This offset is computed via `path.relative(repoRoot, project.rootPath)` and applied consistently in goal creation, `executeWorktreeAsync`, pool claims, and team member spawning.
2. **Working**: The agent works in the worktree directory (or subdirectory for offset projects). The git status widget shows ahead/behind master, and push/pull controls work the same as for goal branches.
3. **Cleanup**: On session terminate or archive, the worktree and branch are removed via `cleanupWorktree()` (host) or `ProjectSandbox.removeWorktree()` (sandbox).
4. **Orphan detection**: Orphaned `session/*` worktrees (from ungraceful shutdowns where cleanup didn't run) are **not** removed automatically on startup. Use Settings → Maintenance tab to preview orphaned worktrees and clean them up manually. The REST API (`GET /api/maintenance/orphaned-worktrees`) lists orphans; `POST /api/maintenance/cleanup-worktrees` removes them after validation.
5. **Restore**: After a restart, existing session worktrees are reused - the server reconnects to the worktree on disk without recreating it.

**Session creation modes:** The session-setup pipeline (`src/server/agent/session-setup.ts`) handles four modes, all routed through the same plan/execute structure:

| Mode | Triggered by | Worktree? | Seed context? |
|---|---|---|---|
| Normal (assistant) | `POST /api/sessions` for assistant types (goal/project/tool) | No | No |
| Worktree | `POST /api/sessions` for non-goal, non-assistant sessions in a git repo | Yes (auto) | No |
| Delegate | Parent session spawns a child via the `delegate` tool | Inherits parent cwd | No |
| Continue-Archived | `POST /api/sessions/:archivedId/continue` | Yes (fresh) if source had one | No - agent CLI rehydrates from a clone of the source `.jsonl` (no system-prompt injection) |

Continue-Archived sessions are covered in detail under [Continue-Archived sessions](#continue-archived-sessions) below.

**Staff agent worktrees:** Staff agents get a permanent worktree at creation time. Because staff sessions are long-lived (they persist across wake/sleep cycles rather than being recreated), their worktrees can become stale over time. To address this, `StaffManager.refreshWorktree()` runs on each wake cycle for non-sandboxed staff: it rebases the worktree branch onto the primary branch and re-runs **per-component** `worktree_setup_command` hooks (e.g. `npm ci`). Sandboxed staff agents skip the host-side refresh - their container-internal worktrees are managed via `sandboxBranch`, which is passed to `createSession()` during staff creation and legacy migration so the container creates the worktree properly.

**Per-component `worktree_setup_command`.** When provisioning any worktree (pool prebuild, on-demand creation, or staff wake refresh), `runComponentSetups()` (`worktree-setup.ts`) iterates `components[]` in declared order. For each component with a `worktree_setup_command:`, it runs that command in the **component's root path** - `<worktree>/<component.repo>/<component.relative_path>` (with `<repo>` collapsing to nothing when `.`). 2-minute timeout per command, non-fatal on error (logs warning, worktree is still usable). Each command runs independently - failure of one component's setup does not skip others. **No deduplication**: if multiple components in the same repo each define `worktree_setup_command: npm ci`, it runs once per component. Authors who don't want that should structure their components accordingly. `SOURCE_REPO` is set to the matching primary path so `cp -r "$SOURCE_REPO/node_modules" .` works as today. Components without the field (including all data-only components) are silently skipped.

**Single source of truth: `components[*].worktreeSetupCommand`.** The legacy top-level `worktree_setup_command` field in `project.yaml` is migrated onto the default component by `state-migration/migrate-project-yaml.ts` and never read again. The legacy `setupCommand` parameter on `createWorktree` / `createWorktreeSet` and the `setupWorktreeDeps` helper have been removed; every site invokes `runComponentSetups()` directly:

| Site | When it runs | How components are resolved |
|---|---|---|
| `WorktreePool._fill()` (single-repo and multi-repo) | After every successful pool prebuild, before the entry is published into the pool | `componentsResolver: () => Component[]` closure passed at construction - invoked **fresh per fill** so live edits to `project.yaml` take effect on the next replenishment without a server restart |
| `StaffManager.refreshWorktree()` | On each wake cycle for non-sandboxed staff, after rebasing the worktree onto the primary branch | `ctx.projectConfigStore.getComponents()` |
| `goal-manager.ts::setupWorktree` (single-repo and multi-repo) | When the pool is empty/disabled or claim fails, after `createWorktree` / `createWorktreeSet` succeeds | `componentsResolver(goal.projectId)` |
| `session-setup.ts::executeWorktreeAsync` (single-repo on-demand) | Fallback `createWorktree` path when the pool is empty | `ctx.projectConfigStore.getComponents()` - honours each component's `relativePath` via `componentRoot()` |

**Why the per-fill resolver matters.** Pool entries can sit in the pool for hours; if components were captured at pool construction time, a user who fixes a wrong setup command in `project.yaml` would still get stale entries baked with the old command until the server restarted. The closure pattern guarantees the next fill picks up edits.

**Loud log line.** Every pool fill that has at least one component with a setup command emits:

```
[worktree-pool] running setup for components: <names>
```

This exists specifically because the source-of-truth migration regressed silently once: three consumers (`server.ts`, `staff-manager.ts`, `git.ts::readWorktreeSetupCommand`) kept reading the migrated-away top-level key, `setupWorktreeDeps("")` no-oped, and every team lead's first build failed with an empty `node_modules`. The log makes any future regression immediately visible. A companion regression-guard unit test (`tests/worktree-pool.test.ts`) `grep`s `src/` for `.get("worktree_setup_command")` and fails on any hit outside the migration helper. A sibling guard in `tests/worktree-setup-fallback.test.ts` enforces the inverse direction: it fails if any source file passes a `setupCommand` argument to `createWorktree` / `createWorktreeSet`, or references the deleted `setupWorktreeDeps` helper, so a future caller cannot reintroduce the legacy plumbing that bypassed `componentRoot()` and ran setup hooks at the wrong cwd.

**`BOBBIT_SKIP_NPM_CI=1`** continues to bypass setup at the `git.ts` layer; `runComponentSetups()` honours it transparently.

#### Branch container vs agent cwd

Projects whose `rootPath` points at a subdirectory of a larger git repo (e.g. `rootPath: /persist/code/monorepo/agentic-fluyt-experiments`) need two different paths at runtime: a worktree-root path for git operations and component-step resolution, and an offset path for the agent process itself. `goal-manager.createGoal()` resolves both and stores them on the goal so downstream code can pick the right one — but the two paths are easy to confuse, and forwarding the wrong one into step resolution layers the offset twice and fails verification with `ENOENT`.

**The two fields on a goal:**

- **`goal.worktreePath`** — the un-offset *branch container*. Equal to the worktree root (`<rootPath>-wt/<branch>/` for single-repo, or the container holding sibling repo worktrees for multi-repo). Always at the git repo root level.
- **`goal.cwd`** — what agent sessions actually run in. For sub-rooted projects this is `worktreePath + relativeOffset`, where `relativeOffset = path.relative(repoPath, project.rootPath)`. For projects rooted at the git repo root (and for legacy / pre-worktree goals where no worktree was created), `cwd` and `worktreePath` are the same value.

**Which one to use:**

- **Agent session cwd** — the directory the agent process boots into, what tools like `bash`/`Read` see — is **`goal.cwd`**. This is the offset path; sessions want to land at the user's project root, not at the surrounding repo root.
- **`componentRoot()` / `resolveStep()` `branchContainer` argument** — must be **`goal.worktreePath ?? goal.cwd`**. These helpers layer `repo + relativePath` themselves to derive a component's working directory. Passing an already-offset `goal.cwd` here doubles the `relativePath` segment (e.g. `…/sub/sub/…`) and the resulting command runs in a path that does not exist.

**Use the exported helper.** `goalBranchContainer(goal)` in `src/server/agent/verification-harness.ts` returns the un-offset container with the correct legacy fallback. Any new call site that forwards a goal into step resolution — verification, sandbox exec, or any future caller — should route through this helper rather than picking a field directly:

```ts
export function goalBranchContainer(goal: { worktreePath?: string; cwd: string }): string;
```

The `?? goal.cwd` fallback inside the helper handles legacy / non-worktree goals where `worktreePath` is undefined; in that case no offset was ever applied to `cwd`, so the fallback is safe.

**Pinning test.** `tests/verify-step-resolution.test.ts` pins the call-site contract with four cases: single-repo with `relativePath` (the original bug), single-repo with no `relativePath`, multi-repo with both `repo` and `relativePath`, and the legacy fallback when `worktreePath` is undefined. An agent investigating step-resolution paths in verification should start there.

#### Remote branch cleanup

Bobbit creates four classes of remote branch and is responsible for deleting each when its owning entity is archived. **Why eager delete instead of one global purge:** the remote accumulates branches faster than any single timer can drain it (~30 sessions/day churn, dev restarts reset the 24h purge interval), so cleanup must be tied to the archive event itself.

| Branch pattern | Created by | Deleted by | When |
|---|---|---|---|
| `session/*` | Auto worktree on session create | `eagerDeleteRemoteSessionBranch` (fire-and-forget from `session-manager.ts::terminateSession`) | On archive, iff non-delegate AND fully merged into `origin/<primary>`. Unmerged branches fall back to the 7-day `purgeOneSession` cleanup. |
| `goal/<branch-name>` | Goal creation | `deleteRemoteGoalBranches` in `server.ts` (DELETE `/api/goals/:id` handler) | On goal archive. |
| `goal-goal-<slug>-<id>-<role>-<short>` | Per-role team agent worktree | Same handler - agent branch names are **snapshotted into a `string[]` before `teamManager.teardownTeam` runs**, because teardown mutates `entry.agents` in place via `dismissRole`'s `splice`. | On goal archive. |
| `staff-*` | Staff agent creation | `cleanupWorktree(..., deleteBranch=true)` in `skills/git.ts` | On staff dismiss. |

**Test-mode gate:** every push-delete call - existing (`cleanupWorktree`) and new (`deleteRemoteGoalBranches`, `eagerDeleteRemoteSessionBranch`) - short-circuits when `shouldSkipRemotePush()` returns true (`BOBBIT_TEST_NO_PUSH=1`). The eager session helper checks this flag *before* invoking `git merge-base --is-ancestor`, so test mode never touches git at all.

**Merge check (sessions only):** `eagerDeleteRemoteSessionBranch` runs `git merge-base --is-ancestor <branch> origin/<primary>` and only push-deletes on exit 0. If `origin/<primary>` is stale locally the check is conservative (skip delete) and `purgeExpiredArchives` mops up after 7 days. Local worktree cleanup remains in `purgeOneSession` so the archived-session review experience is preserved.

**Why the goal handler snapshots eagerly:** `teamStore.get(id)` returns the live `PersistedTeamEntry`; `teardownTeam → dismissRole` calls `entry.agents.splice(...)` on that same object. Reading `teamEntry.agents` *after* teardown sees an empty array and only the team-lead branch gets deleted - every per-role branch leaks. The fix copies branch names into a fresh `readonly string[]` before teardown.

Full design + bug archaeology: [docs/design/orphan-remote-branch-cleanup.md](design/orphan-remote-branch-cleanup.md). Diagnosis steps: [docs/debugging.md - Leaked remote branches](debugging.md#leaked-remote-branches).

### Git status cache & client resilience

The git-status widget (shown on every session with a worktree and on the goal dashboard) exposes branch / ahead / behind / dirty state. It must stay visible through transient server load, network drops, and container recycles - the user loses orientation if it flickers out. The widget only disappears when the server *explicitly* confirms the cwd is not a git repository.

Full design lives in [docs/design/git-status-widget-reliability.md](design/git-status-widget-reliability.md). The sketch:

**Server (`src/server/server.ts`, `src/server/skills/git-status-native.ts`).** `batchGitStatus` is a 2000ms-TTL single-flight cache wrapping `runBatchGitStatus`. Cache key is `${containerId ?? 'host'}::${cwd}::${summary|untracked}`. Concurrent callers share the same in-flight promise, resolved entries are reused for up to 2000ms, errors are never cached (the entry is deleted on rejection so the next call retries fresh). The 2-second window collapses the idle / reconnect / visibility-change / dashboard fan-out refresh storm into one git invocation while keeping data fresh enough for a 10s-cadence widget. `invalidateGitStatusCache(cwd, containerId?)` is called from `/git-commit`, `/git-pull`, `/git-push`, merge endpoints, and the `?fetch=true` branch so local git writes never return cached pre-write state.

The default `/git-status` call uses `git status --porcelain=v1 -uno` (summary: skips untracked scan, which is the long tail on large repos). `?untracked=1` switches to `-uall` and sets `untrackedIncluded: true` on the response; clients must not treat `clean` as authoritative when `untrackedIncluded === false`. The session widget fetches summary by default and refetches `?untracked=1` when the user opens the dropdown - the widget dispatches a `git-status-dropdown-open` CustomEvent (bubbles, composed) for this. Summary and untracked responses live in separate cache keys so one doesn't shadow the other.

**Host path** (no `containerId`) goes through `runBatchGitStatusNative` in `src/server/skills/git-status-native.ts`, which fans out direct `git.exe` invocations via `child_process.execFile` (argv array - no shell) in two parallel phases:

- **Phase A** (`Promise.all`, ~6 calls): current branch, `origin/HEAD` symbolic-ref, master/main verify, `status --porcelain`, upstream tracking branch.
- **Phase B** (`Promise.all`, ~6 calls): ahead/behind counts vs upstream and vs primary, plus two `git diff --shortstat` calls (`<pref>...HEAD` for committed delta + `HEAD` for uncommitted delta) parsed by `parseShortstat()` into `insertionsVsPrimary` / `deletionsVsPrimary` on `GitStatusResult`. Untracked files aren't counted (matches `git diff` semantics; `~N` already covers them). Parse failure or on-primary falls back to `0/0` silently. After Phase A resolves the primary ref.

Per-call timeout is 3s; only the HEAD lookup is mandatory (any other failure falls back to safe defaults matching the legacy bash behaviour - missing upstream → `hasUpstream=false`, count failures → 0, etc.). Wall-clock is dominated by the slowest single git call (~50-150ms on Windows, ~10-30ms on Linux). This replaces the earlier approach that piped a multi-line script through Git Bash on Windows - that one cold spawn cost 500-1000ms per refresh and the in-script git invocations ran sequentially.

**Container path** (when `containerId` is set) keeps the batched approach: a single `docker exec sh -c '<batch script>'` round-trip. Inside the container, `git` is fast and the perf complaint never applied; one round-trip beats N parallel `docker exec` calls because Docker Desktop's daemon serializes inbound requests under contention.

**No in-server retries.** `runBatchGitStatusCount` increments exactly once per `batchGitStatus` call. The 3s per-call timeout fast-fails contended invocations; client-side retry in `git-status-refresh.ts` (4 attempts at [0, 500, 2000, 5000]ms) is the only resilience layer. Responses still carry optional `partial: true` for Phase-B timeouts - the client renders a yellow warning dot and the dropdown offers Re-scan.

Test-only hooks - `__setGitStatusFake` / `__clearGitStatusFake` / `__getGitStatusInvocationCount` / `__resetGitStatusInvocationCount` - replace the git-spawn path with a deterministic function so coalesce/TTL/retry E2E tests don't depend on the real `git status` binary, which becomes flaky under CI load (EAGAIN / ENFILE / Windows ENOENT races). Production code never touches them.

**Client (`src/app/api.ts`, `src/app/session-manager.ts`, `src/app/goal-dashboard.ts`, `src/ui/components/AgentInterface.ts`, `src/ui/components/GitStatusWidget.ts`, `src/app/git-status-refresh.ts`).**

- `fetchGitStatus` returns a discriminated `GitStatusResult = { kind: 'ok', data } | { kind: 'not-a-repo' } | { kind: 'error', err }`. Never `null`, never throws. The old `null` return collapsed "not a repo" and "transient failure" into the same outcome, which is exactly the bug that caused widget disappearance.
- Tri-state `gitRepoKnown: 'yes' | 'no' | 'unknown'` (property on `AgentInterface`, module variable in `goal-dashboard.ts`) gates rendering. Default `'unknown'` on session connect / dashboard load. Only HTTP 400 with `error === "Not a git repository"` flips to `'no'` (widget hides). 200 → `'yes'`. Any other non-2xx / network error / abort leaves it unchanged - widget stays visible with last-known-good data (or skeleton if there was none).
- `refreshGitStatusForSession` runs up to 4 attempts at [0, 500, 2000, 5000]ms. One in-flight refresh per session (tracked in a `Map<sessionId, AbortController>`); a session switch aborts the controller so retries don't land on the wrong `AgentInterface`. `gitStatusLoading = true` spans the entire retry chain and clears only in the final `finally` - users see continuous loading, not flicker.
- 30s safety poll (session) gated on `document.visibilityState === 'visible'` + active session + `gitRepoKnown !== 'no'`. 10s coalesce window via `gitStatusLastRefreshAt` so event-driven refreshes (agent idle, reconnect, local git action) don't double-fire with the poll. On `visibilitychange → visible` an immediate refresh fires rather than waiting out the interval. The goal dashboard uses the identical tri-state + retry at its existing 60s cadence (cadence unchanged per the design's out-of-scope list).
- `GitStatusWidget` has reactive `loading` and `partial` props. `loading && !branch` → shimmer skeleton ("Checking git..."); `loading && branch` → existing content + pulsing dot; `partial && branch` → yellow warning dot.

**Why tri-state plus retry instead of a single boolean "have we ever seen data"?** The `'no'` decision has to be authoritative - the widget is the user's only feedback that we even *tried* to read git state. Inferring "not a repo" from any failure mode (the pre-fix behaviour) silently hid the widget for network blips, CPU spikes, git lockfile contention, and Docker exec hiccups, and the only way the user got it back was a page reload. Making the server say it explicitly, and keeping every other failure visibly in `'unknown'` with retries, means the UI state always matches what we actually know.

### Continue-Archived sessions

Archived, non-goal, non-delegate sessions render a "Continue in New Session" button below their transcript. Clicking it creates a brand-new session that inherits the archived session's **settings** but none of its **runtime state**.

**Why split settings from runtime state**: Users reopening an archived session usually want to resume the task, not resurrect the exact environment. The old worktree may be gone, the sandbox container may have been pruned, and the branch may be merged or abandoned. Continue-Archived gives them the same tools (model, role, sandbox/worktree flags) in a fresh runtime, with the prior conversation available as context only.

**What is copied:**

- `projectId`
- `modelProvider`, `modelId` (applied post-create via `setModel` + persisted immediately; worktree sessions set the model once the agent is ready)
- `role` (resolved via `roleManager.getRole()`, so prompt/accessory/tool policies are re-applied fresh)
- `sandboxed` flag (new container state per normal per-project sandbox rules)
- `worktreePath` presence - if the source had a worktree, the new session gets one via the standard pipeline (pool claim or `git worktree add`)

**What is explicitly NOT copied:**

- Working directory, worktree path, branch, uncommitted changes
- Sandbox container identity or in-container state (the new session joins the project's container per normal semantics)
- `goalId`, `teamGoalId`, `teamLeadSessionId`, `delegateOf` - guaranteed absent because the scope gate rejects those source types up front
- Task/gate signals, streaming state, tool state

**Scope gate** (enforced server-side in `handleApiRoute()` and client-side in `AgentInterface.ts`): the source must be archived, have no `goalId`, no `delegateOf`, no `teamGoalId`, no `assistantType`, and its project must still be registered. Violations return `409` / `422` / `410` respectively. See [docs/rest-api.md - Continue-Archived endpoint](rest-api.md#continue-archived-endpoint) for the full error table.

**Lossless transcript carry-over**: Continue-Archived used to render the archived transcript back to plain text and inject it into the new session's system prompt as `seedContext`, capped at 128 KB - any non-trivial session was truncated. The endpoint now clones the source `.jsonl` byte-for-byte and lets the agent CLI rehydrate from it via `switch_session`, the same mechanism `restoreSession()` uses for live-session restart. Full transcript fidelity, no byte budget, no system-prompt section, no Summary vs Full distinction. Full design rationale: [docs/design/lossless-continue-archived.md](design/lossless-continue-archived.md).

**Endpoint flow** (`src/server/server.ts`, `POST /api/sessions/:archivedId/continue`):

1. Resolve the source `agentSessionFile` from `getPersistedSession(archivedId)`. Falls back to `sessionManager.recoverSessionFile(ps)` (promoted to public) for legacy persisted rows that never carried the field. Missing on both paths → **404**.
2. Compute the destination path via `formatAgentSessionFilePath(cwd, createdAtMs, sessionId)` in `src/server/agent/agent-session-path.ts`. Format matches the agent CLI's own naming - `<globalAgentDir()>/sessions/--<cwd-slug>--/<isoTs>_<uuid>.jsonl` - so the path round-trips through `recoverSessionFile`'s parser regex.
3. Copy via `sessionFileCopy(srcCtx, srcPath, dstCtx, dstPath, mgr)` in `src/server/agent/session-fs.ts`. Two-tier dispatch mirroring `sessionFileDelete`:
   - **host↔host**: `fs.copyFileSync` after `mkdirSync({recursive:true})`.
   - **same-project sandboxed↔same-project sandboxed**: `docker exec cp` inside the container.
   - **host↔sandbox** or **cross-project sandboxed**: throws `CrossRealmCopyError` → handler returns **422**.
   Other copy failures unlink the destination and return **500** with cleanup.
4. Best-effort `copyToolContentDirIfPresent(srcId, dstId, stateDir)` recursively copies `<stateDir>/tool-content/<srcId>/` if present. The directory does not exist on disk today - `GET /api/sessions/:id/tool-content/:mi/:bi` reads through `rpcClient.getMessages()` from the JSONL - but the helper is shipped as defensive forward-compat for any future on-disk cache.
5. Build `createSession` opts with `preExistingAgentSessionFile: <destPath>`. The `seedContext` / `seedContextSourceId` opts have been removed entirely - they had no other callers.
6. Inside the session-setup pipeline (`src/server/agent/session-setup.ts`), `persistOnce` writes the cloned path as `agentSessionFile` on the `PersistedSession` row **before** spawn, so a hard kill between persist and spawn cannot strand the clone. After `rpcClient.start()` succeeds and before `persistSessionMetadata`, the pipeline issues `{type: "switch_session", sessionPath: plan.preExistingAgentSessionFile}` - the same RPC restart-resume uses (`session-manager.ts::restoreSession`). The agent CLI loads the cloned transcript before the user's first prompt.

**Worktree-cwd slug rebase**: Step 2 computes `destJsonl` against `proj.rootPath` because that's the only `cwd` known at request time. For worktree-backed sources, however, the agent CLI boots with `cwd = offsetCwd` (the per-branch worktree container), and `formatAgentSessionFilePath` embeds a `slugify(cwd)` segment in the path - so a clone left under the project-root slug-dir is invisible to the agent CLI and `switch_session` fails. To bridge this, `executeWorktreeAsync` in `src/server/agent/session-setup.ts` rebases the cloned `.jsonl` after `plan.cwd` is finalised to the worktree path and before `switch_session` is issued: it re-derives the correct path via `formatAgentSessionFilePath(plan.cwd, Date.now(), session.id)`, moves the file (host-side `fs.promises.rename` with a `copyFile + unlink` cross-device fallback for non-sandboxed sessions; container-side `sessionFileCopy + sessionFileDelete` for sandboxed sessions), `mkdir { recursive: true }`s the target dir, and updates both `plan.preExistingAgentSessionFile` and the persisted `agentSessionFile` field so a hard kill in the post-spawn window restores the right path. The rebase only fires on the worktree branch when `plan.preExistingAgentSessionFile` is set; the non-worktree continue path is untouched. Regression test: `tests/e2e/continue-archived-worktree.spec.ts`.

**Title**: The new session is titled `Continued: <original title>` and marked `markGenerated: true` so the first-message auto-titler does not overwrite it.

**Key files:**

- `src/server/agent/continue-archived.ts` - trimmed to `copyToolContentDirIfPresent` + `cleanupFailedContinue`. All transcript-stringification helpers (`buildSeedContext`, `formatFullTranscript`, `summarizeTranscript`, `renderMessagesAsText`, `truncateStringToBudget`, `callNamingModel`, `SEED_TOTAL_BUDGET`, `SUMMARY_INPUT_BUDGET`) are gone.
- `src/server/agent/agent-session-path.ts` - `formatAgentSessionFilePath`, sibling to `recoverSessionFile`'s parser regex.
- `src/server/agent/session-fs.ts` - `sessionFileCopy` with the four-row dispatch matrix and `CrossRealmCopyError`.
- `src/server/server.ts` - `POST /api/sessions/:archivedId/continue` handler (scope gate, copy, session creation, cleanup-on-failure).
- `src/server/agent/session-manager.ts` - `recoverSessionFile` is public; `createSession` opts carry `preExistingAgentSessionFile?: string` (no `seedContext` plumbing).
- `src/server/agent/session-setup.ts` - `SessionSetupPlan.preExistingAgentSessionFile`; both `spawnAgent` and `executeWorktreeAsync` issue `switch_session` after `rpcClient.start()` succeeds, before `persistSessionMetadata`. `persistOnce` writes the path up front.
- `src/server/agent/system-prompt.ts` - `seedContext` / `seedContextSource` and the `## Prior Session Transcript` section have been removed from `PromptParts`.
- `src/ui/components/AgentInterface.ts` - footer renderer, keyed by `[data-continue-archived-footer]`.
- `src/ui/components/ContinueSessionChooser.ts` - confirm-only modal (no mode radio, no large-transcript warning, empty POST body).

### Archived session WS handshake

When a client opens an archived session, the WebSocket handler in `src/server/ws/handler.ts` must push a `state` frame as part of the initial handshake - immediately after `auth_ok` / `session_status` / `session_title`. The frame carries the session's persisted `model` (provider, id, plus inferred `contextWindow` / `maxTokens` / `reasoning`) and any `imageGenerationModel`, matching the shape live sessions receive via the proactive `getState()` push.

**Why this exists.** `RemoteAgent` in `src/app/remote-agent.ts` seeds `_state.model` at construction time with a hardcoded placeholder default (currently a Claude Opus id) so the footer model picker has something to render before the first server frame arrives. For live sessions this placeholder is overwritten almost instantly by the `getState()` push the server makes on connect. Archived sessions used to have no equivalent push - the persisted model only shipped if and when the client sent `get_state`, which happens on reconnect but not on initial connect - so the placeholder leaked into the footer until the user reloaded or the WebSocket dropped and resumed. The bug surfaced as "every archived session looks like it ran on Opus regardless of which model it actually used." The fix closes the asymmetry between live and archived initial-connect behaviour.

**Single source of truth.** The archived state payload is built by `buildArchivedStateData(archived, sessionManager, sessionId)` in the same handler module. Both the archived branch of the `auth_ok` flow and the existing `get_state` request handler call it, so the two sites cannot drift in shape (e.g. `get_state` previously emitted a slimmer payload missing `contextWindow` / `maxTokens` / `imageGenerationModel`). Any future field added to the archived state - new model metadata, additional read-only flags - belongs inside that helper.

**Latent fragility.** The client-side placeholder default in `RemoteAgent` is the underlying reason this bug was visible at all; removing it would require auditing every consumer of `state.model` for null-safety and is out of scope here. As long as the placeholder exists, every code path that hydrates state for an archived session must push a real `state` frame on initial connect. New transports or alternative connect paths (e.g. snapshot replay endpoints, future test harnesses) need to preserve this invariant. The regression test `tests/e2e/archived-footer-model.spec.ts` connects to an archived session **without** sending `get_state` and asserts the inbound `state` frame carries the true persisted model - keep it green.

### Sidebar grouping

The sidebar always groups sessions and goals under collapsible project folder rows - even with a single project. This unified code path avoids duplication between single-project and multi-project layouts.

```
├── Project A (collapsible)
│   ├── Goal 1
│   │   ├── session...
│   ├── Sessions (ungrouped)
│       ├── session...
├── Project B (collapsible)
│   ├── ...
├── [+ Add Project]
```

When only one project is registered, its folder row defaults to expanded so there is no extra click required. Each project row shows a folder icon, project name, settings gear, and new-goal button. When no projects are registered (fresh install), the sidebar shows a "No projects configured" empty state with an "Add Project" button.

**Toolbar "+ New Goal" behavior** depends on how many projects are registered:

| # projects | Click behavior |
|---|---|
| 0 | Button disabled with tooltip "Add a project first". Empty-state Add Project CTA is the primary action. |
| 1 | Skips the picker entirely and opens the goal creation dialog directly, scoped to the one project. |
| 2+ | Opens `<project-picker-popover>` (`src/ui/components/ProjectPickerPopover.ts`) anchored beneath the button, listing every registered project with its color dot. Clicking a project starts goal creation scoped to it; Esc / click-outside closes; arrow keys + Enter navigate. On mobile (viewport < 640px) the popover renders as a centered sheet. |

The per-project "+ goal" button on each project row bypasses the popover - the project is already unambiguous. Goal creation is centralized in `startNewGoalFlow(anchorEl)` in `src/app/goal-entry.ts` so every call site (toolbar button, mobile nav, empty-state CTA, `Alt+G` shortcut) stays in sync.

#### Staff agents in the sidebar

Staff agents are project-scoped permanent sessions: each staff record carries a `projectId`, lives in that project's `staff.json`, and owns a long-lived worktree on a `staff-<name>-<id>` branch. Each project group in the sidebar renders a dedicated, collapsible **Staff** sub-section between the project's goals and its ungrouped Sessions list. The sub-section is rendered by `renderStaffSidebarSection` in `src/app/sidebar.ts` (the same helper drives desktop and mobile — it branches internally on `isDesktop()`).

The sub-section is always present, even when the project has zero staff, so users have a stable place to create their first one. Its header carries a `Bot` icon, the **Staff** label, and two action buttons that mirror the project header's quick-actions: **Manage staff** (`List` icon → `#/staff`) and **New staff** (`Plus` icon → `startNewStaffFlow(e, project.id)`). Individual staff rows get the same active / unread / last-activity treatment as ordinary sessions, plus a hover-action pencil that opens `#/staff/<id>`. Staff whose current session is archived under a goal render in that goal's archived sub-section instead, never duplicated into Staff.

**Staff are not merged into Sessions.** Created staff agents live exclusively in the Staff sub-section. The staff-creation **assistant session** (`assistantType: "staff"`) is a transient normal session and shows up in the project's Sessions list while open — only the persisted staff record that results from accepting `propose_staff` moves into Staff. This split was the point of restoring the sub-section: a previous experiment that synthesised staff rows into Sessions made staff feel like ordinary disposable sessions and hid the fact that they are long-lived, profile-backed agents.

The collapsed (icon-only) sidebar buckets staff under their owning project group alongside goals and ungrouped sessions; there is no global staff tail list. The project header retains the same **Manage staff** / **New staff** quick-action buttons (redundant with the sub-section header but useful when the sub-section is collapsed) — **New staff** calls `createStaffAssistantSession({ projectId, cwd })` so the creation assistant always lands in the right project context, no second project picker and no `propose_staff(cwd)` re-link dance after the fact.

**Orphan handling.** Legacy records can land in two broken states: missing `projectId` outright, or persisted under `SYSTEM_PROJECT_ID` (from the pre-change server-scope carve-out). `StaffManager.listOrphaned()` returns both kinds on startup and the sidebar surfaces them in a one-off orphan banner above the project list, with a one-click **Assign to project…** action that calls `PATCH /api/staff/:id { projectId }`. The handler moves the persisted record between per-project stores, re-indexes search, and preserves the existing worktree branch (the next wake rebases against the new project's primary branch). Orphaned staff are never silently dropped from the UI. See [rest-api.md — Staff Agents](rest-api.md#staff-agents) for the endpoint contract.

**Collapse state is per-project**: The Sessions section collapse toggle is stored per-project, not globally. Collapsing Sessions in Project A does not affect Project B. State is persisted as a collapsed-project-ID set in localStorage (`bobbit-collapsed-ungrouped`). Default state is expanded for all projects. Access via `isUngroupedExpanded(projectId)` / `setUngroupedExpanded(projectId, value)` in `state.ts`. The Staff sub-section uses the same per-project pattern: `isStaffExpanded(projectId)` / `setStaffSectionExpanded(projectId, value)` backed by localStorage key `bobbit-collapsed-staff`, also consulted by the keyboard-navigation expand/collapse helpers in `src/app/sidebar-nav.ts` (kind `staff-header`).

**Per-project Archived subsections**: Each project group ends with its own collapsible Archived subsection (rendered by `renderProjectArchivedSection` in `src/app/render-helpers.ts`, shared between desktop `renderSidebar` (`src/app/sidebar.ts`) and mobile `renderMobileLanding` (`src/app/render.ts`) so both breakpoints render identically). Bucketing is currently split: desktop uses an inline loop in `sidebar.ts` that emits `console.warn` for orphaned items, while mobile uses the `bucketArchivedByProject` helper in `render-helpers.ts` which silently drops unmatched items. The global Archived block that used to sit at the bottom of the sidebar is gone.

- **Global visibility toggle**: The bottom-bar "See Archived" button (localStorage `bobbit-show-archived`, state `state.showArchived`) still controls whether any archived content is rendered at all. It is global, not per-project - one toggle flips every per-project Archived subsection at once. This keeps the user-visible UX contract of the pre-existing toggle unchanged.
- **Per-project collapse state**: Each project's Archived subsection defaults to **expanded** when `showArchived` is on; users can collapse individual projects' subsections independently. Collapsed project IDs are persisted in localStorage `bobbit-archived-collapsed-projects` (mirrors `bobbit-collapsed-ungrouped` / `bobbit-collapsed-staff`). Access via `isArchivedSectionExpanded(projectId)` / `setArchivedSectionExpanded(projectId, value)` in `state.ts`. Default-expanded is deliberate: before the per-project split there was no intermediate "collapsed but visible" state, so expanded-by-default preserves the old behaviour of "See Archived on = archived items are visible".
- **Orphaned-item fallback**: Archived goals or sessions whose `projectId` is missing or does not resolve to a registered project are bucketed into the first project's Archived subsection so they remain visible to the user rather than silently disappearing. This is a UI rendering fallback for data inconsistencies - it does not imply a runtime default project on the server side. On desktop the fallback emits a `console.warn` to make the inconsistency debuggable; on mobile (via `bucketArchivedByProject` in `render-helpers.ts`) the fallback is silent.
- **Pagination (v1)**: Archived goals and sessions are still fetched globally (not per-project) via `GET /api/goals?archived=true` and `GET /api/sessions?include=archived`. The "Load more archived goals..." / "Load more archived sessions..." buttons are rendered **once**, below the project list, not per project. Per-project pagination would require server-side `projectId` filters on those endpoints and is intentionally deferred. On mobile the pagination buttons are additionally hidden while a search query is active, since search results collapse the per-project layout.
- **Search**: The `_archivedBySearch` / `_ensureArchivedForSearch` auto-open behaviour is unchanged - a search match inside any archived item still forces `state.showArchived` on globally. When a search query is active, each project's subsection only renders matching items; projects with no matches render no Archived subsection at all.
- **Collapsed sidebar**: `renderCollapsedSidebar` is unchanged - archived goals continue to render inline with live goals in the icon-only rail.

### Sidebar keyboard navigation

`Ctrl+↑/↓` walk the sidebar in rendered DOM order with auto-open on every step; `Ctrl+→/←` expand/collapse the active group header without moving the cursor. The order is read directly from `[data-nav-id]` elements under `.sidebar-edge`, so search filtering, archived view, and every collapse toggle are honoured automatically — the rendered sidebar is the single source of truth. Implementation lives in `src/app/sidebar-nav.ts`; shortcut ids `prev-session`, `next-session`, `sidebar-expand`, `sidebar-collapse` are registered in `src/app/main.ts`. See [docs/sidebar-keyboard-navigation.md](sidebar-keyboard-navigation.md) for the full contract, the row-kind → destination table, and the rationale behind `state.keyboardNavActiveId`.

### REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all registered projects |
| `POST` | `/api/projects` | Register a project (body: `name`, `rootPath`, optional `color`) |
| `GET` | `/api/projects/:id` | Get a single project |
| `PUT` | `/api/projects/:id` | Update name/color |
| `DELETE` | `/api/projects/:id` | Unregister (does not delete files on disk); any project may be removed, including the last visible one |
| `GET` | `/api/projects/:id/config` | Raw project-level config overrides |
| `GET` | `/api/projects/:id/config/defaults` | Built-in defaults |
| `PUT` | `/api/projects/:id/config` | Set/clear project config fields |
| `GET` | `/api/projects/:id/config/resolved` | Resolved values with `{ value, source }` |

Session/goal/search endpoints accept optional `?projectId=` filter:
- `GET /api/sessions?projectId=<id>`
- `GET /api/goals?projectId=<id>`
- `GET /api/search?projectId=<id>`

### Key files

| File | Purpose |
|---|---|
| `project-registry.ts` | Project CRUD and persistence |
| `project-context.ts` | Scoped store container per project (with `open()`/`close()` lifecycle) |
| `project-context-manager.ts` | Central registry of contexts, aggregation, store routing |
| `state-migration.ts` | One-time migration from centralized to per-project state |
| `config-resolver.ts` | 3-tier scalar config cascade (`project.yaml` keys) |
| `builtin-config.ts` | Read-only provider for factory-default config from `dist/server/defaults/` |
| `config-cascade.ts` | Three-layer entity resolution (builtin → server → project) with origin tags |
| `config-scope.ts` | Shared UI scope row + origin badge helpers for config pages |
| `project-assistant.ts` | Guided project registration |

---

## Editable proposals

Every `propose_*` payload (`goal`, `project`, `workflow`, `role`, `tool`, `staff`) is mirrored to a real file under `.bobbit/state/proposal-drafts/<sessionId>/<type>.{md,yaml}`. The file is the single source of truth; the in-memory `state.activeProposals[type]` slot is a parsed projection rebuilt on every change. Two new tools - `view_proposal(type)` and `edit_proposal(type, old_text, new_text)` - let the agent apply surgical changes via exact-string replacement, with structured rollback on parse failure.

### Why

Agents previously had to re-emit the entire payload via `propose_*` to tweak one field. For a fully-elaborated `propose_project` call (components, workflows, gate DAGs, verify steps) this meant streaming kilobytes of YAML to change a single command string - expensive in tokens and wall-clock time, and easy to drift between successive emissions. The file-on-disk model lets `edit_proposal` patch the draft in place using the same `old_text`/`new_text` contract the agent already uses for source code, with atomic rollback so a malformed edit cannot corrupt the stored form.

The refactor also unified the six per-type proposal slots into one keyed map and lifted the goal-proposal UX behaviours (draft persistence, dismissal stickiness, "Open proposal" reopen, first-emit auto-select, streaming shallow-merge, per-session scoping) so every type inherits them. Bespoke per-type renderers (project's Components/Workflows/Diff, workflow's gate graph, goal's spec markdown) are unchanged - only the surrounding plumbing was rewritten.

Full spec: [docs/design/editable-proposals.md](design/editable-proposals.md).

### On-disk layout

```
.bobbit/state/proposal-drafts/
  <sessionId>/
    goal.md         # markdown body + YAML frontmatter (title/cwd/workflow/options)
    project.yaml    # native YAML matching the propose_project arg shape
    workflow.yaml
    role.yaml
    tool.yaml
    staff.yaml
```

Goal is the only markdown format; the body after the frontmatter is the goal `spec`. The other five files are native YAML (no JSON-stringified structured fields - see [Native-YAML project.yaml fields](#native-yaml-projectyaml-fields)). Per-session directories are created lazily on first write, cleaned up on session archive by `session-manager.ts::terminateSession` (fire-and-forget `fs.rm`).

Path safety: `sessionId` is validated against `/^[A-Za-z0-9_-]+$/` and `type` against the union literal, so no traversal is possible.

### Server module: `proposal-files.ts`

`src/server/proposals/proposal-files.ts` owns the disk lifecycle and has no WebSocket or session-manager imports. The atomic-rollback contract is in `editProposalFile`:

1. Read current content.
2. Apply exact-string replacement (first-and-only-occurrence rule, identical to the builtin `edit` tool). Empty `new_text` deletes.
3. Write to `<file>.tmp`.
4. Parse via the per-type plugin in `proposal-types.ts` and run the required-field whitelist.
5. On any parse/validate failure: unlink the `.tmp`, return a `ParseError` with structured `code`, file on disk untouched.
6. On success: `fs.rename` `.tmp` → final path.

Structured error codes (returned to the agent in the tool result and as `400` JSON bodies on the REST endpoint):

| Code | Meaning |
|---|---|
| `FILE_NOT_FOUND` | No prior `propose_<type>` in this session. |
| `OLD_TEXT_NOT_FOUND` | `old_text` does not match the file. |
| `OLD_TEXT_NOT_UNIQUE` | `old_text` matches multiple times - ambiguous. |
| `FRONTMATTER_MALFORMED` | `goal.md` frontmatter fence is broken. |
| `YAML_PARSE_ERROR` | The post-edit YAML body fails to parse. |
| `MISSING_REQUIRED_FIELD` | Per-type required-field whitelist failed. |
| `STRUCTURAL_VALIDATION_FAILED` | Project YAML fails the same structural validator used by `PUT /api/projects/:id/config`. |

Per-type metadata lives in `src/server/proposals/proposal-types.ts`: `filename`, `serialize(args) → body`, `parse(body) → ParseResult`, `requiredFields[]`. Adding a new proposal type means adding a plugin entry plus the matching client-side entry in `PROPOSAL_TYPE_REGISTRY`.

### Unified client state

The six legacy slots (`activeGoalProposal`, `activeProjectProposal`, `activeRoleProposal`, `activeStaffProposal`, plus the implicit slots for `tool`/`workflow`) are collapsed into one map in `src/app/state.ts`:

```ts
activeProposals: Partial<Record<ProposalType, ProposalSlot>>;

interface ProposalSlot {
  sessionId: string;
  fields: Record<string, unknown>;  // parsed projection
  streaming: boolean;                // mirrors proposalStreamingByTag for legacy panels
  mode?: "provisional" | "registered"; // project only
  rev: number;                       // monotonic; UI re-render hint
}
```

`src/app/proposal-registry.ts` exports `ProposalType`, `ProposalSlot`, `ProposalTypePlugin`, and `PROPOSAL_TYPE_REGISTRY`. Each plugin contributes:

- `mergeFields(prev, incoming)` - streaming shallow-merge. Project carries `components` and `workflows` forward when the partial omits them; goal carries the markdown body across frontmatter-only deltas; the others use a plain spread.
- `onFirstEmit(slot, opts)` - tab auto-select on the first emit (e.g. project flips `previewPanelActiveTab="project"`, mobile flips the assistant tab).
- `validate(fields)` - returns blocking errors that disable the submit button.
- `accept(slot)` - reserved hook; current accept paths (`createGoal`, `acceptProjectProposal`, role/staff/tool/workflow accept endpoints) are unchanged.

Unified draft + dismissal helpers in `src/app/proposal-helpers.ts` replace the per-type ad-hoc managers:

- `saveProposalDraft(sid, type)` / `loadProposalDraft(sid, type)` / `deleteProposalDraft(sid, type)`
- `markProposalDismissed(sid, type, fields)` / `isProposalDismissed(sid, type, fields)` / `clearProposalDismissed(sid, type)`

LocalStorage key for dismissal is `bobbit-${type}-proposal-dismissed-${sessionId}`; the legacy `bobbit-goal-proposal-dismissed-<sid>` key is migrated once on first read.

### Flow: `propose_*` → file-seed → broadcast → parsed projection

```
agent calls propose_<type>(args)
  └─> defaults/tools/proposals/extension.ts execute()
        └─> POST /api/sessions/:id/proposal/:type/seed { args }
              └─> writeProposalFile (serialize + write)
                    └─> parseProposalFile
                          └─> _broadcastToSession({ type: "proposal_update",
                                                       proposalType, fields,
                                                       streaming: false,
                                                       source: "seed" })
                                └─> client remote.onProposal(type, fields, false)
                                      └─> mergeFields, onFirstEmit (if first), renderApp
```

`edit_proposal` follows the same flow except the entry point is `POST /api/sessions/:id/proposal/:type/edit` and `source: "edit"`. `view_proposal` is a pure `GET` that returns the raw file body for the agent to read.

### Dual-fire: legacy streaming path coexists

The live `propose_*` tool-use scanner in `src/app/remote-agent.ts::_checkToolProposals` continues to fire the legacy per-type `onXProposal` callbacks during streaming, so partial deltas flow into the panel as the model types them. The unified `remote.onProposal` callback is the WS-driven path - it handles `proposal_update` (sources `seed`, `edit`, `rehydrate`) and `proposal_cleared`. Both paths funnel into the same `state.activeProposals[type]` slot via the plugin's `mergeFields`. The streaming-partial path provides UX responsiveness; the file-derived path provides the canonical projection and restart survival.

### Restart survival via rehydrate-on-attach

On WS `auth_ok` / session attach, `src/server/ws/handler.ts` enumerates `.bobbit/state/proposal-drafts/<sessionId>/`, parses each surviving file, and emits one `proposal_update { source: "rehydrate" }` per draft to the freshly-attached client. Because the file IS the source of truth, no separate persistence layer is needed - a server restart mid-edit, a browser reload, or a session resume all yield the same broadcasted projection.

Session archive cleans the directory: `session-manager.ts::terminateSession` fire-and-forgets `fs.rm` of the per-session dir. An in-flight `editProposalFile` racing with cleanup is harmless - `unlink` on a missing dir is a no-op.

### Accept lifecycle

The per-type accept handlers (`createGoal`, `acceptProjectProposal`, etc.) are unchanged. After a successful accept, the client fires `DELETE /api/sessions/:id/proposal/:type` which deletes the file and broadcasts `proposal_cleared`; the unified callback then drops the slot from `state.activeProposals`. The matching `deleteProposalDraft(sid, type)` clears the local-draft side state.

### Tool surface

| Tool | Group | Purpose |
|---|---|---|
| `view_proposal` | Proposals | `{ type }` → raw file body, or `404 {code:"FILE_NOT_FOUND"}` pointing at the matching `propose_*`. |
| `edit_proposal` | Proposals | `{ type, old_text, new_text }` → post-edit body on success, structured error otherwise. Failed edits do NOT modify the file. |
| `propose_<type>` | Proposals | Unchanged surface; now also seeds the file via the `/seed` REST endpoint as a side effect of `execute()`. |

Descriptors: `defaults/tools/proposals/{view,edit}_proposal.yaml`. Implementation: `defaults/tools/proposals/extension.ts`.

### REST endpoints

Five endpoints, full reference in [docs/rest-api.md - Proposal drafts](rest-api.md#proposal-drafts):

- `GET /api/sessions/:id/proposal/:type` - read raw body
- `POST /api/sessions/:id/proposal/:type/seed` - called by `propose_*` `execute()`
- `POST /api/sessions/:id/proposal/:type/edit` - surgical edit
- `POST /api/sessions/:id/proposal/:type/restore` - restore prior revision snapshot (writes new snapshot at `currentRev+1`)
- `DELETE /api/sessions/:id/proposal/:type` - clean up after accept

### Revision snapshots

Every successful `propose_*` (`seed`) and `edit_proposal` (`edit`) write also writes an immutable per-rev snapshot alongside the live draft. This makes the chat transcript a navigable timeline: the "Open proposal" button on every `propose_*` and `edit_proposal` tool card restores the panel to *exactly* the revision that existed immediately after that call.

**Why.** Before snapshots, the panel only ever held the latest revision on disk. Users couldn't tell which revision was live, and clicking the *original* propose card after later edits silently re-dispatched the original payload - destroying every later edit. Snapshots make rollback explicit (a real `rev = currentRev + 1` write that appears in the timeline) and reversible.

- **On-disk layout.** Snapshots live under `<stateDir>/proposal-drafts/<sessionId>/<type>.history/<rev>.<ext>`. Filename grammar `^(\d+)\.(md|yaml)$`; integer rev recovered by `readdir` + `parseInt` (no metadata file). Cleaned up with the rest of the per-session draft directory on session terminate - no separate retention logic.
- **Rev counter source of truth.** Server-side, implicit. `latestRev()` scans the history dir; `writeSnapshot` writes `latestRev() + 1`. The server stamps `rev` on every `proposal_update` WS event (`source: "seed" | "edit" | "restore" | "rehydrate"`) - clients overwrite `slot.rev` with the server value, never client-increment.
- **Tool-result marker.** `propose_*` and `edit_proposal` tool extensions append `__proposal_rev_v1__:<n>` to the tool-result text on success. Renderers parse the marker via `proposal-rev-marker.ts::parseRevFromResult` and route the "Open proposal" button through `POST /api/sessions/:id/proposal/:type/restore` `{rev}`. Legacy archived sessions without the marker fall back to the original `{type, fields}` round-trip via the per-type callbacks (graceful degradation).
- **Restore semantics.** `restoreSnapshot` reads snapshot N, validates via the per-type plugin, atomically writes it back to the live draft, AND writes a new snapshot at `currentRev + 1` whose contents equal snapshot N. The rollback itself is therefore a real revision - monotonic counter, no silent state loss.
- **Non-fatal snapshot failures.** Snapshot-write failures (disk full, permission denied) leave the live draft committed and broadcast `rev: 0`. Clients treat `rev: 0` as "snapshot system unavailable" - the panel still renders, but the rev badge and "Open proposal" snapshot path are disabled. Mid-restore crash between live rename and snapshot write is benign: the next write recomputes `latestRev` from the dir and picks the same number, overwriting consistently.
- **Edit failures don't bump rev.** Failed `edit_proposal` calls (any structured error code) leave the file byte-for-byte unchanged and write no snapshot - the rev counter only advances on successful disk writes. The `EditProposalRenderer` shows the error code on failed cards but no "Open proposal" button.
- **Streaming partials don't bump rev.** The dual-fire `_checkToolProposals` streaming path emits in-memory `proposal_update` events from in-flight tool calls; only the gateway-side `seed` POST writes the file. Rev advances exactly once per completed tool call.

Full design (file format, error codes, restore-handler edge cases, test plan): [docs/design/proposal-revision-snapshots.md](design/proposal-revision-snapshots.md).

### Per-type panel testids

Each proposal preview panel exposes `data-panel="<type>-proposal"` for E2E targeting. The project panel keeps its three-view structure (`view-tab-{components|workflows|diff}`) on top of the unified slot - see [Project-proposal panel structure](#project-proposal-panel-structure).

### Inline comments on goal/role/staff proposals

The Preview-mode markdown body of goal, role, and staff proposals is mounted via `<commentable-markdown>` (a thin wrapper around the existing `<review-document>`) so users can select text and attach inline comments without retyping quotes into the chat. Annotations are ephemeral - backed by an in-memory store (`src/ui/components/review/proposal-annotations.ts`) keyed by `(sessionId, "proposal:<type>")`, with no server persistence. They survive Edit↔Preview toggles, but are cleared on dismiss, on `proposal_cleared`, on a `proposal_update` whose body actually changed (offsets won't survive a rewrite), and on reload. A "Send feedback" button composes a quoted-text+comment chat message via `state.remoteAgent.prompt` and clears the bucket. Tool and project proposals are out of scope (YAML / no single markdown body). Full design: [docs/design/proposal-inline-comments.md](design/proposal-inline-comments.md).

### Out of scope

- Diff/undo history of edits. Agents see the latest file contents only.
- Concurrent multi-agent edits to the same proposal (single-session model preserved).
- Refactoring the bespoke per-type preview forms.

### Key files

| Path | Purpose |
|---|---|
| `src/server/proposals/proposal-files.ts` | Atomic file API (`writeProposalFile`, `editProposalFile`, `parseProposalFile`, `deleteProposalFile`). |
| `src/server/proposals/proposal-types.ts` | Per-type plugins: filename, serialize, parse, requiredFields. |
| `src/server/server.ts` | Four REST handlers (regex-routed at `/api/sessions/:id/proposal/:type[/edit\|/seed]`). |
| `src/server/ws/protocol.ts` | `proposal_update` / `proposal_cleared` server messages. |
| `src/server/ws/handler.ts` | Rehydrate-on-attach. |
| `src/server/agent/session-manager.ts::terminateSession` | Per-session directory cleanup. |
| `src/app/proposal-registry.ts` | `ProposalType`, `ProposalSlot`, `ProposalTypePlugin`, `PROPOSAL_TYPE_REGISTRY`. |
| `src/app/proposal-helpers.ts` | Unified draft + dismissal helpers. |
| `src/app/state.ts::activeProposals` | Unified slot map. |
| `src/app/session-manager.ts::remote.onProposal` | Unified WS-driven callback. |
| `src/app/remote-agent.ts` | WS dispatch + legacy `_checkToolProposals` dual-fire. |
| `defaults/tools/proposals/{view,edit}_proposal.yaml` | Tool descriptors. |
| `defaults/tools/proposals/extension.ts` | Tool registration; `propose_*` `execute()` POSTs to `/seed`. |

### Tests

- `tests/proposal-files.test.ts` - unit: write/read/edit/parse/delete round-trip, atomic-rollback, path-traversal rejection.
- `tests/proposal-registry.test.ts` - unit: per-type `mergeFields` and validators.
- `tests/proposal-helpers.test.ts` - unit: unified draft + dismissal.
- `tests/e2e/proposal-edit-api.spec.ts` - API E2E: edit-before-propose, restart survival, malformed-edit rollback (SHA-256 byte-equal pre/post).
- `tests/e2e/ui/proposal-edit-flow.spec.ts` - browser E2E: project propose → edit → accept happy path.
- `tests/e2e/ui/proposal-types-uX-parity.spec.ts` - parametrised across all six types: dismissal stickiness, "Open proposal" reopen, first-emit auto-select, streaming shallow-merge, restart survival.

---

## Read/unread state

The sidebar shows an "unseen activity" dot on sessions that have new activity since the user last looked. Read state is **server-side**: a `lastReadAt` timestamp on each `PersistedSession`, mutated only by the user navigating to a session.

### Why server-side

Read state used to live in `localStorage` (key `bobbit-session-visited`). That broke down in three ways: a fresh browser showed every session as unread; a different device had no idea what the first device had already seen; and clearing site data wiped the entire history. Moving the timestamp into `sessions.json` makes it shared across browsers/devices and survives server restarts - the same durability guarantee as every other piece of session metadata.

The trade-off is that there is no real-time push of read-state changes between open tabs - a second tab learns about the read state on its next refresh of the session list. This is acceptable because read state is per-user, low-stakes, and Bobbit is single-user (one server = one read state).

### Data flow

1. **Server stores** `lastReadAt?: number` on `PersistedSession` (see `src/server/agent/session-store.ts`). It is included in `UpdatableSessionFields` so writes go through the normal `SessionStore.update()` path with disk persistence.
2. **Server exposes** `lastReadAt` in session-list payloads - `GET /api/sessions` (via `listSessions()`) and the archived-sessions list (via `listArchivedSessions()`). The field is threaded through both the live and archived `SessionSummary` shapes in `session-manager.ts`. The single-session `GET /api/sessions/:id` endpoint and the WS `messages` frame (which carries chat transcript, not session metadata) do not include `lastReadAt` - the client only needs it for the sidebar list, which is hydrated from the list endpoint.
3. **Client computes unseen-ness locally** in `src/app/render-helpers.ts::hasUnseenActivity` by comparing `session.lastActivity > (session.lastReadAt ?? 0)`. No round-trip is needed to render the dot.
4. **On navigation**, the sidebar calls `markSessionVisited(sessionId)` which (a) updates an in-memory mirror so the dot disappears on the very next render, and (b) fires `POST /api/sessions/:id/mark-read` so other browsers learn on their next refresh. The endpoint is backed by `SessionManager.markSessionRead`, which uses `resolveStoreForId` so live, dormant, and archived sessions are all markable.

### Display rules

Two invariants live in `hasUnseenActivity` and must be preserved by any future refactor:

- **The active session is never "unseen".** Otherwise the user would see a dot on the very session they are looking at.
- **The dot only surfaces when a human is actually needed.** The shared `needsHumanAttention` predicate in `src/app/notification-policy.ts` is the gate. Team members and delegates never surface; a team lead surfaces only when the goal is `complete` or the lead is stuck (no live downstream work and no in-flight verification). The same predicate also gates the polling beep in `src/app/api.ts` and the active-session `agent_end` beep in `src/app/remote-agent.ts`, so the three surfaces can't drift. See [design/notification-policy.md](design/notification-policy.md).

### Legacy localStorage migration

Existing users have a `bobbit-session-visited` map in `localStorage` from before the server-side feature. `migrateLegacyVisitedMap` in `src/app/render-helpers.ts` is invoked once post-auth from `src/app/main.ts`: it POSTs `mark-read` for each entry, then deletes the localStorage key. The migration is idempotent - re-running it is a no-op once the key is gone - and non-fatal: a network error leaves the legacy key intact for a retry on the next load. New users never have the key and skip the migration entirely.

### `lastActivity` preservation across restart

`lastReadAt` is only useful if `lastActivity` is itself trustworthy across a server restart. The persisted timestamp on disk is correct, but three paths in `session-manager.ts` install rpc-event listeners that mutate `session.lastActivity` after re-attaching to a fresh `RpcBridge`:

- `restoreSession()` - server startup restores persisted sessions concurrently (CONCURRENCY=5).
- The role-restart path - swaps the bridge after a role change.
- The abort-restart path (`restoreFromAbort`) - swaps the bridge after a force-abort.

All three bridges emit `switch_session` history replay frames followed by lifecycle frames on resume (`agent_start`, `agent_idle`, `connection_state`, `state`, `session_title`, etc.). Without a guard, every one of those frames would call `session.lastActivity = Date.now()` and clobber the persisted value. The original guard - a `restoring` / `switchingSession` flag flipped to `false` after `switch_session` resolves - was insufficient because lifecycle frames continue to fire after the flag clears, and under concurrent restore every restored session ended up clustered at restart time with identical timestamps.

**Single source of truth**: the exported helper `isUserVisibleActivity(event)` at the top of `src/server/agent/session-manager.ts`. It returns `true` only for events that represent real new turn activity:

- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_end`
- `agent_end`

Everything else returns `false`, including all lifecycle frames, `auto_compaction_*`, `process_exit`, container `died`/`recovered` events, and `gate_verification_*` frames. All three rpc-event listeners now wrap the `session.lastActivity = Date.now()` bump in `if (isUserVisibleActivity(event))`. The pre-existing `restoring` / `switchingSession` flags are retained for cost-tracking but no longer relied on for `lastActivity`. The dormant-session path (`addDormantSession`) preserves `ps.lastActivity` directly and is unaffected.

Locked by `tests/session-restore-last-activity.test.ts` - source-scan assertions verify all three sites import the helper, and behavioural tests verify (a) lifecycle frames don't bump, (b) real activity does bump, and (c) concurrent restore of N sessions with widely-varied pre-restart timestamps does not cluster them.

### Client must not mutate `lastActivity`

The server is the **sole writer** of `lastActivity`. The client receives it on `GET /api/sessions` (polled ~every 5s) and must treat it as read-only. In particular, `updateLocalSessionStatus()` in `src/app/api.ts` - invoked from the `session_status` WS handler in `src/app/session-manager.ts` - must update `status` only and leave `lastActivity` alone.

Why: `session_status` frames fire on every real transition **and** on the 15s status heartbeat (see [design/unify-session-status.md](design/unify-session-status.md)). If the client bumped `lastActivity` on each frame, `hasUnseenActivity()` would flip true on every heartbeat (because `lastActivity > lastReadAt`) and `terseRelativeTime()` would render "now", giving the sidebar a spurious unread dot on idle sessions roughly every 15 seconds. The next `/api/sessions` poll reconciles within ~5s, but the heartbeat re-triggers the bug indefinitely. The poll-driven 5s lag is invisible at sidebar granularity (`terseRelativeTime` bucket is 60s).

Locked by `tests/spurious-idle-unread.spec.ts`.

### Key files

| File | Role |
|---|---|
| `src/server/agent/session-store.ts` | `PersistedSession.lastReadAt` field + `UpdatableSessionFields` entry |
| `src/server/agent/session-manager.ts` | `markSessionRead()`; `lastReadAt` in `SessionSummary` payloads; `isUserVisibleActivity()` filter applied at `restoreSession`, role-restart, and abort-restart event listeners |
| `src/server/server.ts` | `POST /api/sessions/:id/mark-read` route |
| `src/app/state.ts` | `GatewaySession.lastReadAt` |
| `src/app/render-helpers.ts` | `markSessionVisited`, `hasUnseenActivity`, `migrateLegacyVisitedMap` |
| `src/app/notification-policy.ts` | `needsHumanAttention` — shared predicate consulted by the unread dot, the polling beep, and the active-session `agent_end` beep |
| `src/app/main.ts` | One-shot migration trigger post-auth |
| `tests/session-store.test.ts` | Disk round-trip for `lastReadAt` |
| `tests/session-manager-restore.test.ts` | Replay events don't bump `lastActivity`; post-restore events do |
| `tests/session-restore-last-activity.test.ts` | `isUserVisibleActivity` filter at all three restore sites; concurrent-restore non-clustering |
| `tests/e2e/ui/unseen-activity.spec.ts` | Read state survives reload after `localStorage` cleared |

---

## Archived-session state push on auth

Loading an archived session needs to show its real model in the footer on first connect. The original code path sent `auth_ok`, `session_status`, and `session_title` on the archived branch but no `state` frame - the model only arrived if the client later sent `get_state`. Since the client only sends `get_state` on reconnect (not on initial connect), the footer kept showing the client-side placeholder (`claude-opus-4-6`) until a manual reload.

### Helper and call sites

`buildArchivedStateData(archived, sessionManager, sessionId)` in `src/server/ws/handler.ts` returns the data block for `{ type: "state", data }` and is the single source of truth for archived state shape. Two call sites:

- **Archived auth-ok branch.** Right after `session_title`, the handler builds the payload and sends it. This is the fix - the footer now reads the persisted model on first connect, with no round-trip required.
- **Legacy `get_state` handler.** The same helper drives the response, so the reconnect path stays consistent with first-connect.

The payload mirrors `sendFallbackModelState`: `model.{provider, id, contextWindow, maxTokens, reasoning}` from `inferMeta(archived.modelId)`, plus `imageGenerationModel` from `sessionManager.getImageModelForSession(sessionId)`. Persisted `modelProvider`/`modelId` come from the archived row in the session store.

The footer model picker remains read-only/disabled for archived sessions - the push only seeds the displayed model, it does not enable editing. UI test hooks `data-testid="footer-model-id"` on the model name span and `window.__bobbitState` (set in `src/app/main.ts`) make the seeded value inspectable from `tests/e2e/ui/archived-session-model.spec.ts`.

Client-side, the `claude-opus-4-6` placeholder default in `src/app/remote-agent.ts` is unchanged - it only matters before the server `state` frame arrives, which is now immediate.

---

## Tool access policies

All tool access uses a **grant policy** system enforced by a single `tool_call` guard extension. Every tool resolves to one of three policy values:

| Policy | Behavior |
|---|---|
| `allow` | Tool executes immediately, no prompt. |
| `ask` | Guard blocks execution; UI prompts user for permission. |
| `never` | Tool is not registered - invisible to the agent. |

### Why a guard extension?

Earlier versions used a fragile multi-layered approach: stub extensions raced against real extensions using first-registered-wins semantics, error regex matching detected denials after the fact, and leaked tool detection was needed because shared extensions (e.g. a single `shell/extension.ts` that registers both `bash` and `bash_bg`) bypassed allowedTools filtering. The guard extension replaces all of that with a single interception point - pi-coding-agent's `tool_call` event hook fires before every tool execution and supports `{ block: true }` to prevent it.

### How the guard works

1. At session setup, `writeToolGuardExtension()` generates a TypeScript extension containing a map of all `ask`-policy tools and the session's pre-existing grants.
2. The extension registers a `pi.on("tool_call", ...)` handler that intercepts every tool invocation.
3. For `allow` tools (or tools already granted), the handler returns immediately - no blocking.
4. For `ask` tools without a grant, the handler POSTs to `POST /api/sessions/:id/tool-grant-request` (long-poll). The gateway broadcasts a `tool_permission_needed` WebSocket message to all connected clients, and the HTTP request blocks until the user responds.
5. The UI shows a grant dialog. The user can grant (with a duration choice) or deny.
6. On grant: the gateway resolves the long-poll with `{ granted: true }`. The guard adds the tool to its in-memory grant set so future invocations pass through.
7. On deny: the gateway resolves the long-poll with `{ granted: false, reason: "..." }`. The guard returns `{ block: true, reason }` and the agent sees a tool error.
8. `never` tools are never registered with the agent, so no `tool_call` event fires for them - the guard is not involved.

**Key files:** `tool-guard-extension.ts` (generates the guard), `tool-activation.ts` (`writeToolGuardExtension`, `computeToolPolicies`), `tool-group-policy-store.ts`, role YAML `toolPolicies`, tool YAML `grantPolicy`.

### Grant duration

Grant duration is chosen by the user at grant time, not configured in policy YAML. The grant dialog offers three options:

| Duration | Effect |
|---|---|
| **Always** (permanent) | Tool is added to the role's `toolPolicies` as `allow` - persists across sessions. |
| **This session** | Grant stored in the session's in-memory grant set - lasts until session ends. |
| **Just this once** | Grant is consumed immediately - the guard will prompt again on the next invocation. |

This replaces the old `ask-once` / `always-ask` distinction, which conflated "should this tool require a grant?" with "how long should the grant last?"

### Grant and deny protocol

**WebSocket messages:**
- `tool_permission_needed` (server → client): `{ toolName, group, roleName, roleLabel, lastPromptText? }`
- `grant_tool_permission` (client → server): `{ toolName, scope: "tool" | "group", group?, mode?: "persistent" | "session-only" | "one-time" }`
- `deny_tool_permission` (client → server): `{ toolName }`

**REST endpoint:**
- `POST /api/sessions/:id/tool-grant-request` - called by the guard extension (long-poll). Body: `{ toolName, toolGroup }`. Blocks until the user grants or denies. Returns `{ granted: boolean, reason? }`.

### Policy resolution cascade

Resolution order is unchanged (first non-null wins):

1. `role.toolPolicies["<tool-name>"]` - per-tool override on role
2. `role.toolPolicies["<group>"]` - per-group override on role
3. `tool.grantPolicy` - tool YAML default
4. Group default - `defaults/tool-group-policies.yaml` (builtin), overridden by `.bobbit/config/tool-group-policies.yaml` (server/project)
5. System fallback - `allow`

### MCP groups default to `allow`

MCP server groups behave identically to built-in tool groups: with no override anywhere, they fall through to the system `allow` fallback. `defaults/tool-group-policies.yaml` deliberately ships **no** `mcp__*` entries.

Why no MCP-specific builtin denials: the Tools page renders the cascaded effective policy but cannot show its origin, so a builtin `mcp__<server>: never` would display as "Allow (default)" while silently blocking every agent call — the UI must be honest. A user who wants to block a server does so explicitly via the Tools page (or `.bobbit/config/tool-group-policies.yaml`), and the dropdown then reflects reality.

Disruptive servers (e.g. headed Chromium from `@playwright/mcp`) are opted out at the **role** layer instead — see `defaults/roles/qa-tester.yaml`, which sets `toolPolicies: { mcp__playwright: never }`. Roles that need the tool inherit the `allow` default; roles that shouldn't have it block it locally.

### REST API

- `PUT /api/roles/:name` - accepts `toolPolicies` (Record of tool/group name → `allow` | `ask` | `never`)
- `PUT /api/tools/:name` - accepts `grantPolicy`
- `GET /api/tool-group-policies` - all group default policies
- `PUT /api/tool-group-policies/:group` - set/clear group default (`{ policy: "allow" | "ask" | "never" | null }`)
- `POST /api/sessions/:id/tool-grant-request` - guard extension long-poll endpoint

### Migration from legacy policy values

Legacy policy values are normalized on load:

| Legacy value | New value |
|---|---|
| `always-allow` | `allow` |
| `ask-once` | `ask` |
| `always-ask` | `ask` |
| `never-ask` | `never` |

This happens transparently in `normalizeGrantPolicy()` - existing role YAML and tool YAML files with old values continue to work. The `allowedTools` array on roles is a computed getter derived from `toolPolicies` for backward compatibility - it includes only `allow`-policy tools (not `ask` or `never`).

> **Important:** Session creation must not use `role.allowedTools` directly to determine which tools are active, because that excludes `ask`-policy tools entirely. Instead, `server.ts` calls `computeEffectiveAllowedTools()` from `tool-activation.ts`, which returns both `allow` and `ask` tools. This ensures `resolveToolActivation()` in the session setup pipeline sees the full set and generates the guard extension for `ask`-policy tools. Without this, roles with only `ask` policies would produce sessions with no tool guard - the agent could use guarded tools without user approval.

> **Activation flag contract (pi 0.70+).** `computeToolActivationArgs()` emits `--no-builtin-tools` + `--no-extensions` + an explicit `--extension <…>/defaults/tools/_builtins/extension.ts` with `env.BOBBIT_BUILTIN_TOOLS` carrying the sorted list of pi file-builtins to re-register. The shape is pinned by `tests/tool-activation-contract.test.ts` (unit, seconds) and end-to-end by `tests/manual-integration/agent-tool-use.spec.ts`. Background and the diagnostic flow live in [docs/debugging.md — Agent silently substitutes file tools](debugging.md#agent-silently-substitutes-file-tools-when-prompted-for-bash--web--mcp) and [docs/testing-coverage.md — Agent tool-use canary](testing-coverage.md#agent-tool-use-canary-two-layers).

---

## Per-role model & thinking-level overrides

Roles can pin a specific model and reasoning level for any session that runs under them, independent of the global defaults. This solves the common case of "my `code-reviewer` role should always run on opus, but my `coder` role can stay on the cheaper default" - without forcing users to change `default.sessionModel` or remember to override the model manually each time a verification step spawns.

This is the third role-level override, alongside `toolPolicies` (which tools the role can use) and `defaultPersonalities` (how the role communicates). All three cascade the same way and are edited from the same role-manager page.

> **Authoritative design:** [docs/design/per-role-model-overrides.md](design/per-role-model-overrides.md) - file-level mechanics, validators, and the rationale behind splitting `applyModelString` from `applyReviewModelOverrides`.

### Role fields

Two optional fields on the `Role` interface in `role-store.ts`:

| Field | Type | Meaning |
|---|---|---|
| `model` | `"<provider>/<modelId>"` | Same shape as `default.sessionModel` (e.g. `anthropic/claude-opus-4-1`). Empty/missing = inherit. |
| `thinkingLevel` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | Same value space as the global thinking selector. `xhigh` is only honoured on models that support it (Opus 4.6+, gpt-5.1-codex-max, gpt-5.2*) — unsupported levels are clamped down at use-time. Empty/missing = inherit. See [Per-model thinking-level capabilities](thinking-levels.md). |

`parseRole` and `serializeRole` round-trip both fields and omit them from YAML when unset ("absent" and "empty string" are equivalent on the wire). Malformed values (e.g. `model: "no-slash"`, `thinkingLevel: "weird"`) are silently dropped at parse time so a typo never breaks role loading; the API layer rejects them with 400 so the UI surfaces the error.

### Cascade

The generic `resolve<T>()` machinery in `config-cascade.ts` handles these fields automatically - no changes were needed in the cascade itself. Project-level role YAML > server-level > builtin, by whole-record replacement (not field-level merge). This is the same precedence as `toolPolicies` and is the documented contract: a project role with `model` set replaces the entire server role record, including its `thinkingLevel` if any.

### Precedence at session start

When a session starts, the model and thinking level are resolved in this order (highest wins):

1. **Explicit per-session override** - the user picking a model in the composer mid-run, or callers passing `skipAutoModel: true` after pre-binding (e.g. delegate sessions with an explicit model arg).
2. **Role override** - `role.model` / `role.thinkingLevel` from the resolved cascade.
3. **Global defaults** - `default.sessionModel` / `default.sessionThinkingLevel` (or the AI-Gateway best-ranked fallback when no pref is set).

Layers 2 and 3 live in `tryAutoSelectModel` and `tryApplyDefaultThinkingLevel` in `session-manager.ts`. The role layer was added as a new step 0 inside both functions and binds via the `applyModelString` helper exported from `review-model-override.ts` - the same retry-and-verify path `applyReviewModelOverrides` uses, but reading a literal `<provider>/<modelId>` string instead of a prefs key.

**Failure handling.** Model binding failures throw - the session start fails loudly with the same red "Unavailable" pattern you see in Settings → Models. Thinking-level failures only `console.warn` and fall through to the global default, matching the existing tolerance for level mismatches.

### Verification harness integration

The verification harness spawns reviewer, QA, and sub-session agents for gate steps, each tied to a specific role. At all three call sites in `verification-harness.ts`, the harness now resolves the role through the cascade and prefers `role.model` / `role.thinkingLevel` over `default.reviewModel` / `default.reviewThinkingLevel`. When the role has no override, the existing `applyReviewModelOverrides` path runs unchanged.

This is what makes "my `code-reviewer` role always runs on opus" work without changing `default.reviewModel` and without leaking that choice to every other reviewer step.

**Naming model is explicitly unaffected** - `default.namingModel` and `pickFallbackAigwNamingModel` still drive title generation regardless of role.

### UI

The role-manager page (`src/app/role-manager-page.ts`) has a third tab next to **Prompt** and **Tool Access**, labelled **Model**. It reuses the model picker and thinking dropdown components from the settings page, with a leading "(use default)" option that maps to the empty string → omitted from YAML. The standard origin badge / Customize / Revert flow operates on the whole role record, so touching either field flips builtin→overridden and Revert clears them along with any other overrides.

---

## Spawn-time model pinning

Without spawn-time pinning, every session emitted two `model_change` events at startup - pi-coding-agent booted with its CLI default (`anthropic/claude-opus-4-7`) and Bobbit then called `setModel` ~13 ms later - which transiently flashed the wrong model in the footer and was easy to mistake for a model-binding bug.

Agent processes are now spawned with the desired model and reasoning level passed as CLI flags, so the pi-coding-agent boot binds directly to the right model and emits a single `model_change` event. The legacy path - boot with the CLI default, then call `setModel` post-spawn - still runs as a fallback for cases where the model is not yet resolvable at spawn time (chiefly the aigw cold-cache discovery path).

### Bridge options and CLI flags

`RpcBridgeOptions` in `src/server/agent/rpc-bridge.ts` carries two optional fields:

- `initialModel?: string` - literal `<provider>/<modelId>`.
- `initialThinkingLevel?: string` - one of `off|minimal|low|medium|high|xhigh`. The level is clamped against the resolved model before injection — see [Per-model thinking-level capabilities](thinking-levels.md) for the rules.

`buildAgentArgs(options)` in the same file translates them to `--model <provider>/<modelId>` and `--thinking <level>` and prepends them to the agent argv. Malformed values (no `/`, unknown level) are silently dropped - the post-spawn helpers will still bind correctly.

### Resolution helpers

`SessionManager.resolveInitialModel(role, projectId)` and `resolveInitialThinkingLevel(role, projectId)` mirror the precedence used at session start:

1. Role override (`role.model` / `role.thinkingLevel` from the resolved cascade).
2. `default.sessionModel` / `default.sessionThinkingLevel` preference (or `default.reviewModel` for verification sub-sessions).
3. `undefined` - the aigw best-ranked fallback runs post-spawn via `tryAutoSelectModel` and emits a second `model_change` only on a cold cache.

`resolveBridgeOptions` in `src/server/agent/session-setup.ts` is the single call site for the normal-create pipeline; `session-manager.ts` re-runs the helpers at the role-respawn and force-abort respawn sites; `verification-harness.ts` does it at all three reviewer/QA sub-session sites; `server.ts` does it at the continue-archived endpoint. The pinned values are stored on `session.spawnPinnedModel` and `session.spawnPinnedThinkingLevel`.

`SessionSetupPlan` exposes two parallel fields naming the same role — `role` and `roleName` — because callers were added at different times and never converged. `team-manager.spawnRole`, `startTeam` for the team lead, and `staff-manager` pass only `roleName`; the verification harness and respawn paths pass `role`. `_resolveBridgeOptions` therefore resolves overrides from `plan.role ?? plan.roleName` (and `spawnAgent` / `persistOnce` mirror the same fallback when populating `session.role`, so the post-spawn `tryAutoSelectModel` safety net keys off the right id). Collapsing the duality into a single field is a separate refactor; until then, new spawn sites should set `roleName` and rely on the fallback rather than re-introducing it elsewhere.

### Skip-setModel branch preserves hard-fail-on-mismatch

`applyModelString` and `applyReviewModelOverrides` in `src/server/agent/review-model-override.ts` accept `skipSetModel?: boolean`. When `true`, the helper skips the `setModel` RPC but still calls `rpc.getState()` and throws on mismatch - the same contract as the unconditional `setModel` path. `tryAutoSelectModel` / `tryApplyDefaultThinkingLevel` and the three verification sub-session sites set `skipSetModel: true` exactly when `session.spawnPinnedModel` equals the model they would otherwise bind. Net effect: the read-back verification still runs, but the redundant `setModel` RPC (and its `model_change` event) is elided.

### Pool-claimed sessions

The worktree pool (`src/server/agent/worktree-pool.ts`) pre-creates **git worktrees only** - it does not pre-spawn agent processes. When a session claims a pool worktree, `executeWorktreeAsync` in `session-setup.ts` runs the same `resolveBridgeOptions` → `new RpcBridge(plan.bridgeOptions)` sequence as a non-pool spawn, so `initialModel` is injected and `session.spawnPinnedModel` is populated identically. Spawn-time pinning therefore applies to pool-claimed sessions too - there is no special pool path that emits two `model_change` events. The remaining two-event case is the aigw cold-cache discovery fallback, where the model is not resolvable at spawn time.

### Out of scope

- The client-side placeholder default (`anthropic/claude-opus-4-6`) seeded in `src/app/remote-agent.ts` until the first server `state` frame arrives. Replacing it with `null` would require auditing every `state.model` consumer.
- Patching pi-coding-agent to suppress its own initial `model_change` when spawned with `--model`. The current behaviour is benign - the event simply matches the bound model.

### Key files

| File | Role |
|---|---|
| `src/server/agent/rpc-bridge.ts` | `RpcBridgeOptions.initialModel`/`initialThinkingLevel`, `buildAgentArgs` |
| `src/server/agent/session-setup.ts` | `resolveBridgeOptions` injects pinned values into `bridgeOptions`; persists them onto the session |
| `src/server/agent/session-manager.ts` | `resolveInitialModel` / `resolveInitialThinkingLevel`; `tryAutoSelectModel` / `tryApplyDefaultThinkingLevel` skip-setModel branch; respawn pinning |
| `src/server/agent/review-model-override.ts` | `applyModelString` / `applyReviewModelOverrides` `skipSetModel` flag with read-back retained |
| `src/server/agent/verification-harness.ts` | Pre-resolves model at all 3 sub-session spawn sites; passes `skipSetModel: true` post-spawn when matched |
| `src/server/server.ts` | Continue-archived endpoint pre-resolves model before `createSession` |
| `tests/rpc-bridge-spawn-args.test.ts` | Asserts `--model` / `--thinking` flag injection |
| `tests/review-model-override.test.ts` | Covers the `skipSetModel` read-back contract |

---

## AI Gateway per-session header (`x-opencode-session`)

When Bobbit talks to an on-prem model through the AI Gateway, the gateway's token caches are keyed per upstream caller. Without a per-session discriminator every Bobbit session would share one cache bucket, so cache hits collapse and the gen-AI team's routing loses its signal. To partition cleanly, every aigw request carries an `x-opencode-session: <bobbit-session-id>` header - or, when no session id is available, **no header at all**. A constant fallback would defeat the whole point: it would re-collapse buckets onto a single key.

### Where it's emitted

`writeAigwModelsJson` in `src/server/agent/aigw-manager.ts` writes `~/.bobbit/agent/models.json`. The `aigw` provider entry now carries a provider-level `headers` block:

- Key: `x-opencode-session`.
- Value: a pi-coding-agent `!cmd` resolver expression that runs `node -e "process.stdout.write(process.env.BOBBIT_SESSION_ID || '')"`.

Provider-level (not per-model) is deliberate - it covers every `openai-completions` model the aigw exposes without the file having to enumerate them. Claude entries in the same file use `api: "bedrock-converse-stream"`, whose pi-ai 0.67.5 driver does not honour `model.headers`; that's fine, on-prem routing only matters for the openai-completions path.

### Startup refresh of `models.json`

On every gateway startup, `startupAigwCheck` in `src/server/agent/aigw-manager.ts` re-runs the aigw setup so `~/.bobbit/agent/models.json` doesn't drift between restarts. When aigw is already configured, it sets the Bedrock env vars and then calls `discoverAigwModels(existingUrl)` followed by `writeAigwModelsJson(existingUrl, models)` - which rewrites the file with the freshly-discovered model list and the provider-level `x-opencode-session` `headers` block, while preserving user `modelOverrides` and any non-aigw providers (the writer already merges these). The practical effect: new gateway-side models, and the header block for users whose `models.json` predates that feature, are picked up automatically without anyone having to re-configure aigw from Settings.

If the gateway is unreachable at startup (network error / HTTP failure / timeout), the function logs `[aigw] gateway unreachable on startup (<msg>), keeping existing models.json` and leaves the file untouched - staleness is preferred to wiping a working file with a stub. The `BOBBIT_SKIP_AIGW_DISCOVERY=1` test/CI escape hatch skips only the network call: when aigw is already configured, the Bedrock env vars are still applied and the existing `models.json` is kept as-is. The not-configured branch (auto-probing for a local gateway) is unchanged.

### Resolver semantics (pi-coding-agent contract surface)

The pi-coding-agent CLI evaluates header values via `resolveConfigValue` (in `dist/core/resolve-config-value.js`):

- A plain string `"X"` falls back to `process.env["X"] || "X"` - i.e. it can leak the literal key name. **Unsafe for our requirement.**
- A `"!cmd"` string runs `cmd` via `child_process.exec` (shell-interpreted) and returns the trimmed stdout, or `undefined` when stdout is empty.
- `resolveHeaders` (in `dist/core/model-registry.js`) drops any header whose resolved value is falsy.

So the `!node -e ...` form gives us exactly "send the header iff `BOBBIT_SESSION_ID` is set to a non-empty value, otherwise omit it." That is the only behaviour we want.

### Per-session env injection

Every agent-CLI spawn path (`session-setup.ts`, `session-manager.ts`, the rpc-bridge child spawn) injects `BOBBIT_SESSION_ID=<sessionId>` into the subprocess env. Each Bobbit session owns its own subprocess with its own env, so values are correctly partitioned at the OS level and never leak across sessions.

### Performance: one shell exec per session, not per request

`resolveConfigValue` caches `!cmd` results in a module-level `commandResultCache` `Map` keyed by the command string. The first LLM request in a session pays a one-time ~50 ms `node -e` startup; every subsequent request in that same subprocess reuses the cached value. Because each Bobbit session spawns its own agent subprocess, the cache is naturally per-session - no cross-contamination, no repeated process spawns within a session.

### Cross-shell quoting

`child_process.exec` runs the command through `cmd.exe` on Windows and `/bin/sh` on POSIX. The chosen quoting - outer `"` for the JS argument, inner `'` for the empty-string default - is interpreted identically by both shells (cmd.exe and sh both treat `''` as an empty string literal in this position). The JSON-encoded value in `models.json` is `"!node -e \"process.stdout.write(process.env.BOBBIT_SESSION_ID || '')\""`.

### Out of scope

- The `/api/aigw/v1/*` passthrough proxy used for UI model-list/test calls - it never carries a session id and isn't on the request path that needs cache routing.
- The title generator and other one-shot gateway calls - single-call, no cache benefit.
- Bedrock/Claude routing - driver ignores `model.headers`, and on-prem models don't route to Bedrock anyway.
- Custom local providers configured outside the aigw block - the `headers` block is scoped to the `aigw` provider entry only.

---

## Semantic search

Lexical search over goals, sessions, messages, and staff. One embedded index per project; everything runs locally with **no runtime network calls and no native binaries**.

> **Authoritative design:** [docs/design/portable-search.md](design/portable-search.md) - this section is the quick reference; the design doc is the source of truth for schema, ranking, and rationale. The earlier [docs/design/semantic-search.md](design/semantic-search.md) covers the previous Nomic+LanceDB architecture and is kept for historical context only.

### Why this shape

Bobbit must install and run anywhere - including network-restricted environments. The previous stack (Nomic embeddings + LanceDB) pulled in `@huggingface/transformers`, `onnxruntime-node`, `sharp`, and platform-specific Rust binaries, plus a ~140-500 MB model download on first search. Any of those can fail in an airgap.

The current engine is **[FlexSearch](https://github.com/nextapps-de/flexsearch)** - a pure-JS, zero-dependency full-text index library. One backend, one code path, no native compilation, no postinstall network work, no model cache. Natural-language "fuzzy meaning" queries are weaker than an embedding model; identifier/keyword search is **better** because strict tokenization ranks exact symbol matches first.

### Store

- **FlexSearch `Document` index** - one per project at `<project-root>/.bobbit/state/search.flex/`.
  - `index/<key>.json` - one file per FlexSearch export key (posting lists, document registry, tag index, cache).
  - `meta.json` - engine name/version, schema version, content policy version, last rebuild timestamp.
- Multi-field document schema: natural-language fields (`title`, `text`) use forward-prefix tokenization with stemming; an `identifier_text` field uses strict tokenization for exact-symbol matches (camelCase, snake_case, dotted paths all indexed as decomposed tokens).
- Persistence is export/import via FlexSearch's built-in serializer, written per-key with an atomic `.tmp` → rename and a trailing-edge debounce. Crash-mid-write leaves `.tmp` files that the loader skips on next open.
- Meta mismatch on startup triggers a full rebuild from the source-of-truth stores. Fields checked: `engine`, `engineVersion`, `schemaVersion`, `contentPolicyVersion`.

### Abstractions

The surface in `src/server/search/types.ts` that downstream code sees is unchanged from the previous backend, so v2 work (e.g. file indexing) drops in without a refactor:

- **`IndexSource`** - `iterate(ctx)` and optional `watch(ctx)`. Goals, sessions, messages, staff today. File indexing arrives via the same interface; `sources/files-source.stub.ts` ships as a reference shape.
- **`Indexable`** - uniform shape handed to the indexer: `id`, `sourceId`, `text`, `metadata`, `contentHash`, `weight`, `role`, optional `display`.
- **`SearchQuery`** / **`SearchResult`** / **`SearchResults`** - caller-facing query and result shapes.

`SearchService` (`search-service.ts`) is the per-project facade that bundles `FlexSearchStore`, `Indexer`, and the source array. `ProjectContext` constructs and owns one per project. No embedder component exists.

### Content policy (role-aware weighting)

What gets indexed per message matters more than the store choice. `content-policy.ts` (replaces the old `message-extractor.ts`) extracts role-tagged entries with weights applied as post-rank multipliers:

| Role | Weight | Text indexed |
|---|---|---|
| `title` (session title) | 3.0 | full |
| `spec` (goal spec) | 2.5 | `title + spec` |
| `user` (user message) | 2.0 | full |
| `profile` (staff profile) | 1.5 | `name + description` |
| `assistant` (assistant text) | 1.0 | `<thinking>...</thinking>` stripped before embedding |
| `tool_call` | 0.8 | `<tool_name> + first line of input` |
| `tool_result` | 0.5 | first 500 chars; **hard-skipped if raw >32KB** (aligns with `truncate-large-content.ts`) |

Bump `CONTENT_POLICY_VERSION` when the policy changes - the meta-mismatch check auto-rebuilds. Weights are tunable server-side without re-indexing the content itself.

### Chunking

`chunker.ts` splits overlong text into bounded chunks with overlap using an approximate-token counter (~4 chars/token). Chunk IDs follow `<parentId>:chunk:<n>` and the `parent_id` field stores the pre-chunk id. The store collapses by `parent_id` after ranking - one result per logical entity, keyed to the best-scoring chunk. Chunking remains because BM25 prefers bounded documents; exact token counts no longer matter (there is no embedding context window).

### Ranking

BM25-style lexical scoring across three indexed fields (`identifier_text`, `title`, `text`) with per-field boost (identifiers outrank titles, titles outrank body text). The final score is `fieldScore × doc.weight × recencyMultiplier`, where `weight` is the role-aware content-policy multiplier and `recencyMultiplier` decays recent-content bias to 1.0× over a 30-day half-life. Results are then collapsed by `parent_id` and the window sliced by `offset`/`limit`. Filters (`projectId`, `archived`, `types`) apply via FlexSearch tag filters. Snippet rendering in `snippet.ts` uses the same `<b>` contract - `search-page.ts` consumes an unchanged result shape.

### Orphan filtering & stale-click safety net

Search indexes lag behind deletes - a goal, session, or staff record can be removed between the index write and the next query, and the user ends up clicking a result that goes nowhere (blank goal dashboard, `SESSION_NOT_FOUND` modal, blank staff form). Two layers catch this:

- **Server-side orphan filter** (`ProjectContextManager.searchAll()` in `src/server/agent/project-context-manager.ts`): after merging per-project results, each hit is checked against the authoritative stores - `projectRegistry.has(projectId)`, `goalStore.get(id)` (live or archived), `sessionManager.getPersistedSession(id)` (live/dormant/archived), `staffStore.get(id)`. Hits that fail the check are dropped, `total` is recomputed from the filtered list (so Load More's remainder is honest), and a fire-and-forget opportunistic cleanup removes the stale rows from the owning project's `SearchService` (`removeGoal` / `removeSession` / `removeMessagesForSession` / `removeStaff`). The response does not wait on cleanup. This complements - does not replace - the Maintenance → Orphaned Index Rows scanner.
- **Weak-match tagging** (`toSearchResult()` in `src/server/search/flex-store.ts`): every `SearchResult` carries `matchedOn: "text" | "metadata"` based on whether the sanitized snippet contains a `<b>` highlight. `message` rows with `matchedOn === "metadata"` are phantom matches (token hit metadata only - the user can't see why) and are dropped in the same post-filter pass. Goal/session/staff weak-matches are kept (the match is real - the highlighter's window just didn't land on the token) and rendered with a muted "matched on title/metadata" note. Field is optional for back-compat; legacy clients treat an absent value as `"text"`.

### Grouped search results & stale-click toast

The full search page (`src/app/search-page.ts`) runs a purely client-side transform over the flat `SearchResult[]` into `ResultGroup` cards via `buildGroups()`: one card per unique goal / session / staff (staff are standalone; messages nest under their session; goals/sessions/staff render as peer top-level cards to keep nesting at two levels max). The collapsed card header carries up to two `<b>`-highlighted snippet fragments and a match-count pill; the chevron button toggles a per-render `_expanded` set (keyed by `kind:id`, not persisted across reloads); groups with `totalMatches === 1` auto-expand. The client-side type-filter runs *before* grouping so pill counts stay honest.

A click can still race a concurrent delete (entity existed at query time, gone at click time). Rather than bubble that up as a blocking `showConnectionError` modal or a blank dashboard, navigation from the search page is origin-tagged:

- `connectToSession(id, true, { onMissing: "toast" })` in `src/app/session-manager.ts` - on `SESSION_NOT_FOUND` / WS close code 4005, skip the modal and dispatch `window.dispatchEvent(new CustomEvent("search-result-stale", { detail: { kind, id } }))`.
- `src/app/goal-dashboard.ts` - on a 404 from the dashboard loader, dispatch the same event when the previous hash was `#/search`.
- `src/app/staff-page.ts` - same pattern for missing staff ids.

`search-page.ts` listens for `search-result-stale`, shows an inline 5s auto-dismiss toast, and marks the corresponding row with muted opacity + a "stale" badge. Non-search callers of `connectToSession` keep the default `onMissing: "modal"` behavior unchanged.

### Graceful degradation

Failure is surfaced as the **red status dot** + "Search unavailable" - never a silent partial mode. There is only one disabled path now (catastrophic store failure, e.g. the state dir is unwritable); `/api/search` returns **503** with `{ error: "search-unavailable", reason, state }`. See [docs/design/portable-search.md §10](design/portable-search.md) for the state machine (`initializing` → `ready` → `disabled` → `closed`).

### Re-indexing triggers

- **Incremental** (continuous, invisible): new messages, goal/session/staff create/edit/rename/archive → upsert via `SearchService.indexX(entity)`. Incremental upsert skips unchanged rows via `contentHash` comparison.
- **Full rebuild** (rare): first boot on a project with no `search.flex/` directory, meta mismatch (engine upgrade, schema version bump, content-policy version bump), index fails to load, or user clicks **Rebuild Index** in Settings. Runs in the background; status dot goes yellow.
- **Legacy cleanup:** on first open under the current engine, a stale `search.lance/` directory from the previous backend is deleted. The shared model cache at `~/.bobbit/models/` (from the earlier Nomic embedder) is no longer used - users can `rm -rf ~/.bobbit/models` to reclaim disk; Bobbit does not touch it automatically.

### WebSocket events

Added to `ServerMessage` in `ws/protocol.ts`, broadcast per-project and debounced at 500ms:

- `index:progress` - `{ phase: "rebuild"|"incremental", total, completed, backlog }`
- `index:complete` - `{ phase, durationMs, rowsWritten }`
- `index:error` - `{ message, recoverable }`

These drive the **search status dot** (`src/app/components/search-status-dot.ts`): green (idle), yellow (`backlog > 50` or active rebuild), red (unavailable, with Retry link).

### REST endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=...&projectId=...&type=...&limit=...&offset=...` | Hybrid query. `projectId` omitted → search across all projects. Results include `projectId`/`projectName`. Returns **503** when the service is disabled. |
| `POST /api/search/rebuild?projectId=...` | Kick off a full rebuild. Runs in background; progress via WS. |
| `GET /api/search/stats?projectId=...` | Service state, engine name + version, per-source row counts, dataset size on disk, last rebuild timestamp. **400** if `projectId` missing; **503** if disabled. |
| `POST /api/search/compact?projectId=...` | No-op under FlexSearch. Retained for API compatibility so older clients don't 404; always returns `{ ok: true }`. |
| `GET /api/maintenance/orphaned-index-rows?projectId=...` | Rows whose parent entity no longer exists. |
| `POST /api/maintenance/cleanup-index-rows?projectId=...` | Delete them. |

### Migration

Indexes are a rebuildable cache; the source-of-truth stores repopulate automatically via `rebuildFromSources([...])` on a meta mismatch. Any legacy `search.db` (pre-LanceDB) or `search.lance/` (pre-FlexSearch) directory is deleted on first startup under the current code - no data loss, just a one-time rebuild.

### Maintenance panel

**Settings → Maintenance → Search Index** surfaces engine name/version, state, last rebuild time, dataset size, and per-source row counts. Controls are **Refresh** and **Rebuild Index**; live rebuild progress is streamed over the WS events above. The earlier *Retry Download* and *Compact Dataset* buttons are gone - there is no model to download, and compaction is a no-op under the pure-JS engine.

### Two-mode search UX

**1. Filter mode (sidebar):** Instant client-side filtering - no API calls. Filters goals by title, sessions by title and agent role, and staff by name using case-insensitive substring matching. Archived sections auto-expand on a match and auto-collapse when cleared. A "Full Search" link navigates to the full search page with the current query. Key file: `SearchBox.ts`; filtering lives in `Sidebar.ts`.

**2. Full search page (`#/search`):** The sole consumer of `GET /api/search`. Large auto-focused input, type filter toggles (Goals, Sessions, Staff, Messages), grouped results with `<b>`-highlighted snippets, relative timestamps, archived badges, and "Load More" pagination. Key file: `search-page.ts`.

> **Design note - gate content:** Gate content (design specs, review findings) is not currently indexed. Tracked for future work; adding it requires bumping `SCHEMA_VERSION` or `CONTENT_POLICY_VERSION` to force a rebuild.

### Paginated archives

- `GET /api/goals?archived=true&limit=50&after=<cursor>` - cursor is `archivedAt` timestamp
- `GET /api/sessions?include=archived&limit=50&after=<cursor>`
- Live data uses generation-based polling (`?since=N`)

---

## Thinking level configuration

Configurable via `default_thinking_level` in `project.yaml`. Values: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `""` (empty = agent default `"medium"`). `xhigh` is only honoured on models that advertise it (Anthropic Opus 4.6+, OpenAI `gpt-5.1-codex-max`, `gpt-5.2*`); on other models it clamps down at session-start. See [docs/thinking-levels.md](thinking-levels.md) for the capability matrix and clamping semantics.

Token budgets (hardcoded in `remote-agent.ts`): minimal=1024, low=4096, medium=10240, high=32768.

Per-session toggle overrides the project default.

---

## Config scan directories

Bobbit scans multiple directories for skills, MCP servers, tools, and agent files. Manage via Settings → Config Directories tab or `config_directories` in `project.yaml`.

Storage format (native YAML):
```yaml
config_directories:
  - path: ~/my-config
    types: [skills, mcp]
```

Types: `"skills"`, `"mcp"`, `"tools"`, `"agents"`. Custom directories are additive. Built-in directories always scanned with higher priority. Legacy JSON-string form (`config_directories: '[...]'`) still parses but is rewritten in native form on next save - see [Native-YAML project.yaml fields](#native-yaml-projectyaml-fields).

**Per-project scoping:** Config directories are resolved per-project. Each project's `config_directories` in its `project.yaml` affects only that project's sessions - a session in project B uses project B's custom directories for skill, MCP, and agent file discovery. Projects never inherit each other's config directories. The API endpoints (`/api/config-directories`, `/api/slash-skills`, `/api/slash-skills/details`) accept a `?projectId=` query parameter to resolve directories for a specific project.

**Built-in directories:**

| Type | Directories |
|---|---|
| Skills | `.claude/skills/`, `.bobbit/skills/`, `~/.claude/skills/`, `~/.bobbit/skills/`, `.claude/commands/` |
| MCP | `~/.claude.json`, `~/.claude/.mcp.json`, `~/.bobbit/.mcp.json`, `.mcp.json`, `.claude/.mcp.json`, `.bobbit/config/mcp.json` |
| Tools | `defaults/tools/` (builtins), `.bobbit/config/tools/` (overrides) |
| Agents | `AGENTS.md` (falls back to `CLAUDE.md`) |

**Agents type:** entries point at individual files, not directories. Concatenated into system prompt in order. `@ref` resolved relative to file's parent dir.

**Key file:** `src/server/agent/config-directories.ts`

### Skill chip rendering & autonomous activation

Skills follow the [Agent Skills spec](https://agentskills.io/specification)'s *progressive disclosure* model: skill name + description load with the system prompt (level 1, ~100 tokens each), the full body loads only when the skill is activated (level 2). This keeps the system prompt cheap regardless of how many skills are installed while still letting the agent self-route to the right one mid-turn. Full design: [docs/design/skill-ux-and-autonomous-activation.md](design/skill-ux-and-autonomous-activation.md).

**User invocation - literal text + chip.** When a user types `/name args` (prefix-only) or includes `/name` inline, `resolveSkillExpansions()` (`src/server/skills/resolve-skill-expansions.ts`) returns the original text plus a `skillExpansions[]` array of `{ name, args, source, filePath, range, expanded }`. The `expanded` body is *snapshotted at invocation time* so replaying the transcript later renders the same content the agent originally saw, even if SKILL.md has changed on disk. The chat bubble shows the literal text; each expansion is spliced in as a `<skill-chip>` element (`src/ui/components/SkillChip.ts`) at its recorded range. The model-facing prompt is byte-equal to the legacy fully-expanded form - only the persisted UI shape changed.

**Sidecar persistence.** The pi-coding-agent CLI owns the `.jsonl` transcript schema, so expansions are stored out-of-band in `<stateDir>/skill-sidecar/<sessionId>.jsonl` (one JSON line per user message). Lookup on replay matches `modelText` exactly with a ±2 s timestamp tolerance (falls back to text-only match for clock skew). A missing or unreadable sidecar is treated as "no expansions" - old sessions render as plain text, fully backward compatible. Key file: `src/server/skills/skill-sidecar.ts`.

**Autonomous activation - system prompt section.** At session start, `system-prompt.ts` injects an "Available Skills" section listing `name`, `description`, and `argument-hint` for every discovered skill where: (a) `disable-model-invocation` is not set, and (b) the role has access to the `Skills` tool group. The section is capped by a configurable byte budget (default **16 KB**; user-tunable in `[1 KB, 128 KB]` via the `skillsCatalogBudget` preference / Settings → General — see `docs/features.md`). If exceeded, skills are sorted alphabetically by name and the tail is truncated with a footer (`_… (N more skills omitted, alphabetically truncated)_`) and a warn log reflecting the effective budget. The resolver `resolveSkillsCatalogBudget()` in `src/server/agent/system-prompt.ts` clamps overrides and falls back to the default for missing/invalid values. Existing 5-second cache TTL applies, so newly added skills appear within 5 s for autonomous use (immediately for slash use via cache miss).

**Activation tool.** Built-in `activate_skill({ name, args? })` (`defaults/tools/skills/activate_skill.yaml` + `extension.ts`) looks up the skill via `getSlashSkill()`, runs `buildSlashSkillPrompt()` along the same snapshot path as user invocations, and returns the expanded body as the tool result. The chat UI renders the tool call as the same `<skill-chip>` UX (`src/ui/tools/renderers/ActivateSkillRenderer.ts`). Activation of a `disable-model-invocation` skill is rejected with a clear error.

**Tool-group policy.** `activate_skill` is in the `Skills` tool group. Roles can opt out by setting `Skills: never` in their `toolPolicies`, which both removes the "Available Skills" section from the system prompt *and* hard-blocks any `activate_skill` call - see [Tool access policies](#tool-access-policies).

**WS handler echo.** `src/server/ws/handler.ts` must include `skillExpansions` in the user-message echo broadcast back to the client; dropping it causes chips to vanish until reload (when the sidecar replay path rehydrates them). Regression guarded by E2E coverage - see [docs/debugging.md - Skill chip not rendering](debugging.md#skill-chip-not-rendering).

### Skill resource manifest (Level-3 progressive disclosure)

Claude Code's skills spec describes three levels of progressive disclosure: (1) name + description in the system prompt, (2) full SKILL.md body on activation, (3) referenced files (`references/REFERENCE.md`, `scripts/extract.py`, `assets/template.docx`) read on demand using the relative paths the author wrote. Bobbit implements Level 3 by prepending a small synthetic *activation header* to the model-facing expanded body.

**Header format.** Wrapped in an HTML comment fence so it's markdown-invisible (graceful fallback if any UI strip ever misses) and unambiguously regex-strippable:

```
<!-- skill-activation-header -->
Skill root: /abs/path/to/skill
Available resources: references/REFERENCE.md, scripts/extract.py, assets/template.docx
<!-- /skill-activation-header -->
```

**Helpers.** `src/server/skills/skill-manifest.ts` exports two functions:
- `buildSkillResourceManifest(skillRoot)` - scans `references/`, `scripts/`, `assets/` one level deep (subdirs are NOT recursed), returns `{ root, resources, truncated, truncationSuffix }` or `null` if none of those dirs exist. Resource list is sorted alphabetically and capped at **2 KB** of joined output (UTF-8 byte length); overflow is truncated with a `(N more files)` suffix.
- `buildActivationHeader(skill, pathRewrite?)` - returns the header string (or `""` for legacy `.claude/commands/*.md` single-file skills and synthetic built-ins like `compact` that have no on-disk root). The optional `pathRewrite` callback maps host paths to container paths for sandboxed sessions; returning `null` from it forces a degraded header (see [Sandbox skill visibility](#sandbox-skill-visibility)).

**Call sites.** The header is injected in two places, both server-side, so the model-facing string is identical regardless of activation path:
- `src/server/skills/resolve-skill-expansions.ts` - for user-typed `/name` invocations, the header is prepended to each expansion's `expanded` field. Because expansions are snapshotted into the sidecar, replays render the same header the agent originally saw.
- `POST /api/sessions/:id/activate-skill` handler in `src/server/server.ts` - for autonomous `activate_skill` tool calls.

**UI strip.** `<skill-chip>` (`src/ui/components/SkillChip.ts`) strips the header from the disclosure body via `ACTIVATION_HEADER_STRIP_RE` so the user sees only what the SKILL.md author wrote. The regex is duplicated from `skill-manifest.ts` (importing from server code would drag `node:fs`/`node:path` into the UI bundle); **keep both copies in sync**.

**Why `@path` auto-inline was removed.** `slash-skills.ts` previously called `resolveMarkdownRefs()` on every SKILL.md body, eagerly inlining `@references/foo.md` references at load time. This diverged from Claude Code (which keeps Level 3 strictly on-demand), bloated the system prompt, and broke the spec's "Keep your main SKILL.md under 500 lines" expectation. The call was dropped for skill bodies; `@path` text is now passed through verbatim to the model, which reads the referenced file via the activation header's manifest when (and only when) it actually needs the content.

### Sandbox skill visibility

When a skill is activated, Bobbit prepends an *activation header* to the SKILL.md body that tells the model the skill's root directory and a one-level-deep manifest of `references/`, `scripts/`, `assets/` (Level-3 progressive disclosure - see [docs/design/claude-code-skill-parity.md](design/claude-code-skill-parity.md)). This lets the agent read referenced files using the relative paths the skill author wrote.

**Inside the Docker sandbox, only project-local skills are fully visible.**

| Skill location                  | Level 1 (system-prompt listing) | Level 2 (SKILL.md body) | Level 3 (referenced files) |
| ------------------------------- | :-----------------------------: | :---------------------: | :------------------------: |
| `<project>/.claude/skills/<name>/` | yes                          | yes                     | **yes**                    |
| `defaults/skills/<name>/` (built-in) | yes                       | yes                     | **no**                     |
| `~/.claude/skills/<name>/` (personal) | yes                      | yes                     | **no**                     |

The project worktree mounts at `/workspace` inside the container, so project-local skill roots resolve cleanly via the resolver's `pathRewrite` callback (host path → `/workspace/...`). `docker-args.ts` does **not** mount the Bobbit install directory or `~/.claude`, so built-in and personal skill roots are not reachable from inside the container.

**Degraded header.** When a skill root cannot be exposed inside the sandbox, `buildActivationHeader()` (in `src/server/skills/skill-manifest.ts`) emits a degraded form with no resource manifest:

```
<!-- skill-activation-header -->
Skill root: (not visible inside sandbox - see docs/internals.md "Sandbox skill visibility")
<!-- /skill-activation-header -->
```

Level-1 (description listing) and Level-2 (the SKILL.md body itself, which is captured on the host before being passed to the sandboxed agent) continue to work for these skills. Only Level-3 - reading actual files under `references/` / `scripts/` / `assets/` - is unavailable. Skills that don't depend on referenced files behave identically inside and outside the sandbox.

**Workaround.** If a built-in or personal skill needs Level-3 access inside the sandbox, copy its directory into the project's `.claude/skills/` tree. A bind-mount or copy-on-activate mechanism that exposes built-in/personal skill roots automatically is a planned follow-up, not part of v1.

**Manual verification recipe.** Inside the sandbox:

```bash
# Project-local skill works (resource list populated):
curl -sk -H "Authorization: Bearer $TOKEN" \
  -X POST "$GW/api/sessions/$SID/activate-skill" \
  -d '{"name":"<project-skill-name>"}' | jq -r .expanded | head -10

# Built-in skill emits degraded header (no "Available resources:" line):
curl -sk -H "Authorization: Bearer $TOKEN" \
  -X POST "$GW/api/sessions/$SID/activate-skill" \
  -d '{"name":"compact"}' | jq -r .expanded | head -10
```

---

## Image generation routing

Bobbit ships a `generate_image` tool that fans out to multiple image providers (OpenAI Images / DALL-E, Google Gemini Flash Image, Google Imagen 4, OpenAI-Codex driver models) behind a single contract. The selected model is **per-session, not per-call** - the agent only specifies `model=...` when the user explicitly names a non-default provider; otherwise the gateway resolves to whatever the user picked in the footer image-model picker. This mirrors how the chat session model works and avoids the agent guessing at provider availability on every call.

### Per-session state

`SessionStore` rows carry the selected image model as **two separate optional fields**: `imageModelProvider` (e.g. `"openai"`) and `imageModelId` (e.g. `"gpt-image-2"`). They are set by the user via the footer picker (see `set_image_model` below) and read by the gateway when the agent calls `generate_image` without an explicit `model` argument. Splitting provider and id avoids parsing a `provider/id` string at every read - the WS handler validated both halves against the registry once on write, and downstream code consumes the parsed pair directly.

Key resolver: `SessionManager.getImageModelForSession(sessionId)` - returns `{ provider, id }` for the session if both fields are set, otherwise falls back to the system-default preference at key **`default.imageModel`** (full `provider/id` string, e.g. `"openai/gpt-image-2"`). If the preference is unset, `defaultImageModelPref()` returns the built-in default. There is no 503 "image generation unavailable" path on `POST /api/image-generation/generate` - if the resolved model has no credentials, the provider helper throws and the endpoint returns `500 { error: "<provider message>" }`.

### WebSocket: `set_image_model`

The footer picker mutates session state via the WS message:

```json
{ "type": "set_image_model", "provider": "openai", "modelId": "gpt-image-2" }
```

Handled in `src/server/ws/handler.ts`. The session ID is connection-derived - the server reads it from the WS connection context, not from the message payload - so the client never sends it. The handler validates `provider`/`modelId` against `getAvailableImageModels()` (registry + credential check). Unknown values reply with an error envelope `{ type: "error", message: "unknown image model", code: "UNKNOWN_IMAGE_MODEL" }` and **do not** mutate session state - invalid values cannot wedge a session into an unrenderable picker state. On a valid value, the handler persists `imageModelProvider`/`imageModelId` to the session row and broadcasts the updated state.

A confirmation snapshot is broadcast back as a normal session-update so all attached clients re-render the footer in sync.

### Tool resolution & routing

1. Agent calls `generate_image` (built-in tool, `defaults/tools/images/generate_image.yaml`).
2. Tool extension (`defaults/tools/images/extension.ts`) reads `.bobbit/state/gateway-url` + `.bobbit/state/token` and POSTs to `/api/image-generation/generate` with the prompt, optional `model` override, `n`, `imageSize`, and the session ID.
3. Server endpoint (`src/server/server.ts::handleApiRoute` for `POST /api/image-generation/generate`):
   - Validates `prompt` length (≤8192 chars) and `n` range (`[1, 4]`).
   - If `model` is omitted, looks up `getImageModelForSession(sessionId)`.
   - Canonicalises both the request `model` and the session model through the same helper before comparing - prevents `OpenAI/GPT-Image-2` from being treated as a different model than `openai/gpt-image-2`.
   - **Override resolution.** A request `model` is honoured when (a) it canonicalises equal to the session's selected model, (b) there is no `sessionId`, **or** (c) `imageModelMentionedInText` finds the request model id in the user's most-recent prompt text. Otherwise the request `model` is silently ignored and the session's selected model is used. This last-prompt check is why an explicit override sometimes "works" and sometimes doesn't - it must be named in the user's text, not just sent in the API body.
   - If a request `model` is supplied that doesn't match any registered image model, the canonical helper returns `undefined` and the request silently falls back to the session's selected model. There is no 4xx response for unknown image models on this endpoint.
   - Dispatches to one of `generateOpenAIImage`, `generateGeminiImage`, `generateImagenImage`, or `generateOpenAICodexImage` in `src/server/agent/image-generation.ts`.
4. The provider helper makes the upstream HTTP call and returns `{ images, format }`. Any error thrown from a helper is caught by the endpoint and surfaced as `500 { error: err?.message || "Image generation failed" }`. Helpers throw arbitrary `new Error(...)` strings (missing credentials, upstream HTTP failures, the Codex `n=1` clamp, the 25 MB remote-image cap, etc.) - there is no required prefix format, and the API surface never emits `502` or `503`.

### OpenAI-Codex driver model fallback chain

`generateOpenAICodexImage` runs through the AI Gateway and needs a chat-completion-capable model to drive image-tool calls. To avoid hard-coding a single model id (which goes stale every time OpenAI ships a new tier), `getCodexImageDriverModel()` walks a fallback chain mirroring `pickFallbackAigwNamingModel`:

1. Environment variable `BOBBIT_OPENAI_CODEX_IMAGE_DRIVER_MODEL` (explicit override - deliberately env-only, not a stored preference, so an operator can swap the driver without touching prefs).
2. `gpt-5.5`
3. `gpt-5`
4. `gpt-4o`

First non-empty entry wins; if none are set, the function throws `Error("no codex image driver model available")` which surfaces as a `500` to the agent rather than a confusing upstream `404`.

The driver also clamps `n` to `1` - multi-image requests reject up-front with `Error("openai-codex image driver supports n=1 only")` instead of silently returning one image, since the upstream API does not support batch generation through this path.

### Remote image size cap

`imageFromUrl()` (used when prompts reference an existing image URL) streams the response with a hard cap of 25 MiB (`MAX_IMAGE_BYTES`). Crossing the cap aborts the controller and throws `Error("remote image exceeds 25 MB cap")` - a memory-exhaustion guard that prevents a malicious prompt from forcing the gateway to buffer an arbitrarily large remote payload.

### `outputPath` containment

When the agent passes `outputPath` to `generate_image`, the tool extension resolves it relative to the session worktree and rejects any path that escapes the worktree:

```ts
const resolved = path.resolve(process.cwd(), basePath);
const rel = path.relative(process.cwd(), resolved);
if (rel.startsWith("..") || path.isAbsolute(rel)) {
  throw new Error("outputPath escapes worktree");
}
```

This is a hard security check - `outputPath` is model-controlled, and without containment a prompt-injection could write files outside the worktree (or to absolute paths like `/etc/...`).

### Restoring image tools on dormant sessions

The image tool group is included in `session-setup.ts::resolveToolActivation` for sessions that had it active when archived. `restoreSession()` round-trips the same activation list, so a session created before image tools existed never grows the tool group implicitly, and a session that did have it keeps it across restart.

Round-tripping the same activation list is the user-friendly default - at session-creation the user explicitly enabled/disabled tool groups, and we grandfather that choice rather than re-deriving from the latest tool-group policy (which may have changed between then and the restore). See [docs/debugging.md - Image generation failure](debugging.md) when the tool is missing on a session that should have it.

### Key files

- `src/server/agent/image-generation.ts` - provider helpers (`generateOpenAIImage`, `generateGeminiImage`, `generateImagenImage`, `generateOpenAICodexImage`), `imageFromUrl`, `getCodexImageDriverModel`, `getAvailableImageModels`.
- `src/server/agent/session-manager.ts::getImageModelForSession` - per-session resolver.
- `src/server/ws/handler.ts` - `set_image_model` handler.
- `src/server/server.ts` - `GET /api/image-models`, `POST /api/image-generation/generate` routes.
- `defaults/tools/images/{generate_image.yaml,extension.ts}` - tool surface.
- `src/ui/dialogs/ImageModelSelector.ts` - footer picker.
- `src/app/settings-page.ts::renderImageModelRow` - Settings → Models → Image row + Test button.
- `defaults/system-prompt.md` - agent-facing routing rules (DALL-E vs `openai/gpt-image-2`, Google ID table).

See also: [docs/rest-api.md - Image generation](rest-api.md#image-generation) for the wire-level contract; AGENTS.md debugging index for symptom-based pointers.

---

## MCP servers

Auto-discovered from Claude Code-compatible locations. Sources (later overrides earlier):

1. Custom directories with type `"mcp"` (lowest priority)
2. Additional registered projects' MCP locations (see below)
3. `~/.claude.json` → `mcpServers` + `projects[<cwd>].mcpServers`
4. `~/.claude/.mcp.json`
5. `~/.bobbit/.mcp.json`
6. `<project>/.mcp.json`
7. `<project>/.claude/.mcp.json`
8. `<project>/.bobbit/config/mcp.json` (highest priority)

**Multi-project discovery:** In multi-project setups, MCP discovery scans all registered projects - not just the primary project. Each additional project's custom MCP directories, `.mcp.json`, `.claude/.mcp.json`, and `.bobbit/config/mcp.json` are included. Additional project configs have lower priority than user-level configs (`~/.claude.json` etc.) and the primary project's own configs, so the primary project always wins on name conflicts. This ensures sessions can access MCP servers defined in any registered project without manual duplication.

Config format matches Claude Code `.mcp.json`:
```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "remote": { "url": "https://mcp.example.com/api" }
  }
}
```

**Tool surface:** the model sees one **meta-tool per server** named `mcp_<server>(operation, args)` plus a shared `mcp_describe(server, operation?)` discovery tool. The legacy per-op identifier `mcp__<server>__<tool>` remains the internal routing key (used by `_toolNameMap`, `tool-group-policies.yaml` keys like `mcp__playwright`, the dispatcher, and existing tests) but is no longer exposed to the model. Failed servers degrade to a stub meta-tool that reports the failure reason rather than aborting the agent turn. See [docs/mcp-meta-tools.md](mcp-meta-tools.md) for the user-facing overview and [docs/design/mcp-meta-tool-aggregation.md](design/mcp-meta-tool-aggregation.md) for the architecture.

Transports: stdio (spawn) and HTTP (POST JSON-RPC). Env vars (`${VAR}`) expanded from `process.env`.

### MCP tool documentation

When an MCP server connects, `McpManager` auto-generates documentation for its tools so they follow the same two-tier pattern as built-in tools: enriched one-line summaries in the system prompt, full parameter docs on disk.

**Summary generation** - deterministic, no LLM dependency:
- First sentence of the tool description (terminated by `.`, `!`, or `?`)
- Truncated at ~120 characters on a word boundary with `...` if needed
- Falls back to `"MCP tool <name> from <server>"` when no description exists

**Disk cache** - stored in `<project-root>/.bobbit/state/mcp-tool-docs/`:
- `<serverName>.cache.json` - per-tool SHA-256 content hash (of description + inputSchema) and generated summary. On each connect, hashes are compared; only changed tools trigger regeneration.
- `<serverName>.md` - full Markdown reference with tool descriptions and parameter tables (name, type, required, description). Rewritten only when any tool in the server changes.

**Prompt layout** - `getToolDocsForPrompt()` in `tool-manager.ts` produces a single compact `# Tools` section sent on every assistant turn. Each group is one `## <Group> — see <relpath>` header followed by a one-line bullet per tool: `- name(params) — summary`. The `params` list comes from the YAML `params: [name, name?]` field (trailing `?` marks optional); tools without `params` render as `- name — summary`. Per-tool prose (`docs`, `detail_docs`) is **not** inlined into the prompt — it is folded into the per-group reference markdown the pointer resolves to. Built-in groups point at `<stateDir>/tool-docs/<groupDir>.md` (written by `generateDetailDocs()` from each tool's `docs` paragraph followed by `detail_docs`); MCP groups point at `<stateDir>/mcp-tool-docs/<serverName>.md` (auto-generated from `tools/list`). MCP groups render one bullet per op with no inlined parameter prose — agents call `mcp_describe` for full schemas. This compact format replaced an earlier sentence-form `### name` layout to drop ~78% of the per-turn `# Tools` byte count.

**API:** `GET /api/mcp-servers`, `POST /api/mcp-servers/:name/restart`, `POST /api/internal/mcp-call`, `POST /api/internal/mcp-describe`. See also [docs/mcp-meta-tools.md](mcp-meta-tools.md).

---

## Docker sandbox

Opt-in Docker isolation for agent sessions. Set `sandbox: "docker"` in `project.yaml`. Each project gets one long-lived Docker container - agents work inside it using standard git worktrees, the same isolation model as non-sandbox mode.

### Architecture

```
HOST                                    CONTAINER (one per project, long-lived)
────                                    ────────────────────────────────────────
Bobbit server                           /workspace        (repo clone, native Linux)
  │                                     /workspace-wt/
  ├─ docker exec → team lead              ├─ goal-abc/     (worktree)
  ├─ docker exec → agent-1                │   └─ agent-1/  (worktree)
  └─ docker exec → agent-2                └─ goal-def/     (worktree)
```

- **One container per project**, created when sandbox is enabled, lives until disabled/removed
- **Container clones its own repo** from the real remote - no host-side clone, no cross-OS bind mounts for workspace
- **`npm ci`, Playwright install, and build happen inside the container** on native Linux filesystem
- **Agents use git worktrees** inside the container - identical to non-sandbox mode
- **One scoped token per project container** (not per-agent/session)

### Configuration

All settings in `project.yaml` (Settings → Project → Docker Sandbox):

```yaml
sandbox: "docker"                      # "none" (default) or "docker"
sandbox_image: "bobbit-agent"          # must be pre-built
sandbox_credentials: '{"GITHUB_TOKEN": "ghp_..."}'  # env vars for container
sandbox_mounts: '["/data/shared:/data:ro"]'  # bind mounts
```

### Docker image

```bash
docker build -t bobbit-agent docker/
```

Auto-built on startup if image missing but `docker/Dockerfile` exists (120s timeout). Includes Node.js 20, git, curl, gh, build-essential. Agent CLI bind-mounted at runtime.

### How it works

**Container lifecycle** is managed by `ProjectSandbox` (one instance per project) and `SandboxManager` (registry mapping projectId → ProjectSandbox).

**Lazy per-project init:** Bobbit does not initialize any sandbox at server startup. `SandboxManager` is constructed bare and each project's sandbox is brought up the first time it is actually needed, via the idempotent `SandboxManager.ensureForProject(projectId)`. Concurrent callers for the same project share a single in-flight init (`Map<projectId, Promise<void>>`). This replaces the previous behavior of initializing one sandbox for the default project at startup. `ensureForProject` is called from:

- Session setup (`session-setup.ts` plan phase) when the plan is `sandboxed`.
- `POST /api/goals` when the request body has `sandboxed: true`, after project resolution succeeds.
- `StaffManager` wake, for sandboxed staff agents.

A sandbox is never created for a project that has not asked for one. The image build is shared across projects (same Docker image tag). Failure to init project B's sandbox does not affect project A.

**Startup sequence (on first `ensureForProject` call for a project):**

1. `SandboxManager.initForProject(projectId, config)` creates a `ProjectSandbox` instance
2. `ProjectSandbox.init()` searches for an existing container by label (`bobbit-project=<projectId>`):
   - **Found running** → reconnect (reuse container ID)
   - **Found stopped** → restart via `docker start`
   - **Not found** → create new container with named Docker volumes (`bobbit-workspace-<projectId>` for `/workspace`, `bobbit-worktrees-<projectId>` for `/workspace-wt`)
3. On first create, the container runs an init sequence: `git clone <repoUrl>`, `npm ci`, optional Playwright install, `npm run build`
4. Container runs with `--restart=unless-stopped` so it survives Docker daemon restarts

**Agent spawn:**

1. `ProjectSandbox.createWorktree(name, branch, baseBranch?)` creates a git worktree at `/workspace-wt/<name>` inside the container via `docker exec`
2. A post-commit hook is installed in each worktree for mandatory push-to-remote (durability)
3. RpcBridge spawns the agent via `docker exec -i -w <containerCwd> <containerId>` - the `-w` flag sets the container process working directory so the agent CLI's `process.cwd()` resolves to the correct worktree path (without it, docker exec defaults to the container's WORKDIR `/workspace`, which is wrong for worktree sessions)
4. Delegates inherit parent sandbox config

**Session termination:**

1. `ProjectSandbox.removeWorktree(name)` removes the worktree inside the container via `docker exec git worktree remove`

### Network

Containers run on a dedicated Docker bridge network (`bobbit-sandbox-net`) with direct outbound internet access. This replaces the previous proxy-based approach where all traffic was routed through a gateway-hosted `SandboxProxy`.

- **Network creation**: `ensureSandboxNetwork()` in `session-manager.ts` creates the network idempotently via `docker network create bobbit-sandbox-net --driver bridge --opt com.docker.network.bridge.enable_icc=false`. The `enable_icc=false` flag prevents inter-container communication.
- **Metadata endpoint blackholing**: Cloud metadata endpoints are blocked via `--add-host` entries in `docker-args.ts` (`169.254.169.254`, `metadata.google.internal`, and `metadata.internal` all resolve to `0.0.0.0`). `169.254.169.254` is the AWS/GCP/Azure IMDS endpoint; the named hosts cover GCP and Azure specifically. This is defense-in-depth against SSRF via cloud instance metadata.
- **Gateway reachable**: `--add-host=host.docker.internal:host-gateway` ensures the container can reach the gateway for API calls (tool extensions, delegate sessions, etc.).
- **Cleanup**: `cleanupSandboxNetwork()` removes the network on shutdown (non-fatal if containers are still connected).
- `web_search`/`web_fetch` use direct `curl` from inside the container - no gateway proxy needed.

### Scoped tokens

Each sandboxed project gets a single 256-bit token shared by all sessions in that project. Generated via `SandboxTokenStore.register(projectId)`, in-memory only (regenerated on restart). Sessions are added to the scope via `addSession(projectId, sessionId)`. Auth tries admin token first, then `SandboxTokenStore`.

**Allowed endpoints:** `/api/health`, `/api/internal/mcp-call`, `/api/internal/verification-result`, `/api/preview/mount`, `/api/sessions` (forced sandboxed), own session CRUD, own goal+team+gates+tasks, `/api/tasks/:id`. Everything else blocked. `bash_bg` blocked at tool and API level.

Full allowlist: see `src/server/auth/sandbox-guard.ts`.

### Resource limits

Container resource limits are computed dynamically based on the host machine:
- **Memory**: total system memory minus 2GB (minimum 4GB) - leaves headroom for the host OS and gateway
- **CPU**: total CPU cores minus 2 (minimum 2) - prevents sandbox from starving the host
- **PIDs**: unlimited - fork bombs are mitigated by the memory and CPU limits

These are computed in `ProjectSandbox` and passed to `buildDockerRunArgs()`.

### Git authentication (GITHUB_TOKEN)

Sandbox containers include a git credential helper so agents can `git push` and use `gh pr create` without manual authentication. The token flows from the host into the container at runtime - the Docker image contains only the credential helper script, never the token itself.

**Injection path:**

1. `resolveHostApiCredentials()` in `session-manager.ts` auto-detects a GitHub token on the host - checking `GITHUB_TOKEN` env var, `gh auth token` CLI, and `~/.config/gh/hosts.yml`
2. The token is passed to the agent process via `docker exec -e GITHUB_TOKEN=xxx` (not `docker run -e`, because pooled containers start before credentials are known)
3. The Dockerfile configures a global git credential helper:
   ```
   git config --global credential.helper \
     '!f() { test -n "$GITHUB_TOKEN" && echo "username=x-access-token" && echo "password=$GITHUB_TOKEN"; }; f'
   ```
   When git requests HTTPS credentials, this helper reads `$GITHUB_TOKEN` from the current process environment and returns it as a password with the `x-access-token` username (GitHub's convention for token auth).
4. `gh` CLI also honours `GITHUB_TOKEN` natively - no extra configuration needed.

**Configuration:** The `sandbox_github_token` setting in `project.yaml` (defaults to `true`) controls whether the host token is injected. Set to `false` to disable injection - the credential helper will be present but inert (it checks `test -n "$GITHUB_TOKEN"` before returning credentials).

**Security notes:**
- The token is injected per-process via `docker exec -e`, not stored on the container filesystem
- The credential helper is a shell function, not a persisted script with embedded secrets
- If `GITHUB_TOKEN` is unset in the container's environment, the helper is a no-op and git falls back to its normal credential flow (which will fail in the sandbox since there is no TTY)

### Worktree management

Sandboxed agents use standard git worktrees inside the project container - the same model as non-sandbox mode. No shared bare repos or team remotes are needed.

**Worktree creation** (`ProjectSandbox.createWorktree()`):

1. Creates a worktree at `/workspace-wt/<name>` branching from the specified base
2. Installs a post-commit hook that pushes to the remote after every commit (durability - ensures commits survive container loss)
3. Called during agent spawn via `applySandboxWiring()`

**Multi-repo containers.** Multi-repo projects mount `rootPath` (the container of sibling repos) at `/workspace`; each repo lives at `/workspace/<repo>/`. `docker-args.ts` host-path rewriting understands the new layout. `ProjectSandbox.createWorktree()` returns a worktree set in multi-repo mode. Per-component `worktree_setup_command` runs inside the container at the component's path. The pool prebuild also works inside the sandbox.

**Worktree removal** (`ProjectSandbox.removeWorktree()`):

1. Removes the worktree via `git worktree remove --force`
2. Called during session termination

**Worktree pool** (host-side, `worktree-pool.ts`): The worktree pool pre-creates worktrees in the background so sessions and goals start faster. Pool entries use the `pool/_pool-<id>` branch namespace (was `session/_pool-*` pre-Phase 3); claim atomically renames the branch and moves the worktree to the target name. **Goal creation also routes through the pool** as of Phase 3 - it no longer calls `createWorktree()` directly. Multi-repo pool entries are sets of N worktrees (one per configured repo, including data-only) sharing a single branch name across repos. See [Session worktrees](#session-worktrees) for the full pool claim sequence (single rename at claim time, no first-prompt rename - see [Remove session worktree & branch renaming](design/remove-session-worktree-rename.md)). Pools are **per-project** - `SessionManager` maintains a `Map<string, WorktreePool>` keyed by project ID, so each project's worktrees are rooted in the correct repo. On startup, a pool is initialized for every registered project whose `rootPath` is a git repo, using that project's `worktree_pool_size` and `worktree_setup_command` config. When a session is created, the pool claim looks up the pool by the session's `projectId` - sessions only claim from their own project's pool. New projects registered at runtime (`POST /api/projects`) get a pool auto-initialized if they're git repos. Deleted projects (`DELETE /api/projects/:id`) get their pool drained via `removeWorktreePool(projectId)`. The pool status API (`GET /api/worktree-pool`) returns per-project data: `{ pools: { [projectId]: { enabled, ready, target, filling } } }` without a query param, or flat status for a single project with `?projectId=<id>`. Settings UI shows per-project pool status when viewing a project's settings, and aggregated status in system scope.

**Pool freshness**: When a pooled worktree is acquired, it is fetched from origin and hard-reset to the configured base ref (project `base_ref`, falling back to the dynamically-resolved remote primary via `git symbolic-ref refs/remotes/origin/HEAD`, then `origin/master`). This prevents stale worktrees when the base has advanced since the pool entry was created. The pool reads the current `base_ref` on every fill/claim via a live `baseRefResolver` (sibling of `componentsResolver`) — pool entries auto-adopt the new value when the setting changes, no drain needed. The fetch+reset is non-fatal: if it fails, the worktree is still usable but may be behind. Full design: [design/base-ref.md](design/base-ref.md).

**Inter-agent coordination:** Because all agents share the same `/workspace` clone, they can fetch each other's branches directly (`git fetch origin <branch>`). The team lead merges agent branches locally, same as non-sandboxed teams.

### Session persistence across restarts

Sandbox containers are long-lived and survive gateway restarts (via `--restart=unless-stopped`). Session state (conversation history, branch, goal association) persists in `sessions.json` on the host via the bind-mounted `.bobbit/state/` directory.

**Recovery flow on gateway startup:**

1. `ProjectSandbox.init()` finds the existing container by label (`bobbit-project=<projectId>`)
2. If running, reconnects. If stopped, restarts. If gone, recreates with the same named volumes (`bobbit-workspace-<projectId>` for `/workspace`, `bobbit-worktrees-<projectId>` for `/workspace-wt`) - git history and agent worktrees in the volumes are preserved
3. If the volumes were also lost (e.g. Docker Desktop reset), the container re-clones from the remote - committed work is recovered from the remote, uncommitted work is lost
4. `restoreSession()` calls `applySandboxWiring()` which verifies the worktree still exists inside the container
5. If the worktree is missing (e.g. volume was reset but the container was recreated), the server attempts to recreate it via `ProjectSandbox.createWorktree(branch, branch)` using the session's persisted branch. If recreation succeeds, restore continues normally. If it fails (branch deleted, no sandbox available), the session is archived - the server never launches an agent into a non-existent CWD.

**Durability layers:** (1) Post-commit hooks push every commit to the remote immediately. (2) Named Docker volumes preserve `/workspace` and `/workspace-wt` across container recreation - agent worktrees survive even if the container is removed and recreated. (3) Session logs are bind-mounted to the host - never stored only inside the container.

### Verification command execution

When a gate's verification workflow includes `command` steps (e.g. running tests), the verification harness needs access to the team's latest code. For non-sandboxed goals, this code lives in the host worktree. For sandboxed goals, the team's commits only exist inside the shared team bare repo and the containers' `/workspace` directories - the host worktree does not have them.

To solve this, `runCommandStep` in `verification-harness.ts` accepts an optional `containerId`. At the call site, the harness checks `goal.sandboxed`; if true, it resolves the project container ID via `SandboxManager.get(projectId)` → `ProjectSandbox.getContainerId()`. When a container ID is available, the command runs via `docker exec -w /workspace <containerId> /bin/sh -c <command>` instead of spawning on the host.

**Fallback:** If the goal is sandboxed but the project container is not running (container crashed, Docker restarting), the harness falls back to host execution. A warning is emitted to both server logs (`console.warn`) and the verification step's output stream so the user can see why results may be stale.

### Container resilience

When a sandbox container is killed or removed (e.g. `docker rm -f`, OOM kill, Docker Desktop restart), the gateway automatically detects the death, recreates the container, and recovers all affected sessions - no server restart required.

#### Why this matters

Without container health monitoring, a killed container leaves all sandbox sessions in a stale state (`idle` or `streaming` with a dead subprocess). The user sees no error - sessions simply stop responding. Recovery previously required a full server restart, and even then sessions were often archived instead of restored due to broken worktree state.

#### Health monitor

`ProjectSandbox` runs a background health check that polls container liveness via `docker inspect --format "{{.State.Running}}"` every 20 seconds (configurable via `startHealthMonitor(intervalMs)`). The monitor is started automatically by `SandboxManager.initForProject()` after the container is initialized.

**Detection logic:**
- If the container is running → healthy, no action
- If the container is not running, inspect fails, or the container is gone → trigger recovery
- If a previous recovery attempt failed (`_status === "error"`), the monitor retries on the next poll - recovery is never permanently abandoned
- Active recovery is guarded by `_recovering` flag to prevent concurrent recovery attempts

**Recovery sequence:**
1. Set status to `"error"`, emit `container-died` event with the old container ID
2. Call `init()` to reconnect/recreate the container (reuses existing named volumes so git history and worktrees may survive)
3. On success, emit `container-recovered` event with the new container ID
4. On failure, log the error and retry on the next poll cycle

#### Event API

`ProjectSandbox` exposes `onHealthEvent(listener)` for low-level events (`container-died`, `container-recovered`). `SandboxManager` exposes a higher-level `onContainerRecovered(listener)` that fires with `(projectId, newContainerId)` - this is what `SessionManager` subscribes to for session recovery.

```typescript
type SandboxHealthEvent =
  | { type: "container-died"; projectId: string; containerId: string }
  | { type: "container-recovered"; projectId: string; containerId: string };
```

#### Session recovery flow

When the health monitor emits `container-recovered`, `SessionManager.recoverSandboxSessions()` runs:

1. **Find affected sessions** - all sessions with `sandboxed === true` and matching `projectId`
2. **Recover worktrees** using a 3-tier strategy for each session:
   - **Tier 1: Verify** - `docker exec test -d <cwd>` checks if the worktree still exists on the volume
   - **Tier 2: Repair** - `git worktree repair` inside the container fixes broken `.git` link files (common after hard container kill where the worktree directory survived on the volume but git metadata is inconsistent)
   - **Tier 3: Recreate** - `ProjectSandbox.createWorktree(name, branch)` creates a fresh worktree from the session's persisted branch
3. **Archive unrecoverable sessions** - if all three tiers fail (branch deleted, volume lost), the session is archived
4. **Restore sessions** - calls the existing `restoreSession()` path which re-spawns the agent process inside the new container
5. **Preserve WebSocket clients** - connected browser clients are saved before session deletion and re-attached after restore, so the UI receives the recovery status broadcast in real-time

The user experience for idle sessions: status briefly shows `terminated` (from `process_exit` handling), then automatically transitions back to `idle` within ~30 seconds. Chat history, branches, and all Bobbit state are preserved.

#### process_exit handling

When a container dies, all agent processes inside it die. The RPC bridge emits `process_exit` events for each dead process. `handleAgentLifecycle()` now handles this event type - it transitions the session to `terminated` status and broadcasts to connected UI clients. This provides immediate visual feedback while the health monitor works on recovery in the background.

#### Startup worktree repair

The existing session restore path (on gateway restart) also benefits from worktree repair. Before attempting `createWorktree` for a missing sandbox worktree, the restore flow now tries `git worktree repair` first. This handles cases where the worktree directory exists on the volume but git considers it broken - common after an ungraceful container shutdown.

### Security summary

- Container sees `/workspace`, `/workspace-wt/`, `/agent-modules` (ro), `/tools` (ro), `/bobbit-state/{sessions,tool-guard,html-snapshots}/` (selective mounts - the host gateway token, TLS keys, and other sensitive state files are not mounted), and `/bobbit/preview` (per-session bind-mount of `<stateDir>/preview/<sid>/` - or `/bobbit/preview-root` for the per-project shared parent; see [`docs/preview-architecture.md`](preview-architecture.md))
- Runs as `node` user (uid=1000), no Docker socket
- Mount paths validated against blocklist (`/proc`, `/sys`, `/.ssh`, `/.aws`, etc.)
- Credential keys sanitized (`^[A-Za-z_][A-Za-z0-9_]*$`)
- One scoped token per project (not per-session) - all sessions in a project share access
- `bash_bg` blocked (spawns on host); Docker args redacted in logs

### Key files

| File | Purpose |
|---|---|
| `docker/Dockerfile` | Image definition |
| `project-sandbox.ts` | Per-project container lifecycle and worktree management |
| `sandbox-manager.ts` | Registry mapping projectId → ProjectSandbox |
| `docker-args.ts` | Docker argument builder |
| `sandbox-status.ts` | Docker availability check, auto-build |
| `sandbox-token.ts` | Per-project scoped token store |
| `sandbox-guard.ts` | Endpoint allowlist enforcement |

### REST API

| Endpoint | Method | Description |
|---|---|---|
| `/api/sandbox-status` | GET | Docker availability + image status |
| `/api/sandbox-image/build` | POST | Build image from Dockerfile |

---

## Large content truncation

When an agent writes a large file, the `pi-coding-agent` RPC protocol emits `message_update` events containing the **full accumulated message** on every streaming chunk. For a 40MB file write, this means ~40MB of JSON is serialized, broadcast via WebSocket, parsed by the browser, and held in the EventBuffer - on every token. With multiple agents writing simultaneously, this creates catastrophic memory pressure and freezes the Node.js event loop.

The truncation system intercepts events before they reach the broadcast layer and EventBuffer, replacing large tool input content with a lightweight stub while preserving the full content in the agent's `.jsonl` session file for on-demand access.

### Architecture

```
Agent process → message_update (full content)
       │
       ├─→ handleAgentLifecycle() - receives original (for search indexing)
       ├─→ trackCostFromEvent()   - receives original (for token accounting)
       │
       └─→ truncateLargeToolContent(event)
              │
              ├─→ eventBuffer.push()  - truncated (ring buffer stays small)
              └─→ broadcast()         - truncated (WebSocket payloads stay small)
```

### Key design decisions

- **32KB threshold** - generous enough that normal code files (<10KB) pass through untouched, but catches generated data files, large test fixtures, and minified bundles. Exported as `LARGE_CONTENT_THRESHOLD` from `truncate-large-content.ts`.
- **Zero overhead for small content** - no cloning occurs unless truncation is actually needed. The function returns the original event reference unchanged.
- **Original event never mutated** - `handleAgentLifecycle()` and `trackCostFromEvent()` receive the unmodified event. Only the broadcast/buffer path sees the truncated version.
- **Dual format support** - both `toolCall`/`arguments` (pi-coding-agent RPC format) and `tool_use`/`input` (Anthropic API format) are handled for robustness.
- **UI lazy loading** - `WriteRenderer` shows a preview (first 512 chars) with a "Load full content" button. Full content is fetched via `GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex`. The endpoint reads `block.arguments?.content ?? block.input?.content` for tool-call blocks and falls back to `block.text` for text blocks (used by `preview_open` snapshots - see [Preview snapshots & reopening](#preview-snapshots--reopening)). See [docs/rest-api.md - Large content truncation](rest-api.md#large-content-truncation).
- **`preview_open` snapshot blocks** - `preview_open` tool_results carry a second `{type:"text"}` block whose text begins with one of the `__preview_snapshot_v{1,2,3}__\n` sentinels. `truncateSnapshotBlock()` walks `toolResult` messages, and when a snapshot exceeds the threshold it rewrites the block to `{ type:"text", text: marker, _truncated:true, _originalLength, preview }` - the matched marker is preserved so downstream consumers (UI renderer, further truncation passes) can still detect the block. The 512-char preview applies to v1 (legacy raw-HTML) snapshots; v2/v3 snapshots are constant ~250 bytes and never trip the threshold, so the truncation path only fires for legacy v1 archived snapshots in practice. Agent-facing context therefore only ever sees the 512-char preview; the UI hydrates the full HTML via the tool-content endpoint.
- **Streaming throttle** - `remote-agent.ts` throttles `streamMessage` updates to 2x/sec when content is truncated, reducing Lit re-render pressure in the browser.

### Key files

| File | Purpose |
|---|---|
| `truncate-large-content.ts` | `truncateLargeToolContent()` function and `LARGE_CONTENT_THRESHOLD` constant |
| `session-setup.ts` | Applies truncation in `subscribeToEvents()` before broadcast/buffer |
| `session-manager.ts` | Same truncation at all event listener sites |
| `server.ts` | REST endpoint for lazy-loading full content from `.jsonl` |
| `fetch-tool-content.ts` (UI) | Client-side REST helper for lazy loading |
| `WriteRenderer.ts` (UI) | Detects truncation, shows preview + "Load full content" button |
| `Messages.ts` (UI) | Handles `load-full-content` CustomEvent, fetches and re-renders |
| `remote-agent.ts` (UI) | Throttles stream updates for truncated content |

---

## Preview snapshots & reopening

The `preview_open` tool drives a single live preview side-panel in the UI. Each call overwrites the panel - there are no tabs, no history slots. But every past `preview_open` widget in chat history renders an **Open** button that re-hydrates the preview on demand by re-posting to the same mount endpoint, so users can flip between previous previews without re-running the agent.

### Why

Previews are transient by design: the agent iterates on a mockup by calling `preview_open` repeatedly, and each call replaces the panel. Once a newer call lands, the earlier preview is gone from the panel - but the chat history still shows the widget for the earlier call, which is confusing if clicking it does nothing. Persisting a tiny snapshot marker (URL + path, never the HTML body) into the tool_result and giving each widget an Open button closes the loop. Full architecture in [docs/preview-architecture.md](preview-architecture.md).

### Data flow

```
Agent calls preview_open({html|file})
   └─→ extension (defaults/tools/html/extension.ts)
        1. PATCH /api/sessions/:id {preview:true}
        2. POST  /api/preview/mount?sessionId=... {html} or {file}
           - server writes into <stateDir>/preview/<sid>/, broadcasts
             preview-changed via subscribePreviewChanged
        tool_result = [
          {type:"text", text:"Preview panel is open ..."},
          {type:"text", text: PREVIEW_SNAPSHOT_MARKER_V3 + JSON {kind:"preview", url, path}}
        ]
   └─→ session.jsonl persists both blocks (each ≤ 250 bytes total)
   └─→ Browser SSE subscriber on /api/sessions/:sid/preview-events receives
       {entry, mtime, url, path}; iframe src bumps `#mtime=<n>` and reloads.

User clicks Open on widget #N (PreviewRenderer.ts):
   └─→ parse v3 marker → POST /api/preview/mount?sessionId=... {html|file}
   └─→ same endpoint the extension uses; SSE picks up; iframe re-renders.
```

### Key design decisions

- **Constant-size snapshots (≤ 250 bytes)** - tool_result holds only `{kind:"preview", url, path}` wrapped in the v3 marker, so iteration cost is independent of HTML size. The agent can refresh a 5000-line report 50 times without the bytes ever entering its context.
- **Bytes never re-enter agent context** - the content origin serves files from `<stateDir>/preview/<sid>/` on disk; tool_result holds only the URL/path. This is the structural fix to the v1 token-bloat problem.
- **v1/v2 markers preserved in renderer-only code paths** - archived sessions still parse and reopen via the same mount endpoint (with `{html}` or `{file}` payloads recovered from the legacy block). New code emits only v3.
- **Cookie auth for the content origin** - `bobbit_session` cookie scopes `/preview/<sid>/...` requests, so iframe loads, asset fetches, and "Open in new tab" all authenticate without URL tokens.
- **SSE replaces 1 s polling for hot reload** - `subscribePreviewChanged` pushes `preview-changed` events; the panel bumps `#mtime=<n>` on the iframe `src` to force reload, typically within 100 ms of the agent writing.
- **Truncation layer recognises all three markers** - `truncateSnapshotBlock()` matches against `PREVIEW_SNAPSHOT_MARKERS`. v3 blocks are always tiny so the lazy-load branch is dead code for v3, but kept live for legacy archived sessions whose v1/v2 blocks may exceed the 32 KB threshold.

### Key files

| File | Purpose |
|---|---|
| `src/server/preview/mount.ts` | Per-session mount lifecycle (write/copy/remove/watch) |
| `src/server/preview/content-route.ts` | `/preview/<sid>/<path>` static serve + bridge injection |
| `src/server/preview/events.ts` | `subscribePreviewChanged` / `broadcastPreviewChanged` event channel |
| `src/server/auth/cookie.ts` | `bobbit_session` cookie store and verifier |
| `defaults/tools/html/snapshot.ts` | v3 marker constant + builder + parser; v1/v2 parser arms preserved for archived sessions |
| `defaults/tools/html/extension.ts` | Tool extension emits `[status, v3-snapshot]` tool_result after PATCH + POST mount |
| `src/server/agent/truncate-large-content.ts` | Recognises v1/v2/v3 markers (via `PREVIEW_SNAPSHOT_MARKERS`); v3 blocks always small so lazy-load only fires on legacy archived sessions |
| `src/ui/tools/renderers/PreviewRenderer.ts` | Open button dispatch: v3 → mount endpoint; v1/v2 → mount endpoint with `{html}`/`{file}` (read-only legacy) |
| `src/app/preview-panel.ts` | EventSource SSE subscription + bootstrap GET |
| `tests/preview-{mount,cookie,content-route,extension,renderer}*`, `tests/e2e/preview-{mount-route,token-cost}.spec.ts`, `tests/e2e/ui/preview-{happy-path,new-tab,archived-snapshot}.spec.ts` | Unit, API E2E, browser E2E coverage |

---

## Event stream ordering & dedup

Live-streaming agent events (`message_update`, `message_end`, `tool_execution_start`, ...) are delivered to the browser as `{type:"event", data, seq, ts}` WebSocket frames. The `seq` + `ts` fields exist to solve a pair of transport-level bugs that manifested as duplicated or reordered chat messages - **not** bugs in agent execution, and **not** visible on reload-replay (the snapshot path is already self-consistent).

### Why

Before this, `{type:"event"}` frames had no server-assigned identity. Two failure modes followed:

- **Snapshot-vs-live race on reconnect.** When the WebSocket dropped mid-turn, the client reconnected and requested a `get_messages` snapshot. Events arriving in the window between the snapshot request and its response were either dropped (snapshot overwrote them) or duplicated (snapshot already contained them **and** the live event re-arrived). The client had only text equality to fall back on, which covered user messages but not assistant/toolResult messages.
- **No tiebreaker for parallel tool bursts.** Back-to-back `message_end` frames from parallel tool calls could be dispatched in whichever order the renderer happened to reach them; without a server-assigned key the client could not restore the intended order.

The fix is additive and session-scoped: a monotonic `seq` per session plus a wall-clock `ts`. Existing `{type:"event"}` consumers ignore unknown keys, so old clients against new servers (and vice-versa) keep working - they just miss the new guarantees.

Full reasoning and alternatives considered are in [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

### Server side

`EventBuffer` (`src/server/agent/event-buffer.ts`) stores `{seq, ts, event}` tuples in a 1000-entry ring. `push()` assigns the next `seq` and stamps `ts = Date.now()`. It exposes:

- `since(fromSeq)` - entries with `seq > fromSeq` (the reconnect tail).
- `canResumeFrom(fromSeq)` - false if `fromSeq` is older than the retained window (ring eviction).
- `lastSeq` - highest assigned seq (used in `resume_gap` so the client can resync).

All `{type:"event"}` broadcasts flow through a single helper `emitSessionEvent(session, event)` in `src/server/agent/session-manager.ts`. It truncates large content, pushes into the buffer, and broadcasts `{type:"event", data, seq, ts}` in lockstep. This replaces the previous pattern of paired `eventBuffer.push(...) + broadcast(...)` calls at six call sites; the helper is the only place that can assign a seq, which keeps the stream strictly monotonic even across call sites.

Other broadcast types (`session_status`, `session_title`, `messages`, `state`, `queue_update`, ...) do **not** carry `seq` - they are idempotent snapshots, not stream deltas, and the dup/reorder class of bug doesn't apply.

### Resume handshake

The WS protocol (`src/server/ws/protocol.ts`) gains two message types:

- `{type:"resume", fromSeq}` - client → server, sent immediately after `auth_ok` on a reconnect when the client has a non-zero `_highestSeq`.
- `{type:"resume_gap", lastSeq}` - server → client, sent when `canResumeFrom(fromSeq)` is false (the missed tail has already been evicted). The client resets its seq tracking to `lastSeq` and falls back to the `get_messages` snapshot path.

`src/server/ws/handler.ts` handles `resume` by replaying `since(fromSeq)` as normal `{type:"event"}` frames (same seq/ts as the originals), then the session continues to broadcast live events as they arrive. Clients that never send `resume` (old clients, or first-time connections with `_highestSeq === 0`) get the existing cold-connect path - `getState()` + `get_messages` - which is backward-compatible.

### Client side

`RemoteAgent` in `src/app/remote-agent.ts` tracks `_highestSeq` and a small `_pendingEvents` array:

- **Duplicate drop.** `seq <= _highestSeq` is silently discarded.
- **In-order dispatch.** `seq === _highestSeq + 1` advances the watermark and dispatches the event.
- **Out-of-order buffering.** Any higher seq is inserted into `_pendingEvents` (sorted by seq). After every ingest the drain loop pops entries whose seq is now contiguous and dispatches them. If `_pendingEvents` exceeds 500 entries the client abandons the gap and forces a snapshot refresh - a safety valve so a permanently-gapped client can't grow unbounded.
- **Baseline adoption.** The first seq'd frame on a fresh connection adopts `seq - 1` as the baseline, so the initial state-snapshot path doesn't stall waiting for a non-existent seq 1.
- **Reconnect.** On WS reopen, if `_highestSeq > 0`, the client sends `{type:"resume", fromSeq: _highestSeq}` **before** any other traffic. On `resume_gap` it resets `_highestSeq` to the server's `lastSeq` and falls back to `get_messages`.

Seq-less frames (old servers) fall through the dispatch path unchanged - the reducer still runs and the pre-seq dedup heuristics (user messages by text, assistant messages by id) still apply. There is no hard dependency on seq at render time; `messages[]` remains the authoritative ordered list, and seq only governs the event→state reducer.

### Tests

- `tests/event-buffer.test.ts` - seq monotonicity, eviction invariants, `since()` / `canResumeFrom()` / `lastSeq` semantics.
- `tests/remote-agent-seq-dedup.spec.ts` (+ `tests/fixtures/remote-agent-seq-dedup.html`) - file:// fixture driving synthetic WS frames through the reducer: duplicate drop, out-of-order buffering, `resume` on reconnect, compat fallback for seq-less frames, full-buffer replay dedup.
- `tests/e2e/ui/stories-streaming.spec.ts` - `ST-DEDUP-01` reproducing test: reconnect mid-stream must not duplicate or reorder events. Fails on master pre-fix, passes after.
- `tests/e2e/ui/stories-resilience.spec.ts` - `RE-07` (reconnect catch-up) unchanged and still green; the new `resume` path is a strict superset of its coverage.

### Key files

| File | Purpose |
|---|---|
| `src/server/agent/event-buffer.ts` | `{seq, ts, event}` ring buffer + `since()` / `canResumeFrom()` / `lastSeq` |
| `src/server/agent/session-manager.ts` | `emitSessionEvent()` - single push+broadcast helper |
| `src/server/ws/protocol.ts` | Additive `seq`/`ts` on `event`; new `resume` / `resume_gap` types |
| `src/server/ws/handler.ts` | Handles `resume`, emits `resume_gap` on eviction |
| `src/app/remote-agent.ts` | `_highestSeq`, `_pendingEvents`, reconnect `resume`, gap fallback |

---

## Verification event dedupe

Gate verification streams a separate event family (`gate_verification_step_output`, `gate_verification_step_end`, `gate_verification_complete`, ...) that does **not** flow through `emitSessionEvent` and the per-session seq pipeline above. Verification is goal-scoped, not session-scoped: the harness broadcasts via `broadcastToGoal(goalId, event)` to every WebSocket whose session belongs to the goal team, plus the dashboard `__viewer__` connection. The dedupe story for that family is described here.

### The fan-out problem

In the UI, every open session in a goal team has its own `RemoteAgent` with its own WebSocket. When a verification step writes a stdout line, the server delivers the resulting `gate_verification_step_output` payload to all N session sockets (one copy each), plus +1 for the dashboard's viewer WS when mounted. Pre-fix, each `RemoteAgent` independently re-broadcast the payload as a `document.dispatchEvent(new CustomEvent("gate-verification-event", {detail: msg}))`, so the document-level listeners in `<verification-output-modal>` and `<gate-verification-live>` appended one chunk per dispatch - a single log line ended up rendered N× (or (N+1)× with the dashboard mounted).

The bug is fundamentally about **fan-out at the dispatch layer, not the wire layer**: server-side broadcast volume is fine (clients legitimately need every session WS to stay live), but the listeners need to see each logical event exactly once.

### Server-assigned seq

`src/server/agent/verification-harness.ts` stamps a monotonic `seq: number` on every `gate_verification_*` payload it broadcasts. The protocol type in `src/server/ws/protocol.ts` carries the field additively - older clients ignore it, and a pre-`seq` server still fan-outs (the bus then falls back to a content hash, see below). The seq is unique within the verification stream of a single signal/step, which is all the bus needs to dedupe.

### The dedupe bus

`src/app/verification-event-bus.ts` is a module-scoped singleton that exports `dispatchVerificationEvent(msg)`. All dispatch sources - every `RemoteAgent` instance and the goal dashboard's viewer WS in `src/app/goal-dashboard.ts` - funnel through it instead of calling `document.dispatchEvent` directly. The bus computes a key from `(eventType, signalId, stepIndex, seq)`; if the key was seen recently, the dispatch is dropped, otherwise the bus emits the document-level CustomEvent and remembers the key.

The seen-set is bounded (~5000 keys) with FIFO/LRU eviction so a long-running session can't grow it without limit. The eviction window is wide enough that real fan-out (which happens within milliseconds of the original broadcast) is always within the window, but narrow enough to keep memory bounded across a multi-hour goal.

When `seq` is missing (older server, hand-written test fixtures), the bus falls back to hashing the salient payload fields (`stream`, `text`, `status`, ...) so identical fan-out copies still collapse - best-effort, since two semantically distinct events that happen to carry identical content would be coalesced. With the new server stamping `seq` on every event this fallback is only a compatibility shim.

### Bootstrap-vs-live overlap in the modal

`<verification-output-modal>` can be opened mid-stream after some output has already accumulated server-side. The modal seeds its rendered chunks from `initialOutput` (the bootstrap) and then continues consuming live events. Pre-fix, a live event whose payload was already in the bootstrap would be appended again, producing a visible "prefix shown twice" effect on reopen.

The fix tracks a high-water `seq` derived from the bootstrap and silently discards live events with `seq` ≤ that mark. The modal also short-circuits `_fetchBootstrapOutput` when `initialOutput` is already populated, eliminating a parallel snapshot race.

### AbortController listener hygiene

Lit re-renders the modal and live components on property changes; without disciplined teardown, `document.addEventListener` calls would accumulate across re-renders and listeners from prior mount cycles would keep firing on stale closures. `VerificationOutputModal` and `GateVerificationLive` now allocate a fresh `AbortController` on connect, pass `{ signal }` to every `addEventListener`, and call `controller.abort()` from `disconnectedCallback`. This guarantees listener count == 1 per live component instance, regardless of how many times Lit re-renders.

### Tests

- `tests/verification-dedup.spec.ts` (+ `tests/fixtures/verification-dedup-*`) - Playwright file:// fixture that dispatches the same `gate-verification-event` 6× and asserts a single rendered occurrence in both `<verification-output-modal>` and `<gate-verification-live>`. This pins the multi-layer guarantee end-to-end on the listener side.

### Key files

| File | Purpose |
|---|---|
| `src/app/verification-event-bus.ts` | Module-scoped dedupe funnel; `dispatchVerificationEvent(msg)` + bounded LRU seen-set |
| `src/app/remote-agent.ts` | Routes `gate_verification_*` WS frames through the bus instead of `document.dispatchEvent` |
| `src/app/goal-dashboard.ts` | Same routing for the dashboard `__viewer__` WS |
| `src/server/agent/verification-harness.ts` | Stamps monotonic `seq` on every `gate_verification_*` event |
| `src/server/ws/protocol.ts` | Additive `seq` field on the verification event union |
| `src/ui/components/VerificationOutputModal.ts` | `AbortController` listeners + bootstrap high-water seq |
| `src/ui/tools/renderers/GateVerificationLive.ts` | `AbortController` listeners on the live renderer |

For the parallel pattern on the agent stream (different event family, same shape of fix), see [Event stream ordering & dedup](#event-stream-ordering--dedup) above and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

---

## Steer-interruptible bash_bg wait

`bash_bg` action `wait` blocks the agent for up to 300 s (default) while the server long-polls `BgProcessManager.waitForExit()`. Without special handling, a steer (user or `team_steer`) arriving during that window would be accepted by the WebSocket handler but could not take effect until the wait resolved - the agent is stuck mid tool-call and the steer feels ignored.

**Contract.** When a steer is delivered for a session that has one or more in-flight `bash_bg wait` handlers:

- Every in-flight wait for that session is aborted immediately (the wait HTTP response resolves with `{ info, timedOut: false, aborted: true }`).
- The backgrounded processes are **not** killed - they keep running and can be re-queried via `bash_bg logs`, `grep`, or another `wait`.
- The shell extension translates the aborted result into a visible tool_result: `Process <hdr> wait interrupted by steer. Use 'logs' or 'wait' again to continue monitoring.`.
- The steer is then forwarded to `rpcClient.steer()` as usual and processed on the next turn.

### Why

Long waits made the agent feel unresponsive: users would type a correction, see it accepted, and then watch the UI sit idle for minutes because the agent was parked inside a `wait` tool call. Aborting the wait (not the process) keeps the correction latency proportional to the WebSocket round-trip, while preserving the original intent of having the process run in the background.

### Architecture

- `BgProcessManager.waits: Map<sessionId, Set<AbortController>>` - per-session registry of pending waits.
- `registerWait(sessionId, controller)` / `unregisterWait(sessionId, controller)` - called by the `/api/sessions/:id/bg-processes/:pid/wait` REST handler in its `try`/`finally` around `waitForExit(..., signal)`.
- `abortAllWaits(sessionId)` - aborts every registered controller for a session. Registry cleanup happens via the handlers' `finally` blocks (not inside `abortAllWaits`), so a single iterator pass is safe.
- `waitForExit(sessionId, processId, timeoutMs, signal?)` - races process `exit`, `setTimeout`, and `signal.abort` in a single promise with a shared `cleanup()` that clears the timer and removes the exit/abort listeners. A single `settled` flag guards against double-resolve.

### Call sites

Live-steer delivery is centralised on `SessionManager.deliverLiveSteer(sessionId, message)`, which enqueues the row into `promptQueue` and hands it to the single `SessionManager._dispatchSteer()` site. `_dispatchSteer` calls `bgProcessManager.abortAllWaits(sessionId)` before awaiting `rpcClient.steer(batchText)`, so every dispatch path runs through one abort site. All steer entry points that run while the agent is `streaming` go through this helper:

- `src/server/ws/handler.ts` - `case "steer"` (user-initiated live steer) calls `deliverLiveSteer` → `_dispatchSteer`.
- `src/server/agent/team-manager.ts` - `injectSteerMessage()` and the task-completion nudge (mid-turn `team_steer`) call `deliverLiveSteer` → `_dispatchSteer`.
- `src/server/agent/session-manager.ts` - `SessionManager.steerQueued()` flips `isSteered=true` and (if `status === "streaming"`) calls `bgProcessManager.abortAllWaits()` so a parked `bash_bg wait` resolves and a tool boundary actually arrives. The boundary handler in `handleAgentLifecycle` (`tool_execution_end`, with `agent_end` non-aborting as a safety net for non-tool turns) drains all consecutive steered rows via `dequeueAllSteered()` and hands them to `_dispatchSteer`.

Net result: `bgProcessManager.abortAllWaits(sessionId)` has exactly two call sites - once inside `_dispatchSteer` (every dispatch) and once inside `steerQueued` for the streaming case (so the parked wait resolves *before* a tool boundary can occur). Down from three pre-rewrite, with cleaner semantics.

### Termination cleanup

`SessionManager.terminateSession()` calls `bgProcessManager.abortAllWaits(id)` before `bgProcessManager.cleanup(id)`. `BgProcessManager.cleanup()` also calls `abortAllWaits()` defensively as its first step. This ensures any long-poll HTTP handlers still hanging in the server event loop resolve cleanly (as `aborted: true`) before the processes are killed and the session entry is dropped - no leaked Promises, no dangling `exit` listeners.

### Key files

| File | Purpose |
|---|---|
| `src/server/agent/bg-process-manager.ts` | `waits` registry, `registerWait`/`unregisterWait`/`abortAllWaits`, `waitForExit` with `AbortSignal` support |
| `src/server/agent/session-manager.ts` | `deliverLiveSteer()` helper; single `_dispatchSteer()` site (one `abortAllWaits` per dispatch); `steerQueued()` (one `abortAllWaits` to unblock parked waits); `_consumeSteerEcho()` / `_reconcileAfterAbort()` shadow-ledger lifecycle; `terminateSession()` termination-time abort |
| `src/server/agent/team-manager.ts` | Team-initiated steers routed through `deliverLiveSteer()` |
| `src/server/ws/handler.ts` | WebSocket `case "steer"` routed through `deliverLiveSteer()` |
| `src/server/server.ts` | `/bg-processes/:pid/wait` REST handler - creates the `AbortController`, registers it, passes `signal` to `waitForExit`, unregisters in `finally` |
| `defaults/tools/shell/extension.ts` | Translates `aborted: true` into the user-facing "wait interrupted by steer" tool_result |
| `tests/bg-process-manager.test.ts` | Unit tests (abort before exit, abort after exit no-op, abort after timeout no-op) |
| `tests/e2e/bg-wait-steer-abort.spec.ts` | API E2E: long-sleep bg process + concurrent steer, asserts fast abort and process still running |

---

## Chat surface UI invariants

Two surfaces in the chat client previously relied on time-based heuristics that gave intermittent, hard-to-repro misbehaviour (scroll snap-back / vibration in idle sessions, stale messages trailing after newer ones on session navigate). Both have been replaced with deterministic invariants the implementation must preserve.

### Chat scroll lock invariant

**What this is for.** The chat surface in `AgentInterface` (`src/ui/components/AgentInterface.ts`) is a streaming transcript: tool-use cards appear, tool-result blocks expand asynchronously as their content lands, markdown highlights and lazy-loaded images reflow, and the whole viewport must continue tracking the bottom of the conversation while the agent is talking. "Tail-chat" is the user-facing contract that says *if I am at the bottom when content arrives, I stay at the bottom*. The mechanism that enforces this contract is the scroll lock - a single boolean intent flag plus the bookkeeping needed to grow the scroll container without confusing browser-emitted echo events for user intent.

**Why this section exists.** Earlier iterations layered defenses on top of each other — a programmatic-scroll latch, a settle window, a carry-over flag, a jump-button suppression timer, a triple-rAF chain, a 10 %/10 px stick-grace band, an `_isAutoScrolling` debounce. Each layer was added to mask a race introduced by the previous one. After PR #468 collapsed all of that to a single `_stickToBottom` flag plus an echo ring, two regressions surfaced (false-positive Jump button on Chromium desktop, tail-chat lost mid-stream on iOS PWA). The current implementation is a vanilla-TS port of the [`use-stick-to-bottom`](https://github.com/stackblitz-labs/use-stick-to-bottom) library (731⭐, powers bolt.new) which had already solved both races upstream. **Do not re-introduce a deleted mechanism without first proving the new model can't handle the case** — every one of the deleted pieces was eventually shown to be masking a bug elsewhere rather than fixing one.

#### State inventory

All fields below live on `AgentInterface` (`src/ui/components/AgentInterface.ts`). The implementation is the canonical reference; this list explains *why* each piece exists.

| Field / constant | Role |
|---|---|
| `_isAtBottom: boolean` (default `true`) | Sticky intent. Toggleable by user gestures, RO callback, jump-to-bottom click, `setAutoScroll`. Reads as "do we currently want to be pinned?" |
| `_escapedFromLock: boolean` (default `false`) | True ONLY after a user-driven scroll-up that takes the viewport OUT of the 70 px near-bottom band. Cleared on jump-to-bottom click, sendMessage, session navigate, near-bottom auto-relock, or `setAutoScroll(true)`. The re-pin invariant is `_isAtBottom && !_escapedFromLock` — both flags must agree. |
| `_resizeDifference: number` | Set by RO callback on every height delta; reset via `requestAnimationFrame(() => setTimeout(…, 1))`. The deferred scroll handler bails when this is non-zero so a `scroll` event fired during an in-flight resize is not misclassified as user intent. |
| `_lastScrollTop: number` | Reference for up/down classification in the deferred scroll handler. |
| `_lastUserGestureTs: number` | `performance.now()` of the latest wheel/touch/keydown gesture. The deferred handler uses this with `USER_GESTURE_WINDOW_MS = 500` to gate user-vs-programmatic scroll-event classification — a programmatic `el.scrollTop = X` issued by another component or test harness must NOT escape the lock. |
| `_ignoreScrollToTop: number \| null` | Single-value latch set immediately before any programmatic `scrollTop` write (via `_writeScrollTop()`), consumed by the deferred handler. Replaces the 4-entry `_programmaticEchoes` ring — within one task only one programmatic write commits, so the ring was over-spec. |
| `_scrollDeferTimer` | Coalesces multiple `scroll` events into one `setTimeout(0)` macrotask so RO has a chance to set `_resizeDifference` first. |
| `_animation` | Spring rAF state. Used ONLY by the jump-to-bottom click landing (damping 0.7, stiffness 0.05, mass 1.25 — upstream defaults). Cancelled synchronously by every user-intent listener so a wheel-up during the spring releases immediately. |
| `_imageLoadHandler` | Capture-phase `load` listener on the scroll container. NOT redundant with RO `delta>0`: image/iframe decode + paint can land on the same task as the layout commit BEFORE the next RO microtask tick, causing a single-frame visible drift on Safari/iOS PWA where `overflow-anchor` has limited availability. |
| `STICK_TO_BOTTOM_OFFSET_PX = 70` | Near-bottom band (matches upstream). `_isNearBottom()` returns true when `scrollDifference ≤ 70`. A 30 px wheel-up auto-relocks on the next content growth without requiring a Jump click. |
| `USER_GESTURE_WINDOW_MS = 500` | Recent-gesture window for the freshness gate. |

Geometry getters: `_targetScrollTop()` is `scrollHeight - 1 - clientHeight` (the `-1` is intentional, matches upstream; avoids float-rounding edge cases where the browser clamps `scrollTop` one sub-pixel above the integer target). `_scrollDifference()` is the gap to that target; `_isNearBottom()` compares it against the 70 px band.

#### Contract

The scroll-lock subsystem is governed by a small set of cooperating handlers. Each has a narrow, documented job; nothing else is allowed to mutate `_isAtBottom` / `_escapedFromLock`.

1. **User-gesture handlers are the only synchronous writers of "escaped".** `wheel`, `touchstart`, and `keydown` (PageUp/PageDown/ArrowUp/ArrowDown/Home/End) are wired directly to the scroll container. Each stamps `_lastUserGestureTs = performance.now()`, cancels any in-flight spring, and — for unambiguous up gestures (`wheel` `deltaY < 0`, PageUp/ArrowUp/Home) — flips `_isAtBottom = false` synchronously BEFORE the resulting browser scroll event is dispatched. Down keys cancel the animation and let the deferred handler classify (typically auto-relocks via the near-bottom override). This is the contract that lets geometry never have to second-guess intent.
2. **Deferred scroll handler is the recompute path.** `_handleScroll` snapshots `(scrollTop, _ignoreScrollToTop, _lastUserGestureTs)` synchronously and queues `setTimeout(0)` (coalesced — only one timer in flight). The deferred body runs in this order:
   1. **Resize-in-flight bail.** If `_resizeDifference !== 0`, recompute the jump button (so visibility doesn't strand stale on bail paths) and return.
   2. **Echo latch.** If `scrollTop ≈ _ignoreScrollToTop`, recompute the jump button and return.
   3. **Gesture freshness gate.** If no wheel/touch/keydown has fired within `USER_GESTURE_WINDOW_MS`, treat the scroll event as programmatic-from-elsewhere; if we're sticky and have drifted, queue an rAF re-pin; recompute the jump button; return.
   4. **Up/down classification** against `_lastScrollTop`: a user scroll OUT of the near-bottom band sets `_escapedFromLock = true; _isAtBottom = false`; a scroll down clears `_escapedFromLock`.
   5. **Near-bottom override.** If `_isNearBottom()`, force `_escapedFromLock = false; _isAtBottom = true`. Internalises upstream's `isAtBottom = isAtBottom || isNearBottom` semantic.
   6. **Recompute jump button.**
3. **ResizeObserver callback handles size changes.** Computes `delta`, bails on width-only reflow, sets `_resizeDifference` and schedules its rAF + `setTimeout(1 ms)` reset, overscroll-clamps `scrollTop > targetScrollTop`. On positive growth, if `_isAtBottom && !_escapedFromLock` it pins synchronously via `_scrollToBottomNow({ animate: false })`. On negative shrink, if `_isNearBottom() && !_escapedFromLock` it re-engages stick (`_isAtBottom = true`) and applies the post-collapse clamp from `tests/collapse-scroll-bugs.spec.ts`.
4. **Capture-phase `_imageLoadHandler` covers the paint-vs-RO race.** Async `<img>` / `<iframe>` decode + paint can commit to layout BEFORE the next RO microtask tick. The handler pins synchronously when `_isAtBottom && !_escapedFromLock` — avoids a single-frame visible drift on Safari/iOS PWA where `overflow-anchor` has limited availability. Pairs with, not replaces, the RO `delta>0` branch.
5. **All programmatic `scrollTop` writes route through `_writeScrollTop()`.** The helper sets `_ignoreScrollToTop` immediately before the write so the resulting browser-emitted scroll event is consumed by the deferred handler's echo latch (step 2.2).
6. **Spring animation only on jump-to-bottom click.** `_scrollToBottomNow({ animate: true })` runs an rAF loop until `|delta| < 0.5 && |velocity| < 0.5`, re-reading the target each tick so RO growth during the animation moves the goalpost. All other re-pin sites use the synchronous `animate: false` fast path.
7. **Jump-button visibility is a pure function** of `!_isAtBottom && (dist > 0.5 × clientHeight)`, recomputed at every deferred-handler tick (including bail paths). Closes the original Bug A loophole where the echo-path early-return left `_showJumpToBottom = true` stranded at the tail.

**Session-navigate flow.** `setupSessionSubscription` resets `_isAtBottom = true`, `_escapedFromLock = false`, and after `await this.updateComplete` calls the synchronous pin. Subsequent async growth (markdown highlighting, hydrated tool-content, lazy decode reflows, KaTeX/Mermaid) is caught by the RO `delta>0` branch and the capture-phase load handler.

**`overflow-anchor: none` on the scroll container.** `agent-interface .overflow-y-auto` has inline `overflow-anchor: none`. CSS scroll-anchoring is Chromium-only (Safari has limited availability — see MDN); leaving it on would mean Chromium silently masked broken JS pin behaviour while Safari/iOS PWA users got only what the JS path actually delivered. With anchoring off everywhere, the JS pin path is the single contract — any regression surfaces on both engines, and Tier 2 / 2.5 tests on Chromium catch what users see on Safari.

#### Removed mechanisms (do NOT re-introduce)

Each was added to fix a symptom but masked a deeper race introduced by an earlier mechanism. Every one is now redundant under the algorithm above. If you find yourself reaching for one, the bug is somewhere else.

- **`_programmaticEchoes` ring buffer (4-entry).** Replaced by `_ignoreScrollToTop` single-value latch. Within one task only one programmatic write commits, so the ring was over-spec. (A no-op `_programmaticEchoes` array shim is preserved on the class for E2E test setup that still `.push()`es to it.)
- **`_pinIfSticking()` echo-return path.** Replaced by the deferred scroll handler's ordered bail steps (resize-in-flight → echo-latch → freshness gate). The previous "early `return` when echo matched" left `_showJumpToBottom` stale at the tail — Bug A in the post-PR-#468 issue analysis.
- **`_lastProgrammaticScrollTop` / `_lastProgrammaticScrollHeight` (single-pair echo latch).** Folded into `_ignoreScrollToTop`.
- **`_wasAtBottomAtLastUserScroll` (carry-over flag).** The geometry path that needed it (geometry-flip-in-`_handleScroll`) is gone; intent is mutated only by observed user gestures and the near-bottom override.
- **`_settleWindowActive` / `_settleWindowDeadline` / `_lastSettleScrollHeight` / `_settleQuietTickCount` (3 s post-navigate settle window).** A timer-bounded loop that re-pinned on every RO tick for up to 3 s after session navigate. Replaced by the `_isAtBottom = true` reset on session navigate plus the always-on RO `delta>0` re-pin.
- **`_suppressJumpUntilTs` (600 ms jump-button click-suppression timer).** Unnecessary now: jump-button visibility is a pure function of `!_isAtBottom + dist`, recomputed every tick.
- **Triple-rAF chain in `setupSessionSubscription`.** Replaced by single `await this.updateComplete` + synchronous pin (subsequent reflows caught by RO `delta>0`).
- **Geometry-based intent flip in `_handleScroll`.** Production code never mutates intent from raw geometry alone; only observed user gestures and the explicit near-bottom override do.
- **10 % / 10 px stick-grace band.** Gone with the geometry flip. The 70 px near-bottom band is structurally different — it auto-relocks rather than papering over misfires.
- **`requestAnimationFrame` re-assert inside `_scrollToBottom`.** Bypassed the echo latch; replaced by the single synchronous write inside `_writeScrollTop()` plus RO `delta>0` follow-up.
- **`_isAutoScrolling` timer.** Predates PR #468; do not re-add.

**Note on `_imageLoadHandler`.** A previous revision of this section listed the capture-phase `load` listener in the do-NOT-re-add list. It has been **deliberately restored** — the RO callback runs on a microtask boundary and can lag image/iframe decode by up to a frame on Safari/iOS PWA, which is exactly the engine where `overflow-anchor` can't paper over the gap. See the design doc's sensitivity matrix for the manual iOS verification beat that justifies keeping it.

#### Rules for future modifications

- **`setTimeout(0)` and `setTimeout(1)` are part of the contract**, not ad-hoc timers — the deferred scroll handler and the `_resizeDifference` reset both rely on task-boundary ordering vs the RO microtask. Do not replace either with rAF; rAF can land in the same frame as the scroll dispatch and miss the disambiguation.
- **Two flags, not one.** Anything that needs to ask "is the viewport pinned?" reads `_isAtBottom && !_escapedFromLock`. The legacy `_stickToBottom` getter/setter is a compat shim for E2E test setup; production paths use the new flags directly.
- **All programmatic `scrollTop` writes go through `_writeScrollTop()`.** A direct `scrollTop = ...` write skips the `_ignoreScrollToTop` latch and its echo will be misclassified by the deferred handler.
- **User gestures, not geometry, drive intent transitions to `escaped`.** The near-bottom override is the only path that auto-relocks; the deferred handler's classification step is the only path that auto-escapes (and only on a real gesture observed via the freshness gate).

**Behavioural tests.** `tests/agent-interface-scroll.spec.ts` (canonical `delta === 0` vibration regression), `tests/agent-interface-scroll-hardening.spec.ts` (sub-pixel echo absorbing, multi-write race, geometry-doesn't-flip-flag), `tests/scroll-anchor-shrink.spec.ts` (shrink/grow while scrolled up), `tests/collapse-scroll-bugs.spec.ts` (post-collapse clamp), `tests/mobile-scroll-keyboard.spec.ts`, `tests/e2e/ui/jump-to-bottom.spec.ts` (button visibility threshold + click), and `tests/e2e/ui/tail-chat-*.spec.ts` (reliability scenarios: real streaming burst, tool-card expand, rapid stream, session-navigate, user-scroll-up release, image-reflow, jump-button false-positive, near-bottom relock, tool-expand reflow). The tail-chat suite drives **real preconditions** (`STREAM_BURST`, `STAY_BUSY`, `page.mouse.wheel`, etc.) and asserts via outcome-only helpers — `expectLatestMessagePinned` reads only `getBoundingClientRect()` of the latest message vs the scroll container, and `disableScrollAnchoring` cascades `overflow-anchor: none` so Chromium ≡ Safari for the duration of the test. Tests must NEVER read private fields; if a test needs a new fact, add a public outcome to `tail-chat-helpers.ts` rather than reaching through. See [docs/design/tail-chat-redesign.md — Outcome of the use-stick-to-bottom port](design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).

### Proposal panel scroll lock invariant

The six proposal panels (`goal`, `project`, `role`, `tool`, `staff`, `workflow` in `src/app/render.ts`) re-render on every streamed delta of a `propose_*` tool_use block. Lit's `.value=` rewrite of the spec/prompt `<textarea>` and the markdown-block parent `<div>` resets `scrollTop` and the textarea's selection range on each commit, so without intervention a user who scrolls up to read mid-spec gets snapped back to the top on the next delta and an in-progress textarea edit loses its caret. The fix mirrors the chat scroll lock invariant rather than refactoring `AgentInterface` - the chat path has subtle invariants and the regression risk of a shared helper outweighs the duplication cost.

The logic lives in **`src/app/follow-tail.ts`** (`reconcileFollowTail(el)`), called from a `queueMicrotask` at the end of each panel's render so it fires after the synchronous DOM commit but before paint. The same three rules apply:

1. **Auto-scroll only on positive delta.** `delta < 0` (shrink) updates the cached height and returns. `delta === 0` is a no-op - the canonical vibration-loop fix from the chat surface. Only `delta > 0` triggers a programmatic `scrollTop` write, and only when `stickToBottom` is true.
2. **Programmatic-scroll echo filter, not timers.** Before each programmatic write the helper latches `(lastProgScrollTop, lastProgScrollHeight)`. The matching browser-emitted scroll event is consumed exactly once and the latch is cleared, so a later coincidental geometry match is treated as user intent.
3. **User intent is observed.** `wheel`, `touchstart`, and `keydown` (PageUp/Down, Home, End, Arrow Up/Down) listeners on the scroll container set `stickToBottom = false` immediately. The 5px tail is sub-pixel rounding tolerance only, not an intent heuristic.

Lock state is stored in a module-private `WeakMap<HTMLElement, LockState>` keyed by the scroll element. This matters for two reasons. First, when Lit re-renders and re-attaches the same element across deltas the WeakMap entry is reused, so the user's `stickToBottom = false` choice persists across re-renders without any explicit re-binding. Second, when the panel unmounts the element is GC-eligible and the WeakMap entry goes with it - a fresh remount of the same panel starts with a clean `{stickToBottom: true, lastScrollHeight: 0}` state. This is the **fresh-state-on-remount invariant**: panel close/reopen always behaves like a first render, never inherits stale lock state from the previous lifecycle.

Textarea selection (`selectionStart` / `selectionEnd`) is captured on `select`, `keyup`, and `click`, then re-applied via `setSelectionRange(...)` after every reconcile branch (positive delta, zero delta, and shrink) - `setSelectionRange` is a state mutation per the WHATWG spec and applies even when the textarea is not the active element, so the caret is in the right place when focus returns. The DOMException some browsers throw on detached/hidden inputs is swallowed.

**Timing choice.** Reconciliation runs in a `queueMicrotask` scheduled by each panel function, not via the parent `LitElement`'s `updateComplete` Promise. The six panels are plain functions returning `html\`\`` templates, so they have no `updateComplete` of their own; the microtask runs after the parent's synchronous render commit and before paint, which is the tightest deterministic hook available. A `ResizeObserver` would also work but adds an asynchronous tick before the first reconcile after stream-start - exactly when the user would perceive a snap.

When modifying proposal-panel scroll behaviour: route through `reconcileFollowTail` rather than touching `scrollTop` or `setSelectionRange` directly; do not introduce timer-based intent heuristics; do not widen the 5px tail. See `src/app/follow-tail.ts` and the panel render functions in `src/app/render.ts`. Behavioural twin test: `tests/follow-tail.spec.ts`.

### Proposal streaming flag

`state.proposalStreamingByTag: Record<string, boolean>` (in `src/app/state.ts`) tracks whether each proposal panel is currently receiving streamed deltas. Keyed by the `tag` from `PROPOSAL_PARSERS` - `goal_proposal`, `project_proposal`, `role_proposal`, `tool_proposal`, `staff_proposal`. Read via the `isProposalStreaming(tag)` accessor.

A per-tag map rather than a single boolean because the six panels can be in independent lifecycle states (e.g. an active `goal_proposal` and `project_proposal` simultaneously) and a scalar would force them to share a flag. The map also makes bulk-clear on session change cheap.

**Why the flag exists.** Without it the Create / Apply / Save buttons are clickable mid-stream and a user can submit before the spec/title has finished streaming, producing a goal/role/tool with truncated content. The flag drives (a) the `disabled` state of each panel's primary submit, (b) the `streamingBadge()` + `STREAMING_BORDER` indicator, and (c) consumers in `session-manager.ts` that may want to suppress destructive side-effects on streaming-mode fires.

**Writer (single owner): `RemoteAgent` in `src/app/remote-agent.ts`.** Set to `true` inside `_checkToolProposals(message, streaming=true)` immediately before the per-tag `callback(input, streaming)` fan-out. Cleared on the matching block-finish branch (`!streaming && blockId` - the `_processedProposalIds.add(blockId)` site, reached on `case "message_end"` and on full re-scans), and bulk-cleared on `case "agent_end"` and `RemoteAgent.reset()` so an aborted/errored turn never leaves the flag stuck on. Readers are the seven panel render functions in `src/app/render.ts`; they call `isProposalStreaming("<tag>_proposal")` once at the top.

**WebSocket reconnect.** The resume path (`{type:"resume", fromSeq}`) replays missed events through the same handler, so a replayed `message_update` re-sets the flag and a replayed `message_end` clears it - no extra logic. The resume-gap fallback (`get_messages`) re-scans the snapshot with `_checkToolProposals(m, false)`, which hits the block-finish branch for any propose_* block in the snapshot and clears any stale flag. The `agent_end` / `reset()` bulk-clears are the final safety net on hard disconnect or session change. Cross-session isolation: `state.proposalStreamingByTag` is a singleton on the global `state` object cleared on `reset()`, which fires on session switch.

### Reducer ordering invariant

Transcript ordering is a single-source-of-truth concern owned by the pure reducer in `src/app/message-reducer.ts`. `RemoteAgent.handleServerMessage` / `handleAgentEvent` are thin dispatchers that translate WebSocket frames into actions and apply them via `reduce(state, action)`; the reducer's `messages` array is the canonical render input - there are no client-only buckets and no render-time sort. The invariant is:

- **Every message carries an `_order: number` and `_insertionTick: number`, and the reducer sorts by `(_order ASC, _insertionTick ASC)` exactly once per `apply()`.** Server live events use the monotonic per-session `seq` (positive integer). Snapshot rows use `_order = SNAPSHOT_ORDER_FLOOR + i` (≡ `-1_000_000_000 + i`) so every snapshot order is strictly less than every live `seq`, no coordination required. `tool_permission_needed` frames are stamped via `EventBuffer.pushFrame()` and treated like a live event. Synthetics (compaction marker, system notifications, error rows) sit at `highestSeq + 0.5`. Optimistic prompts/steers sit at `Number.MAX_SAFE_INTEGER - 1e9 + tick` so they always tail-position until the server echo replaces them by id (or by text fallback when the optimistic id is `^optimistic_`).
- **The server snapshot is authoritative for any id it contains.** On a `snapshot` action the reducer drops every prior row whose id appears in the snapshot, then merges in the surviving client-only rows (optimistic / synthetic / permission). Permission cards survive iff their id is not in the snapshot **and** no snapshot row has a greater `_order` - the old `_pendingPermissionCards` `maxServerTs` cutoff is gone. The synthetic compaction marker — now a rich `__compaction_summary` tool render (see [compaction.md](compaction.md); persistence and pre-compaction history surface in [compaction-history.md](compaction-history.md)) — also falls back to a text-prefix check (`"Context compacted"`) so a legacy snapshot row without a stable id still wins. **The survivor filter applies four equivalence tiers, in order, to live server-origin rows:** (1) string `id` match; (2) `toolResult` rows whose `toolCallId` matches a snapshot row's `toolCallId`; (3) `assistant` rows containing a `toolCall` whose `id` matches a snapshot assistant row's inner `toolCall.id`; (4) plain-text rows (assistant/user with no `toolCall` content and not a `toolResult`) whose `(role, normalisedText)` matches a snapshot row - detected via the `isPlainTextRow` and `normaliseText` helpers. Tiers 2 and 3 cover the un-id'd `message_end` case for tool-bearing rows (Bug 2 / scenario 08 bg-3, regression-tested by `tests/dual-render-bg3.test.ts`); tier 4 covers id-less / id-mismatched live plain-text `message_end` rows that would otherwise duplicate on every visibility-driven snapshot tick (new-tab dup bug, regression-tested by `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts`). **Invariant: tier 4 must NEVER apply to `toolResult` rows** - those are owned by tier 2; widening tier 4 to cover them would re-open the bash_bg.wait dup bug because two distinct bg waits with identical text content but different `toolCallId`s would collapse to one. Do not add a fifth tier without first checking whether one of the existing four can be extended.
- **Render trusts the reducer verbatim.** `MessageList.buildRenderItems` keys every row by id (synthetic fallback `synth:${origin}:${order}:${tick}` for rows without server ids) - no `msg:${i}` index keys, no render-time sort. The streaming-message preview is hidden at render time when `state.streamingMessage?.id === m.id`; the old `_deferredAssistantMessage` mutable slot is gone.
- **Thirteen actions cover every transcript mutation.** `live-event`, `snapshot`, `optimistic-prompt`, `optimistic-steer`, `permission-needed`, `permission-resolved`, `compaction-placeholder`, `compaction-result`, `system-notification`, `error`, `deny-permission-filter`, `replace-messages`, `reset`. If a new transcript-touching code path can't be expressed as one of these, add a new action - do not bypass the reducer with a direct push. The pre-reducer mechanisms `_deferredAssistantMessage`, `_liveEventMessages`, `_pendingPermissionCards`, `_compactionSyntheticMessages`, `flushDeferredMessage`, optimistic-text dedupe, the snapshot-merge stable-sort by `(timestamp, insertionOrder)`, and `MessageList.buildRenderItems` index keys have all been deleted; if you find yourself wanting to reintroduce one, the design is wrong.

When extending transcript handling: every new transcript mutation goes through a new action in the reducer - do **not** push directly into `state.messages` from `RemoteAgent`. Compute `_order` from `seq` (live), `SNAPSHOT_ORDER_FLOOR + i` (snapshot), `highestSeq + 0.5` (synthetic), or the optimistic sentinel (user-typed). Reconciliation always goes id-first; text fallback is reserved for the optimistic-prompt and compaction-marker paths and nowhere else. Pinned by `tests/message-reducer.test.ts` (12 scenarios incl. proposal burst and `ask_user_choices` envelope routing) and the ST-DEDUP-02 / ST-DEDUP-03 / ST-DEDUP-04 stories in `tests/e2e/ui/stories-streaming.spec.ts`. Full design: [`docs/design/unified-message-ordering-reducer.md`](design/unified-message-ordering-reducer.md).

### Streaming message id (synthetic fallback)

When an assistant `message_end` carries tool calls, the streaming container in `AgentInterface.ts` keeps owning the rendered card until the next event arrives, while the same message is also appended to `state.messages` by the reducer. The visible-messages filter hides the duplicate by id-equality (`m.id !== streamingMessageId`). Real LLM streams sometimes deliver `message_end` without a string `id` (undefined / null / numeric / `0` / `""`); the historical inline check `typeof msg.id === "string" ? msg.id : undefined` demoted `streamingMessageId` to `undefined`, the `!streamingMessageId` short-circuit opened the filter, and the card rendered twice - each instance with its own `<bg-process-renderer>` and its own `Date.now()` start time, diverging visibly during a parked `bash_bg.wait` where no further events arrive to reconcile.

The canonical key is computed by `computeStreamingMessageId(msg)` in `src/app/streaming-message-id.ts`: prefer a non-empty string `msg.id`, otherwise fall back to `synth:tc:<firstToolCallId>` (toolCall ids are stable across `message_update` deltas), otherwise `undefined`. Both sites in `src/app/remote-agent.ts` - the `streamingMessageId` field assignment **and** the `id` stamped onto the reducer entry before the `live-event` action - must go through the helper, or the two diverge and the filter's id-equality check fails. The defensive `if (streamingMessage && m === streamingMessage) return false` guard in `AgentInterface.renderMessages` is belt-and-braces for the case where the streaming message is the same object reference as a row in `messages`; it does not replace the id-equality path because production hits the separate-objects case via the reducer's `live-event` append.

Follow-up not in this fix: `BgProcessRenderer.getCallStart` keys its start-time WeakMap on the `params` object identity rather than on `bgId`. Two render paths produce two distinct `params` objects → two start times. Re-keying on `bgId` would mask the *visible* dual-timer symptom even if the dual-render itself recurred for some other reason - worth doing as defence in depth, but a separate goal.

Regression tests: `tests/dual-render-noid-message.test.ts` (id=undefined/null/numeric/empty-string cases), `tests/message-reducer.test.ts`, `tests/e2e/ui/bg-wait-no-dup.spec.ts`.

---

## Errored-turn recovery (implicit unstick on new input)

When an agent turn ends with `stopReason: "error"` (malformed tool_use JSON, provider transport blip not on the whitelist, content-filter trip, etc.), `SessionManager.handleAgentLifecycle` sets `session.lastTurnErrored = true`. Historically the queue was then fully gated: any subsequent prompt or steer sat in `promptQueue` forever until the user clicked the UI Retry button. That worked for "human needs to decide", but it created a permanent-wedge failure mode for transient glitches the `TRANSIENT_ERROR_PATTERNS` list didn't match, and it silently swallowed team-lead nudges to errored workers (stalling whole teams overnight).

### Design

**Process, don't retry.** A new prompt or steer arriving at a wedged session is treated as fresh intent. `SessionManager` clears the error flag, prepends a short `[SYSTEM: previous turn failed with: <snippet>. Ignore the incomplete last turn and handle the following.]` stub (via `buildErrorRecoveryPrefix`), and dispatches the new message. The failed turn is **not** re-attempted - the sender gets to decide what happens next, not the stuck turn. The explicit UI Retry button still exists for the "please re-attempt that turn" case; implicit unstick is strictly additive.

The broken assistant message (with a malformed `tool_use` block and no matching `tool_result`) stays in transcript history. Providers tolerate this as long as the next message is regular user text, not a `tool_result`; the system-prefix keeps the model oriented.

### Consecutive-error cap

`session.consecutiveErrorTurns: number` (on `SessionInfo`) is the brake. It increments on every `message_end` with `stopReason: "error"`, resets to 0 on any successful `message_end`, and is forced to 0 by the explicit-Retry path (`retryLastPrompt`) so a deliberate human action never erodes the budget.

`MAX_CONSECUTIVE_ERROR_TURNS = 3` (module-local constant in `src/server/agent/session-manager.ts`). Behaviour:

- `consecutiveErrorTurns < 3`: implicit unstick fires. `lastTurnErrored`, `lastTurnErrorMessage`, `turnHadToolCalls`, `transientRetryAttempts` are cleared (but **not** `consecutiveErrorTurns` - that only drops on a real success). Any `pendingAutoRetryTimer` is cancelled so we don't double-dispatch. Prefixed message dispatches; any already-parked queue items drain after it (unprefixed).
- `consecutiveErrorTurns ≥ 3`: the incoming message parks in `promptQueue` (today's pre-fix behaviour), and `[session-manager] Session ... has N consecutive errors; parking incoming prompt. Human action required (click Retry or fix upstream issue).` is logged. Parked items drain automatically once a human resolves the upstream problem and clicks Retry.

This is strictly better than the pre-fix state: one-off glitches self-heal on the next message; persistent failures stop costing model calls after 3 attempts and match the old "parked awaiting human" endpoint. No exponential backoff - for auth/quota failures no wait helps, so a hard stop is the right final state.

### Entry points

- `SessionManager.enqueuePrompt` (`src/server/agent/session-manager.ts`) - user / REST prompt arrival.
- `SessionManager.deliverLiveSteer` - WS `{type:"steer"}` and team-manager steer paths. Enqueues into `promptQueue` as `{ isSteered: true }` and hands to `_dispatchSteer`, which removes the row before awaiting `rpcClient.steer()` and pushes the batch text onto the shadow ledger on success. The PI-25b/c invariant that steers survive a Stop/retry roundtrip is preserved by the shadow ledger → `_reconcileAfterAbort` → `enqueueAtFront` → post-respawn `drainQueue` chain, not by an in-row `dispatched` flag (which has been deleted).
- Both emit a one-line log on the implicit-unstick path recording `sessionId`, `source` (`enqueuePrompt` vs `deliverLiveSteer`), and current `consecutiveErrorTurns`, so the rescue-vs-park ratio is observable in practice.

### Team-manager suppression removed

The old `if (teamLeadSession.lastTurnErrored) { suppress }` guard in `team-manager.ts` existed solely because a nudge to an errored team lead would vanish into the queue forever. With implicit unstick + the cap, `SessionManager` is the single source of truth for error-state policy: the nudge either unsticks the lead (≤ 3 errors) or parks (≥ 3). TeamManager no longer second-guesses, which closes the "worker idle → nudge dropped → team stalls" path.

### Key files

| File | Role |
| --- | --- |
| `src/server/agent/session-manager.ts` | `SessionInfo.consecutiveErrorTurns`, `MAX_CONSECUTIVE_ERROR_TURNS`, increment/reset in `handleAgentLifecycle`, implicit-unstick branches in `enqueuePrompt` and `deliverLiveSteer`, cap-driven parking, `buildErrorRecoveryPrefix`, reset-on-success in `retryLastPrompt` |
| `src/server/agent/team-manager.ts` | Removed `lastTurnErrored` suppression in the worker-idle notify path; delivery now unconditional |
| `tests/queue-dispatch.spec.ts` | Unit coverage: happy-path unstick, cap parking, success resets counter, explicit Retry bypasses cap, steer path, queue drain, auto-retry timer cancellation |
| `tests/e2e/stuck-session-recovery.spec.ts` | API E2E: mock-agent error turn → new prompt dispatches without UI Retry |

---

## Viewer WebSocket

The `/ws/viewer` endpoint provides a read-only, sessionless WebSocket connection for the goal dashboard to receive live gate verification events.

### Why a separate endpoint?

The main `/ws/:sessionId` endpoint binds a WebSocket to a specific agent session. When the user navigates to the goal dashboard, no session is active - the `RemoteAgent` disconnects. Without a connected WebSocket, `gate_verification_step_output` events from the server never reach the browser, so the verification output modal stays empty. The viewer endpoint solves this by keeping a lightweight connection open while the dashboard is mounted.

### Protocol

1. Client opens `ws(s)://<host>/ws/viewer`
2. Client sends `{ type: "auth", token: "<gateway-token>" }` - same auth as session connections
3. Server validates the token and responds with `{ type: "auth_ok" }`. The connection is marked as authenticated but is **not** associated with any session
4. Server broadcasts via `broadcastToGoal()`, which has a fallback path that sends to all authenticated clients with no session ID - this is how events reach the viewer
5. All client-to-server messages after auth are ignored (read-only)

### Client lifecycle

- **Connect on mount**: `loadDashboardData()` in `goal-dashboard.ts` opens the viewer WS after setting the current goal ID
- **Dispatch events**: Incoming messages are dispatched as `gate-verification-event` CustomEvents on `document`, matching the same pattern `RemoteAgent` uses - so `VerificationOutputModal` and `handleLiveVerificationEvent` work without modification
- **Disconnect on unmount**: `clearDashboardState()` closes the connection and clears the reconnect timer
- **Auto-reconnect**: On unexpected close, reconnects after a 3s delay (only if the dashboard is still mounted). Brief gaps are acceptable because the dashboard also polls gate status periodically

### Server handling

The upgrade handler in `server.ts` matches `/ws/viewer` alongside `/ws/:sessionId`. The WS handler in `handler.ts` recognizes the `__viewer__` sentinel session ID: after successful auth, it sends `auth_ok` and returns immediately without calling `sessionManager.addClient()` or syncing session state. No changes to `broadcastToGoal()` were needed - the existing fallback path already sends to authenticated clients with no session association.

## Goals, workflows, tasks & gates

See [goals-workflows-tasks.md](goals-workflows-tasks.md) for the full architecture.

### Goal re-attempt flow

1. User clicks "Re-attempt" in goal dashboard or sidebar
2. Goal assistant session created with `reattemptGoalId` → original goal's context loaded via `buildReattemptContext()`
3. Assistant guides: what went wrong, approach (revert/fix/both), new spec
4. On accept: old goal archived, new goal gets `reattemptOf` link

**Data:** `PersistedGoal.reattemptOf`, `PersistedSession.reattemptGoalId`. API: `POST /api/sessions` accepts `reattemptGoalId`; goals accept `reattemptOf`.

**PR URL in re-attempt context:** `buildReattemptContext(goal, prStatusStore)` reads the original goal's PR URL from `PrStatusStore` (`src/server/agent/pr-status-store.ts`), the single source of truth — `Goal.prUrl` no longer exists. The store is sticky and persists across restarts, so an archived or merged goal's last-known PR URL still surfaces in the `**PR URL:**` line. `SessionManager` threads the store through `PipelineContext.prStatusStore` so both the legacy and pipeline session-creation paths agree on the same source.

**Visibility:** the "Re-attempt" button is shown whenever the goal has no active team and no live (non-terminated) session - covering fresh, shelved, stopped-team, archived, and merged goals. It is hidden only while a team-lead session or any other live session is running for the goal. Sidebar predicate lives in `src/app/render-helpers.ts`; dashboard nav predicate lives in `src/app/goal-dashboard.ts::renderNavBar`.

---

## LSP

The LSP supervisor gives agents IDE-grade code intelligence (definition, references, hover, diagnostics, symbols, rename) instead of `grep` + `read` + `npm run check`. One language-server child per `(worktreePath, language)`, shared across sessions, LRU-evicted at a hard cap, idle-shutdown after a TTL.

- Entry point: [`src/server/lsp/supervisor.ts`](../src/server/lsp/supervisor.ts) (singleton owned by `SessionManager`). Lifecycle hooks land in `src/server/agent/session-setup.ts` (pre-warm + acquire) and `src/server/agent/session-manager.ts` (release on termination).
- Tool YAMLs: [`defaults/tools/lsp/`](../defaults/tools/lsp/) — seven `lsp_*` tools, each POSTing to `/api/lsp/<method>`. Budget-pinned by `tests/tool-description-budget.test.ts`.
- Design contract: [docs/design/lsp-code-intelligence.md](design/lsp-code-intelligence.md).
- Operator + agent reference: [docs/lsp.md](lsp.md) (supported languages, config keys, troubleshooting, when-to-use guidance).

## Disk state

### `defaults/` - version controlled (shipped builtins)

| File / Directory | Owner | Purpose |
|---|---|---|
| `system-prompt.md` | `cli.ts`, `system-prompt.ts::resolveSystemPromptPath` | Global system prompt template (read directly from `defaults/`; only copied to `.bobbit/config/` when the user opts in via `POST /api/system-prompt/customise`) |
| `roles/*.yaml` | `RoleStore` | Built-in role definitions + tool access |
| `roles/assistant/*.yaml` | `assistant-registry.ts` | Built-in assistant prompts |
| `workflows/*.yaml` | (legacy) | Historical default workflow seeds. No longer copied into new projects - the server seeds nothing; the project assistant designs workflows. Not read by `BuiltinConfigProvider` at runtime. See [No default workflow scaffold](#no-default-workflow-scaffold). |
| `tools/<group>/*.yaml` | `ToolManager` | Built-in tool definitions + extensions |
| `tool-group-policies.yaml` | `ToolGroupPolicyStore` | Built-in group grant policies |

Copied to `dist/server/defaults/` at build time by `scripts/copy-defaults.mjs`. Read at runtime by `BuiltinConfigProvider`.

### `.bobbit/config/` - runtime overrides (gitignored)

| File / Directory | Owner | Purpose |
|---|---|---|
| `project.yaml` | `ProjectConfigStore` | Project settings |
| `roles/*.yaml` | `RoleStore` | Server/project role overrides |
| `tools/<group>/*.yaml` | `ToolManager` | Server/project tool overrides |
| `tool-group-policies.yaml` | `ToolGroupPolicyStore` | Server/project policy overrides |
| `mcp.json` | `McpManager` | MCP server overrides |

### `<project-root>/.bobbit/state/` - per-project, gitignored

Each registered project has its own state directory. All store data is scoped to the owning project.

| File / Directory | Owner | Purpose |
|---|---|---|
| `goals.json` | `GoalStore` | Goal definitions |
| `sessions.json` | `SessionStore` | Session metadata |
| `tasks.json` | `TaskStore` | Task state |
| `gates.json` | `GateStore` | Gate state + signals |
| `team-state.json` | `TeamStore` | Team agents/roles |
| `staff.json` | `StaffStore` | Staff agents |
| `search.flex/` | `SearchService` | FlexSearch index (JSON files under `index/` plus `meta.json`). See [Semantic search](#semantic-search). |
| `costs/` | `CostTracker` | Token/cost data |
| `mcp-tool-docs/` | `McpManager` | Auto-generated MCP tool docs + summary caches |

### `<server-cwd>/.bobbit/state/` - global, gitignored

Only truly global state lives in the server's central state directory.

| File / Directory | Owner | Purpose |
|---|---|---|
| `projects.json` | `ProjectRegistry` | Registered project definitions |
| `token` | `token.ts` | Auth token (0600) |
| `session-colors.json` | `ColorStore` | Session colors |
| `preferences.json` | `PreferencesStore` | Key-value prefs |
| `session-prompts/` | `system-prompt.ts` | Per-session prompts |
| `tls/` | `tls.ts` | TLS certs |
| `gateway-url` | `cli.ts` | Gateway base URL used by same-host tool extensions for callbacks. Wildcard binds (`--host 0.0.0.0` / `--host ::`) are normalised to a loopback peer (`127.0.0.1` / `[::1]`) by `loopbackForBind` in `src/server/cli-loopback.ts` before the file is written — wildcards are valid listen addresses but not valid connect peers, and the agent's `apiCall` helper (`defaults/tools/_shared/gateway.ts`) reads this file. The human-readable `Listening:` console line keeps the literal bind host. |
| `gateway-restart` | `harness.ts` | Dev restart sentinel |
| `rpc-debug.log` | `rpc-bridge.ts` | RPC event log |
| `mcp-extensions/` | `tool-activation.ts` | MCP proxy extensions |
| `preview/<sid>/` | `src/server/preview/mount.ts` | Per-session preview mount (entry HTML + sibling assets). See [`docs/preview-architecture.md`](preview-architecture.md). |
| `auth-cookies.json` | `src/server/auth/cookie.ts` | `bobbit_session` cookie store (HttpOnly, server-side; mode `0o600`). |

### Global

| File | Purpose |
|---|---|
| `~/.bobbit/agent/auth.json` | API auth credentials |
| `~/.bobbit/agent/bin/{fd,rg}[.exe]` | Bundled search binaries staged at gateway boot from `@bobbit/binaries-<plat>-<arch>` optional sub-packages. Picked up by pi-coding-agent's `getToolPath()`. Resolver + staging live in `src/server/binaries.ts`; build/release flow in [`docs/releasing.md`](releasing.md). |
