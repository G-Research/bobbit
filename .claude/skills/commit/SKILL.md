---
name: commit
description: Stage all changes, generate a commit message from the diff, and commit. Optionally push.
argument-hint: [push]
---

Commit the current changes with an auto-generated message.

## Steps

1. Run `git add -A` to stage all changes
2. Run `git diff --cached --stat` to see what changed
3. Run `git diff --cached` to read the full diff
4. Write a concise, conventional-commits-style commit message based on the diff:
   - Use the format: `type: summary` (e.g. `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`)
   - First line under 72 characters
   - Add a blank line then bullet points for notable details if the change is non-trivial
   - Do NOT pad or over-explain — be direct
5. Run `git commit -m "<message>"`
6. If the argument is "push", also run `git push`

## Rules

- If there are no staged changes after `git add -A`, say so and stop.
- Never amend a previous commit — always create a new one.
- Do not ask for confirmation — just commit.
