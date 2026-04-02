# Agent-in-the-Loop Debug Cycle

How to debug and validate UI features using an agent driving a real browser against an isolated gateway — without touching the production dev server.

## Why This Exists

Automated E2E tests use mock agents and synthetic REST calls to simulate user flows. This misses bugs that only manifest through the **real code path**: real agent → real tool call → real guard extension → real WebSocket broadcast → real UI render.

Example: the tool permission card had two bugs that the existing E2E test missed because the test called the REST endpoint directly instead of letting the real agent trigger the guard extension.

## The Protocol

### 1. Spin up an isolated gateway

Everything in a temp dir **completely outside the repo**:

```bash
WORK_DIR=$(mktemp -d)
mkdir -p "$WORK_DIR/.bobbit/state"
echo "test" > "$WORK_DIR/.bobbit/state/setup-complete"

REPO="/path/to/bobbit"
FREE_PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

BOBBIT_DIR="$WORK_DIR/.bobbit" \
BOBBIT_NO_OPEN=1 \
BOBBIT_LLM_REVIEW_SKIP=1 \
BOBBIT_SKIP_NPM_CI=1 \
  node "$REPO/dist/server/cli.js" \
    --host 127.0.0.1 \
    --port "$FREE_PORT" \
    --no-tls \
    --auth \
    --cwd "$WORK_DIR" &
```

**Use the real agent, not the mock.** The mock bypasses the extension system — tool_call guards, MCP proxies, etc. never fire. If you're spending the cost of browser automation and agent reasoning, don't undermine it by skipping the component most likely to have the bug.

The mock agent is for repeatable unit-style E2E tests where you need determinism and speed. This debug cycle is for validating that the **real system works as a user would experience it**.

### 2. Wait for health, read the token

```bash
# Poll until healthy
TOKEN=$(cat "$WORK_DIR/.bobbit/state/token")
curl -s "http://127.0.0.1:$FREE_PORT/api/health" \
  -H "Authorization: Bearer $TOKEN"
```

Note: the token may regenerate if the server restarts. Always re-read from the state file.

### 3. Connect the browser

```bash
# Navigate with token in URL
http://127.0.0.1:$FREE_PORT/?token=$TOKEN
```

If the UI shows "Not connected" despite the token, set localStorage directly:
```js
localStorage.setItem('gateway.url', 'http://127.0.0.1:PORT');
localStorage.setItem('gateway.token', 'TOKEN');
location.reload();
```

### 4. Drive the test scenario

Use browser tools to interact as a real user:
- Create sessions via the role picker
- Send messages via the textarea
- Take screenshots at each step
- Use `browser_eval` to inspect DOM state, console logs, WebSocket messages
- Test persistence by navigating away and back

### 5. Verify production is unaffected

```bash
# Production gateway should still respond
curl -sk "$PROD_GATEWAY/api/health" -H "Authorization: Bearer $PROD_TOKEN"
```

### 6. Clean up

```bash
kill $GW_PID
rm -rf "$WORK_DIR"
```

## Isolation Rules

| Rule | Why |
|------|-----|
| `--cwd` points to temp dir, not repo | Prevents file watcher interference |
| `BOBBIT_DIR` points to temp's `.bobbit/` | Prevents state file corruption |
| Repo referenced read-only for `dist/` only | No writes to source tree |
| Separate port via `--port 0` or free port | No conflict with dev server |
| No `--agent-cli mock` | Real agent exercises the real code path |

## What This Caught That Tests Missed

The permission card bug had two components:

1. **Missing event handler**: `AgentInterface` didn't handle the `"render"` event emitted by `RemoteAgent` after adding the permission card to messages. Lit never re-rendered.

2. **No persistence for new clients**: `tool_permission_needed` was only broadcast at the moment the guard blocked. Reconnecting clients never saw it.

The existing E2E test (`tool-ask-policy.spec.ts`) uses the mock agent and calls the `tool-grant-request` REST endpoint directly — this bypasses the guard extension entirely and happened to work because of timing. The real flow (agent → guard → gateway → WS broadcast → UI render) was never tested.

## Toward a QA Agent Role

This protocol can be automated as a **qa-engineer** role in goal workflows:

1. Team lead spawns `qa-engineer` after implementation gate passes
2. QA agent builds the server from the goal branch
3. Spins up an isolated gateway in a temp dir
4. Drives the browser through test scenarios with screenshots
5. Produces an HTML report with pass/fail evidence
6. Signals the `qa-validation` gate with the report
7. Tears down the ephemeral environment

Prerequisites:
- `qa-engineer` role with browser tools and the protocol above in its prompt
- A skill for "ephemeral gateway lifecycle" (start, health-check, teardown)
- HTML report generation template
- A `qa-validation` workflow gate
