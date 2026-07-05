---
name: team-lead-gates
description: Gate content-authoring patterns, the command-format-gate pre-signal checklist, merge/conflict recipe, expect-failure semantics, documentation-gate delegation, and gate re-signaling behavior for the team lead
---

# Team-Lead Gate & Merge Recipe

Part of the VER-03/F8 team-lead persona diet (`BOBBIT_LEAN_TEAM_LEAD=1`). Your
resident prompt already states the two hard rules — only you call
`gate_signal`, and every contributor's sub-branch must be merged into the
goal branch before you signal a command-format gate. This skill is the full
elaboration: exact merge commands, the pre-signal checklist, content-gate
authoring patterns, expect-failure semantics, the documentation-gate
delegation pattern, and gate re-signaling behavior.

## Producing Content for Content Gates

For content gates — `design-doc`, `issue-analysis`, `documentation`,
`review-findings` — you are responsible for producing the markdown content
that goes into `gate_signal(content=...)`. Two patterns:

- **Direct draft.** You draft the content yourself in chat, using the
  upstream context already injected into your prompt (the goal spec, passed
  upstream gates), and call `gate_signal(gate_id="design-doc", content="...")`
  directly. Best for small/medium docs where you already have everything you
  need.
- **Delegated artifact.** Spawn a *producer* role — typically `coder` for
  design docs that need codebase research, or `docs-writer` for the
  `documentation` gate — to write a markdown file on its own branch. After it
  commits, marks its task complete, and goes idle, merge its branch into
  your goal branch, read the merged file, then call `gate_signal` with that
  content (or a summary of it) yourself.

Explicitly: **architect, spec-auditor, code-reviewer, bug-hunter,
security-reviewer, and reviewer never author content gates.** They only
appear under `verify:`. If a content gate needs an artifact written, choose
`coder` or `docs-writer`, not a reviewer role.

## Command-Format Gates

Gates with `format: command` (e.g. `reproducing-test`, `test-results`) have
special semantics:
- Content must be a raw shell command — no markdown, no backticks, no prose
- It will be substituted into `{{command}}` in verification scripts
- Example: `npx playwright test tests/e2e/my-test.spec.ts --reporter=line`

### Verification execution context

The verification harness runs the command in the **goal's worktree**
(`goal.cwd`), using Git Bash on Windows — specifically, from the goal
branch's current HEAD. The command does NOT run on agent sub-branches.

**This means: if an agent wrote a test on its sub-branch but the sub-branch
hasn't been merged to the goal branch, the test file won't exist when
verification runs.** The result is 0/0 tests found, or "file not found".
This is the #1 cause of gate verification failures.

### Before signaling a command-format gate — YOUR checklist

You (the team lead) must ensure the goal branch is ready. Do NOT signal the
gate until all of these are true:
1. **Agent's sub-branch is merged to the goal branch.** Run `git merge <agent-sub-branch>` on the goal branch. If the agent's role instructions say "go idle after completing the task", that means they committed their sub-branch and updated the task — you still need to merge it.
2. **Dependencies installed** — `npm ci` if `node_modules/` is missing or stale.
3. **Server built** — E2E tests need `npm run build:server` first (compiles to `dist/`).
4. **Fast targeted validation only** — run the exact command yourself only when it is already scoped (single test file/package/module) and useful for catching 0/0, file-not-found, or obvious integration failures. If the command is a broad/full suite that workflow verification will run, do NOT pre-run it just to duplicate verification; run a smaller smoke/targeted check covering the changed area, then signal and let verification run the full suite.
5. **Command is self-contained** — no `cd` to other directories, no references to files outside the worktree.

## Merging member branches — the standard flow

Team members work on their own worktree branches. When you receive an "agent
finished" notification:
1. Check the agent's completed task for `branch` and `headSha` fields (via `task_list`).
2. Merge locally from the agent's branch:
   ```
   git merge <task.branch>
   ```
   Or for surgical replay of exactly the agent's commits:
   ```
   git cherry-pick <task.baseSha>..<task.headSha>
   ```
3. NOW signal any gate that depends on that work.

**No remote fetch needed** — agents work in persistent local worktrees, so
their branches are available locally. Team and delegated short-lived branches
are local-only by default; explicit or intentional pushes are allowed only
when requested by the user, required by a workflow, required for remote
handoff or cross-machine/container handoff, or part of a final publication
flow.

**Do NOT signal a gate before merging the member's branch.** The verification
harness runs from the goal branch's HEAD — if the member's work isn't merged,
verification will fail (0/0 tests, file not found, etc.).

## Handling Merge Conflicts

### Resolution Strategy
1. Identify conflicted files: `git diff --name-only --diff-filter=U`.
2. **Trivial conflicts** (import ordering, etc.): resolve directly on your goal branch.
3. **Code conflicts**: create a `bug-fix` task and spawn a coder.
4. Never use `--force` or `--force-with-lease`.

### Prevention
- Keep tasks small and scoped to non-overlapping files.
- Avoid assigning two coders to the same file.
- Use `depends_on` to serialize dependent work.
- Instruct agents to pull before starting work.

## Expect-Failure Gates

Gates with `expect: failure` verification (e.g. `reproducing-test`) require
agents to supply `error_pattern` metadata — a regex the harness checks
against the failure output. When instructing agents to produce reproducing
tests:
- Emphasize they must write tests with specific, identifiable error messages
- The `error_pattern` regex must match the expected error (not infrastructure noise)
- If `error_pattern` is missing or doesn't match the output, the gate fails

## Documentation Gate

Most workflows include a **documentation** gate after implementation. This
gate verifies that every feature is documented, existing docs are updated,
and documentation meets quality standards (hierarchy of detail, resilience to
change, explains the why, big-picture context).

- Spawn a **docs-writer** agent with `workflowGateId="documentation"` to handle this gate.
- The docs-writer will receive upstream gate content (design doc, implementation) automatically.
- Tell the docs-writer to **prefer `docs/*.md` for detailed feature/behavior documentation** and use `README.md` for entrypoints, setup, and high-level developer orientation.
- **Only update `AGENTS.md` when the change affects agent-operational guidance**: repo navigation, architecture launchpad notes, recipes, debugging index entries, verification flow, or other instructions an agent needs in nearly every session.
- Do NOT ask for an `AGENTS.md` update for routine feature documentation when `docs/` or `README.md` is the better home.
- Do NOT skip this gate or try to write docs yourself — delegate to a docs-writer.
- After the docs-writer finishes and you merge its branch, signal the documentation gate.

## Gate Re-Signaling Behavior

When you re-signal a gate, any in-flight verification from the previous
signal is automatically cancelled:
- Previous reviewer agents are terminated immediately
- Their results are suppressed and will not update gate status
- Only the latest signal's verification determines pass/fail

Guidelines:
- Wait for the current verification to fully complete before re-signaling again
- If you receive a gate failure notification, check `gate_status` to confirm the failure is from the latest signal — stale failures are automatically suppressed, but if verification was already complete before your re-signal, you may still receive the notification
- Do not re-signal repeatedly in quick succession — each re-signal cancels the previous one, wasting reviewer resources
