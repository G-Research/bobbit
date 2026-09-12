# Security Model

Bobbit controls agents with full shell access to the host machine. Treat its admin token like an SSH key, and expose the gateway only through authorities and network paths you intend to operate.

Request admission is the gateway's outer network boundary. It rejects untrusted browser and authority contexts before readiness checks, public routes, CORS, authentication, preview/static handling, API dispatch, or WebSocket upgrade. It supplements bearer, signed-cookie, sandbox-token, rate-limit, and route authorization; it does not replace them.

## Authentication and token custody

- A 256-bit cryptographically random token is generated on first run. It is persisted in `serverSecretsDir()` (an OS user-level directory outside any project root, defaulting to `<AppData|Library/Application Support|~/.local/state>/bobbit/secrets/<hash>/token`) with mode `0600`. Override the directory with `BOBBIT_SECRETS_DIR`. Keeping the token outside Headquarters prevents ordinary same-root project agents from reading the gateway admin credential. See [Headquarters — Live secrets exception](headquarters.md#live-secrets-exception-serversecretsdir).
- Outside the genuinely all-loopback policy, HTTP routes enforce their existing bearer, signed-browser-cookie, or scoped sandbox credential as applicable. A WebSocket's first frame must authenticate with the admin token or a session-scoped sandbox token. A loopback-only gateway keeps the local credential bypass unless `--auth` is set.
- Adding any non-loopback public, published, direct-listener, TLS, or Vite authority disables the local credential bypass for the complete policy, including requests addressed through loopback. This prevents a public deployment from retaining an accidental unauthenticated backend path.
- Constant-time token comparison prevents timing attacks. Failed authentication is IP-rate-limited, and WebSocket authentication has a five-second timeout.
- Static file serving prevents directory traversal by requiring resolved paths to remain below the static directory.
- The gateway binds to the NordLynx mesh IP when requested, otherwise to `localhost`. It never binds to `0.0.0.0` unless explicitly configured. TLS defaults on for non-loopback addresses and off for localhost unless `--tls` is passed.
- OAuth uses PKCE when obtaining API credentials.

## Request admission

### Trusted authorities

The gateway compiles one immutable authority policy after the listener has selected its actual port and the published URL is known. Its inputs are finite and configuration-owned:

- the configured bind host when it is not a wildcard;
- `localhost`, `127.0.0.1`, and `[::1]` at the actual listener port;
- configured direct-TLS certificate names, including the configured deSEC name in the CLI path;
- each explicit public origin;
- the origin of the URL published after binding, including a programmatic `GatewayConfig.onBound` result.

Separately, explicit Vite-origin-to-trusted-gateway mappings grant the narrow development browser exception. A Vite origin is not added as a gateway `Host` authority.

`0.0.0.0` and `::` are listener addresses, not authorities, so they never authorize arbitrary `Host` values. The policy does not infer names from DNS, TLS SNI, request headers, or the network interface. A reverse proxy, manual DNS name, externally terminated TLS scheme, or external port therefore needs an explicit public origin. See [Networking — Request-admission configuration](networking.md#request-admission-configuration).

Every HTTP request and WebSocket upgrade must contain exactly one trusted `Host`, even when `Origin` is absent. An attacker-controlled `Host` and equal `Origin` still fail because equality cannot add the authority to the compiled set; this is the DNS-rebinding boundary.

Security-sensitive fields are read from the raw header list so duplicate fields cannot be hidden by Node's normalized header view. Missing or duplicate `Host`, duplicate `Origin`, duplicate Fetch Metadata/preflight fields, comma-joined values, control characters, whitespace ambiguity, userinfo, paths, queries, fragments, bad brackets, invalid ports, and unbracketed IPv6 are rejected. Valid values are compared after canonicalizing HTTP(S) scheme, DNS case and a single trailing dot, IPv4/IPv6 spelling, and default or explicit ports.

### Browser context matrix

A trusted `Host` is necessary in every row. A present `Origin` must be one exact normalized origin for that authority, or the configured Vite origin paired with it. `null`, merely same-site, and attacker-selected origins are not accepted.

| Context | Accepted browser shape | Why |
|---|---|---|
| Top-level UI or preview document | Safe `GET`/`HEAD` navigation to a document with no `Origin`, including address-bar, bookmark, reload, external-link, and supported popup contexts; or an exact same-origin/Vite navigation | Users must be able to open trusted URLs normally, but the navigation exception must not grant API authority. |
| UI static resource or manifest | Exact same-origin/Vite context, or coherent originless same-origin subresource metadata | Ordinary page loading remains usable without accepting sibling-origin embedding. |
| API | Exact same-origin/Vite context; a same-origin browser fetch may omit `Origin` when its Fetch Metadata is coherent | Browsers do not send `Origin` on every same-origin request, so Host and Fetch Metadata must classify those requests without creating a cross-site bypass. |
| Embedded preview iframe | Exact same-origin/Vite iframe navigation | The top-level navigation exception never applies to iframes, and cross-site iframe navigation is rejected even when ambient preview state exists. The loaded frame then receives an opaque origin. |
| Opaque preview redirect or asset | `Origin: null` or the coherent browser follow-on shape, only on the matching preview route | Every resource is authorized independently with the session-bound preview capability; authorizing the first HTML response does not authorize later resources or another session path. |
| Preview SSE stream | Exact same-origin/Vite browser context, with coherent originless same-origin metadata where browsers normally omit `Origin` | SSE remains an application transport authenticated by the normal session/admin path, not an opaque-frame capability. |
| WebSocket | Exact allowed browser `Origin`; supplied Fetch Metadata must describe a same-origin socket. Both the standard empty destination and WebKit's `websocket` destination are accepted. | Admission runs before either session/viewer upgrade and before first-frame authentication. |
| CORS preflight | Exact configured origin, allowed requested method and headers, coherent metadata, and no private-network request | The response advertises only the capability that was actually approved. |

A client with no browser `Origin` or Fetch Metadata can proceed as non-browser traffic. Node's known originless HTTP-fetch shape is treated the same way. This preserves CLI, agent, and sandbox callbacks, but only after Host admission and without bypassing their normal bearer or sandbox-scope checks. Browser-shaped partial, same-site, cross-site, or incoherent metadata is rejected outside the narrow safe-navigation case.

### CORS and Private Network Access

CORS responses come from the admission decision rather than route-local reflection:

- `Access-Control-Allow-Origin` is the exact approved origin, never `*`.
- `Vary: Origin` is added.
- Preflights return only the requested allowed method and requested allowed headers, with a bounded cache lifetime.
- Cross-origin cookies are not advertised on general routes: `Access-Control-Allow-Credentials` is omitted. API and WebSocket transports use bearer authentication across the finite Vite exception. The only narrow exception is a successfully authenticated `Origin: null` request below the matching preview session route, where the read-only preview capability needs credentialed CORS for opaque-frame assets.
- An unapproved preflight returns `403` without CORS capability headers.
- Private Network Access preflights are denied. The gateway omits `Access-Control-Allow-Private-Network`; it never sends either an affirmative grant or a misleading `false` value.

### Reverse proxies and diagnostics

`Forwarded` and `X-Forwarded-*` are ignored for admission. There is no implicit trusted-proxy hop or CIDR mode. A proxy must preserve the externally visible `Host` and the deployment must declare its public origin; otherwise the browser's public `Origin` cannot match the admitted gateway authority. This fail-closed behavior prevents an untrusted client from manufacturing the authority through forwarding headers.

Rejected requests log only a stable reason code, transport, method, coarse route context, and bounded remote address. Raw URLs, query strings, authorization values, cookies, and header contents are intentionally excluded so a security diagnostic cannot leak credentials.

## Authored HTML preview isolation

Request admission prevents an unrelated web origin from reaching Bobbit. A second boundary isolates repository- or agent-authored HTML that Bobbit intentionally renders.

Inline `.html`/`.htm` chat cards and side-panel preview documents run in iframes with `sandbox="allow-scripts"` and no `allow-same-origin`. The resulting opaque/null origin prevents authored scripts from reading the parent DOM, application storage, browser-held MCP operator credential, and Bobbit session state. Preview responses also carry a CSP sandbox without same-origin permission; the policy applies to successful HTML, SVG/other assets, and `HEAD`, including content opened in a standalone tab.

Opaque assets cannot use normal same-site cookie behavior, so a successful primary-authenticated preview response mints a separate `bobbit_preview` cookie. It is HttpOnly, Secure, SameSite=None, read-only, bound to one session, and path-scoped below that session's preview mount. It does not authorize APIs, WebSockets, another session's preview, or an MCP decision. Credentialed `Origin: null` CORS is returned only after this capability verifies on the matching preview route; hostile cross-site iframe navigation is rejected before redirects or bytes.

Theme, resize, and side-panel swipe compatibility use a bounded `postMessage` bridge instead of parent DOM access. The child accepts theme data only from its exact parent and validates an explicit cosmetic-token allowlist; theme/ready/resize messages use the expected protocol version. The host accepts child messages only from the registered or active preview frame and validates/clamps their exact shape; side-panel swipe messages are additionally limited to the active preview. Bridge failure costs cosmetics or gestures, never isolation.

Pack panels and app-owned renderers that execute directly in the host document remain part of the Bobbit application trust domain and use its authenticated transports. Do not move repository-authored HTML into that domain or add `allow-same-origin` as a compatibility workaround.

## Private MCP startup authority

Project-controlled MCP definitions are inert until an operator approves their exact effective behavior. Pending, rejected, changed, and invalid definitions are not spawned, connected, initialized, sent data, or registered as tools. This startup gate is separate from `Allow` / `Ask` / `Never` operation policy, which controls calls only after a server is eligible.

Approval and rejection require a dedicated operator credential obtained from a one-use terminal pairing code. General gateway cookies, bearer tokens, session secrets, and repository-controlled agents are deliberately insufficient. The browser sends the credential only with MCP decision requests; the server persists only its ID and one-way verifier in `serverSecretsDir()`. Approval decisions and their HMAC key also live in that private OS-user namespace rather than repository-reachable Headquarters state.

Decisions bind the stable project, logical source, server name, and a keyed fingerprint of every execution- or connection-relevant field, including secret values before display redaction. Worktree review also binds a current owning session or goal to its validated project/execution scope; arbitrary paths, foreign or stale owners, and root-only review cannot authorize an external sibling worktree.

Project Marketplace MCP contributions are pretrusted only with a private install attestation for the exact contribution configuration and complete installed pack. The pack measurement covers all directories, regular files, internal relative symlinks, paths, relevant mode bits, bytes, and link targets, with bounds and race rechecks. Unsafe, changed, missing, legacy, or unverifiable attestations fail closed into ordinary project review; packs without MCP contributions do not need this MCP-specific measurement.

Review metadata exposes project-relative provenance and useful command structure while redacting environment/header values, URL credentials/query/fragment, credential-bearing arguments, configured secret substrings, private source paths, and attestation signals. Runtime health/error output has its own projection: configured environment/header values and URL credential components are removed, configured URLs become safe endpoints, and output is bounded. See [MCP server startup approvals](mcp-server-approvals.md) for source classes, persistence, lifecycle, API semantics, and recovery.

## Preview endpoint hardening

The preview mount API and `/preview/<session>/...` content routes scope rendered bytes per session. Security measures include:

- **UUID validation:** `sessionId` is validated against a strict UUID-shaped expression. Values containing traversal syntax, backslashes, or colons return `400`, preventing sandbox agents from selecting an arbitrary state directory.
- **Path and asset confinement:** mount input uses explicit asset opt-in, and content resolution rejects absolute paths, traversal, backslashes, NULs, and symlink escape.
- **Opaque transport capability:** primary authentication can bootstrap only the session-bound preview cookie described above; every follow-on content request revalidates the route/session binding.
- **Vite filesystem deny:** `server.fs.deny` rules block `.bobbit` and `node_modules/.vite`, preventing Vite's `/@fs/` route from serving sensitive files.
- **Vite plugin hardening:** `blockDangerousGlobs` rejects `import.meta.glob` calls targeting `.bobbit` paths. `localhostGuard` rejects non-loopback peers when Vite is bound to localhost and blocks Docker bridge addresses in non-local development mode.

See [Embedded HTML preview architecture](preview-architecture.md#security-boundary) for cookie admission, opaque-origin symptoms, CSP, CORS, messaging, mount, asset, SSE, theme, and artifact details.

## AI Gateway discovery boundaries

AI Gateway well-known documents may name a one-hop remote config and cross-origin provider endpoints. Bobbit treats those URLs as untrusted: cross-origin targets require HTTPS and public DNS answers, discovery pins validated answers, redirects are refused, and the configured-origin bearer token never crosses origins. The gateway revalidates admitted provider DNS at connection time; agent processes do so through a generated extension when it can be written and activated. Extension-write failure is logged but does not block agent startup, so operators using cross-origin providers must treat that warning as security-relevant. See [AI Gateway routing — Remote config security](ai-gateway-routing.md#remote-config-security) for the complete URL, header, deadline, and container-guard policy.

## Sandbox agent-directory boundaries

The configurable agent directory can contain provider credentials, so sandbox containers receive only narrow mounts:

- active `<agentDir>/sessions/` for transcript continuity;
- active `<agentDir>/models.json` read-only when present; and
- a generated, project-scoped auth file mounted as `/home/node/.bobbit/agent/auth.json`.

Bobbit never mounts the full host agent directory or host `<agentDir>/auth.json` into Docker. Remote-less sandbox clone sources are generated from sanitized tracked content that excludes `.bobbit/` and `auth.json`, then mounted read-only. See [Configurable agent directory](configurable-agent-directory.md#sandbox-safeguards).
