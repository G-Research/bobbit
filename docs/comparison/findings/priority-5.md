# Priority 5 — Edit Safety and Capability

Scope: Goals 5.1–5.9 in `bobbit-improvements.md` (lines 903–1180).

All Bobbit citations are anchored at the wrapped library `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{edit,write,edit-diff}.js` because Bobbit's `.bobbit/config/tools/filesystem/*.yaml` files declare `provider: { type: builtin, tool: <name> }` and contribute no override (audit `bobbit.md:15–18, 60–67`).

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 5.1 | Read-before-edit enforcement (FileStateRegistry; `must_read_first`) | **real** | high |
| 5.2 | Stale-mtime detection between read and edit | **real** | high |
| 5.3 | `replace_all` flag + atomic `multi_edit` tool | **real** | high |
| 5.4 | V4A multi-file patch tool with sorted-lock atomic apply | **real** | high |
| 5.5 | Fuzzy-match fallback chain (multiple strategies + reported strategy) | **partial** | high |
| 5.6 | Preserve CRLF/LF line endings on edit | **already-done** | high |
| 5.7 | Cap inline diff (~200 lines) + persist large diffs + `bytes_before/after` | **real** | high |
| 5.8 | Post-write byte-compare on every edit/write/patch | **real** | high |
| 5.9 | Auto syntax check by extension after patch/edit | **real** | high |

---

## Goal 5.1 — Read-before-edit enforcement

**Doc claim.** Bobbit `edit`/`write` extensions don't check whether the file was previously read; should fail with `must_read_first` when un-read and `file_changed_since_read` when mtime drifted.

**Bobbit reality.** No such check anywhere. `edit` only calls `ops.access(absolutePath)` (POSIX R_OK|W_OK) before reading the file fresh from disk; there is no per-session/per-task read registry. Confirmed by audit `bobbit.md:206 ("Read-before-edit enforcement: ✗ None")` and inspection of `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit.js:44–52`. The Bobbit-side `src/server/agent/` tree has no `file-state.ts`, no `readFileState`, no `FileStateRegistry`. `write.js` likewise has no read check (see `write.js:1–60`).

**Claude Code reality.** Strictly enforced. `FileEditTool.ts:275–287` rejects with `errorCode: 6` and message `"File has not been read yet. Read it first before writing to it."` if `toolUseContext.readFileState.get(fullFilePath)` is missing or `isPartialView`. Same gate in `FileWriteTool.ts:198–205` (audit `claude-code.md:52, 236`).

**Hermes reality.** Soft-enforced (warn, don't block). `tools/file_state.py:142–215` returns a `_warning` "was not read by this agent" classed under "Case 3b" when no read stamp exists; the write proceeds. Reference: audit `hermes.md:208`.

**Verdict.** real

**Reasoning.** Bobbit has neither registry nor check. CC's hard block + Hermes' soft warn are both reference implementations.

**Minimal proof of gap.**
- Bobbit `edit.js:44–52`:
  ```js
  try { await ops.access(absolutePath); }
  catch { reject(new Error(`File not found: ${path}`)); return; }
  // ...read & edit immediately, no read-state lookup
  ```
- CC `FileEditTool.ts:275–287`:
  ```ts
  const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
  if (!readTimestamp || readTimestamp.isPartialView) {
    return { result: false, behavior: 'ask',
      message: 'File has not been read yet. Read it first before writing to it.',
      errorCode: 6 }
  }
  ```

**Scope-down notes.** None — the gap is exactly as the doc claims. Decide CC-style hard block vs Hermes-style warn at design time.

---

## Goal 5.2 — Stale-file detection

**Doc claim.** Re-stat at edit time; refuse with `stale` error if mtime drifted from cached read mtime.

**Bobbit reality.** No mtime tracking exists in Bobbit or in pi-coding-agent. `edit.js` re-reads on every call but never compares to a prior `read` timestamp (no registry to compare against). Audit `bobbit.md:207`: "No stale-content / mtime detection". Confirmed `grep "mtime\|fs.stat" node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{edit,write}.js` returns no hits.

**Claude Code reality.** Mtime+content cross-check at `FileEditTool.ts:289–308`: `lastWriteTime = getFileModificationTime(fullFilePath); if (lastWriteTime > readTimestamp.timestamp) { … errorCode: 7, "File has been modified since read…" }`. Falls back to content-equality on full reads (Windows cloud-sync workaround). See audit `claude-code.md:58, 237`.

**Hermes reality.** Both per-task (`file_tools.py:677–707`) and cross-agent (`file_state.py:120–200`, four-class staleness). Audit `hermes.md:208–209`.

**Verdict.** real

**Reasoning.** Bobbit has nothing; CC and Hermes both implement.

**Minimal proof of gap.**
- Bobbit (audit `bobbit.md:207`): no `mtime` references in `edit.js`/`write.js`.
- CC `FileEditTool.ts:289–293`:
  ```ts
  const lastWriteTime = getFileModificationTime(fullFilePath)
  if (lastWriteTime > readTimestamp.timestamp) {
    // ...errorCode 7 with re-read instruction
  }
  ```

**Scope-down notes.** Goal 5.2 is the natural follow-on to 5.1; ship together. The "warn-not-block" Hermes posture is a viable lower-friction option.

---

## Goal 5.3 — `replace_all` + multi-edit

**Doc claim.** Add `replace_all: bool` (default false) and a new `multi_edit` tool with all-or-nothing semantics.

**Bobbit reality.** `edit` rejects multi-occurrence matches with an explicit error and provides no `replace_all` flag — `pi-coding-agent/dist/core/tools/edit.js:84–90`:
```js
if (occurrences > 1) {
  reject(new Error(`Found ${occurrences} occurrences ... The text must be unique.`)); return;
}
```
No `multi_edit` / `MultiEdit` / `patch` tool exists in `.bobbit/config/tools/` or pi-coding-agent (`grep -rn "multi_edit\|MultiEdit\|replace_all\|replaceAll" .bobbit/config/tools/ node_modules/@mariozechner/pi-coding-agent/dist/core/tools/` → no hits). Audit `bobbit.md:218`: "No multi-file patch tool. Each `edit`/`write` call touches one file."

**Claude Code reality.** Has `replace_all` (`FileEditTool.ts:56`, schema field) and the multi-match guard at `FileEditTool.ts:265–275`. Does **not** ship a `MultiEdit` in this revision (audit `claude-code.md:243, 256, 310`).

**Hermes reality.** `replace_all=True` accepted; `fuzzy_match.py:91–95` rejects multi-occurrence unless flagged. V4A multi-file patch covers the "multi-edit" requirement at a richer level (`file_tools.py:790–859`).

**Verdict.** real

**Reasoning.** Both reference harnesses implement `replace_all`; Bobbit does not. The `multi_edit` half is more accurately covered by Goal 5.4 (V4A patch). Recommend keeping the `replace_all` ask but **scoping down** the separate `multi_edit` tool — overlaps with 5.4.

**Minimal proof of gap.**
- Bobbit `edit.js:81–90` (reject any multi-match outright; no flag).
- CC `FileEditTool.ts:56`: `inputs: { file_path, old_string, new_string, replace_all? }` (audit `claude-code.md:56`).
- Hermes `fuzzy_match.py:91–95`: rejects multi-occurrence unless `replace_all=True` (audit `hermes.md:213`).

**Scope-down notes.** Drop `multi_edit` tool — implement V4A patch (5.4) instead, which is strictly more general.

---

## Goal 5.4 — V4A multi-file patch

**Doc claim.** Add `patch` tool with V4A grammar; sorted-path locks, dry-run validation, atomic apply, rollback.

**Bobbit reality.** No multi-file patch capability at all — confirmed in audit `bobbit.md:217–218`. There is no `patch` extension in `.bobbit/config/tools/` and no V4A parser anywhere in `src/server/`.

**Claude Code reality.** Also absent — single-edit-per-call only (audit `claude-code.md:254–256, 310`). So this goal cites Hermes only.

**Hermes reality.** First-class V4A patch tool. `tools/file_tools.py:790–859`, parser `tools/patch_parser.py:241–555`, sorted-lock acquisition `file_tools.py:818–826` (`ExitStack` over `sorted(paths)`). Audit `hermes.md:55–65, 235–238`.

**Verdict.** real

**Reasoning.** Reference impl exists in Hermes; Bobbit lacks the capability. Effort tag "M" is realistic — needs parser + per-path locks (Goal 7.2).

**Minimal proof of gap.**
- Bobbit: no `patch` tool / no V4A parser (confirmed by `find /Users/aj/Documents/dev/bobbit -name "*patch*"` returning only unrelated UI / proposal-patch routes).
- Hermes `file_tools.py:818–826` (paraphrase from audit `hermes.md:58`):
  ```python
  with ExitStack() as stack:
      for p in sorted(paths):
          stack.enter_context(file_state.lock_path(p))
      # then validate-all, apply-all
  ```

**Scope-down notes.** Implementation depends on Goal 7.2 (per-path locks); list 7.2 as a hard prereq.

---

## Goal 5.5 — Fuzzy match fallback

**Doc claim.** Five-strategy chain (whitespace, indent, newline, trailing-ws, comment-tolerant) returning a `match_strategy` field.

**Bobbit reality.** Already has a single fuzzy fallback strategy. `pi-coding-agent/dist/core/tools/edit-diff.js:25–48, 56–90` (`normalizeForFuzzyMatch` + `fuzzyFindText`):
- Strips trailing whitespace per line.
- Normalises smart quotes, em/en/figure dashes, hyphens, NBSP and various Unicode spaces to ASCII.
- Tries exact match, then this normalized-space match.

But it does **not** report which strategy succeeded (no `match_strategy` field; the result text is the same `Successfully replaced text in {path}` either way), it does **not** offer indent-tolerance or comment-tolerance, and there is no escape-drift guard.

**Claude Code reality.** Has a single quote-tolerant fallback (`findActualString` + `preserveQuoteStyle`, `FileEditTool.ts:251`). Audit `claude-code.md:239`: "smart-quote / curly-quote tolerant matching". No multi-strategy chain.

**Hermes reality.** 9 strategies in `fuzzy_match.py:50–110` (`exact`, `line_trimmed`, `whitespace_normalized`, `indentation_flexible`, `escape_normalized`, `trimmed_boundary`, `unicode_normalized`, `block_anchor`, `context_aware`) plus escape-drift guard (`fuzzy_match.py:112–150`). Audit `hermes.md:59–62, 211, 216`.

**Verdict.** partial

**Reasoning.** The doc states the gap as if Bobbit has no fuzzy at all ("Exact-match edits fail on minor whitespace/indent drift"). False — Bobbit *does* have whitespace+Unicode-tolerant fuzzy. What is genuinely missing: indent-flexible matching, escape-drift guard, surfaced strategy reporting. Scope down accordingly.

**Minimal proof of (smaller) gap.**
- Bobbit `edit-diff.js:31–48` already covers strategies 1, 3 (newline normalisation via `normalizeToLF`), 4 (`trimEnd` per line); does **not** cover indent-flexible or comment-tolerant.
- Hermes `fuzzy_match.py:50–110` adds `indentation_flexible`, `block_anchor`, `context_aware`, plus the escape-drift guard at `fuzzy_match.py:112–150`.

**Scope-down notes.** Reword problem statement. Real deltas: (a) add `indentation_flexible` & `block_anchor`, (b) emit `match_strategy` (or at minimum `usedFuzzyMatch: true/false` — already present internally at `edit-diff.js:88` but **not** exposed in tool output), (c) add Hermes-style escape-drift guard.

---

## Goal 5.6 — Preserve line endings

**Doc claim.** Editing a CRLF file rewrites it to LF, producing massive diffs.

**Bobbit reality.** **Already done.** `edit.js:67–69, 109` calls `detectLineEnding(content)` (CRLF vs LF) before normalising to LF for matching, then `restoreLineEndings(newContent, originalEnding)` before writing. Function definitions at `edit-diff.js:9–22`:
```js
export function detectLineEnding(content) { /* returns "\r\n" or "\n" */ }
export function restoreLineEndings(text, ending) {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
```
BOM is also preserved (`edit.js:65, 109` via `stripBom` and reassembly).

**Claude Code reality.** Detects encoding/CRLF (audit `claude-code.md:58`: "encoding+CRLF detect"); writes via `writeTextContent` in `src/utils/file.ts`.

**Hermes reality.** Not specifically called out in the audit; file ops are heredoc-based (audit `hermes.md:64`).

**Verdict.** already-done

**Reasoning.** The doc problem statement is incorrect for Bobbit's current implementation. `edit` round-trips CRLF; only `write` (full-file overwrite by spec) accepts whatever the model passes.

**Scope-down notes.** Drop this goal for `edit`. If concern remains, narrow to: "have `write` extension preserve existing line endings when overwriting an existing file" (currently `pi-coding-agent/dist/core/tools/write.js:46–50` writes raw `content` with no detection). That's a tiny `write`-only addition.

---

## Goal 5.7 — Concise diffs in tool output

**Doc claim.** Cap inline diff at ~200 lines; persist larger diffs; report `bytes_before` / `bytes_after`.

**Bobbit reality.** `edit.js:120–125` returns the full unified diff via `details.diff` from `generateDiffString` (`edit-diff.js:91–250`) with no length cap. There is no `bytes_before`/`bytes_after` field. Truncation only happens via the generic `truncate-large-content.ts` in pi-coding-agent's bash extension, **not** for `edit` (audit `bobbit.md:252`: "No `/api/sessions/:id/tool-content/<mi>/<bi>` endpoint exists" in master). Diff context is capped to 4 lines (`edit-diff.js:93`), but a 1000-line change still emits ~1000 diff lines.

**Claude Code reality.** Edit returns `structuredPatch` + `gitDiff` (audit `claude-code.md:57, 304`); `maxResultSizeChars: 100_000` cap (`FileEditTool.ts:84`). No explicit "200-line preview + persist" pattern in this revision.

**Hermes reality.** Auto-spillover on size: `tool_output_limits.py` enforces `max_result_size_chars` per tool; large outputs persisted via `tool_result_storage.py:43–58`, addressable via `read_file` over the active backend (audit `hermes.md:249`). Diffs benefit from this generic spillover.

**Verdict.** real

**Reasoning.** Bobbit has no diff cap and no `bytes_before/after` reporting on `edit`. CC caps result size; Hermes persists overflow. The exact 200-line shape isn't standard but the underlying problem is real.

**Minimal proof of gap.**
- Bobbit `edit.js:118–127` returns `details.diff` (full unified diff) with no truncation; no byte-count fields.
- CC `FileEditTool.ts:84`: `maxResultSizeChars: 100_000` (audit `claude-code.md:65`).
- Hermes `tool_result_storage.py:43–58` spillover (audit `hermes.md:249`).

**Scope-down notes.** Frame as "cap edit-tool result + persist overflow", not a fresh idea — align with Goal 6.1.

---

## Goal 5.8 — Post-write byte-compare

**Doc claim.** After write/edit/patch, re-read and compare to expected; mismatch → structured error.

**Bobbit reality.** None. `edit.js:108–115` does `await ops.writeFile(absolutePath, finalContent)` and returns success without re-reading. `write.js:48` likewise writes and returns. Audit `bobbit.md:210`: "Post-write verify / syntax check: ✗ None."

**Claude Code reality.** No inline byte-compare. CC relies on atomic temp+rename via `writeTextContent` (audit `claude-code.md:238`) and post-write LSP `didChange/didSave` (asynchronous). Audit `claude-code.md:304` explicitly: "no inline syntax/lint check by Edit/Write themselves".

**Hermes reality.** Yes, but **`patch_replace` only**, not `write_file`. `tools/file_operations.py:795–808` re-reads via `cat $path` and compares byte-for-byte; mismatch returns `PatchResult(error=...)`. Audit `hermes.md:210, 288`: "post-write read-back is patch-only, not write_file".

**Verdict.** real

**Reasoning.** Capability missing in Bobbit. Hermes gives a working reference; CC does not implement this exact mechanism (LSP path is async). Scope to edit/patch (matching Hermes), not necessarily `write` (which can rely on atomic-rename instead).

**Minimal proof of gap.**
- Bobbit `edit.js:110–115`:
  ```js
  await ops.writeFile(absolutePath, finalContent);
  // ...resolve immediately with diff; no re-read
  ```
- Hermes `file_operations.py:798–806`:
  ```python
  verify_result = self._exec(f"cat {self._escape_shell_arg(path)} 2>/dev/null")
  if verify_result.stdout != new_content:
      return PatchResult(error=f"Post-write verification failed for {path}…")
  ```

**Scope-down notes.** Apply to `edit` and (if added) `patch`; for `write`, prefer atomic temp+rename + size check.

---

## Goal 5.9 — Auto syntax check on patch

**Doc claim.** Per-extension syntax check (`.py`/`.js`/`.ts`/`.go`/`.rs`/`.json`/`.yaml`); return `syntax_ok` + first error line.

**Bobbit reality.** No syntax check anywhere in the edit/write pipeline. Audit `bobbit.md:210`: "Post-write verify / syntax check: ✗ None." Confirmed by absence of any parser/linter invocation in `edit.js`, `write.js`, or `.bobbit/config/tools/filesystem/*`.

**Claude Code reality.** No inline syntax check; relies on async LSP diagnostics (audit `claude-code.md:242, 245, 304`). So this goal cites Hermes.

**Hermes reality.** `tools/file_operations.py:261–267` (`LINTERS` dict) + `_check_lint` at `:853–883`, called from the patch handler. Returns a `LintResult` with `success`/`output` fields (audit `hermes.md:63, 221`):
```python
LINTERS = {
    '.py': 'python -m py_compile {file} 2>&1',
    '.js': 'node --check {file} 2>&1',
    '.ts': 'npx tsc --noEmit {file} 2>&1',
    '.go': 'go vet {file} 2>&1',
    '.rs': 'rustfmt --check {file} 2>&1',
}
```

**Verdict.** real

**Reasoning.** Bobbit lacks the capability; Hermes implements it directly. Worth shipping, with the doc's noted caveat that `npx tsc --noEmit <file>` is slow — cache or per-project tsserver as suggested.

**Minimal proof of gap.**
- Bobbit: no per-extension lint table anywhere (`grep -rn "py_compile\|tsc --noEmit\|node --check" /Users/aj/Documents/dev/bobbit/{src,.bobbit,node_modules/@mariozechner/pi-coding-agent/dist}` → no hits in core tool paths).
- Hermes `file_operations.py:261–267, 853–883` (above).

**Scope-down notes.** Optional opt-out is the right ergonomic. Default-skip TS/`.tsx` until per-project tsserver is available; per-call `tsc --noEmit` is too slow for a default. `.json` / `.yaml` native parse is cheap and high-value — prioritise.

---

## Cross-cutting note

Goals 5.1, 5.2, 5.4, 5.7, 5.8 all depend on (or strongly benefit from) the file-state registry promised in Goal 7.1. Sequence: 7.1 → 5.1 → 5.2 → 5.7/5.8 → 5.4 (which also needs 7.2 per-path locks).
