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

## 4. Shared resolver, cold-cache contract, and ordering

Extend the dependency-light `src/app/play-finish-sound.ts`; do not import the app state graph into it. The effective resolver is asynchronous specifically so a known project can never use the global value merely because its raw config is cold. Proposed public API:

```ts
export const PROJECT_PLAY_FINISH_SOUND_KEY = "play_agent_finish_sound";

export type ProjectPlayFinishSoundOverride = "inherit" | "on" | "off";

export interface FinishSoundSource {
  projectId?: string | null;
}

/** Global preference only. Existing BellToggle/Global Settings contract. */
export function isPlayFinishSoundEnabled(): boolean;

/**
 * Explicit source-project override -> global dataset -> default on.
 * A known cold project waits for its raw-config lookup to settle.
 */
export function isEffectivePlayFinishSoundEnabled(
  source?: FinishSoundSource,
): Promise<boolean>;

export function getProjectPlayFinishSoundOverride(
  projectId: string,
): ProjectPlayFinishSoundOverride;

export function isProjectPlayFinishSoundOverrideLoaded(
  projectId: string,
): boolean;

/** Capture the per-project revision immediately before starting a raw GET. */
export function captureProjectPlayFinishSoundRead(projectId: string): number;

/** Commit a raw GET only if its captured revision is still current. */
export function primeProjectPlayFinishSoundOverride(
  projectId: string,
  rawValue: unknown,
  capturedRevision: number,
): boolean;

/** Deduplicated, non-throwing raw-config load for session-owning projects. */
export function ensureProjectPlayFinishSoundOverrides(
  projectIds: Iterable<string | null | undefined>,
): Promise<void>;

/** Optimistically update the cache, persist, and revision-safely finalize. */
export function setProjectPlayFinishSoundOverride(
  projectId: string,
  override: ProjectPlayFinishSoundOverride,
): Promise<boolean>;
```

Internal state uses one monotonic ordering domain per project:

```ts
const projectOverrides = new Map<string, ProjectPlayFinishSoundOverride>();
const projectLoads = new Map<string, Promise<"accepted" | "stale" | "failed">>();
const projectRevisions = new Map<string, number>(); // absent means revision 0
const projectMutationRevisions = new Map<string, number>(); // latest in-flight PUT
const projectWriteTails = new Map<string, Promise<void>>(); // network ordering only
```

`projectRevisions` is the single ordering authority for every writer of `projectOverrides`; a revision is never decremented or reused. `projectMutationRevisions` only marks which revision currently owns optimistic finalization and is not a second generation counter. All writes use this protocol:

| Operation | Revision protocol |
|---|---|
| Runtime raw GET start | Capture `r = currentRevision(projectId)` immediately before `gatewayFetch`. |
| Settings raw GET start | Capture the same `r` before launching the existing raw `/config` request, not after its response arrives. |
| Raw GET completion | Accept only when the current revision still equals `r` and no PUT mutation is in flight. Parse and write the value (including `"inherit"`), then advance the revision. Otherwise discard it as stale without touching the map. Both runtime and Settings GETs call the same conditional prime helper. |
| Optimistic PUT | Snapshot the prior `{ hadEntry, value }`, advance to mutation revision `m`, record `projectMutationRevisions[id] = m`, and write the requested value before the first `await`. Even Inherit is cached explicitly as `"inherit"`. |
| PUT success | Only the completion still owning `m` may finalize: write/retain its requested value, clear its mutation marker, and advance again. A superseded success is discarded. This second advance invalidates any GET captured while the request was pending. |
| PUT failure/rollback | Restore the snapshot only when both the current revision and mutation marker still equal `m`; then clear the marker and advance again. If any newer mutation owns the project, the older failure cannot roll it back. |

A raw GET is also forbidden from committing while `projectMutationRevisions` contains the project. Thus a GET started during an optimistic PUT cannot briefly replace the immediate value before PUT success; success or rollback advances the revision and makes that response stale. The Settings select is still disabled while its save is pending, but correctness does not depend on that UI guard. `projectWriteTails` serializes all setter network PUTs per project in invocation order while each setter still performs its optimistic cache write immediately. This prevents overlapping callers from persisting an older request after a newer one; revision checks independently prevent stale success/rollback from changing the cache. Delete an idle tail after its exact final promise settles.

### Loader lifecycle

`projectLoads` contains **in-flight requests only**. `ensureProjectPlayFinishSoundOverrides` normalizes/deduplicates non-empty IDs and, for each project:

1. return immediately when `projectOverrides.has(id)` is true;
2. reuse the exact promise already in `projectLoads`, if present;
3. otherwise capture the current revision, create one raw `GET /api/projects/:id/config`, and insert its promise;
4. on an OK, parseable response, call the revision-checked prime helper;
5. in `finally`, delete the entry only when `projectLoads.get(id)` is that same promise.

A successfully accepted raw value, including missing/malformed -> `"inherit"`, is represented solely by `projectOverrides.has(id)`. Every failed HTTP/network/parse lookup leaves `projectOverrides` absent and removes the in-flight entry, so the next call performs a fresh request. Per project, ensure stops on `"accepted"`/cached success or `"failed"`; on `"stale"`, it returns if a concurrent writer populated the map, otherwise loops and starts/reuses a load at the new revision. Staleness is therefore never misclassified as lookup failure. This makes failed-then-successful retry and duplicate in-flight behavior deterministic.

### Effective resolution

For a missing/blank `projectId`, `isEffectivePlayFinishSoundEnabled` performs no project request and immediately resolves the global dataset value. For a known project:

1. if `projectOverrides.has(id)` is false, await the deduplicated ensure;
2. if the lookup succeeded, resolve exact `"on"`/`"off"`, or use the current global value for cached `"inherit"`;
3. only if the completed lookup explicitly failed and the map is still absent, use the current global value.

There is no global fallback for a merely pending or cold known-project lookup. The resolver reads the global dataset only after the project load settles, so inherited/failed lookups use the latest global setting. It produces this matrix:

| Project | Global on | Global off |
|---|---:|---:|
| Inherit/unset | on | off |
| On | on | on |
| Off | off | off |

An absent global dataset remains on. `setProjectPlayFinishSoundOverride` returns `true` only for an OK response and `false` after a revision-safe rollback on rejection/non-OK. It must not write `document.documentElement.dataset.playAgentFinishSound` or dispatch `PLAY_FINISH_SOUND_CHANGED`; both are global-only surfaces.

## 5. Data loading and lifetime

### Runtime preload

In `src/app/api.ts::refreshSessions()`, after parsing `newSessions` and before evaluating any `streaming -> idle` transitions:

```ts
await ensureProjectPlayFinishSoundOverrides(
  newSessions.map((session) => session.projectId),
);
```

The helper is non-throwing, deduplicates in-flight loads, and skips `projectOverrides.has` successes, so requests occur only for cold projects or retries after an explicit failure. This is deliberately based on all returned sessions, not `state.activeProjectId`, and therefore covers background sessions in other projects. The transition loop cannot run until each known source project's current load has either succeeded or explicitly failed; only the latter may use global fallback.

This polling preload reduces notification latency, but foreground correctness must not depend on polling having run. `RemoteAgent.playNotificationBeep` itself awaits the shared resolver for a cold known source (Section 6). No change is required at `session-manager.ts::connectToSession`: a WebSocket may attach while a config request is in flight, but an arriving foreground `agent_end` defers only its audio decision until that exact project's deduplicated load settles. This is the selected cold-cache contract and prevents either opposite-value violation after reload.

### Settings raw load

`src/app/settings-page.ts::loadProjectScopeConfig(projectId)` already receives the authoritative raw config. It must capture the sound revision immediately before starting its existing `Promise.all` requests, then conditionally prime only after the raw response parses:

```ts
const soundReadRevision = captureProjectPlayFinishSoundRead(projectId);
const [resolvedRes, rawRes] = await Promise.all([/* existing GETs */]);
// ...parse raw...
primeProjectPlayFinishSoundOverride(
  projectId,
  raw[PROJECT_PLAY_FINISH_SOUND_KEY],
  soundReadRevision,
);
```

The response may still populate `projectScopeConfigCache` for unrelated Settings fields, but a `false` return from `primeProjectPlayFinishSoundOverride` means its sound value is stale and must not replace the shared override. The select renders from the shared override cache, not directly from the possibly stale raw object. This reuses the Settings raw request without allowing it to overwrite a newer optimistic/successful PUT. `renderProjectGeneralTab` uses `isProjectPlayFinishSoundOverrideLoaded` to show a disabled/loading select until an authoritative raw value exists.

### Immediate application, navigation, and reload

- Immediate: the project setter writes the module cache synchronously, before persistence. A notification invoked immediately afterward sees `projectOverrides.has(id)` and resolves the optimistic value without project I/O.
- Navigation: the shared module cache and revision maps are not route-local, so switching sessions/projects/settings tabs retains the authoritative selection. A late raw Settings result cannot revert it.
- Reload: the project key is re-read either by `refreshSessions` for every session-owning project or by `loadProjectScopeConfig` when Project General is opened. A foreground notification that wins both races waits for its own source-project load.
- Global changes: inherited projects consult the global dataset at resolution time, so header/global Settings changes and `preferences_changed` broadcasts apply immediately without rewriting the project cache. Explicit On/Off values remain authoritative.

No new cross-tab project-config broadcast is required for the stated navigation/reload contract. An out-of-band edit in another tab becomes authoritative on reload; adding a generic `project_config_changed` event is a separate config-coherency concern rather than part of this feature.

## 6. Foreground and background source-project flow

### Audio primitive

Change the primitive in `src/app/remote-agent.ts` to:

```ts
static async playNotificationBeep(source?: FinishSoundSource): Promise<void> {
  if (!(await isEffectivePlayFinishSoundEnabled(source))) return;
  // Existing Web Audio construction, unchanged.
}
```

Callers intentionally fire-and-forget this promise. Cached/missing-project decisions incur no network wait; a known cold project defers only Web Audio construction until its lookup succeeds or explicitly fails. The badge and the rest of event handling continue synchronously while audio waits. Loader errors remain consumed by the shared helper, so callers do not acquire unhandled rejections.

### Foreground/live `agent_end`

In `RemoteAgent.handleAgentEvent`, `case "agent_end"`:

1. Resolve `sess` exactly as today with `state.gatewaySessions.find(gs => gs.id === this._sessionId)`.
2. Keep the existing `needsHumanAttentionOnIdleTransition` / `needsImmediateHumanAttention` policy.
3. When found, invoke `void RemoteAgent.playNotificationBeep(sess)`. If `sess.projectId` is known but cold, the primitive reuses or starts its raw load and cannot consult global until that load settles.
4. In the existing session-cache-miss fallback, invoke `void RemoteAgent.playNotificationBeep(undefined)`. Here the project ID is genuinely absent/unresolvable, so global fallback is valid.
5. Keep `showFaviconBadge()` outside and immediately after invoking the audio primitive in both branches; do not await audio before showing it.

This also handles cached/background `RemoteAgent` instances correctly: `this._sessionId`, not the currently selected session, chooses the source record.

### Background polling

In `src/app/api.ts::refreshSessions()`, the awaited bulk ensure stays before the transition loop. Inside the existing non-active `streaming -> idle` notification block, pass the loop record:

```ts
void RemoteAgent.playNotificationBeep(s);
showFaviconBadge();
```

Because `s.projectId` comes from the server session payload (`src/app/state.ts::GatewaySession.projectId?: string`), a project other than the currently viewed project resolves against its own override. The preceding ensure normally makes this call cache-hot; an explicitly failed preload is the only known-project case that reaches global fallback.

### Do not move the gate outward

Do not write this:

```ts
if (await isEffectivePlayFinishSoundEnabled(s)) {
  void RemoteAgent.playNotificationBeep(s);
  showFaviconBadge();
}
```

That would delay and potentially suppress favicon/unread behavior. The effective resolver belongs inside the audio primitive only. Project-specific state must not enter `notification-policy.ts`.

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

### Resolver, loader, ordering, and persistence helper

Extend `tests2/core/play-finish-sound.test.ts`:

- await all six table cases for inherit/on/off x global on/off;
- no-source fallback for global on/off performs no project GET; a known unknown project falls back globally only after a deterministic 404/rejection;
- global dataset absent defaults on;
- strict parsing of `"true"` / `"false"`; missing/invalid successful values cache Inherit;
- two simultaneous ensures for one cold project observe one deferred GET; assert neither resolves as global while it is pending, both resolve from its response, `projectLoads` is removed after settle, and another ensure uses `projectOverrides.has` without another GET;
- a first failed loader leaves no override/load entry, and a second ensure issues a new GET and successfully applies the explicit value;
- start a deferred runtime raw GET returning old Off, complete an optimistic On PUT, then release the GET; its captured revision is stale and effective behavior remains On (repeat with opposite values if useful);
- setter sends strings for On/Off and `null` for Inherit, changes effective behavior before the request settles, and advances the same revision on success;
- non-OK/rejection rollback restores the exact prior `{ hadEntry, value }` only when its mutation revision is current; a superseded failure cannot roll back a newer selection;
- setting a project override does not mutate the global dataset or emit `PLAY_FINISH_SOUND_CHANGED`.

### Foreground/background source and cold-cache regression

Add `tests2/dom/project-audio-notification-paths.test.ts` (or extend the real-path coverage in `tests2/dom/remote-agent-status.test.ts`):

- seed two `GatewaySession` records with different `projectId` values;
- drive real `RemoteAgent.handleAgentEvent({ type: "agent_end" })` and assert the source is the record matching that agent's `_sessionId`, not the selected/active project's record;
- for a cold known foreground project, hold its config GET deferred and invoke `agent_end`; assert the badge is immediate and no `AudioContext` is constructed before the GET settles;
- release explicit Off while global is On and assert no audio; in a separate deterministic case release explicit On while global is Off and assert audio occurs. These opposite-value cases prove cold cache never falls back early;
- drive two real `refreshSessions()` payloads (`streaming`, then `idle`) for a non-active session and assert the background call uses that loop session/project after awaiting its preload;
- use opposite active/source overrides so passing no source or the active project fails the assertions;
- assert badge invocation remains present for project Off.

### Settings and API

Add `tests2/dom/project-audio-settings.test.ts`:

- raw config absent renders Inherit;
- selecting On and Off sends the correct partial PUT and changes the shared resolver immediately;
- selecting Inherit sends `null` and clears the persisted key while retaining a loaded Inherit cache entry;
- deterministically start a Settings raw GET with old Off, complete an On PUT, then release the GET; `loadProjectScopeConfig` may retain unrelated raw fields, but the revision-checked sound prime is discarded and the select/resolver remain On;
- navigating away/back retains the cached state;
- a failed PUT restores the prior selection and displays failure state; a stale failed PUT cannot replace a newer choice.

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
| The first notification races project-config loading. | Polling awaits the deduplicated preload. The async audio primitive defers a foreground known-project decision until the same loader settles; only absent project IDs or explicit lookup failure use global fallback. |
| A background session uses the viewed project's setting. | Pass the actual `GatewaySession` from each notification path; never consult `activeProjectId`. |
| A project Off suppresses badges/unread state. | Keep the gate inside `playNotificationBeep`; leave `showFaviconBadge` and notification policy outside it. |
| Inherit accidentally becomes an explicit stored state. | Canonical PUT is `null`; assert raw GET omits the key and reload still inherits. |
| `/config/resolved` introduces server config/default precedence. | Parse only raw `/config`; do not add this key to project defaults. |
| Runtime/Settings raw GET overwrites a newer PUT. | Both GET paths capture the shared per-project revision before request and conditionally prime; optimistic write, success, and rollback advance that same monotonic revision. GETs cannot commit during a mutation. |
| A failed load becomes permanently cached or duplicate loads multiply. | `projectLoads` contains in-flight promises only and deletes the exact promise in `finally`; only `projectOverrides.has` records success, failure leaves no cache entry, and concurrent callers reuse one promise. |
| An older failed PUT rolls back a newer selection. | Rollback requires both the current revision and current mutation marker to match its own mutation revision. |
| Cache grows across many projects. | It holds one small string per session-owning/settings-opened project; optionally prune IDs no longer present in `state.projects` during project refresh. |
| A malformed YAML value mutes unexpectedly. | Only exact `"false"` forces off; all other unrecognized values inherit. |
| Another browser tab edits project config. | Current scope guarantees same-tab immediacy plus reload persistence. A future generic `project_config_changed` broadcast can invalidate the cache without changing resolver semantics. |
| The project key appears in the generic Commands editor. | Add it to `renderProjectScopeTab`'s `HIDDEN_KEYS`. |

## 11. Conflict-free implementation partition

The slices below have non-overlapping file ownership. Dependencies flow top-to-bottom; merge in that order.

| Slice | Ownership (exclusive) | Work |
|---|---|---|
| A — resolver/cache | `src/app/play-finish-sound.ts` | Add key/type/source contracts, async effective resolver, monotonic read/write revisions, in-flight-only loader lifecycle, and optimistic/revision-safe setter while preserving global helpers. |
| B — notification routing | `src/app/remote-agent.ts`, `src/app/api.ts` | Make only the audio primitive async/deferred, pass foreground/background source sessions, and preload overrides before polling transitions. |
| C — Settings UI | `src/app/settings-page.ts` | Capture revision before raw GET and conditionally prime afterward; render/autosave the three-state control from shared cache, hide the raw key from Commands, and render save/error state. |
| D — unit/DOM tests | `tests2/core/play-finish-sound.test.ts`, `tests2/dom/project-audio-notification-paths.test.ts`, `tests2/dom/project-audio-settings.test.ts`, `tests2/dom/bell-toggle.test.ts` | Matrix, cold-cache opposites, GET/PUT ordering, loader retry/dedupe, both source paths, UI states, badge preservation, and Bell-global regression. |
| E — API/browser tests | `tests2/integration/project-config-api.test.ts`, `tests2/browser/journeys/project-settings.journey.spec.ts`, `tests2/tests-map.json` | Raw key persistence/clear/reload and the end-to-end project mute/Bell journey; this owner alone edits the shared test map. |

Do not assign `tests2/tests-map.json` to more than one worker. No slice should edit `src/server/server.ts`, `src/server/agent/project-config-store.ts`, `src/app/main.ts`, `src/app/state.ts`, or `src/ui/components/BellToggle.ts`; their current contracts already support the design and leaving them untouched reduces merge risk.

## 12. Acceptance trace

- Three states: `renderProjectGeneralTab` select with `inherit/on/off`.
- Clear semantics: `null` partial PUT -> `ProjectConfigStore.remove`.
- Precedence/default: async `isEffectivePlayFinishSoundEnabled` matrix after authoritative source-project resolution.
- Correct source: foreground passes `sess`; background passes `s`.
- Cold known project: audio waits for deduplicated raw load; it never uses global merely because the cache is cold or pending.
- Unresolvable source: absent project ID or explicitly failed lookup -> global dataset -> default on.
- Ordering: runtime and Settings GETs share one captured-revision conditional prime; optimistic PUT, success, and conditional rollback advance the same per-project revision.
- Loader lifecycle: `projectLoads` is in-flight only; `projectOverrides.has` means successful load, failure remains retryable, and concurrent calls deduplicate.
- Immediate/navigation/reload: optimistic module cache, route-independent lifetime, revision-safe raw-config rehydration.
- Bell global: existing global helper/event/API remain the Bell's only inputs.
- Non-audio preserved: resolver is inside the Web Audio primitive; badges/unread policy are untouched.
