# Extension Host Channels — `host.channels` Architecture

**Status:** design input for the Extension Channels goal.  
**Scope:** add a small generic, framed, long-lived channel capability to the existing Extension Host, then implement the built-in terminal as a first-party pack that uses that capability. This document does not propose a terminal-specific core Host API.

## 1. Goals and non-goals

### Goals

- Add an additive client Host API namespace, `host.channels`, for long-lived bidirectional framed communication.
- Keep pack identity server-derived through surface tokens; callers never choose a pack id, URL, WebSocket, bearer token, or transport.
- Resolve channel names only inside the calling pack's declared `channels/<name>.yaml` handlers.
- Support detach/remount/reload reattach while the gateway process is alive.
- Define clear lifecycle, quotas, backpressure, idle-timeout, error, cleanup, and audit semantics.
- Provide a production path for a first-party xterm.js terminal pack using a `terminal` channel convention and a narrow PTY helper.

### Non-goals for v1

- No binary frames. V1 supports only text and JSON frames.
- No raw WebSocket endpoint, signed URL, bearer URL, `gateway.fetch`, caller-supplied transport, or arbitrary gateway path.
- No `host.terminal` namespace. Terminal is a blessed channel protocol convention owned by a pack.
- No live PTY survival across gateway restart. Restart closes all in-memory channels; UI must render a clear disconnected/closed state and offer restart.

## 2. Existing architecture to reuse

Relevant current pieces:

- **Frozen Host API contract:** `src/shared/extension-host/host-api.ts` owns `HostApi`, `HostCapabilities`, version constants, and stable contract shapes. Additive methods do not bump `HOST_API_VERSION`; feature availability is exposed through `host.capabilities`.
- **Client Host API implementation:** `src/app/host-api.ts` constructs a host bound to `{ sessionId, toolUseId?, surface }`, lazily mints a server surface token, and exposes scoped methods. Existing scoped calls already avoid raw passthrough.
- **Surface binding:** `src/server/extension-host/surface-binding.ts` mints/validates HMAC surface tokens and resolves trusted `{ sessionId, packId, tool?, contributionId }` from a token, never from caller-supplied pack identity.
- **Scoped authorization:** `src/server/extension-host/action-guard.ts::authorizeScopedRequest()` uses the `x-bobbit-session-id` header as canonical session identity and rejects mismatched body/query session ids.
- **Pack contribution registry:** `src/server/agent/pack-contributions.ts` and `src/server/extension-host/pack-contribution-registry.ts` load pack-scoped panels, entrypoints, providers, and routes. Channels should extend this registry rather than create a second pack-discovery path.
- **Pack-scoped metadata:** `/api/ext/contributions` in `src/server/server.ts` feeds client registries from `PackContributionRegistry`; it should expose channel names only as metadata/diagnostics, never handler module paths.
- **Panels and entrypoints:** `src/app/pack-panels.ts`, `src/app/pack-entrypoints.ts`, `src/app/session-actions.ts`, and `src/ui/components/MessageEditor.ts` already implement pack-local panels and user-gesture launcher dispatch.
- **Session WebSocket:** `src/server/ws/protocol.ts`, `src/server/ws/handler.ts`, and app-side bridges such as `src/app/session-write-bridge.ts` provide an existing Bobbit-owned authenticated channel that pack code cannot directly access.
- **Server module isolation:** `src/server/extension-host/module-host-worker.ts` runs pack server modules in worker threads for resource/crash isolation. Long-lived channels need a sibling persistent worker model, not the current per-invocation `ModuleHost.invoke()` lifecycle.
- **Session termination cleanup:** `src/server/agent/session-manager.ts::terminateSession()` already has cleanup seams for session-owned resources such as background processes and sandbox tokens. Channel cleanup should be called from the same termination path.

## 3. Public Host API shape

Add to `src/shared/extension-host/host-api.ts`:

```ts
export type HostChannelFrame =
  | { kind: "text"; data: string }
  | { kind: "json"; data: unknown };

export interface HostChannelOpenInit {
  /** JSON-serializable protocol-specific open data. */
  data?: unknown;
  /** Optional stable key for singleton-per-session channels such as terminal. */
  singletonKey?: string;
}

export interface ChannelInfo {
  id: string;
  name: string;
  packId: string;        // server-derived, informational only
  sessionId: string;     // bound session
  state: "opening" | "open" | "closing" | "closed";
  createdAt: number;
  lastActiveAt: number;
  attached: boolean;
  closeReason?: string;
}

export interface HostChannel {
  readonly id: string;
  readonly name: string;
  readonly state: "open" | "closing" | "closed";
  send(frame: HostChannelFrame): Promise<void>;
  close(reason?: string): Promise<void>;
  onFrame(cb: (frame: HostChannelFrame) => void): () => void;
  onClose(cb: (ev: { reason?: string; error?: string }) => void): () => void;
}

export interface HostChannelsApi {
  open(name: string, init?: HostChannelOpenInit): Promise<HostChannel>;
  attach(id: string): Promise<HostChannel>;
  list(opts?: { name?: string; includeClosed?: boolean }): Promise<ChannelInfo[]>;
}
```

Add `readonly channels: boolean` to `HostCapabilities` and `readonly channels: HostChannelsApi` to `HostApi`. `HOST_API_VERSION` remains `1` because this is additive. Bump `HOST_CONTRACT_VERSION` to `4` because `HostChannelFrame`, `ChannelInfo`, and channel close events are new Host-API-owned data contracts.

Compatibility rules:

- Existing packs compiled against older contracts continue to run unchanged; existing renderer/action/panel/route/store/session surfaces remain byte-compatible except for the additive optional namespace and capability flag.
- Runtime feature detection is mandatory: pack code must check `host.capabilities.channels === true` or `host.capabilities.has("channels")` before using `host.channels`.
- Hosts that do not implement channels must either omit `host.channels` or expose the same reserved-namespace throwing pattern used by earlier Phase-2 capabilities, but `capabilities.channels` must be the single source of truth and remain `false`.
- Contract/regression tests must assert older host surfaces remain valid and that a no-channels host does not break existing Extension Host renderer/action/panel/route/store/session tests.

`send()` returns a `Promise<void>` so backpressure, closed-channel, quota, and frame-validation errors are observable. The frame union is deliberately small: text and JSON only.

## 4. Client transport design

Implement `src/app/channel-bridge.ts` as the only client-side transport owner.

- `host.channels.open/attach/list` in `src/app/host-api.ts` calls into `channel-bridge.ts`.
- The bridge obtains the surface token through the same closure path as `host.store`, `host.callRoute`, and `host.session`.
- The bridge sends typed request/response frames over the existing authenticated session WebSocket, similar to `session-write-bridge.ts`.
- Pack code receives only a `HostChannel` object. It never sees:
  - a WebSocket object,
  - a URL,
  - an Authorization header,
  - a bearer token,
  - a gateway-relative path,
  - a caller-supplied pack id.

Proposed WS protocol additions in `src/server/ws/protocol.ts`:

```ts
// client -> server
| { type: "ext_channel_open"; requestId: string; surfaceToken: string; name: string; init?: HostChannelOpenInit; openGrant: string }
| { type: "ext_channel_attach"; requestId: string; surfaceToken: string; channelId: string }
| { type: "ext_channel_list"; requestId: string; surfaceToken: string; name?: string; includeClosed?: boolean }
| { type: "ext_channel_send"; requestId: string; channelId: string; frame: HostChannelFrame }
| { type: "ext_channel_close"; requestId: string; channelId: string; reason?: string }
| { type: "ext_channel_detach"; channelId: string };

// server -> client
| { type: "ext_channel_result"; requestId: string; ok: boolean; channel?: ChannelInfo; channels?: ChannelInfo[]; error?: ChannelErrorCode; message?: string }
| { type: "ext_channel_frame"; channelId: string; frame: HostChannelFrame }
| { type: "ext_channel_close"; channelId: string; reason?: string; error?: string };
```

`openGrant` is an opaque, one-shot, server-minted permit, not a client assertion, and it is required for every process-creating `ext_channel_open`. Direct user-gesture opens and trusted Bobbit launcher opens both first mint a server-verifiable grant bound to `{ sessionId, packId, contributionId, channelName, singletonKey }`, then consume it on `ext_channel_open`. The server rejects missing, unknown, expired, mismatched, or replayed grants before handler or PTY creation. There is no `trustedLauncher` boolean or equivalent authority-bearing client flag.

`ext_channel_send` and close frames do not carry a surface token. The server only accepts them from a WebSocket connection that has already successfully opened or attached that `{ sessionId, packId, channelId }` tuple; otherwise it rejects with `UNAUTHORIZED` or `CHANNEL_NOT_FOUND`.

## 5. Server channel registry

Add `src/server/extension-host/channel-registry.ts` as the process-lifetime registry. Key channels by:

```ts
{
  sessionId: string;
  packId: string;
  channelId: string;  // opaque random UUID/ULID
  name: string;       // pack-local channel name, e.g. "terminal"
}
```

Also maintain an optional singleton index:

```ts
sessionId + packId + name + singletonKey -> channelId
```

This lets a terminal launcher create or focus a session-persistent terminal without spawning duplicates.

### Open

1. WS handler receives `ext_channel_open` on an authenticated session connection.
2. Resolve the surface token with `resolveSurfaceIdentity({ headerSessionId: sessionId, ... })`.
3. Reject if the surface token session does not match the WS session.
4. Require a server-verifiable one-shot `openGrant` bound to this session, pack, contribution, channel name, and singleton key. The grant may have been minted from a synchronous direct user gesture or by trusted Bobbit platform launcher code, but the WS open path never accepts bare gesture claims.
5. Reject missing, forged, expired, replayed, or mismatched grants; never accept a client-supplied launcher-trust boolean.
6. Resolve `name` against `PackContributionRegistry.getChannel(projectId, packId, name)`.
7. Enforce quotas and singleton reuse.
8. Allocate the channel and start the pack handler.
9. Attach the current WS connection and return `ChannelInfo`.

### Attach

1. Resolve surface token.
2. Look up `channelId`.
3. Require exact same `sessionId` and `packId` as the channel record.
4. If the channel is open, attach this WS connection. Generic channels replay no historical frames by default; a handler may send explicit attach-only frames from `onAttach`, as the built-in terminal does for bounded PTY output replay.
5. If the channel is closed or missing, return a clear `CHANNEL_CLOSED`/`CHANNEL_NOT_FOUND` result.

Cross-pack and cross-session attach attempts should be indistinguishable from not found where possible to avoid enumeration.

### List

`list()` returns only channels for the resolved `{ sessionId, packId }`, optionally filtered by pack-local `name`. It never lists another pack's channels, another session's channels, or handler declarations.

### Detach/remount/reload

A browser panel unmount or WebSocket close detaches the connection only. It does not close the server channel. While detached, the channel remains alive until explicit close, process cleanup, handler exit, quota enforcement, or idle timeout.

V1 does not replay historical frames by default. Server outbound queues are delivery buffers for currently attached or briefly disconnected clients, not durable scrollback. Protocols that need reattach history must implement their own bounded replay and decide what is safe to expose to a newly attached client.

The built-in terminal protocol does this in the handler: while a PTY channel is live, recent text output is retained in an in-memory buffer scoped to that one `{session, pack, channel}` instance. On attach, the handler sends replay frames only to the attaching client, coalesced into bounded text frames, then sends status. Existing clients do not receive duplicate replay, and replay does not cross sessions, packs, channels, or clients. The WebSocket handler holds attach-time frames until it has sent the successful attach result, then flushes them, so the browser has a `HostChannel` before replay delivery begins.

On browser reload, the panel reconstructs its Host API, mints a fresh surface token, calls `host.channels.list({ name: "terminal" })` or `attach(channelId)`, and receives the still-live process channel when the gateway has not restarted. If the gateway restarted, there is no persisted live channel or replay buffer; the UI should render a disconnected state with `Restart`.

### Close

`HostChannel.close(reason)` sends `ext_channel_close`. The registry:

- marks the channel closing,
- invokes the handler cleanup,
- terminates any worker and child resources,
- broadcasts `ext_channel_close` to attached clients,
- retains a bounded closed tombstone for diagnostics/list-with-closed, then prunes it.

For terminal, `close("kill")` maps to PTY termination. Typing `exit` causes the PTY process to exit naturally; the handler sends the terminal exit frame and closes the channel.

### Cleanup

- **Session termination/archive:** `SessionManager.terminateSession()` calls `channelRegistry.closeSession(sessionId, "session-terminated")` before or alongside bg-process cleanup.
- **Pack uninstall/disable/precedence change:** `invalidateResolverCaches()` should call `channelRegistry.closeUnavailablePacks(projectId)` or force close channels whose `packId/name` no longer resolves to the same handler.
- **Gateway shutdown:** `channelRegistry.dispose("gateway-shutdown")` closes workers and PTYs best-effort.
- **Gateway restart:** no channel registry is persisted in v1. Clients attempting attach after restart receive closed/not-found and render a disconnected state with a Restart action.

## 6. Authorization model

All channel authority derives from the same existing surface-token path:

- `open`, `attach`, and `list` require a server-minted surface token.
- The server resolves trusted `{ sessionId, packId, contributionId, tool? }` from the token using `resolveSurfaceIdentity`.
- The channel name is resolved inside the derived `packId`; no request contains a trusted pack id field.
- Tool-bound tokens still re-resolve through the session's `ToolManager` and `allowedTools` when a tool is present.
- Pack-bound tokens validate through `PackContributionRegistry` for panel/entrypoint/route surfaces.
- A channel open does not trust any channel-owned identity from the client. It uses the surface token only to derive the calling pack, then resolves `name` against that pack's declared channels.

Cross-pack rejection examples:

- Pack A calls `attach(channelIdFromPackB)` → reject.
- Pack A calls `open("terminal")` when only Pack B declares `terminal` → reject `CHANNEL_NOT_FOUND`.
- Session A token used on Session B WebSocket → reject `surface token session mismatch`.
- A stale token after pack uninstall or precedence change → reject on re-resolution.

## 7. Pack contribution schema

Add a dedicated contribution type, not routes with streaming semantics.

### Directory layout

```text
<pack>/
  pack.yaml
  channels/<name>.yaml
  lib/<handler>.mjs
```

### `pack.yaml`

Add `contents.channels` as a list of channel contribution basenames:

```yaml
name: terminal
schema: 2
contents:
  channels: [terminal]
  entrypoints: [terminal-session-menu]
# panels remain auto-discovered from panels/*.yaml and are not listed in contents.
```

`contents.channels` is a manifest/list integration point, analogous to providers and entrypoints. It makes channel handlers explicit, filterable by pack activation, and visible in Market diagnostics without overloading routes.

### `channels/<name>.yaml`

Canonical schema:

```ts
interface ChannelContribution {
  name: string;
  protocol?: string;
  module: string;
  handler?: string;
  capabilities?: Array<"sessionPty">;
  requiresUserGesture?: boolean;
  quotas?: {
    maxChannelsPerSessionPerPack?: number;
    idleTimeoutMs?: number;
    maxFrameBytes?: number;
    maxInboundBufferedBytesPerChannel?: number;
    maxInboundBufferedFramesPerChannel?: number;
    maxOutboundBufferedBytesPerChannel?: number;
    maxOutboundBufferedFramesPerChannel?: number;
    maxBufferedBytesPerAttachedClient?: number;
    sendRateFramesPerSecond?: number;
    sendRateBurstFrames?: number;
    openTimeoutMs?: number;
    closeGraceMs?: number;
  };
}
```

Example terminal declaration:

```yaml
name: terminal                 # pack-local channel name; basename must match unless explicitly aliased
protocol: terminal.v1          # documentation/diagnostics string
module: ../lib/terminal-channel.mjs
handler: terminal              # export member under `channels`, default = name
capabilities: [sessionPty]
quotas:
  maxChannelsPerSessionPerPack: 1
  idleTimeoutMs: 1800000
  maxFrameBytes: 65536
  maxInboundBufferedBytesPerChannel: 1048576
  maxInboundBufferedFramesPerChannel: 256
  maxOutboundBufferedBytesPerChannel: 1048576
  maxOutboundBufferedFramesPerChannel: 256
  maxBufferedBytesPerAttachedClient: 262144
requiresUserGesture: true
```

Validation rules:

- `name` matches `/^[a-z0-9][a-z0-9_-]*$/` and is unique within the pack.
- `module` resolves relative to the channel YAML and must stay inside the pack root using `isPackPathWithinRoot`.
- `handler` is an export member name; default is `name`.
- `protocol` is metadata only; it does not affect dispatch.
- `capabilities` accepts only known privileged capability tokens. `sessionPty` is authorized only for built-in/first-party packs or an explicit reviewed allowlist; unauthorized declarations are rejected or loaded without the helper and surfaced as a validation problem.
- Quota keys are exactly the canonical names above. Values are integers clamped by server global minimum/maximum bounds; omitted values use server defaults from §9. Legacy aliases such as `maxChannelsPerSession` or `maxBufferedBytes` are not part of v1 and should be rejected or warned/dropped rather than silently interpreted.
- Unknown fields are tolerated for forward compatibility, retained only as inert metadata/diagnostics, and never grant authority or quota changes.
- Malformed channel files are warned and dropped; duplicate channel names are a hard pack-contribution conflict.

Extend:

- `src/server/agent/pack-manifest.ts` to accept `contents.channels`.
- `src/server/agent/pack-contributions.ts` with `ChannelContribution` and `loadChannels()`.
- `src/server/extension-host/pack-contribution-registry.ts` with `getChannel(projectId, packId, name)` and channel activation filtering.
- `src/app/api.ts` `PackContributionsWire` with `channelNames?: string[]` for diagnostics/client reconcile if needed.
- `GET /api/ext/contributions` to include channel names only, not module paths.

## 8. Channel handler runtime

Add a persistent channel handler host rather than reusing one-shot `ModuleHost.invoke()` directly.

Proposed files:

- `src/server/extension-host/channel-dispatcher.ts` — resolves channel modules, starts handlers, applies per-open concurrency/rate limits.
- `src/server/extension-host/channel-module-host.ts` — persistent worker per open channel, using the same import-containment and child-process tracking principles as `ModuleHost`.
- `src/server/extension-host/channel-registry.ts` — process registry, attachment tracking, queueing, idle timeouts, cleanup.
- `src/server/extension-host/channel-types.ts` — server-only handler contracts.

Pack module shape:

```ts
export const channels = {
  terminal: async (ctx, channel, init) => {
    const pty = await ctx.host.pty.openTerminal({ cols: 80, rows: 24 });
    pty.onData((data) => channel.send({ kind: "text", data }));
    pty.onExit((ev) => {
      channel.send({ kind: "json", data: { op: "exit", ...ev } });
      channel.close("pty-exit");
    });
    channel.onFrame((frame) => { /* protocol dispatch */ });
    channel.onClose(() => pty.kill());
  },
};
```

The worker receives a serializable context plus a proxied channel object. `channel.send` posts a message to the parent registry; inbound client frames are posted from the parent to the worker. The parent keeps authoritative state, quotas, attachments, and cleanup.

## 9. Backpressure, quotas, idle timeout, and errors

Default quotas should be conservative and overridable downward/upward within server-clamped bounds:

- `maxChannelsPerSessionPerPack`: default 4.
- `maxChannelsPerGateway`: default 128.
- `maxFrameBytes`: default 64 KiB for text or serialized JSON.
- `maxInboundBufferedBytesPerChannel`: default 1 MiB from attached clients waiting for handler delivery.
- `maxInboundBufferedFramesPerChannel`: default 256 client-to-handler frames.
- `maxOutboundBufferedBytesPerChannel`: default 1 MiB from handler waiting for attached clients.
- `maxOutboundBufferedFramesPerChannel`: default 256 handler-to-client frames.
- `maxBufferedBytesPerAttachedClient`: default 256 KiB per WS attachment for slow-client fanout.
- `sendRate`: token bucket per channel/direction, e.g. 120 frames/sec burst 240.
- `idleTimeoutMs`: default 30 minutes detached or inactive.
- `openTimeoutMs`: default 10 seconds for handler startup.
- `closeGraceMs`: default 2 seconds before worker/PTY force-kill.

Backpressure semantics:

- Client `HostChannel.send(frame)` resolves when the server accepts the frame into the channel's inbound queue.
- It rejects with `BACKPRESSURE` when inbound bytes/frames are above high-water mark and resumes only after the queue drains below low-water mark.
- Server `channel.send(frame)` returns a promise/boolean equivalent inside the handler worker; if outbound channel or attached-client queues cannot drain, it waits until outbound low-water mark or rejects on close.
- Inbound and outbound limits are enforced independently so sustained client input and sustained handler output are both bounded and testable.
- For terminal output, the terminal handler should pause PTY reads or buffer boundedly where the PTY library supports it; otherwise it must drop/close on sustained overflow rather than unbounded memory growth.

Error codes:

```ts
type ChannelErrorCode =
  | "UNAUTHORIZED"
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_CLOSED"
  | "HANDLER_NOT_FOUND"
  | "FRAME_TOO_LARGE"
  | "INVALID_FRAME"
  | "QUOTA_EXCEEDED"
  | "BACKPRESSURE"
  | "OPEN_TIMEOUT"
  | "HANDLER_ERROR";
```

The client maps failed requests to `Error` objects with `.code` and `.status` where applicable. `onClose` receives the final reason/error for UI state.

## 10. Audit logging

Add structured audit events at the server chokepoints:

- channel open accepted/denied,
- attach accepted/denied,
- close reason,
- handler crash/timeout,
- quota/backpressure denial,
- cross-session/cross-pack rejection,
- PTY spawn/exit for terminal channels.

Minimum fields: timestamp, event, sessionId, projectId, packId, channelName, channelId, contributionId, surface kind, result, error code, frame metadata counts/bytes. Never log frame payloads by default; terminal output and user input may contain secrets.

The immediate implementation can use the existing server logger/console style, but should centralize event construction in `channel-registry.ts` so it can later route to a durable audit sink.

## 11. User gesture, open grants, and trusted launcher requirement

Interactive channel creation can create durable processes. Therefore every `ext_channel_open` requires a server-verifiable one-shot `openGrant`; a bare WS open with only a surface token must be rejected even if the client claims a gesture.

Grant minting has two allowed sources:

- **Direct pack call from a real user gesture:** `host.channels.open()` synchronously consumes browser user activation (same prologue pattern as `host.session.postMessage`), asks the gateway to mint a short-lived open grant bound to `{ sessionId, packId, contributionId, channelName, singletonKey }`, then sends `ext_channel_open` with that grant. If user activation is absent, grant minting fails and no open frame is sent.
- **Trusted Bobbit platform launcher:** launcher-owned app code asks the gateway to mint the same bound one-shot grant as part of the click/slash dispatch. The grant is opaque to pack code and is never a pack-callable bypass.

`attach()` and `list()` do not require a grant; they are needed for remount/reload recovery and do not create a new process.

For terminal, the preferred flow is:

1. User clicks a session-menu entrypoint such as **Open Terminal**.
2. `runLauncherEntrypoint()` recognizes a structured channel-panel target, e.g. `{ action: "open-channel-panel", channel: "terminal", panelId: "terminal.panel", singletonKey: "default" }`.
3. Bobbit-owned launcher code asks the gateway to mint a short-lived open grant bound to `{ sessionId, packId, contributionId, channelName: "terminal", singletonKey: "default" }`. The grant is stored/validated server-side or encoded as an opaque signed nonce; it expires quickly and is consumed once.
4. The launcher calls `host.channels.open("terminal", { singletonKey: "default" })` through the bridge with that opaque `openGrant`. The server independently validates the grant against the surface token, WS session, channel name, singleton key, and contribution before creating any process. Direct user-gesture opens use the same grant-mint-and-consume sequence.
5. It opens/focuses the pack panel with `{ channelId }` params.
6. Closing the panel tab detaches UI only. Kill/Restart are explicit terminal actions.

An `ext_channel_open` with no grant, or with a made-up, expired, replayed, or mismatched `openGrant`, must be rejected. There is no accepted `trustedLauncher` field. This avoids the anti-pattern where a panel auto-opens a process on mount without a gesture, while also avoiding a client-asserted trust bypass.

## 12. Terminal protocol convention

The built-in terminal pack declares and owns `channels/terminal.yaml` with `protocol: terminal.v1`. The Host API remains generic.

### Frames

Client to server:

```ts
{ kind: "text", data: "..." }                         // PTY stdin
{ kind: "json", data: { op: "resize", cols, rows } }  // PTY resize
```

Server to client:

```ts
{ kind: "text", data: "..." }                         // PTY output
{ kind: "json", data: { op: "status", state: "starting" | "running" | "exited", cwd?: string, shell?: string } }
{ kind: "json", data: { op: "exit", code?: number, signal?: string, reason?: string } }
```

The built-in panel sends a kill JSON frame to request PTY termination. Restart after exit/kill is a new `open("terminal", { singletonKey: "default" })` from a trusted launcher or terminal panel button click.

### PTY helper

Add a narrow server-side helper available only to channel handlers that explicitly opt into terminal/session PTY support and pass registry authorization:

```ts
ctx.host.pty.openTerminal({
  cols,
  rows,
  cwd?: "session" | "projectRoot",
  env?: Record<string, string>,
}): Promise<PtyHandle>
```

`PtyHandle` exposes only:

```ts
write(data: string): void;
resize(cols: number, rows: number): void;
kill(signal?: string): void;
onData(cb: (data: string) => void): () => void;
onExit(cb: (ev: { code?: number; signal?: string; reason?: string }) => void): () => void;
```

PTY eligibility is declared in `channels/<name>.yaml` and validated by the dispatcher before `ctx.host.pty` is constructed:

```yaml
capabilities: [sessionPty]
```

`sessionPty` is a privileged channel capability. V1 should restrict it to built-in/first-party packs or an explicit reviewed allowlist in the pack registry; third-party generic channels do not receive `ctx.host.pty` by default. A handler without an authorized `sessionPty` declaration sees no `ctx.host.pty`, and attempts to invoke PTY helper paths fail closed.

The helper, not the pack, resolves:

- the session/worktree cwd,
- sandbox container execution when the session is sandboxed,
- read-only constraints,
- platform shell selection,
- environment redaction/allowlist,
- process cleanup on channel close/session termination.

Implementation should use `node-pty` or a documented cross-platform equivalent. `package.json` currently has no PTY dependency, so the terminal implementation must add one intentionally and handle install/build implications for Windows, macOS, Linux, and packaged binaries.

Sandbox rule: if a sandboxed session has a live container, the PTY runs inside that container with equivalent or stricter constraints. If no container is available, opening the terminal fails closed with a clear error; it must not silently spawn on the host. Unsandboxed sessions spawn in the session worktree per cwd policy.

## 13. Built-in terminal pack areas

Likely pack layout:

```text
market-packs/terminal/
  pack.yaml
  channels/terminal.yaml
  panels/terminal-panel.yaml
  entrypoints/terminal-session-menu.yaml
  lib/terminal-channel.mjs
  lib/terminal-panel.js
  src/terminal-panel.ts
  src/terminal-channel.ts
```

Build/package areas:

- `scripts/build-market-packs.mjs` to compile/copy terminal pack client/server modules if needed.
- `scripts/copy-defaults.mjs` / `scripts/copy-builtin-packs.mjs` only if the existing built-in pack copy path needs new files included.
- `market-packs/terminal/package` dependencies or root `package.json` for xterm.js and PTY runtime dependency.

UI behavior:

- xterm.js panel uses theme tokens, fit-to-panel resize, bounded scrollback, accessible label, status banner, Kill, Restart, and Close panel controls.
- Fit waits for connected, visible, non-zero panel dimensions and retries during mount, attach, restore, and resize. This avoids stale measurements and first-paint xterm corruption when a side panel is still settling.
- Panel remount/reload attaches to an existing channel by id or lists `name:"terminal"` and attaches the session singleton.
- Reattaching to a live terminal replays recent bounded PTY output from the handler before the status frame, targeted only to the attaching client and flushed after the browser attach result.
- Panel tab close detaches only. Kill closes the channel and PTY. Exit from shell marks channel closed.

## 14. Exact implementation sequencing

1. **Shared contract:** update `src/shared/extension-host/host-api.ts` with channel types, `HostChannelsApi`, `HostApi.channels`, `HostCapabilities.channels`, and `HOST_CONTRACT_VERSION = 4`.
2. **Pack schema:** update `src/server/agent/pack-manifest.ts`, `src/server/agent/pack-contributions.ts`, and `src/server/extension-host/pack-contribution-registry.ts` for `contents.channels` and `channels/<name>.yaml`.
3. **Metadata:** update `src/app/api.ts` and `/api/ext/contributions` in `src/server/server.ts` to include channel names for active packs.
4. **Server substrate:** add `channel-registry.ts`, `channel-dispatcher.ts`, `channel-module-host.ts`, and channel quota/error types under `src/server/extension-host/`.
5. **WS transport:** extend `src/server/ws/protocol.ts` and `src/server/ws/handler.ts`; add `src/app/channel-bridge.ts`; wire `host.channels` in `src/app/host-api.ts`.
6. **Lifecycle hooks:** thread the registry into server bootstrap, `handleWebSocketConnection`, resolver invalidation, gateway shutdown, and `SessionManager.terminateSession()` cleanup.
7. **Open-grant support:** extend `src/app/pack-entrypoints.ts`, `src/app/session-actions.ts`, and `src/ui/components/MessageEditor.ts` only as needed for channel-panel launcher targets plus server-minted one-shot open grants for both direct gestures and trusted launchers; never allow bare WS opens or introduce a client-trusted `trustedLauncher` flag.
8. **PTY helper:** add `src/server/extension-host/pty-helper.ts` and proxy support in the channel module host. Gate `ctx.host.pty` on an authorized `capabilities: [sessionPty]` channel declaration restricted to first-party/reviewed packs. Ensure sandboxed sessions fail closed unless launched inside the sandbox.
9. **Built-in terminal pack:** add `market-packs/terminal/` with channel, panel, entrypoint, xterm UI, and terminal handler.
10. **Docs/tests follow-up:** update authoring docs and add unit/API/browser E2E tests for registry auth, open/send/attach/close, quota denial, session cleanup, reload reattach, restart disconnected state, and terminal UX.

## 15. Test plan to hand to implementers

- Unit: channel frame validation, inbound/outbound quota and backpressure, singleton reuse, idle close, `PackContributionRegistry.getChannel`, duplicate channel rejection.
- Unit: surface token auth rejects wrong session, wrong pack, stale pack, missing handler, caller-supplied pack identity attempts, generic channel handlers without `sessionPty`, and `sessionPty` declarations from packs outside the first-party/reviewed allowlist.
- API/WS E2E: open, send both directions, attach from remount, detach on WS close without handler close, explicit close, session termination cleanup, quota denial, sustained client input backpressure, sustained handler output backpressure, and missing/forged/expired/replayed/mismatched open-grant rejection before handler/PTY creation.
- Restart E2E: open channel, restart gateway, reload/attach shows closed/disconnected and allows a new open.
- Browser E2E: Open Terminal from session menu, run a simple command, resize, reload and reattach, type `exit`, Kill, Restart, Close panel detach.
- Existing Extension Host tests must remain green: renderer/action/panel/route/store/session/surface-token invariants.
