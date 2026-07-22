# Pi runtime compatibility

Bobbit depends on Pi for provider metadata, browser-side first-message streaming helpers, and the `pi-coding-agent` process that runs agent turns. Pi upgrades are runtime compatibility changes, not simple package bumps: they can affect browser bundle safety, model catalog reads, authentication, RPC lifecycle events, tool-result shapes, transcript metadata, compaction, sandbox credentials, and provider default selection.

This page records the durable Bobbit-side contracts added or reaffirmed for the selected Pi `0.81.1` line:

- `@earendil-works/pi-agent-core@0.81.1`
- `@earendil-works/pi-ai@0.81.1`
- `@earendil-works/pi-coding-agent@0.81.1`

Keep all three packages pinned exactly to the same Pi patch. A mixed Pi line can compile while still breaking the spawned-agent runtime contract.

## Compatibility and release eligibility

Pi `0.81.1` is the compatibility baseline selected on 2026-07-21. It removes the high-severity `brace-expansion` finding from Pi's published dependency tree, but **the next Bobbit release is not audit-clean or release-eligible**.

`@earendil-works/pi-coding-agent@0.81.1` publishes its own `npm-shrinkwrap.json`. That shrinkwrap pins `protobufjs@7.6.4`, which is affected by the moderate advisory [`GHSA-j3f2-48v5-ccww`](https://github.com/advisories/GHSA-j3f2-48v5-ccww). A Bobbit root override can make the development checkout resolve `protobufjs@7.6.5`, but npm ignores that override when Bobbit is installed as a dependency and honors coding-agent's published shrinkwrap. The root checkout can consequently report zero audit findings while the packed consumer remains vulnerable; root `npm audit` output is not consumer evidence.

Compatibility and release eligibility are separate decisions:

- **Compatibility may pass for `0.81.1`** when all behavior gates pass and the packed consumer has exactly the one known moderate advisory, with no low, high, critical, or additional moderate findings.
- **Release eligibility remains blocked** until a compatible common Pi patch publishes coding-agent with every `protobufjs` edge at `7.6.5` or newer, all three Pi pins advance together, and a fresh packed-consumer audit reports zero vulnerabilities.

Do not describe `0.81.1` as audit-clean. The packed-consumer E2E treats the known moderate as an asserted compatibility outcome, not as a security exception for release.

### Verified dependency outcomes

The controlled development-checkout regeneration produced this result:

- all root and nested Pi copies resolve to `0.81.1`, with no stale or mixed Pi version;
- every development-checkout `brace-expansion` occurrence resolves to `5.0.7` or newer; the legacy `shx`/ShellJS 1.x edge has been removed;
- the root `@google/genai` tree resolves `protobufjs@7.6.5`, while coding-agent's shrinkwrap-owned nested tree resolves the known `protobufjs@7.6.4` edge;
- `npm ls` exits successfully with no invalid, missing, stale, or extraneous Pi edge; and
- a plain `npm install` with the repository `.npmrc` restored leaves `package-lock.json` unchanged.

A clean project installing the packed Bobbit tarball under normal consumer npm settings produced this result:

- all three Pi packages remain aligned at `0.81.1`;
- every packed-consumer `brace-expansion` occurrence is `5.0.7` or newer;
- exactly one `protobufjs@7.6.4` occurrence exists under coding-agent's published shrinkwrap;
- `npm audit --omit=dev --json` exits nonzero with exactly one moderate finding, `GHSA-j3f2-48v5-ccww`, and zero low, high, or critical findings; and
- Bobbit's bundled `fd` and `rg` resolve from the installed package and execute `--version` on supported platforms.

The `brace-expansion@5.0.7+` floor fixes the targeted high advisory. It does not resolve the separate protobuf release blocker.

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

All live and rehydrated `state.model` frames must route through `resolveModelStateMeta(provider, id)` instead of deriving metadata from `inferMeta(id)` alone. The resolver checks the merged registry cache first, then the Pi catalog, then `inferMeta` as a last resort. This matters on reconnect and `get_state`: a plausible fallback can silently drop `thinkingLevelMap.max` and the 1M context window.

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

### Summarization and compaction retries

Pi `0.81.1` adds retry policies and lifecycle events for compaction and branch summarization, including `summarization_retry_scheduled`, `summarization_retry_attempt_start`, and `summarization_retry_finished`. Bobbit forwards these additive events and retains summary usage across retries.

A `compaction_end` or `auto_compaction_end` with `willRetry: true` is a non-terminal continuation. Bobbit retains its usage but keeps `isCompacting` true and does not write a sidecar, attach `compactionId`, refresh the transcript, or tell clients that compaction completed. Those completion effects run only for the terminal compaction event where `willRetry !== true`. Turn waiters, queued prompts, grants, and completed-turn accounting remain pending beyond that event until the terminal `agent_end`. This prevents a summarizer retry from creating a false compaction or idle boundary.

Pinned coverage: `tests2/core/pi-rpc-agent-end-retry.test.ts`, `tests2/core/compaction-types.test.ts`, `tests2/dom/ui-fixtures/compaction-widget.test.ts`, and the full-stack `tests/e2e/ui/pre-compaction-history.spec.ts` reload journey.

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

Bobbit does read Pi-owned JSONL. It must preserve new `retainedTail`, optional `firstKeptEntryId`, compaction and branch-summary `usage`, richer usage members such as `reasoning` and `cacheWrite1h`, and unknown additive fields byte-for-byte. The transcript sanitizer still projects the active branch conservatively; compaction refresh, the sidecar, the synthetic `__compaction_summary` card, pre-compaction history, and reload behavior remain Bobbit-owned compatibility boundaries.

Session-tree metadata such as `active_tools_change`, `leaf`, `branch_summary`, and hidden `custom_message` rows is not chat content or Bobbit runtime metadata. Sanitization and cwd rebasing leave it intact. Only Bobbit-owned runtime headers are eligible for cwd rebasing during fork and continue-archived flows.

Pinned coverage: `tests2/core/transcript-sanitizer.test.ts`, `tests2/core/compaction-types.test.ts`, and `tests/e2e/ui/pre-compaction-history.spec.ts`.

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

Pi JSONL is an append-only, parent-linked session tree. Bobbit follows the current leaf, applies the latest compaction projection, and validates only that active model-context branch. A message-level `toolResult` is retained only when its non-empty `toolCallId` is still present in the immediately preceding assistant result run. This supports a single call or parallel calls with results in any order. Consecutive unmatched results, missing or empty IDs, mismatches, duplicates, and IDs from an older assistant are removed. `isError: true` does not make a matched result invalid.

Valid tool-use/result pairs, valid parallel results, errored results, incomplete assistant tool turns, synthetic compaction pairs, unrelated metadata, and inactive-branch message content are preserved. A valid transcript remains byte-identical. For a malformed active branch, line ordering and trailing-newline shape are retained; only orphan records are removed, plus the minimum `parentId` bypass on surviving descendants needed to avoid breaking the tree. This link-only repair also applies when an inactive branch shared a removed active ancestor. The transform is deterministic and idempotent.

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

## Manual integration blockers and diagnostics

Manual integration remains required for future Pi runtime upgrades because only a real agent turn proves Pi built-in tools, Bobbit extensions, MCP/meta tools, model selection, thinking propagation, sandbox auth propagation, and credential-backed providers work together.

Two environment-sensitive blockers are reported explicitly:

- **Missing usable model credentials** — if no explicit `MANUAL_TEST_MODEL` or provider credential is configured and the gateway default resolves to unauthenticated Code Assist, `agent-tool-use` skips or fails early with an actionable message instead of timing out after sandbox setup.
- **Docker/local transport availability** — Docker must be reachable for sandboxed coverage. Multi-repo readiness polling retries transient local fetch resets, but still fails on HTTP errors, setup errors, or deadline expiry.

For live developer smoke runs, set `BOBBIT_MANUAL_INHERIT_SERVER_CONFIG=1` so isolated manual gateways inherit current model/provider preferences and Pi auth/config files without copying live sessions, goals, projects, gateway tokens, or TLS material. `MANUAL_TEST_MODEL` and `MANUAL_TEST_THINKING_LEVEL` remain highest precedence.

A skipped credential-backed run is a diagnostic, not proof of compatibility.

## Upgrade verification

Run focused contract coverage before the broad gates:

```bash
npx vitest run --config vitest.config.ts --project v2-core \
  tests2/core/oauth-external-callbacks.test.ts \
  tests2/core/pi-rpc-agent-end-retry.test.ts \
  tests2/core/pi-tool-lifecycle-contract.test.ts \
  tests2/core/pi-published-shrinkwrap-security.test.ts \
  tests2/core/compaction-types.test.ts \
  tests2/core/transcript-sanitizer.test.ts \
  tests2/core/google-code-assist-provider-extension.test.ts
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

For release evaluation, the packed-consumer path must build and pack Bobbit, install the tarball into an empty project under normal npm settings, inspect the same dependency tree, parse `npm audit --omit=dev --json` even when it exits nonzero, and smoke the installed `fd`/`rg` binaries. `tests2/core/pi-published-shrinkwrap-security.test.ts` separately pins why a clean root audit cannot replace that consumer test.

Historical upgrade note: [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) records the Opus-specific model, thinking-level, spawn, and sandbox auth contracts from that earlier Pi line.
