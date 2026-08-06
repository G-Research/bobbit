# EP-12 — Thinking selector extraction

**Status:** implemented design record. **Depends on:** EP-2 advisory selections, EP-6 exact `decide` grants, EP-11's bounded decision dispatcher, and the built-in first-party-pack pipeline. This slice moves the optional fallback selector only. It does not loosen runtime model safety or reclassify a configured/user choice as extension advice.

## Decision

Replace the core fallback of `"medium"` (and the duplicated selection/call paths that manufacture it) with a first-party schema-2 decision-hook pack. The pack is provided in place but is **default-disabled**. When it is explicitly enabled and the project grants its exact `decide` tuple, it returns the same canonical `thinking: "medium"` proposal that core previously chose when no explicit choice exists. The existing EP-2 reducer, active-pack ordering, grant fences, trace, and verified runtime tuple path accept it.

Consequences:

- **No active selector is a no-op.** Core does not import a hook, invent a fallback level, write a tuple, or make a thinking RPC merely because the pack exists on disk. A disabled, absent, shadowed, ungranted, or revoked selector is equivalent to no selector.
- **Enabled + granted first-party selector preserves current fallback behaviour.** It supplies `medium` at the same pre-spawn and post-turn decision points where the legacy fallback was used. The host clamps that proposal against the exact model before Pi observes it.
- **Configured/user choices remain core policy.** An authenticated WebSocket model/thinking selection, an explicit caller `initialThinkingLevel`, a role `thinkingLevel`, a configured `default.sessionThinkingLevel`, and a recovered verified tuple are not heuristic output. Core resolves their established precedence, fences extensions behind them, and only clamps/applies the resulting candidate. The selector never learns or changes a pin.
- **Model support remains core policy.** `src/shared/thinking-levels.ts`, `src/server/agent/thinking-level-clamp.ts::clampThinkingLevelForModel()`, and `src/server/ws/runtime-model-selection.ts` remain the final canonical/model ceiling, read-back, persistence, rollback, and broadcast owners. The pack cannot send an RPC, set a model, persist a pin, or bypass `SessionCommandSerialiser`.

This is deliberately not a second heuristic. After migration, core has explicit-choice resolution plus safety enforcement; the only optional fallback choice lives in the pack.

## Implemented behaviour

The built-in `thinking-selector` pack is shipped but default-disabled. Enabling the pack merely makes its hook eligible to run; a project must also grant the exact `decide` capability to `default-thinking`. These are separate opt-ins so neither the presence of a first-party pack nor a Market toggle silently creates selection authority.

With both opt-ins, the hook makes one pure `medium` proposal at `sessionSetup` and `afterTurn`. Setup awaits the existing decision dispatcher once so its reduced result can become a spawn candidate. After-turn work remains detached and uses the existing advisory consumer. In either case, the host admits the proposal, resolves precedence, clamps it to the exact model, and uses the established verified tuple path. If the pack is absent, disabled, shadowed, ungranted, or revoked, no optional fallback is invented in core.

Core deliberately remains responsible for explicit choices and safety. Authenticated user selections, caller-provided startup choices, role/default configuration, and a matching durable tuple express an operator or recovery decision rather than a heuristic. They suppress advice. The extension cannot access pins or make a mutation; immediately before a live write the core rechecks the session, grant, and explicit-choice fence inside the per-session command serialiser. It then clamps against current model metadata, requires Pi read-back, persists only the verified tuple, and broadcasts authoritative state. This keeps model capabilities, operator intent, and recovery correct even when an extension is disabled, stale, or racing a human action.

## Baseline and exact extraction boundary

Before extraction, `src/server/agent/session-manager.ts` mixed the selection policy with trusted runtime work:

| Legacy symbol/path | Legacy role | EP-12 disposition |
|---|---|---|
| `SessionManager.resolveThinkingLevelForModel()` | Selects role/default/preferred and falls back to `"medium"`, then clamps. | Split. Retain only an explicit-candidate-to-clamp helper; remove the no-candidate `medium` fallback and preference-ranking heuristic from this helper. |
| `resolveCurrentCatalogThinkingLevel()` / `resolveCurrentCatalogPreferredThinkingLevel()` | Finds the exact selectable model and calls the mixed helper. | Replace with an explicit-candidate clamp boundary. It must reject/unavailable-fence stale model data exactly as today, but must not pick a fallback. |
| `resolveInitialThinkingLevel()` and `session-setup.ts::resolveBridgeOptions()` | Creates a thinking spawn pin before Pi starts. | Replace with the shared setup-selection result described below. Explicit choices still produce a clamped bridge pin; absent choices invoke the active selector once. |
| `tryAutoSelectModel()`'s `commitExactSpawnTuple()` and fallback branches | Applies and read-backs a complete tuple, currently deriving another `medium` candidate. | Keep verified tuple read-back/persistence/broadcast. It receives either a clamped explicit/setup proposal or no requested level; delete its fallback selection branches. |
| `tryApplyDefaultThinkingLevel()` and `session-setup.ts::postSpawn()` | Redundant post-spawn default selection/read-back path. | Remove the superseded fallback/call path. Retain only a minimal exact-tuple verifier where a legacy recovery path genuinely lacks a verified tuple; it must not select a level. |
| `_setupInitialThinkingAuthorities` / `retainSetupInitialThinkingAuthority()` | Temporarily carries a caller-provided level through controlled model fallback. | Retain only as provenance for an explicit caller choice, rename to make that scope clear, and never use it to fabricate `medium`. |
| `src/server/ws/runtime-model-selection.ts::{applyRuntimeSessionModelSelection,applyRuntimeSessionThinkingSelection,applyVerifiedRuntimeSessionThinkingMutation}` | Human command verification, clamp, Pi mutation/read-back, persistence, recovery and broadcast. | Unchanged authority; user paths remain the only writers of `HumanSelectionPins`. |
| `src/server/agent/advisory-thinking-consumer.ts::AdvisoryThinkingConsumer` | Existing live after-turn EP-2 application fence. | Reuse for post-turn selection. Extend its shared fences, not a second mutation path, for the setup hand-off. |

`HumanSelectionPins` in `src/server/agent/session-store.ts` and the authenticated `set_model` / `set_thinking_level` branches in `src/server/ws/handler.ts` are deliberately outside the extraction. Their post-read-back writes must continue to win over an extension even if a hook was already running.

## Reused decision surface and data flow

EP-2 already exposes `DecisionHookDispatcher`, strict `DecisionHookOutput`, immutable `availableSelections`, active-pack priority, `resolveExtensionGrant()`, module-worker timeouts, and safe trace rows. EP-12 must extend that path rather than adding a selector loader, a hook runner, a grant store, or a direct pack-to-session callback.

### Setup selection

The legacy fallback matters before the first prompt, so post-turn-only application is insufficient. Add one narrow **awaited setup selection** operation to the existing dispatcher/lifecycle composition:

```text
SessionManager/create or restore chooses exact model
  -> core resolves an explicit thinking candidate, if any
     -> explicit candidate: core clamp -> bridge initialThinkingLevel
     -> no explicit candidate: LifecycleHub/DecisionHookDispatcher setup selection
          -> active hook list -> exact decide grant before import
          -> worker decide(ctx) -> strict selection validation/admission
          -> fresh grant check -> EP-2 deterministic reducer
          -> winning thinking proposal or undefined
  -> core clamp against the exact chosen model
  -> bridge --thinking only when there is a clamped candidate
  -> existing Pi state read-back -> verified tuple persistence/broadcast
```

The setup operation is not a new executor. `LifecycleHub` delegates to the existing `DecisionHookDispatcher`, which uses its existing `dispatchHooks()`, `ModuleHost.invoke()`, `admitAdvisorySelection()`, `reduceAdvisorySelectionCandidates()`, and exact grant resolver. It returns a typed, immutable winning thinking candidate to the session setup planner in addition to its normal safe outcome rows. The planner never accepts raw hook output.

To avoid a double invocation, `LifecycleHub.dispatch("sessionSetup", ...)` must perform this one dispatcher call in setup-selection mode and return its selection result to `resolveDynamicContext()` / the setup plan; it must not also launch the detached generic decision branch for the same event. Non-selection request/advisory outputs retain their current isolated handling. Other lifecycle events remain detached. This preserves one import, one timeout budget, one priority reduction, and one trace sequence for each hook event.

The setup context contains only the existing decision fields plus immutable `availableSelections`; it does not receive `SessionInfo`, a preferences store, pin values, model credentials, or an apply function. The selector can nominate only a canonical value in `THINKING_LEVELS`. The chosen model is not extension authority: after selection, `clampThinkingLevelForModel(requested, provider, modelId)` is mandatory and its effective level alone enters bridge args.

### Explicit-choice fence

Before setup dispatch and again immediately before setting a live level, core evaluates an explicit-choice predicate. It is a policy check, not an extension-configured precedence list:

1. verified authenticated human thinking/model pin for the session;
2. caller-supplied `initialThinkingLevel` (verification/delegate/recovery caller contract);
3. active role `thinkingLevel` and configured `default.sessionThinkingLevel` according to the current role/default precedence; and
4. an existing verified durable tuple on restore/replacement, when its model remains the selected model.

An explicit candidate is canonicalized and clamped, never trusted verbatim. It suppresses the setup selector and causes `AdvisoryThinkingConsumer` to return `pinned` before any live RPC. A role/default choice is an operator-configured selection, even though it is not stored in `HumanSelectionPins`; it must receive the same no-override treatment. A durable tuple is recovery evidence, not a newly written human pin.

The dispatcher's existing after-turn consumer keeps its current two fences: active exact grant plus pin before invocation, then the serialized pre-mutation re-read in `AdvisoryThinkingConsumer.assertPreMutationAuthority()`. Extend that authoritative re-read to use the shared explicit-choice predicate so a user/operator change racing a worker wins. An extension result must never create, update, or clear `humanSelectionPins`.

### After-turn selection

The first-party hook also declares `afterTurn`. This retains the established EP-2 live application route for sessions that began without an explicit choice and permits a newly enabled/granted selector to take effect on an already-running unpinned session. The flow remains:

```text
final afterTurn -> detached DecisionHookDispatcher
  -> grant before import -> strict selection/reducer -> fresh grant
  -> AdvisoryThinkingConsumer serialiser -> explicit-choice/pin re-read
  -> clamp current live model -> Pi setThinkingLevel -> exact read-back
  -> SessionStore verified tuple + state broadcast + safe trace
```

No hook, no proposal, an unavailable proposal, a disabled pack, or a missing/revoked grant makes no runtime mutation. A revoked late worker result is denied before reducer/application. Trace values retain only the final effective canonical thinking token; extension prose, the raw request, pin values, availability snapshots, and model credentials remain excluded.

## First-party selector pack

Add a shipped source at `market-packs/thinking-selector/`:

```text
market-packs/thinking-selector/
  pack.yaml
  hooks/default-thinking.yaml
  lib/default-thinking-selector.mjs
```

```yaml
# pack.yaml
schema: 2
name: thinking-selector
description: Optional first-party fallback thinking-level selector.
version: 1.0.0
defaultDisabled: true
contents:
  roles: []
  tools: []
  skills: []
  entrypoints: []
  hooks: [default-thinking]
  providers: []
  mcp: []
  pi-extensions: []
  runtimes: []
  workflows: []
```

```yaml
# hooks/default-thinking.yaml
id: default-thinking
module: ../lib/default-thinking-selector.mjs
events: [sessionSetup, afterTurn]
mode: decide
capabilities: []
budget:
  maxTokens: 64
  timeoutMs: 1000
```

Its module is intentionally pure and has no Host API, configuration, I/O, clock, random value, score, explanation, or mutation:

```js
export default {
  decide() {
    return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "medium" } };
  },
};
```

Add only `"thinking-selector"` to the explicit first-party allowlist in `scripts/copy-builtin-packs.mjs`; the existing build ships it under `dist/server/builtin-packs/market-packs/thinking-selector/`. `builtinFirstPartyPackEntries()` and the ordinary resolver derive the server-owned pack id `thinking-selector` from that path. No `server.ts` special case or implicit hook registration is allowed.

The pack is visible in the existing Built-in Market catalogue but `defaultDisabled: true` makes its hook inactive until an operator enables the **hook** through the normal server-scope `pack_activation` row. Enabling remains only an execution ceiling. An operator must separately grant the exact project tuple:

```text
(packId: "thinking-selector", hookId: "default-thinking", capability: "decide")
```

`resolveExtensionGrant()` stays deny-by-default and has no first-party exception. A user-installed higher-precedence pack of the same name shadows it under normal resolver rules; activation/grants bind the winning active declaration, not an imagined built-in twin.

## Core changes and deletion ledger

| Path | Implementation |
|---|---|
| `src/server/agent/session-manager.ts` | Extract explicit-choice resolution from the mixed fallback logic; consume the setup selection result; remove every `?? "medium"` heuristic branch and the superseded `tryApplyDefaultThinkingLevel()` selector path. Keep model catalog validation, exact tuple verification/persistence, recovery, and broadcasting. |
| `src/server/agent/session-setup.ts` | Thread the awaited `sessionSetup` selection result into `SessionSetupPlan.bridgeOptions.initialThinkingLevel`; stop calling the removed default-thinking path after spawn. Preserve `skipAutoThinking` as an explicit caller opt-out and preserve explicit bridge pins. |
| `src/server/agent/lifecycle-hub.ts` | Add the one setup-selection return channel and suppress duplicate detached dispatch for that same `sessionSetup` decision invocation. All other decision dispatches remain detached. |
| `src/server/agent/decision-request-manager.ts` | Reuse one dispatcher implementation for setup and after-turn selection; expose only a typed reduced result, preserve strict validation, isolation, priority, fresh grants, and safe trace outcomes. |
| `src/server/agent/advisory-thinking-consumer.ts` | Centralize/reuse the explicit-choice/pin fence for live after-turn mutation. Keep `SESSION_COMMAND_SERIALISER`, fresh authorization, clamp, read-back, recovery `none`, persistence and broadcast behaviour. |
| `src/server/agent/thinking-level-clamp.ts`, `src/shared/thinking-levels.ts`, `src/server/ws/runtime-model-selection.ts`, `session-store.ts`, `ws/handler.ts` | Safety and authenticated-choice owners; no extraction/delegation of their policy or mutation responsibilities. |
| `market-packs/thinking-selector/**`, `scripts/copy-builtin-packs.mjs` | New optional first-party pack and explicit ship allowlist entry. |

Do not retain an inactive compatibility fallback in core. In particular, do not leave a `medium` default in `resolveThinkingLevelForModel`, `tryAutoSelectModel`, `tryApplyDefaultThinkingLevel`, a bridge-options fallback, or a recovery branch. Such a fallback would make absence of the extension hidden activation and invalidate the migration proof.

## Regression coverage

The coverage is deterministic: hook workers, model metadata, Pi RPC, registry order, grants, and clock are fixtures.

| Layer | File | What it proves |
|---|---|---|
| Core | `tests2/core/thinking-selector-extraction.test.ts` | The pack is schema-2, pure, default-disabled, and shipped through the normal first-party pipeline. It guards against a server special case, a residual `medium` fallback, or the deleted post-spawn selector call. |
| Core | `tests2/core/decision-hook-dispatcher.test.ts` | Setup uses the ordinary dispatcher/reducer once; missing or revoked grants do not import a hook, and late revocation cannot return a setup selection. |
| Core | `tests2/core/advisory-thinking-consumer.test.ts` and `tests2/core/runtime-model-selection.test.ts` | Pin and configured-choice fences make no RPC, application rechecks authority under the command serialiser, and mutation/read-back failures preserve the prior tuple and pin. |
| Browser | `tests2/browser/e2e/first-party-thinking-selector.spec.ts` | The installed pack is inert while disabled and while enabled without a grant; enabled plus an exact grant restores `medium`; model capability clamps it; reload and a user pin win; disabling or revoking returns to no-op. Context renders only safe host metadata. |

`tests2/browser/e2e/extension-advisory-thinking.spec.ts` remains the generic third-party selection and revocation journey. The first-party browser journey covers packaging and the two opt-in boundaries rather than duplicating that generic surface.

## Reproducible core owner/fan-out metric

The metric deliberately measures the optional-selector ownership, not all model safety code. Its tracked symbols are:

```text
resolveThinkingLevelForModel
resolveCurrentCatalogThinkingLevel
resolveCurrentCatalogPreferredThinkingLevel
resolveInitialThinkingLevel
tryApplyDefaultThinkingLevel
retainSetupInitialThinkingAuthority
_setupInitialThinkingAuthorities
```

The fixed pre-extraction baseline is tree `642a6e093`. The measured result is **37 → 3 owner references** in `src/server/agent/session-manager.ts` and **4 → 2 direct non-owner fan-out references** in `src/server/agent/session-setup.ts`. The two files are deliberately fixed in the measurement so the result cannot improve by narrowing the scan.

The five remaining lexical references are only the retained `resolveInitialThinkingLevel` compatibility boundary: its manager declaration and pipeline wiring plus the setup callback and use. It resolves configured role/default authority and clamps it; it does not manufacture a fallback or invoke an extension. Those references are safety/compatibility ownership, not an optional selector.

Run the following from the repository root before and after the migration. It compares the fixed baseline tree object with the candidate tree.

```bash
BASE=642a6e093 node --input-type=module <<'NODE'
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const symbols = [
  "resolveThinkingLevelForModel",
  "resolveCurrentCatalogThinkingLevel",
  "resolveCurrentCatalogPreferredThinkingLevel",
  "resolveInitialThinkingLevel",
  "tryApplyDefaultThinkingLevel",
  "retainSetupInitialThinkingAuthority",
  "_setupInitialThinkingAuthorities",
];
const files = [
  "src/server/agent/session-manager.ts",
  "src/server/agent/session-setup.ts",
];
const base = process.env.BASE;
const textAt = (rev, file) => rev
  ? execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" })
  : readFileSync(file, "utf8");
const measure = (rev) => {
  const rows = files.map(file => ({ file, text: textAt(rev, file) }));
  const hits = rows.map(({ file, text }) => ({
    file,
    hits: symbols.reduce((n, symbol) => n + text.split(symbol).length - 1, 0),
  }));
  return {
    ownerHits: hits.find(row => row.file.endsWith("session-manager.ts")).hits,
    fanoutHits: hits.filter(row => !row.file.endsWith("session-manager.ts")).reduce((n, row) => n + row.hits, 0),
    filesWithHits: hits.filter(row => row.hits).map(row => row.file),
  };
};
console.log(JSON.stringify({ before: measure(base), after: measure(undefined) }, null, 2));
NODE
```

The command reports the recorded `37 → 3` and `4 → 2` values. The retained `resolveInitialThinkingLevel` reference is intentionally included in that metric, so it must not be used as a forbidden-token scan. Run this separate scan for the deleted heuristic surface:

```bash
rg -n 'resolveThinkingLevelForModel|resolveCurrentCatalogThinkingLevel|resolveCurrentCatalogPreferredThinkingLevel|tryApplyDefaultThinkingLevel|retainSetupInitialThinkingAuthority|_setupInitialThinkingAuthorities|\?\? "medium"' \
  src/server/agent/session-manager.ts src/server/agent/session-setup.ts
```

It produces no matches in the implementation. Together, the stable metric and empty forbidden scan prove that the migration removed the optional fallback without claiming credit for removing core clamp, read-back, persistence, or explicit-choice policy.

## Scope boundaries

In scope: the optional `medium` fallback selector, exact decision grant/activation behaviour, setup hand-off through the existing dispatcher, first-party packaging, trace-safe outcomes, measured core reduction, and regression/browser coverage.

Out of scope: model selection extraction, role/default preference APIs, changing user WebSocket semantics, new grants or Marketplace grant UI, application of EP-2 model/role/workflow proposals, a new hook worker/runtime, moving `thinking-level-clamp.ts`, changing Pi recovery semantics, or modifying Hindsight/provider behaviour.
