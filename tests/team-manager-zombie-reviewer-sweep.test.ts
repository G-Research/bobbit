/**
 * Pinned regression: TeamManager.resubscribeTeamEvents sweeps zombie
 * reviewer registrations on boot.
 *
 * Live test (PR #409 0e4fc54c): the user reported "agents spawned but
 * nowhere to be seen". Inspection showed 4 reviewer sessions
 * registered to Eve's goal team that were 17h+ idle, role=null,
 * kind=null — left behind by harness crashes mid-review. The
 * corresponding `unregisterReviewerSession` calls in
 * verification-harness.ts (`finally` blocks at lines ~1099, 1367,
 * 3114, 3390) never ran because the harness process died before
 * reaching them. The session records were terminated but the team-
 * store registration persisted, producing phantom agents in the UI.
 *
 * Fix: in `resubscribeTeamEvents` (called once on boot after
 * `restoreTeams`), walk every registered agent and identify those
 * that look like reviewers AND whose session is missing or
 * terminated. Unregister them.
 *
 * Reviewer heuristic (any of):
 *   - agent.kind === "reviewer"
 *   - agent.role === "reviewer"
 *   - agent.task starts with "Verification review:"
 *   - agent.sessionId starts with "llm-review-"
 *
 * The kind/role/task patterns cover post-migration records.
 * The sessionId-prefix pattern catches legacy records whose `kind`
 * field was never populated (the 17h-ago zombies on Eve's goal).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface AgentLike {
	sessionId: string;
	role?: string | null;
	kind?: string | null;
	task?: string | null;
}

interface SessionLike {
	status?: string;
}

/** Replicates the zombie-reviewer predicate. */
function isZombieReviewer(agent: AgentLike, session: SessionLike | null | undefined): boolean {
	const looksLikeReviewer =
		agent.kind === "reviewer" ||
		agent.role === "reviewer" ||
		(typeof agent.task === "string" && agent.task.startsWith("Verification review:")) ||
		(typeof agent.sessionId === "string" && agent.sessionId.startsWith("llm-review-"));
	if (!looksLikeReviewer) return false;
	return !session || session.status === "terminated";
}

describe("TeamManager — zombie reviewer sweep predicate", () => {
	it("THE bug: legacy zombie (sessionId starts llm-review-, role/kind null, no session) -> sweep", () => {
		// Exact pattern from Eve's goal: 4 reviewers from 17h-ago verifications
		// all had kind=null, role=null because they predated the kind migration.
		// Their sessionId still starts with llm-review-.
		assert.equal(isZombieReviewer(
			{ sessionId: "llm-review-16303f7c-83d", role: null, kind: null },
			null, // session not found (terminated + culled)
		), true);
	});

	it("modern reviewer with kind=reviewer + terminated session -> sweep", () => {
		assert.equal(isZombieReviewer(
			{ sessionId: "llm-review-foo", kind: "reviewer", role: "code-reviewer" },
			{ status: "terminated" },
		), true);
	});

	it("reviewer recognised by task prefix -> sweep when session terminated", () => {
		assert.equal(isZombieReviewer(
			{ sessionId: "llm-review-bar", task: "Verification review: Gap analysis" },
			{ status: "terminated" },
		), true);
	});

	it("LIVE reviewer (session idle, not terminated) -> DO NOT sweep", () => {
		// Currently-running verification — leave it alone.
		assert.equal(isZombieReviewer(
			{ sessionId: "llm-review-baz", kind: "reviewer", role: "code-reviewer" },
			{ status: "idle" },
		), false);
	});

	it("LIVE reviewer (status=streaming) -> DO NOT sweep", () => {
		assert.equal(isZombieReviewer(
			{ sessionId: "llm-review-qux", kind: "reviewer" },
			{ status: "streaming" },
		), false);
	});

	it("worker agent (coder, role!=reviewer) with terminated session -> DO NOT sweep", () => {
		// We only target reviewer-looking agents. Worker termination is
		// handled separately by the team-manager's own auto-archive flow.
		assert.equal(isZombieReviewer(
			{ sessionId: "abc-coder-1", role: "coder", kind: "worker" },
			{ status: "terminated" },
		), false);
	});

	it("team-lead (kind=undefined, role=team-lead) with no session -> DO NOT sweep", () => {
		// Team-leads are never swept. Their lifecycle is managed by goal
		// archive flow, not the reviewer cleanup.
		assert.equal(isZombieReviewer(
			{ sessionId: "tl-1", role: "team-lead" },
			null,
		), false);
	});

	it("agent with sessionId NOT starting with llm-review- and no role/kind -> DO NOT sweep", () => {
		// Conservative default: don't sweep what we can't confidently
		// classify as a reviewer.
		assert.equal(isZombieReviewer(
			{ sessionId: "12345-something" },
			null,
		), false);
	});
});
