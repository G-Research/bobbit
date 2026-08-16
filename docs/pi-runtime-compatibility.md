# Pi runtime compatibility

Bobbit depends on Pi for provider metadata, browser-side first-message streaming helpers, and the `pi-coding-agent` process that runs agent turns. Pi upgrades are runtime compatibility changes, not simple package bumps: they can affect browser bundle safety, model catalog reads, authentication, RPC lifecycle events, tool-result shapes, transcript metadata, compaction, sandbox credentials, and provider default selection.

This page records the durable Bobbit-side contracts added or reaffirmed across Pi runtime upgrades. The current runtime line pins these packages exactly and together:

- `@earendil-works/pi-agent-core@0.84.1`
- `@earendil-works/pi-ai@0.84.1`
- `@earendil-works/pi-coding-agent@0.84.1`

A mixed Pi line can compile while still breaking the spawned-agent runtime contract.

## Pi `0.84.1` reliable-turn compatibility

Bobbit upgraded the trio together from `0.82.1` to the newest compatible stable release containing Pi `0.84.0`'s reliable-turn fixes. The source/release audit covered the upstream changes that:

- flush prompts accepted while compaction is active;
- serialize manual and automatic compaction and preserve events across compaction;
- reject direct prompt submission inside Pi core while manual compaction is active;
- classify recoverable `length` stops as overflow, remove the truncated assistant tail, compact, and retry once; and
- change JSON/RPC `message_update` to delta-only payloads.

Bobbit adopts those Pi contracts rather than recreating Pi's internal retry or compaction queues. Bobbit's own responsibility is the durable browser/server outbox above the Pi boundary: it accepts and persists user intent while Pi cannot accept direct input, then releases it at the correct lifecycle boundary.

### Delta-only RPC and terminal authority

Pi `0.84.1` JSON/RPC `message_update` frames contain `assistantMessageEvent` deltas but no cumulative `message` and no `assistantMessageEvent.partial`. `RpcBridge` scopes one `PiAssistantStreamNormalizer` to each Pi process and reconstructs Bobbit's cumulative internal update stream from the preceding assistant `message_start.message`.

The adapter handles text, thinking, and progressive tool-call JSON. It tolerates a delta arriving without its matching start only when an authoritative message-start baseline exists. It resets on a new assistant start, `message_end`, final `agent_end`, process exit, or process failure.

`message_end.message` is terminal authority. Bobbit passes that provider/Pi terminal through the normal metadata projection; it never synthesizes the final answer from accumulated deltas. After a terminal reset, a stray delta cannot inherit the previous stream.

The Pi bridge normalization and browser transport compaction are separate layers:

- the bridge reconstructs Pi's delta-only wire format into Bobbit's cumulative internal event;
- Bobbit retains cumulative events for replay and legacy clients; and
- clients that advertise `assistantStreamDelta: 1` receive compact live deltas and reconstruct them against a self-contained baseline.

A failed browser reconstruction closes/reconnects instead of presenting a plausible corrupt stream. Snapshot attach re-establishes a cumulative baseline.

### Compaction and recoverable length

Pi emits `compaction_start` before compaction and `compaction_end` after releasing its compaction controller. Direct prompt submission during manual compaction is expected to reject inside Pi; Bobbit therefore queues above that boundary and does not call Pi while `session.isCompacting`.

`compaction_end.willRetry` describes the interrupted agent turn, not another compaction operation. Bobbit completes the compaction boundary and preserves continuation affinity while waiting for the final non-retry `agent_end`.

Pi `0.84.1` emits that final `agent_end` before clearing its active-run guard. The event completes Bobbit's terminal turn bookkeeping, but it does not admit a fresh prompt. Pi may still compact or process queued continuation work before `_emitAgentSettled()` clears the guard and emits `agent_settled`; Bobbit drains next-turn work only at that later boundary. Graceful Stop waits for and replays settlement, while hard Stop synthesizes it after killing the old process and marks interrupted compaction aborted. See [Context compaction](compaction.md#reliable-turn-fence-and-release).

For a recoverable assistant `stopReason: "length"`, Pi removes the first truncated tail, performs overflow compaction, and retries the input at most once. Bobbit assigns `assistantStreamId` values and emits `assistant_stream_invalidated` before retry output so the browser and snapshots mirror Pi's rewritten branch. Only the retry's final non-retrying terminal is canonical. See [Context compaction](compaction.md#recoverable-length-overflow).

### Steer acknowledgement boundary

Pi's `Agent.steer()` acknowledgement means the steer entered Pi's pending queue; it does not mean a user message entered the transcript. Pi keeps queued steers until the current response releases and emits each user start before the next model call. Bobbit assigns documented server-originated steers a server-owned stable occurrence identity at admission and retains that occurrence in its delivery outbox until the correlated Pi user event is surfaced. See [Reliable prompt and steer delivery](prompt-queue.md#receipt-settlement-and-snapshots).

### TypeBox v1 boundary

Pi `0.84.1` uses TypeBox v1. Bobbit pins `typebox@1.3.7` and migrates Pi-facing tool schemas and generated extension templates to `Type`/`Static` from `typebox`, avoiding incompatible v0/v1 `TSchema` values. `@sinclair/typebox` remains installed for unrelated legacy consumers; do not pass its schema objects into Pi v1 APIs.

### Pinning coverage

`tests2/core/pi-installed-contract.test.ts` executes the installed runtime to pin the aligned trio, delta-only event shape, terminal authority, manual-compaction ordering and prompt rejection, recoverable-length removal and one-retry cap, overflow `willRetry`, and steer queue acknowledgement boundary. `tests2/core/assistant-stream-delta.test.ts`, `assistant-stream-session-broadcast.test.ts`, and `tests2/dom/remote-agent-assistant-stream-delta.test.ts` pin bridge reconstruction and browser live/replay behavior.

## Historical Pi `0.82.1` compatibility outcome

### PR #1057 disposition (historical)

This table records the decision when PR #1057 was accepted. It remains the audit history for that delivery; the tuple-transition findings have since been resolved or closed as described in the current-status section below.

| Decision | Status |
|---|---|
| Compatibility | **Accepted with deferred findings at merge.** Dependency alignment, Opus 5 catalog/ranking, exact live selection, and the then-covered persistence, spawn, and inheritance paths passed. The conflicting role/default restore case remained deferred for follow-up. |
| Tests | **Passed.** The final verification run passed `npm run build`, `npm run check`, `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e`. Security review passed; optional agent QA was not enabled. |
| Immutable upstream audit | **Non-zero.** The isolated packed-consumer audit reports one high finding: Pi coding-agent's published shrinkwrap pins `brace-expansion@5.0.7`, affected by [`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg). This is immutable class C upstream packaging, not an audit-clean result. |
| Accepted-risk status | **Accepted.** The exact `brace-expansion@5.0.7` finding remains visible and was explicitly accepted without an audit fix, override, vendor, fork, repack, or weakened check. It is not a merge or release-eligibility blocker for this delivery. |
| Implementation verification | **Human-bypassed for PR #1057.** The final implementation review failed on the findings below. A human overseer advanced the gate for urgency; bypass is not a passing review result. |
| Release eligibility | **True for PR #1057 under the amended acceptance and explicit human decision.** At that decision, the delivery was release-eligible but neither audit-clean nor free of deferred findings. Any additional audit finding or unaccepted release failure remained blocking. |

### PR #1057 verification disposition and deferred findings (historical)

At final implementation commit `68dc74a4`, the build, type-check, unit, browser, and E2E command gates passed. The security review also passed. Optional agent QA was skipped because it was not enabled.

The final static review then raised these unresolved items at the time:

- **Deferred restore finding:** a role-backed session could prefer its role's configured thinking level over a later verified durable `effectiveThinkingLevel` during cold restore or force-abort replacement. Multiple reviewers traced this path, but no executable failing regression was run before the human decision to proceed. The later **Harden Tuple Transitions** follow-up owned deterministic reproduction and a focused fix.
- **Unexecuted review hypotheses:** the systems review proposed races involving wrong-target quarantine after restart, rollback of a concurrently committed tuple during staged role replacement, and reconnect publishing an in-flight mixed tuple. These were not demonstrated by executable reproductions in PR #1057 and were not reported there as confirmed defects. The follow-up exercised each hypothesis deterministically and changed production behavior only for confirmed defects.

For PR #1057, a human overseer bypassed the failed Implementation gate for **Urgency** after reviewing the aggregate. The bypass allowed the documentation and merge workflow to continue, but it did not erase the findings, convert failed reviews into passes, or make the optional QA step executed. The historical release eligibility above reflects that explicit decision and the amended accepted-risk policy.

### Harden Tuple Transitions follow-up (current status)

The follow-up ran deterministic reproductions after PR #1057. The historical implementation bypass remains recorded above, but these tuple-transition items are no longer deferred:

- **Restore and force-abort precedence is fixed.** When a complete durable `{provider, modelId, effectiveThinkingLevel}` exists, its thinking level wins during cold restore and force-abort. An already attached role is not new user intent. A new explicit `assignRole` remains role-first, with its requested thinking clamped against the exact selected model before read-back and persistence.
- **Runtime recovery is fenced to exact bridge ownership.** A stale mutation or restart bridge cannot stop, terminate, archive, or publish state for a newer role/restart replacement. Recovery rechecks canonical session and RPC bridge identity around asynchronous read-back, and publishes a newer bridge only when its complete read-back still matches current durability. The empty-transcript zombie decision uses the same coordinated ownership admission: an owned direct restart still fails closed and archives a genuine zombie, while queued stale recovery cannot archive a verified replacement.
- **The staged rollback hypothesis is closed without an extra production fix.** The existing deterministic A/B ordering test already proves that a failed staged role replacement cannot restore captured tuple A over a concurrently verified runtime tuple B. This narrow hypothesis required no duplicate test or behavior change.
- **Reconnect and `get_state` retain complete durability during mutation.** If the model step has moved to B while thinking is still from A, proactive attach and explicit state requests publish the previous complete durable tuple A, not mixed `{B, A-thinking}` state. The snapshot retains unrelated status, cost, and preparation fields. Matching live identity may preserve dynamic metadata; mismatched live identity cannot lend B's metadata to durable A. The complete B tuple becomes authoritative only after final verification and atomic persistence.
- **Fallback and inherited thinking remain tuple-correct.** When controlled fallback changes the selected model, Bobbit re-clamps the original explicit role, durable, or inherited thinking request against the exact current fallback `ApiModel`. It does not reuse a clamp from the failed model or replace inherited thinking with the global default. Normal and worktree setup persist a fallback tuple only after verification, and clear temporary setup authority on both success and failure.

Focused evidence:

- `tests2/core/orphan-tool-result-rehydration-boundaries.test.ts` covers durable-first cold restore and force-abort in both directions, explicit `assignRole` precedence, the existing A/B rollback ordering, stale recovery queued behind role replacement, and empty-transcript zombie admission.
- `tests2/core/runtime-model-recovery-ownership.test.ts` covers role bridge B replacing recovery bridge R during read-back, B committing before quarantine admission, and replacement C winning while B verification is held.
- `tests2/integration/context-bar-reconnect.test.ts` covers explicit `get_state`, second-connection hydration during partial mutation, complete durable metadata, and matching dynamic live metadata.
- `tests2/core/controlled-model-fallback.test.ts` covers exact fallback tuple verification, fresh and staged role reclamping, durable-thinking reclamping, and inherited thinking through normal and worktree setup.
- `tests2/core/runtime-model-zombie-recovery-repro.test.ts` retains the fail-closed canary for a genuinely owned, unverifiable recovery bridge.
- `tests2/core/rpc-bridge-spawn-args.test.ts` and `tests2/integration/host-agents-sandbox-inheritance.test.ts` retain exact tuple propagation across the shared host/sandbox argument boundary and inherited child sessions.

### Authoritative Claude Opus 5 catalog

Bobbit exposes the direct Anthropic model and every Opus 5 Amazon Bedrock profile published by Pi `0.82.1`. The exact provider and model ID are part of the model identity; regional Bedrock prefixes are not normalized away.

| Provider / exact model ID | Published name | API | Base URL | Cost `{input, output, cacheRead, cacheWrite}` |
|---|---|---|---|---|
| `anthropic/claude-opus-5` | Claude Opus 5 | `anthropic-messages` | `https://api.anthropic.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/au.anthropic.claude-opus-5` | Claude Opus 5 (AU) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/eu.anthropic.claude-opus-5` | Claude Opus 5 (EU) | `bedrock-converse-stream` | `https://bedrock-runtime.eu-central-1.amazonaws.com` | `{5.5, 27.5, 0.55, 6.875}` |
| `amazon-bedrock/global.anthropic.claude-opus-5` | Claude Opus 5 (Global) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/jp.anthropic.claude-opus-5` | Claude Opus 5 (JP) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |
| `amazon-bedrock/us.anthropic.claude-opus-5` | Claude Opus 5 (US) | `bedrock-converse-stream` | `https://bedrock-runtime.us-east-1.amazonaws.com` | `{5, 25, 0.5, 6.25}` |

All six entries are reasoning models with text and image input, a 1,000,000-token context window, a 128,000-token output limit, and `thinkingLevelMap: { xhigh: "xhigh", max: "max" }`. The direct Anthropic row also publishes this `compat` metadata:

```ts
{
  forceAdaptiveThinking: true,
  supportsTemperature: false,
  supportsStrictTools: true,
}
```

The Bedrock rows publish no model-level `compat` object, so Bobbit does not invent one; Pi's Bedrock adapter owns its adaptive-thinking behavior. Pi's catalog remains authoritative for API, endpoint, limits, input modes, pricing/cache rates, reasoning, thinking, and compatibility metadata.

Ordinary absent thinking-map entries retain the existing provider defaults, while `xhigh` and `max` require explicit non-null entries. Opus 5 therefore exposes the full supported ladder: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Selection uses the existing upward-first clamp against the exact selected model.

Server auto-selection and the UI picker share one browser-safe ranking function. Its Claude order is Fable 5 (`113`) > Opus 5 (`112`) > Sonnet 5 (`111`) > every older Opus (`110` or lower); existing non-Claude ranks are unchanged.

### Exact runtime tuple

The durable selection contract is:

```text
provider + modelId + normalized effectiveThinkingLevel
```

The picker sends one combined additive WebSocket frame:

```ts
{ type: "set_model", provider, modelId, thinkingLevel }
```

The client clamps the current thinking level against the selected catalog row, optimistically updates both fields, and sends no follow-up thinking frame for the same pick. Standalone `set_thinking_level` remains supported. The gateway serializes both mutation messages with existing per-session command ordering.

For a live model selection, the gateway validates the exact provider/model against the current session-selectable catalog, applies the model, verifies exact provider/model read-back before applying thinking, then verifies the complete effective tuple. Only that verified tuple is atomically persisted, mirrored for later spawns, and broadcast as authoritative state. An unrequested Pi or configured fallback is never a successful live selection.

Failure keeps the previous durable tuple unchanged. Bobbit broadcasts a complete observed or durable tuple to correct both optimistic model and thinking state, makes one bounded rollback to the previous tuple, and verifies it. If live state or rollback is incomplete, unreachable, or unverifiable, the existing agent restart path replaces the bridge from unchanged durability; a partially mutated bridge does not continue live. The client also requests authoritative state after either model or thinking selection errors.

Persistence adds only `effectiveThinkingLevel` beside the existing exact provider/model fields. Settled reconnect, reload, archived-state, and rehydration paths use the verified tuple rather than a placeholder. A complete durable tuple now also takes precedence over an attached role default during cold restore and force-abort; only a new explicit role assignment applies new role thinking. Legacy rows remain readable, but a new complete tuple becomes durable only after runtime verification.

Host and sandbox processes use the same argument builder and receive separate arguments:

```text
--provider anthropic --model claude-opus-5 --thinking xhigh
--provider amazon-bedrock --model eu.anthropic.claude-opus-5 --thinking max
```

The provider/model split occurs at the first slash only, preserving slashes inside model IDs. After all raw arguments and realm wiring are assembled, the final spawn boundary resolves Pi's effective last-wins tuple, preserves requested and effective identity separately, validates the effective model against the exact host or sandbox catalog, and clamps thinking against that row. It then emits one canonical tuple. The same guard covers creation, delegates, restore, role/force-abort replacement, review/QA, fork/continue, host, and sandbox paths; invalid or cross-provider tuples fail before bridge construction.

### Deferred provider and login surfaces

Pi `0.82.1` adds provider and login capabilities that Bobbit does not adopt in this upgrade. Exact provider `kimi-coding` is a canary for an unadopted provider, not a special credential or security class. It is absent or rejected across Bobbit-owned catalog, defaults, roles, runtime selection, initial-model, delegate, and team surfaces. No Kimi login, new Pi-native provider/login UI, credential store, OAuth path, sandbox token policy, or environment-forwarding policy is added.

This boundary compares the provider exactly; it does not scan model IDs for `kimi`. Kimi-named IDs remain valid under an existing selectable AIGW, custom, local, Moonshot, or legacy gateway provider. Existing custom/local providers, legacy gateway models, OpenRouter API-key models, and supported login paths therefore retain their previous behavior.

### PR #1057 focused coverage (historical)

The PR #1057 focused canaries covered:

- exact aligned Pi `0.82.1` root, nested, and packed-consumer structure;
- the Anthropic and five Bedrock catalog rows, full metadata, shared rank, and `xhigh`/`max` clamping;
- one combined request through the real gateway/mock-agent boundary, atomic durability, settled reconnect, archived state, covered non-conflicting cold restore, host/sandbox argv, and child/team inheritance;
- exact-provider `kimi-coding` rejection while preserving Kimi-named custom/local and AIGW models;
- correction of both optimistic fields, verified rollback, and restart after an unverifiable partial mutation; and
- the established browser-import, OAuth, RPC correlation/retry/thinking, tool lifecycle, compaction, transcript, extension, binary-resolution, and sandbox-status compatibility boundaries.

The PR #1057 browser journey selected `anthropic/claude-opus-5`, verified its authoritative limits, image/reasoning flags and complete thinking ladder, sent the combined `xhigh` tuple through a mock-backed session, reloaded and re-verified authoritative state, then deleted the session and restored preferences.

## Pi `0.82.1` dependency-only Phase 0 baseline

The dependency-only baseline was measured on 2026-07-27 before any feature production or test change.

- Current `origin/master`: `60aa0d4099f58070217e9ef0c8fe7a683d955d30`.
- Design-only parent: `94f71d2f7db96f0da319692fdd9ea683a4599d0c` (the current master plus the approved design commits).
- Dependency-only commit: `df799ab7cc1075b6f884c960c4e38c04b88c45fe`.
- Exact direct pins: `@earendil-works/pi-agent-core@0.82.1`, `@earendil-works/pi-ai@0.82.1`, and `@earendil-works/pi-coding-agent@0.82.1`.

### Controlled lock regeneration and graph

The lock was regenerated using [the `0.82.1` design procedure](design/minimal-pi-0.82.md#fresh-base-and-exact-lock-regeneration): `.npmrc` was backed up outside the worktree and removed, the installed old coding-agent shrinkwrap was deleted, and `npm install --package-lock=true` freshly extracted `node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json` at `0.82.1`. `.npmrc` was restored byte-for-byte before testing. A following plain `npm install` with `shrinkwrap=false` left `package.json`, `package-lock.json`, and `.npmrc` byte-identical.

The parsed command

```bash
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui brace-expansion protobufjs --all --json
```

exited zero with no invalid, missing, stale, or extraneous edge. Every reported direct and nested Pi occurrence is exactly `0.82.1`. The development graph reports `protobufjs@7.6.5` on both paths, `brace-expansion@5.0.7` below coding-agent, and the unrelated development-only `brace-expansion@5.0.8` path below c8. The published coding-agent shrinkwrap itself contains aligned Pi `0.82.1`, `protobufjs@7.6.5`, and `brace-expansion@5.0.7`.

### Dependency-only compatibility results

| Boundary | Result |
|---|---|
| `npm run check` | Passed after generating the ignored `dist/server` type-import prerequisite with `npm run build:server`; a subsequent direct `npm run check` passed. |
| Design's nine-file core Pi canary command | 9 files passed; 92 tests passed and 1 platform-specific transcript test skipped. |
| Extended OAuth, RPC lifecycle, tool normalization, transcript reader, Pi extension, binary, shrinkwrap-fixture, and sandbox-status canaries | 13 files passed; 167 tests passed and 1 platform-specific extension test skipped. |
| Compaction DOM canary | 1 file passed; 2 tests passed. |
| Sandbox missing/stale-image coverage | The existing two-test `sandbox-status` Docker-context canary passed. No focused image-version canary exists in `tests2/` or `tests/`; no dependency-only edit to `sandbox-status.ts` is justified. |
| Packed-consumer graph/binary canary | Reached the unchanged assertion expecting package name `bobbit`, but `npm pack` returns the current manifest name `@gresearch/bobbit`. Both the manifest name and canary are byte-identical to `origin/master`, so this pre-existing failure occurs before any Pi graph or binary assertion and is not a dependency-bump delta. |

### Deterministic failure ledger

**No deterministic dependency-only failures.** There are no `D*` entries and therefore no compatibility production change is justified by the `0.82.1` bump.

The fresh-worktree `npm run check` prerequisite and stale packed-consumer package-name assertion above reproduce independently of the Pi pins and are explicitly excluded from this ledger. Timeouts, network behavior, and mutable advisory-feed results are likewise not compatibility deltas.

### Dependency audit evidence

At `2026-07-27T15:15:55Z`, root `npm audit --omit=dev --json` exited zero and reported zero vulnerabilities. That root result does not inspect the dependency-owned coding-agent shrinkwrap and is not packed-consumer evidence.

`npm run audit:packed-consumer` successfully packed and installed Bobbit in its isolated clean consumer, then exited 1 with exactly one high finding: coding-agent's immutable `brace-expansion@5.0.7` edge is affected by [`GHSA-mh99-v99m-4gvg`](https://github.com/advisories/GHSA-mh99-v99m-4gvg). This is class C upstream Pi packaging. Compatibility Phase 0 passes. Under the current user-approved accepted-risk amendment, this exact finding does not block merge or release eligibility, although the result remains non-zero and not audit-clean. No audit fix, override, vendoring, fork, upstream Pi repack, or reporting exception was used.

The remaining sections document the preceding `0.81.1` compatibility line and its durable Bobbit-side contracts.

## Historical Pi `0.81.1` compatibility and release eligibility

Pi `0.81.1` is the compatibility baseline selected on 2026-07-21. It removes the targeted high-severity `brace-expansion` edge from Pi's published dependency tree, but **the next Bobbit release is not audit-clean or release-eligible**.

`@earendil-works/pi-coding-agent@0.81.1` publishes its own `npm-shrinkwrap.json`. That shrinkwrap pins `protobufjs@7.6.4`, below the required `7.6.5` floor. At selection time the registry associated that edge with [`GHSA-j3f2-48v5-ccww`](https://github.com/advisories/GHSA-j3f2-48v5-ccww). A Bobbit root override can make the development checkout resolve `protobufjs@7.6.5`, but npm ignores a dependency's override and honors coding-agent's shrinkwrap when Bobbit is installed as a package. Root `npm audit` output is therefore not evidence about the installed consumer graph.

Compatibility and release eligibility are separate decisions:

- **Compatibility may pass for `0.81.1`** when behavior gates and deterministic packed-consumer checks pass. Those checks cover graph validity, consumer lock creation and dependency-owned shrinkwrap presence, coordinated Pi versions, known version/path floors, and bundled binaries.
- **Release eligibility remains blocked** until a compatible common Pi patch publishes coding-agent with every `protobufjs` edge at `7.6.5` or newer, all three Pi pins advance together, and the required release-only packed-consumer audit reports zero vulnerabilities.

Normal unit, browser, and E2E suites deliberately do not query or assert the mutable registry advisory feed. Advisory data can change independently of the code under test, so using it as a normal gate makes compatibility results nondeterministic. Live consumer advisory enforcement instead runs only during release preflight through `npm run audit:packed-consumer`; every severity must be zero, with no exceptions. Do not describe `0.81.1` as audit-clean or release-eligible.

### Verified dependency outcomes

The controlled development-checkout regeneration produced this result:

- all root and nested Pi copies resolve to `0.81.1`, with no stale or mixed Pi version;
- every development-checkout `brace-expansion` occurrence resolves to `5.0.7` or newer; the legacy `shx`/ShellJS 1.x edge has been removed;
- the root `@google/genai` tree resolves `protobufjs@7.6.5`, while coding-agent's shrinkwrap-owned nested tree resolves the known `protobufjs@7.6.4` edge;
- `npm ls` exits successfully with no invalid, missing, stale, or extraneous Pi edge; and
- a plain `npm install` with the repository `.npmrc` restored leaves `package-lock.json` unchanged.

A clean project installing the packed Bobbit tarball under normal consumer npm settings deterministically verifies that:

- all three Pi packages remain aligned at `0.81.1`;
- the consumer creates and owns its `package-lock.json`, while coding-agent retains its published shrinkwrap;
- every packed-consumer `brace-expansion` occurrence is `5.0.7` or newer;
- exactly one `protobufjs@7.6.4` occurrence exists under coding-agent's published shrinkwrap; and
- Bobbit's bundled `fd` and `rg` resolve from the installed package and execute `--version` on supported platforms.

These package-graph facts remain stable test inputs; registry advisory output does not. The `brace-expansion@5.0.7+` floor addresses the targeted high advisory, but the deterministic protobuf floor still blocks release eligibility for `0.81.1`.

### Lockfile invariant

Preserve `.npmrc` with `shrinkwrap=false`. On the npm version used for this upgrade it maps to `package-lock=false`, which prevents ordinary installs from silently regenerating the committed lock from dependency-owned shrinkwraps. Follow the controlled procedure in [the Pi 0.81 upgrade design](design/pi-0.81-upgrade.md#pins-and-lockfile) whenever a later Pi patch is evaluated. Never re-enable routine lockfile writes or treat a Bobbit root override as the packed-consumer fix.

## Adopted Pi `0.81.1` capabilities

Bobbit adopts Pi's refreshed static provider/model metadata through its existing synchronous model registry. This includes the Kimi K3 thinking and routing corrections, OpenAI Responses fixes, corrected OpenAI Codex metadata, Bedrock fixes, OpenCode Go session-affinity behavior, xAI/Grok catalog updates, and refreshed model entries. These are metadata and provider implementation corrections; they do not add Bobbit configuration, credential sources, or routing rules.

Codex provider fixes are adopted together with the required OAuth migration described below. Richer optional usage data on compaction, branch summaries, and tool results is accepted and preserved. The new summarization retry lifecycle is also accepted without changing Bobbit's terminal turn boundary.

## Capabilities intentionally not adopted

The following `0.81.1` capabilities remain upstream-only until Bobbit has an explicit integration design:

- native full provider extensions and dynamic provider catalogues, including Radius-style refresh, do not replace Bobbit's provider bridge or generated extensions;
- Pi's managed llama.cpp model/process lifecycle is not used; Bobbit's existing custom-provider discovery remains unchanged;
- Qwen Token Plan international and China providers are excluded from Bobbit's built-in provider ids, even when a matching key is stored; enabling them requires explicit credential forwarding to both host and sandbox agents plus authentication coverage;
- provider-scoped `ModelRuntime` authentication and asynchronous `Models.refresh()` are not added to the gateway model registry;
- new xAI device-OAuth behavior is not exposed as a Bobbit authentication flow; and
- no new Pi credential store, background catalogue refresh loop, or automatic activation of dynamically reported tools is introduced.

Deferral is deliberate: exposing a catalog entry without equivalent host and sandbox credentials can make a model selectable but unusable. Existing provider behavior must remain stable until the full path is supported.

## OpenAI Codex OAuth migration

In Pi `0.81.1`, `@earendil-works/pi-ai/oauth` is a type-only compatibility entry. Its JavaScript no longer exports `getOAuthProvider` or `OPENAI_CODEX_BROWSER_LOGIN_METHOD`.

Bobbit's external Codex flow now creates the built-in `Models` service with `builtinModels()` from the server-safe providers module and uses the `Models.login()` contract:

```ts
models.login("openai-codex", "oauth", interaction)
```

The interaction uses Pi's root-exported `AuthInteraction` and credential types. Bobbit maps it onto the existing UI contract as follows:

- `auth_url` and device-code notifications become the existing `{ url, instructions }` response;
- text and manual-code prompts wait on the existing manual code submission;
- a single select option is chosen directly; otherwise Bobbit prefers option id `browser`, then the established case-insensitive id/label browser heuristic;
- unsupported multi-choice prompts fail explicitly rather than selecting an unknown flow; and
- progress, device instructions, and failures remain redacted in logs.

The migration preserves `callbackServer: true`, flow expiry and cancellation, OAuth credential persistence in the agent `auth.json`, `storeOAuthCredentials()`, and `clearOAuthCache()`. It changes only the Pi integration boundary, not the user-visible Codex login lifecycle.

Pinned coverage: `tests2/core/oauth-external-callbacks.test.ts`.

## Model runtime and catalog boundary

Bobbit keeps `assembleModels()`, `getAvailableModels()`, and `resolveModelStateMeta()` as a synchronous, gateway-owned catalog. Provider-scoped `ModelRuntime` authentication and asynchronous `Models.refresh()` remain internal to the Pi CLI; the gateway does not add a second credential store or refresh loop.

Server code should use the narrowest stable Pi subpath for runtime values. Built-in provider/model metadata comes from `@earendil-works/pi-ai/providers/all`; completion helpers use the compatibility export. This makes future export drift visible at compile time and prevents server-only dependency paths from leaking into the browser.

### Model and thinking metadata

The `0.81.1` catalog retains the GPT 5.6 metadata Bobbit must preserve end to end:

- `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra`;
- routed variants such as `openrouter/openai/gpt-5.6-*` and `vercel-ai-gateway/openai/gpt-5.6-*`;
- `thinkingLevelMap.max` only where the upstream model explicitly supports the tier; and
- optional provider cost-tier metadata.

Bobbit exposes those fields through `/api/models`, the model selector, session spawn args, role validation, and reconnect state frames. `max` is not guessed from model-family patterns. See [Per-model thinking-level capabilities](thinking-levels.md) for shared validation and clamping rules.

Pi also adds the RPC command `get_available_thinking_levels`. The RPC bridge accepts this additive command without changing Bobbit's source of truth: selectors and validation continue to use the synchronous model metadata already carried through Bobbit state.

Pinned coverage includes `tests2/core/models-api.test.ts`, `tests2/core/thinking-levels.test.ts`, `tests2/core/role-store.test.ts`, `tests2/core/rpc-bridge-spawn-args.test.ts`, and `tests2/dom/thinking-levels-per-model.test.ts`.

### Fable model-state preservation

Claude Fable 5 remains the canary for model metadata preservation because Pi reports it as a 1M-context reasoning model with:

```ts
{ off: null, xhigh: "xhigh", max: "max" }
```

The `off: null` entry means Fable cannot disable adaptive thinking. The `max` entry means Bobbit must keep the `Max` selector option available whenever the live model frame carries that map.

All live and rehydrated `state.model` frames route through `resolveModelStateMeta(provider, id)`. The resolver checks the last exact assembled registry row first, then an exact direct Pi row, and otherwise returns unavailable capability metadata. During a transient AIGW/custom refresh failure, the unchanged source retains its last exact row; identity-matching live fields may be preserved only when exact composition is temporarily unavailable. No family fallback is allowed to invent context, reasoning, modalities, or thinking tiers.

Pinned coverage: `tests2/core/model-state-meta-resolver.test.ts` and `tests2/integration/fable-model-state-frame.test.ts`.

## Stream function and browser-safe boundary

Pi `0.81` makes `streamFn` explicit in agent-core APIs. Pi `0.81.1` restores the pre-`0.81` runtime fallback with `setDefaultStreamFn(streamSimple)`, which keeps already-compiled callers compatible. Bobbit still supplies its own proxy-aware stream function, but the assignment target depends on the session implementation: gateway-backed `RemoteAgent` exposes Bobbit's `streamFn` property, while a real Pi `Agent` exposes `streamFunction`. `AgentInterface` must detect that distinction and assign the `proxy-utils` wrapper to the matching property; both paths delegate to the lazy browser-safe streaming helper. Do not write a Pi-only `streamFunction` property onto `RemoteAgent`, and do not remove either bridge merely because the upstream fallback exists.

Browser code must not use runtime value imports from the bare `@earendil-works/pi-ai` package. The bare index traverses Node-oriented paths such as environment API-key probing, which makes Vite externalize Node modules into browser builds. Type-only root imports are safe because TypeScript erases them.

Bobbit uses three browser-safe patterns:

- provider catalog reads go through `GET /api/pi-ai/providers`;
- provider key tests go through `POST /api/pi-ai/provider-key-test`; and
- first-message streaming dynamically imports only package-exported `@earendil-works/pi-ai/api/*` subpaths through `pi-ai-lazy`.

Do not reintroduce legacy direct provider imports such as `@earendil-works/pi-ai/anthropic` or `@earendil-works/pi-ai/openai-responses`.

Pinned coverage: `tests2/core/pi-ai-browser-boundary.test.ts` and `tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts`.

## Code Assist pre-auth provider registration

Bobbit generates a `google-code-assist` provider extension so `google-gemini-cli/*` account models can run inside `pi-coding-agent`. Pi `0.81.1` retains the legacy provider-registration API alongside its new native provider extension surface, so Bobbit intentionally keeps its existing bridge.

The contract remains split deliberately:

- the generated extension is loaded for spawned agents so the Code Assist API can become available without respawning;
- before a real Google credential is visible, it registers only the API and `streamSimple` handler, not `models[]` or a placeholder `apiKey`;
- when local OAuth, `GOOGLE_CLOUD_ACCESS_TOKEN`, or gateway token access becomes available, an auth watcher upgrades the registration with `models[]` and the runtime marker `apiKey`; and
- the gateway registry emits `google-gemini-cli/*` models only after a real Code Assist credential is present.

The shared credential check counts both a stored `auth.json` OAuth entry and a gateway `GOOGLE_CLOUD_ACCESS_TOKEN` Bearer token. A generic `GOOGLE_API_KEY` or `GEMINI_API_KEY` never authenticates Code Assist, and `GOOGLE_CLOUD_ACCESS_TOKEN` never authenticates the API-key-only `google` provider. See [Google OAuth models](google-oauth-models.md#account-backed-gemini-as-agent-session-models).

Pinned coverage: `tests2/core/google-code-assist-provider-extension.test.ts` and `tests2/core/google-code-assist-registry.test.ts`.

## Retry and lifecycle boundaries

### Retryable `agent_end` is non-final

Pi can emit `agent_end` for a failed attempt that it will retry internally. An event with `willRetry: true` is not the end of the Bobbit turn.

Bobbit therefore keeps the session streaming and does not revoke one-time tool grants, drain queued prompts, increment the completed-turn count, resolve `waitForIdle()`, or deliver the retryable `agent_end` to the browser. Settlement waits for the terminal `agent_end` where `willRetry !== true`.

Pinned coverage: `tests2/core/pi-rpc-agent-end-retry.test.ts`.

### Summarization retries and post-compaction turn retry

Pi `0.81.1` has two distinct retry scopes. `summarization_retry_scheduled`, `summarization_retry_attempt_start`, and `summarization_retry_finished` describe summarizer retry attempts; for compaction, those attempts run *inside* `compact()`. Bobbit forwards these additive events and preserves summary usage.

By contrast, `compaction_end { willRetry: true }` means the compaction itself succeeded and the aborted overflow turn will retry afterward. The installed `0.81.1` runtime has already appended the compaction entry and rebuilt agent state before emitting this event; it then returns to continue the agent turn. It does not emit a later terminal `compaction_end` for the same operation.

Bobbit must therefore complete the compaction boundary on that event: clear `isCompacting`, persist the sidecar, attach the `compactionId`, refresh the transcript, forward the completion to clients, and retain `result.usage`. `willRetry` applies only to turn settlement. Turn waiters, queued prompts, one-time grants, idle status, and completed-turn accounting remain pending until the final `agent_end`. Keeping these boundaries separate prevents lost compaction history without dispatching queued work during the retried turn.

Pinned coverage: `tests2/core/pi-rpc-agent-end-retry.test.ts`, `tests2/core/compaction-types.test.ts`, `tests2/dom/ui-fixtures/compaction-widget.test.ts`, and the full-stack `tests2/browser/e2e/pre-compaction-history.spec.ts` reload journey.

## Tool lifecycle and optional result fields

Pi `0.81.1` exports more lifecycle contracts, including `AgentEvent`, tool execution start/update/end events, extension tool call/result events, `AgentToolResult`, and `AgentToolUpdateCallback`. Bobbit preserves their existing ordering and boundaries:

1. execution start marks the turn as having used a tool and enforces tool policy;
2. execution update refreshes partial UI state without triggering final-result side effects; and
3. extension result/execution end preserves the final payload, error normalization, persistence, browser delivery, and the queued-steer boundary.

Tool results can now carry optional `usage` and `addedToolNames`. Bobbit forwards and persists those fields when Pi supplies them, leaves them absent otherwise, and does not synthesize defaults. Their presence does not activate tools, change turn settlement, or create a new Bobbit cost-accounting source.

Pinned coverage: `tests2/core/pi-tool-lifecycle-contract.test.ts`.

### Tool-result error normalization

Pi may return tool errors where the top-level event says `isError: false`, but nested result content serializes a JSON object with `isError: true`.

Bobbit normalizes these events before rendering and persistence decisions. The normalizer inspects top-level flags, `result`/`output`, stringified JSON payloads, and text content nested under `result.content` or `output.content`. It returns a normalized copy and does not mutate the original Pi event.

Pinned coverage: `tests2/core/tool-result-error-normalizer.test.ts`.

## Session storage, transcripts, and compaction

Pi `0.81.1` expands `SessionStorage` with `getSessionName()`, `getSessionStats()`, `getPathToRootOrCompaction()`, and cursor options for `getEntries()`. Bobbit does not implement that Pi CLI interface, so these methods remain CLI-internal rather than becoming a second gateway storage abstraction.

Bobbit does read Pi-owned JSONL. For valid transcripts, it preserves new `retainedTail`, optional `firstKeptEntryId`, compaction and branch-summary `usage`, richer usage members such as `reasoning` and `cacheWrite1h`, and unknown additive fields byte-for-byte. The active-order projection treats a Pi `0.81` compaction's `retainedTail` as context records owned by that compaction line, before later active JSONL messages. This matters because a poisoned tool result can be embedded in the checkpoint rather than stored as its own JSONL record. The transcript sanitizer still projects the active branch conservatively; compaction refresh, the sidecar, the synthetic `__compaction_summary` card, pre-compaction history, and reload behavior remain Bobbit-owned compatibility boundaries.

Session-tree metadata such as `active_tools_change`, `leaf`, `branch_summary`, and hidden `custom_message` rows is not chat content or Bobbit runtime metadata. Sanitization and cwd rebasing leave it intact. Only Bobbit-owned runtime headers are eligible for cwd rebasing during fork and continue-archived flows.

Pinned coverage: `tests2/core/transcript-sanitizer.test.ts`, `tests2/core/compaction-types.test.ts`, and `tests2/browser/e2e/pre-compaction-history.spec.ts`.

## Orphan tool-result persistence and recovery

Anthropic rejects a request when a `tool_result` references a tool call that is not present in the immediately preceding assistant message. The identifying error is:

```text
messages.<n>.content.<n>: unexpected tool_use_id ...
```

The full provider message also identifies `tool_result` ordering and the missing corresponding previous `tool_use`. Bobbit deliberately requires that complete shape before classifying poisoned history; unrelated HTTP 400s keep their existing behavior. This corruption is permanent without repair because every subsequent turn replays the same invalid persisted history.

### Historical persistence race

The race predates the current Pi line. Upstream Pi commit [`ff5148e7`](https://github.com/badlogic/pi-mono/commit/ff5148e7cc7dc330fcc61b2619de43feb21022c0) introduced asynchronous message-event forwarding in Pi `0.52.10`. `AgentSession._handleAgentEvent` began awaiting extension message handlers before `sessionManager.appendMessage`, while event listener invocations remained unserialized. A later tool-result event could therefore append before—or survive an interruption without—the assistant event that introduced its call ID. Bobbit first adopted an affected line with `@mariozechner/pi-coding-agent@0.57.1`; the later Earendil migration did not introduce the defect.

Upstream fixed the race in [`dfc779faab24478fd4f6c608d78efe760a51160a`](https://github.com/badlogic/pi-mono/commit/dfc779faab24478fd4f6c608d78efe760a51160a), tracked by [`badlogic/pi-mono#1717`](https://github.com/badlogic/pi-mono/issues/1717), by serializing session event handling. Pi owns these conversation writes, so Bobbit cannot atomically order its internal appends.

The `0.81.1` upgrade deliberately retains Bobbit's boundary sanitizer. Even when a runtime prevents new races, existing malformed history still requires repair, and force-abort, process exit, or gateway restart can expose an incomplete turn.

### Conservative active-branch repair

Pi JSONL is an append-only, parent-linked session tree. Bobbit follows the current leaf, applies the latest compaction projection, and validates only that active model-context branch. When a Pi `0.81` compaction carries `retainedTail`, its embedded messages participate in active ordering at the owning compaction checkpoint before the following active lines. A message-level `toolResult` is retained only when its non-empty `toolCallId` is still present in the immediately preceding assistant result run. This supports a single call or parallel calls with results in any order. Consecutive unmatched results, missing or empty IDs, mismatches, duplicates, and IDs from an older assistant are removed. `isError: true` does not make a matched result invalid.

Valid tool-use/result pairs, valid parallel results, errored results, incomplete assistant tool turns, synthetic compaction pairs, unrelated metadata, and inactive-branch message content are preserved. A valid transcript remains byte-identical. For a malformed active branch, top-level orphan records are removed and only the necessary surviving `parentId` links and active `leaf.targetId` are rebased to keep the tree connected.

An orphan embedded in `retainedTail` is repaired differently: the sanitizer filters only the unmatched message's `retainedTail` index from the owning compaction line and rewrites that line. Valid retained messages and every unknown or additive compaction field remain structurally preserved; unrelated JSONL lines remain byte-identical, and line ordering and trailing-newline shape are retained. Each embedded removal contributes to the repair count just like a removed top-level record. Rerunning the repair is idempotent.

Every existing Pi rehydration boundary sanitizes before `switch_session`:

- cold restore and revive-on-prompt;
- refresh, restart, in-place respawn, role replacement, and sandbox recovery;
- force-abort hard-kill recovery; and
- synchronous and worktree pre-existing-session setup used by continue-archived and live fork.

The guard uses the session's actual filesystem realm for host and sandbox sessions. Container paths are read through the sandbox and mapped to the host sessions bind mount for guarded writes; a persisted host-absolute path remains host-side even when the session is marked sandboxed. Trusted sessions-root checks, realpath validation, regular-file checks, traversal rejection, pre-write revalidation, and final-component symlink protection remain in force. Exact legacy persisted files outside trusted roots are read-compatible only and never become sanitizer write targets.

### In-place user recovery

The visible **Retry** action and an ordinary follow-up both recognize poisoned history before the generic consecutive-error cap. Bobbit sanitizes, respawns the Pi bridge in place, and dispatches once against the fresh bridge. It preserves the Bobbit session identity, model and thinking state, valid visible history, prompt queue and envelopes, and the accepted user intent. No replacement session appears in the sidebar or route. REST and tool-driven prompts use the same recovery classification.

Retry replays the original prompt and images if no tools ran. If tools already ran, it sends the established continuation instruction instead of repeating side effects. A normal follow-up sends the new prompt unchanged and ahead of parked queue entries. Concurrent duplicate Retry actions join one recovery; replacement lifecycle operations serialize with the repair so intent lands on the canonical bridge.

Recovery is user-driven and single-flight, with at most one sanitize/respawn/redrive for the poisoned error. Bobbit never arms the provider auto-retry timer for this signature. Even when no disk row is removed, it may respawn once because the old process can retain poisoned in-memory history after the file is clean. If the same validation error recurs, Bobbit surfaces it and waits for a later user action rather than looping.

The recovery diagnostic is concise and content-free:

```text
[session-manager] Poisoned-history repair session=<id> boundary=<retry|follow-up> repairedRecords=<count> sandboxed=<bool> project=<id>
```

It reports repair count and session context without tool IDs, tool payloads, transcript text, credentials, or provider request bodies. Operator steps are in [Session permanently fails with `unexpected tool_use_id`](debugging.md#session-permanently-fails-with-unexpected-tool_use_id).

Pinned coverage:

- `tests2/core/transcript-orphan-tool-results.test.ts` covers structural validity, active/inactive branches, metadata, compaction, newline preservation, and idempotence;
- `tests2/core/orphan-tool-result-recovery.test.ts` covers narrow classification and bounded Retry, follow-up, and REST/tool recovery;
- `tests2/core/orphan-tool-result-rehydration-boundaries.test.ts` covers restore, respawn, role, force-abort, continue setup, filesystem realms, and path safety; and
- `tests2/browser/e2e/orphan-tool-result-recovery.journey.spec.ts` covers user-visible Retry and follow-up recovery against a real filesystem.

## Worktree setup timeout cleanup

Worktree setup commands are non-fatal, but timeout handling must still wait until the timed-out shell tree has been cleaned up before publishing or claiming the worktree. Returning early can leave child processes holding worktree directory handles, especially on Windows with Git Bash/MSYS children.

`runComponentSetups()` distinguishes callers whose executor owns timeout cleanup. Host setup uses the shell wrapper so it can kill the process tree, wait for cleanup, and then reject with timeout. Container setup similarly passes the per-command timeout into Docker exec.

The reason is operational rather than cosmetic: a worktree that appears claimable while setup children still hold handles can fail later move, cleanup, or reuse operations. The regression is pinned by the worktree-pool tests.

## Real-model context-pressure smoke

`tests/manual-integration/reliable-agent-context-pressure.spec.ts` is an opt-in real Pi/real-model test of exact-once prompt and steer delivery through genuine automatic context pressure. Deterministic mock-Pi coverage remains the CI gate; this smoke validates the installed provider/runtime path when credentials and budget are available.

### Credentials and model selection

Choose one setup:

```bash
MANUAL_TEST_MODEL="<provider>/<model>" \
<provider-credential-environment> \
npm run test:manual -- tests/manual-integration/reliable-agent-context-pressure.spec.ts --project=manual-integration --workers=1
```

Or explicitly inherit only the live server's model/auth subset into the isolated test gateway:

```bash
BOBBIT_MANUAL_INHERIT_SERVER_CONFIG=1 \
BOBBIT_DIR="/absolute/path/to/live/.bobbit" \
npm run test:manual -- tests/manual-integration/reliable-agent-context-pressure.spec.ts --project=manual-integration --workers=1
```

`MANUAL_TEST_MODEL` overrides an inherited default; `MANUAL_TEST_THINKING_LEVEL` is optional. The inherit switch accepts `1` or `true`. On PowerShell, set the same variables through `$env:<NAME>` before running the unchanged npm command.

The selected value must use exact `<provider>/<model>` syntax and must appear in `/api/models` as authenticated and session-selectable. The fixture forces `allowSessionModelFallback=false` and fails if runtime state reports another provider/model. It lowers only that exact model's advertised context window to 48,000 tokens inside the isolated agent directory so genuine pressure is reachable within the budget.

Inheritance copies the relevant model/thinking/provider preferences, `providerKey.*`, AI Gateway/custom-provider configuration, and Pi agent auth/config files. It does not reuse the live Bobbit directory or copy sessions, goals, projects, gateway tokens, or TLS state. Git and provider network access are required; Docker and sandboxing are not used by this spec.

If neither explicit model credentials nor explicit inheritance is configured, or the exact model is absent/unauthenticated/unselectable, the test skips with an actionable reason. A skip is not compatibility evidence and the test never falls back to another provider.

### Spend and time guards

The spec aborts and fails with body-free lifecycle diagnostics when any guard is reached:

| Guard | Limit |
| --- | --- |
| Estimated model requests | The sixth request start triggers abort; no seventh request is intentionally queued. The estimate combines assistant/agent starts with automatic compaction summarizer starts. |
| Aggregate reported tokens | 250,000 input, output, cache-read, and cache-write tokens. |
| Reported session cost | USD 2.00. |
| Measured model scenario | 8 minutes, after gateway startup. |
| Overall Playwright test | 630 seconds, including the separately bounded gateway startup and cleanup margin. |
| Pressure generation | At most four pressure turns, each with a bounded inert ledger body. |

The configured model and provider determine actual spend. Review their pricing before opting in; do not weaken the guards to make a flaky model pass.

### Assertions and cleanup

The test observes a real threshold or overflow compaction start, then submits one steer and one next-turn prompt in the same WebSocket callback while compaction is active. It requires:

- successful compaction completion;
- one correlated Pi user start for each exact `intentId`;
- useful post-compaction output containing both nonce facts;
- exactly one transcript occurrence for each ID in a settled snapshot;
- no matching row in a fresh attach outbox;
- no late duplicate after a server `ping`/`pong` barrier; and
- no runtime provider/model fallback.

Failure output contains bounded IDs, counters, state, and lifecycle summaries, not prompt or provider bodies. The `finally` path aborts the turn, purges the session best-effort, stops the isolated gateway, and removes the temporary fixture even on budget failure.

## Upgrade verification

Run focused contract coverage before the broad gates:

```bash
npx vitest run --config vitest.config.ts --project v2-core \
  tests2/core/pi-installed-contract.test.ts \
  tests2/core/assistant-stream-delta.test.ts \
  tests2/core/assistant-stream-session-broadcast.test.ts \
  tests2/core/reliable-intent-queue.test.ts \
  tests2/core/reliable-intent-attempt.test.ts \
  tests2/core/reliable-compaction-release.test.ts \
  tests2/core/oauth-external-callbacks.test.ts \
  tests2/core/pi-rpc-agent-end-retry.test.ts \
  tests2/core/pi-tool-lifecycle-contract.test.ts \
  tests2/core/pi-published-shrinkwrap-security.test.ts
npx vitest run --config vitest.config.ts --project v2-integration \
  tests2/integration/reliable-intent-recovery.test.ts \
  tests2/integration/steer-gateway-restart.test.ts
npm run test:e2e:run -- tests/e2e/pi-packed-consumer.spec.ts --project=api --workers=1 --retries=0
```

Then run the required project gates:

```bash
npm run build
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
```

Run `npm run test:manual` when credentials and Docker are available. Also retain the development tree from:

```bash
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent brace-expansion protobufjs --all
```

`tests/e2e/pi-packed-consumer.spec.ts` builds and packs Bobbit, installs the tarball into an empty project under normal consumer lock settings, inspects the dependency graph and shrinkwrap-owned paths, and smokes the installed `fd`/`rg` binaries. It intentionally does not call `npm audit`; normal unit, browser, and E2E gates must remain independent of mutable registry advisory output.

For release evaluation, first build Bobbit, then run `npm run audit:packed-consumer`. The command packs the built package and installs it into a clean temporary consumer, then runs `npm audit --omit=dev --json` against the public registry. Its child npm processes use fresh home/config/cache/temp directories, do not inherit registry credentials or auth tokens, and disable lifecycle scripts. The normal release policy requires a successful zero-finding result and treats an unavailable advisory service as blocking; see [Releasing Bobbit](releasing.md#required-packed-consumer-audit). This `0.82.1` delivery has one explicit, human-approved exception for the exact Pi-owned `brace-expansion@5.0.7` finding. The command remains non-zero and its report remains required evidence. The exception does not cover a changed advisory result, an additional finding, or an unavailable audit service.

`tests2/core/pi-published-shrinkwrap-security.test.ts` uses local fixtures to pin why a clean root audit cannot replace consumer evidence without querying the registry.

Historical upgrade note: [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) records the Opus-specific model, thinking-level, spawn, and sandbox auth contracts from that earlier Pi line.
