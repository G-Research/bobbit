# Priority 8 — Plan / Read-Only Mode

Cross-checked against the Phase-A audits (`audits/bobbit.md:225`, `audits/claude-code.md:128-131,267-271`, `audits/hermes.md:253-257`) and verified directly in source.

## Verdict summary

| Goal | Claim | Verdict | Confidence |
|---|---|---|---|
| 8.1 | Bobbit lacks a plan-mode toggle that blocks mutating tools; CC has `EnterPlanModeTool` | **real** | high |
| 8.2 | Bobbit has no per-call permission classifier (`(tool, args) → readOnly/mutating/dangerous`); CC has `isReadOnly(input)` per tool incl. parsed-bash | **real** | high |
| 8.3 | Bobbit UI has no plan-mode badge / toggle / transcript event | **real** (depends on 8.1) | high |

All three goals are real gaps in Bobbit. Reference implementations live in Claude Code (`EnterPlanModeTool`, `ExitPlanModeV2Tool`, `BashTool.isReadOnly`, `bashPermissions.ts`). Hermes has no plan-mode equivalent either, so it's CC-only as the reference.

---

## Goal 8.1: `plan` mode toggle

**Doc claim.** Add `enter_plan` / `exit_plan` tools (or session flag). In plan mode, mutating tools are blocked or routed to dry-run. Reference: Claude Code `EnterPlanModeTool`.

**Bobbit reality.** No plan-mode state, no enter/exit tool, no mutating-tool gating by mode. Audit `audits/bobbit.md:225-226` settles this: searches for `plan.mode|planMode|readOnly` in `src/server/` returned no matches; tool selection is per-role only via role YAML's `allowedTools` (`src/server/agent/role-store.ts:14,61,81`). Re-verified: `grep -rn "plan_?mode\|planMode" /Users/aj/Documents/dev/bobbit/src/server /Users/aj/Documents/dev/bobbit/src/ui` produces nothing relevant; the only `readOnly` hit is `AgentInterface.ts:81` (UI prop indicating an archived/read-only **session view** — completely unrelated to tool gating).

**Claude Code reality.** First-class plan-mode state with a dedicated tool family.
- `src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:36,79-94` — zero-input tool that calls `applyPermissionUpdate(prepareContextForPlanMode(prev.toolPermissionContext), { type: 'setMode', mode: 'plan', destination: 'session' })`. Disabled when `--channels` is active so plan mode isn't a trap (`:60-66`).
- `src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:147,182` — reads a plan file, shows it for user approval, restores `prePlanMode`.
- Permission modes enumerated in `src/types/permissions.ts` (`default | plan | bypass | …`); `prePlanMode` saved for restoration (`audits/claude-code.md:267`).

**Hermes reality.** No first-class plan-mode (`audits/hermes.md:253-257`). Closest analogue is the `delegation.role="leaf"` blocked-tool list in `tools/delegate_tool.py:38-46`, but that's a static per-subagent config, not a runtime mode toggle.

**Verdict.** `real` — high confidence.

**Reasoning.** Bobbit literally has no plan-mode primitive at any layer (server, role, tool, UI). The CC reference is concrete and idiomatic.

**Minimal proof of gap.**

Bobbit — only "plan"-style construct in `src/server/agent/` is **none**; per-role tool gating is the only safety mechanism (`src/server/agent/role-store.ts:14`):

```ts
// src/server/agent/role-store.ts:14
allowedTools: string[];
// :81
allowedTools: role.allowedTools,
```

CC — runtime mode mutation:

```ts
// src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:87-94
context.setAppState(prev => ({
  ...prev,
  toolPermissionContext: applyPermissionUpdate(
    prepareContextForPlanMode(prev.toolPermissionContext),
    { type: 'setMode', mode: 'plan', destination: 'session' },
  ),
}))
```

**Scope-down notes.** Goals 8.1 and 8.3 are tightly coupled — implementing 8.1 without 8.3's badge would leave the user blind to the active mode. CC pairs them via `EnterPlanMode` returning a tool result that the UI interprets to render the badge; recommended to land them together.

---

## Goal 8.2: Permission classifier

**Doc claim.** Per-call classifier maps `(tool, args)` → `{readOnly, mutating, executes, dangerous}`; bash classified by parsing first token + flags. Plan mode allows only `readOnly`. Override via session config.

**Bobbit reality.** No classifier. There is no `permissions.ts` in `src/server/agent/` (verified via `ls`). Every tool is gated only by the role's static `allowedTools` list. Bash inputs are never inspected for read-vs-mutate intent. The Bobbit audit confirms (`audits/bobbit.md:225-226`): "tool selection is per-role only."

**Claude Code reality.** Each tool implements `isReadOnly(input)` (and `isConcurrencySafe(input)` derived from it):
- `FileReadTool.ts:373,376`, `GlobTool.ts:79`, `GrepTool.ts:186`, `WebFetchTool.ts:98`, `LSPTool.ts:149`, `EnterPlanModeTool.ts:71`, `ExitPlanModeV2Tool.ts:182`, `AgentTool.tsx:1264`, `ConfigTool.ts:90` (input-dependent), `PowerShellTool.tsx:300` (input-dependent), `SendMessageTool.ts:539` (input-dependent), and `BashTool.tsx:434-441`:

```tsx
// src/tools/BashTool/BashTool.tsx:434-441
isConcurrencySafe(input) {
  return this.isReadOnly?.(input) ?? false;
},
isReadOnly(input) {
  const compoundCommandHasCd = commandHasAnyCd(input.command);
  const result = checkReadOnlyConstraints(input, compoundCommandHasCd);
  return result.behavior === 'allow';
},
```

The bash classifier parses the command (operator-aware: `&&`, `||`, `|`) into `isRead`/`isSearch`/`isList` (`isSearchOrReadBashCommand` in `BashTool.tsx`, ref `audits/claude-code.md:82`). The mode-aware permission pipeline runs in `bashPermissions.ts:1140-1163`:

```ts
// src/tools/BashTool/bashPermissions.ts:1146-1163
const modeResult = checkPermissionMode(input, toolPermissionContext)
if (modeResult.behavior !== 'passthrough') return modeResult
// 7. Check read-only rules
if (BashTool.isReadOnly(input)) {
  return { behavior: 'allow', updatedInput: input,
    decisionReason: { type: 'other', reason: 'Read-only command is allowed' } }
}
```

Plus an env-key allowlist of secret names (`bashPermissions.ts:402-496`) and a sed-edit reroute through the same atomic-write+permission path (`audits/claude-code.md:83`).

**Hermes reality.** No per-call (tool, args) classifier; tool gating is static per role/leaf (`audits/hermes.md:255-257`). Tirith scans command **content** for security threats (`tools/tirith_security.py`) but doesn't classify read-vs-mutate.

**Verdict.** `real` — high confidence.

**Reasoning.** Bobbit's safety surface is pure static role allowlists. The doc's proposed shape (`(tool, args) → CallClass`) is essentially CC's `Tool.isReadOnly(input)` interface plus a bash sub-classifier. Concrete, missing, and CC-proven.

**Minimal proof of gap.** See Goal 8.1's Bobbit excerpt (`role-store.ts:14`) plus CC's `BashTool.tsx:437-441` excerpt above. Bobbit's `bash` extension at `.bobbit/config/tools/shell/extension.ts` performs only co-author-trailer injection (per `audits/bobbit.md:241`), not classification.

**Scope-down notes.** The doc's acceptance criterion "covers all built-in tools" is fine, but the bash classifier carries 90% of the value — most non-bash tools either are obviously read-only or obviously mutating without input parsing. Land the per-tool `isReadOnly()` first (cheap), then a bash AST sub-classifier modelled on `checkReadOnlyConstraints` second.

---

## Goal 8.3: UI affordance

**Doc claim.** Persistent badge in session header showing `PLAN MODE` when active; one-key/click toggle; transcript enter/exit event; survives reload via WS broadcast.

**Bobbit reality.** No plan-mode state to surface. Verified by inspecting `src/ui/components/AgentInterface.ts` — the only `readOnly` hit (`:81,847`) is a flag for archived sessions that hides the message editor; nothing in the WS protocol, session store, or header component carries a plan-mode flag. No badge, no toggle, no transcript event. Audit `audits/bobbit.md:225-226` confirms absence at all layers.

**Claude Code reality.** UI components exist for both transitions:
- `src/tools/EnterPlanModeTool/UI.tsx` (renderToolUseMessage / renderToolResultMessage / renderToolUseRejectedMessage are wired in `EnterPlanModeTool.ts`).
- `src/tools/ExitPlanModeTool/UI.tsx` likewise.
- The mode is part of `toolPermissionContext` on app state, so any component reading state can render an indicator. Plan-mode tool-results carry "DO NOT write or edit any files yet" guidance (`audits/claude-code.md:270`).

**Hermes reality.** Not applicable (no plan mode → no UI).

**Verdict.** `real` — high confidence (gap depends on 8.1 being implemented).

**Reasoning.** This is the UX leg of 8.1. Without it, even if the server enforced plan mode, the user would have no persistent visual indicator. Doc's design (header badge, transcript events, WS broadcast, refresh-survival via persisted session state) is conventional and correct.

**Minimal proof of gap.**

Bobbit — `AgentInterface.ts` `readOnly` is unrelated to plan mode; it gates the editor on archived sessions:

```ts
// src/ui/components/AgentInterface.ts:81
@property({ type: Boolean }) readOnly = false;
// :847
${this.readOnly || (state as any).isPreparing ? nothing : html`<message-editor …`
```

CC — plan-mode tool returns transcript-visible content and sets app-state mode atomically (excerpt above from `EnterPlanModeTool.ts:87-99`).

**Scope-down notes.** Doc lists optional tooltip + one-key toggle. The badge + transcript event are the must-haves; the keybinding is optional polish. The doc-suggested REST endpoint `PATCH /api/sessions/:id/plan-mode` is fine but Bobbit could equivalently expose plan/exit as agent tools (matching CC's design), which avoids inventing a separate REST surface. Recommend keeping the server contract symmetric with 8.1 (tool-driven mutation; WS push for badge updates) rather than splitting into REST + tool paths.
