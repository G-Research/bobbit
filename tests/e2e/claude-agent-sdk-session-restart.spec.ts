/**
 * Gateway-restart acceptance coverage for the Claude Agent SDK runtime.
 *
 * This file is intentionally fixme until the production SDK bridge exposes its
 * planned dependency factory through GatewayDeps. The existing gateway harness
 * can restart a gateway against the same store, but it currently accepts only
 * an IRpcBridge replacement factory. Replacing the whole bridge would bypass
 * ClaudeAgentSdkBridge, its official SDK query input, and its translator, so it
 * would be a second protocol rather than this test's production-path fixture.
 *
 * Required additive production seam (no test-local protocol):
 *
 *   GatewayDeps.claudeAgentSdkBridgeDepsFactory?:
 *     (options: ClaudeAgentSdkBridgeOptions) => ClaudeAgentSdkBridgeDeps
 *
 * `createSessionBridge` must call it only for runtime "claude-agent-sdk" and
 * construct the production ClaudeAgentSdkBridge with the returned fake-query
 * deps. `gateway-harness.ts` must pass this GatewayDeps member to createGateway
 * on initial boot and restart. The fake then owns only the official `query`
 * dependency; Pi keeps the existing InProcessMockBridge factory.
 */
import { test } from "./gateway-harness.js";

test.describe("Claude Agent SDK session restart", () => {
	test.fixme(
		"persists runtime and opaque SDK id, resumes through the production bridge, and leaves Pi unchanged",
		async () => {
			// Enable when GatewayDeps exposes claudeAgentSdkBridgeDepsFactory. The
			// required scenario is deliberately captured in the test title and design:
			//
			// 1. Create an SDK session and a co-resident Pi session through REST.
			// 2. Send an SDK prompt, observe translated SDK output, then assert the
			//    persisted record holds runtime="claude-agent-sdk" + opaque SDK id.
			// 3. Restart the gateway fixture against the same state directory.
			// 4. Assert the fake Query received options.resume equal to that opaque id,
			//    reaches ready, and accepts a post-restart prompt.
			// 5. Record Pi sendCommand calls and prove no SDK restore issues
			//    switch_session, while the Pi session restores and prompts normally.
		},
	);
});
