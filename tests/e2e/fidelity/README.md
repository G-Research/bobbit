# Transcript fidelity harness

See [docs/design/transcript-fidelity-harness.md](../../../docs/design/transcript-fidelity-harness.md)
for the design rationale.

This directory contains the **prototype** (Step 1 of the build order):

- `scripts/*.json`           — declarative scripts the agent should emit
- `scripted-agent.mjs`       — replays a script through the in-process bridge
- `scripted-agent-bridge.mjs` — `IRpcBridge` implementation that hosts the player
- `dom-recorder.ts`          — in-page MutationObserver, records what the user saw
- `oracle.ts`                — pure `diff(script, observed) → Verdict`
- `harness.ts`               — Playwright fixture that wires it all together
- `fidelity-prototype.spec.ts` — first end-to-end demo test

## Script schema (prototype subset)

```jsonc
{
  "name": "happy-path",
  "description": "...",
  "firstPaintBudgetMs": 600,
  "idleSettleBudgetMs": 800,
  "steps": [
    // Wait until a user prompt arrives on the bridge
    { "on": "user_prompt" },

    // Absolute (Nms) or relative (+Nms) timing.
    // Frame shapes mirror agent-protocol events that flow through
    // RemoteAgent's WS event handler: message_update, message_end,
    // session_status, agent_start, agent_end.
    { "at": "+20ms",  "emit": { "type": "session_status", "status": "streaming" } },
    { "at": "+30ms",  "emit": { "type": "agent_start" } },
    { "at": "+50ms",  "emit": { "type": "message_end",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": "Hello." }] } } },
    { "at": "+60ms",  "emit": { "type": "agent_end" } },
    { "at": "+70ms",  "emit": { "type": "session_status", "status": "idle" } }
  ]
}
```

## Run the prototype demo

```bash
npm run build
npx playwright test --config playwright-e2e-standard.config.ts \
  tests/e2e/fidelity/fidelity-prototype.spec.ts
```

The test prints an oracle verdict — multiset / order / monotonicity / first-paint / idle-settle.

## What's deliberately missing

This is the prototype. The following come in subsequent steps:

- Tool-call lifecycle frames (`tool_execution_start/update/end`) — Step 2.
- Streaming `message_update` deltas with stable IDs — Step 2.
- Reload / WS-drop / server-restart perturbations — Step 3+.
- Steer-during-stream branches — Step 5.
- DOM identifier audit (`data-message-id` etc.) — Step 1 follow-up.
