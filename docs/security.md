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
| Embedded preview iframe | Exact same-origin/Vite iframe navigation | Preview cookies and the direct-parent theme bridge require same-origin embedding. The top-level navigation exception never applies to iframes. |
| Preview redirect, asset, or SSE stream | Exact same-origin/Vite browser context, with coherent originless same-origin metadata where browsers normally omit `Origin` | Every request in a preview load is admitted independently; authorizing the first HTML response does not authorize later resources. |
| WebSocket | Exact allowed browser `Origin`; supplied Fetch Metadata must describe a same-origin socket. Both the standard empty destination and WebKit's `websocket` destination are accepted. | Admission runs before either session/viewer upgrade and before first-frame authentication. |
| CORS preflight | Exact configured origin, allowed requested method and headers, coherent metadata, and no private-network request | The response advertises only the capability that was actually approved. |

A client with no browser `Origin` or Fetch Metadata can proceed as non-browser traffic. Node's known originless HTTP-fetch shape is treated the same way. This preserves CLI, agent, and sandbox callbacks, but only after Host admission and without bypassing their normal bearer or sandbox-scope checks. Browser-shaped partial, same-site, cross-site, or incoherent metadata is rejected outside the narrow safe-navigation case.

### CORS and Private Network Access

CORS responses come from the admission decision rather than route-local reflection:

- `Access-Control-Allow-Origin` is the exact approved origin, never `*`.
- `Vary: Origin` is added.
- Preflights return only the requested allowed method and requested allowed headers, with a bounded cache lifetime.
- Cross-origin cookies are not advertised: `Access-Control-Allow-Credentials` is omitted. API and WebSocket transports use bearer authentication across the finite Vite exception.
- An unapproved preflight returns `403` without CORS capability headers.
- Private Network Access preflights are denied. The gateway omits `Access-Control-Allow-Private-Network`; it never sends either an affirmative grant or a misleading `false` value.

### Reverse proxies and diagnostics

`Forwarded` and `X-Forwarded-*` are ignored for admission. There is no implicit trusted-proxy hop or CIDR mode. A proxy must preserve the externally visible `Host` and the deployment must declare its public origin; otherwise the browser's public `Origin` cannot match the admitted gateway authority. This fail-closed behavior prevents an untrusted client from manufacturing the authority through forwarding headers.

Rejected requests log only a stable reason code, transport, method, coarse route context, and bounded remote address. Raw URLs, query strings, authorization values, cookies, and header contents are intentionally excluded so a security diagnostic cannot leak credentials.

## Existing authored-HTML boundary

Request admission prevents an unrelated web origin from reaching Bobbit; it does **not** isolate authored HTML that Bobbit already runs at its own origin.

Inline `.html`/`.htm` chat cards remain browser-generated `srcdoc` documents and make no HTTP request for the document itself. Inline cards and side-panel preview iframes use `sandbox="allow-scripts allow-same-origin"`. Side-panel documents load from `/preview/<session>/...`; relative assets, redirects, SSE refresh, popouts, and restored previews remain on the gateway origin. The canonical theme bridge intentionally reads `parent.document` so embedded previews track live theme and palette changes, while standalone tabs use a server-injected theme snapshot.

Because scripts plus same-origin access make this authored content part of Bobbit's browser trust domain, Host/Origin validation is not a sandbox against it. Changing that boundary would require a separate content-origin design and a `postMessage` theme/asset/navigation contract. It is deliberately outside request-admission hardening.

Pack panels and renderers likewise remain in the host document and use the app-owned authenticated REST and WebSocket transports. By contrast, artifact surfaces sandboxed without `allow-same-origin` retain an opaque origin and communicate through `postMessage`; their `Origin: null` or cross-site attempts to call the gateway are rejected.

## Preview endpoint hardening

The `GET/POST /api/preview` endpoints accept an optional `sessionId` query parameter to scope preview HTML per session. Security measures include:

- **UUID validation:** `sessionId` is validated against a strict UUID-shaped expression. Values containing traversal syntax, backslashes, or colons return `400`, preventing sandbox agents from writing HTML outside the state directory.
- **Vite filesystem deny:** `server.fs.deny` rules block `.bobbit` and `node_modules/.vite`, preventing Vite's `/@fs/` route from serving sensitive files.
- **Vite plugin hardening:** `blockDangerousGlobs` rejects `import.meta.glob` calls targeting `.bobbit` paths. `localhostGuard` rejects non-loopback peers when Vite is bound to localhost and blocks Docker bridge addresses in non-local development mode.

See [Embedded HTML preview architecture](preview-architecture.md) for signed-cookie, mount, asset, SSE, theme, and artifact details.

## AI Gateway discovery boundaries

AI Gateway well-known documents may name a one-hop remote config and cross-origin provider endpoints. Bobbit treats those URLs as untrusted: cross-origin targets require HTTPS and public DNS answers, discovery pins validated answers, redirects are refused, and the configured-origin bearer token never crosses origins. The gateway revalidates admitted provider DNS at connection time; agent processes do so through a generated extension when it can be written and activated. Extension-write failure is logged but does not block agent startup, so operators using cross-origin providers must treat that warning as security-relevant. See [AI Gateway routing — Remote config security](ai-gateway-routing.md#remote-config-security) for the complete URL, header, deadline, and container-guard policy.

## Sandbox agent-directory boundaries

The configurable agent directory can contain provider credentials, so sandbox containers receive only narrow mounts:

- active `<agentDir>/sessions/` for transcript continuity;
- active `<agentDir>/models.json` read-only when present; and
- a generated, project-scoped auth file mounted as `/home/node/.bobbit/agent/auth.json`.

Bobbit never mounts the full host agent directory or host `<agentDir>/auth.json` into Docker. Remote-less sandbox clone sources are generated from sanitized tracked content that excludes `.bobbit/` and `auth.json`, then mounted read-only. See [Configurable agent directory](configurable-agent-directory.md#sandbox-safeguards).
