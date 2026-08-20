# Multi-gateway providers reference

A model gateway is a named, typed model source. The feature generalizes the former single `aigw.url` setting without changing the established AIGW routing contract. The gateway name is the provider key in the model catalog, model preference (`<name>/<model-id>`), generated `models.json`, and agent model tuple.

Use [Bring your own models](bring-your-own-models.md) for setup and [the design record](design/multi-gateway-providers.md) for rationale.

## Persisted and public shape

```ts
interface ModelGateway {
  id: string;                 // stable private-key association, not a provider key
  name: string;               // generated provider key
  url: string;
  type: "aigw" | "openai-compatible";
  enabled: boolean;
  apiKeyConfigured?: boolean; // public marker only
}
```

Records live in the `modelGateways` preference. An optional key expression is stored separately as `providerKey.gateway.<id>`. It is never embedded in the record or returned by a gateway endpoint.

Names are trimmed, unique, and restricted to safe provider-key characters. They cannot collide with a built-in provider. An `aigw` record must be named `aigw`, and at most one exists. URLs must be absolute HTTP(S), with no credentials, fragments, or credential-like query parameters.

## Discovery and generated configuration

`aigw` retains the well-known-first pipeline. Its authoritative OpenCode provider configuration can set a model's API, base URL, wire ID, limits, input, thinking, compatibility, and cost. If no authoritative configuration resolves, legacy `/v1/models` discovery applies AIGW fallback routing.

`openai-compatible` performs only normalized `GET /v1/models`. It preserves the upstream ID and derives ordinary metadata from endpoint fields plus Bobbit's conservative inference. It never consumes AIGW well-known configuration, emits AIGW headers, touches Bedrock environment variables, or treats `claude` in an ID as a Bedrock signal.

On successful discovery, Bobbit atomically updates just the managed `providers.<name>` block in the active agent directory's `models.json`. It preserves unrelated providers and user `modelOverrides`. Successful empty discovery replaces the block with an empty model list. A failed refresh keeps a matching last-good block; an explicitly disabled, removed, renamed, or URL-mismatched gateway is pruned.

Only an enabled `aigw` activates AIGW Bedrock/DNS-guard lifecycle behavior. An OpenAI-compatible generated block uses normalized `/v1`, `api: "openai-completions"`, raw IDs, and no provider headers. The separate writers make the Claude-local no-Bedrock boundary structural rather than a string heuristic. Current direct server discovery, proxy, and model-probe helpers still add the canonical Bobbit user agent for both types; that transport detail does not add AIGW routing or generated-provider headers.

## Catalog and availability

The model registry discovers each enabled gateway. An enabled AIGW makes the registry exclusive: only the AIGW contributes remote models. Without an enabled AIGW, built-in providers and every enabled generic gateway merge normally; existing custom local providers retain their existing behavior.

When live discovery fails, a retained catalog is accepted only from the same provider name and normalized base URL. It preserves exact routing metadata for restore and selection. A gateway with a configured key additionally rejects retained cross-origin model routes. Thus an outage remains visibly distinct from a successful empty response, without allowing stale configuration to bind an unrelated endpoint.

The registry cache lasts five seconds. Gateway publication invalidates it and the session auto-selection cache, broadcasts safe preferences, and asks sandbox containers to refresh their atomically replaced mount. A `remountPending` response means the durable publication succeeded but container recreation will continue through normal health recovery.

## Credentials

Credential expressions use the shared model configuration convention: `none`, literal, environment-name indirection, or `!command`. They are resolved at request time. A resolved key becomes a bearer header only for the configured origin; no value means no authorization header. Credential resolution errors are sanitized and fail closed before outbound traffic. The generated `models.json` contains the original expression or `none`, not resolved output, so agent-side provider calls preserve request-time resolution.

`PUT /api/aigw/gateways` accepts `apiKey` per row:

- omitted: preserve a stable row's expression;
- string: replace it;
- `null`: clear it.

`POST /api/aigw/test` can use a saved row ID to resolve its existing private expression only when the submitted URL and type match that row. This prevents a browser request from redirecting a saved credential to an arbitrary endpoint.

## Status contract

| State | Meaning | Models |
|---|---|---|
| `reachable` | Live discovery succeeded with models | live rows |
| `empty` | Live discovery succeeded with none | none |
| `unreachable` | Live discovery or credential resolution failed | matching retained rows, if any |
| `disabled` | Saved row is disabled | none |

Status errors are sanitized. They do not include upstream error bodies, headers, credentials, commands, or resolved token values.

## API summary

See [REST API](rest-api.md#ai-gateways-multi-gateway) for request and response details. Canonical endpoints are list/read/write, test, named refresh/status, and named proxy routes. The prior single-AIGW endpoints remain compatibility shims bound to the `aigw` row.

## Report-only scope boundary

No provider consolidation or per-model overrides is implemented here. Discovery defaults and image-only custom-provider types are documented in [Bring your own models](bring-your-own-models.md#limits-and-report-only-findings).