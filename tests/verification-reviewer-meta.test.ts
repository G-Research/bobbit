/**
 * Pure-function tests for `buildVerificationReviewerMeta` — pins the contract
 * for the session-meta payload that the verification harness writes when
 * spawning llm-review reviewers and agent-qa testers.
 *
 * The bug this protects against: image #50 + #51, where archived reviewer/QA
 * sessions persisted with `teamLeadSessionId === undefined` and the sidebar
 * couldn't nest them under their triggering team-lead. The fix is in two
 * call sites in `verification-harness.ts`; this test pins the helper they
 * both delegate to.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildVerificationReviewerMeta } from "../src/server/agent/verification-reviewer-meta.ts";

describe("buildVerificationReviewerMeta — teamLeadSessionId stamp", () => {
	it("stamps teamLeadSessionId when the team has one", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "synthesis-reviewer",
			goalId: "g1",
			teamLeadSessionId: "lead-1",
		});
		assert.equal(out.teamLeadSessionId, "lead-1");
	});

	it("OMITS the teamLeadSessionId KEY (not just sets it to undefined) when not provided", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "code-reviewer",
			goalId: "g1",
		});
		assert.equal("teamLeadSessionId" in out, false, "key must be absent so updateSessionMeta does not clear an existing link");
	});

	it("OMITS the key when teamLeadSessionId is explicitly undefined", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "code-reviewer",
			goalId: "g1",
			teamLeadSessionId: undefined,
		});
		assert.equal("teamLeadSessionId" in out, false);
	});

	it("OMITS the key when teamLeadSessionId is null (legacy team-store entries)", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "code-reviewer",
			goalId: "g1",
			teamLeadSessionId: null,
		});
		assert.equal("teamLeadSessionId" in out, false);
	});

	it("OMITS the key when teamLeadSessionId is an empty string (defensive)", () => {
		const out = buildVerificationReviewerMeta({
			kind: "agent-qa",
			roleName: "qa-tester",
			goalId: "g1",
			teamLeadSessionId: "",
		});
		assert.equal("teamLeadSessionId" in out, false);
	});
});

describe("buildVerificationReviewerMeta — accessory defaults", () => {
	it("llm-review defaults to magnifying-glass", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "code-reviewer",
			goalId: "g1",
		});
		assert.equal(out.accessory, "magnifying-glass");
	});

	it("agent-qa defaults to stamp", () => {
		const out = buildVerificationReviewerMeta({
			kind: "agent-qa",
			roleName: "qa-tester",
			goalId: "g1",
		});
		assert.equal(out.accessory, "stamp");
	});

	it("role-yaml accessory wins over the kind default", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "security-reviewer",
			goalId: "g1",
			roleAccessory: "shield",
		});
		assert.equal(out.accessory, "shield");
	});

	it("empty-string roleAccessory falls back to the kind default (defensive)", () => {
		const out = buildVerificationReviewerMeta({
			kind: "agent-qa",
			roleName: "qa-tester",
			goalId: "g1",
			roleAccessory: "",
		});
		assert.equal(out.accessory, "stamp");
	});
});

describe("buildVerificationReviewerMeta — invariants", () => {
	it("always sets nonInteractive=true (these sessions never accept user input)", () => {
		const llm = buildVerificationReviewerMeta({ kind: "llm-review", roleName: "r", goalId: "g" });
		const qa = buildVerificationReviewerMeta({ kind: "agent-qa", roleName: "r", goalId: "g" });
		assert.equal(llm.nonInteractive, true);
		assert.equal(qa.nonInteractive, true);
	});

	it("always sets role and teamGoalId verbatim", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "synthesis-reviewer",
			goalId: "deadbeef-1234",
			teamLeadSessionId: "lead",
		});
		assert.equal(out.role, "synthesis-reviewer");
		assert.equal(out.teamGoalId, "deadbeef-1234");
	});

	it("payload shape matches what SessionManager.updateSessionMeta accepts", () => {
		const out = buildVerificationReviewerMeta({
			kind: "llm-review",
			roleName: "r",
			goalId: "g",
			teamLeadSessionId: "lead",
		});
		// Sanity: only the documented keys are present
		const allowed = new Set(["role", "teamGoalId", "accessory", "nonInteractive", "teamLeadSessionId"]);
		for (const k of Object.keys(out)) {
			assert.ok(allowed.has(k), `unexpected key on payload: ${k}`);
		}
	});
});
