# G6 — Claude Agent SDK persistence and resume

## Corrected SDK surface and decision

The pinned dependency is `@anthropic-ai/claude-agent-sdk@0.3.222`
(`package.json`, `package-lock.json`). Its `sdk.d.ts` exposes:

```ts
getSessionInfo(sessionId, { dir? }): Promise<SDKSessionInfo | undefined>
getSessionMessages(sessionId, { dir?, limit?, offset?, includeSystemMessages? }): Promise<SessionMessage[]>
forkSession(sessionId, { dir?, upToMessageId?, title? }): Promise<{ sessionId: string }>

type SessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
};
```

`getSessionInfo` and `getSessionMessages` are the SDK-owned source of truth for
valid SDK session existence and visible history. G6 keeps one Bobbit
`SessionStore` record per Bobbit session: it persists only
`runtime: "claude-agent-sdk"`, the opaque SDK UUID, and the existing verified
model/thinking tuple. It does not persist raw SDK messages, synthesize Pi JSONL,
or send Pi `switch_session`.

The SDK also exports `forkSession`. G6 does **not** claim that the SDK lacks a
fork primitive. Live SDK Fork nevertheless remains explicitly unsupported in
this bounded goal: Bobbit's live Fork contract spans an active-query snapshot,
worktree/config creation, author-sidecar ownership, tool-content and proposal
ownership, and destination lifecycle. There is no reviewed atomic
synchronization/rollback contract joining an external SDK fork mutation to
Bobbit destination creation. Calling the SDK primitive here could leave an
orphaned remote fork or an inconsistent Bobbit destination. Consequently,
`POST /api/sessions/:id/fork` returns `422 RUNTIME_FORK_UNSUPPORTED` before
allocating a destination or doing Pi work.

## Audited baseline

| Concern | Existing seam | Status |
|---|---|---|
| Runtime selection | `src/server/agent/session-runtime.ts::resolveSessionRuntime`, `createSessionBridge` | Implemented; only explicit `claude-agent-sdk` selects the SDK. Anthropic remains Pi. |
| Query/restart identity | `src/server/agent/claude-agent-sdk-bridge.ts::ClaudeAgentSdkBridge.startInternal` | Implemented; one async-input query receives `options.resume`; no Pi replay command. |
| Durable metadata | `session-store.ts::PersistedSession`, `UpdatableSessionFields`; `session-setup.ts::persistOnce`; `session-manager.ts::persistSessionMetadata` | Implemented in the existing store. |
| Restore/replacement | `session-manager.ts::restoreOneSession`, `restoreSession`, role replacement, `forceAbort` | Implemented; validates the UUID at boot and skips Pi rehydration at `:7966`, `:10388`, and `:12816`. |
| Queue/steer recovery | `session-manager.ts::_dispatchSteer`, `_consumeSteerEcho`, `_reconcileInFlightSteers` | Implemented ownership remains in `SessionManager`; the bridge only acknowledges ordered input. |
| Automatic compaction | `session-setup.ts::resolveSdkRuntimeOptions`, SDK bridge `PreCompact` hook | Implemented; reuses `LifecycleHub.dispatch("beforeCompact", ...)`. Manual SDK `compact()` remains unsupported. |
| Deterministic boot restart | `tests/e2e/claude-agent-sdk-session-restart.spec.ts` | Implemented for stored id, `resume`, post-restart prompt, and co-resident Pi regression. |

## Ownership and recovery flow

1. `session-setup.ts::resolveSdkRuntimeOptions` chooses the runtime;
   `persistOnce` creates the ordinary session row. `executePlan`/`spawnAgent`
   starts the query, and `SessionManager.persistSessionMetadata` records the
   SDK UUID before idle.
2. `ClaudeAgentSdkBridge` owns only its query, async input queue, event
   translator state, listeners, readiness/failure state, and observed SDK id.
   It does not write Bobbit persistence or drain queues.
3. `SessionManager` owns status, `PromptQueue`, the durable in-flight-steer
   ledger, author sidecars, replacement fencing, and client event broadcasts.
   During restore it stages events until canonical install, reconciles only
   proven/unechoed steers once, then invokes `_dispatchBootContinuation` for
   interrupted interactive work. Verification sessions remain owned by
   `VerificationHarness`.
4. `SessionStore` owns Bobbit identity and minimal runtime metadata, while the
   SDK's session directory (looked up with `{ dir: persisted.cwd }`) owns
   conversation history. The official SDK functions are accessors, not another
   Bobbit database.
5. SDK automatic compaction remains SDK-owned. `PreCompact` dispatches the
   existing hook; the same opaque UUID is retained/persisted and used on the
   next replacement or boot resume. No Bobbit compact transcript is made.

## History, archived Continue, and Fork boundaries

### Visible history

Add a small SDK session-access helper, for example
`src/server/agent/claude-agent-sdk-session-access.ts`:

```ts
readSdkSessionInfo({ sessionId, cwd }): Promise<SDKSessionInfo | undefined>
readSdkSessionMessages({ sessionId, cwd }): Promise<SessionMessage[]>
```

It lazily loads the pinned SDK, calls the official functions with `{ dir: cwd }`,
maps import/filesystem/provider errors to the existing sanitized
`ClaudeAgentSdkUnavailableError`, and is injected through a deterministic
helper-dependency factory. It must not inspect `~/.claude` paths directly. It
has no fork helper or SDK-fork dependency.

Add a pure adapter alongside
`src/server/agent/claude-sdk-event-translator.ts` that converts the official
`SessionMessage[]` shape into the same normalized message snapshot consumed by
`SessionManager.buildVisibleMessageSnapshot`. Preserve `uuid`, user/assistant
ordering, `parent_tool_use_id`, and system-message behavior; treat the
`message: unknown` payload as SDK data and use the existing translator's
message/content normalization rather than a Pi JSONL parser. `getSessionMessages`
returns chronological conversation messages; request `includeSystemMessages`
only where the existing snapshot contract requires those system boundaries.

Wire live `ClaudeAgentSdkBridge.getMessages()` to this helper so
`SessionManager.getMessagesSnapshotBase()` and `ws/handler.ts` `get_messages`
return an ordinary visible snapshot. Wire
`SessionManager.getArchivedMessages()` to the same helper for an archived SDK
record instead of the Pi `agentSessionFile` parser. A missing `getSessionInfo`
source is a clear `SDK_SESSION_UNAVAILABLE` result, not an empty successful
snapshot; a source with a valid `SDKSessionInfo` and zero messages is valid.

### Archived Continue where valid

At `src/server/server.ts` `POST /api/sessions/:archivedId/continue` (around
`:14482`), branch on `ps.runtime === "claude-agent-sdk"` before any
`agentSessionFile`, `sessionFileCopy`, transcript-sidecar, or worktree clone
work:

1. Require a valid persisted SDK UUID/model tuple, then preflight the official
   `readSdkSessionInfo({ sessionId: ps.claudeAgentSdkSessionId, cwd: ps.cwd })`
   **before destination allocation**. Missing/malformed persisted metadata
   returns `422 RUNTIME_CONTINUE_UNSUPPORTED`; an unavailable SDK source returns
   `404 SDK_SESSION_UNAVAILABLE` with a clear “SDK conversation is unavailable”
   message. Either failure creates nothing.
2. Create a fresh Bobbit wrapper through the existing internal
   `SessionManager.createSession(...)` path, passing the **same** SDK UUID only
   through internal `opts.claudeAgentSdkSessionId`. `SessionSetupPlan` and
   `resolveSdkRuntimeOptions` thread that value into
   `SessionBridgeOptions.claudeAgentSdkSessionId`, while preserving the normal
   project/model/role/sandbox validity checks. The public request surface never
   accepts a caller-controlled resume id.
3. Persist that runtime/id tuple before the new session becomes idle. The
   archived Bobbit record remains archived; this is a new Bobbit wrapper that
   resumes the same SDK conversation, not a copied transcript.

When G6 was designed, SDK sessions remained fail-closed in Docker because the
existing bridge rejected that runtime there. [G9 — Claude Agent SDK Docker
sandbox runtime](claude-agent-sdk-sandbox-g9.md) supersedes that Docker
limitation for supported sandbox SDK sessions: Continue follows normal sandbox
wiring and container-scoped history access, never a host-local transcript
fallback.

### Live Fork remains unsupported

At `src/server/server.ts` `POST /api/sessions/:id/fork` (around `:13909`), the
existing live-source eligibility checks remain authoritative. For an SDK source,
`sessionAuditIdentity(ps).runtime === "claude-agent-sdk"` returns:

```json
{ "error": "Claude Agent SDK sessions cannot be forked", "code": "RUNTIME_FORK_UNSUPPORTED" }
```

with HTTP `422`, before transcript resolution, destination id allocation,
worktree/config setup, sidecar/tool-content/proposal copying, or any Pi
`switch_session` work. This is stable rejection behavior, not a statement that
`forkSession` is absent from the SDK. A future goal may define and review an
atomic source-snapshot/destination-creation/rollback protocol before considering
an SDK fork integration.

## Same-scope approaches

| Approach | Description | Decision |
|---|---|---|
| **Direct SDK session-access helper — selected** | A narrow lazy helper owns only `getSessionInfo` and `getSessionMessages`; `ClaudeAgentSdkBridge.getMessages`, `SessionManager.getArchivedMessages`, and archived Continue compose it. A pure adapter supplies the existing visible-snapshot shape. | Smallest change: archive sources have no live bridge, while manager/routes already own snapshot/archive lifecycle. One injectable SDK seam covers valid SDK access without adding a second store. |
| **Expand `IRpcBridge` with history/info methods** | Add methods to every bridge and route archived sources through placeholder bridges. | Reject: broadens a runtime-control interface for archive access, adds Pi stubs and lifecycle ambiguity, and still needs a helper for no-live-bridge records. |
| **Compose SDK `forkSession` into live Fork** | Fork the SDK then create a Bobbit destination around the returned UUID. | Reject for G6: an SDK mutation cannot be atomically synchronized with Bobbit's active-query snapshot, worktree/config, author-sidecar, tool-content/proposal, and destination ownership lifecycle. No rollback contract has been reviewed. |

Neither selected approach adds a Bobbit message store or reuses Pi's JSONL
protocol. The SDK-specific helper remains at the existing runtime boundary; the
normalized snapshot adapter remains pure and testable.

## Gaps and implementation order

1. **Require valid identity before idle.**
   `ClaudeAgentSdkBridge.startInternal` currently accepts missing/invalid
   initialization `session_id`; `persistSessionMetadata` can then fall through
   to Pi `sessionFile` retries. Reject readiness with a sanitized SDK error and
   make SDK metadata persistence reject when no valid UUID exists.
2. **Add SDK access and snapshot adaptation.**
   Extend the existing gateway dependency injection near
   `src/server/gateway-deps.ts` so tests supply deterministic `getSessionInfo`
   and `getSessionMessages` implementations without loading the SDK or local
   subscription. Reuse the bridge's current fake-SDK factory plumbing rather
   than a global mock.
3. **Compose snapshots without a second store.**
   Add the SDK branch to `ClaudeAgentSdkBridge.getMessages` and
   `SessionManager.getArchivedMessages`; retain Pi behavior unchanged.
4. **Branch archived Continue before Pi file work.**
   Add the validated, preflighted SDK Continue branch described above. Reuse
   `SessionManager.createSession(...)` with internal-only
   `opts.claudeAgentSdkSessionId`, threaded by `SessionSetupPlan` and
   `resolveSdkRuntimeOptions`; the public generic `createSession` request
   surface does not gain a caller-controlled resume id.
5. **Retain the live SDK Fork rejection.**
   Do not add an SDK fork helper, destination creation path, or Pi clone path.
   The route's early `422 RUNTIME_FORK_UNSUPPORTED` is the bounded G6 contract.

## Deterministic test matrix

| Tier/file | Case | Assertions |
|---|---|---|
| `tests2/core/claude-agent-sdk-bridge.test.ts` | valid/missing/malformed initialization id | Valid id persists; invalid id rejects `start`/`waitForReady` once and never tries Pi session-file persistence. |
| same or new `tests2/core/claude-agent-sdk-session-access.test.ts` | info/history helpers | Exact `dir`, UUID, helper error normalization, `SessionMessage` ordering/parent ids, zero-message valid source, and pure visible-snapshot adapter. |
| `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` | manager restore + history | Valid UUID fixture (not `sdk-opaque-session-id`); `get_messages` and archived messages use official helper; no `switch_session`; no Pi JSONL access. |
| same | queue/steer and resume failure | Unechoed steer requeues exactly once; echoed steer clears ledger; unavailable source becomes dormant with sanitized `restoreError`, preserves queue, and never starts unrelated history. |
| same | force-abort/role replacement after `PreCompact` | Ready replacement receives the persisted current UUID before queue drain; Pi remains unchanged. |
| focused server integration/E2E route suite | archived SDK Continue | `getSessionInfo` preflight occurs before allocation; a valid source creates a new Bobbit id with the same SDK id and `resume`; unavailable source returns `404 SDK_SESSION_UNAVAILABLE`; invalid metadata returns `422 RUNTIME_CONTINUE_UNSUPPORTED`; no copy/switch/destination on failure. |
| focused server integration/E2E route suite | live SDK Fork rejection | Returns stable `422 RUNTIME_FORK_UNSUPPORTED` before destination allocation and proves no SDK fork call, Pi transcript resolution/copy, `switch_session`, sidecar/tool-content/proposal work, or worktree/config creation. |
| `tests/e2e/claude-agent-sdk-session-restart.spec.ts` | restart/compaction/history | Existing restart proof plus reconnect snapshot equality before/after restart, automatic compaction then resume, and co-resident Pi `switch_session` regression. |

Register new tests in `tests2/tests-map.json` at their existing core,
integration, and E2E tiers. The opt-in manual smoke remains subscription-only;
it must not read or log session files or credentials.

## Acceptance criteria

- The SDK UUID is persisted before idle and is the only SDK recovery metadata.
- Stop/restart, boot restore, force-abort, role replacement, and archived
  Continue create a ready query with the stored UUID as `resume`, never Pi
  `switch_session`.
- Live and archived history use `getSessionInfo`/`getSessionMessages` and the
  existing visible snapshot pipeline; the SDK transcript remains authoritative.
- Archived Continue preflights official `getSessionInfo` before destination
  allocation. Missing, malformed, or unavailable sources fail clearly, preserve
  queued work where applicable, and never create an unrelated/corrupt
  destination.
- Live SDK Fork returns `422 RUNTIME_FORK_UNSUPPORTED` before destination
  allocation or any Pi/worktree/config/sidecar/tool-content/proposal work;
  G6 never calls `forkSession`.
- Pi session creation, history, Fork/Continue, compaction, and restore retain
  their current behavior.
