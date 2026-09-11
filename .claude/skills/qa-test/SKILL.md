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
- At least one component in `.bobbit/config/project.yaml` must carry `config.qa_start_command`

## Step 1: Read Configuration

Read the project config to discover the component(s) with QA testbed configuration:

```bash
cat .bobbit/config/project.yaml
```

Each component in `components[]` may carry an opaque `config:` map. The component you want is the one whose `config.qa_start_command` is set. Pick it as follows:

1. **Look for a `[QA-TEST CONTEXT]\ncomponent: <name>` block near the top of your kickoff message.** When the verification harness invokes you for an `agent-qa` step that declares a `component:` field, it prepends this context block to your prompt. If present, prefer that component.
2. Else, if multiple components have `config.qa_start_command`, use the component whose `name` matches the project name.
3. Else use the first component with `config.qa_start_command`.

From that component's `config:` map, read these keys:
- `qa_start_command` — **REQUIRED**. Start command. Env vars are already inlined by the project author (e.g. `PORT=$PORT NODE_ENV=test npm start`). There is no separate `qa_env` field.
- `qa_build_command` — optional; falls back to the component's `commands.build`.
- `qa_health_check` — URL to poll for readiness.
- `qa_browser_entry` — URL to open in the browser.
- `qa_max_duration_minutes` — time budget (default: 10).
- `qa_max_scenarios` — scenario budget (default: 5).

If no component has `config.qa_start_command`, report "No QA testing configured for this project" and stop.

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
bash_bg(action="create", command="cd <repo_dir> && PORT=<free_port> WORK_DIR=<work_dir> BOBBIT_DIR=<work_dir>/.bobbit eval '<qa_start_command>'")
```

Any other environment variables the project needs (e.g. `NODE_ENV`, `BOBBIT_NO_OPEN`) are already inlined by the project author into `qa_start_command` itself. Do NOT add a `qa_env` substitution — that field has been removed.

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
- `browser_screenshot(includeBase64=true, ...)` — capture evidence and receive a verifier-workspace `[screenshot_file]` path (always set `includeBase64` for report evidence)
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

Call `browser_screenshot` with `includeBase64=true`. The browser tool spills the image under the verifier workspace and returns a short `[screenshot_file]<absolute-path>[/screenshot_file]` marker instead of a copyable base64 text block.

```
browser_screenshot(includeBase64=true, format="jpeg", quality=75)
```

Keep every returned path. Use PNG when lossless detail matters; prefer JPEG or a smaller viewport when it keeps the final report comfortably below the upload limit. Do not move screenshots outside the verifier workspace or replace them with symlinks.

### Per-scenario flow

For each scenario from your task prompt (respecting `qa_max_scenarios`):

1. **Before**: Capture a screenshot with `includeBase64=true` and record its `[screenshot_file]` path
2. **Action**: Perform the user interaction (click, type, navigate, etc.)
3. **After**: Capture another screenshot and record its path
4. **Verdict**: Record PASS, FAIL, or SKIPPED with a clear explanation

Track elapsed time. If `qa_max_duration_minutes` is exceeded, stop testing immediately and proceed to report generation with partial results.

## Step 7: Produce HTML Report

Write `$WORK_DIR/validation-report.html` as a regular file, not a symlink, directory, device, or pipe. Reference each returned screenshot path with a `file://` URL; on Windows, use forward slashes:

```html
<img class="screenshot" src="file:///absolute/path/to/.bobbit-qa/screenshots/example.jpg" alt="Scenario 1 after">
```

Do **not** read, print, or manually embed base64 screenshot data. On submission, the `verification_result` extension runs inside this verifier process. It reads the report with a bounded descriptor, inlines eligible workspace images, and uploads only the resulting HTML bytes. The gateway never receives or dereferences the file path.

The generated report should contain:

- Inline CSS and no external dependencies
- Environment details: branch, commit, server URL, and temp directory
- One scenario section with numbered steps, before/after evidence, and PASS/FAIL/SKIPPED rationale
- Automated test coverage gaps
- Pass/fail/skip totals and budget consumed

Keep the source report at or below **10 MiB**. The extension rejects an oversized or non-regular report before upload, including a report path that is itself a symlink. Screenshot inlining is limited to 20 MiB of source image bytes, and each rewrite must also keep the final UTF-8 HTML at or below 10 MiB. Ineligible, escaped, changed, or over-budget image references remain unchanged, so keep the report compact enough for every required screenshot to be inlined before cleanup.

## Step 8: Submit Results

Call the `verification_result` tool to deliver your findings:

1. **verdict** (REQUIRED): Based on your test results:
   - `"pass"` — if all critical scenarios passed
   - `"fail"` — if any critical scenario failed

2. **summary** (REQUIRED): Concise summary of what you tested and what you found.

3. **report_html_file** (REQUIRED): Absolute path to the regular HTML report file (for example, `$WORK_DIR/validation-report.html`). The verifier-side extension reads, bounds, and transforms it into `report_html`; the gateway accepts only those uploaded bytes. Do NOT use `report_html` for this QA flow and do not POST the endpoint directly.

Call the tool from the verifier session that performed the QA. It automatically sends that process's `X-Bobbit-Session-Secret`; an admin token, browser login, public session ID, missing secret, or another session's secret cannot submit this verifier's result. This tool call is how the verification system receives your results. Without it, your testing work is lost.

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
- **ALWAYS** capture report screenshots with `includeBase64=true` and reference the returned `[screenshot_file]` path from the HTML
- **NEVER** read or paste base64 image data — verifier-side inlining makes the uploaded gate artifact self-contained
- **RESPECT** the time and scenario budgets — partial results are better than no results
- If $ARGUMENTS were provided, use them as scenario descriptions to validate
