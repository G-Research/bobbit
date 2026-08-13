# Session Manager Sidebar Views

**Status:** Approved implementation specification

**Scope:** Desktop and mobile session navigation, filtering, session tags, and Pin / Unpin

**Visual reference:** [Interactive session manager mock](mockups/session-manager/README.md)

## 1. Purpose

Add a second way to browse the sessions already available in Bobbit without replacing or weakening the production sidebar.

The expanded sidebar has two views:

- **By Project** — the existing production project, goal, staff, team, child-session, and archive hierarchy.
- **By Status** — a flat session list grouped into Pinned, Unread, and Read.

The feature changes how sessions can be found and grouped. It must not create a second session-row design, a reduced action set, a separate search implementation, or a replacement project tree.

The checked-in mock is the visual source of truth for the expanded desktop sidebar. Existing production behavior is the source of truth for details the mock does not exercise, including archive loading, staff sessions, child sessions, keyboard navigation, mobile hit targets, error handling, and real-time updates.

## 2. Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative. A deliberate deviation from a `MUST` or `MUST NOT` requires an explicit design review and an update to this specification.

## 3. Non-negotiable product constraints

1. There is one production search box. It is shared by both views and behaves identically in both.
2. A single compact control row sits directly below search and contains **By Project**, **By Status**, and **Filters**.
3. There are no top-level Needs response, Unread, Read, Busy, project, goal, or tag tabs.
4. **By Status** has exactly three ordered sections: **Pinned**, **Unread**, and **Read**.
5. Those sections are mutually exclusive. A pinned unread session appears only in Pinned.
6. Rows within each section are newest-first.
7. The same production session-row renderer and action model are used in both views.
8. Live rows retain the production quick actions **Modify**, **Terminate** (or the contextually equivalent End team action), and the hamburger.
9. The hamburger uses the Lucide `Menu` icon, not an ellipsis.
10. Pin / Unpin is menu-only and is the third built-in item in a live session hamburger menu, after Modify and Terminate.
11. Production row alignment is unchanged: identity sprite and title remain left-aligned; activity time or active indicator remains right-aligned; the hover/focus action overlay occupies the same space.
12. Active work is represented by the production `.sidebar-active-dot` shimmer. Do not add textual `busy`, `working`, or similar row labels.
13. V1 exposes only Pin / Unpin as a `user_tags` mutation. Raw tag editing, tag chips, tag query syntax, and user-defined tag management are out of scope.
14. Filter state is independent per view.
15. **Show teams** exists only in By Status. It defaults off. Off hides team-member sessions but keeps team leads; on reveals team members.

## 4. Visual and interaction contract

### 4.1 Control placement

The order in the expanded sidebar is:

1. Existing top-level sidebar actions.
2. Existing production search box.
3. One compact view/filter row.
4. The active view's scrollable content.
5. Existing bottom actions and collapse control.

The control row MUST match the mock's density and labels:

```text
[By Project] [By Status]                         [Filters]
```

- The two view controls form one minimal segmented selector.
- Control labels use a compact but clearly legible `0.8333em` size.
- Filters remains a separate button in the same row.
- Switching views closes an open filter popover but does not clear search.
- There is no session-count or sort-summary row below the controls.
- The controls use real buttons with a group label, `aria-pressed`, keyboard activation, and visible focus styling.

### 4.2 View selection

Add a client preference with the conceptual type:

```ts
type SidebarSessionView = "project" | "status";
```

- Existing users and new installations default to `project`.
- Persist the preference locally so reload restores the selected view.
- Suggested key: `bobbit-sidebar-session-view`.
- Unknown or corrupt values fall back to `project`.
- Changing views does not mutate project/tree expansion state or either view's filters.

### 4.3 Status section headings

By Status renders collapsible headings in this exact order:

1. Pinned — includes the Lucide `Pin` icon.
2. Unread — includes a mail icon.
3. Read — includes an opened-mail icon.

Each visible heading contains a disclosure chevron, icon, label, and visible count. Its typography and base padding match the By Project group headings; Unread and Read add slight lower breathing room before their rows. A horizontal rule appears above every visible section except the first, never inline with the title. Expansion defaults on and persists locally per section.

- Hide a heading when its section has no rows.
- Do not reserve blank space for an empty section.
- If no sessions remain after search and filters, render one compact empty state: `No sessions match this search and filter.`
- In By Status only, goal-owned agents promote the uppercase goal title to the first line with a goal icon in the owning project's accent colour; the agent/session title moves to a quiet second line. The two-line text block is vertically centred against the sprite's layout box, with the pixel sprite optically nudged slightly upward, and Status rows retain clear whitespace between them. Standalone sessions remain single-line and carry a smaller identity icon in the owning project's accent colour, optically nudged slightly downward: ordinary sessions use the session/chat icon, while staff sessions use the staff icon. Do not add a `Goal` label, project names, role labels, busy labels, tag chips, or status badges.

## 5. Session tag contract

Every session list representation, live or archived, MUST expose these two additive fields:

```ts
server_tags: string[];
user_tags: string[];
```

Missing fields from legacy persisted records are read as empty arrays.

### 5.1 Tag format

Tags use normalized `key=value` strings.

- Keys are lowercase kebab-case.
- A keyed tag has at most one current value.
- Exact duplicate strings are removed.
- Unknown tags are preserved.
- Clients MUST use shared tag helpers rather than open-coded substring matching.

### 5.2 `server_tags`

`server_tags` are server-controlled projections of canonical session state. Clients MUST NOT submit, edit, or overwrite them.

The server emits, at minimum, the tags needed by this feature:

- `read-state=unread|read`
- `activity-state=busy|not-busy`
- `archive-state=archived|live`
- `team-kind=lead|member|none`
- `project-id=<id>` when a project exists
- `goal-id=<id>` when a goal exists

`read-state` MUST use the same notification/read policy that drives the production unread treatment. Do not introduce a second timestamp-only definition in By Status. The existing unread dot, Show Read behavior, status grouping, and emitted read-state tag must be covered by parity tests so they cannot drift.

`activity-state=busy` means the same states as production Show Busy: streaming, aborting, preparing, starting, or compacting. Adding a new production busy-like state requires updating the shared classifier, not only one view.

`team-kind=member` means a team-owned non-lead session. At minimum this covers a session with `teamLeadSessionId`, and archived/legacy team rows with a `teamGoalId` whose role is not `team-lead`. Delegates and first-class child sessions are not team members solely because they have a parent.

The server refreshes derived tags whenever their canonical source changes. The UI may update an in-memory projection optimistically, but the next authoritative session refresh must reconcile it.

### 5.3 `user_tags`

`user_tags` are durable user-owned metadata. V1 supports one UI-controlled key:

```text
pinned=true
```

A session is pinned only when its normalized `user_tags` contain `pinned=true`.

- Pinning replaces any existing `pinned=*` value with exactly one `pinned=true`.
- Unpinning removes every `pinned=*` value.
- Pin / Unpin preserves all unrelated user tags.
- Server tags are never changed by the pin endpoint.
- The UI does not expose unrelated user tags in V1.

## 6. Pin / Unpin persistence and API

Provide one narrow, idempotent endpoint instead of exposing arbitrary tag mutation:

```http
PUT /api/sessions/:id/pin
Content-Type: application/json

{ "pinned": true }
```

The response returns the authoritative updated `user_tags`.

Requirements:

- `pinned` MUST be a boolean; invalid payloads return `400`.
- Unknown session IDs return `404`.
- The operation works for live, dormant, terminated, and archived persisted sessions.
- The server writes durably before returning success.
- Repeating the same request succeeds without duplicating tags.
- The update is propagated through the normal session-list invalidation/update path so other connected clients refresh.
- Concurrent requests are last-write-wins at the persisted session record.

The client updates the row optimistically so Pin immediately moves it into Pinned and Unpin immediately reclassifies it. If the request fails, restore the previous tags and show the existing production error/toast treatment.

Pin state survives reload, gateway restart, archive, restore/continue flows where session identity is retained, and opening the app from another authenticated browser.

## 7. By Project contract

By Project is the current production sidebar, not a simplified reconstruction.

Implementation MUST continue through the existing project/tree model and preserve:

- Headquarters and registered-project presentation.
- Project ordering and drag reorder.
- Project, goal, team-lead, staff, ungrouped-session, child-session, delegate, and archive sections.
- Goal nesting, spawned sub-goals, workflow progress, project/goal/staff actions, and create actions.
- Existing expansion state, reveal-on-navigation, keyboard navigation, search retention of ancestors, and archive pagination.
- Existing loading, preparation, connection, empty, provisional-project, error, and orphan states.
- Existing desktop, mobile, and collapsed-sidebar behavior.

The new control row is the only required structural addition above this view. Do not replace `buildSidebarTree`, flatten the project tree, or feed a status-sorted model into By Project.

### 7.1 By Project filters

The Filters popover contains exactly the existing production visibility toggles:

| Toggle | Default | Semantics |
|---|---:|---|
| Show Archived | Off | Uses current lazy archive loading, pagination, and clearing behavior. |
| Show Busy | On | Uses the shared production busy predicate. |
| Show Read | On | Uses the shared production read filter. |

Do not add project or goal facets to this popover.

Existing By Project persisted values and shortcuts remain valid. The implementation SHOULD retain the existing local-storage keys for backward compatibility:

- `bobbit-show-archived`
- `bobbit-show-busy`
- `bobbit-show-read`

## 8. By Status contract

### 8.1 Eligible session set

By Status starts from the same sidebar-eligible session population as production, before project/goal nesting. It MUST NOT expose internal sessions that the production sidebar deliberately suppresses.

The flattened population includes each eligible session exactly once, including:

- ordinary project and ungrouped sessions;
- goal sessions and team leads;
- staff-backed current sessions using the existing staff display/action resolution;
- delegates and first-class child sessions;
- team members only when Show teams is on;
- archived sessions only when Show Archived is on or production search temporarily exposes matching archived results.

Deduplicate by session ID. If a live and archived collection both contain the same ID, the live record wins.

By Status has no tree indentation, project/goal headers, or team-child nesting. Its three flat status sections have independent persisted expansion state. A child or delegate is a normal flat row in this view, with owning-goal membership inherited from its canonical tree ancestors when the session record does not carry a goal ID. Its row action eligibility and read-only behavior remain unchanged.

### 8.2 Filter order

For a non-empty trimmed search query, apply production search behavior described in section 10.

Otherwise apply these gates in order:

1. Show Archived.
2. Show teams.
3. Show Busy.
4. Show Read.

The existing active-session exemption remains exact for Show Busy and Show Read. Show Archived and Show teams are categorical gates and are not bypassed merely because a hidden row is currently selected. Search may temporarily expose it.

### 8.3 Mutually exclusive classification

After eligibility and filters, classify each session once:

```ts
if (hasUserTag(session, "pinned", "true")) return "pinned";
if (isUnreadByCanonicalPolicy(session)) return "unread";
return "read";
```

Pinned always wins. There is no duplicate rendering across sections.

The classification is independent of activity state. A busy session can be Pinned or can remain in its read-state section; the production active shimmer communicates activity.

### 8.4 Ordering

Sort each section independently by:

Rows that visibly render a last-activity value use:

1. `lastActivity` descending;
2. `createdAt` descending;
3. `id` ascending as a deterministic final tie-breaker.

Rows showing the active/busy shimmer instead of a last-activity value form a stable cluster ahead of timestamp rows and sort by `createdAt` descending, then `id` ascending. Hidden `lastActivity` churn therefore does not rearrange several simultaneously active agents when the user has no visible timestamp change with which to understand that movement. When a row transitions between shimmer and timestamp presentation, it rejoins the corresponding ordering policy.

Do not sort pinned rows by the time they were pinned. Do not sort unread ahead of pinned. Do not apply project, goal, title, role, or manual ordering inside a section.

Real-time activity, read-state, archive-state, team-state, or pin-state changes re-run the same pipeline. Examples:

- Pinning a row moves it immediately to Pinned.
- Unpinning moves it to Unread or Read according to current canonical read state.
- Opening an unread session uses the existing mark-read path and moves it to Read when the authoritative/optimistic state changes.
- A newly unread non-pinned row moves to Unread.
- Updated activity may change a row's position within its current section.

Meaningful ordering changes use a 280 ms FLIP translation (`transform` only, ease-out) so rows preserve spatial continuity without delaying authoritative data. The row whose presentation signature changed also receives a subtle 650 ms project-identity trace: a 5% surface tint and a 24% two-pixel inset rail. Displaced rows that did not themselves change move without the trace.

For the duration of a row's FLIP movement, pointer-generated `click` and `auxclick` events targeting that row or any descendant are canceled in the capture phase. This applies equally to the row body and its action buttons, preventing an element that moved under the pointer from accepting an unintended action. Keyboard-generated activation remains available. Reduced-motion users receive the immediate final ordering with no movement, trace, or temporary click suppression.

### 8.5 By Status filters

The Filters popover contains:

| Toggle | Default | Semantics |
|---|---:|---|
| Show Archived | Off | Same archive semantics as By Project, but independent value. |
| Show Busy | On | Same classifier as production, independent value. |
| Show Read | On | Same classifier as production, independent value. |
| Show teams | Off | Off hides team members; on includes them. Team leads remain visible in either state. |

Suggested storage keys:

- `bobbit-status-show-archived`
- `bobbit-status-show-busy`
- `bobbit-status-show-read`
- `bobbit-status-show-teams`

The Filter button's active styling is calculated only from the active view's defaults. Show teams being off is the default and does not make Filters look active; turning it on does.

Existing filter shortcuts operate on the active view's corresponding Archived, Busy, or Read value. Show teams does not require a keyboard shortcut in V1. Shortcut labels shown in the popover must match the registered production bindings.

## 9. Independent state requirements

The two views retain separate Archived, Busy, and Read values.

Example that MUST work:

1. In By Project, turn Show Archived on and Show Read off.
2. Switch to By Status; its defaults remain Archived off and Read on.
3. Turn Show teams on.
4. Switch back; By Project still has Archived on and Read off.
5. Reload; all persisted values and the selected view are restored.

An open filter popover closes when switching views. It is re-rendered from the newly active view and its title reads either `By Project filters` or `By Status filters`.

## 10. Search contract

There is one `SearchBox`, one query state, and one production search pipeline.

- The query is not copied, reset, or transformed when changing views.
- Search uses the production matching surface, including its current title, role, goal, staff, archive, and remote archived-search behavior.
- Do not add project-name matching or raw tag syntax solely because the mock contains project metadata.
- A non-empty trimmed query bypasses Busy and Read filters in both views.
- In By Status it also bypasses Show teams so a matching team member is discoverable.
- Existing production archived-search behavior may temporarily expose matching archived results while Show Archived is off; this must not mutate the persisted toggle.
- Clearing search immediately reapplies the active view's filters.
- By Project preserves matching ancestors and its existing ephemeral expansion/reveal behavior.
- By Status remains flat and keeps the Pinned / Unread / Read classification and newest-first order for matching results.
- Full Search remains available and unchanged.

## 11. Canonical session row and action contract

### 11.1 One renderer

Both views MUST call the existing production live or archived row renderer. Do not fork the markup into `renderStatusSessionRow`, copy the mock row into production, or maintain separate CSS for status rows.

If tree-specific concerns prevent direct reuse, refactor the canonical row into shared row content plus optional tree chrome. The final DOM, classes, sizing, action descriptors, navigation, and accessibility behavior must remain shared.

The following production behavior is invariant across views:

- Bobbit identity color, accessory, animation, unread pulse, preparation spinner, and selected state.
- Title rendering, highlighting, truncation, and active title treatment.
- Right-aligned relative time and unread dot.
- `.sidebar-active-dot` shimmer in place of time for active work.
- Middle-click/open-new-window behavior where currently supported.
- Row selection, connection, read marking, read-only archive opening, and error handling.
- Desktop hover/focus action overlay.
- Mobile always-visible action controls and effective touch targets.
- `data-session-id`, navigation identity, and test hooks needed by production keyboard navigation.

### 11.2 Quick actions

For a normal live session, preserve the visible quick action order:

1. Modify.
2. Terminate.
3. Hamburger.

Pin / Unpin MUST NOT become a permanent quick button.

Contextual production substitutions remain valid: for example Edit staff and End team. Hidden/ineligible actions remain governed by existing production rules.

### 11.3 Hamburger and menu ordering

Use the real Lucide `Menu` icon and the existing `SidebarActionsPopover` on desktop, mobile, sidebar rows, and header surfaces that share session action descriptors.

The live menu's built-in order begins:

1. Modify / Edit staff.
2. Terminate / End team.
3. Pin session / Unpin session.
4. Refresh agent, when eligible.
5. Fork, when eligible.
6. Existing copy, prompt, new-window, and extension actions in their production order.

Pin's label reflects current state and uses `Pin` / `PinOff`. It is not destructive.

Archived rows retain the existing archived-safe action model. Pin / Unpin is permitted because it mutates only user metadata. Place it after Continue in new session and Copy link—third when Continue is eligible. When Continue is ineligible and hidden, do not render a blank placeholder; Pin / Unpin naturally becomes the second visible item. Preserve View System Prompt and Open in new window after it. Do not leak live runtime or extension actions into archived menus.

All action buttons and menu items stop row activation as they do in production. Menu focus, Escape close, focus restoration, outside-click handling, roving keyboard focus, FLIP motion, and reduced-motion behavior remain unchanged.

## 12. Responsive and collapsed behavior

### 12.1 Mobile

Mobile uses the same view state, search query, tag classification, filters, sorting, and action descriptors.

- The selector and Filters appear immediately below the mobile sidebar search surface at mobile density.
- Section headings remain compact and counts remain visible.
- Session actions remain always visible on touch; do not introduce hover-only controls.
- The hamburger remains available even when lower-priority quick actions must collapse for width.
- Tapping any action does not select the row.
- Existing back navigation, scroll behavior, landing/sidebar transitions, safe areas, and composer layout remain unaffected.

### 12.2 Collapsed sidebar

Collapsed mode remains functional in either view.

- By Project preserves the existing compact project/session representation.
- By Status uses the same filtered and sorted flat population, rendered with existing compact session affordances.
- Section labels MAY collapse to separators or accessible labels when there is insufficient width, but section order and row order do not change.
- Expanding the sidebar reveals the selected view and full control row without resetting scroll, query, or filters.

## 13. Real-time, archive, and multi-client behavior

The implementation must use existing authoritative session refresh and invalidation paths.

- Session creation/removal, status, activity, title, role, staff ownership, archive, read state, and pin state update both views without reload.
- By Project continues to use current archive lazy loading and pagination.
- By Status Show Archived triggers the same fetch/clear lifecycle using its own toggle value.
- Switching between views must not discard already fetched data needed by the other view; normal production cache ownership decides when data is cleared.
- Archived search remains separate from normal archive pagination.
- A pin change in one browser appears in another through the normal update channel.
- No filter preference other than durable session tags is synchronized across browsers in V1; view/filter preferences remain local client preferences.

## 14. Accessibility requirements

- View buttons have stable accessible names, pressed/selected state, visible focus, and Enter/Space activation.
- Filters has `aria-haspopup="dialog"` and synchronized `aria-expanded`.
- Filter rows use native labelled checkboxes.
- Escape and outside click close the filter popover; keyboard close returns focus to Filters.
- Status sections are labelled groups with counts available to assistive technology without duplicate announcements.
- Session rows and action controls preserve current keyboard order and accessible names.
- Hamburger triggers use `aria-haspopup="menu"` and synchronized `aria-expanded`.
- No meaning relies only on color, shimmer, hover, or sprite animation.
- Light, dark, and all supported palette themes use existing semantic tokens.

## 15. Production-preservation guardrail

This work is incomplete if By Project looks correct but an existing production capability disappears or changes behavior.

At minimum, preserve:

- search and Full Search;
- sidebar resize/collapse;
- project reorder and settings;
- project, goal, staff, session, team, child, delegate, and archive navigation;
- create session/goal/staff flows;
- workflow and goal progress affordances;
- current quick actions, action eligibility, extension launchers, and header/sidebar parity;
- archived read-only behavior and Continue in new session eligibility;
- unread policy, mark-read persistence, notifications, and active indicators;
- keyboard navigation, reveal-on-navigation, deep links, middle-click, and open-new-window;
- mobile action visibility and hit targets;
- WebSocket/viewer invalidation and background-tab refresh;
- all existing sidebar empty/loading/error states.

Prefer composing existing classifiers, renderers, action descriptors, archive loaders, and navigation models. Do not duplicate them to make the new view easier to build.

## 16. Implementation boundaries and recommended ownership

Recommended client ownership:

- `src/app/state.ts` — selected view and per-view persisted filter values.
- `src/ui/components/sidebar-filters.ts` — active-view filter descriptors and toggle handlers.
- `src/app/sidebar.ts` — selector placement and By Status population/rendering.
- `src/app/render-helpers.ts` — canonical visibility/read classifiers and shared row rendering only.
- `src/app/session-actions.ts` — Pin / Unpin descriptor and shared action order.
- `src/app/api.ts` — narrow pin request and refresh/invalidation integration.

Recommended server ownership:

- `src/server/agent/session-store.ts` — durable `user_tags` and derived/exposed `server_tags` fields; `user_tags` must be updatable.
- `src/server/agent/session-manager.ts` — live and archived list serialization.
- `src/server/server.ts` or the established session route module — pin endpoint and validation.
- Existing WebSocket/session-list invalidation — cross-client propagation.

A pure status-view selector/classifier SHOULD accept sessions, active-view filters, search state, and tag helpers and return the three ordered arrays. Keeping that logic pure makes exclusivity and ordering easy to pin without coupling tests to DOM structure.

## 17. Test and acceptance plan

All new tests belong in `tests2/` and must be registered in `tests2/tests-map.json`.

### 17.1 Core tests

Pin the following as pure or server tests:

- tag normalization, keyed replacement, and unknown-tag preservation;
- legacy missing tags becoming empty arrays;
- server tag projection parity with production busy, read, archive, and team classifiers;
- Pinned > Unread > Read exclusivity;
- newest-first ordering and deterministic ties;
- Show teams member classification without hiding delegates/children;
- independent filter defaults, persistence keys, and active-view shortcut routing;
- search bypass behavior;
- live-over-archived deduplication;
- canonical action ordering with Pin / Unpin third for live sessions.

### 17.2 Server/integration tests

Cover:

- pin and unpin for live and archived sessions;
- input validation and unknown IDs;
- idempotency and no duplicate pin tags;
- preservation of unrelated `user_tags` and all `server_tags`;
- durability after store reload/gateway restart;
- live and archived session-list serialization;
- session-list invalidation/broadcast after mutation;
- authorization behavior matching other session mutations.

### 17.3 Browser journey

Add a real user-facing journey that proves, in one isolated run where practical:

1. A clean profile starts in By Project with the existing tree intact.
2. Search, Full Search, project expansion, and an existing session action still work.
3. By Status shows Pinned, Unread, and Read in that order, with no duplicate session IDs.
4. Each section is newest-first.
5. Show teams defaults off; enabling it reveals members without hiding leads.
6. Project and Status filters retain independent values across switches and reload.
7. Search is shared, bypasses visibility filters, and clearing it restores them.
8. Pin is the third live menu item; choosing it moves the row to Pinned immediately and survives reload.
9. Unpin reclassifies the row correctly.
10. Opening an unread row marks it read and moves it to Read.
11. Show Archived uses archived-safe rows/actions and does not change the other view's archived preference.
12. Live quick actions remain Modify, Terminate, hamburger; Pin is not a quick action.
13. The hamburger is a Menu icon, right-side time alignment remains intact, and active rows use the shimmer without busy text.
14. Mobile exposes the same views and filters, with always-visible actions and no action-to-row click leakage.
15. Keyboard focus, Escape close, and view/filter reload persistence work.
16. Test-created sessions, tags, archives, and preferences are cleaned up.

Existing sidebar fixture and journey coverage must remain green, especially search/filter, archived actions, keyboard navigation, project reorder, staff subsection, mobile action menus, deep-link reveal, and archive pagination.

## 18. Definition of done

The feature is complete only when all of the following are true:

- The expanded production sidebar visually matches the checked-in mock for the approved controls, headings, grouping, row density, and filter contents.
- By Project remains behaviorally equivalent to production before this feature, aside from the added selector row and independent filter ownership.
- By Status contains exactly Pinned, Unread, and Read, with exclusive classification and newest-first ordering.
- Show teams is Status-only, defaults off, and has the approved semantics.
- Pin / Unpin is durable, cross-client, menu-only, and correctly ordered.
- Search is shared and preserves all production search behavior.
- Live and archived rows use canonical production rendering and actions.
- Desktop, mobile, collapsed, keyboard, archive, and real-time paths are covered.
- Existing tests pass and new regression tests pin every new invariant above.

## 19. Explicit non-goals

- Raw server/user tag editors.
- User-created tag filters or saved tag queries.
- Project or goal facets in Filters.
- A Needs response view or other top-level status tabs.
- A separate status-specific search box.
- A new session card/row design.
- Pin ordering by pin time or drag-and-drop pin ordering.
- Server-synchronized view/filter preferences.
- Changing notification policy, read semantics, project hierarchy, or archive lifecycle merely to implement the new view.
