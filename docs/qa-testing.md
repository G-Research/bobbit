# QA Testing

Automated E2E tests exercise known paths through simulated components, but they can miss integration failures that only surface when a real user drives the full system. QA testing closes this gap: an agent stands up an ephemeral copy of the application, drives a real browser through user scenarios, captures screenshots as evidence, and produces an HTML report. It is integrated as an optional workflow gate so it fits naturally into the goal lifecycle without blocking projects that don't need it.

## How it fits in the architecture

The implementation gate in `feature` and `bug-fix` workflows includes an optional `agent-qa` verify step at phase 2. When enabled at goal creation (via the "Enable QA Testing" toggle), the verification harness automatically spawns a test-engineer session after phase 0 (commands) and phase 1 (LLM reviews) pass. The agent uses the `/qa-test` skill, calls the `verification_result` tool to deliver structured results (verdict, summary, and optional HTML report), and the harness records the report as a step artifact.

This mode is fully automated — the team lead does not need to spawn a test-engineer or signal a gate. See [goals-workflows-tasks.md — agent-qa step type](goals-workflows-tasks.md#agent-qa-step-type) for execution details and [goals-workflows-tasks.md — Optional verify steps](goals-workflows-tasks.md#optional-verify-steps) for the toggle mechanism.

```
design-doc → implementation → documentation → ready-to-merge
```

## Project configuration

QA settings live on a **component** — inside its opaque `config:` key→string map in `.bobbit/config/project.yaml`. Set them on the component that runs the QA testbed (typically the one matching the project name, or whichever the `agent-qa` workflow step's `component:` field points at). Only `qa_start_command` is required — the rest have sensible defaults or can be omitted.

**Why per-component (not project-level).** A multi-repo or monorepo project may have several runnable services and needs to be able to QA-test each independently. Hosting QA settings on a component lets the `agent-qa` workflow step's `component:` field select which testbed to spin up. Single-repo projects still have just one component, so there is no extra friction.

Keys recognised by the `/qa-test` skill (all values are strings — numeric budgets are stringified):

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `qa_start_command` | **Yes** | — | Command to start an isolated server. Receives `$PORT`, `$WORK_DIR`, and `$TOKEN`. **Inline any extra env vars directly into this string** (e.g. `PORT=$PORT NODE_ENV=test npm start`). |
| `qa_build_command` | No | Falls back to the component's `commands.build` | How to build the project before starting the ephemeral server |
| `qa_health_check` | No | `""` | URL to poll for server readiness. Use `$PORT` placeholder (e.g. `http://127.0.0.1:$PORT/api/health`) |
| `qa_browser_entry` | No | `""` | URL to open in the browser. Use `$PORT` and `$TOKEN` placeholders |
| `qa_max_duration_minutes` | No | `"10"` | Hard time budget in minutes — server is killed after this many minutes |
| `qa_max_scenarios` | No | `"5"` | Maximum number of scenarios to run before stopping |

There is **no** `qa_env` field. Inline env vars into `qa_start_command` itself (single-quoted, with `'\''` escapes for embedded quotes) — no server-side process ever spread `qa_env` into a child env; it was only ever inlined by agents at author time.

### Bobbit's own config

Bobbit ships with a working QA testbed under its single `bobbit` component:

```yaml
components:
  - name: bobbit
    repo: "."
    commands:
      build: npm run build
      # ...
    config:
      qa_start_command: "BOBBIT_NO_OPEN=1 BOBBIT_LLM_REVIEW_SKIP=1 BOBBIT_SKIP_NPM_CI=1 node dist/server/cli.js --host 127.0.0.1 --port $PORT --no-tls --auth --cwd $WORK_DIR"
      qa_health_check:         "http://127.0.0.1:$PORT/api/health"
      qa_browser_entry:        "http://127.0.0.1:$PORT/?token=$TOKEN"
      qa_max_duration_minutes: "10"
      qa_max_scenarios:        "5"
```

Key points for the start command:
- `WORK_DIR` and `BOBBIT_DIR=$WORK_DIR/.bobbit` are exported by the QA skill itself before invoking `qa_start_command` — isolating all state to the temp directory
- `--cwd $WORK_DIR` — prevents the ephemeral server from touching the repo
- `--no-tls` — avoids certificate complexity for local testing
- `--auth` — generates a token in the temp dir's state for browser authentication

### Generic project example

For a Node.js web app:

```yaml
components:
  - name: web
    repo: "."
    commands: { build: npm run build, test: npm test }
    config:
      qa_start_command:        "PORT=$PORT NODE_ENV=test node dist/server.js"
      qa_health_check:         "http://127.0.0.1:$PORT/healthz"
      qa_browser_entry:        "http://127.0.0.1:$PORT"
      qa_max_scenarios:        "3"
```

### REST endpoint

The "is QA configured anywhere?" toggle is available via:

```
GET /api/projects/:id/qa-testing-config
```

Returns `{ configured: boolean }` — `true` iff at least one component has a non-empty `config.qa_start_command`. Detailed per-key values are no longer surfaced through this endpoint; they live on the component and are read directly by the `/qa-test` skill from `project.yaml`.

## The `/qa-test` slash skill

The `/qa-test` skill (in `.claude/skills/qa-test/SKILL.md`) provides the full ephemeral environment protocol. Agents invoke it to run QA testing scenarios. The skill handles environment lifecycle; the agent handles browser interaction and report writing.

### Protocol overview

The protocol has 9 steps:

1. **Read config** — Locate the component whose `config.qa_start_command` is set (preferring the gate's `agent-qa` step `component:` field, then a name-match against the project, then the first component with `qa_start_command`). Read all `qa_*` keys from that component's `config:` map. Stop if no component has `config.qa_start_command`.

2. **Create isolated environment** — Create a temp directory completely outside the repo (`mktemp -d`). Initialize a minimal `.bobbit/state/` inside it, then seed it with realistic fixture data via `node "$REPO/scripts/qa-seed/seed.mjs" "$WORK_DIR"`. The seed populates the environment with a registered project, a goal with passed gates and verification history, archived sessions with tool call messages (including `verification_result`), tasks, and team state — so QA agents can immediately test dashboards, renderers, and verification UI without building state from scratch. See `scripts/qa-seed/README.md` for seed data details. This isolation is critical — the ephemeral server must never read or write the repo's `.bobbit/` or affect the production dev server.

3. **Build** — Run `qa_build_command` from the repo directory. If the build fails, produce a failure report and skip to cleanup.

4. **Allocate port and start server** — Find a free port, then start the server via `bash_bg` (never `bash` with `&` — that hangs agent sessions). The command receives `$PORT` and `$WORK_DIR`. Any other environment variables the project needs are already inlined by the project author into `qa_start_command` itself — there is no `qa_env` step.

5. **Wait for health check** — Poll `qa_health_check` (with `$PORT` substituted) every 2 seconds for up to 60 seconds. Read the auth token from the temp dir's state.

6. **Drive browser scenarios** — Navigate to `qa_browser_entry` (with `$PORT` and `$TOKEN` substituted). For each scenario from the task prompt, take before/after screenshots and record a PASS/FAIL verdict. Respect `qa_max_scenarios` and `qa_max_duration_minutes`.

7. **Produce HTML report** — Write an HTML report that references screenshots via `<img src="file:///<path>">` using the paths returned in `[screenshot_file]` blocks from `browser_screenshot(includeBase64: true)`. The server inlines those references to base64 data URIs when the report is submitted via `report_html_file` (see Screenshots in QA reports below).

8. **Submit results** — Call the `verification_result` tool with `verdict` ("pass" or "fail"), `summary` (concise findings), and `report_html` (self-contained HTML report). The verification harness receives results through this tool and handles gate signaling automatically.

9. **Cleanup** — Kill the background server via `bash_bg`, delete the temp directory. Always runs, even on failure.

## Report format

The validation report is a self-contained HTML file. Screenshots are embedded as base64 data URIs so the report works offline without external dependencies.

### Sections

- **Environment** — Branch, commit, server URL, temp directory path. Establishes what was tested.

- **Scenario sections** — One per scenario, each containing:
  - Numbered steps with descriptions
  - Before/after screenshots for each step
  - A PASS or FAIL verdict with explanation
  - Visual styling: green left border for pass, red for fail, amber for skipped

- **Automated test coverage gaps** — Identified gaps in existing E2E/unit test coverage. The purpose of QA testing is not to replace automated tests, but to discover where they should be added.

- **Summary** — Total scenarios passed/failed/skipped, budget consumed.

### Why self-contained HTML?

The report is the gate artifact — it's stored as gate content and must be readable without a running server. Base64-embedded screenshots ensure the evidence is preserved with the report, not lost when the temp directory is cleaned up.

## Screenshots in QA reports

QA reports embed screenshots as evidence. To keep the agent's own transcript small (base64 image payloads balloon cache-read token costs on every subsequent turn), screenshots taken with `includeBase64: true` are **spilled to disk** rather than returned inline as text. The server then inlines them to base64 data URIs only when the final report is submitted — so the report stays self-contained while the agent's turns stay cheap.

### How to take a screenshot for the report

Call `browser_screenshot` with `includeBase64: true`:

```
browser_screenshot({ includeBase64: true })
```

The tool returns two content blocks:

- An `image` block — the visual the agent's vision pipeline uses to reason about the page.
- A text block of the form `[screenshot_file]<absolute-path>[/screenshot_file]`. The file lives under `<session-cwd>/.bobbit-qa/screenshots/<uuid>.(png|jpg)`.

Reference the file in the HTML report via a `file://` URL:

```html
<img src="file:///absolute/path/to/.bobbit-qa/screenshots/abc123.png" alt="Step 1 before">
```

On Windows, use forward slashes in the path (e.g. `file:///C:/Users/.../abc123.png`).

### Server-side inlining

When the agent submits the report via `verification_result`'s `report_html_file` parameter, the server reads the file, finds every `<img src="file://...">` reference, and rewrites it to an inline `data:image/...;base64,...` URI. This makes the final report self-contained for viewing in the blob-URL report viewer and for long-term gate-artifact storage.

Constraints:

- Only `file://` srcs resolving under the session's cwd (including the `.bobbit-qa/` subtree) are inlined. Paths outside the session tree are left unchanged.
- Cumulative cap: **20 MB** of inlined image data per report. References beyond the cap are left as `file://` URLs.
- Missing files, non-image MIME types, and unresolvable paths are left as-is — they do not fail the submission.
- The `report_html` inline-string parameter is not rewritten; use `report_html_file` to get automatic inlining.

### Cleanup

The `.bobbit-qa/` directory is gitignored and scoped per session. It is deleted when the session shuts down. Do not commit spilled screenshots.

### Reducing screenshot cost further

- The default browser viewport is 960×540 (lowered from 1280×720) to shrink encoded size. Use `browser_resize` if a scenario needs a larger or mobile viewport.
- `browser_screenshot` accepts optional `format: "png" | "jpeg"` (default `png`) and `quality` (for JPEG, e.g. 75). JPEG at quality 75 is roughly 5× smaller than PNG and is usually fine for QA evidence:

  ```
  browser_screenshot({ includeBase64: true, format: "jpeg", quality: 75 })
  ```

### Why not paste base64 directly into the report?

Earlier versions of the tool returned the full `data:image/png;base64,...` URI as a text block so the agent could copy-paste it into the report. That payload then stayed in the agent transcript and was re-cached on every subsequent turn, costing tens of thousands of tokens per screenshot. The file-spill + server-inline flow replaces that path — agents should never embed base64 image data as literal text in their HTML or in their chat output.

## Browser automation

QA agents drive browsers **only** through the native `browser_*` tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_eval`, `browser_wait`, `browser_snapshot`, etc.). These are always headless and per-session isolated.

### What's blocked

The `mcp__playwright__*` tool group (from `@playwright/mcp`) is **denied by default for every role** via `defaults/tool-group-policies.yaml` (`mcp__playwright: never`). The `qa-tester` role additionally sets the same policy in its own `toolPolicies` as a belt-and-braces block. Attempting to call `mcp__playwright__browser_navigate` (or any sibling) returns a policy-denied error without launching the MCP server.

### Why

- `@playwright/mcp` defaults to **headed** Chromium — it pops a visible window on the host, steals focus, and resizes tiled windows. This is disruptive on developer desktops and causes flakiness when the OS minimises or resizes the window mid-interaction.
- Even with `--headless` set, the MCP Playwright browser is a single shared instance across all sessions; concurrent agents hijack each other's pages.
- The native `browser_*` extension launches Chromium with `headless: true` plus explicit hardening args: `--headless=new`, `--disable-gpu`, and (on Windows/macOS, or Linux when not running as root) `--no-sandbox`. Each session gets its own browser context.
- `.claude/.mcp.json` passes `--headless --isolated` to `@playwright/mcp` so that even if a role overrides the policy, the MCP-launched browser stays invisible and per-session.

### Overriding (if you actually want MCP Playwright)

If a project legitimately needs `mcp__playwright__*` (e.g. driving a real headed browser for manual inspection), allow it at the project layer:

1. Create `.bobbit/config/tool-group-policies.yaml` with:
   ```yaml
   mcp__playwright: allow
   ```
2. Optionally override `.mcp.json` in the project to drop `--headless` (e.g. `.bobbit/config/mcp.json` or `.claude/.mcp.json` — see [internals.md — MCP servers](internals.md#mcp-servers) for precedence).

Per-role overrides in a role YAML's `toolPolicies` also work for scoping the allowance to a single role.

## Budget enforcement

Two budgets prevent runaway validation:

- **Time budget** (`qa_max_duration_minutes`, default 10) — If elapsed time exceeds the budget during scenario execution, the agent stops testing immediately and produces a report with partial results. The server is killed and cleaned up.

- **Scenario budget** (`qa_max_scenarios`, default 5) — Caps the number of scenarios executed in a single validation run.

Partial results are valid — the report documents what was tested and what was skipped due to budget exhaustion.

## Isolation rules

The ephemeral environment is fully isolated from the repo and the production dev server:

| Concern | How it's isolated |
|---------|-------------------|
| State directory | Temp dir gets its own `.bobbit/` — never shares with the repo's `.bobbit/` |
| Port | Dynamically allocated free port — no conflict with the dev server |
| Working directory | `--cwd` or equivalent points to the temp dir |
| Cleanup | Temp dir and server process are destroyed after validation, even on failure |
| Read-only repo | The build step reads from the repo; the ephemeral server writes only to the temp dir |

The production dev server is completely unaffected throughout the validation process.

## Troubleshooting

- **"No QA testing configured"** — No component in the project's `project.yaml` has `config.qa_start_command` set. Add `qa_*` keys to the relevant component's `config:` map as described above.
- **Health check never passes** — Verify `qa_health_check` URL uses `$PORT` placeholder. Check `bash_bg` logs for server startup errors.
- **Screenshots missing from report** — The agent drives the browser via the native `browser_*` tools, not `mcp__playwright__*`. Check that the session's role allows the `browser` tool group (the `qa-tester` role does by default) and that the agent called `browser_screenshot({ includeBase64: true })`. Spilled files live under `<session-cwd>/.bobbit-qa/screenshots/` and must be referenced in the report as `<img src="file:///<absolute-path>">` so the server can inline them on submit via `report_html_file`.
- **QA step skipped unexpectedly** — Check that the goal has QA testing enabled (`enabledOptionalSteps` includes `agent-qa`). Check `gate_status` for the implementation gate verification results.
- **Temp directory not cleaned up** — If the agent crashes mid-protocol, the temp dir may remain. These are in the system temp directory (`$TMPDIR`) and can be manually cleaned.

## Related docs

- [Goals, workflows, and tasks](goals-workflows-tasks.md) — Gate lifecycle and dependency model
- [Internals](internals.md) — Project config resolution, per-project state
- [Debugging](debugging.md) — General debugging checklists
