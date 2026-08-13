# Claude Agent SDK embedded subagent card UX (G10b)

## Decision

Render Claude Agent SDK child work **inside the existing root `Agent`/legacy
`Task` tool-call card**. A child is not a Bobbit session, team member, message
thread, avatar, sidebar row, or standalone transcript surface.

The root transcript remains the page-level reading order. Child text and tools
are a disclosure region owned by the root tool call identified by
`parent_tool_use_id` / `parentToolUseId`. Child frames must never reach the
ordinary root assistant prose renderer.

This extends the existing `tool-message` and tool-renderer pattern; it does not
introduce a second subagent UI system.

## Existing surface and constraints

The current transcript already supplies the required primitives:

| Existing primitive | Current behavior | G10b use |
| --- | --- | --- |
| `assistant-message` in `src/ui/components/Messages.ts` | Walks assistant content in source order and places a `tool-message` at each tool-call position. | The root `Agent`/`Task` call remains at this exact position. Child updates never move it. |
| `tool-message` | Uses `p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs`. | The only outer card for SDK subagent work. |
| `renderHeader` / `renderCollapsibleHeader` | Uses a 14 px muted header, a state-colored icon, spinner, trailing metadata, and chevron disclosure. | Reuse its spacing, typography, icon/status colors, and interaction grammar. |
| Existing tool renderers | Render canonical Bobbit tools with in-progress, complete, warning, and error states. | Render child calls through the same registry after identity normalization. Do not create subagent-only Read/Find/Grep cards. |
| `DefaultRenderer` payload disclosure | Uses a button, `aria-expanded`, `aria-controls`, focus ring, and a bounded collapsed payload. | Accessibility baseline for the parent disclosure. |
| `DelegateRenderer` / `delegate-cards.ts` | Represents real Bobbit child sessions and can link to them. | Visual reference only. Do **not** show session links, child cards, or “view” actions: SDK children are not sessions. |
| Message ordering reducer | Owns the page-level transcript ordinal. | Keep the parent tool card at its root ordinal; order child activity only within that card. |

Today, a native `Agent` call without a specialized renderer falls through to
`DefaultRenderer`. G10b may specialize that call, but its result must still be
an ordinary non-custom tool render wrapped by `tool-message`. The SDK's legacy
initialization label `Task` may select the same renderer, but the user-facing
noun should be **Agent**. Bobbit's durable `task_*` tools and their renderers are
unrelated and must not change.

## Information hierarchy

The parent card has three layers:

1. **Always-visible parent header** — state icon, `Agent`, approved role label,
   compact activity summary, duration, and disclosure chevron.
2. **Embedded activity region** — one vertically stacked child section per
   confirmed child identity. Text and tool lifecycle entries appear here in
   source order.
3. **Root result** — the root Agent tool result/error remains the root-session
   and durable-history lifecycle authority. A child terminal can update embedded
   card presentation, but cannot complete the root turn.

### Renderer projection required by the UX

Live translated events expose `parentToolUseId`. `SubagentStart`/`SubagentStop`
identify a child but omit that parent key, so G10b projects their lifecycle only
through the verified admission registry into semantic embedded-work frames. The
client receives that nested projection rather than raw lifecycle hooks. The UI
input needs, at minimum:

```ts
interface EmbeddedAgentActivity {
  parentToolUseId: string;       // exact root Agent/legacy Task call
  agentId: string;               // child identity from the SDK lifecycle
  agentType?: string;            // approved type, when known
  displayLabel: string;          // bounded resolved label
  state: "starting" | "working" | "completed" | "failed" | "stopped" | "unknown";
  startedAt?: number;
  stoppedAt?: number;
  orderedMessages: unknown[];    // normalized text/thinking/tool lifecycle
}
```

This describes renderer data, not a second persisted UI store. Live lifecycle
metadata may be projected alongside the existing normalized events; snapshots
may reconstruct it from official SDK history/recovery. The correlation rules
are mandatory:

- a parent projection is keyed by `parentToolUseId`;
- a child section is keyed by the composite
  `(parentToolUseId, agentId)` (use `parentAgentId` only when it is the official
  SDK child identity for that row);
- message and tool identities are scoped by that composite, so repeated tool ids
  in two children cannot settle each other; and
- role/state must come from SDK lifecycle or authoritative recovery metadata,
  never be inferred from prose, tool arguments, timing, or the nearest card.

If lifecycle metadata is missing, render `Agent helper` and `Status unavailable`
rather than guessing. `Starting`, `Finishing`, and per-child terminal states are
allowed only when the projection has the corresponding lifecycle evidence.

Collapsed terminal example:

```text
┌────────────────────────────────────────────────────────────────────┐
│ ✓  Agent · Backend parity reviewer     3 tools · 18s           ⇵  │
└────────────────────────────────────────────────────────────────────┘
```

Expanded streaming example:

```text
┌────────────────────────────────────────────────────────────────────┐
│ ◌  Agent · Backend parity reviewer     Working · 12s           ↑  │
│                                                                    │
│    BACKEND PARITY REVIEWER                                  Working │
│    I’m checking the session recovery boundary…                    │
│                                                                    │
│    ✓ Read  src/server/agent/claude-agent-sdk-bridge.ts             │
│    ◌ Search  "getSessionMessages"                                 │
└────────────────────────────────────────────────────────────────────┘
```

The inset is a grouping treatment, not a second card: use the parent card's
surface, `mt-3`, a subtle `border-l border-border`, and left padding. Nested
tool calls reuse existing renderer content and header grammar without another
`bg-card shadow-xs` wrapper. This avoids card-within-card noise while retaining
recognizable tool states.

## Parent header contract

### Labels

- Primary noun: `Agent`.
- Role label: map the approved SDK type to the resolved human label, for example
  `bobbit-backend-parity-reviewer` → `Backend parity reviewer`.
- Do not expose raw SDK ids in the normal header. Raw `agent_id` and
  `parent_tool_use_id` remain available to debug/audit output and DOM test data.
- Do not show the child prompt. The current default renderer already excludes
  `prompt` from compact title badges; preserve that privacy boundary.
- Do not show a session link, avatar, branch, task assignment, or “open agent”.

### State copy

| Parent/child condition | Icon/state | Header summary | Disclosure default |
| --- | --- | --- | --- |
| Parent call admitted; no `SubagentStart` yet | Spinner, in progress | `Starting…` | Expanded |
| Child text/tools streaming | Spinner, in progress | `Working · N tools` | Expanded unless the user collapsed it |
| `SubagentStop` received; parent result pending | Spinner, in progress | `Finishing… · N tools` | Preserve user choice |
| Successful parent result | Green complete | `N tools · duration` or `Completed · duration` | Collapsed |
| Child failure but parent still running | Spinner plus error count in text | `Working · 1 failed` | Expanded |
| Parent result is error | Destructive | `Failed · duration` | Expanded |
| Parent aborted/stopped | Warning or existing aborted treatment | `Stopped · duration` | Expanded when error detail exists; otherwise collapsed |
| Recovered incomplete history | Warning | `Recovered activity · status unavailable` | Collapsed |

Status is never communicated by color alone. The text `Working`, `Completed`,
`Failed`, `Stopped`, or `Recovered activity` must remain available to assistive
technology even when the visual layout uses only compact counts.

Use the approved role label when known. For an unknown but SDK-confirmed type,
show `Agent helper`; never print an unbounded provider string in the header.

## Embedded activity contract

### Streaming text

- Render child text as Markdown using the existing safe markdown path.
- Keep it inside the parent disclosure, under a small role label and explicit
  `Working`/terminal status.
- Update the current text block in place as deltas arrive; do not append one DOM
  row per token.
- Do not show child text in the root `assistant-message` prose area, message
  timestamp gutter, root suggestion-goal action, or notification/unread path.
- Thinking blocks, when available and permitted by the existing transcript
  contract, use the existing `thinking-block` disclosure inside the child
  section. They do not become root thinking.

### Child tools

- Normalize SDK raw names before renderer lookup. Server-owned
  `mcp__bobbit__read`/`find`/`grep` must render as the existing canonical
  `read`/`find`/`grep` tools. Native, foreign, malformed, or unknown identities
  use the existing safe fallback renderer; they never gain a privileged custom
  renderer through suffix matching.
- Preserve the existing lifecycle order: assistant/tool call, execution start,
  tool result, execution end. Update one tool entry in place by tool-call id.
- Pending calls show the existing in-progress spinner. Successful calls show the
  existing green state. Denied/failed/dangling calls use the existing error
  treatment and bounded error preview.
- Do not group calls across child identities or across parent partitions.
  Existing same-tool grouping may operate only within one settled child stream
  and must not hide a failure.
- A child tool may expand using its existing renderer. Its expansion is
  independent of the parent disclosure and keyboard reachable.

### Multiple and interleaved children

Although the admission policy currently allows one live child per bridge,
reload/recovery fixtures and future SDK behavior can contain multiple child
identities. The UI must remain deterministic:

1. Partition every frame by `parent_tool_use_id` before message or tool lookup.
2. Attach each partition only to the root tool call with that exact id.
3. Within a parent, create child sections in first-observed provider order.
4. Within each child, preserve provider message/content order and update a
   matching streamed block/tool in place.
5. Interleaving never alternates root prose with child prose and never moves the
   outer parent cards. For example, frames `A1, B1, A2, B2` update parent card A
   and parent card B independently at their existing root transcript positions.
6. Reused child message UUIDs or tool-call ids in different partitions remain
   isolated; a result can settle only a tool in its own partition.

Do not lay multiple children out side by side. A vertical stack works at the
existing mobile width and maintains a simple reading order.

## Terminal and error behavior

The root Agent tool call/result is the parent-facing lifecycle boundary.
`SubagentStop` terminates only its child section.

- **Child success:** mark the child section `Completed`; keep the parent spinner
  until the root tool result arrives.
- **Child-reported failure:** mark that child `Failed`, keep its completed text
  and tools inspectable, and show the bounded failure reason directly below its
  label. Use `role="alert"` only when the failure first becomes visible.
- **Dangling tool at child terminal:** settle the existing tool row as failed
  with “Tool call ended before a result was received.” Do not create a second
  error card.
- **Parent error:** the outer header becomes `Failed`; preserve child evidence
  and show the existing parent result error after the activity region.
- **Abort/replacement/disconnect:** settle visible running affordances to
  `Stopped` or `Status unavailable`; never leave an eternal spinner in a
  terminal snapshot.
- **Late frames after a child terminal:** ignore them visually and retain the
  bounded translator diagnostic. Do not reopen or duplicate the section.
- **A child terminal must not trigger root `agent_end`, enable retry for the root
  assistant turn, play completion audio, or clear the root streaming state.**

Errors stay local. One child failure must not color another parent card or turn
unrelated root prose destructive.

## Late and unknown parents

Child frames can precede their root call in live delivery or appear without it
in a partial/recovered snapshot. They must still never render as root prose.

### Late parent

Buffer the normalized child projection by `parent_tool_use_id` without mounting
visible DOM. When the matching Agent/legacy Task tool call appears, attach the
buffer atomically and render it inside that card at the card's root ordinal.
The user should not see child prose flash at page level before reparenting.

### Recovery

On reload/resume, first rebuild from the authoritative chronological
`getSessionMessages()` snapshot. The SDK session-access seam also exposes the
pinned official `listSubagents` and `getSubagentMessages` APIs for bounded
supplemental recovery; it never inspects SDK transcript files directly.
`listSubagents` supplies child ids only, not parent or lifecycle mappings. Each
recovered row must independently carry an exact `parent_tool_use_id` that names
a real root Agent/Task card, or it remains unavailable rather than fabricated.

The session-access/runtime boundary owns this bounded fetch; the pure
normalizer/partitioner owns merging; the renderer receives only the projection
defined above. This keeps SDK access out of the browser and avoids a
recovery-specific renderer.

For an orphan row, “confirmed relationship” means the official SDK snapshot or
subagent API returned that exact `parent_tool_use_id`; a client-supplied id,
temporal proximity, or matching role label is insufficient.

Recovery rules:

- De-duplicate by SDK identity plus partition; recovered data cannot append a
  second copy of already visible text/tools.
- Confirm the parent relationship before showing recovered content.
- Keep the root tool card at its original ordinal. Recovered child events are
  ordered inside it by authoritative SDK order, not HTTP completion time.
- While recovery is in flight, the terminal collapsed header may show
  `Loading activity…` with `aria-busy="true"`; do not blank or reshuffle the
  transcript.
- Recovery failure preserves the parent card/result and adds the bounded inline
  warning `Agent activity could not be restored.` The parent result remains
  usable and auditable.

### Still unknown after recovery

If child activity has an SDK-confirmed `parent_tool_use_id` but no matching root
Agent/legacy Task call can be recovered, keep that partition buffered and
suppress it from the visual transcript. Do **not** synthesize, recover, or
mount a fallback Agent/tool card: the existing real parent tool card is the only
G10b surface.

Retain bounded diagnostic/audit evidence that the confirmed partition could not
be attached, including the parent tool-use id, child identity when available,
source/recovery phase, and a bounded count or reason. This evidence belongs in
existing diagnostic/JSON inspection surfaces, never root assistant prose or a
new UI treatment. If the real root call is later received, attach the retained
partition atomically to that exact card. Never attach a partition to the
nearest Agent card by time or label.

If the relationship itself cannot be confirmed, suppress the untrusted content
from the visual transcript and retain only a bounded audit diagnostic.

## Collapse, expansion, and live updates

- The entire parent header is one native `button` with a minimum 44 px touch
  target where layout permits.
- It owns stable `aria-expanded` and `aria-controls` values. The controlled
  region has a stable id derived from the parent tool-use id, not a render-time
  counter.
- Match the existing payload focus treatment exactly:
  `focus-visible:outline-none focus-visible:border-ring
  focus-visible:ring-ring/50 focus-visible:ring-[3px]`.
- Hover uses the existing `hover:text-foreground transition-colors` pattern.
- Enter and Space toggle. Focus stays on the header after toggling.
- Starting/streaming cards are initially expanded so work is discoverable.
  Once the user manually collapses one, subsequent tokens, tool starts, errors,
  or stops do not force it open.
- Expansion ownership lives in one keyed parent-card Lit component (or the
  equivalent parent-card state) keyed by `parentToolUseId`, not in temporary
  refs/class mutations recreated by each renderer call. Track whether the user
  has made an explicit choice. Apply status-based defaults only on that key's
  first mount; never overwrite the choice on a streamed rerender.
- The same keyed owner records coarse lifecycle announcement ids/states so a
  rerender, collapse/expand, or recovered duplicate cannot announce an event
  twice.
- Settled successful cards are initially collapsed on a fresh render/reload.
  Failed cards are initially expanded. During the same mounted lifecycle,
  preserve the user's current choice across status updates.
- Collapsed cards continue to update the compact status/count in place. They do
  not auto-scroll the transcript for hidden child token growth.
- Expansion state is presentation-only and need not be written to the SDK
  transcript. Reload applies the deterministic defaults above.
- Respect reduced motion. Height transitions may be omitted; status changes and
  ordering must not depend on animation.

The existing generic `renderCollapsibleHeader` does not currently expose
`aria-expanded`/`aria-controls` or a focus-visible ring. G10b's parent
disclosure must meet the contract above, ideally by improving/reusing that
primitive rather than copying another incomplete toggle.

## Screen-reader behavior

The objective is useful lifecycle feedback without announcing every streamed
token.

- The activity region uses `aria-busy="true"` while child work is active and
  `false` when terminal.
- Child Markdown and tool payloads are **not** broad live regions.
- Add one visually compact status node with `role="status" aria-live="polite"
  aria-atomic="true"`. Announce coarse transitions only: “Backend parity
  reviewer started”, “Search started”, “Search failed”, “Backend parity
  reviewer completed”. Throttle/deduplicate repeated streaming updates.
- An actionable/new terminal failure is announced once with `role="alert"`;
  rerender, expansion, and reload must not repeatedly announce the same error.
- Decorative icons and spinners are `aria-hidden="true"`; state words remain in
  accessible text.
- The header accessible name includes noun, role, state, and count, for example
  `Agent, Backend parity reviewer, working, 2 tools`.
- DOM order matches visual order. Collapsed content is actually hidden from the
  accessibility tree, not merely clipped with zero height.
- Nested disclosure buttons keep distinct accessible names such as `Expand
  Agent activity` and `Expand Read details`.

## Reload, compaction, and resume

Live, reloaded, compacted, archived, and resumed views must resolve to the same
parent/child projection:

- `getSessionMessages()` remains the primary authoritative snapshot and
  preserves `uuid`, `parentToolUseId`, and `parentAgentId`.
- Partition and reparent before handing rows to `MessageList`; a child row must
  never briefly enter the ordinary assistant-message list.
- Root message ordering remains owned by the existing unified reducer. Child
  activity is stored/rendered as parent-card detail rather than acquiring an
  unrelated root `_order`.
- Compaction may summarize older root context, but any retained/recovered Agent
  card keeps its child attribution. Recovered details must not appear both in a
  pre-compaction history view and the live card.
- Resume merges the SDK snapshot with live frames idempotently. A replayed
  `SubagentStart`, assistant message, tool result, or `SubagentStop` updates the
  same parent projection rather than duplicating it.
- A terminal snapshot has no spinner unless the SDK explicitly confirms the
  child or parent is still live.
- UI expansion defaults may reset on reload; content, state, order, and error
  visibility may not.

## Cost metadata, transcript, and audit presentation

G10b treats SDK usage/cost fields as opaque source metadata. It passes available
metadata through with its source identity and parent/child partition for audit;
it does not define aggregation, totals, billing rows, attribution, or accounting
semantics. G8 owns those decisions and any resulting cost presentation.

For auditability:

- retain child transcript rows with parent partition, child identity, and any
  available opaque source metadata in the authoritative normalized data;
- retain bounded diagnostic/audit evidence for partitions that cannot attach to
  a real parent card;
- expose stable, bounded DOM hooks on the ordinary parent card, for example
  `data-subagent-parent-tool-use-id`, `data-subagent-state`, and
  `data-subagent-count`;
- expose raw ids/types and opaque source metadata only in existing debug/JSON
  inspection surfaces; and
- never include prompts, credentials, transcript paths, or environment data in
  status labels, errors, tool summaries, analytics, or audit rows.

## Responsive and density rules

- Preserve the existing transcript `px-2 sm:px-4` gutters and outer card
  padding.
- Keep the header on one flex row when possible. The role label truncates before
  the state/count and chevron; its full safe label may be available by title.
- Below 480 px, metadata may wrap beneath the noun/role within the same header
  button. Do not create a separate toolbar row.
- Child text wraps normally. Paths and tool arguments use the existing renderer
  truncation/expansion behavior and must not force horizontal page scrolling.
- Multiple children remain a vertical stack with `space-y-3`.
- For large histories, collapsed parent cards mount only the summary until
  expanded; recovery and rendering remain partition-local and bounded.

## Consistency rationale

1. **Toggle:** reuse the tool/payload disclosure button grammar, spacing,
   chevrons, hover, and focus tokens. The G10b-specific requirement is to close
   the current missing ARIA/focus behavior, not invent a different accordion.
2. **Container:** retain the exact `tool-message` outer classes. No child gets
   its own card-colored shell or shadow.
3. **Label and icon:** reuse the `Bot`/Agent visual language and 14 px muted tool
   header. Status uses the same foreground, positive, destructive, warning, and
   muted tokens as existing renderer states.
4. **Tool lifecycle:** invoke the existing renderer registry with canonical
   identities. This preserves tool-specific labels, payload disclosure,
   loading, errors, truncation, and theme behavior.
5. **Position:** activity appears in the parent tool card's body, the same
   visual group as its call/result. It does not create a page-level row,
   sidebar item, modal, or panel.
6. **Affordances:** there is no session link because the SDK child has no Bobbit
   session. Adding one would copy the appearance of `DelegateRenderer` while
   violating its navigation contract.

## Acceptance scenarios

| Scenario | Required visible/accessibility result |
| --- | --- |
| Streaming text then Read/Search | One expanded Agent card; text and existing tool rows update inside it; no duplicate root prose; coarse live announcements only. |
| Root plus two interleaved parent partitions | Each child updates only its exact parent card; outer card order remains root order; repeated ids across partitions do not collide. |
| Two children under one recovered parent | Two vertical labeled sections in first-observed order; no cross-child tool grouping or result matching. |
| Child succeeds before parent result | Child says `Completed`; outer header says `Finishing…` and remains in progress until root result. |
| Child tool fails | Existing nested tool row shows destructive state and bounded detail; header includes `1 failed`; error announced once. |
| Child terminal with dangling tool | That row settles failed; no root `agent_end`, retry, completion sound, or unrelated state change. |
| Parent fails/aborts | Same outer card becomes `Failed`/`Stopped`, is expanded when detail exists, and preserves child evidence. |
| Child frames arrive before parent | No page-level flash; buffered activity attaches atomically when the matching parent card appears. |
| Parent absent on reload | Attempt SDK recovery; buffer an SDK-confirmed partition by its exact parent id, but suppress it until the real parent card is present. Retain bounded diagnostic/audit evidence; suppress untrusted content as well. |
| Collapse during streaming | Header stays focused and updates counts/status; hidden tokens do not reopen the card or force scroll. |
| Successful reload | Same content/order/state, terminal card collapsed by default, no spinner or duplicated rows. |
| Failed reload/recovery | Parent result remains visible; inline warning says activity could not be restored; no standalone child UI. |
| Resume/replayed frames | Existing parent projection updates idempotently; no duplicate child text/tool calls or repeated alert announcements. |
| Keyboard/screen reader | Header exposes correct accessible name, `aria-expanded`, `aria-controls`, focus ring, real hidden state, coarse status announcements, and explicit terminal words. |

## Non-goals

- No subagent sidebar, tab, standalone card type, transcript route, or modal.
  G10b makes no cost/accounting presentation decision; G8 owns that scope.
- No SDK child avatar, accessory, session link, branch, worktree, Bobbit task,
  task assignment, notification, or completion sound.
- No change to Bobbit `team_delegate`, `team_spawn`, or durable `task_*` UX.
- No change to backend admission, authorization, concurrency, billing, or
  transcript ownership in this UX specification.
