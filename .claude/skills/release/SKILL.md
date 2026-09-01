---
name: release
description: Cut a Bobbit release — preflight checks, version bump and release notes in a release PR; merging it makes CI publish to npm via OIDC, tag the commit, and create the GitHub release. Optional binary sub-packages stay manual.
argument-hint: [major|minor|patch|<explicit-version>]
---

Drive an end-to-end release of Bobbit. The human's job is the **release PR**:
version bump + release notes, reviewed and squash-merged. Merging it is what
releases — the release PR's required GitHub checks run the test suites, then
`.github/workflows/release-publish.yml` validates, builds, type-checks, and packs
an immutable tarball without publish authority, publishes that exact tarball to
npm (trusted publishing / OIDC, with provenance), creates the tag, and creates
the GitHub release. **Never** create the release tag, run a root `npm publish`, or
create the GitHub release by hand. `npm login` / OTP is needed **only when
republishing binary sub-packages** — pause and ask when the flow needs it.

Single source of truth for release mechanics: [`docs/releasing.md`](../../../docs/releasing.md).
This skill orchestrates that doc + version bump + notes + GitHub release.

**Where this runs — read this first.** Never cut the release from the **primary
worktree**: the dev server runs there, and `npm ci` / `npm run build` would wipe
its `node_modules` / overwrite its `dist/` and break the running server
mid-release. Never cut it from a **session worktree** either — that's on a
session branch, not `main`, and git won't let you check out `main` in a
second worktree while the primary already has it. Instead, §1.5 creates a
dedicated **detached-HEAD worktree off `origin/main`** (a sibling of the
primary, *not* under `*-wt/`), and every mutating step runs there. The release
commit is pushed to a `release/v<version>` branch and squash-merged through the
repository's required PR flow (§6–§8); the resulting merge commit is what gets
tagged.

## 0. Sanity check the environment

These are location-independent (the `.git` is shared across worktrees), so run
them from wherever the skill was activated. Report results before doing
anything mutating:

```bash
git fetch origin --tags
git rev-parse origin/main                # sha we'll release from
git tag --sort=-v:refname | head -5      # find previous tag
git log --oneline <prev-tag>..origin/main | head    # must be non-empty (something to release)
node -v                                  # must satisfy engines.node (>=22.19.0)
npm whoami                               # only needed if republishing binary sub-packages (§3); root ships via CI
gh auth status                           # must be authed for G-Research/bobbit
```

Note: do **not** gate on the current worktree's branch or cleanliness — the
release is cut from a fresh detached worktree at `origin/main`'s tip (§1.5),
so the session/primary worktree state is irrelevant. What matters is that
`origin/main` is the intended release point.

**Stop and ask the user** if any of:
- `origin/main` has nothing new since the previous tag (nothing to release), or it isn't the commit they expect to ship.
- `npm whoami` fails **and** step 3 will republish binary sub-packages — ask them to run `npm login` (and enable 2FA if not already; npm requires OTP for those sub-package publishes). The root `@gresearch/bobbit` publish needs no npm login — it goes through CI/OIDC.
- `gh auth status` not logged in — ask them to run `gh auth login`.

## 1. Decide the new version

`$ARGUMENTS` is one of `major`, `minor`, `patch`, or an explicit `X.Y.Z`.
If absent, ask the user via `ask_user_choices` with the current version
shown and recent commit summary so they can pick.

Read current version from `package.json`. Compute next version. Confirm
with the user before bumping. Use `ask_user_choices` for the confirmation
so it's one click.

## 1.5 Create the isolated release worktree

All mutating steps (§2 onward) run inside a dedicated detached-HEAD worktree
so the running dev server in the primary worktree is never disturbed. Create
it as a sibling of the primary worktree, **outside** the `*-wt/` pool dir (so
the gateway never mistakes it for a session worktree):

```bash
# The main working tree is always the FIRST entry of `git worktree list`,
# regardless of which worktree the skill was activated in.
PRIMARY=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
RELDIR="$(dirname "$PRIMARY")/bobbit-release-<new-version>"
git fetch origin --tags
git worktree add --detach "$RELDIR" origin/main
cd "$RELDIR"
git rev-parse --short HEAD            # confirm == origin/main tip
git status --porcelain               # must be empty (fresh checkout)
```

Detached HEAD is deliberate: `main` is already checked out in the primary
worktree and git forbids the same branch in two worktrees. The release commit
lands on this detached HEAD, is pushed to a release branch in §6, and reaches
`main` through the required squash-merge PR in §8.

**Run every remaining step from inside `$RELDIR`.** Its `node_modules` and
`dist/` are independent of the dev server's.

## 2. Pre-flight quality gates

Run only the local install, build, and type-check, in this order, and **stop on
any failure**:

```bash
npm ci                          # clean install, lockfile authoritative
npm run build                   # full build; emits declarations used by test type-checks
npm run check                   # type-check server + web + tests against fresh dist
```

Rules:
- Runtime registry audits are deliberately outside the release process. Do not run `npm audit` or `audit:packed-consumer` as release gates; mutable advisory data must not change eligibility for an unchanged commit.
- Do not run `test:unit`, `test:browser`, or `test:e2e` locally as release pre-flight. The release PR's required GitHub checks own all three suites across the supported runner matrix.
- Build must precede `check` because `tsconfig.tests.json` follows intentional imports of emitted `dist/server/*.js` declarations.
- If a local pre-flight step or required GitHub check fails, fix the failure or abort the release; do not retry hoping it is flaky.

Use `bash_bg` for the build if it may run long so output stays inspectable.

## 3. Decide whether to bump the binary sub-packages

Inspect:

```bash
git diff v<prev>..HEAD -- binaries.versions.json
```

- **No change** → skip sub-package republish. The root's `optionalDependencies` pin stays as-is. (This is the common case — fd/rg bump ~yearly.)
- **Changed** → follow [`docs/releasing.md`](../../../docs/releasing.md) §"Bumping fd or ripgrep" end-to-end:
  1. Run `npm run build:binaries` (or per-target during testing).
  2. Bump each `binaries/binaries-*/package.json` version by hand.
  3. Update the matching pins in root `package.json` `optionalDependencies`.
  4. Sub-packages get published *before* the root in step 7.

## 4. Bump the root version

```bash
npm version <new-version> --no-git-tag-version
```

`--no-git-tag-version` because the release tag is created by CI at the merge
commit, not locally — a local tag here would point at a commit that never
lands on `main`. **Don't commit yet** — the release notes (§5) ship in the *same* `chore(release)` commit as the version bump. Leave the bumped `package.json` / `package-lock.json` (and any `binaries/*` edits from §3) staged-but-uncommitted until §5.

## 5. Generate release notes — then commit

**Prepend** a new section to `CHANGELOG.md`, directly under the file's intro and
above the previous release. Newest first — the release workflow rejects a
changelog whose top section is not the version being released.

```markdown
## v<new-version>

Short intro naming the previous version.

### ✨ New Features

* 🎯 **Bold lead-in**: what changed and why it matters to a user.

### 🐛 Bug Fixes

* 🧩 **Bold lead-in**: what was broken and what now happens instead.
```

Match the tone of the entries already in the file — friendly, concrete, no
marketing fluff. Headings inside an entry are `###` or deeper; `##` is reserved
for version headings, and the workflow splits on it.

**Never edit an existing entry.** The run compares `CHANGELOG.md` against the
parent commit and refuses any change to an already-released section — those are
the record of what shipped.

Show the drafted section to the user and iterate before committing; these notes
become the public GitHub release.

How to build the input:

```bash
git log v<prev>..HEAD --pretty=format:'%h %s' --no-merges
gh pr list --state merged --search "merged:>=<v_prev_date>" --limit 200 \
  --json number,title,mergedAt,labels,url
```

Group commits/PRs into features vs fixes by message prefix (`feat`, `fix`, `refactor`, `chore`, etc.) and PR labels. Drop chores, version bumps, and pure-internal refactors. Do **not** list fixes for features that are new in this same release — fold the polish into that feature's bullet or omit it as development process. For each kept item, write one user-facing bullet — what changed from the user's POV, not the implementation. Look at the actual diff for anything ambiguous.

Show the draft to the user via `review_open` before committing. Iterate until they're happy. Do **not** commit or tag with provisional notes.

Once the user approves the notes, commit the version bump and the notes together as a single `chore(release)` commit:

```bash
git add package.json package-lock.json CHANGELOG.md
# include binaries/* package.json edits if §3 changed them
git -c commit.gpgsign=false commit -m "chore(release): v<new-version>" \
  --trailer "Co-authored-by: bobbit-ai <bobbit@bobbit.ai>"
```

The commit lands on this worktree's detached HEAD — that's expected. The
required squash merge in §8 creates the final `main` commit; that commit,
not the detached release commit, is what gets tagged so npm, Git, and the
GitHub release all agree.

## 6. Open the release PR and clear its gates

Direct pushes to `main` are blocked by repository rules, and squash is the
only enabled merge strategy. Push the detached HEAD to a release branch and
open a PR.

**The release branch must live in `G-Research/bobbit`, never in a fork.** The
release contract requires the merged PR to come from this repository, and both
the pre-merge check and the release run reject a fork PR. If `git push origin`
below is rejected, you do not have push access to the repository — stop and
hand the release to a maintainer who does, rather than pushing the branch to a
fork.

The `Release contract` check on the PR enforces the branch name, the title, the
lockfile, the notes and the binary sub-package pins **before** the merge. Treat
a failure there as a blocker to fix on this branch: after the merge the same
rules run again, but by then a failure has already spent the version number.

```bash
RELBRANCH="release/v<new-version>"
git push origin HEAD:refs/heads/$RELBRANCH
PR_URL=$(gh pr create \
  --base main \
  --head "$RELBRANCH" \
  --title "chore(release): v<new-version>" \
  --body-file <release-pr-body-file>)
PR=$(gh pr view "$PR_URL" --json number -q .number)
```

The PR body must summarize the version, release notes, and local pre-flight
results, and must end with the standard Bobbit footer. GitHub owns the unit,
browser, and E2E results. Wait for every required check and review before
publishing:

```bash
gh pr checks "$PR" --watch
gh pr view "$PR" --json mergeStateStatus,reviewDecision,statusCheckRollup
```

If GitHub does not attach a `Build & Unit Gate` run to the latest PR head, use
the workflow's read-only exact-head fallback and watch that specific run:

```bash
gh workflow run build-unit-gate.yml --ref "$RELBRANCH"
HEAD_SHA=$(git rev-parse HEAD)
RUN_ID=$(gh run list --workflow build-unit-gate.yml --commit "$HEAD_SHA" --event workflow_dispatch --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

This no-input dispatch runs the same unit, browser, and E2E matrices but has no
publish or repository-write authority. The PR-only `Release contract` check
must also have passed after the release fields last changed.

The PR must be ready to merge, but **do not merge it yet**. Publishing remains
the last irreversible step before the source and tag become public. Do not
create the tag before the squash merge because the pre-merge commit will not
be the commit that lands on `main`.

## 7. Publish binary sub-packages (only if step 3 bumped binaries)

**The root `@gresearch/bobbit` package is NOT published here.** It publishes automatically
via the `.github/workflows/release-publish.yml` workflow (npm trusted publishing
/ OIDC, with provenance) when the release PR is merged in §8 — there is no manual
root `npm publish`. Skip straight to §8 unless step 3 bumped the binary
sub-packages.

If step 3 bumped binaries, publish the sub-packages now — **before** the merge
in §8, so they are on npm before the root that pins them. **Pause and confirm with
the user** first; npm publishes are irreversible (you can `unpublish` for 72h but
the version number is burned either way). Use `ask_user_choices` with the exact
commands:

```bash
npm publish ./binaries/binaries-darwin-arm64
npm publish ./binaries/binaries-darwin-x64
npm publish ./binaries/binaries-linux-x64
npm publish ./binaries/binaries-linux-arm64
npm publish ./binaries/binaries-win32-x64
```

Notes:
- `publishConfig.access: "public"` is baked into each sub-package, so `--access public` is not needed.
- npm will prompt for OTP — that's the maintainer's job; just wait.
- If publish fails after some sub-packages went through, **do not** try to bump+republish under a new version. Re-run `npm publish` on the remaining packages with the same version once the issue is fixed.

## 8. Squash-merge the release PR (the merge is the release)

**STOP. Merging is the publish.** The squash merge pushes the release commit to
`main`, and that push is the release trigger:
`.github/workflows/release-publish.yml` validates, builds, type-checks, and packs
the commit without OIDC authority, then publishes the verified tarball without
running lifecycle scripts, creates the `v<new-version>` tag, and creates the
GitHub release. Nothing after this point is reversible — npm version
numbers are immutable and release tags cannot be moved or deleted.

**Pause here and confirm with the user before running any command in this
section.** Use `ask_user_choices` with the exact `gh pr merge` command shown
below. Do not run it until they have said yes.

**Do not create the tag by hand** — CI does it.

Once the release PR is fully green and mergeable, and the user has confirmed,
squash-merge it. Pin the subject and co-author trailer explicitly:

```bash
gh pr merge "$PR" \
  --squash \
  --delete-branch \
  --subject "chore(release): v<new-version>" \
  --body "Co-authored-by: bobbit-ai <bobbit@bobbit.ai>"
MERGE_SHA=$(gh pr view "$PR" --json mergeCommit -q .mergeCommit.oid)
git fetch origin main --tags
git merge-base --is-ancestor "$MERGE_SHA" origin/main
git show "$MERGE_SHA":package.json | grep '"version": "<new-version>"'
git diff --exit-code HEAD "$MERGE_SHA" -- \
  package.json package-lock.json CHANGELOG.md
```

The workflow only accepts a release commit that satisfies every one of these, so
keep §6's branch and title conventions exactly:

- produced by a merged PR from `release/v<new-version>` in this repository into `main`
- PR title `chore(release): v<new-version>`
- `package.json` and `package-lock.json` both at `<new-version>`, bumped by *this* commit
- a substantial `## v<new-version>` section at the top of `CHANGELOG.md`, with no edits to earlier entries
- `<new-version>` not already on npm

Watch the run for **this commit** — every push to `main` starts a run of this
workflow, so `--limit 1` can hand you an unrelated one:

```bash
gh run watch "$(gh run list --workflow release-publish.yml --commit "$MERGE_SHA" --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

If a step fails (e.g. transient registry error), use **Re-run all jobs** on the
same workflow run — not **Re-run failed jobs**. A fresh validation pass safely
re-checks npm provenance before deciding whether publication is still needed.
Never create a tag by hand to work around a failed run. If the run is unusable entirely,
cut the next patch version through a fresh release PR; there is no manual
dispatch to release an arbitrary commit, deliberately.

If merging fails, stop and repair the same release PR. Do not change the
version, create a second release commit, or force-push `main`.

**Refresh the running dev server** so it picks up the release commit (its
local `main` is now behind remote):

```bash
cd "$PRIMARY" && git pull origin main    # fast-forward the primary worktree on main
# then restart the dev server if needed (npm run restart-server)
```

## 9. Verify the GitHub release

The workflow already created the tag and the GitHub release: this version's
`CHANGELOG.md` entry first, with GitHub's generated list of merged pull
requests appended beneath it, marked `--prerelease` when the version carries a
`-rc`/`-beta`/`-alpha` suffix. Confirm rather than create:

```bash
gh release view v<new-version> --json url,isPrerelease,tagName
```

If it is missing while the npm publish succeeded, re-run the workflow run —
do not create the release by hand.

## 10. Post-release smoke

In a scratch directory, prove the published artefact actually installs and resolves binaries:

```bash
cd $(mktemp -d) && npm init -y >/dev/null
npm install @gresearch/bobbit@<new-version>
ls node_modules/@bobbit/binaries-*/bin/
node -e "import('@gresearch/bobbit/dist/server/binaries.js').then(m => console.log(m.getFdPath(), m.getRgPath()))"
```

Both paths should print a real file. If they're `undefined`, the platform sub-package didn't install — investigate before announcing the release.

## 10.5 Tear down the release worktree

Once the smoke test passes, remove the throwaway release worktree (from the
primary, since you can't remove the worktree you're standing in):

```bash
cd "$PRIMARY"
git worktree remove "$RELDIR"      # add --force only if it refuses on untracked build output
git worktree prune
```

Leave it in place only if a publish step failed and you need to re-run from
the same checkout.

## 11. Announce

Report to the user:
- Version + tag + GitHub release URL (`gh release view v<new-version> --json url -q .url`)
- npm package URL (`https://www.npmjs.com/package/@gresearch/bobbit/v/<new-version>`) — provenance is attached automatically by CI
- Whether binaries were republished, and which versions
- Required build, type-check, unit, browser, and E2E gate results

## Rules / best practices

- **Never tag by hand.** CI creates the immutable public source tag. Safe reruns are authorized by npm's verified provenance for this workflow and commit, not by the repository-wide GitHub Actions tag bypass.
- **Publish, tag, and GitHub release are CI-only.** They run via `release-publish.yml` (OIDC trusted publishing) on the merge to `main`, with provenance automatic. Never run them manually.
- **OTP is the human's job** — but only for the binary sub-package publishes. Pause and let them type it; don't try to read it from anywhere. The root publish uses no OTP.
- **Never `npm publish --force`.** If a sub-package republish is genuinely needed, bump the patch version and republish cleanly. If the CI root publish fails, re-run all jobs in the same workflow run for the same version.
- **Never delete a tag that's been pushed.** If you tagged wrong, bump the version and tag again — published version numbers are immutable.
- **Use the required squash-merge PR flow.** Merging the release PR is what publishes; verify the merged commit carries the intended version and release files.
- **One release at a time.** Never merge a second release PR while the previous release run is still going: publish jobs serialise on `release-publish-root`, and GitHub keeps at most one pending job per group. After taking the lock, the job requires the npm dist-tag to match the state verification approved; tagging happens only after publication. Wait for the run to finish.
- **An already-published version fails closed.** It proceeds only when npm's verified provenance identifies this workflow and commit. Otherwise confirm what was published and release the next version.
- **Stop on any local pre-flight or required GitHub check failure.** Releases amplify bugs — the cost of waiting a day is tiny; the cost of a bad publish is days of cleanup.
