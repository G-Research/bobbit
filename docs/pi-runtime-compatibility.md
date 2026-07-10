# Pi runtime compatibility

Bobbit depends on Pi for provider metadata, browser-side first-message streaming helpers, and the `pi-coding-agent` process that runs agent turns. Pi upgrades are runtime compatibility changes, not simple package bumps: they can affect browser bundle safety, model catalog reads, RPC lifecycle events, tool-result event shapes, transcript metadata, sandbox auth, and provider default selection.

This page records the durable Bobbit-side contracts added or reaffirmed while upgrading the three Pi packages to `0.80.6`:

- `@earendil-works/pi-agent-core@0.80.6`
- `@earendil-works/pi-ai@0.80.6`
- `@earendil-works/pi-coding-agent@0.80.6`

Keep the three packages pinned to the same Pi patch line. A mixed Pi line can compile while still breaking spawned-agent runtime contracts.

## Pi `0.80.6` model and thinking metadata

Pi `0.80.6` keeps the `0.80.x` package export surface compatible with Bobbit's server import paths, but it adds new catalog metadata that Bobbit must preserve end to end:

- GPT 5.6 model ids: `gpt-5.6-luna`, `gpt-5.6-sol`, and `gpt-5.6-terra`.
- Routed GPT 5.6 variants, including `openrouter/openai/gpt-5.6-*` and `vercel-ai-gateway/openai/gpt-5.6-*`.
- `thinkingLevelMap.max` for models that explicitly support Pi's `max` effort tier.
- Optional provider cost-tier metadata.

Bobbit exposes those fields through `/api/models`, the settings/model selector, session spawn args, role validation, and reconnect state frames. `max` is not guessed from model-family regexes; it is only selectable when upstream metadata explicitly includes a non-null `thinkingLevelMap.max`. See [Per-model thinking-level capabilities](thinking-levels.md) for the shared clamping rules.

Pinned coverage:

- `tests2/core/models-api.test.ts` checks GPT 5.6 Luna/Sol/Terra, OpenAI/OpenAI-Codex context windows, routed variants, and `xhigh`/`max` metadata exposure.
- `tests2/core/thinking-levels.test.ts`, `tests2/core/role-store.test.ts`, `tests2/core/rpc-bridge-spawn-args.test.ts`, and `tests2/dom/thinking-levels-per-model.test.ts` cover `max` validation, clamping, labels, and spawn propagation.

## Fable model-state preservation

Claude Fable 5 is the canary for model metadata preservation because Pi reports it as a 1M-context reasoning model with:

```ts
{ off: null, xhigh: "xhigh", max: "max" }
```

The `off: null` entry means Fable cannot disable adaptive thinking. The `max` entry means Bobbit must keep the `Max` selector option available whenever the live model frame carries that map.

All live and rehydrated `state.model` frames must route through `resolveModelStateMeta(provider, id)` instead of deriving metadata from `inferMeta(id)` alone. The resolver checks the merged registry cache first, then the Pi catalog, then `inferMeta` as a last resort. This matters on reconnect and `get_state`: a stale `inferMeta` fallback can look plausible while silently dropping `thinkingLevelMap.max` and the 1M context window.

Pinned coverage:

- `tests2/core/model-state-meta-resolver.test.ts` checks Fable metadata resolution.
- `tests2/integration/fable-model-state-frame.test.ts` checks that selecting Fable emits the full metadata frame and that reconnect/`get_state` preserves `thinkingLevelMap.max`.

## Browser-safe `pi-ai` boundary

Browser code must not use runtime value imports from the bare `@earendil-works/pi-ai` package. The bare index still pulls in Node-oriented runtime paths such as environment API-key probing, which makes Vite externalize Node modules into browser builds.

Bobbit uses three safe browser patterns instead:

- provider catalog reads go through `GET /api/pi-ai/providers`;
- provider key tests go through `POST /api/pi-ai/provider-key-test`;
- first-message browser streaming goes through `src/app/pi-ai-lazy.ts`, which dynamically imports only Pi package-exported `@earendil-works/pi-ai/api/*` subpaths.

For Pi `0.80.x`, streaming helpers live under `@earendil-works/pi-ai/api/*` and expose a common `streamSimple` export. Do not reintroduce the legacy direct subpaths such as `@earendil-works/pi-ai/anthropic` or `@earendil-works/pi-ai/openai-responses`; those are not the Pi `0.80.x` package exports.

Pinned coverage:

- `tests2/core/pi-ai-browser-boundary.test.ts` checks that `src/app/pi-ai-lazy.ts` has no bare runtime `pi-ai` import and keeps streaming imports on package-exported API subpaths.
- `tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts` checks the model selector and browser-safe provider/key-test routes through the UI.

## Server-side model catalog imports

Server code may import Pi runtime values, but should use the narrowest stable server subpath for the contract it needs. In Pi `0.80.x`, Bobbit reads built-in provider and model metadata from `@earendil-works/pi-ai/providers/all` via `getBuiltinProviders`, `getBuiltinModels`, and `getBuiltinModel`.

Completion helpers that need the compatibility completion surface use `@earendil-works/pi-ai/compat`. Keeping catalog reads and completion helpers on explicit subpaths makes future Pi export drift visible at compile time and avoids accidentally copying a browser-unsafe import pattern into UI code.

## Code Assist pre-auth provider registration

Bobbit generates a `google-code-assist` provider extension so `google-gemini-cli/*` account models can run inside `pi-coding-agent`. Pi `0.80.x` made provider registration order more visible because a registered provider with placeholder auth/models can become an implicit/default candidate before the user logs in.

The final contract is split deliberately:

- The generated extension is written and loaded for spawned agents so the `google-code-assist` API can become available without respawning.
- Before a real Google credential is visible, it registers only the API and `streamSimple` handler. It does **not** register `models[]` or a placeholder `apiKey`, so Code Assist cannot become Pi's unauthenticated default model.
- When local OAuth, `GOOGLE_CLOUD_ACCESS_TOKEN`, or gateway token access becomes available, an auth watcher upgrades the provider registration with `models[]` and the runtime marker `apiKey`.
- The gateway model registry still emits `google-gemini-cli/*` models only after account credentials are present; API-key Gemini remains the separate `google` provider.

Pinned coverage:

- `tests2/core/google-code-assist-provider-extension.test.ts` checks pre-auth extension registration, late-auth upgrade shape, token endpoint use, env fallback, and no TLS downgrade.
- `tests2/core/google-code-assist-registry.test.ts` checks that unauthenticated Code Assist models are not emitted and cannot authenticate the API-key-only `google` provider.

See [Google OAuth models](google-oauth-models.md) for the user-facing provider split.

## Retryable `agent_end` is non-final

Pi `0.80.x` can emit an `agent_end` event for a failed attempt that Pi will retry internally. Those events carry `willRetry: true` and are not the end of the Bobbit turn.

Bobbit treats `agent_end.willRetry === true` as non-final:

- keep the session in `streaming`;
- do not revoke one-time tool grants;
- do not drain queued prompts;
- do not resolve `waitForIdle()`;
- wait for the final `agent_end` where `willRetry !== true`.

This preserves Bobbit's queue and grant lifecycle while Pi handles the retry. The contract is pinned by `tests2/core/pi-rpc-agent-end-retry.test.ts`.

## Tool-result error normalization

Pi `0.80.x` may return tool result errors where the top-level event says `isError: false`, but the nested result content serializes a JSON object with `isError: true`.

Bobbit normalizes these events before rendering and persistence decisions. The normalizer inspects top-level flags, `result`/`output`, stringified JSON payloads, and text content nested under `result.content` or `output.content`. It returns a normalized copy and does not mutate the original Pi event.

Pinned coverage: `tests2/core/tool-result-error-normalizer.test.ts`.

## Transcript/session-tree metadata

Pi session JSONL is Pi-owned, so Bobbit transcript utilities must be conservative around new entry kinds. Pi `0.80.x` can write session-tree metadata entries such as `active_tools_change`, `leaf`, and hidden `custom_message` rows. These are metadata entries, not chat messages and not Bobbit runtime headers.

Bobbit's transcript sanitizer and cwd-rebase path leave these entries byte-identical. Only Bobbit-owned runtime metadata headers are eligible for cwd rebasing during fork/continue-archived flows. This prevents a compatibility sanitizer from corrupting Pi's session tree while still allowing Bobbit to update its own top-level runtime cwd metadata.

Pinned coverage: `tests2/core/transcript-sanitizer.test.ts`.

## Worktree setup timeout cleanup

Worktree setup commands are non-fatal, but timeout handling must still wait until the timed-out shell tree has been cleaned up before publishing or claiming the worktree. Returning early can leave child processes holding worktree directory handles, especially on Windows with Git Bash/MSYS children.

`runComponentSetups()` distinguishes callers whose `exec` implementation owns timeout cleanup via `execHandlesTimeout`. Host worktree setup uses `execShellCommand()` so the shell wrapper can kill the process tree, wait for cleanup, and then reject with timeout. Container setup similarly passes the per-command timeout into the Docker exec path.

The reason is operational rather than cosmetic: a worktree that appears claimable while setup children still hold handles can fail later `git worktree move`, cleanup, or reuse operations. The regression is pinned by `tests/worktree-pool.test.ts`.

## Manual integration blockers and diagnostics

Manual integration remains required for Pi runtime upgrades because only a real agent turn proves Pi built-in tools, Bobbit extensions, MCP/meta tools, model selection, thinking-level propagation, sandbox auth propagation, and credential-backed providers still work together.

The `0.80.6` upgrade found two environment-sensitive blockers that the manual suite now reports more clearly:

- **Missing usable model credentials** — if no explicit `MANUAL_TEST_MODEL`/provider credential is configured and the gateway default resolves to unauthenticated Code Assist, `agent-tool-use` skips/fails early with an actionable credential message instead of timing out after sandbox setup. Tool-card assertions remain strict.
- **Docker/local transport availability** — Docker must be reachable for sandboxed manual coverage. Multi-repo goal-readiness polling retries transient local fetch resets such as `TypeError: fetch failed` / `ECONNRESET`, but still fails immediately on HTTP errors, `setupStatus=error`, or deadline expiry.

For live developer smoke runs, set `BOBBIT_MANUAL_INHERIT_SERVER_CONFIG=1` so isolated manual gateways inherit the current server's model/provider preferences and Pi agent auth/config files from `BOBBIT_DIR` without copying live sessions, goals, projects, gateway tokens, or TLS material. `MANUAL_TEST_MODEL` and `MANUAL_TEST_THINKING_LEVEL` remain highest precedence and override the inherited session model/thinking defaults.

Use the manual diagnostics as blockers, not as proof of compatibility. A skipped credential-backed run does not verify Pi built-in tools, Bobbit extension tools, MCP/meta tools, or OAuth-backed providers.

## Upgrade checklist

For future Pi upgrades, keep these checks in the focused pass before broad verification:

```bash
npm run check
npm run test:unit
npm run test:browser
npm run test:e2e
npm run test:manual
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent
```

Expected `npm ls` result for this upgrade: all three target packages resolve to `0.80.6` with no stale nested copies.

Historical upgrade note: [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) records the Opus 4.8-specific model, thinking-level, spawn, and sandbox auth contracts from that earlier Pi line.
