// v2-native — unit commands cannot create target evidence in the normal gate lifecycle.

import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import { test } from "./_e2e/in-process-harness.ts";
import { assertRejectedLifecycle, execOnly } from "./helpers/systems-review-command-evidence-fixture.ts";

test("normal lifecycle rejects target evidence from a unit command", async ({ gateway }) => {
	const commandRunner = execOnly(gateway.sessionManager.commandRunner as CommandRunner);
	await assertRejectedLifecycle(commandRunner, {
		label: "unit command",
		commandName: "unit",
		invoke: "success",
		expectEvidence: false,
	});
});
