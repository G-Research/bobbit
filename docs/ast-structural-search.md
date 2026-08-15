# AST Structural Search

`ast_grep` is the Code Intelligence pack's read-only structural-search tool. It uses the upstream ast-grep executable to match source syntax rather than text, so an agent can find constructs such as a function call without treating comments or string contents as code. It complements `grep` and `read`; it does not replace them or provide structural editing.

## When to use it

Use `ast_grep` when the query is a valid fragment of a source language and syntax matters:

```ts
ast_grep({
  paths: ["src"],
  pattern: "console.log($$$ARGS)",
  language: "typescript",
  strictness: "ast",
})
```

Use `grep` for literal text, regular expressions, and broad discovery. Use `read` to inspect a known file or the context around a match. `ast_grep` never rewrites files.

## Inputs

| Input | Behaviour |
|---|---|
| `paths` | Existing files or directories relative to the session working directory. Defaults to `.`. Paths must remain inside that directory; absolute paths, traversal, symlinks, unreadable paths, and unsupported file types are rejected. |
| `pattern` | Required ast-grep source pattern. It must parse in the selected language. Metavariables such as `$$$ARGS` can capture syntax. |
| `language` | Optional case-insensitive language alias. When omitted, supported languages are detected from the requested paths. |
| `strictness` | Optional match mode: `cst`, `smart` (the default), `ast`, `relaxed`, `signature`, or `template`. |

Supported aliases are `bash`, `c`, `cpp`, `csharp`, `css`, `elixir`, `go`, `haskell`, `hcl`, `html`, `java`, `javascript`, `json`, `kotlin`, `lua`, `nix`, `php`, `python`, `ruby`, `rust`, `scala`, `solidity`, `swift`, `typescript`, `tsx`, and `yaml`. The Code Intelligence language matrix owns the extension mapping, so structural-search support is independent of LSP availability. See [Language LSP Intelligence](language-lsp-intelligence.md) for the dormant LSP capability model.

For example, a Python search can be explicit:

```ts
ast_grep({
  paths: ["tools"],
  pattern: "print($$$ARGS)",
  language: "python",
})
```

## Results and errors

A successful result contains `matches`, `matchCount`, `languages`, `truncated`, and `diagnostics`.

- Each match has a working-directory-relative `file`, matched `text`, a one-based `line`, a zero-based `range`, and any captured `metaVariables`.
- No matches is successful: `matchCount` is `0`.
- Output and diagnostics are bounded. `truncated: true` means the result was limited or contained an unparseable output record.
- Diagnostics can accompany valid matches, allowing a malformed source file to be reported without discarding matches from other files. Paths outside the session working directory are redacted from diagnostics.

An invalid pattern, unsupported language, unsafe path, unavailable executable, timeout, cancellation, or a failed search is returned as a tool error with an actionable message. Check that the pattern parses for the chosen language before relaxing strictness.

## Availability and execution

The tool is registered only when both conditions hold:

1. the Code Intelligence pack is active for the session; and
2. the session working directory contains a supported source language and a runnable ast-grep executable is available.

Unsupported projects remain inert rather than receiving a partial parser fallback. Supplying `language` chooses an already-supported grammar for a call; it does not add an arbitrary grammar.

Searches run without a shell. User values are passed as argument values, and search paths are placed after ast-grep's end-of-options marker. The runner uses only read-only `sg run` options and creates no cache, rule, configuration, or generated output in the checkout.

## Host and Docker operations

On supported host platforms, Bobbit resolves a verified ast-grep binary from its optional binary package first, then from `sg` or `ast-grep` on `PATH`. A missing executable leaves the tool unavailable; it never falls back to a different parser.

Docker sessions use the image-local `sg` binary, not a host binary mount. The sandbox image installs the same pinned ast-grep release as the host packages and labels the image with that version. Bobbit rebuilds a stale sandbox image during its normal freshness check, so a binary-version update reaches both execution environments without writing into a project checkout.

For package/version maintenance and release verification, see [Bundled binaries](releasing.md#bundled-fdrgast-grep-binaries). For pack installation and activation, see [Marketplace](marketplace.md).

## Troubleshooting

| Symptom | Resolution |
|---|---|
| `ast_grep` is absent | Confirm the Code Intelligence pack is active, the session starts in a directory containing a supported source file, and the host binary package or `PATH` executable is runnable. |
| Pattern error | Use syntax valid for the selected language. Start with an explicit `language` when the tree contains more than one language. |
| No results | Check the selected `paths`, then use `read` to verify the source shape or `grep` for text-level discovery. |
| Docker session lacks the tool | Rebuild or let Bobbit refresh the configured sandbox image; the container must provide `sg` itself. |
