import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	__resolveSessionGitStatusPublicationForTests,
	__resolveSessionGitStatusPublicationPolicyForTests,
	type GitStatusResult,
} from "../src/server/skills/git-gh.ts";

function gitStatus(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
	return {
		branch: "master",
		primaryBranch: "master",
		primaryRef: "origin/master",
		isOnPrimary: true,
		status: [],
		hasUpstream: true,
		ahead: 0,
		behind: 0,
		aheadOfPrimary: 0,
		behindPrimary: 0,
		mergedIntoPrimary: false,
		insertionsVsPrimary: 0,
		deletionsVsPrimary: 0,
		clean: true,
		summary: "clean",
		unpushed: false,
		...overrides,
	};
}

describe("session git-status publication policy", () => {
	it("treats legacy scoped team members without persisted policy as local-only", () => {
		const session = {
			teamGoalId: "656b8057-1111-4222-8333-aaaaaaaaaaaa",
			teamLeadSessionId: "lead-session-id",
			role: "coder",
			branch: "goal/656b8057/coder-c594",
		};

		const decision = __resolveSessionGitStatusPublicationForTests(
			session,
			gitStatus({ branch: "goal/656b8057/coder-c594", isOnPrimary: false, ahead: 1, hasUpstream: true, unpushed: true }),
		);

		assert.equal(decision.policy, "local-only-policy");
		assert.equal(decision.result.remotePublication, "local-only-policy");
		assert.equal(decision.autoPublish, false);
	});

	it("does not infer local-only from goal/session branch prefixes without structural metadata", () => {
		const regularGoalPrefix = __resolveSessionGitStatusPublicationPolicyForTests(
			{ role: "coder", branch: "goal/656b8057/coder-c594" },
			"goal/656b8057/coder-c594",
		);
		assert.equal(regularGoalPrefix, "legacy-auto-publish");
		assert.equal(
			__resolveSessionGitStatusPublicationPolicyForTests(
				{ teamGoalId: "656b8057-1111-4222-8333-aaaaaaaaaaaa", teamLeadSessionId: "lead-session-id", role: "coder", branch: "goal/local-sub-agen-656b8057" },
				"goal/local-sub-agen-656b8057",
			),
			"legacy-auto-publish",
		);
		const regularSessionPrefix = __resolveSessionGitStatusPublicationPolicyForTests(
			{ teamGoalId: "656b8057-1111-4222-8333-aaaaaaaaaaaa", teamLeadSessionId: "lead-session-id", role: "coder", branch: "session/656b8057" },
			"session/656b8057",
		);
		assert.equal(regularSessionPrefix, "legacy-auto-publish");

		const regularSessionDecision = __resolveSessionGitStatusPublicationForTests(
			{ branch: "session/regular" },
			gitStatus({ branch: "session/regular", isOnPrimary: false, hasUpstream: false }),
		);
		assert.equal(regularSessionDecision.result.remotePublication, undefined);
		assert.equal(regularSessionDecision.autoPublish, true);
	});

	it("honors explicit persisted policy before legacy fallback", () => {
		const structuralSession = {
			teamGoalId: "656b8057-1111-4222-8333-aaaaaaaaaaaa",
			teamLeadSessionId: "lead-session-id",
			role: "coder",
			branch: "goal/656b8057/coder-c594",
		} as const;

		assert.equal(
			__resolveSessionGitStatusPublicationPolicyForTests(
				{ ...structuralSession, worktreePushPolicy: "publish" },
				"goal/656b8057/coder-c594",
			),
			"legacy-auto-publish",
		);
		assert.equal(
			__resolveSessionGitStatusPublicationPolicyForTests(
				{ role: "assistant", branch: "session/regular", remotePublicationPolicy: "local-only" },
				"session/regular",
			),
			"local-only-policy",
		);
	});
});
