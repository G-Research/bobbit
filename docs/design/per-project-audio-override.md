# Per-project agent-finish audio override

## 1. Scope and invariants

Add a project-owned override for the existing agent-finish beep while leaving every non-audio notification unchanged.

The required precedence is:

1. explicit override on the notification source project;
2. global `playAgentFinishSound` preference;
3. default **on** when the global preference is absent.

The source project is the project that owns the session which finished. It is never the current route, `state.activeProjectId`, the selected Settings scope, or the project currently visible in the sidebar.

Two invariants constrain the implementation:

- `document.documentElement.dataset.playAgentFinishSound` remains a mirror of the **global** preference only.
- Project muting gates only `RemoteAgent.playNotificationBeep(...)`. Callers must continue to invoke `showFaviconBadge()` independently, so favicon badges, unread state, and `notification-policy.ts` behavior are not suppressed.

## 2. Existing architecture

### Global preference and header bell

- `src/app/play-finish-sound.ts`
  - `isPlayFinishSoundEnabled(): boolean` reads the global dataset and defaults to `true`.
  - `setPlayFinishSoundEnabled(enabled: boolean): Promise<void>` updates the dataset synchronously, dispatches `PLAY_FINISH_SOUND_CHANGED`, and persists to `PUT /api/preferences`.
- `src/ui/components/BellToggle.ts::BellToggle`
  - `_onChange`, `_toggle`, and `render` use those global helpers for icon, tooltip, and action.
- `src/app/settings-page.ts`
  - `loadGeneralSettings()`, `togglePlayFinishSound()`, and `renderGeneralTab()` own the global Settings checkbox.
- `src/app/main.ts` applies the global preference at authenticated boot and in its `visibilitychange` refresh.
- `src/app/remote-agent.ts::_applyPreferences(prefs)` applies `preferences_changed` broadcasts to the same global dataset/event.
- `src/server/server.ts::handleApiRoute()` handles `GET/PUT /api/preferences`; `PreferencesStore` persists it under server state.

None of those global/header semantics should become project-aware.

### Current beep paths

There are two production notification paths and one audio primitive:

1. Foreground/live event: `src/app/remote-agent.ts::RemoteAgent.handleAgentEvent`, `case "agent_end"`, resolves `sess` by `this._sessionId` and calls `RemoteAgent.playNotificationBeep()`.
2. Background polling: `src/app/api.ts::refreshSessions()`, in the `streaming -> idle` loop for a non-active session, calls `RemoteAgent.playNotificationBeep()`.
3. `src/app/remote-agent.ts::RemoteAgent.playNotificationBeep(): void` currently reads only the global dataset before constructing Web Audio oscillators.

Both call sites separately call `showFaviconBadge()` after the audio call. That separation must remain.

### Project configuration

- `src/server/server.ts::handleApiRoute()` already implements:
  - `GET /api/projects/:id/config` as the raw project-only config;
  - `PUT /api/projects/:id/config` as a partial update;
  - removal when a flat value is `null` or `""`.
- `src/server/agent/project-config-store.ts::ProjectConfigStore`
  - `get(key: string): string | undefined`
  - `set(key: string, value: string): void`
  - `remove(key: string): void`
  - `getAll(): ProjectConfig`
  - each `set`/`remove` auto-saves `.bobbit/config/project.yaml`.
- `src/app/settings-page.ts::loadProjectScopeConfig(projectId)` already loads both raw `/config` and `/config/resolved` into `projectScopeConfigCache`.
- `src/app/settings-page.ts::renderProjectGeneralTab(projectId)` is the target UI surface.

The generic flat-key route/store already provides the required persistence and clearing behavior. No server production change or `ProjectConfigStore` default is needed.

## 3. Persisted key and wire semantics

Use this project config key:

```yaml
play_agent_finish_sound: "true"   # force on
# or
play_agent_finish_sound: "false"  # force off
```

The client constant is:

```ts
export const PROJECT_PLAY_FINISH_SOUND_KEY = "play_agent_finish_sound";
```

Semantics:

| UI state | PUT body | On-disk state |
|---|---|---|
| Inherit global | `{ "play_agent_finish_sound": null }` | key removed |
| On | `{ "play_agent_finish_sound": "true" }` | explicit string scalar |
| Off | `{ "play_agent_finish_sound": "false" }` | explicit string scalar |

`null` is the canonical client clear value. The existing route calls `ProjectConfigStore.remove`, so selecting **Inherit global** must not store an `"inherit"` sentinel or an empty/default value. Existing projects have no key and therefore inherit automatically.

Only exact strings `"true"` and `"false"` are accepted by the client parser. A missing, malformed, or future value is treated as inherited rather than unexpectedly silencing audio.

The runtime must read the raw `/config` response, not `/config/resolved`. The resolved endpoint cascades project config through server `project.yaml` and built-in defaults; this feature instead has a specific cross-store precedence of raw project override -> global `PreferencesStore` -> on. Adding this key to `ProjectConfigStore.DEFAULTS` or reading a server-level resolved value would violate that contract.

## 4. Shared resolver and cache

Extend the dependency-light `src/app/play-finish-sound.ts`; do not import the app state graph into it. Proposed public API:

```ts
export const PROJECT_PLAY_FINISH_SOUND_KEY = "play_agent_finish_sound";

export type ProjectPlayFinishSoundOverride = "inherit" | "on" | "off";

export interface FinishSoundSource {
  projectId?: string | null;
}

/** Global preference only. Existing BellToggle/Global Settings contract. */
export function isPlayFinishSoundEnabled(): boolean;

/** Project override -> global dataset -> default on. */
export function isEffectivePlayFinishSoundEnabled(
  source?: FinishSoundSource,
): boolean;

export function getProjectPlayFinishSoundOverride(
  projectId: string,
): ProjectPlayFinishSoundOverride;

export function isProjectPlayFinishSoundOverrideLoaded(
  projectId: string,
): boolean;

/** Seed the cache from a raw GET /config field. */
export function primeProjectPlayFinishSoundOverride(
  projectId: string,
  rawValue: unknown,
): void;

/** Deduplicated, non-throwing raw-config preload for session-owning projects. */
export function ensureProjectPlayFinishSoundOverrides(
  projectIds: Iterable<string | null | undefined>,
): Promise<void>;

/** Optimistically update the cache, persist, and roll back on failure. */
export function setProjectPlayFinishSoundOverride(
  projectId: string,
  override: ProjectPlayFinishSoundOverride,
): Promise<boolean>;
```

Internal data:

```ts
const projectOverrides = new Map<string, ProjectPlayFinishSoundOverride>();
const projectLoads = new Map<string, Promise<void>>();
```

`Map.has(projectId)` distinguishes a successfully loaded inherited value from an unresolved project. `ensureProjectPlayFinishSoundOverrides` should normalize/deduplicate non-empty IDs, reuse `projectLoads`, fetch `GET /api/projects/:id/config` once per uncached project, and prime from `config[PROJECT_PLAY_FINISH_SOUND_KEY]`. It must consume failures rather than fail `refreshSessions`; unresolved data deliberately falls back to the global preference, and a later poll may retry.

`isEffectivePlayFinishSoundEnabled` is synchronous because notification events cannot wait for I/O:

```ts
if (source?.projectId && projectOverrides.has(source.projectId)) {
  const override = projectOverrides.get(source.projectId);
  if (override === "on") return true;
  if (override === "off") return false;
}
return isPlayFinishSoundEnabled();
```

This produces the complete matrix:

| Project | Global on | Global off |
|---|---:|---:|
| Inherit/unset | on | off |
| On | on | on |
| Off | off | off |

A missing source session, missing `projectId`, unknown project, or not-yet-resolved cache entry uses the global result. An absent global dataset remains on.

`setProjectPlayFinishSoundOverride` updates `projectOverrides` before its first `await`, then directly uses dependency-light `gatewayFetch` to PUT the string or `null`. It returns `true` only for an OK response. On rejection/non-OK it restores the previous cache entry and returns `false`, allowing Settings to show an error. Use a per-project mutation generation (or disable the select while saving) so an older failed request cannot roll back a newer selection.

The project setter must not write `document.documentElement.dataset.playAgentFinishSound` and must not dispatch `PLAY_FINISH_SOUND_CHANGED`; both are global-only surfaces.

## 5. Data loading and lifetime

### Runtime preload

In `src/app/api.ts::refreshSessions()`, after parsing `newSessions` and before evaluating any `streaming -> idle` transitions:

```ts
await ensureProjectPlayFinishSoundOverrides(
  newSessions.map((session) => session.projectId),
);
```

The helper is non-throwing and caches successful results, so the extra requests occur only when a project first appears in the live session set. This is deliberately based on all returned sessions, not `state.activeProjectId`, and therefore covers background sessions in other projects.

The first application refresh has no prior status transition to notify, giving the preload time to establish reload behavior before later transitions. A newly discovered project is also preloaded before its first transition loop. If loading is genuinely impossible, the documented unknown/unresolved fallback is global.

### Settings preload

`src/app/settings-page.ts::loadProjectScopeConfig(projectId)` already receives the authoritative raw config. After parsing `raw`, call:

```ts
primeProjectPlayFinishSoundOverride(
  projectId,
  raw[PROJECT_PLAY_FINISH_SOUND_KEY],
);
```

This avoids a duplicate Settings-only config request. `renderProjectGeneralTab` can use `isProjectPlayFinishSoundOverrideLoaded` to show a disabled/loading select until the raw fetch finishes.

### Immediate application, navigation, and reload

- Immediate: the project setter changes the module cache synchronously, before persistence completes. The next foreground or background notification uses it immediately.
- Navigation: the module cache and the Settings cache are not route-local, so switching sessions/projects/settings tabs retains the selection.
- Reload: the project key is re-read either by `refreshSessions` for every session-owning project or by `loadProjectScopeConfig` when Project General is opened.
- Global changes: inherited projects consult the global dataset on every resolution, so header/global Settings changes and `preferences_changed` broadcasts apply immediately without rewriting the project cache. Explicit On/Off values remain authoritative.

No new cross-tab project-config broadcast is required for the stated navigation/reload contract. An out-of-band edit in another tab becomes authoritative on reload; adding a generic `project_config_changed` event is a separate config-coherency concern rather than part of this feature.

## 6. Foreground and background source-project flow

### Foreground/live `agent_end`

Change the primitive signature in `src/app/remote-agent.ts` to:

```ts
static playNotificationBeep(source?: FinishSoundSource): void;
```

Its first line gates Web Audio through `isEffectivePlayFinishSoundEnabled(source)`.

In `RemoteAgent.handleAgentEvent`, `case "agent_end"`:

1. Resolve `sess` exactly as today with `state.gatewaySessions.find(gs => gs.id === this._sessionId)`.
2. Keep the existing `needsHumanAttentionOnIdleTransition` / `needsImmediateHumanAttention` policy.
3. Call `RemoteAgent.playNotificationBeep(sess)` when the session is found.
4. In the existing cache-miss fallback, call `RemoteAgent.playNotificationBeep(undefined)` so unresolved sessions use the global preference.
5. Keep `showFaviconBadge()` outside and after the audio call in both branches.

This also handles cached/background `RemoteAgent` instances correctly: `this._sessionId`, not the currently selected session, chooses the source record.

### Background polling

In `src/app/api.ts::refreshSessions()`, inside the existing non-active `streaming -> idle` notification block, pass the loop record:

```ts
RemoteAgent.playNotificationBeep(s);
showFaviconBadge();
```

Because `s.projectId` comes from the server session payload (`src/app/state.ts::GatewaySession.projectId?: string`), a project other than the currently viewed project resolves against its own override.

### Do not move the gate outward

Do not write this:

```ts
if (isEffectivePlayFinishSoundEnabled(s)) {
  RemoteAgent.playNotificationBeep(s);
  showFaviconBadge();
}
```

That would incorrectly suppress favicon/unread behavior. The effective resolver belongs inside the audio primitive only.

## 7. Project Settings UI

Implement the control in `src/app/settings-page.ts::renderProjectGeneralTab(projectId)`, preferably in a **Notifications** section before Working Directory:

```html
<select data-testid="project-play-finish-sound">
  <option value="inherit">Inherit global</option>
  <option value="on">On</option>
  <option value="off">Off</option>
</select>
```

Use the shared `ProjectPlayFinishSoundOverride` values directly. On change:

1. mark a per-project save-status map as saving and disable the select;
2. invoke `setProjectPlayFinishSoundOverride(projectId, value)` and render immediately after invocation so the optimistic cache/value is visible;
3. clear saving on success;
4. show an inline error/toast on failure after the helper rolls back.

The control auto-saves; it must not join the existing Worktree/Sandbox pending Save button because that would delay effective behavior.

Also add `PROJECT_PLAY_FINISH_SOUND_KEY` to the local `HIDDEN_KEYS` in `renderProjectScopeTab(projectId)`. Otherwise the raw custom key would appear again under Commands -> Other Commands and create two competing editors.

`settings-page.ts::getActiveScope()` aliases Headquarters General to System. Preserve that existing system-scope behavior: the global General checkbox remains the control for Headquarters/system sessions, while normal registered project scopes expose the new override. Runtime resolution remains safe for any project ID and falls back globally when no raw override exists.

## 8. Header bell remains strictly global

`src/ui/components/BellToggle.ts` should require no production change.

- `connectedCallback`, `_onChange`, `_toggle`, icon choice, and tooltip continue to use `isPlayFinishSoundEnabled()` with no project argument.
- `_toggle` continues to call `setPlayFinishSoundEnabled(next)` and only `PUT /api/preferences`.
- A viewed project set to Off does not change a globally-on Bell or its “Mute agent finish beeps” tooltip.
- A viewed project set to On does not change a globally-off Bell or its “Unmute agent finish beeps” tooltip.
- Toggling the Bell updates the global fallback only. Explicit project On/Off still wins for notification audio.

Likewise, keep `src/app/settings-page.ts::renderGeneralTab()` and `togglePlayFinishSound()` global-only, and keep `src/app/main.ts` / `RemoteAgent._applyPreferences` writing only the global dataset.

## 9. Test recommendations

All new tests must be registered in `tests2/tests-map.json` where applicable.

### Resolver and persistence helper

Extend `tests2/core/play-finish-sound.test.ts`:

- six table cases for inherit/on/off x global on/off;
- no-source and unknown-project fallback for global on and off;
- global dataset absent defaults on;
- strict parsing of `"true"` / `"false"`; missing/invalid values inherit;
- loader deduplicates concurrent project GETs and loads projects independently;
- setter sends strings for On/Off and `null` for Inherit;
- setter changes effective behavior before the request settles and rolls back on non-OK/rejection;
- setting a project override does not mutate the global dataset or emit `PLAY_FINISH_SOUND_CHANGED`.

### Foreground/background source regression

Add `tests2/dom/project-audio-notification-paths.test.ts` (or extend the real-path coverage in `tests2/dom/remote-agent-status.test.ts`):

- seed two `GatewaySession` records with different `projectId` values;
- drive real `RemoteAgent.handleAgentEvent({ type: "agent_end" })` and assert `playNotificationBeep` receives the record matching that agent's `_sessionId`, not the selected/active project's record;
- drive two real `refreshSessions()` payloads (`streaming`, then `idle`) for a non-active session and assert the background call receives that loop session/project;
- use opposite overrides/global values so passing no source or the active project would fail the assertions;
- assert badge invocation remains present for project Off.

### Settings and API

Add `tests2/dom/project-audio-settings.test.ts`:

- raw config absent renders Inherit;
- selecting On and Off sends the correct partial PUT and changes the shared resolver immediately;
- selecting Inherit sends `null` and clears the override;
- navigating away/back retains the cached state;
- a failed PUT restores the prior selection and displays failure state.

Extend `tests2/integration/project-config-api.test.ts`:

- PUT `"true"` and `"false"`, GET raw round-trip;
- PUT `null`, GET confirms the key is absent;
- reconstruct `ProjectConfigStore` over the same filesystem to prove On/Off and clearing survive reload.

Extend `tests2/dom/bell-toggle.test.ts`:

- prime the active project's override to Off while global is on and assert Bell/title remain globally on;
- prime project On while global is off and assert Bell/title remain globally off;
- clicking still PUTs only `{ playAgentFinishSound: ... }` to `/api/preferences`.

### Browser journey

Extend `tests2/browser/journeys/project-settings.journey.spec.ts` with a serial scenario:

1. register a project and navigate to `#/settings/<projectId>/general`;
2. verify Inherit, select Off, reload, and verify Off persists;
3. instrument `window.AudioContext`, finish a session owned by that project, and verify no audio instance is created while the global Bell still shows the globally-on state;
4. set global off through the Bell, select project On, finish another turn, and verify audio occurs while the Bell remains globally off;
5. select Inherit and verify `GET /api/projects/:id/config` no longer contains `play_agent_finish_sound`;
6. clean up the session/project and restore the global preference.

This single journey covers source-project mute behavior, immediate application, reload persistence, clearing, and the header-global invariant.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The first notification races project-config loading. | Await the deduplicated preload before polling transition checks; initial hydration has no previous transition. Foreground cache misses intentionally fall back global. |
| A background session uses the viewed project's setting. | Pass the actual `GatewaySession` from each notification path; never consult `activeProjectId`. |
| A project Off suppresses badges/unread state. | Keep the gate inside `playNotificationBeep`; leave `showFaviconBadge` and notification policy outside it. |
| Inherit accidentally becomes an explicit stored state. | Canonical PUT is `null`; assert raw GET omits the key and reload still inherits. |
| `/config/resolved` introduces server config/default precedence. | Parse only raw `/config`; do not add this key to project defaults. |
| Settings raw fetch and an optimistic write race. | Disable the select until raw config is loaded and while saving; guard rollback with a per-project mutation generation. |
| Cache grows across many projects. | It holds one small string per session-owning/settings-opened project; optionally prune IDs no longer present in `state.projects` during project refresh. |
| A malformed YAML value mutes unexpectedly. | Only exact `"false"` forces off; all other unrecognized values inherit. |
| Another browser tab edits project config. | Current scope guarantees same-tab immediacy plus reload persistence. A future generic `project_config_changed` broadcast can invalidate the cache without changing resolver semantics. |
| The project key appears in the generic Commands editor. | Add it to `renderProjectScopeTab`'s `HIDDEN_KEYS`. |

## 11. Conflict-free implementation partition

The slices below have non-overlapping file ownership. Dependencies flow top-to-bottom; merge in that order.

| Slice | Ownership (exclusive) | Work |
|---|---|---|
| A — resolver/cache | `src/app/play-finish-sound.ts` | Add key/type/source contracts, parser/cache/preloader/setter, and effective resolver while preserving global helpers. |
| B — notification routing | `src/app/remote-agent.ts`, `src/app/api.ts` | Change the audio primitive signature, pass foreground/background source sessions, and preload overrides before polling transitions. |
| C — Settings UI | `src/app/settings-page.ts` | Prime from raw config, render/autosave the three-state control, hide the raw key from Commands, and render save/error state. |
| D — unit/DOM tests | `tests2/core/play-finish-sound.test.ts`, `tests2/dom/project-audio-notification-paths.test.ts`, `tests2/dom/project-audio-settings.test.ts`, `tests2/dom/bell-toggle.test.ts` | Matrix, cache/write behavior, both source paths, UI states, badge preservation, and Bell-global regression. |
| E — API/browser tests | `tests2/integration/project-config-api.test.ts`, `tests2/browser/journeys/project-settings.journey.spec.ts`, `tests2/tests-map.json` | Raw key persistence/clear/reload and the end-to-end project mute/Bell journey; this owner alone edits the shared test map. |

Do not assign `tests2/tests-map.json` to more than one worker. No slice should edit `src/server/server.ts`, `src/server/agent/project-config-store.ts`, `src/app/main.ts`, `src/app/state.ts`, or `src/ui/components/BellToggle.ts`; their current contracts already support the design and leaving them untouched reduces merge risk.

## 12. Acceptance trace

- Three states: `renderProjectGeneralTab` select with `inherit/on/off`.
- Clear semantics: `null` partial PUT -> `ProjectConfigStore.remove`.
- Precedence/default: `isEffectivePlayFinishSoundEnabled` matrix.
- Correct source: foreground passes `sess`; background passes `s`.
- Unknown session/project: omitted/unloaded source -> global dataset -> default on.
- Immediate/navigation/reload: optimistic module cache, route-independent lifetime, raw-config rehydration.
- Bell global: existing global helper/event/API remain the Bell's only inputs.
- Non-audio preserved: resolver is inside the Web Audio primitive; badges/unread policy are untouched.
