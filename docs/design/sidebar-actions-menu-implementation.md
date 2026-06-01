# Sidebar Actions Menu implementation plan

> Superseded by design-doc Revision 2.1 — see docs/sidebar-actions-menu.md for the authoritative shipped behavior.

## Scope and ownership

This document is the implementation handoff for the Sidebar Actions Menu goal. It is based on inspection of:

- `src/app/render-helpers.ts`
- `src/ui/components/ProjectPickerPopover.ts`
- `src/ui/dialogs/CopyLinkFallbackDialog.ts`
- `src/app/sidebar-nav.ts`
- `src/ui/components/AgentInterface.ts`
- `src/app/session-manager.ts`
- `src/server/server.ts` session creation and continue routes

Implementation should be split by owner so parallel agents do not collide:

| Area | Owner file(s) | Responsibility |
|---|---|---|
| Sidebar action modeling and row wiring | `src/app/render-helpers.ts` | Build session/goal action arrays, keep existing hover buttons, add hamburger trigger, mount/unmount popover, copy/fork/open handlers, `canForkSidebarSession` guard. |
| Popover component and FLIP helper | `src/ui/components/SidebarActionsPopover.ts` plus optional `src/ui/components/sidebar-actions-flip.ts` | Render menu, keyboard nav, outside/Escape dismissal, positioning, shared-element animation, Fork "New worktree" `menuitemcheckbox`. |
| Session fork endpoint + helper | `src/server/server.ts`, `src/app/session-manager.ts` | Add dedicated `POST /api/sessions/:id/fork` (transcript clone + `newWorktree` body), then export a client helper that calls that endpoint, refreshes session list, and connects. |
| GitHub link resolver | `src/server/server.ts` and `src/app/api.ts` | `GET /api/goals/:id/github-link` (`execFile`-based, sanitized) still exists but no longer gates the menu item; `Open on GitHub` mirrors the goal-row PR badge. |
| Modal/open-popover suppression | `src/ui/components/AgentInterface.ts` | Add `sidebar-actions-popover` to the global Escape suppression selector. |
| Tests | `tests/e2e/ui/sidebar-actions-menu.spec.ts` plus conditional unit test | Browser coverage for menu behavior; unit coverage is required whenever FLIP rect/delta logic is extracted to a helper. |

No `src/` or `tests/` changes are made by this research task.

## Existing UI contracts

### Session rows

`renderSessionRow(session: GatewaySession)` currently:

- Renders live non-archived sessions.
- Uses `isDesktop()` to decide desktop hover strip vs mobile always-visible buttons.
- Builds two hover actions inline:
  - Modify / Edit staff: `showRenameDialog(session.id, displayTitle)` or `#/staff/<staffId>`.
  - Terminate / End team: `terminateSession(session.id)`.
- Uses `.sidebar-actions hidden group-hover:flex` only on desktop; mobile renders the same `buttons` template inline.
- Keeps the row click as session navigation: `connectToSession(session.id, true)`.

`renderTeamLeadRow(session, childCount, expanded)` reuses the same Modify + End team action strip, with termination routed through `terminateSession(session.id, { goalId, isTeamLead: true })`. Team-lead rows expose `copy-link` in the menu but **never** `fork` (team sources are unsupported / `422`).

Archived session rows do not currently expose hover actions. Leave them out of v1 unless explicitly expanded later.

### Goal rows

`renderGoalGroup(goal: Goal)` currently:

- Builds three possible hover actions:
  - Re-attempt: `startReattempt(goal.id)`, only when `!hasActiveSession`. **Popover-only (`quick: false`)** — intentionally not a hover quick-action button.
  - Archive: `deleteGoal(goal.id)`, only when `!goal.archived`. Hover quick action.
  - Goal dashboard: `setHashRoute("goal-dashboard", goal.id)`, always present. Hover quick action.
- Uses `state.prStatusCache.get(goal.id)` for PR state/badge; entries have shape `{ state, url?, number?, reviewDecision?, mergeable? }`.
- Uses canonical goal route `#/goal/<goalId>` through `setHashRoute("goal-dashboard", goal.id)` and `sidebar-nav.ts::navIdToHash()`.

### Popover lifecycle pattern

`ProjectPickerPopover` is the best local pattern:

```ts
@customElement("project-picker-popover")
export class ProjectPickerPopover extends LitElement {
  @property({ attribute: false }) projects: ProjectPickerItem[] = [];
  @property({ attribute: false }) anchorEl: HTMLElement | null = null;
  @property({ type: Boolean, reflect: true }) open = false;
}
```

Relevant behavior to preserve for the sidebar menu:

- Light DOM via `createRenderRoot() { return this; }` so app/Tailwind styles apply.
- Host `display: contents` so Playwright visibility and positioning behave.
- Document-level `pointerdown` and `keydown` listeners while `open` is true.
- Outside click ignores clicks inside the popover and on `anchorEl`.
- Escape fires a bubbling `close` event; consumer unmounts.
- Keyboard support is implemented in the component, not in sidebar rows.
- Positioning uses `position: fixed` and the anchor bounding rect.

`AgentInterface` suppresses global streaming abort on Escape while popovers/dialogs are mounted by querying a selector list that currently includes `project-picker-popover`, `annotation-popover`, `continue-session-chooser`, and `copy-link-fallback-dialog`. Add `sidebar-actions-popover` there.

## Proposed action model

Create an action model in `render-helpers.ts` and pass it to the new component. This keeps quick buttons and popover rows driven by the same data instead of duplicating handlers.

```ts
export type SidebarActionEntityKind = "session" | "goal";

export interface SidebarActionItem {
  id: string;
  label: string;
  title?: string;
  icon: TemplateResult;
  tone?: "default" | "danger";
  /** True when this action also appears as a hover-strip quick button. */
  quick: boolean;
  /** Invoked by both quick buttons and popover menu rows. Must stop row navigation upstream. */
  run: (event: Event) => void | Promise<void>;
}

interface SidebarActionsMountState {
  kind: SidebarActionEntityKind;
  entityId: string;
  anchorEl: HTMLElement;
}
```

Recommended builders in `render-helpers.ts`:

```ts
function buildSessionSidebarActions(session: GatewaySession, displayTitle: string): SidebarActionItem[];
function buildTeamLeadSidebarActions(session: GatewaySession, displayTitle: string, goalId?: string): SidebarActionItem[];
function buildGoalSidebarActions(goal: Goal, input: { hasActiveSession: boolean; showArchive: boolean }): SidebarActionItem[];
function renderSidebarQuickActions(actions: SidebarActionItem[], opts: { mobile: boolean; btnPad: string }): TemplateResult;
function renderSidebarActionsTrigger(input: { kind: SidebarActionEntityKind; entityId: string; actions: SidebarActionItem[]; mobile: boolean; btnPad: string }): TemplateResult;
```

Use stable action ids for animation/test selectors:

| Entity | Existing quick ids (`quick: true`) | Menu-only ids (`quick: false`) |
|---|---|---|
| Session | `modify`, `terminate` | `copy-link`, `fork` (only when `canForkSidebarSession`) |
| Team lead | `modify`, `terminate` | `copy-link` — **no `fork`** (team sources are unsupported / `422`) |
| Goal | `archive`, `dashboard` | `reattempt` (popover-only, when `!hasActiveSession`), `copy-link`, `open-github` (PR-badge-mirrored) |

The `fork` popover row carries an optional trailing-toggle descriptor for its inline `role="menuitemcheckbox"` "New worktree" control (default checked). `canForkSidebarSession(session)` is the client availability guard — standalone live sessions only (not terminated/archived/read-only/non-interactive/child/role-bearing/team), kept in lockstep with the server `422` scope.

Every rendered action button/menu row should carry:

```html
[data-sidebar-action-id="copy-link"]
[data-sidebar-action-quick="true|false"]
```

The hamburger trigger is focusable and must carry accessible menu-button attributes:

```html
[data-testid="sidebar-actions-trigger"]
[data-sidebar-actions-kind="session|goal"]
[data-sidebar-actions-id="<id>"]
aria-haspopup="menu"
aria-expanded="true|false"
aria-label="Session actions" / "Goal actions"
```

Use the hamburger as an additive right-most button in the same action strip. Do not move or wrap the existing quick icons ahead of it. Keep `aria-expanded` synchronized with the mounted/open popover state.

## Proposed popover component

Add `src/ui/components/SidebarActionsPopover.ts`:

```ts
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

export interface SidebarActionsPopoverItem {
  id: string;
  label: string;
  icon: TemplateResult;
  tone?: "default" | "danger";
  quick: boolean;
}

export interface SidebarActionsFlipRect {
  actionId: string;
  rect: DOMRectReadOnly;
}

export interface SidebarActionsSelectDetail {
  actionId: string;
}

@customElement("sidebar-actions-popover")
export class SidebarActionsPopover extends LitElement {
  @property({ attribute: false }) items: SidebarActionsPopoverItem[] = [];
  @property({ attribute: false }) anchorEl: HTMLElement | null = null;
  @property({ attribute: false }) sourceRects: SidebarActionsFlipRect[] = [];
  @property({ type: Boolean, reflect: true }) open = false;

  @state() private _highlightIndex = 0;
}
```

Events:

```ts
// Fired when a menu item is chosen; consumer runs the already-built action handler.
new CustomEvent<SidebarActionsSelectDetail>("sidebar-action-select", {
  detail: { actionId },
  bubbles: true,
  composed: true,
});

// Fired on Escape, outside click, route-change close request, or after select.
new CustomEvent("close", { bubbles: true, composed: true });
```

Component behavior:

- `role="menu"` on the list container.
- `role="menuitem"` on every row.
- `ArrowDown` / `ArrowUp` cycles `_highlightIndex`.
- `Enter` and Space select the highlighted item.
- `Escape` closes.
- Mouse enter updates highlight.
- Click selects item and lets the consumer close after running the handler.
- Font sizes and spacing should be `em`-relative so `--sidebar-font-scale` continues to affect the menu. Prefer inline styles like `font-size: 1em`, `padding: 0.45em 0.65em`, icon box `width: 1.4em`.
- Use theme variables only: `var(--popover, var(--background))`, `var(--popover-foreground, var(--foreground))`, `var(--border)`, `var(--accent, var(--secondary))`, `var(--destructive)`.

Positioning signature:

```ts
function computeSidebarActionsPopoverPosition(
  anchorRect: DOMRectReadOnly,
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; placement: "bottom" | "top" };
```

Implementation detail: first render can use an estimated menu size, then measure the menu in `updated()` and call `requestUpdate()` if placement changes. Flip above when `anchorRect.bottom + menuHeight + 8 > viewport.height` and there is more room above.

Mounting should follow the project picker pattern: the sidebar owns creation/removal, and the component only emits `close` / `sidebar-action-select`.

## FLIP/shared-element animation plan

Capture source rects before mounting the popover:

```ts
function captureSidebarActionSourceRects(rowEl: HTMLElement): SidebarActionsFlipRect[] {
  return [...rowEl.querySelectorAll<HTMLElement>("[data-sidebar-action-quick='true'][data-sidebar-action-id]")]
    .map((el) => ({ actionId: el.dataset.sidebarActionId!, rect: el.getBoundingClientRect() }));
}
```

Extract pure math for unit testing:

```ts
export interface FlipDelta {
  actionId: string;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

export function computeSidebarActionFlipDeltas(
  sources: SidebarActionsFlipRect[],
  targets: SidebarActionsFlipRect[],
): FlipDelta[];
```

Algorithm:

1. User clicks hamburger.
2. Row handler calls `event.stopPropagation()` and captures quick icon rects from the row while the hover strip is still visible.
3. Mount `<sidebar-actions-popover>` with `open = true`, `anchorEl`, `items`, and `sourceRects`.
4. Component renders final menu rows with matching `data-sidebar-action-id`.
5. In `firstUpdated` / `updated(open)`, collect target icon rects for matching quick actions.
6. If `matchMedia("(prefers-reduced-motion: reduce)").matches`, skip FLIP and only show final rows.
7. Otherwise, for each matching quick action icon, animate the target icon from source to target using Web Animations. For menu-only actions (`copy-link`, `fork`, `reattempt`, `open-github`), animate their rows with a short opacity + translateY fade/slide after a 40–70 ms delay so new actions visibly appear alongside the shared quick actions:

```ts
el.animate([
  { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.85 },
  { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
```

Simplest robust approach: animate the actual menu-row icon from an inverted transform rather than creating global floating clones. This still reads as shared-element motion, is interruptible by `Animation.cancel()`, and avoids orphaned elements. The non-quick actions can fade/slide in with a separate animation on their rows.

Reverse animation on close is required when the source row and matching quick-action rects are still available. Expose:

```ts
public closeWithAnimation(): Promise<void>;
```

The sidebar awaits it before removing the element. If the source row no longer exists because of route/layout changes, fall back to fade-only close and unmount. If another trigger is clicked while closing, cancel in-flight animations and remove immediately.

## Copy link behavior

Canonical route helpers should live in `render-helpers.ts` or a small route utility:

```ts
function absoluteHashUrl(hash: string): string {
  return `${location.origin}${location.pathname}${location.search}${hash}`;
}

function sessionDeepLink(sessionId: string): string {
  return absoluteHashUrl(`#/session/${sessionId}`);
}

function goalDeepLink(goalId: string): string {
  return absoluteHashUrl(`#/goal/${goalId}`);
}
```

Use hash routes for sidebar copy links. The existing header copy button uses `${location.origin}/session/<id>`; do not reuse that exact path for sidebar unless routing is changed, because the hash router’s canonical session route is `#/session/<id>` per `routing.ts` and `sidebar-nav.ts`.

Copy helper:

```ts
async function copySidebarLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Legacy fallback so links still copy in insecure http:// contexts.
    const ta = document.createElement("textarea");
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  showHeaderToast("Link copied");
}
```

The sidebar copy path does **not** use the `CopyLinkFallbackDialog` modal. After copying (via the Clipboard API or the legacy `<textarea>` + `document.execCommand("copy")` fallback), flash a `Link copied` toast through `showHeaderToast` (`data-testid="header-toast"`; mount a standalone toast when no session header is present). The copy-link menu icon is the lucide `Link` icon.

## Fork session decision

Decision: **add a dedicated `POST /api/sessions/:id/fork` endpoint** (the prior `/duplicate` route is renamed to `/fork`). Fork **clones the source session's conversation history** — like the archived **Continue** flow — copying the `.jsonl` transcript plus the tool-content and proposal dirs, and spawning the new session with `preExistingAgentSessionFile`.

Endpoint shape:

```http
POST /api/sessions/:id/fork
```

Request body `{ newWorktree?: boolean }`, default `true`:

- `true` → create a fresh worktree/branch (or a plain project-root session when the project is not a git repo).
- `false` → **reuse the source session's existing worktree** (new session `cwd` = source `worktreePath`, same repo/branch; no new worktree registered — the two live sessions intentionally share the tree).

Server contract:

1. Resolve the source from live sessions first. v1 UI calls this only for standalone live sessions.
2. Reject unsupported sources with `422`: archived, terminated, `delegateOf`, first-class child (`parentSessionId`), `teamGoalId`, `teamLeadSessionId`, `role === "team-lead"`, and `readOnly`. The client `canForkSidebarSession` guard agrees with this scope so no shown menu item ever errors server-side.
3. Clone the source `.jsonl` transcript plus tool-content and proposal dirs, and spawn the new session with `preExistingAgentSessionFile`.
4. Preserve `projectId`, `cwd`, `goalId`, `assistantType`, `staffId`, `role`, `accessory`, `sandboxed`, `modelProvider`/`modelId`, `reattemptGoalId`, and `taskId`.
5. Honour the `newWorktree` flag per the body semantics above.
6. Title the new session `Fork: <source title>`; never mutate the source.
7. Preserve the prior duplicate route's sandbox allow-list / auth parity.

Client helper signature in `src/app/session-manager.ts`:

```ts
export async function forkSession(source: GatewaySession, opts: { newWorktree: boolean }): Promise<void>;
```

Client behavior:

```ts
const res = await gatewayFetch(`/api/sessions/${source.id}/fork`, {
  method: "POST",
  body: JSON.stringify({ newWorktree: opts.newWorktree }),
});
const { id } = await res.json();
await refreshSessions();
await connectToSession(id, false);
```

Compatibility caveats:

- Do **not** offer Fork for delegates, first-class children, team leads/team members, archived sessions, or read-only sessions. `canForkSidebarSession` must stay in lockstep with the server `422` scope.
- Fork with `newWorktree=false` intentionally shares a worktree between two live sessions; terminating one must not delete the shared tree out from under the other.
- Browser E2E must assert the transcript is cloned and metadata preserved, that `newWorktree=true` allocates a distinct worktree/branch, that `newWorktree=false` reuses the source worktree, and that unsupported sources are rejected with `422`.

## Open on GitHub decision

Decision: **`Open on GitHub` mirrors the goal-row PR badge**. The menu item is shown **only when the goal-row PR badge is visible** — a PR exists in `state.prStatusCache.get(goal.id)` with a `pr.url`, and for workflow goals the gate summary is fully passed (`gs.passed === gs.total`, `gs.total > 0`). It opens `pr.url` and uses the same state-coloured PR/merge SVG as the goal row via the shared `resolveGoalPrBadge` helper (MERGED `#a87fd4`, CLOSED/CHANGES_REQUESTED `#c47070`, APPROVED/default `#6bc485`, REVIEW_REQUIRED `#d4a04a`). There is **no** client-visible branch-fallback menu item.

The `GET /api/goals/:id/github-link` endpoint still exists (server-side resolver, `execFile` argv with no shell interpolation of branch names, sanitized GitHub branch fallback) but **no longer gates this menu item**. Keep it for callers that need a server-derived link; never construct GitHub branch URLs client-side from untrusted remotes.

Endpoint (retained, not gating the menu item):

```http
GET /api/goals/:id/github-link
```

Client behavior:

- When building goal menu actions, derive visibility from the same `resolveGoalPrBadge` state used by the goal row — show `Open on GitHub` only when that badge renders and a `pr.url` is present.
- Use the badge's `pr.url` directly; do not lazy-fetch a branch fallback for the menu item.
- Browser E2E must assert the item mirrors the badge: a coloured icon opens `pr.url` when the badge shows, and the item is hidden for gated/no-PR goals.

## Route-change dismissal

The popover must close on route changes. Add a small global close path in the sidebar mount owner:

```ts
let activeSidebarActionsPopover: HTMLElement | null = null;
let activeSidebarActionsAbort: AbortController | null = null;

function closeSidebarActionsPopover(): void;
function openSidebarActionsPopover(input: {
  kind: SidebarActionEntityKind;
  entityId: string;
  anchorEl: HTMLElement;
  rowEl: HTMLElement;
  actions: SidebarActionItem[];
}): void;
```

`openSidebarActionsPopover` should bind:

```ts
window.addEventListener("hashchange", closeSidebarActionsPopover, { signal });
```

Also call `closeSidebarActionsPopover()` before opening a different row’s menu.

This avoids changes to `sidebar-nav.ts`; its DOM-order keyboard navigation should continue to see the same `[data-nav-id]` rows. The menu’s own `keydown` handler must `stopPropagation()` for arrow keys and Escape so sidebar shortcuts do not race the menu.

## Mobile decision

Recommendation: **suppress the hamburger on mobile in v1**.

Reasoning:

- Mobile already renders the existing inline buttons always visible.
- Adding a fourth/fifth tiny target increases crowding in the row.
- The popover’s discovery animation is primarily a hover-strip desktop affordance; mobile has no hover-strip source positions for FLIP.

Acceptance criteria for mobile v1:

- The hamburger trigger is hidden below the desktop breakpoint.
- Existing mobile inline quick buttons remain visible and directly clickable.
- Menu-only actions (Copy link, Fork, Re-attempt, Open on GitHub) are intentionally desktop-only in v1.
- Browser E2E must resize to mobile and assert the hamburger is absent while existing inline quick actions remain available.

If mobile parity becomes mandatory later, use a bottom sheet instead of an anchored popover below 640 px; that is out of scope for this goal.

## Compatibility risks

- **Existing hover behavior regression:** building the hamburger must not wrap existing quick buttons in another clickable parent. Every quick button handler must still call `event.stopPropagation()` and execute without opening the menu.
- **Row navigation leaks:** trigger/menu clicks must stop propagation or they will also toggle goal expansion / navigate to sessions.
- **Focus and Escape conflicts:** add `sidebar-actions-popover` to `AgentInterface`’s modal selector; otherwise Escape while streaming can abort the agent instead of closing the menu.
- **Route-change stale popover:** because sidebar rows re-render frequently, a mounted popover can outlive its source row unless explicitly closed on `hashchange` and before `renderApp()`-driven remounts where practical.
- **Animation orphaning:** avoid body-level floating clones unless lifecycle is airtight. Inverted target-icon animation is safer and still satisfies the visual intent.
- **Reduced motion:** all FLIP and fade/slide animations must be skipped when `prefers-reduced-motion: reduce` matches.
- **GitHub link trust:** never construct branch URLs from arbitrary remotes without parsing and stripping embedded credentials. Hide action for non-GitHub remotes.
- **Fork semantics:** `POST /api/sessions/:id/fork` clones the source transcript (`.jsonl` + tool-content + proposal dirs) and spawns with `preExistingAgentSessionFile`, like the archived Continue flow. `newWorktree=false` intentionally shares a worktree between two live sessions; terminating one must not delete the shared tree.
- **Sidebar font scale:** hard-coded pixel font sizes in the popover will ignore `--sidebar-font-scale`; use em-relative sizing.

## Test plan for later implementation

Add `tests/e2e/ui/sidebar-actions-menu.spec.ts` using the existing gateway harness and patterns from `settings.spec.ts` / `copy-session-link.spec.ts`.

Required browser E2E cases:

1. **Session hamburger visibility and menu contents**
   - Create a live session.
   - Hover its sidebar row.
   - Assert existing Modify and Terminate quick buttons are visible.
   - Assert hamburger trigger is visible on desktop.
   - Click hamburger.
   - Assert menu rows: Modify, Terminate, Copy link, Fork (with the inline "New worktree" `menuitemcheckbox`).

2. **Goal hamburger visibility and menu contents**
   - Create a goal with no active session.
   - Hover goal row.
   - Assert quick actions remain visible: Archive, Goal dashboard (Re-attempt is popover-only, not a hover quick action).
   - Click hamburger.
   - Assert menu rows include Re-attempt, Archive, Goal dashboard, Copy link, and Open on GitHub only when the goal-row PR badge is visible.

3. **Existing quick actions still fire directly**
   - Click session Modify quick icon, assert rename dialog opens.
   - Click session Terminate quick icon, assert confirm dialog opens; cancel.
   - Click goal dashboard quick icon, assert hash becomes `#/goal/<id>`.
   - This is the pinning test for “hamburger is additive”.

4. **Copy link happy path and fallback**
   - Stub/grant clipboard and click menu Copy link for session.
   - Assert clipboard equals `${location.origin}${location.pathname}${location.search}#/session/<id>`.
   - Repeat for goal: `#/goal/<id>`.
   - Force `navigator.clipboard.writeText` rejection and assert the link still copies via the legacy `<textarea>`/`execCommand` fallback and the `Link copied` toast (`[data-testid="header-toast"]`) flashes — **no** `copy-link-fallback-dialog` modal is shown for the sidebar path.

5. **Dismissal**
   - Open menu, click outside, assert removed.
   - Open menu, press Escape, assert removed.
   - Open menu, navigate route/hash, assert removed.

6. **Fork session**
   - Toggle the inline "New worktree" `menuitemcheckbox` and assert it flips without firing Fork or closing the popover.
   - Activate the Fork row and wait for a `POST /api/sessions/:id/fork` response (body `{ newWorktree }` per checkbox state) and hash route `#/session/<newId>`.
   - Assert the transcript is cloned and metadata preserved (`projectId`, `cwd`, `goalId`, `assistantType`, model fields) via `GET /api/sessions/:id`; assert `newWorktree=true` allocates a distinct worktree/branch and `newWorktree=false` reuses the source worktree.
   - Assert an unsupported source (archived/terminated/delegate/child/read-only/team/team-lead) returns `422`, matching `canForkSidebarSession`.

7. **Mobile v1 acceptance**
   - Resize below 640 px.
   - Assert `[data-testid="sidebar-actions-trigger"]` is absent.
   - Assert existing inline quick actions remain visible/clickable.
   - Assert menu-only actions are not exposed on mobile in v1.

8. **Reduced motion**
   - Override `window.matchMedia` for `(prefers-reduced-motion: reduce)` before opening the menu.
   - Assert menu opens and no `Element.prototype.animate` call is required. If using a spy, assert FLIP helper is bypassed.

Unit/file-fixture test requirement:

- If rect-capture or FLIP delta logic lives in a helper, add `tests/sidebar-actions-flip.test.ts` verifying `computeSidebarActionFlipDeltas` computes `dx`, `dy`, `sx`, `sy`; ignores missing source/target ids; and handles zero-size rects without `Infinity`/`NaN`.

## Recommended implementation order

1. Add `SidebarActionsPopover.ts` with static menu rendering, keyboard nav, positioning, and dismissal. No FLIP yet.
2. Refactor `render-helpers.ts` action strips to action arrays and keep existing quick buttons byte-behavior equivalent.
3. Add hamburger trigger and sidebar-owned popover mount/unmount.
4. Add Copy link handlers: Clipboard API + legacy `<textarea>`/`execCommand` fallback + `Link copied` toast via `showHeaderToast` (no modal).
5. Add dedicated `POST /api/sessions/:id/fork` endpoint (transcript clone + `newWorktree` body) and client helper, plus the `canForkSidebarSession` guard and the Fork "New worktree" `menuitemcheckbox`.
6. Wire goal menu Open on GitHub to mirror the goal-row PR badge (`resolveGoalPrBadge`, opens `pr.url`). `GET /api/goals/:id/github-link` remains available but does not gate the item.
7. Add FLIP/reduced-motion animation.
8. Add E2E/unit coverage, including mobile v1 acceptance and helper-level FLIP tests if helper logic exists.
9. Add `sidebar-actions-popover` to `AgentInterface` Escape suppression.
