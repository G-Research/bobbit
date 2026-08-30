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
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	rawApiFetch,
	deleteGoal,
	defaultProjectId,
	nonGitCwd,
	seedTeamLeadHeader,
} from "./_e2e/e2e-setup.js";

let gw: any;
let humanCookie = "";
test.beforeAll(async ({ gateway }) => {
	gw = gateway;
	// Bootstrap the stateless operator cookie through a realistic same-origin
	// browser request. Fetch Metadata controls eligibility, not authority.
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
		headers: humanHeaders(),
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
				headers: humanHeaders(),
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
				headers: humanHeaders(),
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
 * Operator-path calls explicitly present the signed cookie bootstrapped by the
 * browser-signaled setup request. It is harmless for the orchestration class —
 * the cookie cannot authorize it. Deny/team-lead paths use `rawApiFetch`.
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
			// Explicitly present the signed human cookie; no team-lead secret is
			// supplied. Operator class accepts the cookie.
			const resp = await apiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				headers: humanHeaders(),
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
			// The explicitly presented human cookie must NOT authorize an
			// orchestration-class policy change.
			const denied = await apiFetch(`/api/goals/${parentId}/policy`, {
				method: "PATCH",
				headers: humanHeaders(),
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
				headers: humanHeaders(),
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

/**
 * SERVER-AUTHORITY GUARD — `PATCH /api/goals/:id/policy` must clamp a CHILD
 * goal's `maxNestingDepth` to its PARENT's effective cap, not merely the
 * system ceiling. Descendants can only tighten, never widen past the inherited
 * tree cap. Without this, a child stamped with the parent's effective cap (2)
 * could be re-widened to 3 via /policy and silently re-open a forbidden
 * grandchild tier.
 */
test.describe("PATCH /policy — child maxNestingDepth cannot widen past inherited parent cap", () => {
	test.afterEach(async () => {
		await setSubgoalsEnabled(true);
	});

	test("root cap=2 → child inherits 2; PATCH child to 3 is clamped to 2 and grandchild stays blocked", async () => {
		await setSubgoalsEnabled(true);
		const rootTitle = `widen-root ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const rootId = await createParent(rootTitle, true);
		let childId: string | undefined;
		try {
			// Tighten the root to a 2-level tree via the operator path.
			const rootHeaders = seedTeamLeadHeader(gw, rootId);
			const rootPatch = await rawApiFetch(`/api/goals/${rootId}/policy`, {
				method: "PATCH",
				headers: { "X-Bobbit-Session-Secret": rootHeaders["X-Bobbit-Session-Secret"] },
				body: JSON.stringify({ maxNestingDepth: 2 }),
			});
			expect(rootPatch.status).toBe(200);
			const rootAfter = await (await apiFetch(`/api/goals/${rootId}`)).json();
			expect(rootAfter.maxNestingDepth).toBe(2);

			// Create a child — it is stamped with the parent's EFFECTIVE cap (2).
			const childResp = await apiFetch("/api/goals", {
				method: "POST",
				headers: humanHeaders(),
				body: await childBody(rootId),
			});
			expect(childResp.status).toBe(201);
			const childCreated = await childResp.json();
			childId = childCreated.id as string;
			const child = await (await apiFetch(`/api/goals/${childId}`)).json();
			expect(child.maxNestingDepth).toBe(2);

			// Attempt to WIDEN the child past the inherited cap — server must clamp.
			const childHeaders = seedTeamLeadHeader(gw, childId);
			const widen = await rawApiFetch(`/api/goals/${childId}/policy`, {
				method: "PATCH",
				headers: { "X-Bobbit-Session-Secret": childHeaders["X-Bobbit-Session-Secret"] },
				body: JSON.stringify({ maxNestingDepth: 3 }),
			});
			expect(widen.status).toBe(200);
			const childWidened = await (await apiFetch(`/api/goals/${childId}`)).json();
			// Clamped to the parent effective cap, NOT widened to 3.
			expect(childWidened.maxNestingDepth).toBe(2);

			// Grandchild (depth 3) creation under the child stays blocked by depth.
			const grandResp = await apiFetch("/api/goals", {
				method: "POST",
				headers: humanHeaders(),
				body: await childBody(childId),
			});
			expect(grandResp.status).not.toBe(201);
			const grandBody = await grandResp.json().catch(() => ({} as any));
			expect(grandBody.code).toBe("NESTING_DEPTH_EXCEEDED");
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(rootId);
		}
	});
});

/**
 * REGRESSION (#2) — retroactively tightening an ANCESTOR must constrain an
 * already-created descendant. Root + child are first created under the wide
 * system cap (3); the child is stamped own=3. The root is THEN tightened to 2
 * via /policy. A grandchild under the existing child (depth 3) must now be
 * refused, even though the child's stored `maxNestingDepth` is the stale 3 —
 * the spawn gate recomputes the effective cap against the ancestor chain.
 */
test.describe("PATCH /policy — lowering an ancestor cap blocks an already-created descendant", () => {
	test.afterEach(async () => {
		await setSubgoalsEnabled(true);
	});

	test("root + child at cap 3; lower root to 2 → grandchild under existing child is blocked", async () => {
		await setSubgoalsEnabled(true);
		const rootTitle = `retro-root ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const rootId = await createParent(rootTitle, true);
		let childId: string | undefined;
		try {
			// Child created while the tree cap is still the wide system default (3);
			// it inherits + stores own=3.
			const childResp = await apiFetch("/api/goals", {
				method: "POST",
				headers: humanHeaders(),
				body: await childBody(rootId),
			});
			expect(childResp.status).toBe(201);
			const childCreated = await childResp.json();
			childId = childCreated.id as string;
			const child = await (await apiFetch(`/api/goals/${childId}`)).json();
			expect(child.maxNestingDepth).toBe(3);

			// Retroactively tighten the ROOT to a 2-level tree.
			const rootHeaders = seedTeamLeadHeader(gw, rootId);
			const rootPatch = await rawApiFetch(`/api/goals/${rootId}/policy`, {
				method: "PATCH",
				headers: { "X-Bobbit-Session-Secret": rootHeaders["X-Bobbit-Session-Secret"] },
				body: JSON.stringify({ maxNestingDepth: 2 }),
			});
			expect(rootPatch.status).toBe(200);

			// The child's stored own is still the stale 3 …
			const childStale = await (await apiFetch(`/api/goals/${childId}`)).json();
			expect(childStale.maxNestingDepth).toBe(3);

			// … but a grandchild (depth 3) under the existing child is now refused,
			// because the spawn gate recomputes the effective cap against the
			// now-lowered ancestor.
			const grandResp = await apiFetch("/api/goals", {
				method: "POST",
				headers: humanHeaders(),
				body: await childBody(childId),
			});
			expect(grandResp.status).not.toBe(201);
			const grandBody = await grandResp.json().catch(() => ({} as any));
			expect(grandBody.code).toBe("NESTING_DEPTH_EXCEEDED");
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(rootId);
		}
	});
});
