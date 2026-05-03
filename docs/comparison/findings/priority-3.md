# Priority 3 — Upgrade File Read & Search

Investigation of Goals 3.1–3.7 in `bobbit-improvements.md` against actual source in
`/Users/aj/Documents/dev/bobbit` (master @ `a3a9cc7`, package `0.1.8`),
`/Users/aj/Documents/dev/claude-code`, and `/Users/aj/Documents/dev/hermes-agent`.

Bobbit's coding-tool surface (`read`, `grep`, `find`) is inherited verbatim from
`@mariozechner/pi-coding-agent` — defined in
`node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{read,grep,find}.js`.
Bobbit ships no override of these tools, no `file-state.ts`, no loop-guard, no
redactor. Phase-A audit `audits/bobbit.md:193–234` confirms this.

## Verdict summary

| Goal | Claim | Verdict | Confidence |
|------|-------|---------|------------|
| 3.1  | Bobbit re-reads identical files into context; no dedup cache | **real** | high |
| 3.2  | No repeated-call / loop guard on read+search | **real** | high |
| 3.3  | `read`/`grep`/`find` truncate without surfacing structured `{truncated, nextOffset}` | **partial** | high |
| 3.4  | Bobbit's grep lacks `output_mode`/`head_limit`/`offset`/`type`/leading-dash handling | **real** | high |
| 3.5  | `find` is unordered (fd default), no `since`/mtime-sort | **real** | high |
| 3.6  | No device-file blocklist on `read` (e.g. `/dev/zero`) | **real** | high |
| 3.7  | No secret redaction on tool output | **real** | high |

---

## Goal 3.1: Read deduplication

**Doc claim.** Re-reading the same `(path, offset, limit)` while mtime is unchanged
re-injects full contents; need a per-session `FileStateRegistry` returning a short
stub when the read is a no-op.

**Bobbit reality.** `read` is the verbatim pi-coding-agent tool —
`node_modules/@mariozechner/pi-coding-agent/dist/core/tools/read.js:14` (`createReadTool`).
The `execute` body (lines 27–160) reads from disk on every call (`ops.readFile(absolutePath)`,
line 56 / 84) with no cache lookup. Phase-A audit:
`audits/bobbit.md:37` ("No mtime tracking, no read-before-edit linkage, no caching/dedup.
Each call re-reads from disk.") and `audits/bobbit.md:193–197`
(grep on `dedup|sameToolCall` in `src/server` returns no matches). No `file-state.ts`
exists in `src/server/agent/`.

**Claude Code reality.** Implements exactly the proposed shape.
`src/tools/FileReadTool/FileReadTool.ts:386–432` returns a `file_unchanged` stub
when `(absoluteFilePath, offset, limit, mtime)` matches the prior Read entry in
`readFileState: FileStateCache` (LRU 100/25 MB, `src/utils/fileStateCache.ts:18–23`).
Killable via GrowthBook flag `tengu_read_dedup_killswitch`
(`FileReadTool.ts:537`). Audit cite: `audits/claude-code.md:22, 214–215`.

**Hermes reality.** Per-task `_read_tracker` keyed `(resolved_path, offset, limit) →
mtime` in `tools/file_tools.py:485–520`; on unchanged-mtime re-read returns a
`_READ_DEDUP_STATUS_MESSAGE` stub (`tools/file_tools.py:425–442`); after 2 stub
returns same key, hard-blocks (`tools/file_tools.py:415–430`). Cleared on context
compression via `reset_file_dedup` (`run_agent.py:8993–8994`). Audit cite:
`audits/hermes.md:33`.

**Verdict.** **real — high confidence.**

**Reasoning.** Bobbit ships no dedup at any layer (extension, server, library).
Both reference impls match the doc's interface sketch closely. The retrofit is
a straightforward cwd-/sessionId-keyed `Map` plus an `executeWrapper`-style
extension hook in `.bobbit/config/tools/filesystem/`.

**Minimal proof of gap.**

Bobbit (no cache; full content re-read every call):
```js
// pi-coding-agent/dist/core/tools/read.js:84
const buffer = await ops.readFile(absolutePath);
const textContent = buffer.toString("utf-8");
const allLines = textContent.split("\n");
```

Claude Code (cache hit returns stub):
```ts
// src/tools/FileReadTool/FileReadTool.ts:386-432
const cached = readFileState.get(absoluteFilePath)
if (cached && cached.offset === offset && cached.limit === limit
    && cached.timestamp >= currentMtime) {
  return { type: 'file_unchanged' as const, ... }
}
```

Hermes (same idea, Python):
```py
# tools/file_tools.py:495-510
dedup_key = (resolved_str, offset, limit)
cached_mtime = task_data.get("dedup", {}).get(dedup_key)
if cached_mtime is not None and os.path.getmtime(resolved_str) == cached_mtime:
    return _READ_DEDUP_STATUS_MESSAGE  # stub
```

**Scope-down notes.** Goal as written is well-scoped. Recommend tying cache reset
to Bobbit's compaction event (currently `refreshAfterCompaction`, `session-manager.ts:1429`)
not just to session destruction.

---

## Goal 3.2: Repeated-call loop guards

**Doc claim.** No guard against a model spinning on the same `(toolName, args)`
identical call. Need warn-at-3, block-at-4 escalation per session.

**Bobbit reality.** No matching code. Audit `audits/bobbit.md:193–197`:
`grep -rn "loop|repeated"` and `grep -rn "dedup|duplicate|sameToolCall"` in
`src/server` and `pi-coding-agent` agent loop return no loop-guard hits — only
streaming-loop machinery references. Tools have no per-call counter; the agent
will happily emit the same `grep`/`read` 20 times in a row.

**Claude Code reality.** No explicit consecutive-identical-call counter for
`Grep`/`Glob`. The `Read`-side `file_unchanged` stub indirectly bounds Read loops
but not Grep loops. (`audits/claude-code.md:212–217` only describes the read-dedup
freshness mechanism; no separate loop-guard.) So CC is not a reference for this
specific goal — Hermes is.

**Hermes reality.** Explicit consecutive-key counter per task.
`tools/file_tools.py:506–525` for `read_file`: same `read_key` 3×→`_warning`,
4×→hard-block `BLOCKED:` error returning no content. Mirrored for `search_files`
at `tools/file_tools.py:879–897` (`count >= 4` ⇒ block, `>= 3` ⇒ warn).
Counter reset by `notify_other_tool_call(task_id)` whenever a non-read/non-search
tool runs (`tools/file_tools.py:608–627`). Audit cites:
`audits/hermes.md:34, 189–194`.

**Verdict.** **real — high confidence.**

**Reasoning.** Bobbit has no analogue. Hermes provides a clean reference
implementation matching the doc's interface (`LoopGuard.observe` → `'ok'|'warn'|'block'`).
CC is silent here, which is fine — the goal cites Hermes as reference.

**Minimal proof of gap.**

Bobbit: nothing exists. Search across `src/server/`, the inherited
`pi-coding-agent` tool dir, and `.bobbit/config/tools/` returns no
matches for `consecutive`, `loop_guard`, or counter logic on tool args.

Hermes (block + warn):
```py
# tools/file_tools.py:633-650
if count >= 4:
    return json.dumps({"error":
        f"BLOCKED: You have read this exact file region {count} times in a row. "
        "STOP re-reading and proceed with your task.", ...})
elif count >= 3:
    result_dict["_warning"] = (
        f"You have read this exact file region {count} times consecutively. ...")
```

**Scope-down notes.** As written. Two minor notes: (a) reset on *any* non-read/search
tool (Hermes's rule) is sound and should be the default; (b) the `callKey` hash
should canonicalize paths to absolute so `./foo.ts` and `/abs/foo.ts` collapse.

---

## Goal 3.3: Truncation flags

**Doc claim.** `read`/`grep`/`find` "currently truncate silently."

**Bobbit reality.** *Partially wrong.* The pi-coding-agent tools **already**
emit a truncation notice in the textual output. `read.js:114–124` appends
`[Showing lines X-Y of N. Use offset=Z to continue.]`, and `find.js:71–82`
appends `[<n> results limit reached. <bytes> limit reached]`. Internally,
`truncate.js:44–96` returns a structured `{ truncated, truncatedBy, content,
outputLines, ... }` and the read tool sets it under `details.truncation`
(see `read.js:113, 125`). What is **missing** is a stable, parseable
`{truncated: bool, totalCount, nextOffset}` field at the top level of the
tool result — the agent currently has to parse the human-readable notice
out of the text. `grep.js` does not surface a structured `truncated` field
either; it just appends bytes via `truncateLine`.

**Claude Code reality.** Surfaces truncation as a structured field on most
result envelopes — e.g. Glob output `{filenames[], numFiles, durationMs,
truncated}` (`audits/claude-code.md:31`); `isResultTruncated()` /
`isOutputLineTruncated()` (`MCPTool.ts:67`, `audits/claude-code.md:171`)
are first-class.

**Hermes reality.** Surfaces truncation hints similarly to Bobbit but with
explicit `[Hint: Results truncated. Use offset=N…]` and a structured
`hint` field on `search_files` (`audits/hermes.md:41`). Plus head/tail
truncation with explicit char count for shell output
(`terminal_tool.py:2031–2041`, `audits/hermes.md:72`).

**Verdict.** **partial — high confidence.**

**Reasoning.** Bobbit *does* tell the agent when output was truncated
(via in-text `[Showing lines X-Y of N. Use offset=Z to continue.]`), so
the headline claim "truncate silently" is wrong. The real gap is shape:
no structured top-level `{truncated, nextOffset}` flag, and `grep` is
genuinely silent about line-count truncation (only the per-line clip
of long lines is surfaced). This is worth doing but at lower priority
than 3.1/3.2/3.4.

**Minimal proof of gap.**

Bobbit `read` already gives a notice:
```js
// pi-coding-agent/dist/core/tools/read.js:118-122
outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay}
  of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
```
…but the textual notice is not a programmatic field. The structured
`details.truncation` exists internally but is not part of the model-visible
tool result envelope.

**Scope-down notes.** Drop "currently truncate silently" framing. Reframe
as: (a) add structured `truncated`/`nextOffset` to result envelopes; (b)
extend pi-coding-agent's `grep.js` to surface match-count truncation, not
just per-line clip. Goal becomes XS effort and impact ⭐ rather than ⭐⭐.

---

## Goal 3.4: Upgrade grep tool

**Doc claim.** Bobbit's grep lacks `output_mode`, `head_limit`, `offset`,
`type`, robust leading-dash patterns; needs a CC-style upgrade.

**Bobbit reality.** Verified by reading
`node_modules/@mariozechner/pi-coding-agent/dist/core/tools/grep.js:9–17`
(schema). Parameters: `pattern, path, glob, ignoreCase, literal, context,
limit`. **Missing**: `output_mode`, `head_limit`, `offset`, `type` (rg
`--type` filter), `multiline`, before/after split context. Pattern is passed
as a positional arg (`args.push(pattern, searchPath)`, line 96) — *not* via
`-e`, so a leading-dash pattern would be parsed as an rg flag (system prompt
already documents the workaround: "**Cannot search patterns starting with
`--`** — use `bash` with `rg -- 'pattern'` instead"). Output is a
`<rel>:<line>: <text>` block-format with a per-line clip; no
`files_with_matches` or `count` mode. Audit cite: `audits/bobbit.md:47–51`.

**Claude Code reality.** `src/tools/GrepTool/GrepTool.ts:32–93` schema has
`pattern, path, glob, output_mode (content|files_with_matches|count), -A,
-B, -C, context, -n, -i, type, head_limit (default 250), offset, multiline`.
Default cap 250; `head_limit=0` disables. `audits/claude-code.md:36–38`
confirms.

**Hermes reality.** `tools/file_tools.py:943–1010` (search_files): `pattern,
target, path, file_glob, limit (default 50), offset, output_mode
(content|files_only|count), context`. Truncation appends
`[Hint: Results truncated. Use offset=N…]`. Audit cite:
`audits/hermes.md:41`.

**Verdict.** **real — high confidence.**

**Reasoning.** Both reference impls match the proposed schema closely;
Bobbit's surface is genuinely thinner. The leading-dash issue is a
real footgun that a `-e` switch fixes trivially.

**Minimal proof of gap.**

Bobbit grep schema (no output_mode / head_limit / offset / type):
```js
// pi-coding-agent/dist/core/tools/grep.js:9-17
const grepSchema = Type.Object({
    pattern, path, glob, ignoreCase, literal, context, limit
});
// line 96: args.push(pattern, searchPath); // pattern positional, no -e
```

Claude Code (rich schema):
```ts
// src/tools/GrepTool/GrepTool.ts:52-84
output_mode: z.enum(['content', 'files_with_matches', 'count']) ...
head_limit: ... 'Defaults to 250 ... Pass 0 for unlimited'
offset:     ... 'Skip first N lines/entries before applying head_limit'
```

**Scope-down notes.** As written, but note this requires either (a)
forking/overriding pi-coding-agent's grep via a `.bobbit/config/tools/`
extension (matching the bash-override pattern documented at
`audits/bobbit.md:82`), or (b) upstreaming to pi-coding-agent. Recommend
(a) for shipping speed.

---

## Goal 3.5: Upgrade find tool

**Doc claim.** Results unordered; no mtime sort; may not respect `.gitignore`;
no `since`/`limit`/`offset` params (only basic limit).

**Bobbit reality.** `pi-coding-agent/dist/core/tools/find.js:9–14` schema is
`{pattern, path, limit}` — no `glob` (since `pattern` *is* the glob), no
`offset`, no `since`. Implementation uses `fd --glob --hidden` with
gitignore-file flags (`fd` does honour .gitignore by default and the code
explicitly adds nested `--ignore-file` entries — so the doc's "may not respect
.gitignore" claim is wrong). Output order is **fd's default** (filesystem
traversal order, not mtime). Audit cite: `audits/bobbit.md:53–56`.

**Claude Code reality.** `Glob` tool `src/tools/GlobTool/`: hardcoded
`limit = 100`; no offset; no `since`; sort by mtime is not surfaced.
(`audits/claude-code.md:30–34`.) So **CC is *not* a reference for the
mtime-sort behaviour** — only Hermes is.

**Hermes reality.** Audit notes mtime-sorted file search as a Hermes feature;
`tools/file_operations.py:996–1043` runs `rg --files` with sort.
(`audits/hermes.md:42`; `bobbit-improvements.md:597` cites "Hermes mtime-sorted
file search".)

**Verdict.** **real — high confidence**, but with one factual correction.

**Reasoning.** The mtime-sort and `since` params genuinely don't exist in
Bobbit. The `.gitignore`-respect claim is a hallucination — fd respects
.gitignore by default and the Bobbit/pi-coding-agent code adds explicit
`--ignore-file` flags. Drop that part of the claim.

**Minimal proof of gap.**

Bobbit (no mtime sort, no since):
```js
// pi-coding-agent/dist/core/tools/find.js:9-14
const findSchema = Type.Object({
    pattern: ..., path: ..., limit: ...,  // that's it
});
// line ~98: args = ["--glob", "--color=never", "--hidden", "--max-results", N]
//   → no --sortr=modified, no time filter
```

Hermes (rg with sort cited in audit):
```py
# tools/file_operations.py:996-1043 (per audit hermes.md:42)
# ripgrep via ShellFileOperations._search_*
# rg --files --sortr=modified is the doc-cited pattern
```

**Scope-down notes.** Drop the ".gitignore not respected" sub-claim —
already handled. Keep mtime-sort + `since` + `offset`.

---

## Goal 3.6: Device-file blocklist

**Doc claim.** Reading `/dev/zero`, `/dev/random`, `/dev/stdin`, etc. can hang
the agent; need an explicit reject list in `read`.

**Bobbit reality.** No such guard. `pi-coding-agent/read.js:48` calls
`ops.access(absolutePath)` and proceeds; lines 84–86 run
`ops.readFile(absolutePath)` (which on `/dev/zero` is unbounded but in
practice will be cut off by the 50KB byte cap in `truncateHead`, line 105).
However `/dev/stdin` / `/dev/tty` block on syscall *before* any byte cap
applies, hanging the agent. Search confirms no blocklist:
```
$ grep -rn '"/dev/' /Users/aj/Documents/dev/bobbit/src \
    /Users/aj/Documents/dev/bobbit/.bobbit \
    /Users/aj/Documents/dev/bobbit/node_modules/@mariozechner/pi-coding-agent
# (no matches in tool source)
```
Audit `audits/bobbit.md:32–37` makes no mention of device blocking.

**Claude Code reality.** Explicit set.
`src/tools/FileReadTool/FileReadTool.ts:98–114`:
```ts
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
  '/dev/stdin', '/dev/tty', '/dev/console',
  '/dev/stdout', '/dev/stderr',
  /* /proc/<pid>/fd/{0,1,2} via prefix check */
])
// line 118: if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
```
Audit cite: `audits/claude-code.md:26`.

**Hermes reality.** Same set.
`tools/file_tools.py:69–90`:
```py
_BLOCKED_DEVICE_PATHS = frozenset({
    "/dev/zero", "/dev/random", "/dev/urandom", "/dev/full",
    "/dev/stdin", "/dev/tty", "/dev/console",
    "/dev/stdout", "/dev/stderr",
    "/dev/fd/0", "/dev/fd/1", "/dev/fd/2",
})
```
Audit cite: `audits/hermes.md:30`.

**Verdict.** **real — high confidence.**

**Reasoning.** Both reference impls have the identical list, almost
character-for-character matching the goal's proposed list. Trivial XS
implementation as a guard at the top of the read extension.

**Minimal proof of gap.** Excerpts above.

**Scope-down notes.** As written. Recommend matching Hermes/CC and
also blocking `/proc/<pid>/fd/{0,1,2}` (regex match). Currently only
`/dev/fd/{0,1,2}` is in the goal's list.

---

## Goal 3.7: Secret redaction in tool output

**Doc claim.** AWS keys, GitHub tokens, OpenAI/Anthropic keys, JWTs, PEM
blocks, Slack webhooks can flow into context via `read`/`grep`/`find`/`bash`
output; need a redactor.

**Bobbit reality.** No redaction. Audit `audits/bobbit.md:232–234`:
"No automatic redaction. Searched `grep -rn "secret|redact" src/server/` —
only `cli.ts:235` ('keep it secret' CLI message) and the `--new-token`
regen path. No redaction in tool-result paths, no log scrubbing, no
.env-aware filtering." Confirmed via direct re-search:
```
$ grep -rn 'redact\|AKIA\|sk-ant\|ghp_\|BEGIN.*PRIVATE KEY' \
    /Users/aj/Documents/dev/bobbit/src/server \
    /Users/aj/Documents/dev/bobbit/.bobbit/config
# (no security-related matches; only "deduplicate" tokens unrelated to redaction)
```

**Claude Code reality.** Allow-list/permission-style guarding rather than
content redaction. `bashPermissions.ts:402–496` lists protected env names
(`ANTHROPIC_API_KEY`, `GROWTHBOOK_API_KEY`, …) excluded from echo/printenv
allowlists. Plus `checkTeamMemSecrets` on writes (audit `claude-code.md:58`).
Audit `claude-code.md:274–278`: "**No content-level sanitisation** on file
reads or web fetches" — so CC does *not* implement output redaction in the
sense the doc proposes. **Hermes is the sole reference for this goal.**

**Hermes reality.** Comprehensive output redactor at `agent/redact.py`
covering AWS/GH/OpenAI/Anthropic/PEM/JWT/Slack and more (~30 vendor
prefixes, ENV `KEY=VALUE`, JSON `apiKey`, `Authorization: Bearer`,
DB conn-string passwords, URL `?access_token=`, `user:pass@host` userinfo,
form-urlencoded, Telegram/Discord, E.164). Applied at: every `read_file`
result (`file_tools.py:441–443`), every `terminal` output
(`terminal_tool.py:2049`), every `search_files` match
(`file_tools.py:911–916`), every compactor input
(`context_compressor.py:706–735`). `RedactingFormatter` for log records.
Off by default; enable via `security.redact_secrets: true` or
`HERMES_REDACT_SECRETS=1`. Snapshot at import time so an in-session agent
can't toggle (`agent/redact.py:62`). Audit cites:
`audits/hermes.md:36, 266–271`.

**Verdict.** **real — high confidence.**

**Reasoning.** Bobbit has zero defence here. Hermes provides a complete,
production-grade reference. The doc's proposed approach (single redactor
applied to `read`/`grep`/`find`/`bash` outputs, opt-out per session) maps
1:1 onto Hermes's design. Goal as written is well-scoped.

**Minimal proof of gap.**

Bobbit (no redactor anywhere):
```
// .bobbit/config/tools/{filesystem,shell}/extension.ts
// no import or call referencing redact / secret / sanitize
```

Hermes (single point of application per tool):
```py
# tools/file_tools.py:441-443
content = redact_sensitive_text(content)  # gated by HERMES_REDACT_SECRETS
# tools/terminal_tool.py:2049 — same call on shell output
```

**Scope-down notes.** As written, but with two hardening notes from the
Hermes audit: (a) snapshot the enable-flag at import, not per-call, so a
compromised agent can't `export HERMES_REDACT_SECRETS=0` mid-session
(`audits/hermes.md:271`); (b) also redact in the *compactor* before
serialization, otherwise secrets survive across compactions. Bobbit's
compaction lives in the pi-coding-agent loop (`audits/bobbit.md:188–190`)
so the redactor must hook at both the tool boundary *and* before any
post-compaction summary build.
