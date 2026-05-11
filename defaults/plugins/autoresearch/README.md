# Autoresearch plugin

A bobbit plugin that turns the Goal/Workflow/Gate machinery into an
autoresearch pipeline: a Goal is a research idea, gates are research-lifecycle
checkpoints, verification is structured human/LLM judgement against rubrics
plus webhook-driven external job tracking.

This plugin ships **data only**. It does not register any plugin-side
verify-step handler code; the workflow it contributes uses bobbit's built-in
verify types: `rubric-review`, `external-job`, and `llm-review`. As a result
the plugin is auto-trusted when installed from `defaults/plugins/` (no
approval prompt) and has no native code to audit.

## The workflow

`autoresearch::research` (id `research`) defines a six-stage research
lifecycle:

| Stage             | Gate id          | Verification                                                                 |
|-------------------|------------------|------------------------------------------------------------------------------|
| Research idea     | `idea`           | None — content gate; team lead signals after capturing the idea.             |
| Literature        | `literature`     | `rubric-review` (LLM) — coverage / novelty / rigor each ≥ 3.                  |
| Plan              | `plan`           | `rubric-review` (LLM) — clarity ≥ 3, feasibility ≠ low, rigor ≥ 3.            |
| Experiment        | `experiment-run` | `external-job` — external system POSTs verdict + artifact to a webhook.       |
| Analysis          | `analysis`       | `rubric-review` (LLM) — soundness ≥ 3, honesty ≥ 3.                          |
| Publication       | `publication`    | Manual — human researcher clicks "Mark passed" when the work is shareable.   |

Each content-bearing gate (`idea`, `literature`, `plan`, `analysis`) carries
`inject_downstream: true` so its accepted content is auto-prepended to every
downstream agent's system prompt under the `# Upstream Gates` section. The
plan agent sees the idea + literature; the analysis agent sees idea +
literature + plan + experiment-run summary.

## Installing into a project

1. **Trust** — when shipped under `defaults/plugins/autoresearch/`, this
   plugin is auto-trusted. From other locations (`~/.bobbit/plugins/`,
   `<project>/.bobbit/plugins/`) you must click Trust in Settings → Plugins.

2. **Install** — open Settings → Plugins for the target project and click
   Install. The plugin's workflow is copied into `project.yaml::plugin_workflows`
   as a frozen snapshot under the namespaced id `autoresearch::research`. New
   goals can select it from the workflow dropdown.

3. **Run** — create a goal against the workflow. The team lead progresses
   gates with `gate_signal` as usual.

## Wiring the `experiment-run` callback

When the team lead signals the `experiment-run` gate, the external-job
handler mints a single-use token and broadcasts a `gate_verification_external_pending`
event. The token is also visible in the goal dashboard's running-verification
card. Hand that token to the external system (training queue, batch runner,
human collaborator with compute) and have it POST when the run finishes:

```bash
curl -X POST "$GATEWAY_URL/api/verify/external/<token>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "goalId":   "<goal-id>",
    "gateId":   "experiment-run",
    "signalId": "<signal-id>",
    "passed":   true,
    "summary":  "Training run completed. Top-line metric: 0.92.",
    "artifact": {
      "content":     "# Training report\n\nFull metrics, plots, run config…",
      "contentType": "text/markdown"
    }
  }'
```

The token, goalId, gateId, and signalId are all in the WebSocket event
emitted at signal time. Token validation is strict: a tampered triple, a
re-used token, or a callback after `timeout: 604800` seconds is rejected.
On timeout the gate fails with a clear message and the team lead can
re-signal to mint a fresh token.

## Customising the rubrics

The rubric definitions in `workflows/autoresearch.yaml` are deliberately
generic. To tailor them to a research group's standards (more dimensions,
stricter `pass_when`, additional reviewer roles), copy this plugin into
`~/.bobbit/plugins/<your-fork>/` or `<project>/.bobbit/plugins/<your-fork>/`,
edit the YAML, bump the `version`, and re-install. Plugin install copies the
workflow into the project as a frozen snapshot, so in-flight goals are
unaffected by edits to the plugin source.

## What this plugin does not (yet) ship

- A `researcher` role with custom tool policies. The roles cascade integration
  for plugin-contributed `roles/` is a follow-up; for now the workflow uses
  the default `reviewer` role.
- A literature search tool (`tool-call` step). Drop an MCP server (arxiv,
  Semantic Scholar, etc.) into `.bobbit/config/mcp.json` and edit the
  `literature` gate to add a `tool-call` step that invokes it if you want
  the LLM rubric review to be backed by a real lookup.
- Restart-resume for in-flight `external-job` callbacks. The token store is
  in-memory in v1; a gateway restart causes pending callbacks to time out
  cleanly rather than survive. The Phase 2 harness refactor (extracting
  `tryResume` onto handlers) unblocks this.

## See also

- [docs/goals-workflows-tasks.md](../../../docs/goals-workflows-tasks.md) —
  the full Goal/Workflow/Gate model this plugin builds on.
- [src/server/agent/verify-handlers/](../../../src/server/agent/verify-handlers/) —
  source of the built-in `rubric-review`, `external-job`, `tool-call`,
  and `llm-review` step handlers.
