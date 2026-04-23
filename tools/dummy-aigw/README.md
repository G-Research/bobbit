# Dummy AI Gateway

A tiny local server that **pretends to be an on-prem AI Gateway** so you can test
Bobbit's *AI Gateway* configuration flow outside the secure zone.

It proxies a couple of Claude models through to `api.anthropic.com` using a real
`ANTHROPIC_API_KEY` that lives only on this process, and exposes both protocols
Bobbit speaks to gateways:

| Endpoint | Protocol | Used by Bobbit for |
| --- | --- | --- |
| `GET /v1/models` | OpenAI-style list | Model discovery during configure |
| `POST /v1/chat/completions` | OpenAI chat completions (SSE streaming) | Non-Claude models / title generation |
| `POST /aws/model/{modelId}/converse-stream` | AWS Bedrock Converse Stream (binary EventStream) | Claude models (main agent traffic) |
| `POST /aws/model/{modelId}/converse` | AWS Bedrock Converse (JSON) | Non-streaming fallback |

## Quick start

From the repo root:

```bash
cd tools/dummy-aigw
ANTHROPIC_API_KEY=sk-ant-... node server.js
```

Output:

```
Dummy AI Gateway listening on http://127.0.0.1:1111
Configure Bobbit with this URL (append /v1):
    http://127.0.0.1:1111/v1
Available models:
  - aws/us.anthropic.claude-haiku-4-5
  - aws/us.anthropic.claude-sonnet-4-5
```

Then in Bobbit: **Settings → AI Gateway → URL** =
`http://127.0.0.1:1111/v1` → *Save*. The two models above should appear in the
model picker.

## Env vars

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | *(required)* | Upstream auth. |
| `PORT` | `1111` | Bobbit's startup probe tries `http://localhost:1111/v1` first. |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to listen on all interfaces. |
| `AIGW_AUTH_TOKEN` | *(none)* | If set, incoming requests must include `Authorization: Bearer <token>`. |
| `MODELS` | `aws/us.anthropic.claude-haiku-4-5,aws/us.anthropic.claude-sonnet-4-5` | Comma-separated list of model IDs to expose. |

## Model ID format

The `aws/us.anthropic.claude-*` prefix matches what production gateways expose.
Bobbit strips `aws/` when it sees a Claude model and sends the Bedrock-style ID
(`us.anthropic.claude-haiku-4-5`) in the `/aws/model/{id}/converse-stream` URL.
This gateway strips `us.` and `anthropic.` further and forwards
`claude-haiku-4-5` to Anthropic.

If you want to test with raw Anthropic model IDs, set
`MODELS=claude-haiku-4-5,claude-sonnet-4-5` — they'll still route through the
same translators.

## What it does *not* do

- **No SigV4 verification.** Any AWS-style request is accepted; the gateway is
  meant for local testing only.
- **No retries, rate limiting, or caching.** One-shot proxy to upstream.
- **No OpenAI-compatible image generation / embeddings / audio.** Chat
  completions only.

## Dependencies

The server depends on `@anthropic-ai/sdk`, `@smithy/eventstream-codec`, and
`@smithy/util-utf8`. All three are already present in Bobbit's root
`node_modules` (the Bobbit server itself uses them), so you can run
`node server.js` directly without a separate `npm install` when launching from
the monorepo root.

If you want to run this tool in isolation elsewhere, `npm install` inside this
directory will pull them in.
