/**
 * S1 — server-side team-lead authorization for the MUTATING Children REST
 * endpoints. Pure-function unit tests for `authorizeChildrenMutation`.
 *
 * See `src/server/auth/children-mutation-authz.ts` for the threat model:
 *   - absent caller header              → ALLOW (trusted human/UI gateway call)
 *   - caller header, no team-lead known → ALLOW (nothing to match against)
 *   - caller header == team-lead         → ALLOW
 *   - caller header != team-lead         → DENY  (403 NOT_TEAM_LEAD)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authorizeChildrenMutation } from "../src/server/auth/children-mutation-authz.ts";

describe("authorizeChildrenMutation (S1)", () => {
	it("allows when no caller header is present (trusted human/UI gateway call)", () => {
		const r = authorizeChildrenMutation({ callerSessionId: undefined, teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "no-caller-header");
	});

	it("allows an empty/whitespace caller header (treated as absent)", () => {
		assert.equal(authorizeChildrenMutation({ callerSessionId: "", teamLeadSessionId: "tl-1" }).ok, true);
		assert.equal(authorizeChildrenMutation({ callerSessionId: "   ", teamLeadSessionId: "tl-1" }).ok, true);
	});

	it("allows when the goal has no established team-lead (nothing to match against)", () => {
		for (const lead of [undefined, null, ""]) {
			const r = authorizeChildrenMutation({ callerSessionId: "agent-x", teamLeadSessionId: lead });
			assert.equal(r.ok, true, `lead=${JSON.stringify(lead)}`);
			assert.equal(r.ok && r.reason, "no-team-lead");
		}
	});

	it("allows when the caller header matches the team-lead session", () => {
		const r = authorizeChildrenMutation({ callerSessionId: "tl-1", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "team-lead-match");
	});

	it("matches after trimming surrounding whitespace", () => {
		const r = authorizeChildrenMutation({ callerSessionId: "  tl-1  ", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.reason, "team-lead-match");
	});

	it("DENIES when the caller header does NOT match the team-lead session", () => {
		const r = authorizeChildrenMutation({ callerSessionId: "agent-x", teamLeadSessionId: "tl-1" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "team-lead-mismatch");
	});

	it("never trusts the header as a bare claim — a non-empty caller with a non-matching lead is denied", () => {
		// Even a 'team-lead-looking' value must equal the authoritative id.
		const r = authorizeChildrenMutation({ callerSessionId: "team-lead", teamLeadSessionId: "tl-real" });
		assert.equal(r.ok, false);
	});
});
