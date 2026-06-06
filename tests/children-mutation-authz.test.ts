/**
 * S1 — server-side team-lead authorization for the MUTATING Children REST
 * endpoints. Pure-function unit tests for `authorizeChildrenMutation`.
 *
 * See `src/server/auth/children-mutation-authz.ts` for the threat model.
 * Agents and the UI share the gateway Bearer token, so the human-operator
 * signal is the server-verified `bobbit_session` cookie (`isHumanOperator`),
 * NOT the absence of the spawning-session header:
 *   - verified human cookie                       → ALLOW (human/UI gateway call)
 *   - no cookie, absent caller header             → DENY  (the closed bypass)
 *   - no cookie, caller header, no team-lead known → DENY  (teamless goal: only a human operator may mutate)
 *   - no cookie, caller header == team-lead        → ALLOW
 *   - no cookie, caller header != team-lead        → DENY  (403 NOT_TEAM_LEAD)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authorizeChildrenMutation } from "../src/server/auth/children-mutation-authz.ts";

describe("authorizeChildrenMutation (S1)", () => {
	it("allows a verified human cookie regardless of header / team-lead", () => {
		for (const caller of [undefined, "", "agent-x", "tl-1"]) {
			for (const lead of [undefined, null, "tl-1", "tl-other"]) {
				const r = authorizeChildrenMutation({ isHumanOperator: true, callerSessionId: caller, teamLeadSessionId: lead });
				assert.equal(r.ok, true, `caller=${JSON.stringify(caller)} lead=${JSON.stringify(lead)}`);
				assert.equal(r.ok && r.reason, "human-cookie");
			}
		}
	});

	it("DENIES an absent caller header without a human cookie (closes the bypass)", () => {
		const r = authorizeChildrenMutation({ isHumanOperator: false, callerSessionId: undefined, teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "no-caller-header");
	});

	it("DENIES an empty/whitespace caller header without a human cookie (treated as absent)", () => {
		for (const caller of ["", "   "]) {
			const r = authorizeChildrenMutation({ isHumanOperator: false, callerSessionId: caller, teamLeadSessionId: "tl-1" });
			assert.equal(r.ok, false, `caller=${JSON.stringify(caller)}`);
			assert.equal(!r.ok && r.reason, "no-caller-header");
		}
	});

	it("DENIES a non-human caller when the goal has no established team-lead (teamless goals are human-only)", () => {
		for (const lead of [undefined, null, ""]) {
			const r = authorizeChildrenMutation({ isHumanOperator: false, callerSessionId: "agent-x", teamLeadSessionId: lead });
			assert.equal(r.ok, false, `lead=${JSON.stringify(lead)}`);
			assert.equal(!r.ok && r.reason, "no-team-lead");
		}
	});

	it("allows a verified human cookie on a teamless goal (the only authorized mutator)", () => {
		for (const lead of [undefined, null, ""]) {
			const r = authorizeChildrenMutation({ isHumanOperator: true, callerSessionId: undefined, teamLeadSessionId: lead });
			assert.equal(r.ok, true, `lead=${JSON.stringify(lead)}`);
			assert.equal(r.ok && r.reason, "human-cookie");
		}
	});

	it("allows when the caller header matches the team-lead session", () => {
		const r = authorizeChildrenMutation({ isHumanOperator: false, callerSessionId: "tl-1", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "team-lead-match");
	});

	it("matches after trimming surrounding whitespace", () => {
		const r = authorizeChildrenMutation({ isHumanOperator: false, callerSessionId: "  tl-1  ", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "team-lead-match");
	});

	it("DENIES when the caller header does NOT match the team-lead session", () => {
		const r = authorizeChildrenMutation({ isHumanOperator: false, callerSessionId: "agent-x", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "team-lead-mismatch");
	});

	it("never trusts the header as a bare claim — a non-empty caller with a non-matching lead is denied", () => {
		// Even a 'team-lead-looking' value must equal the authoritative id.
		const r = authorizeChildrenMutation({ isHumanOperator: false, callerSessionId: "team-lead", teamLeadSessionId: "tl-real" });
		assert.equal(r.ok, false);
	});
});
