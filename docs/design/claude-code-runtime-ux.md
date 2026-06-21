# Claude Code Runtime UX

**Status:** Design artifact only. No production code or tests changed in this task.
**Scope:** Model/runtime picker UX, Settings UI, readiness/auth states, existing-session runtime switching, reload metadata, and browser E2E coverage for adding a local Claude Code session runtime.

---

## 1. Current UI audit

Bobbit currently exposes model selection as a **model picker**, not a separate runtime picker.

| Surface | File / component | Current behavior |
|---|---|---|
| Active-session footer model button | `src/ui/components/AgentInterface.ts` → `<agent-interface>` → `modelButton` | Opens `ModelSelector`, then calls `session.setModel(model)` immediately. |
| Shared model picker dialog | `src/ui/dialogs/ModelSelector.ts` → `<agent-model-selector>` | Fetches `GET /api/models`, sorts, renders provider badges, unauthenticated icon, and disabled rows when `sessionSelectable === false`. |
| Default session/review/naming models | `src/app/settings-page.ts` → `renderModelsTab()` / `renderModelRow()` | Uses the same `ModelSelector`; persists `default.sessionModel`, `default.reviewModel`, etc. via `PUT /api/preferences`. |
| Settings navigation | `src/app/settings-page.ts` / `src/app/routing.ts` | Live settings are the hash-routed Settings page. `SettingsDialog.ts` and `ProvidersModelsTab.ts` are legacy/orphan surfaces; do **not** extend those for this feature. |
| Session model persistence | `src/server/agent/session-store.ts`, `src/server/server.ts`, `src/app/routing.ts` | Server persists `modelProvider` / `modelId`; browser also has local `session.<id>.model` cache. No runtime discriminator exists yet. |

Design constraint: **Claude Code should appear in the existing model picker as a local runtime-backed option**, not as an OpenAI-compatible/API provider and not as a billing-bypass concept.

---

## 2. Product language

Use this language consistently:

- Provider badge: **Claude Code (local)**
- Detail copy: **Runs through your local Claude Code CLI and existing Claude Code login.**
- Terms copy: **You are responsible for complying with Anthropic and Claude Code terms.**
- Avoid: “free Claude”, “billing bypass”, “API workaround”, or “Anthropic API key not needed”.

---

## 3. Model/runtime picker design

### 3.1 Server model entries

`GET /api/models` should include synthetic Claude Code entries from `src/server/agent/model-registry.ts` when the feature is enabled, for example:

```ts
{
  provider: "claude-code",
  id: "sonnet",
  name: "Claude Code Sonnet",
  api: "claude-code-runtime",
  runtime: "claude-code",
  localRuntime: true,
  authenticated: status.ready,
  sessionSelectable: status.ready,
  sessionUnavailableReason: status.reason,
  contextWindow: 200_000,
  maxTokens: 8192,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}
```

Recommended MVP aliases: `sonnet`, `opus`, and `default` if Claude Code can resolve its own default. The stored pref/session value is `claude-code/sonnet` etc.

### 3.2 Picker row

Change `src/ui/dialogs/ModelSelector.ts` only; reuse the existing row structure.

For Claude Code rows:

- Main label: `Claude Code Sonnet`
- Secondary/metadata label: `sonnet`
- Badges, right side:
  - Provider label `Claude Code (local)`; no separate `Local runtime` pill.
  - `Claude Code (local)` using `Badge(..., "outline")`
- Tooltip when ready: `Runs through your local Claude Code CLI and existing Claude Code login.`
- Tooltip when unavailable: use `sessionUnavailableReason` from the server.

Visual behavior should match existing disabled-row conventions:

- Ready: normal opacity, `cursor-pointer`.
- CLI missing / auth required / probe error: `sessionSelectable: false`, `cursor-not-allowed`, `opacity-45`.
- Do **not** use the current generic `Account only` badge for Claude Code. Add a generic unavailable badge renderer that can show:
  - `CLI missing`
  - `Login required`
  - `Probe failed`
  - `Unavailable`

### 3.3 Search and sorting

- Searching `claude`, `claude code`, `local`, `sonnet`, or `opus` should find these rows. Include `model.name`, `provider`, `id`, and `runtimeLabel` in the existing search text.
- Sort ready Claude Code rows near authenticated Anthropic Claude models, not at the very bottom. Unavailable Claude Code rows should remain below selectable rows, matching existing `sessionSelectable === false` behavior.

---

## 4. Readiness and unavailable states

Add a server-side readiness probe route in `src/server/server.ts`:

```http
GET /api/claude-code/status
POST /api/claude-code/status/refresh
```

Response shape:

```ts
type ClaudeCodeStatus = {
  available: boolean;        // executable found and --version succeeded
  authenticated: boolean;    // lightweight auth probe succeeded, if feasible
  ready: boolean;            // available && authenticated
  checking: boolean;
  executablePath: string;    // resolved preference, default "claude"
  version?: string;
  modelAliases: string[];    // e.g. ["claude-opus-4-8", "default", "sonnet", "opus"]
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  reason?: "cli_missing" | "auth_required" | "probe_failed";
  message?: string;          // safe, user-facing explanation
  checkedAt?: number;
};
```

Probe behavior:

1. Run configured executable with `--version`.
2. If version succeeds, run the lightest feasible authenticated check with a short timeout and no tools. If this is too costly or unreliable, return `authenticated: false`, `reason: "auth_required"`, and guide the user to run `claude login` / open Claude Code locally.
3. Cache status briefly (30–60s) so opening the picker does not repeatedly spawn probes.

Picker copy by state:

| State | Picker row | Tooltip |
|---|---|---|
| Ready | Enabled, `Claude Code (local)` provider label | `Runs through your local Claude Code CLI and existing Claude Code login.` |
| CLI missing | Disabled, `CLI missing` badge | `Claude Code CLI was not found. Set the executable path in Settings → Models → Claude Code.` |
| Not authenticated | Disabled, `Login required` badge | `Claude Code is installed but not authenticated. Run Claude Code login locally, then refresh status.` |
| Probe failed | Disabled, `Probe failed` badge | Server-provided safe `message`, with Settings path. |

---

## 5. Settings UI

Extend the live Settings Models tab: `src/app/settings-page.ts` → `renderModelsTab()`.

Place a new **Claude Code (local)** section:

1. After **AI Gateway**.
2. Before **Default Models**.

This keeps runtime/provider setup above defaults, matching the existing AI Gateway → Defaults → Provider API Keys flow.

### 5.1 Section layout

Use existing primitives/classes from `renderModelsTab()`:

- Section wrapper: `flex flex-col gap-4`, `data-testid="claude-code-section"`
- Heading: `h3.text-sm.font-semibold.text-foreground`
- Body copy: `p.text-sm.text-muted-foreground`
- Inputs: same `input` class used by Gateway URL.
- Buttons: same primary/outline/destructive styles already used in the Models tab.

### 5.2 Status card

Show one bordered status card:

- Ready: green dot, `Ready`, version, command path.
- CLI missing: destructive text, `Claude Code CLI not found`.
- Login required: warning/destructive text, `Claude Code login required`.
- Checking: spinner text, `Checking Claude Code…`.

Actions:

- `Refresh status` → `POST /api/claude-code/status/refresh`
- `Test authentication` if automatic auth probe is not run by default

### 5.3 Settings fields

Persist via existing `PUT /api/preferences`:

| Field | Preference key | UI |
|---|---|---|
| Executable path | `claudeCode.executablePath` | Text input, placeholder `claude` |
| Default model alias | `claudeCode.defaultModel` | Select: `claude-opus-4-8`, `default`, `sonnet`, `opus` |
| Permission mode | `claudeCode.permissionMode` | Select: `default`, `acceptEdits`, `bypassPermissions` |
| Allow bypass mode | `claudeCode.allowBypassPermissions` | Explicit checkbox/confirmation gate |

Permission mode copy:

- `default`: `Claude Code asks for permissions normally.`
- `acceptEdits`: `Accept edit operations when Claude Code requests them.`
- `bypassPermissions`: `Bypasses Claude Code permission prompts. Only enable if you understand the local-machine risk.`

`bypassPermissions` must be disabled unless `claudeCode.allowBypassPermissions === true`. Selecting/turning on bypass should show an explicit warning; never default to it.

---

## 6. Existing Pi-backed session behavior

Do **not** silently switch an existing Pi-backed session to Claude Code.

Current path to change: `src/ui/components/AgentInterface.ts` → `modelButton` callback currently calls `session.setModel(m)` immediately.

New behavior:

1. Determine current session runtime from server metadata (`session.runtime`, default `"pi"`).
2. Determine selected model runtime from `model.runtime ?? "pi"`.
3. If runtimes match, use existing `setModel` path.
4. If runtimes differ, **do not send** WS `set_model`.
5. Show confirmation dialog:

Title: `Start a Claude Code session?`
Body: `This session is running on the standard Bobbit runtime. Claude Code uses a different local runtime, so Bobbit will start a new session with the same project and working directory. The current session will stay unchanged.`
Primary: `Start new session`
Secondary: `Cancel`

On confirm, call `POST /api/sessions` with:

```json
{
  "cwd": "<current cwd>",
  "projectId": "<current projectId>",
  "runtime": "claude-code",
  "model": "claude-code/sonnet"
}
```

Then connect to the returned session. For goal/team/staff sessions, the implementation should either pass the existing contextual IDs when safe or disable cross-runtime restart with copy: `Start a new top-level Claude Code session from this working directory.`

The reverse direction (Claude Code session → Pi model) should use the same pattern and copy, replacing runtime names.

---

## 7. Reload metadata preservation

Add runtime metadata to `PersistedSession` in `src/server/agent/session-store.ts`:

```ts
runtime?: "pi" | "claude-code";
claudeCodeSessionId?: string;
claudeCodeModelAlias?: string;
claudeCodeExecutable?: string;
claudeCodePermissionMode?: "default" | "acceptEdits" | "bypassPermissions";
```

Server response changes:

- `src/server/server.ts` `GET /api/sessions/:id` returns the runtime fields.
- Session list responses should include at least `runtime`, `modelProvider`, `modelId`, and `claudeCodeModelAlias` so the sidebar/footer can render without waiting for WS state.
- `src/server/agent/session-manager.ts` restore path chooses the bridge based on `ps.runtime` and passes `claudeCodeSessionId` for resume when available.

Client changes:

- `src/app/session-manager.ts` threads `runtime` into `<agent-interface>` during both slow-path and cached fast-path reconnects.
- `src/ui/components/AgentInterface.ts` adds a compact footer title/badge when `runtime === "claude-code"`, e.g. button title `Claude Code (local) · sonnet`; visible footer text can remain short (`sonnet`) to preserve space.
- `src/app/routing.ts` local `saveSessionModel()` cache can remain as a fallback, but server runtime metadata is authoritative after reload.

Acceptance: after browser reload, a Claude Code session still shows `Claude Code (local)` metadata, uses the Claude Code bridge, and never rehydrates as a Pi-backed `anthropic/*` session.

---

## 8. Exact implementation touchpoints

### UI

- `src/ui/dialogs/ModelSelector.ts`
  - Render `runtime/localRuntime` badges.
  - Replace hardcoded `Account only` unavailable badge with model-provided unavailable label.
  - Include runtime label in search.
- `src/ui/components/AgentInterface.ts`
  - Add `runtime` / `runtimeLabel` properties.
  - Intercept runtime-mismatched model selections and show restart/new-session confirmation instead of calling `setModel`.
  - Add footer title/label for Claude Code local sessions.
- `src/app/settings-page.ts`
  - Add Claude Code section to `SYSTEM_TABS`’ existing `models` tab via `renderModelsTab()`.
  - Load/save `claudeCode.*` prefs and status.
- `src/app/session-manager.ts`
  - Preserve/thread session runtime metadata through slow path, cached fast path, and reload.
  - Start new session on confirmed runtime switch.
- `src/app/routing.ts`
  - Keep local model cache as fallback; do not treat it as authoritative for runtime.

### Server/API

- `src/server/server.ts`
  - Add `/api/claude-code/status` and refresh route.
  - Accept `runtime` / `model` in `POST /api/sessions`.
  - Return runtime metadata in session list/detail responses.
- `src/server/agent/model-registry.ts`
  - Emit synthetic `claude-code/*` models with readiness/selectability metadata.
- `src/server/agent/preferences-store.ts`
  - No structural change needed; document and validate `claudeCode.*` keys at API boundaries.
- `src/server/agent/session-store.ts`
  - Persist runtime and Claude Code resume fields.
- `src/server/agent/session-manager.ts`
  - Select `ClaudeCodeBridge` vs `RpcBridge` from `PersistedSession.runtime` / create opts.
  - Restore Claude Code sessions without falling back to Pi.
- `src/server/agent/session-setup.ts`
  - Replace direct `new RpcBridge(...)` construction with a bridge factory or runtime branch.
- `src/server/ws/protocol.ts` / `src/server/ws/handler.ts`
  - Guard `set_model`: runtime-mismatched changes should return a clear error if the UI misses the guard.

---

## 9. Browser E2E scenarios

Add browser E2E coverage under `tests/e2e/ui/`.

1. **Picker visibility / labeling**
   - Stub `/api/models` with ready `claude-code/sonnet`.
   - Open active-session model picker.
   - Assert row contains `Claude Code Opus 4.8` and `Claude Code (local)`, and does not contain a separate `Local runtime` pill or numeric local limits.

2. **Unavailable CLI state**
   - Stub status/models with `sessionSelectable: false`, reason `cli_missing`.
   - Assert row is disabled, has `CLI missing`, and click does not select it.

3. **Not-authenticated state in Settings**
   - Navigate to `#/settings/system/models`.
   - Stub `/api/claude-code/status` as `available: true`, `authenticated: false`.
   - Assert status card says `Claude Code login required` and `Refresh status` is visible.

4. **Settings save**
   - Edit executable path, model alias, and permission mode.
   - Assert `PUT /api/preferences` writes `claudeCode.executablePath`, `claudeCode.defaultModel`, and `claudeCode.permissionMode`.
   - Assert `bypassPermissions` cannot be selected until explicit allow/confirmation is enabled.

5. **Existing Pi session requires new session**
   - Open a Pi-backed session.
   - Pick `claude-code/sonnet`.
   - Assert no WS `set_model` frame is sent.
   - Assert confirmation dialog appears.
   - Confirm and assert `POST /api/sessions` includes `runtime: "claude-code"` and `model: "claude-code/sonnet"`.

6. **Reload metadata preservation**
   - Create/open a session whose REST metadata includes `runtime: "claude-code"`, `modelProvider: "claude-code"`, `modelId: "sonnet"`.
   - Reload page.
   - Assert footer still identifies `Claude Code (local)` and the selected model remains `sonnet`.

7. **Status refresh**
   - In Settings, click `Refresh status`.
   - Assert `POST /api/claude-code/status/refresh` is called and the status card updates from checking to ready/error.

Fixture-level additions should also cover `ModelSelector.ts` behavior in `tests/ui-fixtures/model-selector-fixture.spec.ts`, mirroring existing session-unavailable tests.

---

## 10. Consistency rationale

- Reuses the existing model picker instead of introducing a second runtime picker.
- Reuses `sessionSelectable === false` disabled-row semantics, but improves the badge copy to support non-account runtime failures.
- Places Claude Code setup in live `Settings → Models`, next to AI Gateway and default model preferences, because it controls a model/session runtime rather than a general OAuth account row.
- Keeps the active-session footer compact; runtime distinction lives in badge/title and confirmation flow.
- Prevents silent runtime switching by making runtime changes create a new session or explicitly stop at a confirmation dialog.
