# Inter-Agent Communication

## Problem

Bobbit has several ways to steer, nudge, notify, and observe agents, but it does not yet have a durable agent-to-agent communication model. Current channels are mostly control-plane paths: team lead nudges, owner-scoped child-agent prompts, inbox staff nudges, WebSocket broadcasts, and extension session posts. Future swarms need a data-plane path: direct scoped messages, goal-local topics, and reconciliation events that can be consumed without scraping transcripts.

This design adds durable communication without broadening trust. The owner-session scoping used by `host.agents` is the baseline: a sender may address only sessions it owns, leads, works with, or is explicitly permitted to notify.

## Today's state

- Team-lead nudges exist today. Team event subscriptions are restored after restart in `src/server/agent/team-manager.ts:1058`, worker-nudge checks and enqueue paths live at `src/server/agent/team-manager.ts:1545`, worker terminal events schedule team-lead notifications at `src/server/agent/team-manager.ts:1638`, and team-lead idle/backoff handling is at `src/server/agent/team-manager.ts:1683`.
- Team spawning already enforces goal/team constraints. `spawnRole()` validates role, active team, concurrency cap, paused goal, and gate dependency before creating a worker at `src/server/agent/team-manager.ts:1996`.
- Verification can notify the team lead. The server wires a verification notifier that uses live steer when possible and queued prompts otherwise at `src/server/server.ts:3183`.
- Browser-to-session prompt/steer exists. The WebSocket handler enqueues prompts or delivers live steer for browser sessions at `src/server/ws/handler.ts:840`.
- Team prompt/steer has an API. `/api/goals/:id/team/prompt` can prompt or steer team agents, direct-child leads, or owned helper children at `src/server/server.ts:12502`.
- Cross-session prompt is constrained. `/api/sessions/:id/prompt` requires an `x-bobbit-session-secret` mapped to the caller session and the caller's `session_prompt` tool at `src/server/server.ts:12958`.
- Session notification exists as a system-sourced queue path. `/api/sessions/:id/notify` is used for server-originated notification to a session prompt queue at `src/server/server.ts:13000`.
- `host.agents` already provides owner-scoped child control. `OrchestrationCore` is the shared implementation for REST and extension-host child agents at `src/server/agent/orchestration-core.ts:5`, denies spawn verbs/read-only tools for children at `src/server/agent/orchestration-core.ts:34`, and rejects grandchildren at `src/server/agent/orchestration-core.ts:414`.
- `host.agents` children inherit sandbox/project scope and are registered as owned children at `src/server/agent/orchestration-core.ts:520`. Owned-child registration and filtering lives at `src/server/agent/orchestration-core.ts:625`.
- The REST orchestration routes preserve owner-session scoping for child spawn/prompt/steer/abort/dismiss/wait at `src/server/server.ts:13086`.
- The extension host exposes `host.agents` as a poll-based, owner-filtered namespace at `src/server/extension-host/server-host-api.ts:50`, with spawn/prompt/dismiss/list/read/status/spawnGoal methods at `src/server/extension-host/server-host-api.ts:66`.
- The extension-host implementation filters to own `host-agents` children and requires ownership before prompt/read/status at `src/server/extension-host/server-host-api.ts:332`.
- Inbox machinery is staff-oriented, not general agent messaging. `InboxManager` persists entries, broadcasts `inbox.entry.*`, and pokes the nudger at `src/server/agent/inbox-manager.ts:11`; enqueue is at `src/server/agent/inbox-manager.ts:70`, completion at `src/server/agent/inbox-manager.ts:111`, terminal updates at `src/server/agent/inbox-manager.ts:135`, and removal at `src/server/agent/inbox-manager.ts:158`.
- `InboxNudger` wakes idle staff sessions for pending inbox work. Its policy is described at `src/server/agent/inbox-nudger.ts:8`, `poke()` is at `src/server/agent/inbox-nudger.ts:80`, pending-entry checks are at `src/server/agent/inbox-nudger.ts:134`, and compact inbox prompts are enqueued at `src/server/agent/inbox-nudger.ts:168`.
- WebSocket broadcasts are UI and invalidation channels, not durable agent messages. Goal broadcasts are implemented at `src/server/server.ts:2888`, global broadcasts at `src/server/server.ts:2976`, project broadcasts at `src/server/server.ts:3016`, session broadcasts at `src/server/server.ts:3144`, and viewer subscriptions are handled at `src/server/ws/handler.ts:609`.
- Extension channels are scoped to pack-bound surfaces. Channel permits are bound and registered in `src/server/ws/handler.ts:246`, supported extension channel message types are listed at `src/server/ws/handler.ts:281`, and open permits are minted at `src/server/server.ts:8111`.
- Extension session posts are session-bound, nonce-bound, and pack-derived. `ext_session_write_permit` is minted from the authenticated session at `src/server/ws/handler.ts:1485`, and `ext_session_post` targets only that authenticated session with source `extension` at `src/server/ws/handler.ts:1518`.
- The client channel bridge intentionally hides raw socket, URL, bearer, and caller-selectable pack identity from untrusted extension UI code at `src/app/channel-bridge.ts:1`.
- SWARM-W0 groundwork exists. The design doc says two of three reconciliation primitives are built in `docs/design/swarm-orchestration-w0.md:16`, terminal barrier/artifact capture is described at `docs/design/swarm-orchestration-w0.md:81`, and the reconciler remains out of scope at `docs/design/swarm-orchestration-w0.md:149`.
- The fable-refactor swarm design expects a `swarm-group` tag, terminal barrier plus artifact capture, and a reconciler pack in `/Users/aj/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md:41`.
- Multi-Bobbit federation could not be verified as an implemented feature in this checkout. This design names seams only and keeps federation out of scope.

## Design

### Direct agent-to-agent messages

Add a durable `AgentMessageStore` with append-only records and recipient indexes. Direct messages should be persisted before any wake-up or steer happens.

```ts
type AgentMessage = {
  id: string;
  projectId: string;
  goalId?: string;
  threadId?: string;
  fromSessionId: string;
  toSessionId: string;
  topic?: string;
  kind: "note" | "request" | "answer" | "artifact" | "status" | "barrier";
  priority: "low" | "normal" | "urgent";
  body: string;
  refs?: Array<{ kind: string; id: string; path?: string }>;
  createdAt: string;
  expiresAt?: string;
  requiresAck?: boolean;
  ack?: { at: string; bySessionId: string };
};
```

Delivery should be a separate concern:

- `append`: store the message and make it visible to readers.
- `wake`: if the recipient is idle, enqueue a compact system message pointing at unread items.
- `steer`: for urgent messages to an actively streaming eligible recipient, use existing live-steer mechanics after persistence.

The recipient prompt should contain a digest, not the whole message log. The session can read the full message through a tool/API when it needs it.

### Pub-sub topics per goal

Add goal-local topics backed by the same message store. Topics are not arbitrary global strings; they are server-derived resources such as:

- `goal.<goalId>.team`
- `goal.<goalId>.swarm.<swarmGroupId>`
- `goal.<goalId>.gate.<gateId>`
- `goal.<goalId>.reviews`
- `goal.<goalId>.artifacts`

Membership should be derived from existing goal/team/orchestration records:

- Team lead and workers subscribe to the team topic.
- Swarm siblings and the reconciler subscribe to the swarm topic.
- Verification staff and team lead subscribe to gate topics.
- Owner sessions can read topics for their own children.

Publishing should support retained events. A late-starting reconciler should be able to read terminal sibling artifacts that were published before it started.

### SWARM-W1 reconciliation barrier consumption

SWARM-W0 already describes a terminal barrier and artifact capture. SWARM-W1 should turn that barrier into topic events:

- `swarm.sibling.terminal`: emitted when a sibling reaches terminal state, with refs to captured artifacts.
- `swarm.barrier.ready`: emitted once all expected siblings reach terminal state or the all-failed path is known.
- `swarm.reconciler.started`: emitted when the reconciler begins consuming the barrier.
- `swarm.reconciler.result`: emitted with the selected artifact, merge notes, and unresolved conflicts.
- `swarm.reconciler.failed`: emitted with failure evidence and next-step recommendation.

The reconciler should not scrape sibling transcripts. It should consume:

- Swarm group metadata.
- Captured sibling artifacts.
- Topic events since the swarm group started.
- Direct messages addressed to the reconciler.

If all siblings fail, the barrier should publish `swarm.barrier.ready` with an `allFailed` marker and send a direct urgent message to the team lead or owning session.

### Trust and permissions

The permission model follows owner-session scoping:

- Team lead may message workers and child leads in its team.
- Worker may message its team lead and, where the workflow allows it, sibling topic channels for the same swarm group.
- Owner session may message its own `host.agents` children.
- `host.agents` children may message their owner session but not foreign sessions.
- Verification may notify the relevant team lead or gate topic only.
- Staff sessions may publish to the inbox or staff topic they own, not arbitrary user sessions.
- Extension channels may post only to their authenticated session unless an explicit server-mediated agent-message capability is added later.

Every send should derive sender identity from the session secret, WebSocket auth, or server context. The caller should not supply `projectId`, `fromSessionId`, or pack identity as trusted inputs.

Cross-goal messaging should be limited to ancestor/descendant goal relationships unless an explicit project policy grants more. Cross-project messaging is out of scope.

### Federation scope

Multi-Bobbit federation is explicitly out of scope. The message ids, project ids, and topic names should be stable enough that a future federation bridge could map them, but this design does not add remote identity, remote routing, remote trust, or inter-instance delivery.

## Phased implementation plan

### Phase 1 - S: append-only message store

Create a project-scoped `AgentMessageStore` with append, list-by-recipient, list-by-topic, mark-read, and ack operations. Do not wake sessions in this phase.

File seams:

- Add `src/server/agent/agent-message-store.ts`.
- Mount it near other server-owned stores, alongside the existing inbox and orchestration setup.
- Broadcast lightweight invalidation through existing `broadcastToSession()` at `src/server/server.ts:3144` and `broadcastToGoal()` at `src/server/server.ts:2888`.

### Phase 2 - M: direct message API and tool

Add a server route and tool for direct messages. The route should authenticate like `/api/sessions/:id/prompt` and authorize relationships like `host.agents`.

File seams:

- Reuse session-secret caller mapping from `src/server/server.ts:12958`.
- Reuse owner-child checks from `src/server/agent/orchestration-core.ts:625` and `src/server/extension-host/server-host-api.ts:332`.
- Add a narrow tool such as `agent_message_send` rather than broadening `session_prompt`.
- Deliver wake-ups through the existing queued prompt path, with source `agent-message`.

### Phase 3 - M: goal topics and digest delivery

Add topic publish/read APIs and throttled recipient digests. Digest delivery should borrow the inbox pattern: persist first, poke a nudger, and enqueue only when useful.

File seams:

- Reuse the side-effect shape of `InboxManager` at `src/server/agent/inbox-manager.ts:11`.
- Reuse idle/wake policy ideas from `InboxNudger` at `src/server/agent/inbox-nudger.ts:8`.
- Reuse viewer/project/goal broadcast wiring from `src/server/server.ts:2888`.

### Phase 4 - M: SWARM-W1 barrier events

Publish swarm terminal and barrier events from the SWARM-W0 terminal path. Start the reconciler from a retained `swarm.barrier.ready` topic event rather than from ad hoc polling.

File seams:

- Use SWARM-W0 terminal-barrier design in `docs/design/swarm-orchestration-w0.md:81`.
- Use the fable-refactor reconciliation primitives in `/Users/aj/Documents/dev/bobbit-fable-refactor/design/swarm-orchestration.md:41`.
- Publish `swarm.sibling.terminal` before firing the reconciler.
- Publish `swarm.reconciler.result` as the artifact that the team lead or parent goal consumes.

### Phase 5 - L: UI and observability

Expose message/topic state in the side panel and future Mission Control. The UI should show unread direct messages, topic streams for the selected goal, and swarm barrier state. It should not expose raw send controls unless the current user/session has a valid relationship to the target.

File seams:

- Existing session list and dashboard synchronization are described in `docs/architecture.md:38`.
- Extension channel panels can observe through scoped channels, but must preserve the channel-bridge constraints in `src/app/channel-bridge.ts:1`.

## Risks

- Context overload: direct messages can become another prompt-bloat source if every event wakes an agent.
- Loops: two agents can keep requesting clarification unless messages have thread ids, acks, and rate limits.
- Prompt injection: agents may trust sibling messages too much. System prompts should identify message source and permission class.
- Privacy leakage: topic membership bugs could leak goal or project data across sessions.
- Delivery ambiguity: live steer is ephemeral, while the message store is durable. Persistence must happen first.
- Reconciliation deadlocks: a reconciler waiting for topic events must have clear terminal and timeout rules.

## A-B-testability

Inter-agent communication can be tested against today's nudge-only behavior. Use workflow variants where one branch uses current team-lead nudges and another enables direct messages or swarm topics.

Primary metrics are wall time, idle time, number of steer/prompt interventions, gate re-signal count, reconciler success rate, all-failed handling quality, token cost, and user intervention count. Topic/digest thresholds are also tunable A/B levers: immediate wake versus batched digest, direct worker-to-lead messages versus topic-only publish, and retained barrier events versus polling.

