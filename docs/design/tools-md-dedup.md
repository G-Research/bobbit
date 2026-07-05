# Design note — `# Tools` markdown dedup vs JSON schemas (F22)

Finding F22 (Fable refactor program, tracker W3.8) — token lever #2: the
`# Tools` markdown section injected into every system prompt allegedly
"duplicates the tools' JSON schemas already sent to the model."

## Measured first (Rule 0)

Traced the mechanism in `src/server/agent/tool-manager.ts` (`getToolDocsForPrompt`,
`loadToolDefinitions`) and the actual tool-registration code paths
(`defaults/tools/<group>/extension.ts`, `defaults/tools/_builtins/extension.ts`,
`@earendil-works/pi-coding-agent`) before writing any code.

**The prior audit's own composition doc already flagged this as a soft finding**
(`raw/analysis-cache-stratification.md` in the Fable audit bundle, misplacement
#2): a *different* duplication — the `team-lead.yaml` persona's own hand-written
`## Tools` section repeating the auto-generated `# Tools` index — was previously
noted as "a token nit, not a cache-hit problem." F22 asks a narrower, more
literal question: does the auto-generated `# Tools` markdown itself duplicate
the actual wire-format JSON tool schemas (the `tools:` array every Anthropic
request carries, built from `name`/`description`/`input_schema`)?

### What actually goes into the `# Tools` markdown

`getToolDocsForPrompt()` (`tool-manager.ts:912`) renders one bullet per tool:
`- name(params) — summary`, grouped under `## <Group> — see <path>` headers.
The `summary` and `params` fields come from **YAML files** under
`defaults/tools/<group>/*.yaml` (e.g. `defaults/tools/shell/bash.yaml`):

```yaml
name: bash
description: "Run command; returns stdout/stderr (truncated)"
summary: "Execute a shell command"
params: [command, description?, timeout?]
```

### What actually goes into the JSON schema sent to the model

The **actual wire schema** for the same tool is registered completely
separately, in `defaults/tools/shell/extension.ts:153-160`:

```ts
pi.registerTool({
  name: "bash",
  description: "Run a bash command. Output truncated to last 2000 lines / 50KB.",
  parameters: { /* TypeBox schema: command (string), timeout (number, "Seconds. Default 300."), ... */ },
});
```

For `read`/`write`/`edit`/`grep`/`find`/`ls`, the wire schema comes from
`@earendil-works/pi-coding-agent`'s own `createReadToolDefinition()` etc.
(`defaults/tools/_builtins/extension.ts:36`), hardcoded in that package —
**not derived from the YAML at all**.

### Conclusion: semantic overlap, not literal duplication

These are **two independently hand-authored strings**, maintained on
disconnected code paths (YAML doc layer vs. TypeBox/pi-coding-agent
registration), that happen to describe the same tool:

| | `# Tools` markdown | JSON wire schema |
|---|---|---|
| Source | `defaults/tools/<group>/*.yaml` (`summary`/`params`) | `pi.registerTool()` call / pi-coding-agent builtin |
| `bash` description | `"Execute a shell command"` | `"Run a bash command. Output truncated to last 2000 lines / 50KB."` |
| `read` description | `"Read file contents (text or images)"` | `"Read the contents of a file. Supports text files and images (jpg, png, gif, webp)..."` (298 chars) |
| Params | **names only**: `bash(command, timeout?)` | full JSON Schema: types, `required`, per-field descriptions |

Neither `docs` nor `detail_docs` (the long-form per-tool prose) is inlined
into the markdown at all — a prior "Compact tool docs in prompt" pass
(pinned by `tests/tool-docs-prompt.test.ts`) already cut that out and
replaced it with a `## <Group> — see <path>` pointer to on-disk detail docs.
So the markdown is *already* fairly lean; the residual overlap is narrower
than the finding implies:

1. **`summary` vs wire `description`** — same gist, different wording, not a
   literal duplicate. Real but modest: one extra one-line restatement per
   tool.
2. **`(params)` name list vs wire `input_schema`** — this IS the clearest
   case of "the markdown restates what the schema already carries": the
   wire schema always has full types/required/descriptions per parameter;
   the markdown's `(params)` notation is param NAMES only, a strict subset
   of information the model already has, for a real (measured) token cost.
3. **Group header + detail-docs pointer** — NOT duplication. This path
   (`.bobbit/state/tool-docs/<group>.md`) exists nowhere else; it's new
   information the model needs to find full docs.

`tests/tool-description-budget.test.ts` independently pins the **wire**
descriptions (≤150 chars) and per-parameter descriptions (≤80 chars,
recursive) captured directly from each `defaults/tools/<group>/extension.ts`
`pi.registerTool()` call. It does not import or exercise
`getToolDocsForPrompt()` at all — the two budgets are on disjoint code
paths (YAML-driven markdown generation vs. TypeScript tool registration), so
this fix does not touch anything that test measures. It stays green
unmodified.

## Fix

Trim the schema-shaped duplication (params names) rather than the prose
(the one-line summary earns its keep — it's the compact per-tool "what does
this do" index, and the previous compaction pass already established that
shape). `BOBBIT_TOOLS_MD=full|index` env var (`resolveToolsMdMode()` /
`getToolDocsForPrompt(..., modeOverride?)`).

**Default unset = `"full"` = today's output, byte-identical** (pinned by the
flag-off tests in `tests/tool-docs-prompt.test.ts`).

`"index"`:
1. Drops the `(params)` name list from every bullet — `- name — summary`
   for every tool, not just the ones that already had no `params:` field.
2. Adds one pointer line under the `# Tools` heading: full parameter
   schemas already ship with each tool's JSON definition, not repeated here.
3. Leaves group headers and detail-docs pointers unchanged (not
   duplication — see above).
4. Per-section `toolsMdMode: "full" | "index"` is recorded on the "Tools"
   entry in the persisted `<sessionId>-prompt.json` breakdown
   (`PromptSection.toolsMdMode`) and shown as an "index" badge in the System
   Prompt inspector, mirroring F19's `truncated` badge, so an A/B can
   measure the before/after token delta on real sessions.

## Measurement

Reproduced on this repo's own default builtin tool set (69 tools across 15
groups — `defaults/tools/`, via `ToolManager.getToolDocsForPrompt()`
pointed at the real directory, same harness as the existing
`tests/tool-docs-prompt.test.ts` "byte budget (real builtins)" test):

```
FULL   bytes=7,435  chars=7,257  ~tokens=1,815
INDEX  bytes=5,504  chars=5,324  ~tokens=1,331
reduction: 26.6%
```

This is a per-turn, every-uncached-request saving (the `# Tools` section
sits in the stable system-prompt prefix, so on a cache hit it's ~0.1x cost —
but it is billed at full price on every cache write/miss, e.g. after the
5-minute idle TTL expires, exactly the pattern flagged by the sibling
cache-retention finding). Smaller than F19's ~21K-token AGENTS.md cascade,
but real and additive — the two fixes stack (both are default-OFF env-var
flags feeding the same `<sessionId>-prompt.json` breakdown / cost telemetry
A/B).

## Why default OFF

The `(params)` name list, though redundant with the wire schema, is
free-form documentation surface some operators or downstream tooling may
already rely on (e.g. a human skimming the raw system prompt for a quick
parameter reminder without cross-referencing the JSON schema). Default OFF
lets it be measured via the `toolsMdMode` breakdown field and real session
token deltas before considering a default-on rollout — same posture as
F19's `BOBBIT_AGENTSMD_BUDGET`.

## A/B plan

1. Ship default OFF (`"full"`). Operators opt in with `BOBBIT_TOOLS_MD=index`.
2. Compare `<sessionId>-prompt.json` `totalTokens` and the "Tools" section's
   `tokens`/`toolsMdMode` fields across matched sessions with the flag off
   vs. on for the same project/role mix, alongside the `cacheWrite1h`
   telemetry (W3.17) to see the effect land specifically on cache-write
   turns.
3. If token savings are material and no task-quality regression is observed
   (agents should not need the `(params)` names — the wire schema is the
   actual contract the model calls against), consider flipping the default.
   Left for a follow-up finding, out of scope for this PR.

## Files touched

- `src/server/agent/tool-manager.ts` — `ToolsMdMode`, `resolveToolsMdMode()`,
  `getToolDocsForPrompt(..., modeOverride?)` index-mode rendering.
- `src/server/agent/system-prompt.ts` — new optional `PromptSection.toolsMdMode`
  field, populated in `getPromptSections()`.
- `src/ui/dialogs/SystemPromptDialog.ts` — "index" badge on the Tools section.
- `tests/tool-docs-prompt.test.ts` — `resolveToolsMdMode` resolution tests,
  index-mode rendering tests, flag-off byte-identity, real-builtins size
  comparison.
- `tests/system-prompt.test.ts` — `getPromptSections` records `toolsMdMode`
  on the Tools section.
- `docs/internals.md` — env-knob reference entry under "MCP tool documentation".
