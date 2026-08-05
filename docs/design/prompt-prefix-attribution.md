# Prompt-prefix attribution

## Decision

Add downstream, provider-agnostic attribution in Bobbit. It compares cryptographic fingerprints of the cache-relevant request components that Bobbit already owns; it does not alter Pi, inspect provider internals, add an extension-platform API, persist prompt text, or claim a provider cache miss without telemetry.

The result answers **which component changed since the prior comparable request**: **System prompt**, **Tool list/schema**, **Dynamic context**, or **Skills**. A stable local prefix is not evidence of a provider hit; it means only that Bobbit did not invalidate the observed component fingerprint.

## Current owners and evidence

| Concern | Existing owner | Relevant behavior |
|---|---|---|
| System prompt sections | `src/server/agent/system-prompt.ts::_assembleSystemPrompt()` and `getPromptSections()` | Both derive labeled, ordered sections from `PromptParts`; tools and skills are stable-prefix sections and dynamic context is the tail. |
| Prompt input construction | `src/server/agent/session-setup.ts::resolvePrompt()` and `SessionManager._assemblePrompt()` in `src/server/agent/session-manager.ts` | Setup supplies `PromptParts`; `_assemblePrompt()` supplies tool docs and skills, caches parts, persists the existing inspector snapshot, then assembles. |
| Tool selection | `session-setup.ts::resolveTools()` / `resolveToolActivation()` and `tool-activation.ts::computeEffectiveAllowedTools()` | `EffectiveTool` preserves selected names and kind. `McpManager.getToolRouteSnapshots()` exposes the active MCP input schemas. Marketplace Pi discovery has `PiExtensionToolInfo.inputSchema`. |
| Dynamic context | `session-setup.ts::resolveDynamicContext()`, `LifecycleHub.dispatch()` in `lifecycle-hub.ts`, and `context-blocks.ts::fenceBlock()` | `sessionSetup` blocks enter the assembled tail. Per-turn `beforePrompt` blocks are budgeted by `LifecycleHub` and delivered as a hidden `bobbit:dynamic-context` message. |
| Per-turn boundary | `provider-bridge-extension.ts::generateProviderBridgeExtension()` and `server.ts` `POST /api/sessions/:id/provider-hooks/before-prompt` | The existing bridge calls the route immediately before Pi sends the request; it does not amend `systemPrompt`. |
| Existing trace store | `context-trace-store.ts::ContextTraceStore` | Bounded, restart-safe session JSONL already records hook/providing-block diagnostics; it is the correct persistence owner, but currently stores no component identity. |
| Provider telemetry | `session-manager.ts::trackCostFromEvent()` → `cost-tracker.ts` | `cacheHitRate` is `null` when counters are absent/zero, as documented in `docs/cache-hit-rate.md`; this must remain **unknown**, never a miss. |

The persisted prompt-section inspector intentionally contains raw content for inspection. Attribution is a separate, hashes-only diagnostic record; it must not widen that persistence surface.

## Data model

Add `src/server/agent/prompt-prefix-attribution.ts`. Keep canonical JSON and SHA-256 here rather than copying the private `stableStringify()` in `tool-activation.ts`.

```ts
export type PrefixComponent = "system" | "tools" | "dynamic-context" | "skills";
export type PrefixBoundary = "dispatch" | "before-prompt";
export type ProviderCacheTelemetry = "hit" | "miss" | "unknown";

export interface PrefixComponentFingerprint {
  kind: PrefixComponent;
  sha256: string;       // 64 lowercase hex, never raw source text
  bytes: number;        // UTF-8 bytes hashed; diagnostic only
}

export interface PromptPrefixSnapshot {
  schemaVersion: 1;
  ts: number;
  sessionId: string;
  sequence: number;
  boundary: PrefixBoundary;
  // The tuple makes snapshots incomparable across a model/provider switch.
  model?: { provider: string; id: string };
  // Changes whenever the conversation was compacted; not a culprit component.
  compactionEpoch: number;
  components: PrefixComponentFingerprint[];
  aggregateSha256: string;
  providerCacheTelemetry: ProviderCacheTelemetry;
}

export interface PrefixAttribution extends PromptPrefixSnapshot {
  comparison: "first" | "stable" | "changed" | "boundary";
  culprit?: PrefixComponent | "multiple" | "unattributable";
  changed?: PrefixComponent[];
  comparableTo?: number;
}
```

`canonicalJson(value)` recursively sorts object keys, preserves array order, serializes `undefined` as `null`, and uses explicit domain/version envelopes before `createHash("sha256").update(bytes, "utf8").digest("hex")`. This avoids ambiguous concatenation and makes order changes detectable. Never truncate a persisted digest.

Fingerprint inputs, computed in memory only:

| Group | Canonical input |
|---|---|
| `system` | The ordered `getPromptSections(parts)` entries excluding `Tools`, `Available Skills`, and `Dynamic Context`; include `{ label, content }` and the effective `sectionOrder`. Thus a source, text, or placement change is attributed to System prompt. |
| `tools` | The selected `EffectiveTool[]` (`kind`, `name`) in activation order; `parts.toolDocs`; active MCP `getToolRouteSnapshots()` filtered to selected MCP names including `name`, server identity, description, and canonical `inputSchema`; and selected marketplace `PiExtensionToolInfo` name/description/inputSchema. Do not infer schema from rendered markdown. Built-in/Bobbit tools without an exposed schema contribute their runtime selected name plus the actual tool-doc text. |
| `dynamic-context` | Both the immutable `sessionSetup` blocks used to assemble the prompt and the current `beforePrompt` blocks actually returned by `LifecycleHub.dispatch()`, after host validation/budgeting and `fenceBlock()`. Include order and envelope metadata, not only block content. Empty is a stable, explicit value. |
| `skills` | The exact output of `buildSkillsCatalogSection(parts.skillsCatalog, parts.skillsCatalogBudget)`, including deterministic alphabetical truncation/footer. |

The aggregate digest hashes the ordered component `{ kind, sha256 }` list plus model tuple and compaction epoch. It is a comparison guard, not an extra cause.

## Flow

1. In `SessionManager._assemblePrompt()`, immediately after it has populated tool docs, skills, and the `PromptParts` cache, build an immutable per-session `PrefixSeed`. Its system/tools/skills digests and the `sessionSetup` dynamic blocks describe the prompt actually assembled. Do not reuse `session.promptParts.dynamicContext` as mutable truth: `server.ts` currently refreshes it for the inspector after a per-turn hook.
2. `resolveToolActivation()` returns or stamps the activation descriptor used for both activation and the seed. This uses its existing `EffectiveTool`, MCP extension, and marketplace discovery values—no second resolution pass.
3. `dispatchTrackedPrompt()` records a `boundary: "dispatch"` snapshot using the seed and an empty per-turn dynamic portion. It stores its sequence as the session's pending snapshot. This is the fallback for sessions without a provider bridge.
4. In the existing `before-prompt` route, after `LifecycleHub.dispatch("beforePrompt", ...)` has budgeted blocks and before returning `content`, replace/finalize that pending snapshot with `boundary: "before-prompt"` and the returned blocks. This is the closest existing downstream boundary to the provider request; it changes neither the route response nor Pi request shape. The existing hidden-message delivery remains unchanged.
5. `ContextTraceStore.appendPrefixSnapshot()` appends the finalized `PrefixAttribution` to the same bounded per-session JSONL file (or a sibling `<session>.prefix.jsonl` in its existing directory if trace compatibility requires it). It applies the existing 2 MiB newest-record retention and accepts malformed/old rows during reads. Only fields in the model above are written.
6. Compare only with the latest snapshot having the same model tuple and compaction epoch. Compare component digests, not raw bytes. One changed group is the culprit; two or more is `multiple`; an aggregate change with no changed group is `unattributable` and must be investigated rather than guessed.

A `PrefixAttributionRecorder` owned by `SessionManager` supplies the per-session pending sequence/seed and delegates durable append/read to `ContextTraceStore`. `ContextTraceStore` remains the only filesystem owner. This keeps prompt assembly, lifecycle dispatch, and storage in their present ownership domains.

## Boundaries and semantics

- **Restart/respawn:** `ContextTraceStore` survives restart. `restoreSession()` reconstructs a fresh seed from the restored `PromptParts`; its first post-restart snapshot compares with the last persisted snapshot when model and compaction epoch match. A reconstruction difference produces a real culprit, which is exactly the desired diagnostic. No raw prompt is recovered or stored by attribution.
- **Model switch:** `ws/runtime-model-selection.ts::applyRuntimeSessionModelSelection()` is the model-switch authority. Add a model-boundary marker after its verified tuple commit. The first request on a different provider/model is `comparison: "boundary"`, not stable or changed; its cache telemetry is `unknown` until that provider reports it.
- **Compaction:** `SessionManager` receives `compaction_end` and calls `refreshAfterCompaction()`. Increment a session-local, persisted `compactionEpoch` only on a successful terminal compaction. The next request is a `boundary`: conversation/context changed outside the four prefix components, so it must not be blamed on them. The hidden dynamic-context filtering already prevents stale turn context replay.
- **Provider telemetry:** Populate `hit` or `miss` only if the completed response exposes unambiguous per-request cache counters. The current cumulative `CostTracker` does not retain per-request attribution and absence/zero counters means `unknown`; it must never be converted to `miss` or used to override a stable fingerprint.
- **Concurrency/retry:** the prompt queue permits one active request per session; guard finalization by pending sequence so a late bridge callback cannot overwrite a newer dispatch. A retry gets its own sequence and comparison.

## Operator API and UI

Add `GET /api/sessions/:id/prompt-prefix-attribution?limit=N` beside the existing context-trace route in `server.ts`. It returns `{ entries: PrefixAttribution[] }`, oldest to newest, with `limit` clamped to 1000. It returns hashes, byte counts, labels/enums, model identity, and telemetry state only—never component contents or block text.

Extend the existing **System Prompt Inspector** (`src/ui/dialogs/SystemPromptDialog.ts`, opened from `src/app/session-actions.ts`) with a compact top status row:

- `Stable prefix` for `stable`;
- `Prefix changed: Tools` (or System prompt/Dynamic context/Skills);
- `Prefix changed: multiple components`;
- `Prefix baseline changed at model switch` / `after compaction` for boundaries;
- `Provider cache: unknown` unless explicit per-request telemetry exists.

A details disclosure shows sequence, timestamp, component digest prefixes, bytes, changed groups, comparison sequence, and telemetry state. Do not add raw-content copy/export to this surface; the existing inspector retains its separate behavior.

## Focused tests

New tests belong in `tests2/` and must be registered in `tests2/tests-map.json`.

1. **Core fingerprint tests** for canonical-object-key stability, array-order sensitivity, SHA-256 format, and no raw sentinel text in serialized attribution rows.
2. **Component matrix**: identical snapshots are stable; mutate only each of system sections, tool selection/schema, fenced dynamic block, and skills catalog to prove exactly that named culprit. Mutate two to produce `multiple`; alter only aggregate framing to prove `unattributable` is not guessed.
3. **Lifecycle integration**: `sessionSetup` blocks seed Dynamic context; `beforePrompt` blocks finalize the pending dispatch snapshot; a late callback cannot replace a newer sequence; no bridge leaves the dispatch fallback.
4. **Tool regression coverage**: changing an MCP `inputSchema` from `McpManager.getToolRouteSnapshots()` changes Tools even when the markdown description is identical; reordering selected tools is intentional and detectable.
5. **Privacy/persistence**: read the JSONL and API response after system prompt, tool schema, skill description, and dynamic context sentinels are used; assert none occur. Assert entries survive a fresh `ContextTraceStore` instance and old trace rows still read.
6. **Boundary tests**: restored same-model/no-compaction seed compares normally; verified runtime model switch and successful compaction produce `boundary`; aborted compaction does not. Include session restart with a deliberate tools/skills/system mutation to report the correct culprit.
7. **Telemetry tests**: missing cache fields and zero-denominator usage return `unknown`, never `miss`; explicit fixture counters may return hit/miss without altering fingerprint attribution.
8. **Browser journey**: open the existing system-prompt inspector, verify stable and named-culprit states, reload, and verify no prompt content is exposed by the attribution disclosure.

## Non-goals and escalation

This slice diagnoses Bobbit-owned inputs; it cannot prove a provider cache hit, reveal provider-side normalization, or fingerprint unexposed Pi built-in schemas. If evidence shows stable four-component fingerprints alongside confirmed provider misses, record that result and evaluate a narrowly scoped request-shaping hook separately. Do not introduce that hook, mutate the system prompt, or extend Pi as part of attribution.
