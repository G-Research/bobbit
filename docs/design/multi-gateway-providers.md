# Design: multi-gateway providers

## Context

Bobbit's former single AI Gateway path already owned bindable model discovery, generated `models.json`, session selection, title generation, sandbox remounting, and legacy compatibility. It could not represent local OpenAI-compatible endpoints beside built-in providers, and its Claude-ID fallback could incorrectly route a local `claude-*` model through Bedrock.

This design ports multi-gateway behavior onto the current well-known AIGW pipeline rather than mechanically replaying the original PR. That preserves authoritative per-model routes, DNS admission, atomic publication, model-ID migration, and retained-catalog behavior.

## Decisions

### Named, typed records

`modelGateways` stores secret-free ordered records with a stable ID, provider name, URL, type, and enabled state. The type is either `aigw` or `openai-compatible`. A key expression belongs in the existing private preference namespace `providerKey.gateway.<id>`, so the established preference-redaction boundary continues to apply.

A gateway name is its provider key in every downstream surface. `aigw` is singleton and must retain the literal name `aigw`: AIGW-specific Bedrock headers, fallback behavior, and client-side thinking capability guards depend on that stable provider identity. A generic endpoint may choose any validated non-built-in name.

### Type-specific discovery and writers

AIGW keeps its well-known-first discovery, including authoritative per-model API/base URL/wire ID, safe remote config handling, and legacy fallback. Generic endpoints use their own `/v1/models` discovery path and raw IDs. Separate `buildAigwProviderBlock` and `buildOpenAiCompatibleProviderBlock` functions prevent a generic `claude-local` model from acquiring an AIGW generated-provider header, `/aws` base URL, or Bedrock API.

The writer reads once, changes only managed provider blocks, and publishes atomically. A success-empty response is authoritative. A failure preserves a same-provider, same-normalized-URL last-good block rather than replacing it with an empty one.

### Derived exclusivity

An enabled AIGW defines an intentional egress boundary: it alone contributes gateway models and suppresses built-in and generic gateway rows. Otherwise generic gateways merge with built-ins. This is derived from enabled AIGW rows instead of a durable toggle, avoiding contradictory settings.

### Request-time credentials

Keys use the existing model-config indirection semantics: anonymous `none`, literal, environment lookup, or `!command`. Resolution occurs before every outgoing discovery, proxy, probe, or title request. A failing command is a credential error, not permission to retry anonymously. Public records, responses, broadcasts, logs, and UI state disclose at most a configured marker.

### Semantic outage state

`reachable`, `empty`, `unreachable`, and `disabled` distinguish success, authoritative absence, failure with possible retained availability, and user intent. The registry may use retained rows only if the name and normalized URL match; credentialed gateways additionally keep retained model routes on their own origin. This keeps restore/selection viable during a brief outage without making an old endpoint selectable after reconfiguration.

## Compatibility

Boot migration is idempotent. A legacy nonblank `aigw.url` becomes one enabled AIGW row; existing `modelGateways`, even `[]`, is authoritative. Legacy keys are removed without changing `aigw/<model>` preferences. Unchanged single-AIGW output remains byte-identical. The original status, configure, refresh, and proxy routes remain shims for the `aigw` row.

## Validation focus

Coverage is organized in Test Suite v2 for migration and byte preservation; type-specific writers and Claude-ID routing; key absent/literal/environment/command/failure and redaction; empty versus outage retention; named CRUD/status/proxy/shims; and the persisted browser list-editor and picker-filter journey. The critical regression proves an OpenAI-compatible model containing `claude` remains a raw OpenAI-completions model with no Bedrock-specific configuration.

## Non-goals and findings

The work does not expose host services to sandboxes, merge custom providers with gateways, add per-model overrides, add native local-provider discovery, or alter image generation. Generic discovery starts from `inferMeta(modelId)`: recognized families retain their family baseline (for example, current GPT-5.6 is 272,000 context / 128,000 output and Claude Sonnet is 1,000,000 / 16,384), while unknown IDs use `DEFAULT_META` (128,000 / 16,384). Positive supported endpoint fields are combined by `max`, so they can raise but never lower inferred limits. AIGW well-known behavior is separate: supplied positive finite `limit.context` and `limit.output` are authoritative, while absent or invalid values use `DEFAULT_META` (128,000 / 16,384). `openai-images`, `gemini-images`, and `google-imagen` custom-provider settings are image-only and intentionally contribute no LLM session models. Current direct server discovery, named proxy, and model-probe helpers attach Bobbit's canonical user agent to both types, and the named proxy currently expects an origin URL rather than an already suffixed `/v1` URL; both are documented limitations rather than changes in this scope.

## Related documents

- [Bring your own models](../bring-your-own-models.md)
- [Multi-gateway providers reference](../multi-gateway-providers.md)
- [AI Gateway routing](../ai-gateway-routing.md)
- [REST API](../rest-api.md#ai-gateways-multi-gateway)
