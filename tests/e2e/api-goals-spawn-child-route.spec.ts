/**
 * `POST /api/goals/:id/spawn-child` — route-level wiring tests.
 *
 * Covers the fixes that landed in 0f7e6a64, 7491041c, and 00d6805f
 * without dedicated route-level coverage:
 *
 *   1. `X-Bobbit-Spawning-Session` header → stamps `spawnedBySessionId`
 *      on the persisted child (header path).
 *   2. `body.spawnedBySessionId` → stamped when no header present
 *      (body fallback path).
 *   3. Body wins over header when both are supplied — body.spawnedBySessionId
 *      is tier 1 in the four-tier cascade (explicit caller claim);
 *      X-Bobbit-Spawning-Session header is tier 2. See
 *      src/server/agent/spawn-child-spawnedby.ts.
 *   4. `body.suggestedRole` → persisted on the child goal (commit
 *      7491041c reinstated this after it had been `void`'d).
 *   5. `spawnedFromPlanId` is stamped (existing stamp-immediately invariant —
 *      atomic with `createGoal`, no awaits between).
 *   6. Child goal's `cwd` is derived from `parent.repoPath` (NOT
 *      `parent.cwd`) so children don't inherit the parent's worktree
 *      path and end up nested under `<parent-worktree>-wt/`.
 *   7. Setup-trigger: `setupWorktreeAndStartTeam` is invoked after
 *      spawn-child so the child doesn't sit in `setupStatus="preparing"`
 *      forever (the showstopper bug from 0f7e6a64).
 *
 * Mirrors the in-process harness import pattern from
 * `tests/e2e/gates-api.spec.ts`.
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	gitCwd,
	rawApiFetch,
	readE2EToken,
	seedTeamLeadHeader,
} from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

let token: string;
// The in-process gateway (worker-scoped) — captured in beforeAll so the
// helpers below can reach `gateway.teamManager` to establish a team-lead.
let gw: any;

test.beforeAll(async ({ gateway }) => {
	token = readE2EToken();
	gw = gateway;
});

/**
 * Build a header set including the auth token. `spawn-child` is an
 * ORCHESTRATION-class Children verb (the cookie does NOT bypass), so these
 * route-wiring tests authorize as the parent goal's team-lead — the
 * spawnedBy-cascade assertions still hold because the cascade reads the same
 * `X-Bobbit-Spawning-Session` / body fields independently of authz (`body`
 * tier 1 still beats the team-lead-matching header tier 2). See
 * `spawnChildRaw` below for the team-lead seeding.
 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		...(extra ?? {}),
	};
}

/**
 * Create a parent goal in a real git repo so it gets a worktree
 * (`worktreePath`, `repoPath`, `branch`). Use `autoStartTeam: false` so
 * the team-lead doesn't actually spawn — we only need the goal record.
 */
async function createParentGoal(): Promise<{ id: string; cwd: string; repoPath?: string; worktreePath?: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `spawn-child route parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			cwd: gitCwd(),
			autoStartTeam: false,
			workflowId: "feature",
		}),
	});
	expect(resp.status).toBe(201);
	const created = await resp.json();
	// Wait for setupStatus to settle — we need repoPath and worktreePath
	// stamped before the spawn-child handler reads them.
	const settled = await pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const g = await r.json();
			return g.setupStatus === "ready" && g.repoPath ? g : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `parent ${created.id} setup ready` },
	);
	return settled;
}

/** Read the persisted child goal directly via REST. */
async function readGoal(goalId: string): Promise<any> {
	const r = await apiFetch(`/api/goals/${goalId}`);
	expect(r.status).toBe(200);
	return r.json();
}

/**
 * POST to /api/goals/:id/spawn-child via rawApiFetch so we can pass
 * arbitrary headers (and not have the harness mutate the body).
 *
 * spawn-child is an ORCHESTRATION verb: it requires an
 * `X-Bobbit-Spawning-Session` (or `X-Bobbit-Session-Id`) header matching the
 * parent's authoritative team-lead. We seed the team-lead to match the authz
 * identity this call will use:
 *   - if the test supplies an explicit spawning/session header, the team-lead
 *     is seeded to THAT value (so the cascade assertion is unchanged), and
 *   - otherwise we inject a deterministic `e2e-tl-<parentId>` header and seed
 *     the team-lead to match.
 * Returns the established team-lead id so no-header/no-body cascade tests can
 * assert spawnedBySessionId resolves to it.
 */
async function spawnChildRaw(opts: {
	parentId: string;
	body: Record<string, unknown>;
	headers?: Record<string, string>;
}): Promise<{ status: number; body: any; teamLeadId: string }> {
	const explicit = opts.headers?.["X-Bobbit-Spawning-Session"]
		?? opts.headers?.["X-Bobbit-Session-Id"];
	const authzId = (explicit && explicit.trim()) ? explicit.trim() : `e2e-tl-${opts.parentId}`;
	// Establish the parent's team-lead to match `authzId` and register a
	// capability secret that resolves to it (idempotent).
	const tlHeader = seedTeamLeadHeader(gw, opts.parentId, authzId);
	// S1: authz is keyed off the unforgeable X-Bobbit-Session-Secret, NOT the
	// public spawning-session header. So we ALWAYS send the secret (it resolves
	// to `authzId`, which equals the seeded team-lead), while letting the test's
	// explicit public spawning/session header through verbatim so the
	// spawnedBy-cascade tier under test is exercised faithfully.
	const headers = authHeaders({
		// Always inject the public spawning header matching authzId (overridden
		// below by the test's explicit header, if any) + the auth secret.
		...tlHeader,
		...opts.headers,
	});
	const resp = await rawApiFetch(`/api/goals/${opts.parentId}/spawn-child`, {
		method: "POST",
		headers,
		body: JSON.stringify(opts.body),
	});
	const text = await resp.text();
	let body: any;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: resp.status, body, teamLeadId: authzId };
}

test.describe("POST /api/goals/:id/spawn-child — route wiring", () => {
	test("X-Bobbit-Spawning-Session header → stamps spawnedBySessionId @smoke", async () => {
		const parent = await createParentGoal();
		const sessionId = `sess-header-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Spawning-Session": sessionId },
				body: {
					planId: "plan-header-1",
					title: "Child via header",
					spec: "header-path child spec: verify X-Bobbit-Spawning-Session stamps spawnedBySessionId on the created child.",
				},
			});
			expect(status).toBe(201);
			expect(body.id).toBeTruthy();
			expect(body.spawnedBySessionId).toBe(sessionId);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(sessionId);
			expect(child.parentGoalId).toBe(parent.id);
			expect(child.spawnedFromPlanId).toBe("plan-header-1");

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("body.spawnedBySessionId fallback → stamped when no header", async () => {
		const parent = await createParentGoal();
		const sessionId = `sess-body-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				// The test supplies no spawning header; spawnChildRaw injects a
				// team-lead-matching one for authz, but body.spawnedBySessionId
				// (tier 1) still wins over that header (tier 2).
				body: {
					planId: "plan-body-1",
					title: "Child via body",
					spec: "body-fallback child spec: verify body spawnedBySessionId (tier 1) wins over the authz header (tier 2).",
					spawnedBySessionId: sessionId,
				},
			});
			expect(status).toBe(201);
			expect(body.spawnedBySessionId).toBe(sessionId);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(sessionId);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("body wins over header when both present (tier 1 beats tier 2)", async () => {
		// Cascade order per design: body.spawnedBySessionId is tier 1
		// (explicit caller claim); X-Bobbit-Spawning-Session header is tier 2.
		// Body wins. See src/server/agent/spawn-child-spawnedby.ts.
		const parent = await createParentGoal();
		const headerSession = `sess-header-${Date.now()}`;
		const bodySession = `sess-body-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Spawning-Session": headerSession },
				body: {
					planId: "plan-precedence-1",
					title: "Body-wins child",
					spec: "precedence test: confirm header spawnedBySessionId wins over body spawnedBySessionId field.",
					spawnedBySessionId: bodySession,
				},
			});
			expect(status).toBe(201);
			expect(body.spawnedBySessionId).toBe(bodySession);
			expect(body.spawnedBySessionId).not.toBe(headerSession);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(bodySession);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("suggestedRole body field → persisted on the child goal", async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-role-1",
					title: "Role-suggested child",
					spec: "suggested-role spec: verify suggestedRole is recorded on the spawned child goal correctly.",
					suggestedRole: "test-engineer",
				},
			});
			expect(status).toBe(201);
			// Response echoes the role back so callers can confirm it landed
			// (commit 7491041c — was previously void'd at server.ts:3356).
			expect(body.suggestedRole).toBe("test-engineer");

			const child = await readGoal(body.id);
			expect(child.suggestedRole).toBe("test-engineer");

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("spawnedFromPlanId is stamped atomically with createGoal (stamp `spawnedFromPlanId` IMMEDIATELY after createGoal — no awaits between)", async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-lesson-4-1",
					title: "stamp-immediately invariant child",
					spec: "lesson 4.1 spec: spawnedFromPlanId must be stamped synchronously before the REST handler returns.",
				},
			});
			expect(status).toBe(201);

			// The persisted record MUST carry spawnedFromPlanId — by the time
			// we can read it back through the REST API the synchronous
			// updateGoal that follows createGoal must have completed.
			const child = await readGoal(body.id);
			expect(child.spawnedFromPlanId).toBe("plan-lesson-4-1");
			expect(child.parentGoalId).toBe(parent.id);

			// Idempotency: a second call with the same planId must return the
			// same child id without creating a duplicate record (the handler's
			// idempotency branch keys on (parentGoalId, spawnedFromPlanId)).
			const second = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-lesson-4-1",
					title: "stamp-immediately invariant child",
					spec: "lesson 4.1 spec: second call with same planId must be idempotent and return the existing child.",
				},
			});
			expect(second.status).toBe(200);
			expect(second.body.alreadyExists).toBe(true);
			expect(second.body.id).toBe(body.id);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("child cwd derived from parent.repoPath, not parent.cwd (no nested -wt/)", async () => {
		const parent = await createParentGoal();
		// Sanity: the parent must have BOTH a worktreePath and a repoPath
		// for the invariant to be testable. If either is absent (e.g. the
		// harness env doesn't produce a worktree), the parent.repoPath-vs-
		// parent.cwd distinction collapses to a trivially-true tautology
		// and we skip cleanly. Note: we do NOT skip on parent.cwd ===
		// parent.repoPath because that's actually possible AND meaningful
		// (sub-package roots), but here we want a worktree-vs-root
		// difference, so both must be present.
		if (!parent.worktreePath || !parent.repoPath) {
			test.skip(true, `Parent missing worktree (worktreePath=${parent.worktreePath}, repoPath=${parent.repoPath})`);
			return;
		}

		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-repopath-1",
					title: "RepoPath child",
					spec: "repoPath derivation: when repoPath is omitted, derive it from the parent goal's repoPath.",
				},
			});
			expect(status).toBe(201);

			const child = await readGoal(body.id);
			// The handler's invariant: child.cwd is derived from
			// parent.repoPath (with monorepo offset preserved), NOT from
			// parent.cwd. The child gets its OWN worktree under the same
			// `<root>-wt/` parent — never under `<parent-worktree>-wt/`.
			expect(child.repoPath).toBe(parent.repoPath);
			// The child's own worktree path must NOT be a sub-path of the
			// parent's worktree path (which would mean the new repoPath
			// resolved through the parent's worktree).
			if (child.worktreePath) {
				expect(child.worktreePath.startsWith(parent.worktreePath)).toBe(false);
			}

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("setup is triggered: child does NOT sit in setupStatus=preparing forever", async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-setup-1",
					title: "Setup-triggered child",
					spec: "setup trigger smoke: verify spawn-child triggers worktree setup for the new child goal.",
				},
			});
			expect(status).toBe(201);
			const childId = body.id;

			// The showstopper bug from 0f7e6a64: the handler created the
			// child record but never called setupWorktreeAndStartTeam, so
			// the child's setupStatus stayed "preparing" forever. After the
			// fix, setup is initiated and the status moves off "preparing"
			// — either to "ready" (worktree created OK) or "error" (a
			// downstream step failed). The bug repro is "stays preparing
			// indefinitely"; either of the post-fix outcomes is enough to
			// confirm setup was actually initiated.
			const settled = await pollUntil(
				async () => {
					const g = await readGoal(childId);
					return g.setupStatus && g.setupStatus !== "preparing" ? g : null;
				},
				{ timeoutMs: 30_000, intervalMs: 100, label: `child ${childId} setupStatus moves off preparing` },
			);
			expect(settled.setupStatus === "ready" || settled.setupStatus === "error").toBe(true);

			await deleteGoal(childId);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("missing planId / title / spec → 400 with actionable error", async () => {
		const parent = await createParentGoal();
		try {
			// Missing planId
			const r1 = await spawnChildRaw({
				parentId: parent.id,
				body: { title: "no-planId", spec: "missing planId: actionable error spec body padded to meet validator minimum length." },
			});
			expect(r1.status).toBe(400);
			expect(String(r1.body.error || "")).toMatch(/planId/i);

			// Missing title
			const r2 = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-x", spec: "missing title: actionable error spec body padded to meet the spec validator minimum length." },
			});
			expect(r2.status).toBe(400);
			expect(String(r2.body.error || "")).toMatch(/title/i);

			// Missing spec
			const r3 = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-x", title: "title" },
			});
			expect(r3.status).toBe(400);
			expect(String(r3.body.error || "")).toMatch(/spec/i);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("team-lead spawn with no body override → spawnedBySessionId = team-lead (tier 2/4)", async () => {
		// Under the orchestration authz model a spawn-child is ALWAYS authorized
		// by a team-lead-matching X-Bobbit-Spawning-Session header, so the
		// spawnedBy cascade resolves to the team-lead (tier 2 header == team-lead)
		// when no body field overrides it. (The legacy "null spawnedBy" REST
		// branch is unreachable now that orchestration requires a header; the
		// tier-5 fallback is covered by the spawn-child-spawnedby unit test.)
		const parent = await createParentGoal();
		try {
			const { status, body, teamLeadId } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-absent-1",
					title: "Team-lead-stamped child",
					spec: "no body override: the authorizing team-lead session id is stamped as spawnedBySessionId via the header tier.",
				},
			});
			expect(status).toBe(201);
			expect(body.spawnedBySessionId).toBe(teamLeadId);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(teamLeadId);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("body.inlineRoles → snapshotted onto child goal record", async () => {
		const parent = await createParentGoal();
		try {
			const inlineRoles = {
				"synthesis-reviewer": {
					name: "synthesis-reviewer",
					label: "Synthesis Reviewer",
					promptTemplate: "You are a synthesis reviewer for this audit. {{AGENT_ID}}",
					accessory: "magnifying-glass",
				},
			};
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-inline-roles-1",
					title: "Inline-roles child",
					spec: "child with ephemeral synthesis-reviewer role attached via inlineRoles in the spawn-child request.",
					inlineRoles,
				},
			});
			expect(status).toBe(201);

			const child = await readGoal(body.id);
			expect(child.inlineRoles).toBeTruthy();
			expect(child.inlineRoles["synthesis-reviewer"].label).toBe("Synthesis Reviewer");
			expect(child.inlineRoles["synthesis-reviewer"].promptTemplate).toContain("synthesis reviewer");

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("inlineRoles inheritance: child inherits parent's inline roles, child overrides on collision", async () => {
		// Parent goal carries an inline 'reviewer' role.
		const parentInline = {
			reviewer: {
				name: "reviewer",
				label: "Parent's Reviewer",
				promptTemplate: "PARENT REVIEWER PROMPT",
				accessory: "none",
			},
			"audit-tester": {
				name: "audit-tester",
				label: "Parent's Audit Tester",
				promptTemplate: "PARENT AUDIT TESTER PROMPT",
				accessory: "none",
			},
		};
		const parentResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: `inherit parent ${Date.now()}`,
				cwd: gitCwd(),
				autoStartTeam: false,
				workflowId: "feature",
				inlineRoles: parentInline,
			}),
		});
		expect(parentResp.status).toBe(201);
		const parent = await parentResp.json();
		// Settle parent so spawn-child reads the inlineRoles back from disk.
		await pollUntil(
			async () => {
				const r = await apiFetch(`/api/goals/${parent.id}`);
				if (r.status !== 200) return null;
				const g = await r.json();
				return g.setupStatus === "ready" && g.repoPath ? g : null;
			},
			{ timeoutMs: 30_000, intervalMs: 100, label: `parent ${parent.id} setup ready` },
		);

		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-inherit-1",
					title: "Inherit child",
					spec: "child overrides reviewer; inherits audit-tester role from the parent goal's ephemeral roles.",
					inlineRoles: {
						reviewer: {
							name: "reviewer",
							label: "Child's Reviewer",
							promptTemplate: "CHILD REVIEWER PROMPT",
							accessory: "none",
						},
					},
				},
			});
			expect(status).toBe(201);

			const child = await readGoal(body.id);
			expect(child.inlineRoles).toBeTruthy();
			// reviewer: child wins on collision
			expect(child.inlineRoles.reviewer.label).toBe("Child's Reviewer");
			expect(child.inlineRoles.reviewer.promptTemplate).toBe("CHILD REVIEWER PROMPT");
			// audit-tester: inherited from parent (child didn't redefine)
			expect(child.inlineRoles["audit-tester"]).toBeTruthy();
			expect(child.inlineRoles["audit-tester"].label).toBe("Parent's Audit Tester");

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("X-Bobbit-Session-Id header (tier 3 — defence in depth) → stamps spawnedBySessionId", async () => {
		// Defence-in-depth: when neither the explicit body field nor the
		// children-tools-extension `X-Bobbit-Spawning-Session` header is
		// present, the cascade falls back to `X-Bobbit-Session-Id` — the
		// generic agent-session header set by every other tool extension
		// (MCP, read_session, …). A raw cURL spawn issued from inside an
		// agent therefore stamps correctly even without explicit opt-in.
		const parent = await createParentGoal();
		const sessionId = `agent-sess-tier3-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Session-Id": sessionId },
				body: {
					planId: "plan-tier3-1",
					title: "Tier-3 child",
					spec: "defence-in-depth tier 3: verify project-level ephemeral roles flow down into spawned children.",
				},
			});
			expect(status).toBe(201);
			expect(body.spawnedBySessionId).toBe(sessionId);

			const child = await readGoal(body.id);
			expect(child.spawnedBySessionId).toBe(sessionId);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("X-Bobbit-Spawning-Session beats X-Bobbit-Session-Id (tier 2 > tier 3)", async () => {
		const parent = await createParentGoal();
		const spawning = `spawning-${Date.now()}`;
		const generic = `generic-${Date.now()}`;
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				headers: {
					"X-Bobbit-Spawning-Session": spawning,
					"X-Bobbit-Session-Id": generic,
				},
				body: {
					planId: "plan-tier-precedence-1",
					title: "Tier-precedence child",
					spec: "tier 2 wins over tier 3: parent-level ephemeral roles override project-level same-named roles.",
				},
			});
			expect(status).toBe(201);
			expect(body.spawnedBySessionId).toBe(spawning);

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("body.workflow inline → child snapshots its own workflow (bypasses store)", async () => {
		const parent = await createParentGoal();
		try {
			const inlineWorkflow = {
				id: "audit-mini",
				name: "Audit Mini",
				description: "ephemeral audit-only workflow",
				gates: [
					{ id: "gather", name: "Gather Inputs", dependsOn: [] },
					{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["gather"] },
				],
				createdAt: 0,
				updatedAt: 0,
			};
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-inline-wf-1",
					title: "Inline-workflow child",
					spec: "child with ephemeral workflow attached via inlineWorkflow on the spawn-child request body.",
					workflow: inlineWorkflow,
				},
			});
			expect(status).toBe(201);

			const child = await readGoal(body.id);
			expect(child.workflow).toBeTruthy();
			expect(child.workflow.id).toBe("audit-mini");
			expect(child.workflow.gates.length).toBe(2);
			expect(child.workflow.gates[0].id).toBe("gather");

			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});
});

/**
 * Route-level spec validation — POST /api/goals/:id/spawn-child.
 *
 * Pins the HTTP 400 contract so a wiring regression in nested-goal-routes.ts
 * is caught here, not just in the unit tests for the pure helper.
 */
test.describe("POST /spawn-child spec validation (route-level)", () => {
	test(`spec: 'placeholder' → 400 SPEC_PLACEHOLDER @smoke`, async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-ph", title: "T", spec: "placeholder" },
			});
			expect(status).toBe(400);
			expect(body.code).toBe("SPEC_PLACEHOLDER");
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test(`spec: 'todo' → 400 SPEC_PLACEHOLDER`, async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-td", title: "T", spec: "todo" },
			});
			expect(status).toBe(400);
			expect(body.code).toBe("SPEC_PLACEHOLDER");
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test(`spec shorter than 50 chars → 400 SPEC_TOO_SHORT`, async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-sh", title: "T", spec: "too short" },
			});
			expect(status).toBe(400);
			expect(body.code).toBe("SPEC_TOO_SHORT");
			expect(body.actualLength).toBeLessThan(50);
			expect(body.minLength).toBe(50);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test(`spec missing → 400 (spec required, no regression)`, async () => {
		const parent = await createParentGoal();
		try {
			const { status } = await spawnChildRaw({
				parentId: parent.id,
				body: { planId: "plan-ms", title: "T" },
			});
			expect(status).toBe(400);
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test(`valid spec (≥50 chars) → 201 success`, async () => {
		const parent = await createParentGoal();
		try {
			const { status, body } = await spawnChildRaw({
				parentId: parent.id,
				body: {
					planId: "plan-valid",
					title: "Valid child",
					spec: "Implement the feature described in the parent goal spec (this spec is exactly fifty-one characters).",
				},
			});
			expect(status).toBe(201);
			expect(body.id).toBeTruthy();
			await deleteGoal(body.id);
		} finally {
			await deleteGoal(parent.id);
		}
	});
});

test.describe("POST /api/goals/:id/spawn-child — S1 capability-secret forgery regression", () => {
	// The HIGH finding: orchestration trusted the PUBLIC X-Bobbit-Spawning-
	// Session header, which any token holder could read and replay. These tests
	// pin that a forged public header is now USELESS without the per-session
	// secret. The team-lead is seeded with a registered secret; the attacker
	// replays only the (discoverable) public team-lead id.
	test("correct public team-lead header but NO secret → 403 (forgery blocked)", async () => {
		const parent = await createParentGoal();
		try {
			// Seed the team-lead + its capability secret, then DISCARD the secret:
			// the attacker only knows the public team-lead session id.
			const seeded = seedTeamLeadHeader(gw, parent.id);
			const publicTeamLeadId = seeded["X-Bobbit-Spawning-Session"];
			expect(publicTeamLeadId).toBeTruthy();

			const resp = await rawApiFetch(`/api/goals/${parent.id}/spawn-child`, {
				method: "POST",
				headers: authHeaders({ "X-Bobbit-Spawning-Session": publicTeamLeadId }),
				body: JSON.stringify({
					planId: "forge-1",
					title: "Forged spawn",
					spec: "forgery regression: a replayed public team-lead header with no capability secret must be refused server-side.",
				}),
			});
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_TEAM_LEAD");
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("correct public team-lead header + FOREIGN secret → 403 (mismatch)", async () => {
		const parent = await createParentGoal();
		try {
			const seeded = seedTeamLeadHeader(gw, parent.id);
			const publicTeamLeadId = seeded["X-Bobbit-Spawning-Session"];
			// A valid-but-foreign secret resolving to the attacker's OWN session.
			const foreignSecret = gw.sessionManager.sessionSecretStore.getOrCreateSecret(
				`attacker-${parent.id}`,
			);

			const resp = await rawApiFetch(`/api/goals/${parent.id}/spawn-child`, {
				method: "POST",
				headers: authHeaders({
					"X-Bobbit-Spawning-Session": publicTeamLeadId,
					"X-Bobbit-Session-Secret": foreignSecret,
				}),
				body: JSON.stringify({
					planId: "forge-2",
					title: "Forged spawn 2",
					spec: "forgery regression: a foreign capability secret (not the team-lead's) must not authorize spawning despite the replayed public header.",
				}),
			});
			expect(resp.status).toBe(403);
			const body = await resp.json();
			expect(body.code).toBe("NOT_TEAM_LEAD");
		} finally {
			await deleteGoal(parent.id);
		}
	});

	test("the team-lead's own secret → 201 (authentic caller authorized)", async () => {
		const parent = await createParentGoal();
		let childId: string | undefined;
		try {
			// Both headers from the seam (public id + matching secret) authorize.
			const headers = seedTeamLeadHeader(gw, parent.id);
			const resp = await rawApiFetch(`/api/goals/${parent.id}/spawn-child`, {
				method: "POST",
				headers: authHeaders(headers),
				body: JSON.stringify({
					planId: "authentic-1",
					title: "Authentic spawn",
					spec: "forgery regression positive case: the team-lead's own capability secret resolves to the authentic caller and authorizes spawn-child.",
				}),
			});
			expect(resp.status).toBe(201);
			const body = await resp.json();
			expect(body.id).toBeTruthy();
			childId = body.id;
		} finally {
			if (childId) await deleteGoal(childId);
			await deleteGoal(parent.id);
		}
	});
});

