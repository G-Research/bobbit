// v2-native — wrong production target/scope cannot create target evidence in the normal gate lifecycle.

import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import { test } from "./_e2e/in-process-harness.ts";
import { assertRejectedLifecycle, execOnly } from "./helpers/systems-review-command-evidence-fixture.ts";

test("normal lifecycle rejects final-adapter target and scope mismatches", async ({ gateway }) => {
	const commandRunner = execOnly(gateway.sessionManager.commandRunner as CommandRunner);
	await assertRejectedLifecycle(commandRunner, {
		label: "wrong target and scope",
		commandName: "integration",
		invoke: "mismatch",
		expectEvidence: false,
	});
});
