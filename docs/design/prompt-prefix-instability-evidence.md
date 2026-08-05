# Prompt-prefix instability: implementation evidence

**Scope.** This records the request construction that Bobbit owns on current `main` (commit
`1c1e3672e`). It deliberately does not infer provider cache hits from local token usage, and it
does not require a Pi change or a private extension-platform API.

## Request path and ownership boundary

1. `SessionSetup.executePlan()` resolves extensions, tools, `sessionSetup` provider context, the
   system prompt, and tool activation before spawning Pi
   (`src/server/agent/session-setup.ts:1101-1109`). `RpcBridge.buildAgentArgs()` passes the
   resulting prompt file with `--system-prompt`, then appends Bobbit's extension arguments
   (`src/server/agent/rpc-bridge.ts:322-370`). Bobbit therefore owns the inputs to Pi, but does
   not own Pi's final provider request serializer or provider cache telemetry.
2. `assembleSystemPrompt()` produces the system-prompt bytes in a fixed default order:
   global prompt, AGENTS/config files, working directory, tool docs, skills catalog, goal/role,
   task, workflow context, then spawn-time dynamic context
   (`src/server/agent/system-prompt.ts:496-613`). The checked-in test explicitly pins the
   stable-before-volatile intent (`tests2/core/system-prompt-order.test.ts:1-18, 63-160`).
3. The inspector is useful evidence, but is not a wire capture: `persistPromptSections()` stores
   the section snapshot (`system-prompt.ts:747-756`), and `GET .../prompt-sections` serves that
   snapshot before falling back to reconstruction (`src/server/server.ts:17062-17083`). It must
   not be presented as proof of a provider cache hit or miss.

## Component findings

| Component | Per-turn result | Concrete evidence | Attribution conclusion |
|---|---|---|---|
| System prompt | Stable during an ordinary live session; can change at a respawn/restart because it is rebuilt. | The generated provider bridge never returns `systemPrompt` and only returns a hidden custom message (`provider-bridge-extension.ts:233-254`). The bridge test pins that behavior (`tests2/core/provider-bridge-extension.test.ts:138-178`). | Do not add a request shaper to rewrite system bytes per turn. If a system digest changes without a lifecycle boundary, it is a source bug. |
| Tool schemas/order | Not rebuilt on ordinary turns, but there is a real restart/spawn nondeterminism risk. | Tool docs preserve `loadToolDefinitions()` iteration order (`tool-manager.ts:954-1028`). That loader preserves first-seen scan order (`tool-manager.ts:411-468`), while `scanToolsDir()` consumes both directory and YAML `readdirSync()` results without sorting (`tool-manager.ts:181-258`). Activation likewise builds extension paths by insertion order (`tool-activation.ts:1243-1335`), and MCP proxy operation arrays use `getToolInfos()` iteration order (`tool-activation.ts:1107-1219`). | This is a credible source-level culprit for tool-list/schema differences across fresh processes. Sort directory entries, resolved tool identities, extension paths, MCP server/subgroup keys, and operations before rendering/registering; then fingerprint the canonical ordered result. |
| Skills catalog | Stable for a fixed discovered set. | Discovery resolves then alphabetically sorts skills (`src/server/skills/slash-skills.ts:410-450`); rendering sorts again and applies a fixed byte budget (`system-prompt.ts:436-489`). | A changed skills fingerprint is a real configuration/filesystem/pack activation change, not ordinary turn churn. The sorted catalog should not be request-shaped. |
| Per-turn dynamic context | Intentionally changes the current request's user-side tail whenever a provider returns different blocks. Old injected context is removed before the next request. | `before_agent_start` posts the unmodified user prompt, then returns `bobbit:dynamic-context` only when content is non-empty (`provider-bridge-extension.ts:233-254`). The `context` handler removes stale dynamic messages before the latest real user while retaining the current one (`provider-bridge-extension.ts:132-150, 257-263`), behavior exercised in `tests2/core/provider-bridge-extension.test.ts:215-260`. Server dispatch fences provider blocks in response order after budgeting (`server.ts:7255-7279`; `lifecycle-hub.ts:238-327`). | This is the expected culprit when a provider contributes content. It does not mutate system bytes, but it necessarily means the turn's model-message suffix differs. Attribute it as **dynamic context**, including provider/block metadata, rather than calling it a system-prefix miss. |

### Dynamic context ordering and observability

`LifecycleHub.dispatch()` lists enabled providers, invokes them sequentially, collects their
returned blocks, applies priority/budget selection, and writes only provider id, timing,
block/omission counts, and errors to `ContextTraceStore`
(`src/server/agent/lifecycle-hub.ts:238-327`; `context-trace-store.ts:5-78`). The trace contains
no block contents, hashes, request payload, cache status, or model id. The before-prompt endpoint
refreshes prompt sections with the latest dynamic blocks (`server.ts:7255-7279`), which is useful
for UI display but is not redacted telemetry and must not become the attribution store.

The deliberate context filtering gives a deterministic two-turn shape:

```text
turn N:   … user[N] + dynamic[N]                 (dynamic[N] reaches model)
turn N+1: … user[N] + assistant[N] + user[N+1] + dynamic[N+1]
          ^ dynamic[N] is filtered as stale
```

Thus a provider changing `dynamic[N]` changes only the current user-side suffix; it cannot change
the system prompt at this boundary. If a provider response times out or fails, the bridge swallows
the failure and injects nothing (`provider-bridge-extension.ts:216-230, 244-245`), another
intentional dynamic-context difference that should be visible as an error/absence, not as a
fabricated cache miss.

## Lifecycle boundaries that do change input

### Restart and respawn

The restart path correctly re-adds the provider bridge when enabled
(`session-manager.ts:3797-3828`) and restores model selection before `switch_session`
(`session-manager.ts:7762-7806, 7936-7965`). It nevertheless reassembles ordinary prompt parts
with only base prompt, cwd, goal, role, tool names, config store, and section order
(`session-manager.ts:7746-7759`). It supplies neither the original `dynamicContext`, task fields,
nor `workflowContext`. Those values were available on initial construction
(`session-setup.ts:898-916`) but are not carried by the persisted session fields used to
rebuild `PromptParts`; the only provider-context assignment on a reconstructed delegate is the
in-memory `session.promptParts?.dynamicContext`
(`session-manager.ts:4065-4089`).

This is a concrete restart instability/loss boundary. It should be fixed at the prompt-part
source: preserve an explicitly versioned, privacy-safe representation for reconstructible
spawn-time components or deliberately re-dispatch a side-effect-safe `sessionSetup` contract. Do
not silently copy raw prompt text into diagnostics. Until fixed, attribution should report a
**restart reconstruction boundary** and name missing components rather than blaming the provider
cache.

Role reassignment is another respawn path. It reassembles a prompt with goal/role/tool inputs
(`session-manager.ts:10198-10211`) but does not pass `sectionOrder`, task, workflow context, or
spawn-time dynamic context. Treat it as an expected **role-respawn boundary**, not normal
turn-to-turn instability. It is a separate source-level parity bug from model selection.

### Model changes

A live model selection uses Pi RPC (`tryAutoSelectModel()` skips redundant `setModel` for an
already-pinned spawn model and otherwise verifies the selected tuple;
`session-manager.ts:9237-9305`). This code does not reassemble prompt sections. A provider/model
change creates a different provider-side cache domain by definition; Bobbit can report the model
boundary, but absent provider telemetry its cache result is **unknown**. Do not call it a tool,
skill, system, or dynamic-context mutation.

### Compaction

`session_before_compact` sends a bounded span to providers but does not amend compaction output
(`provider-bridge-extension.ts:266-272`). The bridge excludes hidden dynamic-context messages
from the compacted span (`provider-bridge-extension.ts:151-189`), and successful compaction only
refreshes client messages/state (`session-manager.ts:5682-5779, 8909-8927`). The transcript
summary/history necessarily changes the conversational request prefix after compaction. Attribute
that as **compaction boundary**; it is not evidence that any named prompt component changed.

## Decision: fix source, do not add a narrow request-shaping hook

The evidence supports source stabilization:

1. Canonicalize tool and MCP discovery/registration order before Pi receives schemas. This is the
   only named stable component with an identified nondeterministic input path.
2. Make all respawn builders reproduce the same named `PromptParts` contract as initial assembly,
   or explicitly mark the lifecycle boundary and its omitted components. Do not rebuild an
   apparently equivalent prompt from a smaller ad-hoc subset.
3. Keep the existing public generated bridge for dynamic context. It already confines volatile
   provider output to a hidden user-side message and preserves system-prompt bytes. A second
   request-shaping hook would be redundant, risk moving volatile context into the cacheable
   prefix, and would require relying on Pi request internals Bobbit does not own.

A narrow request-shaping hook is warranted only after a deterministic capture proves that Pi or a
provider mutates/reorders the canonicalized Bobbit inputs *within the same lifecycle generation*.
That proof is currently unavailable: Bobbit has no final wire-payload or cache telemetry surface.
It must not be replaced by heuristics.

## Required safe measurement for the attribution slice

At the boundary Bobbit owns (immediately before spawn and at every `before_agent_start`), hash
canonical UTF-8 bytes with SHA-256 for: system prompt, canonical tool schema/list, skills catalog,
and each dynamic-context block plus the canonical block list. Persist only `{component, digest,
length, lifecycleGeneration, model/provider identity, reason}` and component/block ids/provider
ids; never raw prompt, tool arguments, user text, dynamic block content, or provider response.
Use the existing context trace only for provider timing/error/block-count correlation.

Compare the latest record to the previous record in the same session and lifecycle generation;
report the first changed named component. On restart, role respawn, model/provider switch, or
compaction, report the boundary first and retain component deltas as diagnostic detail. Cache
telemetry must be represented as `unknown` unless a provider explicitly supplies a value; lack of
telemetry is never a miss.

Deterministic acceptance observations:

- Two same-session turns with no dynamic block/configuration mutation have identical system,
  canonical tool, and skills digests.
- A changed provider block changes only the dynamic-context digest and identifies the provider/
  block id; the system digest remains equal.
- Reordering YAML filenames or MCP discovery order cannot change canonical tool digest/schema
  ordering after source stabilization.
- Restart and role-respawn tests must compare initial and rebuilt component digests, exposing any
  omitted task/workflow/spawn-time dynamic context explicitly.
- A model switch/compaction records the boundary with cache status `unknown`, never `miss`.
