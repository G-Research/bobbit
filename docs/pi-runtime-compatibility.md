# Pi runtime compatibility

Bobbit depends on Pi for provider metadata, browser-side first-message streaming helpers, and the `pi-coding-agent` process that runs agent turns. Pi upgrades are therefore runtime compatibility changes, not simple package bumps: they can affect browser bundle safety, model catalog reads, RPC lifecycle events, tool-result event shapes, and transcript metadata.

This page records the durable Bobbit-side contracts added or reaffirmed while upgrading the three Pi packages to `0.80.5`:

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-coding-agent`

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

`runComponentSetups()` now distinguishes callers whose `exec` implementation owns timeout cleanup via `execHandlesTimeout`. Host worktree setup uses `execShellCommand()` so the shell wrapper can kill the process tree, wait for cleanup, and then reject with timeout. Container setup similarly passes the per-command timeout into the Docker exec path.

The reason is operational rather than cosmetic: a worktree that appears claimable while setup children still hold handles can fail later `git worktree move`, cleanup, or reuse operations. The regression is pinned by `tests/worktree-pool.test.ts`.

## Upgrade checklist

For future Pi upgrades, keep these checks in the focused pass before broad verification:

```bash
npm run check
npm run test:unit
npm run test:browser
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent
```

Manual integration remains required for Pi runtime upgrades because only a real agent turn proves Pi built-in tools, Bobbit extensions, MCP/meta tools, model selection, thinking-level propagation, and credential-backed providers still work together.

Historical upgrade note: [Pi 0.77 / Claude Opus 4.8 compatibility](pi-0.77-opus-4.8.md) records the Opus 4.8-specific model, thinking-level, spawn, and sandbox auth contracts from that earlier Pi line.
