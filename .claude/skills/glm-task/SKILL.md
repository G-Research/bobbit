---
name: glm-task
description: Delegate a well-specified, test-oracle-backed code fix to GLM 5.2 (NVIDIA NIM), falling back to GPT-5.5 (codex) if NIM is unavailable, with a cross-model review gate. Use for bulk/batch micro-tasks — single-file or few-file transforms where the caller can express "here's the file(s) + the failing check" and control gets handed back once tests pass. Do NOT use for ambiguous, multi-step, or exploratory work.
---

# /glm-task

Runs the GLM-worker pipeline: **probe GLM availability → GLM 5.2 (or GPT-5.5 fallback) implements →
cross-model (or harness) review → orchestrator gates/merges.**

- **GLM available**: GLM 5.2 implements, GPT-5.5 (codex) reviews. This is the default, cost-optimized path.
- **GLM unavailable** (NIM endpoint down/timeout/error): GPT-5.5 (codex) implements directly in the
  worktree, and the harness itself reviews with fresh eyes against the brief — GPT-5.5 cannot review its
  own generation here, and skipping review is not acceptable just because the cheap tier is down.

This skill documents how to drive `~/Documents/dev/bobbit-fable-refactor/scripts/cheap-model-probe.sh`,
`scripts/glm-worker.mjs`, the codex-companion `task`/`status` subcommands, and `scripts/gpt55-review.sh`
directly with the `Bash` tool — there is no MCP server or long-running process involved. The GLM-shaped
routing boundary below is unchanged by this fallback; the fallback only covers *availability* of the NIM
endpoint, not the decision of whether a task belongs on this pipeline at all.

## When to use GLM 5.2 for this

Per `~/Documents/dev/bobbit-fable-refactor/MODEL-ROUTING-EVAL.md`, GLM 5.2 matched GPT-5.5 on a small,
fully-specified, test-oracle-backed bugfix task and ran roughly 2x faster wall-clock — but it has **no
agentic harness** on this machine (no file exploration, no multi-turn tool use, no self-directed test
running beyond what this driver does for it). Use it when ALL of these hold:

- The task can be expressed as: here are the file(s), here is the failing/expected check, fix it.
- A test command exists that objectively proves success/failure (unit test, typecheck, lint — anything
  with a real exit code). No test oracle → do not use GLM; there's nothing for the loop to converge on.
- The file set is small and known up front (single-file is the sweet spot; a handful of related files is
  fine — GLM never explores the repo to find what else might be relevant).
- The task is mechanical, not ambiguous: a seeded bug, a type error, a lint violation, a small refactor
  with a clear target shape. Nothing that requires judgment calls about architecture or design.

## When NOT to use it (route elsewhere instead)

- **Multi-step or ambiguous work** — anything requiring exploration, root-causing, or judgment about
  what "correct" even means. Use `codex:codex-rescue` (GPT-5.5, has a real agentic harness with sandboxed
  file/tool access) or a Claude subagent instead.
- **Large or unknown file sets** — if you don't already know which files need to change, GLM can't find
  out; it only sees what you hand it.
- **No test oracle** — if success can only be judged by a human/reviewer reading the diff, this loop has
  no stopping condition other than the round cap, which is a bad sign, not a workaround.
- **Anything security- or contract-sensitive as the *only* gate** — the review step below is not optional
  and is not a substitute for orchestrator judgment; GLM's own harness does zero self-review.

## Pipeline

### 0. Probe GLM availability

Before preparing anything, check whether the NIM endpoint is up:

```bash
~/Documents/dev/bobbit-fable-refactor/scripts/cheap-model-probe.sh
```

- Exit 0, prints `GLM_AVAILABLE` → proceed with steps 1–3 below (GLM generates, GPT-5.5 reviews).
- Exit 1, prints `GLM_UNAVAILABLE <reason>` (`timeout`/`dns`/`http-NNN`/`key-missing`/`network`) → skip
  straight to **3b. Fallback: GPT-5.5 generates** below. Do not retry the probe in a loop and do not fall
  back to hand-editing the file yourself — the routing below is the designed replacement for that failure
  mode.
- The probe hits the exact endpoint/model `scripts/glm-worker.mjs` uses (`NVIDIA_CHAT_URL`/`MODEL`
  constants) with a 1-token request and a 15s timeout. It never prints the key, the request body, or the
  response body — only `GLM_AVAILABLE` / `GLM_UNAVAILABLE <reason-class>`.

### 1. Prepare a task spec

Write a spec JSON (see `scripts/glm-worker.mjs` header for the full shape):

```json
{
  "instructions": "Fix the off-by-one in totalValue() so it sums every item...",
  "files": ["src/foo.ts"],
  "contextFiles": ["src/foo.test.ts"],
  "testCommand": "node --test src/foo.test.ts",
  "maxRounds": 4
}
```

- `files` — editable files GLM may rewrite. Keep this the minimal set that should change.
- `contextFiles` — read-only files sent for context (e.g. the test file) that GLM must not modify; the
  driver silently drops any `FILE:` block for a path not in `files`.
- `testCommand` — must have a real exit code. Runs via `sh -c` in `workdir`.
- `maxRounds` — default 4. Each round is one model call + one test run.

### 2a. GLM path: run the driver

Only reached when the step-0 probe printed `GLM_AVAILABLE`.

```bash
node scripts/glm-worker.mjs --spec <spec.json> --workdir <dir>
```

- Reads `NVIDIA_BUILD_KEY` from the environment, or (checked in order) `--env-file <path>`, `.env` in
  `<dir>` or any of its ancestors, or the primary git worktree's `.env`. **Never** hardcode or print the
  key; if you ever see the literal key value in your own output, treat that as an incident, not a log line.
- **Reasoning effort defaults to high.** Every request sends `chat_template_kwargs: { thinking: true }` —
  verified empirically against NVIDIA NIM's `z-ai/glm-5.2` endpoint (accepted with no 400, and produced a
  `reasoning_content` field plus ~4-5x completion tokens vs. the same call without it). `reasoning_effort`
  and a top-level `reasoning: {...}` object were also tried: the former is silently accepted but is a
  no-op (no behavior change) on this endpoint, the latter is rejected with HTTP 400 — neither is used.
  Override with `BOBBIT_GLM_EFFORT=off` (or `low`/`false`) in the environment to disable thinking mode,
  e.g. for a cheap smoke call.
- Emits one JSON log line per round to stdout (round number, files changed, token usage,
  `reasoningContentLen`, elapsed ms), and a final `RESULT {"passed": bool, "rounds": n, "wallSeconds": n,
  "usage": {...}, "filesChanged": [...]}`.
- Exit code 0 iff tests passed within `maxRounds`. A non-zero exit with `passed: false` means: stop, do not
  merge, do not silently retry with a bigger round cap — read the log, decide whether the task was
  actually GLM-shaped (see above) or needs a human/Claude/GPT-5.5 pass instead.

### 2b. Fallback path: GPT-5.5 generates

Only reached when the step-0 probe printed `GLM_UNAVAILABLE <reason>`. GPT-5.5 (codex) implements the fix
directly via the codex-companion `task` subcommand, in the **same worktree** the orchestrator prepared —
its sandbox can write files under its `--cwd`, but it cannot `git commit` or reach the network, so the
harness still owns verify/commit/push/PR exactly as in the GLM path.

```bash
COMPANION="$(ls ~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs | head -1)"
node "$COMPANION" task --cwd <worktree> --model gpt-5.5 --effort high --write --background "<instructions,
  same content you'd have put in spec.json's instructions field, plus the file(s) to touch and what NOT to
  touch>"
```

This prints one line: `Codex Task started in the background as <task-id>.` Poll until it stops running:

```bash
node "$COMPANION" status <task-id> --cwd <worktree>
```

- `--cwd` must be the **exact same path** passed to `task` — job state is cwd-scoped (keyed by a hash of
  the cwd), not global.
- Poll in a bounded foreground loop (not a backgrounded watcher) — check the line starting `- <task-id> |
  <status> | ...`; keep polling while that cell reads `running`, stop once it reads `completed` (or
  `failed`/`error`).
- Once `completed`, the worktree files are already changed — there is no separate "apply" step. Run the
  spec's `testCommand` yourself to confirm it passes; if it doesn't, this is the same "not GLM/codex-shaped
  as specced" signal as a failed GLM round — stop and report, don't loop the same prompt at codex repeatedly.

### 3a. GLM-generated → review with GPT-5.5

Commit GLM's change (or leave it uncommitted — either works), then:

```bash
bash scripts/gpt55-review.sh <workdir> --commit <sha>      # review one commit
bash scripts/gpt55-review.sh <workdir> --base <ref>        # review <ref>...HEAD
bash scripts/gpt55-review.sh <workdir>                     # review uncommitted changes (git diff HEAD)
```

Prints `VERDICT: approve|needs-attention|no-changes|error` followed by the full JSON (schema:
`scripts/gpt55-review-schema.json` — `verdict`, `summary`, `findings[]` with severity/file/line/
recommendation, `next_steps[]`). This runs through the ChatGPT-subscription-backed `codex` CLI
(`codex exec -m gpt-5.5`), not metered API billing. **Reasoning effort defaults to high**: the
script passes `-c model_reasoning_effort="high"` explicitly (belt-and-suspenders on top of the
global `model_reasoning_effort = "high"` set in `~/.codex/config.toml`), so it stays correct on
a machine without that global default.

This deliberately does **not** use codex's own `codex exec review` subcommand — that routes through
codex's built-in app-server review prompt and silently ignores `--output-schema` (verified: it always
returns a free-text paragraph). `gpt55-review.sh` instead builds the diff itself and runs a generic
`codex exec` turn with the schema, which does honor it.

### 3b. Fallback-generated → harness self-review

When GPT-5.5 generated the fix (step 2b), it cannot also be the reviewer — GLM review is not a substitute
either (it's the tier that's down), and skipping review is not acceptable. Instead, **the worker harness
itself reviews with fresh eyes**:

- Read the diff (`git -C <worktree> diff`) against the original brief/instructions, as if you had never
  seen the fix being produced.
- Check the same things `gpt55-review.sh`'s prompt asks for: correctness, whether the diff is minimal and
  targeted at the stated task, whether tests were modified unintentionally (test-gaming), and any
  contract/security concerns.
- Produce the same shape of verdict by hand: `approve` or `needs-attention` + findings, so step 4's gate
  logic is identical regardless of which path produced the change.
- This review step is mandatory on the fallback path — it is not optional just because NIM happened to be
  down, and it is not the same thing as the harness's own "did the test pass" check in step 2b.

### 4. Gate

- `approve` + no `findings` → safe to proceed to commit/PR.
- `needs-attention` or any `high`/`critical` finding → do not merge. Either address the finding with
  another round on whichever model generated (feed the finding back as part of `instructions`, or another
  `task --resume` codex turn) or escalate — do not loop indefinitely trying to satisfy the reviewer; two
  generate+review cycles without resolution means this task escalated past "GLM-shaped" and belongs on
  GPT-5.5/Claude as a first-class task instead.
- Low/medium findings with no correctness impact are an orchestrator judgment call, not an auto-block.
- **Report model attribution.** The final report (commit message and PR body, per the `glm-worker` agent)
  must name which model generated the fix and which reviewed it — GLM 5.2 + GPT-5.5 review, or GPT-5.5 +
  harness review — so per-PR model attribution stays accurate whichever path ran.

## Why this shape (skill + scripts + agent, no MCP server)

- **MCP server**: rejected. GLM's job here is a single request/response chat completion in a loop the
  *caller* drives — there is no persistent state, no bidirectional tool-call protocol GLM itself needs
  (it has no tool-use harness on this machine), and no reason to keep a process alive between invocations.
  An MCP server would add a lifecycle (start/stop/health) and an approval surface for zero capability gain
  over a plain script invoked via `Bash`.
- **Standalone script over inline skill logic**: the retry loop, diff parsing, and key-loading logic is
  non-trivial and needs to run for real (make an HTTP call, retry, parse), not be re-derived by an LLM
  reading prose each time. A script is testable and deterministic; a skill's job is to say *when* and
  *how* to invoke it, not to re-implement it in natural language each run.
- **Agent definition over a bare skill**: a dedicated `glm-worker` agent (see `.claude/agents/glm-worker.md`)
  gives the orchestrator a single delegatable unit — prepare worktree, run driver, run review, address
  trivial findings, commit, open PR — without the orchestrator's own context filling up with per-round
  logs. The agent is a thin shepherd around these scripts, not a reimplementation of them.
- **A standalone probe script, not a try/catch inside `glm-worker.mjs`**: an outage was previously handled
  by the worker improvising (applying the edit itself), which is exactly the failure mode this fallback
  replaces. A cheap, separate, single-purpose availability check (`cheap-model-probe.sh`, ~15s worst case)
  keeps the routing decision explicit and inspectable *before* any work starts, rather than discovered
  mid-round inside the retry loop. It reuses the same endpoint/model/key-discovery as `glm-worker.mjs` by
  reading them from the same source of truth, not by duplicating a second guess at the URL.
- **GPT-5.5 as the fallback generator, not a lower-effort GLM retry or a Claude hand-edit**: GPT-5.5/codex
  is already the review tier and already has a real agentic harness (file access, no separate diff-parsing
  logic needed) on this machine, unlike GLM. Routing generation to it on outage is strictly safer than the
  orchestrator improvising an edit itself outside the pipeline's verify/commit/PR contract.
