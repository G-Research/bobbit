# QA Testing

Automated E2E tests exercise known paths through simulated components, but they can miss integration failures that only surface when a real user drives the full system. QA testing closes this gap: an agent stands up an ephemeral copy of the application, drives a real browser through user scenarios, captures screenshots as evidence, and produces an HTML report. It is integrated as an optional workflow gate so it fits naturally into the goal lifecycle without blocking projects that don't need it.

## How it fits in the architecture

The implementation gate in `feature` and `bug-fix` workflows includes an optional `agent-qa` verify step at phase 2. When enabled at goal creation (via the "Enable QA Testing" toggle), the verification harness automatically spawns a test-engineer session after phase 0 (commands) and phase 1 (LLM reviews) pass. The agent uses the `/qa-test` skill, calls the `verification_result` tool to deliver structured results (verdict, summary, and optional HTML report), and the harness records the report as a step artifact.

This mode is fully automated — the team lead does not need to spawn a test-engineer or signal a gate. See [goals-workflows-tasks.md — agent-qa step type](goals-workflows-tasks.md#agent-qa-step-type) for execution details and [goals-workflows-tasks.md — Optional verify steps](goals-workflows-tasks.md#optional-verify-steps) for the toggle mechanism.

```
design-doc → implementation → documentation → ready-to-merge
```

## Project configuration

Add `qa_*` keys to `.bobbit/config/project.yaml`. Only `qa_start_command` is required — the rest have sensible defaults or can be omitted.

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `qa_build_command` | No | Falls back to `build_command`, then `npm run build` | How to build the project before starting the ephemeral server |
| `qa_start_command` | **Yes** | — | Command to start an isolated server. Receives `$PORT`, `$WORK_DIR`, and `$TOKEN` as environment variables |
| `qa_health_check` | No | `""` | URL to poll for server readiness. Use `$PORT` placeholder (e.g. `http://127.0.0.1:$PORT/api/health`) |
| `qa_browser_entry` | No | `""` | URL to open in the browser. Use `$PORT` and `$TOKEN` placeholders |
| `qa_env` | No | `{}` | JSON object of extra environment variables for the server process |
| `qa_max_duration_minutes` | No | `10` | Hard time budget — server is killed after this many minutes |
| `qa_max_scenarios` | No | `5` | Maximum number of scenarios to run before stopping |

### Bobbit's own config

Bobbit ships with a working config in its `project.yaml`:

```yaml
qa_build_command: npm run build
qa_start_command: >-
  PORT=$PORT WORK_DIR=$WORK_DIR BOBBIT_DIR=$WORK_DIR/.bobbit
  BOBBIT_NO_OPEN=1 BOBBIT_LLM_REVIEW_SKIP=1 BOBBIT_SKIP_NPM_CI=1
  node dist/server/cli.js
  --host 127.0.0.1 --port $PORT --no-tls --auth --cwd $WORK_DIR
qa_health_check: http://127.0.0.1:$PORT/api/health
qa_browser_entry: http://127.0.0.1:$PORT/?token=$TOKEN
qa_env: '{"BOBBIT_NO_OPEN":"1","BOBBIT_LLM_REVIEW_SKIP":"1","BOBBIT_SKIP_NPM_CI":"1"}'
qa_max_duration_minutes: "10"
qa_max_scenarios: "5"
```

Key points for the start command:
- `BOBBIT_DIR=$WORK_DIR/.bobbit` — isolates all state to the temp directory
- `--cwd $WORK_DIR` — prevents the ephemeral server from touching the repo
- `--no-tls` — avoids certificate complexity for local testing
- `--auth` — generates a token in the temp dir's state for browser authentication

### Generic project example

For a Node.js web app:

```yaml
qa_start_command: "PORT=$PORT node dist/server.js"
qa_health_check: "http://127.0.0.1:$PORT/healthz"
qa_browser_entry: "http://127.0.0.1:$PORT"
qa_max_scenarios: "3"
```

### REST endpoint

The parsed config is available via:

```
GET /api/projects/:id/qa-testing-config
```

Returns `{ config: QaTestingConfig | null }`. Returns `null` when `qa_start_command` is not set. The `QaTestingConfig` object has camelCase field names: `buildCommand`, `startCommand`, `healthCheck`, `browserEntry`, `env`, `maxDurationMinutes`, `maxScenarios`.

## The `/qa-test` slash skill

The `/qa-test` skill (in `.claude/skills/qa-test/SKILL.md`) provides the full ephemeral environment protocol. Agents invoke it to run QA testing scenarios. The skill handles environment lifecycle; the agent handles browser interaction and report writing.

### Protocol overview

The protocol has 9 steps:

1. **Read config** — Load `qa_*` keys from `project.yaml`. Stop if `qa_start_command` is missing.

2. **Create isolated environment** — Create a temp directory completely outside the repo (`mktemp -d`). Initialize a minimal `.bobbit/state/` inside it, then seed it with realistic fixture data via `node "$REPO/scripts/qa-seed/seed.mjs" "$WORK_DIR"`. The seed populates the environment with a registered project, a goal with passed gates and verification history, archived sessions with tool call messages (including `verification_result`), tasks, and team state — so QA agents can immediately test dashboards, renderers, and verification UI without building state from scratch. See `scripts/qa-seed/README.md` for seed data details. This isolation is critical — the ephemeral server must never read or write the repo's `.bobbit/` or affect the production dev server.

3. **Build** — Run `qa_build_command` from the repo directory. If the build fails, produce a failure report and skip to cleanup.

4. **Allocate port and start server** — Find a free port, then start the server via `bash_bg` (never `bash` with `&` — that hangs agent sessions). The command receives `$PORT`, `$WORK_DIR`, and any `qa_env` variables.

5. **Wait for health check** — Poll `qa_health_check` (with `$PORT` substituted) every 2 seconds for up to 60 seconds. Read the auth token from the temp dir's state.

6. **Drive browser scenarios** — Navigate to `qa_browser_entry` (with `$PORT` and `$TOKEN` substituted). For each scenario from the task prompt, take before/after screenshots and record a PASS/FAIL verdict. Respect `qa_max_scenarios` and `qa_max_duration_minutes`.

7. **Produce HTML report** — Write a self-contained HTML report with base64-embedded screenshots (see Report Format below).

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

- **"No QA testing configured"** — The project's `project.yaml` is missing `qa_start_command`. Add `qa_*` keys as described above.
- **Health check never passes** — Verify `qa_health_check` URL uses `$PORT` placeholder. Check `bash_bg` logs for server startup errors.
- **Screenshots missing from report** — The agent needs Playwright MCP tools available. Check that the browser tools are in the session's tool set.
- **QA step skipped unexpectedly** — Check that the goal has QA testing enabled (`enabledOptionalSteps` includes `agent-qa`). Check `gate_status` for the implementation gate verification results.
- **Temp directory not cleaned up** — If the agent crashes mid-protocol, the temp dir may remain. These are in the system temp directory (`$TMPDIR`) and can be manually cleaned.

## Related docs

- [Goals, workflows, and tasks](goals-workflows-tasks.md) — Gate lifecycle and dependency model
- [Internals](internals.md) — Project config resolution, per-project state
- [Debugging](debugging.md) — General debugging checklists
