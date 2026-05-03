# Claude Code — Capability Audit

Source: `/Users/aj/Documents/dev/claude-code` (this is the official `@anthropic-ai/claude-code` source — `cli/`, `tools/`, `services/`, `query/` etc.). All citations are `path:line` from that tree. Built from a fresh read of source; no comparison docs consulted until the final cross-check section.

Conventions: every tool is registered via `buildTool(...)` (`src/Tool.ts:357`) and exposed through `getAllBaseTools()` in `src/tools.ts:147`. Each tool declares a `name`, `inputSchema` (Zod v4), `outputSchema`, `maxResultSizeChars` (the per-tool persistence threshold — see "Tool result persistence" below), `searchHint`, plus optional `shouldDefer`, `isReadOnly`, `isConcurrencySafe`, `isOpenWorld`, `interruptBehavior`, etc.

## Tools

### Read family

#### `Read` (`FileRead`)
- **Defined**: `src/tools/FileReadTool/FileReadTool.ts:271` (registration), schema `:225-262`, `call` `:357`.
- **Purpose**: Read text, image, PDF, or Jupyter notebook by absolute path. Per-extension dispatch in `callInner` (`:476`).
- **Inputs**: `{ file_path: string (absolute), offset?: int≥0, limit?: int>0, pages?: string }` (PDF page range, e.g. `"1-5"`, `:259`).
- **Output**: discriminated union `text | image | notebook | pdf | parts | file_unchanged` (`:165-220`).
- **Limits**:
  - `maxResultSizeChars: Infinity` (`:282`) — Read self-bounds, must not be persisted (would create Read→file→Read loops).
  - Token cap: 25 000 default (`DEFAULT_MAX_OUTPUT_TOKENS`, `src/tools/FileReadTool/limits.ts:19`); env override `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` (`limits.ts:25`); throws `MaxFileReadTokenExceededError` (`FileReadTool.ts:151`).
  - Byte cap: `MAX_OUTPUT_SIZE = 0.25 MB` (`src/utils/file.ts:48`) — gates total file size, not slice; throws pre-read.
  - Image base64 limit `5 MB` (`src/constants/apiLimits.ts:23`); auto resize+compress to fit token budget (`readImageWithTokenBudget`, `:858`).
  - PDF: `PDF_MAX_PAGES_PER_READ = 20` (`apiLimits.ts:73`), inline only if ≤10 pages (`apiLimits.ts:79`); >3 MB triggers per-page extraction (`PDF_EXTRACT_SIZE_THRESHOLD`, `apiLimits.ts:60`).
- **Read-dedup**: identical file+range+mtime returns a stub `file_unchanged` (`FileReadTool.ts:386-432`); flagged off via GrowthBook `tengu_read_dedup_killswitch`. Only triggers for prior Read entries (`offset !== undefined`) so Edit/Write entries don't poison.
- **Read state**: every successful read records `{content, timestamp, offset, limit, isPartialView}` in `readFileState: FileStateCache` (LRU, 100 entries, 25 MB total — `src/utils/fileStateCache.ts:18-23`). Used downstream for Edit/Write freshness checks.
- **Skill discovery**: each Read fires `discoverSkillDirsForPaths` and `activateConditionalSkillsForPaths` (`:438-451`) — touching a file can pull in a colocated `SKILL.md`.
- **Cyber-risk reminder**: every successful text read appends a system-reminder telling the model it may analyse but not improve malware (`CYBER_RISK_MITIGATION_REMINDER`, `:738`); skipped on `claude-opus-4-6` (`:746`).
- **Blocked devices**: `/dev/zero`, `/dev/random`, `/dev/stdin`, `/dev/tty`, `/proc/<pid>/fd/{0,1,2}`, etc. (`:96-114`) so reads can't hang the agent.

#### `Glob`
- **Defined**: `src/tools/GlobTool/GlobTool.ts:55`. Implementation calls into `src/utils/glob.ts`.
- **Inputs**: `{ pattern: string, path?: string }`.
- **Output**: `{ filenames[], numFiles, durationMs, truncated }`.
- **Limits**: hardcoded `limit = 100` files (`:158`); `maxResultSizeChars: 100_000` (`:60`). Truncation appended to result text (`:184-188`).
- **Behavior**: read-only, concurrency-safe, relativizes paths under cwd (`:166`), excludes nothing client-side (defers to ripgrep/glob default).
- **Conditionally registered**: `tools.ts:154` — when `hasEmbeddedSearchTools()` (ant-internal builds with bfs/ugrep aliased to `find`/`grep` inside Bash), Glob/Grep are dropped.

#### `Grep`
- **Defined**: `src/tools/GrepTool/GrepTool.ts` (registration ~`:300+`, schema `:32-93`).
- **Inputs**: ripgrep wrapper. `{ pattern, path?, glob?, output_mode?: "content"|"files_with_matches"|"count", -A, -B, -C, context, -n, -i, type, head_limit?, offset?, multiline? }`.
- **Limits**: `DEFAULT_HEAD_LIMIT = 250` (`:99`); `head_limit: 0` opt-out for unlimited; `maxResultSizeChars: 100_000`. Excludes `.git/.svn/.hg/.bzr/.jj/.sl` automatically (`:88`).

#### `LSPTool`
- **Defined**: `src/tools/LSPTool/LSPTool.ts:60` (gated by env `ENABLE_LSP_TOOL`, `tools.ts:179`).
- **Operations** (`:64-72`): `goToDefinition | findReferences | hover | documentSymbol | workspaceSymbol | goToImplementation | prepareCallHierarchy | incomingCalls | outgoingCalls`.
- **Inputs**: `{ operation, filePath, line, character, ...op-specific }`.
- **Limit**: `MAX_LSP_FILE_SIZE_BYTES = 10_000_000` (`:54`).

#### `ListMcpResources` / `ReadMcpResource`
- Imported in `tools.ts:81-82` and added unconditionally (`tools.ts:228`); thin wrappers over MCP `resources/list` and `resources/read`. Filtered out of the model-visible set unless MCP is wired (`tools.ts:259`).

### Edit / Write family

All three have a strict **read-before-edit** invariant: `readFileState.get(absoluteFilePath)` must exist and **not** be `isPartialView`, else the tool fails with `errorCode: 6`/`2` (`FileEditTool.ts:198-208`, `FileWriteTool.ts:198-205`).

#### `Edit` (`FileEdit`)
- **Defined**: `src/tools/FileEditTool/FileEditTool.ts:81`, name constant `src/tools/FileEditTool/constants.ts:2`.
- **Inputs**: `{ file_path, old_string, new_string, replace_all? }` (single edit per call). Schema `src/tools/FileEditTool/types.ts`.
- **Output**: `{ filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll, gitDiff? }` (`:402-411`).
- **Validation pipeline** (`:131-291`): rejects `old_string === new_string`, deny-rule check, UNC bypass, file-size cap `MAX_EDIT_FILE_SIZE = 1 GiB` (`:80`), encoding+CRLF detect, file-existence handling (suggests "did you mean…?", `:202`), `.ipynb` redirected to NotebookEdit, **stale-file check** (`:225-244`: `lastWriteTime > readTimestamp.timestamp` → `FILE_UNEXPECTEDLY_MODIFIED_ERROR` unless content matches), `findActualString` for **smart-quote / curly-quote tolerant matching** (`utils.ts`), match-count check (`>1` requires `replace_all`).
- **Atomicity**: comment at `:319` warns "Please avoid async operations between here and writing to disk to preserve atomicity." Content read is sync (`readFileForEdit`, `:432`).
- **File history**: every successful edit calls `fileHistoryTrackEdit` (`:333-338`) to capture pre-edit content (idempotent v1 backup keyed on content hash) so Ctrl-Z / undo works.
- **LSP integration**: `didChange` + `didSave` notifications (`:373-388`); diagnostics are cleared on the same path so new ones surface.
- **Skill activation**: same as Read (`:300-313`).
- **Settings-file guard**: `validateInputForSettingsFileEdit` simulates the post-edit content and rejects edits that corrupt `~/.claude/settings.json` (`:264-279`).
- **Quote preservation**: `preserveQuoteStyle` keeps curly quotes when the file uses them (`:357`).
- **Limit**: `maxResultSizeChars: 100_000` (`:84`).

#### `Write` (`FileWrite`)
- **Defined**: `src/tools/FileWriteTool/FileWriteTool.ts`. Same read-before-edit and stale-file guard as Edit (`:198-217`); same secret guard via `checkTeamMemSecrets`. Full overwrite — no partial patches.

#### `NotebookEdit`
- **Defined**: `src/tools/NotebookEditTool/NotebookEditTool.ts:90`. `maxResultSizeChars: 100_000` (`:93`). Cell-level patch into `.ipynb`.

### Shell

#### `Bash`
- **Defined**: `src/tools/BashTool/BashTool.tsx`. Schema `:230-269`, `call` `:625`.
- **Inputs**: `{ command, timeout?, description?, run_in_background?, dangerouslyDisableSandbox? }` (`_simulatedSedEdit` is internal-only, omitted from model schema, `:264`).
- **Default timeout**: 2 min (`DEFAULT_TIMEOUT_MS`, `src/utils/timeouts.ts:2`); max 10 min (`:3`); env overrides `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`.
- **Output cap**: `BASH_MAX_OUTPUT_DEFAULT = 30_000` chars (`src/utils/shell/outputLimits.ts:4`), upper bound `150 000` via `BASH_MAX_OUTPUT_LENGTH`. The on-process accumulator is `EndTruncatingAccumulator` (`src/utils/stringUtils.ts:140`) with default cap `2^25` chars but the in-tool limit is enforced earlier by `getMaxOutputLength()`. Large outputs spill to a file in `tool-results/` (up to `MAX_PERSISTED_SIZE = 64 MB`, `BashTool.tsx:734`) and the model gets a preview + `persistedOutputPath`/`persistedOutputSize`.
- **Background tasks**: `run_in_background: true` registers a `LocalShellTask`; `TaskOutput` / `TaskList` / `TaskStop` / `TaskGet` / `TaskUpdate` (todo-V2) tools manage them (`src/tools/Task*Tool/`).
- **Sandbox**: `shouldUseSandbox` (`src/tools/BashTool/shouldUseSandbox.ts:54`) decides whether to wrap the invocation in a sandbox (Linux landlock / macOS sandbox-exec / a per-OS adapter `src/utils/sandbox/sandbox-adapter.ts`). User can opt out with `dangerouslyDisableSandbox: true`. Stderr is annotated with sandbox violations (`BashTool.tsx:715`).
- **Read/search detection**: `isSearchOrReadBashCommand` (`:81-180`) parses the command (with operator awareness, `&&` / `||` / pipes) and classifies it `isRead`/`isSearch`/`isList` so the UI collapses the result chrome — and so the result is treated like a Read for downstream caching.
- **Sed-edit preview**: `parseSedEditCommand` + `applySedEdit` reroute `sed -i …` through the same atomic-write+permission path as Edit, including a permission preview the user sees before approval (`BashTool.tsx:629-633`, `sedEditParser.ts`).
- **Secret keys**: `bashPermissions.ts:402-496` lists protected env names (`ANTHROPIC_API_KEY`, `GROWTHBOOK_API_KEY`, …) excluded from echo/printenv allowlists.
- **Auto-background**: in assistant/non-interactive mode, blocking commands auto-background after `ASSISTANT_BLOCKING_BUDGET_MS = 15_000` (`BashTool.tsx:53`).
- **Limit**: per-tool max-result threshold inherits from the global default; output may be persisted as above.

#### `PowerShell`
- `src/tools/PowerShellTool/PowerShellTool.tsx`. Windows analogue, gated by `isPowerShellToolEnabled()` (`tools.ts:200`). Same persistence pattern.

### Delegation / sub-agents

#### `Agent` (`Task` legacy name)
- **Defined**: `src/tools/AgentTool/AgentTool.tsx:60`, name `src/tools/AgentTool/constants.ts:1` (legacy `'Task'`, `:3`).
- **Inputs**: `{ description (3-5 words), prompt, subagent_type?, model?: 'sonnet'|'opus'|'haiku', run_in_background?, name?, team_name?, mode?, isolation?: 'worktree'|'remote', cwd? }` (`:80-117`). Some fields gated by feature flags (`KAIROS`, ant-only).
- **Behavior**: spawns a subagent in either:
  - In-process (`runAgent`, `src/tools/AgentTool/runAgent.ts`) — shares the prompt cache via `forkSubagent.ts` (cache-shared fork preserves the parent's frozen `renderedSystemPrompt`).
  - Worktree-isolated (`createAgentWorktree`, `src/utils/worktree.ts`).
  - Remote (`isolation: 'remote'` → `RemoteAgentTask`, only on `USER_TYPE === 'ant'`).
- **Auto-background**: `getAutoBackgroundMs() = 120_000 ms` if env `CLAUDE_AUTO_BACKGROUND_TASKS` or GB flag.
- **Built-in agent types**: `Explore`, `Plan` (one-shot, listed in `ONE_SHOT_BUILTIN_AGENT_TYPES`, `constants.ts:9`); `general-purpose` (`built-in/generalPurposeAgent.ts`); `verification` (`VERIFICATION_AGENT_TYPE`).
- **Custom agents**: `loadAgentsDir.ts` reads markdown definitions from `~/.claude/agents/` and `<project>/.claude/agents/`.
- **Filtering / disallowed tools**: `ALL_AGENT_DISALLOWED_TOOLS`, `CUSTOM_AGENT_DISALLOWED_TOOLS`, `ASYNC_AGENT_ALLOWED_TOOLS`, `COORDINATOR_MODE_ALLOWED_TOOLS` (`tools.ts:99-104`, defined in `src/constants/tools.ts`).

#### `TaskOutputTool` / `TaskStopTool`
- `src/tools/TaskOutputTool/`, `src/tools/TaskStopTool/`. Read background-agent output / kill background agent.

#### `SendMessageTool`
- `src/tools/SendMessageTool/SendMessageTool.js` (lazy-required, `tools.ts:67-70`). Lets a coordinator address a named agent (`AgentTool.name` field); enabled when `isAgentSwarmsEnabled()` or coordinator mode.

#### `TeamCreateTool` / `TeamDeleteTool`
- Lazy-required (`tools.ts:60-66`). Multi-agent team management (gated by `isAgentSwarmsEnabled()`).

#### `Skill` (`SkillTool`)
- `src/tools/SkillTool/SkillTool.ts`. Invokes a slash skill / MCP prompt as a subagent. Pulls full command list including MCP `prompt` commands (`:80-93`). Records usage via `recordSkillUsage`.

### Memory / todos

#### `TodoWrite`
- `src/tools/TodoWriteTool/TodoWriteTool.ts:32`. Inputs `{ todos: TodoListSchema }`. Maintained per-session in `appState.todos[sessionId|agentId]` (`:67-69`). Verification-nudge: when the agent closes a 3+ item list with no verification step, a system-reminder is appended (`:74-86`, gated by `tengu_hive_evidence`). Disabled when `isTodoV2Enabled()` (`:51`); replaced by `TaskCreate/Get/Update/List` tools (`tools.ts:166-168`).

#### `Task{Create,Get,Update,List}` (Todo-V2)
- `src/tools/TaskCreateTool/`, etc. Persistent task list with create/list/update/get verbs.

#### `Brief` / `SyntheticOutput`
- `src/tools/BriefTool/BriefTool.ts` (always loaded, `tools.ts:191`). `SyntheticOutputTool` is a marker tool used internally to inject content; filtered out of the model-visible set (`tools.ts:206`).

### Plan mode

#### `EnterPlanMode`
- `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:36`. Zero inputs (`:21`). Switches `toolPermissionContext.mode` to `'plan'` via `applyPermissionUpdate` (`:91`). `tool_result` instructs the model to explore-only, no edits. Disabled when `--channels` is active (`:60-66`).

#### `ExitPlanModeV2`
- `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:147`. Reads a plan file (`:268`), shows it to the user for approval, restores `prePlanMode`. Strict requirement that the plan be in the configured plans directory.

### Worktree

#### `EnterWorktree` / `ExitWorktree`
- `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:52`. Creates an isolated git worktree and switches the session into it. Slug validation `validateWorktreeSlug` (≤64 chars, segment charset `[A-Za-z0-9._-]`, `:36-44`). `shouldDefer: true` (`:69`).
- Gated by `isWorktreeModeEnabled()` (`tools.ts:180`).

### Web

#### `WebFetch`
- `src/tools/WebFetchTool/WebFetchTool.ts:65`. Inputs `{ url, prompt }` (`:25`). `shouldDefer: true` (`:69`) — must come through ToolSearch.
- **Behavior**: GETs the URL, converts to markdown, runs the prompt against it via a forked subagent (Haiku), returns the result. `MAX_MARKDOWN_LENGTH = 100_000` (`utils.ts:128`); over-cap content is truncated.
- **Permission domain rules**: rule content is `domain:<hostname>` (`:50-62`); plus a `preapproved.ts` allowlist of code-related hosts (npmjs.com, github.com, etc., `preapproved.ts:154`).
- **No prompt-injection sanitisation** of fetched content beyond markdown conversion. The fetched text is passed verbatim to the inner Haiku call. (Searched `src/tools/WebFetchTool/utils.ts`, `preapproved.ts`, `WebFetchTool.ts`.)

#### `WebSearch`
- `src/tools/WebSearchTool/WebSearchTool.ts:152`. `name: WEB_SEARCH_TOOL_NAME`. Internally calls Anthropic's hosted server-tool `web_search` (`:281` `toolChoice: { type: 'tool', name: 'web_search' }`).

#### `WebBrowserTool` (feature `WEB_BROWSER_TOOL`)
- Lazy-required (`tools.ts:121`).

### Misc / infrastructure

- **`ToolSearchTool`**: `src/tools/ToolSearchTool/ToolSearchTool.ts:235`. Keyword search over deferred tools when `isToolSearchEnabled()` (`src/utils/toolSearch.ts:385`). Supports `select:<name>[,<name>…]` direct selection and keyword ranking with `+required` terms (`:170-200`). Returns `tool_reference` blocks; the API expands them server-side (1P/Foundry only — Bedrock/Vertex may not support).
- **`AskUserQuestion`**: `src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`. 1-4 questions, 2-4 options each, optional `preview` + `multiSelect`. Synchronous — pauses the loop until the user answers.
- **`ConfigTool`**: `src/tools/ConfigTool/` (ant-only, `tools.ts:160`).
- **`McpAuthTool`**: `src/tools/McpAuthTool/`.
- **`ScheduleCronTool`**: `CronCreate/Delete/List` triplet (feature `AGENT_TRIGGERS`, `tools.ts:30`).
- **`SleepTool`**: features `PROACTIVE` or `KAIROS` (`tools.ts:23`).
- **`Tungsten`** (ant-only, `tools.ts:161`), **`MonitorTool`**, **`SuggestBackgroundPRTool`**, **`SnipTool`**, **`ListPeersTool`**, **`SubscribePRTool`**, **`PushNotificationTool`**, **`SendUserFileTool`**, **`RemoteTriggerTool`**, **`OverflowTestTool`**, **`CtxInspectTool`**, **`TerminalCaptureTool`**, **`VerifyPlanExecutionTool`**, **`WorkflowTool`**: each gated by either `process.env.USER_TYPE === 'ant'` or a `feature(...)` flag (`tools.ts:23-145`); none of them affect public-build coding workflow.
- **`REPLTool`**: `src/tools/REPLTool/` (ant-only). When active, hides primitive tools `FileRead/Write/Edit, Glob, Grep, Bash, NotebookEdit, Agent` from the direct tool list (`primitiveTools.ts:29-39`); they remain reachable inside the REPL VM context (`tools.ts:267-275`).

### MCP

- **`MCPTool`** (`src/tools/MCPTool/MCPTool.ts:27`) is a **template** — actual MCP tools are constructed at runtime in `src/services/mcp/mcpClient.ts`, where `name`, `description`, `prompt`, `call`, `userFacingName`, and `mcpInfo` are all overridden. `inputSchema` is a passthrough `z.object({}).passthrough()` (`:14`) so the MCP server's own schema flows through.
- MCP tools participate in the same deny-rule filter (`tools.ts:284`), the same persistence pipeline, and the same ToolSearch deferral. They can opt-in to "always load" via `_meta['anthropic/alwaysLoad']` (`Tool.ts:594`).
- Truncation detection per tool is `isResultTruncated(output)` — `MCPTool.ts:67` calls `isOutputLineTruncated`.

### Tool result persistence

System-wide cap: `DEFAULT_MAX_RESULT_SIZE_CHARS = 50 000` (`src/constants/toolLimits.ts:13`). Per-tool: `maxResultSizeChars` (most coding tools set 100 000 — clamped down to 50 000 by `getPersistenceThreshold`, `src/utils/toolResultStorage.ts:55-78`). Read sets `Infinity` to opt out (`FileReadTool.ts:282`).

When exceeded, the result is written to `<projectDir>/<sessionId>/tool-results/<toolUseId>.{txt|json}` (`src/utils/toolResultStorage.ts:106-112`) and the model receives a 2 KB preview + a `<persisted-output>` tag with the file path. Per-message aggregate budget `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200 000` (`toolLimits.ts:48`) — when N parallel tools collectively exceed this, the largest are persisted first.

A `ContentReplacementState` (`Tool.ts:284-293`) tracks per-conversation-thread budget so subagents inherit the parent's decisions.

---

## Context

### System-prompt assembly

- Entry point: `getSystemPrompt(...)` in `src/constants/prompts.ts:444`. Returns a `SystemPrompt` (typed `string[]`, `src/utils/systemPromptType.ts`).
- Prompt is split with the marker `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` (`prompts.ts:107`). Everything before the marker is **statically cacheable across orgs** (`scope: 'global'`), everything after is per-session/dynamic.
- Splitting logic: `splitSysPromptPrefix` (`src/utils/api.ts:321`). Three modes:
  1. MCP present → org-scope only (`:330`).
  2. Boundary-marker mode (1P only) → 4 blocks: attribution / prefix / static-global / dynamic.
  3. Default (3P / no boundary) → 3 org-scoped blocks.
- Cache TTL: `getCacheControl({...})` (`src/services/api/claude.ts:359`) — `ephemeral` with optional `ttl: '1h'` selected via `should1hCacheTTL` (`:401`); allowlist + ant/subscriber gating; latched in bootstrap state for session stability so mid-session GrowthBook flips don't bust cache (`:413-422`).
- Tool prompts are per-tool: `tool.prompt(...)` (`Tool.ts:597`) — each tool has its own `prompt.ts`. The full system call assembles them in `claude.ts:buildSystemPromptBlocks` (`:3213`).

### Per-turn output budget

- `getMaxOutputTokensForModel(model)` (`src/services/api/claude.ts:3399`); env override `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (`:3413`).
- Compaction reserves `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20 000` (`src/services/compact/autoCompact.ts:31`, p99.99 of compaction summary output).
- When output is hit-capped: stop reason `max_tokens` is logged with a hint to set the env var (`claude.ts:2266-2274`).

### Compaction

- **Auto-compact**: `src/services/compact/autoCompact.ts`. Threshold = effective context window − `AUTOCOMPACT_BUFFER_TOKENS = 13 000` (`:60`). Effective window = model context − reserved-summary tokens (`:35`). Env overrides `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. Circuit-breaker: stops trying after `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (`:65`) — addresses past bug where 1 279 sessions had 50+ failures.
- **Microcompact** (per-turn): `src/services/compact/microCompact.ts`. Goal is to remove tool-result content (file reads, bash output, grep, glob, web fetch, edit, write) from old turns while keeping the cache warm. Two paths:
  1. **Time-based** (`:166`): if the gap to the last assistant message exceeds the threshold, the server cache has expired anyway → content-clear old tool results before sending. `[Old tool result content cleared]` placeholder (`:35`).
  2. **Cached microcompact** (`:185`): uses Anthropic's cache-editing API to remove tool results from the server-side cache without invalidating the prefix. Gated by feature `CACHED_MICROCOMPACT` and model support. Pinned per `userMessageIndex` so subsequent calls re-send the same cache_edits at the same positions (`pinCacheEdits`, `:113`).
- **Compactable tool set** (`:39-49`): `Read`, all `SHELL_TOOL_NAMES` (Bash/PowerShell), `Grep`, `Glob`, `WebSearch`, `WebFetch`, `Edit`, `Write`. Other tool results (Agent, AskUser, etc.) are preserved.
- **Manual compact** (`/compact`): `src/services/compact/compact.ts:compactConversation`, `MANUAL_COMPACT_BUFFER_TOKENS = 3 000`. Strips images before summarising (`:46-92`). After compact, restores up to `POST_COMPACT_MAX_FILES_TO_RESTORE = 5` recently-edited files (`:122`) within `POST_COMPACT_TOKEN_BUDGET = 50 000` (`:123`), capped at `POST_COMPACT_MAX_TOKENS_PER_FILE = 5 000`. Skills are re-injected up to `POST_COMPACT_SKILLS_TOKEN_BUDGET = 25 000` with per-skill cap `POST_COMPACT_MAX_TOKENS_PER_SKILL = 5 000` (`:128-130`).
- **Session memory compact**: `sessionMemoryCompact.ts` — separate path for summarising into a persistent session-memory file.

### Read-dedup / freshness

- `readFileState: FileStateCache` (LRU 100 entries / 25 MB, `fileStateCache.ts:18-22`). Holds `{content, timestamp, offset, limit, isPartialView}`.
- `Read` returns a `file_unchanged` stub (no re-emission of content) when same-range + same-mtime (`FileReadTool.ts:386-432`). Killable via GB flag `tengu_read_dedup_killswitch`. **Only** dedups actual prior Reads — Edit/Write entries are not deduped against (their `offset === undefined`).
- `Edit`/`Write` enforce read-before-edit AND a stale-mtime check; if mtime advanced since the last Read, the model is told to re-read (`FileEditTool.ts:225-244`). On Windows, falls back to content-equality if mtime advanced spuriously (cloud-sync, antivirus).

### Tool-doc rendering / ToolSearch deferral

- Each tool's `prompt()` returns its description block; the API request bundles them into `tools` with optional `defer_loading: true` for tools where `shouldDefer === true` and `isToolSearchEnabled()` returns true (`src/utils/toolSearch.ts:385`).
- Deferred tools require a `ToolSearchTool` round-trip first; the tool returns an array of `tool_reference` blocks naming the tools to load (`ToolSearchTool.ts:481-492`). Auto-trigger char threshold per model: `getAutoToolSearchCharThreshold` (`src/utils/toolSearch.ts:115`).
- `alwaysLoad` (`Tool.ts:594`) opts a tool back into eager loading even with ToolSearch on.

### Prompt cache

- `cache_control: { type: 'ephemeral', ttl?: '1h', scope?: 'global' }` (`claude.ts:359-373`).
- Cache breakpoints set on tool definitions, system prompt prefix, and final user message (`claude.ts:603-663`).
- Built-ins are sorted alphabetically and form a contiguous prefix; MCP tools sort after (`tools.ts:303-316`) — keeps the tool-list prefix cache stable when MCP tools change.
- Forked subagents share the parent's `renderedSystemPrompt` (`Tool.ts:316-322`) so their requests hit the parent's cache.

---

## Coding

### Edit safety
- **Read-before-edit**: enforced for Edit, Write, NotebookEdit (`FileEditTool.ts:198`, `FileWriteTool.ts:198`). Failure surface message: "File has not been read yet."
- **Stale-file check**: mtime+content (`FileEditTool.ts:225-244`). Windows fallback to content equality.
- **Atomic write**: `writeTextContent` (`src/utils/file.ts`) uses an atomic temp+rename. The Edit body is annotated "avoid async ops between staleness check and writeTextContent" (`FileEditTool.ts:319`).
- **Fuzzy matching**: `findActualString` (`utils.ts`) normalises straight ↔ curly quotes so the model can supply either (`FileEditTool.ts:251`). `preserveQuoteStyle` keeps the file's original quote style on write.
- **Multi-match guard**: if `old_string` matches >1 location and `replace_all !== true`, the call fails with `errorCode: 9` and an instructional message (`FileEditTool.ts:265-275`).
- **Settings-file guard**: simulated post-edit content is run through `validateInputForSettingsFileEdit` and rejected if it would corrupt `settings.json` (`:285`).
- **Post-write verification**: LSP `didChange`+`didSave` notifications (`:373-388`); `clearDeliveredDiagnosticsForFile` so the model gets fresh diagnostics. `notifyVscodeFileUpdated` for IDE diff view (`:391`). No syntax check / no formatter run by the tool itself.
- **Single-edit-per-call**: Edit takes one `(old_string, new_string)` pair. There is no `MultiEdit`/multi-hunk API in this revision (the schema is `strict` so the model cannot smuggle one in).
- **File history**: `fileHistoryTrackEdit` captures pre-edit content (`fileHistoryEnabled()`-gated, `FileEditTool.ts:333`), enabling undo.
- **No syntax/lint check** is performed inline by Edit/Write. Diagnostics arrive asynchronously through LSP.

### File-state cache
- `FileStateCache` (`src/utils/fileStateCache.ts:30`): LRU keyed by normalized absolute path; stores `{content, timestamp, offset, limit, isPartialView}`. Used by:
  - `Read` for dedup.
  - `Edit`/`Write` for read-before-edit + staleness.
  - `NotebookEdit` for the same.
- `cloneFileStateCache` (`:122`) for subagent forks.

### Multi-file patches
- **Not supported** as a single tool call. Edit operates on one file × one match. Coordination across files is the model's responsibility (often through `Agent` / sub-agent batches).
- Searched: `src/tools/FileEditTool/`, `src/tools/FileWriteTool/`, `src/tools/NotebookEditTool/` — no multi-edit shape; no `MultiEdit` tool exported from `tools.ts`.

### Concurrency
- `Tool.isConcurrencySafe(input)` (`Tool.ts:560`). Read/Glob/Grep/AskUser/PlanMode return `true`; Edit/Write/Bash do not.
- Parallel tool calls within a turn are gated by this flag — only concurrency-safe tools run in parallel; others are serialised.
- File-state cache writes are synchronous around the disk write to keep mtime/timestamp consistent.

### Sandbox / backend support
- **Worktrees**: `EnterWorktreeTool` + `Agent(isolation: 'worktree')` (`AgentTool.tsx:114`). Worktree creation/teardown in `src/utils/worktree.ts` (`createAgentWorktree`, `removeAgentWorktree`, `hasWorktreeChanges`).
- **Containers**: no built-in container backend in this source; the sandbox is OS-level (Linux landlock / macOS sandbox-exec via `src/utils/sandbox/sandbox-adapter.ts`, used only inside `Bash`).
- **Remote execution**: `Agent(isolation: 'remote')` via `src/tasks/RemoteAgentTask/RemoteAgentTask.ts` (gated by `USER_TYPE === 'ant'`); also `src/remote/RemoteSessionManager.ts` for full remote sessions over WebSocket.
- **Permission modes**: `default | plan | bypass | ...` (`src/types/permissions.ts`); plan mode is a first-class state, with `prePlanMode` saved for restoration.

### Plan mode
- `EnterPlanMode` (zero args) → plan mode (`EnterPlanModeTool.ts:79-94`). All tool-results during plan mode include "DO NOT write or edit any files yet" instructions.
- `ExitPlanModeV2` shows the plan (read from a fixed plan file in the plans directory) for user approval before exiting.

### Prompt-injection defence
- **No content-level sanitisation** on file reads or web fetches. Searched `src/tools/FileReadTool/` and `src/tools/WebFetchTool/` for `injection`, `sanitize`, `prompt-injection` — no matches.
- Cyber-risk reminder is appended to every Read text result instructing the model to refuse to "improve or augment" malware-looking code (`FileReadTool.ts:738-742`); this is a model-behaviour nudge, not a sanitiser.
- WebFetch runs the user's prompt against fetched markdown via a Haiku subagent (`WebFetchTool/utils.ts:484`); the inner subagent's system prompt is the entire defence — there is no allow-list / regex stripping of injected instructions.

### Secret redaction
- **Team-memory write guard**: `checkTeamMemSecrets` (`src/services/teamMemorySync/teamMemSecretGuard.ts:15`) blocks Edit/Write of files inside team-memory paths if the content matches `scanForSecrets` patterns (Anthropic key prefixes etc., feature `TEAMMEM`-gated). Surface message names the matched labels.
- **Bash env-key allowlist**: `bashPermissions.ts:402-496` lists `ANTHROPIC_API_KEY`, `GROWTHBOOK_API_KEY`, … as protected; commands referencing them require permission.
- **No general output-redaction**: there is no global "redact secrets in tool results" pass. A Read of a `.env` file returns the raw bytes (subject to permission). The cyber-risk system reminder doesn't redact either.

### Notable bonus features
- **Slash-skill discovery on touch**: any Read/Edit/Write of a file under a directory containing a `SKILL.md` auto-loads that skill into the session (`FileReadTool.ts:438-451`, same in Edit/Write).
- **Dedup as cost optimisation**: documented Big-Query measurement at `FileReadTool.ts:380-388` — ~18% of Reads were same-file collisions, ~2.64% of fleet `cache_creation` tokens.
- **Cyber-risk reminder model carve-out**: skipped on `claude-opus-4-6` (`FileReadTool.ts:746`).
- **Parallel-tool-result aggregate budget**: enforced per single user message, not just per tool result (`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200 000`, `toolLimits.ts:48`) — prevents N parallel tools from blowing the turn.
- **REPL primitive hiding**: when REPL is on, primitive tools are removed from the model-visible list but kept reachable inside the REPL VM (`primitiveTools.ts:29-39`, `tools.ts:267`).

---

## Discrepancies vs comparison.md

Read `criteria.md` and the Claude-Code-relevant sections of `comparison.md` only after writing the inventory above. The independent audit largely agrees, but the following items in `comparison.md` are inaccurate, incomplete, or worth flagging:

1. **Read byte cap, 256 KB vs 250 KB.** `comparison.md:168` cites "256 KB by bytes". The constant is `MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024` (`src/utils/file.ts:48`) — i.e. **262 144 bytes (256 KiB)**. The header comment in `src/tools/FileReadTool/limits.ts:6` documents it as "256 KB". Both correct in spirit but the doc-block in `limits.ts` flags it as gating on **total file size**, not the slice — a non-trivial caveat omitted from `comparison.md`.

2. **Microcompact compactable tool set is broader than listed.** `comparison.md:164` lists `FILE_READ, SHELL, GREP, GLOB, WEB_SEARCH, WEB_FETCH, FILE_EDIT, FILE_WRITE`. Source confirms this exact set in `src/services/compact/microCompact.ts:39-49` — accurate. However `comparison.md` does not mention that microcompact has **two distinct paths** (time-based vs cached, with `pinCacheEdits` for cache-stable re-injection) — material for the A6/A3 axes.

3. **Autocompact thresholds.** `comparison.md:165` says "warning + error thresholds at 20000" — both `WARNING_THRESHOLD_BUFFER_TOKENS` and `ERROR_THRESHOLD_BUFFER_TOKENS` are indeed 20 000 (`autoCompact.ts:63-64`). Confirmed; no discrepancy. But the circuit-breaker line number is `:70` in source, vs `comparison.md` citing `line 70` correctly — accurate.

4. **Plan mode framing — "distinct from a static blocklist" is overstated.** `comparison.md:178` says the permission classifier "evaluates per-call" instead of using a static blocklist. In source, plan-mode is implemented through `permissionSetup.ts` mode transitions (`src/utils/permissions/permissionSetup.ts:602-641`) that gate which tools/actions are enabled. The classifier is real but the practical effect on the model is closer to a curated read-only toolset. The comparison overstates the dynamism.

5. **Edit "post-edit git-diff fetched for verification" is mis-stated.** `comparison.md:172` implies a git-diff is fetched as verification. The Edit tool emits a `gitDiff` field in its **structured output to the model** (`FileEditTool.ts:402-411`) — it's a pretty diff for the agent's benefit, not a verification step. Real post-edit verification is LSP `didChange/didSave` (`:373-388`) and that is **asynchronous** — diagnostics arrive on a later turn, not bound to the edit's tool result. C5 (post-edit verification) credit should be qualified: there is **no inline syntax/lint check** by Edit/Write themselves.

6. **"Forked subagent gets byte-exact prompt" requires a feature flag.** `comparison.md:176` and `:344` describe fork-subagent as a top-line capability. `forkSubagent.ts` requires `isForkSubagentEnabled()` (referenced from `AgentTool.tsx:51,115`) — gated behind the `FORK_SUBAGENT` GrowthBook feature. Worth noting in scoring.

7. **Read dedup scope.** `comparison.md:168` describes the dedup as a "file-state cache returns an unchanged stub for repeated reads of the same range." Source confirms — but only for entries whose `offset !== undefined` (`FileReadTool.ts:386-432`). I.e. dedup **only** triggers against prior Reads, not against the file-state entries planted by Edit/Write, so an Edit-then-Read does **not** get deduped. This subtlety affects A5 scoring; `comparison.md` doesn't surface it.

8. **Multi-file patches — Claude Code has none.** `comparison.md` doesn't claim Claude Code has a multi-file patch tool, which is correct. The C2 axis (`criteria.md` Group C) credits "V4A multi-file patches" to Hermes; Claude Code has **only single-edit-per-call** Edit. This audit confirms — searched `tools.ts`, `FileEditTool/`, `FileWriteTool/`, `NotebookEditTool/` and found no `MultiEdit`/`patch`/`apply_patch` shape. Not a discrepancy in `comparison.md`, but worth pinning explicitly.

9. **Prompt-injection defence — `comparison.md` overscores.** `comparison.md:117` lists "prompt-injection defense" as a Hermes/CC strength relative to Bobbit. For Claude Code, this audit found **no content-level sanitisation** of file reads or web fetches; the only defence is a model-behaviour reminder appended to text Reads (`FileReadTool.ts:738`) and the WebFetch internal-prompt design (`WebFetchTool/utils.ts:484`). F2 credit should be modest — there is no AGENTS.md/CLAUDE.md scanning, no "ignore previous instructions" detection, no hidden-Unicode or curl-exfil pattern check.

10. **Secret redaction is asymmetric.** `comparison.md` does not separately discuss secret redaction. Source has a **write-side guard** for team-memory files (`teamMemSecretGuard.ts:15`) and an env-key allowlist in `bashPermissions.ts:402-496` — but **no general output redaction**, so Read of a `.env` returns the raw bytes (subject to permission). F1 should reflect this asymmetry: protected on write/exec, not on read.

11. **Per-turn aggregate budget — not surfaced in `comparison.md`.** A4 (per-turn output budget) is one of `criteria.md`'s explicit dimensions. Claude Code has `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200 000` (`toolLimits.ts:48`), with biggest-first persistence to `<projectDir>/<sessionId>/tool-results/<toolUseId>.{txt|json}` (`toolResultStorage.ts:106-112`). `comparison.md`'s prose on Claude Code (lines 157-184) does not mention this aggregate budget — Claude Code deserves a top mark on A4 that the comparison narrative under-credits.

12. **Skill-on-touch discovery is missing from `comparison.md`'s Claude Code section.** Every Read/Edit/Write fires `discoverSkillDirsForPaths` and `activateConditionalSkillsForPaths` (`FileReadTool.ts:438-451`). This is a non-trivial product-fit feature (G1) and a context-economics consideration (skills inflate context only when files in their scope are touched). `comparison.md` does not credit it.

13. **Cyber-risk reminder appended to every text Read** (`FileReadTool.ts:738-742`) is a context-cost worth noting on A1; `comparison.md` does not mention it. Skipped on `claude-opus-4-6` (`:746`), so the cost is model-dependent.

No factual claims in `comparison.md`'s Claude Code paragraphs (lines 157-184) appear to be wrong on a load-bearing axis. The discrepancies above are mostly **omissions** and **overstatements** rather than misrepresentations.

