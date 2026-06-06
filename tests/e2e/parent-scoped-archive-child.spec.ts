/**
 * `DELETE /api/goals/:parentId/archive-child/:childId` — parent-scoped
 * archive route.
 *
 * This endpoint is a MUTATING Children operation and is guarded by the same
 * S1 server-side authorization as every other Children mutation
 * (`spawn-child`, `integrate-child`, `pause`, `resume`, mutation `decision`,
 * `policy`, plan `PATCH`). See `src/server/auth/children-mutation-authz.ts`
 * for the full threat model and decision table.
 *
 * Coverage:
 *   1. Authz — agent caller with neither a verified `bobbit_session` cookie
 *      nor a spawning-session header is rejected 403 NOT_TEAM_LEAD (the
 *      absent-header bypass is closed), and the child is NOT archived.
 *   2. Authz — a verified human/UI operator (bobbit_session cookie) is
 *      allowed past the gate and the child is archived.
 *   3. Authz — an agent caller presenting a spawning-session header on a goal
 *      with no established team-lead takes the "no-team-lead → allow" branch
 *      and the child is archived.
 *   4. Relationship — once authorized, a target that is NOT a direct child of
 *      the parent is rejected 403 NOT_DIRECT_CHILD (authenticating
 *      legitimately via the human cookie so the request reaches the
 *      relationship check).
 *
 * Mirrors the in-process harness + cookie-capture pattern from
 * `tests/e2e/api-goals-spawn-child-route.spec.ts`.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	gitCwd,
	rawApiFetch,
	readE2EToken,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

let token: string;
let humanCookie = "";

test.beforeAll(async () => {
	token = readE2EToken();
	// The S1 Children-mutation authz treats a request carrying the verified
	// `bobbit_session` cookie as a trusted human/UI operator. The gateway
	// mints the cookie on the first authenticated request; capture it so the
	// "human → allow" assertions can authorize via the cookie.
	const probe = await rawApiFetch("/api/goals", { headers: { Authorization: `Bearer ${token}` } });
	const setCookies = (probe.headers as any).getSetCookie?.() as string[] | undefined
		?? (probe.headers.get("set-cookie") ? [probe.headers.get("set-cookie") as string] : []);
	humanCookie = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("bobbit_session=")) ?? "";
	expect(humanCookie, "harness must mint a bobbit_session cookie for the human/UI authz path").not.toBe("");
});

/** Header set including the auth token plus the human bobbit_session cookie. */
function humanHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		...(humanCookie ? { Cookie: humanCookie } : {}),
		...(extra ?? {}),
	};
}

/**
 * Create a goal in a real git repo so it gets a worktree (`repoPath`).
 * `autoStartTeam: false` so no team-lead is established — leaving the
 * "no-team-lead → allow" authz branch in play for agent callers.
 */
async function createReadyGoal(label: string): Promise<{ id: string; repoPath?: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
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
			return g.setupStatus === "ready" && g.repoPath ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `goal ${created.id} setup ready` },
	);
	return settled;
}

/** Spawn a DIRECT child of `parentId` via the cookie-authorized human path. */
async function spawnChild(parentId: string, planId: string): Promise<string> {
	const resp = await rawApiFetch(`/api/goals/${parentId}/spawn-child`, {
		method: "POST",
		headers: humanHeaders(),
		body: JSON.stringify({
			planId,
			title: `archive-child target ${planId}`,
			spec: "archive-child authz fixture: a direct child goal created so the parent-scoped archive route has a real relationship to validate.",
		}),
	});
	expect(resp.status).toBe(201);
	const body = await resp.json();
	expect(body.id).toBeTruthy();
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

	test("agent caller with spawning header on team-lead-less goal → allowed (no-team-lead branch)", async () => {
		const parent = await createReadyGoal("archive-child agent parent");
		const childId = await spawnChild(parent.id, "plan-authz-agent");
		try {
			const { status, body } = await archiveChildRaw({
				parentId: parent.id,
				childId,
				headers: {
					Authorization: `Bearer ${token}`,
					"X-Bobbit-Spawning-Session": `agent-sess-${Date.now()}`,
				},
			});
			expect(status).toBe(200);
			expect(body.ok).toBe(true);
			expect(await isArchived(childId)).toBe(true);
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
