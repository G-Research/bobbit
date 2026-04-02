# Exploratory Validation

Automated E2E tests exercise known paths through simulated components, but they can miss integration failures that only surface when a real user drives the full system. Exploratory validation closes this gap: an agent stands up an ephemeral copy of the application, drives a real browser through user scenarios, captures screenshots as evidence, and produces an HTML report. It is integrated as an optional workflow gate so it fits naturally into the goal lifecycle without blocking projects that don't need it.

## How it fits in the architecture

Exploratory validation sits between the **implementation** gate and the **documentation** gate in both the `feature` and `bug-fix` workflows. After code passes type checks, automated tests, and code review, the team lead decides whether visual/integration validation is needed. If so, a test-engineer agent invokes the `/validate` slash skill, which handles the ephemeral environment lifecycle. The agent handles the actual browser interaction and report authoring.

```
design-doc → implementation → exploratory-validation (optional) → documentation → ready-to-merge
```

The gate is **optional** — projects without `ev_*` config or goals without UI changes simply skip it via an "N/A" signal. The workflow continues to the documentation gate either way.

## Project configuration

Add `ev_*` keys to `.bobbit/config/project.yaml`. Only `ev_start_command` is required — the rest have sensible defaults or can be omitted.

| Key | Required | Default | Description |
|-----|----------|---------|-------------|
| `ev_build_command` | No | Falls back to `build_command`, then `npm run build` | How to build the project before starting the ephemeral server |
| `ev_start_command` | **Yes** | — | Command to start an isolated server. Receives `$PORT`, `$WORK_DIR`, and `$TOKEN` as environment variables |
| `ev_health_check` | No | `""` | URL to poll for server readiness. Use `$PORT` placeholder (e.g. `http://127.0.0.1:$PORT/api/health`) |
| `ev_browser_entry` | No | `""` | URL to open in the browser. Use `$PORT` and `$TOKEN` placeholders |
| `ev_env` | No | `{}` | JSON object of extra environment variables for the server process |
| `ev_max_duration_minutes` | No | `10` | Hard time budget — server is killed after this many minutes |
| `ev_max_scenarios` | No | `5` | Maximum number of scenarios to run before stopping |

### Bobbit's own config

Bobbit ships with a working config in its `project.yaml`:

```yaml
ev_build_command: npm run build
ev_start_command: >-
  PORT=$PORT WORK_DIR=$WORK_DIR BOBBIT_DIR=$WORK_DIR/.bobbit
  BOBBIT_NO_OPEN=1 BOBBIT_LLM_REVIEW_SKIP=1 BOBBIT_SKIP_NPM_CI=1
  node dist/server/cli.js
  --host 127.0.0.1 --port $PORT --no-tls --auth --cwd $WORK_DIR
ev_health_check: http://127.0.0.1:$PORT/api/health
ev_browser_entry: http://127.0.0.1:$PORT/?token=$TOKEN
ev_env: '{"BOBBIT_NO_OPEN":"1","BOBBIT_LLM_REVIEW_SKIP":"1","BOBBIT_SKIP_NPM_CI":"1"}'
ev_max_duration_minutes: "10"
ev_max_scenarios: "5"
```

Key points for the start command:
- `BOBBIT_DIR=$WORK_DIR/.bobbit` — isolates all state to the temp directory
- `--cwd $WORK_DIR` — prevents the ephemeral server from touching the repo
- `--no-tls` — avoids certificate complexity for local testing
- `--auth` — generates a token in the temp dir's state for browser authentication

### Generic project example

For a Node.js web app:

```yaml
ev_start_command: "PORT=$PORT node dist/server.js"
ev_health_check: "http://127.0.0.1:$PORT/healthz"
ev_browser_entry: "http://127.0.0.1:$PORT"
ev_max_scenarios: "3"
```

### REST endpoint

The parsed config is available via:

```
GET /api/projects/:id/exploratory-validation-config
```

Returns `{ config: ExploratoryValidationConfig | null }`. Returns `null` when `ev_start_command` is not set. The `ExploratoryValidationConfig` object has camelCase field names: `buildCommand`, `startCommand`, `healthCheck`, `browserEntry`, `env`, `maxDurationMinutes`, `maxScenarios`.

## The `/validate` slash skill

The `/validate` skill (in `.claude/skills/validate/SKILL.md`) provides the full ephemeral environment protocol. Agents invoke it to run exploratory validation scenarios. The skill handles environment lifecycle; the agent handles browser interaction and report writing.

### Protocol overview

The protocol has 9 steps:

1. **Read config** — Load `ev_*` keys from `project.yaml`. Stop if `ev_start_command` is missing.

2. **Create isolated environment** — Create a temp directory completely outside the repo (`mktemp -d`). Initialize a minimal `.bobbit/state/` inside it. This isolation is critical — the ephemeral server must never read or write the repo's `.bobbit/` or affect the production dev server.

3. **Build** — Run `ev_build_command` from the repo directory. If the build fails, produce a failure report and skip to cleanup.

4. **Allocate port and start server** — Find a free port, then start the server via `bash_bg` (never `bash` with `&` — that hangs agent sessions). The command receives `$PORT`, `$WORK_DIR`, and any `ev_env` variables.

5. **Wait for health check** — Poll `ev_health_check` (with `$PORT` substituted) every 2 seconds for up to 60 seconds. Read the auth token from the temp dir's state.

6. **Drive browser scenarios** — Navigate to `ev_browser_entry` (with `$PORT` and `$TOKEN` substituted). For each scenario from the task prompt, take before/after screenshots and record a PASS/FAIL verdict. Respect `ev_max_scenarios` and `ev_max_duration_minutes`.

7. **Produce HTML report** — Write a self-contained HTML report with base64-embedded screenshots (see Report Format below).

8. **Signal gate** — Convert the report to markdown and signal the `exploratory-validation` gate with content and metadata (`scenarios_passed`, `scenarios_failed`, `budget_used`).

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

- **Automated test coverage gaps** — Identified gaps in existing E2E/unit test coverage. The purpose of exploratory validation is not to replace automated tests, but to discover where they should be added.

- **Summary** — Total scenarios passed/failed/skipped, budget consumed.

### Why self-contained HTML?

The report is the gate artifact — it's stored as gate content and must be readable without a running server. Base64-embedded screenshots ensure the evidence is preserved with the report, not lost when the temp directory is cleaned up.

## Workflow gate

### Gate definition

The `exploratory-validation` gate appears in both `feature.yaml` and `bug-fix.yaml`:

```yaml
- id: exploratory-validation
  name: Exploratory Validation
  depends_on: [implementation]
  content: true
  optional: true
  metadata:
    scenarios_passed: string
    scenarios_failed: string
    budget_used: string
  verify:
    - name: "Report has evidence"
      type: llm-review
      prompt: |
        Review this exploratory validation report...
```

Key properties:
- **`optional: true`** — The gate can be signaled with "N/A" content and still pass. Downstream gates (documentation) don't block if this gate hasn't been signaled.
- **`content: true`** — The gate carries the validation report as content.
- **`metadata`** — Structured data about results (`scenarios_passed`, `scenarios_failed`, `budget_used`).

### LLM review verification

The gate's verifier checks:
1. Every scenario has screenshot evidence
2. Failures are explained with actionable detail
3. Automated test coverage gaps were identified
4. "N/A" or "Skipped" content is accepted as valid

### How the team lead uses it

The team-lead role prompt includes instructions for the exploratory validation gate:

1. **Decide if needed** — If the goal has no UI changes or is purely infrastructure, signal the gate with "N/A" content and zeroed metadata. The LLM reviewer accepts this.

2. **If needed** — Spawn a test-engineer agent with `workflowGateId: "exploratory-validation"`, a task prompt listing scenarios to validate (derived from the design doc), and instructions to invoke `/validate`.

3. **The test-engineer signals the gate** with the report and metadata after completing the validation.

## Budget enforcement

Two budgets prevent runaway validation:

- **Time budget** (`ev_max_duration_minutes`, default 10) — If elapsed time exceeds the budget during scenario execution, the agent stops testing immediately and produces a report with partial results. The server is killed and cleaned up.

- **Scenario budget** (`ev_max_scenarios`, default 5) — Caps the number of scenarios executed in a single validation run.

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

- **"No exploratory validation configured"** — The project's `project.yaml` is missing `ev_start_command`. Add `ev_*` keys as described above.
- **Health check never passes** — Verify `ev_health_check` URL uses `$PORT` placeholder. Check `bash_bg` logs for server startup errors.
- **Screenshots missing from report** — The agent needs Playwright MCP tools available. Check that the browser tools are in the session's tool set.
- **Gate signaled as N/A but downstream is blocked** — The `optional: true` flag means N/A is accepted. Check `gate_status` for the actual verification result.
- **Temp directory not cleaned up** — If the agent crashes mid-protocol, the temp dir may remain. These are in the system temp directory (`$TMPDIR`) and can be manually cleaned.

## Related docs

- [Goals, workflows, and tasks](goals-workflows-tasks.md) — Gate lifecycle and dependency model
- [Internals](internals.md) — Project config resolution, per-project state
- [Debugging](debugging.md) — General debugging checklists
