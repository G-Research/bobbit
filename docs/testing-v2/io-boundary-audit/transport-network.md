# Transport and network I/O boundary audit

**Audit date:** 2026-07-15
**Frozen evidence snapshot:** `4df9a35e2bd1ac5b662382189e12973fc4e1c4c2` (`MB`)
**Policy:** no substantive coverage migration landed after `MB` may justify mocking a unit-owned I/O boundary.

## Baseline scope and decision rules

This re-audit uses the merge-base tree only. At `MB`, `tests2/core` contained `548` `*.test.ts` files and `tests2/integration` contained `188`; the twelve paths already present in `scripts/testing-v2/integration-e2e-files.mjs` are eligible E2E, leaving `176` unit-scope integration files and `724` unit-owned files total. Current/new browser tests, current assertions added to old files, and files moved into an E2E lane after `MB` do not qualify.

The baseline was checked with:

```bash
git show MB:scripts/testing-v2/integration-e2e-files.mjs
git ls-tree -r --name-only MB -- tests2/core tests2/integration
git cat-file -e MB:<candidate-path>
git show MB:<candidate-path> | nl -ba
git diff --name-status MB..HEAD -- <candidate-paths>
```

All qualifying paths cited below existed at `MB`. The final diff command showed no changes to any cited browser or fixed-list E2E test; the only fixed-list manifest change after `MB` is a comment. Assertions are nevertheless quoted from `git show MB:...`, never from the working tree.

Status meanings:

- **MB-COVERED:** an eligible test already crossed the same real boundary at `MB` and asserted all material boundary behavior owned by the unit seam.
- **MB-PARTIAL:** baseline E2E proved only a representative path or adjacent behavior. Unproved boundary-owning assertions remain real.
- **MB-GAP:** no baseline E2E crossed and asserted the same boundary.
- **Boundary-independent (`BI`):** route/domain decisions, validation, state transitions, mapping, and payload construction that do not depend on a real listener/socket/protocol implementation.
- **Boundary-owning (`BO`):** assertions about actual HTTP/socket/WS/SSE framing, parsing, auth headers/frames, listener bind/refusal, streaming order/backpressure, disconnect, or close behavior.

**Non-negotiable preservation rule:** a unit assertion that owned real HTTP/socket/WS/SSE/stream framing, auth, listener, or close semantics at `MB` stays on the real boundary unless the exact assertion is MB-COVERED. A generic browser health check does not cover every route; a happy-path WS exchange does not cover payload limits, auth rejection, backpressure, or close; an in-process `restoreSessions()` call does not cover a gateway process/listener restart.

## Merge-base proof ledger

Line references are to the blobs returned by `git show MB:<path> | nl -ba`.

| ID | Eligible baseline test and exact assertion |
|---|---|
| `E1` | `tests2/browser/journeys/session-lifecycle.journey.spec.ts:74-83`, “send message gets mock-agent response”: fill/Enter and `expect(page.getByText("OK").first()).toBeVisible(...)`; `:102-112` reloads and reopens the editor. |
| `E2` | `tests2/browser/e2e/crash-restart.journey.spec.ts:49-61` calls `gateway.crash()`/`gateway.restart()` and asserts sidebar recovery plus `GET /health` status `200`; `:68-77` asserts a pre-crash session GET returns `200` and the same id. |
| `E3` | `tests2/integration/project-isolation.test.ts:75-94` asserts session detail `200`, exact `projectId`, inclusion in project B, and exclusion from the default project; `:156-192` asserts goal create `201` and filtered isolation. |
| `E4` | `tests2/integration/team-lead-child-authz.test.ts:58-96` sends foreign-secret/no-secret HTTP requests and asserts `403`; `:102-116` sends the owner secret and asserts prompt/dismiss `200` and `{ok:true}`. |
| `E5` | `tests2/integration/commit-file-diffs-api.test.ts:79-110` asserts commits/diff status `200`, exact diff markers, rename text, and `400` invalid path/commit errors; `:125-140` applies it to a real session route. |
| `E6` | `tests2/browser/e2e/tail-chat-real-stream.spec.ts:30-73` dispatches `STREAM_BURST:2`, asserts more than six samples, transcript growth, no tail drift, and live DOM equality with the refreshed transcript. |
| `E7` | `tests2/browser/journeys/goal-team-gates.journey.spec.ts:231-260` calls `connectWs`, waits for a gate terminal frame, then asserts slim-list and full-inspect payloads; `:291-305` repeats the real WS wait and asserts terminal/non-stale status. |
| `E8` | `tests2/browser/e2e/terminal-pack.spec.ts:39-108` asserts `ext_channel_open`, command output, resize-frame growth, reload `ext_channel_attach`, replay, hide without kill, exit, reopen, explicit kill, and terminal state transitions. |
| `E9` | `tests2/integration/team-wait-semantics.test.ts:152-169`, “chunked wait route surfaces a post-headers error”: asserts HTTP `200`, string `error` matching `/not owned/i`, and an empty status list. |
| `E10` | `tests2/integration/steer-gateway-restart.test.ts:41-152` uses a real WS, closes/reconnects it around an in-process `restoreSessions()`, and asserts `RESTART_M1`/`M2` exactly once and ordered plus REST status `200`. It is not a process/listener restart proof. |
| `E11` | `tests2/integration/orchestrate-restart.test.ts:76-115` uses a parent WS and HTTP wait/dismiss, but lines `84-88` explicitly simulate reboot by rebuilding the in-process index. It proves orchestration semantics, not bind/shutdown/restart. |
| `E12` | `tests2/browser/e2e/pr-walkthrough-pack.spec.ts:624-648` observes a browser `POST /api/ext/route/run`, asserts status `200`, and visible `NO_PR` feedback; `:698-724` asserts `x-bobbit-session-id`, body `sessionId`, and status `200` for an inactive-row launch. |
| `E13` | `tests2/browser/journeys/goal-editing.journey.spec.ts:444-469` posts a child goal, asserts `201`, and asserts the returned `parentGoalId`. |
| `E14` | `tests2/browser/journeys/misc.journey.spec.ts:205-258` asserts preview PATCH/POST `200`, entry/mtime, client-state delivery, iframe URL, stable open-in-new-tab URL, and refresh cache-buster change. |
| `E15` | `tests2/integration/team-dismiss-structured-regression.test.ts:77-140` asserts first/duplicate dismiss response contracts and real worker cleanup; `:149-184` asserts non-owner denial and lead success. This is server-route proof, not execution of the generated client. |

Baseline-adjacent tests deliberately **not** credited:

- `pi-runtime-upgrade.journey.spec.ts:35-41,70-107` proves Bobbit `/api/models`, not an AIGW upstream; `:116-157` intercepts provider-key requests with `page.route()`.
- `pr-walkthrough-default-off.spec.ts:126-203` proves Hindsight is absent, not Hindsight HTTP.
- `sidebar-actions-fork-github-link.test.ts:169-205` reads a seeded PR/link state, not GitHub HTTP.
- `pr-walkthrough-trust-prompt.spec.ts:115-193` fulfills the run route with `page.route()`, so it cannot prove GitHub transport.
- `prompt-interaction.journey.spec.ts:207-228` calls the grant endpoint directly and proves UI/server behavior, not generated extension-client transport.

## Verdict summary

| Seam | Merge-base verdict | Exact baseline proof | Real unit behavior that must remain |
|---|---|---|---|
| Gateway HTTP routes | **MB-PARTIAL** | `E1`, `E3`, `E4`, `E5`, `E14` | Unproved endpoint HTTP parsing/serialization/auth and listener canaries |
| Gateway boot/shutdown/restart | **MB-PARTIAL** | `E2`; `E10`/`E11` are explicitly in-process only | Bind, port, refusal, open-socket shutdown, HTTP/WS close |
| Gateway WebSocket | **MB-PARTIAL** | `E6`, `E7`; limited reconnect evidence in `E2`/`E10` | Upgrade/auth rejection, frame limits, backpressure, fan-out, transparent reconnect/close |
| Extension-host WS channels | **MB-PARTIAL** | `E8` terminal happy path | Token rejection, cross-pack/session isolation, ordering failures, socket close |
| Chunked HTTP/body streams | **MB-PARTIAL** | `E9` only for `/orchestrate/wait` post-header error | Header timing, heartbeats, chunks, abort, oversized request body |
| SSE | **MB-GAP** | None | SSE parser/framing, content type, flush, abort/disconnect/reconnect |
| AI Gateway upstream | **MB-GAP** | None | Local upstream HTTP/proxy/stream/header/listener contracts |
| OAuth | **MB-GAP** | None | Callback listener, redirect/auth/state transport, provider HTTP, close |
| Image-provider HTTP | **MB-GAP** | None | Redirects, streamed byte cap, abort/close, provider request contract |
| Google Code Assist HTTP/SSE | **MB-GAP** | None | Provider SSE framing/abort and generated token-client HTTP |
| Hindsight HTTP | **MB-GAP** | None | Timeout/refusal/status and local upstream lifecycle |
| MCP streamable HTTP | **MB-GAP** | None | Initialize/session-header/framing/error/close sequence |
| GitHub review HTTP | **MB-GAP** | None | Authorization header, review body, status/error/close transport |
| Generated gateway clients | **MB-PARTIAL** | `E12` for PR launcher only; `E15` is server-side only | Every unproved generated-client request/auth/error contract |
| Direct handler adapters | **MB-PARTIAL** | `E13`, `E14`, part of `E12` | Body overflow, preview-cookie auth, bg heartbeat, stream state |
| Fetch/command egress fence | **MB-GAP** | No product E2E is appropriate | Positive real loopback canary and block-before-DNS behavior |
| HTTPS/TLS | **MB-GAP** | None | No baseline unit coverage exists; add TLS proof before claiming fidelity |

No seam is **MB-COVERED** at the granularity needed to remove all of its real unit owners.

## Findings by transport seam

### 1. Fork-scoped gateway HTTP transport — **MB-PARTIAL**

**Baseline unit owners:** the `164` shared-gateway files in Appendix A plus the baseline direct/custom gateway owners described in seam 2. They cross `127.0.0.1:<ephemeral>` into the production Node HTTP listener and are unit-scope despite using real TCP.

**BI assertions:** route selection; request validation after bytes are decoded; CRUD/filtering; permission decisions; manager/store effects; response-object shape.

**BO assertions:** actual method/path/header/body parsing; bearer and `X-Bobbit-Session-Secret` carriage; Node status/header/body serialization; malformed request behavior; connection and response close.

**MB proof:** `E1`, `E3`, `E4`, `E5`, and `E14` cover only their exact routes and assertions. They do not license replacing the listener for unrelated Appendix A endpoints.

**Disposition:** handler-level BI permutations may use an extracted `createGatewayRequestHandler(runtimeDeps)` only for exact MB-proved routes. Keep a real listener/auth/serialization canary, and keep every unproved route owner real until an endpoint-equivalent baseline-eligible proof exists.

### 2. Gateway boot, shutdown, restart, and port allocation — **MB-PARTIAL**

**Baseline unit owners:** Appendix A indirectly boots the fork singleton. Direct/custom owners include `gateway-fixture-leak.test.ts`, `project-delete-last.test.ts`, `project-story-api.test.ts`, `session-lifecycle-api.test.ts`, `tasks-api.test.ts`, `unseen-activity-api.test.ts`, `headquarters-api.test.ts`, and `headquarters-server-scope-guards.test.ts`; `cli-loopback-for-bind.test.ts` and `fetch-fence.test.ts` own focused listener behavior.

**BI assertions:** service construction order, restoration decisions, shutdown callbacks invoked, and resource-registry bookkeeping.

**BO assertions:** wildcard/loopback URL mapping, ephemeral-port allocation, bind collision/error, connection refusal, listener readiness, graceful HTTP/WS shutdown, and closure of accepted/open sockets.

**MB proof:** only `E2` crashes and restarts the external gateway and then asserts health/session recovery. `E10` and `E11` are eligible files but explicitly simulate restoration inside the existing process, so they do not cover bind or close.

**Disposition:** split runtime construction from `ListenerFactory`/`PortAllocator`, but keep every BO lifecycle test real. Fixed “unreachable” ports (`1`, `9`, `19999`) must not become injected refusal until a real baseline-eligible refusal assertion exists.

### 3. WebSocket connection, auth, fan-out, reconnect, and frame ordering — **MB-PARTIAL**

**Baseline unit owners:** the `44` real-WS integration files in Appendix B. Fake-socket/protocol owners include `event-buffer.test.ts`, `extension-host-ws-channel-attach-ordering.test.ts`, `extension-host-ws-channel-open-grant.test.ts`, `restart-preserves-streaming-frame.test.ts`, `sandbox-recovery-preserves-streaming-frame.test.ts`, `snapshot-clears-streaming-message.test.ts`, `ws-overflow-guard.test.ts`, `ws-max-payload.test.ts`, and `verification-review-timeout-payload.test.ts`.

**BI assertions:** event routing and sanitization; replay selection; reducer state; authorization policy after identity is supplied; overflow decisions and message/domain ordering independent of the socket implementation.

**BO assertions:** RFC upgrade; auth frame carriage/rejection; JSON/text/binary frame parsing and order; multi-client fan-out; `maxPayload`; `bufferedAmount` backpressure; network disconnect/reconnect; close code/reason and cleanup.

**MB proof:** `E6` proves a representative live stream and refresh equality; `E7` proves gate delivery over a real WS; `E10` proves client close/reconnect and domain ordering around an in-process restore. `E2` reloads after restart and accepts even `disconnected`, so it does not prove transparent reconnect.

**Disposition:** BI handler logic may use `handleWebSocketConnection()` with a port. Keep real WS auth, payload, backpressure, fan-out, reconnect, and close owners. No MB test sends an oversized frame or forces persistent `bufferedAmount`.

### 4. Extension-host WebSocket channels — **MB-PARTIAL**

**Baseline unit owners:** core channel/open/registry/session-event-bus tests plus real-WS `extension-host-surface-token.test.ts` and `tools-e2e.test.ts`.

**BI assertions:** permit decisions; channel registry ownership; surface-token key construction; cross-session/cross-pack policy; attach-result-before-buffered-frame ordering in the handler.

**BO assertions:** token/auth transport over WS; open/result/frame/attach sequence on a real socket; replay framing; disconnect/close detachment; rejected or malformed channel frames.

**MB proof:** `E8` exactly covers the terminal happy path: open, text frames, resize frames, attach/replay, hide-without-kill, exit, reopen, kill. It does not assert invalid surface tokens, malicious cross-pack/session attempts, malformed frames, or server-side close cleanup.

**Disposition:** handler-policy permutations may use injected `ExtensionChannelServices`; the baseline real socket auth/rejection/close assertions remain real. The terminal journey alone is not blanket coverage for every extension channel.

### 5. Chunked HTTP, long-poll, request bodies, and response streaming — **MB-PARTIAL**

**Baseline unit owners:** `bg-wait-response.test.ts`, `request-body-limit.test.ts`, and real-loopback wait/orchestration owners including `bg-wait-steer-abort.test.ts`, `gates-api.test.ts`, and `team-steer-prompt.test.ts`. `image-from-url-cap.test.ts` uses a synthetic byte stream.

**BI assertions:** terminal JSON/error mapping; wait result/status decisions; byte-count policy after chunks are delivered.

**BO assertions:** headers written before awaiting; chunk/heartbeat byte timing; post-header error framing; `write`/`end` order; request `data`/`end`/`error`/abort behavior; oversized chunked-body rejection and cleanup.

**MB proof:** `E9` proves only that `/orchestrate/wait` returns HTTP `200` and carries a post-header ownership error in JSON. It does not observe header arrival before completion, heartbeat bytes, the bg-process wait route, raw chunk boundaries, abort, or request-body overflow.

**Disposition:** `StreamingResponse` and async-byte ports are valid seams for BI logic, but all baseline BO framing/body-stream assertions stay real at their original level.

### 6. Server-Sent Events — **MB-GAP**

**Baseline unit owners:** `google-code-assist.test.ts` parses synthetic SSE chunks, including byte splits, error events, timeout, and abort; `google-code-assist-provider-extension.test.ts` checks generated endpoint/abort wiring. No baseline unit opens a real `EventSource`; the production server `text/event-stream` route has no real-client test.

**BI assertions:** decoded event-to-domain mapping and provider error classification.

**BO assertions:** UTF-8/SSE split framing, event delimiters, content type, header flush, first event, AbortSignal propagation, disconnect cleanup, and reconnect semantics.

**MB proof:** none.

**Disposition:** keep the SSE parser and abort/framing assertions. Do not replace them or claim real server SSE fidelity until a qualifying real client asserts content type, initial event, split delivery, disconnect cleanup, and reconnect.

### 7. AI Gateway discovery, pricing, proxying, titles, and model probes — **MB-GAP**

**Baseline unit owners:** local upstream listeners in `aigw-pricing.test.ts`, `aigw-startup-refresh.test.ts`, `openrouter-glm-thinking.test.ts`, `aigw-configure.test.ts`, `aigw-session-header.test.ts`, `aigw-title-generator.test.ts`, and `models-api.test.ts`; refused-port probes in `aigw-api.test.ts`.

**BI assertions:** model/pricing normalization; title fallback; request construction; error classification after a transport result.

**BO assertions:** real discovery/proxy HTTP path, method, headers (`User-Agent`, session identity), request body, streamed response, refusal/timeout, upstream listener and close behavior.

**MB proof:** none. The baseline Pi runtime test only asserts Bobbit’s own `/api/models` and intercepts key-test calls; it never connects to an AIGW upstream.

**Disposition:** inject `fetchImpl`/`AigwProxyTransport` for BI cases, but preserve local listener/refusal/proxy-stream owners. Full mocking requires a qualifying external-free local AIGW journey with request, response, stream, and teardown assertions.

### 8. OAuth callback listener and provider HTTP — **MB-GAP**

**Baseline unit owners:** `oauth-google.test.ts` starts the production Google callback listener on `127.0.0.1:0`; direct callback/state tests and unit-gateway OAuth status/logout tests cover adjacent behavior.

**BI assertions:** state/code/error decisions; token storage; refresh/revoke policy; provider-result mapping.

**BO assertions:** callback listener bind and redirect URI; query delivery over HTTP; provider token/userinfo/revoke request contract; auth headers; redirect response; listener close and late-connection refusal.

**MB proof:** none.

**Disposition:** retain the real callback listener and close semantics. Extract an `OAuthCallbackListenerFactory` and callback handler for BI permutations only; do not fully mock until a browser journey completes callback, provider-stub exchange, and listener shutdown.

### 9. Image-provider HTTP and remote image streaming — **MB-GAP**

**Baseline unit owners:** `image-generation-registry.test.ts`, `image-from-url-cap.test.ts`, `controlled-model-fallback.test.ts`, `output-path-containment.test.ts`, and unit-scope `image-generation-providers.test.ts` with intercepted public fetches.

**BI assertions:** provider payload mapping; model selection/fallback; output-path validation; domain error mapping.

**BO assertions:** HTTP request contract; redirect following; `Content-Length` versus streamed-byte limits; body cancellation/abort; close and partial-stream failure.

**MB proof:** none.

**Disposition:** keep provider contract and byte-cap/abort assertions. A separate local provider E2E must prove selected model request, redirects, streaming, cap, error, and close before real owners can be removed.

### 10. Google Code Assist gateway calls and provider SSE — **MB-GAP**

**Baseline unit owners:** `google-code-assist.test.ts`, `google-code-assist-provider-extension.test.ts`, `google-code-assist-registry.test.ts`, and unit-gateway `google-code-assist-token-api.test.ts`.

**BI assertions:** token/project resolution; request and result mapping; registry behavior.

**BO assertions:** generated gateway-token HTTP auth/request; provider HTTP headers/path/body; SSE byte/event framing; timeout/AbortSignal; response close.

**MB proof:** none. The baseline provider-settings journey does not spawn the generated extension and its provider-key POSTs are fulfilled by Playwright routes.

**Disposition:** keep provider SSE and generated runtime-client assertions. Inject `GatewayTokenClient`/`CodeAssistTransport` for BI tests without deleting the BO protocol canaries.

### 11. Hindsight external HTTP — **MB-GAP**

**Baseline unit owners:** `hindsight-client.test.ts` owns real local slow/refused connections; `hindsight-provider.test.ts` uses a fake client; `hindsight-external.test.ts` uses a local stub but remains unit-scope.

**BI assertions:** health/recall/retain request construction; response mapping; provider lifecycle policy.

**BO assertions:** actual HTTP status/body; timeout and refusal classification; abort; local server/client shutdown.

**MB proof:** none. The only adjacent browser assertion says Hindsight is absent.

**Disposition:** retain the slow/refusal and local-stub canaries; add injected fetch/clock for BI cases. A qualifying full-gateway local-stub journey is required before removal.

### 12. MCP streamable-HTTP gateway/catalogue — **MB-GAP**

**Baseline unit owners:** `marketplace-mcp-gateway.test.ts` opens a real streamable-HTTP MCP server; catalogue branches inject fetch. Related materialization/registry/config tests are boundary-independent.

**BI assertions:** catalogue parsing; tool materialization; registry/config policy; JSON-RPC result mapping after transport.

**BO assertions:** initialize request/response; `notifications/initialized`; `tools/list`; `Mcp-Session-Id` response-to-request propagation; JSON-RPC error framing; HTTP session close/error cleanup.

**MB proof:** none.

**Disposition:** keep the local protocol server. An `McpTransport` can isolate BI tests, but a qualifying external MCP service must prove initialize, session header, list, error, and close before the real owner is removed.

### 13. GitHub/PR review HTTP — **MB-GAP**

**Baseline unit owners:** `pr-walkthrough-export-mapper.test.ts` starts a local GitHub review server and also injects fetch/command behavior; related walkthrough metadata tests stub gateway fetch.

**BI assertions:** review mapping; trust/fallback decisions; request payload construction; CLI fallback selection.

**BO assertions:** authorization header carriage; actual review JSON bytes; HTTP method/path/status/error; timeout/retry and response/listener close.

**MB proof:** none. Baseline PR walkthrough browser tests prove pack/launcher/recovery UI; the trust test stubs the route; the fixed-list GitHub-link test reads seeded state. None submits review HTTP.

**Disposition:** retain the recording local GitHub server. Existing `options.fetch`/`CommandRunner` seams may host BI tests, but a local-upstream E2E must record auth/body and error/close before full mocking.

### 14. Generated tool/extension clients calling Bobbit HTTP — **MB-PARTIAL**

**Baseline unit owners:** Bobbit tool client tests plus generated skill, preview, proposal, provider-bridge, read-session, team-dismiss, tool-guard, and PR-walkthrough client tests.

**BI assertions:** operation validation; URL/method/body/header construction as data; response-to-tool-result mapping; local policy before dispatch.

**BO assertions:** generated code actually performing HTTP; bearer/session credentials on the wire; network error/status/body handling; abort/close.

**MB proof:** `E12` proves the PR walkthrough browser launcher sends one real route POST and, in the inactive-row case, carries the correct session header/body. `E15` proves only the server dismiss routes. Direct API preview/tool-grant journeys do not execute their generated clients.

**Disposition:** only the exact PR launcher mapping has equivalent baseline proof. All other generated-client BO assertions remain, including Bobbit catalogue, slash-skill, preview extension, provider bridge, read-session, proposal, dismiss-client, and tool-guard transport.

### 15. Direct handler/request/response units — **MB-PARTIAL**

**Baseline unit owners:** direct nested-goal, PR walkthrough, preview, bg-wait, and body-limit handler tests using fake Node request/response objects.

**BI assertions:** route/domain validation, concurrency decisions, bounded result selection, preview content choice, and error payload mapping.

**BO assertions:** even without a socket, tests that intentionally model Node request `data/end/error/abort`, streaming `writeHead/write/end`, cookie/header auth parsing, or “headers already sent” state own a transport contract and must stay equivalent.

**MB proof:** `E13` covers linked parent creation, `E14` covers the preview happy path, and `E12` covers selected PR extension routes. No baseline proof covers request-body overflow, non-local preview-cookie rejection, bg-wait heartbeat, several nested-goal error/concurrency branches, or bounded PR bundle windows.

**Disposition:** typed request/response ports are the target architecture for BI logic. Preserve every BO stream/header/auth state assertion; do not use adjacent route proof to delete it.

### 16. Fetch/command network fence — **MB-GAP**

**Baseline unit owners:** `fetch-fence.test.ts`, `command-runner-fence.test.ts`, `gateway-deps-default-real.test.ts`, and `cli-real-deps.test.ts`.

**BI assertions:** URL/command classification and dependency selection.

**BO assertions:** non-loopback rejection before DNS/connect; allowed request reaching a real loopback listener; production default using the real dependency.

**MB proof:** no product E2E is appropriate, and no baseline E2E is credited. This safety boundary is therefore conservatively MB-GAP rather than using unrelated loopback journeys as equivalence.

**Disposition:** keep the positive real loopback canary and block-before-DNS assertion permanently. Injected dependencies may test BI policy, but global-fetch bypasses remain audit gaps.

### 17. HTTPS/TLS — **MB-GAP**

**Baseline unit owners:** none opens an HTTPS server, performs a TLS handshake, or opens WSS. HTTPS URLs in unit tests are synthetic/intercepted.

**BI assertions:** certificate/config selection policy if extracted in the future.

**BO assertions:** certificate loading; HTTPS bind/handshake; trust rejection; SNI/secure headers; WSS upgrade; TLS shutdown.

**MB proof:** none.

**Disposition:** do not claim TLS fidelity. Add a test-CA gateway journey asserting HTTPS health, WSS, bad-certificate rejection, and shutdown before any future real TLS owner is mocked.

## Conversion decision at the merge base

1. **No blanket listener/socket conversion is authorized.** Every seam is MB-PARTIAL or MB-GAP.
2. **BI-only extraction is allowed without erasing BO canaries.** Route/domain permutations may move behind typed handler/transport ports only when the original real framing/auth/listener/close assertions remain.
3. **Exact baseline proof is route- and assertion-specific.** `E4` can back team-route auth behavior; it does not cover unrelated endpoint auth. `E8` can back terminal happy-path channel behavior; it does not cover invalid tokens or close cleanup.
4. **Post-MB E2E additions cannot unlock migration.** They can become future regression coverage, but this audit’s conversion authorization remains frozen to `MB`.
5. **Highest-value missing baseline-equivalent proofs:** OAuth callback lifecycle; SSE connect/deliver/disconnect; AIGW discovery/proxy stream; MCP session-header/close; bg-wait header/heartbeat and request overflow; WS payload/backpressure/auth rejection; generated-client full chain; TLS health/WSS/shutdown.

## Appendix A: baseline shared-gateway HTTP owners

These `164` paths existed under `tests2/integration/` at `MB`. Each imports the fork-scoped in-process harness and crosses a real loopback HTTP listener. They are unit-scope, not E2E.

```text
abort-status-e2e.test.ts
activate-skill-rest.test.ts
agent-dir-settings.test.ts
agent-tools-e2e.test.ts
aigw-api.test.ts
aigw-configure.test.ts
aigw-session-header.test.ts
aigw-title-generator.test.ts
api-goal-workflow-edit.test.ts
api-goals-child-autostart-ready.test.ts
api-goals-child-create-authz.test.ts
api-goals-paused-parent-child.test.ts
api-goals-prompt-paused.test.ts
api-subgoals-disabled.test.ts
archived-delegates-api.test.ts
archived-footer-model.test.ts
archived-query-search-api.test.ts
archived-session-merge.test.ts
ask-user-choices.test.ts
auto-start-team.test.ts
base-ref-api.test.ts
bg-process-sandbox-guard.test.ts
bg-wait-steer-abort.test.ts
cancel-verification.test.ts
compact-cost-ws.test.ts
config-cascade-api.test.ts
context-bar-reconnect.test.ts
cost-update-cache-hit.test.ts
cross-project-proposals.test.ts
default-project-loss-repro.test.ts
delegate-prompt-sections.test.ts
dev-boot-timing-api.test.ts
draft-api.test.ts
extension-host-surface-token.test.ts
fable-model-state-frame.test.ts
file-mentions-api.test.ts
gate-bypass-api.test.ts
gate-diagnostics-cleanup.test.ts
gate-inspect-slicing.test.ts
gate-reset-api.test.ts
gate-resign-cancel.test.ts
gate-signal-progress.test.ts
gate-signal-reminder.test.ts
gate-status-cache-ws.test.ts
gate-status-summary.test.ts
gates-api-heavy.test.ts
gates-api.test.ts
gateway-fixture-leak.test.ts
git-handoff-multi-repo.test.ts
git-status-caching.test.ts
git-status-local-only-policy.test.ts
goal-creation-flow.test.ts
goal-fanout-ws.test.ts
goal-pr-url.test.ts
goal-routing-story-api.test.ts
goal-workflow-api.test.ts
google-code-assist-token-api.test.ts
harness-restart-api.test.ts
hindsight-external.test.ts
host-agents-sandbox-inheritance.test.ts
human-signoff.test.ts
image-generation-providers.test.ts
image-model-restore.test.ts
inbox-api.test.ts
inline-workflow-goal-flow.test.ts
localhost-auth.test.ts
maintenance-api.test.ts
market-pack-roles-api.test.ts
market-pack-team-roles.test.ts
marketplace-provider-activation.test.ts
mcp-meta-call.test.ts
models-api.test.ts
multi-repo-goal.test.ts
multi-repo-project.test.ts
notifications.test.ts
oauth-flow-status.test.ts
oauth-google-logout.test.ts
optional-steps-api.test.ts
parent-scoped-archive-child.test.ts
pr-cache.test.ts
pr-walkthrough-api.test.ts
preview-broadcast.test.ts
preview-mount-route.test.ts
preview-snapshot.test.ts
preview-token-cost.test.ts
project-assistant-api.test.ts
project-bugs.test.ts
project-config-api.test.ts
project-config-component-config.test.ts
project-config-native-yaml.test.ts
project-detect-browse.test.ts
project-reorder-api.test.ts
project-ui-api.test.ts
projects-no-default-workflows.test.ts
projects-preflight.test.ts
prompt-sections-persist.test.ts
proposal-edit-api.test.ts
proposal-goal-workflow-validation.test.ts
queue-e2e.test.ts
quiet-pr-status-api.test.ts
review-annotations-api.test.ts
role-assistant-session.test.ts
role-manager-api.test.ts
roles-api.test.ts
sandbox-archive.test.ts
sandbox-branch-reconcile.test.ts
sandbox-delegate.test.ts
sandbox-pentest.test.ts
sandbox-persistence.test.ts
sandbox-restore.test.ts
sandbox-security.test.ts
sandbox-token.test.ts
sandbox.test.ts
search-admin-api.test.ts
search-orphan-filter.test.ts
search-preview-api.test.ts
session-create-regressions-todo.test.ts
session-created-sync.test.ts
session-restart-api.test.ts
sessions-projectless.test.ts
set-image-model-ws.test.ts
setup-status.test.ts
side-panel-workspace-api.test.ts
sidebar-api.test.ts
sidebar-child-loading.test.ts
skill-expansion.test.ts
skill-prompt-bytes.test.ts
skill-surface-consistency.test.ts
slash-skill-e2e.test.ts
staff-accessory-persistence.test.ts
staff-goal-triggers.test.ts
staff-patch-reassign.test.ts
staff-role.test.ts
staff.test.ts
steer-midturn.test.ts
steer-multitab.test.ts
steer-reconnect.test.ts
steer-snapshot-continuity.test.ts
stories-sessions-api.test.ts
stuck-session-recovery.test.ts
subgoal-parent-policy-repro.test.ts
support-session-role-wiring.test.ts
system-prompt-customise.test.ts
task-git-fields.test.ts
team-abort.test.ts
team-complete-unresolved-children.test.ts
team-steer-prompt.test.ts
thinking-level.test.ts
tool-guard-ask-policy.test.ts
tool-policy.test.ts
tools-api.test.ts
tools-cascade.test.ts
tools-e2e.test.ts
transcript-api.test.ts
transcript-before-compaction.test.ts
user-message-echo.test.ts
user-message-event-order.test.ts
verification-core.test.ts
verification-restart-resignal.test.ts
verification-result.test.ts
wizard-greeting.test.ts
workflows-api.test.ts
workflows-project-scope.test.ts
ws-frame-limit-regression.test.ts
```

The five unit-scope integration files that do **not** boot or call a gateway are `cost-tracker-real-fs.test.ts`, `direct-agent-admin-token.test.ts`, `gate-verification.test.ts`, `session-store-real-fs.test.ts`, and `verification-review-timeout-payload.test.ts` (the last only sanitizes a would-be WS payload).

## Appendix B: baseline real-WebSocket unit owners

All `44` paths below existed under `tests2/integration/` at `MB`; none is E2E for this audit.

```text
abort-status-e2e.test.ts
agent-tools-e2e.test.ts
archived-footer-model.test.ts
ask-user-choices.test.ts
compact-cost-ws.test.ts
context-bar-reconnect.test.ts
cost-update-cache-hit.test.ts
fable-model-state-frame.test.ts
gate-bypass-api.test.ts
gate-reset-api.test.ts
gate-resign-cancel.test.ts
gate-status-cache-ws.test.ts
gates-api-heavy.test.ts
goal-fanout-ws.test.ts
hindsight-external.test.ts
host-agents-sandbox-inheritance.test.ts
image-generation-providers.test.ts
image-model-restore.test.ts
notifications.test.ts
pr-cache.test.ts
preview-broadcast.test.ts
preview-snapshot.test.ts
prompt-sections-persist.test.ts
queue-e2e.test.ts
sandbox-archive.test.ts
session-created-sync.test.ts
set-image-model-ws.test.ts
side-panel-workspace-api.test.ts
skill-expansion.test.ts
slash-skill-e2e.test.ts
staff.test.ts
steer-midturn.test.ts
steer-multitab.test.ts
steer-reconnect.test.ts
steer-snapshot-continuity.test.ts
stuck-session-recovery.test.ts
team-steer-prompt.test.ts
thinking-level.test.ts
tools-e2e.test.ts
user-message-echo.test.ts
user-message-event-order.test.ts
verification-core.test.ts
wizard-greeting.test.ts
ws-frame-limit-regression.test.ts
```
