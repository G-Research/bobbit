# Agent-in-the-Loop Debug Cycle

How to debug UI features that automated tests miss, using an agent driving a browser against an isolated test gateway.

## Context: The Permission Card Bug

The tool permission card (shown when a guard blocks a tool call) had two bugs:
1. `AgentInterface` didn't handle the `"render"` event emitted by `RemoteAgent`, so Lit never re-rendered with the card
2. The card was only broadcast via WebSocket at block time — reconnecting clients never saw it

The existing E2E test (`tool-ask-policy.spec.ts`) didn't catch this because it **called the REST endpoint directly** to simulate the guard, bypassing the real flow where the agent's guard extension POSTs to the gateway, the gateway broadcasts via WS, and the client renders the card.

## The Debug Session (What Worked)

An agent drove the production dev server's browser UI:

1. **Created a UX Designer session** (the only role with `bash_bg: ask` policy)
2. **Sent a message** asking the agent to use `bash_bg`
3. **Observed the tool spinner stuck** — guard was blocking but no card appeared
4. **Added diagnostic console.log** to both server (`requestToolGrant`) and client (`handleServerMessage`)
5. **Checked browser state** via `browser_eval`:
   - `state.messages` had 2 items (user + `tool_permission_needed`) — server broadcast worked
   - `message-list.messages` had 1 item (user only) — Lit wasn't re-rendering
6. **Found root cause**: `AgentInterface.subscribe()` didn't handle `type: "render"` events
7. **Fixed both bugs**, rebuilt, created a new session, confirmed the card appeared
8. **Tested persistence** by navigating away and back — card reappeared

Total diagnostic artifacts: browser screenshots at each step, JS console state dumps, server log traces.

## What Went Wrong: Isolation

The agent ran the debug cycle against the **production dev server**, which:
- Meant the user couldn't use their own server during testing
- Risked corrupting production state
- Failed when the agent tried to spin up an "isolated" gateway inside the same repo directory, which shared git state and file watchers with the dev harness, taking down the production server

## How to Do It Properly

### Isolated Gateway Setup

The key requirement: **nothing shared with the source repo at runtime**.

```bash
# 1. Create temp directory completely outside the repo
WORK_DIR=$(mktemp -d)
BOBBIT_DIR="$WORK_DIR/.bobbit"
mkdir -p "$BOBBIT_DIR/state" "$BOBBIT_DIR/config/roles"
echo "test" > "$BOBBIT_DIR/state/setup-complete"

# 2. Reference built artifacts from the repo (read-only)
REPO="/path/to/bobbit"
SERVER_CLI="$REPO/dist/server/cli.js"
MOCK_AGENT="$REPO/tests/e2e/mock-agent.mjs"

# 3. Create test-specific config
cat > "$BOBBIT_DIR/config/roles/test-role.yaml" << EOF
name: test-role
label: Test Role
toolPolicies:
  bash_bg: ask
EOF

# 4. Start gateway with full isolation
BOBBIT_DIR="$BOBBIT_DIR" \
BOBBIT_NO_OPEN=1 \
  node "$SERVER_CLI" \
    --host 127.0.0.1 \
    --port 0 \
    --no-tls \
    --auth \
    --agent-cli "$MOCK_AGENT" \
    --cwd "$WORK_DIR"

# 5. Clean up after
rm -rf "$WORK_DIR"
```

Critical isolation rules:
- `--cwd` points to the temp dir, NOT the repo
- `BOBBIT_DIR` points to temp dir's `.bobbit/`, NOT the repo's
- The repo is only referenced for `dist/` and `tests/` (read-only)
- No git operations in the temp dir (or init a fresh repo if needed)

### Browser-Driven Verification

Once the gateway is running, the agent uses browser tools to:

1. Navigate to `http://127.0.0.1:<port>/?token=<token>`
2. Create a session with the test role
3. Send a message that triggers the guarded tool
4. Take screenshots at each step (saved to the temp dir)
5. Use `browser_eval` to inspect DOM state and JS console
6. Test persistence by navigating away and back
7. Generate an HTML report with embedded screenshots

### Incorporating into Goal Workflows

A **QA agent role** could automate this as a workflow gate:

1. Team lead spawns a `qa-engineer` agent after implementation
2. QA agent checks out the goal branch
3. Builds the server (`npm run build`)
4. Spins up an isolated gateway in a temp dir (as above)
5. Drives the browser through test scenarios with screenshots
6. Produces an HTML report with pass/fail evidence
7. Signals the `qa-validation` gate with the report
8. Tears down the ephemeral environment

This requires:
- A `qa-engineer` role with browser tools and a prompt describing the test protocol
- A skill or recipe for "spin up isolated gateway + test + report"
- A workflow gate (`qa-validation`) that the QA agent signals
- The team lead's prompt to know when/how to spawn the QA agent

### Existing Infrastructure to Build On

- `tests/e2e/gateway-harness.ts` — already spawns isolated gateways per Playwright worker
- `tests/e2e/mock-agent.mjs` — deterministic mock agent (no API key needed)
- `tests/e2e/e2e-setup.ts` — REST/WS helpers for the isolated gateway
- `tests/e2e/ui/ui-helpers.ts` — page-object helpers for browser interaction

The gap is making these available to an agent session (not just Playwright test files) and adding report generation.
