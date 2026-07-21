# Pi 0.81 upgrade design

## Decision

Pin `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` exactly to `0.81.1`, the latest common release on 2026-07-21. It restores the pre-0.81 `streamFn` fallback via coding-agent's `setDefaultStreamFn(streamSimple)`. If a compatible patch appears first, advance all three pins together and repeat every check; mixed versions are invalid.

Only coding-agent publishes a shrinkwrap: it fixes `brace-expansion` at `5.0.7` but pins vulnerable `protobufjs@7.6.4`. Clean consumers ignore Bobbit's override and report sole moderate `GHSA-j3f2-48v5-ccww`. Prefer a Pi patch with `protobufjs@7.6.5+`; until then `0.81.1` fixes the high advisory but is not release-audit-clean.

## Implementation

### Pins and lockfile

Change only the three `package.json` pins. Preserve `.npmrc` `shrinkwrap=false` exactly: on current npm it means `package-lock=false`, freezing the lock against ordinary installs.

Follow `.npmrc`: stop native-module holders; back it up outside the repo with a failure trap; temporarily remove it and the installed old `node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json`; run `npm install --package-lock=true`; restore `.npmrc` before testing. Verify the upgrade re-extracted the selected shrinkwrap; never restore the `0.80.6` copy.

The lock must contain one Pi version/integrity, no `0.80.6`, `brace-expansion@5.0.7+`, and `protobufjs@7.6.5+`. Plain `npm install` with `.npmrc` restored must not alter it. A root override is not the consumer fix.

### API adaptations and preserved contracts

- **OAuth — required.** `@earendil-works/pi-ai/oauth` is type-only in `0.81.1`; its JS exports no `getOAuthProvider` or `OPENAI_CODEX_BROWSER_LOGIN_METHOD`. Change `src/server/auth/oauth.ts::oauthStartExternal` to create `builtinModels()` from `@earendil-works/pi-ai/providers/all` and call `Models.login("openai-codex", "oauth", interaction)`. Import `AuthInteraction`/credential types from pi-ai's server-safe root.

  Map `notify` auth/device events to existing `{url,instructions}` and redact logs. Map text/manual prompts to `manualCodePromise`; select one option automatically, else prefer id `browser`, then the existing case-insensitive id/label heuristic. Preserve flow expiry/cancellation, `callbackServer: true`, `storeOAuthCredentials()`, auth.json, `clearOAuthCache()`, and redaction.

- **Models/auth.** Provider-scoped `ModelRuntime` auth and async `Models.refresh()` stay inside the CLI. Keep `src/server/agent/model-registry.ts::{assembleModels,getAvailableModels,resolveModelStateMeta}` as Bobbit's synchronous catalogue and `model-completion.ts` on the compatibility export unless compilation proves otherwise. Add no credential store/refresh loop.

- **RPC/lifecycle.** `rpc-bridge.ts::sendCommand` already accepts additive `get_available_thinking_levels`. Preserve `session-manager.ts::{isRetryableAgentEnd,handleAgentLifecycle}` and `session-setup.ts::subscribeToEvents`: `agent_end {willRetry:true}` cannot mark idle, settle waiters, drain prompts, revoke grants, or reach the browser. Summarization retries/`compaction_end.willRetry` settle only at terminal end; retain usage.

- **Storage/compaction.** New `SessionStorage` members (`getSessionName`, `getSessionStats`, `getPathToRootOrCompaction`, cursor `getEntries`) remain CLI-internal. Preserve `transcript-sanitizer.ts::{sanitizeTranscriptContent,sanitizeAgentTranscriptFile}` branch/orphan handling; preserve `session-manager.ts::refreshAfterCompaction`, `compaction-sidecar.ts`, `__compaction_summary`, and reload/history UI.

- **Browser/extensions.** Keep `src/app/pi-ai-lazy.ts` on browser-safe `@earendil-works/pi-ai/api/*` values and erased root types. Preserve the proxy `streamFn` in `AgentInterface.ts`/`proxy-utils.ts`. Keep `google-code-assist-provider-extension.ts` and unconditional `session-setup.ts` registration until host/Docker tests prove replacement safe.

Update `docs/pi-runtime-compatibility.md` with the version, OAuth migration, blocker, and upstream dynamic catalogues, llama.cpp management, Qwen Token Plan providers, richer usage, and thinking-level RPC. Mark them upstream-only unless intentionally adopted.

## Regression and verification

Extend `tests2/core/oauth-external-callbacks.test.ts`, `tests2/core/pi-rpc-agent-end-retry.test.ts`, `tests2/core/transcript-sanitizer.test.ts`, `tests2/core/compaction-types.test.ts`, `tests2/dom/ui-fixtures/compaction-widget.test.ts`, `tests2/browser/e2e/pre-compaction-history.spec.ts`, and `tests2/core/google-code-assist-provider-extension.test.ts` for the contracts above.

Add `tests2/core/pi-published-shrinkwrap-security.test.ts`: a fixture with a secure root override and vulnerable dependency-owned pin must fail. Add/register `tests/e2e/pi-packed-consumer.spec.ts`: pack Bobbit, install into an empty temp project, inspect the installed consumer tree, and enforce floors. This detects root-audit false negatives.

Retain clean-consumer output from:

```text
npm pack --json
npm install <absolute-bobbit-tarball>
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent brace-expansion protobufjs
npm audit --omit=dev
```

Import `node_modules/bobbit/dist/server/binaries.js`; require bundled `getFdResolution()`/`getRgResolution()` on supported platforms and execute both with `--version`. Run focused tests, `npm run build`, `npm run check`, `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e`.

## Pass/fail

Compatibility requires aligned pins/lock, all commands green, preserved OAuth, terminal-only retry/compaction settlement, stable transcript/compaction UI, narrow browser imports, working extensions, consumer `brace-expansion@5.0.7+`, and binary smoke success.

Release security requires a zero clean-consumer audit and every `protobufjs@7.6.5+`. On `0.81.1`, compatibility/high remediation may pass but release security must fail with exactly the known moderate advisory. Any extra advisory, stale/mixed Pi entry, missing shrinkwrap, lock mutation under restored `.npmrc`, or behavior regression fails.
