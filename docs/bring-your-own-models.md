# Bring your own models

Bobbit can add models from HTTP endpoints you operate, including local OpenAI-compatible servers. This is the supported path when a model needs to appear in the normal picker, be selected for a session, and be written into the agent's `models.json`. It does not expose a host-local service to sandbox containers: a sandboxed agent needs an endpoint it can already reach.

For the API contract, see [Multi-gateway providers](multi-gateway-providers.md). For enterprise AI Gateway routing, well-known discovery, and security constraints, see [AI Gateway routing](ai-gateway-routing.md).

## Add a local or generic endpoint

1. Start an endpoint that implements `GET /v1/models` and OpenAI chat completions.
2. Open **Settings → Models → AI Gateways**.
3. Choose **Add gateway** and enter a provider name and URL.
4. Select **OpenAI-compatible**, leave it enabled, then choose **Test**.
5. When the reported models are expected, choose **Save** and select `<name>/<model-id>` in the model picker or as a default model.

Use a URL reachable by the Bobbit server. Discovery accepts either `http://host:port` or `http://host:port/v1` and normalizes OpenAI-compatible discovery to `/v1`. Use the origin form when using Bobbit's named browser proxy: it currently appends `/v1` itself, so a saved `/v1` URL would produce `/v1/v1/...` on that proxy path. A gateway name becomes the durable provider key, so use a stable, safe identifier such as `local`, `ollama`, or `lab-vllm`.

A generic endpoint never uses Bedrock routing. In particular, an endpoint model called `claude-local` remains an OpenAI-completions model. Its generated provider block has no AIGW headers, although current server-side discovery, proxy, and model-probe helpers still send the canonical `User-Agent: Bobbit/<version>` to every gateway type; this is a current implementation limitation, not an AIGW/Bedrock routing signal.

## Optional gateway authentication

The API key field accepts the same request-time value forms used by generated model configuration:

| Value | Meaning |
|---|---|
| Empty / absent | Send no `Authorization` header. An empty edit preserves a saved key; use **Clear key** to remove one. |
| Literal | Use the literal as the bearer token unless an environment variable with that exact name is set. |
| Environment name | Resolve the named environment variable for each request when it is present. |
| `!command` | Run the command for each request and use trimmed standard output as the bearer token. |
| `none` | Explicit anonymous mode; send no bearer token. |

Keys and expressions are stored privately under the gateway's stable ID. Gateway lists, status responses, preference broadcasts, and the UI expose only a configured marker, never the expression or resolved token. Resolution happens immediately before discovery, proxy, probe, or title traffic. A command that fails, times out, exits nonzero, or yields empty output fails closed with `Unable to resolve API key for gateway "<name>"`; Bobbit does not retry unauthenticated.

A credential is sent only to the gateway's configured origin. Do not put credentials in the URL: URLs with embedded credentials, fragments, or credential-like query parameters are rejected.

## Choose the gateway type

| Type | Use it for | Discovery and routing | Picker effect |
|---|---|---|---|
| `openai-compatible` | Local or generic OpenAI-compatible endpoints | Calls normalized `/v1/models`; preserves raw model IDs; uses `openai-completions` only | Merges with built-in providers and other enabled generic gateways |
| `aigw` | An enterprise AI Gateway implementing the OpenCode well-known contract | Well-known-first discovery, authoritative provider routes, legacy AIGW fallback, and AIGW headers | Exclusive while enabled |

An `aigw` gateway is a singleton named exactly `aigw`. While it is enabled, built-in cloud providers and enabled OpenAI-compatible gateway models are intentionally suppressed. Existing custom-provider behavior is unchanged. Disable—not delete—the AIGW row to return to the merged gateway picker.

## Connection states

A saved, enabled gateway has one of these states:

- **Connected** (`reachable`): discovery succeeded and returned models.
- **No models** (`empty`): discovery succeeded but returned none. This is authoritative; stale models are removed.
- **Unreachable**: discovery, authentication, or transport failed. Bobbit retains the matching last-published provider block so existing models can remain selectable during a brief restart or outage.
- **Disabled**: the row is saved but deliberately contributes no models.

Retained models are used only when both the gateway name and normalized base URL match the saved row. They are not carried over after a rename or endpoint change. Fix the endpoint or credential and use **Refresh**; do not treat an unreachable state as an empty catalog.

## Existing single AI Gateway installs

At boot, Bobbit migrates a legacy nonempty `aigw.url` to one enabled `{ name: "aigw", type: "aigw" }` row. The migration is idempotent. If `modelGateways` already exists, including an empty list, it is authoritative and stale legacy keys are removed. Existing `aigw/<model>` preferences remain valid, and unchanged single-gateway `models.json` output is preserved.

Legacy `/api/aigw/status`, configure, refresh, and proxy endpoints still operate on the `aigw` row for older clients.

## Limits and report-only findings

- Generic gateway discovery starts with `inferMeta(modelId)`. Recognized families keep their family baseline (for example, current GPT-5.6 is 272,000 context / 128,000 output and Claude Sonnet is 1,000,000 / 16,384); unknown IDs use the `DEFAULT_META` baseline of 128,000 / 16,384. Positive endpoint context/output fields are combined with those baselines by `max`, so they can raise a limit but never lower it. There are no per-model overrides in this feature.
- AIGW well-known discovery is separate: supplied positive finite `limit.context` and `limit.output` are authoritative; absent or invalid values use `DEFAULT_META` (128,000 / 16,384).
- A generic endpoint can accept image payloads even when inferred metadata does not label an unfamiliar model as vision-capable. This is a picker-labeling limitation, not a guarantee of model capability.
- Existing custom-provider settings with type `openai-images`, `gemini-images`, or `google-imagen` are image-generation configuration. They may save successfully but contribute zero LLM session models. They are intentionally not consolidated with gateways.
- Native Ollama, llama.cpp, and vLLM discovery types, per-model metadata overrides, image-provider changes, and host-service exposure to sandboxes are out of scope.
- The named `/api/aigw/:name/v1/*` proxy currently requires saving the gateway origin rather than an already suffixed `/v1` URL. Generic generated model blocks remain header-free, but direct server discovery, proxy, and probe helpers currently attach Bobbit's canonical user agent to generic endpoints too.

## Troubleshooting

See [Debugging](debugging.md#gateway-is-unreachable-but-the-picker-should-keep-last-known-models) for outage retention, credentials, naming, and Claude-shaped local model IDs.
