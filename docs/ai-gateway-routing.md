# AI Gateway routing

Bobbit can discover models from named model gateways and publish them to the active agent directory's `models.json`. The gateway is the routing authority: Bobbit preserves authoritative AIGW routes where available instead of guessing from model names. This keeps OpenAI Responses, Bedrock Converse, and ordinary chat-completions traffic on their intended endpoints.

For local or generic endpoint setup, see [Bring your own models](bring-your-own-models.md). For the record/API model, see [Multi-gateway providers](multi-gateway-providers.md).

## Gateway types

| Type | Intended endpoint | Discovery | Routing |
|---|---|---|---|
| `aigw` | Enterprise AI Gateway | `/.well-known/opencode` first, then legacy `/v1/models` fallback | Uses authoritative per-model route when present; legacy Claude IDs use Bedrock Converse |
| `openai-compatible` | Local or generic OpenAI-compatible service | Normalized `/v1/models` only | Always OpenAI completions; raw model IDs are preserved |

The AIGW type is a single provider named `aigw`. It supplies the existing enterprise routing contract and is exclusive while enabled. Generic gateways may have any valid non-built-in name and merge with built-in providers when no AIGW is enabled.

A Claude-shaped ID is **not** a generic routing signal. An OpenAI-compatible model such as `claude-local` never receives Bedrock routing, AIGW headers, `/aws`, or AIGW environment wiring.

## AIGW discovery precedence

AIGW discovery is well-known-first:

1. Request `/.well-known/opencode` at the configured URL's origin, not below `/v1`.
2. Accept a raw configuration, a `{ "config": ... }` wrapper, or one `remote_config` hop.
3. When a valid `provider` object resolves, use it as authoritative—even if filtering yields no usable models.
4. Only when no authoritative configuration resolves, request legacy `/v1/models` and infer missing metadata.

A successful authoritative response is not supplemented from legacy discovery. This avoids silently bypassing an operator's disabled-provider, whitelist, URL, or model policy.

The well-known translation preserves each provider's API, `options.baseURL`, wire ID, limits, input modes, thinking variants, compatibility flags, and per-million-token costs. The provider adapter determines the pi-ai API:

| Adapter | pi-ai API | Route |
|---|---|---|
| `@ai-sdk/openai` | `openai-responses` | `{baseURL}/responses` |
| `@ai-sdk/amazon-bedrock` | `bedrock-converse-stream` | Bedrock Converse at the provider endpoint |
| `@ai-sdk/openai-compatible` | `openai-completions` | `{baseURL}/chat/completions` |
| Unknown | `openai-completions` | Conservative fallback |

Per-provider base URLs and wire IDs matter: a multiplexed `/v1` root may require a provider-prefixed model ID, while a provider subpath may require the bare wire ID.

### AIGW legacy fallback

When well-known configuration is unavailable or invalid, Bobbit reads `/v1/models`.

- OpenAI-family reasoning IDs use `openai-responses` at the gateway's `/openai/v1` route with a bare wire ID.
- Claude IDs use `bedrock-converse-stream` at the gateway's `/aws` route with a provider prefix stripped.
- Other models use ordinary OpenAI completions at `/v1`.

This fallback belongs only to the `aigw` type. It keeps compatibility with older enterprise gateways while keeping generic endpoints structurally separate.

## Generic OpenAI-compatible discovery

A generic gateway calls normalized `GET /v1/models`. It preserves each returned ID verbatim, uses `openai-completions`, and derives ordinary metadata from supported endpoint fields plus conservative ID inference. Endpoint `context_length`/`context_window` and `max_tokens`/`max_completion_tokens` can raise inferred values. Missing fields use the documented defaults: 128,000 context tokens and 16,384 output tokens.

Generic discovery deliberately does not parse AIGW well-known documents. That boundary prevents AIGW-specific routing, generated provider headers, and Bedrock behavior from leaking into a local model service. Current direct server discovery, proxy, and model-probe helpers still add the canonical Bobbit user agent to both gateway types; this does not alter generated agent routing.

## Credentials and request boundaries

A gateway can have an optional private key expression. Bobbit resolves it at request time, sends it as `Authorization: Bearer …` only to the configured origin, and never exposes the expression or output in settings responses, logs, or model configuration responses.

The AIGW well-known request additionally supports its established best-effort OpenCode token source: `AIGW_OPENCODE_TOKEN`, then compatible OpenCode `auth.json`, then no header. This is separate from the per-gateway optional key.

AIGW-generated agent traffic receives `User-Agent: Bobbit/<version>` and may receive `x-opencode-session` for per-session attribution. Those generated headers, and AIGW Bedrock environment/DNS-guard lifecycle, apply only to the `aigw` type. Generic generated providers receive neither special provider header nor Bedrock configuration. The current server-side discovery, named proxy, and model-probe helpers do attach the canonical user agent to either type; it is a shared transport behavior rather than an AIGW model-routing rule.

## Remote-config security

AIGW well-known URLs are untrusted configuration:

- URLs must be absolute HTTP(S), without embedded credentials or fragments. Redirects are refused and JSON is size-bounded.
- The configured origin may be HTTP and private to support on-prem gateways. Cross-origin remote configs and provider endpoints require HTTPS and public DNS answers.
- Cross-origin hosts are admitted during discovery, DNS-pinned for the request, then revalidated at later connections to resist DNS rebinding. Agent processes receive a generated guard when it can be written and activated.
- The configured-origin authorization does not cross origins. A same-origin remote can explicitly replace authorization; a cross-origin remote receives only its declared headers.
- Hop-by-hop, proxy, `Host`, `Content-Length`, and inbound `User-Agent` headers are dropped. Credentials, bodies, and remote headers are not logged.

A rejected provider is omitted. Status/test discovery does not modify the active DNS guard set; only successful publication does.

## Publication, retention, and status

A successful save or refresh atomically replaces managed `providers.<gateway-name>` blocks while preserving unrelated providers and user `modelOverrides`. It invalidates model/session caches, broadcasts safe preferences, and refreshes sandbox mounts. A `remountPending` response means configuration is durable but a tracked container still needs normal health recovery.

Live discovery states are semantic:

- `reachable`: successful discovery with models;
- `empty`: successful discovery with no models; this removes stale availability;
- `unreachable`: discovery, transport, or credential resolution failed; matching retained models may remain available;
- `disabled`: the saved row intentionally contributes no models.

Retained rows are accepted only from the same gateway name and normalized base URL. A successful result always wins over retention. This prevents a brief restart from looking like an empty picker while refusing to use routing from a renamed or changed endpoint.

## Identity, defaults, and probes

AIGW-facing preferences use `aigw/<bare-id>`; `upstreamProvider` is display/search provenance, not part of the preference. Legacy AIGW prefix migration is conservative: Bobbit changes an old pref only when exactly one matching bare ID proves the intended target.

A successful AIGW configure or manual refresh can seed unset session, review, and naming defaults from the well-known top-level `model`. It never overwrites a user choice. Generic gateways do not use AIGW default seeding.

`POST /api/models/test` probes the already resolved route: Responses models use `/responses`, completions use `/chat/completions`, and Converse/future provider-native models run through pi-ai. It never retries a failed route through another API. `POST /api/aigw/test` is discovery-only and does not save configuration.

## Related documentation

- [Bring your own models](bring-your-own-models.md)
- [Multi-gateway providers](multi-gateway-providers.md)
- [REST API](rest-api.md#ai-gateways-multi-gateway)
- [Debugging](debugging.md#gateway-is-unreachable-but-the-picker-should-keep-last-known-models)
