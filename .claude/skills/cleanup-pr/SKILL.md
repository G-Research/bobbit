---
name: cleanup-pr
description: Rebase a PR branch onto the primary branch, resolve any merge conflicts, and force-push to get it ready for merge.
argument-hint: [branch-name]
---

Get a PR branch ready for merge by rebasing it onto the primary branch and resolving any conflicts.

## Steps

1. Determine the primary branch: run `git symbolic-ref refs/remotes/origin/HEAD` and extract the branch name.
2. Determine the PR branch:
   - If $ARGUMENTS is provided, use that as the branch name.
   - Otherwise, run `gh pr view --json headRefName -q .headRefName` to get the current PR's branch.
3. Run `git fetch origin` to get the latest state.
4. Check out the PR branch: `git checkout <pr-branch>`
5. Rebase onto the primary branch: `git rebase origin/<primary-branch>`
6. If there are merge conflicts:
   - For each conflicted file, read the file, understand both sides of the conflict, and resolve it intelligently — preserve the intent of both the PR changes and the upstream changes.
   - After resolving each file, `git add <file>`.
   - Run `git rebase --continue`. Repeat if more conflicts arise.
7. Run `npm run check` to verify the resolved code compiles.
8. If type-check fails, fix the issues and amend the last commit.
9. Force-push: `git push --force-with-lease`
10. Report what was done: how many conflicts were resolved, which files, and whether the build passes.

## Rules

- Never delete or drop commits — always rebase, never squash unless asked.
- Resolve conflicts by understanding the intent of both sides, not by picking one side blindly.
- If a conflict is genuinely ambiguous (e.g. both sides rewrote the same function differently), explain what you chose and why.
- Always verify the build passes before pushing.
