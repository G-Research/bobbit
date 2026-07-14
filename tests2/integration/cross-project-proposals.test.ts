/**
 * API integration — cross-project proposal seed resolver.
 *
 * Design: docs/design/cross-project-proposals.md §1, §2, §3, §6.
 *
 * A `propose_*` seed may target a DIFFERENT project than the session's via the
 * optional `projectId`. The seed endpoint resolves the TARGET uniformly:
 *   - omitted  → session's project (system → headquarters);
 *   - explicit → validated against the registry and stamped onto the draft;
 *   - unknown  → 422 UNKNOWN_PROJECT (goal/role/tool/staff);
 *   - `project` proposals are exempt — they may name a brand-new project.
 *
 * Acceptance covered here:
 *   (a) omitted projectId → session project (incl. system → headquarters)
 *   (b) explicit valid cross-project accepted for goal/role/tool/staff/project
 *   (c) explicit unknown → 422 UNKNOWN_PROJECT for goal/role/tool/staff
 *   (d) unknown projectId allowed at seed for a brand-new propose_project
 *   (e) goal workflow validated against the TARGET project's workflows
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import {
	apiFetch,
	rawApiFetch,
	createSession,
	deleteSession,
	createGoal,
	deleteGoal,
	defaultProjectId,
	registerProject,
} from "./_e2e/e2e-setup.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const SYSTEM_PROJECT_ID = "system";

const cleanupRoots: string[] = [];

function projectDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bobbit-xproj-${prefix}-`));
	cleanupRoots.push(dir);
	fs.writeFileSync(path.join(dir, "README.md"), "# cross-project target\n");
	try { return fs.realpathSync(dir); } catch { return dir; }
}

/** A workflow id that exists ONLY in the target project (never in the default). */
const TARGET_WORKFLOWS = {
	"target-only": {
		id: "target-only",
		name: "Target Only",
		description: "Workflow present only in the cross-project target.",
		gates: [
			{ id: "implementation", name: "Implementation", verify: [{ name: "Check", type: "command", run: "echo ok" }] },
			{ id: "ready-to-merge", name: "Ready to Merge", depends_on: ["implementation"], verify: [{ name: "PR raised", type: "command", run: "echo ok" }] },
		],
	},
};

async function seed(sid: string, type: string, args: Record<string, unknown>): Promise<Response> {
	return apiFetch(`/api/sessions/${sid}/proposal/${type}/seed`, {
		method: "POST",
		body: JSON.stringify({ args }),
	});
}

async function seededFields(sid: string, type: string): Promise<Record<string, unknown> | undefined> {
	const resp = await apiFetch(`/api/sessions/${sid}/proposals`);
	expect(resp.status).toBe(200);
	const body = await resp.json() as { proposals?: Array<{ proposalType?: string; fields?: Record<string, unknown> }> };
	return body.proposals?.find(p => p.proposalType === type)?.fields;
}

const VALID_ARGS: Record<string, Record<string, unknown>> = {
	goal: { title: "X-Proj Goal", spec: "body\n", workflow: "target-only" },
	role: { name: "xproj-role", label: "X Role", prompt: "do things" },
	tool: { tool: "xproj-tool", action: "create", content: "name: xproj-tool\n" },
	staff: { name: "xproj-staff", prompt: "help out" },
};

test.describe("cross-project proposal seed @smoke", () => {
	let sid: string;
	let targetProjectId: string;
	let defaultPid: string;

	test.beforeAll(async () => {
		sid = await createSession();
		defaultPid = (await defaultProjectId())!;
		const project = await registerProject({
			name: `xproj-target-${Date.now()}`,
			rootPath: projectDir("target"),
			seedWorkflows: false,
		});
		targetProjectId = project.id;
		// The default project already carries the harness workflows (feature,
		// general, …). Give the target a DISTINCT workflow so §2/§e can prove the
		// goal validation resolves against the target, not the session's project.
		const cfg = await apiFetch(`/api/projects/${targetProjectId}/config`, {
			method: "PUT",
			body: JSON.stringify({
				components: [{ name: "test", repo: ".", commands: { build: "echo ok" } }],
				workflows: TARGET_WORKFLOWS,
			}),
		});
		expect(cfg.status, `seed target workflows: ${await cfg.text()}`).toBe(200);
	});

	test.afterAll(async () => {
		await deleteSession(sid);
		for (const dir of cleanupRoots.splice(0)) {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	// ── (a) omitted projectId → session's project ──────────────────────
	test("(a) omitted projectId stamps the session project for goal/role/tool/staff", async () => {
		const s = await createSession();
		try {
			for (const type of ["goal", "role", "tool", "staff"] as const) {
				const args = type === "goal" ? { title: "Def Goal", spec: "body\n", workflow: "feature" } : VALID_ARGS[type];
				const r = await seed(s, type, args);
				expect(r.status, `${type} omitted seed: ${await r.clone().text()}`).toBe(200);
				const fields = await seededFields(s, type);
				expect(fields?.projectId, `${type} default stamp`).toBe(defaultPid);
			}
		} finally {
			await deleteSession(s);
		}
	});

	// ── (a) system → headquarters default mapping ──────────────────────
	test("(a) system-scope session default maps to headquarters", async () => {
		// A role assistant created with a cwd outside any project resolves to the
		// synthetic `system` project (see role-assistant-session.test.ts). An
		// omitted-projectId seed must default to the user-facing headquarters
		// scope, never the hidden `system` id.
		const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-xproj-system-"));
		cleanupRoots.push(bogusCwd);
		const created = await rawApiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ assistantType: "role", cwd: bogusCwd }),
		});
		expect(created.status, `create system-scope role session: ${await created.clone().text()}`).toBe(201);
		const systemSid = (await created.json()).id as string;
		try {
			const r = await seed(systemSid, "role", VALID_ARGS.role);
			expect(r.status, `system-scope role seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(systemSid, "role");
			expect(fields?.projectId).toBe(HEADQUARTERS_PROJECT_ID);
		} finally {
			await rawApiFetch(`/api/sessions/${systemSid}`, { method: "DELETE" }).catch(() => {});
		}
	});

	// ── (b) explicit valid cross-project ───────────────────────────────
	test("(b) explicit valid cross-project projectId is accepted and stamped for goal/role/tool/staff", async () => {
		const s = await createSession();
		try {
			for (const type of ["goal", "role", "tool", "staff"] as const) {
				const r = await seed(s, type, { ...VALID_ARGS[type], projectId: targetProjectId });
				expect(r.status, `${type} cross-project seed: ${await r.clone().text()}`).toBe(200);
				const fields = await seededFields(s, type);
				expect(fields?.projectId, `${type} cross-project stamp`).toBe(targetProjectId);
			}
		} finally {
			await deleteSession(s);
		}
	});

	test("(b) explicit valid cross-project projectId is accepted for propose_project", async () => {
		const s = await createSession();
		try {
			const r = await seed(s, "project", { name: "X-Proj Edit", root_path: "/tmp/xproj", projectId: targetProjectId });
			expect(r.status, `project cross-project seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.projectId).toBe(targetProjectId);
		} finally {
			await deleteSession(s);
		}
	});

	// ── propose_project root_path is conditional (edit vs create) ──────
	// Requirement 4 / design §3: editing an existing registered project via an
	// explicit projectId does not require root_path (the server already knows
	// it); a brand-new CREATE (no projectId) still requires root_path.
	test("propose_project with explicit registered projectId seeds WITHOUT root_path (edit)", async () => {
		const s = await createSession();
		try {
			const r = await seed(s, "project", { name: "Edit Existing", projectId: targetProjectId });
			expect(r.status, `project edit seed (no root_path): ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.projectId).toBe(targetProjectId);
			expect(fields?.root_path).toBeUndefined();
		} finally {
			await deleteSession(s);
		}
	});

	test("propose_project with NO projectId and NO root_path is rejected (create requires root_path)", async () => {
		const s = await createSession();
		try {
			const r = await seed(s, "project", { name: "New No Root" });
			// A missing required field is caught by writeProposalFile's serialize
			// validation and surfaced as a 500 (same as any other missing required
			// field at seed); the important invariant is that CREATE without
			// root_path never produces a valid draft.
			const text = await r.text();
			expect(r.status, `project create seed (no root_path) must fail: ${text}`).not.toBe(200);
			expect(text).toMatch(/root_path/);
			// And no valid draft was persisted.
			const fields = await seededFields(s, "project");
			expect(fields).toBeUndefined();
		} finally {
			await deleteSession(s);
		}
	});

	test("propose_project brand-new with name + root_path still seeds (create)", async () => {
		const s = await createSession();
		try {
			const r = await seed(s, "project", { name: "Brand New Create", root_path: "/tmp/brand-new-create" });
			expect(r.status, `project create seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.root_path).toBe("/tmp/brand-new-create");
		} finally {
			await deleteSession(s);
		}
	});

	// ── (c) explicit unknown → 422 UNKNOWN_PROJECT ─────────────────────
	test("(c) explicit unknown projectId → 422 UNKNOWN_PROJECT for goal/role/tool/staff", async () => {
		const s = await createSession();
		try {
			for (const type of ["goal", "role", "tool", "staff"] as const) {
				const r = await seed(s, type, { ...VALID_ARGS[type], projectId: "does-not-exist-project" });
				expect(r.status, `${type} unknown seed`).toBe(422);
				const body = await r.json();
				expect(body.ok).toBe(false);
				expect(body.code).toBe("UNKNOWN_PROJECT");
			}
		} finally {
			await deleteSession(s);
		}
	});

	// ── (c') explicit hidden/system target → 422 UNKNOWN_PROJECT ───────
	// The synthetic `system` project IS registered (hidden: true), but it is not
	// a user-facing cross-project target. The system→headquarters mapping is for
	// the OMITTED default only; an EXPLICIT `system` must be rejected.
	test("(c') explicit hidden `system` projectId → 422 UNKNOWN_PROJECT for goal/role/tool/staff", async () => {
		const s = await createSession();
		try {
			for (const type of ["goal", "role", "tool", "staff"] as const) {
				const r = await seed(s, type, { ...VALID_ARGS[type], projectId: SYSTEM_PROJECT_ID });
				expect(r.status, `${type} explicit system seed`).toBe(422);
				const body = await r.json();
				expect(body.ok).toBe(false);
				expect(body.code).toBe("UNKNOWN_PROJECT");
				// No valid draft was persisted for the hidden target.
				expect(await seededFields(s, type)).toBeUndefined();
			}
		} finally {
			await deleteSession(s);
		}
	});

	// ── (d) unknown projectId allowed at seed for propose_project ──────
	test("(d) unknown projectId is allowed at seed for a brand-new propose_project", async () => {
		const s = await createSession();
		try {
			const r = await seed(s, "project", { name: "Brand New", root_path: "/tmp/brand-new", projectId: "not-yet-registered" });
			expect(r.status, `project unknown seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.projectId).toBe("not-yet-registered");
		} finally {
			await deleteSession(s);
		}
	});

	// ── (e) goal workflow validated against the TARGET project ─────────
	test("(e) goal workflow is validated against the target project's workflows", async () => {
		const s = await createSession();
		try {
			// The target has `target-only` but NOT `feature`; the session's default
			// project has `feature` but NOT `target-only`.
			const okResp = await seed(s, "goal", { title: "Target WF", spec: "body\n", workflow: "target-only", projectId: targetProjectId });
			expect(okResp.status, `target workflow accepted: ${await okResp.clone().text()}`).toBe(200);
			expect((await seededFields(s, "goal"))?.projectId).toBe(targetProjectId);

			// `feature` is valid in the SESSION's project but unknown to the TARGET —
			// must be rejected, proving validation resolves against the target.
			const badResp = await seed(s, "goal", { title: "Session WF", spec: "body\n", workflow: "feature", projectId: targetProjectId });
			expect(badResp.status).toBe(400);
			const body = await badResp.json();
			expect(body.code).toBe("UNKNOWN_WORKFLOW");
			const ids = (body.availableWorkflows ?? []).map((w: { id?: string }) => w.id);
			expect(ids).toContain("target-only");
			expect(ids).not.toContain("feature");
		} finally {
			await deleteSession(s);
		}
	});
});

/**
 * PR #1005 (Bug hunt, high) — team-lead parent auto-injection must NOT fire for a
 * CROSS-PROJECT goal proposal.
 *
 * For a team-lead session whose current goal can spawn children, the seed handler
 * auto-injects `parentGoalId = teamGoalId` when the proposal omits one. That inject
 * runs AFTER §1 stamps the resolved TARGET project. If the target names a DIFFERENT
 * project, the injected parent belongs to the SOURCE project, so on accept
 * POST /api/goals rejects it with PARENT_CROSS_PROJECT. The fix guards the inject on
 * a same-project check (parent.projectId === enrichedArgs.projectId); cross-project
 * goals stay top-level. The same-project / no-explicit-target path is unchanged.
 */
test.describe("team-lead parent inject vs cross-project target (PR #1005) @smoke", () => {
	let gw: any;
	let leadSid: string;
	let parentGoalId: string;
	let injectTargetProjectId: string;

	test.beforeAll(async ({ gateway }) => {
		gw = gateway;
		// A spawn-capable parent goal in the SESSION's (default) project.
		const defaultPid = (await defaultProjectId())!;
		const parent = await createGoal({
			title: `xproj-inject-parent ${Date.now()}`,
			workflowId: "feature",
			subgoalsAllowed: true,
			projectId: defaultPid,
		});
		parentGoalId = parent.id as string;

		// A DIFFERENT registered project with NO workflows, so goal-workflow
		// validation is skipped for the cross-project draft and this test isolates
		// the parent-inject guard alone.
		const project = await registerProject({
			name: `xproj-inject-target-${Date.now()}`,
			rootPath: projectDir("inject-target"),
			seedWorkflows: false,
		});
		injectTargetProjectId = project.id;

		// Promote the session to a team-lead whose team goal is the spawn-capable
		// parent. getSession returns the live SessionInfo; mutate role/teamGoalId in
		// place (mirrors a real team-lead session as seen by the seed handler).
		leadSid = await createSession();
		const sess = gw.sessionManager.getSession(leadSid);
		expect(sess, "team-lead session must be live in the manager").toBeTruthy();
		sess.role = "team-lead";
		sess.teamGoalId = parentGoalId;
	});

	test.afterAll(async () => {
		await deleteSession(leadSid);
		await deleteGoal(parentGoalId);
	});

	test("(same-project) team-lead goal proposal STILL auto-injects the parent", async () => {
		const r = await seed(leadSid, "goal", { title: "Same-Proj Child", spec: "body\n", workflow: "feature" });
		expect(r.status, `same-project team-lead seed: ${await r.clone().text()}`).toBe(200);
		const fields = await seededFields(leadSid, "goal");
		expect(fields?.parentGoalId, "same-project proposal must auto-inject the team-lead parent").toBe(parentGoalId);
	});

	test("(cross-project) team-lead goal proposal stays TOP-LEVEL (no parent inject)", async () => {
		const r = await seed(leadSid, "goal", { title: "Cross-Proj Child", spec: "body\n", projectId: injectTargetProjectId });
		expect(r.status, `cross-project team-lead seed: ${await r.clone().text()}`).toBe(200);
		const fields = await seededFields(leadSid, "goal");
		expect(fields?.projectId, "cross-project stamp").toBe(injectTargetProjectId);
		expect(
			fields?.parentGoalId,
			"cross-project proposal must NOT inject a source-project parent (would fail accept with PARENT_CROSS_PROJECT)",
		).toBeUndefined();
	});
});
