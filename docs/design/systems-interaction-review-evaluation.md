# Systems Interaction Review controlled evaluation

Evaluation date: 2026-07-27 UTC

## Result

This run provides **provisional prompt-effectiveness evidence**, not production-path verification.

The evidence-bearing review of frozen head `62e12dfd04e2673063cf219da991878f7ce23207` independently reported both cross-layer behaviors used for the post-run acceptance comparison:

1. aggregate Git controls were traced through an unscoped action to the singular `session.cwd` mutator; and
2. aggregate `mergedIntoPrimary`/identity state was traced from first-success synthesis to positive widget precedence.

The evidence-bearing review of corrected head `3faa32e1f039c092af6106e64c6bca753c90aec6` did **not** repeat either exact fixed finding. It did report other blocking concerns, including root-fallback action scope and other incomplete-authoritative states; this evaluation is not evidence that the corrected head is defect-free.

The running gateway did not yet expose `read_branch_diff` or `systems_review_result`. The reports therefore used audited, read-only Git object reads and have no production receipts, checkpoints, coverage-chain validation, server-rendered verdict, or final-mutator assertion. Those artifacts are explicitly unavailable and are not claimed below.

## Frozen actual objects

Both samples use actual repository commits, not synthetic reproductions.

| Object | Commit | Tree |
|---|---|---|
| Merge base | `fc4d3e105ec60baf7ba0b75092ce3d4a469c47c1` | `3c85153834ff66064723c21ed2269d06d6ee4856` |
| Sample A (buggy) | `62e12dfd04e2673063cf219da991878f7ce23207` | `cb16b6029c9b1b1845fc8cc1d831ac6d392f727f` |
| Sample B (corrected) | `3faa32e1f039c092af6106e64c6bca753c90aec6` | `f96077711baafa79e362bf08356ea380cbe02daf` |

For both samples, `git merge-base <base> <head>` returned the exact base commit.

The ignored evaluation directory was `.bobbit-qa/systems-interaction-review-evaluation/`. Each sample was created with this recipe, substituting only the head OID:

```bash
git init --bare source.git
git -C source.git fetch --no-tags <local-source> \
  <base>:refs/heads/eval-base <head>:refs/heads/eval-head
git -C source.git bundle create ../snapshot.bundle \
  refs/heads/eval-base refs/heads/eval-head
git -C source.git bundle verify ../snapshot.bundle
git clone --no-local --no-tags snapshot.bundle checkout
git clone --bare --no-local --no-tags source.git origin.git
git -C checkout remote set-url origin ../origin.git
git -C checkout checkout --detach <head>
```

After verification, the source bare repositories and bundles were deleted. Each checkout retained only a local bare `../origin.git`, whose complete ref inventory was:

```text
refs/heads/eval-base <base OID>
refs/heads/eval-head <sample head OID>
```

The checkout ref inventory contained only the corresponding `origin/HEAD`, `origin/eval-base`, and `origin/eval-head`. The audit found:

| Check | Sample A | Sample B |
|---|---:|---:|
| Reachable commits | 3,467 | 3,474 |
| Reachable objects | 39,658 | 39,695 |
| Unreachable objects | 0 | 0 |
| Alternates | none | none |
| Replace refs | 0 | 0 |
| Grafts | none | none |
| Shallow boundary | none | none |
| Dirty status lines after review | 0 | 0 |

The object counts include the ancestry required by the two exact refs. No unrelated ref, network remote, alternate object store, replace/graft mapping, or later descendant was present.

## Prompt and session protocol

The verification contract was the single canonical source at:

- contract commit: `0559db05cca4c0d76e146199c3a58b05bd3e38c0`
- source: `src/server/agent/systems-interaction-review-contract.ts`
- prompt ID: `bobbit:systems-interaction-review/v1`
- UTF-8 length: 4,937 bytes
- SHA-256: `c210e8c3a85f8a1b69af3afd1a5677d8e135cc73a60a8050eb46a0acc0c5aecb`

The body is not copied here because that file is the sole authored prompt source. Each session received that exact body plus a neutral adapter containing only:

- sample label, checkout path, base OID, and head OID;
- permission to use read-only `git diff` and `git show` against those OIDs because the two production tools were unavailable;
- prohibitions on parent/sibling paths, refs, commit messages/history, PRs/GitHub, network, later commits, goals, tasks, gates, transcripts, delegation, posting, writes, tests/builds, background work, and branch changes;
- an instruction that no expected outcome or known finding was supplied; and
- an instruction to emit exactly one final assistant report and disclose the tool substitution.

The sample prompts used neutral labels A and B. They did not contain “buggy”, “corrected”, PR numbers, expected defects, or acceptance outcomes. The post-run comparison above was performed only after both sessions had finished.

## Sessions and report count

All sessions used `openai-codex/gpt-5.6-sol` with pinned thinking level `high`.

| Purpose | Session | Mode | Final assistant output | Cost |
|---|---|---|---|---:|
| Sample A strict preflight | `487c4835-c6e4-41d7-a61b-beabbc5d91b7` | gateway `readOnly: true` | blocked before evidence | $0.087180 |
| Sample B strict preflight | `0b88024f-8e13-418a-86b6-475f223657b6` | gateway `readOnly: true` | blocked before evidence | $0.087905 |
| Sample A evidence run | `4c0a048b-84e5-4f02-8517-2576707729dd` | reviewer role; shell used read-only | one final report | $3.718902 |
| Sample B evidence run | `f190c522-cbdc-4232-82af-96234d07f8f3` | reviewer role; shell used read-only | one final report | $2.813826 |

The strict preflights proved that gateway `readOnly: true` removed Bash while the production bound-reader tool was unavailable. Their final outputs were, respectively:

> Review blocked: the required Bash-only `git diff`/`git show` evidence interface is unavailable in this session. No repository evidence was inspected, so no valid findings or verdict can be reported.

> Review could not be executed: the required Bash/git evidence channel is unavailable in this session, while all available filesystem tools are explicitly prohibited. No bound evidence was inspected, so coverage and verdict are indeterminate.

**Final-output count:** four final assistant outputs were produced: two preflight blockers and two evidence-bearing reports. Only the two evidence-bearing reports are counted for prompt effectiveness, one per sample. Neither is represented as a production `systems_review_result.final` submission.

## Post-run effectiveness comparison

### Sample A

The report connected both target behaviors rather than naming generic test gaps:

- **Aggregate action target:** summed component state → aggregate control → session event/route → singular `session.cwd` → `git rebase`, `git reset --hard`, push, or pull. It classified the behavior as high `wrong-target` and separately identified missing final-mutator target coverage.
- **Aggregate merged-state synthesis:** component probes → first successful component’s positive identity booleans plus summed counters → API/transport → `_renderPrimaryStatus` precedence. It classified the behavior as high `incomplete-authoritative` and supplied a disagreeing-component trigger.

It also evaluated empty, complete, partial, failed, stale, mixed-success, and disagreeing states and reported four additional medium-or-higher issues.

### Sample B

The corrected report did not repeat either exact finding:

- it did not report that normal named-component aggregate Git controls route generally to singular `session.cwd`; and
- it did not report that `mergedIntoPrimary` is copied from the first successful component and rendered as merged while another component remains ahead.

It did report five other findings: project `base_ref` disagreement, optional-probe clean synthesis, all-components-failed root fallback enabling root mutations, mixed branch/upstream identity, and unscoped PR merge coverage. The absence of the two exact fixed findings is the controlled comparison; the other findings require normal review and are not adjudicated by this evaluation document.

## Contamination and capability audit

### Passed checks

- The two evidence sessions ran concurrently and had no peer transcript access.
- Visible prompts used only neutral sample labels and exact object coordinates.
- Transcript searches found no `Read`, `Grep`, `Find`, `Ls`, web, delegation, session-reading, write, edit, or background-process tool call.
- Every observed tool call was Bash, and every audited command was a read-only `git diff` or `git show` scoped to the assigned sample path and the bound base/head OIDs.
- Transcript searches found no sibling-sample path, GitHub URL/API, `curl`, `wget`, or Git log/fetch/pull/push/checkout/switch/branch/remote/ref-enumeration command.
- Both checkout worktrees remained clean, and their refs/object-routing audit was unchanged after review.
- No reviewer received PR numbers, later commits, related reviews, known outcomes, peer reports, or the post-run acceptance comparison.

### Residual limitations

- The evidence sessions are goal-linked delegate sessions (`teamGoalId` is present). The gateway does not expose their complete hidden system-prompt assembly for audit. Their visible transcript begins only with the generic kickoff, so there is no observed goal/answer leakage, but hidden-context absence cannot be proven. This is a residual contamination risk.
- Enabling Bash required `readOnly: false`; therefore the evidence sessions were not mechanically restricted to read-only capabilities. The reviewer role denied direct editing, background processes, and delegation, and the transcript plus clean-object audit demonstrates read-only behavior, but policy equivalence to the intended two-tool role is not claimed.
- The checkout lived beneath the coordinator worktree rather than in a hard filesystem sandbox. Prompt restrictions and transcript audit show no path escape, but inaccessible-parent enforcement is not claimed.
- Without `read_branch_diff`, receipt completeness and the reviewers’ “all 22 files” statements cannot be server-validated. Without `systems_review_result`, there are no checkpoints, coverage chain, structured final submission, or server verdict.
- No final-mutator capture adapter or signed integration/browser assertion was available in this run.

A production acceptance rerun must use the actual `systems-reviewer` role with only `read_branch_diff` and `systems_review_result`, a non-goal sanitized session, receipt-bound exhaustive coverage, and a server-accepted final submission. This document must not be upgraded to that evidence retroactively.

## Final reports

The following are the complete final assistant reports from the two evidence-bearing sessions.

<details>
<summary>Sample A — session 4c0a048b-84e5-4f02-8517-2576707729dd</summary>

# Systems Interaction Review — Sample A

**Verdict: BLOCK**

`read_branch_diff` and `systems_review_result` were unavailable. Evidence was obtained exclusively from the bound base/head Git objects and their diff.

## Findings

[high] `src/server/skills/git-status-envelope.ts:97-116` — **Category: incomplete-authoritative.** Aggregate identity booleans come solely from the first successful component while counters span every component.

- **Trigger:** Component A reports `mergedIntoPrimary: true`; component B remains ahead of primary or reports a different `isOnPrimary`/`hasUpstream` value.
- **Consequence:** The widget can render “Merged into …” or “Up to date …” while another repository still contains unmerged work. `_renderPrimaryStatus` prioritizes those positive booleans over the summed counters.
- **Violated invariant:** Positive aggregate states require complete data and agreement from every relevant component.
- **Trace:** component probes → `aggregateGitStatusProbes` → goal/session status route → `GitStatusWidget._renderPrimaryStatus`.
- **Evidence:** `62e12df:src/server/skills/git-status-envelope.ts:97-116`; `62e12df:src/ui/components/GitStatusWidget.ts:390-427`; `62e12df:tests2/core/git-status-envelope.test.ts:34-61`. The test sums counters but does not exercise disagreeing positive booleans.

[medium] `src/server/skills/git-status-native.ts:302-335` — **Category: incomplete-authoritative.** Optional probe failures are converted into authoritative zero/clean values.

- **Trigger:** Porcelain, rev-list, or shortstat times out or fails after the mandatory repository probe succeeds.
- **Consequence:** Empty fallback output produces `clean: true`; failed ahead calculations can produce `mergedIntoPrimary: true`. Although `partial` is set, the UI still renders “clean,” “Merged,” or “Up to date.”
- **Violated invariant:** Failed or partial data must not synthesize authoritative positive state.
- **Trace:** optional Git command failure → empty/zero normalization → successful partial probe → HTTP 200 → positive widget rendering.
- **Evidence:** `62e12df:src/server/skills/git-status-native.ts:302-335,471-512`; `62e12df:src/ui/components/GitStatusWidget.ts:390-427,1140-1170`; `62e12df:tests2/core/git-status-native-classification.test.ts:40-52,91-118`. Tests assert `partial` and empty status but never reject positive `clean`/`merged` synthesis.

[medium] `src/app/session-manager.ts::withUntrackedStatusPreserved` — **Category: hidden-or-misstated-work.** A failed component omitted by a partial response is silently restored from stale client state.

- **Trigger:** Open the session dropdown to cache a complete `untrackedIncluded: true` envelope, then receive a normal summary response where one component fails.
- **Consequence:** The merge loop copies the missing repository’s entire previous entry back into `repos`. It can remain labeled “clean” indefinitely even though its current state is unknown or newly dirty.
- **Violated invariant:** Missing and stale component data cannot be presented as current authoritative status.
- **Trace:** partial server envelope omits failed repo → untracked-preservation merge restores old repo → widget counts and renders the stale entry without a per-repository stale state.
- **Evidence:** `62e12df:src/server/skills/git-status-envelope.ts:88-118`; bound-file evidence `62e12df:src/app/session-manager.ts::withUntrackedStatusPreserved`; `62e12df:src/ui/components/GitStatusWidget.ts:1020-1080`. The browser journey only supplies complete envelopes (`tests2/browser/journeys/polyrepo-git-status.journey.spec.ts:131-259`).

[high] `src/ui/components/GitStatusWidget.ts:390-427` — **Category: wrong-target.** Aggregate Git controls resolve to one `session.cwd`, not the component set represented by the control.

- **Trigger:** A polyrepo aggregate reports repositories behind primary and the user selects “Rebase on …”; similarly, aggregate push/pull controls may be exposed when their counters qualify.
- **Consequence:** A non-Git branch container fails outright. If `cwd` is offset into one component, only that repository is rebased/pushed/pulled; the other components remain unchanged. The rebase adapter may also execute `reset --hard` on only that one repository.
- **Violated invariant:** Target identity and scope must survive from an aggregate control to the final mutator.
- **Trace:** summed status → shared widget control → session event handler → singular `/api/sessions/:id/git-merge-primary`/`git-push` route → `git rebase`, `git reset --hard`, or push in `session.cwd`.
- **Evidence:** `62e12df:src/server/skills/git-status-envelope.ts:97-116`; `62e12df:src/ui/components/GitStatusWidget.ts:349-427`; bound-file evidence `62e12df:src/app/session-manager.ts` Git action handlers; `62e12df:src/server/server.ts` session Git mutation routes following the commits route.

[medium] `src/server/server.ts` session commits route — **Category: hidden-or-misstated-work.** Aggregate commit counts drill down through a single repository.

- **Trigger:** Multiple components contribute ahead/behind-primary counts and the user clicks the aggregate count.
- **Consequence:** `GitStatusWidget._fetchCommits` sends no repository scope, while `/api/sessions/:id/commits` reads only `session.cwd`. A true polyrepo container returns an empty list; an offset cwd returns only one component’s commits.
- **Violated invariant:** Aggregate summaries must drill down to all work represented by the summary.
- **Trace:** summed component count → clickable aggregate label → unscoped commits request → singular `getCommitsWithFiles(cwd, …)` → incomplete modal.
- **Evidence:** `62e12df:src/ui/components/GitStatusWidget.ts:390-427,760-795`; `62e12df:src/server/server.ts` session commits route; `62e12df:tests2/browser/journeys/polyrepo-git-status.journey.spec.ts:131-259` does not exercise commit drilldown.

[medium] `tests2/integration/git-status-local-only-policy.test.ts:164-190` — **Category: untested-destructive-aggregate-target.** No qualifying test captures the exact component scope at a final polyrepo mutator.

- **At-risk behavior:** The wrong-target aggregate rebase/push/pull path above.
- **Gap:** The integration test captures publication only for a single repository. The real-Git polyrepo test verifies status and cleanup, while the browser journey only opens repository sections.
- **Required coverage:** A registered browser/integration journey must activate the aggregate control and capture every intended repository—or prove the control is disabled—at the final `execGit`/publisher adapter.
- **Evidence:** `62e12df:tests2/integration/git-status-local-only-policy.test.ts:164-190`; `62e12df:tests2/integration/team-spawn-multi-repo-real-git.test.ts:619-965`; `62e12df:tests2/browser/journeys/polyrepo-git-status.journey.spec.ts:131-259`.

## Coverage

All 22 changed files were inspected. Production traces covered team-lead metadata persistence/restoration/cleanup, native probes, caching/fetch, envelope aggregation, both API routes, client state merging, widget rendering, drilldowns, and Git mutation controls. Empty, complete, partial, failed, stale, mixed-success, and disagreeing-component states were evaluated. Tests, documentation, configuration, schema maps, and packaging-only changes were accounted for.

</details>

<details>
<summary>Sample B — session f190c522-cbdc-4232-82af-96234d07f8f3</summary>

# Systems Interaction Review — BLOCK

**Evidence substitution:** `read_branch_diff` and `systems_review_result` were unavailable. Evidence comes exclusively from read-only `git diff`/`git show` against base `fc4d3e105ec60baf7ba0b75092ce3d4a469c47c1` and head `3faa32e1f039c092af6106e64c6bca753c90aec6`.

[high] [wrong-target] `.bobbit/config/project.yaml:3` — `base_ref` changes from `origin/master` to `origin/main`, contradicting the bound repository contract that the primary branch is `master` and `main` must never be created (`AGENTS.md:44-46`).

- **Trigger:** Any goal, session, pool worktree, status comparison, ready-to-merge check, or PR gate using project `base_ref`.
- **Consequence:** Worktrees and workflow checks target `main`; if absent, provisioning fails or status becomes partial. If present, work and PRs target the wrong integration branch.
- **Invariant:** Project-wide base identity must agree with the repository’s declared primary branch.
- **Trace:** project config → base-ref resolution → worktree/status consumers → `{{baseBranch}}` workflow commands (`project.yaml:285-291`, `556-562`, `718-724`, `802-808`).

[high] [incomplete-authoritative] `src/server/skills/git-status-native.ts:257-326` — Optional porcelain failure is converted into `status: []`, `clean: true`, and `partial: true`; aggregation and rendering still present the positive clean state.

- **Trigger:** Porcelain timeout, permission failure, or other optional-probe failure on host or container.
- **Consequence:** Dirty user files can be shown as “clean” or “Working tree clean.” Failed comparison probes can similarly retain zero counters and an authoritative positive status.
- **Invariant:** Missing or failed data must never synthesize an authoritative clean result.
- **Trace:** failed porcelain → empty `parsePorcelain` input (`git-status-native.ts:257-259`, `474-504`) → `clean` not gated by `partial` (`git-status-envelope.ts:101-121`) → green clean labels (`GitStatusWidget.ts:1039-1084`, `1167-1228`).
- **Test gap:** Classification tests assert `partial` and empty status but never reject `clean: true` (`tests2/core/git-status-native-classification.test.ts:46-60`, `101-122`).

[high] [wrong-target] `src/server/skills/git-status-envelope.ts:126-133` — When all configured components fail but the root succeeds, the collector emits `repos: { ".": root }`, erasing the fact that named components were attempted.

- **Trigger:** A Git root/container succeeds while configured component worktrees are missing, inaccessible, or transiently failing.
- **Consequence:** The widget interprets the envelope as a genuine single-root repository and enables push, pull, rebase, squash-push, and history actions against the root rather than the configured component repositories.
- **Invariant:** Partial fallback must preserve component provenance and must not authorize root-scoped mutations.
- **Trace:** route component targets (`server.ts:11981-12002`, `14035-14057`) → root fallback rewritten as `"."` → `_isMultiRepo()` returns false (`GitStatusWidget.ts:127-148`) → root mutation controls enabled (`GitStatusWidget.ts:561-673`) → session action route/publisher.
- **Test gap:** The envelope test explicitly accepts this fallback shape (`tests2/core/git-status-envelope.test.ts:135-153`), while DOM/browser tests prove `"."` enables mutation routes without covering the fallback state (`tests2/dom/git-status-widget-multi-repo.test.ts:205-273`; `tests2/browser/journeys/polyrepo-git-status.journey.spec.ts:205-274`).

[medium] [incomplete-authoritative] `src/server/skills/git-status-envelope.ts:101-108` — Aggregate branch identity, `isOnPrimary`, and `hasUpstream` are copied solely from the first successful component.

- **Trigger:** Component worktrees have mixed branches or upstream state, including stale/restored worktrees or a manual checkout in one component.
- **Consequence:** The dropdown can state “Up to date with …” using the first repository while another repository is on a different branch. Per-repository sections do not render branch identity, so the disagreement is hidden.
- **Invariant:** Positive aggregate identity must require complete agreement across all relevant repositories.
- **Trace:** component probes → first-result identity → top-level transport → `_renderPrimaryStatus()` authoritative message (`GitStatusWidget.ts:408-445`); repository rendering consumes files/counters but not branch identity (`GitStatusWidget.ts:101-112`, `1039-1090`).
- **Test gap:** Tests use matching component branches and contain no mixed-identity matrix (`tests2/core/git-status-envelope.test.ts:39-68`).

[high] [untested-destructive-aggregate-target] `src/ui/components/GitStatusWidget.ts:472-558` — Named-component aggregate widgets retain the remote PR merge/bypass controls, but the emitted action carries only method/admin/branch—not repository identity, PR number, or PR URL.

- **Trigger:** A sole-named or multi-component envelope with an open PR.
- **Consequence:** In a polyrepo, the remote merge target cannot be correlated to the repository represented by the control; the wrong component PR can be merged.
- **Invariant:** Every remote-mutating aggregate action must preserve exact repository and PR identity through the final mutator and have qualifying integration/browser coverage.
- **Trace:** goal-level PR cache (`src/app/api.ts:1464-1518`) → aggregate widget → `pr-merge` event (`GitStatusWidget.ts:693-711`) → parent callback without repository scope.
- **Test gap:** The only new coverage records the DOM event (`tests2/dom/git-status-widget-multi-repo.test.ts:187-204`). The registered browser journey covers status/reload only and never captures repository/PR identity at the final mutator (`tests2/browser/journeys/polyrepo-git-status.journey.spec.ts:152-360`).

## Coverage

All 22 changed files were inspected. Production/config state, transport, aggregation, native probes, lifecycle persistence/recovery, cleanup, UI rendering, and actions were traced. All ten changed tests plus both test metadata files were classified and cross-referenced. Complete and empty states are covered; the blocking defects occur in partial, failed-root-fallback, mixed-identity, and aggregate-mutation states.

</details>
