# MCP E2E blocker

## Decision

`tests2/browser/journeys/pi-runtime-upgrade.journey.spec.ts` cannot naturally or credibly own the requested proof as a journey-only change. The journey was not changed.

The journey's production gateway is deliberately configured with `tests/e2e/mock-agent.mjs`, and `tests/e2e/gateway-harness.ts` registers `InProcessMockBridge` for that path. Session turns therefore do not start Pi, do not load the generated MCP extension passed through Pi's `--extension` boundary, and cannot invoke its `mcp_<server>` meta-tool. The harness also sets `BOBBIT_TEST_NO_EXTERNAL=1`, supplies no usable provider credential, and seeds only fake OAuth state so the browser skips setup UI.

Enabling `test.use({ enableMcp: true })` would prove only the gateway-to-MCP side. It can start a local MCP subprocess, run `initialize` and `tools/list`, and expose/call operations through gateway REST. Calling `/api/internal/mcp-call` from the journey would be adjacent endpoint coverage, not the required chain through a real Pi-loaded meta-tool.

## Boundary evidence

| Required boundary | Available in this journey | Result |
|---|---|---|
| Production MCP client starts a real local subprocess and sends `initialize` | Possible with `enableMcp` plus test-authored config | Insufficient alone |
| MCP session identity is established and retained | Not exposed by the current stdio fixture; streamable-HTTP identity is covered only below E2E | Missing |
| Production MCP client sends `tools/list` | Possible through gateway setup | Insufficient alone |
| A real Pi process loads the generated `mcp_<server>` extension | No; the in-process mock bridge replaces Pi | Blocked |
| Pi invokes the generated meta-tool, which calls the gateway and reaches MCP `tools/call` | No; a model-driven Pi turn needs a usable provider or a credential-free production-shaped local provider seam | Blocked |
| Gateway ownership tears down the MCP child and the test observes process exit | Worker teardown occurs outside the journey assertion; no journey-only Pi/MCP lifecycle observer exists | Blocked |

## Existing adjacent coverage

- `tests/e2e/mcp-integration.spec.ts` opts into MCP, starts `tests/fixtures/mock-mcp-server.mjs`, and asserts discovery, gateway REST `tools/call`, and tool-list metadata. It never crosses Pi extension loading or invocation.
- `tests2/integration/mcp-meta-call.test.ts` seeds fake MCP clients and calls gateway APIs. It explicitly skips real MCP subprocesses.
- `tests2/core/marketplace-mcp-gateway.test.ts` uses a real loopback Streamable HTTP server and asserts `initialize`, `Mcp-Session-Id` carry, and `tools/list`, but it is unit-scope and does not involve Pi or `tools/call` through the generated meta-tool.
- `tests/manual-integration/agent-tool-use.spec.ts` starts a real credential-backed agent and asserts `mcp_describe` was selected. It permits an `ERROR` result and does not assert a generated `mcp_<server>` tool call or MCP child teardown.

None of these may be combined as proof of the missing production chain.

## Required owner

Add a dedicated real-agent/manual or real-fidelity MCP spec with an isolated gateway configured to use the actual Pi CLI and a deterministic local MCP service. It must:

1. record `initialize`, session identity, `tools/list`, and `tools/call` at the local MCP service;
2. create a production session whose Pi process loads the generated MCP meta-tool extension;
3. drive Pi to invoke a specific operation and assert the returned sentinel in the transcript;
4. terminate the session or gateway and assert the owned MCP process/socket exits;
5. use either configured manual provider credentials or a production-shaped local model provider that deterministically emits the tool call.

The current browser journey fixture would need an agent-CLI/provider option and observable MCP lifecycle support to make this credential-free. Those fixture/production changes are outside the allowed journey-only edit.
