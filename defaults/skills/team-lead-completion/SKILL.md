---
name: team-lead-completion
description: Exact command sequence for finishing a team-lead goal - merging master, pushing, PR creation/detection, signaling ready-to-merge, and team_complete
---

# Team-Lead Completion Sequence

Part of the VER-03/F8 team-lead persona diet (`BOBBIT_LEAN_TEAM_LEAD=1`). Your
resident prompt already states the outcome (mandatory PR, never merge it
yourself, signal `ready-to-merge`, then `team_complete`). This is the exact
step-by-step command sequence.

When all implementation/review/documentation gates have passed, prepare for
the `ready-to-merge` gate:

1. **Merge master into the goal branch** so it is up-to-date and conflict-free:
   ```
   git fetch origin master
   git merge origin/master
   ```
   If there are conflicts, resolve them (or spawn a coder to resolve them), then run targeted type-check/unit checks covering the conflicted or modified areas. Do not duplicate full-suite workflow verification just for merge confidence.

2. **Push the goal branch**: `git push origin <goal-branch>`
   - **First check the branch's PR is not already merged**: `gh pr list --head <goal-branch> --state all` — if it lists a `MERGED`/`CLOSED` PR, do NOT re-push the merged branch (the commits would be orphaned). Instead detect the primary branch (`git symbolic-ref refs/remotes/origin/HEAD`; never assume master/main), create a fresh branch off `origin/<primary>`, move the new work onto it, push that, and open a **new** PR.

3. **Create a pull request** — this is **mandatory**, not optional:
   - Check for `gh` CLI: `which gh`
   - If `gh` is available: `gh pr create --title "<goal title>" --body "<work summary>" --head <goal-branch>`
   - If `gh` is NOT available: Tell the user to create the PR manually. Provide the branch name, suggested title, and a summary of changes.
   - **Do NOT merge the PR under any circumstances.** Leave it for human review.

4. **Signal the `ready-to-merge` gate** via `gate_signal`. The verification will confirm that master is merged, the branch is pushed, and the PR exists. Wait for it to pass.

5. Call `team_complete` to dismiss all role agents and mark the goal done.

6. **Stay idle and await further instructions.** Do NOT terminate yourself.

Note: The goal dashboard automatically generates a visual summary of all
tasks, gates, and progress — you do NOT need to produce an HTML report.
