# Hermes Agent — Capability Audit

**Source audited:** `/Users/aj/Documents/dev/hermes-agent` (HEAD `69d4800d`, package `hermes-agent==0.11.0`, Python ≥ 3.11). All citations are `path:line` in that tree. Built bottom-up from source; comparison docs read only at the cross-check step.

## Preamble — shape of the codebase

Hermes is a single Python package, not a thin gateway around a library. The agent loop, model providers, prompt assembly, compaction, tools, file-state coordinator, and sandbox/backend abstraction are all in-repo. The coding-relevant surface is concentrated in:

- **Tool registry**: `tools/registry.py` — every tool self-registers at module import via `registry.register(...)`. Auto-discovered by AST-scanning every `tools/*.py` for top-level `registry.register` calls (`tools/registry.py:43-72`). Per-tool `max_result_size_chars`, `check_fn` (TTL-cached for 30 s, `:107-127`), `is_async`, `requires_env`.
- **File toolchain**: `tools/file_tools.py`, `tools/file_operations.py`, `tools/fuzzy_match.py`, `tools/patch_parser.py`, `tools/file_state.py`, `tools/binary_extensions.py`, `agent/file_safety.py`.
- **Shell/sandbox**: `tools/terminal_tool.py` (one tool, seven backends), `tools/environments/`.
- **Context economics**: `agent/context_compressor.py` (default engine), `agent/context_engine.py` (pluggable interface), `agent/prompt_builder.py`, `agent/prompt_caching.py`, `tools/budget_config.py`, `tools/tool_result_storage.py`, `tools/tool_output_limits.py`.
- **Defence in depth**: `agent/redact.py`, `tools/tirith_security.py`, `tools/url_safety.py`, `tools/website_policy.py`, `agent/file_safety.py`.

Hermes also ships voice/cron/RL/datagen/memory/skills/MCP — out of scope for this audit (the brief excludes them). Coding-relevant tools are explicitly enumerated below.

---

## Tools

All registrations are auto-discovered (`tools/registry.py:55-72`). The registry returns OpenAI-format schemas via `get_definitions()` (`:288-321`); MCP tools are added dynamically via `tools/mcp_tool.py:2708/2744` with per-server toolset names `mcp-<server>` and a deregister-on-refresh path (`registry.py:259-279`).

### Read family

#### `read_file`
- **Defined**: handler `tools/file_tools.py:374-559`; schema `:1057-1071`; registration `:1119`.
- **Inputs**: `path`, `offset` (default 1, ≥1), `limit` (default 500, max 2000 — clamped via `normalize_read_pagination` at `tools/file_operations.py:281-302` against `tool_output.max_lines`).
- **Output**: line-numbered `LINE_NUM|CONTENT` (impl `_add_line_numbers`, `file_operations.py:421-432`); per-line cap `MAX_LINE_LENGTH=2000` chars with `... [truncated]` suffix; **read-size guard rejects** any read whose formatted content exceeds `_get_max_read_chars()` (default 100 000; configurable via `file_read_max_chars`, `file_tools.py:33-66`). Image extensions return base64 instead (`file_operations.py:414-418` + `IMAGE_EXTENSIONS`).
- **`max_result_size_chars`** registered as `float('inf')` to opt out of persistence (`file_tools.py:1119`); pinned by `tools/budget_config.py:13` so it can never be overridden — prevents persist→read→persist loops.
- **Device-path guard**: `_BLOCKED_DEVICE_PATHS` (`file_tools.py:79-90`) blocks `/dev/zero`, `/dev/{stdin,tty,console,…}`, `/proc/<pid>/fd/{0,1,2}` to prevent the agent from hanging on infinite-output or input-blocking devices; pure path check, no symlink resolve.
- **Binary guard**: `tools/binary_extensions.py` extension list, rejected with a "use vision_analyze" hint (`file_tools.py:391-398`).
- **Hermes-internal cache guard**: `agent/file_safety.py:96-114` — `~/.hermes/skills/.hub` and `index-cache` paths refuse reads ("prevent prompt injection").
- **Read dedup**: per-task `_read_tracker` keyed `(resolved_path, offset, limit) → mtime` (`file_tools.py:160-200`). On a re-read of an unchanged file, returns `_READ_DEDUP_STATUS_MESSAGE` stub instead of bytes (`:425-442`). After 2 stub returns the same key, escalates to a hard-block `BLOCKED:` error (`:415-430`). Dedup cache cleared on context compression (`reset_file_dedup`, `:579-606`; called from `run_agent.py:8993-8994`).
- **Loop guard (real reads)**: `consecutive` counter — same `read_key` 3 times → `_warning`; 4 times → hard-block (`file_tools.py:506-525`). Counter reset by `notify_other_tool_call(task_id)` whenever a non-read/non-search tool runs (`:608-627`).
- **Cross-agent file-state stamp**: every successful read calls `file_state.record_read(task_id, resolved, partial=…)` (`file_tools.py:480-484`), planting `(mtime, read_ts, partial)` in a process-wide registry for sibling-subagent staleness detection.
- **Redaction**: every read result passes through `redact_sensitive_text` after the size guard (`file_tools.py:441-443`), but only if `HERMES_REDACT_SECRETS=1` / `security.redact_secrets: true` — opt-in (`agent/redact.py:62`).
- **Large-file hint**: when `file_size > 512_000` and the caller didn't narrow (`limit > 200`) and the read truncated, append `_hint` field nudging at offset/limit (`file_tools.py:445-457`).

#### `search_files` (grep + find combined)
- **Defined**: handler `tools/file_tools.py:861-933`; schema `:1037-1054`; registration `:1122`.
- **Inputs**: `pattern`, `target` (`content`/`files`; legacy `grep`/`find` mapped at `:1110-1112`), `path`, `file_glob`, `limit` (default 50), `offset`, `output_mode` (`content|files_only|count`), `context`. Truncation appends `[Hint: Results truncated. Use offset=N…]` (`:927-930`).
- **Backend**: ripgrep via `ShellFileOperations._search_*` (`file_operations.py:996-1043`); falls back to `find` only if `rg` is missing.
- **Loop guard**: same `_read_tracker` consecutive-key mechanism (`file_tools.py:879-897`); `count >= 4` ⇒ hard-block, `>= 3` ⇒ warning. `max_result_size_chars=100_000`.

### Edit / Write family

#### `write_file`
- **Defined**: handler `file_tools.py:736-787`; schema `:1073-1083`; registration `:1120`.
- **Pipeline**: `_check_sensitive_path` (`:135-152`, blocks `/etc/`, `/private/etc/`, `/usr/lib/systemd/`, `/private/var/`, exact `/var/run/docker.sock` etc.) → `_is_internal_file_status_text` (`:202-235`, refuses to write our own dedup-stub message back as file content) → resolve path → `file_state.lock_path(resolved)` (per-path `threading.Lock`, `file_state.py:64-83`) → `file_state.check_stale(task_id, resolved)` cross-agent registry → per-task `_check_file_staleness` mtime drift check → `file_ops.write_file` → `_update_read_timestamp` + `file_state.note_write`.
- **Cross-agent staleness** (`file_state.py:120-200`): three classes ranked — sibling subagent wrote, external mtime drift, never-read. Returns a model-facing `_warning` (does not block).
- **Per-task staleness** (`file_tools.py:677-707`): warns when `os.path.getmtime` drifted from the value stamped at last read; cleared by `_update_read_timestamp` after a successful write. **Warns, does not block.** Write proceeds either way.
- **Write deny-list**: `agent/file_safety.py:23-66` — `~/.ssh/{authorized_keys,id_rsa,id_ed25519,config}`, `~/.aws`, `~/.kube`, `~/.gnupg`, `~/.docker`, `~/.config/gh`, `/etc/sudoers`, `/etc/passwd`, `/etc/shadow`, `~/.bashrc/.zshrc/.profile/.netrc/.npmrc/.pypirc`, plus all directories under `~/.ssh/`, `/etc/sudoers.d`, `/etc/systemd`. Also a `HERMES_WRITE_SAFE_ROOT` opt-in chroot (`file_safety.py:67-93`).
- **`max_result_size_chars=100_000`** (registry.py default route via `BudgetConfig.resolve_threshold`).

#### `patch` (replace mode + V4A multi-file mode)
- **Defined**: handler `file_tools.py:790-859`; schema `:1085-1105`; registration `:1121`.
- **Modes**: `replace` (single file find-and-replace) or `patch` (V4A multi-file). For V4A, paths are extracted from the body via regex (`r'^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$'`, `:797-799`) and each undergoes the sensitive-path check.
- **Multi-file lock acquisition**: paths sorted ascending, locked in order via `ExitStack` to prevent deadlock when two agents patch overlapping multi-file V4A blocks (`file_tools.py:818-826`).
- **Fuzzy matching**: 9-strategy chain in `tools/fuzzy_match.py:50-110` — `exact`, `line_trimmed`, `whitespace_normalized`, `indentation_flexible`, `escape_normalized`, `trimmed_boundary`, `unicode_normalized`, `block_anchor`, `context_aware`. Multi-occurrence ⇒ explicit error unless `replace_all=True` (`:91-95`).
- **Escape-drift guard**: when a non-`exact` strategy matches and `new_string` contains `\'` or `\"` that don't exist in the matched region, the patch is rejected with a tool-call-serialization-drift error (`fuzzy_match.py:112-150`).
- **Unicode normalization**: smart quotes / em-dashes / NBSP → ASCII (`fuzzy_match.py:34-48`).
- **Did-you-mean hints** on miss: `format_no_match_hint` in `tools/fuzzy_match.py` (referenced at `file_operations.py:783, 791`); generic hint added at `file_tools.py:851-857` if not already attached.
- **Post-edit syntax check**: `_check_lint` (`file_operations.py:853-883`) runs the per-extension linter from `LINTERS = {.py: 'python -m py_compile', .js: 'node --check', .ts: 'npx tsc --noEmit', .go: 'go vet', .rs: 'rustfmt --check'}` (`:261-267`); result returned as `lint:` field in `PatchResult` (`:116`). Skipped when no linter matches the extension or the command isn't installed.
- **Atomic write?**: writes are routed through `ShellFileOperations.write_file` which uses `cat > FILE` heredoc into the sandbox — **not** a tmp+rename atomic dance.
- **V4A parser**: `tools/patch_parser.py:241-555`. Iterative window-based fuzzy search (`:486-555`), apply by collecting (`Add File`, `Update File`, `Delete File`) operations.

### Shell

#### `terminal`
- **Defined**: handler `tools/terminal_tool.py:1556-2080`-ish (the `terminal_tool` function); schema `:2241-2298`; registration `:2299-2307` with `max_result_size_chars=100_000`.
- **Inputs**: `command`, `background` (bool), `timeout`, `workdir`, `pty` (bool), `notify_on_complete`, `watch_patterns`.
- **Output cap**: `MAX_OUTPUT_CHARS = get_max_bytes()` (default 50 000, configurable via `tool_output.max_bytes`, `tools/budget_config.py:39`); **head 40 % / tail 60 % truncation** with explicit `[OUTPUT TRUNCATED — N chars omitted]` notice (`:2031-2041`).
- **Post-processing pipeline**: ANSI strip (`tools/ansi_strip.py`, `:2046`) → `redact_sensitive_text` (`:2049`) → `_interpret_exit_code` to label expected non-zero codes (`grep=1` etc., `:1428-1490`).
- **Sudo handling**: `_transform_sudo_command` rewrites real `sudo` invocations to a managed flow; `_handle_sudo_failure` and `_prompt_for_sudo_password` walk the user through approval (lines 357-450 region).
- **Approval callback**: `_get_approval_callback` (`:242`) reads a `threading.local()`-stored CLI callback installed at session start (`tools/approval.py`).
- **Background processes**: handed to a separate `tools/process_registry.py` (registers tool `process` at `:1429`, separate registration) — the `terminal` tool itself dispatches background commands there.

### Backends (composed under `terminal`)

`_get_env_config` / `_create_environment` (`terminal_tool.py:971-1213`) routes to one of seven backends:

| Backend | Notes |
|---|---|
| `local` | Default; persistent or one-shot (`local_persistent`). |
| `docker` | `find_docker` autodetect; `docker_volumes`, `docker_mount_cwd_to_workspace`, `docker_run_as_host_user`, `docker_forward_env`. |
| `singularity` (apptainer) | `:1113-1119`; preflight check. |
| `ssh` | `host`, `user`, `port`, `key`, `persistent`. |
| `modal` | `managed` (Nous gateway) vs `direct` (modal SDK) modes; preflight at `:1120-1170`. |
| `daytona` | API-key gated. |
| `vercel_sandbox` | Runtime-aware preflight (`_check_vercel_sandbox_requirements`, `:128-180`). |

`tools/file_operations.py:373` (`ShellFileOperations`) is the abstraction — every file tool ultimately runs as a shell command in the chosen backend, so the same `read_file`/`write_file`/`patch`/`search_files` work uniformly across local, container, and remote.

### Delegation

#### `delegate_task`
- **Defined**: schema and handler in `tools/delegate_tool.py`; registration `:2514-2533`.
- **Inputs**: `goal`, `context`, `toolsets[]` (default inherits parent), `tasks[]` (parallel batch), `max_iterations`, `acp_command`/`acp_args` (override transport — children can be `claude --acp --stdio` or any ACP-capable agent), `role` (`"leaf"`/`"orchestrator"`).
- **Blocked tools** for children regardless of toolsets: `delegate_task` (no recursion for `leaf`), `clarify`, `memory`, `send_message`, `execute_code` (`delegate_tool.py:38-46`).
- **Orchestrator depth**: `delegation.max_spawn_depth` (default 2); `orchestrator_enabled` global kill switch (`:427-440`).
- **Worker thread approval**: `ThreadPoolExecutor(initializer=_set_subagent_approval_cb, …)` so subagents get a non-interactive `_subagent_auto_deny` (or opt-in `_subagent_auto_approve`) callback installed in their `threading.local()` (`:48-100, 1420`). Without this the parent TUI's `prompt_toolkit` deadlocks on stdin.
- **Cross-agent file-state**: at spawn time the parent records `since_ts`; on completion `file_state.writes_since(parent_id, since_ts, parent_reads)` returns `{child_id: [paths]}` for any sibling-modified files the parent had read, appended to the delegation result reminder.
- **Subagent context**: fresh conversation, own `task_id`, own terminal session/file-ops cache. Parent only sees the call and the summary.

### MCP

`tools/mcp_tool.py` (3 140 lines). Dynamic schema ingestion: `_build_schema_from_mcp_tool` (`:2480-2495`); per-server toolset name (`mcp-<server>`); aliases via `register_toolset_alias` (`:2756`); event-loop kept alive as a self-registered tool (`:1849`); supports `notifications/tools/list_changed` to nuke-and-repave (`registry.py:259-279`).

### Misc coding-relevant tools (registered, not deep-dived)

| Tool | File:line | Notes |
|---|---|---|
| `execute_code` | `tools/code_execution_tool.py:1599` | Sandboxed Python/JS exec; subagent-blocked. |
| `process` | `tools/process_registry.py:1429` | Long-running background processes (start/stop/list/logs). |
| `todo` | `tools/todo_tool.py:270` | Per-session task list. |
| `memory` | `tools/memory_tool.py:571` | Persistent memory; subagent-blocked. |
| `clarify` | `tools/clarify_tool.py:132` | Ask the user; subagent-blocked. |
| `skills_list` / `skill_view` | `tools/skills_tool.py:1477, 1508` | Tier-1/2 skill discovery. |
| `skill_manage` | `tools/skill_manager_tool.py:865` | Skill CRUD. |
| `session_search` | `tools/session_search_tool.py:580` | Cross-session transcript recall. |
| `web_search` / `web_extract` | `tools/web_tools.py:2133, 2143` | DDG/Exa/Firecrawl-backed; URL-safety policy in `tools/url_safety.py`, `tools/website_policy.py`. |
| `browser_*` (10 tools) | `tools/browser_tool.py:2911-2985`, `:browser_cdp_tool.py:550`, `:browser_dialog_tool.py:137` | Playwright; `navigate`, `snapshot`, `click`, `type`, `scroll`, `back`, `press`, `get_images`, `vision`, `console`, `cdp`, `dialog`. |
| `mixture_of_agents` | `tools/mixture_of_agents_tool.py:533` | Voting ensemble. |
| `image_generate` | `tools/image_generation_tool.py:994` | Provider-routed image gen. |

### Tool-result persistence

`tools/tool_result_storage.py` is the layer-2/3 system:

- **Layer 2** (`maybe_persist_tool_result`, `:118-176`): per-tool threshold from `BudgetConfig.resolve_threshold(name)` (default 100 000 chars; `read_file` pinned to `inf` so it never persists). Over-cap output is written into the **sandbox** at `${TMPDIR}/hermes-results/<tool_use_id>.txt` via `env.execute()` heredoc — works on every backend (`:74-87`). The model gets a `<persisted-output>` block with original size, file path, and a 1 500-char preview (`generate_preview`, `:60-69`; `_build_persisted_message`, `:90-114`).
- **Layer 3** (`enforce_turn_budget`, `:178-226`): aggregate budget per assistant turn = 200 000 chars (`DEFAULT_TURN_BUDGET_CHARS`, `tools/budget_config.py:19`). When exceeded, the largest non-persisted results are persisted first, biggest-first, until under budget.
- **Per-tool override** comes from `registry.get_max_result_size(name, default)` (`registry.py:336-344`). RL-environment level overrides via `BudgetConfig.tool_overrides`.

---

## Context

### System-prompt assembly
- Entry point: `AIAgent._build_system_prompt` (`run_agent.py:4733-4892`). Cached on `self._cached_system_prompt`, only rebuilt after compression (`:2304` reset). **Stable across all turns in a session — maximises prefix-cache hits.**
- Layer order:
  1. **Identity** — `SOUL.md` if present (`agent/prompt_builder.py:load_soul_md`), else `DEFAULT_AGENT_IDENTITY` (`prompt_builder.py:139-152`).
  2. `HERMES_AGENT_HELP_GUIDANCE` pointer (`prompt_builder.py:154`).
  3. **Tool-conditional guidance** — `MEMORY_GUIDANCE`, `SESSION_SEARCH_GUIDANCE`, `SKILLS_GUIDANCE` injected only if the corresponding tool is loaded (`run_agent.py:4770-4779`).
  4. **Model-conditional guidance** — `TOOL_USE_ENFORCEMENT_GUIDANCE` for matched models (`prompt_builder.py:200-217`); `GOOGLE_MODEL_OPERATIONAL_GUIDANCE` for gemini/gemma; `OPENAI_MODEL_EXECUTION_GUIDANCE` (~80 lines, tool-persistence/verification/missing-context blocks) for `gpt`/`codex` (`prompt_builder.py:222-291`).
  5. Caller-supplied `system_message`.
  6. **Memory blocks** — `format_for_system_prompt("memory")` and `("user")` from `memory_store`; plus external memory provider (`run_agent.py:4824-4848`).
  7. **Skills index** — `build_skills_system_prompt(available_tools, available_toolsets)` (`prompt_builder.py:654`); only when `skills_*` tools are present. Lists each skill's name+description from frontmatter (tier-1 progressive disclosure).
  8. **Context files** — `build_context_files_prompt` (`prompt_builder.py:1083`): SOUL.md (if not used as identity), AGENTS.md / agents.md (cwd only, no recursive walk, `:1022-1031`), `.cursorrules` + `.cursor/rules/*.mdc` (`:1053-1080`), `.hermes.md`/`HERMES.md` (cwd → ascending parents, stops at git root, `:_find_hermes_md` `:_HERMES_MD_NAMES`).
  9. **Context-file injection-scan** — every loaded context file passes through `_scan_context_content` (`prompt_builder.py:53-72`) which checks `_CONTEXT_THREAT_PATTERNS` (10 regexes: "ignore previous instructions", "do not tell the user", "system prompt override", hidden divs, `curl … $TOKEN`, `cat .env`, …) plus `_CONTEXT_INVISIBLE_CHARS` (zero-width / RTL-override). On hit → content replaced with `[BLOCKED: <file> contained potential prompt injection (<finding>). Content not loaded.]`. **Active prompt-injection mitigation at the system-prompt layer.**
  10. **Date/time + session/model/provider stamp** (`run_agent.py:4880-4892`).
  11. Provider-quirk patches (Alibaba GLM model-name override, etc., `:4886-4892`).

### Tool-doc rendering / lazy loading

- Tools are emitted as **OpenAI function-calling schemas** in the request `tools` field, not embedded in the system prompt as text — i.e. provider-side tool schema rather than per-token cost. `_format_tools_for_system_message` (`run_agent.py:3718-3741`) only runs when serialising **trajectories** for training, not at request time.
- **Skills are tier-1 lazy**: `skills_list` returns only `{name, description}` (≤1024 chars per skill, `tools/skills_tool.py:8-67, 674-740`); full body fetched on demand via `skill_view(name)` or `skill_view(name, "references/<file>.md")` for tier-3 (`:849-1000`). This is the closest Hermes equivalent to ToolSearchTool deferral; it applies to skills, not tool schemas.
- No `defer_loading: true` flag is sent on tool schemas (searched `agent/prompt_builder.py`, `agent/transports/`).

### Prompt cache

- **Anthropic-only**, `system_and_3` strategy: `agent/prompt_caching.py:42-72`. Up to **4 `cache_control` breakpoints** (Anthropic's max): system prompt + last 3 non-system messages. Marker is `{"type": "ephemeral"}` plus optional `ttl: "1h"` (`:60-62`).
- Applied at request time after deep-copy (`:55`); native-anthropic vs OpenAI-completions formats handled at `_apply_cache_marker` (`:14-39`).
- The system prompt itself is built once per session and only rebuilt after compaction (`run_agent.py:4737-4742`) — so the prefix is stable for full prefix-cache hits across turns.

### Per-turn output budget

- `MAX_TURN_BUDGET_CHARS = 200 000` chars aggregate across all tool results in a single assistant turn (`tools/budget_config.py:19`, enforced at `tool_result_storage.py:178-226`). Largest-first persistence — exact pattern as Claude Code's `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`.
- Per-result threshold defaults to 100 000 chars; per-tool overrides via `registry.register(..., max_result_size_chars=…)`. `read_file` pinned to `inf` (`budget_config.py:13`) so its output never gets persisted into a file the model would re-read.

### Compaction (the `ContextEngine` interface)

- **Pluggable interface** at `agent/context_engine.py:34-120`. The default is `ContextCompressor` (`agent/context_compressor.py:331+`); third-party engines (e.g. LCM) can replace it via the plugin system. Selection: `context.engine` in `config.yaml` (`context_engine.py:7-12`).
- **Trigger**: `should_compress(prompt_tokens)` (`context_compressor.py:465-487`). Threshold = `int(context_length * threshold_percent)`, **floored at `MINIMUM_CONTEXT_LENGTH`** (default `threshold_percent=0.50`, `:379, 411`). Anti-thrashing: after 2 consecutive compressions saving <10 %, compression is **skipped entirely** with a `/new` recommendation (`:476-486, 1395-1402`).
- **Failure cool-down**: `_SUMMARY_FAILURE_COOLDOWN_SECONDS = 600` (`:74`); on summary-LLM failure, `_summary_failure_cooldown_until` blocks compaction for 10 minutes (`:886-891`). Static fallback summary inserted with `_last_summary_dropped_count` reported up so the gateway can warn the user (`:447-460`).
- **Algorithm** (`context_compressor.py:328-346`):
  1. **Pruning pass** (`_prune_old_tool_results`, `:494-668`) — *no LLM call*. Three sub-passes:
     - **Pass 1**: deduplicate identical tool results by md5 (`:602-624`) — replaces older copies with `"[Duplicate tool output — same content as a more recent call]"`.
     - **Pass 2**: replace old tool results (>200 chars, outside protected tail) with informative 1-line summaries via `_summarize_tool_result` (`:204-310`) — knows `terminal`, `read_file`, `write_file`, `search_files`, `patch`, `browser_*`, `web_search`, `web_extract`, `delegate_task`, `execute_code`, `vision_analyze`, `memory`, `todo`, …; falls back to a generic shape.
     - **Pass 3**: shrink long `tool_call` arguments inside JSON via `_truncate_tool_call_args_json` (`:155-200`) — reparses, truncates string leaves to 200 chars, reserialises to keep arguments JSON-valid (a hard requirement: malformed args make MiniMax/etc. 400 every subsequent turn — see issue #11762 documented in the docstring).
  2. **Head/tail protection** — `protect_first_n=3` (system + first exchange), `protect_last_n=20`, plus a token-budget tail protection (`tail_token_budget = threshold × 0.20`, `:417-419`).
  3. **LLM summarisation** of the middle (`_generate_summary`, `:736-1000` region) using auxiliary client (cheap model). Structured template: Goal / Progress / Decisions / Resolved+Pending Questions / Files / Remaining Work. Iterative — `_previous_summary` carried forward and re-summarised across compactions. Optional `focus_topic` from `/compress <topic>` (`:782-798`).
  4. Summary budget scales: `_compute_summary_budget` (`:737-746`) = `max(2 000, min(content_tokens × 0.20, max_summary_tokens))`, where `max_summary_tokens = min(context_length × 0.05, 12 000)`.
  5. Pre-summarisation **redaction** of all message content (`_serialize_for_summary`, `:706-735`) so secrets don't leak into the summary that gets persisted across compactions.
- **Image budgeting**: `_IMAGE_TOKEN_ESTIMATE = 1600` per image part, equivalent char-budget at `_IMAGE_CHAR_EQUIVALENT = 6400` (`:64-71`) — multi-image turns aren't accidentally treated as ~0 tokens.
- **Post-compaction hooks**: `reset_file_dedup` is fired (`run_agent.py:8993-8994`) — without this, reads after compaction would return "file unchanged" stubs pointing at content no longer in context.
- **`update_model`** (`context_compressor.py:348-369`): on a model switch / fallback, recalibrates `threshold_tokens`, `tail_token_budget`, `max_summary_tokens` to the new context length. Avoids stale calibration after a 200K → 32K fallback.
- **Manual compaction**: `/compress` and `/compress <topic>`; `has_content_to_compress` (`context_engine.py:111-120`) lets the gateway preflight without an LLM call.

### Read deduplication and loop guards (recap)

- `read_file`: dedup stub on unchanged-mtime re-reads, hard-block after 2 stubs; consecutive-key warn ≥3, block ≥4 (`file_tools.py:415-525`).
- `search_files`: consecutive-key warn ≥3, block ≥4 (`:879-897`).
- Counter is **reset by any non-read/non-search tool call** via `notify_other_tool_call` (`:608-627`).
- Tracker bounded: `_READ_HISTORY_CAP=500`, `_DEDUP_CAP=1000`, `_READ_TIMESTAMPS_CAP=1000`, oldest-first eviction (`file_tools.py:127-160`).

### Image / multimodal accounting

`_content_length_for_budget` (`context_compressor.py:78-115`) walks multimodal content lists, summing `len(text)` for text parts and adding `_IMAGE_CHAR_EQUIVALENT` (≈ 1 600 tokens × 4) per `image_url` / `input_image` / `image` part — used in tail-protection budgeting.

---

## Coding

### Edit safety

| Property | Status | Where |
|---|---|---|
| Read-before-edit enforcement | **Warn-only** — writes/patches never blocked, only `_warning` field added | `file_tools.py:677-707` (per-task), `file_state.py:120-200` (cross-agent: sibling-write/external/never-read classes) |
| Stale-mtime detection | ✓ both per-task (`_check_file_staleness`, `:677-707`) and cross-agent (`check_stale`) | mtime + `read_ts` from `record_read` |
| Atomic write | ✗ `cat > FILE` heredoc into the sandbox; no temp+rename. **However**, every `patch_replace` performs a **post-write byte-for-byte read-back** and rejects the operation if the on-disk content differs from the intended write | `tool_result_storage.py:79-87`; **read-back verify** `file_operations.py:795-808` |
| Fuzzy match | ✓ 9 strategies | `fuzzy_match.py:50-110` |
| Quote/Unicode normalisation | ✓ smart quotes, em/en dashes, NBSP, ellipsis | `fuzzy_match.py:34-48` |
| Multi-occurrence handling | ✓ rejects with explicit error unless `replace_all=True` | `fuzzy_match.py:91-95` |
| Identical-string rejection | ✓ "old_string and new_string are identical" | `fuzzy_match.py:78-79` |
| Did-you-mean snippet | ✓ via `format_no_match_hint` | `file_operations.py:783-791`, `file_tools.py:851-857` |
| Escape-drift guard | ✓ blocks `\'` / `\"` artifacts on non-exact matches | `fuzzy_match.py:112-150` |
| Settings-file guard | ✗ no equivalent of CC's `validateInputForSettingsFileEdit` | searched `tools/file_tools.py`, `tools/file_operations.py` |
| Internal-status echo guard | ✓ refuses to write the dedup-stub message back as file content | `file_tools.py:202-235` |
| Sensitive write deny-list | ✓ `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `/etc/sudoers*`, `/etc/passwd`, `/etc/shadow`, `~/.npmrc`, `~/.pypirc`, `~/.docker`, etc. + opt-in `HERMES_WRITE_SAFE_ROOT` chroot | `agent/file_safety.py:23-93` |
| Sensitive system-path guard inside file-tools layer | ✓ `/etc/`, `/private/etc/`, `/usr/lib/systemd/`, `/var/run/docker.sock` | `file_tools.py:121-152` |
| Post-write syntax/lint | ✓ per-extension linter table for `.py/.js/.ts/.go/.rs`; runs synchronously after patch; result returned in `lint:` field | `file_operations.py:261-267, 853-883` |
| File history / undo | ✗ no Ctrl-Z buffer | searched `tools/file_*.py` for `history`, `backup`, `undo` |
| LSP integration | ✗ no LSP client; lint via per-language CLI subprocess only | `file_operations.py:LINTERS` |

### File-state cache / coordination

`tools/file_state.py:48-220` is a **process-wide singleton** (`_registry`) that tracks:

- `_reads: {task_id: {resolved_path: (mtime, read_ts, partial)}}` — bounded `_MAX_PATHS_PER_AGENT=4096`.
- `_last_writer: {resolved_path: (task_id, write_ts)}` — bounded `_MAX_GLOBAL_WRITERS=4096`.
- `_path_locks: {resolved_path: threading.Lock}` — per-path R/M/W critical sections.

Public API: `record_read`, `note_write`, `check_stale`, `lock_path`, `writes_since`, `known_reads`. All ops respect `HERMES_DISABLE_FILE_STATE_GUARD=1` opt-out (`:255-258`).

### Multi-file patches

- **V4A patch mode** (`tools/file_tools.py:790-859`, `tools/patch_parser.py`) accepts a multi-file `*** Begin Patch / *** Update File / *** End Patch` block with multi-hunk operations. Per-path locks acquired in **sorted order** under one `ExitStack` to avoid deadlock on overlapping multi-file patches (`file_tools.py:818-826`).
- This is a **first-class capability** that neither Bobbit nor Claude Code surfaces in their primitive tools — Hermes can apply a coherent multi-file change in one tool call.

### Concurrency

- **Per-path locks** for the read→modify→write region (`file_state.py:64-83`) — different paths run in parallel, same path serialises across threads/subagents.
- **Cross-agent staleness** via `_last_writer` registry — sibling subagent edits surface as a model-facing `_warning` on the next write/patch.
- **Subagent reminders** — `delegate_task` uses `writes_since(parent_id, since_ts, parent_reads)` to append a "subagent modified files you previously read" note to the delegation result (`tools/delegate_tool.py` flow + `file_state.py:202-220`).
- The registry has no `isConcurrencySafe` flag on tool entries (searched `tools/registry.py`); parallelism gating happens at the agent loop level (`run_agent.py:_should_parallelize_tool_batch` referenced by the file-state docstring).

### Sandbox / backend support

Seven backends behind one `terminal` tool — see the table in **Tools › Backends** above. Critically: `ShellFileOperations` makes **`read_file`/`write_file`/`patch`/`search_files` work uniformly on all of them** (`tools/file_operations.py:373-410`), so the agent's coding loop is backend-agnostic. Persisted tool results write into the **active backend's tmpdir** (`/tmp/hermes-results/<id>.txt` resolved from `env.get_temp_dir()`, `tool_result_storage.py:43-58`) so the model can `read_file` them back over the same backend.

Hermes also supports **delegation across transports**: `delegate_task(acp_command="claude", acp_args=["--acp", "--stdio"])` spawns a Claude Code subagent over ACP — handled in `acp_adapter/`, `acp_registry/`, `agent/copilot_acp_client.py`. Lets a Hermes parent orchestrate a Claude Code worker.

### Plan / read-only mode

- ✗ **No first-class plan-mode state.** Searched `agent/`, `tools/` for `plan_mode`, `read_only_mode`, `permission.*mode` — only matches are unrelated (delegation roles, model `mode`).
- The closest analogue is the `delegation` blocked-tool list (`leaf` agents lose write capability), and tool-toolset gating via config — neither equates to a runtime mode toggle.

### Prompt-injection defence

- **Active scanning of context files** at system-prompt build time — 10 regex threats (`prompt_injection`, `disregard_rules`, `bypass_restrictions`, `html_comment_injection`, `hidden_div`, `translate_execute`, `exfil_curl`, `read_secrets`, `sys_prompt_override`, `deception_hide`) plus invisible-Unicode set (zero-width, RTL/LRO override). Hits replace the file's content with a `[BLOCKED: …]` notice — **the malicious instructions never enter the prompt** (`agent/prompt_builder.py:38-72`).
- **Tirith integration** (`tools/tirith_security.py:1-285`): runs the external `tirith` binary as a subprocess to scan commands for content-level threats (homograph URLs, pipe-to-interpreter, terminal injection). Auto-installs from GitHub releases when missing. Configurable via `tirith_enabled`, `tirith_path`, `tirith_timeout`, `tirith_fail_open`.
- **URL safety / website policy** (`tools/url_safety.py`, `tools/website_policy.py`) — pre-fetch checks on web tools.
- **Internal-cache read guard** (`agent/file_safety.py:96-114`) — the model cannot read its own skill index-cache files (a documented prompt-injection vector).
- **Internal-status-echo guard** (`tools/file_tools.py:202-235`) — refuses to let the model echo the dedup-stub message back as file content.

### Secret redaction

- **Comprehensive output redaction** when enabled: `agent/redact.py` covers (i) ~30 vendor key prefixes (`sk-…`, `ghp_…`, `AIza…`, `xox[baprs]-…`, `AKIA…`, `eyJ…` JWTs, `-----BEGIN PRIVATE KEY-----`, …) (ii) ENV-style `KEY=VALUE` patterns (iii) JSON `"apiKey": "…"` fields (iv) `Authorization: Bearer …` headers (v) DB conn-string passwords (vi) URL query params (`?access_token=…&code=…`) (vii) URL `user:pass@host` userinfo (viii) form-urlencoded bodies (ix) Telegram bot tokens (x) Discord mentions (xi) E.164 phone numbers.
- Applied at: every `read_file` result (`file_tools.py:441-443`), every `terminal` output (`terminal_tool.py:2049`), every `search_files` match (`file_tools.py:911-916`), every compactor input (`context_compressor.py:706-735`).
- **`RedactingFormatter`** for log records (`redact.py:end`) — ensures secrets don't end up in log files either.
- **Off by default**: enable via `security.redact_secrets: true` in `config.yaml` or `HERMES_REDACT_SECRETS=true`. Snapshot at import time (`redact.py:62`) so a malicious agent can't disable it mid-session by `export`-ing the env var.

### Provider-quirk patches

- Aliibaba GLM API returns a wrong model name; Hermes injects the true model identity into the prompt (`run_agent.py:4886-4892`).
- OpenAI GPT-5/Codex use the `developer` role instead of `system` — swap at `_build_api_kwargs` boundary, internal representation stays `system` (`prompt_builder.py:DEVELOPER_ROLE_MODELS`).

---

## Discrepancies vs comparison.md

Read `criteria.md` and the Hermes-relevant sections of `comparison.md` only after the inventory above was written. Where my audit and `comparison.md` agree, no entry; the list below is **only** items where `comparison.md` is wrong, incomplete, or worth refining.

1. **Threshold percent is 0.50, not 0.75.** `comparison.md:209` says "Trigger at **75 % of context length** (`threshold_percent = 0.75` in `agent/context_engine.py:59`)." That cites the **abstract base-class default**, not the actual class. `ContextCompressor.__init__` defaults to **`threshold_percent=0.50`** (`agent/context_compressor.py:379`), floored at `MINIMUM_CONTEXT_LENGTH`. The effective trigger is **50 %** of context length, with a hard minimum floor for tiny-context models.

2. **"13 threat patterns" → actually 10 regex + 10 invisible-Unicode chars.** `comparison.md:190` says the context-file scanner has "13 threat patterns". The actual `_CONTEXT_THREAT_PATTERNS` list has **10 regexes** (`agent/prompt_builder.py:38-48`) — `prompt_injection`, `deception_hide`, `sys_prompt_override`, `disregard_rules`, `bypass_restrictions`, `html_comment_injection`, `hidden_div`, `translate_execute`, `exfil_curl`, `read_secrets`. A separate `_CONTEXT_INVISIBLE_CHARS` set (`:50-53`) holds 10 zero-width / RTL-override codepoints. Either count it as 10+10=20 signals or 11 categories — not 13.

3. **Post-write read-back is `patch`-only, not `write_file`.** `comparison.md:202` correctly cites the byte-for-byte read-back at `file_operations.py:798-806` (confirmed at `:795-808` in current source) but reads as if all writes get this protection. **Only `patch_replace` does**; `write_file` writes through the same heredoc with no read-back. Plain `write_file` failures (truncated heredoc, FS race) are still silent. C5 credit should be qualified.

4. **Compaction circuit-breaker / failure cool-down** — `comparison.md:209` mentions "Failure cooldown 600 s" but does **not** call out the second protection: `_ineffective_compression_count >= 2` anti-thrashing skip (`context_compressor.py:476-486`), where two consecutive low-savings (<10 %) compactions disable compaction entirely with a `/new` recommendation. That's a stronger guarantee than Claude Code's `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (which only counts hard failures, not ineffective passes).

5. **Per-turn aggregate budget** — `comparison.md:207` and `:351` correctly credit `MAX_TURN_BUDGET_CHARS = 200_000`. No discrepancy; just confirming this is parity with Claude Code's `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`, both at the same number.

6. **Read-dedup escalation under-credited.** `comparison.md:196` says "warning at 3, hard block at 4" — that's the **consecutive real-read** counter (`file_tools.py:506-525`). It does **not** mention the **separate** dedup-stub escalation: `dedup_hits[key] >= 2` triggers a hard-block on the *third* unchanged-mtime stub return (`file_tools.py:415-430`), independent of the consecutive counter. Two distinct loop-protection layers, not one.

7. **Multi-file patch (C2)** — `comparison.md:347` correctly credits this. Confirmed: V4A multi-file patch via `tools/patch_parser.py` + sorted-lock acquisition at `file_tools.py:818-826`. Neither Bobbit nor Claude Code has an equivalent.

8. **Atomic writes (C3)** — Hermes uses heredoc, not temp+rename (no `os.rename`/`os.replace` in the write paths, confirmed). The compensating mechanism is the `patch_replace` read-back; `write_file` itself is not atomic. If C3 scoring credits Hermes for atomicity, it should be qualified to "patch only".

9. **Plan / read-only mode (B6)** — Hermes has **no** first-class plan-mode state. Searched `agent/`, `tools/` for `plan_mode`, `read_only_mode`, `permission.*mode` — only matches are unrelated. The closest analogue is `delegation.role="leaf"`'s blocked-tool list (`delegate_tool.py:38-46`), which removes write/exec capability for subagents but is not a runtime mode toggle for the main agent.

10. **Backends (D4)** — `comparison.md:211` correctly enumerates the seven backends. What it **doesn't** make explicit is that `tools/file_operations.py:ShellFileOperations` makes **`read_file`/`write_file`/`patch`/`search_files` work uniformly on all of them**, and persisted tool-result spillover routes through the active backend's tmpdir (`tool_result_storage.py:43-58`) so the model can `read_file` it back regardless of backend. Plus ACP delegation (`tools/delegate_tool.py` `acp_command`/`acp_args`) lets a Hermes parent orchestrate Claude Code workers — cross-harness orchestration is unique to Hermes.

11. **Prompt-injection defence (F2)** — `comparison.md:349` credits Hermes here. Confirmed and stronger than the doc implies: scanned content is **substituted with a `[BLOCKED:…]` notice**, so the malicious instructions never reach the prompt (`prompt_builder.py:71-72`) — not just flagged. Tirith adds a second layer for command-content scanning (`tools/tirith_security.py:1-285`).

12. **Secret redaction (F1)** — `comparison.md:196, 198` mentions "secret redaction post-read" / "results subject to secret redaction". What's missing: redaction also runs on **terminal output** (`terminal_tool.py:2049`) and **inside the compactor before serialisation** (`context_compressor.py:706-735`), so secrets aren't persisted into summaries that survive across compactions. Plus `RedactingFormatter` for log records. The mechanism is opt-in (`HERMES_REDACT_SECRETS` / `security.redact_secrets`), snapshotted at import time so a malicious agent can't toggle it mid-session (`agent/redact.py:62`).

13. **Cross-agent file-state coordinator** — `comparison.md:200` covers this well; no discrepancy. Confirmed `_MAX_PATHS_PER_AGENT=4096`, `_MAX_GLOBAL_WRITERS=4096`, four staleness cases.

14. **Pluggable context engine** — `comparison.md` doesn't mention that `ContextCompressor` is one implementation of an abstract `ContextEngine` base class (`agent/context_engine.py:34-120`) and can be swapped via `context.engine` config (e.g. for third-party LCM engines). Architectural property worth surfacing in the A-group narrative.

15. **Skill-progressive-disclosure** — `comparison.md` does not separately credit the tier-1/2/3 skill discovery: `skills_list` returns name+description only (≤1024 chars/skill); `skill_view(name)` loads body; `skill_view(name, "references/x.md")` loads colocated tier-3 files (`tools/skills_tool.py:8-67, 849-1000`). Hermes's analogue of CC's "skill discovery on file-touch", but explicit-call-driven rather than implicit.

16. **Provider-quirk patches** — `comparison.md` doesn't note the Alibaba GLM model-name override (`run_agent.py:4886-4892`) or the `developer`-role swap for GPT-5/Codex (`prompt_builder.py:DEVELOPER_ROLE_MODELS`). Niche but real provider-robustness features.

17. **No LSP / semantic navigation** — `comparison.md:393` correctly says "Hermes's biggest deficit relative to Claude Code is LSP". Confirmed; Hermes has only per-extension CLI linters (`file_operations.py:261-267`).

18. **Hermes-internal cache read guard** (`agent/file_safety.py:96-114`) — not surfaced in `comparison.md`. Refuses reads of `~/.hermes/skills/.hub` and `index-cache` to prevent prompt injection through cache-poisoning. Niche but a real attack-surface mitigation in the F-group.

19. **`HERMES_DISABLE_FILE_STATE_GUARD=1` opt-out** (`tools/file_state.py:255-258`) — not surfaced in `comparison.md`. The cross-agent file-state coordinator can be globally disabled via env var; relevant when discussing how robust the protection is in adversarial settings.
