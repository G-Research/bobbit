# Non-hook extension grants — Market UX

**Status:** design guidance for the generic EP-6 capability slice.

**Surface:** Market → Installed → selected project → existing **Project runtime** rows.

**Scope:** presentation and interaction only; the server remains the authority for principal identity, capability support, active state, authentication, and audit state.

## Decision

Non-hook grants use the existing Market grant pattern. A pack-level principal appears in the existing **Pack** target row and uses the same **Review grants** disclosure, capability row, status copy, `market-btn` action, confirmation dialog, inline error, and live success message already used by hook grants. Do not add a Hindsight page, permissions tab, grant-all control, capability checkbox matrix, or a second permissions store/UI.

The distinction is identity, not interaction:

- Hook row: exact `(project, pack, hook, capability)` authority; keep its current layout and behavior unchanged.
- Pack row: exact `(project, pack, pack principal, capability)` authority. One pack row is shared by its service lifecycle, panels/routes, and agent tools; do not repeat the same capability under each caller.

The server projection is the source of truth. The client must not infer support from a pack name, manufacture capabilities, or optimistically treat activation as authority.

## Existing-pattern inventory and consistency rationale

The implementation must reuse these primitives from `src/app/marketplace-page.ts` and `src/app/marketplace.css`:

| Existing primitive | Required reuse |
|---|---|
| `.market-project-runtime` and `.market-runtime-grid` | Keep grants inside the installed pack card's current project-owned surface. |
| `.market-runtime-target.market-runtime-target--pack` / `market-project-pack-row` | Attach non-hook grants to the existing Pack row; do not create a new row beside it. |
| `.market-runtime-kind`, `.market-runtime-target-main` | Keep the current `Pack` kind label and server-resolved pack display name. |
| `.market-hook-grants` visual treatment | Generalize/alias the class for pack and hook principals without changing spacing, type, border, or disclosure behavior. Preserve the hook class/test seam for backward compatibility. |
| `.market-capability-grant` | Use one exact capability per row, with state text and one action. No bulk selection. |
| `.market-btn` | Reuse default, hover, focus-visible, disabled, and mobile 44 px minimum-height behavior exactly. |
| `.market-error[role="alert"]` | Keep failures adjacent to the affected capability row. |
| `.market-settings-status[role="status"][aria-live="polite"]` | Announce successful grant/revoke and refreshed state. |
| `confirmAction()` | Keep the existing grant confirmation structure and button labels. |
| `.market-lozenge` | Continue to show activation/runtime status independently from authority. Do not use the lozenge as the grant action. |

No new toggle is appropriate: activation toggles whether a contribution is available; a grant is a consented authority change. Reusing the toggle would collapse two safety concepts and make an enabled pack look authorized.

At the `max-width: 640px` breakpoint, keep the existing two-column target layout and full-width disclosure. Capability content may wrap, while its action remains a normal `.market-btn`; do not introduce horizontal scrolling.

## Information architecture

### Pack row

When the active server projection reports supported non-hook capabilities, render the same disclosure currently shown for hooks:

```text
Pack  Hindsight                         On   Active
Review grants
  Manage service          service.manage       Not granted   [Grant service.manage]
  Read memory             memory.read           Granted       [Revoke memory.read]
  Read all memory         memory.read.all       Not granted   [Grant memory.read.all]
```

`Review grants` remains collapsed by default. Its summary should include a concise count when available, for example `Review grants · 1 of 3 granted`; do not replace the exact state in the expanded rows.

Each row shows:

1. a short human label;
2. the exact platform string in `<code>` or equivalent monospace treatment;
3. one of the state strings below;
4. the existing Grant/Revoke button;
5. description/help text when needed, connected with `aria-describedby`.

Showing the exact string is mandatory. Friendly labels alone are too ambiguous for a security decision and make audit comparison difficult.

### Closed capability copy and order

Render only capabilities supplied as supported by the server and recognized by the platform-owned closed vocabulary. Use this stable order and copy when several are present:

| Capability | Human label | One-line description |
|---|---|---|
| `service.manage` | Manage service | Start, stop, and manage this pack's project service. |
| `memory.read` | Read memory | Read memory available to this pack in the current project scope. |
| `memory.write` | Write memory | Create and update memory in the current project scope. |
| `memory.reflect` | Reflect on memory | Produce derived reflections from memory this pack is allowed to read. |
| `memory.invalidate` | Invalidate memory | Mark existing memory as invalid so it is no longer used as current knowledge. |
| `memory.read.all` | Read all memory | Read all project memory, including memory outside the pack's ordinary scoped context. |

`memory.read.all` must retain the explicit “all project memory” wording in both its row help and confirmation. Do not visually imply that `memory.read` includes it, or that granting one capability grants any other. Do not show wildcard or “Allow all” actions.

Unknown or malformed capability strings may be shown as `Unavailable` only when the safe server projection intentionally preserves them for forward visibility. They must never receive an enabled action.

### State vocabulary

Reuse the current state language:

- `Not granted` — supported for the active pack, exact grant absent.
- `Granted` — exact durable grant present and pack active.
- `Granted · inactive` — durable grant present, but activation/configuration currently prevents use. Revoke stays available.
- `Unavailable` — unknown, malformed, stale, unsupported, uninstalled, or otherwise not safely actionable. No grant action.

If a supported but ungranted pack is inactive, keep `Not granted`, disable its Grant action, and associate the explanation `Enable this pack before granting this capability.` The Pack row's existing Disabled/Needs configuration status supplies the visible inactive signal. Never allow the UI to grant merely because stale client data still shows the pack.

Do not optimistically change state. During mutation, preserve the last server state, disable only the exact tuple's action, set the disclosure/row `aria-busy="true"`, and use `Granting…` or `Revoking…`. On completion, re-fetch the durable projection; revocation must therefore be visible without reload and stale work cannot leave a positive UI state.

### Grant history (audit)

Add a single read-only **Grant history** disclosure to the existing selected-project Installed surface, near the Project runtime content. It is not a new navigation destination or a second permissions UI and contains no mutation controls. This project-level placement is necessary so events for an uninstalled pack remain inspectable after its pack card disappears.

Show the API's newest bounded window in its returned append order: earliest to latest within that window. Do not re-sort by timestamp in the client; append/recovery order is authoritative. Each compact row contains only:

- localized date/time via a semantic `<time datetime="full ISO value">`;
- `Granted` or `Revoked` text (not color alone);
- exact capability string;
- principal type and exact identity (`Pack · hindsight` or `Hook · hindsight / hook-id`);
- actor (`admin` or `localhost`, or later server-provided safe label).

Example:

```text
Grant history
Apr 8, 10:39     Revoked    decide             Hook · advisor / choose-mode  admin
Apr 8, 10:42     Granted    memory.read.all    Pack · hindsight             admin
```

Legacy hook audit rows remain readable and appear in the same list; missing additive principal metadata is interpreted only for display using the legacy row's existing `hookId`. Never hide orphaned/uninstalled pack events. Empty copy: `No extension grant changes have been recorded for this project.` Loading copy: `Loading grant history…`. Failure copy: `Could not load grant history.` with the existing **Retry** button.

## Confirmation and authentication

### Grant

Opening authority always uses the existing confirmation dialog. The dialog names all consent-relevant identity fields and never relies on background context:

- Title: `Grant extension capability`
- Pack-principal body: `Grant memory.read.all to pack Hindsight (hindsight) for Hermes? This lets it read all project memory, including memory outside its ordinary scoped context.`
- Hook-principal body: preserve the existing hook wording.
- Buttons: `Cancel` and `Grant capability`

Use the human pack label followed by exact `packId`, exact capability, and project name. Never offer confirmation for a client-inferred, inactive, uninstalled, shadowed, or unsupported pack.

Focus moves into the dialog, is trapped there, and returns to the invoking action on close. Escape and Cancel make no change. Enter may confirm only while the confirm button/dialog owns keyboard interaction; typing or activating another dialog control must not accidentally grant.

### Revoke

Preserve the existing one-step Revoke behavior: revocation removes authority and should be immediate. Do not add a second confirmation only for non-hook capabilities. Disable the exact row while the request is pending, then re-fetch. Success copy is `Revoked memory.read for Hindsight in Hermes.`

### Operator authentication

The control can be visible to a normally authenticated reader, but the server decides whether the signed browser-operator cookie permits mutation. Never infer operator authority from local UI state or send actor identity from the client.

On `401`/`403`:

- keep the durable state unchanged;
- restore the action button;
- render adjacent `role="alert"` copy: `Sign in as a browser operator to change extension grants.`;
- use the existing authentication entry point if a re-authentication action is offered;
- do not leak cookie, bearer, actor, or server detail.

Switching project while a confirmation or request is open cancels/ignores that interaction. A response for project A must never update project B's surface.

## Error and recovery behavior

| Condition | Required behavior |
|---|---|
| Network/ordinary server failure | Keep last durable state, restore action, show `Could not grant/revoke this extension capability. Retry.` inline. |
| `400` malformed/unknown | Fail closed, refresh projection, show `This capability request is no longer valid.`; no enabled retry until valid server data returns. |
| `404` inactive/uninstalled/stale pack | Fail closed, refresh projection, show `This pack is no longer active for this project.` |
| `422` unsupported | Fail closed, refresh projection, show `This pack does not support this capability.` |
| Concurrent/project revision conflict | Refresh instead of merging local state; announce `Extension grants changed elsewhere. Showing the latest state.` |
| `503 EXTENSION_GRANT_AUDIT_UNAVAILABLE` partial success | Re-fetch authority immediately: the access change already took effect. Show a persistent warning, `Access changed, but its audit record is pending.` Never roll back or display the old authority. Offer `Retry audit recording` only by replaying the exact original action; do not invert it from the refreshed button state. |
| Audit GET failure | Grant controls remain usable; history shows its independent Retry state. Do not imply active grants are unknown if their projection loaded successfully. |

All errors remain scoped to the exact project/pack/principal/capability. A failed `memory.read` action must not disable or relabel `memory.write`.

## Accessibility acceptance criteria

- Native disclosure semantics expose expanded/collapsed state and work with Enter/Space.
- Every capability action has an accessible name matching its exact authority, e.g. `Grant memory.read.all`; row context exposes the associated pack/principal.
- State is always written as text; color, border, or lozenge color is supplemental only.
- Focus-visible styling exactly matches `.market-runtime-target :focus-visible`.
- Pending buttons are disabled, retain their row position, and use text plus `aria-busy`; no spinner-only status.
- Inline failures use `role="alert"`; successful refresh messages use the existing polite live region.
- Help/disabled reasons use `aria-describedby`; do not rely on `title` alone.
- Audit rows use headings/list semantics at narrow widths rather than an inaccessible clipped table. ISO timestamps remain machine-readable.
- At mobile width, all actions keep the existing 2.75 rem minimum target height and a logical DOM/tab order: disclosure → capability information → action → error.
- Confirmation identifies project, exact pack, principal type, and capability to screen-reader users as well as sighted users.

## Browser journey specification

Add a registered `tests2/browser` journey using a fixture pack with the non-hook capabilities `service.manage`, `memory.read`, and `memory.read.all`. Drive the production Market controls; do not call grant/revoke APIs as a setup shortcut for the behavior under test.

1. Open the canonical Market route for project `Hermes`, Installed tab, with the fixture installed and active.
2. Locate its existing `market-project-runtime` and `market-project-pack-row`. Assert no duplicate permission panel exists and the hook rows, if present, retain their existing controls.
3. Open **Review grants** from the Pack row by keyboard. Assert all three exact capability strings, readable labels, and `Not granted` states; assert there is no wildcard/Grant all control.
4. Assert `Grant memory.read.all` is keyboard reachable and has that accessible name. Activate it.
5. Assert the confirmation names project `Hermes`, exact pack ID, principal `pack`, capability `memory.read.all`, and the broad “all project memory” consequence. Cancel with Escape; assert state remains `Not granted` and audit has no new event.
6. Open again and confirm **Grant capability**. While pending, assert only that exact action is disabled and reads `Granting…`. Await the server-refetched `Granted` state and polite success announcement.
7. Reload the page and reopen the same project/pack disclosure. Assert `memory.read.all` remains `Granted`, while `memory.read` and `service.manage` remain `Not granted` (exact scoping/no implied authority).
8. Open project **Grant history**. Assert a `Granted` row attributes the exact project, pack principal, pack ID, capability, actor, and parseable timestamp. Assert the newest bounded rows retain the API's append order (earliest to latest). Include a legacy hook audit fixture and assert it remains readable as a Hook principal in the same history.
9. Revoke through the same capability row. Assert `Revoking…`, then server-refetched `Not granted`; verify a Revoked audit row appears and a second reload preserves the state.
10. Simulate stale/inactive state by disabling the pack through its existing activation toggle. Assert ungranted actions are disabled with an accessible explanation. If an existing grant fixture is retained, assert `Granted · inactive` remains visible and Revoke remains enabled.
11. Simulate missing signed operator authentication for a mutation. Assert `403` leaves state unchanged and shows the adjacent operator-auth alert; no actor/token/cookie value appears in page text.
12. Simulate `503 EXTENSION_GRANT_AUDIT_UNAVAILABLE`. Assert the UI re-fetches and shows the changed authority plus pending-audit warning, then the exact retry recovers the audit without reversing access.
13. Uninstall the fixture and assert no pack grant controls remain. The project-level Grant history must still show its prior exact pack events.
14. Run at a mobile viewport and keyboard-only desktop pass; assert no horizontal overflow, 44 px actions, visible focus, logical tab order, dialog focus return, and live-region/error announcements.

Suggested additive test seams may use generic names such as `market-extension-grants` and `market-grant-history`, but existing `market-hook-grants`, `market-capability-grant`, `market-capability-action`, and hook browser assertions must remain valid.

## Non-goals

- No Hindsight-specific wording, route, storage, panel, or policy.
- No capability bundles, inheritance, presets, wildcards, or grant-all.
- No runtime/service/memory implementation.
- No optimistic authorization, client-owned actor, or client-side support inference.
- No redesign of activation toggles, Pack/Hook rows, buttons, confirmation dialog, or legacy hook grants.
