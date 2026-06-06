/**
 * S1 — server-side team-lead authorization for the MUTATING Children REST
 * endpoints. Pure-function unit tests for `authorizeChildrenMutation`.
 *
 * See `src/server/auth/children-mutation-authz.ts` for the threat model.
 * Mutations are split into two CLASSES (blast-radius reduction):
 *
 *   ORCHESTRATION (spawn-child, plan PATCH, integrate-child, policy) — the
 *   cookie does NOT bypass (it is mintable by any holder of the shared admin
 *   Bearer token). Team-lead-only:
 *     - absent caller header                  → DENY (no-caller-header)
 *     - caller header, no team-lead known     → DENY (no-team-lead)
 *     - caller header == team-lead            → ALLOW (team-lead-match)
 *     - caller header != team-lead            → DENY (team-lead-mismatch)
 *     - even a verified human cookie          → still resolved via team-lead match
 *
 *   OPERATOR (pause, resume, mutation decision, archive-child) — the human/UI
 *   verbs. A verified bobbit_session cookie is accepted; otherwise team-lead
 *   match (identical to orchestration).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authorizeChildrenMutation, type ChildrenMutationClass } from "../src/server/auth/children-mutation-authz.ts";

describe("authorizeChildrenMutation (S1) — OPERATOR class", () => {
	const mutationClass: ChildrenMutationClass = "operator";

	it("allows a verified human cookie regardless of header / team-lead", () => {
		for (const caller of [undefined, "", "agent-x", "tl-1"]) {
			for (const lead of [undefined, null, "tl-1", "tl-other"]) {
				const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: true, callerSessionId: caller, teamLeadSessionId: lead });
				assert.equal(r.ok, true, `caller=${JSON.stringify(caller)} lead=${JSON.stringify(lead)}`);
				assert.equal(r.ok && r.reason, "human-cookie");
			}
		}
	});

	it("DENIES an absent caller header without a human cookie (closes the bypass)", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: undefined, teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "no-caller-header");
	});

	it("DENIES an empty/whitespace caller header without a human cookie (treated as absent)", () => {
		for (const caller of ["", "   "]) {
			const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: caller, teamLeadSessionId: "tl-1" });
			assert.equal(r.ok, false, `caller=${JSON.stringify(caller)}`);
			assert.equal(!r.ok && r.reason, "no-caller-header");
		}
	});

	it("DENIES a non-human caller when the goal has no established team-lead (teamless goals are human-only)", () => {
		for (const lead of [undefined, null, ""]) {
			const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "agent-x", teamLeadSessionId: lead });
			assert.equal(r.ok, false, `lead=${JSON.stringify(lead)}`);
			assert.equal(!r.ok && r.reason, "no-team-lead");
		}
	});

	it("allows a verified human cookie on a teamless goal (the only authorized mutator)", () => {
		for (const lead of [undefined, null, ""]) {
			const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: true, callerSessionId: undefined, teamLeadSessionId: lead });
			assert.equal(r.ok, true, `lead=${JSON.stringify(lead)}`);
			assert.equal(r.ok && r.reason, "human-cookie");
		}
	});

	it("allows when the caller header matches the team-lead session", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "tl-1", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "team-lead-match");
	});

	it("matches after trimming surrounding whitespace", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "  tl-1  ", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "team-lead-match");
	});

	it("DENIES when the caller header does NOT match the team-lead session", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "agent-x", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "team-lead-mismatch");
	});

	it("never trusts the header as a bare claim — a non-empty caller with a non-matching lead is denied", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "team-lead", teamLeadSessionId: "tl-real" });
		assert.equal(r.ok, false);
	});
});

describe("authorizeChildrenMutation (S1) — ORCHESTRATION class (cookie does NOT bypass)", () => {
	const mutationClass: ChildrenMutationClass = "orchestration";

	it("IGNORES a verified human cookie — a cookie-only caller with no header is denied", () => {
		// The cookie is mintable by any holder of the shared admin token, so it
		// must NOT bypass an orchestration (team-lead-only) mutation.
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: true, callerSessionId: undefined, teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "no-caller-header");
	});

	it("IGNORES the cookie even on a teamless goal — denied (no-caller-header)", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: true, callerSessionId: undefined, teamLeadSessionId: undefined });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "no-caller-header");
	});

	it("a verified human cookie does NOT override a header/team-lead MISMATCH", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: true, callerSessionId: "agent-x", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "team-lead-mismatch");
	});

	it("DENIES an absent caller header (no cookie)", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: undefined, teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "no-caller-header");
	});

	it("DENIES a caller header on a teamless goal (no-team-lead)", () => {
		for (const lead of [undefined, null, ""]) {
			const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "agent-x", teamLeadSessionId: lead });
			assert.equal(r.ok, false, `lead=${JSON.stringify(lead)}`);
			assert.equal(!r.ok && r.reason, "no-team-lead");
		}
	});

	it("ALLOWS the team-lead (matching X-Bobbit-Spawning-Session), cookie irrelevant", () => {
		for (const cookie of [true, false]) {
			const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: cookie, callerSessionId: "tl-1", teamLeadSessionId: "tl-1" });
			assert.equal(r.ok, true, `cookie=${cookie}`);
			assert.equal(r.ok && r.reason, "team-lead-match");
		}
	});

	it("matches after trimming surrounding whitespace", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "  tl-1  ", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "team-lead-match");
	});

	it("DENIES a non-team-lead caller (team-lead-mismatch)", () => {
		const r = authorizeChildrenMutation({ mutationClass, isHumanOperator: false, callerSessionId: "agent-x", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "team-lead-mismatch");
	});
});
