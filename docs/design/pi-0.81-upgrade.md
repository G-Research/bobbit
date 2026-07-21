# Pi 0.81 upgrade design

## Decision

Pin `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` exactly to `0.81.1`, the latest common release on 2026-07-21. It restores the pre-0.81 `streamFn` fallback via coding-agent's `setDefaultStreamFn(streamSimple)`. If a compatible patch appears first, advance all three pins together and repeat every check; mixed versions are invalid.

Only coding-agent publishes a shrinkwrap: it fixes `brace-expansion` at `5.0.7` but pins vulnerable `protobufjs@7.6.4`. Clean consumers ignore Bobbit's override and report sole moderate `GHSA-j3f2-48v5-ccww`. Prefer a Pi patch with `protobufjs@7.6.5+`; until then `0.81.1` fixes the high advisory but is not release-audit-clean.

## Implementation

### Pins and lockfile

Change only the three `package.json` pins. Preserve `.npmrc` `shrinkwrap=false` exactly: on current npm it means `package-lock=false`, freezing the lock against ordinary installs.

Follow `.npmrc`: stop native-module holders; back it up outside the repo with a failure trap; temporarily remove it and the installed old `node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json`; run `npm install --package-lock=true`; restore `.npmrc` before testing. Verify the upgrade re-extracted the selected shrinkwrap; never restore the `0.80.6` copy.

The lock must contain one Pi version/integrity, no `0.80.6`, and only `brace-expansion@5.0.7+`. With selected `0.81.1`, require the coding-agent shrinkwrap's known nested `protobufjs@7.6.4`; require `protobufjs@7.6.5+` only if all three pins advance to a Pi patch that publishes that floor. Plain `npm install` with `.npmrc` restored must not alter the lock. A root override is not the consumer fix.

### API adaptations and preserved contracts

- **OAuth — required.** `@earendil-works/pi-ai/oauth` is type-only in `0.81.1`; its JS exports no `getOAuthProvider` or `OPENAI_CODEX_BROWSER_LOGIN_METHOD`. Change `src/server/auth/oauth.ts::oauthStartExternal` to create `builtinModels()` from `@earendil-works/pi-ai/providers/all` and call `Models.login("openai-codex", "oauth", interaction)`. Import `AuthInteraction`/credential types from pi-ai's server-safe root.

  Map `notify` auth/device events to existing `{url,instructions}` and redact logs. Map text/manual prompts to `manualCodePromise`; select one option automatically, else prefer id `browser`, then the existing case-insensitive id/label heuristic. Preserve flow expiry/cancellation, `callbackServer: true`, `storeOAuthCredentials()`, auth.json, `clearOAuthCache()`, and redaction.

- **Models/auth.** Provider-scoped `ModelRuntime` auth and async `Models.refresh()` stay inside the CLI. Keep `src/server/agent/model-registry.ts::{assembleModels,getAvailableModels,resolveModelStateMeta}` as Bobbit's synchronous catalogue and `model-completion.ts` on the compatibility export unless compilation proves otherwise. Add no credential store/refresh loop.

- **RPC/lifecycle.** `rpc-bridge.ts::sendCommand` already accepts additive `get_available_thinking_levels`. Preserve `session-manager.ts::{isRetryableAgentEnd,handleAgentLifecycle}` and `session-setup.ts::subscribeToEvents`: `agent_end {willRetry:true}` cannot mark idle, settle waiters, drain prompts, revoke grants, or reach the browser. Summarization retries/`compaction_end.willRetry` settle only at terminal end; retain usage.

- **Tool lifecycle.** Audit `rpc-bridge.ts`, `session-setup.ts::subscribeToEvents`, `session-manager.ts::{handleAgentLifecycle,emitAgentEvent}`, generated tool extensions, and the client reducer against Pi's exported `AgentEvent`, `ToolExecutionStartEvent`, `ToolExecutionUpdateEvent`, `ToolExecutionEndEvent`, `ToolCallEvent`, `ToolResultEvent`, `AgentToolResult`, and `AgentToolUpdateCallback` contracts. Preserve call/update/result ordering and payloads: start still marks a tool turn and enforces policy, update only refreshes partial UI state, and result/end preserves error normalization, persisted output, browser delivery, and the steer boundary. Treat `usage` and `addedToolNames` as optional additive fields: accept and forward them without synthesizing defaults, changing Bobbit cost accounting, activating tools, or changing settlement.

- **Storage/compaction.** New `SessionStorage` members (`getSessionName`, `getSessionStats`, `getPathToRootOrCompaction`, cursor `getEntries`) remain CLI-internal. Preserve `transcript-sanitizer.ts::{sanitizeTranscriptContent,sanitizeAgentTranscriptFile}` branch/orphan handling; preserve `session-manager.ts::refreshAfterCompaction`, `compaction-sidecar.ts`, `__compaction_summary`, and reload/history UI.

- **Browser/extensions.** Keep `src/app/pi-ai-lazy.ts` on browser-safe `@earendil-works/pi-ai/api/*` values and erased root types. Preserve the proxy `streamFn` in `AgentInterface.ts`/`proxy-utils.ts`. Full provider extensions remain upstream-only; do not replace Bobbit's `google-code-assist-provider-extension.ts`, provider bridge, or unconditional `session-setup.ts` registration in this upgrade.

Update `docs/pi-runtime-compatibility.md` with the version, OAuth migration, security blocker, richer optional usage/tool fields, and these explicit adoption decisions:

- Adopt refreshed static model metadata and the Kimi K3, OpenAI Responses, Bedrock, OpenCode Go, and xAI fixes through Bobbit's existing synchronous registry/provider paths, without new configuration or routing behavior.
- Adopt the Codex provider fixes plus the required OAuth migration above; do not adopt Pi's provider-scoped runtime auth or async catalogue refresh.
- Keep full provider extensions, dynamic provider catalogues, llama.cpp management, and Qwen Token Plan providers upstream-only. They require separate Bobbit integration work; existing extensions and provider behavior remain unchanged.

## Regression and verification

Extend `tests2/core/oauth-external-callbacks.test.ts`, `tests2/core/pi-rpc-agent-end-retry.test.ts`, `tests2/core/transcript-sanitizer.test.ts`, `tests2/core/compaction-types.test.ts`, `tests2/dom/ui-fixtures/compaction-widget.test.ts`, and `tests2/core/google-code-assist-provider-extension.test.ts`. Add `tests2/core/pi-tool-lifecycle-contract.test.ts`: emit tool execution start/update/end plus extension tool call/result payloads and assert ordering, policy/steer boundaries, partial-result forwarding, final output/error normalization, and omission/presence of optional `usage` and `addedToolNames`. Include compile-time type imports for the newly exported lifecycle types without adopting new runtime behavior.

Add `tests2/core/pi-published-shrinkwrap-security.test.ts`: a fixture with a secure root override and vulnerable dependency-owned pin must fail. Explicitly register both `tests2/core/pi-tool-lifecycle-contract.test.ts` and `tests2/core/pi-published-shrinkwrap-security.test.ts` in `tests2/tests-map.json` under the core unit suite. Add/register `tests/e2e/pi-packed-consumer.spec.ts`: pack Bobbit, install into an empty temp project, and apply the version-conditional compatibility assertions below. This detects root-audit false negatives.

### Browser E2E journey

In `tests/e2e/ui/pre-compaction-history.spec.ts`, use the isolated full-stack gateway/mock-agent fixture and its temporary project/`BOBBIT_DIR`. Create a session through the fixture API, wait for `idle`, and navigate the app to `#/session/<sessionId>`. Send `AUTO_COMPACT:3` through the visible message editor so the mock agent emits the real auto-compaction lifecycle and persists three pre-boundary messages, a compaction sidecar entry, and a retained tail. `npm run test:e2e` must discover and run this full-stack UI path. Do not add a duplicate `tests2/browser` version unless it covers a distinct browser-tier contract.

Assert one successful summary card, a collapsed `Show 3 messages before compaction` control before the retained tail, and—after clicking it—three dimmed historical rows with their original content and no live/queued state. Reload the same route, wait for the transcript snapshot, and assert the one-card invariant, collapsed count, retained tail/order, and the same three rows after re-expansion. In `finally`, delete the session through the fixture helper; fixture teardown removes the temporary project and `BOBBIT_DIR`.

### Dependency trees

After controlled lock regeneration, retain development-checkout output from:

```text
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent brace-expansion protobufjs --all
```

It passes only when npm exits zero, the three Pi roots are the same selected version, every resolved `brace-expansion` is `5.0.7+`, and the `0.81.1` tree contains exactly the known coding-agent-nested `protobufjs@7.6.4` edge (or every `protobufjs` is `7.6.5+` for a later selected patch), with no invalid, missing, stale, or extraneous Pi edge.

Retain packed-consumer output from:

```text
npm pack --json
npm install <absolute-bobbit-tarball>
npm ls @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent brace-expansion protobufjs --all
npm audit --omit=dev --json
```

The packed-consumer audit helper must capture stdout and parse its JSON even when `npm audit` exits nonzero. For `0.81.1`, it accepts a nonzero exit only when the parsed result has the exact expected single-moderate-advisory shape: the consumer has aligned Pi versions, every `brace-expansion` is `5.0.7+`, the sole vulnerable dependency is the coding-agent-nested `protobufjs@7.6.4`, the only advisory is `GHSA-j3f2-48v5-ccww`, and the counts are exactly one moderate with zero low, high, or critical vulnerabilities. It must fail infrastructure/command-spawn errors, missing or malformed stdout, JSON parse errors, and any divergent exit status, advisory, count, package, version, or dependency path. For a later selected patch, it instead requires a zero exit, every `protobufjs@7.6.5+`, and a zero-vulnerability audit.

Import `node_modules/bobbit/dist/server/binaries.js`; require bundled `getFdResolution()`/`getRgResolution()` on supported platforms and execute both with `--version`. Run focused tests, `npm run build`, `npm run check`, `npm run test:unit`, `npm run test:browser`, and `npm run test:e2e`; the known `0.81.1` moderate is an asserted compatibility outcome, not a failing E2E.

## Pass/fail

Compatibility requires aligned pins/lock, all commands green, preserved OAuth/tool lifecycle/retry/compaction behavior, stable history UI, narrow browser imports, working extensions, `brace-expansion@5.0.7+` in both trees, the version-conditional protobuf/audit assertions above, and binary smoke success. Any extra advisory, stale/mixed Pi edge, missing shrinkwrap, lock mutation under restored `.npmrc`, or behavior regression fails.

Release eligibility is a separate blocking condition, not the `0.81.1` compatibility E2E verdict: Pi must publish a compatible common patch whose coding-agent shrinkwrap resolves every `protobufjs@7.6.5+`, and a fresh packed-consumer audit must report zero vulnerabilities. Therefore `0.81.1` may complete implementation and all required test gates with exactly its known moderate, but Bobbit must not declare the next release audit-clean or release-eligible until that condition passes.
