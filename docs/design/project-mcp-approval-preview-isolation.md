# Design: project MCP approval with gateway authentication and opaque-origin previews

## Status and decisions

This is the full replacement design for explicit approval of project-defined MCP servers. It preserves the implemented discovery, provenance, fingerprinting, private persistence, runtime filtering, safe status, Tools review, banner, Marketplace, worktree, shared-owner, and opaque-preview architecture. It revises the approval authority after the product decision that direct, non-sandbox agents intentionally have human-equivalent gateway control.

Two decisions are selected:

1. **Use established gateway authentication for MCP decisions.** A request that has passed normal gateway admission and authentication through a signed `bobbit_session`, the admin bearer/query token, or trusted-local mode may approve or reject an exact current definition. Direct agents intentionally receive the admin `BOBBIT_TOKEN` and therefore may decide. Sandbox agents receive only sandbox-scoped tokens; `isSandboxAllowed()` default-denies the approval route before its body, ledger, or runtime can be touched.
2. **Keep every repository-authored preview browsing context opaque.** Embedded previews omit `allow-same-origin`, and every successful preview content response has a CSP `sandbox` directive without `allow-same-origin`. A session-bound preview resource cookie and bounded `postMessage` bridges preserve assets and cosmetic behavior without giving repository content gateway authority.

The removed terminal/browser pairing system is not replaced with another principal or capability subsystem. The approval route composes with the existing global gateway boundary and retains every project, cwd, source, fingerprint, ledger, and reload check. Approval remains a deliberate per-server action and remains separate from `Allow` / `Ask` / `Never` tool invocation policy.

## Source-validated findings

The revised decision was validated against the current implementation rather than inferred from the earlier design:

- `src/server/server.ts` admits requests first, verifies `bobbit_session`, then accepts an admin Bearer/query token or trusted localhost. A sandbox bearer resolves to `sandboxScope`; `isSandboxAllowed()` runs before `handleApiRoute()`.
- `src/server/auth/sandbox-guard.ts::isSandboxAllowed()` is an explicit allowlist and does not admit `POST /api/mcp-servers/:name/approval`.
- `src/app/gateway-fetch.ts::gatewayFetch()` supplies the configured gateway Bearer token and otherwise leaves Fetch credentials at the same-origin default, so remote configured gateways use the admin bearer and same-origin UI uses its signed cookie.
- `SessionManager.applyScopedGatewayCredentials()` and `scopedGatewayEnvForDirectAgent()` intentionally read and inject the admin token on direct create/delegate/restore/revive/respawn paths.
- `SessionManager.applySandboxWiring()` normally mints a scoped token, but currently contains a legacy/test `readToken()` fallback. That fallback must be removed before unified approval authority is safe.
- `RpcBridge.spawnDockerExec()` currently appends `sandboxCredentials` after its server-supplied `BOBBIT_TOKEN`; a case-insensitive credential named `BOBBIT_TOKEN` can therefore override the scoped token. The key must be reserved and filtered.
- `src/server/agent/docker-args.ts` correctly omits gateway URL/token from the sandbox container's PID 1. The scoped token is injected only into the session process with `docker exec -e`; this stays unchanged.
- The current approval handler verifies `X-Bobbit-Mcp-Operator`, and current server/CLI/browser/Tools code owns pairing state. Those branches are removed. The exact decision validation begins immediately afterward and remains intact.
- `src/app/mcp-approval-banner.ts` already has scope-keyed counts, one in-flight request per scope, periodic Tools reconciliation, and revision fencing. The remaining UX contract is stale-while-revalidate across invalidation as well: never erase a confirmed count merely because a refresh started.

### Consolidated finding matrix

| Finding | Corroboration | Consequence | Required design response |
|---|---|---|---|
| Separate pairing conflicts with the amended authority | Both gateway-auth explorations and the UX exploration | It denies a direct agent that intentionally holds the same admin credential as the operator and adds an unnecessary secret, endpoint, state owner, and UI ceremony. | Delete pairing end to end; established valid gateway authentication authorizes decisions. |
| Sandbox admin fallback | Both gateway-auth explorations; directly present in `SessionManager.applySandboxWiring()` | Missing `SandboxTokenStore` wiring can start a sandbox with the global admin token. | Scoped-token minting is mandatory; sandbox startup fails closed when it cannot mint one. |
| Sandbox credential override | Minimal-composition exploration; directly present in `RpcBridge.spawnDockerExec()` ordering | A configured `BOBBIT_TOKEN` can supersede the scoped token in the sandbox process. | Filter the reserved name case-insensitively and emit exactly the server-minted scoped token. |
| Pairing UI and client credential are obsolete | UX exploration plus both gateway-auth explorations | Keeping the form/header/storage errors would misstate authority and complicate normal remote/UI behavior. | Remove the callout, state, CSS, special header, endpoint, CLI code, and pairing errors with no replacement UI. |
| Stale browser credential remains after removal | Both gateway-auth explorations | `mcp.operator.credentials.v1` becomes inert but remains secret-shaped browser data. | Best-effort delete only that key during app boot; never touch `gateway.url` or `gateway.token`. |
| Server verifier cleanup has competing proposals | One exploration proposed best-effort unlink; the other identified filesystem race/symlink surface. | The file contains only an ID/verifier and is harmless once no reader exists. | Do not auto-delete `serverSecretsDir()/mcp-operator-authorization.json`; ignore it and document optional manual removal. |
| CORS compatibility has competing proposals | One exploration proposed a temporary ignored header; the minimal packet chose a clean contract. | A stale cached remote client may require refresh, but retaining a dead header prolongs obsolete surface. | Remove `X-Bobbit-Mcp-Operator` immediately from accepted CORS headers; `Authorization` and `Content-Type` remain sufficient. |
| Explicit principal/capability layer is viable | Alternate exploration supplied a pure classification module and positive capability check. | It makes authority named but adds a type/module/router parameter and changes mixed-credential semantics not required by the amended model. | Reject it for this change. The already-authenticated request is authority; sandbox safety is enforced by credential provenance plus the existing pre-handler guard. |
| Mixed normal and sandbox credentials | Alternate exploration proposed contaminating otherwise valid admin/cookie/local authentication. | That would downgrade a valid normal gateway credential solely because a sandbox token is also presented. | Reject the downgrade. Any winning valid normal gateway credential is authority under the amendment. Keep `hasSandboxCredential` for its current cookie bootstrap/renewal defense. |
| Pairing-era preview containment remains necessary | Preview-isolation comparison and current iframe/content-route code | Normal gateway authentication is broader than the retired pairing token. Same-origin repository code could spend stored Bearer or ambient cookie authority. | Preserve opaque iframe/CSP isolation, narrow preview resources, and exact-source cosmetic messaging. |
| Periodic pending banner can flicker | Banner task and existing count/revision seams | Clearing a confirmed count while reconciliation is unresolved hides a real pending state and remounts the banner. | Use stale-while-revalidate for periodic and event-driven reconciliation, with single flight and revision fencing. |

## Scope ledger

### Must deliver

- Fail-closed startup and connection approval for every runtime-effective MCP definition introduced by repository-controlled project sources.
- Provenance through the existing discovery cascade and stable logical project/source identity across worktrees.
- Headquarters-owned approval persistence keyed by project, source, server, and deterministic configuration fingerprint, with no raw secrets persisted or exposed.
- Pending/rejected/changed definitions retained in safe status output while excluded from process spawn, connection, initialization, tool discovery, route publication, and data exchange.
- Immediate, consistent reload after an exact current decision; disconnection on rejection, removal, invalidation, or behavior change.
- A compact pending banner and deliberate per-server review in the existing Tools → MCP section, with startup approval separate from tool invocation policy and runtime health.
- Established gateway-authenticated decision authority for browser UI, direct agents, remote configured gateways, and trusted-local mode; sandbox-scoped credentials remain denied.
- Fail-closed sandbox credential delivery: no admin fallback and no `BOBBIT_TOKEN` override through configured sandbox credentials.
- Opaque-origin execution for repository-authored inline HTML, mounted preview HTML, popouts/direct preview navigation, and active non-HTML documents such as SVG.
- Authenticated sibling preview resources without granting opaque preview code application/API authority.
- Message-based theme, resize, and swipe compatibility, with all messages cosmetic, source-checked, and bounded.
- Stale-while-revalidate banner behavior that preserves confirmed state until a current response replaces it.
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
2. `CookieStore.verify()` accepts a genuine signed `bobbit_session`.
3. Otherwise, outside trusted-local mode, `validateToken()` accepts the admin Bearer/query token or `SandboxTokenStore.lookup()` resolves a scoped sandbox token.
4. In trusted-local mode, an admitted local request is authenticated under the gateway's existing no-token contract.
5. If a sandbox token won, `sandboxScope` is passed through `isSandboxAllowed()` before route dispatch. MCP approval is not allowlisted, so the gateway returns 403 before handler body parsing, manager creation, ledger access, or reload.
6. A non-sandbox authenticated request reaches the existing MCP approval handler. The handler freshly resolves viewing project and execution cwd, validates source project, server, source ID, and fingerprint against the current effective definition, durably records the decision, and reloads every relevant manager.

There is no second per-route credential check. This is deliberate: under the amended model, the normal authenticated gateway caller is allowed to make control-plane decisions. Request admission is still a network/browser boundary, not proof of humanness.

### Authority matrix

| Authenticated context | May decide MCP startup | Reason |
|---|---:|---|
| Admin Bearer/query token | Yes | Existing gateway-wide control credential. |
| Genuine signed `bobbit_session` | Yes | Existing authenticated UI session. |
| Trusted-local request | Yes | Existing localhost-no-auth control contract; any admitted local process has this power. |
| Direct non-sandbox agent with `BOBBIT_TOKEN` | Yes | It intentionally receives the admin credential and has human-equivalent control. |
| Sandbox-scoped bearer | No | Resolves `sandboxScope`; default-deny route guard returns 403 before the handler. |
| Unauthenticated request | No | Global auth returns 401. |
| Obsolete `X-Bobbit-Mcp-Operator` alone | No | Header is removed from CORS and has no reader or authentication meaning. |
| Opaque preview resource cookie | No | Accepted only for GET/HEAD below its exact preview SID path. |

A valid normal credential is not downgraded merely because the request also contains a recognized sandbox token. This is consistent with the amended model: possession of an independently valid admin token or signed browser cookie is authority. `hasSandboxCredential` retains its narrower current purpose—preventing cookie bootstrap/renewal in a request that presents sandbox credentials—so a sandbox token cannot be converted into a browser cookie.

### Required sandbox hardening

`SessionManager.applySandboxWiring()` is the single decision point across sandbox create, delegate, restore, revive, and respawn. It must:

- require a registered project and initialized `SandboxTokenStore`;
- mint a scoped token with `mintScopedGatewayToken()` for the exact project/session and optional goal;
- throw before the runtime starts if minting is unavailable or fails;
- never call `readToken()` as a fallback;
- leave `bridgeOptions.gatewayToken` unset on failure.

`RpcBridge.spawnDockerExec()` must reserve `BOBBIT_TOKEN` case-insensitively when projecting `sandboxCredentials`. The final Docker exec environment contains exactly the server-minted scoped token. Preserve omission of `BOBBIT_TOKEN` and `BOBBIT_GATEWAY_URL` from PID 1, session-secret delivery only to the agent process, private-locator filtering, and current cwd/remap behavior.

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
8. Admin bearer, signed browser cookie, and trusted-local mode may authorize a decision. A sandbox-scoped token, preview resource cookie, obsolete operator header, Origin, or Fetch Metadata alone may not.
9. Sandbox startup cannot fall back to the admin token, and sandbox-configured credentials cannot replace the server-minted scoped `BOBBIT_TOKEN`.
10. Preview bridge messages carry cosmetic state only. Hosts identify the exact sending frame by `event.source`, validate a strict DTO, and clamp numeric values; `event.origin === "null"` is never identity.
11. Generic gateway API CORS remains `allowCredentials:false`. Any credentialed `Origin: null` projection is route-local to authenticated preview GET/HEAD resources and is never available to API, WebSocket, UI static, preflight escalation, or unsafe methods.
12. Pending-banner refresh never substitutes “unknown” for a last confirmed count. Only a current authoritative response changes visible count.

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
2. Once a count is confirmed, keep it while periodic or event-driven revalidation is unresolved. Never delete it merely to mark loading.
3. Allow both confirmed zero → pending and pending → zero transitions. Only a successful current response changes the confirmed count.
4. Keep at most one request in flight per exact scope. Timer ticks do not overlap a slow request.
5. Capture the scope revision at request start. Any authoritative invalidation increments the revision; a response from an older revision is discarded even if it resolves last.
6. Invalidation schedules/refires an immediate authoritative fetch for the current scope without trusting event-provided counts. It does not clear the prior confirmed count.
7. Scope changes never project the old scope's count into the new one. Each scope key retains its own fenced state.
8. Rejected-only rows do not count. The banner disappears only after a current response confirms no pending/changed rows.

This is stale-while-revalidate, not optimistic state. It prevents banner flashes and preserves urgency while still discovering filesystem changes on a continuously mounted Tools route that has no active session socket.

## Migration and compatibility

### Pairing removal

- Delete `src/server/auth/mcp-operator-authorizer.ts`, its construction/threading, `POST /api/mcp-operator/pair`, and the gateway's pairing-code hook.
- Delete CLI pairing-code creation/format/output. Normal startup URL, token banner, `--show-token`, auto-open, base-path, Vite, remote, and headless behavior stay unchanged.
- Delete `src/app/mcp-operator-auth.ts`. `decideMcpServerApproval()` sends only `Content-Type`; `gatewayFetch()` supplies existing connection auth.
- Remove pairing state, copy, form, focus/error handling, test IDs, and `.mcp-pairing-*` CSS from Tools.
- Remove `X-Bobbit-Mcp-Operator` from `API_CORS_ALLOWED_HEADERS` and from every request/response/test helper. A stale cached client must refresh to use the current contract.
- During app boot, call `safeRemoveItem("mcp.operator.credentials.v1")` best-effort. Do not parse, display, migrate, or attach the value, and do not alter `gateway.url` or `gateway.token`.
- Do not unlink `serverSecretsDir()/mcp-operator-authorization.json` automatically. With no importer, constructor, or route reading it, the ID/verifier is inert and grants nothing. Operators may remove it manually; leaving it has no security or runtime effect.
- Existing approval ledger decisions, fingerprint keys, and historical decisions remain valid. The retired pairing verifier is not approval state.

### Approval compatibility

- Existing project definitions without a ledger decision remain pending; no grandfathering.
- User/home, Headquarters/managed, and Marketplace sources remain pretrusted.
- Configuration changes produce `changed` and disconnect before reapproval.
- Direct agents may now approve by design. This is not presented as human-only behavior.
- A genuine signed browser cookie and trusted-local mode may decide under their existing contracts.
- Sandbox-only requests continue to receive a generic pre-handler 403. The obsolete-header-only case receives outer 401 because the header is not authentication.

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
- Trusted-local mode means any admitted local process can decide. This is an explicit trade-off of the established gateway mode.
- Direct-agent/admin-token compromise permits MCP decisions by design. Do not describe this as human-only protection.
- Non-loopback remote gateways require HTTPS for `Secure` preview cookies. Test Chromium, Firefox, and WebKit because opaque Fetch Metadata and cookie behavior vary.
- Vite, embedded, saved cross-origin, reverse-proxy, base-path, remote, and mobile operation retain current gateway/request-admission configuration. The new preview exception remains preview-route-only.

## Implementation-ready packet

### Change sequence

1. **Delete the obsolete authority subsystem.** Remove server authorizer construction/route/hook, CLI pairing lifecycle, browser credential owner/header, Tools pairing UI/CSS, and pairing errors/tests/helpers. Remove the special CORS header. Add bounded browser-storage cleanup; leave the inert server verifier unread.
2. **Harden sandbox credential delivery.** Remove `applySandboxWiring()`'s admin fallback and reserve `BOBBIT_TOKEN` case-insensitively in `spawnDockerExec()` sandbox credential projection. Pin direct admin continuity and sandbox startup failure.
3. **Compose approval with global auth.** Leave the approval handler behind existing auth and sandbox guard; retain all current scope/body/fingerprint/persistence/reload behavior. Add normal-admin, cookie, trusted-local, unauthenticated, obsolete-header, and real sandbox cases.
4. **Amend banner reconciliation.** Preserve last confirmed per-scope count across refresh/invalidation; single-flight requests, revision fencing, immediate invalidation refresh, periodic zero discovery, and both zero transitions.
5. **Preserve and verify MCP trust core.** Run provenance, fingerprint, redaction, store, runtime, remote no-request, worktree, Marketplace, shared-owner, and reload suites unchanged except auth helpers.
6. **Preserve preview isolation.** Keep iframe/CSP opacity, preview resource cookie/admission, bounded bridge, raw popout/SVG protection, and adapt the hostile journey to attempt normal gateway-auth approval rather than the removed operator header.
7. **Update journeys and support.** The canonical browser flow goes from banner directly to inline review, decides without pairing, survives reload, handles changed reapproval, and cleans up.

### Exact production file and symbol matrix

| File | Existing symbol/seam | Required change | Must not change |
|---|---|---|---|
| `src/server/server.ts` | global API auth/guard; `handleApiRoute()`; MCP pair and approval routes | Delete authorizer construction/threading/pair route/hook and approval special-header check. Leave approval behind existing auth + sandbox guard. | Project/cwd/source/fingerprint validation, ledger/reload, safe status, generic auth precedence. |
| `src/server/auth/mcp-operator-authorizer.ts` | Retired authorizer | Delete. | Approval ledger/key are unrelated and remain. |
| `src/server/cli.ts` | pairing format/start wrapper; normal gateway startup | Delete pairing code creation/output and start directly. | Normal token/startup URL, auto-open, Vite/base-path/remote behavior. |
| `src/server/cors.ts` | `API_CORS_ALLOWED_HEADERS` | Remove `X-Bobbit-Mcp-Operator`. | `Authorization`, `Content-Type`, finite origins, non-credentialed generic CORS. |
| `src/server/agent/session-manager.ts` | `applySandboxWiring()`, `mintScopedGatewayToken()`, direct credential helpers | Require sandbox scoped token; remove `readToken()` fallback. Keep direct admin injection. | Create/delegate/restore/revive/respawn lifecycle and sandbox worktree ownership. |
| `src/server/agent/rpc-bridge.ts` | `spawnDockerExec()` environment projection | Reject/skip sandbox credential key `BOBBIT_TOKEN` case-insensitively; emit one scoped token. | PID-1 omission, session secret, cwd/remap/private-env behavior. |
| `src/app/mcp-operator-auth.ts` | Retired browser credential owner | Delete. | Gateway connection storage remains in `gateway-fetch.ts`. |
| `src/app/api.ts` | `decideMcpServerApproval()` | Remove special header/import/forget branch; use normal `gatewayFetch()`. | Exact request body/scope and response/stale parsing. |
| `src/app/tool-manager-page.ts` | pairing helpers/state/callout; decision rows | Delete pairing-only code; preserve direct per-row decision lifecycle. | Safe review, confirmation, stale refresh, focus/live regions, policy separation. |
| `src/app/tool-manager.css` | `.mcp-pairing-*` | Delete pairing-only rules/selectors. | Existing MCP row/responsive/accessibility styling. |
| `src/app/main.ts`, `src/app/safe-storage.ts` | app boot; `safeRemoveItem()` | Best-effort remove only `mcp.operator.credentials.v1`. | `gateway.url`, `gateway.token`, boot/auth flow. |
| `src/app/mcp-approval-banner.ts` | confirmed count/request/revision maps; periodic timer/invalidation | Preserve confirmed count while revalidating; immediate invalidation fetch, no overlap, revision discard, zero transitions. | Scope resolution, Review servers navigation/focus, rejected exclusion. |
| `src/server/preview/content-route.ts` | `handlePreviewRequest()`, `isAuthorized()` | Preserve scoped cookie follow-ons, common sandbox CSP, post-auth null-origin CORS. | Entry/artifact/path/read-lease/base/no-store behavior. |
| `src/server/auth/cookie.ts` | `CookieStore` and preview helpers | Preserve domain-separated SID-bound preview format/path. | Generic `bobbit_session` format and browser auth. |
| `src/server/request-admission.ts` | preview context classification and CORS projection | Preserve exact opaque GET/HEAD exception. | API/UI/WS/preflight policy and generic non-credentialed CORS. |
| `src/app/render.ts` | mounted iframe/popout/swipe | Preserve exact `allow-scripts`, frame registration, source-checked swipe, raw query-free popout. | Panel/SSE/restore/navigation behavior. |
| `src/ui/tools/renderers/HtmlRenderer.ts` | inline iframe/stream/resize | Preserve opaque `srcdoc`, message resize, debounce and cleanup. | 600px cap, 1.5s debounce, stable completion/EditRenderer behavior. |
| `src/ui/tools/renderers/prepare-inline-html.ts`, `src/shared/preview-bridge-scripts.ts`, `src/ui/preview-frame-host.ts` | prepared content and bridge | Preserve bounded source-bound theme/resize protocol. | No security authority, fetch, storage, or navigation responsibility. |

### Existing protections to compose

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
3. Trusted-local mode approves under its no-token contract.
4. Missing auth is 401; obsolete `X-Bobbit-Mcp-Operator` alone is 401 and cannot affect ledger/runtime.
5. A real sandbox-scoped token is 403 before body parsing, manager creation, ledger mutation, process spawn, or remote request.
6. `isSandboxAllowed('/api/mcp-servers/name/approval', 'POST', scope)` remains false.
7. Sandbox wiring without a `SandboxTokenStore` or minted token throws and never reads/injects admin.
8. A sandbox credential named any casing of `BOBBIT_TOKEN` cannot override the server-minted scoped value; Docker exec contains exactly the scoped token and no admin sentinel.
9. Direct create/delegate/restore/revive/respawn still receive the admin token.
10. Existing `hasSandboxCredential` cases continue to deny cookie bootstrap/renewal when a recognized sandbox credential is presented.

### Pairing removal and UX

1. Delete authorizer and browser credential unit/DOM suites; no pair route, CLI code, gateway hook, callout, CSS, test ID, special header, or `MCP_APPROVAL_HUMAN_REQUIRED` remains.
2. Seed `mcp.operator.credentials.v1`; app boot removes it without changing the active gateway URL/token.
3. Seed the old server verifier; startup ignores it, obsolete header cannot authorize, and normal admin auth still can.
4. Standard `Authorization`/`Content-Type` remote preflight remains allowed with `allowCredentials:false`; the obsolete header is absent from the allowlist.
5. Tools opens directly to server rows. Each exact row retains safe review, individual actions, interruption confirmation, `Working…`, stale refresh/no replay, focus restoration, and announcements.
6. Canonical browser journey: pending banner → Review servers → inline safe review → reject one/approve one → runtime update → hard reload durability → changed configuration returns to review → approve current fingerprint → cleanup. No pairing step or approve-all.

### Banner reconciliation

1. A confirmed pending banner stays the same mounted element throughout a deferred periodic refresh.
2. Slow periodic requests never overlap later timer ticks.
3. Confirmed zero becomes pending after a current response; confirmed pending becomes zero only after a current response.
4. Invalidation prompts an immediate fetch but preserves the last confirmed count while unresolved.
5. A response from an older revision cannot replace a newer result, including after scope changes.
6. Authoritative decision/configuration events update promptly without trusting payload counts.

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

Acceptance is not merely green status: inspect that sandbox denial precedes body/ledger/runtime, obsolete credentials never authenticate, banner state changes only from current confirmed responses, normal gateway contexts all decide successfully, and hostile previews leave both local and remote MCP activity at zero.

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

- [ ] Normal admin bearer, signed cookie, and trusted-local requests can decide an exact current MCP definition.
- [ ] Direct non-sandbox agents retain admin `BOBBIT_TOKEN` and may decide by design.
- [ ] Sandbox agents receive only a server-minted scoped token; missing minting fails startup and configured credentials cannot override `BOBBIT_TOKEN`.
- [ ] Sandbox approval requests are rejected before body, ledger, manager, spawn, or network activity.
- [ ] No active pairing endpoint, header, authorizer, CLI output, browser module, Tools callout, CSS, error code, or test helper remains.
- [ ] Obsolete browser storage is removed without touching gateway connection state; obsolete server verifier is ignored and never auto-migrated.
- [ ] Every approval still validates project, cwd, source project, source ID, server name, and current fingerprint before atomic persistence/reload.
- [ ] Pending/rejected/changed definitions remain inert; trusted/approved definitions preserve discovery precedence and runtime behavior.
- [ ] Banner keeps last confirmed state while refreshing, single-flights, handles both zero transitions, and discards stale revisions.
- [ ] No repository HTML iframe contains `allow-same-origin`.
- [ ] Every successful preview content response, including SVG and HEAD, contains CSP sandbox without `allow-same-origin`.
- [ ] Preview cookie is HttpOnly, Secure, SameSite=None, exact-path, purpose-separated, session-bound, and unusable for gateway API/MCP approval.
- [ ] Null-origin admission is GET/HEAD preview-only and inner auth remains mandatory.
- [ ] Generic API CORS remains non-credentialed and no obsolete operator header is allowed.
- [ ] Theme, resize, and swipe use exact-frame bounded messaging without parent/contentDocument access.
- [ ] Existing Tools → MCP review remains a single-page, individual-decision flow with no approve-all action.

## Final rationale

The approval trust gate and the gateway login boundary answer different questions. The trust gate determines whether a repository-supplied MCP definition may start; the established gateway credential determines who may make that control-plane decision. Under the amended product model, a direct agent intentionally holds the same admin credential as the UI operator, so a second terminal-paired browser secret is both semantically wrong and unnecessary.

The smallest robust design is subtraction plus two concrete sandbox fixes. Delete pairing and let the existing globally authenticated request reach the already exact, fail-closed decision handler. Preserve confinement by requiring scoped-token minting for every sandbox runtime, blocking configured `BOBBIT_TOKEN` override, and relying on the existing pre-handler default-deny guard. This adds no principal, capability token, middleware, endpoint, or persistent authority.

Opaque preview isolation remains security-critical because a normal gateway cookie or stored admin bearer now authorizes decisions. Repository-authored content must not share the application origin that holds or spends those credentials. The selected iframe/CSP boundary, SID-scoped read cookie, narrow admission, and cosmetic message bridge remove that path without changing MCP identity, persistence, runtime, Tools UX, or deployment topology.

Finally, banner stale-while-revalidate makes the management surface truthful during uncertainty: confirmed pending state stays visible until a current response replaces it, while revision fencing and single-flight requests prevent stale or overlapping refreshes. Together these choices preserve the original MCP trust architecture, align authority with the product decision, and minimize new defect surface.