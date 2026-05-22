# Provider Opt-In Auth UX

Design specification for direct-cloud provider opt-in, credential status, and auth gating. Final user/API behavior is documented in [../provider-opt-in-auth.md](../provider-opt-in-auth.md).

## Principles

- Bobbit must never imply Anthropic is required.
- Provider enablement and credentials are separate. Disabling a provider hides its models and stops prompts, but does not delete saved credentials.
- Auth prompts are user-action scoped: show them only when direct-cloud work needs a valid enabled provider, or when the user explicitly clicks a provider connect action.
- AI Gateway mode suppresses all Anthropic/OpenAI/Google auth gates, login prompts, expired-token prompts, and provider-token reminders.

## Existing pattern alignment

Match the current `Settings > System > Account` and dialog patterns:

- Settings rows use the current Account tab rhythm: section title, muted description, rounded `border border-border p-3` cards, compact `Button` controls, and status text inside the card.
- Dialogs use the existing `Dialog` surface from `src/app/dialogs.ts`: `width: min(480px, 92vw)`, `bg-black/50 backdrop-blur-sm`, `DialogHeader`, content with `mt-2`, and `DialogFooter` with right-aligned `Cancel` + primary action.
- OAuth flows keep the current automatic browser-tab behavior and manual paste fallback.

## Provider inventory

Render one user-facing row per vendor:

| Vendor | Provider IDs to treat as this vendor | Display title | Short description |
|---|---|---|---|
| Anthropic | `anthropic` | `Anthropic` | `Claude models through Anthropic direct cloud.` |
| OpenAI | `openai`, `openai-codex` | `OpenAI` | `GPT models, OpenAI Codex OAuth, and OpenAI image models.` |
| Google Gemini | `google`, `google-gemini-cli` | `Google Gemini` | `Gemini text models and Google image models.` |

Credential actions by vendor:

| Vendor | Primary auth label | Secondary key label |
|---|---|---|
| Anthropic | `Connect Anthropic` | none |
| OpenAI | `Connect OpenAI` | `Add API key` |
| Google Gemini | `Connect Google` | `Add API key` |

If Google OAuth is unavailable in the underlying OAuth provider library, clicking `Connect Google` shows an inline error in the card: `Google sign-in is not available in this build. Add a Gemini API key instead.` The `Add API key` action remains available.

## Settings: System > Account

### Section header

Add this section at the top of the Account tab:

- Heading: `Cloud model providers`
- Body: `Choose which cloud vendors Bobbit can use directly. Disabling a provider hides its models and suppresses auth prompts. Saved credentials are kept until you remove them.`

### AI Gateway banner

When AI Gateway is configured, show a neutral info panel above the provider rows:

- Title: `AI Gateway is handling model access`
- Body: `Cloud provider sign-in prompts are paused while AI Gateway is configured. Bobbit will not ask you to sign in to Anthropic, OpenAI, or Google Gemini.`
- Button: `Manage AI Gateway` → opens `Settings > System > Models`.

Provider rows may remain visible for manual management, but they must not show warning styling, reminder banners, or automatic reauth prompts in AI Gateway mode. If `aigw.exclusive` is on, status copy should read `Paused by AI Gateway` instead of `Needs re-authentication`.

### Provider card anatomy

Each provider card contains:

1. Header row
   - Provider title.
   - Status pill.
   - Enable switch or checkbox with visible label `Enabled` and accessible name `{Provider} enabled`.
2. Description text from the provider inventory.
3. Status detail line.
4. Credential source line when known.
5. Actions row.

Recommended test IDs:

- Account section: `settings-account-cloud-providers`
- Provider card: `provider-card-{provider}` where provider is `anthropic`, `openai`, `google`
- Enable control: `provider-enabled-{provider}`
- Status pill: `provider-status-{provider}`
- Primary connect button: `provider-connect-{provider}`
- API key button: `provider-api-key-{provider}`
- Disable/remove buttons: `provider-disable-{provider}`, `provider-remove-credential-{provider}`

### Status states and exact copy

| State | Status pill | Detail copy | Credential line | Primary actions |
|---|---|---|---|---|
| Disabled | `Disabled` | `Models hidden. Auth prompts are off.` | If credential exists: `Saved credential kept.` Otherwise omit. | `Enable`; if credential exists: `Remove credential…` |
| Enabled without credential | `Enabled · no credential` | `Connect this provider before Bobbit can use its models.` | `No credential saved.` | Primary auth label; secondary key label where available; `Disable` |
| Authenticated | `Authenticated` | `Ready. Models are available in selectors.` | `Credential: OAuth`, `Credential: API key saved`, or `Credential: environment variable` | `Re-authenticate`; secondary key label where available; `Disable`; `Remove credential…` if Bobbit owns the credential |
| Expired/needs reauth | `Needs re-authentication` | `The saved credential is expired or was rejected. Models stay hidden until you reconnect.` | `Credential: OAuth` or `Credential: API key saved` | `Re-authenticate`; `Disable`; `Remove credential…` |
| AI Gateway active | `Paused by AI Gateway` | `AI Gateway is active, so Bobbit will not prompt for this provider.` | Existing credential line may be shown neutrally. | Manual actions only; no reminders |

Use color plus text/icon; never rely on color alone. Suggested tones: neutral for Disabled/Paused, warning for Enabled without credential, positive for Authenticated, destructive/warning for Needs re-authentication.

### Interaction details

#### Enable provider

- Turning `Enabled` on persists the provider preference immediately.
- If no valid credential exists, the card moves to `Enabled · no credential` and shows auth actions.
- Do not auto-open OAuth from the settings toggle.
- Toast: `{Provider} enabled. Connect a credential to use its models.`

#### Disable provider

- Turning `Enabled` off persists the provider preference immediately.
- Do not delete OAuth tokens, API keys, environment variables, or auth files.
- Hide that provider's models from selectors and prevent it from being auto-selected.
- If any saved default model uses that provider, reset that default to `Auto (best available)`.
- Toast: `{Provider} disabled. Saved credentials were kept.`

If disabling affects a current saved default, use this confirmation first:

- Title: `Disable {Provider}?`
- Body: `{Provider} models will be removed from selectors and affected defaults will switch to Auto. Saved credentials will be kept.`
- Buttons: `Cancel`, `Disable provider`

#### Remove credential

Only remove credentials stored by Bobbit. Do not attempt to remove environment variables.

Confirmation dialog:

- Title: `Remove {Provider} credential?`
- Body: `This deletes Bobbit's saved credential for {Provider}. Provider enablement is unchanged. Environment variables are not affected.`
- Buttons: `Cancel`, `Remove credential`

Success toast: `{Provider} credential removed.`

#### API key dialog

For OpenAI and Google Gemini, `Add API key` opens a compact dialog:

- Title: `Add {Provider} API key`
- Body: `Bobbit stores this key locally and never shows it again.`
- Field label: `API key`
- Placeholder:
  - OpenAI: `Paste OpenAI API key`
  - Google Gemini: `Paste Gemini API key`
- Buttons: `Cancel`, `Save key`
- Loading button: `Saving…`
- Success toast: `{Provider} API key saved.`

If a key is already saved, keep the same dialog title and add muted copy: `A key is already saved. Saving a new key replaces it.` Never prefill the key value.

#### OAuth dialog copy

Update provider labels so the same dialog supports Anthropic, OpenAI, and Google Gemini.

- Dialog title: `Connect {Provider}`
- Loading: `Opening {Provider} sign-in…`
- Waiting copy: `A browser tab opened for {Provider}. Bobbit will continue automatically after you approve access. If it does not, paste the redirect URL or authorization code below.`
- Field label: `Redirect URL or authorization code`
- Placeholder: `Paste redirect URL or code`
- Link: `Open sign-in page`
- Buttons: `Cancel`, `Submit code`
- Exchanging: `Finishing sign-in…`
- Done: `{Provider} connected.`
- Error title/copy in body: `Could not connect {Provider}` followed by the existing error-details component.
- Error buttons: `Cancel`, `Try again`

## Direct-cloud auth gate modal

### When to show

Show this modal only when all are true:

1. AI Gateway is not configured.
2. The attempted action needs a cloud-backed model.
3. No enabled cloud provider has a valid credential.

Do not show it during gateway connect just because Anthropic is unauthenticated. Trigger it before starting work, not after an agent has spawned.

Common trigger points:

- Creating a new cloud-backed session.
- Continuing an archived cloud-backed session when its provider is disabled or invalid.
- Sending the first prompt to a dormant/preparing direct-cloud session with no valid provider.
- Selecting a cloud model whose provider is disabled or unauthenticated.

Do not show it for AI Gateway models, local/custom providers, or already-authenticated enabled providers.

### Modal copy

- Title: `Connect a model provider`
- Body: `Bobbit needs at least one enabled cloud provider before it can start this work. Choose the vendors you want to connect. You can change this later in Settings > System > Account.`

Provider rows are checkbox cards:

| Row title | Row helper |
|---|---|
| `Anthropic` | `Claude models through Anthropic direct cloud.` |
| `OpenAI` | `GPT models and OpenAI image models.` |
| `Google Gemini` | `Gemini models and Google image models.` |

Footer buttons:

- Secondary: `Cancel`
- Primary, no selection: `Select a provider` disabled
- Primary, selection present: `Connect selected`
- Primary, while processing: `Connecting…`
- Primary, after at least one success and at least one failure: `Continue with connected providers`
- Primary, complete: `Continuing…`

Optional tertiary link: `Set up AI Gateway instead` → `Settings > System > Models`; closes the modal without starting work.

Recommended test IDs:

- Modal: `cloud-auth-gate`
- Provider checkbox rows: `cloud-auth-gate-provider-{provider}`
- Primary: `cloud-auth-gate-connect`
- Cancel: `cloud-auth-gate-cancel`
- Status message: `cloud-auth-gate-status`

### Modal states

| State | Modal behavior | Row status copy |
|---|---|---|
| Initial | No provider selected. Primary disabled. | `Not selected` |
| Selected | Provider checkbox selected. | `Ready to connect` |
| Connecting | Disable provider checkboxes and footer primary. Launch OAuth/API-key flow for selected provider. | `Connecting…` |
| Connected | Enable provider preference and persist credential. | `Connected` |
| Failed | Keep modal open, show inline row error. | `Could not connect` |
| Complete | Close after short confirmation and resume original action. | `Connected` |
| Cancelled | Close modal, do not start original action. | n/a |

### Multi-select auth flow

- Process selected providers sequentially to avoid concurrent OAuth flow collisions.
- Use OAuth for the primary provider action. If the provider supports API-key fallback, expose `Use API key instead` inside the row when OAuth fails or is unavailable.
- After each successful provider auth:
  - Persist `providerEnabled.{provider}=true`.
  - Refresh provider status.
  - Mark row `Connected`.
- If all selected providers succeed, show: `Connected. Continuing your original action…` then resume the original action.
- If some succeed and some fail, show: `{Connected providers} connected. {Failed providers} still need attention.` Enable `Continue with connected providers` only if the original action can run with one of the successful providers.
- If none succeed, keep the modal open with errors and do not start work.

### Cancel safe state

Cancel must leave the user in a safe state:

- No cloud-backed session is created.
- No queued prompt is sent.
- No unauthenticated cloud model is selected.
- Provider enablement is changed only for providers that completed authentication successfully before cancellation.
- If the modal was opened from the composer or create-session flow, show a neutral toast: `Provider connection cancelled. Work was not started.`

## Model selector behavior

- Disabled cloud providers do not appear in model selectors.
- Enabled providers without a valid credential do not appear as available authenticated models.
- If a saved model preference points to a disabled or invalid provider, show the row value as `Auto (best available)` and an inline muted note: `Previous provider unavailable.`
- Do not silently pick an unauthenticated cloud model in direct-cloud mode. Route through the auth gate first.
- AI Gateway models and local/custom providers keep their existing behavior.

## Reminder and reauth rules

Show reauth prompts only when all are true:

1. AI Gateway is not configured.
2. Provider is enabled.
3. A credential exists for that provider.
4. The credential is expired, invalid, or refresh failed.

Do not prompt for disabled providers. Do not prompt for enabled providers that were never configured; use the passive `Enabled · no credential` state instead.

## Accessibility

- Provider rows are keyboard reachable and expose the provider name in every control label.
- Checkboxes use `aria-describedby` pointing to the status detail.
- Status is text plus icon, not color alone.
- Auth gate status updates use a polite live region.
- OAuth and API-key dialogs return focus to the triggering button on close.
