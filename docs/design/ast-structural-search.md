# AST Structural Search

**Status:** implemented

**Scope:** A read-only `ast_grep` agent tool backed by the maintained ast-grep release binary. This is deliberately separate from LSP support and adds neither editing nor UI. The durable user and operator reference is [AST Structural Search](../ast-structural-search.md).

## 1. Scope ledger

| Classification | Included |
|---|---|
| MUST | Read-only structural matching; `paths`, `pattern`, `language`, and `strictness` controls; data-driven language detection; parse-error reporting; linked-worktree and Docker execution; no checkout output; focused v2 tests and registration; tool docs that state when `grep`/`read` are better. |
| ALLOWED | Small, low-risk additions to existing tool activation, binary resolution, Docker-image freshness, and documented sandbox mounts when needed to make the one tool available in both host and Docker sessions. |
| OUT | LSP implementation or availability work, graph/index work, UI/import offers, structural editing/rewrite mode, custom parsers/grammars, and private Extension Host subsystems. |

The feature must not infer AST support from LSP support. A language record can carry an independent `ast.supported` capability even when no LSP exists or is available.

## 2. Decision

Use the maintained **ast-grep CLI** from the pinned upstream release binary, invoked as a child process. It exposes the full upstream grammar set, recursive file discovery, `--strictness`, and `--json=stream` output. The tool invokes only `sg run` with a pattern, language, paths, JSON output, and read-only search flags. It never supplies `--rewrite`, `--interactive`, or `--update-all`.

### Alternatives compared

| Approach | Advantages | Rejected because |
|---|---|---|
| `@ast-grep/napi` | In-process API, no JSON parsing. | Its built-in Node API supports only JS/TS/TSX/HTML/CSS; other grammars require dynamic registration. That conflicts with a data-driven cross-language matrix and would create a custom grammar-loading subsystem. |
| ast-grep CLI (chosen) | Upstream-maintained parser/grammar distribution, explicit strictness, JSON stream output, full CLI language matrix, one implementation in host and Docker. | Requires a small process adapter and a pinned binary/image lifecycle. Both compose with existing binary and sandbox machinery. |
| Hand-rolled tree-sitter/parser adapters | Could tailor output. | Would duplicate grammar resolution, parse-error behavior, and maintenance owned by ast-grep. Explicitly prohibited by the goal. |
| Text search (`rg`/`grep`) | Fast and ideal for literals. | Cannot distinguish syntax from comments/strings or reason over AST metavariables. It remains the preferred tool for simple text queries. |

## 3. Public tool contract

The canonical Code Intelligence pack source is `market-packs/code-intelligence/`:

- `tools/ast/ast_grep.yaml` declares `name: ast_grep`, provider `bobbit-extension`, and concise prompt/docs metadata.
- `tools/ast/extension.ts` registers exactly this read-only tool.
- `lib/language-matrix.ts` is the shared language catalogue and detection helper.
- `tools/ast/ast-grep-runner.ts` validates inputs, executes the CLI, and normalizes results with injected process/filesystem seams for unit tests.

The tool parameters are:

```ts
interface AstGrepInput {
  /** CWD-relative files or directories; default ["."]. */
  paths?: string[];
  /** Valid ast-grep source pattern for the selected language. */
  pattern: string;
  /** A catalogue alias; omitted means detect supported languages from paths. */
  language?: AstGrepLanguageAlias;
  /** ast-grep pattern matcher strictness; default "smart". */
  strictness?: "cst" | "smart" | "ast" | "relaxed" | "signature" | "template";
}
```

Validation rules:

1. `pattern` is nonempty after trimming; do not rewrite it.
2. `paths` defaults to `["."]`, must be a nonempty bounded array of relative paths, and each resolved/canonical existing path must remain within `process.cwd()`. Reject absolute paths, traversal, symlink escapes, unreadable paths, and unsupported file types with a clear tool error.
3. `language`, when present, is a case-normalized alias from the catalogue. Do not pass arbitrary language names to the process.
4. `strictness` defaults to `smart` and is an enum, never a passthrough flag.
5. The adapter executes without a shell using an argument array, has a finite output buffer and timeout, and forwards cancellation through `AbortSignal`.
6. The runner limits returned matches and diagnostic text deterministically. It reports truncation rather than silently dropping data.

Each result is normalized to model-readable text plus machine-readable `details`:

```ts
interface AstGrepMatch {
  file: string; // cwd-relative, slash-normalized
  range: { start: { line: number; column: number }; end: { line: number; column: number } };
  line: number; // human-readable, one-based
  text: string;
  metaVariables: Record<string, unknown>;
}
interface AstGrepResult {
  languages: AstGrepLanguageAlias[];
  matches: AstGrepMatch[];
  matchCount: number;
  truncated: boolean;
  diagnostics: Array<{ file?: string; message: string }>;
}
```

Line and column values use ast-grep's JSON positions (zero-based); the `line` field is one-based. A no-match search is successful and returns `matchCount: 0`. A malformed pattern, unsupported requested language, inaccessible input, process startup failure, or all-language parse failure is an error result with actionable text. Parse diagnostics for individual files remain in `diagnostics` while valid matches from other files are returned.

The YAML `detail_docs` must be candid: use `ast_grep` for syntax-aware patterns (for example `console.log($$$ARGS)`), use `grep` for plain text/regex and broad fast discovery, and use `read` to inspect surrounding source or a small known file. It must explicitly say that patterns must parse in the selected language and that the tool does not edit files.

## 4. Data-driven language capability

`market-packs/code-intelligence/lib/language-matrix.ts` is the single source of truth for both availability/detection and invocation. It exports records rather than parallel extension maps or LSP checks:

```ts
interface CodeIntelligenceLanguage {
  id: string;                         // stable API alias, e.g. "typescript"
  label: string;
  evidence: { globs: readonly string[] };
  ast: { supported: true; grammar: string }; // independent capability
}
```

Initial records mirror ast-grep's built-in CLI languages: Bash, C, C++, C#, CSS, Elixir, Go, Haskell, HCL, HTML, Java, JavaScript, JSON, Kotlin, Lua, Nix, PHP, Python, Ruby, Rust, Scala, Solidity, Swift, TypeScript, TSX, and YAML. The implemented records use the exact upstream extension matrix, including aliases such as `.cts`/`.mts`, `.pyi`, `.yml`, and `.yaml`; collisions are resolved explicitly in the record table rather than by an implicit first-match rule.

Detection is bounded and read-only:

1. Resolve validated requested paths under the session CWD.
2. Walk only those paths with ignored/build directories excluded and no symlink following; collect extensions up to a documented scan cap.
3. Map extensions through the catalogue, yielding a sorted unique `AstGrepLanguageAlias[]`.
4. With no explicit `language`, execute one `sg run` per detected language. With an explicit language, execute only that language against the validated paths.

At extension activation, the same detector checks the session CWD. If it finds no catalogue language, it registers no `ast_grep` tool: unsupported projects are inert. A project with a supported AST language receives the tool regardless of LSP capability. Explicit language selection is validated at call time and cannot make an unsupported grammar appear.

Do not use `repo-scan.ts` or `monorepo-scan.ts` as language sources: they identify repositories/manifests, not source grammar capabilities. They may remain independent consumers of project files.

## 5. Execution and diagnostics

For each selected language the runner builds this conceptual argv:

```text
sg run --pattern <pattern> --lang <cliLanguage> --strictness <strictness> --json=stream --color never --heading never <validated paths...>
```

The real implementation adds only fixed, reviewed flags needed to respect existing ignore behavior and output limits. User input is always an argument value, never an option fragment or shell source. It parses JSON lines independently so one malformed output record does not hide already valid records. Stderr is parsed/normalized into bounded parse diagnostics; unexpected nonzero exit status is distinguished from ast-grep's normal no-match outcome.

The tool is read-only by construction:

- it never asks ast-grep to rewrite or launch an interactive session;
- it creates no cache, rule, temp, config, or generated file inside the worktree;
- any process-level temporary material belongs in the system temp directory and is removed in `finally` (the intended path needs none);
- matches always report CWD-relative paths, never host filesystem paths outside the worktree.

## 6. Binary and sandbox lifecycle

The tool uses the same pinned ast-grep version on host and Docker through the existing `src/server/binaries.ts` resolver/staging pattern:

1. `binaries.versions.json`, `binaries.checksums.json`, and the per-platform optional packages carry the pinned upstream ast-grep release for the supported host targets.
2. The resolver verifies the packaged `ast-grep` executable first, then probes `sg` and `ast-grep` on `PATH`. An unavailable executable leaves the surface inert; it never causes fallback parsing.
3. The resolved host binary is staged through the existing agent binary staging location, so direct agents invoke it without writing to a checkout.
4. `docker/Dockerfile` installs the matching release archive and exposes its `sg` launcher. Sandbox freshness compares the image ast-grep label with `binaries.versions.json` and rebuilds stale images.
5. Docker does not receive a host project `node_modules` mount or host binary path: it uses the image-local executable in its linked-worktree CWD.

This deliberately relies on existing `docker-args.ts` image construction, read-only tools mount, `rpc-bridge.ts` Docker `-w` CWD selection, and linked-worktree volumes. It does not add arbitrary sandbox mounts, state mounts, or checkout writes.

## 7. Implemented surface

| Path | Responsibility |
|---|---|
| `market-packs/code-intelligence/tools/ast/ast_grep.yaml` | Tool metadata, concise tool docs, `bobbit-extension` provider. |
| `market-packs/code-intelligence/tools/ast/extension.ts` | Registers read-only `ast_grep` only when detector + binary availability allow it. |
| `market-packs/code-intelligence/lib/language-matrix.ts` | Catalogue, alias validation, bounded extension detection, independent AST capability. |
| `market-packs/code-intelligence/tools/ast/ast-grep-runner.ts` | Validation, no-shell CLI adapter, stream JSON/stderr normalization, cancellation and limits. |
| `src/server/binaries.ts` and binary build/version/package metadata | Resolve and stage the pinned ast-grep binary using the existing approach. |
| `docker/Dockerfile` and sandbox freshness code | Install/pin `sg`; mark containers stale when the ast-grep image version changes. |
| `tests2/tests-map.json` | Registers focused Test Suite v2 coverage. |
| `docs/ast-structural-search.md` | User and operator reference for invocation and fallback behaviour. |

No LSP module, graph module, UI component, import offer, or edit API belongs in this change.

## 8. Verification plan

Focused coverage is registered in `tests2/tests-map.json`:

| Test | Tier | Assertions |
|---|---|---|
| `tests2/core/ast-grep-language-catalog.test.ts` | unit | Every supported extension resolves deterministically; aliases are unique; collision handling is explicit; structural-search availability does not depend on LSP state; unsupported trees are inert. |
| `tests2/core/ast-grep-runner.test.ts` | unit | Argument array is read-only/no-shell; defaults and enum validation; JSON match normalization; zero-result success; parse stderr is retained; cancellation, truncation, and process failures are accurate. |
| `tests2/core/ast-grep-tool-activation.test.ts` | unit | The YAML provider loads one extension in supported worktrees and no tool in unsupported worktrees; the existing description-budget test includes the new group. |
| `tests2/integration/ast-grep-worktree.test.ts` | integration | A real linked worktree with TypeScript/Python fixtures returns structural matches, respects paths/language/strictness, reports a malformed fixture, and leaves `git status --porcelain` empty. |
| `tests2/integration/ast-grep-docker-worktree.test.ts` | E2E-owned integration | When Docker is available, invoke the actual sandbox image from a linked worktree, prove image-local `sg` resolves in the container CWD and results map to worktree-relative paths; skip only under the established no-Docker guard. |

The implementation owner runs `npm run check` and the affected focused unit command while developing; the team workflow runs the inherited `npm run test:unit`, browser, and E2E gates. The Docker test is the required proof that image/build and mount wiring—not an accidental host executable—serves sandboxed sessions.

## 9. Acceptance criteria

1. A supported linked worktree exposes `ast_grep`; an unsupported project exposes nothing and produces no generated checkout files.
2. `paths`, `pattern`, `language`, and `strictness` are validated and demonstrably affect execution.
3. TypeScript and a non-JS grammar work through the same data-driven catalogue; the latter needs no LSP.
4. A malformed source file reports a bounded parse diagnostic without discarding valid matches from other files.
5. The binary runs on host and in the real Docker project-worktree CWD through existing image/mount machinery.
6. The implementation contains no rewrite/edit flag, method, UI, or generated configuration in a checkout.
7. Tests are focused, registered, and cover the catalogue, runner, linked worktree, Docker path, and clean worktree invariant.
