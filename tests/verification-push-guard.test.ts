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

function assertSafe(command: string, vars: VerificationPushSafetyVars = GOAL_VARS): void {
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

	it("rejects protected destination refspecs through non-origin remotes", () => {
		const reason = assertUnsafe("git push upstream goal/foo:refs/heads/master");
		assert.match(reason, /targets `refs\/heads\/master`/);
	});

	it("rejects bare non-primary branch pushes through non-origin remotes", () => {
		const reason = assertUnsafe("git push fork goal/foo");
		assert.match(reason, /inherited upstream|no destination ref/i);
	});

	it("rejects unsafe pushes invoked through absolute git executable paths", () => {
		assertUnsafe("/usr/bin/git push origin goal/foo");
		assertUnsafe('"C:/Program Files/Git/cmd/git.exe" push origin goal/foo');
		assertUnsafe('"C:\\Program Files\\Git\\cmd\\git.exe" push origin goal/foo');
	});

	it("rejects unsafe pushes invoked through env wrappers", () => {
		assertUnsafe("env GIT_CONFIG_GLOBAL=/dev/null git push origin goal/foo");
		assertUnsafe("/usr/bin/env /usr/bin/git push upstream goal/foo:refs/heads/master");
	});

	it("allows explicit refspecs targeting the same goal branch", () => {
		assertSafe("git push origin goal/foo:refs/heads/goal/foo && git ls-remote --heads origin goal/foo | grep -q .");
		assertSafe("git push upstream goal/foo:refs/heads/goal/foo");
	});

	it("allows the primary branch to push to the primary branch", () => {
		assertSafe("git push origin master:refs/heads/master", {
			branch: "master",
			baseBranch: "master",
			master: "master",
		});
		assertSafe("git push upstream master:refs/heads/master", {
			branch: "master",
			baseBranch: "master",
			master: "master",
		});
	});
});
