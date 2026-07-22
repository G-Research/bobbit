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
 * A known cold project waits for only its raw-config lookup to settle.
 */
export function isEffectivePlayFinishSoundEnabled(
  source?: FinishSoundSource,
): Promise<boolean>;

/** Newest pending value, otherwise the confirmed baseline; undefined if neither exists. */
export function getProjectPlayFinishSoundOverride(
  projectId: string,
): ProjectPlayFinishSoundOverride | undefined;

/** Whether an accepted raw GET or successful PUT has established a baseline. */
export function isProjectPlayFinishSoundOverrideLoaded(
  projectId: string,
): boolean;

/** Capture the per-project revision immediately before starting a raw GET. */
export function captureProjectPlayFinishSoundRead(projectId: string): number;

/** Establish a confirmed baseline only if the captured raw GET is still current. */
export function primeProjectPlayFinishSoundOverride(
  projectId: string,
  rawValue: unknown,
  capturedRevision: number,
): boolean;

/** Deduplicated, non-throwing raw-config load for one session-owning project. */
export function ensureProjectPlayFinishSoundOverride(
  projectId: string,
): Promise<boolean>;

/** Enqueue immediately, serialize persistence, and settle this request independently. */
export function setProjectPlayFinishSoundOverride(
  projectId: string,
  override: ProjectPlayFinishSoundOverride,
): Promise<boolean>;
```

Internal state separates server-confirmed state from optimistic visibility:

```ts
interface PendingProjectSoundMutation {
  id: number;
  value: ProjectPlayFinishSoundOverride;
}

const projectConfirmedOverrides = new Map<string, ProjectPlayFinishSoundOverride>();
const projectPendingMutations = new Map<string, PendingProjectSoundMutation[]>();
const projectLoads = new Map<string, Promise<"accepted" | "stale" | "failed">>();
const projectRevisions = new Map<string, number>(); // absent means revision 0
const projectNextMutationIds = new Map<string, number>();
const projectWriteTails = new Map<string, Promise<void>>();
```

`projectConfirmedOverrides` is the authoritative per-project baseline: it changes only after an accepted raw GET or a successful serialized PUT. It is never assigned an optimistic value and is never rolled back from a per-write snapshot. The visible override is derived, not independently authoritative: use the value of the newest entry in `projectPendingMutations[id]`, or `projectConfirmedOverrides.get(id)` when the queue is empty. Thus removing any settled mutation recomputes visibility from the newest mutation still pending, then from the confirmed baseline. Even Inherit is represented explicitly as `"inherit"` in both places; only persistence uses `null`.

`projectRevisions` is the monotonic read-validity authority. A revision is never decremented or reused. The protocol is:

| Operation | Baseline, queue, and revision protocol |
|---|---|
| Runtime or Settings raw GET start | Capture `r = currentRevision(projectId)` immediately before starting that raw request. |
| Raw GET completion | Accept only if `currentRevision(projectId) === r` **and** the pending queue is empty. Parse the raw value, establish it (including `"inherit"`) as `projectConfirmedOverrides[id]`, then advance the revision. Otherwise discard it without changing baseline or visibility. Both GET paths call the same helper. |
| Setter enqueue | Allocate a unique mutation ID, append `{ id, value }`, and advance the revision synchronously before the first `await`. The appended newest value becomes visible immediately even though its transport may be waiting behind earlier writes. |
| Serialized PUT success | When that mutation reaches the head of the transport chain and returns OK, assign its value to `projectConfirmedOverrides[id]`. This mirrors the server's newly confirmed state even when newer mutations remain pending. |
| Serialized PUT failure | Leave `projectConfirmedOverrides[id]` unchanged. Never restore a snapshot, because any earlier optimistic value may itself have failed. |
| Either settlement | Remove that exact mutation, advance the revision, and derive visibility again from the newest still-pending mutation or the confirmed baseline. Delete an empty pending queue. |

The revision checks close both GET races. Enqueue advances the revision, so a GET started before an optimistic choice cannot later establish an old baseline. The explicit non-empty-queue check prevents a GET started after an enqueue from establishing any baseline during mutations. Settlement advances again, so a GET captured while mutations were pending cannot become valid merely because the last mutation was removed before its response arrived. An accepted GET also advances, so two reads captured at the same revision cannot both establish competing baselines. A stale runtime load loops only when neither a pending visible value nor a confirmed baseline now exists.

`projectWriteTails` preserves per-project PUT transport order, including response handling and queue removal, while different projects remain independent. Each setter gets its own result promise. It resolves `true` exactly when that mutation's own PUT returned OK and `false` for that mutation's own rejection/non-OK, after its baseline update/no-op and exact queue removal have completed. An older setter can therefore resolve `true` while a newer pending choice remains visible; no newer request changes the older promise's result. The tail consumes failures so later writes still run, and deletes itself only when the exact last chained promise settles.

The Settings select is enabled only after `isProjectPlayFinishSoundOverrideLoaded(projectId)` is true, so normal UI writes always begin with an authoritative baseline. The queue protocol is still safe for a cold programmatic setter: its pending value is immediately usable; success establishes the baseline, while failure leaves the baseline absent and the next effective resolution retries the raw GET rather than inventing an inherited state.

### Queue correctness proofs

Assume all named mutations are enqueued before their transports settle; visibility always follows the newest still-pending mutation.

- **Inherit -> On fails -> Off fails:** baseline starts Inherit. Enqueue On then Off, so Off is visible. On fails: baseline stays Inherit; removing On leaves pending Off visible. Off fails: baseline stays Inherit; removing Off exposes Inherit. The server and final visible state are both Inherit.
- **Explicit Off -> On fails -> Inherit fails:** baseline starts Off. Enqueue On then Inherit, so Inherit is visible. On fails: baseline stays Off; removing On leaves pending Inherit visible. Inherit fails: baseline stays Off; removing Inherit exposes Off. The server and final visible state are both explicit Off.
- **Mixed A-success/B-failure/A-failure/B-success:** enqueue `m1=A`, `m2=B`, `m3=A`, `m4=B`; newest `m4` makes B visible. Serialized `m1` succeeds, so baseline becomes A; `m2` and `m3` fail, so baseline remains A; pending `m4` keeps B visible throughout those removals. `m4` succeeds, so baseline becomes B, and removing it exposes B. The server's last successful value and final visible state are both B.

These outcomes do not depend on a completion "owning" the latest optimistic revision. Every serialized response authoritatively updates (success) or preserves (failure) the baseline for its own server request, while the queue independently owns current optimistic visibility.

### Loader lifecycle

`projectLoads` contains **in-flight requests only**. `ensureProjectPlayFinishSoundOverride(projectId)` handles one normalized, non-empty project ID:

1. return `true` immediately when a newest pending value or confirmed baseline exists;
2. reuse the exact promise already in `projectLoads`, if present;
3. otherwise capture the current revision, create one raw `GET /api/projects/:id/config`, and insert its promise;
4. on an OK, parseable response, call the revision-checked prime helper;
5. in `finally`, delete the entry only when `projectLoads.get(id)` is that same promise.

A successfully accepted raw value, including missing/malformed -> `"inherit"`, establishes `projectConfirmedOverrides[id]`. Every failed HTTP/network/parse lookup leaves the baseline absent and removes the in-flight entry, so the next call performs a fresh request. Ensure returns `true` for an accepted load or when a concurrent mutation/baseline now supplies a visible value, and `false` only after an explicit failure with neither available. On `"stale"`, it returns `true` if a pending value or baseline exists; otherwise it loops and starts/reuses a load at the new revision. Staleness is therefore never misclassified as lookup failure. This makes failed-then-successful retry and duplicate in-flight behavior deterministic.

### Effective resolution

For a missing/blank `projectId`, `isEffectivePlayFinishSoundEnabled` performs no project request and immediately resolves the global dataset value. For a known project:

1. read the newest pending override, otherwise the confirmed baseline;
2. if neither exists, await `ensureProjectPlayFinishSoundOverride(projectId)` and read again;
3. resolve exact `"on"`/`"off"`, or use the current global value for confirmed/pending `"inherit"`;
4. only if the completed lookup explicitly failed and no pending value or baseline exists, use the current global value.

There is no global fallback for a merely pending or cold known-project lookup. A pending optimistic selection is already a valid immediate audio decision and requires no I/O. Otherwise the resolver reads the global dataset only after the source project's load settles, so inherited/failed lookups use the latest global setting. It produces this matrix:

| Project | Global on | Global off |
|---|---:|---:|
| Inherit/unset | on | off |
| On | on | on |
| Off | off | off |

An absent global dataset remains on. `setProjectPlayFinishSoundOverride` must not write `document.documentElement.dataset.playAgentFinishSound` or dispatch `PLAY_FINISH_SOUND_CHANGED`; both are global-only surfaces.

## 5. Data loading and lifetime

### Runtime preload

In `src/app/api.ts::refreshSessions()`, after parsing `newSessions`, opportunistically start a deduplicated load for each distinct known project and do not await any of them:

```ts
for (const projectId of new Set(newSessions.map((session) => session.projectId))) {
  if (projectId) void ensureProjectPlayFinishSoundOverride(projectId);
}
```

The helper is non-throwing, so these fire-and-forget preloads cannot create unhandled rejections. General polling must immediately continue to update session state and evaluate every transition; it never waits for one project, much less an unbounded fan-out across all returned sessions. A slow or failed unrelated project therefore cannot delay status transitions, badges, unread behavior, or the refresh promise.

The preload is only a latency optimization and correctness must not depend on it. `RemoteAgent.playNotificationBeep(source)` awaits `isEffectivePlayFinishSoundEnabled(source)`, which awaits only that source project's exact deduplicated load. If opportunistic polling already started the load, audio reuses it; other project loads are irrelevant and may remain pending. No change is required at `session-manager.ts::connectToSession`: an arriving foreground `agent_end` likewise defers only its own audio decision until that one project lookup settles. This preserves the no-early-global-fallback contract without coupling general refresh/transitions to optional audio configuration.

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

The response may still populate `projectScopeConfigCache` for unrelated Settings fields, but a `false` return from `primeProjectPlayFinishSoundOverride` means its sound value is stale and must not replace the confirmed baseline or pending queue. The select renders the shared derived value (newest pending mutation, otherwise confirmed baseline), not the possibly stale raw object. This reuses the Settings raw request without allowing it to overwrite an enqueued or settled PUT. `renderProjectGeneralTab` uses `isProjectPlayFinishSoundOverrideLoaded` to show a disabled/loading select until an authoritative baseline exists; once saving starts, the pending value renders immediately.

### Immediate application, navigation, and reload

- Immediate: the project setter appends to the pending queue synchronously, before persistence. A notification invoked immediately afterward resolves the newest pending value without project I/O.
- Navigation: the shared confirmed-baseline, pending-queue, and revision maps are not route-local, so switching sessions/projects/settings tabs retains the current selection. A late raw Settings result cannot revert it.
- Reload: the project key is opportunistically requested by `refreshSessions` for session-owning projects or read by `loadProjectScopeConfig` when Project General is opened. A notification that wins both races awaits only its own source-project load; general polling never awaits preloads.
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

In `src/app/api.ts::refreshSessions()`, evaluate transitions without awaiting the opportunistic project loads. Inside the existing non-active `streaming -> idle` notification block, pass the loop record:

```ts
void RemoteAgent.playNotificationBeep(s);
showFaviconBadge();
```

Because `s.projectId` comes from the server session payload (`src/app/state.ts::GatewaySession.projectId?: string`), a project other than the currently viewed project resolves against its own override. The audio promise reuses the source project's preload if one exists or starts that one load itself; it never waits for unrelated project loads. Only an explicit failure of that source lookup reaches global fallback. The refresh and badge remain synchronous with respect to audio.

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
4. show an inline error/toast on failure after that mutation is removed and the select recomputes from a newer pending value or the confirmed baseline.

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
- strict parsing of `"true"` / `"false"`; missing/invalid successful values establish an Inherit baseline;
- two simultaneous ensures for one cold project observe one deferred GET; assert neither resolves as global while it is pending, both resolve from its response, `projectLoads` is removed after settle, and another ensure uses the confirmed baseline without another GET;
- a first failed loader leaves no baseline/load entry, and a second ensure issues a new GET and successfully applies the explicit value;
- start a deferred runtime raw GET returning old Off, enqueue and settle an On PUT, then release the GET; its captured revision is stale and confirmed/visible behavior remains On;
- start a GET after a mutation is enqueued, settle the last mutation before releasing the GET, and prove the queue check plus settlement revision still discard that read;
- setter sends strings for On/Off and `null` for Inherit, exposes the latest enqueue before transport starts, and resolves each returned promise from that request's own OK/non-OK result;
- assert PUT transports for one project start strictly in invocation order even though all optimistic values become visible immediately, while different projects are independent;
- with confirmed Inherit, enqueue On then Off, reject both in transport order, and assert the exact visibility sequence `Off -> Off -> Inherit`, both setter promises resolve `false`, and final baseline/visible state match the server's Inherit;
- with confirmed explicit Off, enqueue On then Inherit, reject both, and assert `Inherit -> Inherit -> Off`, both promises resolve `false`, and final baseline/visible state match server Off;
- enqueue values A/B/A/B with outcomes success/failure/failure/success; after every settlement assert the newest pending B remains visible, baselines advance only on the two successes (`A`, then `B`), per-request promises are `true/false/false/true`, and final server/baseline/visible value is B;
- setting a project override does not mutate the global dataset or emit `PLAY_FINISH_SOUND_CHANGED`.

### Foreground/background source and cold-cache regression

Add `tests2/dom/project-audio-notification-paths.test.ts` (or extend the real-path coverage in `tests2/dom/remote-agent-status.test.ts`):

- seed two `GatewaySession` records with different `projectId` values;
- drive real `RemoteAgent.handleAgentEvent({ type: "agent_end" })` and assert the source is the record matching that agent's `_sessionId`, not the selected/active project's record;
- for a cold known foreground project, hold its config GET deferred and invoke `agent_end`; assert the badge is immediate and no `AudioContext` is constructed before the GET settles;
- release explicit Off while global is On and assert no audio; in a separate deterministic case release explicit On while global is Off and assert audio occurs. These opposite-value cases prove cold cache never falls back early;
- drive two real `refreshSessions()` payloads (`streaming`, then `idle`) for a non-active session and assert the background call uses that loop session/project;
- hold opportunistic config GETs for multiple projects deferred and prove each `refreshSessions()` promise resolves, session state/transitions update, and the badge appears without awaiting any preload;
- settle only the transitioning source project's GET and prove its audio decision completes while an unrelated project's preload remains pending; assert duplicate preload/audio callers shared one source-project GET;
- use opposite active/source overrides so passing no source or the active project fails the assertions;
- assert badge invocation remains present for project Off.

### Settings and API

Add `tests2/dom/project-audio-settings.test.ts`:

- raw config absent renders Inherit;
- selecting On and Off sends the correct partial PUT and changes the shared resolver immediately;
- selecting Inherit sends `null` and clears the persisted key while retaining a loaded Inherit cache entry;
- deterministically start a Settings raw GET with old Off, complete an On PUT, then release the GET; `loadProjectScopeConfig` may retain unrelated raw fields, but the revision-checked sound prime is discarded and the select/resolver remain On;
- navigating away/back retains the cached state;
- a single failed PUT removes only its mutation, reveals the confirmed baseline, and displays failure state;
- repeat the deterministic Inherit -> On-fail -> Off-fail and explicit Off -> On-fail -> Inherit-fail queues through the Settings-facing setter/render path, proving the displayed state ends at the confirmed server value rather than an earlier optimistic snapshot.

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
| The first notification races project-config loading. | Polling may start a fire-and-forget deduplicated preload, but correctness lives in the async audio primitive: a known source awaits only its own loader; only absent project IDs or explicit source lookup failure use global fallback. |
| Opportunistic project loads stall general polling. | Never await the preload fan-out or `playNotificationBeep` in `refreshSessions`; update transitions and badges immediately. Deterministically hold unrelated GETs pending while asserting refresh completion. |
| A background session uses the viewed project's setting. | Pass the actual `GatewaySession` from each notification path; never consult `activeProjectId`. |
| A project Off suppresses badges/unread state. | Keep the gate inside `playNotificationBeep`; leave `showFaviconBadge` and notification policy outside it. |
| Inherit accidentally becomes an explicit stored state. | Canonical PUT is `null`; assert raw GET omits the key and reload still inherits. |
| `/config/resolved` introduces server config/default precedence. | Parse only raw `/config`; do not add this key to project defaults. |
| Runtime/Settings raw GET overwrites queued or confirmed state. | Both GET paths capture the shared revision; enqueue and settlement advance it, and prime additionally requires an empty queue. Only an accepted GET establishes the baseline. |
| A failed load becomes permanently cached or duplicate loads multiply. | `projectLoads` contains in-flight promises only and deletes the exact promise in `finally`; a confirmed baseline/pending value records availability, failure remains retryable, and concurrent callers reuse one promise. |
| Two failed queued writes expose an unconfirmed optimistic value. | Never snapshot optimistic state. Failures leave the authoritative baseline unchanged; exact mutation removal derives visibility from the newest pending mutation or that baseline. |
| A successful older PUT is ignored because a newer choice exists. | Serialized success always advances the confirmed baseline to its own value while the newer queue entry continues to own visibility; later failure then correctly exposes the last server-confirmed value. |
| Setter results become coupled to the latest selection. | Return one promise per mutation and resolve it from that request's own response after settlement, independent of newer queue entries. |
| Cache grows across many projects. | It holds one small baseline plus short-lived mutations per session-owning/settings-opened project; optionally prune idle IDs no longer present in `state.projects`. |
| A malformed YAML value mutes unexpectedly. | Only exact `"false"` forces off; all other unrecognized values inherit. |
| Another browser tab edits project config. | Current scope guarantees same-tab immediacy plus reload persistence. A future generic `project_config_changed` broadcast can invalidate the cache without changing resolver semantics. |
| The project key appears in the generic Commands editor. | Add it to `renderProjectScopeTab`'s `HIDDEN_KEYS`. |

## 11. Conflict-free implementation partition

The slices below have non-overlapping file ownership. Dependencies flow top-to-bottom; merge in that order.

| Slice | Ownership (exclusive) | Work |
|---|---|---|
| A — resolver/cache | `src/app/play-finish-sound.ts` | Add key/type/source contracts, async effective resolver, confirmed baselines, ordered pending queues, per-request serialized setters, revision-checked raw loads, and loader dedupe while preserving global helpers. |
| B — notification routing | `src/app/remote-agent.ts`, `src/app/api.ts` | Make only the audio primitive async/deferred, pass foreground/background source sessions, and start opportunistic preloads without awaiting them in polling. |
| C — Settings UI | `src/app/settings-page.ts` | Capture revision before raw GET and conditionally establish the baseline afterward; render/autosave the three-state control from derived queue/baseline state, hide the raw key from Commands, and render per-request save/error state. |
| D — unit/DOM tests | `tests2/core/play-finish-sound.test.ts`, `tests2/dom/project-audio-notification-paths.test.ts`, `tests2/dom/project-audio-settings.test.ts`, `tests2/dom/bell-toggle.test.ts` | Matrix, cold-cache opposites, baseline/queue sequences, GET revision races, per-request/transport ordering, non-blocking polling, both source paths, UI states, badge preservation, and Bell-global regression. |
| E — API/browser tests | `tests2/integration/project-config-api.test.ts`, `tests2/browser/journeys/project-settings.journey.spec.ts`, `tests2/tests-map.json` | Raw key persistence/clear/reload and the end-to-end project mute/Bell journey; this owner alone edits the shared test map. |

Do not assign `tests2/tests-map.json` to more than one worker. No slice should edit `src/server/server.ts`, `src/server/agent/project-config-store.ts`, `src/app/main.ts`, `src/app/state.ts`, or `src/ui/components/BellToggle.ts`; their current contracts already support the design and leaving them untouched reduces merge risk.

## 12. Acceptance trace

- Three states: `renderProjectGeneralTab` select with `inherit/on/off`.
- Clear semantics: `null` partial PUT -> `ProjectConfigStore.remove`.
- Precedence/default: async `isEffectivePlayFinishSoundEnabled` matrix after authoritative source-project resolution.
- Correct source: foreground passes `sess`; background passes `s`.
- Cold known project: audio awaits its one deduplicated raw load; it never uses global merely because the cache is cold or pending.
- Non-blocking polling: `refreshSessions` may opportunistically start project loads but awaits none; state transitions, badges, and refresh completion do not wait on audio config.
- Unresolvable source: absent project ID or explicitly failed source lookup -> global dataset -> default on.
- Ordering: accepted raw GETs and successful serialized PUTs alone establish/update the confirmed baseline; every enqueue is immediately visible; every settlement removes its exact mutation and derives visibility from newest pending or baseline.
- GET race safety: runtime and Settings reads share captured revisions; enqueue/settlement advances plus the empty-queue prime condition prevent reads from racing writes.
- Failure correctness: Inherit -> On-fail -> Off-fail ends Inherit; explicit Off -> On-fail -> Inherit-fail ends Off; mixed A-success/B-failure/A-failure/B-success ends B, matching the server in each case.
- Setter/transport contract: PUTs remain serialized per project, and each setter resolves from its own request after its baseline/queue settlement.
- Loader lifecycle: `projectLoads` is in-flight only; a confirmed baseline or pending value is available immediately, failure remains retryable, and concurrent source callers deduplicate.
- Immediate/navigation/reload: pending/confirmed module state has route-independent lifetime and raw reloads are revision-safe.
- Bell global: existing global helper/event/API remain the Bell's only inputs.
- Non-audio preserved: resolver is inside the Web Audio primitive; badges/unread policy are untouched.
