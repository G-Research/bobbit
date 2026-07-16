# AI Gateway routing

Bobbit can use one AI Gateway as the model source for agent sessions, reviews, and title generation. The gateway remains the routing authority: Bobbit discovers each upstream provider's API and endpoint, translates that information into pi-ai model entries, and publishes the result to the active agent directory's `models.json`.

This avoids guessing from model names. In particular, OpenAI reasoning models can use the Responses API, where reasoning and function tools are supported together, while Bedrock models retain Converse semantics.

## Configure an AI Gateway

Open **Settings → Models → AI Gateway** and enter an absolute HTTP(S) gateway URL, such as `https://gateway.example/v1`.

- **Test** performs discovery without saving or changing active routing.
- **Enable Gateway** or **Update** discovers models, atomically replaces the generated `aigw` provider in `models.json`, and saves `aigw.url`.
- **Refresh Models** repeats the saved configuration flow, including model discovery, default seeding, cache invalidation, and sandbox refresh.
- **Disconnect** removes the generated provider and saved URL.

The equivalent REST endpoints are documented in [REST API](rest-api.md#ai-gateway). Agents with the administrative Bobbit tool can configure or remove the URL through `aigw_configure`.

While an AI Gateway is configured, Bobbit hides built-in public providers by default. Local custom providers remain visible. Clear **Hide built-in providers while the gateway is configured** when a development environment needs direct providers and gateway models together; this stores `aigw.exclusive: false`.

### Operator inputs

| Input | Purpose |
|---|---|
| `aigw.url` | Saved gateway URL. Discovery accepts an origin or `/v1` URL. Use the origin form when callers use Bobbit's `/api/aigw/v1/*` proxy, which appends `/v1/*` to the saved value. |
| `AIGW_OPENCODE_TOKEN` | Preferred bearer token for the initial opencode well-known request. |
| opencode `auth.json` | Fallback token source. Bobbit accepts a `type: "wellknown"` entry keyed by the gateway URL or host from opencode's standard data/config locations. |
| `BOBBIT_SKIP_AIGW_DISCOVERY=1` | Disables startup network discovery. An existing `models.json` stays active and Bedrock environment wiring is still applied. |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` | Startup auto-detection candidates when no gateway is saved and Bobbit determines that public internet access is unavailable. Bobbit also probes the local port `1111` gateway convention. |

The well-known token is best-effort. Discovery proceeds without `Authorization` when neither token source exists.

## Discovery precedence

Discovery is well-known-first:

1. Resolve `/.well-known/opencode` against the configured URL's **origin**, not beneath `/v1`.
2. Accept a raw config, a top-level `{ "config": ... }` wrapper, or one `remote_config` hop.
3. If the resolved document has a valid `provider` object, treat it as authoritative, even if filtering produces no usable models.
4. Only when no authoritative config resolves, request the legacy `/v1/models` endpoint and infer missing metadata.

A remote config may not point to another unresolved `remote_config`. The initial document, optional remote document, and provider-host DNS admission share one bounded discovery deadline. Configure reuses that resolved result rather than fetching the well-known document twice.

Authoritative filtering applies `disabled_providers`, each provider's `whitelist`, and URL validation. Bobbit does not repopulate filtered or invalid providers from `/v1/models`; doing so would silently override the gateway operator's policy.

## Remote config security

Discovery URLs are untrusted configuration and are constrained to prevent credential leakage, SSRF, and DNS rebinding:

- URLs must be absolute HTTP(S) URLs without embedded credentials or fragments. Redirects are not followed, and JSON responses are size-bounded.
- The configured gateway origin may use HTTP and private addressing, which permits an on-prem gateway.
- Cross-origin remote configs and provider endpoints require HTTPS. Literal and resolved addresses must be public; loopback, private, link-local, metadata, carrier-grade NAT, multicast, documentation, unspecified, and reserved ranges are rejected.
- DNS answers are validated and pinned for discovery while TLS still verifies the original hostname. The gateway process re-resolves and revalidates admitted cross-origin provider hosts on later connections. Agent processes do the same when Bobbit can generate and activate the DNS guard extension; extension-write failure is logged and the agent starts without that guard.
- The bearer token for the well-known request never crosses the configured origin. A same-origin remote may replace it with an explicitly declared `Authorization` header; a cross-origin remote receives only its explicitly declared headers.
- Hop-by-hop, proxy, `Host`, `Content-Length`, and `User-Agent` headers are discarded. Bobbit supplies its own canonical user agent. Credentials, bodies, and remote headers are not logged.

A rejected provider is omitted. Test/status discovery cannot change the active DNS guard set; it changes only after a successful `models.json` publication. Disconnect clears the active set. Operators using cross-origin provider endpoints should keep the Bobbit state directory writable and treat a DNS guard extension warning as a security-relevant configuration failure.

## Provider-specific routing

The well-known provider's `npm` adapter selects the pi-ai API. Each model retains that provider's `options.baseURL` as its endpoint.

| well-known adapter | pi-ai API | Request route |
|---|---|---|
| `@ai-sdk/openai` | `openai-responses` | `{baseURL}/responses` |
| `@ai-sdk/amazon-bedrock` | `bedrock-converse-stream` | Bedrock Converse beneath the provider endpoint, commonly `/aws` |
| `@ai-sdk/openai-compatible` | `openai-completions` | `{baseURL}/chat/completions` |
| Unknown adapter | `openai-completions` | Conservative chat-completions fallback |

Per-provider base URLs matter because a gateway's multiplexed `/v1` root and provider subpaths can expose different APIs and model ID forms. Provider subpaths receive the bare wire ID, such as `gpt-5.6-sol`, rather than a multiplexed ID such as `openai/gpt-5.6-sol`.

The well-known document also supplies reasoning, context/output limits, input modalities, thinking variants, and per-million-token costs. Bobbit persists these fields rather than replacing them with model-name heuristics.

## Legacy fallback

If well-known discovery is unavailable or invalid, Bobbit reads `/v1/models` and applies the legacy metadata rules with two routing safeguards:

- OpenAI-family reasoning IDs (`gpt-*` and `o1`–`o9`, excluding Claude-shaped IDs) use `openai-responses` at `{gatewayOrigin}/openai/v1` with a bare wire ID.
- Claude IDs use `bedrock-converse-stream` at `{gatewayOrigin}/aws` with the upstream prefix removed.
- Other models remain on `openai-completions` at the gateway's `/v1` root.

This fallback preserves compatibility with gateways that have not implemented the opencode document while preventing reasoning-plus-tools requests from being sent to an incompatible chat-completions endpoint.

## Model identity, provenance, and migration

Bobbit-facing AIGW preferences use `aigw/<bare-id>`. The upstream provider is metadata, not part of the public model ID:

- `upstreamProvider` records the well-known provider key, or the legacy model ID prefix, and is returned by the model APIs and persisted in `models.json`.
- Settings and model pickers render it as an AIGW provider badge and include it in search.
- When providers advertise the same bare ID, the provider selected by the top-level `model` wins for that ID; otherwise provider declaration order is stable.

Older preferences may contain `aigw/<upstream>/<id>`. Bobbit migrates one only when the current `models.json` contains exactly one matching bare ID and no exact prefixed entry. Malformed, missing, ambiguous, unknown multi-segment, and already exact IDs remain unchanged. The same normalization is applied to default preferences and restored session pins; ambiguous migrations are preserved rather than guessed.

## Default model seeding

On a successful configure or manual refresh, a well-known top-level `model` value such as `aws:us.anthropic.claude-opus-4-6` can seed:

- `default.sessionModel`
- `default.reviewModel`
- `default.namingModel`

Bobbit writes `aigw/<bare-id>` only when the corresponding preference is unset or empty and the deduplicated model matches both the declared upstream provider and wire ID. User choices are never overwritten. Test, status, and startup refresh do not seed empty defaults.

## Model probes

The Settings default-model **Test** action calls `/api/models/test` and probes the model's resolved route:

- Responses models send a small request to `{baseUrl}/responses` with `max_output_tokens`.
- Completions models send a small request to `{baseUrl}/chat/completions` with `max_tokens`.
- Converse and future provider-native APIs run through pi-ai instead of being relabelled as chat completions.

A failed probe is reported for that route and is not retried against another API. `/api/aigw/test` is different: it validates discovery and returns the discovered models without saving configuration or testing inference.

## Publication, caches, and containers

A successful configure or refresh publishes `models.json` with temp-file-plus-rename replacement, preserving non-AIGW providers and user `modelOverrides`. It also invalidates the model registry cache and the session auto-selection cache, then notifies connected clients.

Normal reads use short-lived caches: the model registry caches assembled models for five seconds, while session AIGW auto-selection caches discovery for one minute. Configure, refresh, and disconnect clear both immediately.

Docker file bind mounts retain the old inode after atomic replacement. Bobbit therefore recreates tracked project containers after each publication or removal. Publication generations serialize concurrent refreshes so a newer update cannot be lost behind an in-progress recreation; workspace and worktree volumes survive, and live sandboxed sessions use normal container recovery. Startup health checks also compare the mounted file's content with the active host file and recreate stale or pre-upgrade containers.

Direct host agent processes are not recreated by this sandbox refresh. They retain the model registry and DNS guard extension loaded at spawn until the session is respawned; new direct sessions use the newly published configuration.

The durable configuration remains committed if container recreation fails. Configure, refresh, or disconnect then returns `remountPending: true`; normal sandbox health recovery remains responsible for completing the remount.

## Request metadata

AIGW traffic receives `User-Agent: Bobbit/<version>`. Agent inference also receives `x-opencode-session: <session-id>` when a session ID is available, allowing gateway-side attribution and cache partitioning. These headers are scoped to the generated `aigw` provider and direct AIGW request helpers; Bobbit does not attach them to unrelated public-provider traffic.

For implementation details, pricing units, and header generation, see [AI Gateway internals](internals.md#ai-gateway-request-headers-user-agent-x-opencode-session). For stale model or model-selection diagnostics, see [Debugging](debugging.md).
