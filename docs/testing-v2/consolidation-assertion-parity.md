# Consolidation Assertion-Parity Audit — 151 `legacy-pending` browser specs

**Task:** 92adf324 · **Scope:** every `tests2/tests-map.json` entry with `method: "legacy-pending"`
(151 legacy browser E2E specs consolidated into smoke journeys). For each legacy spec this audit
compares its meaningful assertions against the assertions actually present in its replacement
journey and classifies coverage as **COVERED / PARTIAL / GAP**.

This is a **read-only audit** — no test files were edited. It is the input to the coverage-parity
gate (requirement 3: "every retired test mapped" + no assertion regression). The `replacementNote`
on nearly all these entries already admits *"journey covers navigation/smoke only — behavioral
assertions pending"*; this document quantifies exactly which assertions are pending and what to add.

## Classification key

| Class | Meaning |
|-------|---------|
| **COVERED** | Journey asserts the same core behaviours (equivalent or stronger), OR the legacy file is an intentionally-empty / `describe.skip` stub with no live assertions to preserve. |
| **PARTIAL** | Journey touches the feature (navigation / one happy-path assertion) but omits specific behavioural assertions the legacy spec pins. |
| **GAP** | Journey does not meaningfully verify the legacy spec's behaviour at all (route-smoke only, or the feature is never exercised). |

## Headline counts

| | Count | % of 151 |
|---|------:|------:|
| **COVERED** | 8 | 5.3% |
| **PARTIAL** | 36 | 23.8% |
| **GAP** | 107 | 70.9% |
| **Total** | **151** | 100% |

**Interpretation:** the consolidation journeys currently deliver *navigation/shell smoke* for these
domains but have **not** yet ported the behavioural assertions. 143 of 151 specs (PARTIAL+GAP) still
carry assertions not reproduced in v2. Per requirement 3 ("per-area coverage ≥ baseline; every
retired test mapped") and the constraint "never weaken/skip/delete an assertion to meet a budget",
**these 143 specs must not be retired until their assertions are ported** — the mapping's
`tier: "retired"` transition is blocked for them. The 8 COVERED are safe to retire (6 are already
empty stubs migrated to fixtures; 2 are equivalently covered).

## Per-journey summary

| Replacement journey | Legacy specs | COVERED | PARTIAL | GAP |
|---|---:|---:|---:|---:|
| `journeys/app-smoke.journey.spec.ts` | 20 | 0 | 3 | 17 |
| `journeys/bg-wait-multi-repo.journey.spec.ts` | 6 | 0 | 2 | 4 |
| `journeys/goal-editing.journey.spec.ts` | 8 | 0 | 6 | 2 |
| `journeys/goal-team-gates.journey.spec.ts` | 1 | 0 | 1 | 0 |
| `daily/crash-restart.journey.spec.ts` | 4 | 0 | 0 | 4 |
| `journeys/marketplace-packs.journey.spec.ts` | 8 | 0 | 1 | 7 |
| `journeys/misc.journey.spec.ts` | 17 | 1 | 3 | 13 |
| `journeys/project-onboarding.journey.spec.ts` | 13 | 1 | 1 | 11 |
| `journeys/project-settings.journey.spec.ts` | 9 | 0 | 1 | 8 |
| `journeys/prompt-interaction.journey.spec.ts` | 11 | 0 | 2 | 9 |
| `journeys/proposals.journey.spec.ts` | 10 | 0 | 2 | 8 |
| `journeys/sidebar-nav.journey.spec.ts` | 20 | 6 | 2 | 12 |
| `journeys/staff-debug.journey.spec.ts` | 8 | 0 | 2 | 6 |
| `journeys/stories-registry.journey.spec.ts` | 8 | 0 | 3 | 5 |
| `journeys/team-operations.journey.spec.ts` | 8 | 0 | 7 | 1 |
| **Total** | **151** | **8** | **36** | **107** |

## Cross-cutting observations & priority recommendations

1. **Scope mismatches (specs mapped to the wrong journey).** Several specs were bucketed into a
   journey whose domain does not match the spec's behaviour, so a "GAP" here is really a
   *re-mapping* action, not a journey extension:
   - `skill-multifile.spec.ts`, `skills-chip.spec.ts` → mapped to `marketplace-packs` but test
     skill-chip/activation UI. Re-map to a **skills journey**.
   - `per-project-native-yaml-fields.spec.ts`, `remove-first-project.spec.ts`,
     `splash-multi-project.spec.ts`, `splash-no-projects.spec.ts` → mapped to
     `project-onboarding` but test settings-editing / splash-recovery. Re-map to
     project-settings / a splash journey.
   - `session-prompt-grant-replay`, `tool-assistant-system-scope`, the three
     `steer-during-bash-tool*` env-flag repros → belong to permission/steer-abort suites, not the
     `prompt-interaction` smoke.
   Update `tests-map.json` `replacement[]` for these before porting assertions.

2. **Whole domains have zero behavioural coverage in v2** and are the highest-risk retirements:
   - **crash-restart / resilience** (dormant-revive, preparing-UX, push-sync, status-resync,
     stories-resilience RE-07) — no in-place revive, live post-revive delivery, or
     message-survives-disconnect assertions.
   - **streaming lifecycle & steer/queue/abort** (stories-streaming, queue-ui, escape-aborts,
     steer-during-bash-tool ×3) — no stop-button/queue-pill/abort/dedup assertions anywhere in v2.
   - **workflow editor**, **gate bypass**, **goal-proposal metadata/roles/workflow tabs** — large
     surfaces reduced to app-shell smoke.
   - **sidebar session-actions** (create/rename/terminate), **refresh-agent**, **tree-restart**,
     **unified-tree keyboard nav** — the sidebar journey highlights rows but never mutates.

3. **`team-operations` is the closest to parity** (7 PARTIAL, 1 GAP): the journey renders the cards
   but omits reload persistence, reject/409-failure regressions, live WS gate-status flips, and
   archived-pill / awaiting-signoffs attributes — mostly one-or-two-assertion additions per file.

4. **`goal-editing` (6 PARTIAL) is also near-parity**: default-value, PUT-persistence-across-reload,
   and proposal-panel per-goal-control assertions are the recurring omissions.

5. **Persistence-across-reload and server-sourced-state assertions are the single most common
   omission** across every group (draft persistence, toggle persistence, dismissal fingerprints,
   `lastReadAt` server-backed read state). Any journey ports should include the reload leg.

---

# Detailed findings

Each entry: **CLASS** — *legacy assertions* / *journey covers* / **REC** (concrete assertions to add).

## `journeys/app-smoke.journey.spec.ts` — 0 COVERED / 3 PARTIAL / 17 GAP

- **`base-ref-detect.spec.ts` — GAP.** Legacy: blank base_ref → input "" + placeholder
  "origin/master" + `base-ref-using` shows resolved fallback; "Detect from remote" fills input; Save
  (PUT 200) persists across reload. Journey: only that `#/settings/system/general` is navigable.
  **REC:** settings-scoped test with a bare origin/master remote — assert placeholder, `base-ref-using`,
  `base-ref-detect` click fills input, Save + reload persists.
- **`base-ref-settings.spec.ts` — GAP.** Legacy: happy-path persist "origin/develop" across reload +
  4 inline validation errors (tag rejection, grammar, sandbox-local remote, multi-repo missing with
  per-repo `<li>`), typing clears stale error. Journey: nothing. **REC:** port persistence + at least
  one validation-error row (`base-ref-error` text + clear-on-type).
- **`copy-session-link.spec.ts` — PARTIAL.** Legacy: clipboard == `${origin}/session/<id>`,
  "Link copied" toast, survives reload, deep-link path canonicalizes to `/#/session/<id>`. Journey:
  only asserts a copy button/`session-actions-trigger` present; clipboard test is `test.skip`.
  **REC:** grant clipboard perms, assert clipboard value + `header-toast`, plus a path→hash
  canonicalization check.
- **`draft-loss.spec.ts` — PARTIAL.** Legacy: 4 race scenarios incl. immediate-hard-reload
  beforeunload/sendBeacon flush and delayed-stale-server-restore not clobbering a fresh draft
  (PR #830 gen-reseed). Journey: plain A→B→A switch, normal reload, A↮B isolation. **REC:** add the
  same-tick-hard-reload flush and the stale-restore-convergence scenarios.
- **`git-status-untracked-race.spec.ts` — GAP.** Legacy: git dropdown shows untracked file, requests
  `?fetch=true&untracked=1`, late summary-only refresh must not hide it; dashboard dropdown likewise.
  Journey: nothing. **REC:** route-mock git-status widget, assert `untracked=1&fetch=true` request +
  untracked file retained after late refresh.
- **`github-trusted-hosts.spec.ts` — GAP.** Legacy: add/remove trusted GitHub host persists via PUT
  /api/preferences across reload; invalid input rejected. Journey: settings body only. **REC:** port
  add→persist→remove + invalid-input rejection against `github-trusted-host-*`.
- **`goal-metadata.spec.ts` — GAP.** Legacy: unified proposal tabs; metadata editor only on Metadata
  tab; manual rows JSON-parsed + persist across reload; empty-key sends no override; agent-seeded
  metadata mirrored/edited/removed; legacy worktree-setup controls gone. Journey: nothing. **REC:**
  large distinct feature — keep as its own spec or a dedicated metadata journey; do not treat
  app-smoke as its replacement.
- **`goal-proposal-offscreen-return.spec.ts` — GAP.** Legacy: off-screen `propose_goal` restored on
  return via 3 paths (switch-back, fresh WS, reload); stale-draft race doesn't drop it; dismissed
  stays hidden; no cross-session leak. Journey: nothing. **REC:** dedicated proposal-restore journey;
  out of app-smoke scope.
- **`local-only-policy-status.spec.ts` — GAP.** Legacy: team member git-status
  `remotePublication=="local-only-policy"` + branch pattern; UI shows `git-local-only-policy`;
  terminate archives with no remote branch. Journey: nothing. **REC:** keep as own spec (needs real
  team spawn + git).
- **`mid-session-project-proposal.spec.ts` — GAP.** Legacy: `project_proposal` → Project tab
  registered-mode panel; "Apply Changes" writes config via PUT + persists; Dismiss clears without
  writing; Settings reflects accepted config without reload. Journey: nothing. **REC:** dedicated
  project-proposal journey.
- **`new-tab-no-duplicate-messages.spec.ts` — GAP.** Legacy: opening a 2nd tab + `visibilitychange`
  keeps assistant reply count exactly 1 (3 round-trips still 1). Journey: nothing. **REC:** dedup
  regression test (send prompt, open 2nd page, dispatch visibilitychange, assert exactly one reply).
- **`notification-policy.spec.ts` — GAP.** Legacy: standalone idle session shows `.unseen-dot`;
  team-member suppresses it; team-lead complete shows / in-progress+streaming hides; reload matches
  server `lastReadAt`. Journey: nothing. **REC:** at least standalone-dot + mark-read persistence.
- **`open-session-new-window.spec.ts` — GAP.** Legacy: actions popover "Open in new window" →
  `window.open(deepLink,"_blank","noopener")`; middle-click opens deep link without changing active
  session. Journey: nothing. **REC:** stub `window.open`, assert captured `{url,target,features}` +
  auxclick-button-1 leaves active session unchanged.
- **`page-title.spec.ts` — PARTIAL.** Legacy: `document.title` matches `/.+ · Bobbit$/`. Journey:
  only that title is non-empty. **REC:** strengthen to assert the `· Bobbit` suffix / project name.
- **`palette-session.spec.ts` — GAP.** Legacy: ocean-palette project + session →
  `documentElement.dataset.palette === "ocean"` (no refreshSessions revert). Journey: nothing.
  **REC:** create ocean-palette project+session, navigate, `waitForFunction` on `data-palette`.
- **`project-palette-none.spec.ts` — GAP.** Legacy: per-project Appearance None↔Ocean swaps Active +
  `data-palette` + auto-seeds/reset accent colours; persists across reload incl. oklch labels.
  Journey: nothing. **REC:** port the None-clears-override flow with reload persistence.
- **`replace-bobbit-text.spec.ts` — GAP.** Legacy: toggle swaps `bobbit-blob__sprite` canvas for
  `.bobbit-blob-text` (aria-label ∈ Idle/Busy/…); row order; persists + reverts. Journey: nothing.
  **REC:** port sprite↔text swap + order + reload + revert.
- **`repro-h3-snapshot-live-interleave.spec.ts` — GAP.** Legacy: mid-stream resync races — 8 rapid
  prompts each 1 reply; WS drop+reconnect loses no rows; two tabs converge. Journey: nothing.
  **REC:** keep as own reducer-race spec (out of smoke scope).
- **`sidebar-keyboard-nav.spec.ts` — GAP.** Legacy: Ctrl/Cmd+Arrow walks `data-nav-id` rows in DOM
  order, wraps first↔last, routes goal/session destinations. Journey: only `.sidebar-edge` visible.
  **REC:** seed project+goal+session, assert `data-nav-active` walk/wrap/route.
- **`tree-cost-rollup.spec.ts` — GAP.** Legacy: dashboard `tree-cost-row` + expandable
  `tree-cost-breakdown` (bounded scroll); row stays when children archived; `/tree-cost` roots at
  subgoal (strictly-decreasing totals, breakdown excludes ancestors); legacy-zero child muted-italic
  "(legacy)". Journey: nothing. **REC:** keep as own spec (needs goal tree + cost seeding).

## `journeys/bg-wait-multi-repo.journey.spec.ts` — 0 COVERED / 2 PARTIAL / 4 GAP

- **`bg-process-persistence.spec.ts` — GAP.** Legacy: bg process streams across gateway
  crash+restart, re-attaches live, captures exit code 0, dismiss purges persisted files across
  reload+restart; killed→exited pill survives restart. Journey: only GET /bg-processes → [] for a
  fresh session. **REC:** restart-harness journey (create real bg proc, streaming resumes after
  restart, exitCode captured, dismiss purges) — or keep the legacy spec.
- **`bg-wait-no-dup.spec.ts` — GAP.** Legacy: exactly one `bash_bg` card during a parked wait
  (BG_WAIT_NOID/END_ONLY); reducer entry stamped `synth:tc:<toolCallId>`. Journey: nothing. **REC:**
  BG_WAIT_NOID step asserting `countBashBgCards===1` + synthetic id.
- **`bg-wait-steer-flow.spec.ts` — PARTIAL.** Legacy: clicking Steer aborts a parked wait
  (aborted:true, timedOut:false, elapsed<3000, proc still running) + steered message renders.
  Journey: queue-pill + steer button appear and pill vanishes. **REC:** spawn bg proc, park wait,
  assert Steer → aborted:true/timedOut:false, proc running, steered text rendered.
- **`bg-wait-steer-stop-flow.spec.ts` — PARTIAL.** Legacy: Steer-then-Stop → steered text is exactly
  ONE user-message (no abort-drain dup), no queue pill. Journey: steer clears the pill only. **REC:**
  add Stop-after-Steer + `toHaveCount(1)` + zero queue pills after idle.
- **`multi-repo-flow.spec.ts` — GAP.** Legacy: Settings→Components lists 3 (api/web/shared incl.
  data-only hint); edit+Save→"Saved."+persists; delete data-only → count 2 → API ["api","web"].
  Journey: only `#/settings/projects` reachable. **REC:** register multi-repo project, assert
  component count 3, data-only hint, edit+save+reload, delete→2.
- **`session-git-status-multi-repo.spec.ts` — GAP.** Legacy: polyrepo widget aggregated pill
  ("3 changed across 2 repos", ↑3, +15), per-repo sections, clean collapse, per-repo diff
  (`?repo=api`), pill survives reload. Journey: nothing. **REC:** route-mock multi-repo git-status,
  assert aggregate label + summed segments + per-repo sections + diff request + reload.

## `journeys/goal-editing.journey.spec.ts` — 0 COVERED / 6 PARTIAL / 2 GAP

- **`goal-archive-always-on.spec.ts` — PARTIAL.** Legacy: sidebar trash-icon archive (cancel
  preserves route, confirm archives + reload); team-active modal copy ("Stop team and archive") +
  teardown; dashboard Archive → read-only banner + disabled button; cascade "Archive goal &
  descendants". Journey: only dashboard Archive→confirm→`archived===true`. **REC:** add sidebar-row
  archive (cancel/confirm route preservation), team-active modal copy + teardown, cascade, post-archive
  read-only banner, absent-from-sidebar after reload.
- **`goal-creation.spec.ts` — PARTIAL.** Legacy: assistant Create Goal → navigate to dashboard + goal
  via API; assistant panel has NO Dismiss; optional-steps toggle persists `enabledOptionalSteps`
  contains "QA testing" in both panels; proposal panel HAS Dismiss (hides title). Journey: only
  API-created goal appears in list + sidebar. **REC:** assistant-flow navigation + `enabledOptionalSteps`
  assertion + Dismiss presence/absence.
- **`goal-empty-workflows-banner.spec.ts` — PARTIAL.** Legacy: empty banner + Create Goal disabled +
  "Open Project Assistant" POSTs /api/sessions (assistantType project) + hash swap. Journey: banner +
  text + Create disabled. **REC:** assert the open-project-assistant POST + session-id change.
- **`goal-form-tooltips.spec.ts` — PARTIAL.** Legacy: ⓘ tooltip with title `/QA agent/i` +
  `/ephemeral server/` + classes `text-[9px]`/`text-muted-foreground`. Journey: ⓘ visible with
  cursor-help. **REC:** add title-attribute + class assertions.
- **`subgoal-existing-goal-settings.spec.ts` — GAP.** Legacy: on subgoalsAllowed:false parent,
  Children tab toggle persists true (operator-cookie PATCH, not 403), reflects live+reload, then child
  201; stale too-low maxNestingDepth clamps to 2. Journey: only Children tab visible + API accepts
  parentGoalId. **REC:** dashboard enable-toggle test + stale-depth clamp variant.
- **`subgoal-nesting-limit.spec.ts` — PARTIAL.** Legacy: stepper default "3", edit→"2" PUTs
  /api/preferences, persists reload, `dataset.maxNestingDepth==="2"`; disabled when flag off. Journey:
  visible+enabled / disabled-when-off. **REC:** add default-value + edit-persist-reload + dataset.
- **`subgoal-parent-picker-repro.spec.ts` — GAP.** Legacy: ineligible parent marked
  disabled/"(sub-goals off)", eligible unmarked; attach/host sections separated;
  `goal-form-parent-ineligible-warning`; max-depth bounded by parent cap; submit forwards clamped
  depth. Journey: only basic parentGoalId link (eligibility test is `test.skip`). **REC:** un-skip/port
  the picker eligibility + section separation + cap-binding + clamped-submit.
- **`subgoals-experimental-toggle.spec.ts` — PARTIAL.** Legacy: defaults OFF when unset (dataset
  "false" + reload); ON-path flip + PUT + reload; proposal-panel per-goal controls (toggle, max-depth,
  max-concurrent-children, divergence, aria-pressed) when ON, hidden when OFF; Sub-goals tab
  present/absent. Journey: pill + checkbox checked; OFF fires PUT + dataset flips. **REC:** add
  unset-default-OFF, ON-path reload, per-goal proposal controls, Sub-goals tab visibility.

## `journeys/goal-team-gates.journey.spec.ts` — 0 COVERED / 1 PARTIAL / 0 GAP

- **`plan-tab-gate-status.spec.ts` — PARTIAL.** Legacy: (1) archived child failed+mergeConflict →
  `data-plan-gate-status=failed` + `data-plan-conflict=true` + conflict-pill; (2) LIVE child passed →
  enrichment carried from /descendants into live state.goals; (3) running+no conflict → gate-dot +
  conflict-pill count 0 + reload persistence. Journey: archived node + failed gate-dot only. **REC:**
  add conflict-pill assertion, live-child enrichment carry-across, and running/reload-persistence cases.

## `daily/crash-restart.journey.spec.ts` — 0 COVERED / 0 PARTIAL / 4 GAP

- **`dormant-revive-live-reply.spec.ts` — GAP.** Legacy: attach→hibernate→revive renders server turn
  LIVE without reload (`countAssistantOk→1`, `__noReloadSentinel` kept), status idle; two concurrent
  dormant revives coalesce (canonical `clients.size==2`), both get post-revive frame. Journey: only
  gateway crash→restart recovery via reload. **REC:** after revive, enqueue a server prompt and assert
  the reply renders LIVE without reload + revive-coalescing.
- **`preparing-ux.spec.ts` — GAP.** Legacy: with PREPARING_DELAY, worktree-backed create shows
  "Setting up worktree…" banner + sidebar "preparing…" + editor hidden; after window, banner clears +
  editor mounts. Journey: nothing. **REC:** assert preparing banner + hidden editor → then cleared +
  editor mounted.
- **`session-created-push-sync.spec.ts` — GAP.** Legacy: mobile landing keeps authed /ws/viewer;
  createSession pushes session_created/sessions_changed before the 5s poll; `gatewaySessions` includes
  it; refreshing does NOT create a RemoteAgent. Journey: nothing. **REC:** assert viewer WS push updates
  the list before polling + no RemoteAgent.
- **`session-status-recovery.spec.ts` — GAP.** Legacy: status_resync heals stuck "streaming"→idle;
  two subsequent prompts each render exactly once. Journey: nothing. **REC:** assert status_resync
  clears stuck-streaming + no duplicate user-messages.

## `journeys/marketplace-packs.journey.spec.ts` — 0 COVERED / 1 PARTIAL / 7 GAP

- **`artifacts-pack.spec.ts` — GAP.** Legacy: install pack; `artifact_demo` rendererKind "pack";
  pill does NOT auto-invoke store on render; click opens store-backed viewer (data-artifact-id/type,
  iframe `sandbox="allow-scripts"` + srcdoc); store put/get only after click; pill survives reload;
  uninstall drops tool. Journey: route/tabs only. **REC:** install via REST, drive session, assert
  pill→click→viewer sandbox + uninstall drops tool.
- **`extension-host.spec.ts` — GAP.** Legacy: install retry-demo → `sample_action`
  actionNames=["retry"]; pack renderer mounts; no POST pre-click; Retry → 200 + `pack-result=retried`;
  survives reload; uninstall removes renderer + 404s endpoint. Journey: nothing. **REC:** port the
  install→render→action→uninstall round-trip.
- **`market-activation.spec.ts` — GAP.** Legacy: entrypoint toggle checked by default; uncheck drops
  from /ext/contributions; reload still visible+unchecked; re-enable→reload→checked+back in registry.
  Journey: only Sources tab presence. **REC:** Installed-panel toggle disable/reload/re-enable cycle.
- **`marketplace-conflicts.spec.ts` — GAP.** Legacy: API-level install+registry (dup routeId, orphan
  panel, panel-only, built-in disable, within-pack hard conflicts). Journey: nothing (UI-only smoke).
  **REC:** REST-layer registry behaviour — retain as an API spec, not a browser journey.
- **`marketplace-mcp.spec.ts` — GAP.** Legacy: add mcp-gateway source; browse 3 provider packs;
  install Jira; source filter; activation-mcp-group connected + operation toggle round-trip;
  #/tools hierarchy; disable→Disabled+empty activeSubNamespaces+reload; re-enable; uninstall; remove
  source. Journey: only sources-tab + add-source button. **REC:** add mcp-gateway source-kind flow
  (helper copy, install, toggle off/on persists).
- **`marketplace.spec.ts` — PARTIAL.** Legacy: Market nav position; research-preview banner; 3 tabs;
  add-source form; local-dir source + browse + entity chips; source filter menu; install → origin
  chip + provenance + persist; runtime resolution + uninstall; non-active-project targeting; update
  gating; trust/conflict warnings + reorder (PUT pack-order); per-entity descriptions. Journey:
  route + tab structure + add-source-form presence. **REC:** port a happy-path install cycle
  (register local-dir, install, installed card + provenance, uninstall) + banner + nav position.
- **`skill-multifile.spec.ts` — GAP (mis-mapped).** Skill-activation behaviour, not marketplace.
  **REC:** re-map to a skills journey.
- **`skills-chip.spec.ts` — GAP (mis-mapped).** Skill-chip UI, not marketplace. **REC:** re-map to a
  skills journey.

## `journeys/misc.journey.spec.ts` — 1 COVERED / 3 PARTIAL / 13 GAP

- **`api-error-modal.spec.ts` — GAP.** Legacy: createGoal 400 surfaces server error + stack in modal;
  fallback string absent. Journey: nothing. **REC:** stub 400 {error,stack}, assert
  `error-details-message` + expandable `error-details-stack` + no fallback.
- **`auto-retry-banner.spec.ts` — GAP.** Legacy: `auto_retry_pending` banner with
  data-reason/attempt/retry-delay-ms + countdown; cancelled/agent_start hide; transient vs
  provider-overload copy differ. Journey: nothing. **REC:** inject the 3 events, assert
  attributes/copy/hide + both reason flavours.
- **`compact-cost.spec.ts` — GAP.** Legacy: after compaction shrink, footer + context-popover
  "Total cost" + /cost keep persisted cumulative (not visible-sum). Journey: only loads session.
  **REC:** pin footer/popover cost == persisted cumulative via CostTracker + refreshAfterCompaction.
- **`compaction-persistence.spec.ts` — GAP.** Legacy: seeded compaction sidecar renders
  `compaction-summary-card` data-state="complete"; survives nav + reload. Journey: only editor
  visible. **REC:** seed sidecar, assert card count 1 + complete + persistence.
- **`cost-popover-cache-hit.spec.ts` — GAP.** Legacy: dashboard + stats-bar cost popover show
  `cost-cache-hit`="75%"; survives reload. Journey: best-effort cost element only. **REC:** seed
  cacheHitRate 0.75, open popover, assert "75%".
- **`gate-bypass.spec.ts` — GAP.** Legacy: human-only gate bypass end-to-end — button gating, inline
  form (why/who) POST `isInitiatedByHuman:true`, bypassed row + red badge on pill & sidebar,
  confirm-completion gating, reset/remove, reload persistence. Journey: nothing. **REC:** mock
  gates/bypass/reset/complete, assert form + bypassed status + red badge + gating + reload.
- **`goal-role-tabs-wiring.spec.ts` — GAP.** Legacy: proposal Roles tab editor, Customize enables
  editing, created goal persists `inlineRoles[role].label`; Customize works in a 2nd proposal.
  Journey: nothing. **REC:** open Roles tab, customize label, create, assert persisted inlineRoles.
- **`image-attach-roundtrip.spec.ts` — GAP.** Legacy: attach image + ECHO_IMAGE_BLOCK renders
  `attachment-tile` live + after reload. Journey: nothing. **REC:** setInputFiles PNG, send, assert
  tile live + reload.
- **`image-model-selector-lock.spec.ts` — GAP.** Legacy: footer image-model default gpt-image-2;
  selector picks dall-e-3; footer updates + persists reload. Journey: nothing. **REC:** assert
  `footer-image-model-id` default → select → persist.
- **`mobile-staff-sidebar.spec.ts` — COVERED.** Legacy assertion is `test.skip` (known master
  regression); journey renders app at mobile viewport. No live behaviour to port. **REC:** none (track
  the staff-nesting fix separately).
- **`optional-steps.spec.ts` — GAP.** Legacy: GOAL_PROPOSAL with options parsed — title populates +
  Create Goal enabled. Journey: nothing. **REC:** drive proposal + assert title value + enabled button.
- **`preview-happy-path.spec.ts` — PARTIAL.** Legacy: iframe src exact
  `/preview/<sid>/<entry>?mtime=`, body loads, new-tab href (no mtime), Refresh bumps mtime + changes
  src. Journey: mount + iframe visible + src matches `?mtime=\d+`. **REC:** add new-tab-href (no
  cache-buster) + Refresh-bumps-mtime assertions.
- **`prompt-stats-e2e.spec.ts` — GAP.** Legacy: stats bar model name "mock-model" + context-% + cost
  "$"; context + cost popovers open; model name persists reload. Journey: best-effort cost only.
  **REC:** assert model name + context % + $ + popovers + reload.
- **`review-pane.spec.ts` — PARTIAL.** Legacy: review_open opens pane with content; Approve sends
  feedback + closes tab; Reject sends feedback + closes, then fresh review_open reopens with revised
  markdown. Journey: Review tab + content ("Some important text"). **REC:** add Approve/Reject
  feedback-into-chat + tab close + reopen.
- **`unseen-activity.spec.ts` — PARTIAL.** Legacy: after mark-read, clearing localStorage/sessionStorage
  + reload keeps `.unseen-dot` count 0 (server-backed lastReadAt). Journey: fresh dot + mark-read+reload
  removes it (no storage clear). **REC:** clear storage (keep gateway url/token) before the post-mark
  reload to prove server-sourced state.
- **`workflow-editor.spec.ts` — GAP.** Legacy: editor UI/YAML parity — step-type dropdown (incl.
  human-signoff), field round-trips through save+reload+YAML, empty-prompt validation banner,
  type-switch strips run/expect, gate-level fields, dependsOn chips, phase movement,
  label→optionalLabel migration. Journey: stubs workflows GET + app-shell only. **REC:** keep a
  dedicated editor spec (or port step-type options, human-signoff round-trip, validation banner).
- **`workflow-page-scope.spec.ts` — GAP.** Legacy: `#/workflows` redirects to
  `#/settings/<projectId>/workflows` (never system), survives reload; seeded workflow lists;
  project-only origin badges. Journey: nothing. **REC:** assert project-scoped redirect across reload
  + seeded workflow + badges.

## `journeys/project-onboarding.journey.spec.ts` — 1 COVERED / 1 PARTIAL / 11 GAP

- **`add-project-browse-modal.spec.ts` — PARTIAL.** Legacy: Browse overlay; click entry updates
  browseCurrent; Up navigates back; Select current copies path + restores focus + re-runs preflight +
  no suggestion reopen; Esc preserves value + restores focus. Journey: overlay opens (parent mounted),
  browseCurrent visible, Select copies non-empty path, Esc closes without mutating + parent open.
  **REC:** assert entry-click updates browseCurrent + Up reverts; post-select input focused + preflight
  `path.exists` re-runs + `pickerSuggestions` count 0; Esc refocuses input.
- **`add-project-multi-repo-subset.spec.ts` — GAP.** Legacy: path→scan step; both repos pre-checked;
  deselect one → "Selected 1 of 2"; Continue routes to #/session/ + assistant autoPrompt carries JSON
  block with selectedIds subset. Journey: never advances past path step. **REC:** reach scan checklist,
  uncheck one, assert selectedCount + routing + assistant JSON subset.
- **`add-project-post-archive.spec.ts` — GAP.** Legacy: ghost `.bobbit/` (no project.yaml) →
  preflight archive CTA; confirm writes `.bobbit-archive-001`; post-archive Continue opens assistant +
  does NOT auto-import. Journey: nothing. **REC:** seed ghost `.bobbit/`, archive, assert disk archive +
  Continue→#/session/ + no import.
- **`add-project-preflight.spec.ts` — GAP.** Legacy: empty-dir preflight (hasFail=false,
  path.exists pass, preflight-ok, Continue enabled); nested-in-project → fail row, data-has-fail=1,
  preflight-blocked, Continue disabled. Journey: never inspects preflight panel. **REC:** assert
  preflight-panel `data-has-fail=0`/ok/Continue-enabled + a fail-path (nested) case.
- **`add-project-select-all.spec.ts` — GAP.** Legacy: Deselect all → "Selected 0 of N", Continue
  disabled, reciprocal bulk-button enable states; Select all → "N of N" enabled. Journey: never reaches
  scan. **REC:** port bulk deselect/select-all driving selectedCount + Continue + reciprocal states.
- **`add-project-symlink.spec.ts` — GAP.** Legacy: symlinked rootPath → symlink-confirm modal (link +
  canonical); Cancel registers neither; "Use canonical path" stores canonical + persists reload.
  Journey: nothing. **REC:** port symlink-confirm (skip on EPERM), Cancel-registers-nothing,
  use-canonical + reload.
- **`add-project-typeahead.spec.ts` — GAP.** Legacy: parent-prefix renders positioned suggestion
  overlay from /api/browse-directory; ArrowDown+Enter selects (focus retained, preflight re-runs, no
  reopen); trailing separator re-requests; two-stage Esc; drive-root; created-path; blur invalidates.
  Journey: only the Browse modal, never inline typeahead. **REC:** port suggestion overlay +
  ArrowDown/Enter select + two-stage Escape.
- **`per-project-native-yaml-fields.spec.ts` — GAP (mis-mapped).** Settings Tokens native-YAML
  round-trip; qa_env top-level PUT 400. **REC:** belongs in a project-settings journey, not onboarding.
- **`project-management.spec.ts` — GAP.** Legacy: API-created projects render in sidebar; rows
  switchable; hover reveals gear (title "Project settings") navigating to settings hash. Journey: only
  settings/projects route reachable. **REC:** register two projects, assert names in sidebar, row
  switch, gear navigation.
- **`remove-first-project.spec.ts` — GAP (mostly mis-mapped).** Legacy: Danger Zone "Remove Project"
  enabled; Headquarters anchored + not removable; removing → settings/system + drops from API+sidebar,
  no errors. **REC:** belongs to a project-management/removal journey.
- **`single-project-sidebar.spec.ts` — COVERED.** Intentionally-empty file; coverage moved to
  `tests/ui-fixtures/sidebar-filter-search-fixture.spec.ts`. **REC:** none.
- **`splash-multi-project.spec.ts` — GAP (mis-mapped).** Splash "Quick Session" → `splash-project-picker`
  (Headquarters first) → POST /api/sessions bound to projectId; Esc closes. **REC:** splash/session-launch
  journey.
- **`splash-no-projects.spec.ts` — GAP (mis-mapped).** Hidden HQ + no projects → `headquarters-hidden-fallback`
  (not old New Project gate) with Quick Session/Show HQ/Add Project; Quick Session binds to HQ; persists
  reload. **REC:** splash-recovery journey.

## `journeys/project-settings.journey.spec.ts` — 0 COVERED / 1 PARTIAL / 8 GAP

- **`goal-accept-failure-keeps-assistant.spec.ts` — GAP.** Legacy: forced 400 → error dialog msg,
  goal-assistant panel/title/textarea stay mounted, URL/session unchanged, retry re-POSTs. Journey:
  nothing. **REC:** intercept 400, assert error dialog + title-still-visible + URL + sessionId unchanged
  + retry re-POST.
- **`goal-reattempt-project-binding.spec.ts` — GAP.** Legacy: re-attempt session inherits original
  projectId (+ reattemptGoalId), assistantType goal, Create Goal fires (no "No project selected"), new
  goal bound to original projectId. Journey: nothing. **REC:** create goal, Re-attempt, assert
  projectId+reattemptGoalId on session, then propose+create asserting binding.
- **`project-assistant.spec.ts` — GAP.** Legacy: provisional project "(setting up)", accept promotes
  (provisional=false + config written), dismiss cleanup, provisional survives reload, two propose_project
  merge, multi-component cards, assistant session cleaned. Journey: only shell stability. **REC:** port
  Add-Project happy path (provisional→accept→config persisted) + dismiss/cleanup + reload.
- **`role-assistant-new.spec.ts` — GAP.** Legacy: #/roles "+ New Role" POSTs /api/sessions 201 (not
  400), hash→#/session/, textarea visible, no failure modal. Journey: nothing. **REC:** navigate #/roles,
  click New Role, assert 201 + hash + textarea + no modal.
- **`settings-agent-dir.spec.ts` — GAP.** Legacy: maintenance agent-dir active/default/next-start/source,
  INSIDE_WORKTREE rejection, save pending path + restart guidance, migrate skip/overwrite counts + file
  contents, reload persistence. Journey: nothing. **REC:** open maintenance, assert active path + validate
  rejects inside-worktree + save persists (migration optional).
- **`settings-maintenance-archived-worktrees.spec.ts` — GAP.** Legacy: worktree-cleanup card
  actionable-first ordering, summary counts, diagnostics groups, selected cleanup POST
  {mode:"selected",itemIds}, clean-all POST {mode:"all-safe"} then disable-on-zero-safe, empty-state.
  Journey: nothing. **REC:** stub maintenance routes, assert counts + POST bodies + empty/disabled.
- **`settings-model-fallback.spec.ts` — PARTIAL.** Legacy: fallback toggle defaults off ("Off by
  default" + default.sessionModel + "Image generation is separate"), check→PUT true+persist reload,
  uncheck→PUT false. Journey: models route + generic switch visible. **REC:** target
  `allow-session-model-fallback-toggle`, assert default unchecked + PUT true + reload + PUT false.
- **`settings-restart-button.spec.ts` — GAP.** Legacy: without harness Restart button absent (across
  reload/nav); with harness visible, POSTs /api/harness/restart once, "Requesting…"→"Restart Requested"
  disabled, stays visible after reload. Journey: nothing. **REC:** assert button count 0 by default (+
  harness-enabled variant with single POST + disabled feedback).
- **`system-prompt-customise.spec.ts` — GAP.** Legacy: "Customise system prompt" first click POSTs
  /customise, shows "Created", writes config/system-prompt.md, persists reload; second click "Already
  exists". Journey: only general route renders. **REC:** click, await POST, assert "Created" then
  reload→"Already exists" (teardown removes the file).

## `journeys/prompt-interaction.journey.spec.ts` — 0 COVERED / 2 PARTIAL / 9 GAP

- **`ask-user-choices-ui.spec.ts` — PARTIAL.** Legacy: widget+tabs; Other input auto-select; Escape
  clears selection+text; single/multi indicator shape; reload+cache-evict draft persistence;
  submit→read-only+reload; cross-client finalization; keyboard-only submit (letter tabs, press 1/2/Enter);
  error-chip-then-retry; per-tab draft isolation; other_text echoed. Journey: basic happy path (pick
  red→small→Submit→removed). **REC:** add Escape-clears, reload-read-only persistence, keyboard-only path,
  Other auto-select + echoed text, single-vs-multi indicator.
- **`at-mention.spec.ts` — GAP.** Legacy: @ opens `.at-menu`; ↑/↓ + filter + Enter inserts "@path ";
  text-file chip survives reload + click expands snapshot; image chip; unresolvable @nope renders
  unresolved chip without crash. Journey: nothing. **REC:** port autocomplete + chip render/reload +
  unresolved no-crash.
- **`escape-aborts-anywhere.spec.ts` — GAP.** Legacy: Escape aborts streaming when focus OUTSIDE
  textarea and inside. Journey: nothing. **REC:** STAY_BUSY → Escape (blurred) → Stop gone/idle; repeat
  with textarea focused.
- **`queue-ui.spec.ts` — GAP.** Legacy: queue pill + steer-btn when busy; single steer mid-turn without
  abort; batch steer (2 pills) both delivered; draft persists reload; edit pill (remove + re-queue,
  order preserved). Journey: nothing. **REC:** queue-while-streaming pill/steer + steer-without-abort +
  draft-persist.
- **`session-interactions.spec.ts` — PARTIAL.** Legacy: create+send+"OK"; 2nd session via API; switch
  (hash + prior message visible); reload re-renders + session exists; delete removes from list + UI.
  Journey: editor visible, type, hash contains id, send→"OK". **REC:** add switch, reload-persistence,
  delete-cleanup.
- **`session-prompt-grant-replay.spec.ts` — GAP (mis-mapped).** ask-gated session_prompt → permission
  card; grant delivers target once (no lastPromptText replay); deny delivers zero. **REC:** keep in a
  permission suite; assert grant-once + deny-zero if folded in.
- **`steer-during-bash-tool-abort-toolend.spec.ts` — GAP.** MOCK_ABORT_TOOL_END + queue-drop: steer 2,
  Stop → both echoed exactly once, queue drains. Journey: nothing. **REC:** keep legacy env-flag repro.
- **`steer-during-bash-tool-busy-race.spec.ts` — GAP.** MOCK_ABORT_BUSY finishRun race. **REC:** keep
  legacy spec.
- **`steer-during-bash-tool.spec.ts` — GAP.** MOCK_ABORT_AS_ERROR errored-agent_end drain. **REC:** keep
  legacy spec.
- **`tool-ask-policy.spec.ts` — GAP.** tool-permission-card; "Allow just Bash" grants (granted:true +
  "Permission granted"); Deny granted:false; session-only grant doesn't mutate role toolPolicies.
  Journey: nothing. **REC:** keep legacy or add card grant/deny path.
- **`tool-assistant-system-scope.spec.ts` — GAP (mis-mapped).** Tools page "New Tool" POSTs
  {toolAssistant:true, projectId:"headquarters"} 201; survives reload. **REC:** unrelated to
  prompt-interaction; keep in a tools suite.

## `journeys/proposals.journey.spec.ts` — 0 COVERED / 2 PARTIAL / 8 GAP

- **`failed-goal-proposal-ux.spec.ts` — GAP.** Legacy: MISSING_WORKFLOW failed card + error testid;
  reopen loads own draft; `goal-proposal-workflow-error` "Workflow is required"; Create disabled;
  workflow select value "" (no silent default); corrected retry → normal enabled proposal; survives
  reload/replay. Journey: only generic 400 error modal. **REC:** drive MISSING_WORKFLOW, assert
  failed-card + workflow-error + Create disabled + empty select + corrected-retry + reopenable after
  reload.
- **`goal-proposal-dismiss-reload.spec.ts` — GAP.** Legacy: after dismiss (fingerprint in localStorage +
  stale slot-less server draft), reload must NOT repopulate title nor `activeProposals.goal`. Journey:
  same-page dismiss only, no reload. **REC:** dismiss → reload → assert title not repopulated +
  `activeProposals.goal` null.
- **`goal-proposal-invalid-workflow.spec.ts` — GAP.** Legacy: phantom workflow id normalizes to a real
  configured one (select never "" nor phantom) in both panels; user-picked workflow submitted
  (body.workflowId); created goal has it. Journey: nothing. **REC:** inject phantom, assert select is a
  real option + POST body.workflowId matches selection.
- **`goal-proposal-revision-autoupdate.spec.ts` — GAP.** Legacy: 2nd propose_goal + edit_proposal
  auto-update panel in place (previewSpec + markdown) with no "Open proposal"; edited spec persists
  reload; fresh-context rescan doesn't revert. Journey: nothing. **REC:** GOAL_PROPOSAL→REV2 (flip in
  place)→EDIT (edited body without click)→reload persistence.
- **`goal-proposal-subgoal-prefill.spec.ts` — GAP.** Legacy: Sub-goals tab pre-reflects agent fields
  (toggle checked, max-depth 2, max-concurrent 4, divergence autonomous pressed / balanced not).
  Journey: nothing. **REC:** drive SUBGOAL_PREFILL, assert the four prefilled controls.
- **`goal-proposal-workflow-tab.spec.ts` — GAP.** Legacy: inline-only bespoke proposal submits inline
  body (not workflowId); inline precedence; "Bespoke (N Gates)" label updates on Add Gate; creatable
  with empty cache; Customise→editor+Revert; Workflow-tab select syncs Goal-tab. Journey: nothing.
  **REC:** port customise/revert + select-sync + one inline-workflow seed.
- **`proposal-edit-flow.spec.ts` — GAP.** Legacy: propose_project seeds slot (build_command "echo old"),
  edit_proposal flips to "echo new" live with no re-emit + preserves other fields, Apply persists to
  /config, slot clears; edit-only produces no 2nd tool card. Journey: nothing. **REC:** port
  INITIAL→EDIT (slot flip + fields intact)→Apply (config persisted) + no duplicate card.
- **`proposal-open-all-types.spec.ts` — PARTIAL.** Legacy (role browser case): tool card + Open button,
  slot field value, tab+dot, pane after click, mobile chat-pill round-trip, reload rehydrate+reopen,
  dismiss clears slot + hides tab + preserves other slots + returns to chat. Journey: role slot
  populated + tab + pane + dismiss clears slot. **REC:** add Open-button flow, field-value, reload
  rehydrate+reopen, other-slots-preserved on dismiss.
- **`proposal-spec-survives-navigate.spec.ts` — GAP.** Legacy: navigate-away+back keeps proposal
  `commentable-markdown`.markdown unchanged (no empty-spec regression). Journey: nav tests only check
  textarea/sidebar. **REC:** capture spec markdown, nav to 2nd session + back, assert body equals
  captured.
- **`proposal-tools.spec.ts` — PARTIAL.** Legacy: goal proposal tool card ("Goal Proposal" + title),
  `proposal-open-button`, persists across nav, reopens with title; in regular session Dismiss hides
  panel but tool card + Open button remain. Journey: goal dismiss during streaming + partial role
  flows. **REC:** add goal tool-card+title, Open reopen, nav persistence, tool-card-remains-after-dismiss.

## `journeys/sidebar-nav.journey.spec.ts` — 6 COVERED / 2 PARTIAL / 12 GAP

- **`search-e2e.spec.ts` — PARTIAL.** Legacy: filter matches session AND goal titles; Full Search link
  → #/search with query; Ctrl+K focus + Escape clears+blurs; archived section auto-opens on match then
  re-hides. Journey: session-title filter + Ctrl+K focus. **REC:** add goal-title match, Escape
  clear+blur, Full Search navigation, archived auto-open/re-hide.
- **`search-result-navigation.spec.ts` — GAP.** Legacy: full-search result groups (goal/session/staff/
  message) each navigate (hash contains id) with no dialog/Connection-Failed modals. Journey: never
  opens full-search. **REC:** drive #/search?q=, click goal+session cards, assert hash + no dialog.
- **`sidebar-archived-delegates-e2e.spec.ts` — COVERED.** `describe.skip` stub; migrated to
  `tests/ui-fixtures/sidebar-archived-fixture.spec.ts`. **REC:** none.
- **`sidebar-archived-layout.spec.ts` — GAP.** Legacy: Show Archived reveals archived session+goal,
  "Archived" label + grayscale(1), survives reload, toggle-off hides + clears active. Journey: nothing.
  **REC:** archive → toggle on → visible → reload → toggle off → hidden.
- **`sidebar-archived-per-project.spec.ts` — GAP.** Legacy: archived goals render under owning project
  headers (two projects). Journey: single-project. **REC:** retain or add multi-project archived
  grouping.
- **`sidebar-archived-search-repro.spec.ts` — GAP.** Legacy: search surfaces archived session beyond
  first 50-item page, under its project, hides non-matching. Journey: nothing. **REC:** retain
  (pagination-bounded regression).
- **`sidebar-child-loading.spec.ts` — GAP.** Legacy: expand team goal exposes team-lead child;
  navigating loads its editor + hash. Journey: no team goals. **REC:** create team goal + startTeam,
  expand, assert lead reachable.
- **`sidebar-filters.spec.ts` — GAP.** Legacy: Show Read OFF hides a read idle row (localStorage),
  keeps active visible, search bypasses filter to reveal, re-hides on clear. Journey: title search only.
  **REC:** uncheck Show Read hides row, search reveals, clear re-hides.
- **`sidebar-goal-group-filters.spec.ts` — COVERED.** Intentionally-empty describe; matrix moved to
  sidebar-filter-search fixture. **REC:** none.
- **`sidebar-goal-staff.spec.ts` — GAP.** Legacy: New Goal button opens goal-assistant (hash matches);
  Re-attempt via popover on archived/fresh goal; archiving removes from live + reappears under Show
  Archived. Journey: nothing. **REC:** retain or add New Goal→assistant + archive lifecycle.
- **`sidebar-mobile-archived-per-project.spec.ts` — COVERED.** `describe.skip` stub; migrated to fixture.
- **`sidebar-mobile-archived-search.spec.ts` — COVERED.** `describe.skip` stub; migrated to fixture.
- **`sidebar-navigation.spec.ts` — PARTIAL.** Legacy: clicking rows highlights active (full connected
  state) and rapid multi-click settles on the LAST clicked (connect-race guard). Journey: highlight +
  URL update. **REC:** add rapid-switch settle-on-last (optionally connectionStatus="connected").
- **`sidebar-refresh-agent.spec.ts` — GAP.** Legacy: refresh is hamburger-only; POSTs restart for an
  inactive row; pending + result toast; failure toast; ineligible sessions hide it; busy sessions
  disable/guard. Journey: nothing. **REC:** retain (distinct session-action contract).
- **`sidebar-search-filter.spec.ts` — COVERED.** Intentionally-empty describe; matrix in fixture.
- **`sidebar-session-actions.spec.ts` — GAP.** Legacy: New session button creates (hash matches),
  rename via Modify persists reload, terminate (confirm backdrop) removes from sidebar + API. Journey:
  only New Session button visible, never clicks. **REC:** retain or add create/rename-persist/terminate.
- **`sidebar-spawned-children-dedupe.spec.ts` — COVERED.** `describe.skip` stub; moved to
  sidebar-navigation fixture.
- **`sidebar-staff-loading.spec.ts` — GAP.** Legacy: "+ New staff agent" shows `bobbit-loader` within
  2s (creatingSession set before fetch) before navigation. Journey: nothing. **REC:** retain
  (pre-fetch loader regression).
- **`sidebar-tree-restart.spec.ts` — GAP.** Legacy: tree expansion choices + nested-goal indentation
  persist to localStorage + survive crash+restart+reload (`--sidebar-tree-nested-goal-indent`). Journey:
  nothing. **REC:** retain (restart-durability + indent CSS var).
- **`sidebar-unified-tree.spec.ts` — GAP.** Legacy: renders canonical nodes (project, section headers,
  sub-goal parent/child, team-lead, child groups, live+archived delegate groups) + Ctrl+Arrow
  expand/collapse. Journey: nothing. **REC:** retain (tree taxonomy + keyboard nav).

## `journeys/staff-debug.journey.spec.ts` — 0 COVERED / 2 PARTIAL / 6 GAP

- **`children-tool-renderers.spec.ts` — GAP.** Legacy: mounts `goal_spawn_child` renderer, asserts
  `children-spawn-title`/`children-spawn-planid`. Journey: only mock "OK" reply. **REC:** mount
  goal_spawn_child (subgoals flag on) + assert title/planid.
- **`debug-mode-toggle.spec.ts` — PARTIAL.** Legacy: toggle absent without harness; with harness Off→On,
  aria-checked, mirrors `bobbit-client-debug`/`bobbit-perf-instrumentation` localStorage, persists
  reload, arms boot-timing (marks + POST), clears both on off. Journey: only general page +
  `general-appearance-heading` visible. **REC:** harness-gated toggle click → aria-checked + both flags
  "1" + reload + clear-on-off.
- **`instant-loader.spec.ts` — GAP.** Legacy: with POST held, splash Quick Session shows `bobbit-loader`
  before POST resolves. Journey: createSession uses API directly. **REC:** hold POST /api/sessions,
  click create, assert loader visible while pending.
- **`staff-accessory.spec.ts` — GAP.** Legacy: accessory pick shows ring-2; PUT payload + GET carry
  accessory; linked session mirrors; sidebar row overlay img; survives reload. Journey: only list
  heading/empty-state. **REC:** create staff, pick accessory, assert PUT+GET + reload.
- **`staff-role.spec.ts` — GAP.** Legacy: role select empty default; pick pre-fills default accessory;
  PUT/GET persist roleId+accessory; manual accessory survives role change; clear sends roleId=null;
  across reloads. Journey: never opens edit form. **REC:** role select→accessory prefill + save/persist +
  role-clear round-trip.
- **`staff-sandbox-indicator.spec.ts` — GAP.** Legacy: edit-page Sandbox row "Disabled" for
  sandboxed:false (no inherited caption), survives reload; create assistant always renders "Sandbox
  (Docker)" checkbox attached. Journey: never opens edit/create. **REC:** assert Disabled indicator +
  reload + create-flow checkbox.
- **`staff-sub-section.spec.ts` — PARTIAL.** Legacy: per-project Staff header with zero staff; rows
  under Staff (not Sessions); search filters; collapse persists reload; retire hides/restore shows;
  collapsed sidebar STAFF bucket. Journey: only #/staff heading + empty-state/table. **REC:** assert
  `sidebar-staff-header` + row under Staff + collapse/search (archive lifecycle can stay dedicated).
- **`staff-triggers.spec.ts` — GAP.** Legacy: trigger dropdown lists goal_created/goal_archived; goal-*
  flips label "Wake prompt (required)" + inline error + disables Save while empty; filling clears +
  enables; PUT/GET persist goal_created + prompt; reload round-trip. Journey: never touches trigger
  editor. **REC:** add trigger→goal_created, required-label+error+Save-disabled, fill, save, PUT/GET +
  reload.

## `journeys/stories-registry.journey.spec.ts` — 0 COVERED / 3 PARTIAL / 5 GAP

- **`headquarters.spec.ts` — GAP.** Legacy: HQ built-in project (id/name/rootPath); TowerControl vs
  folder icons; same-root distinction + Quick Session scope; hide/show persist across reload+restart;
  Add Project preflight (no archive CTA); New Staff targets HQ; Settings scope labeled "Headquarters"
  (no System); no-git goal gating. Journey: only settings route + shell. **REC:** assert HQ header
  `data-project-id="headquarters"` + TowerControl; Quick Session picker lists HQ + creates HQ session;
  "Show Headquarters" checkbox toggles+persists; scope labeled Headquarters with no System button.
- **`stories-drafts.spec.ts` — PARTIAL.** Legacy: CT-02-a..h (draft survives switch/focus, pasted-image
  attachment fast/slow/reload, model change, reload, goal-dashboard detour, WS disconnect+reconnect,
  gen-desync server-persisted). Journey: CT-02-a + CT-02-d + isolation. **REC:** add dashboard-detour,
  disconnect+reload, editor-focused-after-restore, gen-desync round-trip (attachment/model may stay
  legacy).
- **`stories-goal-routing.spec.ts` — GAP.** Legacy: GR-01 per-project New goal creates in B (persist
  reload); GR-02 toolbar picker lists A+B; GR-03 back-to-back picks; GR-04 assistant scoped to picked
  project; GR-05 reload mid-proposal preserves project; GR-09 zero-project disables New Goal + 400
  PROJECT_ID_REQUIRED; GR-10 single-project skips picker. Journey: nothing. **REC:** two-project routing
  (toolbar New Goal → picker → pick → created goal's projectId) + zero-project disabled + 400.
- **`stories-projects.spec.ts` — PARTIAL.** Legacy: PR-01 default project in /api/projects survives
  reload; PR-09 session navigable/active after reload; PR-10 create-then-delete archived/404. Journey:
  overlaps PR-09 (session navigable + editor after reload). **REC:** add PR-01 (project list persists)
  + PR-10 (delete → archived/404 + row gone).
- **`stories-resilience.spec.ts` — GAP.** Legacy: RE-01..06/08 crash+restart (manual-gated); RE-07
  (non-manual): send message, disconnect WS, reload, assert navigable + message content intact. Journey:
  session-navigable-after-reload only (no disconnect/message). **REC:** port RE-07 (message survives
  disconnect+reload); leave crash/restart to manual phase.
- **`stories-sessions.spec.ts` — PARTIAL.** Legacy: S-01 empty+focused+cannot-send; S-03 draft
  isolation; S-02/11/12 send→"OK"+sequential; S-04 terminated disappears; S-05/06/07 message-content
  isolation + rapid switch + survives reload. Journey: CT-05 draft isolation + session-navigable+editor
  after reload. **REC:** add S-01 (empty/focused/Send disabled), S-02 (send+OK), S-04 (delete removes
  row), S-05/07 (content isolation + survives reload).
- **`stories-sidebar.spec.ts` — GAP.** Legacy: SB-24 three titled sessions visible; Ctrl+K focuses
  `input[data-search]`; typing narrows to one; clearing restores all. Journey: sidebar-visible +
  active-row highlight only. **REC:** create titled sessions, Ctrl+K focus, filter narrows, clear
  restores.
- **`stories-streaming.spec.ts` — GAP.** Legacy: CT-01-a..f streaming lifecycle (Stop, queue-pill,
  idle, abort preserves editor, session-switch keeps stop, reload leaves editor usable); ST-DEDUP-01..04
  reconnect/replay dedup + proposal-burst ordering + ask_user_choices routing. Journey: nothing. **REC:**
  at least streaming-lifecycle (STAY_BUSY → stop visible → queue-pill → idle → editor sendable);
  optionally reload-during-stream (dedup/replay may stay legacy).

## `journeys/team-operations.journey.spec.ts` — 0 COVERED / 7 PARTIAL / 1 GAP

- **`archive-child-cascade.spec.ts` — PARTIAL.** Legacy: children-count 2/0 (API); terminate modal
  lists children by name ("also archive its 2 child agents", CascadeChildA/B); confirm cascade-archives
  (leave live, appear archived); childless shows no "child agent" note. Journey: children-count parity +
  dialog merely appears/dismissed. **REC:** assert modal body child-count text + both titles; after
  confirm children leave live + appear under archived; childless `not.toContainText("child agent")`.
- **`dashboard-mutation-pending.spec.ts` — PARTIAL.** Legacy: pending card + summary; survives reload;
  approve clears; reject clears; card NOT cleared on 409 decision (waits for "decision failed" log).
  Journey: card renders + summary + approve clears. **REC:** add reject clears + survives reload + 409
  keeps card visible.
- **`goal-dashboard-fanout.spec.ts` — PARTIAL.** Legacy: live WS gate update flips label to "passed" +
  `gate-signal-badge` "1 signal" + signal-entry; unrelated tab gets NO events; persist after reload.
  Journey: signal 201 (poll disabled) + checklist + Design Doc row. **REC:** after signal, assert
  `.wf-checklist-status-label` "passed" + `.gate-signal-badge` "1 signal" (live + reload); optional
  unrelated-tab isolation.
- **`goal-status-widget.spec.ts` — PARTIAL.** Legacy: teamGoalId REST; pill on team-lead;
  `data-awaiting-signoffs="false"`; survives reload; visible at 640px (no overflow collapse). Journey:
  teamGoalId + pill visible. **REC:** add awaiting-signoffs attribute + reload + narrow-viewport.
- **`plan-archived-children.spec.ts` — PARTIAL.** Legacy: descendants reports live+complete+archived;
  Plan tab shows all 3; archived visible; reload persists; live-only toggle hides archived+completed +
  toggle-back; tree-cost attributes archived spend (all 3 rows). Journey: single archived-child render +
  descendants-includes-archived. **REC:** add live-only toggle test + tree-cost attribution (breakdown
  costUsd>0/tokensIn>0, all 3 goalIds).
- **`plan-tab-archived-children.spec.ts` — PARTIAL.** Legacy: descendants archived child; Plan-tab DAG
  node `data-archived="true"`; archived pill `plan-node-archived-pill` visible. Journey: descendants +
  node data-archived (both ported). **REC:** add the archived-pill assertion.
- **`team-delegate.spec.ts` — PARTIAL.** Legacy: blocking one-shot card ("Delegated" + "Summarise the
  design doc"); parallel "Delegated to 2 agents"; interactive real /orchestrate spawn→prompt→wait→read
  (child navigable, transcript marker)→dismiss; restart reminder ("gateway restarted", "team_wait") +
  re-collect. Journey: single-child + parallel cards only. **REC:** add single-child summary text; the
  orchestrate flow + restart reminder may belong to an API/integration tier — at minimum port the
  summary-text assertion.
- **`verification-progress-indicator.spec.ts` — GAP.** Legacy: multi-step gate renders 3 named
  `.verify-card` chips within one tick; per-step modifier classes (phase-0 running, phase-1 waiting);
  "Verification in progress" placeholder NEVER alongside chips; persist across reload from REST alone.
  Journey: only gate signal 201 + fast checklist (unrelated to verify-card rendering). **REC:** signal a
  multi-step gate, expand, assert `.verify-card` count 3 + running/waiting classes + no placeholder +
  reload (requires inline slow-multi workflow — consider manual/integration tier).

---

## Retirement gate implications (for `tests-map.json`)

- **Safe to mark `retired` now (8):** `mobile-staff-sidebar`, `single-project-sidebar`,
  `sidebar-archived-delegates-e2e`, `sidebar-goal-group-filters`, `sidebar-mobile-archived-per-project`,
  `sidebar-mobile-archived-search`, `sidebar-search-filter`, `sidebar-spawned-children-dedupe`
  (skipped/empty stubs or equivalently covered).
- **Blocked from retirement (143):** every PARTIAL and GAP entry above retains at least one assertion
  not present in v2. Their `replacementNote` ("behavioral assertions pending") is accurate and must
  stay until the recommended assertions land in the journey (or the spec is kept as a dedicated
  tier-2/tier-3 spec, or re-mapped for the 8 mis-mapped files noted in observation 1).
- **Recommended sequencing** (lowest effort → parity): `team-operations` (7 PARTIAL, mostly one-assertion
  adds) → `goal-editing` (6 PARTIAL) → `misc`/`proposals`/`prompt-interaction` PARTIALs, then tackle the
  large GAP domains (streaming, resilience, workflow-editor, gate-bypass, sidebar mutations) as dedicated
  specs rather than smoke-journey extensions.
