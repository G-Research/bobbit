# Git / worktree / GitHub-CLI I/O boundary audit

## Acceptance rule and baseline

**Audit baseline:** `4df9a35e2bd1ac5b662382189e12973fc4e1c4c2` (abbreviated **MB** below).

This re-audit uses only files and assertions present at MB, read with `git show 4df9a35e2bd1ac5b662382189e12973fc4e1c4c2:<path>`. Current file names, comments, and strengthened assertions are not proof.

A real unit assertion may move behind a mock only when **both** conditions hold:

1. an MB E2E assertion crosses the same Git/worktree/`gh` boundary and proves the material result; and
2. the affected unit assertion is boundary-independent.

An assertion that reads or derives meaning from real Git output, a real ref/commit/worktree/repository state, or real/fake-executable `gh` output/argv/stdin is **not boundary-independent**. It must remain real and may only be fixture-optimized. A nearby E2E does not license replacing it with canned output. No substantive coverage migration is accepted on adjacent behavior.

Statuses are deliberately MB-prefixed:

- **MB-COVERED:** exact MB E2E equivalence exists for the material interaction.
- **MB-PARTIAL:** MB proves only a representative/adjacent path or omits material branches.
- **MB-GAP:** no assertion-equivalent MB E2E exists.

Each proposed seam receives its own status after applying the two-condition rule. `MB-COVERED` interaction proof alone would still not make a boundary-dependent unit assertion mock-eligible.

### Fixed MB integration-E2E set

The exact MB `scripts/testing-v2/integration-e2e-files.mjs` list is:

1. `tests2/integration/team-lead-child-authz.test.ts`
2. `tests2/integration/orchestrate-restart.test.ts`
3. `tests2/integration/continue-archived.test.ts`
4. `tests2/integration/continue-archived-assistant.test.ts`
5. `tests2/integration/multi-repo-flow-api.test.ts`
6. `tests2/integration/steer-gateway-restart.test.ts`
7. `tests2/integration/team-wait-semantics.test.ts`
8. `tests2/integration/team-delegate.test.ts`
9. `tests2/integration/team-dismiss-structured-regression.test.ts`
10. `tests2/integration/project-isolation.test.ts`
11. `tests2/integration/commit-file-diffs-api.test.ts`
12. `tests2/integration/sidebar-actions-fork-github-link.test.ts`

Real `tests2/browser/e2e` assertions at MB may also qualify. Unit-scope integration tests cannot prove themselves.

### Supplemental evidence explicitly rejected

- Any post-MB strengthening of `tests2/integration/multi-repo-flow-api.test.ts` is supplemental. At MB, lines 135–152 assert exact `api`/`web` worktrees and cleanup only inside a conditional; lines 153–157 expressly accept a single-worktree fallback.
- Any post-MB team-dismiss coverage is supplemental. Even the MB test `"/api/goals/:id/team/dismiss real core-registered team worker uses TeamManager cleanup"` only asserts registration/removal and structured dismiss responses at lines 121–147. It never creates or inspects a Git worktree, branch, commit, or base SHA.

## Interaction audit

The rows below are distinct interaction protocols. “Boundary-independent” refers only to the affected real unit assertions, not to whether a typed interface would be architecturally convenient.

### GIT-001 — Repository-root discovery and agent-directory containment

- **Owners:** `tests2/core/agent-dir-validation.test.ts`.
- **Interaction status: MB-GAP.** No MB E2E creates allowed and forbidden Headquarters agent-directory targets and asserts direct, relative, and symlink containment against a real repository root. None of the fixed twelve or MB browser E2E tests has such assertions.
- **Affected unit assertions boundary-independent? No.** The allowed/`INSIDE_WORKTREE` outcomes derive their meaning from whether `git init` made the target part of a real repository. The symlink and canonical-path checks may be fixture-optimized, but the real-repository cases inspect derived Git topology and must remain real.
- **Proposed seam: MB-GAP.** `RepositoryTopology.findRoot(path): string | null` remains a valid design, but it cannot replace these assertions. Add an MB-equivalent E2E first; afterward only separately written topology-independent decision tests may use the seam.

### GIT-002 — Ref existence, configured base-ref validation, and primary-branch fallback

- **Owners:** `tests2/core/base-ref-parse.test.ts`, `tests2/core/clean-build-warnings-regression.test.ts`, `tests2/integration/base-ref-api.test.ts`.
- **Interaction status: MB-GAP.** The MB sidebar fork test sets `base_ref: "master"` and expects the config request to succeed (`tests2/integration/sidebar-actions-fork-github-link.test.ts:243–266`), but it does not assert local/remote/tag/missing ref classification, origin-HEAD fallback, no-origin behavior, or partial multi-repo failure.
- **Affected unit assertions boundary-independent? No.** Existing/missing refs, loose remote refs, tags, remote `HEAD`, branch fallback, sandbox-local-ref rejection, and warnings are assertions about real Git state/output.
- **Proposed seam: MB-GAP.** A typed `RepositoryRefs` (`hasRef`, `remoteHead`, local branches, tags, origin) may support new pure decision tests, but it may not replace the current real-ref assertions. Retain and fixture-optimize those assertions until exact MB-equivalent E2E coverage exists.

### GIT-003 — Command fence for Git/`gh` remote and host-control operations

- **Owners:** `tests2/core/command-runner-fence.test.ts`.
- **Interaction status: MB-GAP.** No MB E2E asserts the full async/sync/spawn matrix, file-remote allow rules, network Git rejection, all-`gh` rejection, Docker rejection, and no-repository short circuit. `tests2/browser/e2e/pr-walkthrough-pack.spec.ts`, `"T-2 — NO_PR..."`, asserts a visible no-PR error, one run request, no reviewer, and no view switch at lines 653–695; it does not identify or prove the command-fence decision.
- **Affected unit assertions boundary-independent? Mixed, therefore not eligible wholesale.** Pure classification expectations are boundary-independent. Assertions that local `rev-parse`, push, or `ls-remote` actually succeed against a real repository/file remote inspect Git behavior and must remain real.
- **Proposed seam: MB-GAP.** Extracting `CommandPolicy.classify(file,args,cwd)` is safe only for the pure classification assertions. Replacing the real positive-control and process-surface assertions is blocked; retain/fixture-optimize them and add an exact E2E before any substantive move.

### GIT-004 — Sanitized repository snapshot for sandbox cloning

- **Owners:** `tests2/core/docker-args.test.ts`.
- **Interaction status: MB-GAP.** MB `multi-repo-flow-api.test.ts` uses local bare origins, but never asserts a sanitized source remains cloneable while `.bobbit/agent/auth.json` is absent. The archived-continuation E2Es clone data, not repositories.
- **Affected unit assertions boundary-independent? No.** Repository validity, committed content, excluded project credentials, and mount-source identity are properties of the produced real repository snapshot.
- **Proposed seam: MB-GAP.** `RepositorySnapshotter.createSanitized(source,destination,exclude)` can isolate implementation, but current snapshot-fidelity assertions must remain real. An in-memory file-selection plan would be new coverage, not a substitute.

### GIT-005 — Native Git status batch

- **Owners:** `tests2/core/git-status-native.test.ts`.
- **Interaction status: MB-GAP.** MB `pr-walkthrough-pack.spec.ts` creates a repository, but its assertions concern bundle confinement, `NO_PR`, and card recovery; it never asserts status fields. No fixed MB integration E2E asserts clean/dirty, untracked, detached, upstream, ahead/behind, merge, or non-repository status results.
- **Affected unit assertions boundary-independent? No.** They explicitly assert parsed/aggregated results produced from real repository graphs and native Git output.
- **Proposed seam: MB-GAP.** A `GitStatusProbe` or typed porcelain snapshot can support additional parser tests, but cannot replace the existing real-output assertions. Retain the native matrix and optimize repository cloning/setup only.

### GIT-006 — Host worktree creation, publication, upstreams, refspec safety, and pool claims

- **Owners:** `tests2/core/local-sub-agent-push-policy.test.ts`, `tests2/core/goal-push-safety-regression.test.ts`.
- **Interaction status: MB-PARTIAL.** MB `tests2/integration/sidebar-actions-fork-github-link.test.ts`, `"newWorktree=true allocates a distinct worktree/branch; newWorktree=false reuses the source worktree"`, asserts a source worktree, a distinct fresh worktree and `session/*` branch, and reuse without a registered worktree at lines 270–316. The stale-source test additionally checks real branch/path existence and distinct replacement at lines 350–386. It does not inspect upstream clearing, pool claims, explicit push refspecs, remote publication, or preservation of `origin/master`.
- **Affected unit assertions boundary-independent? No.** The unit owners inspect real local/bare remote refs, upstream configuration, worktree registration, and push effects.
- **Proposed seam: MB-PARTIAL.** A shared `WorktreeRepository` adapter (`add`, `renameBranch`, `unsetUpstream`, `publish`, `setUpstream`, ref resolution) is architecturally sound, but the MB proof is only creation/reuse. Existing publication/upstream/pool assertions must remain real and may only have fixtures optimized.

### GIT-007 — Team-member worktree lifecycle and persisted base SHA

- **Owners:** `tests2/core/team-manager.test.ts` (`spawnRole + dismissRole (integration with git)`).
- **Interaction status: MB-GAP.** At MB, `tests2/integration/team-dismiss-structured-regression.test.ts`, `"...real core-registered team worker uses TeamManager cleanup"`, asserts spawn registration, a structured `dismissed` response, disappearance from the agent list, and idempotent duplicate dismissal at lines 121–147. It does not create or inspect a Git worktree. The authz test at lines 149–190 likewise asserts authorization and registration only. No other MB E2E asserts member branch/path, exact base commit, local-only base selection, registration, preservation, or persisted `baseSha`.
- **Affected unit assertions boundary-independent? Mixed, therefore not eligible wholesale.** Provision-hook ordering and store-reload orchestration can be expressed independently in new tests. Existing assertions for inherited files, exact HEAD/base SHA, local unpublished bases, distinct worktrees, `git worktree list`, and cleanup/prune inspect real Git/worktree state and must remain real.
- **Proposed seam: MB-GAP.** `TeamWorktreeService.createMember()` returning `{path, branch, baseSha, registered}` may support new orchestration tests, but cannot replace the real integration block. Current-added team-dismiss assertions are supplemental and cannot change this status.

### GIT-008 — Gateway goal/session/staff worktree provisioning and ordering

- **Owners:** `tests2/core/headquarters-no-worktree-runtime.test.ts` (normal-project comparison); `tests2/integration/api-subgoals-disabled.test.ts`, `auto-start-team.test.ts`, `parent-scoped-archive-child.test.ts`, `quiet-pr-status-api.test.ts`, `sandbox-branch-reconcile.test.ts`, `staff-patch-reassign.test.ts`, `stories-sessions-api.test.ts`, and `team-complete-unresolved-children.test.ts`.
- **Interaction status: MB-PARTIAL.** MB `sidebar-actions-fork-github-link.test.ts` proves session setup reaches a real worktree, a new fork gets a distinct path/branch, reuse shares the source path, and a stale-source fork gets an existing fresh branch/path (`:270–316`, `:350–386`). It does not assert staff provisioning, worktree-before-auto-start ordering, child-route preparation, reassignment clearing, or sandbox/non-sandbox reconciliation.
- **Affected unit assertions boundary-independent? Mixed, therefore not eligible wholesale.** Route status, ordering, and metadata persistence can be independent when supplied by a fake service. Existing assertions that a detected repository produced an actual generated branch/worktree/path or that stale worktree metadata was cleared inspect worktree state.
- **Proposed seam: MB-PARTIAL.** A gateway-wide `WorktreeService` with an explicit ready promise/event may support new ordering tests. It cannot replace the existing real provisioning/reconciliation assertions until equivalent E2E cases exist; retain and fixture-optimize those cases.

### GIT-009 — Multi-repository detection and worktree-set lifecycle

- **Owners:** `tests2/integration/multi-repo-goal.test.ts`.
- **Interaction status: MB-PARTIAL.** MB `tests2/integration/multi-repo-flow-api.test.ts`, `"multi-repo project exposes structured data and per-repo worktree lifecycle"`, always asserts structured components and more than one configured repo at lines 91–97. Exact `api`/`web` worktrees, absence of `shared`, path existence, and archive cleanup appear only in the conditional at lines 135–152. Lines 153–157 permit a single-worktree fallback. This is not assertion-equivalent proof of mandatory multi-repo worktree creation.
- **Affected unit assertions boundary-independent? Yes for the only active assertion.** The active unit assertion merely retrieves the created goal; intended per-repository worktree assertions are TODO. Its real Git setup is scaffolding, not an assertion about Git output/state.
- **Proposed seam: MB-PARTIAL.** `ComponentRepositoryResolver` plus `WorktreeService.createSet` is still blocked by missing mandatory MB E2E equivalence. The current unit assertion could be rewritten as a non-Git route test only after this row is accepted as non-substantive fixture removal; it cannot be cited as coverage of component/worktree semantics. Post-MB strengthened multi-repo assertions are supplemental only.

### GIT-010 — Worktree inventory, ownership guards, cleanup, and branch deletion

- **Owners:** `tests2/core/shared-worktree-guard-repro.test.ts`, `tests2/integration/maintenance-api.test.ts`.
- **Interaction status: MB-PARTIAL.** MB `multi-repo-flow-api.test.ts:135–152` conditionally checks that two recorded worktree directories disappear on archive, but permits fallback. MB `sidebar-actions-fork-github-link.test.ts:388–392` deletes a source worktree/branch in test setup and asserts they are gone before checking cloned transcript metadata; this is test-helper cleanup, not the production maintenance classifier/API. Neither proves shared-owner preservation, stale/collision/selector classification, sandbox skipping, selected/all cleanup, or safe branch-deletion outcomes.
- **Affected unit assertions boundary-independent? Mixed, therefore not eligible wholesale.** Ownership-index classification can be pure when given an inventory. Existing assertions that real worktrees/branches exist, remain, or are removed and that Git reports deletion outcomes inspect real worktree/Git state.
- **Proposed seam: MB-PARTIAL.** `WorktreeInventoryBackend` plus a canonical ownership index can host new pure classification tests, but cannot replace real removal/preservation/branch assertions. Keep those real and optimize shared clone fixtures until exact production-maintenance E2E exists.

### GIT-011 — Verification commit identity and non-destructive remote sync

- **Owners:** `tests2/core/verification-basebranch-regression.test.ts`, `tests2/core/verification-goal-sync-nondestructive.test.ts`, `tests2/integration/gate-reset-api.test.ts`, `gate-signal-reminder.test.ts`, and `verification-restart-resignal.test.ts`.
- **Interaction status: MB-GAP.** None of the fixed MB E2E files or MB browser E2E tests asserts equal/local-ahead/remote-ahead/diverged/absent Git graphs, current-HEAD signal identity, ancestry, hook-free hard fast-forward, or preservation of local commits.
- **Affected unit assertions boundary-independent? No.** They inspect real commit SHAs, ancestry, refs, fetch/reset effects, hooks, and warning behavior derived from real repository graphs.
- **Proposed seam: MB-GAP.** `VerificationGit` with typed relationships may enable additional decision tests, but it cannot replace any existing real graph assertion. Retain and fixture-optimize all native graph/sync cases.

### GIT-012 — Commit/diff extraction, local changesets, and durable hunk identity

- **Owners:** `tests2/core/pr-walkthrough-diff-parser.test.ts`, `pr-walkthrough-export-mapper.test.ts`, `pr-walkthrough-durable-routes.test.ts`, and `tests2/integration/pr-walkthrough-api.test.ts`.
- **Interaction status: MB-PARTIAL.** MB has strong but bounded proof:
  - `tests2/integration/commit-file-diffs-api.test.ts`, `"session commits include changed files and commit-scoped git-diff"` and `"goal commits include changed files and commit-scoped git-diff"`: lines 70–110 assert M/A/D/R metadata, old rename path, patch markers, traversal rejection, and invalid-commit rejection; lines 126–140 add a worktree diff; lines 148–177 prove goal worktree readiness and goal commit/diff extraction.
  - `tests2/browser/e2e/pr-walkthrough-pack.spec.ts`, `"no-install dogfood..."`: lines 418–432 create the session repository and prove caller `repoDir` cannot expose another repository's diff.
  - The same browser file, `"T-4 — bound child pane self-recovers READY cards..."`: lines 842–888 creates a real diff-backed session, publishes/re-bundles live evidence, and proves card recovery across reload.
  These do not assert every unit owner’s generated-file classification, duplicate hunk ownership, ambiguous/stale anchor, quota, and fallback-evidence branches.
- **Affected unit assertions boundary-independent? Mixed, therefore not eligible wholesale.** Pure parsing of caller-supplied unified-diff text is boundary-independent. Any existing assertion whose input is obtained from a real repository, or that verifies live SHA/diff/hunk anchoring against that repository, inspects Git output/state and must remain real.
- **Proposed seam: MB-PARTIAL.** `ChangesetSource.read(base,head,limits)` and immutable diff evidence can support new pure parser/synthesis tests. They cannot replace the current real-output assertions, including the shared local-Git export fixture and live durable-route anchoring. Retain or fixture-optimize those tests.

### GIT-013 — GitHub CLI auth, PR resolution/export, and GitHub link derivation

- **Owners:** `tests2/core/pr-walkthrough-export-mapper.test.ts`, `pr-walkthrough-trusted-hosts.test.ts`, `tests2/integration/pr-walkthrough-api.test.ts`, and repository-side `quiet-pr-status-api.test.ts`.
- **Interaction status: MB-PARTIAL.** MB `tests2/integration/sidebar-actions-fork-github-link.test.ts`, `"GET /api/goals/:id/github-link returns PR, branch fallback, and unavailable states"`, asserts cached PR URL, no-worktree, missing-goal, and SSH-origin-derived branch URL at lines 170–205. MB `pr-walkthrough-pack.spec.ts`, `"T-2 — NO_PR..."`, asserts visible no-PR behavior at lines 653–695. Neither invokes and verifies authenticated `gh auth token`, enterprise `--hostname`, review payload stdin, permission/ruleset APIs, or merge capability.
- **Affected unit assertions boundary-independent? Mixed, therefore not eligible wholesale.** Pure host/trust/confirmation decisions are boundary-independent. Assertions that execute fake `gh`/`gh.cmd`, inspect argv/stdin, observe launch failure, or consume CLI output test the process/CLI contract and are not eligible for mocking.
- **Proposed seam: MB-PARTIAL.** A typed `GithubClient` is useful for new mapping/policy tests, but existing executable-shim and launch-failure assertions must remain real. MB branch-link/`NO_PR` proof cannot license migration of auth/export/enterprise behavior.

### GIT-014 — Git-tracked source census used by an architecture guard

- **Owners:** `tests2/core/extension-host-no-capability-sandbox-residual.test.ts`.
- **Interaction status: MB-GAP.** No MB E2E assertion is equivalent, and the boundary is test architecture rather than product behavior.
- **Affected unit assertions boundary-independent? Yes.** The substantive assertion checks forbidden source tokens; `git ls-files` only supplies the file census.
- **Proposed seam: MB-GAP under the strict two-condition rule.** `TrackedFilesProvider` or bounded direct-root enumeration would remove incidental Git I/O, but there is no qualifying MB E2E. Therefore this audit does not authorize that change as a coverage migration. It may be considered separately only as an explicitly non-substantive architecture-fixture rewrite preserving the same tracked-file census.

### GIT-015 — Headquarters “never provision a worktree” suppression

- **Owners:** `tests2/core/headquarters-no-worktree-runtime.test.ts`.
- **Interaction status: MB-GAP.** MB `tests2/integration/project-isolation.test.ts` asserts project/store isolation, not Headquarters worktree suppression. No MB E2E compares repo-backed Headquarters and normal projects while asserting no Headquarters goal/session/staff/pool worktree is provisioned.
- **Affected unit assertions boundary-independent? Mixed, therefore not eligible wholesale.** A pure policy decision or “adapter not called” test can be independent. Existing cases use committed repositories to prove real Git-backed inputs are suppressed, and the normal-project comparison asserts real preparing/repository/branch/worktree metadata; those inspect derived Git/worktree state.
- **Proposed seam: MB-GAP.** `WorktreePolicy.decide(projectScope,request)` before repository detection may host new pure policy tests, but it cannot replace the existing real suppression/comparison assertions without exact E2E equivalence.

### GIT-016 — Incidental or unproved Git scaffolding

- **Owners:** `tests2/integration/gate-bypass-api.test.ts`, `tests2/integration/project-bugs.test.ts`.
- **Interaction status: MB-GAP.** No MB E2E proves a Git semantic for these active tests. `gate-bypass-api` asserts bypass audit/authz while requesting `worktree:false`; `project-bugs` has its subdirectory-worktree assertion skipped.
- **Affected unit assertions boundary-independent? Yes for the active assertions.** Bypass/authz and project registration do not inspect Git output/state; the real repository setup is incidental. The skipped assertion supplies no coverage.
- **Proposed seam: MB-GAP under the strict two-condition rule.** A non-Git fixture or injected repository discovery would remove incidental cost, but no MB E2E satisfies the first condition. This audit therefore authorizes no migration. If treated separately as fixture deletion, it must preserve all active assertions and must not be represented as Git/worktree coverage.

## Complete unit-owner inventory

This is the de-duplicated inventory for the interactions above.

**Core (18):**

- `agent-dir-validation.test.ts`
- `base-ref-parse.test.ts`
- `clean-build-warnings-regression.test.ts`
- `command-runner-fence.test.ts`
- `docker-args.test.ts`
- `extension-host-no-capability-sandbox-residual.test.ts`
- `git-status-native.test.ts`
- `goal-push-safety-regression.test.ts`
- `headquarters-no-worktree-runtime.test.ts`
- `local-sub-agent-push-policy.test.ts`
- `pr-walkthrough-diff-parser.test.ts`
- `pr-walkthrough-durable-routes.test.ts`
- `pr-walkthrough-export-mapper.test.ts`
- `pr-walkthrough-trusted-hosts.test.ts`
- `shared-worktree-guard-repro.test.ts`
- `team-manager.test.ts`
- `verification-basebranch-regression.test.ts`
- `verification-goal-sync-nondestructive.test.ts`

**Integration still in unit scope (17):**

- `api-subgoals-disabled.test.ts`
- `auto-start-team.test.ts`
- `base-ref-api.test.ts`
- `gate-bypass-api.test.ts`
- `gate-reset-api.test.ts`
- `gate-signal-reminder.test.ts`
- `maintenance-api.test.ts`
- `multi-repo-goal.test.ts`
- `parent-scoped-archive-child.test.ts`
- `pr-walkthrough-api.test.ts`
- `project-bugs.test.ts`
- `quiet-pr-status-api.test.ts`
- `sandbox-branch-reconcile.test.ts`
- `staff-patch-reassign.test.ts`
- `stories-sessions-api.test.ts`
- `team-complete-unresolved-children.test.ts`
- `verification-restart-resignal.test.ts`

## Explicit non-owners

The following remain outside the real-boundary owner inventory unless a case also executes real Git/`gh` or copies a real repository:

- pure parsers and decisions with supplied text/data, including `git-diff-unified-parser`, `git-shortstat-parser`, `git-status-local-only-policy`, `pr-status-lookup`, `pr-walkthrough-local-resolver`, `worktree-inventory`, `worktree-support`, `worktree-sweeper-multi`, `orphan-branch-eager-delete`, and `session-worktree`;
- filesystem-only `.git` marker scans;
- generic copy/migration tests that do not copy a repository;
- fake sandbox/worktree objects; and
- route-mocked browser presentation tests.

## Re-audit conclusion

Under the strict MB-only and boundary-independent-assertion rule, **no interaction is approved for a substantive wholesale migration to mocked Git/worktree/`gh` I/O**.

- `GIT-006`, `GIT-008`, `GIT-009`, `GIT-010`, `GIT-012`, and `GIT-013` are **MB-PARTIAL**.
- All other rows are **MB-GAP**.
- The strongest MB proof is native commit/diff extraction, but affected real unit assertions that inspect Git-produced diffs, SHAs, or live hunk state remain ineligible for mocking.
- Current-added team-dismiss and strengthened multi-repo assertions remain supplemental and do not alter any MB status.

Permitted optimization is narrow: share templates, clone/copy fixtures more cheaply, reduce redundant commits/process launches, and add new pure tests at the proposed seams. Do not replace an existing real assertion that observes Git/worktree/`gh` output or state until an exact qualifying E2E exists and that specific assertion is independently shown not to depend on the boundary.
