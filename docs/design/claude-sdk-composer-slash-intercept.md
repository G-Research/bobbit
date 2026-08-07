# Claude SDK composer slash interception (D2)

## Decision

Approved D2 keeps Bobbit slash-command ownership in the composer and the existing
server prompt pipeline; it does **not** configure Claude commands. The client
intercepts an exact, full-composer Bobbit control command before `onSend`, while
skills retain their existing server-side expansion before the prompt is delivered
to the Claude Agent SDK. In an SDK session, the reserved exact text `/compact`
is consumed locally with an inline unsupported-command alert; it never reaches
`onSend` or the SDK, and the editor leaves its draft, attachments, and focus
unchanged. Pack launchers use the existing Extension platform
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
`src/server/skills/slash-skills.ts::BUILTIN_SKILLS` is metadata, not proof that
manual compaction works in every runtime. The composer must not expose that
synthetic skill as an SDK autocomplete item: exact SDK `/compact` is a hidden
reserved intercept which reports its unsupported status locally.

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
| Bobbit control | `/compact` | Pi: local `AgentInterface` compaction dispatch, no model prompt. SDK: hidden exact-text local intercept with an inline unsupported-command alert, no `onSend` or model prompt | visible only for a Pi session with callable `compact`; the SDK reservation is intentionally not a menu item |
| Pack contribution | registered `composer-slash` entries | `runLauncherEntrypoint` with the exact compound key | active project registry contains the entry |
| User/Bobbit skills | project, personal, legacy, custom, built-in-file, and enabled pack skills from `/api/slash-skills` | autocomplete completes text; server `resolveSkillExpansions` injects the existing skill body before runtime delivery | current project/cwd resolution; `userInvocable !== false` |

There are no other built-in Bobbit slash controls in the current runtime. In
particular, a Bobbit **tool** such as `review_open` or goal-management tools is
not a composer command and must not be invented as one.

### Collision policy

1. The composer never queries, mirrors, or renders the Claude Agent SDK bundled
   command list. `settingSources: []` remains the configuration boundary.
2. An exact registered Bobbit control or pack launcher is intercepted before
   `onSend`; it cannot reach the SDK as `/name`. The SDK-only `/compact`
   reservation is also intercepted even though it is not displayed: it alerts
   inline and preserves the editor draft, attachments, and focus.
3. A discovered Bobbit skill has priority over a same-named Claude bundled
   command. It is sent through the existing WebSocket path and expanded before
   `ClaudeAgentSdkBridge::prompt()`. Thus an exact discovered user/Bobbit skill
   named `/goal` or `/review` is Bobbit-owned rather than silently invoking
   Claude semantics.
4. Conversely, when no current Bobbit skill exists for the exact token,
   `/goal` and `/review` are not reserved: they take the ordinary `onSend` path
   as raw prompt text. Near-prefixes (for example `/goa` or `/reviewing`) never
   inherit an exact command's dispatch; they are ordinary prompts unless they
   are themselves an exact current skill/control/launcher match. D2 does not
   manufacture Bobbit equivalents for Claude commands or reject prose merely
   because it starts with `/`.
5. Build one shared composer command registry for both menu filtering and send
   resolution. It contains visible eligible skills, registered launchers, and
   non-menu reservations such as SDK `/compact`; it also records every
   server-recognized skill name as a launcher collision claim, including a skill
   hidden from the menu. A launcher masked by any such skill cannot be visible
   or dispatchable. This single source prevents hidden-skill/visible-launcher
   drift while preserving the rule that a skill wins over a pack launcher.
   A launcher is invoked only when its exact full-line parser resolves one
   unambiguous registered compound key. No bare-id fallback may select one of
   multiple same-id pack launchers.

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
  | { kind: "unsupported-compact" }
  | { kind: "launcher"; entrypointKey: string; label: string; body: Record<string, unknown> };

function resolveComposerSlashDispatch(
  text: string,
  input: { runtime: ComposerRuntime; registry: ComposerSlashRegistry },
): ComposerSlashDispatch | undefined;
```

`ComposerSlashRegistry` is built once from the current skill catalogue and
`listLauncherEntrypoints("composer-slash")`, then supplies both autocomplete
items and `resolveComposerSlashDispatch()`. It distinguishes menu visibility
from collision ownership: a hidden server-recognized skill contributes a
collision claim and uses the ordinary send path, but cannot leave a same-named
launcher visible or dispatchable.

`MessageEditor::handleSend()` calls the resolver after its existing attachment
size check and before the ordinary `message-send` / `onSend` branch. For
`launcher`, retain the current clear, history, feedback, and
`runLauncherEntrypoint` behavior. For Pi `compact`, call a typed callback
supplied by `AgentInterface`; that callback owns the current optimistic message,
attachment-draft cleanup, animation, and `session.compact()` behavior. For
`unsupported-compact` in an SDK session, render the inline alert and return
without clearing, recording history, changing attachments, moving focus, or
calling `onSend`. This exact `/compact` reservation applies even when
attachments are present; it does not silently send or discard them.

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
  -> ComposerSlashRegistry: current skills + current pack entrypoints + hidden reservations
  -> MessageEditor autocomplete: registry-visible items
  -> Enter/send
     -> exact SDK `/compact`? inline alert; preserve draft/attachments/focus
     -> full-line supported Pi Bobbit control? local AgentInterface callback
     -> full-line registered, unmasked pack launcher? runLauncherEntrypoint(key, ...)
     -> otherwise MessageEditor.onSend (including absent `/goal`/`/review` and near-prefixes)
        -> AgentInterface.sendMessage -> RemoteAgent.prompt -> WebSocket prompt
        -> resolveSkillExpansions / file mentions -> enqueuePrompt(modelText)
        -> ClaudeAgentSdkBridge.prompt(modelText) or Pi bridge
```

Normal prompts, unknown slash-prefixed text, attachment sends, and inline skills
all take the final branch. Attachments prevent launcher and supported-control
interception, retaining established ordinary prompt behavior rather than
silently throwing away files. The sole exception is the hidden exact SDK
`/compact` reservation, which consumes the command while preserving those files
and the draft for user correction.

## Failure and reload behavior

| Condition | Result |
| --- | --- |
| SDK session types exact `/compact` | command is absent from autocomplete, consumed before `onSend`/SDK delivery, and shows an inline unsupported-command alert without changing draft, attachments, or focus |
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
   invokes the local handler; exact SDK `/compact` is hidden, alerts inline, and
   never calls `onSend` while preserving draft/attachments/focus; a plain prompt,
   absent `/goal`/`/review`, and near-prefixes reach `onSend`; attachments bypass
   launcher/supported-control interception. Pin that a hidden skill collision
   masks a same-named launcher in both menu and send resolution.
4. Extend `tests2/core/claude-agent-sdk-tool-surface.test.ts` with the literal
   SDK isolation assertion: `settingSources` is exactly `[]`, `mcpServers` is
   only `bobbit`, and no command setting source is added by D2.
5. Add `tests2/browser/journeys/claude-sdk-composer-slash.journey.spec.ts` using
   the real composer/session harness with deterministic SDK bridge deps. Cover:
   autocomplete and selection of a user skill, a successful pack launcher,
   ordinary prompt delivery to the fake SDK, hidden SDK `/compact` inline-alert
   consumption/no SDK delivery, then reload and repeat autocomplete/ordinary
   prompt delivery.
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
| Shared menu/send registry for current Bobbit skills, hidden skill collision claims, and pack entrypoint dispatch semantics | New Bobbit `/goal` or `/review` commands, aliases for Claude commands, or importing the Claude command catalogue |
| Existing server skill expansion before either runtime receives a prompt | Replacing `resolveSkillExpansions`, changing skill files, changing tool policy/MCP surface, or changing SDK transcript storage |
| Reconcile/reload coverage for current pack registry and drafts | Persisting command registry entries, launcher bodies, or SDK command state |
