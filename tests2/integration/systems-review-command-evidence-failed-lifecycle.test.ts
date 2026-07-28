// v2-native — a failed registered command cannot persist captured target evidence.

import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import { test } from "./_e2e/in-process-harness.ts";
import { assertRejectedLifecycle, execOnly } from "./helpers/systems-review-command-evidence-fixture.ts";

test("normal lifecycle discards captures from a failed registered command", async ({ gateway }) => {
	const commandRunner = execOnly(gateway.sessionManager.commandRunner as CommandRunner);
	await assertRejectedLifecycle(commandRunner, {
		label: "failed command",
		commandName: "integration",
		invoke: "success",
		commandExitCode: 1,
		expectEvidence: false,
	});
});
