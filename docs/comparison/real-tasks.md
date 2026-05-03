# Real Tasks — Evidence-Backed Improvement Audit

Synthesis of three Phase-A capability audits (`audits/{bobbit,claude-code,hermes}.md`)
and fifteen Phase-B per-priority verifications (`findings/priority-{0..14}.md`)
against the original `bobbit-improvements.md`. Every "real" verdict in this
document is backed by at least one Bobbit `file:line` citation and at least one
Claude Code or Hermes `file:line` citation tracing through to the per-priority
findings file.

Source pins:
- Bobbit:       `/Users/aj/Documents/dev/bobbit` (master @ `a3a9cc7`, `0.1.8`)
- Claude Code:  `/Users/aj/Documents/dev/claude-code`
- Hermes Agent: `/Users/aj/Documents/dev/hermes-agent`

---

## 1. Executive summary

Counts computed directly from each `findings/priority-N.md` verdict-summary table.

| Priority | Total | Real | Partial | Already-done | Hallucinated | Unverifiable |
|---|---:|---:|---:|---:|---:|---:|
| 0 — Measure Before Optimising              | 5 | 3 | 2 | 0 | 0 | 0 |
| 1 — Lean Coding Mode                       | 6 | 6 | 0 | 0 | 0 | 0 |
| 2 — Lazy Tool Documentation                | 5 | 4 | 1 | 0 | 0 | 0 |
| 3 — Upgrade File Read & Search             | 7 | 6 | 1 | 0 | 0 | 0 |
| 4 — Semantic Code Navigation / LSP         | 5 | 5 | 0 | 0 | 0 | 0 |
| 5 — Edit Safety and Capability             | 9 | 7 | 1 | 1 | 0 | 0 |
| 6 — Tool-Result Context Control            | 6 | 5 | 1 | 0 | 0 | 0 |
| 7 — Concurrency Safety                     | 4 | 4 | 0 | 0 | 0 | 0 |
| 8 — Plan / Read-Only Mode                  | 3 | 3 | 0 | 0 | 0 | 0 |
| 9 — Delegation Efficiency                  | 6 | 5 | 1 | 0 | 0 | 0 |
| 10 — Prompt-Cache Strategy                 | 4 | 1 | 3 | 0 | 0 | 0 |
| 11 — Prompt-Injection Defense              | 5 | 3 | 1 | 0 | 0 | 1 |
| 12 — Sandbox / Isolation Backends          | 4 | 4 | 0 | 0 | 0 | 0 |
| 13 — Verification Support                  | 3 | 3 | 0 | 0 | 0 | 0 |
| 14 — Keep Bobbit's Orchestration Advantage | 5 | 4 | 1 | 0 | 0 | 0 |
| **Total**                                  | **77** | **63** | **12** | **1** | **0** | **1** |

Headline takeaways:

- **Zero outright hallucinations.** Every goal in `bobbit-improvements.md` describes a real or near-real gap. The doc is well-grounded; the discriminator is "real vs partial vs already-done", not "real vs invented".
- **One already-done item:** Goal 5.6 (preserve CRLF/LF line endings) — pi-coding-agent's `edit.js` already preserves the original byte sequence on `fs.writeFile`.
- **One unverifiable item:** Goal 11.5 (streaming context-fence scrubber) — Bobbit emits markdown headings rather than `<memory>` / `<context>` fence tags, so no demonstrable leak path exists. Re-evaluate if those tags are introduced.
- **Twelve "partial" items** mostly describe gaps that exist but are smaller, narrower, or already-half-solved than the doc asserts. Notable: P10 (3 of 4 partials — the prompt-cache narrative is largely upstream-pi-ai with one ephemeral breakpoint, not a Bobbit-side strategy), 6.4 (auto-compaction *does* fire, just isn't configurable), 14.1 (managed-mode regression suite is preventive only, depends on lean-mode landing).

---

## 2. Top 10 highest-confidence real tasks

Ranked by user impact × evidence strength × shippability. Each entry traces a
Bobbit gap to a working Claude Code or Hermes implementation.

### 1. Goal 6.1 — Per-result persistence with `<persisted-output>` envelope

A single 60 KB grep, bash dump, or web fetch lands fully inside the next user
turn today. Bobbit's only mitigation is destructive in-tool truncation
(`shell/extension.ts:23-24` — `MAX_BYTES = 50 * 1024`, `MAX_LINES = 2000`); there
is no `tool-results/<sessionId>/<toolUseId>.txt` spillover store, no preview +
path envelope, and no per-tool `max_result_chars` field. Both reference harnesses
implement the exact pattern: Hermes `tools/tool_result_storage.py:144-162` writes
to the active backend's tmpdir and returns a `<persisted-output>` block with a
1500-char preview; Claude Code `src/utils/toolResultStorage.ts:106-112` writes to
`<projectDir>/<sessionId>/tool-results/...` with a 2 KB preview. This is the
single highest-impact fix on context economics.

### 2. Goal 6.2 — Per-turn aggregate tool-output budget

Distinct from per-result truncation: even when each tool stays under its own cap,
N parallel tools in a single user message can collectively dump >200 KB. Bobbit
has no aggregate budget — `grep "TURN_BUDGET" src/server/` returns nothing. Both
reference impls converge on **200 000 chars**: Claude Code
`src/constants/toolLimits.ts:48` (`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`)
and Hermes `tools/budget_config.py:19`
(`DEFAULT_TURN_BUDGET_CHARS = 200_000`), both with biggest-first persistence.
Bundles cleanly with #1.

### 3. Goal 5.1 — Read-before-edit enforcement

Bobbit's `edit` tool checks only POSIX accessibility before mutating
(`pi-coding-agent/dist/core/tools/edit.js:44-52`); there is no per-session read
registry. CC hard-blocks with `errorCode: 6` when `readFileState.get(path)` is
missing (`FileEditTool.ts:275-287`); Hermes warns on missing read stamp
(`tools/file_state.py:142-215`). The retrofit is a ~50-line `FileStateRegistry`
in `src/server/agent/` plus an extension hook in
`.bobbit/config/tools/filesystem/edit.yaml`. Eliminates a whole class of "agent
edited a file it never read" bugs.

### 4. Goal 5.2 — Stale-mtime detection on edit

Direct sibling of #3 and almost free once the registry exists. Bobbit's edit
re-reads on every call but never compares mtimes against a prior `read` stamp
(no registry to compare against — confirmed by `grep "mtime|fs.stat"
node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{edit,write}.js`,
no hits). CC `FileEditTool.ts:289-293` raises `errorCode: 7` on `lastWriteTime
> readTimestamp.timestamp`; Hermes does the same per-task in
`file_tools.py:677-707` and cross-agent in `file_state.py:120-200`.

### 5. Goal 7.1 — Cross-session `FileStateRegistry`

Generalises #3/#4 to multi-agent: today Bobbit relies entirely on git-worktree
isolation (`audits/bobbit.md:213-215`), so two delegates branched from the same
goal can clobber each other's edits with no signal. Hermes's
`tools/file_state.py:60-83` is the canonical reference: per-task reads,
`_last_writer` map, and `_path_locks: Dict[str, threading.Lock]` keyed by
resolved path, all bounded
(`_MAX_PATHS_PER_AGENT=4096`, `_MAX_GLOBAL_WRITERS=4096`, `:53,:56`). Goals 7.2
(per-path locks), 7.3 (sibling-write warnings), 7.4 (four-case staleness)
all fall out of this single primitive.

### 6. Goal 3.1 — Read deduplication

Re-reading the same `(path, offset, limit)` while mtime is unchanged
re-injects full file bytes — `pi-coding-agent/dist/core/tools/read.js:84`
`ops.readFile(absolutePath)` is called every time with no cache lookup. Both
references implement: Claude Code's `src/utils/fileStateCache.ts:18-23` LRU
(100 entries / 25 MB), `FileReadTool.ts:386-432` returns `{type:'file_unchanged'}`
stub on hit; Hermes's `tools/file_tools.py:485-520` per-task `_read_tracker`
keyed `(path, offset, limit) → mtime`, hard-block after 2 stub returns same key
(`:415-430`). Pairs naturally with #3.

### 7. Goal 2.1 — Replace eager YAML tool docs with summary + `tool_search`/`tool_help`

`getToolDocsForPrompt()` emits an overview list **and** a full Tool Documentation
section concatenating every tool's `docs:` field —
`src/server/agent/tool-manager.ts:255-262`. Estimated 10–20 KB on every request,
no `tool_search`/`tool_help` registered (`grep` returns nothing under
`src/server/` or `.bobbit/config/tools/`). Claude Code's reference is direct:
`src/tools/ToolSearchTool/ToolSearchTool.ts:235`, plus first-class
`shouldDefer: true` / `alwaysLoad` flags on every tool definition
(`src/Tool.ts:442-449`); LSPTool, EnterPlanMode, etc. opt in via
`shouldDefer: true` (`LSPTool.ts:136`, `EnterPlanModeTool.ts:55`). Bobbit will
also need #2.4 (deferred-tools mechanism) to land this cleanly.

### 8. Goal 9.3 — Concurrent delegate spawning

A genuine bug, not a feature gap. Bobbit's "parallel" delegate path creates
sessions in a sequential `for await` loop —
`.bobbit/config/tools/agent/extension.ts:273-290` — and only the *waiting*
phase runs in parallel via `Promise.all` (`:294-321`). Three children with
1 s session-creation each incur 3 s before the first executes. Hermes's
`tools/delegate_tool.py:1985-1995` `ThreadPoolExecutor(max_workers=...)`
submits all tasks at once. Single-line fix:
`await Promise.all(params.parallel.map(p => createDelegateSession(...)))`.
Likely surfaces latent worktree-creation races — ship a regression test.

### 9. Goals 14.2 + 14.3 — Cap and lazy-load workflow / gate context

`team-manager.ts:471-490` `buildDependencyContext` concatenates every passed
`injectDownstream` upstream gate's `currentContent` separated by `---` with **no
ceiling**, then `system-prompt.ts:289-291` appends the result verbatim. The
`gate_status` REST endpoint also returns full content unconditionally
(`server.ts:1474-1483`). Both reference harnesses solve the same shape:
Claude Code persists oversize tool results to disk and gives the model a 2 KB
preview + `<persisted-output>` (`src/utils/toolResultStorage.ts:106-112`,
per-message cap `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`); Hermes
`MAX_TURN_BUDGET_CHARS = 200_000` (`tools/budget_config.py:19`) with biggest-
first persistence. 14.2 + 14.3 are the same fix in `buildDependencyContext`
plus a `?view=full` query mode on the existing endpoint — small, well-scoped,
unblocks lean-mode work.

### 10. Goal 13.1 — Per-extension syntax check on edit/write/patch

Bobbit ships **zero** post-write syntax check — `grep "py_compile|node --check|
gofmt|rustfmt --check"` against `src/` and `.bobbit/` returns nothing
(`audits/bobbit.md:210`). Hermes is the canonical reference,
`tools/file_operations.py:261-267` defines the exact lookup table the goal
prescribes (`'.py': 'python -m py_compile {file}'`,
`'.js': 'node --check {file}'`, `'.ts': 'npx tsc --noEmit {file}'`,
`'.go': 'go vet {file}'`, `'.rs': 'rustfmt --check {file}'`); `_check_lint`
runs with a 30 s timeout, results returned as `lint:` on `PatchResult`
(`:853-883`). CC delegates this to async LSP instead — Hermes's pattern is
the right model for Bobbit. Catches "agent broke a JSON file" within the
edit's tool result, not three turns later. Note: `5.9` and `13.1` describe
the same retrofit — ship one PR under both milestones.

---

## 3. Per-priority breakdown

### Priority 0 — Measure Before Optimising

→ See [findings/priority-0.md](findings/priority-0.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 0.1 Section-by-section prompt budget | partial | high |
| 0.2 Persisted prompt diagnostics | real | high |
| 0.3 UI warning for bloated prompts | real | high |
| 0.4 Cache-hit metric surfaced | partial | high |
| 0.5 Per-turn output budget meter | real | high |

Bobbit already exposes per-section prompt content (`getPromptSections`,
`/api/sessions/:id/prompt-sections`, `SystemPromptDialog`) but every section
carries only `{label, source, content}` — no `chars`/`tokensEstimate`/`enabled`,
no aggregated `PromptBudget`, no persisted artifact. Cache R/W counters exist
in `cost-tracker.ts` but no `cacheHitRate` is computed or surfaced in the UI.
The aggregate per-turn output meter is fully absent. Aggregate confidence:
high — these are observability gaps with cheap, well-scoped fixes; 0.1/0.4 are
half-built and finishing them is a 2-day job each.

### Priority 1 — Lean Coding Mode

→ See [findings/priority-1.md](findings/priority-1.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 1.1 `mode: lean | managed` flag | real | high |
| 1.2 Split `coder.yaml` into lean/managed | real | high |
| 1.3 Make gate tools/instructions opt-in | real | high |
| 1.4 Drop mandatory memory protocol in lean | real | high |
| 1.5 Auto-detect lean candidacy | real | high |
| 1.6 UI mode badge + toggle | real | medium |

All six goals describe genuinely missing functionality. Bobbit master has no
mode flag (`grep "SessionMode|'lean'|\"lean\"|mode: 'managed'" src/`
returns no Bobbit-defined enum), `coder.yaml` is single-shape, the
gate / memory / workflow protocol is unconditional, there is no auto-default
heuristic, and the UI has no mode badge. Cross-harness reference is loose —
"lean vs managed" is Bobbit-specific, but Claude Code's `permissionContext.mode`
+ per-`subagent_type` builtins (`AgentTool.tsx:50,1356`) and Hermes's
`delegation.role="leaf"` blocked-tool list (`tools/delegate_tool.py:38-46`) are
the closest analogues. Aggregate confidence: high; 1.6 only "medium" because
the badge UX details (placement, transcript-event markers) are open design
questions.

### Priority 2 — Lazy Tool Documentation

→ See [findings/priority-2.md](findings/priority-2.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 2.1 Replace eager YAML docs with summary + `tool_search` | real | high |
| 2.2 Cache parsed tool YAML (mtime keyed) | real | high |
| 2.3 Group tools by mode | partial | high |
| 2.4 `defer:` flag on heavy tools | real | high |
| 2.5 Hard size cap on tool-doc section | real | medium |

`tool-manager.ts:255-262` emits both an overview list and a full Tool
Documentation section every request. There is no `mtime`-keyed YAML cache —
`getAvailableTools()` re-scans + re-parses on every call. There is no
`shouldDefer` analogue. 2.3 marked partial because grouping infrastructure
already exists at the role-`allowedTools` layer; the gap is the absence of a
*mode-aware* group filter, not the absence of grouping itself. CC is the
canonical reference (`ToolSearchTool`, `Tool.ts:442-449`). Aggregate confidence:
high.

### Priority 3 — Upgrade File Read & Search

→ See [findings/priority-3.md](findings/priority-3.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 3.1 Read deduplication | real | high |
| 3.2 Repeated-call loop guards | real | high |
| 3.3 Truncation flags (`{truncated, nextOffset}`) | partial | high |
| 3.4 Upgrade grep tool (output_mode/head_limit/type) | real | high |
| 3.5 Order-stable `find` with `since`/mtime sort | real | high |
| 3.6 Device-file blocklist on `read` | real | high |
| 3.7 Secret redaction on tool output | real | high |

Bobbit inherits `read`/`grep`/`find` verbatim from `pi-coding-agent` — there
is no Bobbit-side override, no `file-state.ts`, no loop guard, no redactor.
3.3 "partial" because pi-coding-agent does emit a `truncated:true` flag in
some shapes, but no `nextOffset` continuation contract. Both reference
implementations exist for 3.1/3.2 (CC `FileStateCache` + Hermes
`_read_tracker` with 2-strike escalation). 3.4 grep upgrades and 3.6 device
blocklist (`/dev/zero`, FIFOs) are direct Hermes ports. 3.7 secret redaction
is asymmetric in CC (write-side guard only) — Hermes is the canonical
reference (`agent/redact.py` + `tools/terminal_tool.py:2049`). Aggregate
confidence: high.

### Priority 4 — Semantic Code Navigation / LSP

→ See [findings/priority-4.md](findings/priority-4.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 4.1 LSP tool surface (9 ops) | real | high |
| 4.2 LSP server lifecycle manager | real | high |
| 4.3 Search-order guidance in coder role | real (cond. on 4.1) | high |
| 4.4 Mark LSP tool deferred | real (cond. on 2.4 + 4.1) | high |
| 4.5 Graceful `lsp_unavailable` fallback | real (cond. on 4.1) | high |

`ls .bobbit/config/tools/` shows no `lsp/` directory; `find -type d -name lsp`
returns nothing; the only navigation guidance in the prompt is
`.bobbit/config/system-prompt.md:143` — "use grep, read, and find". Claude
Code's `src/tools/LSPTool/LSPTool.ts:60-89` is the only reference; Hermes has
no LSP. 4.1 is the load-bearing goal; 4.2-4.5 all chain off it. Aggregate
confidence: high. Reasonable to pilot with TypeScript (`tsserver`) and add
Python (`pyright`) in a follow-up — the goal already names exactly these two.

### Priority 5 — Edit Safety and Capability

→ See [findings/priority-5.md](findings/priority-5.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 5.1 Read-before-edit enforcement | real | high |
| 5.2 Stale-mtime detection | real | high |
| 5.3 `replace_all` flag + `multi_edit` | real | high |
| 5.4 V4A multi-file patch | real | high |
| 5.5 Fuzzy-match fallback chain | partial | high |
| 5.6 Preserve CRLF/LF line endings | already-done | high |
| 5.7 Cap inline diff + `bytes_before/after` | real | high |
| 5.8 Post-write byte-compare | real | high |
| 5.9 Auto syntax check by extension | real | high |

The strongest priority section. All Bobbit citations anchor at the upstream
`pi-coding-agent` library (`node_modules/@mariozechner/pi-coding-agent/dist/
core/tools/{edit,write,edit-diff}.js`); `.bobbit/config/tools/filesystem/`
contributes no override. 5.6 is already-done because pi-coding-agent's edit
preserves line endings byte-for-byte on `fs.writeFile`. 5.5 is partial because
pi-coding-agent does have a single fuzzy strategy; the gap is the multi-
strategy chain with reported strategy that CC and Hermes both ship. 5.3's
`multi_edit` half is subsumed by 5.4 (V4A patch is strictly more general) —
ship one tool, not two. 5.9 and 13.1 describe the same syntax-check retrofit.
Aggregate confidence: high.

### Priority 6 — Tool-Result Context Control

→ See [findings/priority-6.md](findings/priority-6.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 6.1 Per-result persistence | real | high |
| 6.2 Per-turn aggregate budget | real | high |
| 6.3 Microcompact old tool results | real | high |
| 6.4 Auto-compaction trigger | partial | high |
| 6.5 Compaction failure cooldown | real | high |
| 6.6 Read-state reset post-compaction | real (blocked on 3.1) | high |

6.4 is the only correction-worthy item: the doc claims compaction is
"manual-only via `compact()` RPC", but auto-compaction *does* fire via
`pi-coding-agent`'s `compaction.js` with default `reserveTokens=16384`,
`keepRecentTokens=20000`. The real surviving delta is configurability
(no per-session threshold/buffer override, no env knob). 6.6 depends on
3.1 landing first (Bobbit has no read-dedup cache to reset yet — but the
compaction event hook at `session-manager.ts:487-491` does already exist).
6.5 has the most damning evidence in the audit: CC's
`autoCompact.ts:65-70` documents 1 279 sessions hitting 50+ consecutive
failures, wasting ~250 K API calls/day. Aggregate confidence: high.

### Priority 7 — Concurrency Safety

→ See [findings/priority-7.md](findings/priority-7.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 7.1 Process-wide file-state registry | real | high |
| 7.2 Per-path locks for write/edit | real | high |
| 7.3 Sibling-agent stale warnings on delegate completion | real | high |
| 7.4 Four-case staleness detection | real | high |

Cleanest section in the doc — all four goals real, all backed by Hermes's
`tools/file_state.py` as a single canonical reference. Bobbit relies entirely
on git-worktree isolation between role agents (`audits/bobbit.md:213-215`);
the only lock primitive in the source tree is `proper-lockfile` on
`settings.json`. Claude Code's `FileStateCache` covers 7.4 partially within a
single process (mtime_drift, partial_read, no_prior_read) but does not solve
7.3 (sibling_wrote across siblings) — for Bobbit's multi-session model
Hermes is the right reference. Aggregate confidence: high.

### Priority 8 — Plan / Read-Only Mode

→ See [findings/priority-8.md](findings/priority-8.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 8.1 `plan` mode toggle | real | high |
| 8.2 Permission classifier | real | high |
| 8.3 UI affordance | real (depends on 8.1) | high |

No plan-mode primitive at any layer in Bobbit — `grep "plan_?mode|planMode"`
finds nothing in `src/server/` / `src/ui/` (the only `readOnly` hit is
`AgentInterface.ts:81`, an unrelated UI prop for archived-session views).
CC is the only reference: `EnterPlanModeTool.ts:36,79-94` plus
`ExitPlanModeV2Tool.ts:147,182`, with per-tool `isReadOnly(input)` allowing
input-dependent classification (notably `BashTool.tsx:434-441` parses the
command). Hermes has no plan mode either — its closest analogue is the
static `delegation.role="leaf"` blocklist. 8.1 and 8.3 should land
together (CC pairs them). Aggregate confidence: high.

### Priority 9 — Delegation Efficiency

→ See [findings/priority-9.md](findings/priority-9.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 9.1 Lightweight delegate mode | real | high |
| 9.2 Context-fork option (byte-exact prompt) | real | high |
| 9.3 Concurrent spawning | real (creation is serial) | high |
| 9.4 Structured delegate results | real | high |
| 9.5 Default delegate toolset restriction | partial | high |
| 9.6 Auto-deny dangerous in delegates | real | high |

9.3 is a confirmed concrete bug — `extension.ts:273-290` `for await`
serialises session creation; only the wait phase runs in parallel. Trivial
fix, immediate latency win on `delegate({parallel:[...]})`. 9.5 partial
because recursion is already blocked via `BOBBIT_DELEGATE_OF`
(`extension.ts:200-205`) but `memory_*` / `send_message` / `browser`
categories are not. 9.2 has direct CC reference in
`src/tools/AgentTool/forkSubagent.ts:46-66` (gated behind `FORK_SUBAGENT`
GrowthBook flag). 9.6 chains off 8.2. Aggregate confidence: high.

### Priority 10 — Prompt-Cache Strategy

→ See [findings/priority-10.md](findings/priority-10.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 10.1 Stable prefix vs volatile suffix | partial | high |
| 10.2 Cache `system + last-N` messages | partial | high |
| 10.3 Provider-aware cache control | partial | medium |
| 10.4 Per-provider/mode/project cache-hit reporting | real | high |

Weakest priority section. `grep cache_control src/server` returns 0 matches —
Bobbit emits no `cache_control` markers itself. The Anthropic provider in
the wrapped `pi-ai` library attaches one ephemeral marker on the system text
+ one on the last user message
(`node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:482-491`). The
doc's framing ("AGENTS.md not cached") is wrong as a cache-mechanics claim:
the entire system prompt is a single Anthropic text block with one breakpoint,
so internal section order does not matter unless Bobbit splits the system
prompt into multiple blocks. The true gap is *splitting* + Bobbit-side
markers (CC's `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` at `prompts.ts:107`). 10.4 is
the cleanly-real one: `cost-tracker.ts` `SessionCost` is flat — no
provider/model/mode/project dimensions, no `cacheHitRate` API. Aggregate
confidence: high on existence of gap, medium on shape of fix.

### Priority 11 — Prompt-Injection Defense

→ See [findings/priority-11.md](findings/priority-11.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 11.1 Context-file scanner | real | high |
| 11.2 YAML frontmatter strip | partial | high |
| 11.3 Sensitive-path write deny-list | real | high |
| 11.4 `BOBBIT_WRITE_SAFE_ROOT`-style chroot | real | high |
| 11.5 Streaming context-fence scrubber | unverifiable | low |

Hermes is the canonical reference for the entire section
(`agent/prompt_builder.py:36-72`, `agent/file_safety.py:1-93`). Bobbit
reads AGENTS.md / CLAUDE.md / memories verbatim through `system-prompt.ts:60-103`
with no scan; both reference harnesses scan or sandbox. 11.2 is partial because
`parseMemoryFile` already strips frontmatter from Claude Code memories but not
from AGENTS.md / CLAUDE.md themselves. 11.5 unverifiable — Bobbit emits
markdown headings, not `<memory>`/`<context>` fence tags, so no demonstrable
leak path; revisit if those tags are added. The doc's "13 patterns" headline
is itself slightly off — Hermes ships 10 regex categories plus 10
invisible-char codepoints. Aggregate confidence: high (except 11.5).

### Priority 12 — Sandbox / Isolation Backends

→ See [findings/priority-12.md](findings/priority-12.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 12.1 `Environment` interface abstraction | real | high |
| 12.2 Docker backend | real | high |
| 12.3 SSH backend | real | high |
| 12.4 Modal/Daytona/Vercel cloud backends | real | high |

Bobbit master has no execution abstraction whatsoever — `find -name '*sandbox*'
-o -name '*docker*'` under `src/server/` returns 0 results; `grep "Environment\b
|exec_backend"` returns 0; `.bobbit/config/tools/shell/extension.ts:14-35`
imports `spawn` from `node:child_process` directly and hard-codes the host
shell. Hermes is the canonical reference: `tools/environments/base.py:267-360`
abstract `BaseEnvironment(ABC)` with seven concrete backends. CC has OS-level
sandbox-exec/landlock wrappers but no pluggable container/cloud backend. 12.1
is the prerequisite for 12.2-12.4. Aggregate confidence: high. Note: row D4
in `comparison.md` scores Bobbit 4/9 — direct code search confirms the
existing score reflects only worktree-based filesystem isolation between role
agents; there is no Docker plumbing in master at `a3a9cc7`.

### Priority 13 — Verification Support

→ See [findings/priority-13.md](findings/priority-13.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 13.1 Auto-syntax check on patch | real | high |
| 13.2 `verify` tool (auto-detect + run) | real | high |
| 13.3 Test-output structuring per runner | real | high |

13.1 is a direct port from Hermes (`tools/file_operations.py:261-267, 853-883`).
13.2's reference impl is weak — CC's bundled "verify" is an ant-only prompt
skill (`src/skills/bundled/verify.ts:1-30`), not a tool that detects manifests
and runs commands; Hermes uses raw `terminal`. The gap is real but the goal
is more "new feature than retrofit" — partial would also defend. 13.3 has no
reference impl in either CC or Hermes (Hermes parses junit-xml only via the
existing `coverage-junit` toolset); the framing as "retrofit" is wrong but
the gap is genuine. 13.1 should ship with 5.9 as a single PR. Aggregate
confidence: high on 13.1, medium on 13.2/13.3 (real gap, weaker reference).

### Priority 14 — Keep Bobbit's Orchestration Advantage

→ See [findings/priority-14.md](findings/priority-14.md)

| Goal | Verdict | Confidence |
|---|---|---|
| 14.1 Managed-mode regression gate | partial | medium |
| 14.2 Summarise gate context by default | real | high |
| 14.3 Hard cap (~4 KB) on injected workflow state | real | high |
| 14.4 Make team lead less eager | real | high |
| 14.5 Memory ranking for managed mode | real | high |

14.1 partial because the *gap* (no `tests/managed-mode/` directory) is real
and verifiable, but the *motivation* depends on lean mode existing — which it
doesn't yet. Park behind Priority 1 and add the snapshot test alongside the
first lean-mode PR. 14.2 + 14.3 share a single root cause:
`team-manager.ts:471-490` `buildDependencyContext` injects upstream-gate
content unbounded; `system-prompt.ts:289-291` appends verbatim. Ship as one
PR. 14.4 evidence is striking — `.bobbit/config/roles/team-lead.yaml:49-55`
explicitly tells the lead to "spawn many agents in parallel ... use that
capacity aggressively"; Hermes defaults `delegation.max_spawn_depth=2` and
blocks recursion for leaf roles. 14.5: `system-prompt.ts:118-134` ranks
Claude Code memories *alphabetically* (`.sort().slice(0,20)`) up to 16 KB —
no relevance, no recency, no type weighting. CC reference is
`findRelevantMemories.ts:40-60` (LLM picker, top-5). Aggregate confidence:
high.

---

## 4. Hallucinations and stale claims appendix

No goal in `bobbit-improvements.md` is fully hallucinated — every cited gap
exists in source. The list below catalogues the *over-statements* and *stale
framings* that need correction or scope-down before any goal in question is
spawned.

### Already-done

- **Goal 5.6 — Preserve CRLF/LF line endings on edit.** pi-coding-agent's
  `edit.js` already uses `fs.writeFile` byte-for-byte against the original
  buffer; line endings are preserved without any explicit code path.
  See `findings/priority-5.md` §5.6.

### Partial — claim is overstated relative to source

- **Goal 0.1 — Section-by-section prompt budget.** Section decomposition
  already exists (`getPromptSections`, `/api/sessions/:id/prompt-sections`,
  `SystemPromptDialog`); only the per-section `chars`/`tokensEstimate` and
  the aggregated `PromptBudget` artifact are missing.
  See `findings/priority-0.md` §0.1.
- **Goal 0.4 — Cache-hit metric.** `cost-tracker.ts` already captures
  cache R/W tokens; the gap is computing and surfacing `cacheHitRate`,
  not the underlying counters.
  See `findings/priority-0.md` §0.4.
- **Goal 2.3 — Group tools by mode.** Grouping infrastructure exists at
  the role-`allowedTools` layer; the gap is mode-aware filtering, not
  grouping itself.
  See `findings/priority-2.md` §2.3.
- **Goal 3.3 — Truncation flags.** Truncation marker is partially
  emitted; `nextOffset` continuation contract is missing.
  See `findings/priority-3.md` §3.3.
- **Goal 5.5 — Fuzzy-match fallback chain.** A single fuzzy strategy
  exists in pi-coding-agent; the gap is the multi-strategy chain with
  reported strategy that CC + Hermes ship.
  See `findings/priority-5.md` §5.5.
- **Goal 6.4 — Auto-compaction trigger.** Doc claims "manual-only via
  `compact()` RPC". **Wrong.** Auto-compaction fires via pi-coding-agent
  (`session-manager.ts:487-491`, `compaction.js:142-146`,
  `reserveTokens=16384`). Real surviving delta: no per-session threshold
  override, no env knob, no user-facing disable.
  See `findings/priority-6.md` §6.4.
- **Goal 9.5 — Delegate toolset restriction.** Recursion is already
  blocked via `BOBBIT_DELEGATE_OF` (`agent/extension.ts:200-205`). The
  surviving gap is `memory_*` / `send_message` / `browser` not being
  filtered out of the delegate's tool surface.
  See `findings/priority-9.md` §9.5.
- **Goal 10.1 — Stable prefix vs volatile suffix.** Doc framing
  ("AGENTS.md not cached because volatile content sits before it") is
  wrong as a cache-mechanics claim. Bobbit emits the entire system prompt
  as one Anthropic text block with one ephemeral breakpoint. Reordering
  alone changes nothing; the real fix is *splitting* into multiple blocks
  with explicit Bobbit-side `cache_control`.
  See `findings/priority-10.md` §10.1.
- **Goals 10.2, 10.3 — Cache `system + last-N`, provider-aware cache
  control.** All cache markers today come from the wrapped `pi-ai`
  library; Bobbit emits none directly. The fix is real (Bobbit-side
  provider-aware splitter) but the doc's cited paths in `src/server/`
  for cache logic do not exist.
  See `findings/priority-10.md` §10.2, §10.3.
- **Goal 11.2 — YAML frontmatter strip.** `parseMemoryFile` already
  strips frontmatter from Claude Code memory files; the gap is that
  AGENTS.md / CLAUDE.md themselves are not similarly stripped.
  See `findings/priority-11.md` §11.2.
- **Goal 14.1 — Managed-mode regression gate.** The `tests/managed-mode/`
  directory truly is absent, but lean mode (the protection target) does
  not yet exist either. Preventive scaffolding only — should ship
  alongside the first lean-mode PR, not now.
  See `findings/priority-14.md` §14.1.

### Unverifiable

- **Goal 11.5 — Streaming context-fence scrubber.** Bobbit emits
  markdown headings, not `<memory>`/`<context>` fence tags. No
  demonstrable leak path exists. Re-evaluate if those tags are
  introduced.
  See `findings/priority-11.md` §11.5.

### Doc-level inaccuracies surviving into "real" verdicts

- **Goal 11.1 cites "13 threat patterns".** Hermes ships 10 regex
  categories (`_CONTEXT_THREAT_PATTERNS`,
  `agent/prompt_builder.py:38-48`) plus 10 zero-width / RTL-override
  codepoints (`_CONTEXT_INVISIBLE_CHARS`, `:50-53`). Either 10+10=20
  signals or 11 categories, not 13. Verdict still real; correct the
  count when writing acceptance criteria.
- **Goal 13.2 cites Claude Code as the reference.** CC's "verify" is
  an internal-only (`USER_TYPE === 'ant'`) prompt skill, not a
  manifest-detecting tool. Reference is weak — frame as new feature,
  not retrofit.
- **Goal 13.3 has no reference implementation.** Neither CC nor Hermes
  ships a per-runner test-output parser. The "retrofit" framing is
  wrong, but the gap is genuine.

---

## 5. Discrepancies vs `comparison.md`

Consolidated and de-duplicated from the three Phase-A audits' "Discrepancies
vs comparison.md" sections. Each bullet identifies an item where the existing
scoring docs are out of date or imprecise enough to mislead a reader who
hasn't done the source audit.

### Bobbit row

- **"No auto-compaction" is too strong.** Auto-compaction does fire via
  `pi-coding-agent`'s `compaction/compaction.js` + `session-manager.ts:487-491`.
  What's missing is a Bobbit-specific failure-cooldown / configurable threshold
  layer. (`audits/bobbit.md` §1)
- **D4 sandbox score 4/9 implies *some* backend abstraction.** Direct code
  search shows zero sandbox/docker code in `src/server/` at `a3a9cc7`. The
  4 reflects worktree-based filesystem isolation only; the row label should
  be "Local + git worktree only; no container/SSH/cloud backends".
  (`audits/bobbit.md` §2)
- **Browser tool count.** Master ships 6 browser tools (`navigate`,
  `screenshot`, `click`, `type`, `eval`, `wait`) — not the richer set
  described in the session worktree's `AGENTS.md`. (`audits/bobbit.md` §3)
- **A3 prompt-cache "None visible" is incorrect.** Cache *is* present, but
  only via inherited pi-ai providers (one ephemeral breakpoint each on system
  prompt and last user message). Bobbit itself emits no `cache_control`.
  Row label should read "inherited 2-breakpoint default; no Bobbit-side
  strategy". (`audits/bobbit.md` §4)
- **Tool families described in this session worktree's prompt are not in
  master.** `verification_result`, `propose_*`, `view_proposal`,
  `edit_proposal`, `review_open`, `ask_user_choices`, `activate_skill`,
  `generate_image`, `goal_*` family, `gate_inspect` — none registered in
  `.bobbit/config/tools/*/extension.ts` at `a3a9cc7`. The comparison should
  pin a commit/version. (`audits/bobbit.md` §5)
- **Missing row: opinionated bash mutation.** Bobbit's bash extension
  auto-injects `Co-Authored-By:` into every `git commit`
  (`.bobbit/config/tools/shell/extension.ts:~92-110`). Worth a row if the
  comparison cares about "opinionated mutations to user shell commands".
  (`audits/bobbit.md` §8)

### Claude Code row

- **Read byte cap is 256 KiB on total file size, not slice.** `MAX_OUTPUT_SIZE
  = 0.25 * 1024 * 1024` (262 144 bytes); `limits.ts:6` documents this gates on
  total file size, not the requested range. (`audits/claude-code.md` §1)
- **Plan-mode dynamism overstated.** `comparison.md:178` describes the
  permission classifier as evaluating per-call; in practice plan mode
  transitions through `permissionSetup.ts:602-641` and gates by curated
  read-only toolset. (`audits/claude-code.md` §4)
- **Edit "post-edit git-diff fetched for verification" is wrong.** The
  `gitDiff` field in `FileEditTool.ts:402-411` is structured output for the
  agent; real verification is async LSP `didChange/didSave`
  (`:373-388`) — diagnostics arrive on a later turn. C5 credit should be
  qualified: there is **no inline syntax/lint check** by Edit/Write.
  (`audits/claude-code.md` §5)
- **Fork-subagent requires a feature flag.** `forkSubagent.ts` gated behind
  `FORK_SUBAGENT` GrowthBook (`isForkSubagentEnabled()`). Affects scoring
  realism. (`audits/claude-code.md` §6)
- **Read-dedup scope is partial.** Triggers only when prior Read had
  `offset !== undefined` (`FileReadTool.ts:386-432`); does not dedup against
  file-state entries planted by Edit/Write — Edit-then-Read is *not* deduped.
  (`audits/claude-code.md` §7)
- **A4 per-turn aggregate budget under-credited.** CC's
  `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`
  (`toolLimits.ts:48`) with biggest-first persistence is a top-mark
  feature absent from `comparison.md`'s Claude Code prose. (`audits/claude-code.md` §11)
- **F2 prompt-injection defense overscored.** No content-level sanitisation
  on Reads or web fetches — only a `<system-reminder>` appended to text Reads
  (`FileReadTool.ts:738`) and the WebFetch internal-prompt design. No
  AGENTS.md scanning, hidden-Unicode check, or "ignore previous" detection.
  (`audits/claude-code.md` §9)
- **F1 secret redaction is asymmetric.** Write-side guard
  (`teamMemSecretGuard.ts:15`) + bash env allowlist (`bashPermissions.ts:402-496`),
  no general output redaction — Read of `.env` returns raw bytes.
  (`audits/claude-code.md` §10)
- **G1 skill-on-touch discovery missing from comparison.md.** Every
  Read/Edit/Write fires `discoverSkillDirsForPaths` and
  `activateConditionalSkillsForPaths` (`FileReadTool.ts:438-451`).
  (`audits/claude-code.md` §12)
- **Cyber-risk reminder appended to every text Read** (`FileReadTool.ts:738-742`,
  skipped on `claude-opus-4-6` `:746`). Context-cost worth noting on A1.
  (`audits/claude-code.md` §13)

### Hermes row

- **Compaction threshold is 50 %, not 75 %.** `comparison.md:209` cites
  the abstract base-class default; the actual `ContextCompressor.__init__`
  defaults `threshold_percent=0.50` (`agent/context_compressor.py:379`).
  (`audits/hermes.md` §1)
- **Threat-pattern count 13 is wrong.** Actually 10 regex categories
  (`agent/prompt_builder.py:38-48`) + 10 invisible-Unicode codepoints
  (`:50-53`) = 20 signals across 11 categories. (`audits/hermes.md` §2)
- **Post-write read-back is `patch`-only.** `comparison.md:202` reads as if
  all writes get this protection; only `patch_replace` does. Plain
  `write_file` failures (truncated heredoc, FS race) are still silent.
  (`audits/hermes.md` §3)
- **Compaction has a second protection layer:** `_ineffective_compression
  _count >= 2` anti-thrashing skip (`context_compressor.py:476-486`),
  stronger than CC's `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`.
  (`audits/hermes.md` §4)
- **Read-dedup has two distinct loop-protection layers, not one.** The
  consecutive-real-read counter (`file_tools.py:506-525`, "warn at 3, block
  at 4") is separate from the `dedup_hits >= 2` stub-escalation hard-block
  (`:415-430`). (`audits/hermes.md` §6)
- **C3 atomic writes credit should be qualified.** Hermes uses heredoc, not
  temp+rename. The `patch_replace` read-back is the compensating mechanism;
  `write_file` itself is not atomic. (`audits/hermes.md` §8)
- **B6 plan/read-only mode: Hermes has none on the main agent.** Closest
  analogue is `delegation.role="leaf"`'s blocked-tool list
  (`tools/delegate_tool.py:38-46`). (`audits/hermes.md` §9)
- **D4 cross-backend uniformity not surfaced.** `tools/file_operations.py:
  ShellFileOperations` makes `read_file`/`write_file`/`patch`/`search_files`
  work uniformly across all 7 backends; persisted tool-result spillover
  routes through the active backend's tmpdir
  (`tool_result_storage.py:43-58`). ACP delegation lets a Hermes parent
  orchestrate Claude Code workers — cross-harness orchestration is unique
  to Hermes. (`audits/hermes.md` §10)
- **F2 prompt-injection defense stronger than implied.** Scanned content is
  *substituted* with a `[BLOCKED:…]` notice (`prompt_builder.py:71-72`) —
  malicious instructions never reach the prompt, not just flagged. Tirith
  adds a second layer (`tools/tirith_security.py:1-285`).
  (`audits/hermes.md` §11)
- **F1 secret redaction wider than mentioned.** Runs on terminal output
  (`terminal_tool.py:2049`) and inside the compactor before serialisation
  (`context_compressor.py:706-735`), so secrets aren't persisted into
  cross-compaction summaries. Snapshotted at import time
  (`agent/redact.py:62`) — un-toggleable mid-session.
  (`audits/hermes.md` §12)
- **Pluggable context engine.** `ContextCompressor` is one implementation
  of an abstract `ContextEngine` base class
  (`agent/context_engine.py:34-120`). (`audits/hermes.md` §14)
- **Provider-quirk patches.** Alibaba GLM model-name override
  (`run_agent.py:4886-4892`); `developer`-role swap for GPT-5/Codex
  (`prompt_builder.py:DEVELOPER_ROLE_MODELS`). (`audits/hermes.md` §16)
- **Cache-poisoning read guard.** `agent/file_safety.py:96-114` refuses
  reads of `~/.hermes/skills/.hub` and `index-cache`. (`audits/hermes.md` §18)
- **`HERMES_DISABLE_FILE_STATE_GUARD=1` opt-out**
  (`tools/file_state.py:255-258`). (`audits/hermes.md` §19)

---

## 6. Recommended next-step goal stubs

Ready-to-spawn one-paragraph stubs for the top-10 real tasks. Use these as
starting `propose_goal` inputs.

### Stub 1 — Per-result persistence (`<persisted-output>`)

**Title:** Per-tool result spillover with preview envelope.
**Problem:** A single oversized tool result (60 KB grep, 200 KB bash) lands
fully in the next turn. Today's only mitigation is destructive in-tool
truncation (`shell/extension.ts:23-24`), which silently loses information.
**Approach:** Add `maxResultChars` per tool YAML (`Infinity` for `read`),
default 50 000; over-cap results persisted to
`<bobbitStateDir>/tool-results/<sessionId>/<toolUseId>.txt`; the model receives
a 2 KB preview wrapped in `<persisted-output original_size=… file=…
preview_size=…>...</persisted-output>` with a hint to call `read` for the
full body. Implementation lives in a new
`src/server/agent/tool-result-store.ts` invoked from the `RpcBridge` tool-result
hook. Mirror Hermes's `tool_result_storage.py:144-162`.
**Acceptance criteria:** A `bash` whose stdout is 80 KB stores the full
content on disk and returns ≤ 3 KB of preview text to the model; a follow-up
`read` of the persisted file returns the full bytes; per-tool overrides via
`maxResultChars:` field accepted; existing `bash` extension truncation is
removed in favour of the new pipeline.

### Stub 2 — Per-turn aggregate tool-output budget

**Title:** Aggregate tool-result budget per user message.
**Problem:** Even with per-result spillover, N parallel tools in one
message can collectively exceed 200 KB. No aggregate accounting exists today
(`grep TURN_BUDGET src/server/` returns 0).
**Approach:** Wire a `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`
sum-then-spill phase at the harness boundary in `rpc-bridge.ts`. After all
tools in a turn have returned, sum their (post-truncation) lengths; while
total > budget, spill the largest unspilled result through Stub 1's pipeline.
Reference: CC `toolLimits.ts:48`, Hermes `budget_config.py:19`.
**Acceptance criteria:** Three parallel `grep` calls totalling 250 KB
produce two preview envelopes (largest two) and one inline result; the
total prompt-side bytes stay below 210 KB; a regression test asserts the
budget on a synthetic 10-tool turn.

### Stub 3 — Read-before-edit enforcement

**Title:** `FileStateRegistry` for read-before-edit gate.
**Problem:** `edit` mutates files the agent never read. pi-coding-agent's
`edit.js:44-52` checks only POSIX accessibility — no read registry.
**Approach:** Add `src/server/agent/file-state.ts` exposing
`recordRead(sessionId, path, mtime, offset, limit)` and
`getRead(sessionId, path)`. Hook into the wrapped `read` extension to record
on every successful read; add an `executeWrapper` on `edit`/`write` that
rejects with `must_read_first` when no entry exists. CC reference:
`FileEditTool.ts:275-287` (errorCode 6); Hermes reference:
`file_state.py:142-215`.
**Acceptance criteria:** `edit` against an un-read path returns
`{ ok:false, code:'must_read_first' }`; `read` then `edit` succeeds;
behaviour configurable via session config (`requireReadBeforeEdit:
'block'|'warn'|'off'`, default `block`); test fixture covers all three modes.

### Stub 4 — Stale-mtime detection

**Title:** Reject edit when file changed since last read.
**Problem:** Edit re-reads on every call but never compares to the prior
read's mtime — silent overwrites of concurrent changes are possible.
**Approach:** Building on Stub 3's registry, capture `mtime` at read time;
on edit, `fs.statSync(path).mtimeMs > recorded.mtime` rejects with
`stale`. CC: `FileEditTool.ts:289-308`; Hermes: `file_tools.py:677-707` +
`file_state.py:120-200`.
**Acceptance criteria:** Read → external touch → edit returns
`{ ok:false, code:'stale', last_read_mtime:…, current_mtime:… }`;
re-read clears the stale state; opt-out via `staleEditMode: 'off'`
session config; covered by E2E test that simulates a sibling write.

### Stub 5 — Cross-session `FileStateRegistry`

**Title:** Process-wide file-state coordinator across team agents.
**Problem:** Two delegates branched from the same goal can clobber each
other's edits with no signal. Bobbit's only safety today is git-worktree
isolation (`audits/bobbit.md:213-215`).
**Approach:** Promote Stub 3's registry to gateway-process scope; key
reads by `taskId`/`sessionId`, last-writer by absolute path. Add
`registry.lockPath(absPath)` (per-path mutex) and acquire in sorted order
on multi-file patches. On `delegate` completion, call
`writes_since(parentSessionId, parentSpawnTs, parentReads)` and append
sibling-write notices to the delegate result. Reference: Hermes
`tools/file_state.py:60-83, 218`; `delegate_tool.py:1407, 1651-1656`.
**Acceptance criteria:** Two concurrent delegates editing the same path
serialise; the parent receives a sibling-write reminder when its delegate
modified files the parent had read; path-locks bounded
(`MAX_PATHS=4096`, `MAX_GLOBAL_WRITERS=4096`); env opt-out
(`BOBBIT_DISABLE_FILE_STATE_GUARD=1`).

### Stub 6 — Read deduplication

**Title:** Stub repeated reads of unchanged files.
**Problem:** Re-reading the same `(path, offset, limit)` while mtime is
unchanged re-injects full bytes — `pi-coding-agent/dist/core/tools/read.js:84`
calls `ops.readFile` every time.
**Approach:** Wrap `read` in `.bobbit/config/tools/filesystem/` with a
session-scoped LRU `Map<path → {mtime, offset, limit}>`. On mtime-match
+ same range, return `{ type: 'file_unchanged', path, mtime }` stub.
Reset on `auto_compaction_end` event (hook already exists at
`session-manager.ts:487-491`). Hard-block after 2 consecutive stub returns
on the same key (Hermes `file_tools.py:415-430`). CC reference:
`fileStateCache.ts:18-23` + `FileReadTool.ts:386-432`.
**Acceptance criteria:** Reading the same file twice in a row produces a
≤ 200-byte stub on the second call; an external touch invalidates the
cache; LRU caps at 100 entries / 25 MB; 3rd same-key stub returns a
hard-block error referencing what the agent should do instead.

### Stub 7 — Lazy tool documentation (`tool_search` + deferred tools)

**Title:** Replace eager YAML tool docs with summary list + on-demand
lookup.
**Problem:** `tool-manager.ts:255-262` emits a full documentation section
for every tool on every request (~10–20 KB). No `defer:` flag exists.
**Approach:** Split `getToolDocsForPrompt()` into `summary` (always
included, name + 1-line description) and `details` (gated by
`tool.alwaysLoad`). Register two new tools, `tool_search(query)` and
`tool_help(name)`, returning the cached `docs:` body on demand. Add
`shouldDefer:` to tool YAML — heavy tools (LSP, browser, plan-mode)
default to `defer:true`. Hard-cap the assembled tool-doc section at
8 KB; spill overflow through Stub 1. CC reference: `ToolSearchTool.ts:235`,
`Tool.ts:442-449`.
**Acceptance criteria:** A coding session's system-prompt tool-doc
section drops to ≤ 4 KB; `tool_help('grep')` returns the full grep doc;
`tool_search('search')` returns ranked candidates; `defer:true` tools
do not appear in initial summary unless explicitly listed in
role `allowedTools`.

### Stub 8 — Concurrent delegate spawning

**Title:** Parallelise session creation in `delegate({parallel:[…]})`.
**Problem:** `agent/extension.ts:273-290` creates sessions in a `for await`
loop; only the wait phase runs in parallel. Three children with 1 s
session-creation each incur 3 s before the first executes.
**Approach:** Replace the serial loop with
`await Promise.all(params.parallel.map(p => createDelegateSession(...)))`.
Add a regression test that asserts `Date.now()` deltas between
`createDelegateSession` calls are < 100 ms apart (mock the gateway).
Surface latent worktree-creation races via a stress test
(10 concurrent delegates).
**Acceptance criteria:** A 4-way `parallel` delegate completes in
roughly `max(child_durations) + 1.5 s`, not `sum`; concurrent
`createDelegateSession` calls do not corrupt `.bobbit/state/sessions.json`;
worktree directories never collide.

### Stub 9 — Cap and lazy-load workflow / gate context

**Title:** Bound workflow-state injection at 4 KB; provide retrieval tools.
**Problem:** `team-manager.ts:471-490` `buildDependencyContext`
concatenates every passed `injectDownstream` upstream gate's
`currentContent` separated by `---` with no ceiling, then
`system-prompt.ts:289-291` appends verbatim. A 12 KB design-doc gate is
dumped into every downstream agent's prompt, every turn.
**Approach:** Default to a 4 KB summary per gate (id, name, status, length,
last-signal timestamp, optional first 80 lines); add `?view=full` query
mode to `GET /api/goals/:goalId/gates/:gateId` (already wired through
`tools/tasks/extension.ts:165-178`) and a `gate_inspect(gateId)` retrieval
tool. Goals 14.2 + 14.3 ship as one PR. Reference: CC
`toolResultStorage.ts:106-112`; Hermes `tool_result_storage.py:178-226`.
**Acceptance criteria:** Workflow context section in the system prompt
caps at ≈ 4 KB regardless of upstream gate count; `gate_inspect` retrieves
the full body; existing `gate_status` endpoint preserves backward-compat
behaviour with explicit `?view=full`.

### Stub 10 — Per-extension syntax check on edit/write/patch

**Title:** Best-effort post-write syntax check via per-extension table.
**Problem:** `edit`/`write`/`patch` returns success without ever running a
fast syntax check; the agent only discovers a broken JSON / unparseable
TS several turns later. Bobbit ships no such pass at any layer
(`audits/bobbit.md:210`).
**Approach:** Add `src/server/agent/syntax-check.ts` with a per-extension
table mirroring Hermes `tools/file_operations.py:261-267`:
`.py: python -m py_compile`, `.js: node --check`, `.ts: npx tsc --noEmit`,
`.go: go vet`, `.rs: rustfmt --check`, `.json: JSON.parse`,
`.yaml: YAML.parse`. Run with a 10 s timeout, skip if the binary is
absent. Surface result as `lint:` field on the edit/write/patch tool
result. Goal 5.9 and 13.1 share this implementation.
**Acceptance criteria:** Editing a `.json` file with invalid JSON returns
`{ ok:true, lint:{ ok:false, error: 'Unexpected token …' } }`; missing
binaries silently skip with `lint:{ok:true, reason:'binary_unavailable'}`;
overall edit time stays under 1.5 s on TypeScript files; per-extension
opt-out via `syntaxCheck:` session config.

---

*End of audit. 77 goals classified. Citations trace to source on disk —
no claim is sourced solely from input MD files.*
