# Priority 2 — Lazy Tool Documentation

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 2.1 | Bobbit emits all tool docs eagerly; replace with summary-only + `tool_search`/`tool_help` like Claude Code's `ToolSearchTool` | **real** | high |
| 2.2 | `getAvailableTools()` re-scans + re-parses YAML on every call; cache by mtime | **real** | high |
| 2.3 | Browser/team/workflow/memory schemas appear in every coding session; group + mode-filter | **partial** | high |
| 2.4 | No `defer:` flag — heavy tools (LSP/MCP/browser/plan-mode) always full-schema'd | **real** | high |
| 2.5 | Add hard size cap on the tool-doc section as a guardrail | **real** | medium |

---

## Goal 2.1: Replace eager YAML docs with lazy docs

**Doc claim.** `src/server/agent/tool-manager.ts` re-renders all tool documentation in every system prompt (10–20 KB for ~40 tools). Replace with name+summary list and add `tool_help(name)` / `tool_search(query)` for on-demand lookup. Reference: Claude Code `src/tools/ToolSearchTool/`.

**Bobbit reality.** Confirmed. `getToolDocsForPrompt()` emits **two** sections: an overview list (name + summary) **and** a full "Tool Documentation" section concatenating every tool's `docs:` field. There is no `tool_search` / `tool_help` registration anywhere under `src/server/` or `.bobbit/config/tools/`.

```ts
// src/server/agent/tool-manager.ts:255-262
// Part 2: Tool Documentation (only tools that have docs)
const docSections: string[] = [];
for (const [group, entries] of grouped) {
  const withDocs = entries.filter((e) => e.docs);
  if (withDocs.length === 0) continue;
  docSections.push(`\n## ${group}\n`);
  for (const entry of withDocs) {
    docSections.push(`### ${entry.name}\n\n${entry.docs}\n`);
  }
}
```

`grep -rn "tool_search\|tool_help" src/server .bobbit/config/tools` returns nothing. Audit corroborates: `audits/bobbit.md:218-221` documents the two-pass eager render.

**Claude Code reality.** `ToolSearchTool` exists at `src/tools/ToolSearchTool/ToolSearchTool.ts:235`; `shouldDefer` and `alwaysLoad` are first-class on every tool definition.

```ts
// src/Tool.ts:442-449
readonly shouldDefer?: boolean
/* …
 * `_meta['anthropic/alwaysLoad']`. Use for tools the model must see on
 * every request even when ToolSearch is enabled.
 */
readonly alwaysLoad?: boolean
```

The provider request bundles deferred tools with `defer_loading: true`; the model fetches them via `ToolSearchTool` round-trips that return `tool_reference` blocks (`audits/claude-code.md:218-222`).

**Hermes reality.** No schema deferral. Tools are emitted as OpenAI function-calling schemas (provider-side, not in-prompt text), and full schemas always ship. **Skills**, not tools, are the lazy tier — `skills_list` returns `{name, description}` and `skill_view(name)` fetches the body (`audits/hermes.md:155-157`). So Hermes is **not** a reference implementation for Goal 2.1; CC is.

**Verdict.** **real** — high confidence.

**Reasoning.** Bobbit's two-section render is exactly the eager-doc pattern the goal targets, and CC's `ToolSearchTool` is a working reference. The cost claim is concrete: one render per request, full `docs:` for every visible tool, no opt-out.

**Minimal proof of gap.**

Bobbit (eager, no deferral hook):
```ts
// src/server/agent/tool-manager.ts:175-188
getToolDocsForPrompt(toolNames?: string[]): string {
  const tools = loadToolDefinitions();
  const grouped = new Map<...>();
  for (const tool of tools) {
    if (toolNames && !toolNames.includes(tool.name)) continue;
    const summary = tool.summary ?? tool.description;
    const docs = tool.docs?.trim();
    grouped.get(group)!.push({ name: tool.name, summary, docs });
  }
```

Claude Code (deferral via `shouldDefer` + `ToolSearchTool`):
```ts
// src/tools/LSPTool/LSPTool.ts:136
shouldDefer: true,
// src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:55
shouldDefer: true,
```

**Scope-down notes.** `summary:` is already present in every YAML (`grep -c "summary:" .bobbit/config/tools/*/*.yaml` returns 1 for all ~25 tools), so the lazy-render half of Goal 2.1 is one-line surgery on `getToolDocsForPrompt`. The harder half is shipping `tool_help`/`tool_search` and teaching the agent to call them — that pattern already exists in CC and could be lifted nearly verbatim.

---

## Goal 2.2: Cache parsed tool YAML

**Doc claim.** `getAvailableTools()` re-scans `.bobbit/config/tools/` and re-parses YAML on every call; cache by mtime.

**Bobbit reality.** Confirmed. `loadToolDefinitions()` runs every call site:

```ts
// src/server/agent/tool-manager.ts:54-57, 145-147
function loadToolDefinitions(): BaseToolInfo[] {
  const tools: BaseToolInfo[] = [];
  const seen = new Set<string>();
  try {
    const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });
    // ...readFileSync + parse() per file every call
// ...and in getAvailableTools:
getAvailableTools(): ToolInfo[] {
  const tools = loadToolDefinitions();
```

Every entry point (`getAvailableTools`, `getToolByName`, `getToolDocsForPrompt`, `getToolProvider`, `getToolProviders`, `getAllToolNames`, `updateToolMetadata`) calls `loadToolDefinitions()` afresh — `readdirSync` + `readFileSync` + `parse` for every YAML on every invocation. No `Map<path, {mtime, parsed}>` anywhere; `grep -n "mtime" src/server/agent/tool-manager.ts` returns nothing.

**Claude Code reality.** Tools are TypeScript modules registered statically via `getAllBaseTools()` in `src/tools.ts:147` (`audits/claude-code.md:5`). There is no YAML-parse cost — the issue doesn't apply to CC's architecture, but the design eliminates the problem entirely.

**Hermes reality.** `tools/registry.py` discovers tools via a one-shot AST scan at startup (`audits/hermes.md`'s registry section; `tools/registry.py:42-74`); after registration the registry is in-memory, not re-parsed per call.

**Verdict.** **real** — high confidence.

**Reasoning.** The re-parse-per-call cost is real and uncontested. CC and Hermes both avoid it (CC via static modules, Hermes via cached registry). For Bobbit the closest fit is the doc's own suggestion: per-file mtime cache. Effort is genuinely XS as labelled.

**Minimal proof of gap.**

Bobbit:
```ts
// src/server/agent/tool-manager.ts:51-55, 153
function loadToolDefinitions(): BaseToolInfo[] {
  const tools: BaseToolInfo[] = [];
  const seen = new Set<string>();
  try {
    const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });
// every public method calls loadToolDefinitions() fresh, e.g.:
getAvailableTools(): ToolInfo[] { const tools = loadToolDefinitions(); /* … */ }
```

Hermes (registry populated once, reused):
```python
# tools/registry.py:42-54
def _module_registers_tools(module_path: Path) -> bool:
    # AST scan at startup, then cached in registry._tools dict
    return any(_is_registry_register_call(stmt) for stmt in tree.body)
```

**Scope-down notes.** Impact is CPU/latency, not tokens. With ~25 small YAMLs (`ls .bobbit/config/tools/*/*.yaml | wc -l` ≈ 25) the absolute cost per request is small; the goal's `<1ms` acceptance criterion is realistic but the user-visible win is modest. Combine with 2.1 — once docs are lazy, `getAvailableTools()` is hit far more often by `tool_search`, raising the cache's value.

---

## Goal 2.3: Group tools by mode

**Doc claim.** Browser/team/workflow/memory tools appear in every coding session. Define toolset groups in YAML (`code-core`, `code-extra`, `code-browser`, `team`, `workflow`, `memory`, `delegate`); lean mode includes `code-core` only.

**Bobbit reality.** YAMLs already declare a `group:` field (e.g. `group: shell`, `group: filesystem`, `group: browser`, `group: team`, `group: tasks`). It is used purely to **bucket tools in the prompt-rendering output** (`tool-manager.ts:240` headers), not to filter by mode. There is **no mode/lean concept** in the source: `grep -rn "mode\|lean" src/server/agent/tool-manager.ts` returns nothing related to tool filtering. The only filter is the `toolNames?: string[]` allowlist passed in by callers — used by role YAMLs (`.bobbit/config/roles/*.yaml`'s `tools:` list), not by a session-level mode toggle.

**Claude Code reality.** Mode-style gating exists, but per-tool, not per-toolset. Tools are gated by `feature(...)` flags (`isAgentSwarmsEnabled`, `KAIROS`, `PROACTIVE`, `USER_TYPE === 'ant'`, etc., `audits/claude-code.md:165-167`) and by `isEnabled()` per tool. REPL mode hides primitives (`tools.ts:267-275`). There is no single named "lean coding mode" — the deferral mechanism (Goal 2.4) does the lean-prompt work.

**Hermes reality.** `toolsets.py` is the closest direct analog: composable toolsets with `includes:` (`audits/hermes.md`; `toolsets.py:68`). Built-in toolsets ("research", "full_stack", platform-specific) are resolved to flat tool-name lists at session start.

**Verdict.** **partial** — high confidence.

**Reasoning.** The grouping primitive (`group:` YAML field) already exists and is wired into rendering; what's missing is (a) a session-level "mode" or "active toolsets" selector and (b) filtering `loadToolDefinitions()` output by it. The doc's framing of new groups (`code-core`, `code-extra`, …) overlooks the existing `group:` taxonomy; the work is *reusing* the field plus adding a per-session active set, not introducing groups from scratch.

**Minimal proof of gap.**

Bobbit (group exists, no mode filter):
```ts
// src/server/agent/tool-manager.ts:243-248
const sections: string[] = ["# Tools"];
for (const [group, entries] of grouped) {
  sections.push(`\n## ${group}\n`);
  for (const entry of entries) {
    sections.push(`- **${entry.name}**: ${entry.summary}`);
  }
}
```

Hermes (named toolsets compose tools):
```python
# toolsets.py — composable toolsets with includes
# Built-in toolsets defined at line 67+, resolve_toolset() flattens via includes
tools = get_toolset("research")
all_tools = resolve_toolset("full_stack")
```

**Scope-down notes.** Don't redefine groups; reuse the existing `group:` field. The real change is a `mode: "lean" | "managed"` (or "active groups: [...]") session setting plus `tool-manager` filtering. Avoid the doc's proposal of a brand-new `code-core` taxonomy — `filesystem`, `shell`, `agent`, `team`, `tasks`, `browser`, `web`, `html` already exist in the YAMLs.

---

## Goal 2.4: Mark heavy tools `defer`

**Doc claim.** Add `defer: true` to YAMLs of heavy-schema tools (LSP/MCP/plan-mode/browser/notebook). Deferred tools render as name+summary only; full schema fetched via `tool_search`. Reference: Claude Code `shouldDefer: true`.

**Bobbit reality.** No `defer:` field anywhere — `grep -rn "defer:" .bobbit/config/tools/` returns nothing, and `tool-manager.ts` has no codepath that omits a tool's `docs` block. The closest existing behaviour is that the longer `detail_docs:` field is **already** lazy: `getToolDocsForPrompt` deliberately omits it and points the agent at the YAML on disk (`tool-manager.ts:266`):

```ts
// src/server/agent/tool-manager.ts:265-266
sections.push("\n_For detailed tool documentation (examples, edge cases, full parameter descriptions), read the tool's YAML file in `.bobbit/config/tools/<group>/<tool>.yaml` — see the `detail_docs` field._");
```

So `detail_docs` is one tier lazy already, but the medium-length `docs:` field — the bulk of the prompt — is still eager for every tool.

**Claude Code reality.** `shouldDefer: true` is wired end-to-end:

```ts
// src/Tool.ts:442
readonly shouldDefer?: boolean
// src/tools/LSPTool/LSPTool.ts:136
shouldDefer: true,
// src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:55
shouldDefer: true,
// src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:69 (per audits/claude-code.md:139)
shouldDefer: true,
// src/tools/WebFetchTool/WebFetchTool.ts:69 (per audits/claude-code.md:145)
shouldDefer: true,
```

These ride on `defer_loading: true` in the request and require a `ToolSearchTool` round-trip (`audits/claude-code.md:218-222`).

**Hermes reality.** No schema deferral on tools (`audits/hermes.md:157`); only on skills.

**Verdict.** **real** — high confidence.

**Reasoning.** Direct one-to-one mapping with CC's mechanism. Concrete reference exists for the exact tools the goal lists.

**Minimal proof of gap.**

Bobbit (no defer-aware filter):
```ts
// src/server/agent/tool-manager.ts:201-208 — every tool's docs always included
for (const tool of tools) {
  if (toolNames && !toolNames.includes(tool.name)) continue;
  const summary = tool.summary ?? tool.description;
  const docs = tool.docs?.trim();
  grouped.get(group)!.push({ name: tool.name, summary, docs });
}
```

Claude Code:
```ts
// src/tools/LSPTool/LSPTool.ts:136
shouldDefer: true,
// src/utils/toolSearch.ts:4-5
// When enabled, deferred tools (MCP and shouldDefer tools) are sent with
// defer_loading: true and discovered via ToolSearchTool rather than being
```

**Scope-down notes.** Goal 2.4 is the natural follow-on after 2.1 (it needs `tool_search` to materialize the deferred schema). If 2.1 is done first with a "render every tool's `docs`" → "render only `summary`" flip, 2.4 collapses to a `defer:` *opt-out* (i.e. `alwaysLoad: true` for cheap tools) plus per-tool annotation — likely simpler than the inverse.

---

## Goal 2.5: Cap tool-doc section size

**Doc claim.** Hard cap (e.g. 8 KB lean / 16 KB managed). On overflow, emit only names+summaries plus a `tool_search` hint.

**Bobbit reality.** No cap anywhere. `getToolDocsForPrompt()` returns whatever the concatenation produces. `grep -n "MAX\|LIMIT\|cap" src/server/agent/tool-manager.ts` returns nothing. There is one truncation guardrail in the codebase — `pi-coding-agent`'s per-tool-result truncation (2000 lines / 50 KB) — but it applies to tool *results*, not to the system-prompt tool-doc section.

**Claude Code reality.** No comparable single cap on the tool-doc *section* — CC handles bloat by deferring schemas (Goal 2.4) instead. There is a system-wide tool-result cap (`DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000`, `src/constants/toolLimits.ts:13`; `audits/claude-code.md`'s "Tool result persistence" section), and a per-message aggregate `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000`, but those are about *outputs*, not the prompt's tool docs.

**Hermes reality.** Tools ride as provider-side schemas (not in-prompt text), so the issue cannot manifest the same way. `MAX_TURN_BUDGET_CHARS = 200_000` (`tools/budget_config.py:19`, `audits/hermes.md`) is again an output-budget construct, not a tool-doc-section cap.

**Verdict.** **real** — medium confidence.

**Reasoning.** The gap is real — no cap exists in Bobbit. But neither CC nor Hermes implements a tool-doc-section cap as such; both prefer *deferral* (CC) or *off-prompt schemas* (Hermes) as the structural fix. So Goal 2.5 is a Bobbit-specific guardrail with no direct reference impl. The doc's own framing concedes this ("a guardrail rather than a full strategy"). Useful as a backstop after 2.1/2.4, but if 2.1+2.4 land, the cap will rarely fire.

**Minimal proof of gap.**

Bobbit (no cap, returns whatever the concat is):
```ts
// src/server/agent/tool-manager.ts:262-269
if (docSections.length > 0) {
  sections.push("\n# Tool Documentation");
  sections.push(...docSections);
  sections.push("\n_For detailed tool documentation … read the tool's YAML file …_");
}
return sections.join("\n");
```

Claude Code (related but different — *result* persistence threshold, used as inspiration for sizing):
```ts
// src/constants/toolLimits.ts:13
DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000
// :48
MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000
```

**Scope-down notes.** Land as the *last* item in Priority 2; once 2.1 + 2.4 are merged, an 8 KB section cap will almost never trip and the implementation simplifies to a `if (output.length > CAP) fallbackToSummariesOnly()` switch. Defer until 2.1/2.4 numbers are measured. Drop the per-mode (lean=8 KB / managed=16 KB) split unless real prompts exceed 8 KB after deferral.
