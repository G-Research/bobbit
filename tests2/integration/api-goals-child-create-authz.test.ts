/**
 * S1 SECURITY — `POST /api/goals` with a `parentGoalId` is a Children mutation.
 *
 * Creating a child goal under another goal spawns (and can auto-start) a child
 * team, so it MUST be authorized like the other Children verbs BEFORE anything
 * is created/started. Previously this path validated parent existence + nesting
 * + pause then created the child with NO authz, letting any shared-bearer-token
 * holder (incl. a non-team-lead agent) drive child creation under an arbitrary
 * goal and bypass the Children tool policy + per-session secret binding.
 *
 * This is an OPERATOR-class verb (see `src/server/auth/children-mutation-authz.ts`):
 *   - a verified stateless signed `bobbit_session` cookie is accepted (proposal-UI path), and
 *   - otherwise the AUTHENTIC caller (derived server-side from the unforgeable
 *     per-session `X-Bobbit-Session-Secret`) must match the team-lead of the
 *     parent's ROOT goal.
 * Everything else → 403 NOT_TEAM_LEAD, with nothing created.
 *
 * Top-level goal creation (no `parentGoalId`) is UNCHANGED — these tests create
 * the parent via the normal authenticated path and assert it succeeds.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	rawApiFetch,
	deleteGoal,
	defaultProjectId,
	nonGitCwd,
	seedTeamLeadHeader,
} from "./_e2e/e2e-setup.js";

// The in-process gateway (worker-scoped) — needed to seed a team-lead + its
// capability secret for the authentic-team-lead allow path.
let gw: any;
let humanCookie = "";
test.beforeAll(async ({ gateway }) => {
	gw = gateway;
	// Cookie bootstrap models a same-origin browser API request. Fetch Metadata
	// classifies issuance eligibility; the valid Bearer remains the authority.
	const probe = await rawApiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const setCookies = (probe.headers as any).getSetCookie?.() as string[] | undefined
		?? (probe.headers.get("set-cookie") ? [probe.headers.get("set-cookie") as string] : []);
	humanCookie = setCookies.map((cookie) => cookie.split(";")[0])
		.find((cookie) => cookie.startsWith("bobbit_session=")) ?? "";
	expect(humanCookie, "browser-signaled Bearer auth must mint a signed bobbit_session cookie").not.toBe("");
});

function humanHeaders(): Record<string, string> {
	return { Cookie: humanCookie };
}

const CHILD_SPEC =
	"Child goal for the POST /api/goals Children-authz E2E — padded to satisfy the spec minimum length validator.";
const PARENT_SPEC =
	"Parent goal for the POST /api/goals Children-authz E2E — padded to satisfy the spec minimum length validator.";

/** Create a top-level parent goal (no parentGoalId). rootGoalId === its own id. */
async function createParent(): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		headers: humanHeaders(),
		body: JSON.stringify({
			title: `child-authz parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: nonGitCwd(),
			worktree: false,
			autoStartTeam: false,
			workflowId: "feature",
			spec: PARENT_SPEC,
			projectId: await defaultProjectId(),
		}),
	});
	expect(resp.status).toBe(201);
	const body = await resp.json();
	expect(body.id).toBeTruthy();
	return body.id as string;
}

/** Build the child-creation request body for a given parent. */
async function childBody(parentId: string): Promise<string> {
	return JSON.stringify({
		title: "child via POST /api/goals",
		cwd: nonGitCwd(),
		worktree: false,
		autoStartTeam: false,
		workflowId: "feature",
		spec: CHILD_SPEC,
		projectId: await defaultProjectId(),
		parentGoalId: parentId,
	});
}

test.describe("POST /api/goals child-creation Children authz (S1)", () => {
	test("agent without cookie or secret → 403, nothing created @smoke", async () => {
		const parentId = await createParent();
		try {
			// rawApiFetch carries only the shared Bearer token — no cookie, browser
			// signaling, or session secret — exactly the rogue/non-team-lead agent profile.
			const resp = await rawApiFetch("/api/goals", {
				method: "POST",
				body: await childBody(parentId),
			});
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_TEAM_LEAD");
			expect(body.goalId).toBe(parentId);
			// Nothing must have been created.
			expect(body.id).toBeUndefined();
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("agent with a foreign session secret (not the team-lead) → 403", async () => {
		const parentId = await createParent();
		try {
			// Seed the parent's team-lead, then register a DIFFERENT session's
			// secret and present it — it resolves to an authentic caller that is
			// NOT the team-lead, so the team-lead-match check must reject it.
			seedTeamLeadHeader(gw, parentId);
			const foreignSecret = gw.sessionManager.sessionSecretStore.getOrCreateSecret(
				`e2e-not-the-teamlead-${parentId}`,
			);
			const resp = await rawApiFetch("/api/goals", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": foreignSecret },
				body: await childBody(parentId),
			});
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_TEAM_LEAD");
			expect(body.id).toBeUndefined();
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("human operator cookie → child created (201)", async () => {
		const parentId = await createParent();
		let childId: string | undefined;
		try {
			// Present the signed cookie bootstrapped by the browser-signaled request;
			// no team-lead secret is needed on the human/proposal-UI operator path.
			const resp = await apiFetch("/api/goals", {
				method: "POST",
				headers: humanHeaders(),
				body: await childBody(parentId),
			});
			expect(resp.status).toBe(201);
			const body = await resp.json();
			childId = body.id as string;
			expect(childId).toBeTruthy();
			expect(body.parentGoalId).toBe(parentId);
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(parentId);
		}
	});

	test("authentic team-lead secret → child created (201)", async () => {
		const parentId = await createParent();
		let childId: string | undefined;
		try {
			// Seed the parent goal's team-lead + its capability secret, then
			// present the secret. The authz resolves it to the authentic team-lead
			// of the parent's ROOT goal (rootGoalId === parentId for a top-level
			// parent) → allow.
			const headers = seedTeamLeadHeader(gw, parentId);
			const resp = await rawApiFetch("/api/goals", {
				method: "POST",
				headers: { "X-Bobbit-Session-Secret": headers["X-Bobbit-Session-Secret"] },
				body: await childBody(parentId),
			});
			expect(resp.status).toBe(201);
			const body = await resp.json();
			childId = body.id as string;
			expect(childId).toBeTruthy();
			expect(body.parentGoalId).toBe(parentId);
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(parentId);
		}
	});
});
