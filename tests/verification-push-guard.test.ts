import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateVerificationPushSafety, type VerificationPushSafetyVars } from "../src/server/agent/verification-harness.ts";

const GOAL_VARS: VerificationPushSafetyVars = {
	branch: "goal/foo",
	baseBranch: "master",
	master: "master",
};

function assertUnsafe(command: string, vars: VerificationPushSafetyVars = GOAL_VARS): string {
	const result = validateVerificationPushSafety(command, vars);
	assert.equal(result.ok, false, `${command} should be rejected`);
	assert.match(result.reason, /Refusing unsafe git push/);
	return result.reason;
}

function assertSafe(command: string, vars: VerificationPushSafetyVars): void {
	const result = validateVerificationPushSafety(command, vars);
	assert.equal(result.ok, true, `${command} should be allowed`);
}

describe("verification push guard", () => {
	it("rejects unsafe bare branch push under push.default=upstream", () => {
		const reason = assertUnsafe("git -c push.default=upstream push origin goal/foo && git ls-remote --heads origin goal/foo | grep -q .");
		assert.match(reason, /push\.default=upstream|inherited upstream/i);
	});

	it("rejects explicit refspecs targeting the base branch from a goal branch", () => {
		const reason = assertUnsafe("git push origin goal/foo:refs/heads/master");
		assert.match(reason, /targets `refs\/heads\/master`/);
	});

	it("allows explicit refspecs targeting the same goal branch", () => {
		assertSafe("git push origin goal/foo:refs/heads/goal/foo && git ls-remote --heads origin goal/foo | grep -q .", GOAL_VARS);
	});

	it("allows the primary branch to push to the primary branch", () => {
		assertSafe("git push origin master:refs/heads/master", {
			branch: "master",
			baseBranch: "master",
			master: "master",
		});
	});
});
