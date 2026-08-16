# Extension settings in Market — UX specification

**Status:** implemented UX reference — companion to `extension-settings-foundation.md` and [Project extension settings](../extension-settings.md)

**Surface:** Market → Installed, in an explicit project context

> **Supersedes pre-EP-7 settings UX.** Historical designs that use a pack-specific config route,
> PackStore overlay, or editable Hindsight `mode` control are not valid on this surface. Market
> writes project settings only through the generic revisioned extension-settings API.

**Scope:** presentation and interaction only. The foundation document owns schema, storage, REST, revision, authentication, redaction, and cache-invalidation contracts.

## 1. Outcome

A project operator can open an installed schema-2 pack, understand why each contribution is or is not running, edit every declared setting type, inspect exact capability grants, and enable or disable the pack, a provider, or a hook for one project without changing another project.

The design has four non-negotiable properties:

1. **Project identity is always visible.** A project-owned mutation never depends on an implicit “first project” fallback.
2. **Enabled, configured, granted, and running are separate facts.** No switch silently grants authority, and an enabled contribution may correctly remain dormant.
3. **Secrets are write-only.** The browser receives only presence metadata and never places a stored secret in markup, application state, a diff, a tooltip, a log, or a trace.
4. **Existing Market patterns remain the visual grammar.** Cards, activation groups, switches, inputs, buttons, lozenges, errors, and the centered `max-w-3xl` content column are reused rather than forked.

## 2. Existing-surface audit

The implementation must start from these existing primitives rather than introducing a parallel settings page.

| Existing surface | Current primitive / selector | Required reuse |
|---|---|---|
| Market entry | Sidebar `market-nav-button`; route `#/market` | Keep `#/market` working as a backwards-compatible entry. |
| Market shell | `renderNavBar()`, Research Preview banner, Installed/Browse/Sources tab bar | Settings stay on **Installed**; do not add a fourth top-level tab. |
| Project navigation | Settings `renderScopeRow()` and shared `renderConfigScopeRow()` | Reuse its horizontally scrollable project buttons, spacing, project colour/icon, active border, and Headquarters treatment. |
| Installed pack | `.market-pack-card`, `market-installed-pack`, scope groups | Render settings inside the owning pack card. Do not create a detached “Extension settings” list. |
| Activation | `.market-activation`, `.market-activation-group`, `.market-activation-toggle`, `.market-toggle-switch` | Add project pack/provider/hook rows to the same grid and preserve the current focus ring and disabled treatment. |
| Status | `.market-lozenge` with muted, warning, positive, error, and info variants | Use text plus icon where appropriate; colour is supplementary. |
| Form controls | `.market-input`, `.market-btn`, `.market-btn--primary`, `.market-btn--danger`, `.market-error` | Match current font sizes, radii, borders, padding, hover, focus, and disabled states exactly. |
| Save feedback | Settings explicit Save rows and `role="status"` sound-setting pattern | Use explicit Save, a stable live-status region, retry, and field-level errors. No autosave. |
| Progressive disclosure | Market “Show details” `<details>` | Settings use an adjacent disclosure with a real `<button>` trigger because it also needs dirty/busy state and programmatic focus. |

### Audit gaps to close while touching the surface

- Current Market tab buttons sit in `role="tablist"` but do not expose `role="tab"`, `aria-selected`, or a controlled tab panel. The settings implementation should complete those semantics without changing the visual treatment.
- Current Market back control has only `title="Back"`. Add `aria-label="Back"`.
- Current Market project focus can be derived indirectly from an install/adoption picker. Project settings must never use that implicit state.
- Current activation rendering covers roles, tools, skills, entrypoints, MCP, and Pi extensions. Providers and hooks must use the same activation group rather than a new switch component.

## 3. Navigation and project context

### 3.1 Canonical route

Use the additive canonical route:

```text
#/market/<projectId>/<tab>
```

`tab` is `installed`, `browse`, or `sources`. `#/market` remains an alias for the active project’s Installed tab (or the first visible project only for navigation), then replaces the hash with the canonical route. A project-owned request is not sent until a concrete registered `projectId` is present.

Reload, back/forward, copying the URL, and switching between Market tabs therefore retain the target project. An unknown or deleted project produces a safe “Project not found” state with a **Choose a project** action; it never falls through to another project.

### 3.2 Scope row

Place the existing Settings-style scope row directly below the Research Preview banner and above the Market tab bar. It is labelled **Project context** for assistive technology. The selected button exposes `aria-current="page"` and its visible project name.

Changing project:

1. prompts before discarding a dirty settings form;
2. updates the route immediately;
3. clears contribution drafts, validation errors, secret inputs, request status, and expanded grant details from the previous project;
4. shows card skeletons or a compact loading state while fetching the new project projection;
5. never briefly renders the previous project’s values under the new project name.

The Browse install target and adoption target remain explicit controls. When they target a project, they default to the project in this route but retain their existing Server and Global options.

## 4. Installed-card information architecture

A schema-2 installed card keeps its existing title, version, provenance, install-scope actions, entity chips, and scope-level activation controls. Add a **Project runtime** block inside the same card, before “Show details”.

```text
Hindsight  v1.0.0     Built-in                  [scope master switch]
Persistent agent memory…

PROJECT RUNTIME · Hermes
  Pack             [switch] Use in Hermes       Ready
  Providers        [switch] Memory              Needs configuration  [Configure]
  Hooks            [switch] Retention advisor   Grant required       [Review grants]

  ┌ Memory provider settings — Hermes ─────────────────────────────┐
  │ …declared fields…                                              │
  │ [Reset project settings]                  [Save]  Saved.        │
  └────────────────────────────────────────────────────────────────┘
```

The existing scope master switch keeps its existing semantics and selector; it controls the installed pack at its install scope. It must not be silently repurposed as the project switch. The new **Use in _Project_** row is the project-owned pack override.

Provider and hook rows are rendered from the unfiltered declaration/settings projection, not the active runtime list. Disabled or dormant rows remain visible and re-enableable.

### 4.1 Status vocabulary

Show every applicable state; do not collapse configuration and authority into a single ambiguous “Inactive” badge.

| Visible label | Meaning | Treatment |
|---|---|---|
| **Active** | Enabled, required config is satisfied, required grants are present, and the contribution is eligible to run. | Positive lozenge. |
| **Disabled for _Project_** | The project pack/provider/hook override is off. | Muted lozenge; switch off. |
| **Needs configuration** | Enabled, but one or more `requiresConfig` fields are unsatisfied. Runtime is dormant. | Warning lozenge plus “Enabled, but inactive until … is saved.” |
| **Grant required** | Hook is enabled/configured but lacks an exact requested capability grant. | Warning lozenge; name the missing capability in the grant disclosure. |
| **Granted · inactive** | An exact durable grant exists, but the target is disabled, dormant, unavailable, or awaiting settings review. | Info lozenge in that capability's grant row; never imply the grant was removed. |
| **Partially enabled** | Pack is enabled but one or more child providers/hooks are disabled or blocked. | Info lozenge with enabled/total text. |
| **Settings need review** | A schema revision made a current stored or legacy **non-secret** value incompatible with its current descriptor. | Error lozenge; contribution remains fail-closed and the incompatible public value is omitted. |
| **Unavailable** | Projection/settings read failed. | Error lozenge and Retry button; no defaults are fabricated. |

If multiple blockers apply, show the target's effective state and keep each exact grant row visible.
A granted row uses **Granted · inactive** whenever enablement, configuration, availability, or
review prevents execution. This makes colour unnecessary for interpretation.

Activation, configuration, and grants are independent operations:

- saving config does not enable a disabled pack/provider/hook;
- enabling does not create a grant;
- granting does not enable or invent configuration;
- disabling preserves settings and grants unless the operator explicitly resets/revokes them;
- configuring while disabled is allowed, so an operator can prepare a contribution before enabling it.

## 5. Settings disclosure

Each pack-, provider-, or hook-owned declaration gets one **Configure** button in its runtime row. The button controls an inline panel immediately below the Project runtime grid, has `aria-expanded` and `aria-controls`, and changes to **Close settings** while open.

Only one settings panel in a card is open at a time. Opening another panel with unsaved changes prompts **Keep editing** or **Discard changes**. A dormant `requiresConfig` contribution opens its settings panel automatically only when the operator activates **Configure**; page load must not move focus or expand cards unexpectedly.

Panel header:

- contribution display name and type, e.g. **Memory provider settings**;
- visible project badge, e.g. **Hermes**;
- current schema revision in visually muted text only when useful for support, never as the primary label;
- concise status sentence, e.g. “Enabled, but dormant until External URL is saved.”

Fields remain in declaration order. Required fields precede optional fields only if the declaration itself orders them that way; the UI must not silently reorder publisher intent. Unknown field types are not guessed: render an **Unsupported setting type** error row and keep Save disabled for that owner.

## 6. Declared field rendering

Every control has a visible `<label>`, optional description, default/source hint, and stable error slot. Use the schema label when declared; otherwise sentence-case the key. Never use placeholder text as the label.

| Declared type | Control | Interaction |
|---|---|---|
| `string` | `.market-input`, `type="text"` | Empty is distinct from absent. Show declared placeholder/description; respect declared required/length/pattern/format constraints. Use `autocomplete="off"` unless the declaration explicitly defines a safe autocomplete purpose. |
| `secret` | `.market-input`, `type="password"` | Always initializes to `""`. When presence metadata is true, show **Stored for this project** and placeholder “Enter a replacement”; otherwise show **Not set**. Use `autocomplete="new-password"`, `autocapitalize="off"`, `spellcheck="false"`. Provide **Remove secret** as a separate explicit action. |
| `enum` | `.market-input` `<select>` | Options use declared labels and values. Do not add an empty option unless optional. An obsolete stored public value is omitted from the projection and produces **Settings need review**; keep the declared control available for repair rather than rendering the value. |
| `boolean` | Existing `.market-toggle-switch` with native checkbox | Visible text states **On** or **Off** beside the switch. This is a setting value, not an activation switch; its label and description must make that distinction. |
| `number` | `.market-input`, `type="number"`, `inputmode="decimal"` | Apply declared `min`, `max`, and `step`; optional numbers may be blank. Reject non-finite values. Preserve a decimal value as typed until blur/save rather than reformatting every keystroke. |

### 6.1 Defaults and reset

A non-secret field shows one of:

- **Default: _value_** when the effective value comes from the declaration;
- **Set for Hermes** when project-owned;
- **Required to activate** when named by `requiresConfig`.

A project override gets a **Use default** action beside the field. It stages removal of that override; Save performs the mutation. The form footer includes **Reset project settings** only when any project override or secret exists. It opens a destructive confirmation naming the project and contribution. Reset removes all project overrides for that owner, including stored secrets, but does not change activation or grants.

### 6.2 Write-only secret rules

The UI contract is stricter than a masked value:

- Stored secret bytes are never returned to the client. A response may contain only a boolean presence flag.
- Do not use a fake value such as `••••••`, `__REDACTED__`, or a length-shaped mask in the input value; those can be submitted accidentally and leak length.
- Do not place a secret in Lit state shared with rendering, URL state, `data-*`, `title`, `aria-label`, toast text, error text, local/session storage, analytics, context trace, revision conflict data, a proposed diff, or console output.
- A secret draft exists only in the password control until submit. Serialize it directly into the authenticated write request, then clear the control immediately after the request settles.
- On success, refetch and show only **Stored for this project**. On any validation, conflict, network, or server failure, clear the control and say **Secret was not saved; re-enter it.** If the outcome is ambiguous, refetch presence metadata without assuming success.
- **Remove secret** stages an explicit clear operation; blank input means “no secret change”, not clear.
- Dirty summaries and confirmation dialogs say **API key changed** or **API key removed**, never show old/new secret values.

## 7. Save, validation, errors, and revision changes

### 7.1 Dirty state

Editing a field, selecting **Use default**, replacing/removing a secret, or changing an enum marks only that owner form dirty. The Save button is disabled while pristine or saving. Navigating project/tab/route, closing the card, or uninstalling with a dirty form uses the existing confirmation dialog pattern:

- **Keep editing** — remain in place and focus the first dirty field.
- **Discard changes** — clear the draft, especially secret inputs, then continue.

### 7.2 Validation

Validate on blur and on Save; do not block ordinary typing. Client validation mirrors declared constraints for fast feedback, but server validation is authoritative.

- Field errors render directly below the control with `role="alert"`, `aria-invalid="true"`, and `aria-describedby` linking label, description, and error.
- Save with invalid fields focuses an error summary at the top of the panel, then the first invalid control.
- Server field errors map by field key. A safe form-level error is used for persistence/auth/network failures.
- Error text must be fixed/sanitized contract text. It never includes submitted values, especially secrets.

### 7.3 Request states

A form PATCHes its owner through the generic project route with the revision that produced its
projection: `PATCH /api/projects/:projectId/extension-settings/:packId/:kind/:id`. Pack runtime
switches use `PATCH /api/projects/:projectId/extension-settings/:packId`. These are CAS writes;
Market never writes a PackStore config record or calls a pack-specific mutable config route. See
[Project extension settings](../extension-settings.md#http-api) for the public API contract.

On Save:

1. set `aria-busy="true"` on the settings panel;
2. disable its controls, Save, reset actions, and the same owner’s activation switch; unrelated cards remain usable;
3. label the button **Saving…**;
4. on success, replace the local snapshot with the returned safe projection, clear the draft, update runtime status, and announce **Settings saved for Hermes.** in a persistent `role="status" aria-live="polite"` region;
5. on failure, preserve non-secret draft values, clear secret drafts, keep the panel open, and provide **Retry**.

Do not optimistically label a `requiresConfig` contribution Active. Only the returned effective/runtime projection can move **Needs configuration** to **Active**.

### 7.4 Revision conflict and schema evolution

Writes carry the revision from the loaded form. A stale-revision response shows:

> Settings changed elsewhere. Reload the latest settings, review your changes, then save again.

Actions are **Reload latest** and **Cancel**. Reload clears secret drafts, fetches the new schema/value projection, preserves only non-secret edits whose field still exists and whose base value did not change, and marks conflicting touched fields **Review required**. There is no “overwrite anyway” action.

After a compatible pack schema update:

- new optional fields appear with their defaults;
- new required/`requiresConfig` fields produce **Needs configuration**;
- removed fields disappear without exposing stale values;
- enum/options/constraints that reject a current stored or legacy **non-secret** value produce **Settings need review** and fail closed;
- field identity is the declared key, not label or position;
- a runtime-only secret read is validated and can fail runtime resolution closed, but it remains publicly `secretSet`-only: it does not expose a value, validation detail, or public review state, and is never copied through the browser.

## 8. Capability grant presentation

A hook row shows its declared requested capabilities as compact labelled rows under **Review grants**. Each row includes capability name, exact state, and consequence:

- **Granted** — exact durable tuple exists and the target is eligible;
- **Not granted** — requested and eligible but absent;
- **Granted · inactive** — the exact tuple exists while the target is disabled, dormant, unavailable, or awaiting review;
- **Unavailable** — reserved or unsupported; no action.

Target-level **Grant required** uses the additive `runtimeAuthorized` projection when supplied,
falling back to the legacy grant status for older servers. This preserves the ordinary exact
`decide` rule while treating an applicable EP-4 request-mutation hook with an exact `mutate` grant
as authorized without requiring a second `decide` grant. The capability rows remain independent:
a `mutate` grant is still shown even when another requested capability is absent.

Use **Grant _capability_** and **Revoke _capability_** buttons against the existing authenticated project grant routes. Grant requires a confirmation naming project, pack, hook, and exact capability. Revoke reduces authority and may proceed without confirmation, but announces the result. A `403` operator-cookie failure renders “Only a browser operator can change extension grants”; it never suggests that a bearer/session token is sufficient.

Grant mutation status is independent from settings Save. A grant/revoke re-fetches the hook projection and announces the effective state. It never auto-enables a hook.

## 9. Accessibility and responsive behaviour

- Use native inputs, checkbox switches, select, number input, buttons, and `<fieldset><legend>` per settings owner. No clickable `<div>` controls.
- Minimum interactive target is 36 CSS px in the dense desktop card and 44 CSS px at the mobile breakpoint, including toggle label padding.
- All focus states use the existing `--ring` treatment and remain visible in light/dark themes.
- Market tabs expose `role="tab"`, `aria-selected`, `aria-controls`; the active content exposes `role="tabpanel"` and a label.
- Project buttons expose the full accessible name, not colour alone. Selected project uses `aria-current="page"`.
- Status lozenges always include text. Icons are decorative unless they add a spoken label.
- Save/grant/reset outcomes use a stable live region. Loading announcements are polite; validation/persistence failures use `role="alert"`.
- On narrow screens, the Project runtime grid becomes one column: group title, then full-width rows. Labels wrap; status and actions move below the primary label. No control or error requires horizontal scrolling.
- Respect reduced motion. Existing 150 ms colour/slider transitions may remain, but no new entrance animation is needed.
- The password control supports paste and password managers; do not add reveal/copy controls in the foundation UI.

## 10. Stable browser selectors

Prefer static `data-testid` plus identity-bearing `data-*` attributes instead of interpolating arbitrary publisher ids into selector names.

| Element | Selector contract |
|---|---|
| Project scope row | `market-project-scope-row` |
| Project button | `market-project-scope`, `data-project-id` |
| Existing installed card | `market-installed-pack`, existing `data-pack-name`, `data-scope` |
| Project runtime block | `market-project-runtime`, `data-project-id`, `data-pack-id` |
| Project pack switch | `market-project-pack-enabled` |
| Provider row / switch | `market-project-provider-row`, `market-project-provider-enabled`, `data-contribution-id` |
| Hook row / switch | `market-project-hook-row`, `market-project-hook-enabled`, `data-contribution-id` |
| Effective status | `market-runtime-status`, `data-state="active|disabled|requires-config|grant-required|review|unavailable"` |
| Configure trigger | `market-settings-toggle`, `data-owner-kind`, `data-owner-id` |
| Settings panel | `market-settings-form`, `data-owner-kind`, `data-owner-id`, `data-revision` |
| Field wrapper | `market-settings-field`, `data-field-key`, `data-field-type` |
| Field control | `market-settings-input`, `data-field-key` |
| Secret presence | `market-settings-secret-state`, `data-state="set|unset"` |
| Remove secret | `market-settings-secret-remove`, `data-field-key` |
| Field reset | `market-settings-use-default`, `data-field-key` |
| Error summary | `market-settings-error-summary` |
| Save button | `market-settings-save` |
| Save/live status | `market-settings-status` |
| Whole-owner reset | `market-settings-reset` |
| Grant disclosure | `market-hook-grants` |
| Capability row / action | `market-capability-grant`, `market-capability-action`, `data-capability`, `data-state` |

Tests should first scope to the installed card, project runtime block, and owner form, then use role/label locators. Dynamic attributes disambiguate identities; visible label assertions protect the accessible contract.

## 11. Browser journey recommendations

Register focused Playwright coverage in `tests2/browser` and `tests2/tests-map.json`. Use a schema-2 fixture that declares all five field types plus a granted hook; use the real Hindsight pack for the end-to-end privacy/isolation proof.

### Journey A — navigation and all field types

1. Create Projects A and B and open `#/market/<projectA>/installed`.
2. Assert the project scope row names A and marks it current after direct navigation, reload, back, and forward.
3. Locate the fixture card and configure string, secret, enum, boolean, and number fields entirely by accessible label.
4. Exercise keyboard focus, switch Space activation, select keyboard choice, number bounds, required string error, error-summary focus, and successful Save live announcement.
5. Reload and assert every non-secret value plus secret **set** metadata persists.
6. Assert the password value is empty and the secret sentinel is absent from card HTML, all attributes/titles/ARIA text, safe API responses, console messages, local/session storage, rendered diffs, and context trace. Never include the submitted secret in test titles, failure messages, or attachments.

### Journey B — Hindsight dormancy, privacy, and project isolation

1. In Project A, find Hindsight → Memory provider. Assert project pack/provider switches are on but status is **Needs configuration**, with dormant explanatory text.
2. Save the exact declared fields: Hindsight URL, API key, Bank, Namespace, Recall scope, Automatic recall, Automatic retention, Recall budget, and Request timeout. There is no editable `mode` field. Assert **Active** only after the server projection refreshes.
3. Reload. Assert the URL and non-secret settings return, API key is only **Stored for this project**, and no key bytes are returned or rendered.
4. Switch to Project B. Assert A’s values/presence never flash or appear. Configure B, then turn **Use in Project B** off.
5. Switch back to A and assert it remains configured and Active. Revisit B and assert **Disabled for Project B**, with settings preserved but inactive.
6. Remove A’s secret and save. Assert only A changes to **Not set**; B remains isolated.

### Journey C — activation and grants

1. Use a provider plus a `mode: decide` hook requesting `decide`.
2. Assert pack, provider, and hook switches remain visible from the unfiltered declaration projection when off.
3. Assert enabled hook shows **Grant required**, Grant confirmation names the exact tuple, successful grant shows **Granted** and eligible Active state, and revoke returns to **Grant required** without changing activation.
4. Disable the hook while granted and assert **Granted · inactive**; repeat for dormant, unavailable, and review states. Re-enable/repair and assert the same exact grant is visible.
5. Add an applicable request-mutation hook with exact `mutate` but no `decide`; assert it is not labelled **Grant required** and its capability rows remain exact.
6. Switch projects and prove no activation override or grant crosses the boundary.

### Journey D — failure, stale revision, and recovery

1. Force safe server validation and persistence failures. Assert field/form errors contain no submitted values, non-secret drafts remain, secret input clears, Retry is reachable, and unrelated cards remain enabled.
2. Write a newer revision out-of-band, then submit the stale form. Assert the conflict copy and **Reload latest** path, no overwrite action, secret draft clearing, and review markers only on conflicting non-secret fields.
3. Simulate settings read failure. Assert **Unavailable**, no fabricated defaults, no editable form, and Retry recovery.
4. Update the fixture schema compatibly. Assert new defaults, removed-field cleanup, obsolete enum review, and required-field dormancy after reload.

### Journey E — accessibility and responsive layout

1. Tab through project selector, card activation, Configure, every control, Save, grant action, reset, and close in visual order.
2. Assert labels, `aria-describedby`, checked/selected state, tab semantics, error focus, live announcements, and 36/44 px targets.
3. At a narrow viewport, assert one-column runtime rows, wrapping labels/status, visible focus, and no horizontal page overflow.
4. Run the project switch with an open dirty form and verify focus returns to the confirmation trigger on cancel.

### Deterministic cleanup

Every journey owns unique fixture ids and uses `try/finally` or `afterEach` cleanup:

1. reset/delete project settings for every fixture owner, including stored secrets;
2. revoke exact capability grants;
3. clear project pack/provider/hook overrides and restore pre-test scope activation;
4. remove installed fixture packs/source assets;
5. delete Projects A and B;
6. return Market to a valid surviving project and close dialogs.

Cleanup APIs must be called even after a failed assertion. Cleanup output must report only ids/statuses, never secret request bodies.

## 12. Consistency rationale

- **Primitive match:** every new field uses `.market-input`; activation and boolean values reuse `.market-toggle-switch`; actions use `.market-btn`; status uses `.market-lozenge`; errors use `.market-error` plus the existing Settings live-region pattern.
- **Spacing/type match:** settings live inside `.market-pack-card`, use the current `.market-activation` grid, 0.4375–0.875 rem gaps, 0.6875–0.75 rem supporting text, existing radii, and the same `max-w-3xl` page column.
- **Grouping match:** project pack/provider/hook switches sit with existing activation controls, not in a new card or Settings tab. Contribution configuration expands directly below the row it configures.
- **Affordance match:** switches keep native checkbox semantics, focus/disabled states, labels, tooltips only for supplementary detail, and visible status text. Save/error/reset mirrors project Settings.
- **Intentional new pattern:** the only new pattern is a project runtime block distinct from install-scope activation. It is necessary because a server/built-in pack can be active for Project A and disabled for Project B; repurposing the existing master switch would break its established scope-level meaning and browser selectors.
