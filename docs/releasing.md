# Releasing Bobbit

This doc covers the parts of a Bobbit release that are easy to get wrong.
For now it focuses on the **bundled fd/rg binaries** — the rest of the
release flow (changelog, version bump, `npm publish`) is conventional.

## Bundled fd/rg binaries

Bobbit ships `fd` and `rg` so agents have them locally with zero network
calls at install or runtime. Binaries live in per-platform optional npm
sub-packages under the `@bobbit/` scope. See
[`src/server/binaries.ts`](../src/server/binaries.ts) for the resolver, and
the design doc (`design-doc.md`) for the rationale.

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
`optionalDependencies` at the same version as the root (lockstep).

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
6. Publish each sub-package, then the root:
   ```bash
   npm publish --access public ./binaries/binaries-darwin-arm64
   npm publish --access public ./binaries/binaries-darwin-x64
   npm publish --access public ./binaries/binaries-linux-x64
   npm publish --access public ./binaries/binaries-linux-arm64
   npm publish --access public ./binaries/binaries-win32-x64
   npm publish
   ```
   The build script prints these commands at the end of its run.

### Lockstep versioning

Sub-package versions track the root `package.json` `version`. The build
script overwrites each sub-package's `version` field to match. Bumping
fd or ripgrep is therefore a normal Bobbit version bump — there is no
independent sub-package version to manage.

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
- `linux-x64` (glibc)
- `linux-arm64` (glibc)
- `win32-x64`

Deferred:

- `win32-arm64` — defer until there is real demand.
- `linux-x64-musl` — defer; glibc users get the bundled binary, musl
  users get the PATH fallback.

### Verifying a release locally

```bash
# Pack the root and one sub-package, install into a scratch dir, and
# confirm the binaries land where pi looks for them.
npm pack
npm pack ./binaries/binaries-$(node -e 'console.log(process.platform+"-"+process.arch)')
mkdir /tmp/bobbit-smoke && cd /tmp/bobbit-smoke && npm init -y
npm install /path/to/bobbit-*.tgz
ls node_modules/@bobbit/binaries-*/bin/
node -e "import('bobbit/dist/server/binaries.js').then(m => console.log(m.getFdPath(), m.getRgPath()))"
```

### Docker sandbox

`docker/Dockerfile` apt-installs `fd-find` and `ripgrep` independently —
the container does **not** mount host-bundled binaries. Bumping the
bundled versions does not affect the sandbox.
