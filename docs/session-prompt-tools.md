# Session prompt tools

Bobbit has two agent-facing ways to send a message to an existing session:

- `team_prompt` — scoped orchestration for a team agent, an owned `team_delegate` child, or a direct child goal's team lead.
- `session_prompt` — an explicitly enabled cross-session tool that can target any live agent session by id.

Both surfaces feed the same server-side delivery helper, which chooses between normal prompt queue delivery and live steering. Keeping mode selection centralized ensures prompt/steer recovery, queue persistence, and `bash_bg wait` interruption stay consistent across tools.

For startup, restart, and broken override fallback behavior, see [Tool override startup resilience](tool-startup-resilience.md).

## Delivery modes

| Mode | Streaming target | Idle / non-streaming target | Typical use |
|---|---|---|---|
| `prompt` | Enqueues a normal prompt behind current work. | Starts a normal turn immediately when possible, otherwise queues normally. | New work or follow-up tasks that should run as a fresh turn. |
| `steer` | Uses the live-steer path (`SessionManager.deliverLiveSteer`). | Queues a steered prompt with `isSteered: true`. | Current-turn corrections, urgent nudges, or preserving steered recovery semantics. |

Steered delivery is not a silent downgrade to a normal prompt. If the target is not currently streaming, the queued row remains steered, so it keeps steered priority and the existing abort/restart recovery behavior described in [Prompt Queue & Message Dispatch](prompt-queue.md).

## `session_prompt`

`session_prompt` sends a message to any live Bobbit agent session by session id.

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

Use `mode: "prompt"` when the agent should treat the message as a fresh next-turn assignment. Use the default steer mode for routine mid-work corrections or nudges; if the target is idle, the prompt is still queued as steered rather than becoming a normal prompt.

## `team_steer` compatibility

`team_steer` remains for backward compatibility. It is streaming-only and fails when the target is not actively running. Prefer `team_prompt(mode="steer")` — or omit `mode` — for normal team nudges because it handles both streaming targets and idle/non-streaming targets with steered queue semantics.

## REST surfaces

- `POST /api/sessions/:id/prompt` backs `session_prompt`. Body: `{ message, mode? }`; `:id` is the target session. The caller is authenticated by session secret and must have the `session_prompt` tool allowed.
- `POST /api/goals/:id/team/prompt` backs goal-team `team_prompt`. Body: `{ sessionId, message, mode?, workflowGateId?, inputGateIds? }`; `:id` is the caller's goal.
- `POST /api/sessions/:id/orchestrate/prompt` backs own-child `team_prompt`. Body includes the child session id and message; `:id` is the owner session.

See [REST API](rest-api.md) for the route table and [Orchestration](orchestration.md) for child-agent scoping.

## Verification coverage

Focused coverage lives in:

- `tests/session-prompt-delivery.test.ts` — shared helper mode selection, streaming vs idle behavior, missing/terminated targets, and non-interactive rules.
- `tests/session-prompt-policy.test.ts` — real `session_prompt` YAML `grantPolicy: never` and absence from default allowed tools until explicitly re-granted.
- `tests/e2e/session-prompt.spec.ts` — caller authorization, arbitrary live target prompting, and steer-mode interruption of `bash_bg wait` through the live-steer path.
- `tests/e2e/team-steer-prompt.spec.ts` — `team_prompt` default steer behavior, `mode: "prompt"` normal queue semantics, and workflow context injection in both modes.
