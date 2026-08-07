# G9 — Claude Agent SDK Docker sandbox runtime

## Decision

Enable `claude-agent-sdk` sessions in an existing project Docker sandbox by
using the official SDK's `Options.spawnClaudeCodeProcess` hook. The hook starts
one Claude Code subprocess with `docker exec` in the project’s already-pooled
`ProjectSandbox` container; it does not start a sidecar, create a per-session
container, or invoke the host Claude executable.

This replaces the current deliberate rejection in
`ClaudeAgentSdkBridge.startInternal()`:

```ts
if (this.options.sandboxed || this.options.containerId) {
  throw new ClaudeAgentSdkUnavailableError(
    "Claude Agent SDK sessions are not supported in Docker sandboxes",
  );
}
```

Pi remains unchanged. `SandboxManager` stays the only owner of project
container lifecycle, recovery, volumes, and container identity. `SessionManager`
stays the owner of sandbox setup, scoped gateway credentials, recovery,
persistence, queues, and replacement fencing. `ClaudeAgentSdkBridge` continues
to own exactly one SDK query and its input/event lifecycle.

## Audited SDK contract

The pinned dependency is `@anthropic-ai/claude-agent-sdk@0.3.222`
(`package.json` and lockfile). The shipped `sdk.d.ts` declares:

```ts
type Options = {
  // …
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
};

interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: { [envVar: string]: string | undefined };
  signal: AbortSignal;
}

interface SpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
}
```

`SpawnedProcess` deliberately has no `stderr` member. The adapter must provide
only the required stdin/stdout and lifecycle members; it must not invent an SDK
stderr protocol. The hook's `signal` is **not** the caller's immediate abort
signal. In this SDK release it fires only after the SDK closes stdin and gives
Claude Code its roughly two-second graceful-exit window. The adapter listens to
that supplied signal and asks `docker exec` to terminate only then; it does not
pass `Options.abortController.signal` to Node `spawn` or preempt the graceful
path.

The package's exact `0.3.222` binary contains the supported
`CLAUDE_CODE_OAUTH_TOKEN` environment mechanism. Its public declarations do
not expose the bundled binary's internal host-auth callbacks; G9 must not call
or cast to those undeclared internals. This package/binary pair is the support
boundary. A future SDK version needs a fresh declaration, binary-capability,
and inventory review.

## Existing seams and constraints

| Concern | Existing seam | G9 composition |
| --- | --- | --- |
| Project container lifecycle | `SandboxManager` → `ProjectSandbox` | Obtain the existing `containerId`; never create or manage another container. |
| Sandbox setup and CWD translation | `SessionManager.applySandboxWiring`, `session-setup.ts::executePlan` | Keep container CWD (`/workspace` or `/workspace-wt/...`) after ordinary worktree provisioning. |
| Per-process Docker execution | `RpcBridge.spawnDockerExec` | Extract a typed, reusable Docker-exec spawn helper; retain `-i`, `-w`, per-process `-e`, Windows env handling, and redacted logging. |
| Sandbox gateway authority | `applySandboxWiring` and `mintScopedGatewayToken` | Forward only the existing scoped gateway values per `docker exec`, never pool-container PID 1 values. |
| SDK options / query lifecycle | `ClaudeAgentSdkBridge`, `session-runtime.ts` | Add a sandbox spawn factory only for the SDK runtime. Query, input queue, translator, model/thinking, stop, and resume ownership do not change. |
| Auth policy/refresh | `host-tokens.ts`, `withSandboxAgentAuthFileLock` | Reuse explicit `ANTHROPIC_OAUTH_TOKEN` sandbox-policy gating and the host refresh-before-export flow, but export only a current access token to this subprocess. |
| SDK session access | `claude-agent-sdk-session-access.ts`, bridge `getMessages`, `SessionManager.getArchivedMessages` | Route sandbox access through a bounded read-only `docker exec` helper against the same persistent sandbox SDK config; direct sessions retain host access. |

`mergeHostAgentProviderEnv` is specifically not an auth source for this path:
it feeds direct Pi API-key environments and can yield `ANTHROPIC_API_KEY`.
The sandbox SDK path must never call it, copy its result, or fall back from an
OAuth failure to an API key.

## Same-scope architectural comparison and selected minimal composition

**Audit baseline.** This comparison is against the merged runtime on the
parent-synced baseline (`e1e422f47`): Pi sandbox execution is owned by
`RpcBridge.spawnDockerExec`; Agent SDK construction rejects a sandbox before
`query()`; and `SessionManager.applySandboxWiring` is the shared project
container/CWD/gateway/auth setup point. It compares only ways to deliver G9;
a second container runtime, a host SDK fallback, or an SDK/Pi runtime redesign
is not an alternative in scope.

| Concern and failure flow | Selected minimal composition | Same-scope option rejected | Added defect surface and reason for selection |
| --- | --- | --- | --- |
| SDK subprocess: SDK hook → `docker exec` → child lifecycle | Extract one narrow typed Docker-exec spawn factory from the already-working Pi executor. Pi composes the same factory with its Pi command/remapping; the SDK composes it with its fixed wrapper and opaque SDK args. | Put a separate `spawn("docker", …)` adapter in `ClaudeAgentSdkBridge`. | One factory and one `SpawnOptions`→`SpawnedProcess` adapter, rather than two command builders, two redaction paths, and two abort/kill implementations. It deliberately is not a general container runtime or process manager. |
| Runtime-specific launch data: setup/recovery → bridge factory → SDK `query()` | Add one ephemeral, typed SDK sandbox launch descriptor after `applySandboxWiring` has obtained the container and translated CWD. | Add optional OAuth/container fields to broad `RpcBridgeOptions`, `SessionInfo`, or persisted records. | One in-memory descriptor transformation. It makes the invalid/missing-descriptor fail-closed branch explicit while preventing credential-bearing data from crossing Pi, persistence, or diagnostics surfaces. |
| Subscription credential: policy/refresh lock → current access token → one process env entry | Add a narrow resolver that returns only a current token while the existing lock is held; the adapter emits only `CLAUDE_CODE_OAUTH_TOKEN=<value>`. | Add OAuth to `sandboxCredentials` and reuse its generic `-e` loop. | One policy/credential result branch. Generic credentials are intentionally broader and feed Pi; using them would make an SDK-only token available to unrelated processes and make an API-key fallback too easy. |
| SDK config/history: stable state path → SDK-owned records → visible-history adapter | Add the deterministic per-session state mount and a bounded, read-only SDK accessor using the same pooled container. | Read a host SDK directory, use Pi JSONL, or create another transcript store. | One mount path transformation and one read-only process call. The selected composition keeps the SDK transcript authority and preserves container isolation instead of adding a transcript owner or host-settings mount. |
| Capability: selected container → SDK wrapper/version check → launch or sanitized error | Reuse the selected `ProjectSandbox` and add one exact SDK image capability/version probe before query startup. | Start the host SDK when the image is stale or let an arbitrary global `claude` run in the container. | One capability branch. It contains platform drift at startup and leaves the existing Pi image/runtime path untouched. |

The first row is the **selected minimal composition**. It changes the least
ownership: `SandboxManager` still owns containers, `SessionManager` still owns
session setup/recovery, and `ClaudeAgentSdkBridge` still owns the single SDK
query. The shared factory owns neither container identity nor session state; it
only adapts an already-authorized `docker exec` child to the SDK contract.

## Defect-surface inventory

| New or changed surface | Owner/lifetime | Failure containment and required pin |
| --- | --- | --- |
| Typed Docker-exec spawn factory and SDK process facade | Factory is stateless; child lifetime remains bridge-owned. | Validate container CWD and pipe streams before query readiness; delegate exit/error/kill exactly once and remove the SDK-supplied abort listener on settlement. Pin command vector, opaque args, lifecycle delegation, redaction, and no Pi remapping. |
| SDK sandbox launch descriptor | `SessionManager` creates it per bridge construction; never persist it. | Missing container, CWD, capability, gateway values, or OAuth must reject before `query()`. Pin absence from `SessionInfo`, `PersistedSession`, `RpcBridgeOptions.env`, diagnostics, and logs. |
| Closed container SDK environment | One query/spawn invocation. | Construct from an allowlist, not `process.env` or project credentials. Pin absence of host settings, generic secrets, API keys, refresh token, and admin credentials. |
| OAuth access-token resolver | Existing project auth lock; result lives only until launch descriptor/spawn construction completes. | Re-read policy after refresh, reject explicit/conflicting credentials and unavailable/expired auth, and return a sanitized stable error. Pin that no credential object, refresh token, or API-key fallback crosses the seam. |
| Image wrapper/capability validation | Existing sandbox-image lifecycle; no session lifecycle ownership. | Fail only SDK sandbox launch with the rebuild action; pin exact package/binary version and prove stale images do not regress Pi. |
| Deterministic SDK state mount and container history accessor | Existing final session purge owns deletion; accessor is read-only per history request. | Restrictive owned mount; accessor has bounded output, strict JSON, no OAuth/gateway env, no query, and no write. Pin empty-history validity and `SDK_SESSION_UNAVAILABLE` mapping. |
| Restore/replacement/recovery descriptor rebuild | Existing `applySandboxWiring`/bridge replacement flow. | Resolve current container and current token afresh before queue drain while preserving only the SDK UUID. Pin recovered container id, resumed UUID, and no `switch_session`. |

No new container manager, persistent credential field, transcript store, host
settings mount, generic environment merge, provider fallback, or public runtime
selection API is introduced. Those omissions are intentional constraints, not
future cleanup work.

## Current merged-runtime preservation audit

The implementation must preserve the following behavior from the audited
merged baseline. Each row identifies the existing owner and the regression
proof required when the new SDK sandbox branch is added.

| Existing runtime contract | Current owner/seam | G9 preservation requirement and regression proof |
| --- | --- | --- |
| Pi direct execution remains host-local; Pi sandbox execution uses one pooled project container with `docker exec -i`, `-w`, pipe stdio, scoped gateway values, `NODE_TLS_REJECT_UNAUTHORIZED=0`, and `NODE_OPTIONS=--no-warnings`. | `RpcBridge._spawnProcess` / `spawnDockerExec`. | Refactoring must leave the Pi command, Pi-only argument remapping, credential loop, CWD behavior, logging/redaction, and child ownership byte-for-byte equivalent in observable behavior. Pin a Pi direct/sandbox regression beside the new factory tests. |
| Sandboxed worktree creation and CWD offset happen before bridge construction; restored container paths are not converted back to host paths. | `SessionManager.applySandboxWiring`, called by session setup, restore, delegate, and replacement paths. | Build the SDK descriptor only after this seam resolves the current container and container-relative CWD. Pin fresh/worktree/restore/recovery paths and reject a host CWD rather than silently escaping the sandbox. |
| Gateway authority is scoped per sandbox session and passed to the child process, not installed in pool-container PID 1. | `mintScopedGatewayToken` and `applySandboxWiring`. | Preserve the existing values and per-process `-e` placement for SDK tools. Pin that the token/session secret are redacted and that neither reaches persistent config or a container-wide environment. |
| Agent SDK direct sessions use a closed allowlist, strict SDK tool surface, one async-input query, visible-event translator, model/thinking state, soft interrupt/stop, and UUID-based resume. | `ClaudeAgentSdkBridge`, `session-runtime.ts`, SDK tool/history adapters. | The sandbox branch changes only process placement. Pin identical query options except custom spawn/container env, model/thinking calls, event translation, stop/interrupt semantics, and resumed UUID; direct SDK tests remain unchanged. |
| SDK history remains SDK-owned and is normalized through the visible-message adapter; Pi `switch_session` is excluded for SDK records. | `ClaudeAgentSdkBridge.getMessages`, `claude-agent-sdk-session-access.ts`, `session-setup.ts`. | Select the container accessor only for sandbox SDK records. Pin read-only normalized history after restart/recovery, valid empty history, no Pi JSONL, and no `switch_session`. |
| Existing sandbox OAuth policy protects Pi's project auth file and refreshes only under the project lock. | `withSandboxAgentAuthFileLock`, `refreshSandboxAnthropicOAuthCredential`, sandbox policy helpers. | Keep Pi behavior unchanged; add a separate in-memory SDK access-token result under that lock. Pin policy absence, refresh failure, API-key rejection, and sanitized errors without changing Pi auth-file inputs. |
| Container lifecycle, pooled-container recreation, and final session cleanup remain centralized. | `SandboxManager` / `ProjectSandbox` and final session purge. | SDK launch/recovery only reads the selected container and uses the existing state-mount cleanup lifecycle. Pin that recovery reconstructs a bridge with a new container id and that archive/ordinary stop do not delete resumable SDK state. |

## Spawn design

### One shared Docker-exec adapter

Add a small shared helper (for example
`src/server/agent/docker-exec-spawn.ts`) rather than duplicating a second
container runtime in the SDK bridge. It accepts a container id, already
container-relative cwd, explicit per-process environment, `SpawnOptions`, and
the existing injectable Node spawn dependency. It builds:

```text
docker exec -i
  -w <container cwd>
  -e BOBBIT_SESSION_ID=…
  -e BOBBIT_SESSION_SECRET=…
  -e BOBBIT_GOAL_ID=…
  -e BOBBIT_TOKEN=<scoped token>
  -e BOBBIT_GATEWAY_URL=…
  -e CLAUDE_CODE_OAUTH_TOKEN=<current OAuth access token>
  -e CLAUDE_CONFIG_DIR=/bobbit-state/claude-agent-sdk/<bobbit session id>
  <container id> /usr/local/bin/bobbit-claude-agent-sdk <SDK args>
```

The helper must use pipe stdio and adapt the resulting `ChildProcess` only
after asserting `stdin` and `stdout` exist. It delegates `on`, `once`, `off`,
`kill`, `killed`, `exitCode`, and optional `signalCode` to that child, satisfying
the exact SDK interface. It installs one abort listener on the **SDK-provided**
`SpawnOptions.signal`, removes it on child exit/error, and does not double-kill
an exited process. It forwards an SDK `kill(signal)` as a Docker-exec process
kill, matching the current Pi ownership boundary.

The adapter treats `SpawnOptions.args` as opaque ordered CLI arguments. It must
not run them through `RpcBridge.remapArgsForContainer`: those arguments belong
to Claude Code, not Pi, and G9 must not rewrite arbitrary values. `cwd` is
validated as a container path before using `docker exec -w`; setup/restore have
already translated it. The host absolute `SpawnOptions.command` is intentionally
ignored after strict validation: it names the host SDK's optional-platform
binary and is not executable in the Linux container. The container wrapper is
pinned to the matching installed SDK binary and receives the SDK arguments
unchanged.

Reuse `redactDockerArgs` for every log line and extend its test coverage for
`CLAUDE_CODE_OAUTH_TOKEN`; values must never reach logs, bridge diagnostics,
error text, persistence, or test snapshots.

### Image prerequisite

`docker/Dockerfile` installs the exact lockfile Agent SDK release in the
sandbox image and creates `/usr/local/bin/bobbit-claude-agent-sdk`, a minimal
architecture-aware wrapper that `exec`s the installed optional-platform
`claude` binary. It is built with a `CLAUDE_AGENT_SDK_VERSION=0.3.222` argument
and records a matching image label. The wrapper must fail clearly when the
expected binary cannot be found; it must never use a globally installed,
unpinned `claude` command.

This is a platform prerequisite: after upgrading Bobbit to G9, operators must
rebuild the sandbox image before creating sandbox SDK sessions. Startup checks
compare the image label/binary version with the server's pinned SDK version and
return `CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE` with an actionable “rebuild the
Docker sandbox image” message. Existing Pi sandbox sessions remain usable while
the image is stale.

### Bridge/options wiring

Extend `ClaudeAgentSdkBridgeOptions` with a typed sandbox launch descriptor
populated only by `applySandboxWiring`, containing the pooled `containerId`,
container cwd, scoped gateway fields, Bobbit session id, and an opaque current
OAuth access token. Keep the token out of `RpcBridgeOptions.env`,
`sandboxCredentials`, `SessionInfo`, `PersistedSession`, and all diagnostics.

`buildClaudeAgentSdkEnv` becomes runtime-location aware:

- direct SDK sessions retain the existing closed host environment;
- sandbox SDK sessions receive a new object with container `HOME=/home/node`,
  `PATH`, temp/locale necessities, Bobbit session identity, and the deterministic
  container `CLAUDE_CONFIG_DIR`; it does not inherit host `HOME`, host
  `CLAUDE_CONFIG_DIR`, project env, generic secrets, provider keys, or gateway
  admin credentials;
- only the spawn adapter adds the scoped `BOBBIT_TOKEN`, gateway URL, and
  current `CLAUDE_CODE_OAUTH_TOKEN` as individual `docker exec -e` values.

`ClaudeAgentSdkBridge.startInternal()` chooses
`spawnClaudeCodeProcess: descriptor.spawn` when the descriptor is valid. It
keeps `settingSources: []`, strict MCP configuration, the existing SDK tool
surface, and the one-query async-input design. A sandbox descriptor missing a
container id, a container CWD, a matching image, or an OAuth credential rejects
before `query()` readiness; it never silently starts locally.

Normal `stop`, soft `interrupt`, forced-abort replacement, and container
recovery retain the current layering. The SDK gets graceful stdin EOF first;
its forwarded spawn signal can then end the `docker exec` process. On forced
replacement or `SandboxManager` recovery, `SessionManager` builds a fresh
bridge through normal sandbox wiring, retrieves the current container id and
fresh OAuth access token, and passes the persisted SDK UUID as `resume` before
queue drain. There is no host fallback and no new lifecycle owner.

## OAuth forwarding and fail-closed behavior

The supported mechanism is a short-lived subscription OAuth **access token** in
`CLAUDE_CODE_OAUTH_TOKEN`, injected only into the Claude Code `docker exec`
process. The existing project policy remains the user consent gate: an enabled
`ANTHROPIC_OAUTH_TOKEN` sandbox-token entry is required for host subscription
handoff. The existing lock serializes policy → host refresh → export decisions.

Within that lock, add a narrowly typed host-token resolver which:

1. rejects explicit `ANTHROPIC_API_KEY` / API-key credentials for this runtime;
2. requires policy opt-in and no conflicting project Anthropic credential;
3. refreshes the host renewable credential with the existing
   `refreshSandboxAnthropicOAuthCredential()` path when necessary;
4. validates the resulting current credential; and
5. returns only its access-token string to `applySandboxWiring` in memory.

It never exports the host refresh token, host `.claude` / credential directory,
provider settings, auth.json path, account metadata, or a credential object.
The existing project-scoped Pi `auth.json` mount is neither configured nor
consulted by this SDK subprocess; its isolated SDK config directory contains no
credentials. The OAuth value is per process (`docker exec -e`), not a PID 1
container environment value, persistent file, mount, or pool credential.

If policy is absent, the host OAuth is missing/expired/unrefreshable, the image
does not support the token mechanism, or the SDK reports authentication failure,
return a sanitized `CLAUDE_AGENT_SDK_SANDBOX_AUTH_UNAVAILABLE` error. The UI
message identifies the required project sandbox OAuth opt-in and re-login/refresh
step without exposing a token. Do **not** try `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, generic sandbox credentials, the host Claude config,
or a host-local SDK query as a recovery path.

## Transcript, history, and resume

A sandbox SDK subprocess uses the persistent per-Bobbit-session config path
`/bobbit-state/claude-agent-sdk/<bobbit-session-id>`. Add the corresponding
owned state mount to `SANDBOX_STATE_MOUNTS`, with restrictive host permissions.
It survives SDK bridge replacement and pooled-container recreation, but is
removed only during the existing final session purge—not archive or ordinary
stop. The path is deterministic from the Bobbit session id and therefore adds
no credential or config-path field to the session store.

The SDK UUID remains the only SDK resume identity in `PersistedSession`.
Sandbox replacement and boot restore pass it via `Options.resume`; they never
use Pi `switch_session`, Pi JSONL, or a second Bobbit transcript store.

Host `getSessionInfo` / `getSessionMessages` cannot read a container-only SDK
config from a host path. Extend the existing injected SDK-session-access seam
with a sandbox implementation that uses the same pooled container and a
read-only `docker exec` helper. The helper runs the pinned SDK accessor in the
container with the deterministic `CLAUDE_CONFIG_DIR`, container cwd, no OAuth
or gateway env, bounded output, and strict JSON validation. It returns only
normalized info/messages to the existing history adapter. It never starts a
query, does not mount host settings, and has no write operation. A missing
container/config/source maps to the existing sanitized
`SDK_SESSION_UNAVAILABLE`; an empty conversation remains valid.

This preserves G6's ownership: the official SDK remains transcript authority,
`ClaudeAgentSdkBridge.getMessages()` and archived snapshots use the established
visible-message adapter, and `SessionManager` remains queue/recovery authority.
Direct SDK history uses its existing host accessor unchanged.

## Implementation files

| File | Change |
| --- | --- |
| `docker/Dockerfile` | Install/version-label the exact Agent SDK and install the fixed container binary wrapper. |
| `src/server/agent/docker-exec-spawn.ts` (new) | Shared typed `SpawnOptions` → `SpawnedProcess` Docker adapter, environment allowlist, abort cleanup, CWD validation, and redacted logging. Refactor Pi’s `spawnDockerExec` to compose it without behavioral drift. |
| `src/server/agent/rpc-bridge.ts` | Export/reuse only shared Docker argument/redaction utilities; retain Pi argument remapping as Pi-only. |
| `src/server/agent/claude-agent-sdk-bridge.ts` | Replace Docker rejection with validated SDK sandbox options, closed container env, custom spawn hook, and sandbox session-access selection. |
| `src/server/agent/session-runtime.ts` | Thread the typed sandbox launch descriptor through the existing bridge factory/dependency seam. |
| `src/server/agent/session-manager.ts` | In `applySandboxWiring`, resolve the pooled container, OAuth handoff, image prerequisite, and descriptor; rebuild it on restore/replacement/recovery. |
| `src/server/agent/session-setup.ts` | Preserve setup ordering: resolve runtime/tools/prompt, wire sandbox and container CWD, then construct the SDK bridge. |
| `src/server/agent/host-tokens.ts` | Add the narrow policy-gated current OAuth access resolver; no API-key fallback or persisted value. |
| `src/server/agent/docker-args.ts`, `project-sandbox.ts` | Add/validate the persistent SDK config state mount and exact image version/capability probe. |
| `src/server/agent/claude-agent-sdk-session-access.ts` | Add injected pooled-container read-only SDK info/history accessor for sandbox records. |
| `docs/claude-agent-sdk-sessions.md`, `docs/internals.md` | Document Docker-image prerequisite, opt-in OAuth policy, fail-closed errors, and manual smoke. |

## Test plan

### Core

Add `tests2/core/claude-agent-sdk-sandbox-spawn.test.ts` to inject a fake child
process and pin the exact `SpawnOptions`/`SpawnedProcess` adaptation:

- one `docker exec -i -w <container cwd>` invocation; no host command path,
  Pi remapping, host CWD, or second Docker container;
- opaque argument ordering, pipe stdio, exit/error/on/once/off delegation, kill
  behavior, and one forwarded-signal listener removed after settlement;
- only approved per-process variables are present; `CLAUDE_CODE_OAUTH_TOKEN`,
  `BOBBIT_TOKEN`, and `BOBBIT_SESSION_SECRET` are redacted;
- absent stdin/stdout, invalid CWD, missing container/image capability, and
  missing OAuth reject deterministically before readiness;
- the direct SDK env and Pi `spawnDockerExec` regression contracts remain
  unchanged.

Add host-token unit coverage for policy opt-in, expired-refresh success/failure,
API-key rejection, no refresh-token export, and no credential-bearing error.
Add SDK declaration/capability canaries that assert the `0.3.222`
`spawnClaudeCodeProcess`, `SpawnOptions`, and `SpawnedProcess` contract and the
container wrapper version; a package/binary drift fails loudly.

### Integration and E2E

Add an isolated `tests2/integration/claude-agent-sdk-sandbox-runtime.test.ts`
with a `MockSandboxManager`/fake Docker spawn seam. Cover fresh sandbox setup,
container CWD and worktree translation, one long-lived SDK query, OAuth handoff,
translated prompt/steer/interrupt events, model/thinking controls, stop,
replacement, and no Pi `switch_session`. Assert that two sessions have distinct
config paths/env objects and that a container-recovered event reconstructs with
the new pooled container id and same persisted SDK UUID.

Add a gateway E2E scenario (registered in `tests2/tests-map.json`) that uses the
production factory seam and a controlled fake SDK/container transport. It must
create a sandbox SDK session, prompt, obtain visible history, restart the
gateway and recover the project container, then prompt and read history again.
Assert resumed UUID, same container-side transcript authority, no host fallback,
no Pi JSONL, no `switch_session`, and a co-resident Pi sandbox regression.
Add an unavailable OAuth/image case that fails before query/destination work
with the stable sanitized code.

### Manual real-subscription scenario

Extend `tests/manual-integration/claude-agent-sdk-lifecycle.spec.ts` (or add a
separate sandbox case) behind both:

```bash
BOBBIT_RUN_CLAUDE_AGENT_SDK_SMOKE=1 \
BOBBIT_RUN_CLAUDE_AGENT_SDK_SANDBOX_SMOKE=1 \
MANUAL_CLAUDE_AGENT_SDK_MODEL=claude-sonnet-4-5 \
npm run test:manual -- --grep "Claude Agent SDK sandbox"
```

The scenario builds/verifies the matching Docker image, configures a temporary
Docker project with the explicit enabled `ANTHROPIC_OAUTH_TOKEN` policy, and
uses a normal local Claude subscription. It asserts readiness, prompt, steer,
soft interrupt, termination, replacement/restart resume, and no credential
value in output. It skips unless Docker, the matching image, explicit opt-in,
and local subscription are present. It never copies `~/.claude`, prints an auth
file, logs an environment object, or accepts an API key as a substitute.

## Acceptance criteria

- A valid explicitly opted-in subscription can run an SDK session in the
  existing pooled project Docker container through the official custom spawn
  hook.
- Worktree/container CWD translation, scoped tool/gateway ownership, event
  translation, model/thinking controls, one-query lifecycle, transcript access,
  resume, replacement, and container recovery match the existing SDK session
  contract.
- No second container runtime, host Claude process, Pi RPC command, Pi JSONL,
  host settings mount, generic environment spread, API-key fallback, refresh
  token, or persisted/logged OAuth access token is introduced.
- Missing supported credentials or platform capability fail early with a clear,
  sanitized, actionable error.
- Pi direct/sandbox behavior and direct SDK behavior remain unchanged.
