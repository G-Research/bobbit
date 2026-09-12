# Design: project MCP approval with opaque-origin previews

## Status and decision

This is the full replacement design for explicit approval of project-defined MCP servers. It preserves the approved discovery, provenance, fingerprinting, persistence, runtime, API, operator-pairing, Tools, banner, migration, and verification design. It revises one security assumption exposed by the Greptile P1: repository-authored preview documents are part of the repository threat boundary, not trusted same-origin application code.

**Selected revision:** every repository-authored preview browsing context is an opaque-origin sandbox. Embedded previews receive an iframe `sandbox` attribute without `allow-same-origin`; every successful preview content response also receives a CSP `sandbox` directive without `allow-same-origin`. Session-bound, path-scoped preview resource authorization and bounded `postMessage` bridges preserve assets, theme, resize, and swipe behavior without restoring application-origin authority.

**Rejected revision:** a server-rendered approval ceremony. It would move every decision through a new top-level claim/review/confirmation/return journey. That violates the explicit no-new-page UX constraint and adds substantially more state, routes, navigation, expiry, recovery, and platform defect surface than isolating the untrusted content at its existing execution boundary.

## Scope ledger

### Must deliver

- Fail-closed startup and connection approval for every runtime-effective MCP definition introduced by repository-controlled project sources.
- Provenance through the existing discovery cascade and stable logical project/source identity across worktrees.
- Headquarters-owned approval persistence keyed by project, source, server, and deterministic configuration fingerprint, with no raw secrets persisted or exposed.
- Pending/rejected/changed definitions retained in safe status output while excluded from process spawn, connection, initialization, tool discovery, route publication, and data exchange.
- Immediate, consistent reload after an exact current decision; disconnection on rejection, removal, invalidation, or behavior change.
- A compact pending banner and deliberate per-server review in the existing Tools → MCP section, with startup approval separate from tool invocation policy and runtime health.
- Human-only MCP decision authority through the already-approved terminal-to-browser pairing capability, separate from generic bearer/cookie/session authority.
- Opaque-origin execution for repository-authored inline HTML, mounted preview HTML, popouts/direct preview navigation, and active non-HTML documents such as SVG.
- Authenticated sibling preview resources without granting opaque preview code application/API authority.
- Message-based theme, resize, and swipe compatibility, with all messages cosmetic, source-checked, and bounded.
- Documentation plus focused unit, DOM, integration, browser, multi-project, worktree, and cross-browser coverage.

### Allowed bounded improvements

- Fix existing Tools scope refresh so MCP data cannot remain from a previous project.
- Render the MCP section when pending/rejected servers have no registered tools.
- Correct existing MCP disclosure button/select structure where required by approval controls.
- Add one purpose- and session-bound preview resource cookie to the existing `CookieStore`.
- Add one shared preview-frame host helper for theme, resize, and swipe messaging.
- Narrow request admission and route-local CORS only for authenticated opaque-origin preview GET/HEAD resource loads.

### Deferred or out of scope

- A new Settings route, approval route, modal, or server-rendered decision page.
- Blanket approve-all or whole-repository trust.
- Changing `Allow` / `Ask` / `Never` semantics.
- Marketplace reapproval, general identity replacement, OAuth/OIDC, WebAuthn, device lists, or broad credential management.
- A new MCP runtime coordinator or per-worktree live manager proliferation.
- Making repository preview JavaScript network-inert or safe to trust with application data.
- Same-origin compromise of trusted Bobbit application code, browser-profile/extensions compromise, Marketplace UI-package compromise, or same-UID host compromise.

## Root-cause finding matrix

| Finding source | Independently established path | Security consequence | Design conclusion |
|---|---|---|---|
| Greptile P1 | Repository-authored preview HTML executes scripts with same-origin privileges while the MCP operator credential is stored for the gateway origin. | Preview code can read the operator bearer and submit the exact MCP approval mutation, turning repository content into its own approver. | The operator pairing design is incomplete unless intentionally executed repository content is isolated from the app origin. |
| Preview-isolation exploration (`7839b36a`) | `src/app/render.ts::htmlPreviewContent()` embeds gateway-served `/preview/...` using `sandbox="allow-scripts allow-same-origin"`; `src/ui/tools/renderers/HtmlRenderer.ts::render()` does the same for `srcdoc`; `sidePanelPopoutButton()` opens the raw route with no iframe sandbox. | Both embedded surfaces can read gateway storage; popout/direct navigation bypasses an iframe-only fix. Active SVG can execute as a document if the response lacks an origin sandbox. | Use two layers: restrictive iframe attributes and a response CSP sandbox on all successful preview content, including non-HTML. Preserve resources with narrowly scoped preview-only auth. |
| Credential-containment exploration (`767eff8d`) | Moving the bearer to sessionStorage, IndexedDB, WebCrypto, a worker, or an ambient HttpOnly cookie does not stop same-origin content from exercising the authority. A robust alternative requires a server-owned claim and per-decision navigation ceremony. | Pure storage changes are insufficient. The ceremony can resist preview session riding, but requires new claim, intent, nonce, page, redirect, activation, TTL, recovery, and embedded/mobile flows. | Reject storage-only containment as insecure. Reject the complete ceremony because it violates no-new-page UX and adds greater defect surface. Isolate repository preview origins instead. |

The matrix revises the earlier statement that “same-origin XSS/browser-profile compromise is out of scope.” Generic compromise of trusted application code remains out of scope. Repository previews are deliberately executed untrusted repository bytes, so their same-origin privilege is directly inside this goal's repository trust boundary and must be removed.

## Security invariants

1. A repository-controlled definition cannot execute or connect before an exact approval of its current effective configuration.
2. A repository-controlled preview cannot read application local/session storage, IndexedDB, service-worker state, parent DOM, application cookies, or the MCP operator credential.
3. A repository-controlled preview cannot make an authenticated application/API request merely because it is rendered by Bobbit. The preview-only cookie is accepted only for GET/HEAD below its exact session preview mount.
4. Removing an iframe's `allow-same-origin` is necessary but insufficient. Raw popouts, direct preview URLs, and active non-HTML documents receive the same opaque-origin boundary from response CSP.
5. MCP startup approval, operator authorization, runtime health, and `Allow` / `Ask` / `Never` remain independent concepts.
6. Approval identity is bound to stable registered-project identity, logical source identity, server name, and all behavior-relevant configuration through an opaque fingerprint.
7. Pending, rejected, changed, invalid, removed, or source-mismatched definitions cannot spawn, connect, initialize, publish tools/routes, or receive MCP calls.
8. Generic admin bearer, `BOBBIT_TOKEN`, `bobbit_session`, localhost trust, Origin, Fetch Metadata, sandbox/session credentials, and preview resource credentials cannot authorize an MCP decision.
9. Preview bridge messages carry cosmetic state only. Hosts identify the exact sending frame by `event.source`, validate a strict DTO, and clamp numeric values; `event.origin === "null"` is never identity.
10. Generic gateway API CORS remains `allowCredentials:false`. Any credentialed `Origin: null` projection is route-local to authenticated preview GET/HEAD resources and is never available to API, WebSocket, UI-static, preflight escalation, or unsafe methods.

## Preserved MCP approval architecture

### 1. Provenance-bearing discovery with unchanged precedence

Keep `src/server/mcp/mcp-manager.ts::McpManager` as the single owner of discovery, precedence, connection lifecycle, external tool routes, health, and reload single-flight. Enrich the existing resolved origin/group records rather than introduce a second catalogue:

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

Preserve the ordered `Map.set(serverName, candidate)` precedence. Resolve the complete cascade before approval classification. A higher-precedence pending, rejected, changed, or invalid project winner blocks fallback to a lower trusted candidate of the same name.

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

Use HMAC-SHA-256 with a Headquarters-owned random key stored beside the ledger. Persist only schema, project/source/server identity, opaque fingerprint, decision, and timestamps. Store the ledger and key under Headquarters state, outside repositories. Use same-directory unique temp files, flushed writes, atomic rename, serialized mutations, and publish memory only after durable rename. Missing/corrupt keys invalidate decisions safely; persistence failure leaves memory and runtime unchanged.

Classification remains exact:

- pretrusted source → `trusted`;
- exact approved row → `approved`;
- exact rejected row → `rejected`;
- history for project/source/server but no exact fingerprint → `changed`;
- no history → `pending`.

Keep exact historical rows so removal and exact reintroduction may reuse the decision. Approve/reject is reversible; the last serialized decision for the exact tuple wins.

Review metadata is always projected live by the server. Reuse/export `redactMcpServerConfig`, `redactRecord`, and `redactUrl`. Environment/header values are `[redacted]`; URL userinfo/query/fragment are absent. Command and ordinary arguments remain visible for deliberate execution review, while values associated with credential-like flags or equal to configured secret values are redacted. UI code never receives raw definitions.

### 3. Runtime eligibility and lifecycle

All startup paths continue to converge through `McpManager.connectAll()` → `reloadDiscoveredServers()` → `_reloadDiscoveredServers()` → gated connection → `McpClient.connect()`.

`discoverConnectionGroups()` retains every effective winner in `discoveredConnectionGroups`, including pending/rejected/changed/invalid definitions. Inside `_reloadDiscoveredServers()`:

1. Rediscover and validate the complete effective set.
2. Classify each final winner.
3. Disconnect any active runtime whose winner is absent, invalid, pending, rejected, changed, source-mismatched, or fingerprint-mismatched; remove clients, runtime configs, operations, routes, and generated registration state while preserving discovered review metadata.
4. Retain an unchanged runtime only for the same valid trusted/exact-approved winner.
5. Only valid trusted/exact-approved winners may reach the private/gated connect helper.
6. Recheck eligibility after `client.connect()` and immediately before tool/route publication so a concurrent decision or file change cannot publish stale authority.
7. Refresh external MCP registrations after reconcile. `/api/internal/mcp-call` always resolves the current live manager and fails closed even if an older agent still displays a stale meta-tool.

Validate exactly one supported local-command or HTTP(S)-URL shape before approval and connection. Invalid definitions expose `MCP_CONFIG_INVALID` safely and cannot be approved.

`disconnectServer()` preserves discovery when used for eligibility cleanup. `POST /api/mcp-servers/:name/restart` calls `restartDiscoveredServer(name)`, which queues full rediscovery/reconciliation and cannot bypass approval.

`SessionManager` constructs one shared approval store and injects it into all managers. `SessionManager.decideMcpApproval()` owns exact current-winner validation, atomic decision publication, all-relevant-manager reload, external-registration refresh, and safe event broadcast. Approval/project/Marketplace mutations reload immediately. One process-wide unref'd bounded reconciliation timer detects external edits/removals without per-source watcher topology.

### 4. Status and decision API

`McpServerStatus` and `src/app/api.ts::McpServerInfo` retain separate approval, source, safe review, diagnostic, and health data. `getServerStatuses()` iterates effective discovered winners plus defensive active-only leftovers, not only runtime configs. Pending/rejected/changed report health `disconnected`, zero tools, no connection error, and informational diagnostics such as `MCP_APPROVAL_PENDING`, `MCP_APPROVAL_REJECTED`, and `MCP_APPROVAL_CHANGED`.

`GET /api/mcp-servers?projectId=...&ensure=true` uses existing project-scope resolution, reconciles safely, and returns pending/rejected/changed/invalid winners even when no operations exist.

The mutation remains:

```http
POST /api/mcp-servers/:name/approval?projectId=<view-project>
X-Bobbit-Mcp-Operator: v1.<credential-id>.<secret>

{
  "decision": "approved|rejected",
  "fingerprint": "...",
  "sourceProjectId": "...",
  "sourceId": "..."
}
```

The route verifies the MCP operator credential before parsing or entering any decision/reload path. It then validates viewing scope, source-project existence, and the exact server/source/fingerprint as the current runtime-effective approval-required winner. Removed, shadowed, or changed requests return `409 MCP_APPROVAL_STALE` with fresh safe metadata; trusted or non-reviewable rows return 422. Persistence precedes reload; response is the current safe status. Old decisions are never retried automatically.

A safe `mcp_approvals_changed` event contains only affected project IDs and pending counts. Tabs refetch authoritative state; configuration and fingerprints are not broadcast.

### 5. Existing Tools and banner UX

No page, navigation item, modal, or approve-all action is added. `src/app/mcp-approval-banner.ts` owns only per-project pending-count cache/invalidation. It resolves the current logical project from route/session, goal, then active-project fallback. It renders only for pending/changed, not rejected, with a `Review servers` action that selects the project scope, navigates to existing `#/tools`, expands, and focuses the first review-needed row.

`src/app/tool-manager-page.ts::renderMcpSection()` renders rows even when no tools exist. Header copy explains that startup can run a command/contact a service and that tool invocation policy is separate. Each row shows startup approval and runtime health independently:

- startup: `Pending approval`, `Approved`, `Rejected`, `Configuration changed — review again`;
- runtime: `Not started`, `Connecting…`, `Connected`, `Disconnected`, `Error`.

Pending/rejected/changed always show `Not started`, never `Error`. `Tool calls:` labels the independent `Allow` / `Ask` / `Never` control.

The inline review panel shows introducing project, logical source file, transport, redacted command/arguments or URL, working directory, redacted environment/header names, and a short fingerprint. Actions are deliberate per server: pending can Reject/Approve; changed and rejected can approve the current configuration; approved can reject with interruption confirmation. Lock only the affected row, do not update optimistically, keep focus/expansion after refresh, and present stale/current configuration errors inline.

Responsive behavior remains inline: at 768px summaries and controls wrap; at 480px decision actions stack with Approve last; touch targets remain at least 44px.

## Preserved human-only operator pairing

`src/server/auth/mcp-operator-authorizer.ts::McpOperatorAuthorizer` remains the sole operator authority owner. After gateway start, `src/server/cli.ts` prints a 32-random-byte, one-use, ten-minute pairing code only to the controlling terminal. The code is not persisted or placed in URLs, environment, state/status, WebSocket payloads, logs, DOM, telemetry, or agent contexts.

`POST /api/mcp-operator/pair` requires normal request admission plus the live terminal code. Serialized exchange allows exactly one winner; invalid guesses do not consume a valid code; rate limiting is defense in depth. It returns `v1.<128-bit id>.<256-bit secret>` with `Cache-Control: no-store`. The server persists only a domain-separated verifier at `serverSecretsDir()/mcp-operator-authorization.json` using owner-only permissions and atomic publication. Re-pairing rotates the singleton credential. Restart reloads the verifier but destroys unused codes.

`src/app/mcp-operator-auth.ts` stores credentials under `mcp.operator.credentials.v1`, keyed by normalized active gateway base URL. It exposes the approval header only to `src/app/api.ts::decideMcpServerApproval()`; `gatewayFetch()` never adds it globally. Pairing performs no approval. Missing/invalid authority keeps the row expanded and focuses the inline pairing callout in Tools. Generic cookie/bearer/local credentials are never fallback authority.

Direct and sandbox agent environment construction must never receive the code, raw credential, verifier, approval header, or storage value. The opaque-preview revision protects that browser-stored credential from intentionally executed repository documents without changing its wire or persistence contract.

## Selected preview-origin architecture

### 1. Two-layer browsing-context isolation

#### Embedded iframe layer

Change all repository HTML iframe sites to `sandbox="allow-scripts"` and omit `allow-same-origin`:

- `src/app/render.ts::htmlPreviewContent()` for the mounted side-panel preview;
- both completed and streaming iframe branches in `src/ui/tools/renderers/HtmlRenderer.ts::render()` for inline `srcdoc` previews.

Scripts remain enabled for preview fidelity, but the document receives a unique opaque origin. Do not add `allow-popups-to-escape-sandbox`, `allow-storage-access-by-user-activation`, or unrestricted top navigation.

#### Response CSP layer

In `src/server/preview/content-route.ts::handlePreviewRequest()`, add a `Content-Security-Policy` header to every successful content response, HTML and non-HTML, GET and HEAD:

```text
sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-top-navigation-by-user-activation; frame-ancestors 'self'
```

The security-critical property is the absent `allow-same-origin`. For embedded documents, CSP and iframe restrictions intersect, so the iframe's stricter `allow-scripts` policy wins. For popout/direct navigation, CSP supplies the otherwise-missing sandbox while preserving reasonable standalone interactions. `frame-ancestors 'self'` prevents hostile third-party framing.

Apply the policy at the common successful-response header builder, including streamed content, so an active SVG document cannot regain the gateway origin. Redirect and error responses disclose no content and need not mint resource authority; they remain `no-store`.

This redundancy is intentional. The iframe attribute protects ordinary embedding even if route headers regress. The response CSP protects `sidePanelPopoutButton()`, copied/direct `/preview/...` URLs, alternate entry documents, and active non-HTML types that bypass element attributes.

### 2. Session-bound preview resource cookie

Opaque-origin documents request relative assets as cross-site contexts and may send `Origin: null` for module scripts, fonts, or authored fetch. The generic Lax `bobbit_session` cookie is not a reliable or appropriately narrow resource credential.

Extend `src/server/auth/cookie.ts::CookieStore` with domain-separated preview capability helpers, with final names chosen consistently in implementation:

```ts
mintPreview(sessionId: string): string;
verifyPreview(value: string, sessionId: string): CookieVerification | undefined;
issuePreviewCookie(res, store, sessionId, { basePath }): string;
tryPreviewAuth(req, store, sessionId): boolean;
```

Properties:

- distinct cookie name and signing domain/version from `bobbit_session`;
- signed payload bound to the exact preview session ID;
- `HttpOnly; SameSite=None; Secure`;
- exact path `<basePath>/preview/<sessionId>/`;
- bounded lifetime and renewal using the existing injectable clock conventions;
- never readable by preview script;
- never accepted by `/api`, UI static, SSE outside the mount, WebSocket, MCP/operator routes, another session ID, or a sibling gateway base path.

Refactor `content-route.ts::isAuthorized()` only enough to validate and bind the session ID before authorization. Initial preview navigation still requires existing admitted localhost/admin/generic-cookie authority. A successfully authenticated initial document response issues or refreshes the scoped preview cookie. Follow-on resource requests may instead use the exact session-bound preview cookie. Failed auth, malformed IDs, missing mounts, and error responses do not mint it.

The preview cookie is a read-only resource capability, not application identity. It authorizes only GET/HEAD of already path-guarded content under one mounted preview session. Artifact paths under that session deliberately share the binding. Project content cannot use it to approve MCP, call APIs, open SSE, or access another session.

Do not place credentials in query/hash URLs, make `/preview` anonymous, widen the generic session cookie to `SameSite=None`, or accept the preview cookie in generic authentication helpers.

### 3. Narrow opaque-resource request admission and CORS

`src/server/request-admission.ts::classifyContext()` already distinguishes `preview-document`, `preview-iframe`, and `preview-resource`. Extend `admitRequest()` with one exact exception after normal Host/path parsing:

- route context is a preview follow-on (`preview-resource`, plus the required opaque iframe-navigation shape during redirects);
- method is GET or HEAD;
- `Origin` is exactly serialized `null` or absent in a coherent cross-site subresource request;
- Fetch Metadata is coherent for its declared resource destination;
- no preflight escalation, unsafe method, WebSocket transport, or API/UI-static route is involved.

Inner `content-route.ts` preview-cookie verification remains mandatory. Admission alone is never authorization. Duplicate/malformed Origin or Fetch Metadata continues to fail closed.

For a null-origin request that needs CORS to consume a module, font, or authored same-mount JSON response, the preview route may project only:

```text
Access-Control-Allow-Origin: null
Access-Control-Allow-Credentials: true
Vary: Origin
```

and only after exact preview route/auth checks for GET/HEAD. It does not create a general preflight path. Generic `simpleCors()` and every API/browser transport remain `allowCredentials:false`; `X-Bobbit-Mcp-Operator` stays purpose-bound to the existing admitted approval request.

Initial third-party embedding remains denied. A raw `Origin: null` request without the exact preview capability does not disclose bytes. `frame-ancestors 'self'` remains defense in depth against hostile embedding.

### 4. Message-based theme compatibility

`src/shared/preview-bridge-scripts.ts::PREVIEW_THEME_BRIDGE` must stop dereferencing `parent.document`. Replace it with an idempotent child bridge that:

1. applies an optional server/srcdoc-injected initial cosmetic theme DTO before authored script execution where possible;
2. posts `{type: "bobbit-preview-ready", version: 1}` to `parent` when embedded;
3. listens only to `message` events where `event.source === parent`;
4. accepts only a strict versioned DTO containing a boolean dark mode, bounded palette/font strings, and an allowlisted map of CSS custom-property names beginning with `--` to bounded string values;
5. applies accepted values to the preview root without evaluating HTML/script/URLs.

Add `src/ui/preview-frame-host.ts` as the one browser host helper used by `render.ts` and `HtmlRenderer`. It enumerates the same Bobbit theme custom properties the current bridge mirrors, snapshots computed values/font/class/palette, sends the DTO to the exact iframe `contentWindow` with target origin `"*"` (opaque origins cannot be named), and resends after the existing root class/palette/style mutation observer fires.

The host accepts readiness only when `event.source` matches a registered current iframe `contentWindow`. It never treats `origin: "null"` as sufficient. Standalone CSP-sandboxed preview documents have no Bobbit parent and use `src/server/preview/theme-snapshot.ts::getPreviewThemeSnapshot()` as their initial/fallback theme.

For inline cards, extend `src/ui/tools/renderers/prepare-inline-html.ts::prepareInlineHtml()` to inject the initial theme/bootstrap before authored scripts. Include stable theme/bootstrap identity in its bounded cache key. Live theme changes use messages and must not recreate the iframe or rerun authored initialization.

### 5. Message-based resize and streaming

`HtmlRenderer::_autoResize()` can no longer read `iframe.contentDocument`. Add a small child `ResizeObserver` bridge that posts a versioned height update. The host accepts it only from a currently registered inline iframe, requires a finite number, and clamps to the existing maximum of 600px and a sensible nonzero minimum. Side-panel frames cannot resize inline cards.

`HtmlRenderer::_writeToIframe()` can no longer use `document.open/write/close`. Assign prepared content to `iframe.srcdoc` after the existing 1.5-second debounce and preserve last-content suppression. Clean up host registration, observers, and pending timers whenever the renderer/iframe is replaced or disconnected. Completed and streaming branches share the same preparation and frame-registration path.

### 6. Message-based swipe

Keep the child `PREVIEW_SWIPE_SCRIPT`, but change `src/app/render.ts::setupPreviewSwipe()` to accept `preview-swipe-start`, `preview-swipe-move`, and `preview-swipe-end` only when `event.source` is the active side-panel preview iframe's current `contentWindow`. Validate the exact message shape, require finite deltas, and clamp values before driving the slider. Ignore inline, stale, hidden, detached, and foreign frames.

Swipe messages are user-interface hints, not authority. Authored content can forge messages from its own frame, so they must never mutate security state or navigate privileged routes.

## Raw popout and active-document coverage

`src/app/render.ts::sidePanelPopoutButton()` may keep opening the canonical, query-free preview URL. The response CSP makes the opened document opaque even though no iframe attribute exists. No operator credential, gateway bearer, or preview capability appears in the URL, history, referrer, DOM, or page-visible storage.

All successful preview MIME responses receive the sandbox CSP. This specifically covers SVG opened directly or selected as the active preview document. Passive use of SVG/images/styles remains functional subject to ordinary browser rules, while active document execution has an opaque origin. `X-Content-Type-Options: nosniff`, path traversal defenses, mount read leases, base-path rewriting, artifact addressing, and `Cache-Control: no-store` remain unchanged.

A direct malicious popout may attempt `fetch('/api/...')`; the browser supplies `Origin: null`, request admission denies the API request, and the preview resource cookie is path-scoped and unusable there. Even where localhost requests otherwise have broad network reach, operator verification independently rejects approval without the unreadable header credential.

## Migration, compatibility, and failure behavior

### Approval migration

- Existing project definitions without a ledger decision become pending; no grandfathering.
- Existing exact approval-ledger decisions remain valid.
- User/home, Headquarters/managed, and Marketplace sources remain pretrusted.
- Existing generic cookies immediately remain non-authoritative for MCP decisions; operator pairing stays required.
- Configuration changes produce `changed` and disconnect before any reapproval.

### Preview migration

- Existing preview URLs, mount layout, artifact IDs, entry selection, base-path behavior, and popout action remain stable.
- Repository-authored scripts continue to run, but any script relying on app storage, `parent.document`, `iframe.contentDocument`, or same-origin API access intentionally stops working.
- Theme, resize, and swipe are migrated to bounded messaging before removing their same-origin assumptions.
- Existing standalone theme snapshot remains the no-parent fallback.

### Failure modes

- Missing, expired, tampered, wrong-session, or corrupt preview resource cookies fail with no content disclosure and no cookie issuance.
- Cookie signing/persistence is not repository-controlled. Preview cookie verification failure never falls back to bearer query material for opaque subresources.
- Unsupported `SameSite=None; Secure` behavior may leave secondary assets unavailable; it must not restore same-origin or anonymous access.
- Missing/invalid bridge messages degrade cosmetic theme/size/swipe behavior only. They never affect approval/runtime state.
- A stale iframe can send messages, but exact `contentWindow` registration rejects it after replacement.
- CSP header generation failure fails closed by refusing preview content rather than serving unsandboxed bytes.
- Preview admission/CORS ambiguity fails closed. Do not broaden API CORS or accept a JavaScript-provided surrogate identity.
- MCP approval persistence failure leaves decision/runtime unchanged. Operator verifier corruption, invalid credential, or unavailable pairing code leaves decisions unavailable but project MCP definitions inert.

### Platform and deployment constraints

- Test Chromium, Firefox, and WebKit because opaque sandbox Fetch Metadata and `SameSite=None` behavior vary.
- `Secure` is mandatory for cross-site preview cookies. Loopback development relies only on browser-supported secure localhost behavior; non-loopback remote gateways require HTTPS. Do not silently emit a non-Secure `SameSite=None` cookie.
- Vite, embedded, saved cross-origin, reverse-proxy, base-path, remote, and mobile operation retain current gateway/request-admission configuration. The new exception concerns only the gateway's preview route.
- Initial preview document navigation still uses existing admitted browser/gateway authority. Opaque follow-on resources use only the session-bound preview cookie.
- Generic gateway API CORS, browser bearer transport, and operator approval headers do not change.

## Explicitly rejected alternatives

### Server-rendered decision ceremony

Rejected despite its viable credential-containment properties. A complete ceremony needs pairing claim tickets, an HttpOnly operator cookie, staged decision intents, top-level navigation checks, server-rendered safe review HTML, a second confirmation nonce, TTL/count bounds, restart recovery, return-URL validation, focus restoration, same-tab mobile flow, embedded new-tab flow, and cross-origin gateway handling.

That is a new decision page and a multi-navigation UX, directly violating the goal's explicit requirement to remain in existing Tools → MCP with no new page/modal. It also creates materially greater state/API/navigation defect surface than removing same-origin privilege at the two existing content boundaries. The selected opaque-origin design preserves direct inline per-server actions and fixes the broader repository-preview trust violation rather than routing around it only for MCP approval.

### Storage-only credential containment

Rejected as insecure. sessionStorage, IndexedDB, a worker, or an extractable/non-extractable WebCrypto key remains available to same-origin authored content directly or through signing/request use. An HttpOnly credential accepted by the direct approval endpoint remains vulnerable to same-origin session riding. Hiding bearer bytes is not enough while repository code shares the authority origin.

### Iframe attribute only

Rejected as incomplete. Raw popout/direct navigation has no iframe element, and active SVG/non-HTML documents can execute under the gateway origin. The response CSP layer is mandatory.

### CSP response only

Rejected as unnecessarily fragile. The iframe attribute is a local defense at both embedding call sites and creates the strictest embedded capability set. The two mechanisms intersect and protect against regression in either path.

### Disable preview scripts

Rejected as incompatible with Bobbit's interactive HTML preview contract. `allow-scripts` remains; only origin authority is removed.

### Anonymous preview mount or URL bearer

Rejected. Anonymous mounts disclose repository/session artifacts. URL credentials leak through history, referrers, copied links, logs, and screenshots. The HttpOnly, path- and session-bound resource cookie grants the minimum read capability without exposing bearer material to authored JavaScript.

### Separate preview origin/listener

Deferred. It can supply a conventional origin boundary but adds listener allocation, advertised URL/origin management, TLS/DNS/reverse-proxy configuration, CORS/storage behavior, and deployment failure modes. Opaque sandboxing composes with the current route and has smaller operational surface.

### WebAuthn or external identity

Deferred. These may strengthen protection against browser-profile compromise but introduce RP/origin ceremony, registration/recovery, secure-context, embedded-browser, and identity-system concerns outside this repository trust gate.

## Implementation-ready packet

### Change sequence

1. **Pin the exploit.** Add a browser regression that pairs/seeds operator authority, runs malicious repository HTML in both existing preview surfaces, attempts storage/parent reads and the exact approval POST, and currently proves the server becomes approved. Add raw popout and active SVG variants.
2. **Add preview resource capability.** Extend `CookieStore`, bind verification to session ID/path, issue only after valid initial preview auth, and add focused unit tests.
3. **Narrow admission/CORS.** Admit only coherent opaque preview GET/HEAD follow-on requests and project route-local null-origin CORS only after preview authorization. Pin API/operator/unsafe-method denials.
4. **Add response sandbox.** Centralize successful preview headers and apply CSP to HTML, streamed resources, SVG, and HEAD. Verify direct/popout origin opacity.
5. **Migrate bridges.** Introduce `preview-frame-host.ts`, replace parent DOM theme pull, add child resize messaging, source-check swipe, and move streaming writes to `srcdoc` assignment.
6. **Remove same-origin iframe capability.** Change all completed/streaming/side-panel iframe sandboxes to exact `allow-scripts` once compatibility paths no longer depend on parent/contentDocument access.
7. **Run focused and cross-browser journeys.** Verify assets, themes, streaming, popout, base path, Vite/embedded/remote/mobile behavior, operator containment, and unchanged MCP lifecycle.
8. **Update reference docs.** Document the repository-preview boundary, resource cookie, opaque request behavior, bridge protocol, platform constraints, and narrowed threat statement in `docs/preview-architecture.md`, `docs/security.md`, and `docs/mcp-server-approvals.md`.

### Exact production file and symbol matrix

| File | Existing symbol/seam | Required change | Must not change |
|---|---|---|---|
| `src/server/preview/content-route.ts` | `handlePreviewRequest()`, `isAuthorized()` | Parse/validate `sid` before inner auth; accept exact preview cookie for follow-ons; issue/refresh after valid initial auth; add CSP to every successful content response; route-local null-origin CORS after auth. | Entry selection, artifact addressing, path guard, read leases, base injection, no-store behavior. |
| `src/server/auth/cookie.ts` | `CookieStore`, `tryAuth()`, `issueCookie()` | Add domain-separated session-bound preview mint/verify/auth/serialization helpers with exact path, HttpOnly, Secure, SameSite=None. | Generic `bobbit_session` format, lifetime, SameSite behavior, browser-cookie admission. |
| `src/server/request-admission.ts` | `admitRequest()`, `classifyContext()`, `isCoherentFetchContext()`, `isCoherentOriginlessSubresource()`, `simpleCors()` | Recognize exact `Origin: null`/originless opaque preview GET/HEAD resource shapes; return preview-only projection without widening generic CORS. | API/UI/WS/preflight policies; generic `simpleCors().allowCredentials === false`. |
| `src/app/render.ts` | `htmlPreviewContent()`, `sidePanelPopoutButton()`, `setupPreviewSwipe()` | Use iframe `sandbox="allow-scripts"`; register side-panel frame host; exact-source-check/clamp swipe; preserve canonical raw popout URL. | Existing panel tabs, restore, SSE mtime remount, navigation contract. |
| `src/ui/tools/renderers/HtmlRenderer.ts` | `render()`, `_autoResize()`, `_writeToIframe()` | Use exact `allow-scripts`; register inline frame; consume bounded resize messages; assign prepared `srcdoc` on debounce; clean up registrations/timers. | 600px maximum, 1.5s debounce, last-content suppression, completion/streaming UX. |
| `src/ui/tools/renderers/prepare-inline-html.ts` | `prepareInlineHtml()` and bounded cache | Inject initial theme and child bridge before authored scripts; include theme/bootstrap identity in cache key. | Existing sanitization/injection contracts unrelated to origin. |
| `src/shared/preview-bridge-scripts.ts` | `PREVIEW_THEME_BRIDGE`, `PREVIEW_SWIPE_SCRIPT`, `PREVIEW_BRIDGE_SCRIPTS`, `injectBaseAndScripts()` | Replace parent DOM pull with versioned ready/theme listener; add bounded resize child bridge; retain swipe messages. | Self-contained/idempotent scripts and server/srcdoc shared use. |
| `src/ui/preview-frame-host.ts` | New focused helper | Own frame registration, cosmetic theme DTO extraction, exact `contentWindow` matching, mutation-driven updates, resize bounds, and cleanup. | No security authority, fetch, storage, or navigation responsibilities. |
| `docs/preview-architecture.md` | Preview security/transport reference | Document opaque origin, CSP, resource capability, messaging, and popout/SVG behavior. | Existing mount/artifact lifecycle. |
| `docs/security.md` | Threat boundaries | Classify repository previews as untrusted and remove them from the generic same-origin-XSS exclusion. | Trusted-code/browser/host compromise exclusions. |
| `docs/mcp-server-approvals.md` | Approval/operator model | State why opaque previews protect browser operator authority and list recovery/troubleshooting behavior. | Pairing and approval contracts. |

### Preserved MCP files and symbols

Do not modify as part of the preview-isolation fix unless a test exposes a direct contract bug:

- `src/server/auth/mcp-operator-authorizer.ts::McpOperatorAuthorizer`;
- `src/app/mcp-operator-auth.ts` credential format and gateway-keyed storage;
- `src/app/api.ts::decideMcpServerApproval()` approval-only header behavior;
- `src/server/mcp/mcp-approval-store.ts::McpApprovalStore`;
- `src/server/mcp/mcp-manager.ts` discovery/eligibility/runtime flow;
- `SessionManager.decideMcpApproval()` and approval reload fan-out;
- approval ledger, fingerprints, status DTO, operator pairing routes, and tool invocation policies.

### Bridge protocol constraints

Use one versioned discriminated union shared by host types and injected child scripts:

```ts
type PreviewChildMessage =
  | { type: "bobbit-preview-ready"; version: 1 }
  | { type: "bobbit-preview-resize"; version: 1; height: number }
  | { type: "preview-swipe-start" }
  | { type: "preview-swipe-move"; dx: number }
  | { type: "preview-swipe-end"; dx: number };

type PreviewHostMessage = {
  type: "bobbit-preview-theme";
  version: 1;
  dark: boolean;
  palette?: string;
  fontFamily?: string;
  properties: Record<string, string>;
};
```

Implementation must bound DTO serialized size, key/value length, property count, palette/font length, and numeric ranges. Only allow known theme custom-property names gathered by the host. Messages are sent with `"*"` only because the child origin is intentionally opaque; exact `WindowProxy` identity supplies channel binding.

### Focused acceptance coverage

1. `tests/unit/core/preview-cookie.unit.test.ts`: domain separation, session binding, wrong/tampered/expired rejection, renewal, exact base-path-aware Path, HttpOnly/Secure/SameSite attributes.
2. `tests/unit/core/preview-content-route.unit.test.ts`: sandbox CSP on HTML/static/SVG/HEAD, no `allow-same-origin`, preview cookie only after valid initial auth, wrong-session cookie rejected, errors/redirects do not grant authority.
3. `tests/unit/core/request-admission.unit.test.ts`: exact null/originless preview GET/HEAD shapes, duplicate/malformed headers, destination variants, and denial for API/operator POST, unsafe methods, UI, WebSocket, preflight, and uncredentialed requests.
4. `tests/integration/gateway/request-admission.gateway.test.ts`: route-local `Access-Control-Allow-Origin: null`/credentials only on authenticated preview resources; generic API `allowCredentials:false` unchanged.
5. `tests/unit/core/preview-theme-bridge-runtime.unit.test.ts` and `preview-bridge-standalone-guard.unit.test.ts`: handshake, strict DTO, source behavior, idempotence, initial snapshot, standalone fallback, no `parent.document`.
6. `tests/dom/inline-html-renderer-lifecycle.dom.test.ts`: exact iframe sandbox, no `contentDocument`, prepared debounced `srcdoc`, resize clamp/source rejection, stale-frame rejection, and cleanup.
7. `tests/browser/fixtures/inline-html-theme-source.fixture.spec.ts`: opaque storage/parent access, parse-time theme, live theme toggles without authored-script rerun, completed/streaming/edit parity.
8. `tests/browser/fixtures/request-admission-preview-compatibility.fixture.spec.ts`: `parentReadable:false`; relative CSS/image/classic+module JS/font/JSON, SSE remount, artifact switch, base path, restart, popout, and hostile external embed behavior.
9. Canonical P1 browser regression: pair/seed `mcp.operator.credentials.v1`; malicious side-panel and inline preview attempts localStorage/sessionStorage/IndexedDB/parent reads and exact approval mutation; approval remains pending and stdio/HTTP counters remain zero. Repeat in raw popout and active SVG; API attempt has null origin and is denied.
10. Existing MCP suites continue to prove provenance, fingerprinting, redaction, persistence, stale decisions, pending/rejected zero startup/request counts, approved startup, changed-config revocation, multi-project/worktree identity, pairing durability, and Tools/banner journey.
11. Run Chromium, Firefox, and WebKit for cookie/Fetch Metadata differences, then `npm run check` and focused unit, integration, DOM, and browser suites. Broad workflow verification owns the full suite.

### Review checklist

- [ ] No iframe rendering repository HTML contains `allow-same-origin`.
- [ ] Every successful preview content response, including SVG and HEAD, contains CSP `sandbox` without `allow-same-origin`.
- [ ] Raw popout/direct preview documents have opaque origin.
- [ ] Preview cookie is HttpOnly, Secure, SameSite=None, exact-path, purpose-separated, and session-bound.
- [ ] Preview cookie cannot authenticate API, SSE outside the session mount, WebSocket, operator pairing, or MCP approval.
- [ ] Null-origin admission is GET/HEAD preview-only and inner auth remains mandatory.
- [ ] Generic gateway/API CORS remains non-credentialed.
- [ ] Theme, resize, and swipe no longer require parent/contentDocument access.
- [ ] Every host message is accepted by exact `event.source` registration and bounded validation.
- [ ] No operator secret appears in preview DOM, URL, storage view, messages, logs, or requests.
- [ ] Pending/rejected/changed MCP definitions remain inert, and exact approved definitions preserve existing precedence/runtime behavior.
- [ ] Existing Tools → MCP inline approval UX remains a single-page flow with no approve-all action.

## Final rationale

The MCP approval design already establishes a narrow, human-paired authority and a fail-closed runtime eligibility gate. The P1 is caused by a separate violated boundary: Bobbit deliberately executes repository-authored content with the same browser origin that holds the operator credential. The smallest complete correction is to isolate that content where it becomes active, while preserving its resources and cosmetic integration through capabilities that cannot authorize application behavior.

Opaque-origin iframe attributes alone do not cover popouts and active documents, so response CSP is the required second layer. Response CSP alone needlessly relies on one server seam, so iframe restrictions remain local defense in depth. A session-bound HttpOnly preview cookie restores only read access to one preview mount; bounded `postMessage` restores only cosmetic interoperability. No MCP identity, decision, discovery, persistence, runtime, or Tools contract needs to move.

The server-rendered ceremony is therefore explicitly rejected: although it can contain the credential, it solves the symptom through a new page and multi-stage navigation, violates the goal's no-new-page UX constraint, and introduces far more security-sensitive state and lifecycle surface. Opaque preview isolation fixes the root trust violation and is the lower-defect, implementation-ready revision.