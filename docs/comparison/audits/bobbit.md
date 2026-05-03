# Bobbit Harness Audit

**Source audited:** `/Users/aj/Documents/dev/bobbit` (master @ `a3a9cc7`, package version `0.1.8`).

## Preamble — Bobbit vs. pi-coding-agent split

Bobbit is a thin gateway/orchestration shell around **`@mariozechner/pi-coding-agent`** (the wrapped library). The wrapped library owns the **agent loop, model providers, system-prompt builder, compaction, settings, and the four "coding" tools** (`read`, `write`, `edit`, `bash`, plus `grep`/`find`/`ls`). Bobbit's source contributes:

- A WebSocket/REST gateway around the agent (`src/server/server.ts`, `src/server/agent/session-manager.ts`).
- A YAML-driven **tool catalog** (`.bobbit/config/tools/<group>/*.yaml`) with `summary`/`docs`/`detail_docs` fields rendered into the prompt.
- A handful of **bobbit-extension** tools (custom `bash`, `bash_bg`, `delegate`, the team/tasks/gates/browser/web/preview families) declared in `.bobbit/config/tools/<group>/extension.ts`.
- A **prompt assembler** (`src/server/agent/system-prompt.ts`) that prepends global prompt + AGENTS.md + goal/role/task sections, then appends the tool catalog produced by `tool-manager.ts`.
- Goal / Workflow / Task / Gate / Team data layers (no behavioural change to coding tools).

**Inherited verbatim from pi-coding-agent** (no Bobbit override): `read`, `edit`, `write`, `grep`, `find`, `ls` — defined in `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/*.js`. **Replaced/wrapped by Bobbit:** `bash` (the YAML still claims `provider.type=builtin tool=bash`, but `.bobbit/config/tools/shell/extension.ts:150` registers a custom `bash`; the extension is loaded after builtins so it wins).

The Bobbit version checked has **no `defaults/tools/` directory**, **no `src/server/agent/project-sandbox.ts` / `sandbox-manager.ts` / `docker-args.ts`**, **no `truncate-large-content.ts`**, **no `/api/sessions/:id/tool-content/...` endpoint**, and **no read-before-edit / loop-guard / stale-mtime checks** anywhere in `src/server/`. (See sections below for specific searches.)

---

## Tools

Tools come from two sources:

1. **Builtins via pi-coding-agent**: `read`, `edit`, `write`, `grep`, `find`, `ls`. The YAML files in `.bobbit/config/tools/filesystem/` declare `provider: { type: builtin, tool: <name> }` and the harness wires them to `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/<name>.js`.
2. **Bobbit extensions** in `.bobbit/config/tools/<group>/extension.ts`, each calling `pi.registerTool(...)`.

Below grouped by family.

### Read family

#### read
- **What**: Read file contents (text, or images as base64).
- **Defined**: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/read.js:14` (`createReadTool`); YAML `.bobbit/config/tools/filesystem/read.yaml:1`.
- **Params**: `path: string`, optional `offset: number` (1-indexed), `limit: number`.
- **Output**: Truncated to **2000 lines or 50KB**, whichever first; impl in `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/truncate.js:11-13` (`DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50*1024`). On truncation, output ends with an actionable `[Showing lines X-Y of N. Use offset=Z to continue.]` notice. If the first line at offset > 30KB, returns instructions to use `bash sed`. Images go through `resizeImage` (default 2000x2000 cap, `node_modules/@mariozechner/pi-coding-agent/dist/utils/image-resize.js`).
- **Safety**: No mtime tracking, no read-before-edit linkage, no caching/dedup. Each call re-reads from disk.
- **Notes**: Never returns partial lines (except bash tail edge case). Aborts honor `signal`.

#### ls
- **What**: List directory contents.
- **Defined**: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/ls.js`; YAML `.bobbit/config/tools/filesystem/ls.yaml:1`.
- **Output**: Truncated to ≤500 entries in the YAML docs (`/Users/aj/Documents/dev/bobbit/.bobbit/config/tools/filesystem/ls.yaml`).

### Search family

#### grep
- **What**: Search file contents via ripgrep (then falls back to JS regex on the spawn target).
- **Defined**: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/grep.js`; YAML `.bobbit/config/tools/filesystem/grep.yaml:1`.
- **Output**: Truncated to **100 matches / 50KB**, long lines clipped to 500 chars (`truncate.js:14` `GREP_MAX_LINE_LENGTH=500`).
- **Safety**: Cannot search patterns starting with `--` (must use `bash` with `rg --`). No dedup.

#### find
- **What**: Glob-search files.
- **Defined**: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/find.js`; YAML `.bobbit/config/tools/filesystem/find.yaml:1`.
- **Output**: Truncated to 1000 results / 50KB per the YAML docs.

### Edit family

#### edit
- **What**: Surgical text replacement in an existing file.
- **Defined**: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit.js:16` (`createEditTool`); YAML `.bobbit/config/tools/filesystem/edit.yaml:1`.
- **Params**: `path`, `oldText`, `newText`.
- **Behaviour**: Reads the file fresh on every call (`ops.readFile`, line ~64). Strips BOM; normalizes line endings to LF for matching, restores on write. Uses `fuzzyFindText` (`edit-diff.js`) which **first tries exact match, then fuzzy** (whitespace-tolerant). Rejects multi-occurrence matches (line ~95): "Found N occurrences ... text must be unique". No mtime guard, no "you must read this file first" gate.
- **Output**: `Successfully replaced text in {path}.` plus a `details.diff` (unified diff) returned for renderer.
- **Safety**: ✗ **No read-before-edit enforcement** (an agent can call `edit` on a never-read file; pi-coding-agent only checks `access(R_OK|W_OK)`, line ~58). ✗ **No stale-content detection / mtime check.** ✓ Multi-occurrence rejection. ✓ Identical-content rejection (line ~108: "No changes made … replacement produced identical content"). ✓ Whole-file fuzzy normalization avoids whitespace drift errors.
- **Notes**: First-occurrence-only by spec; harness aborts with explicit error rather than silently picking one.

#### write
- **What**: Create or overwrite a file (full-file replace).
- **Defined**: `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/write.js`; YAML `.bobbit/config/tools/filesystem/write.yaml:1`.
- **Params**: `path`, `content`.
- **Output**: One-line success message.
- **Safety**: Auto-creates parent dirs. **No confirmation, no backup, no mtime check, no diff against on-disk content before writing.** Will silently overwrite a file that another process modified between read and write.

### Shell family

#### bash (Bobbit-overridden)
- **What**: Run a shell command synchronously.
- **Defined**: Bobbit registers a custom `bash` at `.bobbit/config/tools/shell/extension.ts:150` (overrides the pi-coding-agent builtin). YAML metadata at `.bobbit/config/tools/shell/bash.yaml:1`.
- **Params**: `command: string`, optional `timeout` (seconds; default **300s** per `extension.ts:24` `DEFAULT_TIMEOUT=300`).
- **Output**: stdout+stderr concatenated, truncated to **last 2000 lines / 50KB** (`MAX_BYTES = 50*1024`, `MAX_LINES = 2000` at `extension.ts:23-24`); on truncation full output dumped to a temp file referenced in details.
- **Notes**: The Bobbit override exists specifically to (a) listen on `exit` not `close` (avoids hangs on grandchildren that hold pipes; see comment lines 1-12), (b) force a 5-minute default timeout, and (c) **inject a `Co-Authored-By` git commit trailer automatically** via `injectCoAuthorTrailer()` (extension.ts:~84-110) — every `git commit` (except merges/reverts/cherry-picks or those that already have `--trailer`) is rewritten. **No sandbox isolation, no command allowlist, no per-host validation**: arbitrary commands run with the agent's full uid.

#### bash_bg
- **What**: Manage long-running background processes via the gateway API (create, logs, grep, head, slice, kill, list, wait).
- **Defined**: `.bobbit/config/tools/shell/extension.ts:271` (action-dispatched single tool). YAML at `.bobbit/config/tools/shell/bash_bg.yaml:1`.
- **Params**: `action` (enum), `command`, `name`, `id`, `pattern`, `tail`, `lines`, `from`, `to`, etc.
- **Output**: Action-dependent JSON; logs/grep/head/slice all return slices of captured output to keep token budget bounded.
- **Notes**: Persistent processes survive across tool calls in the gateway, not in the agent. Gateway endpoint is `POST /api/...` — credentials read from `BOBBIT_DIR/state/{token,gateway-url}`.

### Delegation family

#### delegate
- **What**: Spawn one or more *child Bobbit sessions* (real sessions visible in the sidebar) and block until they finish.
- **Defined**: `.bobbit/config/tools/agent/extension.ts:208` (`pi.registerTool({ name: "delegate", ... })`).
- **Params**: `instructions: string?`, `parallel: Array<{instructions, context}>?`, `context: Record<string,string>?`, `timeout_minutes: number?` (default 10).
- **Output**: Per-delegate `{ id, sessionId, status, output, durationMs }`. Parallel mode streams progress updates as delegates finish.
- **Safety**: Recursion guard — if `process.env.BOBBIT_DELEGATE_OF` is set, the tool is **not registered** (extension.ts:202), preventing delegate-of-delegate explosions.
- **Notes**: Each delegate is a full agent process — large per-delegate prompt overhead; Bobbit's own system prompt (in this worktree) warns against using it for simple file reads.

### Team / multi-agent family (Bobbit-extension)

All registered in `.bobbit/config/tools/team/extension.ts` (9 tools).

| Tool | Line | Purpose |
|---|---|---|
| `team_spawn` | 73 | Create a role agent with its own git worktree branched from goal branch. |
| `team_list` | 96 | List team agents w/ role, status, task. |
| `team_dismiss` | 109 | Terminate one agent + clean up worktree. |
| `team_complete` | 124 | Dismiss all agents and mark goal complete (server requires review gate passed). |
| `team_steer` | 137 | Mid-turn redirect to a running agent. |
| `team_abort` | 153 | Force-kill an agent (when steering is unresponsive). |
| `team_prompt` | 168 | Queue/send a follow-up prompt to an agent. |
| `personalities_list` | 189 | List personalities. |
| `personalities_create` | 202 | Define a personality. |

- **Output**: Action-dependent. All hit gateway REST endpoints under `/api/goals/:id/team/...`.
- **Safety**: Server-side enforcement — `team_complete` blocked unless `review-findings` gate passes; `team_spawn` rejects 409 if `workflowGateId` upstream gates haven't passed. The tools themselves are thin REST clients.

### Tasks/Gates family

`.bobbit/config/tools/tasks/extension.ts` registers 6 tools:

| Tool | Line | Purpose |
|---|---|---|
| `task_list` | 73 | List goal tasks. |
| `task_create` | 86 | Create a task with `type`, `spec`, `depends_on`. |
| `task_update` | 110 | Mutate task fields/state/assignment. |
| `gate_list` | 153 | List workflow gates (status + deps). |
| `gate_status` | 166 | Latest signal verdict + truncated last 40 lines of failed step output. |
| `gate_signal` | 181 | Submit content/metadata to a gate; triggers async verification. |

- **Output**: JSON. Gate output is intentionally truncated server-side (last 40 lines of failed steps) per the YAML docs (`.bobbit/config/tools/tasks/gate_status.yaml`). The richer body is fetched via a separate `gate_inspect` action — but **`gate_inspect` is not present as a registered tool in this Bobbit version** (no match in `.bobbit/config/tools/tasks/extension.ts`); the gateway exposes it as a REST call only.

### Browser family

`.bobbit/config/tools/browser/extension.ts` registers 6 tools (lines 65/84/131/149/174/193): `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_eval`, `browser_wait`. Backed by Playwright (chromium) launched on first use; session persists across calls. `browser_screenshot` returns base64 PNG inline (no file-spill mode in this Bobbit version — confirmed by reading lines 84-128: only `savePath` and `fullPage` exist; no `includeBase64`/`format`/`quality` parameters). Notably **absent** versus the system-prompt-described tool surface in this worktree: `browser_console_messages`, `browser_resize`, `browser_press_key`, `browser_hover`, `browser_select_option`, `browser_snapshot`. Searched `.bobbit/config/tools/browser/extension.ts` — no `registerTool` for those names.

### Web family

`.bobbit/config/tools/web/extension.ts` registers `web_search` (line 115; uses DuckDuckGo HTML scraping) and `web_fetch` (line 192; curl + HTML→text). Default 20K-char extract, parallel-friendly. No JS execution.

### HTML / preview family

`.bobbit/config/tools/html/extension.ts` registers `preview_open` (line 60) and `preview_close` (line 131). Writes HTML to a per-session file at `bobbitStateDir()/preview-<sessionId>.html` and tells the UI to load it.

### Gates of the wider Bobbit "ecosystem" — *absent in this version*

Searched `src/server/`, `.bobbit/config/tools/`, and the working tree for the following commonly-described tools and **found no registration**:

- `verification_result` — no match (`grep -rln "verification_result" src/server src/app .bobbit`).
- `propose_goal` / `propose_project` / `propose_role` / `propose_tool` / `propose_staff` — no match.
- `view_proposal` / `edit_proposal` — no match.
- `review_open` / `review_close` — no match.
- `ask_user_choices` — no match.
- `activate_skill` — no match.
- `generate_image` — no match.
- `goal_spawn_child`, `goal_plan_propose`, `goal_plan_status`, `goal_pause`, `goal_resume`, `goal_archive_child`, `goal_decide_mutation`, `goal_set_policy`, `goal_merge_child` — no match in `.bobbit/config/tools/` or extension files.
- MCP tool registration: `src/server/mcp/mcp-manager.ts` exists and exposes external tools via `ToolManager.registerExternalTools()` (`src/server/agent/tool-manager.ts:131`), but no MCP servers are bundled.

These belong to a more recent Bobbit release (the worktree-current `AGENTS.md` and the system prompt in this session reference them). **The audited `master` does not have them.**

---

## Context

### System prompt assembly
- **Defined**: `src/server/agent/system-prompt.ts:154-217` (`assembleSystemPrompt`).
- **Order**: (1) global system prompt (`config/system-prompt.md`); (2) `AGENTS.md` from cwd with `@file.md` refs resolved recursively (`resolveMarkdownRefs`, line 24); (3) `CLAUDE.md` from cwd (skipped if it's just `@AGENTS.md`); (4) Claude Code project memories from `~/.claude/projects/<encodedCwd>/memory/*.md` (line 110-153, capped at 16KB / 20 files); (5) memory `group_id` hint; (6) **Goal section** = `goalSpec` + role prompt + tool restrictions concatenated with `---` separators (line 195-209); (7) Personalities; (8) **Tool documentation** (assembled separately by `tool-manager.ts`); (9) Task context; (10) Workflow upstream-gate context.
- **Output**: Written to `<bobbitStateDir>/session-prompts/<sessionId>.md`, passed to the agent via `--system-prompt`. Sections joined with `\n\n---\n\n`.

### Tool-doc rendering
- **Defined**: `src/server/agent/tool-manager.ts:175-237` (`getToolDocsForPrompt`).
- **Strategy**: Two passes. **Overview** = group → `- **<name>**: <summary>` (one-liner). **Documentation** = `### <name>\n\n<docs>` (the medium-length `docs:` field). The longer `detail_docs:` field is **not** included in the prompt — instead the prompt ends with the line "*For detailed tool documentation … read the tool's YAML file in `.bobbit/config/tools/<group>/<tool>.yaml` — see the `detail_docs` field*" (line 230). So `detail_docs` is **lazy**: discoverable on demand by the agent reading the YAML, not eagerly loaded.
- **No file like `.bobbit/state/tool-docs/<group>.md`** exists in this version — searched: `find /Users/aj/Documents/dev/bobbit -name 'tool-docs' -type d` returns nothing, and `grep -rn "tool-docs/" src/server` returns nothing.
- **Re-scan per request**: `loadToolDefinitions()` runs every call (line 51) — newly added YAML is picked up without restart, but pays a fs-stat cost per request.

### Prompt cache
- **Defined**: `node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:471-488` (Anthropic provider) and `openai-completions.js:363-385` (OpenRouter Anthropic-routed). `cache_control: { type: "ephemeral" }` is attached to (a) the system-prompt text block, (b) the last user message of the conversation. **Only two implicit breakpoints** — Bobbit does not insert additional `cache_control` markers in tool docs or per-section. No file in `src/server/` references `cache_control` (`grep -rn cache_control src/server` returns nothing). Cache is provider-driven, not Bobbit-driven.

### Per-turn output budget / max_tokens
- Set by pi-ai per model: `max_tokens = options?.maxTokens || (model.maxTokens / 3) | 0` for Anthropic (`anthropic.js:464`). Bobbit's gateway-provided model metadata (`src/server/agent/aigw-manager.ts:84-104`) caps `maxTokens` per known model family (Claude Sonnet → 16384; Opus → 32768; Claude Haiku → 8192; GPT-5 → 32768; o-series → 65536–100000). Bobbit doesn't override this beyond model metadata.

### Compaction
- **Defined**: pi-coding-agent `node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js` and emitted to Bobbit as `auto_compaction_start` / `auto_compaction_end` events (handled at `src/server/agent/session-manager.ts:487-491`).
- **Strategy** (from `compaction.d.ts`): walk backwards from newest, accumulate estimated tokens (chars/4 heuristic, `estimateTokens`) until ≥ `keepRecentTokens`, cut there. May split a turn (`isSplitTurn`); the messages before the cut are summarized via the model with reserve `reserveTokens`. Iterative — re-uses `previousSummary` on subsequent compactions.
- **Defaults** (from settings, `node_modules/@mariozechner/pi-coding-agent/dist/core/settings-manager.js`): `enabled: true`, `reserveTokens: 16384`, `keepRecentTokens: 20000`. Trigger: `shouldCompact(contextTokens, contextWindow, settings)` — i.e. when remaining context < `reserveTokens`.
- **Manual compaction**: `AgentSession.compact(customInstructions?)` in pi-coding-agent (`agent-session.d.ts:425`); Bobbit exposes manual compaction over WS/RPC (`src/server/agent/rpc-bridge.ts`) and shows `isCompacting` in session state.
- **Bobbit-side**: `refreshAfterCompaction(session)` (`session-manager.ts:1429`) re-reads the post-compaction message stream and re-broadcasts to clients.
- **Failure handling**: pi-coding-agent's `_compactionAbortController` aborts on overflow/cancel; Bobbit's `auto_compaction_end` event has an `aborted` flag — when true, no refresh is broadcast (line 491).

### Read deduplication / repeated-call guard
- **Searched**: `grep -rn "dedup\|duplicate\|sameToolCall" src/server` → no matches.
- **Searched**: `grep -rn "loop\|repeated" node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js` — only references to the streaming loop machinery (lines 831, 1493), not loop-detection.
- **Conclusion**: **No dedup of identical `read` results, no loop-guard on repeated identical tool calls, no "this file was just read" suppression.** Each tool call carries its full result into context. The only token-saving features are (a) per-tool truncation, (b) compaction.

### Image filtering toggle
- `convertToLlmWithBlockImages` in pi-coding-agent (`sdk.js`) — when `settings.images.blockImages = true` (default false), images in user/toolResult messages are replaced with the text "Image reading is disabled.", with consecutive duplicates de-duped. This is the only context-deduping logic I could find.

---

## Coding

### Edit safety
- **Read-before-edit enforcement**: ✗ **None.** The `edit` tool only verifies file `access(R_OK|W_OK)` (`edit.js:~58`). Nothing tracks whether the agent previously called `read` on the same path.
- **Stale-content / mtime detection**: ✗ **None.** Searched `grep -rn "mtime\|stat\|fs.statSync" node_modules/@mariozechner/pi-coding-agent/dist/core/tools/{edit,write}.js` — no mtime tracking. Each `edit` reads-then-writes; if the file changed between the agent's earlier `read` and the `edit`, no detection.
- **Atomic patches**: Single-file only. Writes via `fs.writeFile` (no rename-tmp atomic dance). `edit` writes the full new content in one syscall (`fs/promises#writeFile`).
- **Fuzzy / exact matching**: Both. `fuzzyFindText` (`edit-diff.js`) tries exact, then a whitespace-tolerant fuzzy pass. Multi-occurrence ⇒ explicit failure. Identical-after-replace ⇒ explicit failure.
- **Post-write verify / syntax check**: ✗ **None.** No re-read, no parser/linter.
- **Diff returned**: ✓. The `details.diff` field carries a unified diff, used by the UI (`EditRenderer.ts`).

### File-state coordination across parallel agents
- Each Bobbit team agent runs in its **own git worktree** (branch namespaces: `pool/_pool-<id>`, `session/<id8>`, `goal/<slug>-<id>`, `staff-<name>-<id>`; documented in `AGENTS.md`). **Coordination is at git-merge time, not at edit time.** No file lock, no mtime gossip, no shared state.
- **Concurrency safety**: only `proper-lockfile` on `settings.json` (pi-coding-agent's settings store, `settings-manager.js`). Tool execution itself has no locks.

### Multi-file patches
- ✗ **No multi-file patch tool.** Each `edit`/`write` call touches one file. To patch N files, the agent must issue N tool calls (parallel-allowed by the streaming layer).

### Sandbox / backend support
- **Searched**: `find /Users/aj/Documents/dev/bobbit -name "*sandbox*" -o -name "*docker*" 2>/dev/null` — **no matches** outside `node_modules`.
- **Searched**: `grep -rn "sandbox\|docker" src/server/` — only `cli.ts` token comment; nothing in `agent/`.
- **Conclusion**: This Bobbit release **has no Docker sandbox, no `project-sandbox.ts` / `sandbox-manager.ts` / `docker-args.ts`, no project-level `sandbox: docker` plumbing.** Tools execute with the gateway process's host privileges. The `AGENTS.md` in this *session worktree* and the system prompt describe sandboxing — not present in master.

### Plan-mode / read-only mode
- ✗ **None.** Searched `grep -rn "plan.mode\|planMode\|readOnly" src/server/` → no matches. pi-coding-agent does ship a `readOnlyTools` set (`sdk.d.ts:53`), but Bobbit doesn't expose any UI/role toggle for it; tool selection is per-role only (role YAML's `tools`/`toolPolicies` lists in `.bobbit/config/roles/*.yaml`).

### Prompt-injection defense
- ✗ **No active defense.** No content-rewriting of `read`/`web_fetch`/`bash` outputs to neutralize injection attempts. Searched `grep -rn "inject\|sanitize" src/server/agent/` — only Unicode surrogate sanitization in pi-ai providers, not prompt-injection mitigation.
- The only nearby filter: pi-ai providers strip empty text blocks and normalize tool-call IDs.

### Secret redaction
- ✗ **No automatic redaction.** Searched `grep -rn "secret\|redact" src/server/` — only `cli.ts:235` ("keep it secret" CLI message) and the `--new-token` regen path. No redaction in tool-result paths, no log scrubbing, no .env-aware filtering.
- Bobbit does store gateway tokens (`.bobbit/state/token`) and OAuth credentials (per pi-coding-agent's `AuthStorage`) outside the conversation, so they aren't echoed by default — but if an agent reads `~/.bobbit/state/token` via `read` or `bash cat`, the value enters the conversation unredacted.

### Co-authored-commit injection (Bobbit-specific)
- ✓ The Bobbit-overridden `bash` tool injects a `Co-Authored-By: Bobbit (<model>) <noreply@bobbit.dev>` trailer into every `git commit` it sees that doesn't already have one (`.bobbit/config/tools/shell/extension.ts:~92-110`). Skipped for `git merge|revert|cherry-pick`. This is the only mutation Bobbit performs on user-issued shell commands.

---

## Discrepancies vs comparison.md

After reading `/Users/aj/Documents/dev/bobbit-comparison/criteria.md` and the Bobbit-relevant sections of `/Users/aj/Documents/dev/bobbit-comparison/comparison.md` (read *after* the inventory above was written):

**Overall:** `comparison.md` is broadly *consistent* with my findings. The summary at line 21 says Bobbit "has no LSP, no auto-compaction, no read dedup, no per-turn budget, no plan mode, no prompt-injection scanning, and no read-before-edit enforcement at its layer" — all confirmed. The scores it assigns Bobbit (A5 read dedup = 2, B5 loop guards = 2, D4 sandbox = 4, C1 edit behavior = 5) match what I observed. Specific discrepancies and corrections:

1. **Auto-compaction.** `comparison.md:21` says Bobbit has "no auto-compaction". *Audited reality:* auto-compaction **does** exist, inherited from pi-coding-agent (`compaction/compaction.js` + `auto_compaction_start`/`_end` events handled at `session-manager.ts:487-491`). What's missing is a Bobbit-specific *failure-cooldown* / *microcompact-old-tool-results* layer — the comparison's scoring (A6 = 3) and improvement goal 6.4 "auto-compaction trigger" still make sense as deltas vs Claude Code, but the absolute claim "no auto-compaction" is too strong. Defaults are `reserveTokens: 16384`, `keepRecentTokens: 20000`, char/4 token estimator — Bobbit does not override these.
2. **Sandbox backends (D4 = 4).** `comparison.md:69` and the 4/9 score suggest *some* sandbox capability. *Audited reality:* I found **zero** sandbox/docker code in `src/server/` (no `project-sandbox.ts`, `sandbox-manager.ts`, `docker-args.ts`, or `sandbox:` plumbing). Score 4/9 may reflect worktree-based git isolation only. If so, the column should clarify "local + git worktree only; no container/SSH/cloud backends" — same conclusion comparison.md reaches at line 301 ("Local only (worktree for fs isolation)"), but the 4 vs Hermes' 9 still reads as if there's *some* backend abstraction.
3. **Browser tool surface (line 188 area + tool tables).** I did not find a browser-tool count in `comparison.md`, but for completeness: master ships 6 browser tools (`navigate`, `screenshot`, `click`, `type`, `eval`, `wait`) — not the richer set (`console_messages`, `resize`, `press_key`, `hover`, `select_option`, `snapshot`, screenshot `includeBase64`/`savePath`/`format`/`quality`) described in *this session worktree's* `AGENTS.md`/system prompt.
4. **Prompt-cache strategy (A3 = 3).** `comparison.md:260` says Bobbit's cache strategy is "None visible". *Audited reality:* cache **is** present, but only via inherited pi-ai providers (`anthropic.js:471-488`) — exactly two ephemeral breakpoints (system prompt, last user message). Bobbit itself adds no `cache_control` markers. The 3/9 score is fair; the row label "None visible" is incorrect — say "inherited 2-breakpoint default; no Bobbit-side strategy".
5. **Tool families absent in master but described in this session.** The session worktree's system prompt and `AGENTS.md` describe `verification_result`, `propose_goal`/`propose_project`/`propose_role`/`propose_tool`/`propose_staff`, `view_proposal`/`edit_proposal`, `review_open`/`review_close`, `ask_user_choices`, `activate_skill`, `generate_image`, the full `goal_*` family (`goal_spawn_child`, `goal_plan_propose`, `goal_plan_status`, `goal_pause`, `goal_resume`, `goal_archive_child`, `goal_decide_mutation`, `goal_set_policy`, `goal_merge_child`), and `gate_inspect`. **None of these are registered as tools in master @ `a3a9cc7`** (confirmed by `grep` of `.bobbit/config/tools/*/extension.ts`). `comparison.md` does not appear to claim these as Bobbit tools — but if the audit reader assumes parity with the session prompt, they're not there. If `comparison.md` was written against a more recent branch (the audit covered `a3a9cc7` published as `0.1.8`), the doc should pin a commit/version for reproducibility.
6. **"No `truncate-large-content.ts` / no lazy `tool-content` endpoint".** `comparison.md` does not appear to claim these for Bobbit (line 233 says "Tool-specific tail truncation"), so no discrepancy — just confirming: truncation is inside tool implementations (`pi-coding-agent/dist/core/tools/truncate.js` + the bash-extension override at `.bobbit/config/tools/shell/extension.ts:23-24`). No `/api/sessions/:id/tool-content/<mi>/<bi>` endpoint exists.
7. **Read-before-edit / stale-file detection.** `comparison.md:243-244` correctly states "Not visible at Bobbit layer" / "Worktree isolation between roles; per-file guard not visible" — confirmed.
8. **Co-author trailer injection.** Bobbit has one Bobbit-specific behaviour I didn't see called out in `comparison.md`: the custom `bash` extension auto-injects `Co-Authored-By: Bobbit (<model>) <noreply@bobbit.dev>` into every `git commit` (`.bobbit/config/tools/shell/extension.ts:~92-110`). Worth a row if the comparison cares about "opinionated mutations to user shell commands".
