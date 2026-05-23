# Provider Opt-In Auth

Bobbit can run through a managed AI Gateway or connect directly to cloud model vendors. Provider opt-in auth controls the direct-cloud path: users choose which vendors Bobbit may use, and Bobbit only prompts for credentials when an enabled vendor is actually needed.

This prevents Anthropic from being treated as mandatory, keeps local/custom providers unchanged, and keeps AI Gateway deployments free of vendor-specific auth prompts.

## Provider scope

The opt-in system covers these direct-cloud vendors:

| Vendor | User-facing id | Model provider ids | Credential sources |
|---|---|---|---|
| Anthropic | `anthropic` | `anthropic` | Anthropic OAuth, `providerKey.anthropic`, `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN` |
| OpenAI | `openai` | `openai`, `openai-codex` | OpenAI Codex OAuth, `providerKey.openai`, `providerKey.openai-codex`, `OPENAI_API_KEY` |
| Google Gemini | `google` | `google`, `google-gemini-cli` | `providerKey.google`, `providerKey.google-gemini-cli`, `GEMINI_API_KEY`, `GOOGLE_API_KEY` |

AI Gateway (`aigw`), local providers, and custom providers are not controlled by these toggles.

## Enablement and credentials are separate

Provider enablement is stored as system preferences:

```text
providerEnabled.anthropic
providerEnabled.openai
providerEnabled.google
```

A provider must be enabled before Bobbit can select its direct-cloud models. Credentials are stored separately, so disabling a provider is reversible:

- Disabling a provider hides its models and suppresses auth prompts.
- Disabling does **not** delete OAuth tokens, API keys, environment variables, or host-managed tokens.
- Saving an API key or completing OAuth enables the matching provider unless the caller explicitly opts out.
- Removing a credential does **not** disable the provider; the status becomes enabled without credential.
- Removing a credential only deletes Bobbit-owned credentials. Environment variables and host-managed tokens stay outside Bobbit's control.

A startup migration may enable vendors that already have credentials so existing users keep working. Users can opt out afterward by disabling the provider.

## Provider statuses

`GET /api/cloud-providers/status` returns one status row per vendor. The Settings → System → Account tab renders the same states.

| Status | Meaning | Prompt/model behavior |
|---|---|---|
| `disabled` | User opted out of the vendor. Credentials may still exist. | Models hidden; no auth, refresh, or reminder prompts. |
| `enabled_without_credential` | Vendor is enabled, but no usable credential source exists. | Models are not selectable as authenticated; direct-cloud work opens the auth gate if no other enabled provider is authenticated. |
| `authenticated` | Vendor is enabled and a usable credential exists. | Models may be selected and auto-selected. |
| `expired` | Vendor is enabled and an OAuth credential exists but is expired. | Needs reauth; models stay unavailable until refreshed/reconnected. |
| `invalid` | Vendor is enabled and the saved credential was definitively rejected. | Needs reauth; transient provider failures do not mark this state. Host/env-managed sources recover automatically after rotation. |
| `oauth_unavailable` | Google OAuth data exists, but this build cannot use Google OAuth at runtime. | Use a Gemini API key instead. |
| `aigw_bypass` | AI Gateway is configured. | Vendor auth UX is paused entirely. |

`credentialTypes` identifies the source class without exposing secrets: `oauth`, `api_key`, `env`, or `host_token`.

## Settings behavior

Use **Settings → System → Account → Cloud model providers** to opt in or out of Anthropic, OpenAI, and Google Gemini independently.

- Turning **Enabled** on only records the preference. It does not auto-open OAuth.
- Turning **Enabled** off keeps saved credentials and resets any matching default session/image model to Auto.
- **Connect** starts OAuth when supported.
- **Add API key** stores a Bobbit-owned key for OpenAI or Google Gemini.
- **Remove credential…** deletes Bobbit-owned OAuth/API-key credentials for that vendor and leaves enablement unchanged.
- Host/env-managed credentials are shown as host-managed and cannot be removed from Bobbit.

When AI Gateway is configured, the Account tab shows providers as **Paused by AI Gateway**. Connect and API-key actions are suppressed, and Bobbit does not show vendor reauth reminders. Enablement rows may still be visible for later direct-cloud use.

## Direct-cloud auth gate

When Bobbit is not using AI Gateway and an action would start cloud-backed work without any enabled authenticated cloud provider, Bobbit opens a **Connect a model provider** modal before starting work.

The gate can appear before:

- creating a session or goal assistant,
- starting a team,
- continuing an archived cloud-backed session,
- sending a prompt to a direct-cloud session whose provider is unavailable,
- generating images with no authenticated image provider.

The gate does not appear for AI Gateway models, local/custom providers, or already-authenticated enabled providers.

Gate behavior:

- The user can select one or more vendors.
- Selected providers are connected sequentially to avoid overlapping OAuth flows.
- OAuth is used when available; OpenAI and Google also offer API-key entry. Google defaults to the API-key path because OAuth is unavailable in this build.
- After at least one selected provider connects successfully, Bobbit retries or resumes the original action.
- If connection cannot be verified, the modal stays open and the original action is not started.
- Cancel closes the modal without creating a session, sending a prompt, queueing work, or selecting an unauthenticated cloud model.

If the server catches the same condition on a work-starting REST call, it returns `409 { code: "cloud_auth_required", status }`. The UI handles that by opening the gate and retrying only after successful auth.

## AI Gateway mode

AI Gateway is the bypass boundary. When `aigw.url` is configured:

- `/api/cloud-providers/status` reports `mode: "aigw"` and `authGateRequired: false`.
- Direct-cloud vendor auth gates are not shown.
- Settings auth actions for Anthropic/OpenAI/Google are hidden or paused.
- Expired-token prompts and provider-token reminders are suppressed.
- Gateway connection only authenticates to Bobbit's gateway; it does not start Anthropic OAuth just because Anthropic is unauthenticated.

AI Gateway model discovery, routing, and local/custom provider behavior remain unchanged.

## OAuth and API-key support

| Vendor | OAuth | API key |
|---|---|---|
| Anthropic | Supported. The dialog opens Claude sign-in and accepts a pasted redirect URL/code fallback. | Recognized from stored key/env sources. |
| OpenAI | Supported through the `openai-codex` OAuth provider. Automatic callback completion is used when the provider supplies a callback server; manual paste fallback remains available. | Supported. |
| Google Gemini | Not available in this build. `/api/oauth/start` returns 501 with API-key guidance, and status reports `oauthSupported: false`. | Supported through Gemini/Google API keys and host/env-managed credentials. |

OAuth/API-key status endpoints never return bearer tokens or key values.

## Model and image selection

Model selectors respect provider enablement and credential status.

- Disabled cloud providers are omitted from direct-cloud model lists.
- Enabled providers without valid credentials can appear as unavailable rows, but cannot be selected.
- Saved defaults that point at disabled or invalid providers are ignored and the UI falls back to Auto.
- Default session model selection uses only authenticated selectable models.
- Default image model selection uses only authenticated image models.
- Image generation fails closed with the auth gate instead of silently selecting an unauthenticated OpenAI or Google model.

This is why provider toggles affect both chat models and image models.

## Implementation map

Primary modules:

- `src/server/agent/cloud-provider-auth.ts` — provider ids, enablement preferences, redacted status, credential source detection.
- `src/server/auth/oauth.ts` — OAuth provider normalization, flow start/complete/status, Google OAuth unavailable path.
- `src/server/agent/model-registry.ts` — provider-aware text model availability and default selection.
- `src/server/agent/image-generation.ts` — provider-aware image model availability and credential invalidation on definitive auth failures.
- `src/app/settings-page.ts` — Settings → System → Account provider cards.
- `src/app/dialogs.ts` — OAuth dialogs, API-key dialogs, direct-cloud auth gate.

Related API reference: [REST API — Cloud provider auth](rest-api.md#cloud-provider-auth) and [REST API — OAuth](rest-api.md#oauth).
