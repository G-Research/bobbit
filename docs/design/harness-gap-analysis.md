# Harness gap analysis — OpenClaw, Hermes, Claude Code vs Bobbit

Status: research complete; roadmap not started. Feature/UX gaps only — **cost/token
efficiency is explicitly out of scope** here because
[time-and-token-cost-efficiency.md](time-and-token-cost-efficiency.md) §4 already covers the Claude Code /
Hermes comparison on that axis.

> **Execution authority** for the §5 quick wins (R2–R6, R9):
> [gap-easy-wins-implementation-plan.md](gap-easy-wins-implementation-plan.md).
> Sequencing: [fable-program-execution-plan.md](fable-program-execution-plan.md).

**The question this answers:** what do the strongest peer harnesses have that Bobbit lacks,
which of those Bobbit actually wants given its direction (the best harness out there —
extensible and fun for coders, researchers, and small-business owners alike), and which are
easy wins on substrate that already exists?

**The one-paragraph answer:** Bobbit's core — goals/workflows with verification gates, team
orchestration, worktree/sandbox isolation, packs/marketplace, and a real web UI — is ahead of
all three peers; nothing in their orchestration stories needs copying. The real gaps cluster
in four places: **(1) memory** — all three peers remember things across sessions
automatically; Bobbit only has per-staff memory and a search index nobody consults at prompt
time; **(2) the self-improvement loop** — Hermes reviews every turn for skill/memory updates
and runs a background curator; Claude Code ships background "dreaming" memory consolidation;
Bobbit has neither (→ [autoimprovement.md](autoimprovement.md)); **(3) reach** — OpenClaw
meets users in 30+ messaging channels with companion apps while Bobbit is a localhost web
app; **(4) ambient automation UX** — peers have one-shot reminders, away summaries, and
"standing orders" conventions on top of cron, where Bobbit has (good) staff triggers but
nothing above them. Several gaps are genuinely cheap because the substrate (staff, triggers,
inbox, packs, session search) already exists — the roadmap in §5 sequences the easy wins
first.

---

## §1 Method

Source study of three checkouts (2026-06-10/11):

| Harness | Repo / commit | Freshness |
|---|---|---|
| OpenClaw | `github.com/openclaw/openclaw` @ `2d404f1b` (2026-06-11) | current master |
| Hermes | `github.com/NousResearch/hermes-agent` @ `a8f404b` (2026-06-10) | current master |
| Claude Code | leaked-source mirror `github.com/yasasbanukaofficial/claude-code` @ `a371abb` (2026-04-05) | **~2 months stale** — findings cross-checked against public docs/changelog; anything load-bearing is flagged *(verify against current behavior)* |

File citations below are repo-relative within those checkouts. "Easy win" means: high user
value, ≤ a few days of work, and lands on an existing Bobbit substrate without new
architecture.

Bobbit baseline assumed known: goals/workflows/gates (`docs/goals-workflows-tasks.md`),
staff + triggers + inbox (`docs/staff-agents.md`, `docs/staff-triggers.md`), packs/marketplace
(`docs/marketplace.md`), session search (`src/server/search/`), sandbox/worktrees, the
planned extension platform ([extension-platform.md](extension-platform.md)).

---

## §2 Comparison matrix

✅ strong · 🟡 partial · ❌ absent. The right column says where the gap is handled.

| Axis | OpenClaw | Hermes | Claude Code | Bobbit | Disposition |
|---|---|---|---|---|---|
| Goal/workflow orchestration, verification gates | 🟡 Task Flow | 🟡 kanban/delegate | 🟡 coordinator mode, subagents | ✅ | Bobbit ahead — keep |
| Sandbox & worktree isolation | 🟡 | 🟡 Docker | 🟡 | ✅ | Bobbit ahead — keep |
| Plugin/extension ecosystem | ✅ 143 extensions + ClawHub | 🟡 skills + agentskills.io hub | 🟡 plugins | 🟡 packs (platform designed, landing) | Covered by extension-platform.md |
| Cross-session memory (automatic) | ✅ memory extensions + workspace files | ✅ MEMORY/USER.md + per-turn review | ✅ memdir + autoDream | ❌ (staff memory only; search unused at prompt time) | **G1** |
| Self-improving skills | 🟡 (static skills, hub) | ✅ per-turn review + curator | 🟡 autoDream (memory only) | ❌ | **G2** → autoimprovement.md |
| Scheduled automation | ✅ cron + heartbeat | ✅ cron jobs w/ skills | 🟡 | ✅ staff `schedule` triggers | parity |
| One-shot "remind me at" | ✅ `--at` | ✅ one-shot schedules | 🟡 | ❌ | **G3** (easy) |
| Ambient/idle automation (heartbeat, commitments) | ✅ heartbeat + inferred commitments | 🟡 idle-triggered curator | 🟡 autoDream gates | ❌ | **G3** |
| Standing orders / persistent authority | ✅ first-class docs/convention | 🟡 SOUL.md | 🟡 CLAUDE.md | 🟡 role/staff prompts (no convention) | **G4** (easy, docs+templates) |
| Away summary / catch-up | 🟡 tasks audit | ❌ | ✅ `awaySummary` (small-fast model) | ❌ (unread dots only) | **G5** (easy) → mission-control.md briefing |
| Messaging channels (Telegram/WhatsApp/…) | ✅ 30+ channels, pairing, access groups | 🟡 Discord/telephony tools | ❌ (terminal/IDE/web) | ❌ | **G6** (strategic) |
| Companion / fun layer | 🟡 | ❌ | ✅ `buddy` (species/rarities/stats) | ✅ bobbit sprites | parity; see §G7 |
| Config doctor / migrations | ✅ `openclaw doctor --fix` | 🟡 | 🟡 | ❌ | **G8** (medium) |
| Cross-harness import | ✅ `migrate-claude`, `migrate-hermes` extensions | ✅ openclaw skill imports | ❌ | 🟡 Claude-plugin compat planned | **G9** (easy, extends planned work) |
| Onboarding for non-coders | ✅ companion apps, first-run UX priority | 🟡 | ✅ `projectOnboardingState`, MagicDocs, PromptSuggestion | 🟡 add-project flow | **G10** → mission-control.md |
| Multi-model / aux-model routing | ✅ per-extension providers | ✅ auxiliary slots (curator, vision, compression…) | ✅ small-fast-model pattern | 🟡 per-role models | **G11** (covered partly by token-cost CE-G6) |
| Trajectory datagen for training | ❌ | ✅ batch runner + `trajectory_compressor.py` | ❌ | ❌ | out of scope (note only) |
| Voice / TTS | ✅ | 🟡 | ❌ | ❌ | future; rides G6 channels |

---

## §3 Per-gap analysis

### G1 — Automatic cross-session memory (HIGH value, M effort)

What peers do:

- **Hermes**: two bounded files — `MEMORY.md` (2,200 chars) + `USER.md` (1,375 chars) —
  injected as a frozen snapshot at session start (cache-safe), managed by the agent via a
  `memory` tool with add/replace/remove, and **fed by a per-turn background review fork**
  (`agent/background_review.py`) that asks "did the user reveal preferences/expectations
  worth saving?". Bounded size forces consolidation; usage % is shown in the header
  (`website/docs/user-guide/features/memory.md`).
- **Claude Code**: `memdir` auto-memory, `services/extractMemories` (per-session extraction),
  `services/SessionMemory`, and `services/autoDream` consolidation (G2).
- **OpenClaw**: workspace bootstrap files auto-injected every session (`AGENTS.md`, `SOUL.md`,
  `USER.md`, `MEMORY.md`, `IDENTITY.md`…) plus pluggable memory backends
  (`extensions/memory-core`, `memory-lancedb`, `memory-wiki`, `active-memory`).

Bobbit today: staff agents have pinned memory; sessions have nothing; the FlexSearch session
index exists but **nothing consults it at prompt time** (already identified as the provider
gap in extension-platform.md §2).

Disposition: the *retrieval* half is the extension platform's `session-memory` reference pack
— don't duplicate. The cheap, immediately-valuable half is **the Hermes-style bounded user
profile**: a global `USER.md`-equivalent (server-scoped, ~500 tokens, agent-managed via a
small tool, injected as a stable prompt section through the existing `PromptParts` assembly
in `src/server/agent/system-prompt.ts`). Frozen-snapshot semantics preserve the cache prefix
(matches Bobbit's existing cache discipline per time-and-token-cost-efficiency §1). The *writing* half
(when to save) belongs to the autoimprovement loop (→ autoimprovement.md §loop, "observe").

### G2 — Self-improving skills (HIGH value; the subject of its own doc)

Hermes is the reference implementation: per-turn background review with a tool whitelist
(`agent/background_review.py` — "most sessions produce at least one skill update"; patch-first
preference order; class-level umbrella skills) plus the idle-triggered **curator**
(`agent/curator.py`, `website/docs/user-guide/features/curator.md`): lifecycle
`active → stale → archived`, never-delete, pin/rollback/dry-run, tar.gz snapshots before every
pass, aux-model review. Claude Code's `autoDream` shows the gate discipline (time gate →
session-count gate → lock, forked subagent, first-class `DreamTask`). Full adopt/adapt/reject
analysis and Bobbit's design: **[autoimprovement.md](autoimprovement.md)**.

### G3 — One-shot triggers + ambient automation (easy win)

OpenClaw's automation taxonomy (`docs/automation/index.md`) distinguishes exact-time cron,
one-shot `--at`, **heartbeat** (flexible periodic batched checks with main-session context),
background-task ledger (`openclaw tasks list/audit`), and **inferred commitments** ("user
mentioned an interview → check in after"). Hermes cron jobs attach skills and persist per-job
output dirs (`cron/jobs.py`).

Bobbit has the staff `schedule` (cron) trigger and the inbox. Missing, in increasing effort:

1. **One-shot trigger** — `{ type: "schedule", config: { at: ISO } }` self-disabling after
   fire. Small change to `staff-trigger-engine.ts` + trigger editor UI. Unlocks "remind me /
   check on X at 5pm" via any staff. *(easy win)*
2. **Goal-event coverage** — triggers already cover `goal_created`/`goal_archived`; add
   `gate_failed` and `session_errored` push triggers (same dispatcher pattern,
   `goal-trigger-dispatcher.ts`) so system staff can react to failures. *(easy win)*
3. **Heartbeat-style digest** — not a new mechanism: a cron-triggered system staff whose
   prompt says "scan what changed; act only if needed" (→ mission-control.md Observer).
   Inferred commitments are deliberately **not** adopted as machinery — they're a prompt
   pattern for Global Staff, documented in the standing-orders template (G4).

### G4 — Standing orders convention (easy win, mostly docs)

OpenClaw's `docs/automation/standing-orders.md` formalizes *permanent operating authority*:
each program defines **Scope / Trigger / Approval gates / Escalation rules**, lives in
auto-injected workspace files, and pairs with cron for enforcement ("cron says when, standing
orders say what you may do"). This is precisely the right authoring convention for Bobbit
staff system prompts — and it's what makes the autoimprovement trust ladder legible.

Disposition: adopt as **convention + template, zero machinery**: a documented standing-order
template in `docs/staff-agents.md` (or a new `docs/standing-orders.md`), the staff-creation
assistant (`src/server/agent/staff-assistant.ts`) nudged to structure proposed prompts that
way, and the mission-control system-staff roster (mission-control.md §5) written in that
format from day one.

### G5 — Away summary / catch-up (easy win)

Claude Code's `services/awaySummary.ts` + `hooks/useAwaySummary.ts`: when the user returns
after a gap, a **small/fast model** (`getSmallFastModel()`) summarizes what happened while
they were away, seeded with session memory. Bobbit's equivalent surface already exists — the
staff inbox and unread dots — but nothing *synthesizes*. Disposition: the **Morning briefing /
Observer staff** in mission-control.md §"Added ideas" is the strategic home; a tactical
slice (per-session "while you were away" header when unread count is high, generated by a
cheap model) can ship independently and reuses the compaction-summary plumbing. *(easy win
for the tactical slice)*

### G6 — Channels (strategic; the "anyone, not just coders" play)

OpenClaw's moat: 30+ channel docs (`docs/channels/` — WhatsApp, Telegram, Signal, Discord,
Slack, iMessage, Matrix, SMS, Teams…), device pairing, per-group access controls, broadcast
groups, bot-loop protection. For Bobbit's small-business-owner audience this is the
difference between "a dev tool I open" and "an assistant I text".

Disposition: **channels as packs**, riding the extension platform — a channel is exactly a
pack `runtime` (long-lived supervised service) + `provider` (session bridge) per
extension-platform.md §3. Do not build bespoke channel code in core. Sequencing: after
extension-platform P5 (runtimes). First channel: **Telegram** (simplest bot API, no phone
pairing). The flight-recorder/notification-policy work in mission-control.md defines what
gets *pushed* to a channel. Not an easy win — listed for the roadmap because of strategic
weight.

### G7 — Fun/companion layer (parity, one borrowed idea)

Claude Code ships a full companion pet (`src/buddy/` — species, hats, eyes, **rarities with
weights, named stats**) — gamified identity for what Bobbit already does better with live
status sprites. Borrowed idea worth a note in mission-control.md: Bobbit accessories already
exist per staff/role; a light "collection" surface (which accessories your staff have earned)
is cheap delight. No goal proposed; tracked as an idea only.

### G8 — `bobbit doctor` (medium)

OpenClaw treats config drift as a first-class product problem: breaking config changes ship
with a doctor migration; `openclaw doctor --fix` detects old shapes, explains, backs up,
rewrites (VISION.md "Configuration compatibility"). Bobbit's config cascade
(`docs/internals.md`) has no equivalent; stale `.bobbit/config` shapes surface as runtime
errors. Disposition: a `bobbit doctor` CLI subcommand (checks: config schema, orphaned staff,
stale worktrees, pack integrity, state-dir locks) — natural pairing with the Caretaker staff
(mission-control.md), which can *run* doctor checks on schedule and inbox the findings.

### G9 — Cross-harness import (easy win, extends planned work)

OpenClaw ships `extensions/migrate-claude` and `extensions/migrate-hermes`; Hermes auto-uses
skills imported from OpenClaw (`~/.hermes/skills/openclaw-imports/`,
`tests/skills/test_openclaw_migration.py` shows hardening). Bobbit already plans Claude-plugin
compat in the marketplace ([pack-based-marketplace.md](pack-based-marketplace.md)); extend the
same staging-adapter seam (`marketplace-install.ts`) with **import adapters for Hermes skills
and OpenClaw workspace skills** (both are SKILL.md-shaped already). One adapter module per
format + fixture-pack tests. Grows the pack catalog for free.

### G10 — Onboarding (handled in mission-control.md)

Claude Code invests heavily here (`projectOnboardingState.ts`, `services/MagicDocs`,
`services/PromptSuggestion`, `outputStyles`); OpenClaw makes first-run UX a stated top
priority. Bobbit's answer is the Mission Control first-run flow (mission-control.md §1):
land in a chat that can set everything up. Output styles (tone/verbosity presets per
audience) are noted as a cheap follow-on — a role-prompt preset, no machinery.

### G11 — Auxiliary-model routing (note)

Hermes routes every side task (curator, vision, compression, session search) through named
`auxiliary.<task>` model slots with one picker UI. Bobbit has per-role models and the
token-cost plan adds a cheap summarizer (CE-G6.1). When autoimprovement lands its review/judge
passes, give them named aux slots from day one rather than hardcoding models — one config
surface, matching `per-role-model-overrides.md` conventions.

---

## §4 Things examined and deliberately not adopted

- **Inferred commitments as machinery** (OpenClaw) — prompt-pattern value without the
  false-positive machinery; folded into standing-orders templates (G4).
- **Trajectory datagen / model training** (Hermes `batch_runner.py`,
  `trajectory_compressor.py`) — out of charter for a harness; transcripts are already
  retained if this ever changes.
- **TUI parity** — peers are terminal-first; Bobbit's web UI is the differentiator. The cost
  is the battery discipline documented in
  [client-performance-battery.md](client-performance-battery.md).
- **Bespoke channel integrations in core** — channels arrive as packs or not at all (G6).

---

## §5 Prioritized roadmap

Easy wins first; each row names the owning doc/goal so this table stays a router, not a
second backlog.

| # | Item | Gap | Effort | Owner |
|---|---|---|---|---|
| R1 | Animation/timer battery fixes | — | S–M | [client-performance-battery.md](client-performance-battery.md) P1–P2 |
| R2 | One-shot (`at`) staff trigger + `gate_failed`/`session_errored` push triggers | G3 | S | new goal off this doc |
| R3 | Standing-orders template + staff-assistant nudge | G4 | S (docs) | new goal off this doc |
| R4 | "While you were away" summary slice (cheap model) | G5 | S–M | tactical slice; strategic home is mission-control.md briefing |
| R5 | Bounded global user-profile memory (Hermes USER.md pattern) | G1 | M | new goal; prompt-section + tool; coordinate with extension-platform `session-memory` |
| R6 | Hermes/OpenClaw skill import adapters | G9 | M | extends marketplace adapter seam |
| R7 | Mission Control core (global scope, meta-tool, system staff) | G3/G5/G10 | L | [mission-control.md](mission-control.md) |
| R8 | Autoimprovement loop (review, curator, trust ladder) | G2 | L | [autoimprovement.md](autoimprovement.md) |
| R9 | `bobbit doctor` | G8 | M | new goal; pairs with Caretaker staff |
| R10 | Telegram channel pack (first channel) | G6 | L | after extension-platform runtimes phase |
| R11 | Aux-model slots for review/judge passes | G11 | S (when R8 lands) | folded into autoimprovement phases |

Implementation notes for R2–R4 (the goals this doc owns directly, written to be executable
without re-deriving context):

- **R2**: extend `StaffTrigger` config union in `src/server/agent/staff-store.ts` with
  `{ at: string }` alongside `{ cron }`; `staff-trigger-engine.ts` fires once when
  `now >= at && !lastFired`, then sets `enabled: false`; trigger-editor UI on the staff edit
  page gains a datetime field; e2e test beside the existing trigger specs. For the push
  triggers, mirror the `goal_created` wiring in `goal-trigger-dispatcher.ts` from the gate /
  session-status mutation points, required-prompt rule included (`docs/staff-triggers.md`).
- **R3**: add the Scope/Trigger/Approval/Escalation template to `docs/staff-agents.md`; update
  the staff assistant's proposal guidance in `src/server/agent/staff-assistant.ts`; seed the
  mission-control pack roster (mission-control.md §5) in that format.
- **R4**: server: on session activation with unread count above threshold, run a
  cheap-model summarization over messages since `lastSeen` (reuse the compaction-summary
  path; aux-model slot per G11); client: collapsible "while you were away" banner above the
  transcript tail. Behind a setting; browser E2E for banner render + dismissal persistence.

R2 trigger contract (so implementation cannot drift): extend the `StaffTrigger` union with

```ts
{ type: "schedule"; config: { cron: string; timezone?: string } | { at: string /* ISO-8601 */ } }
{ type: "gate_failed";     config: {}; prompt: string }   // required prompt, like goal_created
{ type: "session_errored"; config: {}; prompt: string }
```

`at` semantics: fire once when `now >= at && !lastFired`, then set `enabled: false` (record
kept for audit). Push triggers dispatch from the gate-failure and session-error mutation
points via `goal-trigger-dispatcher.ts`, mirroring `goal_created` exactly (including the
required-prompt validation in `docs/staff-triggers.md`).

Execution tracking for every row above: [fable-program-execution-plan.md](fable-program-execution-plan.md).
