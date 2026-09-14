# Design: project MCP approval with gateway authentication and opaque-origin previews

## Status and decisions

This document records the final implemented design for explicit approval of project-defined MCP servers. It preserves discovery, provenance, fingerprinting, private persistence, runtime filtering, safe status, Tools review, banner, Marketplace, worktree, shared-owner, and opaque-preview architecture. It reflects the product decision that direct, non-sandbox agents intentionally have human-equivalent gateway control and the later hardening that binds credential-free local authority to the actual socket peer.

Three decisions are selected and implemented:

1. **Use established gateway authentication for MCP decisions.** A request that has passed normal gateway admission and authentication through a signed `bobbit_session`, the admin bearer/query token, or trusted-local mode may approve or reject an exact current definition. Direct agents intentionally receive the admin `BOBBIT_TOKEN` and therefore may decide. Sandbox agents receive only sandbox-scoped tokens; `isSandboxAllowed()` default-denies the approval route before its body, ledger, or runtime can be touched.
2. **Bind trusted-local authority to the transport peer and fail closed for sandboxes.** Credential-free control requires both an admitted all-loopback policy and an actual loopback peer. Docker host-gateway proxying can erase container provenance, so sandbox creation/restoration/revival/respawn/replacement is refused before side effects in credential-free mode; operators must restart with `--auth`.
3. **Keep every repository-authored preview browsing context opaque.** Embedded previews omit `allow-same-origin`, and every successful preview content response has a CSP `sandbox` directive without `allow-same-origin`. A session-bound preview resource cookie and bounded `postMessage` bridges preserve assets and cosmetic behavior without giving repository content gateway authority.

The removed terminal/browser pairing system is not replaced with another principal or capability subsystem. The approval route composes with the existing global gateway boundary and retains every project, cwd, source, fingerprint, ledger, and reload check. Approval remains a deliberate per-server action and remains separate from `Allow` / `Ask` / `Never` tool invocation policy.

## Source-validated findings

The revised decision was validated against the current implementation rather than inferred from the earlier design:

- `src/server/server.ts` admits requests first, verifies `bobbit_session`, then accepts an admin Bearer/query token or peer-bound trusted-local request. A sandbox bearer resolves to `sandboxScope`; `isSandboxAllowed()` runs before `handleApiRoute()`.
- `src/server/request-admission.ts::isTrustedLocalRequest()` requires the compiled all-loopback policy and an actual loopback socket peer: IPv4 `127/8`, IPv6 `::1`, or IPv4-mapped loopback. Host and Origin are not peer evidence. HTTP API, preview/cookie bootstrap, and WebSocket paths all use this predicate.
- `src/server/auth/sandbox-guard.ts::isSandboxAllowed()` is an explicit allowlist and does not admit `POST /api/mcp-servers/:name/approval`.
- `src/app/gateway-fetch.ts::gatewayFetch()` supplies the configured gateway Bearer token and otherwise leaves Fetch credentials at the same-origin default, so remote configured gateways use the admin bearer and same-origin UI uses its signed cookie.
- `SessionManager.applyScopedGatewayCredentials()` and `scopedGatewayEnvForDirectAgent()` intentionally read and inject the admin token on direct create/delegate/restore/revive/respawn paths.
- `SessionManager.applySandboxWiring()` requires scoped-token minting and no longer falls back to `readToken()`. Missing token-store wiring or mint failure aborts sandbox startup.
- `RpcBridge.spawnDockerExec()` reserves `BOBBIT_TOKEN` case-insensitively, so configured sandbox credentials cannot override the server-minted scoped token.
- `src/server/agent/docker-args.ts` omits gateway URL/token from the sandbox container's PID 1. The scoped token is injected only into the session process with `docker exec -e`.
- `SessionManager.assertSandboxStartupAllowed()` runs before sandbox lifecycle effects, and the server installs credential-free mode before restoration. Direct sandbox bootstrap and session create/delegate paths therefore refuse credential-free trusted-local operation before Docker, worktree, hook, credential, or agent effects.
- The approval handler has no route-local pairing check. Server, CLI, browser, and Tools pairing surfaces have been removed; exact decision validation remains intact behind global authentication and sandbox denial.
- `src/app/mcp-approval-banner.ts` keeps scope-keyed confirmed counts and single-flight request ownership during periodic reconciliation. Timer refreshes preserve confirmed state; explicit decision/configuration invalidation increments the revision, clears cached count and request ownership, renders promptly, and lets a current fetch repopulate the count.

### Historical design findings and implemented responses

| Finding | Corroboration | Consequence | Required design response |
|---|---|---|---|
| Separate pairing conflicted with the amended authority | Both gateway-auth explorations and the UX exploration | It denied a direct agent that intentionally holds the same admin credential as the operator and added an unnecessary secret, endpoint, state owner, and UI ceremony. | Pairing was deleted end to end; established valid gateway authentication authorizes decisions. |
| Historical sandbox admin fallback | Both gateway-auth explorations; formerly present in `SessionManager.applySandboxWiring()` | Missing `SandboxTokenStore` wiring could have started a sandbox with the global admin token. | Scoped-token minting is now mandatory; sandbox startup fails closed when it cannot mint one. |
| Historical sandbox credential override | Minimal-composition exploration; formerly possible in `RpcBridge.spawnDockerExec()` ordering | A configured `BOBBIT_TOKEN` could have superseded the scoped token in the sandbox process. | The reserved name is now filtered case-insensitively and exactly the server-minted scoped token is emitted. |
| Pairing UI and client credential were obsolete | UX exploration plus both gateway-auth explorations | Keeping the form/header/storage errors would have misstated authority and complicated normal remote/UI behavior. | The callout, state, CSS, special header, endpoint, CLI code, and pairing errors were removed with no replacement UI. |
| Trusted-local authority based only on admitted Host policy was insufficient | Peer-bound auth review | A remote/container peer could present a loopback Host, and some Docker Desktop host-gateway paths can appear to Node as loopback. | Credential-free authority now requires an actual loopback socket peer, and all sandbox startup paths fail before side effects in credential-free mode. |
| Stale browser credential remained after removal | Both gateway-auth explorations | `mcp.operator.credentials.v1` became inert but remained secret-shaped browser data. | App boot now best-effort deletes only that key and never touches `gateway.url` or `gateway.token`. |
| Server verifier cleanup had competing proposals | One exploration proposed best-effort unlink; the other identified filesystem race/symlink surface. | The file contains only an ID/verifier and is harmless because no reader exists. | Bobbit does not auto-delete `serverSecretsDir()/mcp-operator-authorization.json`; it ignores the file and permits optional manual removal. |
| CORS compatibility had competing proposals | One exploration proposed a temporary ignored header; the minimal packet chose a clean contract. | A stale cached remote client may require refresh, but retaining a dead header would prolong obsolete surface. | The obsolete header was removed from accepted CORS headers; `Authorization` and `Content-Type` remain sufficient. |
| Explicit principal/capability layer is viable | Alternate exploration supplied a pure classification module and positive capability check. | It makes authority named but adds a type/module/router parameter and changes mixed-credential semantics not required by the amended model. | Reject it for this change. The already-authenticated request is authority; sandbox safety is enforced by credential provenance plus the existing pre-handler guard. |
| Mixed normal and sandbox credentials | Alternate exploration proposed contaminating otherwise valid admin/cookie/local authentication. | That would downgrade a valid normal gateway credential solely because a sandbox token is also presented. | Reject the downgrade. Any winning valid normal gateway credential is authority under the amendment. Keep `hasSandboxCredential` for its current cookie bootstrap/renewal defense. |
| Pairing-era preview containment remains necessary | Preview-isolation comparison and current iframe/content-route code | Normal gateway authentication is broader than the retired pairing token. Same-origin repository code could spend stored Bearer or ambient cookie authority. | Preserve opaque iframe/CSP isolation, narrow preview resources, and exact-source cosmetic messaging. |
| Periodic pending banner can flicker | Banner task and existing count/revision seams | Clearing a confirmed count on every timer refresh hides a real pending state and remounts the banner every two seconds. | Use stale-while-revalidate and single flight for periodic reconciliation. Preserve explicit invalidation's revision bump, cached-state/request-ownership reset, prompt render, and current refetch. |

## Scope ledger

### Must deliver

- Fail-closed startup and connection approval for every runtime-effective MCP definition introduced by repository-controlled project sources.
- Provenance through the existing discovery cascade and stable logical project/source identity across worktrees.
- Headquarters-owned approval persistence keyed by project, source, server, and deterministic configuration fingerprint, with no raw secrets persisted or exposed.
- Pending/rejected/changed definitions retained in safe status output while excluded from process spawn, connection, initialization, tool discovery, route publication, and data exchange.
- Immediate, consistent reload after an exact current decision; disconnection on rejection, removal, invalidation, or behavior change.
- A compact pending banner and deliberate per-server review in the existing Tools → MCP section, with startup approval separate from tool invocation policy and runtime health.
- Established gateway-authenticated decision authority for browser UI, direct agents, remote configured gateways, and peer-bound trusted-local mode; sandbox-scoped credentials remain denied.
- Fail-closed sandbox credential delivery: no admin fallback and no `BOBBIT_TOKEN` override through configured sandbox credentials.
- One peer predicate across HTTP API, preview/cookie bootstrap, and WebSocket: admitted all-loopback policy plus actual IPv4 `127/8`, IPv6 `::1`, or IPv4-mapped loopback peer.
- Credential-free sandbox fail-close across creation, restoration, revival, respawn, replacement, and direct sandbox bootstrap, before Docker/worktree/hook/credential/agent side effects.
- Opaque-origin execution for repository-authored inline HTML, mounted preview HTML, popouts/direct preview navigation, and active non-HTML documents such as SVG.
- Authenticated sibling preview resources without granting opaque preview code application/API authority.
- Message-based theme, resize, and swipe compatibility, with all messages cosmetic, source-checked, and bounded.
- Periodic stale-while-revalidate banner behavior that preserves confirmed state during timer refreshes, while explicit invalidation clears cached state and promptly refetches under a new revision.
- Documentation plus focused unit, DOM, integration, browser, multi-project, worktree, and cross-browser coverage.

### Allowed bounded improvements

- Fix existing Tools scope refresh so MCP data cannot remain from a previous project.
- Render the MCP section when pending/rejected servers have no registered tools.
- Correct existing MCP disclosure button/select structure where required by approval controls.
- Add one purpose- and session-bound preview resource cookie to the existing `CookieStore`.
- Add one shared preview-frame host helper for theme, resize, and swipe messaging.
- Narrow request admission and route-local CORS only for authenticated opaque-origin preview GET/HEAD resource loads.
- Best-effort remove the obsolete browser pairing-storage key.

### Deferred or out of scope

- A new Settings route, approval route, modal, server-rendered decision page, terminal confirmation, or browser/device pairing flow.
- A new authenticated-principal type, capability policy engine, user identity, middleware layer, or per-project admin-token restriction.
- Blanket approve-all or whole-repository trust.
- Changing `Allow` / `Ask` / `Never` semantics.
- Marketplace reapproval, OAuth/OIDC, WebAuthn, device lists, or broad credential management.
- A new MCP runtime coordinator or per-worktree live manager proliferation.
- Making repository preview JavaScript network-inert or safe to trust with application data.
- Same-origin compromise of trusted Bobbit application code, browser-profile/extensions compromise, or same-UID host compromise.

## Approval authority and request flow

### Selected minimal composition

The global API boundary in `src/server/server.ts` remains the only credential verifier:

1. `admitRequest()` validates the finite Host/Origin/Fetch Metadata/CORS context.
2. The gateway derives trusted-local authority only when `!forceAuth`, the admitted policy is all-loopback, and `req.socket.remoteAddress` is IPv4 `127/8`, IPv6 `::1`, or IPv4-mapped loopback. The same predicate feeds API, preview/cookie bootstrap, and WebSocket paths.
3. `CookieStore.verify()` accepts a genuine signed `bobbit_session`.
4. Otherwise, `validateToken()` accepts the admin Bearer/query token, `SandboxTokenStore.lookup()` resolves a scoped sandbox token, or a peer-bound trusted-local request uses the no-token contract. A selected sandbox credential retains sandbox scope even on a genuine loopback peer.
5. If a sandbox token won, `sandboxScope` is passed through `isSandboxAllowed()` before route dispatch. MCP approval is not allowlisted, so the gateway returns 403 before handler body parsing, manager creation, ledger access, or reload.
6. A non-sandbox authenticated request reaches the existing MCP approval handler. The handler freshly resolves viewing project and execution cwd, validates source project, server, source ID, and fingerprint against the current effective definition, durably records the decision, and reloads every relevant manager.

There is no second per-route credential check. This is deliberate: under the amended model, the normal authenticated gateway caller is allowed to make control-plane decisions. Request admission is still a network/browser boundary, not proof of humanness.

### Authority matrix

| Authenticated context | May decide MCP startup | Reason |
|---|---:|---|
| Admin Bearer/query token | Yes | Existing gateway-wide control credential. |
| Genuine signed `bobbit_session` | Yes | Existing authenticated UI session. |
| Peer-bound trusted-local request | Yes | Requires both the all-loopback admitted policy and an actual loopback socket peer; Host spoofing is insufficient. |
| Direct non-sandbox agent with `BOBBIT_TOKEN` | Yes | It intentionally receives the admin credential and has human-equivalent control. |
| Sandbox-scoped bearer | No | Resolves `sandboxScope`; default-deny route guard returns 403 before the handler. |
| Unauthenticated request | No | Global auth returns 401. |
| Obsolete `X-Bobbit-Mcp-Operator` alone | No | Header is removed from CORS and has no reader or authentication meaning. |
| Opaque preview resource cookie | No | Accepted only for GET/HEAD below its exact preview SID path. |

A valid normal credential is not downgraded merely because the request also contains a recognized sandbox token. This is consistent with the amended model: possession of an independently valid admin token or signed browser cookie is authority. `hasSandboxCredential` retains its narrower current purpose—preventing cookie bootstrap/renewal in a request that presents sandbox credentials—so a sandbox token cannot be converted into a browser cookie.

### Implemented sandbox hardening

`SessionManager.applySandboxWiring()` is the scoped-credential decision point across sandbox create, delegate, restore, revive, and respawn. It:

- requires a registered project and initialized `SandboxTokenStore`;
- mints a scoped token with `mintScopedGatewayToken()` for the exact project/session and optional goal;
- throws before the runtime starts if minting is unavailable or fails;
- never calls `readToken()` as a fallback; and
- leaves `bridgeOptions.gatewayToken` unset on failure.

`RpcBridge.spawnDockerExec()` reserves `BOBBIT_TOKEN` case-insensitively when projecting `sandboxCredentials`. The final Docker exec environment contains exactly the server-minted scoped token. `BOBBIT_TOKEN` and `BOBBIT_GATEWAY_URL` remain omitted from PID 1; session-secret delivery stays limited to the agent process, and private-locator filtering plus cwd/remapping remain intact.

A separate `SessionManager.assertSandboxStartupAllowed()` guard addresses Docker peer ambiguity. When the compiled gateway permits credential-free trusted-local control, it refuses sandbox creation, restoration, revival, respawn, replacement, and direct sandbox bootstrap before any container, image/network, worktree, hook, credential, or agent effect. The gateway installs this mode before restoring sessions. Restarting with `--auth` disables credential-free control and allows authenticated sandboxes to continue with scoped tokens.

Direct-agent behavior is not hardened away. `applyScopedGatewayCredentials()` and `scopedGatewayEnvForDirectAgent()` continue to inject the admin token for create/delegate/restore/revive/respawn. A failure to read that credential remains a direct-agent startup error.

### Rejected explicit capability layer

A pure `GatewayAuthenticatedPrincipal` plus `mcp-approval-decision` capability is a defensible alternative, but it adds a module, immutable request value, router parameter, positive policy function, and mixed-credential branch. It also implies that a valid admin/cookie request can be semantically downgraded by an extra sandbox credential. None is needed to implement the amended product rule: normal gateway authentication grants control, while sandbox-only callers are already identified and rejected before dispatch.

The selected composition has fewer independent concepts and is protected by focused gateway-level tests at the two real seams: normal credential admission and sandbox pre-handler denial. Do not generalize this change into an authorization framework.

## Security invariants

1. A repository-controlled definition cannot execute or connect before an exact approval of its current effective configuration.
2. A repository-controlled preview cannot read application local/session storage, IndexedDB, service-worker state, parent DOM, gateway Bearer storage, or application cookies.
3. A repository-controlled preview cannot make an authenticated application/API request merely because Bobbit rendered it. The preview-only cookie is accepted only for GET/HEAD below its exact session preview mount.
4. Removing an iframe's `allow-same-origin` is necessary but insufficient. Raw popouts, direct preview URLs, and active non-HTML documents receive the same opaque-origin boundary from response CSP.
5. MCP startup approval, gateway authentication, runtime health, and `Allow` / `Ask` / `Never` are independent concepts.
6. Approval identity is bound to stable registered-project identity, logical source identity, server name, and all behavior-relevant configuration through an opaque fingerprint.
7. Pending, rejected, changed, invalid, removed, or source-mismatched definitions cannot spawn, connect, initialize, publish tools/routes, or receive MCP calls.
8. Admin bearer, signed browser cookie, and peer-bound trusted-local mode may authorize a decision. Trusted-local authority requires an admitted all-loopback policy and an actual IPv4 `127/8`, IPv6 `::1`, or IPv4-mapped loopback socket peer; Host/Origin claims alone may not.
9. A sandbox-scoped token, preview resource cookie, obsolete operator header, Origin, or Fetch Metadata alone may not authorize a decision. A selected sandbox credential keeps sandbox scope on loopback and is rejected before handler effects.
10. Sandbox startup cannot fall back to the admin token, and sandbox-configured credentials cannot replace the server-minted scoped `BOBBIT_TOKEN`. Credential-free trusted-local mode refuses every sandbox startup/restoration/revival/respawn/replacement path before side effects because host-gateway proxying may obscure container provenance.
11. Preview bridge messages carry cosmetic state only. Hosts identify the exact sending frame by `event.source`, validate a strict DTO, and clamp numeric values; `event.origin === "null"` is never identity.
12. Generic gateway API CORS remains `allowCredentials:false`. Any credentialed `Origin: null` projection is route-local to authenticated preview GET/HEAD resources and is never available to API, WebSocket, UI static, preflight escalation, or unsafe methods.
13. Periodic pending-banner refresh never substitutes “unknown” for a last confirmed count. Explicit decision/configuration invalidation instead increments the revision, clears cached count and request ownership, renders promptly, and discards older responses before a current fetch repopulates state.

## Preserved MCP approval architecture

### 1. Provenance-bearing discovery with unchanged precedence

Keep `src/server/mcp/mcp-manager.ts::McpManager` as the single owner of discovery, precedence, connection lifecycle, external tool routes, health, and reload single-flight. Enrich resolved origin/group records rather than introduce a second catalogue:

```ts
type McpSourceAuthority = "marketplace" | "headquarters" | "user-home" | "project";
type McpSourceTrust = "pretrusted" | "approval-required";

interface ResolvedMcpOrigin {
  scope: McpContributionScope;
  authority: McpSourceAuthority;
  trust: McpSourceTrust;
  sourceId: string;
  file: string;
  projectId?: string;
  projectName?: string;
  path?: string;       // internal only
  packName?: string;
  packId?: string;
  sourceUrl?: string;
}
```

`_discoverManualServers()`, `_mergeConfigFile()`, and `_mergeProjectConfigFromClaudeJson()` carry explicit provenance from each source call site. Trust is never inferred later from a filesystem path or only from `origin.scope`.

| Source | Classification |
|---|---|
| Active Marketplace contribution at any installation scope | `marketplace` / pretrusted |
| `~/.claude.json`, including `projects[cwd].mcpServers` | `user-home` / pretrusted |
| `~/.claude/.mcp.json`, `~/.bobbit/.mcp.json` | `user-home` / pretrusted |
| Headquarters `bobbitConfigDir()/mcp.json` and Headquarters-owned custom MCP directories | `headquarters` / pretrusted |
| Registered project's `.mcp.json`, `.claude/.mcp.json`, `.bobbit/config/mcp.json` | introducing `project` / approval-required |
| Custom MCP directory declared by a normal project | introducing `project` / approval-required, regardless of target path |
| The same sources from another registered project | that additional `project` / approval-required |

`setAdditionalProjects()` receives `{projectId, projectName, cwd, configStore}`. `SessionManager.createMcpManager()` supplies identities from `ProjectContextManager.all()`. The introducing project, not merely the currently viewed manager, remains the provenance owner.

Preserve ordered `Map.set(serverName, candidate)` precedence. Resolve the complete cascade before approval classification. A higher-precedence pending, rejected, changed, or invalid project winner blocks fallback to a lower trusted candidate of the same name.

Logical source identifiers do not include worktree or repository roots:

- `project-file:.mcp.json`
- `project-file:.claude/.mcp.json`
- `project-file:.bobbit/config/mcp.json`
- `custom-dir:<digest-of-normalized-declared-location>/.mcp.json`

Pair these with persisted `RegisteredProject.id`. Root/worktree views of the same logical project share approval identity, but different effective content receives a different fingerprint. Relocation or rename does not change approval; a different registered-project UUID does.

### 2. Canonical fingerprint, decisions, and safe review projection

`src/server/mcp/mcp-approval-store.ts::McpApprovalStore` remains the Headquarters-owned state owner:

```ts
type McpApprovalDecision = "approved" | "rejected";
type McpApprovalState = "trusted" | "pending" | "approved" | "rejected" | "changed";

interface McpApprovalIdentity {
  projectId: string;
  sourceId: string;
  serverName: string;
  fingerprint: string;
}
```

The versioned canonical fingerprint input includes transport, command, ordered arguments, explicit working-directory semantics, effective environment, full URL, headers, and conservative unknown own fields. Recursively sort object keys, preserve array order, omit only `undefined`, and use the same environment expansion semantics as `McpClient`. Include credential-bearing URL components in the fingerprint even though they are removed from review output.

Use HMAC-SHA-256 with a Headquarters-owned random key stored beside the ledger. Persist only schema, project/source/server identity, opaque fingerprint, decision, and timestamps. Store ledger and key under `mcpApprovalSecretsDir()`, outside repositories. Use same-directory unique temp files, flushed writes, atomic rename, serialized mutations, and publish memory only after durable rename. Missing/corrupt keys invalidate decisions safely; persistence failure leaves memory and runtime unchanged.

Classification remains exact:

- pretrusted source → `trusted`;
- exact approved row → `approved`;
- exact rejected row → `rejected`;
- history for project/source/server but no exact fingerprint → `changed`;
- no history → `pending`.

Keep exact historical rows so removal and exact reintroduction may reuse the decision. Approve/reject is reversible; the last serialized decision for the exact tuple wins.

Review metadata is always projected live by the server. Reuse/export `redactMcpServerConfig`, `redactRecord`, and `redactUrl`. Environment/header values are `[redacted]`; URL userinfo/query/fragment are absent. Command and ordinary arguments remain visible for deliberate execution review, while values associated with credential-like flags or equal to configured secret values are redacted. UI code never receives raw definitions.

### 3. Runtime eligibility and lifecycle

All startup paths continue through `McpManager.connectAll()` → `reloadDiscoveredServers()` → `_reloadDiscoveredServers()` → gated connection → `McpClient.connect()`.

`discoverConnectionGroups()` retains every effective winner in `discoveredConnectionGroups`, including pending/rejected/changed/invalid definitions. Inside `_reloadDiscoveredServers()`:

1. Rediscover and validate the complete effective set.
2. Classify each final winner.
3. Disconnect any active runtime whose winner is absent, invalid, pending, rejected, changed, source-mismatched, or fingerprint-mismatched; remove clients, runtime configs, operations, routes, and generated registration state while preserving discovered review metadata.
4. Retain an unchanged runtime only for the same valid trusted/exact-approved winner.
5. Only valid trusted/exact-approved winners may reach the private gated connect helper.
6. Recheck eligibility after `client.connect()` and immediately before tool/route publication so a concurrent decision or file change cannot publish stale authority.
7. Refresh external MCP registrations after reconcile. `/api/internal/mcp-call` always resolves the current live manager and fails closed even if an older agent still displays a stale meta-tool.

Validate exactly one supported local-command or HTTP(S)-URL shape before approval and connection. Invalid definitions expose `MCP_CONFIG_INVALID` safely and cannot be approved.

`disconnectServer()` preserves discovery when used for eligibility cleanup. `POST /api/mcp-servers/:name/restart` calls `restartDiscoveredServer(name)`, queues full rediscovery/reconciliation, and cannot bypass approval.

`SessionManager` constructs one shared approval store and injects it into all managers. `SessionManager.decideMcpApproval()` owns exact current-winner validation, atomic decision publication, all-relevant-manager reload, external-registration refresh, and safe event broadcast. Approval/project/Marketplace mutations reload immediately. One process-wide unref'd bounded reconciliation timer detects external edits/removals without per-source watcher topology.

### 4. Status and decision API

`McpServerStatus` and `src/app/api.ts::McpServerInfo` retain separate approval, source, safe review, diagnostic, and health data. `getServerStatuses()` iterates effective discovered winners plus defensive active-only leftovers, not only runtime configs. Pending/rejected/changed report health `disconnected`, zero tools, no connection error, and informational diagnostics such as `MCP_APPROVAL_PENDING`, `MCP_APPROVAL_REJECTED`, and `MCP_APPROVAL_CHANGED`.

`GET /api/mcp-servers?projectId=...&ensure=true` uses existing project-scope resolution, reconciles safely, and returns pending/rejected/changed/invalid winners even when no operations exist.

The mutation uses only normal gateway authentication:

```http
POST /api/mcp-servers/:name/approval?projectId=<view-project>
Authorization: Bearer <normal gateway token>   # configured remote gateway; omitted for cookie/trusted-local
Content-Type: application/json

{
  "decision": "approved|rejected",
  "fingerprint": "...",
  "sourceProjectId": "...",
  "sourceId": "..."
}
```

Global authentication and sandbox denial occur before the route. The handler validates viewing scope, source-project existence, and the exact server/source/fingerprint as the current runtime-effective approval-required winner. Removed, shadowed, or changed requests return `409 MCP_APPROVAL_STALE` with fresh safe metadata; trusted or non-reviewable rows return 422. Persistence precedes reload; response is the current safe status. Old decisions are never retried automatically.

A safe `mcp_approvals_changed` event contains only affected project IDs and pending counts. Tabs refetch authoritative state; configuration and fingerprints are not broadcast.

## Tools and banner UX

### Tools → MCP

No page, navigation item, modal, auth callout, or approve-all action is added. Pairing UI is deleted with no replacement. The MCP header is followed directly by server rows.

`src/app/tool-manager-page.ts::renderMcpSection()` renders rows even when no tools exist. Header copy explains that startup can run a command/contact a service and that tool invocation policy is separate. Each row shows startup approval and runtime health independently:

- startup: `Pending approval`, `Approved`, `Rejected`, `Configuration changed — review again`, `Trusted`;
- runtime: `Not started`, `Connecting…`, `Connected`, `Disconnected`, `Error`.

Pending/rejected/changed always show `Not started`, never `Error`. `Tool calls:` labels the independent `Allow` / `Ask` / `Never` control.

The inline review shows introducing project, logical source file, transport, redacted command/arguments or URL, working directory, redacted environment/header names, a short fingerprint, and safe diagnostics. Actions remain deliberate per server: pending can Reject/Approve; changed and rejected can approve the current configuration; approved can reject with interruption confirmation. Lock only the affected row, do not update optimistically, keep focus/expansion after refresh, and present stale/current configuration errors inline.

An approval click immediately uses `decideMcpServerApproval()` through the active `gatewayFetch()` connection. Successful requests announce `{server} approved/rejected`, refresh the exact scope, and return focus to the row disclosure. `MCP_APPROVAL_STALE` refreshes, keeps the row expanded, displays the current-config warning, and requires another click. Ordinary 401/403/network failures use established gateway recovery and the row's alert; no pairing language or credential-storage concept appears.

Responsive behavior remains inline: at 768px summaries and controls wrap; at 480px decision actions stack with Approve last; touch targets remain at least 44px. Preserve disclosure ARIA, `role="alert"`, polite atomic announcements, visible focus, and text labels independent of color.

### Pending banner stale-while-revalidate amendment

`src/app/mcp-approval-banner.ts` owns only a scope-keyed confirmed pending/changed count, revision, in-flight request, and Tools timer. The banner remains compact and non-blocking: `N MCP servers need review for {project}.` plus `Review servers`. Its action selects the exact project/session/goal review scope, navigates to existing Tools, expands the first pending/changed row, and focuses its disclosure.

Reconciliation follows these rules:

1. A missing scope has no banner. A scope with no confirmed result renders no speculative banner.
2. Once a count is confirmed, keep it while periodic revalidation is unresolved. A timer refresh never deletes it merely to mark loading.
3. Allow both confirmed zero → pending and pending → zero transitions during periodic reconciliation. Only a successful current response changes the confirmed count in that lifecycle.
4. Keep periodic reconciliation single-flight per exact scope. Timer ticks do not overlap a slow periodic request.
5. Capture the scope revision at request start. Explicit decision/configuration invalidation increments the revision, so a response from the prior revision is discarded even if it resolves last.
6. Explicit invalidation clears the affected scope's cached count and in-flight request ownership, then renders promptly. The render starts a current authoritative fetch without trusting event-provided counts; that fetch repopulates the cache under the new revision.
7. Scope changes never project the old scope's count into the new one. Each scope key retains its own fenced state.
8. Rejected-only rows do not count. A current periodic response can remove a confirmed banner; explicit invalidation removes the cached presentation immediately until the current fetch resolves.

This is stale-while-revalidate for periodic Tools reconciliation, not optimistic state and not a change to explicit invalidation semantics. It prevents the every-two-second banner flash while still discovering filesystem changes on a continuously mounted Tools route that has no active session socket. Explicit decision/configuration events deliberately clear affected cached state and trigger prompt authoritative repopulation.

## Migration and compatibility

### Pairing-removal migration record

- `src/server/auth/mcp-operator-authorizer.ts`, its construction/threading, the former pair endpoint, and the gateway's pairing-code hook were deleted.
- CLI pairing-code creation/format/output was deleted. Normal startup URL, token banner, `--show-token`, auto-open, base-path, Vite, remote, and headless behavior remain unchanged.
- `src/app/mcp-operator-auth.ts` was deleted. `decideMcpServerApproval()` relies on `gatewayFetch()` for existing connection auth.
- Pairing state, copy, form, focus/error handling, test IDs, and pairing-only CSS were removed from Tools.
- The obsolete request header was removed from `API_CORS_ALLOWED_HEADERS` and request/response/test helpers. A stale cached client must refresh to use the current contract.
- App boot calls `safeRemoveItem("mcp.operator.credentials.v1")` best-effort without parsing, displaying, migrating, or attaching the value and without altering `gateway.url` or `gateway.token`.
- Bobbit does not unlink `serverSecretsDir()/mcp-operator-authorization.json` automatically. With no importer, constructor, or route reading it, the ID/verifier is inert and grants nothing. Operators may remove it manually; leaving it has no security or runtime effect.
- Existing approval ledger decisions, fingerprint keys, and historical decisions remain valid. The retired pairing verifier is not approval state.

### Approval compatibility

- Existing project definitions without a ledger decision remain pending; no grandfathering.
- User/home, Headquarters/managed, and Marketplace sources remain pretrusted.
- Configuration changes produce `changed` and disconnect before reapproval.
- Direct agents may now approve by design. This is not presented as human-only behavior.
- A genuine signed browser cookie and peer-bound trusted-local mode may decide under their existing contracts. Trusted-local requires both an all-loopback admitted policy and an actual loopback socket peer.
- Sandbox-only requests continue to receive a generic pre-handler 403. The obsolete-header-only case receives outer 401 because the header is not authentication.
- Credential-free trusted-local deployments cannot start or restore sandbox agents. This is a deliberate safety fallback for host-gateway proxies that can erase container provenance; restart with `--auth` to use sandboxes.

### Preview compatibility

- Existing preview URLs, mount layout, artifact IDs, entry selection, base-path behavior, and popout action remain stable.
- Repository-authored scripts continue to run, but scripts relying on app storage, `parent.document`, `iframe.contentDocument`, or same-origin API access intentionally stop working.
- Theme, resize, and swipe use bounded messaging before same-origin assumptions are removed.
- Existing standalone theme snapshot remains the no-parent fallback.

## Preview isolation: scope-preserving comparison

Both preview options preserve the exact pairing-free Tools → MCP journey, pending/approved/rejected/changed behavior, popouts and interactive previews, established gateway-auth decision authority, and separate tool-call policy. Neither adds an approval page, modal, ceremony, approve-all action, or MCP-flow state.

| Concern | A — selected opaque-origin composition | B — separate preview origin/listener |
|---|---|---|
| Trust boundary | Keep bytes on the gateway preview route, but make every active document opaque with iframe `sandbox="allow-scripts"` plus response CSP sandbox without `allow-same-origin`. | Serve every mounted document, asset, inline card, popout, and active SVG from a dedicated HTTP(S) origin exposing no gateway API/UI/WS/SSE/MCP route. |
| Initial navigation/resources | Existing admitted navigation reaches `/preview/<sid>/...`; after exact initial auth the route issues a purpose- and SID-bound preview cookie. Opaque relative resources return to the same route with that cookie and route-local null-origin CORS where required. | UI obtains a short-lived signed read claim through a new authenticated gateway endpoint, posts it to the preview listener, receives an HttpOnly SID cookie, then navigates to the preview origin. |
| Stored paths/browser URL | Internal `/preview/...` representation and `gatewayUrl()` remain unchanged. | Internal routes remain stored, but a new advertised preview base and `previewUrl()` transform are required. Main gateway must stop serving repository bytes. |
| Inline HTML | Keep `srcdoc`, inject initial cosmetic/child bridges, assign prepared `srcdoc` after existing debounce. | Use a Bobbit-owned bootstrap on the preview origin and transfer prepared content through exact-origin/source messaging. |
| Popout/direct/SVG | Common response CSP supplies opacity without an iframe; path-scoped cookie contains resource authority. | Query-free links use preview origin. Without its claimed SID cookie, listener returns a safe 401 page. |
| Cosmetic bridge | Register exact `WindowProxy`; use `postMessage("*")` because opaque origins cannot be named. Validate bounded cosmetic DTOs. | Require exact source and advertised preview origin; otherwise same bounded DTO. |
| Lifecycle/deployment | Existing gateway listener, mount, admission, and shutdown remain owners. No new port, DNS, certificate, firewall, or proxy route. | Adds listener bind/readiness/TLS/publication/rollback/dual-close, public origin config, firewall/DNS/proxy reachability, and remote/mobile two-port support. |
| Failure modes | Wrong cookie/admission/CSP fails closed; bridge loss degrades cosmetics only. Browser differences can withhold assets but never restore gateway authority. | Bind/TLS/origin collision aborts; claim/cookie errors disclose no bytes; stale endpoint generations and dual shutdown require new handling. |
| Isolation quality | Per-context opaque origin, no shared preview localStorage/service worker authority. | Conventional preview-origin storage is shared across previews unless more partitioning is introduced. |
| New defect surface | One SID cookie format, one narrow GET/HEAD admission/CORS branch, successful-response CSP, one frame-host bridge. | New socket/origin/config, claim endpoint/format, credentialed CORS, client endpoint cache, URL rewriting, bootstrap transport, and coordinated shutdown. |

Select A. It reaches the same repository-authority, asset, inline review, popout/SVG, base-path, restart, and cross-browser boundary while composing with the existing single listener and preview mount lifecycle. B is viable but materially larger and offers weaker per-context storage isolation.

Server-rendered per-decision ceremony is not the comparator. It violates the explicit no-new-page UX and is unnecessary after the authority amendment. Storage-only containment is insecure; iframe-only misses popouts/SVG; CSP-only lacks local embedding defense; disabling scripts breaks compatibility; anonymous mounts and URL credentials leak authority.

## Selected preview-origin architecture

### 1. Two-layer browsing-context isolation

Set exact `sandbox="allow-scripts"` and omit `allow-same-origin` at both repository iframe sites:

- `src/app/render.ts::htmlPreviewContent()` for mounted side-panel preview;
- completed and streaming branches in `src/ui/tools/renderers/HtmlRenderer.ts::render()` for inline `srcdoc`.

Do not add `allow-popups-to-escape-sandbox`, storage-access tokens, or unrestricted top navigation.

In `src/server/preview/content-route.ts::handlePreviewRequest()`, add this header to every successful HTML and non-HTML GET/HEAD response:

```text
Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-top-navigation-by-user-activation; frame-ancestors 'self'
```

The absent `allow-same-origin` is the invariant. Embedded iframe/CSP restrictions intersect; response CSP also covers raw popouts, direct URLs, alternate entries, and active SVG. CSP construction failure serves no repository bytes. Redirect/error responses remain no-store and disclose no content.

### 2. Session-bound preview resource cookie

Extend `src/server/auth/cookie.ts::CookieStore` with a separately domain/version-signed credential bound to exact preview SID. It is `HttpOnly; Secure; SameSite=None`, has bounded lifetime, and has exact base-path-aware `<base>/preview/<sid>/` Path.

Initial preview documents still require existing normal gateway authority. Only a successful initial response issues/refreshes the preview cookie. Follow-on GET/HEAD resources below the same SID may use it. It is never accepted by API/UI/WS, SSE outside the mount, MCP routes, another SID, or another gateway base path.

The cookie is a read-only resource capability, not application identity. Do not put credentials in preview URLs, make mounts anonymous, widen generic `bobbit_session`, or accept preview credentials in generic auth helpers.

### 3. Narrow opaque-resource admission and CORS

Extend `request-admission.ts::admitRequest()/classifyContext()` only for coherent opaque preview follow-on shapes:

- preview resource or required opaque iframe-navigation context;
- GET or HEAD;
- exact serialized `Origin: null` or coherent originless subresource;
- coherent Fetch Metadata destination;
- no preflight escalation, unsafe method, WebSocket, API, or UI-static route.

Inner route preview-cookie verification remains mandatory. Admission is not authorization. After exact route/auth checks only, a null-origin response may project:

```text
Access-Control-Allow-Origin: null
Access-Control-Allow-Credentials: true
Vary: Origin
```

Generic `simpleCors()` remains `allowCredentials:false`. There is no unsafe/preflight/general API exception.

### 4. Message-based cosmetic compatibility

Replace `PREVIEW_THEME_BRIDGE` parent DOM access with a versioned child ready/theme protocol. Add `src/ui/preview-frame-host.ts` to register the exact current iframe `contentWindow`, snapshot an allowlisted bounded set of cosmetic tokens, and post with `"*"`. Exact `WindowProxy` identity—not origin `null`—binds the channel.

`prepareInlineHtml()` injects initial theme/bootstrap before authored scripts and keys its bounded cache accordingly. Standalone documents retain `getPreviewThemeSnapshot()` as fallback.

Replace `HtmlRenderer` `contentDocument` resize with child `ResizeObserver` messages. Accept finite heights only from the registered inline frame and clamp to the existing 600px cap and nonzero minimum. Replace `document.open/write/close` streaming with prepared `srcdoc` assignment after the existing 1.5-second debounce. Cleanup unregisters frames, observers, and timers.

`setupPreviewSwipe()` accepts finite/clamped messages only from the active side-panel frame's exact `WindowProxy`. Swipe remains a cosmetic hint and cannot navigate privileged routes or mutate security state.

### 5. Raw popout and active-document behavior

`sidePanelPopoutButton()` keeps the canonical query-free preview URL. Response CSP makes the document opaque. A malicious popout/API request carries null origin, gateway API admission rejects it, and the path-scoped preview cookie is unusable there. Active SVG receives the same CSP. `X-Content-Type-Options: nosniff`, traversal defenses, mount read leases, base injection, artifact addressing, and no-store remain unchanged.

## Failure and deployment behavior

- Missing/expired/tampered/wrong-session preview cookie discloses no bytes and mints no replacement.
- Unsupported opaque `SameSite=None; Secure` behavior may break secondary assets; it must never restore same-origin or anonymous access.
- Missing/invalid bridge messages degrade theme/size/swipe only.
- Stale frames fail exact-source checks after replacement.
- Preview admission/CORS ambiguity and CSP-generation failure fail closed.
- MCP approval persistence failure leaves decision/runtime unchanged.
- Missing sandbox token-store wiring or token mint fails sandbox startup; it never degrades to admin.
- Invalid/configured reserved sandbox credentials are skipped; they never replace scoped gateway auth.
- Peer-bound trusted-local mode means any process that reaches the gateway through an actual loopback socket under the all-loopback admitted policy can decide. Host spoofing alone is insufficient.
- Credential-free trusted-local mode refuses sandbox creation/restoration/revival/respawn/replacement before side effects because Docker host-gateway traffic may be indistinguishable from a host loopback peer.
- Direct-agent/admin-token compromise permits MCP decisions by design. Do not describe this as human-only protection.
- Non-loopback remote gateways require HTTPS for `Secure` preview cookies. Test Chromium, Firefox, and WebKit because opaque Fetch Metadata and cookie behavior vary.
- Vite, embedded, saved cross-origin, reverse-proxy, base-path, remote, and mobile operation retain current gateway/request-admission configuration. The new preview exception remains preview-route-only.

## Final implementation record

### Delivered sequence

1. **Removed the obsolete authority subsystem.** Server authorizer/route/hook, CLI code lifecycle, browser credential owner/header, Tools pairing UI/CSS, pairing errors/tests/helpers, and the special CORS header were deleted. App boot performs bounded browser-storage cleanup; the inert server verifier remains unread.
2. **Hardened sandbox credential delivery.** `applySandboxWiring()` has no admin fallback, and `spawnDockerExec()` reserves `BOBBIT_TOKEN` case-insensitively while preserving direct-agent admin continuity.
3. **Composed approval with global auth.** The approval handler remains behind existing auth and the sandbox guard, with its scope/body/fingerprint/persistence/reload checks intact.
4. **Bound trusted-local authority to the peer.** HTTP API, preview/cookie bootstrap, and WebSocket use the same all-loopback-policy plus actual-loopback-peer predicate. Credential-free mode refuses sandbox startup/restoration/revival/respawn/replacement before effects.
5. **Amended banner reconciliation.** Periodic refresh preserves the last confirmed per-scope count and stays single-flight; explicit invalidation retains its revision bump, stale-response fence, cache/request reset, prompt render, and current refetch.
6. **Preserved the MCP trust core and preview isolation.** Provenance, fingerprinting, redaction, private persistence, runtime filtering, Marketplace/worktree/shared-owner behavior, opaque preview CSP/iframes, scoped preview cookie, and bounded bridges remain intact.
7. **Updated journeys and support.** The canonical browser flow goes from banner directly to inline review, decides without pairing, survives reload, handles changed reapproval, and cleans up.

### Exact production file and symbol matrix

| File | Symbol/seam | Final implemented behavior | Preserved invariant |
|---|---|---|---|
| `src/server/server.ts` | global API auth/guard; `handleApiRoute()`; MCP approval route | Approval uses normal gateway auth and remains behind the sandbox guard; retired pairing construction/route/hook/header checks are absent. The same peer-bound trusted-local predicate feeds API, preview, and WebSocket paths. | Project/cwd/source/fingerprint validation, ledger/reload, safe status, generic auth precedence. |
| `src/server/request-admission.ts` | `isLoopbackPeerAddress()`, `isTrustedLocalRequest()` | Accepts IPv4 `127/8`, IPv6 `::1`, and IPv4-mapped loopback only when the admitted policy is all-loopback. | Host and Origin never prove the transport peer. |
| `src/server/auth/mcp-operator-authorizer.ts` | Retired authorizer | Deleted; this row is migration history only. | Approval ledger/key are unrelated and remain. |
| `src/server/cli.ts` | normal gateway startup | Pairing output/lifecycle is absent; startup uses the established gateway token and `--auth` mode. | Normal token/startup URL, auto-open, Vite/base-path/remote behavior. |
| `src/server/cors.ts` | `API_CORS_ALLOWED_HEADERS` | The retired MCP operator header is absent. | `Authorization`, `Content-Type`, finite origins, non-credentialed generic CORS. |
| `src/server/agent/session-manager.ts` | `applySandboxWiring()`, `mintScopedGatewayToken()`, `assertSandboxStartupAllowed()`, direct credential helpers | Requires a sandbox scoped token with no `readToken()` fallback; keeps direct admin injection; refuses every sandbox startup path before side effects in credential-free mode. | Create/delegate/restore/revive/respawn lifecycle and sandbox worktree ownership. |
| `src/server/agent/rpc-bridge.ts` | `spawnDockerExec()` environment projection | Skips sandbox credential key `BOBBIT_TOKEN` case-insensitively and emits one scoped token. | PID-1 omission, session secret, cwd/remap/private-env behavior. |
| `src/app/mcp-operator-auth.ts` | Retired browser credential owner | Deleted; this row is migration history only. | Gateway connection storage remains in `gateway-fetch.ts`. |
| `src/app/api.ts` | `decideMcpServerApproval()` | Uses normal `gatewayFetch()` without a special credential header or retry/forget branch. | Exact request body/scope and response/stale parsing. |
| `src/app/tool-manager-page.ts` | decision rows | Pairing state/callout is absent; rows decide directly through established gateway auth. | Safe review, confirmation, stale refresh, focus/live regions, policy separation. |
| `src/app/tool-manager.css` | MCP row styling | Retired pairing-only rules/selectors are absent. | Existing MCP row/responsive/accessibility styling. |
| `src/app/main.ts`, `src/app/safe-storage.ts` | app boot; `safeRemoveItem()` | Best-effort removes only `mcp.operator.credentials.v1`. | `gateway.url`, `gateway.token`, boot/auth flow. |
| `src/app/mcp-approval-banner.ts` | confirmed count/request/revision maps; periodic timer/invalidation | Preserves confirmed count and single flight during periodic refresh; explicit invalidation bumps revision, clears cached count/request ownership, renders promptly, and refetches current state. | Stale-response discard, zero transitions, scope resolution, Review servers navigation/focus, rejected exclusion. |
| `src/server/preview/content-route.ts` | `handlePreviewRequest()`, `isAuthorized()` | Preserves scoped cookie follow-ons, common sandbox CSP, and post-auth null-origin CORS. | Entry/artifact/path/read-lease/base/no-store behavior. |
| `src/server/auth/cookie.ts` | `CookieStore` and preview helpers | Preserves the domain-separated SID-bound preview format/path. | Generic `bobbit_session` format and browser auth. |
| `src/server/request-admission.ts` preview seam | preview context classification and CORS projection | Preserves the exact opaque GET/HEAD exception alongside peer-bound local authority. | API/UI/WS/preflight policy and generic non-credentialed CORS. |
| `src/app/render.ts` | mounted iframe/popout/swipe | Preserves exact `allow-scripts`, frame registration, source-checked swipe, and raw query-free popout. | Panel/SSE/restore/navigation behavior. |
| `src/ui/tools/renderers/HtmlRenderer.ts` | inline iframe/stream/resize | Preserves opaque `srcdoc`, message resize, debounce, and cleanup. | 600px cap, 1.5s debounce, stable completion/EditRenderer behavior. |
| `src/ui/tools/renderers/prepare-inline-html.ts`, `src/shared/preview-bridge-scripts.ts`, `src/ui/preview-frame-host.ts` | prepared content and bridge | Preserves the bounded source-bound theme/resize protocol. | No security authority, fetch, storage, or navigation responsibility. |

### Verification coverage

- Global request/auth and CORS: `tests/integration/gateway/request-admission.gateway.test.ts`, `request-admission-config.gateway.test.ts`, `tests/unit/core/browser-cookie-eligibility.unit.test.ts`, `sandbox-guard.unit.test.ts`.
- Direct/sandbox credential split: `tests/integration/gateway/direct-agent-admin-token.gateway.test.ts`, `tests/unit/core/session-manager-sandbox-scope.unit.test.ts`, `docker-args-sanitize.unit.test.ts`, `rpc-bridge-private-env.unit.test.ts`.
- MCP identity/runtime: `mcp-approval-store.unit.test.ts`, `mcp-approval-lifecycle.unit.test.ts`, `mcp-shared-owner-approval.unit.test.ts`, `mcp-project-approval.gateway.test.ts`, `mcp-approval-redaction.gateway.test.ts`, project-root/worktree/Marketplace suites.
- Tools/banner: `tests/browser/fixtures/tool-manager-mcp-section.fixture.spec.ts`, `tests/dom/mcp-approval-viewer-push.dom.test.ts`, `tests/browser/journeys/mcp-project-approval.journey.spec.ts`.
- Preview cookie/route/admission: `preview-cookie.unit.test.ts`, `preview-content-route.unit.test.ts`, `preview-mount-route.gateway.test.ts`, `request-admission.unit.test.ts`, base-path preview suites.
- Preview renderer/bridge: `inline-html-renderer-lifecycle.dom.test.ts`, preview theme snapshot/runtime/standalone suites, mobile pane retention, preview compatibility/restart/panel/reopen/stateless-cookie journeys.

These tests protect reused seams; revised coverage supplements rather than replaces them.

## Focused acceptance coverage

### Gateway authority and sandbox

1. Admin bearer approves and rejects the exact current tuple; runtime starts/disconnects accordingly.
2. Genuine signed `bobbit_session` approves through normal same-origin UI behavior.
3. Peer-bound trusted-local mode approves under its no-token contract for IPv4 `127/8`, IPv6 `::1`, and IPv4-mapped loopback.
4. A non-loopback socket peer cannot gain trusted-local authority by presenting a loopback Host; the same predicate protects API, preview/cookie bootstrap, and WebSocket.
5. Missing auth is 401; the obsolete MCP operator header alone is 401 and cannot affect ledger/runtime.
6. A real sandbox-scoped token is 403 before body parsing, manager creation, ledger mutation, process spawn, or remote request, including on a loopback peer.
7. `isSandboxAllowed('/api/mcp-servers/name/approval', 'POST', scope)` remains false.
8. Sandbox wiring without a `SandboxTokenStore` or minted token throws and never reads/injects admin.
9. A sandbox credential named any casing of `BOBBIT_TOKEN` cannot override the server-minted scoped value; Docker exec contains exactly the scoped token and no admin sentinel.
10. Credential-free trusted-local mode refuses sandbox create/restore/revive/respawn/replacement and direct bootstrap before Docker, worktree, hook, credential, or agent effects, with recovery guidance to restart using `--auth`.
11. Direct create/delegate/restore/revive/respawn still receive the admin token.
12. Existing `hasSandboxCredential` cases continue to deny cookie bootstrap/renewal when a recognized sandbox credential is presented.

### Historical pairing-removal and UX acceptance

1. The retired authorizer and browser credential suites are absent; no pair route, CLI code, gateway hook, callout, CSS, test ID, special header, or pairing-only approval error remains.
2. Seed `mcp.operator.credentials.v1`; app boot removes it without changing the active gateway URL/token.
3. Seed the old server verifier; startup ignores it, obsolete header cannot authorize, and normal admin auth still can.
4. Standard `Authorization`/`Content-Type` remote preflight remains allowed with `allowCredentials:false`; the obsolete header is absent from the allowlist.
5. Tools opens directly to server rows. Each exact row retains safe review, individual actions, interruption confirmation, `Working…`, stale refresh/no replay, focus restoration, and announcements.
6. Canonical browser journey: pending banner → Review servers → inline safe review → reject one/approve one → runtime update → hard reload durability → changed configuration returns to review → approve current fingerprint → cleanup. No pairing step or approve-all.

### Banner reconciliation

1. A confirmed pending banner stays the same mounted element throughout a deferred periodic refresh.
2. Slow periodic requests never overlap later timer ticks.
3. Confirmed zero becomes pending after a current response; confirmed pending becomes zero only after a current response.
4. Explicit invalidation increments the revision, clears cached count and request ownership, renders promptly, and starts a current fetch that repopulates state without trusting event-provided counts.
5. A response from an older revision cannot replace the current result, including after invalidation or scope changes.
6. Scope changes remain isolated; no scope projects its cached count or request ownership into another.

### MCP trust/runtime

Retain coverage for provenance, trusted-source classification, canonical fingerprinting, secret redaction, decision atomicity, stale-fingerprint rejection, no pending/rejected stdio spawn, no pending/rejected remote request, approval startup/connect, changed-config revocation, removal disconnect, shared-owner gating, all-manager reload, Marketplace attestation, multi-project attribution, and stable logical worktree identity.

### Opaque preview regression

Adapt the canonical hostile preview journey to the new authority:

- malicious mounted and inline repository HTML attempts self/parent/opener reads of `gateway.token`, local/session storage, IndexedDB, and parent DOM;
- it attempts the exact approval POST with `credentials: include` and, if it can obtain one, `Authorization: Bearer`;
- repeat for raw popout and active SVG;
- every active repository document remains opaque, API admission fails, approval remains pending, stdio marker remains absent, and remote request count remains zero.

Preserve relative CSS/image/classic+module JS/font/JSON, inline streaming/edit, live theme without authored rerun, SSE remount, artifacts, Unicode/base paths, durable restart, popout/reload, and hostile external-embed behavior across Chromium, Firefox, and WebKit.

### Exact verification commands

Run focused suites first:

```bash
npm run test:unit -- tests/unit/core/sandbox-guard.unit.test.ts tests/unit/core/browser-cookie-eligibility.unit.test.ts tests/unit/core/session-manager-sandbox-scope.unit.test.ts tests/unit/core/rpc-bridge-private-env.unit.test.ts
npm run test:unit -- tests/integration/gateway/direct-agent-admin-token.gateway.test.ts tests/integration/gateway/mcp-project-approval.gateway.test.ts tests/integration/gateway/mcp-approval-redaction.gateway.test.ts
npm run test:unit -- tests/dom/mcp-approval-viewer-push.dom.test.ts tests/browser/fixtures/tool-manager-mcp-section.fixture.spec.ts
npm run test:unit -- tests/unit/core/preview-cookie.unit.test.ts tests/unit/core/preview-content-route.unit.test.ts tests/unit/core/request-admission.unit.test.ts tests/dom/inline-html-renderer-lifecycle.dom.test.ts
npm run test:browser -- --grep "MCP project approval|MCP preview|preview compatibility"
```

Then run the required project checks:

```bash
npm run check
npm run test:unit
npm run test:browser
```

Acceptance is not merely green status: inspect that sandbox denial precedes body/ledger/runtime, obsolete credentials never authenticate, periodic banner state changes only from current confirmed responses, explicit invalidation clears affected cached state and fences older responses before refetch, normal gateway contexts all decide successfully, and hostile previews leave both local and remote MCP activity at zero.

## Explicitly rejected alternatives

### Retain terminal/browser pairing

Rejected because it contradicts the amended trust model. A direct non-sandbox agent intentionally holds the global admin credential and must have the same control as the human UI. Keeping pairing would add a second authority, verifier state, code lifecycle, endpoint/header/CORS surface, client storage, and form while denying an intentionally authorized caller.

### Explicit gateway principal/capability module

Viable but not selected. It names authority positively and can implement mixed-credential contamination, but adds state transformation and router/API surface without changing required behavior. The existing verified authentication plus default-deny sandbox guard is the smaller contract. Focused tests pin both seams directly.

### Mixed-credential downgrade

Rejected. If a request possesses a valid admin bearer or signed browser cookie, it has normal gateway authority even if a sandbox token also appears. Sandbox confinement relies on never giving sandbox processes that credential, preventing cookie mint/renewal with `hasSandboxCredential`, mandatory scoped-token minting, and reserved-token filtering—not on changing the semantics of an independently valid normal credential.

### Automatic server-verifier deletion

Rejected as unnecessary. Once the reader and route are removed, the file's ID/verifier is inert. Startup unlink introduces avoidable path identity, race, permission, and symlink handling. Browser storage cleanup is bounded and user-profile-local; server cleanup may be manual.

### CORS compatibility window for obsolete header

Rejected for the initial final contract. Keeping an ignored header can let a stale UI finish preflight, but prolongs dead API surface. Remove it immediately and require stale clients to refresh. `Authorization` and `Content-Type` already cover supported remote gateways.

### Server-rendered decision ceremony or new auth subsystem

Rejected. A per-decision page/claim/nonce/return flow violates the no-new-page requirement. WebAuthn/OIDC/user principals add registration, recovery, identity, secure-context, deployment, and policy concerns outside this trust gate. They are unnecessary when established admin authority is intentionally sufficient.

### Storage-only preview credential containment

Rejected as insecure. Moving a gateway bearer among browser storage mechanisms does not stop same-origin repository code from reading or spending it, and HttpOnly application cookies remain vulnerable to same-origin session riding. Isolate repository documents instead.

### Iframe-only, CSP-only, disabled scripts, anonymous mounts, or URL bearers

- Iframe-only misses raw popout/direct navigation and active SVG.
- CSP-only omits local defense at both embedding call sites.
- Disabling scripts breaks interactive preview compatibility.
- Anonymous mounts disclose repository/session artifacts.
- URL credentials leak through history, referrers, copied links, logs, and screenshots.

### Separate preview origin/listener

Credible but larger. It preserves the pairing-free Tools approval journey and isolates gateway authority, but requires a second listener/readiness/TLS/proxy lifecycle, claim handoff, credentialed claim CORS, public-origin propagation, client endpoint state, and inline bootstrap. Opaque-origin composition reaches the same boundary through established route/mount/render seams and gives stronger per-context storage isolation.

## Review checklist

- [x] Normal admin bearer, signed cookie, and peer-bound trusted-local requests can decide an exact current MCP definition.
- [x] Trusted-local authority requires both an all-loopback admitted policy and an actual IPv4 `127/8`, IPv6 `::1`, or IPv4-mapped loopback peer across API, preview/cookie bootstrap, and WebSocket paths; Host spoofing is insufficient.
- [x] Direct non-sandbox agents retain admin `BOBBIT_TOKEN` and may decide by design.
- [x] Sandbox agents receive only a server-minted scoped token; missing minting fails startup and configured credentials cannot override `BOBBIT_TOKEN`.
- [x] Sandbox approval requests are rejected before body, ledger, manager, spawn, or network activity, including from a loopback peer.
- [x] Credential-free trusted-local mode refuses sandbox creation, restoration, revival, respawn, replacement, and direct bootstrap before side effects and instructs the operator to restart with `--auth`.
- [x] No active pairing endpoint, header, authorizer, CLI output, browser module, Tools callout, CSS, error code, or test helper remains.
- [x] Obsolete browser storage is removed without touching gateway connection state; obsolete server verifier is ignored and never auto-migrated.
- [x] Every approval still validates project, cwd, source project, source ID, server name, and current fingerprint before atomic persistence/reload.
- [x] Pending/rejected/changed definitions remain inert; trusted/approved definitions preserve discovery precedence and runtime behavior.
- [x] Banner keeps last confirmed state and single-flight ownership during periodic refreshes, handles both zero transitions, and preserves explicit invalidation's revision bump, cache/request reset, prompt render/refetch, and stale-response discard.
- [x] No repository HTML iframe contains `allow-same-origin`.
- [x] Every successful preview content response, including SVG and HEAD, contains CSP sandbox without `allow-same-origin`.
- [x] Preview cookie is HttpOnly, Secure, SameSite=None, exact-path, purpose-separated, session-bound, and unusable for gateway API/MCP approval.
- [x] Null-origin admission is GET/HEAD preview-only and inner auth remains mandatory.
- [x] Generic API CORS remains non-credentialed and no obsolete operator header is allowed.
- [x] Theme, resize, and swipe use exact-frame bounded messaging without parent/contentDocument access.
- [x] Existing Tools → MCP review remains a single-page, individual-decision flow with no approve-all action.

## Final rationale

The approval trust gate and the gateway login boundary answer different questions. The trust gate determines whether a repository-supplied MCP definition may start; the established gateway credential determines who may make that control-plane decision. Under the amended product model, a direct agent intentionally holds the same admin credential as the UI operator, so a second terminal-paired browser secret is both semantically wrong and unnecessary.

The smallest robust design is subtraction plus narrow guards at the real boundaries. Pairing is gone, and an existing globally authenticated request reaches the exact, fail-closed decision handler. Confinement comes from mandatory scoped-token minting, case-insensitive `BOBBIT_TOKEN` reservation, the pre-handler default-deny sandbox guard, and peer-bound trusted-local admission. Because some Docker host-gateway proxies can erase container provenance, credential-free mode also refuses every sandbox startup/restoration/revival/respawn/replacement path before side effects and directs the operator to restart with `--auth`. This adds no principal, capability token, middleware, endpoint, or persistent authority.

Opaque preview isolation remains security-critical because a normal gateway cookie or stored admin bearer now authorizes decisions. Repository-authored content must not share the application origin that holds or spends those credentials. The selected iframe/CSP boundary, SID-scoped read cookie, narrow admission, and cosmetic message bridge remove that path without changing MCP identity, persistence, runtime, Tools UX, or deployment topology.

Finally, periodic banner stale-while-revalidate prevents the two-second reconciliation timer from flashing away confirmed pending state while keeping periodic reads single-flight. Explicit decision/configuration invalidation retains its distinct lifecycle: it increments the revision, clears cached count and request ownership, renders promptly, and lets a current fetch repopulate state while older responses are discarded. Together these choices preserve the original MCP trust architecture, align authority with the product decision, and minimize new defect surface.