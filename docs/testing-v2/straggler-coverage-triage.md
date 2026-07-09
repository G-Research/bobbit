# Straggler coverage triage — the 51 no-`v2Path` specs (switchover gate)

**Purpose.** Definitive port-vs-accept ledger for every legacy test file classified
migrate-intended (`adapter`/`codemod`/`rewrite`) that reached switchover **without a
`v2Path`** — i.e. deleted from `tests/**` but with no recorded tests2 replacement.
Post-cutover (`test:unit`→tests2 only; `test:e2e`→daily-bucket only) these run
**nowhere** unless an equivalent behaviour exists elsewhere in v2.

This is the input to the user's decision: **port** the material gaps into `tests2/`
(coverage-preserving) vs **knowingly accept** enumerated low-value losses.

> **Scope note.** The 153 `legacy-pending` BROWSER specs are NOT here — they are
> covered by the enhanced journeys and mutation-proven by the D8 browser-chaos
> campaign (0 real journey holes, v2 83 ≥ legacy 81). Only these 51 unit/integration/dom
> stragglers were at risk.

**Method.** Legacy assertion titles read from git (`8edfdd80^`); tests2 coverage
identified by subject + distinctive function/identifier search (e.g.
`resolveDirectGatewayEnv`, `registerProvisional`, `scopeProposalProjectId`) + judgment.
This is **not** a line-by-line assertion diff of all 51 — COVERED/GENUINE calls
anchored on a function-name present/absent are high-confidence; PARTIAL calls name the
specific sub-behaviour to confirm during porting.

---

## Summary tally

| Classification | Count |
|---|---|
| **COVERED-ELSEWHERE** (mapping debt only) | **32** |
| **PARTIAL** (core covered; a sub-behaviour lost) | **10** |
| **GENUINE-LOSS** (behaviour runs nowhere post-cutover) | **9** |
| **Total** | **51** |

**Genuine losses grouped by area:**

- **Verification / workflow gates:** `human-signoff` (**HIGH** — runtime approve/reject/400/no-`BOBBIT_LLM_REVIEW_SKIP`-fallback; a shipped workflow gate).
- **Project/scope security guards:** `proposal-scope-system-alias` (`scopeProposalProjectId` — hidden `system`→HQ mapping), `rpc-bridge-gateway-env` (`resolveDirectGatewayEnv` — scoped direct-agent token/URL injection), `project-registry-provisional-dedupe` (`registerProvisional` reuse/immutability).
- **Headquarters runtime:** `headquarters-no-worktree-runtime` (forces HQ goals/staff to no-worktree even inside a git repo; no HQ worktree pool).
- **PR / live status:** `pr-cache` (`pr_status_changed` WS broadcast on PR-creation detection).
- **Prompt-interaction UX:** `message-editor-arrows` (visual-row ArrowUp/Down history recall, PI-02/03), `mobile-header-race` (mobile header render-race lifecycle).
- **System prompt admin:** `system-prompt-customise` (**LOW-MED** — `POST /api/system-prompt/customise` create-on-first-call + auth; UI toggle is covered, the endpoint isn't).

**PARTIAL losses (sub-behaviour) by area:** metadata resolver session-application + worktree-marker (`goal-metadata-hierarchy`); HQ same-root-split API + server-scope proposal writes (`headquarters-api`, `headquarters-server-scope-guards`); host.agents sandbox inheritance (`host-agents-sandbox-inheritance`); fork worktree-choice + github-link states (`sidebar-actions-server`); delegate model-inheritance + blocking lifecycle (`team-delegate`); first-settled/timeout nuances (`team-wait-semantics`); disabled.providers round-trip (`marketplace-provider-activation`); skill-REST status codes (`activate-skill`); goal-todo-on-validation-fail (`session-create-regressions`).

---

## Per-file ledger

### GENUINE-LOSS (9) — assertions run nowhere post-cutover

| File | Lost behaviour | Severity / value |
|---|---|---|
| `tests/e2e/human-signoff.spec.ts` | Full human-signoff verification runtime: parked → `POST /signoff` pass→gate-pass / fail→gate-fail with feedback persisted as markdown artifact; 400 on bad payloads; parks when only `BOBBIT_LLM_REVIEW_SKIP` set (no fallback). `verification-logic.test.ts` only pins the same-commit cache-*exclusion*, not the runtime. | **HIGH** — real prod verification path; human-signoff gate ships in `project.yaml` (`human-signoff-test` workflow). Port. |
| `tests/proposal-scope-system-alias.test.ts` | `scopeProposalProjectId`: hidden `system` project never becomes a proposal scope; maps `system`→HQ/server; passes HQ through; undefined when no session projectId. No tests2 references the fn. | **MED** — scope-isolation guard (prevents hidden-system leaking as a writable proposal scope). Port. |
| `tests/rpc-bridge-gateway-env.test.ts` | `resolveDirectGatewayEnv`: injects/omits `BOBBIT_TOKEN`/`BOBBIT_GATEWAY_URL` for direct agents; env-over-statefile precedence; omits token when no scoped gatewayToken. No tests2 references the fn. | **MED** — direct-agent credential scoping correctness (security-adjacent). Port. |
| `tests/project-registry-provisional-dedupe.test.ts` | `registerProvisional` reuses an existing/normal server-run-dir project; keeps HQ immutable + hidden system anchors. No tests2 references the fn (`project-registry-order.test.ts` covers ordering, not provisional dedup). | **MED** — prevents duplicate provisional projects; HQ/system immutability. Port. |
| `tests/headquarters-no-worktree-runtime.test.ts` | Forces HQ goals to ready no-worktree even inside a git repo; no HQ worktree pool; HQ staff created without a worktree even when requested. No direct tests2 home. | **MED** — HQ runtime invariant (avoids stray worktrees for server-workspace goals). Port. |
| `tests/e2e/pr-cache.spec.ts` | Server broadcasts `pr_status_changed` on PR-creation detection. No tests2 home (`quiet-pr-status-api`/`goal-pr-url` cover related but not the creation-detection broadcast). | **MED** — user-facing live PR-status update. Port. |
| `tests/message-editor-arrows.spec.ts` | Visual-row ArrowUp/Down history recall (stories 16–20): wrapped/multi-line cursor-row detection deciding history vs caret move. `dom/command-history.test.ts` = dedup only; `dom/message-editor-ctrl-arrow` = Ctrl+Arrow nav (different). | **MED** — PI-02/03 history-recall UX. Port (dom fixture). |
| `tests/mobile-header-race.spec.ts` | Mobile header render-race lifecycle: absent-before-connection → appears-immediately-after → correct state through full connect; goal-assistant tab-bar gating. No tests2 home. | **MED** — real mobile render-timing bug class. Port (dom/browser). |
| `tests/e2e/system-prompt-customise.spec.ts` | `POST /api/system-prompt/customise` creates file on first call, no-ops on second; requires auth. Journeys cover the UI toggle, not the endpoint runtime/auth. | **LOW-MED** — small admin endpoint. Port or accept. |

### PARTIAL (10) — core covered; a sub-behaviour lost

| File | Covered by | Sub-behaviour lost (to confirm on port) |
|---|---|---|
| `tests/e2e/goal-metadata-hierarchy.spec.ts` | `core/goal-metadata.test.ts`, `goal-metadata-edges.test.ts` (resolver ancestry/deep-merge) | Session-level application (lead/member/reviewer/delegate/nested disabled-tool absent), worktree marker reflecting inherited metadata, `disabledProviders` marker filtering. |
| `tests/e2e/headquarters-api.spec.ts` | `core/headquarters-config-alias.test.ts`, `headquarters-state-migration.test.ts` | Same-root Headquarters/normal split API, hide/show HQ persistence across restart, `projectId=system` role/tool writes → HQ scope. |
| `tests/headquarters-server-scope-guards.test.ts` | `headquarters-state-migration.test.ts`, `integration/sessions-projectless.test.ts` | Server-scope role/tool assistant cwd defaults + coercion, projectless-session MCP fail-closed, archive-bobbit-through-symlink preserves HQ. |
| `tests/e2e/host-agents-sandbox-inheritance.spec.ts` | `core/host-agents-scope.test.ts`, `orchestration-core.test.ts` | Sandbox inheritance from bound session (plain + full-lifecycle child); read-only child registers no mutating tools. |
| `tests/e2e/sidebar-actions-server.spec.ts` | `core/sidebar-actions-server.test.ts` (exact-stem, 3 of 11 titles) | Fork worktree-choice (`newWorktree` true/false; rebase off stale source), `GET /github-link` PR/branch-fallback/unavailable states. |
| `tests/e2e/team-delegate.spec.ts` | `core/orchestration-core.test.ts` (scoping/authz) | Blocking one-shot spawn→wait→output→auto-dismiss; parallel wait-for-ALL; **model inheritance** (current-model, per-call override). |
| `tests/e2e/team-wait-semantics.spec.ts` | `core/orchestration-core.test.ts`, `integration/orchestrate-restart.test.ts` | First-settled + status-line wording, chunked-wait post-headers error, `queued` reporting, timeout-terminal aggregate-never-rejects. |
| `tests/e2e/marketplace-provider-activation.spec.ts` | `core/session-manager-respawn-provider-bridge.test.ts` | `PUT/GET` round-trip of `disabled.providers`; schema-1 catalogue omission. |
| `tests/e2e/activate-skill.spec.ts` | `core/activate-skill-extension.test.ts`, `integration/slash-skill-e2e.test.ts` | REST status-code contract: 404 unknown, 403 disable-model-invocation, 400 missing name. |
| `tests/e2e/session-create-regressions.spec.ts` | `core/sandbox-guard.test.ts`, `integration/sessions-projectless.test.ts` | Leaves goal `todo` when projectId validation fails; HQ-sandbox-rejection edge. |

### COVERED-ELSEWHERE (32) — mapping debt only

| File | Covered by (tests2) |
|---|---|
| `tests/e2e/aigw-startup-refresh.spec.ts` | `core/aigw-startup-refresh.test.ts` (exact-stem, 5 ≥ 3) |
| `tests/e2e/qa-seed.spec.ts` | `core/qa-seed.test.ts` (exact-stem, 34 ≥ 6) |
| `tests/e2e/api-goals-spawn-child-route.spec.ts` | `core/api-goals-spawn-child`, `api-spawn-child-spawnedby-derivation`, `api-spawn-child-spec-validation`, `runSubgoalStep-inline-roles-inheritance` |
| `tests/e2e/archive-dormant-cascade.spec.ts` | `core/orchestration-cascade.test.ts` |
| `tests/e2e/base-ref-pin.spec.ts` | `integration/base-ref-api`, `core/base-ref-parse`, `verification-basebranch-regression` |
| `tests/e2e/context-window-overrides.spec.ts` | `core/aigw-context-window-overrides.test.ts` |
| `tests/e2e/cost-backfill-on-boot.spec.ts` | `core/cost-backfill`, `cost-backfill-transcript-pass` |
| `tests/e2e/gate-active-verification-snapshot.spec.ts` | `core/gate-verification-snapshot.test.ts` |
| `tests/e2e/gate-verification-resume.spec.ts` | `core/team-manager-reviewer-resume`, `verification-resume-restart-prompt` |
| `tests/e2e/host-agents.spec.ts` | `core/host-agents-scope`, `orchestration-core`, `extension-host-server-host-api` |
| `tests/e2e/marketplace-pi-extension.spec.ts` | `core/marketplace-pi-extension-activation`, `pi-extension-{discovery,collision,scope-isolation}` |
| `tests/e2e/per-project-config-dirs.spec.ts` | `core/config-directories`, `integration/project-config-native-yaml`, `config-cascade-api` |
| `tests/e2e/pr-walkthrough-host-agents.spec.ts` | `core/pr-walkthrough-*` (many), `integration/pr-walkthrough-api`, `browser/daily/pr-walkthrough-pack` |
| `tests/e2e/propose-goal-tool-result-iserror.spec.ts` | `core/tool-result-error-bridge-extension`, `tool-result-error-normalizer` |
| `tests/e2e/provider-hook-effective-goal.spec.ts` | `core/goal-metadata-edges`, `provider-bridge-extension` |
| `tests/e2e/provider-session-setup.spec.ts` | `core/session-setup-*`, `dynamic-context-section` |
| `tests/e2e/provider-turn-hooks.spec.ts` | `core/provider-bridge-extension`, `lifecycle-hub`, `pack-providers-loader` |
| `tests/e2e/session-create-regressions.spec.ts` | *(see PARTIAL)* |
| `tests/e2e/session-git-status-multi-repo.spec.ts` | `integration/git-handoff-multi-repo.test.ts` |
| `tests/e2e/session-lifecycle-ui.spec.ts` | `integration/session-lifecycle-api`, `browser/journeys/session-lifecycle` |
| `tests/e2e/session-prompt.spec.ts` | `core/steer-midturn`, `integration/team-steer-prompt`, `dom/session-prompt-*` |
| `tests/e2e/session-recovery.spec.ts` | `core/session-store-atomic-write`, `session-recovery-agent-dir` |
| `tests/e2e/staff-cwd-parity.spec.ts` | `integration/staff`, `role-assistant-session`, `core/staff-session-staffid-persistence` |
| `tests/e2e/verification-timeout.spec.ts` | `core/verification-harness-timeout`, `verification-command-runner-contract`, `verification-docker-blast-radius` |
| `tests/runtime-project-scope.test.ts` | `integration/sessions-projectless`, `project-isolation`, `core/multi-project` |
| `tests/sandbox-headquarters-exempt.test.ts` | `core/sandbox-guard.test.ts` (HQ/system sandbox exemption) |
| `tests/session-manager-sandbox-scope.test.ts` | `core/sandbox-guard`, `sandbox-wiring-goal-provisioned` |
| `tests/bg-process-states.spec.ts` | `dom/bg-process-renderer`, `browser/fixtures/bg-process-{pills,popover}` |
| `tests/hq-explicit-project-scope.spec.ts` | `core/headquarters-config-alias`, `config-directories` (projectId-scoped loads) |
| `tests/ui-fixtures/proposal-review-fixture.spec.ts` | `dom/proposal-renderer-*`, `browser/fixtures` proposal/review |
| `tests/ui-fixtures/search-preview-archive.spec.ts` | `integration/search-preview-api`, `browser/fixtures` archived-footer |
| `tests/ui-fixtures/settings-admin-fixture.spec.ts` | `integration/maintenance-api`, settings dom/fixtures |
| `tests/ui-fixtures/sidebar-navigation-fixture.spec.ts` | `browser/journeys/sidebar-nav`, sidebar fixtures |

---

## Recommendation

Port the **9 GENUINE** losses into `tests2/` before switchover (coverage-preserving) —
`human-signoff` is HIGH priority (a shipped workflow gate). The **10 PARTIAL** losses
should each be checked and their named sub-behaviour ported where it is real prod logic
(model-inheritance, fork worktree-choice, HQ same-root split, metadata session-application
are the material ones); the rest are low-value. The **32 COVERED** are mapping debt —
record `v2Path`/note, no porting needed. Alternatively, the user may knowingly accept
specific low-value losses (e.g. `system-prompt-customise` endpoint, `activate-skill`
REST status codes) and port only the material set.

Estimated porting effort for the material set (9 genuine + ~4 material partials): ~1–2
focused coder-days; splittable by area (verification / scope-guards / HQ / PR / prompt-UX).
