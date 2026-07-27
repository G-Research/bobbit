# Releasing Bobbit

This doc covers the Bobbit release checks that cannot be inferred from a normal development checkout: the installed consumer's security report and the bundled `fd`/`rg` binaries. The root `@gresearch/bobbit` package itself is published automatically by [`.github/workflows/release-publish.yml`](../.github/workflows/release-publish.yml) (npm trusted publishing / OIDC, with provenance) when a `v*` tag is pushed; only the binary sub-packages below are published manually.

## Required packed-consumer audit

A root audit and a packed-consumer audit are both required before publication:

```bash
npm audit --omit=dev
npm run build
npm run audit:packed-consumer
```

The build must precede `audit:packed-consumer` because the command packs the built Bobbit package. It then installs that tarball into a clean private consumer with normal lockfile ownership and runs `npm audit --omit=dev --json`. Publication is blocked unless npm exits successfully and the report contains zero `info`, `low`, `moderate`, `high`, `critical`, and total vulnerabilities. An install, advisory-service, malformed-report, or cleanup failure is also blocking; do not skip or waive the preflight.

The command runs npm with fresh home, config, cache, and temporary directories; empty user/global npm configuration; and the public npm registry. It does not inherit auth tokens or custom registry credentials, and pack/install lifecycle scripts are disabled. This isolates release evidence from developer credentials and prevents a package lifecycle hook from executing during the security check.

Normal unit, browser, and E2E suites intentionally do not query or assert registry advisory output because that feed can change without a source change. The packed-consumer E2E remains deterministic: it verifies consumer lock creation, dependency-owned shrinkwrap presence, installed graph validity, coordinated Pi versions, known dependency version/path floors, and bundled binary resolution/smoke behavior. Live advisory enforcement belongs only to this required release preflight.

A clean root audit is still useful, but it is not consumer evidence. npm may honor a dependency's published `npm-shrinkwrap.json` only after Bobbit is installed as a package, so the consumer can resolve a different tree from the repository checkout. See [Pi runtime compatibility](pi-runtime-compatibility.md#compatibility-and-release-eligibility) for the current dependency constraints.

## Bundled fd/rg binaries

Bobbit ships `fd` and `rg` so agents have them locally with zero network
calls at install or runtime. Binaries live in per-platform optional npm
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
are **decoupled from the root bobbit version** — fd and ripgrep change
upstream rarely (~yearly), so the sub-packages stay pinned across many
bobbit releases. Only bump and republish them when `binaries.versions.json`
changes.

### Bumping fd or ripgrep

1. Edit `binaries.versions.json`:
   ```json
   { "fd": "10.2.0", "ripgrep": "14.1.1" }
   ```
2. (Recommended) Update `binaries.checksums.json` with SHA-256s of the
   release archives you intend to bundle. Format:
   ```json
   {
     "fd-v10.2.0-aarch64-apple-darwin.tar.gz": "<sha256 hex>",
     "ripgrep-14.1.1-aarch64-apple-darwin.tar.gz": "<sha256 hex>"
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
   CI on the tag push):
   ```bash
   npm publish ./binaries/binaries-darwin-arm64
   npm publish ./binaries/binaries-darwin-x64
   npm publish ./binaries/binaries-linux-x64
   npm publish ./binaries/binaries-linux-arm64
   npm publish ./binaries/binaries-win32-x64
   ```
   Do this **before** pushing the release tag, so the sub-packages are on npm
   before the root that pins them. `publishConfig.access: "public"` is baked
   into each sub-package, so `--access public` is not needed on the CLI.

### Decoupled versioning

Sub-package versions are pinned independently of the root bobbit version.
For a typical bobbit release that doesn't touch fd or ripgrep, you only
publish the root — the sub-packages stay at their current version and
the existing `optionalDependencies` pin in `package.json` continues to
resolve. Only republish sub-packages when `binaries.versions.json`
changes, and update the root pin to match in the same commit.

### Behaviour when the sub-package is missing

A user can end up without the platform sub-package in three ways:

1. They installed with `npm install --no-optional` / `yarn --ignore-optional` / pnpm equivalents.
2. They are on an unsupported `{os, cpu}` tuple (e.g. Linux musl, FreeBSD).
3. The sub-package failed to install for transient network reasons.

In all three cases, `getFdPath()` / `getRgPath()` fall through to a PATH
probe (`fd`, `fdfind`, `rg` — `fdfind` is the Debian/Ubuntu apt name).
If neither bundled nor PATH resolution succeeds, the gateway logs a
single clear warning at startup naming the expected sub-package and the
PATH candidates it tried, then continues running. Pi-coding-agent's
silent download fallback remains as a last resort.

### Platform matrix

Currently shipped:

- `darwin-arm64` (Apple Silicon)
- `darwin-x64` (Intel Mac)
- `linux-x64` — fd is glibc; ripgrep uses the statically-linked musl asset (works on glibc and musl hosts).
- `linux-arm64` (glibc for fd and rg)
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
node -e "import('@gresearch/bobbit/dist/server/binaries.js').then(m => console.log(m.getFdPath(), m.getRgPath()))"
```

### Docker sandbox

`docker/Dockerfile` apt-installs `fd-find` and `ripgrep` independently —
the container does **not** mount host-bundled binaries. Bumping the
bundled versions does not affect the sandbox.

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
