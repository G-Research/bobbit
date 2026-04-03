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

Seed with realistic test data (project, sessions, goals, gates, tasks, team, messages):
```bash
node "$REPO/scripts/qa-seed/seed.mjs" "$WORK_DIR"
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
- `browser_screenshot(savePath=...)` — take screenshots and save to disk (ALWAYS use `savePath` — see below)
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

### Screenshot capture — CRITICAL

**You CANNOT extract base64 data from `browser_screenshot()` tool responses.** The tool returns images as visual content blocks — you see the picture but cannot copy the underlying binary data. Therefore:

**ALWAYS save screenshots to disk** using the `savePath` parameter:
```
browser_screenshot(savePath="$WORK_DIR/screenshots/scenario1-before.png")
```

Create the screenshots directory at the start of testing:
```bash
mkdir -p "$WORK_DIR/screenshots"
```

Use descriptive filenames: `scenario1-before.png`, `scenario1-after.png`, `scenario2-browse.png`, etc.

### Per-scenario flow

For each scenario from your task prompt (respecting `qa_max_scenarios`):

1. **Before**: Take a screenshot with `savePath` documenting the starting state
2. **Action**: Perform the user interaction (click, type, navigate, etc.)
3. **After**: Take a screenshot with `savePath` documenting the result
4. **Verdict**: Record PASS, FAIL, or SKIPPED with a clear explanation

Track elapsed time. If `qa_max_duration_minutes` is exceeded, stop testing immediately and proceed to report generation with partial results.

## Step 7: Produce HTML Report

### Embedding screenshots

After all scenarios are complete, convert saved screenshots to base64 and build the report. Use this bash script to generate base64 data URIs from saved PNG files:

```bash
# Convert a screenshot to a base64 data URI (works on both Linux and macOS/Windows with Node)
node -e "const fs=require('fs'); const b=fs.readFileSync('$WORK_DIR/screenshots/scenario1-before.png'); console.log('data:image/png;base64,'+b.toString('base64'))"
```

For each screenshot file, run this command and embed the output as the `src` attribute of an `<img>` tag. The output will be a single long string starting with `data:image/png;base64,...`.

**IMPORTANT**: The base64 output is very long (100KB+). Do NOT try to manually type or copy it. Instead, build the HTML report using a script that reads screenshots and generates the HTML:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = '$WORK_DIR/screenshots';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
const imgs = {};
for (const f of files) {
  const data = fs.readFileSync(path.join(dir, f));
  imgs[f] = 'data:image/png;base64,' + data.toString('base64');
}
fs.writeFileSync('$WORK_DIR/screenshot-data.json', JSON.stringify(imgs));
console.log('Processed', Object.keys(imgs).length, 'screenshots');
"
```

Then use the generated `screenshot-data.json` to build your HTML report. Read the JSON, and for each scenario, reference the correct screenshot filename to get its data URI.

A complete approach — write a Node script that generates the final HTML:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const dir = '$WORK_DIR/screenshots';

// Build base64 map
const imgs = {};
if (fs.existsSync(dir)) {
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.png'))) {
    imgs[f] = 'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');
  }
}

// Read the scenario data you'll write earlier
// (write a scenarios.json with your test results before this step)
const scenarios = JSON.parse(fs.readFileSync('$WORK_DIR/scenarios.json', 'utf8'));

// Build HTML...
let html = '<!DOCTYPE html>...'; // construct your report HTML here using imgs[filename] for src attributes
fs.writeFileSync('$WORK_DIR/validation-report.html', html);
"
```

**Recommended workflow:**
1. During testing, save all screenshots to `$WORK_DIR/screenshots/` with descriptive names
2. After all scenarios, write a `$WORK_DIR/scenarios.json` with your test results (verdict, steps, screenshot filenames per scenario)
3. Write a Node script that reads both the screenshots and scenario data, generates the complete HTML report with embedded base64 images, and saves it to `$WORK_DIR/validation-report.html`

This ensures screenshots are properly embedded without you needing to handle base64 strings directly.

The generated report should follow this structure (your Node script produces this):

- HTML with inline CSS (self-contained, no external dependencies)
- Environment table (branch, commit, server, working dir)
- One `<div class="scenario pass|fail|skip">` per scenario containing:
  - Steps as an ordered list with `<img class="screenshot" src="data:image/png;base64,...">` tags
  - A verdict paragraph with PASS/FAIL/SKIPPED and explanation
- Automated test coverage gaps section
- Summary with pass/fail/skip counts

Save the report to `$WORK_DIR/validation-report.html`.

## Step 8: Submit Results

Call the `verification_result` tool to deliver your findings:

1. **verdict** (REQUIRED): Based on your test results:
   - `"pass"` — if all critical scenarios passed
   - `"fail"` — if any critical scenario failed

2. **summary** (REQUIRED): Concise summary of what you tested and what you found.

3. **report_html_file** (REQUIRED): Absolute path to your HTML report file (e.g. `$WORK_DIR/validation-report.html`). The server reads it directly — this handles large reports with embedded base64 screenshots without hitting tool output limits. Do NOT use `report_html` (inline string) — always use `report_html_file`.

This tool call is how the verification system receives your results. Without it, your testing work is lost.

Do NOT emit `<verdict>` or `<qa_report>` XML tags — use the `verification_result` tool exclusively.

## Step 9: Cleanup

**Always run cleanup**, even if earlier steps failed:

1. Kill the background server: `bash_bg(action="kill", id="<server-id>")`
2. Remove the temp directory: `rm -rf "$WORK_DIR"`
3. Verify production is unaffected (optional): `curl -sf` the production health endpoint

## Important Rules

- **NEVER** share state with the repo's `.bobbit/` directory
- **NEVER** use `bash` with `&` for the server — always use `bash_bg`
- **NEVER** run unit tests, integration tests, or `npm test`. You are a QA tester driving a real browser, not a developer. If you cannot get the ephemeral server running, submit a FAIL verdict explaining the infrastructure issue and stop. Do not fall back to running the project's test suite.
- **NEVER** read source code (`.ts`, `.js`, `.tsx`, `.jsx` files). You are testing the product as a user. The only files you may read are config files needed for server setup.
- **ALWAYS** clean up, even on failure
- **ALWAYS** save screenshots to disk with `savePath` and embed as base64 in the report via Node script (self-contained)
- **NEVER** try to manually type base64 data — always use a script to read PNG files and generate the HTML
- **RESPECT** the time and scenario budgets — partial results are better than no results
- If $ARGUMENTS were provided, use them as scenario descriptions to validate
