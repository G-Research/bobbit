---
name: release
description: Cut a Bobbit release — preflight checks, version bump, signed tag, npm publish (with optional binary sub-packages), GitHub release with generated notes.
argument-hint: [major|minor|patch|<explicit-version>]
---

Drive an end-to-end release of Bobbit. The maintainer (human) must be at the
keyboard for `npm login` / OTP prompts and to sign the tag — pause and ask
when the flow needs them. **Never** run `npm publish` non-interactively or
behind their back.

Single source of truth for release mechanics: [`docs/releasing.md`](../../../docs/releasing.md).
This skill orchestrates that doc + version bump + notes + GitHub release.

**Where this runs — read this first.** Never cut the release from the **primary
worktree**: the dev server runs there, and `npm ci` / `npm run build` would wipe
its `node_modules` / overwrite its `dist/` and break the running server
mid-release. Never cut it from a **session worktree** either — that's on a
session branch, not `master`, and git won't let you check out `master` in a
second worktree while the primary already has it. Instead, §1.5 creates a
dedicated **detached-HEAD worktree off `origin/master`** (a sibling of the
primary, *not* under `*-wt/`), and every mutating step runs there. This is
why the release commit is pushed with `git push origin HEAD:master` (§8)
rather than assuming `master` is checked out locally. The E2E harness binds
port 0 and uses ephemeral `BOBBIT_DIR`s, so `test:e2e` won't collide with the
running dev server.

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
npm whoami                               # must succeed; if not -> ask user to `npm login`
gh auth status                           # must be authed for SuuBro/bobbit
git config --get user.signingkey || echo "NO_SIGNING_KEY"
git config --get commit.gpgsign || echo "commit.gpgsign=unset"
```

Note: do **not** gate on the current worktree's branch or cleanliness — the
release is cut from a fresh detached worktree at `origin/master`'s tip (§1.5),
so the session/primary worktree state is irrelevant. What matters is that
`origin/master` is the intended release point.

**Stop and ask the user** if any of:
- `origin/master` has nothing new since the previous tag (nothing to release), or it isn't the commit they expect to ship.
- `npm whoami` fails — ask them to run `npm login` (and enable 2FA if not already; npm requires OTP for publishes on this scope).
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
(§4) lands on this detached HEAD and is published to `master` via
`git push origin HEAD:master` in §8.

**Run every remaining step from inside `$RELDIR`.** Its `node_modules` and
`dist/` are independent of the dev server's.

## 2. Pre-flight quality gates

Run, in this order, and **stop on any failure**:

```bash
npm ci                          # clean install, lockfile authoritative
npm audit --omit=dev            # zero high/critical in runtime deps
npm run build                   # full build; emits declarations used by test type-checks
npm run check                   # type-check server + web + tests against fresh dist
npm run test:unit               # fast unit suite
npm run test:browser            # Playwright browser journeys
npm run test:e2e                # API + worktree/Docker/MCP/restart E2E
```

Rules:
- **`npm audit` must show 0 vulnerabilities** (any severity, runtime deps). If it doesn't, stop and report what's flagged — do not release with known vulns. If a finding is genuinely a false positive (e.g. dev-only path), have the user explicitly acknowledge before continuing.
- Don't skip browser or E2E tests "because they're slow" — releases are the one place flakes bite users.
- Build must precede `check`: `tsconfig.tests2.json` follows intentional imports of emitted `dist/server/*.js` declarations, so a clean checkout cannot type-check the test graph before the build.
- If any test fails, the failure is the bug. Fix it or abort the release; do not retry hoping it's flaky.

Long-running steps (`build`, `test:browser`, `test:e2e`) should use `bash_bg` so output stays inspectable.

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

The commit lands on this worktree's detached HEAD — that's expected. It becomes a real commit on `master` once §8 runs `git push origin HEAD:master`, so `npm install bobbit@<version>`, `git checkout v<version>`, and the GitHub release notes all agree.

## 6. Tag the release (signed)

```bash
git tag -s v<new-version> -m "Bobbit v<new-version>"
# -s = GPG/SSH-sign the tag. If user has no signing key and explicitly
#      opted out in step 0, use -a (annotated, unsigned) instead.
git tag -v v<new-version>    # verify signature
```

Do **not** push the tag yet — publish first, push after.

## 7. Publish to npm

**Pause and confirm with the user** before this step — npm publishes are
irreversible (you can `unpublish` for 72h but the version number is burned
either way). Use `ask_user_choices` with the exact `npm publish` commands
about to run.

If step 3 bumped binaries:

```bash
npm publish ./binaries/binaries-darwin-arm64
npm publish ./binaries/binaries-darwin-x64
npm publish ./binaries/binaries-linux-x64
npm publish ./binaries/binaries-linux-arm64
npm publish ./binaries/binaries-win32-x64
```

Then the root:

```bash
npm publish --provenance
```

Notes:
- `--provenance` attaches a signed npm provenance attestation (sigstore) so users can verify the package came from this repo. Requires the maintainer to be running npm ≥9.5 from a machine where the npm CLI can reach Sigstore. If the env doesn't support it (rare; older corp networks), drop the flag and tell the user the publish is unattested.
- `publishConfig.access: "public"` is baked into each sub-package, so `--access public` is not needed.
- npm will prompt for OTP — that's the maintainer's job; just wait.
- If publish fails after some sub-packages went through, **do not** try to bump+republish under a new version. Re-run `npm publish` on the remaining packages with the same version once the issue is fixed.

## 8. Push the tag and the release commit

From inside `$RELDIR` (detached HEAD), publish the release commit to `master`
and push the tag:

```bash
git push origin HEAD:master       # detached HEAD -> remote master (fast-forward)
git push origin v<new-version>
```

`HEAD:master` (not plain `master`) because this worktree is on a detached
HEAD, not a local `master` branch. The push fast-forwards remote `master`
to the release commit.

If the push is **rejected as non-fast-forward**, someone pushed to `master`
between §1.5 and now. Do **not** force-push. The clean recovery: tear down
this worktree (§10.5), re-create it off the new `origin/master` tip, and
re-run from §2. The version number isn't burned until §7 (`npm publish`), so
as long as you haven't published yet you can safely start over; if you've
already tagged locally, delete the *local* tag first (`git tag -d v<new-version>`)
— never delete a tag that's been pushed.

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
npm install bobbit@<new-version>
ls node_modules/@bobbit/binaries-*/bin/
node -e "import('bobbit/dist/server/binaries.js').then(m => console.log(m.getFdPath(), m.getRgPath()))"
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
- npm package URL (`https://www.npmjs.com/package/bobbit/v/<new-version>`)
- Whether provenance was attached
- Whether binaries were republished, and which versions
- Any audit findings that were explicitly accepted

## Rules / best practices

- **Signed tag, always.** Use `git tag -s`. Only fall back to `-a` if the maintainer explicitly opted out in step 0.
- **Signed commit if a signing key is configured.** Add `-S` to `git commit`. Never override `user.name` / `user.email`; never silently disable signing.
- **`--provenance` on the root publish** whenever the environment supports it.
- **OTP is the human's job.** Pause and let them type it; don't try to read it from anywhere.
- **Never `npm publish --force`.** If a republish is genuinely needed, bump the patch version and republish cleanly.
- **Never delete a tag that's been pushed.** If you tagged wrong, bump the version and tag again — published version numbers are immutable.
- **Don't squash the release commit.** It must be a real commit on `master` with the bumped `package.json` so `npm install bobbit@<version>` and `git checkout v<version>` agree.
- **One release at a time.** Don't start a second version bump while the previous tag/publish is in flight.
- **Stop on any test, audit, or check failure.** Releases amplify bugs — the cost of waiting a day is tiny; the cost of a bad publish is days of cleanup.
