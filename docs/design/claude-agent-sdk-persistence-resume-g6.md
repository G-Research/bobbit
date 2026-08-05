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

These APIs are the SDK-owned transcript and fork source of truth. G6 keeps one
Bobbit `SessionStore` record per Bobbit session: it persists only
`runtime: "claude-agent-sdk"`, the opaque SDK UUID, and the existing verified
model/thinking tuple. It does not persist raw SDK messages, synthesize a Pi
JSONL, or send Pi `switch_session`.

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
   conversation history. The official SDK functions are read/fork accessors,
   not another Bobbit database.
5. SDK automatic compaction remains SDK-owned. `PreCompact` dispatches the
   existing hook; the same opaque UUID is retained/persisted and used on the
   next replacement or boot resume. No Bobbit compact transcript is made.

## History, archived continue, and fork semantics

### Visible history

Add a small SDK session-access helper, for example
`src/server/agent/claude-agent-sdk-session-access.ts`:

```ts
readSdkSessionInfo({ sessionId, cwd }): Promise<SDKSessionInfo | undefined>
readSdkSessionMessages({ sessionId, cwd }): Promise<SessionMessage[]>
forkSdkSession({ sessionId, cwd }): Promise<{ sessionId: string }>
```

It lazily loads the same pinned SDK package, calls the three official functions
with `{ dir: cwd }`, maps import/filesystem errors to the existing sanitized
`ClaudeAgentSdkUnavailableError`, and is injected through a deterministic
helper-dependency factory. It must not inspect `~/.claude` paths directly.

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

### Continue archived

At `src/server/server.ts` `POST /api/sessions/:archivedId/continue` (around
`:14426`), branch on `ps.runtime === "claude-agent-sdk"` **before** any
`agentSessionFile`, `sessionFileCopy`, transcript-sidecar, or worktree clone
work:

1. require `readSdkSessionInfo({ sessionId: ps.claudeAgentSdkSessionId, cwd: ps.cwd })`;
   invalid/missing store id or an undefined source returns `404
   SDK_SESSION_UNAVAILABLE` with a clear “SDK conversation is unavailable”
   message;
2. create a fresh Bobbit session id using a dedicated internal
   `SessionManager.createSdkResumedSession(...)` setup path, preserving the
   normal project/model/role/sandbox validity checks and passing the **same**
   SDK UUID into `SessionBridgeOptions.claudeAgentSdkSessionId`;
3. persist that runtime/id tuple before the new session becomes idle. The
   archived Bobbit record remains archived; this is a new Bobbit wrapper that
   resumes the same SDK conversation, not a copied transcript.

SDK sessions remain fail-closed in Docker because the existing bridge rejects
that runtime there. Continue must return that existing unavailable/runtime
failure and never fall back to a host-local transcript operation.

### Fork

At `src/server/server.ts` `POST /api/sessions/:id/fork` (around `:13856`),
branch before the Pi JSONL-copy pipeline when the live source's persisted
runtime is SDK:

1. validate source id with `readSdkSessionInfo`; return `404
   SDK_SESSION_UNAVAILABLE` if unavailable;
2. call `forkSdkSession({ sessionId, cwd: ps.cwd })`; this SDK operation creates
   a transcript branch with a **new SDK UUID**;
3. create a fresh Bobbit session with that UUID as its resume target, carrying
   the existing legal source configuration but no Pi clone, `agentSessionFile`,
   author-sidecar copy, or `switch_session`.

The existing Fork eligibility checks (live-only, no archived/delegate/child/
read-only/non-interactive/team source) remain authoritative. A Fork response
therefore identifies a new Bobbit session whose persisted SDK UUID differs from
the source. `forkSession` failure is surfaced as `SDK_SESSION_UNAVAILABLE` or
a sanitized SDK operation failure; it must never create a destination record.

## Same-scope approaches

| Approach | Description | Decision |
|---|---|---|
| **Direct SDK session-access helper — selected** | A narrow lazy helper owns `getSessionInfo`, `getSessionMessages`, and `forkSession`; `ClaudeAgentSdkBridge.getMessages`, `SessionManager.getArchivedMessages`, and the two server routes compose it. A pure adapter supplies the existing visible-snapshot shape. | Smallest change: Fork is not an `IRpcBridge` concern, archive sources have no live bridge, and manager/routes already own snapshot/archive lifecycle. One injectable SDK seam covers all accesses. |
| **Expand `IRpcBridge` with history/info/fork methods** | Add methods to every bridge, route archived sources through placeholder bridges, and make Pi expose unsupported stubs. | Reject: broadens a runtime control interface for an archive-only SDK accessor, adds Pi stubs and lifecycle ambiguity, and still needs a helper for no-live-bridge records. |

Neither approach adds a Bobbit message store or reuses Pi's JSONL protocol. The
selected helper is SDK-specific only at the existing runtime boundary; the
normalized snapshot adapter remains pure and testable.

## Gaps and implementation order

1. **Require valid identity before idle.**
   `ClaudeAgentSdkBridge.startInternal` currently accepts missing/invalid
   initialization `session_id`; `persistSessionMetadata` can then fall through
   to Pi `sessionFile` retries. Reject readiness with a sanitized SDK error and
   make SDK metadata persistence reject when no valid UUID exists.
2. **Add the session-access helper and snapshot adapter.**
   Extend the existing gateway dependency injection near
   `src/server/gateway-deps.ts` so tests supply deterministic `getSessionInfo`,
   `getSessionMessages`, and `forkSession` implementations without loading the
   SDK or local subscription. Reuse the bridge's current fake-SDK factory
   plumbing rather than a global mock.
3. **Compose snapshots without a second store.**
   Add the SDK branch to `ClaudeAgentSdkBridge.getMessages` and
   `SessionManager.getArchivedMessages`; retain Pi behavior unchanged.
4. **Branch continue/fork before Pi file work.**
   Add the SDK branches described above and a focused
   `createSdkResumedSession` internal setup seam so the public generic
   `createSession` request surface does not gain a caller-controlled resume id.
5. **Reconcile downstream docs.**
   After code and tests land, revise `docs/claude-agent-sdk-sessions.md` and
   `docs/design/claude-agent-sdk-session-lifecycle.md`, which currently claim
   SDK Fork/Continue and transcript snapshots are unsupported. This G6 design
   is the source for that downstream documentation work; do not retain
   conflicting support statements.

## Deterministic test matrix

| Tier/file | Case | Assertions |
|---|---|---|
| `tests2/core/claude-agent-sdk-bridge.test.ts` | valid/missing/malformed initialization id | Valid id persists; invalid id rejects `start`/`waitForReady` once and never tries Pi session-file persistence. |
| same or new `tests2/core/claude-agent-sdk-session-access.test.ts` | info/history/fork helpers | Exact `dir`, UUID, helper error normalization, `SessionMessage` ordering/parent ids, zero-message valid source, and pure visible-snapshot adapter. |
| `tests2/integration/claude-agent-sdk-runtime-persistence.test.ts` | manager restore + history | Valid UUID fixture (not `sdk-opaque-session-id`); `get_messages` and archived messages use official helper; no `switch_session`; no Pi JSONL access. |
| same | queue/steer and resume failure | Unechoed steer requeues exactly once; echoed steer clears ledger; unavailable source becomes dormant with sanitized `restoreError`, preserves queue, and never starts unrelated history. |
| same | force-abort/role replacement after `PreCompact` | Ready replacement receives the persisted current UUID before queue drain; Pi remains unchanged. |
| focused server integration/E2E route suite | archived SDK Continue | Valid source creates a new Bobbit id with the same SDK id and `resume`; unavailable source returns `404 SDK_SESSION_UNAVAILABLE`; no copy/switch/destination on failure. |
| focused server integration/E2E route suite | live SDK Fork | `forkSession` result UUID differs; new Bobbit session resumes it; source restrictions remain enforced; no copy/switch/destination on SDK failure. |
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
- Fork calls `forkSession` and persists/uses its new UUID; Continue resumes the
  existing UUID in a fresh Bobbit session.
- Missing, malformed, or unavailable SDK sources fail clearly, preserve queued
  work where applicable, and never create an unrelated/corrupt destination.
- Pi session creation, history, Fork/Continue, compaction, and restore retain
  their current behavior.
