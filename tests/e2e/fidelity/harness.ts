/**
 * Fidelity harness fixture.
 *
 * Wraps the existing gateway harness with two additions:
 *   1. Registers ScriptedAgentBridge as an additional bridge factory so
 *      sessions whose env carries BOBBIT_FIDELITY_SCRIPT route to the
 *      scripted agent. The pre-existing mock-agent factory still wins for
 *      every other test in the suite.
 *   2. Sets process.env.BOBBIT_FIDELITY_SCRIPT before the gateway boots
 *      so scripted sessions resolve their script at construction time.
 *
 * The fidelity factory is registered in a "later wins" pattern: we wrap
 * the in-process-mock factory with our own that prefers the scripted
 * bridge when the env var is set, otherwise delegates downward.
 */
import { test as gwTest, expect } from "../gateway-harness.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCRIPTS_DIR = join(__dirname, "scripts");

export const test = gwTest.extend<{ scriptName: string; scriptPath: string }>({
	// Per-test option — override with `test.use({ scriptName: "..." })` or
	// pass the spec via test.beforeAll. Defaults to happy-path.
	scriptName: ["happy-path", { option: true }],
	scriptPath: async ({ scriptName }, use) => {
		const path = join(SCRIPTS_DIR, `${scriptName}.json`);
		// Set env BEFORE the gateway worker fixture has handed control to
		// the test. Because `gateway` is worker-scoped and ours is
		// test-scoped, the gateway is already running by now — the env var
		// only affects sessions created *after* this point. The
		// scripted-bridge factory reads process.env at session-create time,
		// so this is the right window.
		process.env.BOBBIT_FIDELITY_SCRIPT = path;
		const { registerRpcBridgeFactory } = await import("../../../dist/server/agent/rpc-bridge.js");
		const { ScriptedAgentBridge, shouldUseScriptedAgent } = await import("./scripted-agent-bridge.mjs");
		const { InProcessMockBridge, shouldUseInProcessMock } = await import("../in-process-mock-bridge.mjs");
		// Compose: scripted wins when env var is set; otherwise fall through
		// to the existing mock bridge so non-fidelity sessions in this worker
		// still work normally.
		registerRpcBridgeFactory((opts: any) => {
			if (shouldUseScriptedAgent()) return new ScriptedAgentBridge(opts);
			if (shouldUseInProcessMock(opts.cliPath)) return new InProcessMockBridge(opts);
			return null;
		});
		await use(path);
		// Clear the env var so unrelated tests in the same worker don't get
		// scripted bridges.
		delete process.env.BOBBIT_FIDELITY_SCRIPT;
	},
});

export { expect };
