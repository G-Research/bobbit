# Priority 13 — Verification Support

## Verdict summary

| goal | claim | verdict | confidence |
| --- | --- | --- | --- |
| 13.1 | Bobbit's `edit`/`write`/`patch` runs no syntax check; should attach per-extension syntax feedback to the edit result. | real | high |
| 13.2 | Bobbit lacks a `verify` tool that auto-detects project type and runs the standard check command. | real | high |
| 13.3 | Bobbit lacks structured per-runner test-output parsing (jest/vitest/pytest/go test). | real | high |

## Goal 13.1: Auto-syntax check on patch

**Doc claim.** Bobbit's `edit`/`write`/`patch` returns success without ever running a fast per-extension syntax check (`node --check`, `python -m py_compile`, JSON/YAML parse, etc.); the agent only discovers the breakage several turns later. Should be added as a best-effort, time-bounded post-write step, mirroring Goal 5.9 from the verification angle.

**Bobbit reality.** No syntax-check pass exists. `grep -rn "py_compile\|node --check\|gofmt\|rustfmt --check"` against `src/` and `.bobbit/` returns zero matches. The Phase-A audit already concludes: "Post-write verify / syntax check: ✗ **None.** No re-read, no parser/linter." (`audits/bobbit.md:210`). The `edit` tool definition at `.bobbit/config/tools/filesystem/edit.yaml:1-12` describes only the replacement contract — no post-write hook field. There is no `src/server/agent/syntax-check.ts` (find returned nothing). The only "verification" wiring in the agent layer is `src/server/agent/verification-harness.ts`, which is the gate-verification harness for goal/workflow gates, not for tool-level edits.

**Claude Code reality.** No inline syntax/lint pass either. The Phase-A audit explicitly: "**No syntax/lint check** is performed inline by Edit/Write. Diagnostics arrive asynchronously through LSP." (`audits/claude-code.md:245`); also "**Post-write verification**: LSP `didChange`+`didSave` notifications (`:373-388`) … No syntax check / no formatter run by the tool itself." (`audits/claude-code.md:242`). So CC is **not** the reference impl for this goal — it relies on async LSP diagnostics.

**Hermes reality.** Hermes is the canonical reference. `tools/file_operations.py:261-267` defines:

```python
LINTERS = {
    '.py': 'python -m py_compile {file} 2>&1',
    '.js': 'node --check {file} 2>&1',
    '.ts': 'npx tsc --noEmit {file} 2>&1',
    '.go': 'go vet {file} 2>&1',
    '.rs': 'rustfmt --check {file} 2>&1',
}
```

`_check_lint` (`tools/file_operations.py:853-883`) skips when the extension or binary isn't available, runs with a 30 s timeout, and the result is returned as the `lint:` field on `PatchResult` (audit `hermes.md:63, 221`). This is essentially the exact shape Goal 13.1 prescribes.

**Verdict.** real (high confidence).

**Reasoning.** Bobbit ships zero syntax-check on edit/write/patch (audit + grep). Hermes already implements the same per-extension table the goal prescribes, so the retrofit is well-defined. CC's choice (async LSP) is a different design but doesn't invalidate the gap.

**Minimal proof of gap.**

Bobbit edit tool spec (no post-write hook):

```yaml
# .bobbit/config/tools/filesystem/edit.yaml:1-9
name: edit
description: "Replace exact text in a file"
provider:
  type: builtin
  tool: edit
group: File System
renderer: src/ui/tools/renderers/EditRenderer.ts
```

Hermes reference impl:

```python
# tools/file_operations.py:261-267
LINTERS = {
    '.py': 'python -m py_compile {file} 2>&1',
    '.js': 'node --check {file} 2>&1',
    '.ts': 'npx tsc --noEmit {file} 2>&1',
    '.go': 'go vet {file} 2>&1',
    '.rs': 'rustfmt --check {file} 2>&1',
}
# tools/file_operations.py:853-883 — _check_lint, 30s timeout, returned as PatchResult.lint
```

**Scope-down notes.** Bobbit has no `patch` tool — only `edit` and `write`. The "Files to touch" list mentions `.bobbit/config/tools/patch/extension.ts`, which does not exist. Goal should drop `patch` and target only `edit`/`write`. `.ts`/`.tsx` deserves the goal's `typescript_project_check_required` skip path: Hermes invokes `npx tsc --noEmit {file}` per file (slow + project-config–dependent), which is not worth copying. This is identical to Goal 5.9; the duplication should be acknowledged (one shared impl shipped under both milestones).

## Goal 13.2: `verify` tool

**Doc claim.** Bobbit has no project-type-detecting `verify` tool that picks the standard check command (`pnpm typecheck`, `pytest`, `cargo check`, `go vet ./... && go test ./...`).

**Bobbit reality.** No such tool exists. `find` for `verify*` under `src/`/`.bobbit/` returned nothing relevant; tool group dirs are `agent/browser/filesystem/html/shell/tasks/team/web` only (no `verify`). The closest construct is per-project `package.json` scripts surfaced via `bash` and the project config (`build_command`/`test_command`/`typecheck_command` set in `project.yaml`), but the agent must remember the command. The Phase-A Bobbit audit's tool table contains no `verify` row.

**Claude Code reality.** A bundled "verify" **skill** exists (`src/skills/bundled/verify.ts:1-30`, `verifyContent.ts:1-13`) but it is (a) gated to `process.env.USER_TYPE === 'ant'` (internal-only) and (b) a prompt-level skill, not a tool that detects project type and runs commands. Audit notes a built-in `verification` agent type (`audits/claude-code.md:101`, `VERIFICATION_AGENT_TYPE`, `AgentTool/constants.ts:4`) plus verification-nudge reminders in `TodoWriteTool` / `TaskUpdateTool` (`audits/claude-code.md:120`, also `TaskUpdateTool.ts:397`). None of these auto-run `pnpm test` / `pytest` / `cargo check` based on manifest detection — they all delegate to a sub-agent that decides what to run.

**Hermes reality.** No dedicated `verify` tool either; Hermes uses raw `terminal` execution. Hermes does have repo-marker detection (`tools/checkpoint_manager.py:533-534`: markers `pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`, `Makefile`, `pom.xml`, `Gemfile`) but for checkpointing, not verification.

**Verdict.** real (high confidence) — but reference-implementation evidence is weak; **partial** would also be defensible.

**Reasoning.** Bobbit definitively lacks the proposed tool. However, neither CC nor Hermes ships the exact "auto-detect manifest → run canonical check" tool the goal describes — CC's closest is an ant-only prompt skill, Hermes uses a generic terminal. The gap is real, but the goal is more "new feature" than "retrofit". Cited reference impl is essentially design-only.

**Minimal proof of gap.**

Bobbit tool group inventory (no `verify`):

```
# ls .bobbit/config/tools/
agent  browser  filesystem  html  shell  tasks  team  web
```

CC's nearest analogue (skill, not tool, ant-gated):

```ts
// src/skills/bundled/verify.ts:13-15
export function registerVerifySkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }
  registerBundledSkill({ name: 'verify', /* prompt-level skill */ })
}
```

**Scope-down notes.** Reframe as a **new** feature, not a "retrofit from CC/Hermes". A leaner first pass: read existing project-config commands (`project.yaml::components[*].commands.{typecheck,test,build}`) before manifest sniffing — Bobbit already stores these per-component, so the detection step is partly redundant. The goal's command list (`pnpm typecheck` etc.) duplicates what `package.json::scripts` already declares; resolve via `npm run --silent <script-name>` rather than hard-coded `pnpm`.

## Goal 13.3: Test-output structuring

**Doc claim.** Recognise common test-runner output (jest/vitest/pytest/go test), extract pass/fail counts and failing test names, return structured data with raw output persisted via Goal 6.1.

**Bobbit reality.** No per-runner parsing exists. `grep -rn "jest\|vitest\|pytest" src/server` finds only the verification-harness comment ("If you omit this tag, the verification system cannot parse your output", `verification-harness.ts:531`) — that's gate-content parsing, not test-output parsing. There is no `src/server/agent/test-parsers.ts` and no post-processor in `bash`/`bash_bg` that recognises runner output shapes. Test output flows through `bash`/`bash_bg` raw and is subject only to the generic 32 KB truncation (`truncate-large-content.ts`).

**Claude Code reality.** No per-runner parsers. `grep -rn "jest\|vitest\|pytest"` across `src` finds only allowlists/background-command lists (`BashTool.tsx:265`, `PowerShellTool.tsx:261`, `WebFetchTool/preapproved.ts:52`) and a textual mention in the `batch` skill ("Run unit tests … `npm test`, `bun test`, `pytest`, `go test`", `src/skills/bundled/batch.ts:14`). No structured extraction.

**Hermes reality.** No structured test-output parsers. `grep -rni "jest\|pytest\|test.output\|parse.test"` against `tools/` shows only RL-training infrastructure paths (`tools/rl_training_tool.py:1098-1310`) and a `pytest -v` example string in `tools/process_registry.py:20`. No runner-shape parsers.

**Verdict.** real (high confidence) — but **no reference implementation exists in either CC or Hermes**.

**Reasoning.** The Bobbit gap is undeniable, but per the rubric "real" requires a CC-or-Hermes reference impl, and **neither ships one**. Strictly applying the rubric, this is closer to **unverifiable** as a "retrofit". Pragmatically the gap exists and the design is straightforward; flagging as `real` with a strong scope-down caveat.

**Minimal proof of gap.**

Bobbit (no test parsers; only generic 32 KB truncation):

```bash
$ grep -rn "jest\|vitest\|pytest" src/server
# (no test-parser hits — only verification-harness gate-content comment)
```

Hermes (no parsers either; closest is a doc-string example):

```python
# tools/process_registry.py:20
# session = process_registry.spawn(env, "pytest -v", task_id="task_123")
```

CC (no parsers either; closest is a skill prompt mentioning runners):

```ts
// src/skills/bundled/batch.ts:14
// "Run unit tests — Run the project's test suite (check for package.json scripts,
//   Makefile targets, or common commands like `npm test`, `bun test`, `pytest`, `go test`)."
```

**Scope-down notes.** Drop the "common implementation in CC/Hermes" framing — there isn't one. Treat this as a green-field summarisation feature, justified by output-bloat data (Goal 0.1 measurements) before building. Pair it tightly with Goal 6.1 (per-result persistence): without on-disk raw output, structured summaries are hard to drill into. Realistic first cut: pytest + vitest only (the two runners Bobbit's own test suite uses), behind a feature flag, returning `{passed, failed, skipped, failingNames[], rawPath}`.
