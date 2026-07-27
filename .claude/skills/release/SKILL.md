---
name: release
description: Cut a Bobbit release — preflight checks, version bump, signed tag (CI publishes the root to npm via OIDC on tag push), optional binary sub-packages, GitHub release with generated notes.
argument-hint: [major|minor|patch|<explicit-version>]
---

Drive an end-to-end release of Bobbit. The maintainer (human) must be at the
keyboard to sign the tag, and for `npm login` / OTP prompts **only when
republishing binary sub-packages** — pause and ask when the flow needs them.
The root `@gresearch/bobbit` package publishes automatically via CI (npm
trusted publishing / OIDC) when the signed tag is pushed; **never** run a
manual root `npm publish`.

Single source of truth for release mechanics: [`docs/releasing.md`](../../../docs/releasing.md).
This skill orchestrates that doc + version bump + notes + GitHub release.

**Where this runs — read this first.** Never cut the release from the **primary
worktree**: the dev server runs there, and `npm ci` / `npm run build` would wipe
its `node_modules` / overwrite its `dist/` and break the running server
mid-release. Never cut it from a **session worktree** either — that's on a
session branch, not `master`, and git won't let you check out `master` in a
second worktree while the primary already has it. Instead, §1.5 creates a
dedicated **detached-HEAD worktree off `origin/master`** (a sibling of the
primary, *not* under `*-wt/`), and every mutating step runs there. The release
commit is pushed to a `release/v<version>` branch and squash-merged through the
repository's required PR flow (§6–§8); the resulting merge commit is what gets
tagged. The E2E harness binds port 0 and uses ephemeral `BOBBIT_DIR`s, so
`test:e2e` won't collide with the running dev server.

## 0. Sanity check the environment

These are location-independent (the `.git` is shared across worktrees), so run
them from wherever the skill was activated. Report results before doing
anything mutating:

```bash
git fetch origin --tags
git rev-parse origin/master              # sha we'll release from
git tag --sort=-v:refname | head -5      # find previous tag
git log --oneline <prev-tag>..origin/master | head    # must be non-empty (something to release)
node -v                                  # must satisfy engines.node (>=22.19.0)
npm whoami                               # only needed if republishing binary sub-packages (§3); root ships via CI
gh auth status                           # must be authed for G-Research/bobbit
git config --get user.signingkey || echo "NO_SIGNING_KEY"
git config --get commit.gpgsign || echo "commit.gpgsign=unset"
```

Note: do **not** gate on the current worktree's branch or cleanliness — the
release is cut from a fresh detached worktree at `origin/master`'s tip (§1.5),
so the session/primary worktree state is irrelevant. What matters is that
`origin/master` is the intended release point.

**Stop and ask the user** if any of:
- `origin/master` has nothing new since the previous tag (nothing to release), or it isn't the commit they expect to ship.
- `npm whoami` fails **and** step 3 will republish binary sub-packages — ask them to run `npm login` (and enable 2FA if not already; npm requires OTP for those sub-package publishes). The root `@gresearch/bobbit` publish needs no npm login — it goes through CI/OIDC.
- `gh auth status` not logged in — ask them to run `gh auth login`.
- No GPG/SSH signing key configured — confirm whether to proceed with **unsigned** tag or wait until they set one up. Default to waiting.

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
git worktree add --detach "$RELDIR" origin/master
cd "$RELDIR"
git rev-parse --short HEAD            # confirm == origin/master tip
git status --porcelain               # must be empty (fresh checkout)
```

Detached HEAD is deliberate: `master` is already checked out in the primary
worktree and git forbids the same branch in two worktrees. The release commit
lands on this detached HEAD, is pushed to a release branch in §6, and reaches
`master` through the required squash-merge PR in §8.

**Run every remaining step from inside `$RELDIR`.** Its `node_modules` and
`dist/` are independent of the dev server's.

## 2. Pre-flight quality gates

Run, in this order, and **stop on any failure**:

```bash
npm ci                          # clean install, lockfile authoritative
npm audit --omit=dev            # zero vulnerabilities in root runtime deps
npm run build                   # full build; emits declarations used by test type-checks
npm run audit:packed-consumer   # zero vulnerabilities in a fresh tarball consumer
npm run check                   # type-check server + web + tests against fresh dist
npm run test:unit               # fast unit suite
npm run test:browser            # Playwright browser journeys
npm run test:e2e                # API + worktree/Docker/MCP/restart E2E
```

Rules:
- **Both audits must show 0 vulnerabilities** at every severity. The packed-consumer command installs the just-built tarball under normal npm settings because a clean root audit cannot see dependency-owned shrinkwrap findings. Any finding blocks publish; there are no release exceptions.
- Registry advisory availability is deliberately release-only, not part of normal unit, browser, or E2E gates. If the advisory service or clean consumer install is unavailable, stop the release rather than skipping the packed-consumer audit.
- Don't skip browser or E2E tests "because they're slow" — releases are the one place flakes bite users.
- Build must precede both `audit:packed-consumer` and `check`: the audit packs built output, while `tsconfig.tests2.json` follows intentional imports of emitted `dist/server/*.js` declarations.
- If any test fails, the failure is the bug. Fix it or abort the release; do not retry hoping it's flaky.

Long-running steps (`build`, `audit:packed-consumer`, `test:browser`, `test:e2e`) should use `bash_bg` so output stays inspectable.

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

`--no-git-tag-version` because we want a signed tag, not the unsigned one `npm version` would otherwise create. **Don't commit yet** — the release notes (§5) are a tracked file and ship in the *same* `chore(release)` commit as the version bump (that's how prior releases do it, e.g. v0.11.0 bundled `RELEASE_NOTES_v0.11.0.md` with `package.json`). Leave the bumped `package.json` / `package-lock.json` (and any `binaries/*` edits from §3) staged-but-uncommitted until §5.

## 5. Generate release notes — then commit

Write `RELEASE_NOTES_v<new-version>.md`. Match the format of the most recent existing `RELEASE_NOTES_v*.md` — short intro, then `## ✨ New Features` and `## 🐛 Bug Fixes` sections, emoji-prefixed bullets with bold lead-ins, friendly tone, no marketing fluff. End with the standard Bobbit footer.

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
git add package.json package-lock.json RELEASE_NOTES_v<new-version>.md
# include binaries/* package.json edits if §3 changed them
git commit -m "chore(release): v<new-version>" \
  --trailer "Co-authored-by: bobbit-ai <bobbit@bobbit.ai>" \
  -S    # GPG/SSH-sign the commit if a signing key is configured
```

If no signing key is set, drop `-S` (you already confirmed with the user in step 0).

The commit lands on this worktree's detached HEAD — that's expected. The
required squash merge in §8 creates the final `master` commit; that commit,
not the detached release commit, is what gets tagged so npm, Git, and the
GitHub release all agree.

## 6. Open the release PR and clear its gates

Direct pushes to `master` are blocked by repository rules, and squash is the
only enabled merge strategy. Push the detached HEAD to a release branch and
open a PR:

```bash
RELBRANCH="release/v<new-version>"
git push origin HEAD:refs/heads/$RELBRANCH
PR_URL=$(gh pr create \
  --base master \
  --head "$RELBRANCH" \
  --title "chore(release): v<new-version>" \
  --body-file <release-pr-body-file>)
PR=$(gh pr view "$PR_URL" --json number -q .number)
```

The PR body must summarize the version, release notes, and gate results, and
must end with the standard Bobbit footer. Wait for every required check and
review before publishing:

```bash
gh pr checks "$PR" --watch
gh pr view "$PR" --json mergeStateStatus,reviewDecision,statusCheckRollup
```

The PR must be ready to merge, but **do not merge it yet**. Publishing remains
the last irreversible step before the source and tag become public. Do not
create the tag before the squash merge because the pre-merge commit will not
be the commit that lands on `master`.

## 7. Publish binary sub-packages (only if step 3 bumped binaries)

**The root `@gresearch/bobbit` package is NOT published here.** It publishes automatically
via the `.github/workflows/release-publish.yml` workflow (npm trusted publishing
/ OIDC, with provenance) when the signed tag is pushed in §8 — there is no manual
root `npm publish`. Skip straight to §8 unless step 3 bumped the binary
sub-packages.

If step 3 bumped binaries, publish the sub-packages now — **before** the tag push
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

## 8. Squash-merge the release PR, then tag it (this triggers the npm publish)

Once the release PR is fully green and mergeable, squash-merge it.
Pin the subject and co-author trailer explicitly:

```bash
gh pr merge "$PR" \
  --squash \
  --delete-branch \
  --subject "chore(release): v<new-version>" \
  --body "Co-authored-by: bobbit-ai <bobbit@bobbit.ai>"
MERGE_SHA=$(gh pr view "$PR" --json mergeCommit -q .mergeCommit.oid)
git fetch origin master --tags
git merge-base --is-ancestor "$MERGE_SHA" origin/master
git show "$MERGE_SHA":package.json | grep '"version": "<new-version>"'
git diff --exit-code HEAD "$MERGE_SHA" -- \
  package.json package-lock.json RELEASE_NOTES_v<new-version>.md
```

Tag the PR's exact squash commit, not the current `origin/master` tip (another
PR may have merged immediately afterward). **Pushing the tag triggers the root
npm publish** (`.github/workflows/release-publish.yml`) and is irreversible —
pause and confirm with the user before the `git push`:

```bash
git tag -s v<new-version> "$MERGE_SHA" -m "Bobbit v<new-version>"
git tag -v v<new-version>
git push origin v<new-version>       # -> release-publish.yml publishes @gresearch/bobbit to npm (OIDC + provenance)
```

If the user explicitly opted out of signing in step 0, use `git tag -a`
instead and inspect it with `git show --no-patch v<new-version>`.

Then watch the publish workflow and confirm it succeeds before moving on:

```bash
gh run watch "$(gh run list --workflow release-publish.yml --branch v<new-version> --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

If the publish job fails (e.g. transient registry error), **re-run the same
workflow run** for the same version — do not bump the version or re-tag; the
tag is already public and the version number is immutable.

If merging fails, stop and repair the same release PR. Do not change the
version, create a second release commit, force-push `master`, or tag the
detached pre-merge commit.

**Refresh the running dev server** so it picks up the release commit (its
local `master` is now behind remote):

```bash
cd "$PRIMARY" && git pull origin master    # fast-forward the primary worktree on master
# then restart the dev server if needed (npm run restart-server)
```

## 9. Create the GitHub release

```bash
gh release create v<new-version> \
  --title "Bobbit v<new-version>" \
  --notes-file RELEASE_NOTES_v<new-version>.md \
  --verify-tag
```

`--verify-tag` ensures gh refuses to create the release if the tag doesn't already exist on the remote (catches push-skipped-by-mistake).

If this is a pre-release (version contains `-beta`, `-rc`, `-alpha`), add `--prerelease`.

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
- Root and packed-consumer audit results (both must be clean)

## Rules / best practices

- **Signed tag, always.** Use `git tag -s`. Only fall back to `-a` if the maintainer explicitly opted out in step 0.
- **Signed commit if a signing key is configured.** Add `-S` to `git commit`. Never override `user.name` / `user.email`; never silently disable signing.
- **The root publish is CI-only.** It runs via `release-publish.yml` (OIDC trusted publishing) on the tag push, with provenance automatic. Never run a manual root `npm publish`.
- **OTP is the human's job** — but only for the binary sub-package publishes. Pause and let them type it; don't try to read it from anywhere. The root publish uses no OTP.
- **Never `npm publish --force`.** If a sub-package republish is genuinely needed, bump the patch version and republish cleanly. If the CI root publish fails, re-run the same workflow run for the same version.
- **Never delete a tag that's been pushed.** If you tagged wrong, bump the version and tag again — published version numbers are immutable.
- **Use the required squash-merge PR flow.** Never tag the detached release commit; tag the PR's exact `mergeCommit` SHA after verifying its package version and release files.
- **One release at a time.** Don't start a second version bump while the previous tag/publish is in flight.
- **Stop on any test, audit, or check failure.** Releases amplify bugs — the cost of waiting a day is tiny; the cost of a bad publish is days of cleanup.
