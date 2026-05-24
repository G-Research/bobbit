# Pi `0.75.x` upgrade — OAuth callback contract + Node version

Bobbit upgraded `@earendil-works/pi-{ai,agent-core,coding-agent}` from `0.74.0`
directly to `0.75.5`. This document captures the two integration-visible
contracts that changed.

## OAuth: `OAuthLoginCallbacks` shape

`@earendil-works/pi-ai@0.75.x` makes two new callbacks **required** on the
`login()` callbacks bag:

- **`onDeviceCode(info)`** — providers using the OAuth 2.0 Device Authorization
  Grant emit `{ userCode, verificationUri, intervalSeconds?, expiresInSeconds? }`
  here. Bobbit must surface this to the UI so the user can enter the code.
- **`onSelect(prompt)`** — provider asks the host to pick one of
  `prompt.options: { id, label }[]`. Must return the selected id (or
  `undefined` for cancel).

Only `src/server/auth/oauth.ts::oauthStartExternal()` calls
`oauthProvider.login(...)`. The Anthropic flow uses Bobbit's own PKCE path and
is unaffected. The OpenAI Codex flow does not exercise either callback today,
but the type signature requires both to be present.

### How Bobbit wires them

- `onDeviceCode`: packs `userCode` + `verificationUri` into the existing
  `{ url, instructions }` shape that flows through the `started` promise back
  to the UI dialog. `started` is single-shot — `safeResolveStarted()` is a
  guarded wrapper so whichever of `onAuth` / `onDeviceCode` fires first wins;
  subsequent calls log only and never reject. Device-code instructions are
  also logged via `console.log` (passed through `redactSensitive`).
- `onSelect`: deterministic — auto-picks `options[0].id` when exactly one
  option is presented (nothing for the user to choose). Otherwise throws a
  Bobbit-specific `"OAuth provider requested a selection Bobbit does not
  support yet"` error so the flow fails loudly via the existing
  `loginPromise.catch` path rather than hanging on a missing UI.

Pinning test: `tests/oauth-external-callbacks.test.ts`.

## Node engine requirement

`@earendil-works/pi-ai@0.75.x` requires Node `>=22.19.0`. `package.json` now
pins `engines.node` accordingly so `npm install` on older Node fails with a
clear `EBADENGINE` warning rather than a confusing runtime crash inside the
Pi runtime.

## Surface area NOT changed

The following Pi APIs Bobbit consumes were re-verified and did **not** require
code changes for the `0.75.5` jump:

- `import.meta.resolve("@earendil-works/pi-ai")` in `aigw-manager.ts`.
- `import.meta.resolve("@earendil-works/pi-coding-agent")` and the
  `dist/cli.js` spawn path in `rpc-bridge.ts` + `sandbox-status.ts`.
- `Message`, `ToolCall`, `ToolResultMessage`, `AgentEvent`, `AgentTool`,
  `Agent`, `Usage`, `Context`, `Model`, `ThinkingLevel` re-exports across the
  UI layer.
- `streamSimple`, `complete`, `getModel`, `getModels`, `getProviders`,
  `modelsAreEqual` from `pi-ai`.
- `declare module` augmentations in `src/app/custom-messages.ts` and
  `src/ui/components/Messages.ts`.

If any of these break in a future `0.75.x` patch, extend the pinning test
above rather than adding prose.
