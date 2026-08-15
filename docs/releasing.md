# Releasing Bobbit

This doc covers the Bobbit release checks that cannot be inferred from a normal development checkout: the installed consumer's security report and the bundled `fd`/`rg` binaries. The root `@gresearch/bobbit` package is released automatically by [`.github/workflows/release-publish.yml`](../.github/workflows/release-publish.yml); only the binary sub-packages below are published manually.

## Automated root release

A release is authorized by squash-merging a same-repository PR from `release/v<version>` into `main`. Merging is the irreversible publication approval.

**The trigger is the push to `main`, not the pull request.** Three things follow from that, and each of them is the reason for the choice:

- **The checks cannot be swapped out.** A `push` run always executes the workflow file as it exists on `main`. A `workflow_dispatch` run executes the file as it exists on the *dispatched ref*, so anyone able to push a branch could delete every check below, dispatch their branch, and still receive the tag permission and the npm OIDC identity — npm's trusted publisher is bound to the repository and workflow filename, not to a protected source ref. There is deliberately no dispatch input on this workflow.
- **Provenance names the right commit.** `npm publish --provenance` builds its attestation from `GITHUB_SHA`. On a `push` that is the squash commit itself. Under `pull_request` it would be the ephemeral `refs/pull/<n>/merge` commit, which is not on `main` and cannot be checked out by anyone verifying the attestation — the published tarball and the attested source would name different commits.
- **There is one authorization path.** The release is authorized by a reviewed pull request and nothing else.

The `detect` job decides whether a push is a release by comparing `package.json` at the commit against its parent — a version increase is the signal, not the commit message. If the version is unchanged or decreases, the run stops there.

For a release commit, `verify` then enforces the whole contract, in [`scripts/release/validate-release-commit.mjs`](../scripts/release/validate-release-commit.mjs), before anything expensive runs and before `npm ci` executes a single third-party lifecycle script:

- a merged pull request produced this exact commit — resolved from the commit, not read from the event — and it came from `release/v<version>` in **this repository, not a fork**, titled exactly `chore(release): v<version>`. That the commit was reviewed and squash-merged is not re-checked; the branch rulesets on `main` already guarantee it. What this establishes is *intent*: since a release is triggered by the version changing, without it any merged PR that happened to touch the version — a dependency bump, a conflict resolution, a revert — would publish to npm
- the commit is the one that **introduced** the version, and the version **increases** by semver precedence — a change alone is not enough, since a lower version still takes the `latest` dist-tag and would downgrade every consumer
- `<version>` is release-shaped, and `package.json` and both root versions in `package-lock.json` agree on it
- `CHANGELOG.md` has a `## v<version>` section, it is the **first** section in the file, and it says something — that section becomes the public GitHub release. The release may add its own entry and nothing else: every previously released section must survive byte-identical, so a release PR cannot quietly rewrite the record of what an earlier version shipped
- every `optionalDependencies` entry is an exact version rather than a mutable range or dist-tag, and that version already resolves on the registry, so the root can never ship pointing at binary sub-packages that were not published
- the version is **not** already on npm, unless its registry-verified provenance names this repository, this workflow file and this exact commit — which makes skipping publication safe on a rerun (see **Reruns** below)

Only then does the run build and type-check the commit, and pack the resulting files into an immutable workflow artifact. The serialized publishing job publishes that exact tarball with provenance, the tag job then creates `v<version>`, and the GitHub release follows. Pre-release versions (`0.16.0-rc.1`) go to the `next` dist-tag and are marked as prereleases; stable versions go to `latest`.

The post-merge build is deliberate because it produces the exact tarball that ships. The unit suite is not repeated after publication approval: the release PR's required unit matrix already tested the mergeable tree, and the release preflight ran the full unit, browser, and E2E suites before the PR opened.

**The same contract also runs before the merge.** `build-unit-gate.yml` runs `validate-release-commit.mjs --mode pre-merge` on every pull request. It decides whether a PR is a release the same way `detect` does — by comparing `package.json` against the base — and exits immediately when the version is unchanged. Every content rule then runs against that base, including the append-only changelog check and the version-increase check, so a wrong branch name, title, lockfile, changelog entry, backwards version or unpublished binary pin fails while it still costs one push — rather than after the merge, when the version is on `main` and the number is spent. The post-merge run is the authority; the pre-merge run is there so the authority rarely has to say no.

### Why browser and e2e tests are not in the release gate

`npm run test:browser` and `npm run test:e2e` are **not** part of this workflow, or of any workflow. They are not runner-shaped yet:

- **browser** — carries a 3600 s wall budget, and `playwright-v2.config.ts` reserves workers from `scripts/testing-v2/ledger.mjs`. That ledger exists to share one 24-core development machine between concurrent agent sessions; on a single-tenant runner it reserves against contention that does not exist, so the numbers it produces are meaningless there.
- **e2e** — needs a Docker daemon and real git worktrees.

Adding them to a workflow today would not gate anything; it would fail or mislead. Making them runner-shaped is separate work. Run the full suite locally before opening the release PR — the skill's pre-flight does exactly that — and let the PR's required unit matrix provide the hosted unit gate. The post-merge release workflow rebuilds and type-checks the package without repeating that unit matrix.

Publish, tag and release are separate jobs so each holds only the permissions it needs: `id-token: write` to publish, `contents: write` to tag, `contents: write` to create the release. None checks out the repository, installs dependencies, or runs package lifecycle scripts. Before the publishable artifact enters the OIDC-enabled job, that job uses a small inline registry check to confirm the dist-tag still has the value recorded by verification. It then downloads and publishes the verified tarball with `--ignore-scripts`; the release job downloads the reviewed notes from the same immutable artifact. Dependency lifecycle code therefore never receives publish or repository-write authority, and the tarball produced after all gates is the tarball sent to npm.

**Publication happens before tagging.** A workflow cancelled while waiting for the publish lock therefore leaves no immutable tag behind. If npm accepts the package but tagging subsequently fails, a full rerun verifies the package's provenance, skips the immutable publish safely, and retries the idempotent tag step. The tag ruleset protects the public source pointer, but does not participate in rerun authorization.

**The publish job runs a different Node from the build job, on purpose.** Trusted publishing needs npm >= 11.5.1 for the OIDC exchange. Node 22.19.0 — what `engines.node` and the build job require — bundles npm 10.9.x, which cannot do it at all, so a publish from that toolchain would look for a token it does not have and fail at the one moment that is expensive. The publish job therefore pins Node 24 and sets `registry-url`, which is what makes `setup-node` write the `.npmrc` the publish targets; v0.15.1 published from node v24.18.0 with npm 11.16.0. The job also checks the npm version at runtime, so a change to the runner image fails before the publish rather than during it.

**Release one at a time.** Publish jobs share a `release-publish-root` concurrency group; ordinary pushes never enter it. GitHub retains at most one *pending* job per group, so wait for the current release workflow to finish before merging the next release PR. A pending job cancelled by a newer release has only verified and built artifacts; it has neither published nor tagged anything.

Serialization alone does not define order: a newer release can finish verification before an older one. Verification therefore proves that the new version advances the current `latest` or `next` value and records that value. After acquiring the publish lock, the job publishes only if the dist-tag is unchanged. Any intervening release makes the comparison fail closed; a full rerun validates against the new state rather than moving consumers backwards.

**Reruns.** Re-running the entire release workflow is the supported recovery, and every job is idempotent: the tag step accepts a tag that already points at this commit, the publish is skipped when the version is already on the registry, and the release is skipped if it exists. Use **Re-run all jobs**, not **Re-run failed jobs**: a publish can reach npm immediately before its runner is cancelled, and only a fresh `verify` job re-checks registry provenance and updates the downstream decision safely.

An already-published npm version **fails the run** unless the attestation npm serves for it names this repository, this workflow file, and this exact commit. npm verifies provenance signatures before accepting them, so that check answers the only recovery question that matters: *is the immutable artifact on the registry the one this workflow published from this source?*

The tag is deliberately not part of this decision. Its rulesets protect the public source pointer, but their GitHub Actions bypass cannot identify one workflow among all workflows in the repository. If provenance does not match, the recovery is always to release the next version, never to reconcile with the old one.

**If no run exists to re-run at all** — it was cancelled, or the commit predates this workflow — cut the next patch version through a normal release PR. There is intentionally no manual dispatch to release an arbitrary commit: a second, unreviewed path holding the tag permission and the npm OIDC identity is worth more than the version number it would save.

### Release notes live in CHANGELOG.md

Notes are **written**, not generated. The release skill drafts them, the maintainer reviews and iterates on the draft, and the result lands in the release PR where reviewers see exactly what will be published. GitHub's auto-generated notes cannot serve this purpose — they only exist after the tag does, so nobody reviews them.

One file, newest first:

```markdown
# Changelog

## v0.16.0

<this release>

## v0.15.1

<previous release>
```

`## v<version>` starts a release entry; headings inside an entry are `###` or deeper, which is what lets the workflow extract one entry unambiguously. `scripts/release/changelog-section.mjs --version <version>` prints it, and the release job publishes that as the release body with GitHub's generated pull-request list appended underneath.

A single file rather than one `RELEASE_NOTES_v*.md` per version buys three things: a readable history in the place npm consumers look for it; an append-only guarantee, since the run compares against the parent commit and rejects any edit to an already-released entry; and free serialisation, because two concurrent release PRs both touch `CHANGELOG.md` and conflict, which is the "one release at a time" rule enforced by git rather than by documentation.

### Version on `main` between releases

`main` carries the last released version, not a `-SNAPSHOT`/`-DEVELOPMENT` placeholder. That is the npm convention (unlike Maven, where the released version never sits on the default branch), and it is what makes `detect` possible: a push is a release exactly when it changes `package.json`'s version, which is unambiguous only if the version is otherwise stable. The cost is that a commit on `main` does not tell you whether it is before or after the release of the version it names; use the tag for that.

### Required tag ruleset

The automated tag is not GPG/SSH-signed. The reviewed, protected `main` merge and the workflow's exact-SHA checks establish its intended commit; this active tag ruleset, managed in `github-configuration`, makes the source pointer immutable after creation:

```yaml
- enforcement: active
  name: Immutable version tags
  rules:
    deletion: true
    non_fast_forward: true
    update: true
  target: tag
  conditions:
    ref_name:
      include:
        - refs/tags/v*
```

Once a `v*` tag exists, nobody can move or delete it. The ruleset deliberately does not restrict tag creation: `.github/workflows/release-publish.yml` creates the tag with `${{ github.token }}`, but GitHub does not permit the built-in GitHub Actions app to bypass a repository creation rule because that app is not installed in the organisation. A dedicated release app could bypass it, but would require a stored private key and its own permission and rotation lifecycle. Keeping the workflow secretless is the simpler trade-off.

This means any actor with tag-push permission can pre-create a version tag and block the legitimate release tag from being created. That is a denial-of-service risk, not publishing authority: npm trusted publishing remains bound to this repository and workflow, and reruns accept an existing npm artifact only when registry-verified provenance names the exact repository, workflow, and commit.

**The immutable tag ruleset is a prerequisite for automated releases.** Without it, the public source pointer can be rewritten after publication.

#### Decision: the ruleset is the check, and the code that duplicated it was deleted

Earlier revisions of the release workflow re-checked in code what the ruleset guarantees. That was removed deliberately, not overlooked. Two things went:

- **`scripts/release/check-tag-rulesets.mjs`** — read the ruleset back from the API during the release run and failed if it was missing or bypassable. Deleted along with its step in the `tag` job and its call in the release skill's pre-flight.
- **`create-release-tag.mjs`** — a script wrapping the two API calls that create an annotated tag. The `tag` job now makes one `gh api` call inline and creates a lightweight tag; nothing here reads tag objects, so the annotation bought nothing.

The reasoning is the same for both. A ruleset is enforced by GitHub against every actor, at every moment, whether or not a workflow is running. A check in the release run observes it only while the job happens to be running, only for the actor the job happens to be, and only if the token may read it — which `GITHUB_TOKEN` may not, since the rulesets API needs `administration: read`. It could fail to see a real problem and it could go stale against the terraform that actually manages the rule. Duplicating a guarantee in the weaker place is worse than not duplicating it.

Two consequences worth stating plainly, so nobody rediscovers them as bugs:

- **If the ruleset is absent or wrong, nothing here will say so.** The release may succeed with a mutable source tag. That is why an administrator has to satisfy this prerequisite once.
- **The tag is not publishing evidence.** Rerun validation trusts only npm's verified provenance; the ruleset protects the public source reference after creation.

The tag is lightweight rather than annotated. Nothing in this repository reads tag objects — no `git describe`, no signature verification — and immutability rather than annotation provides the protection, so the distinction costs nothing here.

## Optional manual packed-consumer audit

Runtime registry audits are diagnostic tools, not release gates. Neither `.github/workflows/release-publish.yml` nor the `/release` preflight runs `npm audit` or `audit:packed-consumer`, and advisory findings do not determine release eligibility. Registry advisory data can change without a source change, so making it authoritative would make identical release commits pass or fail at different times.

A maintainer investigating dependency exposure may run:

```bash
npm audit --omit=dev
npm run build
npm run audit:packed-consumer
```

The build must precede `audit:packed-consumer` because the command packs the built Bobbit package. It installs that tarball into a clean private consumer with normal lockfile ownership and runs `npm audit --omit=dev --json`. This can reveal dependency-owned shrinkwrap findings that a root audit cannot see.

The command uses fresh home, config, cache, and temporary directories; empty user/global npm configuration; and the public npm registry. It does not inherit auth tokens or custom registry credentials, and pack/install lifecycle scripts are disabled. These controls make the diagnostic reproducible without turning mutable registry output into publication policy.

Unit, browser, and E2E suites intentionally do not query or assert live advisory output. The packed-consumer E2E instead verifies deterministic properties: consumer lock creation, dependency-owned shrinkwrap presence, installed graph validity, coordinated Pi versions, known dependency version/path floors, and bundled binary resolution and smoke behavior. See [Pi runtime compatibility](pi-runtime-compatibility.md) for the selected runtime and historical dependency dispositions.

## Bundled fd/rg/ast-grep binaries

Bobbit ships `fd`, `rg`, and ast-grep so agents have local search binaries with zero network calls at install or runtime. Binaries live in per-platform optional npm
sub-packages under the `@bobbit/` scope. See
[`src/server/binaries.ts`](../src/server/binaries.ts) for the resolver.

### Layout

```
binaries/
  binaries-darwin-arm64/
  binaries-darwin-x64/
  binaries-linux-x64/
  binaries-linux-arm64/
  binaries-win32-x64/
binaries.versions.json   # pinned upstream versions
binaries.checksums.json  # optional pinned SHA-256s
scripts/build-binaries.mjs
```

Each sub-package declares strict `os` / `cpu` fields so npm installs
exactly one per host. The root `package.json` lists all of them under
`optionalDependencies` pinned to an exact version. Sub-package versions
are **decoupled from the root Bobbit version** — the bundled tools change upstream independently, so the sub-packages stay pinned across many Bobbit releases. Only bump and republish them when `binaries.versions.json` changes.

### Bumping a bundled binary

1. Edit `binaries.versions.json`:
   ```json
   { "fd": "10.2.0", "ripgrep": "14.1.1", "astGrep": "<version>" }
   ```
2. (Recommended) Update `binaries.checksums.json` with SHA-256s of the
   release archives you intend to bundle. Format:
   ```json
   {
     "fd-v10.2.0-aarch64-apple-darwin.tar.gz": "<sha256 hex>",
     "ripgrep-14.1.1-aarch64-apple-darwin.tar.gz": "<sha256 hex>",
     "app-aarch64-apple-darwin.zip": "<sha256 hex>"
   }
   ```
   When checksums are present, the build script enforces them.
3. Run the build for every platform:
   ```bash
   npm run build:binaries
   ```
   Or for a single platform during testing:
   ```bash
   node scripts/build-binaries.mjs --only linux-x64
   ```
   The default writes the release package in this checkout. For disposable
   verification, copy the selected `binaries/binaries-<platform>-<arch>`
   package skeleton to an existing temporary directory outside the checkout,
   then use that directory as the bounded staging root:
   ```bash
   node scripts/build-binaries.mjs --only linux-x64 --staging-root /tmp/bobbit-binaries
   ```
   The staging root must contain the copied package directory (for example,
   `/tmp/bobbit-binaries/binaries-linux-x64`); generated binaries remain
   inside that temporary package.
4. Inspect the populated `binaries/binaries-*/bin/` directories. POSIX
   binaries should be `+x`; Windows binaries should end in `.exe`.
5. Commit the bumped `binaries.versions.json`, `binaries.checksums.json`,
   and the regenerated `binaries/binaries-*/package.json` files.
   **Do not commit the binaries themselves** (`bin/` is `.gitignore`d
   inside each sub-package).
6. Bump the version in each `binaries/binaries-*/package.json` by hand
   (the build script no longer auto-bumps these). Update the matching
   pin in the root `package.json` `optionalDependencies` block to the
   new version.
7. Publish each sub-package (the root is not published here — it ships via
   CI when the release PR is merged):
   ```bash
   npm publish ./binaries/binaries-darwin-arm64
   npm publish ./binaries/binaries-darwin-x64
   npm publish ./binaries/binaries-linux-x64
   npm publish ./binaries/binaries-linux-arm64
   npm publish ./binaries/binaries-win32-x64
   ```
   Do this **before** merging the release PR, so the sub-packages are on npm
   before the root package that pins them is published. `publishConfig.access: "public"` is baked
   into each sub-package, so `--access public` is not needed on the CLI.

### Decoupled versioning

Sub-package versions are pinned independently of the root bobbit version.
For a typical Bobbit release that does not change a bundled tool, publish only the root — the sub-packages stay at their current version and the existing `optionalDependencies` pin in `package.json` continues to resolve. Republish sub-packages when `binaries.versions.json` changes, and update the root pin in the same commit.

### Behaviour when the sub-package is missing

A user can end up without the platform sub-package in three ways:

1. They installed with `npm install --no-optional` / `yarn --ignore-optional` / pnpm equivalents.
2. They are on an unsupported `{os, cpu}` tuple (e.g. Linux musl, FreeBSD).
3. The sub-package failed to install for transient network reasons.

In all three cases, `getFdPath()` / `getRgPath()` / `getSgPath()` fall through to a PATH probe (`fd`, `fdfind`, `rg`, `sg`, `ast-grep` — `fdfind` is the Debian/Ubuntu apt name).
If neither bundled nor PATH resolution succeeds, the gateway logs a single clear warning at startup naming the expected sub-package and the PATH candidates it tried, then continues running. Pi-coding-agent's download fallback remains relevant only to its fd/rg tools; callers requiring ast-grep remain unavailable rather than downloading or substituting a parser.

### Platform matrix

Currently shipped:

- `darwin-arm64` (Apple Silicon)
- `darwin-x64` (Intel Mac)
- `linux-x64` — fd is glibc; ripgrep uses the statically-linked musl asset (works on glibc and musl hosts); ast-grep uses the upstream GNU release.
- `linux-arm64` (glibc for fd and rg; upstream GNU release for ast-grep)
- `win32-x64`

Deferred:

- `win32-arm64` — defer until there is real demand.
- A dedicated `linux-x64-musl` sub-package — not needed today because rg's
  musl asset is already linked statically; fd glibc fails on pure-musl hosts,
  which fall through to the PATH probe with a clear warning.

### Verifying a release locally

```bash
# Pack the root and one sub-package, install into a scratch dir, and
# confirm the binaries land where pi looks for them.
npm pack
npm pack ./binaries/binaries-$(node -e 'console.log(process.platform+"-"+process.arch)')
mkdir /tmp/bobbit-smoke && cd /tmp/bobbit-smoke && npm init -y
npm install /path/to/bobbit-*.tgz
ls node_modules/@bobbit/binaries-*/bin/
node -e "import('@gresearch/bobbit/dist/server/binaries.js').then(m => console.log(m.getFdPath(), m.getRgPath(), m.getSgPath()))"
```

### Docker sandbox

`docker/Dockerfile` apt-installs `fd-find` and `ripgrep`, and installs the pinned ast-grep release archive independently. The container does **not** mount host-bundled binaries. Sandbox freshness compares the image's ast-grep version label with `binaries.versions.json`, so an ast-grep version bump rebuilds stale images; fd and ripgrep remain image-owned dependencies.

### Offline composition with `PI_OFFLINE`

When the gateway's startup connectivity probe (`checkInternetAvailable()`
in `src/server/agent/aigw-manager.ts`) determines we're offline, it sets
`process.env.PI_OFFLINE = "1"` for the gateway process. Spawned
pi-coding-agent subprocesses inherit `process.env` (and the Docker
sandbox forwards `PI_OFFLINE` via `-e`), so pi 0.74.0+ skips the GitHub
fd/rg download path in `ensureTool()` and returns `undefined` cleanly
instead of timing out (~10s) on each first call.

Composition:

- **Offline + bundled binary present** — fast path; pi finds the staged
  binary in `<agentDir>/bin` immediately.
- **Offline + no bundled binary, no PATH binary** — pi returns “tool
  unavailable” in ~50 ms instead of hanging on a doomed download. The
  find/grep tool call fails cleanly with a useful error.
- **Online** — `PI_OFFLINE` is not set; pi's download fallback still
  works for users on exotic platforms.

A user-supplied `PI_OFFLINE` value (set in the parent environment
before the gateway starts) is always preserved verbatim — the gateway
never overrides it. Set `PI_OFFLINE=1` manually to force the offline
behaviour even when the connectivity probe would succeed.
