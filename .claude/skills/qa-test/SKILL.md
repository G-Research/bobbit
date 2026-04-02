---
name: qa-test
description: Stand up an ephemeral test environment and drive browser-based QA testing scenarios
argument-hint: [scenario description]
---

# QA Testing Protocol

You are running QA testing for a goal. This protocol stands up an isolated copy of the application, drives a real browser through user scenarios, captures screenshot evidence, and produces an HTML validation report.

## Prerequisites

- You need browser tools (Playwright MCP) available
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

Get a free port:
```bash
FREE_PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
```

Start the server using `bash_bg` (NEVER use `bash` with `&`):
```bash
bash_bg(action="create", command="PORT=<free_port> WORK_DIR=<work_dir> BOBBIT_DIR=<work_dir>/.bobbit <qa_env vars> eval '<qa_start_command>'")
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

Substitute `$PORT` and `$TOKEN` in the browser entry URL. Navigate to it.

For each scenario from your task prompt (respecting `qa_max_scenarios`):

1. **Before**: Take a screenshot documenting the starting state
2. **Action**: Perform the user interaction (click, type, navigate, etc.)
3. **After**: Take a screenshot documenting the result
4. **Verdict**: Record PASS or FAIL with a clear explanation

Use `browser_screenshot(savePath="<work_dir>/screenshot-N.png")` to save screenshots.

Track elapsed time. If `qa_max_duration_minutes` is exceeded, stop testing immediately and proceed to report generation with partial results.

## Step 7: Produce HTML Report

Write a self-contained HTML report. Screenshots should be embedded as base64 data URIs:
```bash
base64 -w0 "$WORK_DIR/screenshot-1.png"
```

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

## Step 8: Signal Gate

Convert key sections of the HTML report to markdown and signal the gate:

```
gate_signal(
  gate_id="qa-testing",
  content="<markdown version of the report>",
  metadata={
    "scenarios_passed": "<count>",
    "scenarios_failed": "<count>",
    "budget_used": "<minutes>m of <max>m"
  }
)
```

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
