# Session prompt tools

Bobbit has two agent-facing ways to send a message to an existing session:

- `team_prompt` — scoped orchestration for a team agent, an owned `team_delegate` child, or a direct child goal's team lead.
- `session_prompt` — an explicitly enabled cross-session tool that can target any live agent session by id.

Both surfaces feed the same server-side delivery helper, which chooses between normal prompt queue delivery, live steering, and errored-idle recovery. Keeping mode selection centralized ensures prompt/steer recovery, queue persistence, and `bash_bg wait` interruption stay consistent across tools.

For startup, restart, and broken override fallback behavior, see [Tool override startup resilience](tool-startup-resilience.md).

## Delivery modes

| Mode | Streaming target | Idle / non-streaming target | Typical use |
|---|---|---|---|
| `prompt` | Enqueues a normal prompt behind current work. | Starts a normal turn immediately when possible, otherwise queues normally. | New work or follow-up tasks that should run as a fresh turn. |
| `steer` | Uses the live-steer path (`SessionManager.deliverLiveSteer`). | Queues a steered prompt with `isSteered: true`. | Current-turn corrections, urgent nudges, or preserving steered recovery semantics. |

Steered delivery is not a silent downgrade to a normal prompt. If the target is not currently streaming, the queued row remains steered, so it keeps steered priority and the existing abort/restart recovery behavior described in [Prompt Queue & Message Dispatch](prompt-queue.md).

## Errored-idle recovery

If a target session is `idle` and its last turn ended with `lastTurnErrored`, prompt delivery checks whether the recorded error is safe to retry before it queues ordinary work. This prevents a team lead's `team_prompt` from parking indefinitely behind an errored turn that the UI would otherwise recover with the **Retry** button.

Recoverable errors include provider backoff, retryable transient transport failures such as `fetch failed`, and retryable generic model/API failures. For those cases, delivery:

1. queues the caller's message through the retry-recovery queue path, preserving whether it was a normal prompt or a steered prompt;
2. calls `retryLastPrompt(..., { auto: true })`, the same continuation-safe path used by auto-retry and the UI Retry button;
3. protects the newly queued row while retrying the failed turn, so the caller's intent drains after recovery exactly once instead of being dropped, consumed as the retry row, or duplicated.

Non-retryable and action-required failures are blocked before queuing the new message. This includes authentication/authorization failures, invalid or missing provider credentials, deterministic validation/configuration errors, unclassified errors, and bounded retry policies whose automatic budget is exhausted. The API returns a clear recovery-blocked error rather than silently resurrecting the session or leaving the prompt hidden in the queue.

The behavior is shared by goal-team `team_prompt`, direct child goal lead prompting, `OrchestrationCore.prompt`, and the own-child fallback used for non-blocking `team_delegate` children. The goal-team route and the `/api/sessions/:ownerId/orchestrate/prompt` route both feed the same delivery helper and `SessionManager` recovery primitives.

## `session_prompt`

`session_prompt` sends a message to any live Bobbit agent session by session id.

The chat transcript uses a dedicated `session_prompt` tool renderer instead of showing the raw JSON response. The card summarizes the action and target in its header, then shows:

- the target session title when the delivery result includes one, otherwise a shortened session id fallback;
- the target session link using the same session-link affordance as other agent cards;
- the delivery mode (`prompt` by default, or `steer`);
- the prompt/steer message body, preserving line breaks while relying on Lit template escaping for safety.

Prompt cards use the chat/message icon and a `Prompted` header. Steer cards use a lightning-style icon and a `Steered` header. Completed cards include the delivery outcome: `queued`, `dispatched`, or `live steer dispatched`. Failed and aborted cards follow the normal tool-renderer error conventions and surface the server error text.

Parameters:

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `session_id` | string | Yes | — | Target session id. The target must be live and not terminated or archived. |
| `message` | string | Yes | — | User message delivered to the target. |
| `mode` | `"prompt" \| "steer"` | No | `"prompt"` | Selects normal prompt delivery or steer delivery. |

`session_prompt` is intentionally more powerful than `team_prompt`: it is not limited to owned children, team members, or direct child goal leads. Because of that scope, the tool YAML declares `grantPolicy: never`. It is registered as a built-in tool but is absent from default allowed tools until a role, project, or user policy explicitly grants `session_prompt`.

If a role or project changes `session_prompt` to `ask`, permission approval resumes the blocked tool call through the active guard long-poll. The UI grant card does not resend the original prompt text, which avoids duplicate delivery to the target session. See [Tool access policies](internals.md#tool-access-policies) for the grant resumption contract.

Server-side authorization is caller-based:

1. The REST endpoint resolves the caller from the per-session secret.
2. The caller session must be live.
3. The caller's resolved allowed-tool list must include `session_prompt`.
4. Only then does the server deliver to the target session id.

Target authorization is deliberately broad after the caller is authorized: any live target id is valid. Missing, archived, or terminated targets are rejected before delivery.

### Result metadata

Successful prompt deliveries include target metadata so the renderer can identify the destination without widening access. Recovery is observable in the result instead of being reported as a plain queued prompt:

```ts
type SessionPromptResult =
  | {
      ok: true;
      mode: "prompt" | "steer";
      status: "dispatched" | "queued";
      target: { sessionId: string; title?: string };
    }
  | {
      ok: true;
      mode: "prompt" | "steer";
      status: "recovered";
      recovered: true;
      recovery: {
        status: "recovered";
        reason: "provider-backoff" | "transient" | "generic";
        queued: true;
        queuedId?: string;
      };
      target: { sessionId: string; title?: string };
    }
  | {
      ok: true;
      mode: "steer";
      dispatched: true;
      target: { sessionId: string; title?: string };
    };
```

`target.sessionId` is always the resolved target id. `target.title` is present only when the live session has a non-empty title. `status: "recovered"` means the delivery path queued the caller's message as preserved intent and triggered retry recovery for the errored target. This metadata is display-only: `session_prompt` keeps `grantPolicy: never`, still requires the caller session secret, and still checks the caller's allowed tools before resolving or delivering to the target.

### Non-interactive / reviewer sessions

Normal prompt mode must not start new work on non-interactive sessions such as verification reviewers. For those sessions:

- `mode: "prompt"` is rejected by default.
- `mode: "steer"` may redirect the session only while it is actively streaming.
- `mode: "steer"` is rejected for idle/non-streaming non-interactive sessions, because queuing it would start reviewer work outside the verification harness.

This keeps automated reviewer/QA sessions owned by their harness while still allowing an authorized operator to redirect an active streaming turn.

## `team_prompt`

`team_prompt` now supports the same `mode` parameter, but its default is `"steer"`.

Parameters:

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `session_id` | string | Yes | — | Team agent, owned `team_delegate` child, or direct child goal team-lead session id. |
| `message` | string | Yes | — | User message delivered to the target. |
| `mode` | `"prompt" \| "steer"` | No | `"steer"` | Omit for routine nudges; set `"prompt"` for normal next-turn queue semantics. |
| `workflowGateId` | string | No | — | Gate the agent works toward; dependency checks still run. |
| `inputGateIds` | string[] | No | — | Explicit gate ids to inject as context. |

Authorization scope is unchanged:

- A team lead may prompt agents in its own team.
- A team lead may prompt the team lead of a direct child goal.
- A caller may prompt its own non-blocking `team_delegate` children through the own-child orchestration path.

`workflowGateId` and `inputGateIds` are applied before delivery, so both prompt and steer modes receive the same dependency context injection. If a `workflowGateId` dependency check fails, delivery is rejected before any prompt or steer reaches the target.

If the target is idle with a retryable errored last turn, `team_prompt` triggers the errored-idle recovery flow above and returns recovery metadata. This applies both to goal team members and to the goal route's own-child fallback for a team lead's non-blocking `team_delegate` helper.

Use `mode: "prompt"` when the agent should treat the message as a fresh next-turn assignment. Use the default steer mode for routine mid-work corrections or nudges; if the target is idle, the prompt is still queued as steered rather than becoming a normal prompt.

## `team_steer` compatibility

`team_steer` remains for backward compatibility. It is streaming-only and fails when the target is not actively running. Prefer `team_prompt(mode="steer")` — or omit `mode` — for normal team nudges because it handles both streaming targets and idle/non-streaming targets with steered queue semantics.

## REST surfaces

- `POST /api/sessions/:id/prompt` backs `session_prompt`. Body: `{ message, mode? }`; `:id` is the target session. The caller is authenticated by session secret and must have the `session_prompt` tool allowed. Returns `409 { code: "GOAL_PAUSED" }` when the target session's goal is paused; sessions with no associated goal are unaffected.
- `POST /api/goals/:id/team/prompt` backs goal-team `team_prompt`. Body: `{ sessionId, message, mode?, workflowGateId?, inputGateIds? }`; `:id` is the caller's goal. Returns `409 { code: "GOAL_PAUSED" }` when the goal is paused — this check fires before team membership verification.
- `POST /api/sessions/:id/orchestrate/prompt` backs own-child `team_prompt`. Body includes the child session id and message; `:id` is the owner session.

See [REST API](rest-api.md) for the route table and [Orchestration](orchestration.md) for child-agent scoping.

## Verification coverage

Focused coverage lives in:

- `tests/session-prompt-delivery.test.ts` — shared helper mode selection, streaming vs idle behavior, missing/terminated targets, result `target.sessionId`/optional `target.title` metadata, and non-interactive rules.
- `tests2/integration/team-steer-prompt.test.ts` — goal-team `team_prompt` recovery for retryable `fetch failed`, blocked/action-required behavior for provider-auth failures, exactly-once queued-intent preservation, and workflow context injection.
- `tests/session-prompt-policy.test.ts` — real `session_prompt` YAML `grantPolicy: never` and absence from default allowed tools until explicitly re-granted.
- `tests/session-prompt-renderer.spec.ts` with `tests/fixtures/session-prompt-renderer.html` — browser fixture coverage for default prompt mode, steer mode with distinct icon/label, multiline escaped message text, missing-title fallback to shortened id, session link rendering, and server error display.
- `tests/e2e/session-prompt.spec.ts` — caller authorization, arbitrary live target prompting, returned target metadata, and steer-mode interruption of `bash_bg wait` through the live-steer path.
- `tests/e2e/team-steer-prompt.spec.ts` — `team_prompt` default steer behavior, `mode: "prompt"` normal queue semantics, and workflow context injection in both modes.
