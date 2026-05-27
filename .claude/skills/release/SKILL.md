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

## 0. Sanity check the environment

Run these in parallel; report results before doing anything mutating:

```bash
git rev-parse --abbrev-ref HEAD          # must be master
git status --porcelain                   # must be empty
git fetch origin --tags
git rev-list --left-right --count HEAD...origin/master  # must be 0 0
git tag --sort=-v:refname | head -5      # find previous tag
node -v                                  # must satisfy engines.node (>=22.19.0)
npm whoami                               # must succeed; if not -> ask user to `npm login`
gh auth status                           # must be authed for SuuBro/bobbit
git config --get user.signingkey || echo "NO_SIGNING_KEY"
git config --get commit.gpgsign || echo "commit.gpgsign=unset"
```

**Stop and ask the user** if any of:
- Branch is not `master`, working tree dirty, or behind/ahead of `origin/master`.
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

## 2. Pre-flight quality gates

Run, in this order, and **stop on any failure**:

```bash
npm ci                          # clean install, lockfile authoritative
npm audit --omit=dev            # zero high/critical in runtime deps
npm run check                   # type-check server + web
npm run build                   # full build
npm run test:unit               # fast unit suite
npm run test:e2e                # API + browser E2E
```

Rules:
- **`npm audit` must show 0 vulnerabilities** (any severity, runtime deps). If it doesn't, stop and report what's flagged — do not release with known vulns. If a finding is genuinely a false positive (e.g. dev-only path), have the user explicitly acknowledge before continuing.
- Don't skip E2E "because it's slow" — releases are the one place flakes bite users.
- If any test fails, the failure is the bug. Fix it or abort the release; do not retry hoping it's flaky.

Long-running steps (`build`, `test:e2e`) should use `bash_bg` so output stays inspectable.

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

`--no-git-tag-version` because we want a signed tag, not the unsigned one `npm version` would otherwise create. Stage and commit:

```bash
git add package.json package-lock.json
# include binaries/* package.json edits if step 3 changed them
git commit -m "chore(release): v<new-version>" \
  --trailer "Co-authored-by: bobbit-ai <bobbit@bobbit.ai>" \
  -S    # GPG/SSH-sign the commit if a signing key is configured
```

If no signing key is set, drop `-S` (you already confirmed with the user in step 0).

## 5. Generate release notes

Write `RELEASE_NOTES_v<new-version>.md`. Match the format of the most recent existing `RELEASE_NOTES_v*.md` — short intro, then `## ✨ New Features` and `## 🐛 Bug Fixes` sections, emoji-prefixed bullets with bold lead-ins, friendly tone, no marketing fluff. End with the standard Bobbit footer.

How to build the input:

```bash
git log v<prev>..HEAD --pretty=format:'%h %s' --no-merges
gh pr list --state merged --search "merged:>=<v_prev_date>" --limit 200 \
  --json number,title,mergedAt,labels,url
```

Group commits/PRs into features vs fixes by message prefix (`feat`, `fix`, `refactor`, `chore`, etc.) and PR labels. Drop chores, version bumps, and pure-internal refactors. For each kept item, write one user-facing bullet — what changed from the user's POV, not the implementation. Look at the actual diff for anything ambiguous.

Show the draft to the user via `review_open` before tagging. Iterate until they're happy. Do **not** tag with provisional notes.

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

```bash
git push origin master
git push origin v<new-version>
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
