/**
 * REPRODUCING TEST — sub-goal creation UX bug (issue analysis gate), HTTP layer.
 *
 * Covers, with the SYSTEM pref `subgoalsEnabled` ON:
 *
 *   #1  POST /api/goals with a parentGoalId whose parent carries
 *       `subgoalsAllowed: false` must reject with a DISTINCT code
 *       `PARENT_SUBGOALS_DISABLED` that NAMES the parent — not the
 *       system-off `SUBGOALS_DISABLED` string. (RED: current tree returns
 *       422 SUBGOALS_DISABLED / "Subgoals are disabled".)
 *
 *   #3  PATCH /api/goals/:id/policy must accept + persist `subgoalsAllowed`
 *       and `maxNestingDepth` (team-lead authorized), survive an API read,
 *       and thereby UNBLOCK child creation under that parent. (RED: current
 *       tree silently ignores both fields.)
 *
 * Non-regression guards (already pass on the current tree):
 *   - system OFF still yields SUBGOALS_DISABLED at the child-create path.
 *   - PATCH /api/goals/:id/policy remains team-lead-only (orchestration class;
 *     a bare bearer token without the team-lead secret is rejected).
 *
 * The "user toggled Allow-subgoals while creating the NEW goal" clarification
 * is encoded structurally: the unblock comes ONLY from editing the PARENT's
 * own policy (PATCH on the parent id), never from any flag on the child body.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	rawApiFetch,
	deleteGoal,
	defaultProjectId,
	nonGitCwd,
	seedTeamLeadHeader,
} from "./e2e-setup.js";

let gw: any;
test.beforeAll(async ({ gateway }) => {
	gw = gateway;
});

const PARENT_SPEC =
	"Parent goal for the PARENT_SUBGOALS_DISABLED repro — padded to satisfy the spec minimum length validator.";
const CHILD_SPEC =
	"Child goal for the PARENT_SUBGOALS_DISABLED repro — padded to satisfy the spec minimum length validator.";

async function setSubgoalsEnabled(enabled: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: enabled }),
	});
	expect(resp.status).toBe(200);
}

/** Create a top-level parent goal with an explicit subgoalsAllowed value. */
async function createParent(title: string, subgoalsAllowed: boolean): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title,
			cwd: nonGitCwd(),
			worktree: false,
			autoStartTeam: false,
			workflowId: "feature",
			spec: PARENT_SPEC,
			projectId: await defaultProjectId(),
			subgoalsAllowed,
		}),
	});
	expect(resp.status).toBe(201);
	const body = await resp.json();
	expect(body.id).toBeTruthy();
	return body.id as string;
}

/** Body for creating a child under `parentId`. */
async function childBody(parentId: string): Promise<string> {
	return JSON.stringify({
		title: "child under parent",
		cwd: nonGitCwd(),
		worktree: false,
		autoStartTeam: false,
		workflowId: "feature",
		spec: CHILD_SPEC,
		projectId: await defaultProjectId(),
		parentGoalId: parentId,
	});
}

test.describe("Sub-goal creation: parent-disabled is distinct + policy is editable", () => {
	test.afterEach(async () => {
		await setSubgoalsEnabled(true);
	});

	test("system ON: creating a child under a subgoalsAllowed:false parent → PARENT_SUBGOALS_DISABLED naming the parent", async () => {
		await setSubgoalsEnabled(true);
		const title = `parent-disabled ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const parentId = await createParent(title, false);
		try {
			const resp = await apiFetch("/api/goals", {
				method: "POST",
				body: await childBody(parentId),
			});
			expect(resp.status).not.toBe(201);
			const body = await resp.json().catch(() => ({} as any));
			// Distinct code — NOT the system-off string.
			expect(body.code).toBe("PARENT_SUBGOALS_DISABLED");
			expect(body.code).not.toBe("SUBGOALS_DISABLED");
			// Message must name the offending parent so the dead-end is clear.
			expect(String(body.error ?? "")).toContain(title);
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("system OFF: child-create path still returns SUBGOALS_DISABLED (system gate non-regression)", async () => {
		// Parent allows sub-goals; only the SYSTEM pref is off — the master gate.
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`sys-off-parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			true,
		);
		try {
			await setSubgoalsEnabled(false);
			const resp = await apiFetch("/api/goals", {
				method: "POST",
				body: await childBody(parentId),
			});
			expect(resp.status).not.toBe(201);
			const body = await resp.json().catch(() => ({} as any));
			expect(body.code).toBe("SUBGOALS_DISABLED");
		} finally {
			await setSubgoalsEnabled(true);
			await deleteGoal(parentId);
		}
	});

	test("PATCH /policy persists subgoalsAllowed + maxNestingDepth and survives an API read", async () => {
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`policy-edit ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			false,
		);
		try {
			// Confirm the starting state really is disabled.
			const before = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(before.subgoalsAllowed).toBe(false);

			// Team-lead-authorized policy edit (orchestration class — the cookie
			// does NOT bypass, so seed the team-lead secret).
			const headers = seedTeamLeadHeader(gw, parentId);
			const resp = await rawApiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				headers: { "X-Bobbit-Session-Secret": headers["X-Bobbit-Session-Secret"] },
				body: JSON.stringify({ subgoalsAllowed: true, maxNestingDepth: 2 }),
			});
			expect(resp.status).toBe(200);

			// Persistence survives an independent API read.
			const after = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(after.subgoalsAllowed).toBe(true);
			expect(after.maxNestingDepth).toBe(2);
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("after enabling sub-goals on the parent via /policy, a child can be created (201)", async () => {
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`unblock ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			false,
		);
		let childId: string | undefined;
		try {
			const headers = seedTeamLeadHeader(gw, parentId);
			const patch = await rawApiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				headers: { "X-Bobbit-Session-Secret": headers["X-Bobbit-Session-Secret"] },
				body: JSON.stringify({ subgoalsAllowed: true }),
			});
			expect(patch.status).toBe(200);

			const resp = await apiFetch("/api/goals", {
				method: "POST",
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

	test("PATCH /policy remains team-lead-only (authz non-regression)", async () => {
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`authz ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			false,
		);
		try {
			// Bare bearer token, no team-lead secret, no human cookie → the
			// operator class (subgoal-only body) still denies a bare bearer.
			const resp = await rawApiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				body: JSON.stringify({ subgoalsAllowed: true }),
			});
			expect(resp.status).toBe(403);
			// The parent must remain disabled.
			const after = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(after.subgoalsAllowed).toBe(false);
		} finally {
			await deleteGoal(parentId);
		}
	});
});

/**
 * NARROWED POLICY AUTHZ (this task) — `PATCH /api/goals/:id/policy` is now
 * split by body shape:
 *
 *   - OPERATOR class when the body carries EXCLUSIVELY the per-goal sub-goal
 *     opt-in fields (`subgoalsAllowed` / `maxNestingDepth`). These are the
 *     human-dashboard settings; a verified `bobbit_session` cookie authorizes
 *     them (else a team-lead match). This is what lets the human UI turn on
 *     sub-goals for an existing parent without the team-lead secret.
 *
 *   - ORCHESTRATION class when the body carries ANY of `divergencePolicy` /
 *     `maxConcurrentChildren` (even mixed with subgoal fields). These remain
 *     team-lead-only; the cookie does NOT bypass.
 *
 * `apiFetch` auto-injects the gateway-minted human cookie for `/policy` (it is
 * harmless for the orchestration class — the cookie can't authorize it). The
 * deny / team-lead paths use `rawApiFetch` with explicit headers.
 */
test.describe("PATCH /policy — narrowed operator vs orchestration auth", () => {
	test.afterEach(async () => {
		await setSubgoalsEnabled(true);
	});

	test("operator (human cookie) CAN patch subgoal-only fields without the team-lead secret", async () => {
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`op-cookie ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			false,
		);
		try {
			// apiFetch auto-injects the human cookie for /policy; no team-lead
			// secret is supplied. Operator class accepts the cookie.
			const resp = await apiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				body: JSON.stringify({ subgoalsAllowed: true, maxNestingDepth: 2 }),
			});
			expect(resp.status).toBe(200);
			const after = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(after.subgoalsAllowed).toBe(true);
			expect(after.maxNestingDepth).toBe(2);
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("bare bearer (no cookie, no secret) CANNOT patch subgoal-only fields", async () => {
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`op-bare ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			false,
		);
		try {
			const resp = await rawApiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				body: JSON.stringify({ subgoalsAllowed: true }),
			});
			expect(resp.status).toBe(403);
			const after = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(after.subgoalsAllowed).toBe(false);
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("orchestration fields (divergencePolicy / maxConcurrentChildren) stay team-lead-only — cookie does NOT bypass", async () => {
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`orch-cookie ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			true,
		);
		try {
			// Human cookie (auto-injected by apiFetch) must NOT authorize an
			// orchestration-class policy change.
			const denied = await apiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				body: JSON.stringify({ divergencePolicy: "autonomous" }),
			});
			expect(denied.status).toBe(403);

			// The team-lead secret authorizes it.
			const headers = seedTeamLeadHeader(gw, parentId);
			const ok = await rawApiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				headers: { "X-Bobbit-Session-Secret": headers["X-Bobbit-Session-Secret"] },
				body: JSON.stringify({ divergencePolicy: "autonomous", maxConcurrentChildren: 2 }),
			});
			expect(ok.status).toBe(200);
			const after = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(after.divergencePolicy).toBe("autonomous");
			expect(after.maxConcurrentChildren).toBe(2);
		} finally {
			await deleteGoal(parentId);
		}
	});

	test("MIXED body (subgoal + orchestration field) is classified orchestration — cookie does NOT bypass", async () => {
		await setSubgoalsEnabled(true);
		const parentId = await createParent(
			`mixed ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			false,
		);
		try {
			// A cookie-only caller must not piggyback an orchestration field
			// (maxConcurrentChildren) behind a sub-goal toggle.
			const denied = await apiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				body: JSON.stringify({ subgoalsAllowed: true, maxConcurrentChildren: 4 }),
			});
			expect(denied.status).toBe(403);
			// Nothing changed.
			const after = await (await apiFetch(`/api/goals/${parentId}`)).json();
			expect(after.subgoalsAllowed).toBe(false);
		} finally {
			await deleteGoal(parentId);
		}
	});
});
