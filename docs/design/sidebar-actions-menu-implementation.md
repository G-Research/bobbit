# Sidebar Actions Menu implementation plan

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
| Sidebar action modeling and row wiring | `src/app/render-helpers.ts` | Build session/goal action arrays, keep existing hover buttons, add hamburger trigger, mount/unmount popover, copy/duplicate/open handlers. |
| Popover component and FLIP helper | `src/ui/components/SidebarActionsPopover.ts` plus optional `src/ui/components/sidebar-actions-flip.ts` | Render menu, keyboard nav, outside/Escape dismissal, positioning, shared-element animation. |
| Session duplicate helper | `src/app/session-manager.ts` | Export a focused client helper that calls existing `POST /api/sessions`, refreshes session list, and connects. |
| Optional GitHub branch URL resolver | `src/server/server.ts` and `src/app/api.ts` | Only needed if v1 must show branch fallback when no PR exists. See “Open on GitHub decision”. |
| Modal/open-popover suppression | `src/ui/components/AgentInterface.ts` | Add `sidebar-actions-popover` to the global Escape suppression selector. |
| Tests | `tests/e2e/ui/sidebar-actions-menu.spec.ts` plus optional unit test | Browser coverage for menu behavior; unit coverage if FLIP math is extracted. |

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

`renderTeamLeadRow(session, childCount, expanded)` duplicates the same Modify + End team action strip, with termination routed through `terminateSession(session.id, { goalId, isTeamLead: true })`.

Archived session rows do not currently expose hover actions. Leave them out of v1 unless explicitly expanded later.

### Goal rows

`renderGoalGroup(goal: Goal)` currently:

- Builds three possible hover actions:
  - Re-attempt: `startReattempt(goal.id)`, only when `!hasActiveSession`.
  - Archive: `deleteGoal(goal.id)`, only when `!goal.archived`.
  - Goal dashboard: `setHashRoute("goal-dashboard", goal.id)`, always present in the current live goal header.
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

| Entity | Existing quick ids | New menu-only ids |
|---|---|---|
| Session | `modify`, `terminate` | `copy-link`, `duplicate` |
| Team lead | `modify`, `terminate` | `copy-link`; `duplicate` optional/hidden for v1 because team duplication semantics are unclear |
| Goal | `reattempt`, `archive`, `dashboard` | `copy-link`, `open-github` |

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
7. Otherwise, for each matching quick action icon, animate the target icon from source to target using Web Animations. For menu-only actions (`copy-link`, `duplicate`, `open-github`), animate their rows with a short opacity + translateY fade/slide after a 40–70 ms delay so new actions visibly appear alongside the shared quick actions:

```ts
el.animate([
  { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.85 },
  { transform: "translate(0, 0) scale(1, 1)", opacity: 1 },
], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
```

Simplest robust approach: animate the actual menu-row icon from an inverted transform rather than creating global floating clones. This still reads as shared-element motion, is interruptible by `Animation.cancel()`, and avoids orphaned elements. The non-quick actions can fade/slide in with a separate animation on their rows.

Reverse animation on close is optional only if it can be made reliable without delaying unmount. If implemented, expose:

```ts
public closeWithAnimation(): Promise<void>;
```

The sidebar can await it before removing the element. If another trigger is clicked while closing, cancel in-flight animations and remove immediately.

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
    showHeaderToast("Link copied");
  } catch {
    const m = await import("../ui/dialogs/CopyLinkFallbackDialog.js");
    m.CopyLinkFallbackDialog.show(url);
  }
}
```

`CopyLinkFallbackDialog.show(url: string)` can be reused as-is. Its title says “Copy session link”; acceptable for a first pass, but a later polish can add an optional label parameter if goal-link wording matters.

## Duplicate session decision

Decision: **add a dedicated `POST /api/sessions/:id/duplicate` endpoint for v1**. The goal requires “forks the session into a new one with the same project/goal/spec context”; the server owns the authoritative persisted session metadata and can preserve context more reliably than a client-side best-effort `POST /api/sessions` call. This endpoint duplicates context, not transcript history.

Endpoint shape:

```http
POST /api/sessions/:id/duplicate
```

Response:

```ts
type DuplicateSessionResponse = {
  id: string;
  cwd: string;
  status: string;
  projectId?: string;
  goalId?: string;
  assistantType?: string;
};
```

Server contract:

1. Resolve the source from live sessions first. v1 UI calls this only for live sessions.
2. Reject unsupported sources with `422`: `delegateOf`, `parentSessionId`, `teamGoalId`, `teamLeadSessionId`, `role === "team-lead"`, `readOnly`, and archived sessions.
3. Read the persisted session record from the project session store so server-only fields are preserved: `projectId`, `cwd`, `goalId`, `assistantType`, `staffId`, `role`, `accessory`, `sandboxed`, model selection (`modelProvider`, `modelId`), and any persisted `reattemptGoalId` / spec-context fields already present on the record.
4. If the session belongs to a goal, resolve the goal and pass the goal id/cwd/project id so the new session inherits the goal spec context through the existing goal-session creation path.
5. If the session is staff-backed, preserve `staffId` and assistant/staff context.
6. Create the new session with the same project/goal/spec context and normal fresh worktree/session lifecycle. Do not copy JSONL transcript, tool-content snapshots, read state, or proposal drafts.
7. Persist the copied model selection when present using the same store path used by normal WS model persistence.
8. Title the new session `Copy of <source title>` unless the session manager has a better title hook; never mutate the source.

Client helper signature in `src/app/session-manager.ts`:

```ts
export async function duplicateSession(source: GatewaySession): Promise<void>;
```

Client behavior:

```ts
const res = await gatewayFetch(`/api/sessions/${source.id}/duplicate`, { method: "POST" });
const { id } = await res.json();
await refreshSessions();
await connectToSession(id, false);
```

Compatibility caveats:

- Do **not** offer Duplicate for delegates, first-class children, team leads/team members, archived sessions, or read-only sessions in v1. Their lifecycle semantics are not equivalent to a plain session fork.
- Do **not** use `POST /api/sessions/:id/continue`; that endpoint is archived-only, rejects live sources with `409`, and clones transcript context, which is a different mental model.
- Browser E2E must assert context preservation, not just that a new session exists: at minimum the duplicated session has a different id and matching `projectId`, `cwd`, `goalId` when applicable, `assistantType`, and persisted model fields when available in the fixture.

## Open on GitHub decision

Decision: **implement full spec support in v1 with a server-derived branch fallback**. The action must open an existing PR when one is known, otherwise open the goal branch view when the project has a GitHub remote, and be hidden only when no GitHub remote/branch can be resolved.

Add a small server resolver because the client `Project` and `Goal` models do not contain the GitHub remote URL. The server already shells out to `git remote get-url origin` in sandbox/bootstrap and has token-stripping/parsing utilities; reuse that sanitization style and never construct GitHub URLs from unparsed client strings.

Endpoint:

```http
GET /api/goals/:id/github-link
```

Response:

```ts
type GoalGithubLinkResponse =
  | { available: true; url: string; kind: "pr" | "branch" }
  | { available: false; reason: "no-branch" | "no-github-remote" | "goal-not-found" };
```

Server behavior:

1. Resolve goal across projects.
2. If `prStatusStore` or fresh `_fetchPrStatus(goal.cwd, goal.branch)` has a PR URL, return `{ kind: "pr", url }`.
3. Else require `goal.branch`.
4. Run `git remote get-url origin` in `goal.repoPath || goal.cwd`.
5. Parse GitHub HTTPS/SSH forms into `https://<host>/<owner>/<repo>/tree/<encoded-branch>`.
6. Return unavailable for non-GitHub remotes.

Client behavior:

- When building goal menu actions, first use `state.prStatusCache.get(goal.id)?.url` if present so cached PRs open instantly.
- If no PR URL exists, lazy-fetch `GET /api/goals/:id/github-link` when the menu opens and cache the result per goal id.
- Render `Open on GitHub` when the resolver returns `available: true`; hide it for `available: false`.
- Browser E2E must cover three states: PR URL opens PR, no PR + GitHub remote opens branch tree URL, and no GitHub remote hides the row.

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

Impact: new menu-only actions (Copy link, Duplicate session, Open on GitHub) are desktop-only in v1 unless separate mobile affordances are added. If mobile parity is mandatory, use the same hamburger but skip FLIP and show the centered-sheet pattern from `ProjectPickerPopover`; this should be treated as a follow-up or explicitly assigned to the component owner.

## Compatibility risks

- **Existing hover behavior regression:** building the hamburger must not wrap existing quick buttons in another clickable parent. Every quick button handler must still call `event.stopPropagation()` and execute without opening the menu.
- **Row navigation leaks:** trigger/menu clicks must stop propagation or they will also toggle goal expansion / navigate to sessions.
- **Focus and Escape conflicts:** add `sidebar-actions-popover` to `AgentInterface`’s modal selector; otherwise Escape while streaming can abort the agent instead of closing the menu.
- **Route-change stale popover:** because sidebar rows re-render frequently, a mounted popover can outlive its source row unless explicitly closed on `hashchange` and before `renderApp()`-driven remounts where practical.
- **Animation orphaning:** avoid body-level floating clones unless lifecycle is airtight. Inverted target-icon animation is safer and still satisfies the visual intent.
- **Reduced motion:** all FLIP and fade/slide animations must be skipped when `prefers-reduced-motion: reduce` matches.
- **GitHub link trust:** never construct branch URLs from arbitrary remotes without parsing and stripping embedded credentials. Hide action for non-GitHub remotes.
- **Duplicate semantics:** `POST /api/sessions` duplicates context but not transcript. If users expect a true fork, this must become a dedicated server endpoint.
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
   - Assert menu rows: Modify, Terminate, Copy link, Duplicate session.

2. **Goal hamburger visibility and menu contents**
   - Create a goal with no active session.
   - Hover goal row.
   - Assert quick actions remain visible: Re-attempt, Archive, Goal dashboard.
   - Click hamburger.
   - Assert menu rows include Re-attempt, Archive, Goal dashboard, Copy link, and Open on GitHub only when a PR/link fixture is available.

3. **Existing quick actions still fire directly**
   - Click session Modify quick icon, assert rename dialog opens.
   - Click session Terminate quick icon, assert confirm dialog opens; cancel.
   - Click goal dashboard quick icon, assert hash becomes `#/goal/<id>`.
   - This is the pinning test for “hamburger is additive”.

4. **Copy link happy path and fallback**
   - Stub/grant clipboard and click menu Copy link for session.
   - Assert clipboard equals `${location.origin}${location.pathname}${location.search}#/session/<id>`.
   - Repeat for goal: `#/goal/<id>`.
   - Force `navigator.clipboard.writeText` rejection and assert `copy-link-fallback-dialog` appears with the expected value in `[data-testid="copy-link-fallback-input"]`.

5. **Dismissal**
   - Open menu, click outside, assert removed.
   - Open menu, press Escape, assert removed.
   - Open menu, navigate route/hash, assert removed.

6. **Duplicate session**
   - Click Duplicate session from a plain live session menu.
   - Wait for a `POST /api/sessions` response and hash route `#/session/<newId>`.
   - Assert new id differs and the new session has matching `projectId`/`cwd` via `GET /api/sessions/:id`.

7. **Reduced motion**
   - Override `window.matchMedia` for `(prefers-reduced-motion: reduce)` before opening the menu.
   - Assert menu opens and no `Element.prototype.animate` call is required. If using a spy, assert FLIP helper is bypassed.

Optional unit/file-fixture test if FLIP math is extracted:

- `tests/sidebar-actions-flip.test.ts`: verify `computeSidebarActionFlipDeltas` computes `dx`, `dy`, `sx`, `sy`; ignores missing source/target ids; handles zero-size rects without `Infinity`/`NaN`.

## Recommended implementation order

1. Add `SidebarActionsPopover.ts` with static menu rendering, keyboard nav, positioning, and dismissal. No FLIP yet.
2. Refactor `render-helpers.ts` action strips to action arrays and keep existing quick buttons byte-behavior equivalent.
3. Add hamburger trigger and sidebar-owned popover mount/unmount.
4. Add Copy link handlers and duplicate helper via `POST /api/sessions`.
5. Add Open on GitHub minimal PR URL support; add full branch resolver only if assigned.
6. Add FLIP/reduced-motion animation.
7. Add E2E/unit coverage.
8. Add `sidebar-actions-popover` to `AgentInterface` Escape suppression.
