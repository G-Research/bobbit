/**
 * `DELETE /api/goals/:parentId/archive-child/:childId` — parent-scoped
 * archive route.
 *
 * This endpoint is an OPERATOR-class Children mutation (the web UI drives it),
 * so a verified stateless signed `bobbit_session` cookie authorizes it; otherwise the same
 * team-lead match as every other Children mutation applies. See
 * `src/server/auth/children-mutation-authz.ts` for the full threat model and
 * decision tables. (The spawn-child setup calls used to create the child are
 * ORCHESTRATION verbs and are authorized as the parent's team-lead.)
 *
 * Coverage:
 *   1. Authz — agent caller with neither a verified `bobbit_session` cookie
 *      nor a spawning-session header is rejected 403 NOT_TEAM_LEAD (the
 *      absent-header bypass is closed), and the child is NOT archived.
 *   2. Authz — a verified human/UI operator (bobbit_session cookie) is
 *      allowed past the gate and the child is archived.
 *   3. Authz — an agent caller presenting a spawning-session header that does
 *      NOT match the parent's authoritative team-lead is rejected 403
 *      NOT_TEAM_LEAD and the child is NOT archived.
 *   4. Relationship — once authorized, a target that is NOT a direct child of
 *      the parent is rejected 403 NOT_DIRECT_CHILD (authenticating
 *      legitimately via the human cookie so the request reaches the
 *      relationship check).
 *
 * Mirrors the in-process harness + cookie-capture pattern from
 * `tests/e2e/api-goals-spawn-child-route.spec.ts`.
 */
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	nonGitCwd,
	rawApiFetch,
	readE2EToken,
	seedTeamLeadHeader,
} from "./_e2e/e2e-setup.js";
import { pollUntil } from "../../tests/e2e/test-utils/cleanup.js";

let token: string;
let humanCookie = "";
// In-process gateway (worker-scoped) — used to establish a team-lead for the
// ORCHESTRATION-class spawn-child setup calls (archive-child itself is an
// OPERATOR verb that the human cookie still authorizes).
let gw: any;

test.beforeAll(async ({ gateway }) => {
	token = readE2EToken();
	gw = gateway;
	// archive-child is an OPERATOR Children verb: the S1 authz treats a request
	// carrying a verified signed `bobbit_session` cookie as a human/UI operator.
	// Bootstrap it only through an authenticated, same-origin browser-signaled
	// request; Fetch Metadata controls issuance eligibility, not authority.
	const probe = await rawApiFetch("/api/goals", {
		headers: {
			Authorization: `Bearer ${token}`,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
		},
	});
	const setCookies = (probe.headers as any).getSetCookie?.() as string[] | undefined
		?? (probe.headers.get("set-cookie") ? [probe.headers.get("set-cookie") as string] : []);
	humanCookie = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("bobbit_session=")) ?? "";
	expect(humanCookie, "browser-signaled Bearer auth must mint a signed bobbit_session cookie").not.toBe("");
});

/** Header set including the auth token plus the signed human bobbit_session cookie. */
function humanHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		...(humanCookie ? { Cookie: humanCookie } : {}),
		...(extra ?? {}),
	};
}

/**
 * Create a data-only goal. The archive route depends on goal relationships and
 * authz, not Git; `autoStartTeam: false` leaves the goal teamless so only the
 * verified human operator may mutate it.
 */
async function createReadyGoal(label: string): Promise<{ id: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		headers: humanHeaders(),
		body: JSON.stringify({
			title: `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: nonGitCwd(),
			worktree: false,
			autoStartTeam: false,
			workflowId: "feature",
		}),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	const settled = await pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" ? g : null;
		},
		{ timeoutMs: 5_000, intervalMs: 25, label: `goal ${created.id} setup ready` },
	);
	return settled;
}

/**
 * Spawn a DIRECT child of `parentId`. spawn-child is an ORCHESTRATION verb
 * (cookie does NOT bypass), so authorize as the parent's team-lead via a
 * seeded matching X-Bobbit-Spawning-Session header.
 */
async function spawnChild(parentId: string, planId: string): Promise<string> {
	const context = gw.projectContextManager.getContextForGoal(parentId);
	const parent = context.goalStore.get(parentId);
	const dependencyPlanId = `fixture-dependency-${planId}`;
	const dependency = await context.goalManager.createGoal(`dependency ${planId}`, nonGitCwd(), {
		spec: "Data-only dependency used to keep the target child from auto-starting a team during route-authz coverage.",
		workflowId: "feature",
		projectId: parent.projectId,
		parentGoalId: parentId,
		worktree: false,
	});
	await context.goalManager.updateGoal(dependency.id, { spawnedFromPlanId: dependencyPlanId });

	const tlHeader = seedTeamLeadHeader(gw, parentId);
	const resp = await rawApiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...tlHeader },
		body: JSON.stringify({
			planId,
			dependsOn: [dependencyPlanId],
			title: `archive-child target ${planId}`,
			spec: "archive-child authz fixture: a direct child goal created so the parent-scoped archive route has a real relationship to validate.",
		}),
	});
	expect(resp.status).toBe(201);
	const body = await resp.json();
	expect(body.id).toBeTruthy();
	// Resolve the seeded dependency after creation and make the target live. This
	// retains relationship semantics without starting an incidental child team.
	await context.goalManager.updateGoal(dependency.id, { state: "complete" });
	await context.goalManager.updateGoal(body.id, { state: "todo" });
	// The spawn-child response does not echo parentGoalId — read the
	// persisted record back to confirm the direct-child relationship.
	const read = await apiFetch(`/api/goals/${body.id}`);
	expect(read.status).toBe(200);
	const child = await read.json();
	expect(child.parentGoalId).toBe(parentId);
	return body.id as string;
}

/** DELETE /archive-child with explicit headers (no auto-injected authz). */
async function archiveChildRaw(opts: {
	parentId: string;
	childId: string;
	headers?: Record<string, string>;
	cascade?: boolean;
}): Promise<{ status: number; body: any }> {
	const cascade = opts.cascade ?? true;
	const resp = await rawApiFetch(
		`/api/goals/${opts.parentId}/archive-child/${opts.childId}?cascade=${cascade}`,
		{ method: "DELETE", headers: opts.headers ?? { Authorization: `Bearer ${token}` } },
	);
	const text = await resp.text();
	let body: any;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: resp.status, body };
}

async function isArchived(goalId: string): Promise<boolean> {
	const r = await apiFetch(`/api/goals/${goalId}`);
	if (r.status !== 200) return false;
	const g = await r.json();
	return g.archived === true;
}

test.describe("DELETE /api/goals/:parentId/archive-child/:childId — Children authz", () => {
	test("agent caller without cookie or spawning header → 403 NOT_TEAM_LEAD (child preserved) @smoke", async () => {
		const parent = await createReadyGoal("archive-child authz parent");
		const childId = await spawnChild(parent.id, "plan-authz-deny");
		try {
			// No cookie, no X-Bobbit-Spawning-Session / X-Bobbit-Session-Id
			// header → the absent-header bypass is closed.
			const { status, body } = await archiveChildRaw({
				parentId: parent.id,
				childId,
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(status).toBe(403);
			expect(body.code).toBe("NOT_TEAM_LEAD");
			// The child must NOT have been archived by a rejected request.
			expect(await isArchived(childId)).toBe(false);
		} finally {
			await deleteGoal(childId);
			await deleteGoal(parent.id);
		}
	});

	test("verified human operator (bobbit_session cookie) → allowed, child archived", async () => {
		const parent = await createReadyGoal("archive-child human parent");
		const childId = await spawnChild(parent.id, "plan-authz-human");
		try {
			const { status, body } = await archiveChildRaw({
				parentId: parent.id,
				childId,
				headers: humanHeaders(),
			});
			expect(status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.archived).toBeGreaterThanOrEqual(1);
			expect(await isArchived(childId)).toBe(true);
		} finally {
			await deleteGoal(childId);
			await deleteGoal(parent.id);
		}
	});

	test("agent caller with a non-matching spawning header → 403 NOT_TEAM_LEAD (child preserved)", async () => {
		const parent = await createReadyGoal("archive-child agent parent");
		const childId = await spawnChild(parent.id, "plan-authz-agent");
		try {
			// A forged spawning-session header that does not equal the parent's
			// authoritative team-lead must NOT authorize the operator mutation.
			const { status, body } = await archiveChildRaw({
				parentId: parent.id,
				childId,
				headers: {
					Authorization: `Bearer ${token}`,
					"X-Bobbit-Spawning-Session": `agent-sess-${Date.now()}`,
				},
			});
			expect(status).toBe(403);
			expect(body.code).toBe("NOT_TEAM_LEAD");
			expect(await isArchived(childId)).toBe(false);
		} finally {
			await deleteGoal(childId);
			await deleteGoal(parent.id);
		}
	});
});

test.describe("DELETE /archive-child — relationship validation (authorized)", () => {
	test("target that is NOT a direct child → 403 NOT_DIRECT_CHILD", async () => {
		const parent = await createReadyGoal("archive-child rel parent");
		const unrelated = await createReadyGoal("archive-child rel unrelated");
		try {
			// Authenticate legitimately via the human cookie so the request
			// passes the S1 authz gate and reaches the relationship check.
			const { status, body } = await archiveChildRaw({
				parentId: parent.id,
				childId: unrelated.id,
				headers: humanHeaders(),
			});
			expect(status).toBe(403);
			expect(body.code).toBe("NOT_DIRECT_CHILD");
			// The unrelated goal must survive a rejected relationship check.
			expect(await isArchived(unrelated.id)).toBe(false);
		} finally {
			await deleteGoal(unrelated.id);
			await deleteGoal(parent.id);
		}
	});
});
