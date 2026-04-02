---
name: qa-test
description: Stand up an ephemeral test environment and drive browser-based QA testing scenarios
argument-hint: [scenario description]
---

# QA Testing Protocol

You are running QA testing for a goal. This protocol stands up an isolated copy of the application, drives a real browser through user scenarios, captures screenshot evidence, and produces an HTML validation report.

## Prerequisites

- You need browser tools available. **Use the native browser tools** — NOT the `mcp__playwright__*` tools. The MCP Playwright browser is a single shared instance across all sessions — other agents and the dev server will hijack your page. The native browser tools give you an isolated browser instance per session.
- **Available native browser tools:** `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_wait`, `browser_snapshot`, `browser_console_messages`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_resize`
- **`browser_snapshot`** is the best way to understand page structure — it returns an ARIA accessibility tree with element roles, names, and refs. Use it instead of screenshots when you need to find interactive elements or verify page content.
- **`browser_console_messages`** captures JS console output. Call with `level="error"` after each navigation to catch silent errors.
- The project must have `qa_*` keys in `.bobbit/config/project.yaml`

## Step 1: Read Configuration

Read the project config to get the QA testing settings:

```bash
cat .bobbit/config/project.yaml
```

Look for these keys:
- `qa_build_command` — how to build the project (falls back to `build_command`)
- `qa_start_command` — how to start an isolated server (REQUIRED — if missing, stop)
- `qa_health_check` — URL to poll for readiness
- `qa_browser_entry` — URL to open in the browser
- `qa_env` — JSON object of extra environment variables
- `qa_max_duration_minutes` — time budget (default: 10)
- `qa_max_scenarios` — scenario budget (default: 5)

If `qa_start_command` is not set, report "No QA testing configured for this project" and stop.

## Step 2: Create Isolated Environment

Create a temp directory COMPLETELY OUTSIDE the repo. The ephemeral server must NEVER share state with the repo or the production dev server.

```bash
WORK_DIR=$(mktemp -d)
mkdir -p "$WORK_DIR/.bobbit/state"
echo "test" > "$WORK_DIR/.bobbit/state/setup-complete"
```

Record the repo path:
```bash
REPO=$(pwd)
```

Record the current branch and commit for the report:
```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse --short HEAD)
```

## Step 3: Build the Project

Run the build command from the repo directory:
```bash
cd "$REPO" && eval "<qa_build_command value>"
```

If the build fails, produce a report documenting the build failure and skip to Step 9 (Cleanup).

## Step 4: Allocate Port and Start Server

Get a free port. **CRITICAL**: You must pick a port that won't conflict with the live dev server or other QA agents. Use a high random port to avoid collisions:
```bash
FREE_PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
```

**Verify the port is not the dev server port** — check `cat .bobbit/state/gateway-url` to see what port the dev server uses. If your allocated port matches, allocate again. Common dev server ports: 3001, 5173, 12835, 19871.

Start the server using `bash_bg` (NEVER use `bash` with `&`):
```bash
bash_bg(action="create", command="cd <repo_dir> && PORT=<free_port> WORK_DIR=<work_dir> BOBBIT_DIR=<work_dir>/.bobbit <qa_env vars> eval '<qa_start_command>'")
```

Record the background process ID for later cleanup.

## Step 5: Wait for Health Check

Substitute `$PORT` in the health check URL and poll until ready:
```bash
for i in $(seq 1 30); do
  if curl -sf "<health_check_url>" > /dev/null 2>&1; then
    echo "Server ready"
    break
  fi
  sleep 2
done
```

Read the auth token:
```bash
TOKEN=$(cat "$WORK_DIR/.bobbit/state/token")
```

If the server doesn't become healthy after 60 seconds, document the failure and skip to cleanup.

## Step 6: Drive Browser Scenarios

Substitute `$PORT` and `$TOKEN` in the browser entry URL. Navigate to it using `browser_navigate` (NOT `mcp__playwright__browser_navigate`).

**Available browser tools:**
- `browser_navigate(url=...)` — navigate to your ephemeral server
- `browser_screenshot(savePath="...")` — take screenshots (always use absolute paths in $WORK_DIR)
- `browser_snapshot()` — get ARIA accessibility tree (best for understanding page structure and finding elements)
- `browser_click(selector=...)` — click elements
- `browser_type(selector=..., text=...)` — type into inputs
- `browser_eval(expression=...)` — run JavaScript on page
- `browser_wait(selector=...)` — wait for elements
- `browser_press_key(key=...)` — press keyboard keys (Enter, Tab, Escape, etc.)
- `browser_hover(selector=...)` — hover over elements (tooltips, dropdowns)
- `browser_select_option(selector=..., value=...)` — select dropdown options
- `browser_resize(width=..., height=...)` — resize viewport for responsive testing
- `browser_console_messages(level=...)` — check for JS errors

**After each navigation**, verify you're on the right URL:
```
browser_eval(expression="window.location.href")
```
If the URL doesn't match your ephemeral server (check the port), re-navigate.

### Pacing rules

- **Breadth first.** Cover all scenarios from the goal spec at a surface level before going deep on any one. A report covering 5/5 features shallowly is more valuable than 1/5 deeply.
- **10 tool calls per scenario max.** If a scenario requires complex setup that isn't working after 10 calls, record it as "SKIPPED — could not test: [reason]" and move on.
- **Do NOT read source code.** You are a user, not a developer. Never `grep` or `cat` production `.ts` files. The only files you should read are config files needed for server setup.
- **Do NOT create test fixtures via API/curl.** If testing requires projects, goals, or entities, create them through the UI. If the UI can't do it, that's a finding, not a problem to solve with curl.
- **If it works, move on.** One screenshot proving a feature works is enough. Don't verify CSS classes, DOM structure, or internal state.

### Per-scenario flow

For each scenario from your task prompt (respecting `qa_max_scenarios`):

1. **Before**: Take a screenshot documenting the starting state
2. **Action**: Perform the user interaction (click, type, navigate, etc.)
3. **After**: Take a screenshot documenting the result
4. **Verdict**: Record PASS, FAIL, or SKIPPED with a clear explanation

Use `browser_screenshot(savePath="$WORK_DIR/screenshot-N.png")` to save screenshots — always use **absolute paths** in `$WORK_DIR`, never relative paths (relative paths resolve against the master repo root, not your worktree).

Track elapsed time. If `qa_max_duration_minutes` is exceeded, stop testing immediately and proceed to report generation with partial results.

## Step 7: Produce HTML Report

Write a self-contained HTML report. Screenshots should be embedded as base64 data URIs. Use the **absolute paths** from Step 6:
```bash
base64 -w0 "$WORK_DIR/screenshot-1.png"
```

On Windows/MSYS, use `base64 -w 0` (with space) or `cat "$WORK_DIR/screenshot-1.png" | base64 | tr -d '\n'`.

The report structure:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>QA Testing Report</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
    h1 { border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    .env-table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    .env-table td, .env-table th { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
    .scenario { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; margin: 1.5rem 0; }
    .pass { border-left: 4px solid #22c55e; }
    .fail { border-left: 4px solid #ef4444; }
    .skip { border-left: 4px solid #f59e0b; }
    .screenshot { max-width: 100%; border: 1px solid #ccc; border-radius: 4px; margin: 0.5rem 0; }
    .verdict { font-weight: bold; font-size: 1.1em; margin-top: 1rem; }
    .verdict.pass { color: #16a34a; }
    .verdict.fail { color: #dc2626; }
    .summary { background: #f1f5f9; padding: 1.5rem; border-radius: 8px; margin: 2rem 0; }
    .summary h2 { margin-top: 0; }
    .gap-list { background: #fffbeb; padding: 1rem; border-radius: 8px; border-left: 4px solid #f59e0b; }
  </style>
</head>
<body>
  <h1>QA Testing Report</h1>
  
  <h2>Environment</h2>
  <table class="env-table">
    <tr><th>Branch</th><td>[branch name]</td></tr>
    <tr><th>Commit</th><td>[commit hash]</td></tr>
    <tr><th>Server</th><td>http://127.0.0.1:[port] (ephemeral, killed after validation)</td></tr>
    <tr><th>Working Directory</th><td>[temp dir path]</td></tr>
  </table>

  <!-- For each scenario: -->
  <div class="scenario pass|fail|skip">
    <h3>Scenario N: [Title]</h3>
    <ol>
      <li>[Step description]
        <br><img class="screenshot" src="data:image/png;base64,[...]" alt="[description]">
      </li>
      <!-- more steps -->
    </ol>
    <p class="verdict pass|fail">Result: PASS|FAIL — [explanation]</p>
  </div>

  <div class="gap-list">
    <h2>Automated Test Coverage Gaps</h2>
    <ul>
      <li>[Identified gap with file/test references]</li>
    </ul>
  </div>

  <div class="summary">
    <h2>Summary</h2>
    <p><strong>Passed:</strong> N | <strong>Failed:</strong> N | <strong>Skipped:</strong> N</p>
    <p><strong>Budget used:</strong> Nm of Nm</p>
  </div>
</body>
</html>
```

Save the report to `$WORK_DIR/validation-report.html`.

## Step 8: Emit Results

Instead of signaling a gate directly, emit structured output tags that the verification harness will parse:

1. **Verdict tag** (REQUIRED): Based on your test results, emit exactly one of:
   - `<verdict>pass</verdict>` — if all critical scenarios passed
   - `<verdict>fail</verdict>` — if any critical scenario failed

2. **QA Report tag** (REQUIRED): Wrap your HTML report in a qa_report tag:
   ```
   <qa_report>
   <!DOCTYPE html>
   <html>
   ... your full HTML report with embedded base64 screenshots ...
   </html>
   </qa_report>
   ```

The verification harness will extract these tags from your output automatically.

The `agent-qa` verification harness handles gate signaling based on your verdict — do NOT call `gate_signal()` yourself.

## Step 9: Cleanup

**Always run cleanup**, even if earlier steps failed:

1. Kill the background server: `bash_bg(action="kill", id="<server-id>")`
2. Remove the temp directory: `rm -rf "$WORK_DIR"`
3. Verify production is unaffected (optional): `curl -sf` the production health endpoint

## Important Rules

- **NEVER** share state with the repo's `.bobbit/` directory
- **NEVER** use `bash` with `&` for the server — always use `bash_bg`
- **ALWAYS** clean up, even on failure
- **ALWAYS** embed screenshots as base64 in the report (self-contained)
- **RESPECT** the time and scenario budgets — partial results are better than no results
- If $ARGUMENTS were provided, use them as scenario descriptions to validate
