# Per-Role Model & Thinking Level Overrides — Design Doc

Goal: add two optional fields — `model` and `thinkingLevel` — to every Role,
editable from a new "Model" tab in the role manager page. When set on a role,
they override the global `default.sessionModel` / `default.sessionThinkingLevel`
(and `default.reviewModel` / `default.reviewThinkingLevel` for verification
sub-sessions) for any session running under that role. Naming model is NOT
affected.

---

## 1. Data model

### 1.1 `Role` interface — `src/server/agent/role-store.ts`

Extend the interface (currently lines 41–58) with two optional fields:

```ts
export interface Role {
    name: string;
    label: string;
    promptTemplate: string;
    accessory: string;
    defaultPersonalities?: string[];
    toolPolicies?: Record<string, GrantPolicy>;
    /** "<provider>/<modelId>" — overrides default.sessionModel / default.reviewModel */
    model?: string;
    /** "off" | "minimal" | "low" | "medium" | "high" — overrides default.sessionThinkingLevel / default.reviewThinkingLevel */
    thinkingLevel?: string;
    createdAt: number;
    updatedAt: number;
}
```

### 1.2 `parseRole` — `role-store.ts:60`

Read both fields with a string-type guard. Treat empty string the same as
missing (i.e. `undefined`), so a UI-side "(use default)" never serializes to a
present-but-empty value:

```ts
const model = typeof data.model === "string" && data.model.trim() ? data.model.trim() : undefined;
const thinkingLevel =
    typeof data.thinkingLevel === "string" && data.thinkingLevel.trim() ? data.thinkingLevel.trim() : undefined;
```

Validate `thinkingLevel` against the existing `["off", "minimal", "low", "medium", "high"]`
set (the same set used in `session-manager.ts:2895`); silently drop on
mismatch (mirrors `normalizeGrantPolicy` tolerance).

Validate `model` shape: must contain exactly one `/` with non-empty parts on
each side, matching the parser in `review-model-override.ts:69-75` and
`session-manager.ts:2820-2823`. Drop on malformed; do not throw at parse time
(parse-time errors should never break role loading).

### 1.3 `serializeRole` — `role-store.ts:74`

Mirror the `toolPolicies` "omit when empty" pattern:

```ts
if (role.model) obj.model = role.model;
if (role.thinkingLevel) obj.thinkingLevel = role.thinkingLevel;
```

`promptTemplate` stays last so YAML stays human-friendly.

### 1.4 Builtin loader — `src/server/agent/builtin-config.ts:80-105` (`loadRoles`)

Add the same two fields to the manual builtin parser, with the same validation
as `parseRole`:

```ts
roles.push({
    name: data.name,
    label: data.label ?? data.name,
    promptTemplate: data.promptTemplate ?? "",
    accessory: data.accessory ?? "none",
    defaultPersonalities: Array.isArray(data.defaultPersonalities) ? data.defaultPersonalities : undefined,
    toolPolicies,
    model: validateModelString(data.model),
    thinkingLevel: validateThinkingLevel(data.thinkingLevel),
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
});
```

Factor the validators into `role-store.ts` as exported helpers
(`validateModelString`, `validateThinkingLevel`) so both `parseRole` and the
builtin loader share the same code.

### 1.5 Cascade — `src/server/agent/config-cascade.ts:51-60` (`resolveRoles`)

**No changes required.** The generic `resolve<T>()` helper at lines 132-176
already merges by `keyFn` (role.name) with project > server > builtin
precedence, treating each `Role` as an opaque value. A project-level role with
`model: "anthropic/claude-opus-4-1"` and `thinkingLevel: "high"` automatically
shadows the server-level role of the same name, exactly as `toolPolicies`
does today. Verified by inspection of `resolve()` at lines 142-176 and the
generic call site at line 60.

### 1.6 No builtin roles change

`defaults/roles/*.yaml` ship without `model` / `thinkingLevel` — leaving them
unset preserves today's behaviour (inherit `default.sessionModel`).

---

## 2. Server: model binding at session start

### 2.1 New helper in `review-model-override.ts`

Add a sibling function `applyModelString` that takes a literal
`<provider>/<modelId>` instead of reading from `prefs.get(prefKey)`. Refactor
`applyReviewModelOverrides` to delegate to it:

```ts
export async function applyModelString(
    rpc: ReviewModelRpc,
    modelString: string,
    opts: {
        sessionManager?: ReviewModelPersister | null;
        sessionId?: string | null;
        contextLabel?: string;            // e.g. "role.coder.model" for error messages
        maxAttempts?: number;
        retryDelayMs?: number;
    },
): Promise<void> { /* parse + setModel + retry + getState verify */ }
```

`applyReviewModelOverrides` becomes a thin wrapper:

```ts
const pref = opts.prefs.get(prefKey);
if (!pref) return;
return applyModelString(rpc, pref, { ...opts, contextLabel: prefKey });
```

This preserves the existing callers (the three sites in
`verification-harness.ts` at 1607, 1823, 1993) byte-for-byte while letting new
code bind a literal `<provider>/<modelId>` straight from a role.

**Why a sibling rather than extending `applyReviewModelOverrides`:** the
existing function's contract is "read pref X, no-op if unset". Role overrides
have already been resolved to a string by the caller — they should not flow
through `prefs.get`. Mixing the two would force a synthetic prefs object and
muddy the error messages.

### 2.2 Resolution order at session start — `src/server/agent/session-manager.ts:2814` (`tryAutoSelectModel`)

The pipeline already calls `tryAutoSelectModel(session)` from `session-setup.ts:734-746`
unless `skipAutoModel` is set. Today the function (lines 2814-2879) reads
`default.sessionModel`, then falls back to the AI-Gateway best-ranked model.

Insert role-level resolution **before** the existing pref read. Sessions know
their role via `session.role` (set by `session-setup.ts:687`,
`SessionInfo.role`).

```ts
private async tryAutoSelectModel(session: SessionInfo): Promise<void> {
    if (!this.preferencesStore) return;

    // 0. Role override (NEW). Skipped if no role or role unresolved.
    const roleModel = this.resolveRoleModel(session);
    if (roleModel) {
        try {
            await applyModelString(session.rpcClient, roleModel, {
                sessionManager: this,
                sessionId: session.id,
                contextLabel: `role.${session.role}.model`,
            });
            this._writeModelNameFile(session.id, roleModel);
            const [provider, modelId] = roleModel.split("/", 2);
            broadcast(session.clients, {
                type: "state",
                data: { model: { provider, id: modelId, reasoning: inferMeta(modelId).reasoning } },
            });
            console.log(`[session-manager] Set role-override model "${roleModel}" for session ${session.id}`);
            return;
        } catch (err) {
            // Role override is a hard contract — surface the same red Unavailable
            // pattern the user sees in Settings → Models. Throwing here matches
            // the behaviour of applyReviewModelOverrides for review sessions.
            console.error(`[session-manager] Role model "${roleModel}" failed for ${session.id}:`, err);
            throw err;
        }
    }

    // 1. Explicit pref (existing behaviour, lines 2818-2839)
    const sessionModelPref = this.preferencesStore.get("default.sessionModel") as string | undefined;
    /* unchanged */

    // 2. aigw fallback (existing behaviour, lines 2843-2877)
    /* unchanged */
}
```

Add the helper:

```ts
private resolveRoleModel(session: SessionInfo): string | undefined {
    if (!session.role) return undefined;
    const projectId = session.projectId;
    const resolved = this.configCascade?.resolveRoles(projectId).find(r => r.item.name === session.role);
    return resolved?.item.model;
}
```

**Note on "explicit per-session override" precedence.** The goal spec lists
three layers (per-session > role > global). In Bobbit today, "per-session
override" is the user picking a model in the composer mid-session — that path
goes through `RemoteAgent.setModel` after the session is already running and
is independent of `tryAutoSelectModel`. The startup pipeline only resolves
role + global. Once the session is started, anything the user clicks wins by
construction — no code change needed.

For the rare programmatic per-session override (e.g. `delegate` with an
explicit model arg) the existing `skipAutoModel: true` flag continues to work
— callers that pre-bind a model already set this flag (verification-harness
sets it at lines 1578, 1794), so role resolution is correctly skipped.

### 2.3 Thinking level — `session-manager.ts:2880` (`tryApplyDefaultThinkingLevel`)

Same pattern. Insert role resolution before the existing pref/project/medium
fallback chain (lines 2884-2898):

```ts
private async tryApplyDefaultThinkingLevel(session: SessionInfo): Promise<void> {
    // 0. Role override (NEW)
    const roleThinking = this.resolveRoleThinkingLevel(session);
    if (roleThinking) {
        try {
            await session.rpcClient.setThinkingLevel(roleThinking);
            console.log(`[session-manager] Applied role thinking level "${roleThinking}" for session ${session.id}`);
            return;
        } catch (err) {
            console.warn(`[session-manager] Role thinking level "${roleThinking}" failed for ${session.id}:`, err);
            // Fall through to default — thinking-level mismatch is non-fatal
        }
    }

    // 1. existing chain (pref → project config → "medium")
    /* unchanged */
}

private resolveRoleThinkingLevel(session: SessionInfo): string | undefined {
    if (!session.role) return undefined;
    const projectId = session.projectId;
    const resolved = this.configCascade?.resolveRoles(projectId).find(r => r.item.name === session.role);
    return resolved?.item.thinkingLevel;
}
```

The WS dispatch is `session.rpcClient.setThinkingLevel(level)` — same call
site `tryApplyDefaultThinkingLevel` already uses (line 2896) and the same
`set_thinking_level` WS message used at `rpc-bridge.ts:384-386`. No new
mechanism.

**Failure handling:** model failure throws (matches `applyReviewModelOverrides`
hard-fail contract). Thinking level failure logs and falls through (matches
existing line 2898 `console.warn` behaviour — pi-coding-agent rejects unknown
levels but the session can still run).

### 2.4 Persistence

`applyModelString` re-uses `sessionManager.persistSessionModel` exactly like
`applyReviewModelOverrides` does today, so the bound model survives restart
via `.bobbit/state/sessions.json`.

---

## 3. Verification harness integration

`verification-harness.ts` has three `applyReviewModelOverrides` call sites
(1607, 1823, 1993). Each spawns a reviewer / QA / sub-session for a specific
step, and each step has an associated role (`step.role`). The role lookup is
already done — `role.name` is in scope at every site.

Wrap each existing call in a "role wins" check:

```ts
// Resolve role from the cascade so project-level overrides apply.
const projectIdForReview = this.projectContextManager?.getContextForGoal(goalId)?.project?.id;
const resolvedRole = projectIdForReview
    ? this.configCascade?.resolveRoles(projectIdForReview).find(r => r.item.name === role.name)?.item
    : this.roleStore.get(role.name);
const roleModel = resolvedRole?.model;
const roleThinking = resolvedRole?.thinkingLevel;

if (roleModel) {
    try {
        await applyModelString(session.rpcClient, roleModel, {
            sessionManager: this.sessionManager ?? null,
            sessionId,
            contextLabel: `role.${role.name}.model`,
        });
        console.log(`[verification] Set role-override model "${roleModel}" for ${sessionId}`);
    } catch (err) {
        console.error(`[verification] Role model "${roleModel}" failed for ${sessionId}:`, err);
        throw err;  // hard-fail to gate, same as applyReviewModelOverrides today
    }
} else if (this.preferencesStore) {
    const reviewModelPref = this.preferencesStore.get("default.reviewModel") as string | undefined;
    try {
        await applyReviewModelOverrides(session.rpcClient, {
            prefs: { get: (k) => this.preferencesStore!.get(k) as string | undefined },
            sessionManager: this.sessionManager ?? null,
            sessionId,
            role: "reviewer",
        });
        if (reviewModelPref) {
            console.log(`[verification] Set review model "${reviewModelPref}" for ${sessionId}`);
        }
    } catch (err) {
        console.error(`[verification] applyReviewModelOverrides failed for reviewer ${sessionId} (pref="${reviewModelPref ?? "<unset>"}"):`, err);
        throw err;
    }
}

// Thinking — role wins; otherwise existing reviewThinking pref logic.
if (roleThinking) {
    try { await session.rpcClient.setThinkingLevel(roleThinking); }
    catch (err) { console.error(`[verification] Failed to set role thinking level:`, err); }
} else {
    /* unchanged existing reviewThinking block at 1625-1635 / 1840-1849 / 2010-2021 */
}
```

Apply this transformation at all three sites:

1. **Reviewer** — `verification-harness.ts:1604-1635` (in `runLlmReviewStep`).
2. **QA** — `verification-harness.ts:1820-1849` (in `runAgentQaStep`).
3. **Sub-session** — `verification-harness.ts:1990-2021` (in the legacy sub-session path; lookup uses `step.role` — see line 2003 context).

The `VerificationHarness` constructor (line ~2078, see `roleStore` param)
already has `roleStore`. Add an optional `configCascade` param and pass it
from the `SessionManager` wiring site. Where the cascade is unavailable
(e.g. unit tests), fall back to `this.roleStore.get(role.name)` — server-level
only. This gracefully degrades and matches today's lookup behaviour.

### 3.1 Naming model untouched

`applyReviewModelOverrides` uses `prefKey: "default.reviewModel"` only; no
caller passes `default.namingModel` from a role. Naming continues to flow
through `title-generator.ts::pickFallbackAigwNamingModel` and
`default.namingModel` exclusively — explicitly out of scope.

---

## 4. UI: role-manager-page

### 4.1 Tab union widening — `src/app/role-manager-page.ts:60`

```ts
let editTab: "prompt" | "tools" | "model" = "prompt";
```

### 4.2 Edit-state init — `role-manager-page.ts:165` (`initEditState`)

```ts
editModelOverride = role.model ?? "";
editThinkingOverride = role.thinkingLevel ?? "";
```

Add module-scope `let` declarations for both alongside `editToolPolicies`
(line 58).

### 4.3 Tab bar — `role-manager-page.ts:533-537`

Insert a third button:

```ts
<div class="roles-tab-bar">
    <button class="roles-tab ${editTab === "prompt" ? "roles-tab--active" : ""}"
        @click=${() => { editTab = "prompt"; renderApp(); }}>Prompt</button>
    <button class="roles-tab ${editTab === "tools" ? "roles-tab--active" : ""}"
        @click=${() => { editTab = "tools"; renderApp(); }}>Tool Access</button>
    <button class="roles-tab ${editTab === "model" ? "roles-tab--active" : ""}"
        @click=${() => { editTab = "model"; renderApp(); }}>Model</button>
</div>

<div class="roles-tab-content">
    ${editTab === "prompt" ? renderPromptTab()
      : editTab === "tools" ? renderToolAccessTab()
      : renderModelTab()}
</div>
```

### 4.4 New `renderModelTab()`

The component reuse target is `renderModelRow(label, hint, modelValue, onModelChange, thinkingValue, onThinkingChange, thinkingDefault)` in `settings-page.ts:1345-1467` — it already does:

- Model picker via `ModelSelector.open` (line 1340)
- Empty value = "Auto (best available)" (line 1320 `formatModelPref`)
- Red **Unavailable** badge when `!modelIsAvailable(modelValue)` (line 1390)
- Thinking dropdown with `["off","minimal","low","medium","high"]` and reasoning-disabled tooltip (lines 1442-1462)
- Per-row Test button (lines 1411-1437)
- "Use default" via empty string

**Action:** export `renderModelRow` from `settings-page.ts` (currently
file-local) so `role-manager-page.ts` can import it directly. Tweak the
display label for the empty case from "Auto (best available)" to "(use
default)" by either (a) parameterising `formatModelPref` with a placeholder
arg, or (b) wrapping `formatModelPref` in `role-manager-page.ts` and
re-implementing one tiny helper. Pick (a):

```ts
// settings-page.ts
export function formatModelPref(value: string, fallback = "Auto (best available)"): string { /* … */ }
export function renderModelRow(/* … */, opts?: { fallbackLabel?: string }): TemplateResult { /* … */ }
```

Pass `{ fallbackLabel: "(use default)" }` from the role tab.

```ts
function renderModelTab(): TemplateResult {
    return html`
        <p class="roles-tools-note">
            Overrides the global default for sessions running as this role. Leave blank to inherit.
        </p>
        ${renderModelRow(
            "Model",
            "When set, sessions assuming this role bind to this model on first turn. Empty = inherit default.sessionModel (or default.reviewModel for reviewers).",
            editModelOverride,
            (v) => { editModelOverride = v; renderApp(); },
            editThinkingOverride,
            (v) => { editThinkingOverride = v; renderApp(); },
            "",   // no thinking default — empty truly means "inherit"
            { fallbackLabel: "(use default)" },
        )}
    `;
}
```

The thinking selector's "(use default)" option needs adding — currently it
hardcodes 5 options. Extend `Select` config with a leading `{ value: "", label: "(use default)" }` when `fallbackLabel` is supplied:

```ts
options: [
    ...(opts?.fallbackLabel ? [{ value: "", label: opts.fallbackLabel, icon: icon(Brain, "sm") }] : []),
    { value: "off", label: "Off", icon: icon(Brain, "sm") },
    /* … */
]
```

### 4.5 Save / dirty / persistence

`handleSave` (line 245) — extend the PUT body:

```ts
const ok = await updateRole(selectedRole.name, {
    label: editLabel,
    promptTemplate: editPrompt,
    accessory: editAccessory,
    toolPolicies: Object.keys(editToolPolicies).length > 0 ? editToolPolicies : {},
    model: editModelOverride || undefined,         // empty → undefined → omitted from yaml
    thinkingLevel: editThinkingOverride || undefined,
}, projectId || undefined);
```

The `updateRole` API call in `src/app/api.ts` and the server PUT handler in
`src/server/server.ts` need to accept and forward both fields. Check the
existing `RoleData` interface in `api.ts` and add the two optional fields;
the server-side handler needs the parallel addition. (Both follow the
`toolPolicies` pattern verbatim — search for `toolPolicies` in those files
and mirror.)

Dirty detection — `renderNavBar` (line 296):

```ts
const modelChanged = (editModelOverride || "") !== (selectedRole?.model || "");
const thinkingChanged = (editThinkingOverride || "") !== (selectedRole?.thinkingLevel || "");
const hasChanges = selectedRole && (
    editLabel !== selectedRole.label ||
    editPrompt !== selectedRole.promptTemplate ||
    editAccessory !== selectedRole.accessory ||
    toolPoliciesChanged ||
    modelChanged ||
    thinkingChanged ||
    subPromptsDirty
);
```

### 4.6 Origin / Customize / Revert

The existing `renderCustomizeRevertButtons` (line 597) operates on the role
record level (origin, overrides) and triggers a generic
`customizeItem`/`revertOverride` against the role yaml as a whole. **No
field-specific logic is needed.** Touching `editModelOverride` or
`editThinkingOverride` flips the dirty state; saving while origin is "builtin"
will create a server-level override yaml (handled by `customizeItem` already).
Revert deletes the project- or server-level yaml entirely, restoring the
inherited state — same behaviour as today for `toolPolicies`.

The acceptance criterion "touching either field flips builtin → overridden"
is satisfied by the dirty check + Save flow already in place.

### 4.7 Failure handling — Unavailable badge

`renderModelRow` in `settings-page.ts:1379-1394` already renders the red
**Unavailable** pill when `!modelIsAvailable(modelValue) && allModels.length > 0`.
By reusing `renderModelRow`, the role-tab gets the same pill for free. The
hard-fail at session-start time is enforced by `applyModelString` (section 2.1)
— same throw contract as `applyReviewModelOverrides` today, surfaced as a
gate failure for verification sessions and as a session-start error for
regular sessions.

---

## 5. Tests

### 5.1 Unit — `tests/role-store.test.ts`

If the file does not exist, create it. Tests:

1. `parseRole` round-trip: yaml with `model: "anthropic/claude-opus-4-1"` and `thinkingLevel: "high"` → `Role` object with both populated.
2. `serializeRole` omits both fields when unset (parse → re-serialize → no `model:` / `thinkingLevel:` lines).
3. `parseRole` drops malformed `model: "no-slash"` and `thinkingLevel: "invalid"` (silently → `undefined`).
4. `parseRole` treats empty string `""` the same as missing.

### 5.2 Cascade — `tests/config-cascade.test.ts` (new test inside existing file if present, otherwise create)

1. Builtin role has `model: undefined`. Server override sets `model: "x/y"`. Project override sets `model: "a/b"`. `resolveRoles(projectId)` returns `model: "a/b"`, `origin: "project"`, `overrides: "server"`.
2. Same shape for `thinkingLevel`.
3. Project override sets `model` only — server override's `thinkingLevel` is also lost (the cascade replaces the whole `Role`, not field-by-field; this is the documented merge semantics — confirm the test asserts that explicitly so future "field-level merge" temptation is gated).

### 5.3 API E2E — `tests/e2e/role-manager-api.spec.ts` (new) or extend existing role API spec

1. `PUT /api/roles/coder` with body `{ label, promptTemplate, accessory, model: "anthropic/claude-opus-4-1", thinkingLevel: "high" }` → 200.
2. `GET /api/roles` → resolved cascade includes the role with both fields populated.
3. PUT with `model: ""` and `thinkingLevel: ""` → 200; subsequent GET shows fields omitted (not present, not empty string).
4. PUT with `model: "malformed-no-slash"` → 400 with helpful error (server should validate at the API layer too — add a check in `server.ts` PUT handler that rejects malformed model strings, since the YAML parser silently drops them and a silent drop on API surface is a UX trap).

### 5.4 Browser E2E — `tests/e2e/ui/role-manager-model-tab.spec.ts` (new)

Use `gateway-harness.js` and `ui-helpers.js` (see `tests/e2e/ui/settings.spec.ts`
as canonical pattern).

1. **Navigate**: open `/#/roles/coder` (or first role in list).
2. **Switch to Model tab**: click `roles-tab` with text "Model"; assert the
   model picker button and thinking dropdown render.
3. **Set both**: pick a model via `ModelSelector` (mock or stub the modal as
   other settings tests do); set thinking to "high"; click Save; assert
   the request body includes `model` and `thinkingLevel`.
4. **Persistence across reload**: `page.reload()`; navigate back to the same
   role's Model tab; assert the picker shows the saved model and thinking
   shows "high".
5. **Cleanup / revert**: click the model clear (X) button and the thinking
   "(use default)" option; Save; assert the role yaml on disk no longer
   contains `model:` or `thinkingLevel:` lines (use the harness to read the
   yaml file, mirroring `tests/e2e/ui/settings.spec.ts` patterns).

### 5.5 Manual integration (not in CI) — `tests/manual-integration/role-model-override.test.ts`

Spawn a goal session under a role that has `model: "<provider>/<modelId>"`
set; after first turn, query `rpcClient.getState()` and assert
`state.model.id === modelId`. Useful for catching the "AI Gateway exposes the
model under a different id" class of bug.

---

## 6. Out of scope (explicit)

- **Per-goal model overrides.** Distinct feature, not in this design.
- **Naming model.** `default.namingModel` and `pickFallbackAigwNamingModel` (`title-generator.ts`) untouched.
- **New thinking levels.** Reuse the existing `["off", "minimal", "low", "medium", "high"]` set; no schema additions.
- **Field-level cascade merge.** A project role replaces the entire server role record; we do NOT merge `model` from project with `thinkingLevel` from server. Documented and tested.
- **Role-level toolPolicy changes.** Beyond what already exists.

---

## 7. File touch list (for the implementer)

| File | Change |
|------|--------|
| `src/server/agent/role-store.ts` | `Role` interface +2 fields; `parseRole` / `serializeRole`; export `validateModelString`, `validateThinkingLevel`. |
| `src/server/agent/builtin-config.ts` | `loadRoles` reads new fields with same validators. |
| `src/server/agent/config-cascade.ts` | No code change (generic resolve already handles it). |
| `src/server/agent/review-model-override.ts` | New `applyModelString` helper; refactor `applyReviewModelOverrides` to call it. |
| `src/server/agent/session-manager.ts` | `tryAutoSelectModel` + `tryApplyDefaultThinkingLevel` insert role layer 0. New `resolveRoleModel` / `resolveRoleThinkingLevel` private helpers. |
| `src/server/agent/verification-harness.ts` | Three call sites (1607, 1823, 1993): "role wins" branch using cascade + `applyModelString`; same for thinking-level. Constructor optionally takes `configCascade`. |
| `src/server/server.ts` | PUT `/api/roles/:name` accepts `model`, `thinkingLevel`; rejects malformed model. |
| `src/app/api.ts` | `RoleData` interface +2 fields; `updateRole` body forwards them. |
| `src/app/role-manager-page.ts` | `editTab` union; module state for two new fields; `renderModelTab`; tab-bar button; `handleSave` body; dirty detection. |
| `src/app/settings-page.ts` | Export `renderModelRow` and `formatModelPref`; add optional `fallbackLabel` param. |
| `tests/role-store.test.ts` | New / extended unit tests. |
| `tests/config-cascade.test.ts` | Cascade tests for both fields. |
| `tests/e2e/role-manager-api.spec.ts` | API E2E. |
| `tests/e2e/ui/role-manager-model-tab.spec.ts` | Browser E2E. |
| `tests/manual-integration/role-model-override.test.ts` | Manual binding-verification test. |
| `AGENTS.md` | Add a Recipes bullet: **"Per-role model override"** → role yaml `model:`/`thinkingLevel:`; bound at session start by `tryAutoSelectModel` / `tryApplyDefaultThinkingLevel` (`session-manager.ts:2814`); reviewer/QA path in `verification-harness.ts` 3 sites. |
| `docs/internals.md` | Brief note under "Per-project config" or a new "Per-role model" subsection cross-linking this design doc. |
