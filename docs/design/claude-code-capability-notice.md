# Claude Code Capability Notice — In-session UX

**Status:** Implemented UX reference. The as-built notice and footer/runtime details live in `src/ui/components/AgentInterface.ts`.
**Scope:** In-session explanation of Claude Code local-runtime capability differences.

## Recommendation

Use a **top-of-session local runtime notice** plus a persistent **footer/runtime details popover**. This is the implemented behavior for Claude Code sessions.

Do not add a new tab by default. A tab/panel is heavier than the problem: users need a quick, contextual explanation before they prompt, then a reliable place to re-check details later. The notice should feel like an informational setup note, not a fault warning.

## Placement

### Primary surface: transcript notice

Show only when `runtime === "claude-code"`.

Place the notice at the top of the active session transcript, below the session header/status widgets and above the first message. It should scroll with the transcript, not remain sticky.

Default behavior:

- New Claude Code sessions: show expanded until the user dismisses it for that Bobbit session.
- Reloaded sessions: preserve the session-scoped dismissal state.
- Dismissal key: `bobbit-claude-code-capability-notice-dismissed-<sessionId>`.
- Do not offer a global “never show again” in MVP; every new Claude Code session should surface the reminder.
- If dismissed, the footer/runtime popover remains available as the persistent access point.

### Secondary surface: footer/runtime popover

The existing footer model/runtime button should expose the same details in compact form:

- Button title: `Claude Code (local) · <alias>`.
- Popover section title: `Claude Code local runtime`.
- Link/action: `Runtime details` or `Learn more` → `docs/claude-code-runtime.md`.

This makes the explanation discoverable after dismissal without keeping a banner on screen.

## Visual treatment

Use a low-severity info callout, not destructive styling.

Recommended structure:

- Container: `mx-4 my-3 p-3 rounded-lg border border-border bg-card text-card-foreground`.
- Left icon: info/terminal icon in `text-primary`, not `text-destructive`.
- Runtime pill: `Claude Code (local)` with outline badge styling matching model picker badges.
- Title: `Claude Code local runtime`.
- Body: one short paragraph.
- Details: collapsible two-column/checklist layout on desktop; stacked on narrow screens.
- Actions: text/ghost buttons matching footer/dialog controls.

Avoid red/destructive language unless the session is actually failing to start.

## Exact microcopy

### Compact notice

**Title:** `Claude Code local runtime`

**Body:** `This session runs through your local Claude Code CLI. Bobbit provides the chat shell, transcript, session metadata, alias switching, best-effort stop/abort, and mapped tool rendering.`

**Actions:**

- `View details`
- `Got it for this session`
- `Learn more`

### Expanded details

Use three short groups:

**Claude Code handles**

- `Login and account state`
- `Available models and exact context behavior`
- `Tool execution and permission prompts`
- `Claude Code's own resume/context semantics`

**Bobbit handles**

- `Chat UI, transcript hydration, and session metadata`
- `claude-code/* alias selection and same-runtime alias switching`
- `Best-effort stop/abort`
- `Rendering mapped tool use/results when Claude Code emits them structurally`

**Still standard Bobbit runtime**

- `Workflow gates, reviewers, and verification agents`
- `Team/staff agents unless explicitly moved to Claude Code later`
- `Bobbit-native tools that are not part of Claude Code's local tool run`

### Footer popover copy

**Heading:** `Claude Code local runtime`

**Summary:** `This session is backed by the local Claude Code CLI and your existing Claude Code login.`

**Rows:**

| Label | Value |
|---|---|
| `Runtime owner` | `Claude Code handles auth, models, context, tools, and permissions.` |
| `Bobbit support` | `Chat, transcript hydration, metadata, alias switching, best-effort stop/abort, mapped tool rendering.` |
| `Automation note` | `Some Bobbit gates, reviewers, team agents, and native tools still use the standard runtime.` |

**Link:** `Learn more about Claude Code runtime`

## Interaction details

- `View details` expands/collapses inline without changing scroll position.
- `Got it for this session` hides the transcript notice for that Bobbit session only.
- `Learn more` opens `docs/claude-code-runtime.md` in the existing docs/review surface if available; otherwise open it in a new browser tab/window.
- The notice should not block prompting.
- If a user attempts an unsupported Bobbit-native action from a Claude Code session, use the same language pattern: `This action still uses the standard Bobbit runtime.` Include a short reason and a next step.

## Accessibility

- Use `role="note"` for the notice.
- `View details` must expose `aria-expanded` and `aria-controls`.
- Dismiss button label: `Dismiss Claude Code runtime note for this session`.
- Do not rely on color alone: include the `Claude Code (local)` pill and explicit headings.
- Keep body text at existing `text-sm`; details can use `text-xs` only for secondary metadata.

## Consistency rationale

- Reuses the existing model/runtime footer as the persistent access point instead of adding a new tab.
- Reuses existing inline banner/card primitives (`rounded-lg`, `border-border`, `bg-card`, `text-muted-foreground`) and avoids destructive warning styling.
- Keeps capability differences visible at the moment of need while allowing session-scoped dismissal.
- Matches existing runtime language from `docs/design/claude-code-runtime-ux.md` and `docs/claude-code-runtime.md`: Claude Code is a local runtime backed by the user's CLI/login, not an API provider or billing workaround.
