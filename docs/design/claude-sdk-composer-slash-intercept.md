# Claude SDK composer slash interception (D2)

## Decision

Approved D2 keeps Bobbit slash-command ownership in the composer and the existing
server prompt pipeline; it does **not** configure Claude commands. The client
intercepts an exact, full-composer Bobbit control command before `onSend`, while
skills retain their existing server-side expansion before the prompt is delivered
to the Claude Agent SDK. Pack launchers use the existing Extension platform
`composer-slash` entrypoint and `runLauncherEntrypoint` hook.

The SDK query posture remains unchanged:

```ts
settingSources: []
strictMcpConfig: true
```

No `.claude/commands`, settings file, command file, plugin, or generated command
is materialized into the project worktree or SDK config directory. In particular,
D2 does not add a Claude-private extension surface. The applicable platform hook
already exists: `src/app/pack-entrypoints.ts::{listLauncherEntrypoints,
runLauncherEntrypoint}` with pack-bound Host API construction in
`src/app/host-api.ts::setLauncherHostFactory`.

## Current evidence

### Existing composer and server paths

`MessageEditor` currently owns the visible slash menu:

- `src/ui/components/MessageEditor.ts::_loadSlashSkills()` fetches
  `GET /api/slash-skills?cwd&projectId`.
- `_updateSlashAutocomplete()` identifies a whitespace-boundary `/[\w-]*` token;
  `_selectSlashSkill()` only completes it in the textarea.
- `_withPackEntrypoints()` appends registered `composer-slash` launchers; exact
  names already win over pack labels.
- `_packSlashLaunchFromText()` recognizes a full-line pack launcher, and
  `handleSend()` invokes `runLauncherEntrypoint(key, callback, { body })` rather
  than `onSend`.

The normal prompt path is intentionally server-owned. In `src/server/ws/handler.ts`
the `prompt` handler calls `resolveSkillExpansions(msg.text, ...)`, resolves file
mentions, then calls `sessionManager.enqueuePrompt(sessionId, originalText,
{ modelText, skillExpansions, ... })`. The queue supplies `modelText` to the
runtime. `ClaudeAgentSdkBridge::prompt()` sends that final text through its
`AsyncInputQueue` as an `SDKUserMessage`. Thus dynamic skills already expand
before the SDK can see a slash token.

`AgentInterface::sendMessage()` separately handles `/compact`: it appends the
optimistic user row, starts the animation, and calls `session.compact()`. This is
not a valid generic SDK command: `ClaudeAgentSdkBridge::compact()` returns
unsupported (the lifecycle contract explicitly pins manual compact unsupported).
The current universal synthetic `compact` skill in
`src/server/skills/slash-skills.ts::BUILTIN_SKILLS` is therefore autocomplete
metadata, not proof that manual compaction works in every runtime.

### Extension platform path and reload behavior

`composer-slash` is a launcher contribution, not a Claude command. A pack
contributes `entrypoints/<name>.yaml`; the installed first-party launchers are:

| Trigger | Contribution | Target | Availability |
| --- | --- | --- | --- |
| `/pr-walkthrough` | `market-packs/pr-walkthrough/entrypoints/pr-walkthrough-open.yaml` | `spawn` route `run`, then `pr-walkthrough.panel` in the child session | only while reconciled/installed |
| `/terminal` | `market-packs/terminal/entrypoints/terminal-slash.yaml` | `channel-panel` terminal | only while reconciled/installed |

`reconcilePackEntrypointsForProject(projectId)` fetches contributions,
generation-guards the apply, and replaces the launcher map. It runs at startup
and on project/session reconciliation (`src/app/main.ts` and
`src/app/session-manager.ts`). Consequently the composer must derive launchers
at filter/send time from `listLauncherEntrypoints("composer-slash")`, as it does
today; it must never persist a launcher name in a draft or cache. A reload simply
reconciles the current project again. A removed or disabled pack disappears, and
a stale send produces a non-destructive launcher-unavailable result rather than
a prompt or a guessed route.

`runLauncherEntrypoint(keyOrId, onResult, options)` is the sole dispatch
chokepoint. Its compound `{packId}\0{id}` key preserves same-id launchers; its
pack-bound host is minted via `setLauncherHostFactory`, so D2 must retain the
compound key and must not replace it with a Claude command implementation.

## D2 command inventory and precedence

Only commands backed by a current Bobbit execution path appear in the composer.
The displayed list is a merge, not an SDK command inventory:

| Source | Item | Handling | Runtime condition |
| --- | --- | --- | --- |
| Bobbit control | `/compact` | local composer dispatch to the existing `AgentInterface` compaction path; no model prompt | Pi session with callable `compact` only |
| Pack contribution | registered `composer-slash` entries | `runLauncherEntrypoint` with the exact compound key | active project registry contains the entry |
| User/Bobbit skills | project, personal, legacy, custom, built-in-file, and enabled pack skills from `/api/slash-skills` | autocomplete completes text; server `resolveSkillExpansions` injects the existing skill body before runtime delivery | current project/cwd resolution; `userInvocable !== false` |

There are no other built-in Bobbit slash controls in the current runtime. In
particular, a Bobbit **tool** such as `review_open` or goal-management tools is
not a composer command and must not be invented as one.

### Collision policy

1. The composer never queries, mirrors, or renders the Claude Agent SDK bundled
   command list. `settingSources: []` remains the configuration boundary.
2. An exact registered Bobbit control or pack launcher is intercepted before
   `onSend`; it cannot reach the SDK as `/name`.
3. A discovered Bobbit skill has priority over a same-named Claude bundled
   command. It is sent through the existing WebSocket path and expanded before
   `ClaudeAgentSdkBridge::prompt()`. This makes a user skill named `/goal` or
   `/review` Bobbit-owned rather than silently invoking Claude semantics.
4. A name that is neither a current Bobbit control/launcher nor a discovered
   skill is not advertised and is an ordinary prompt. D2 does not reserve
   undocumented Claude names, manufacture Bobbit equivalents for `/goal` or
   `/review`, or reject normal prose merely because it starts with `/`.
5. Duplicate visible names preserve the current safety rule: a skill wins over a
   pack launcher in autocomplete. A launcher is invoked only when its exact
   full-line parser resolves one unambiguous registered launcher. No bare-id
   fallback may select one of multiple same-id pack launchers.

This is deliberately narrow: it prevents Bobbit/Claude ambiguity for Bobbit
entries without claiming ownership of unconfigured Claude behavior.

## Proposed composition

Introduce one app-owned resolver, for example
`src/app/composer-slash-dispatch.ts`, rather than adding branches to the SDK
bridge or an SDK extension:

```ts
type ComposerRuntime = "pi" | "claude-agent-sdk";

type ComposerSlashDispatch =
  | { kind: "compact" }
  | { kind: "launcher"; entrypointKey: string; label: string; body: Record<string, unknown> };

function resolveComposerSlashDispatch(
  text: string,
  input: { runtime: ComposerRuntime; hasAttachments: boolean },
): ComposerSlashDispatch | undefined;
```

`MessageEditor::handleSend()` calls the resolver after its existing attachment
size check and before the ordinary `message-send` / `onSend` branch. For
`launcher`, retain the current clear, history, feedback, and
`runLauncherEntrypoint` behavior. For `compact`, call a typed callback supplied
by `AgentInterface`; that callback owns the current optimistic message,
attachment-draft cleanup, animation, and `session.compact()` behavior. It must
return `undefined` for the SDK runtime so a synthetic `/compact` cannot swallow
a prompt in an SDK session.

`AgentInterface` derives runtime from the current session model/provider
(`claude-agent-sdk` selects the SDK; all other current providers select Pi) and
passes the callback/capability into `MessageEditor`. This is UI capability
projection, not an SDK configuration change. Do not probe with a function-name
check alone: the SDK bridge has a `compact` method whose defined result is
unsupported.

Skills are intentionally not reimplemented in this resolver. The editor keeps
its existing autocomplete completion. `ws/handler.ts::resolveSkillExpansions`
remains the only body/substitution/inline-expansion owner; it continues to
produce the `modelText` given to either Pi or the SDK. This preserves arguments,
inline skill behavior, chips, snapshots, sandbox path headers, and reload
history without copying skill content to a worktree.

### Send flow

```text
textarea input
  -> MessageEditor autocomplete: API skills + current pack entrypoints
  -> Enter/send
     -> full-line supported Bobbit control? local AgentInterface callback
     -> full-line registered pack launcher? runLauncherEntrypoint(key, ...)
     -> otherwise MessageEditor.onSend
        -> AgentInterface.sendMessage -> RemoteAgent.prompt -> WebSocket prompt
        -> resolveSkillExpansions / file mentions -> enqueuePrompt(modelText)
        -> ClaudeAgentSdkBridge.prompt(modelText) or Pi bridge
```

Normal prompts, unknown slash-prefixed text, attachment sends, and inline skills
all take the final branch. Attachments prevent launcher/control interception;
they retain the established ordinary prompt behavior rather than silently
throwing away files.

## Failure and reload behavior

| Condition | Result |
| --- | --- |
| SDK session types `/compact` | command is absent from autocomplete and is sent as ordinary text; no false optimistic compaction or unsupported RPC |
| Pi compaction fails | preserve existing compaction error/event behavior; do not fall through into an SDK/agent prompt |
| Pack uninstalled/disabled/reconciled away before send | no launcher match; ordinary prompt pass-through, never a stale host call |
| Launcher route/channel fails after a valid match | existing pending-to-error launcher feedback; editor was cleared/history recorded once; no agent prompt and no automatic retry |
| `/api/slash-skills` fails | retain existing best-effort empty skill list while current pack registry remains usable; ordinary prompts still send |
| User skill changes after a send | current server snapshot semantics apply: persisted `SkillExpansion.expanded` stays replayable; a new send resolves the current skill |
| Reload/session or project switch | draft restoration remains text-only; skill list refetches for cwd/project and pack registry re-reconciles; no command state is persisted |

## Scoped verification plan

Add focused coverage only; no new Claude settings fixture or worktree command
files are allowed.

1. Extend `tests2/dom/message-editor-slash.test.ts` to prove skill autocomplete
   remains a completion-only operation and a selected/typed user skill calls the
   ordinary send path unchanged.
2. Extend `tests2/dom/message-editor-pack-slash.test.ts` to pin exact compound
   entrypoint dispatch, same-id ambiguity refusal, and launcher never calling
   `onSend`.
3. Add a small DOM test for the resolver/callback boundary: Pi `/compact`
   invokes the local handler; SDK `/compact` is absent/not intercepted; a plain
   prompt and an unknown slash prompt reach `onSend`; attachments bypass command
   interception.
4. Extend `tests2/core/claude-agent-sdk-tool-surface.test.ts` with the literal
   SDK isolation assertion: `settingSources` is exactly `[]`, `mcpServers` is
   only `bobbit`, and no command setting source is added by D2.
5. Add `tests2/browser/journeys/claude-sdk-composer-slash.journey.spec.ts` using
   the real composer/session harness with deterministic SDK bridge deps. Cover:
   autocomplete and selection of a user skill, a successful pack launcher,
   ordinary prompt delivery to the fake SDK, SDK `/compact` pass-through/no
   compaction, then reload and repeat autocomplete/ordinary prompt delivery.
   The journey must assert no generated `.claude/commands` or SDK settings
   source is involved.
6. Register the new browser file as a `v2Native` `browser`/`playwright` entry in
   `tests2/tests-map.json`; update the map census via
   `node scripts/testing-v2/gen-inventory.mjs` if required by the generator.
   Existing DOM/core files are already registered and should be amended in
   place, not duplicated.

Focused commands after implementation:

```bash
npx vitest run --config vitest.config.ts --project dom --project core \
  tests2/dom/message-editor-slash.test.ts \
  tests2/dom/message-editor-pack-slash.test.ts \
  tests2/core/claude-agent-sdk-tool-surface.test.ts
npx playwright test tests2/browser/journeys/claude-sdk-composer-slash.journey.spec.ts
npm run check
```

## Scope ledger

| In scope | Explicitly out of scope |
| --- | --- |
| Composer resolver/callback wiring, runtime-gated `/compact`, existing pack launcher reuse, and focused DOM/core/browser tests | Claude SDK private hooks, command files/settings sources, worktree materialization, or changing `settingSources` |
| Current Bobbit skills and pack entrypoint dispatch semantics | New Bobbit `/goal` or `/review` commands, aliases for Claude commands, or importing the Claude command catalogue |
| Existing server skill expansion before either runtime receives a prompt | Replacing `resolveSkillExpansions`, changing skill files, changing tool policy/MCP surface, or changing SDK transcript storage |
| Reconcile/reload coverage for current pack registry and drafts | Persisting command registry entries, launcher bodies, or SDK command state |
