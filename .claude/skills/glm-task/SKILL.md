---
name: glm-task
description: Delegate a well-specified, test-oracle-backed code fix to codex/GPT-5.5 directly, with a harness review gate. GLM 5.2 (NVIDIA NIM) stays wired in but dormant — opt in with BOBBIT_GLM_WORKER=1 for a probe-gated GLM-generate + GPT-5.5-review path. Use for bulk/batch micro-tasks — single-file or few-file transforms where the caller can express "here's the file(s) + the failing check" and control gets handed back once tests pass. Do NOT use for ambiguous, multi-step, or exploratory work.
---

# /glm-task

Runs the micro-tier worker pipeline: **(default) GPT-5.5 (codex) implements → harness reviews, or
(opt-in) probe GLM availability → GLM 5.2 implements → GPT-5.5 reviews → orchestrator gates/merges.**

- **Default (nothing sets `BOBBIT_GLM_WORKER`)**: GPT-5.5 (codex) implements directly in the worktree,
  and the harness itself reviews with fresh eyes against the brief. GLM 5.2 is dropped as a worker LLM —
  see `~/Documents/dev/bobbit-fable-refactor/FABLE-PROMPT.md` ADDENDUM #30 for why (maintenance cost —
  proxy, key rotation, 40rpm babysitting, garbled-edit retries — exceeded benefit). No probe of the NIM
  endpoint happens on this path.
- **Opt-in (`BOBBIT_GLM_WORKER=1`)**: re-arms the old probe-gated path. If the NIM endpoint is up, GLM 5.2
  implements and GPT-5.5 (codex) reviews (cross-model, cost-optimized). If the endpoint is down, this
  falls back to the same default path above (codex generates, harness reviews).

This skill documents how to drive `scripts/glm-worker.mjs`, the codex-companion `task`/`status`
subcommands, `scripts/gpt55-review.sh`, and (opt-in only) `~/Documents/dev/bobbit-fable-refactor/scripts/cheap-model-probe.sh`
directly with the `Bash` tool — there is no MCP server or long-running process involved. The GLM-shaped
routing boundary below (when a task belongs on this pipeline at all) is unchanged by any of this; it's
orthogonal to which model generates.

## When to use this pipeline at all

Whichever model ends up generating (codex by default, or GLM 5.2 under the opt-in), use it when ALL of
these hold:

- The task can be expressed as: here are the file(s), here is the failing/expected check, fix it.
- A test command exists that objectively proves success/failure (unit test, typecheck, lint — anything
  with a real exit code). No test oracle → do not use this pipeline; there's nothing for the loop to
  converge on.
- The file set is small and known up front (single-file is the sweet spot; a handful of related files is
  fine).
- The task is mechanical, not ambiguous: a seeded bug, a type error, a lint violation, a small refactor
  with a clear target shape. Nothing that requires judgment calls about architecture or design.

## When NOT to use it (route elsewhere instead)

- **Multi-step or ambiguous work** — anything requiring exploration, root-causing, or judgment about
  what "correct" even means. Use `codex:codex-rescue` (GPT-5.5, has a real agentic harness with sandboxed
  file/tool access) or a Claude subagent instead.
- **Large or unknown file sets** — if you don't already know which files need to change, this pipeline
  can't find out; both generators only see what you hand them.
- **No test oracle** — if success can only be judged by a human/reviewer reading the diff, this loop has
  no stopping condition other than the round cap, which is a bad sign, not a workaround.
- **Anything security- or contract-sensitive as the *only* gate** — the review step below is not optional
  and is not a substitute for orchestrator judgment.

## When to use the GLM opt-in specifically (`BOBBIT_GLM_WORKER=1`)

Per `~/Documents/dev/bobbit-fable-refactor/MODEL-ROUTING-EVAL.md`, GLM 5.2 matched GPT-5.5 on a small,
fully-specified, test-oracle-backed bugfix task and ran roughly 2x faster wall-clock — but per ADDENDUM
#30 the maintenance cost of keeping it in the loop (proxy, key rotation, 40rpm babysitting, garbled-edit
retries) was judged not worth it, so it is no longer the default. It also has **no agentic harness** on
this machine (no file exploration, no multi-turn tool use). Only reach for the opt-in if you've been told
to specifically re-test/re-evaluate GLM, not as a routine cost optimization — the default codex path is
the one to use otherwise.

## Pipeline

### 0. Default: skip straight to codex — no probe

Nothing sets `BOBBIT_GLM_WORKER` today, so by default:

```bash
echo "${BOBBIT_GLM_WORKER:-unset}"
```

- **Unset (the default)** → skip directly to **1. Prepare a task spec** then **2. Codex generates**
  below. Do not probe the NIM endpoint, do not touch `scripts/glm-worker.mjs`.
- **`BOBBIT_GLM_WORKER=1`** → probe GLM availability before doing anything else:
  ```bash
  ~/Documents/dev/bobbit-fable-refactor/scripts/cheap-model-probe.sh
  ```
  - Exit 0, prints `GLM_AVAILABLE` → go to **2-GLM. GLM path** below.
  - Exit 1, prints `GLM_UNAVAILABLE <reason>` (`timeout`/`dns`/`http-NNN`/`key-missing`/`network`) → fall
    through to the same **2. Codex generates** step used by default. Do not retry the probe in a loop.
  - The probe hits the exact endpoint/model `scripts/glm-worker.mjs` uses (`NVIDIA_CHAT_URL`/`MODEL`
    constants) with a 1-token request and a 15s timeout. It never prints the key, the request body, or the
    response body — only `GLM_AVAILABLE` / `GLM_UNAVAILABLE <reason-class>`.

### 1. Prepare a task spec

Write a spec JSON (see `scripts/glm-worker.mjs` header for the full shape) — used to build the codex
prompt on the default path, or fed straight to the driver on the GLM opt-in path:

```json
{
  "instructions": "Fix the off-by-one in totalValue() so it sums every item...",
  "files": ["src/foo.ts"],
  "contextFiles": ["src/foo.test.ts"],
  "testCommand": "node --test src/foo.test.ts",
  "maxRounds": 4
}
```

- `files` — editable files the generator may rewrite. Keep this the minimal set that should change.
- `contextFiles` — read-only files sent for context (e.g. the test file) that must not be modified; on
  the GLM path the driver silently drops any `FILE:` block for a path not in `files`.
- `testCommand` — must have a real exit code. Runs via `sh -c` in `workdir`.
- `maxRounds` — default 4. Each round is one model call + one test run.

### 2. Codex generates (default path)

GPT-5.5 (codex) implements the fix directly via the codex-companion `task` subcommand, in the **same
worktree** the orchestrator prepared — its sandbox can write files under its `--cwd`, but it cannot
`git commit` or reach the network, so the harness still owns verify/commit/push/PR.

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
  spec's `testCommand` yourself to confirm it passes; if it doesn't, this is the "not shaped for this
  pipeline" signal — stop and report, don't loop the same prompt at codex repeatedly.
- Then go to **3. Harness self-review** below.

### 2-GLM. Opt-in only: run the GLM driver

Only reached when `BOBBIT_GLM_WORKER=1` **and** the step-0 probe printed `GLM_AVAILABLE`.

```bash
BOBBIT_GLM_WORKER=1 node scripts/glm-worker.mjs --spec <spec.json> --workdir <dir>
```

- Without `BOBBIT_GLM_WORKER=1` in the environment, `glm-worker.mjs` refuses to run at all (prints a
  `{"event":"routing","path":"codex",...}` line and exits 3) rather than touching the NIM endpoint — this
  is the code-level guard behind the opt-in, not just a documentation convention. See
  `selectGenerationPath()` in `scripts/glm-worker.mjs`.
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
- Then go to **3-GLM. Review with GPT-5.5** below.

### 3. Harness self-review (default path)

Codex generated the fix (step 2), so it cannot also be the reviewer. Instead, **the worker harness itself
reviews with fresh eyes**:

- Read the diff (`git -C <worktree> diff`) against the original brief/instructions, as if you had never
  seen the fix being produced.
- Check the same things `gpt55-review.sh`'s prompt asks for: correctness, whether the diff is minimal and
  targeted at the stated task, whether tests were modified unintentionally (test-gaming), and any
  contract/security concerns.
- Produce the same shape of verdict by hand: `approve` or `needs-attention` + findings, so step 4's gate
  logic is identical regardless of which path produced the change.
- This review step is mandatory — it is not the same thing as the harness's own "did the test pass" check
  in step 2.

### 3-GLM. Opt-in only: GLM-generated → review with GPT-5.5

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

### 4. Gate

- `approve` + no `findings` → safe to proceed to commit/PR.
- `needs-attention` or any `high`/`critical` finding → do not merge. Either address the finding with
  another round on whichever model generated (feed the finding back as part of `instructions`, or another
  `task --resume` codex turn) or escalate — do not loop indefinitely trying to satisfy the reviewer; two
  generate+review cycles without resolution means this task escalated past this pipeline's bar and belongs
  on GPT-5.5/Claude as a first-class task instead.
- Low/medium findings with no correctness impact are an orchestrator judgment call, not an auto-block.
- **Report model attribution.** The final report (commit message and PR body, per the `glm-worker` agent)
  must name which model generated the fix and which reviewed it — GPT-5.5 + harness review (default), or
  GLM 5.2 + GPT-5.5 review (opt-in) — so per-PR model attribution stays accurate whichever path ran.

## Why this shape (skill + scripts + agent, no MCP server)

- **Codex/GPT-5.5 as the default generator, GLM dormant behind an opt-in**: AJ decision, ADDENDUM #30 in
  `~/Documents/dev/bobbit-fable-refactor/FABLE-PROMPT.md` (2026-07-05) — GLM 5.2 is dropped as a worker
  LLM across the whole program; its maintenance cost (proxy, key rotation, 40rpm babysitting, garbled-edit
  retries) exceeded its benefit (slower in-harness than GPT-5.5, and its zero-cost edge was tied to a
  rate-limited free tier). The GLM code, probe script, and docs stay in place — dormant, not deleted —
  mirroring the `GLM_AUTO_ENABLED` re-arm pattern in `bobbit-fable-refactor/scripts/codex-lane.sh`:
  nothing sets `BOBBIT_GLM_WORKER` today, and `glm-worker.mjs` refuses to run without it.
- **MCP server**: rejected. Generation here is a single request/response chat completion (GLM path) or a
  single codex task (default path) that the *caller* drives — there is no persistent state, no
  bidirectional tool-call protocol either generator needs, and no reason to keep a process alive between
  invocations. An MCP server would add a lifecycle (start/stop/health) and an approval surface for zero
  capability gain over a plain script invoked via `Bash`.
- **Standalone script over inline skill logic**: the GLM driver's retry loop, diff parsing, and
  key-loading logic is non-trivial and needs to run for real (make an HTTP call, retry, parse), not be
  re-derived by an LLM reading prose each time. A script is testable and deterministic; a skill's job is
  to say *when* and *how* to invoke it, not to re-implement it in natural language each run.
- **Agent definition over a bare skill**: a dedicated `glm-worker` agent (see `.claude/agents/glm-worker.md`)
  gives the orchestrator a single delegatable unit — prepare worktree, run generator, run review, address
  trivial findings, commit, open PR — without the orchestrator's own context filling up with per-round
  logs. The agent is a thin shepherd around these scripts, not a reimplementation of them.
- **A standalone probe script, not a try/catch inside `glm-worker.mjs`**: an outage was previously handled
  by the worker improvising (applying the edit itself), which is exactly the failure mode the codex
  fallback (now the default) replaces. A cheap, separate, single-purpose availability check
  (`cheap-model-probe.sh`, ~15s worst case) keeps the routing decision explicit and inspectable *before*
  any work starts, rather than discovered mid-round inside the retry loop — still used on the opt-in path.
- **GPT-5.5 as the generator whenever GLM isn't in the loop, not a Claude hand-edit**: GPT-5.5/codex
  already has a real agentic harness (file access, no separate diff-parsing logic needed) on this machine,
  unlike GLM. Routing generation to it is strictly safer than the orchestrator improvising an edit itself
  outside the pipeline's verify/commit/PR contract.
