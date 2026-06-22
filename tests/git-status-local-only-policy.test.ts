import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionGitStatusAutoPublishDecision } from "../src/server/server.ts";

function status(overrides: Record<string, unknown> = {}) {
	return {
		branch: "session/example",
		isOnPrimary: false,
		ahead: 1,
		hasUpstream: true,
		...overrides,
	} as any;
}

describe("session git-status auto-publish policy", () => {
	it("suppresses status-triggered publication when metadata policy is local-only", () => {
		assert.equal(
			sessionGitStatusAutoPublishDecision(
				status({ branch: "goal/656b8057/coder-abcd", ahead: 3, hasUpstream: true }),
				"local-only-policy",
			),
			undefined,
		);
	});

	it("does not infer local-only from broad goal/ or session/ branch prefixes", () => {
		assert.deepEqual(
			sessionGitStatusAutoPublishDecision(status({ branch: "goal/integration-12345678", ahead: 2, hasUpstream: true })),
			{ branch: "goal/integration-12345678" },
		);
		assert.deepEqual(
			sessionGitStatusAutoPublishDecision(status({ branch: "session/helper-abcdef", ahead: 0, hasUpstream: false })),
			{ branch: "session/helper-abcdef", setUpstream: true },
		);
	});
});
