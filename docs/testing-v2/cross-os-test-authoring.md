# Cross-OS test authoring

Use these rules for every Test Suite v2 fixture, harness, and regression. A test must behave the same on Windows, Linux, and macOS, whether the developer has a configured Bobbit account or several test commands are running at once.

## 1. Own every mutable path

Create one run-owned root before importing production code that can discover configuration. Canonicalize the temp parent, then create the root with `mkdtemp`; all fixture state, profiles, caches, sockets, and artifacts belong below it. Remove only that exact root in cleanup—never its parent, a sibling, or a fixed path.

```ts
// Good: a unique, canonical owner root and exact-owner cleanup.
const tempParent = realpathSync(tmpdir());
const runRoot = realpathSync(mkdtempSync(join(tempParent, "bobbit-v2-")));
afterAll(() => rmSync(runRoot, { recursive: true, force: true }));

const fixtureRoot = mkdtempSync(join(runRoot, "fixture-"));
```

```ts
// Bad: shared across processes and can delete another run's state.
const root = join(tmpdir(), "bobbit-e2e");
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
```

Do not derive writable names from `Date.now()` alone. Use `mkdtemp`, a UUID, or a process-unique token under the owned root. Pass the root to child workers through the harness environment rather than having each layer select its own fixed root.

## 2. Compare paths safely

Never use string prefix checks for containment. Normalize lexical inputs with `path.resolve`, then use `path.relative` to test containment. Before accessing existing filesystem objects, resolve **both** the root and candidate with `realpath` and repeat the relative-path check; macOS `TMPDIR` aliases, symlinks, junctions, and case-normalizing filesystems otherwise produce false rejections or escapes.

A user path may not exist yet. In that case, retain the lexical containment check and canonicalize the longest existing prefix before creating or accessing it; do not call `realpath` on a nonexistent leaf and silently fall back to an unverified string comparison. Preserve a lexical alias only when it has passed the same validation as its canonical spelling.

```ts
// Good: existing paths are decided by their canonical spelling; lexical
// containment is the fallback for a path that does not exist yet.
function isWithin(root: string, candidate: string): boolean {
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);

  try {
    return isRelativeWithin(
      realpathSync(lexicalRoot),
      realpathSync(lexicalCandidate),
    );
  } catch {
    return isRelativeWithin(lexicalRoot, lexicalCandidate);
  }
}

function isRelativeWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
```

```ts
// Bad: breaks for `/var` versus `/private/var` and permits prefix siblings.
candidate.startsWith(root)
```

Test both a lexical and canonical spelling of an in-root path, plus an out-of-root path. Where a native directory symlink/junction cannot be created (for example, Windows without privilege), use an injected `realpath` seam—do not skip the invariant.

## 3. Isolate host state and credentials

Tests must never read, write, or infer a developer's real home, `.bobbit` state, MCP configuration, secrets, or provider credentials. Before any relevant import or service construction, redirect `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `BOBBIT_DIR` to directories inside the run root. Snapshot and restore the complete environment values after the test/process.

Delete inherited provider and authentication variables before initialization, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `CLAUDE_CODE_*`, and non-test-owned `BOBBIT_*`. Seed explicit fake values only in a fixture that asserts their handling.

```ts
// Good: inject fixture state before discovery can run.
const home = mkdtempSync(join(runRoot, "home-"));
setTestEnvironment({ HOME: home, USERPROFILE: home, BOBBIT_DIR: join(runRoot, ".bobbit") });
clearProviderCredentials();
const manager = await createManager();

// Bad: `os.homedir()` and inherited credentials decide the result.
const manager = await createManager();
```

Prefer explicit dependency/config-root injection. Environment redirection is the fallback for production code that intentionally discovers user configuration.

## 4. Synchronize on observable work

Install deterministic `fetch`/network stubs before invoking the code under test. Record calls with a deferred promise, resolve the exact response needed by the scenario, and await the observed request or completion event. Do not allow live network access.

Use promise joins, explicit events, deferreds, or a manual clock for asynchronous behavior. `sleep`, polling loops, and wall-clock deadlines are diagnostic safety nets only; they are not evidence that unrelated work completed. `updateComplete` proves a render completed, not that fire-and-forget I/O did.

DOM tests use the registered v2-dom environment setup, interact with the current window's storage, and clear/restore storage between tests. Do not assume a Node global is a browser global.

```ts
// Good: wait for the request caused by the action.
const requestSeen = deferred<Request>();
globalThis.fetch = vi.fn((input) => {
  requestSeen.resolve(new Request(input));
  return Promise.resolve(new Response("{}", { status: 200 }));
});
triggerSave();
expect((await requestSeen.promise).url).toContain("/api/preferences");

// Bad: timing is load- and platform-dependent.
triggerSave();
await new Promise((resolve) => setTimeout(resolve, 100));
expect(fetch).toHaveBeenCalled();
```

## 5. Exercise platform path behavior deliberately

- Build paths with `path` APIs; never assemble them with `/` or `\\` literals.
- Test separator-sensitive helpers with `path.posix` and `path.win32` seams so each OS exercises both forms.
- Test symlink aliases natively when allowed and with a canonicalization seam when they are not. Treat Windows junction/symlink privilege denial as a reason to use the seam, not to skip.
- Write explicit `\n` and `\r\n` fixture variants for line-ending-sensitive parsing; do not rely on Git checkout normalization.
- Test case identity with a native case variant where supported and with a case-folding/realpath seam elsewhere. Never assume a filesystem is case-sensitive or case-insensitive.
- Cover Windows drive-letter and UNC-style inputs in Windows-path helpers. Do not lowercase paths or compare volume/path strings directly; resolve them with the applicable path semantics and use relative containment.

## 6. Isolate processes, browsers, and ports

Servers must bind port `0` and report the assigned port. A literal port is allowed only for a refused-connection or persisted-value fixture that never listens.

Give each run its own browser profile, browser cache write area, test-results directory, coverage output, logs, and generated artifacts. An immutable shared cache may be read only; all writes must be run-namespaced. Same-worktree runs need distinct output directories just as separate-worktree runs do.

Run isolation is required for unit, browser, integration, and E2E harnesses. Verify changes with at least two concurrent commands from separate worktrees; inspect failures for shared paths, inherited environment, fixed ports, and cleanup crossing ownership boundaries.

## 7. Qualification and retention checklist

Before submitting a test or harness change, confirm:

- [ ] Every writable path is beneath a canonical `mkdtemp` owner root, and cleanup removes only that root.
- [ ] Containment uses lexical and paired-canonical `path.relative` checks; symlink aliases and nonexistent paths are handled safely.
- [ ] Home/config/credential discovery is injected or redirected before initialization, and environment changes are restored.
- [ ] Network responses and async completion are deterministic and observable; no sleep or wall-clock assumption is load-bearing.
- [ ] The regression covers separators, symlink fallback, CRLF, and case behavior natively or through a portable seam.
- [ ] Listeners use dynamic ports; browser profiles, caches, coverage, and artifacts are run-scoped.
- [ ] The affected suite passes concurrently from separate worktrees without cross-talk.
- [ ] Assertions were not weakened, tests were not skipped/deleted, and timeouts were not raised as the primary fix.

The configured `retry: 3` is workflow availability protection only. Qualification evidence uses the same inventory with `--retry=0`: five consecutive first-attempt-clean runs on each available OS, plus CI or portable simulation for unavailable OS constraints. Any retry is a flake to investigate, not a passing stability result.
