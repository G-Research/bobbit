# Gap-Analysis Easy Wins — Implementation Plan (hand-off)

Status: ready for execution, not started. Workstream **GA** in
[fable-program-execution-plan.md](fable-program-execution-plan.md).

Companion to [harness-gap-analysis.md](harness-gap-analysis.md) (the WHAT/WHY — read the
owning G-section for each goal; §5 holds the R2 trigger schema, which is LAW).

> **Anchor baseline:** fable-docs @ 2026-06-11 (master parent `6ec8c8f9`). Locate by symbol
> name; missing symbol ⇒ STOP, re-derive from the cited pattern.
>
> **Universal rules:** [extension-platform-implementation-plan.md §0](extension-platform-implementation-plan.md)
> + [fable-program-execution-plan.md §1](fable-program-execution-plan.md). GA-R2 is a
> **shared seam** (MC-P4 and AI-P1 consume its triggers) — it lands here, exactly once.

Goals are independent unless stated; R2 and R3 are Day-1 starters.

---

## GA-R2 — One-shot `at` trigger + `gate_failed`/`session_errored` push triggers

**Outcome:** any staff can fire once at an ISO time, and react to gate failures / session
errors, per the schema in harness-gap-analysis.md §5 (verbatim — field names included).

**Owned files:** `src/server/agent/staff-store.ts` (`StaffTrigger` config union),
`src/server/agent/staff-trigger-engine.ts` (`TriggerEngine`, schedule eval near `:220`),
`src/server/agent/goal-trigger-dispatcher.ts` (`GoalTriggerDispatcher`, symbol at `:30`),
the gate-failure + session-error mutation points (located in step 3), staff edit page
trigger editor (`src/app/staff-page.ts`); NEW `tests/staff-trigger-at.test.ts`,
`tests/staff-trigger-push.test.ts`; extend the staff-triggers e2e suite;
`docs/staff-triggers.md` (table rows).

**Steps**

1. **`at` one-shot.** Extend the `schedule` trigger config union with `{ at: string }`
   (ISO-8601). In `TriggerEngine`'s schedule evaluation (the branch that currently
   requires `trigger.config.cron` — `if (!trigger.config.cron) return false;` near
   `:220`): when `at` is present instead, fire iff `now >= at && !lastFired`, then set
   `enabled: false` on the trigger record (kept for audit, per the §5 contract). Invalid
   `at` (unparseable / cron+at both set) ⇒ reject at PUT-validation time, not silently at
   eval time.
2. **Trigger editor UI:** the staff edit page's schedule row gains a cron-vs-datetime
   choice (native `datetime-local`, serialized to ISO UTC). Disabled-after-fire state
   renders with a "fired <ts>" hint.
3. **Push triggers.** Read how `GoalTriggerDispatcher` wires `onGoalCreated`/
   `onGoalArchived` from `GoalStore.put`/`archive` (`docs/staff-triggers.md` §"Why push,
   not poll"), then mirror it exactly for: (a) `gate_failed` — from the gate
   verification-result mutation point (find the single place a gate step transitions to
   failed in the verification harness; the human-signoff doc §1 names the step types);
   (b) `session_errored` — from the session-status write where status becomes `errored`
   (**`session-manager.ts` is a §1.4 shared seam** — confine to the status-transition
   function, coordinate with CS merge order). Both types require a `prompt`
   (the `goal_created` required-prompt rule — same validation path).
4. Docs: add both rows + the `at` variant to the `docs/staff-triggers.md` type table.

**Tests (author first; RED):** `at` fires once with a fake clock, then `enabled === false`
and never re-fires; `at` in the past at creation fires on next tick exactly once;
cron+at rejected; push: gate-fail fixture enqueues one inbox entry with the trigger's
prompt; re-failing the same gate re-fires (each transition is an event); prompt-less push
trigger rejected at PUT. E2E: editor round-trip (create `at` trigger → reload → fired
state visible).

**Acceptance:** new + existing trigger/inbox suites green; `docs/staff-triggers.md`
updated in the same PR.

---

## GA-R3 — Standing-orders convention (docs + assistant guidance)

**Outcome:** a documented Scope/Trigger/Approval-gates/Escalation template, and the staff
creation assistant proposes prompts in that shape.

**Owned files:** `docs/staff-agents.md` (new §"Standing orders"); the staff assistant's
guidance text in `src/server/agent/staff-assistant.ts`; NEW assertion in the staff
assistant's existing test coverage.

**Steps:** (1) add the template + one filled example (the gap doc §G4 anatomy, adapted to
a Bobbit staff prompt) to `docs/staff-agents.md`; (2) extend the assistant's
system-prompt guidance: proposed `systemPrompt`s for recurring/triggered staff SHOULD
follow the four-section template (do not hard-fail free-form prompts); (3) the
mission-control pack roster (MC-P4a) consumes this format — note it there, build nothing
for it here.

**Tests:** assistant prompt-text pin (the guidance mentions the four section names);
docs link-check. **Acceptance:** S-size PR, no behavior change beyond assistant guidance.

---

## GA-R4 — "While you were away" summary slice

**Outcome:** opening a session with a large unread backlog shows a collapsible
cheap-model summary banner above the transcript tail. Off by default (setting).

**Owned files:** server summarizer endpoint (reuse the compaction-summary generation path
— locate via `docs/compaction.md` / `compaction-history.md` before writing anything new);
`auxiliary.away-summary` model slot (**shared `auxiliary.*` seam — §1.4: reuse the shape
the first lander defined; if none landed yet, this PR defines it per
[per-role-model-overrides.md](per-role-model-overrides.md)**); client banner component in
the chat header area; settings toggle; NEW `tests/e2e/ui/away-summary.spec.ts`.

**Steps:** (1) `GET /api/sessions/:id/away-summary?since=<lastSeen>` — summarizes messages
since `since` with the aux model, returns `{summary, messageCount}`; hard cap input via
the existing truncation helper (`truncate-large-content.ts`); (2) client: when the
setting is on and unread count ≥ threshold (default 10), fetch + render collapsible
banner; dismissal stores per-session; (3) never block transcript render on the fetch.

**Tests:** API e2e with mock model (deterministic stub summary); browser E2E — banner
renders over threshold, absent under, dismissal survives reload, setting-off ⇒ no fetch
(network spy). **Acceptance:** zero added latency to session open (banner is async);
suites green.

---

## GA-R5 — Bounded global user-profile memory *(coordinate with EP `session-memory`)*

**Outcome:** a Hermes-style bounded user profile (~500 tokens) injected as a stable prompt
section into every session, agent-managed via one tool.

**Owned files:** NEW `src/server/agent/user-profile-store.ts`
(`.bobbit/state/user-profile.md`, char-capped 1,375 like Hermes USER.md); prompt section
via `system-prompt.ts` `PromptParts` (the byte-budget pattern —
`buildSkillsCatalogSection`/`skillsCatalogBudget`, §0.1 patterns library); NEW
`defaults/tools/memory/user_profile.yaml` (+ group extension) with
`add/replace/remove` actions (substring matching, Hermes semantics per gap doc §G1);
NEW tests (store cap/round-trip; prompt-section budget pin; tool e2e).

**Steps:** (1) store with frozen-snapshot semantics — section text captured at session
start, mid-session writes persist but don't mutate the live prompt (cache discipline,
gap doc §G1); (2) section renders with usage % header exactly like the Hermes format so
the agent knows capacity; (3) **coordination rule:** if EP G1.6 (`session-memory` pack)
has landed, this section must register through the provider path instead of a hardcoded
`PromptParts` entry — check the EP checklist first; the store + tool are identical either
way. **Acceptance:** profile survives restart; over-cap add returns a "consolidate first"
error to the tool, never truncates silently; prompt-sections inspector shows the block
with provenance.

---

## GA-R6 — Hermes/OpenClaw skill import adapters

**Outcome:** `bobbit` can import a Hermes skill dir (`~/.hermes/skills/...`) or an
OpenClaw workspace skill as a pack, via the marketplace's existing staging seam.

**Owned files:** the staging-adapter seam in
`src/server/agent/marketplace-install.ts` (the same insertion point the Claude-plugin
adapter uses per [pack-based-marketplace.md](pack-based-marketplace.md) — read that first);
NEW `src/server/agent/skill-import-adapters.ts` (two pure functions:
`adaptHermesSkill(dir) → staged pack tree`, `adaptOpenclawSkill(dir) → staged pack tree`);
fixture skills under `tests/fixtures/`; NEW `tests/skill-import-adapters.test.ts` + one
marketplace e2e install case per format.

**Steps:** both formats are SKILL.md-shaped (gap doc §G9); map: SKILL.md → pack skill
entity; `references/`/`scripts/`/`templates/` → carried verbatim; name collisions →
standard pack-precedence rules (no special-casing). Reject (with a clear error) skills
whose SKILL.md frontmatter is missing required fields rather than guessing.
**Acceptance:** fixture imports install/uninstall cleanly; imported skill resolvable and
`pack_activation`-toggleable; malformed fixture rejected with actionable message.

---

## GA-R9 — `bobbit doctor`

**Outcome:** a CLI subcommand that detects-and-explains (default) and repairs (`--fix`)
known state/config drift, OpenClaw-doctor style (gap doc §G8).

**Owned files:** NEW `src/server/cli/doctor.ts` wired into the existing CLI entry (find
how `run`/`run.cmd` dispatch subcommands first); NEW `tests/doctor.test.ts`.

**Steps:** v1 checks (each = `{id, severity, explain, canFix}`): (1) orphaned staff
records (reuse the orphan-detector logic — import, don't duplicate); (2) stale worktrees
(worktree-pool list vs git state, reuse `orphan-remote-branch-cleanup` machinery's
read side); (3) pack integrity (`.pack-meta.yaml` vs source manifest); (4) config keys
unknown to the current schema (report-only, never delete); (5) state-dir lock files older
than 24 h. `--fix` applies only `canFix` items, **always backing up the touched file to
`.bobbit/state/doctor-backups/<ts>/` first**; `--dry-run` = default behavior. Output:
human table + `--json`. **Tests:** one seeded-breakage fixture per check, assert
detect → fix → re-run clean → backup exists. **Acceptance:** `bobbit doctor` on a healthy
state dir exits 0 with "no findings"; Caretaker integration is explicitly OUT of scope
(future MC follow-up).
