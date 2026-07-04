---
name: qa-spot
description: Post-merge-window QA spot check — boot the merged gateway from an ephemeral dir, drive the highest-risk recently-changed surfaces in a real browser, sweep for console errors, and fail loudly on any regression. Use after every merge window of the Fable refactor program, or whenever a batch of server/UI changes lands on aj-current.
argument-hint: [optional: extra surfaces to check, e.g. "focus on dialogs and settings"]
---

# QA Spot Check (program-side, thin wrapper over /qa-test)

Purpose: catch integration-level regressions that unit/e2e phases miss — wiring, boot, real-browser behavior — cheaply and repeatably as merge windows land. This is NOT the full QA protocol; it is a ~10-minute smoke pass.

## Protocol

1. **Fresh state**: follow `/qa-test` Steps 1–2 (ephemeral `WORK_DIR` via `mktemp -d`, NEVER inside the repo; seed via `scripts/qa-seed/seed.mjs`). Build first if `dist/` is stale (`npm run build`).
2. **Boot**: start the gateway with the component's `qa_start_command` (see `/qa-test` Step 1 for config discovery). Poll `qa_health_check` until ready. Any boot failure = FINDING (severity: blocker).
3. **Console-error sweep**: after EVERY navigation below, `browser_console_messages level="error"`. Any new console error = FINDING.
4. **Core smoke loop** (native browser tools, per `/qa-test` prerequisites):
   - Splash → create Quick Session → send a trivial prompt → streaming renders → reload → transcript persists.
   - Sidebar: sessions list, archived section renders.
   - Settings: opens; Models page renders; role manager list renders (model+thinking rows within bounds).
   - Goals: create a goal, dashboard renders, delete/cleanup.
   - Marketplace: page renders, pack rows + consent cards render.
5. **Recently-changed surfaces** (maintain this list per merge window; current as of the W1+W2 windows):
   - Escape on a confirm dialog while a stream is active → dialog closes, stream survives.
   - Settings → Claude Code: status card populates (GET /api/claude-code/status 200), refresh works; changing executable path prompts operator confirmation (403 without it).
   - Role manager: thinking-override rows (architect etc.) don't overflow; non-override rows unchanged.
   - Hindsight pack row in Marketplace: Configure path renders (memory provider loads — no "declares unknown hook" in server logs).
   - Server log sweep: `grep -iE "dropping|unknown hook|REFUSING|Failed to load" gateway log` → any hit = FINDING.
6. **Report**: append a dated entry to `~/Documents/dev/bobbit-fable-refactor/QA-LOG.md`: surfaces checked, pass/fail per item, FINDINGS with repro + severity. Every FINDING must become either an immediate fix PR or a tracked row in TRACKER.md — never silently logged.
7. **Teardown**: kill the gateway process, `rm -rf "$WORK_DIR"`.

## Escalation

Blocker findings (boot failure, data loss, dead core flow) → stop the merge train until fixed. Cosmetic/minor → tracked row, continue.
