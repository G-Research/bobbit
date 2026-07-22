# Google Account Auth — Settings / UX Design

> **Archived design artifact — superseded.** This file preserves the pre-implementation UX
> proposal for historical rationale only. It is not the current specification, and its file
> references, state descriptions, and checklists are not authoritative implementation targets.
> All future-tense requirements below describe the historical proposal. See
> [Google OAuth & Gemini models](../google-oauth-models.md) for the shipped account-vs-key,
> Code Assist, and session-selection behavior, and [Pi runtime compatibility](../pi-runtime-compatibility.md)
> for the current Pi authentication boundary.

**Current implementation:** Google account login is implemented through Bobbit's native PKCE
flow and Code Assist runtime, and account-backed Gemini models are session-selectable. OpenAI
Codex uses `builtinModels()` plus `Models.login("openai-codex", "oauth", interaction)` with an
`AuthInteraction`; it does not use the removed `getOAuthProvider` or `OAuthLoginCallbacks`
contracts.

## Historical proposal (pre-implementation)

The retained proposal covered the Settings → Account row, API-key fallback discoverability,
model-selector states, limitation copy, reload persistence, re-authentication, logout, errors,
accessibility, and test selectors. It references the app structure as it existed when the design
was written.

---

## 1. Historical state audit at proposal time

The app had **two** settings surfaces. Only one was wired into the live UI.

| Surface | File | Wired into live UI? |
|---|---|---|
| **Then-current** Settings page (hash-routed `#settings`) | `src/app/settings-page.ts` | ✅ Yes — `SYSTEM_TABS` / `PROJECT_TABS` |
| **Legacy** `<settings-dialog>` + `ApiKeysTab` / `ProxyTab` | `src/ui/dialogs/SettingsDialog.ts` | ❌ Not in `SYSTEM_TABS`; orphaned |
| **Legacy** "Providers & Models" tab (`<provider-key-input>` per provider) | `src/ui/dialogs/ProvidersModelsTab.ts` | ❌ Not reachable from the then-current Settings |

### 1.1 The Account tab (the row we extend)

- Tab is declared in `SYSTEM_TABS` (`src/app/settings-page.ts` ~L57–65):
  `{ id: "account", label: "Account" }`.
- Rendered by `renderAccountTab()` (`src/app/settings-page.ts` ~L2948).
- Provider list is the module-level constant **`ACCOUNT_PROVIDERS`**
  (`src/app/settings-page.ts` ~L2885). Today it has exactly two entries:

  ```ts
  type AccountProviderId = "anthropic" | "openai-codex";
  ```

  Each entry is `{ id, title, description, authenticatedLabel }`.
- State module-locals: `accountStatus` (`Partial<Record<AccountProviderId,
  { authenticated: boolean; expires?: number }>>`), `accountLoading`,
  `accountReauthing` (~L2905–2907).
- `loadAccountStatus()` (~L2909) fans out one `GET /api/oauth/status?provider=<id>`
  per provider and stores `{ authenticated, expires }`.
- `handleReauthenticate(provider)` (~L2932) sets `accountReauthing`, calls
  `openOAuthDialog(provider)` from `src/app/dialogs.ts`, then refreshes status.
- Each row renders (per provider): a title + description block, a bordered
  **Status** card (`Authenticated` in green, or `Expired` / `Not authenticated`
  in destructive), an optional **Expires** line, and a single `Button` whose
  label is `Authenticating…` / `Re-authenticate` / `Log in`. **The button is
  disabled for ALL providers while any one is mid-flow** (`disabled:
  accountReauthing !== null`) to prevent concurrent `pendingFlows` collisions.

> At proposal time there was **no logout / disconnect** control in this tab. Section 6
> recorded the proposed addition of one and its server endpoint.

### 1.2 The OAuth dialog

- `openOAuthDialog(provider = "anthropic")` (`src/app/dialogs.ts` ~L466) drives
  the whole flow: `start → waiting → exchanging → done | error`.
- Provider display name is derived by a hardcoded ternary (~L484):

  ```ts
  const providerName = provider === "openai-codex" || provider === "openai" ? "OpenAI" : "Anthropic";
  ```

  The proposal called for a Google branch because anything that was not Anthropic/OpenAI
  would otherwise have been mislabelled "Anthropic".
- It opens the auth URL in a new tab (`window.open`), polls
  `GET /api/oauth/flow-status` when `callbackServer` is true, and also offers a
  **manual paste** field ("Paste redirect URL or code" / "Paste code here
  (format: code#state)").
- `checkOAuthStatus(provider)` (~L442) is the fail-open status probe used
  elsewhere.

### 1.3 Server OAuth pipeline

- Routes in `src/server/server.ts`: `GET /api/oauth/status`, `GET
  /api/oauth/flow-status`, `POST /api/oauth/start`, `POST /api/oauth/complete`,
  and new `POST /api/oauth/logout` (~L10538–10590 plus the new route).
- `src/server/auth/oauth.ts`:
  - `OAuthProviderId = "anthropic" | "openai-codex"` (~L21) and
    `OAUTH_PROVIDER_LABELS` (~L23) — **add canonical `google-gemini-cli` here**.
  - The proposal required `normalizeProvider()` to accept `google-gemini-cli` plus the
    inbound aliases `google` / `gemini`, then collapse them to canonical
    `google-gemini-cli` for provider isolation.
  - The proposal retained Anthropic's built-in PKCE flow and selected a native Bobbit Google
    PKCE flow because Pi had no Gemini Code Assist runtime. Current OpenAI Codex auth instead
    constructs `builtinModels()` and calls `Models.login("openai-codex", "oauth", interaction)`
    with an `AuthInteraction`; see [Pi runtime compatibility](../pi-runtime-compatibility.md#openai-codex-oauth-migration).
  - Credentials are written to `auth.json` keyed by canonical provider
    (`storeOAuthCredentials`, ~L147), so Google account OAuth is stored only at
    `auth.json["google-gemini-cli"]`; `oauthStatus()` (~L402) returns only
    `{ authenticated, expires }` — **never the token** (strict-OAuth contract).
- Model auth detection: `src/server/agent/model-registry.ts` —
  `PROVIDER_ENV` already maps `google`, `google-gemini-cli`, `google-vertex`
  (~L227–232); `hasOAuthCredentials(provider)` (~L284) checks `auth.json` for an
  access token; `model.authenticated` is what the picker reads.

### 1.4 The drift bug (acceptance-critical)

- At proposal time, `renderModelsTab()` contained **AI Gateway** and **Default Models**
  only, with no per-provider API-key entry in the live Settings.
- The model picker tooltip points users at a **dead path**: in
  `src/ui/dialogs/ModelSelector.ts` (~L373) the unauthenticated tooltip reads
  *"API key required — set up in Settings > Providers"*. There was no "Providers"
  tab in the then-current Settings. The proposal identified this as the goal's
  regression and called for the fix in Section 4 plus coverage in Section 9.

---

## 2. Historical proposal: Google Account row — Settings → Account

The proposal called for a **third** entry in `ACCOUNT_PROVIDERS`, rendered by the *same*
`renderAccountTab()` loop. No new layout, card, or component is introduced — the
row is structurally identical to Anthropic/OpenAI so it inherits every state,
spacing token, and affordance.

### 2.1 Provider entry (content)

```
id:                 "google-gemini-cli"   // canonical OAuth AccountProviderId member
title:              "Google OAuth"
description:        "OAuth credentials used by agent sessions to access Gemini
                     models through your Google account. Re-authenticate to
                     refresh expired tokens or switch accounts."
authenticatedLabel: "Authenticated"
```

`AccountProviderId` becomes `"anthropic" | "openai-codex" | "google-gemini-cli"`.
The plain `google` id remains reserved for the Google AI Studio / Gemini Developer
API-key provider in Models → Provider API Keys.

### 2.2 Visual layout (ASCII reference — matches existing rows exactly)

```
Anthropic OAuth
OAuth credentials used by agent sessions to access the Anthropic API…
┌────────────────────────────────────────────────────────────┐
│ Status: Authenticated                                        │
│ Expires: 19/06/2026, 14:03:55                                │
└────────────────────────────────────────────────────────────┘
[ Re-authenticate ]

OpenAI OAuth
OAuth credentials used by agent sessions to access ChatGPT…
┌────────────────────────────────────────────────────────────┐
│ Status: Not authenticated                                    │
└────────────────────────────────────────────────────────────┘
[ Log in ]

Google OAuth                                          ◀── NEW
OAuth credentials used by agent sessions to access Gemini…
┌────────────────────────────────────────────────────────────┐
│ Status: Not authenticated                                    │
└────────────────────────────────────────────────────────────┘
ℹ Gemini models that are not part of an official model API may
  be unavailable through account login. See note below.        ◀── NEW (see §5)
[ Log in ]

  Looking for an API key instead? → Models tab                 ◀── NEW (see §4)
```

### 2.3 Row ordering

Append Google **after** OpenAI (Anthropic → OpenAI → Google). This is purely
additive to the `ACCOUNT_PROVIDERS` array; the render loop and disable-all-while-
busy semantics are unchanged.

### 2.4 Consistency rationale (required sign-off — see role checklist)

1. **Primitives reused exactly:** the row uses the same `<h3 class="text-sm
   font-semibold text-foreground">` title, `text-xs text-muted-foreground`
   description, the bordered `rounded-md border border-border p-3` Status card,
   the green `text-green-600 dark:text-green-400` / `text-destructive` status
   text, and the same `Button` from `renderAccountTab()`. **No new classes.**
2. **Same row/group:** Google sits in the same `ACCOUNT_PROVIDERS.map(...)`
   stream as its peers — no new section invented.
3. **Same affordances:** identical Status / Expires lines, identical button
   states, identical disabled-while-busy behaviour.
4. **No new component:** searched `rg "ACCOUNT_PROVIDERS"`, `rg
   "renderAccountTab"` — extending the array is the established extension point;
   adding OpenAI followed the same pattern.

The only Google-specific additions are the two advisory lines (§4 API-key
pointer, §5 limitations note), and both reuse existing muted-text styling.

---

## 3. OAuth dialog — Google branch

The proposal reused the existing `openOAuthDialog("google-gemini-cli")` flow and listed these
historical changes:

- **Display name:** replace the ternary in `src/app/dialogs.ts` (~L484) with a
  lookup that maps `"google-gemini-cli"` (and inbound aliases `"google"` /
  `"gemini"`) → `"Google"`. Header becomes "Google Login"; body copy "A
  browser tab has been opened for Google authentication."
- **Flow shape:** Google's official flow is a redirect/consent → callback or
  paste-code exchange. The existing dialog already supports both the
  `callbackServer` polling path and the manual paste path, so **no new dialog
  states are needed**. If Google uses a loopback redirect (`callbackServer:
  true`), polling auto-completes; otherwise the user pastes the code, matching
  the OpenAI path at proposal time.
- **Paste-field placeholder:** keep the existing conditional copy. For Google,
  the `code#state` hint applies if no callback server; the redirect-URL hint
  applies if there is one.

No visual redesign of the dialog — it is provider-agnostic once the label is
fixed.

---

## 4. API-key fallback discoverability (fix the drift)

The historical goal required either a clear API-key entry point in the then-current
Settings or corrected UI/docs so users were not sent to a nonexistent screen. The proposal
recommended both: add a minimal API-key entry to
the live **Models** tab and fix the dead tooltip.

### 4.1 Add a "Provider API Keys" section to the Models tab

`renderModelsTab()` (`src/app/settings-page.ts` ~L2004) gains a third section,
**below** "Default Models", reusing the existing `<provider-key-input>`
component (already implemented in `src/ui/components/ProviderKeyInput.ts`, used by
the orphaned `ApiKeysTab`/`ProvidersModelsTab`).

```
Default Models
  Session   …
  Review    …
─────────────────────────────────────────────
Provider API Keys                              ◀── NEW section
Optional. Use a provider API key when you are not using account login
(e.g. Google AI Studio keys for Gemini). Keys are stored locally.

  Google     [ ••••••••••••••••  ] [Save]
  Anthropic  [ ••••••••••••••••  ] [Save]
  OpenAI     [ ••••••••••••••••  ] [Save]
```

- Render at minimum a Google `<provider-key-input .provider="google">` so the
  Gemini AI-Studio key path is reachable; ideally render the same full provider
  list the legacy `ApiKeysTab` did via `getPiAiProviders()`.
- Section header: `Provider API Keys`. Helper copy explicitly names Google AI
  Studio so users understand account-login vs key.
- This section is **API-key fallback**, distinct from the Account tab's OAuth.
  The two must not be conflated: Account = Google account / Gemini subscription;
  Models → Provider API Keys = AI Studio key.

### 4.2 Fix the dead model-selector tooltip

In `src/ui/dialogs/ModelSelector.ts` (~L373 and ~L368), change the
unauthenticated copy from *"Settings > Providers"* to the real location:

- Long tooltip: **"API key or account login required — set up in Settings →
  Account, or add a key under Settings → Models."**
- Short `KeyRound` icon tooltip: **"Authentication required"** (was "API key
  required").

This is the acceptance-critical regression fix and must have a test (§9).

### 4.3 Cross-link from the Account tab

Under the Google row's button add a muted inline link (reusing
`text-xs text-muted-foreground` + underlined `text-foreground` anchor styling
already used in the OAuth dialog's "Click here" link):

> *Looking for an API key instead?* **Go to Models → Provider API Keys.**

Clicking calls the existing deep-link helper `setActiveSettingsTab("models")`
(exported from `src/app/settings-page.ts`).

---

## 5. Copy: official Google API limitations

Consumer Gemini app subscriptions are **not** guaranteed to be usable through an
official model API. The UI must be honest about this rather than implying every
Gemini model unlocks on login.

Show a single advisory line in the Google row (muted, info-toned), between the
Status card and the button:

> **ℹ Note:** Google account login authorizes Gemini models exposed by Google's
> official model API. Models tied to a consumer Gemini app subscription may not
> be available this way. If a model stays locked after login, use a Google AI
> Studio API key under **Models → Provider API Keys**.

Styling: reuse the `text-xs text-muted-foreground` description style; the leading
"Note:" in `font-medium`. **Do not** use a destructive/red treatment — this is
informational, not an error. Color is not the only signal (the "ℹ"/"Note:"
prefix carries meaning for non-color users).

If, at implementation time, the official path supports the selected account with
no caveats, this line may be softened, but the AI-Studio-key fallback pointer
must remain.

---

## 6. Logout / disconnect

At proposal time, the Account tab had no disconnect control. The proposal added one for
all three providers, gated on `authenticated === true`.

### 6.1 UI

When `authenticated`, render a secondary destructive-outline button next to
Re-authenticate:

```
[ Re-authenticate ]  [ Log out ]
```

- "Log out" uses `Button({ variant: "outline" })` with destructive text styling
  consistent with the existing "Disconnect" button in `renderModelsTab()`
  (`border border-destructive text-destructive hover:bg-destructive/10`).
- Disabled while `accountReauthing !== null` (same busy guard).
- On click: confirm via the existing `confirmAction(...)` dialog (already used
  across the app) — *"Log out of Google? Agent sessions will lose access to
  Gemini models until you log in again."* — then call the clear endpoint and
  refresh status (`accountStatus = null; loadAccountStatus()`).

### 6.2 Server (new)

At proposal time there was no clear endpoint; only Anthropic self-cleared on a revoked
token. The proposal added:

- `POST /api/oauth/logout` `{ provider }` → normalizes the provider, deletes that
  canonical provider key from `auth.json`, calls `clearOAuthCache()`, returns
  `{ success: true }`, and never echoes token material.
- Must respect provider isolation: deleting `google-gemini-cli` must not touch
  `anthropic`, `openai-codex`, or API-key-only `google` entries.

### 6.3 Empty state after logout

Row returns to the `Not authenticated` Status, button reverts to `Log in`, the
"Log out" button disappears. This is the same render path as a never-authed
provider — no special empty state needed.

---

## 7. Reload persistence

- Credentials live server-side in `auth.json`; the client holds **no** token.
- On Settings open / tab mount, `loadAccountStatus()` re-fetches
  `GET /api/oauth/status?provider=google-gemini-cli`, so an authenticated Google
  account shows **Authenticated** after a full page reload with no extra work.
- **Acceptance:** *open Settings → Account, authenticate Google, reload Bobbit,
  still see Google authenticated.* This is satisfied by the existing status-fetch
  path the moment `google-gemini-cli` is added to `ACCOUNT_PROVIDERS` and
  accepted by `normalizeProvider()`.
- The `Expires` line renders from `status.expires`; an expired token shows
  **Expired** (destructive) and the button reads **Re-authenticate** — identical
  to the other providers.

---

## 8. Error states

Reuse the existing dialog/state machinery; no new error UI invented.

| State | Where | Treatment |
|---|---|---|
| Status fetch fails | `loadAccountStatus()` catch | Row shows **Not authenticated** (fail-safe), no crash. |
| `normalizeProvider` rejects `google-gemini-cli` or inbound alias `google` (pre-fix) | server | Surfaced as dialog `error` step. **Must not throw** post-implementation. |
| OAuth start fails (`POST /api/oauth/start`) | dialog `error` step | `<error-details>` + **Try again** button (existing). |
| Code exchange fails (`POST /api/oauth/complete`) | dialog `error` step | Server `error` string shown via `<error-details>`; truncated server-side. |
| Flow timeout (5 min) | dialog poll | "OAuth flow timed out after 5 minutes" + Try again. |
| Token expired | Account row | **Expired** status (destructive) + **Re-authenticate**. |
| Model still locked after login | model picker + §5 note | Picker keeps `opacity-45` + key icon; §5 note explains AI-Studio fallback. |
| Logout fails | new logout handler | Inline destructive text in the row: "Failed to log out — try again." (mirror `projectScopeSaveStatus === "error"` pattern). |

**Token safety:** no error path may echo the bearer token. `oauthStatus()`
returns only `{ authenticated, expires }`; error bodies are truncated in
`oauth.ts`. Keep both invariants.

---

## 9. Accessibility & test selectors

### 9.1 Accessibility

- **Status is not color-only:** the Status card always shows the *word*
  ("Authenticated" / "Expired" / "Not authenticated") in addition to color —
  preserve this for Google.
- The §5 limitations note and the §4 advisory use a textual "Note:" / "ℹ"
  prefix, not color alone.
- Buttons are real `<button>` elements (via the `Button` primitive) with text
  labels — keyboard-focusable, visible focus ring inherited from the primitive.
- The OAuth dialog's paste `Input` has a `<label>` ("Authorization Code");
  keep parity for Google.
- Contrast: status greens/destructive and muted note text already meet the app's
  token contrast; do not hardcode new colors — use existing tokens
  (`text-muted-foreground`, `text-destructive`, `text-green-600 dark:text-green-400`).

### 9.2 Historical proposed test selectors

At proposal time the rows had no stable `data-testid` hooks.

To make the Account rows testable (browser E2E per AGENTS.md), add stable hooks.
Recommended naming (kebab, provider-scoped):

| Element | `data-testid` |
|---|---|
| Account tab container | `account-tab` |
| Per-provider row | `account-row-google-gemini-cli` (and `-anthropic`, `-openai-codex`) |
| Status text | `account-status-google-gemini-cli` |
| Expires text | `account-expires-google-gemini-cli` |
| Primary auth button | `account-auth-btn-google-gemini-cli` |
| Logout button | `account-logout-btn-google-gemini-cli` |
| API-key cross-link | `account-apikey-link-google-gemini-cli` |
| Limitations note | `account-google-gemini-cli-limit-note` |
| Models-tab API-key section | `provider-keys-section` |
| Google AI Studio key input wrapper | `provider-key-input-google` |

The model-selector item already exposes `data-model-item` / `data-model-id`
(`ModelSelector.ts` ~L356); the authenticated/locked state is observable via the
`opacity-45` class and the `KeyRound` icon presence.

### 9.3 Required tests (per AGENTS.md "every user-facing feature MUST have a browser E2E")

1. **Browser E2E** (`tests/e2e/ui/`): open Settings → Account, assert the Google
   row renders with `Log in`; mock `GET /api/oauth/status?provider=google-gemini-cli` →
   `{ authenticated: true, expires }`, reload, assert **Authenticated** persists;
   assert Re-authenticate + Log out appear; assert logout returns to `Log in`.
2. **Regression test for the drift:** assert the model-selector unauthenticated
   tooltip does **not** contain the string "Settings > Providers", and that the
   Models tab renders the `provider-keys-section`. This pins the acceptance
   criterion *"tests cover the regression where a user is told to use a settings
   path that is not present in the app."*
3. **Unit/API E2E:** `normalizeProvider("google-gemini-cli")` resolves, inbound
   alias `normalizeProvider("google")` canonicalizes to `google-gemini-cli`,
   `oauthStatus("google-gemini-cli")` never returns the token, and provider
   isolation holds — logging out `google-gemini-cli` leaves `anthropic`,
   `openai-codex`, and API-key-only `google` entries intact.

---

## 10. Historical handoff checklist (completed or superseded; not current work)

- [ ] Add `"google-gemini-cli"` to `AccountProviderId` + a `Google OAuth` entry
      in `ACCOUNT_PROVIDERS` (`settings-page.ts`); keep plain `google` reserved
      for the Models-tab Google AI Studio API-key provider.
- [ ] Add Google branch to `providerName` in `openOAuthDialog` (`dialogs.ts`).
- [ ] Add Logout button + confirm + `POST /api/oauth/logout` (server) for all
      three providers.
- [ ] Add §5 limitations note + §4 API-key cross-link to the Google row.
- [ ] Add **Provider API Keys** section to `renderModelsTab()` reusing
      `<provider-key-input>` (at least Google).
- [ ] Fix the dead "Settings > Providers" tooltip in `ModelSelector.ts`.
- [ ] Add the `data-testid`s in §9.2.
- [ ] Add the three test groups in §9.3.

> Server-side credential storage, refresh, scopes, pi-ai provider capability,
> and sandbox credential propagation are out of scope for this UX artifact and
> are owned by the implementation/backend work; this doc only constrains what the
> user sees and how they reach it.
