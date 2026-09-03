/**
 * `POST /api/goals/:id/spawn-child` — retained route-level integration journeys.
 *
 * The former 22-case matrix repeated parent creation and team/worktree startup
 * for assertions whose permutations are pinned deterministically below the E2E
 * tier. These journeys retain every real boundary in fewer isolated lifecycles:
 *
 *   - HTTP/auth capability boundary and spawned-by header precedence;
 *   - goal persistence, idempotency, inherited/inline workflow and role state;
 *   - dependency blocking and the scheduler start boundary;
 *   - canonical validation and actionable failure responses;
 *   - real Git repository/worktree derivation, setup, and archive cleanup.
 *
 * Exact lower-tier matrices remain in:
 *   - api-spawn-child-spawnedby-derivation.unit.test.ts (all cascade tiers);
 *   - api-spawn-child-spec-validation.unit.test.ts (all spec permutations);
 *   - nested-goal-routes-findings.unit.test.ts (route auth, validation,
 *     workflow/roles, idempotency, cwd preflight, and mutation boundaries);
 *   - goal-spawn-child-dependsOn-blocking.unit.test.ts and
 *     nested-goal-routes-concurrency.unit.test.ts (dependency/scheduler/archive).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../in-process-harness.js";
import {
	apiFetch,
	deleteGoal,
	nonGitCwd,
	rawApiFetch,
	readE2EToken,
	registerProject,
	seedTeamLeadHeader,
} from "../e2e-setup.js";
import { awaitableRm, pollUntil } from "../test-utils/cleanup.js";

let token: string;
let fixtureRoot: string;
let gitProjectId: string;
let gitProjectRoot: string;
let gw: any;

test.beforeAll(async ({ gateway }) => {
	token = readE2EToken();
	gw = gateway;
	fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-spawn-child-route-"));
	const repoRoot = join(fixtureRoot, "repo");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "README.md"), "# Spawn-child route E2E fixture\n");
	for (const args of [
		["init", "--quiet"],
		["config", "user.name", "Bobbit E2E"],
		["config", "user.email", "bobbit-e2e@example.test"],
		["add", "."],
		["commit", "--quiet", "-m", "init"],
	]) execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
	const nativeRoot = realpathSync.native(repoRoot);
	const project = await registerProject({
		name: `spawn-child-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		rootPath: nativeRoot,
	});
	gitProjectId = project.id;
	gitProjectRoot = project.rootPath;
	expect(gitProjectId).toBeTruthy();
	expect(gitProjectRoot).toBe(nativeRoot);
});

test.afterAll(async () => {
	if (gitProjectId) {
		const response = await apiFetch(`/api/projects/${encodeURIComponent(gitProjectId)}`, { method: "DELETE" });
		expect(response.status, await response.text()).toBe(200);
	}
	if (fixtureRoot) {
		const cleanup = await awaitableRm(fixtureRoot);
		expect(cleanup.removed, String(cleanup.lastError ?? "fixture cleanup failed")).toBe(true);
	}
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		...(extra ?? {}),
	};
}

async function createParentGoal(options: {
	realWorktree?: boolean;
	inlineRoles?: Record<string, unknown>;
} = {}): Promise<{ id: string; cwd: string; repoPath?: string; worktreePath?: string }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `spawn-child route parent ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			...(options.realWorktree
				? { cwd: gitProjectRoot, projectId: gitProjectId }
				: { cwd: nonGitCwd(), worktree: false }),
			autoStartTeam: false,
			workflowId: "feature",
			...(options.inlineRoles ? { inlineRoles: options.inlineRoles } : {}),
		}),
	});
	expect(resp.status, await resp.clone().text()).toBe(201);
	const created = await resp.json();
	return pollUntil(
		async () => {
			const r = await apiFetch(`/api/goals/${created.id}`);
			if (r.status !== 200) return null;
			const goal = await r.json();
			return goal.setupStatus === "ready" ? goal : null;
		},
		{ timeoutMs: 30_000, intervalMs: 100, label: `parent ${created.id} setup ready` },
	);
}

async function readGoal(goalId: string): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}`);
	expect(response.status).toBe(200);
	return response.json();
}

/**
 * Authorize as the parent's seeded team lead without injecting a public
 * spawning header when the caller explicitly supplies only the generic
 * session-id header. Keeping the secret and public attribution headers
 * separate lets the retained route journey genuinely cross tiers 2 and 3.
 */
async function spawnChildRaw(options: {
	parentId: string;
	body: Record<string, unknown>;
	headers?: Record<string, string>;
}): Promise<{ status: number; body: any; teamLeadId: string }> {
	const explicitSpawning = options.headers?.["X-Bobbit-Spawning-Session"]?.trim();
	const explicitSession = options.headers?.["X-Bobbit-Session-Id"]?.trim();
	const teamLeadId = explicitSpawning || explicitSession || `e2e-tl-${options.parentId}`;
	const seeded = seedTeamLeadHeader(gw, options.parentId, teamLeadId);
	const headers = authHeaders({
		...(!explicitSpawning && !explicitSession
			? { "X-Bobbit-Spawning-Session": teamLeadId }
			: {}),
		"X-Bobbit-Session-Secret": seeded["X-Bobbit-Session-Secret"],
		...options.headers,
	});
	const response = await rawApiFetch(`/api/goals/${options.parentId}/spawn-child`, {
		method: "POST",
		headers,
		body: JSON.stringify(options.body),
	});
	const text = await response.text();
	let body: any;
	try { body = text ? JSON.parse(text) : null; } catch { body = text; }
	return { status: response.status, body, teamLeadId };
}

const validSpec = (label: string) =>
	`${label}: exercise the spawn-child route through the real gateway, goal store, scheduler, and cleanup boundaries.`;

const parentRoles = {
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

test("spawn-child persists attribution, snapshots, dependencies, and idempotency @smoke", async () => {
	const parent = await createParentGoal({ inlineRoles: parentRoles });
	try {
		let firstChildId = "";
		await test.step("tier 2 beats tier 3 and starts one scheduler-owned child", async () => {
			const spawning = `spawning-${Date.now()}`;
			const generic = `generic-${Date.now()}`;
			const created = await spawnChildRaw({
				parentId: parent.id,
				headers: {
					"X-Bobbit-Spawning-Session": spawning,
					"X-Bobbit-Session-Id": generic,
				},
				body: {
					planId: "route-header",
					title: "Header-attributed child",
					spec: validSpec("Tier 2 attribution"),
					suggestedRole: "test-engineer",
				},
			});
			expect(created.status).toBe(201);
			expect(created.body.spawnedBySessionId).toBe(spawning);
			expect(created.body.suggestedRole).toBe("test-engineer");
			expect(created.body.blocked).toBeUndefined();
			firstChildId = created.body.id;

			const child = await readGoal(firstChildId);
			expect(child.parentGoalId).toBe(parent.id);
			expect(child.spawnedFromPlanId).toBe("route-header");
			expect(child.spawnedBySessionId).toBe(spawning);
			expect(child.suggestedRole).toBe("test-engineer");
			expect(child.workflowId).toBe("feature");
			expect(child.workflow?.id).toBe("feature");
			expect(child.inlineRoles.reviewer.label).toBe("Parent's Reviewer");
			expect(child.inlineRoles["audit-tester"].label).toBe("Parent's Audit Tester");

			const replay = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Spawning-Session": spawning },
				body: {
					planId: "route-header",
					title: "Header-attributed child",
					spec: validSpec("Idempotent replay"),
				},
			});
			expect(replay.status).toBe(200);
			expect(replay.body).toEqual({ id: firstChildId, alreadyExists: true });
		});

		await test.step("body attribution and inline snapshots persist on a dependency-blocked child", async () => {
			const bodySession = `body-${Date.now()}`;
			const headerSession = `header-${Date.now()}`;
			const inlineWorkflow = {
				id: "audit-mini",
				name: "Audit Mini",
				description: "ephemeral audit-only workflow",
				gates: [
					{ id: "gather", name: "Gather Inputs", dependsOn: [] },
					{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["gather"] },
				],
			};
			const created = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Spawning-Session": headerSession },
				body: {
					planId: "route-body",
					title: "Body-attributed child",
					spec: validSpec("Tier 1 attribution and inline snapshots"),
					spawnedBySessionId: bodySession,
					dependsOn: ["route-header"],
					workflow: inlineWorkflow,
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
			expect(created.status).toBe(201);
			expect(created.body.spawnedBySessionId).toBe(bodySession);
			expect(created.body.spawnedBySessionId).not.toBe(headerSession);
			expect(created.body.blocked).toBe(true);
			expect(created.body.pendingDeps).toEqual(["route-header"]);

			const child = await readGoal(created.body.id);
			expect(child.state).toBe("blocked");
			expect(child.paused).not.toBe(true);
			expect(child.dependsOnPlanIds).toEqual(["route-header"]);
			expect(child.workflowId).toBe("audit-mini");
			expect(child.workflow?.gates.map((gate: any) => gate.id)).toEqual(["gather", "ready-to-merge"]);
			expect(child.inlineRoles.reviewer.label).toBe("Child's Reviewer");
			expect(child.inlineRoles["audit-tester"].label).toBe("Parent's Audit Tester");
		});

		await test.step("tier 3 generic session attribution crosses the HTTP route", async () => {
			const sessionId = `generic-only-${Date.now()}`;
			const created = await spawnChildRaw({
				parentId: parent.id,
				headers: { "X-Bobbit-Session-Id": sessionId },
				body: {
					planId: "route-tier-3",
					title: "Generic-session child",
					spec: validSpec("Tier 3 attribution"),
					dependsOn: ["route-header"],
				},
			});
			expect(created.status).toBe(201);
			expect(created.body.spawnedBySessionId).toBe(sessionId);
			expect(created.body.blocked).toBe(true);
			const child = await readGoal(created.body.id);
			expect(child.spawnedBySessionId).toBe(sessionId);
			expect(child.dependsOnPlanIds).toEqual(["route-header"]);
		});
	} finally {
		await deleteGoal(parent.id);
	}
});

test("spawn-child rejects forged callers and invalid request matrices before mutation", async () => {
	const parent = await createParentGoal();
	try {
		await test.step("public identity without the team-lead capability is rejected", async () => {
			const seeded = seedTeamLeadHeader(gw, parent.id);
			const publicTeamLeadId = seeded["X-Bobbit-Spawning-Session"];
			const noSecret = await rawApiFetch(`/api/goals/${parent.id}/spawn-child`, {
				method: "POST",
				headers: authHeaders({ "X-Bobbit-Spawning-Session": publicTeamLeadId }),
				body: JSON.stringify({
					planId: "forged-no-secret",
					title: "Forged spawn",
					spec: validSpec("Forged public identity"),
				}),
			});
			expect(noSecret.status).toBe(403);
			expect((await noSecret.json()).code).toBe("NOT_TEAM_LEAD");

			const foreignSecret = gw.sessionManager.sessionSecretStore.getOrCreateSecret(`attacker-${parent.id}`);
			const mismatch = await rawApiFetch(`/api/goals/${parent.id}/spawn-child`, {
				method: "POST",
				headers: authHeaders({
					"X-Bobbit-Spawning-Session": publicTeamLeadId,
					"X-Bobbit-Session-Secret": foreignSecret,
				}),
				body: JSON.stringify({
					planId: "forged-foreign-secret",
					title: "Foreign-secret spawn",
					spec: validSpec("Foreign capability"),
				}),
			});
			expect(mismatch.status).toBe(403);
			expect((await mismatch.json()).code).toBe("NOT_TEAM_LEAD");
		});

		await test.step("required fields return actionable 400 responses", async () => {
			const cases = [
				{
					body: { title: "Missing plan", spec: validSpec("Missing plan identifier") },
					error: /planId/i,
				},
				{
					body: { planId: "missing-title", spec: validSpec("Missing title") },
					error: /title/i,
				},
				{
					body: { planId: "missing-spec", title: "Missing spec" },
					error: /spec/i,
				},
			];
			for (const entry of cases) {
				const result = await spawnChildRaw({ parentId: parent.id, body: entry.body });
				expect(result.status).toBe(400);
				expect(String(result.body.error ?? "")).toMatch(entry.error);
			}
		});

		await test.step("spec validation codes and length details survive route serialization", async () => {
			const cases = [
				{ planId: "placeholder", spec: "placeholder", code: "SPEC_PLACEHOLDER" },
				{ planId: "todo", spec: "todo", code: "SPEC_PLACEHOLDER" },
				{ planId: "short", spec: "too short", code: "SPEC_TOO_SHORT" },
			];
			for (const entry of cases) {
				const result = await spawnChildRaw({
					parentId: parent.id,
					body: { planId: entry.planId, title: "Invalid spec", spec: entry.spec },
				});
				expect(result.status).toBe(400);
				expect(result.body.code).toBe(entry.code);
				if (entry.code === "SPEC_TOO_SHORT") {
					expect(result.body.actualLength).toBe(entry.spec.length);
					expect(result.body.minLength).toBe(50);
				}
			}
		});
	} finally {
		await deleteGoal(parent.id);
	}
});

test("spawn-child derives and provisions a real child worktree from the repository root", async () => {
	const parent = await createParentGoal({ realWorktree: true });
	try {
		if (!parent.worktreePath || !parent.repoPath) {
			test.skip(true, `Parent missing worktree (worktreePath=${parent.worktreePath}, repoPath=${parent.repoPath})`);
			return;
		}

		const created = await spawnChildRaw({
			parentId: parent.id,
			body: {
				planId: "real-worktree",
				title: "Repository-root child",
				spec: validSpec("Real worktree setup"),
			},
		});
		expect(created.status).toBe(201);
		const child = await pollUntil(
			async () => {
				const goal = await readGoal(created.body.id);
				return goal.setupStatus && goal.setupStatus !== "preparing" ? goal : null;
			},
			{ timeoutMs: 30_000, intervalMs: 100, label: `child ${created.body.id} setup settles` },
		);
		expect(["ready", "error"]).toContain(child.setupStatus);
		expect(child.repoPath).toBe(parent.repoPath);
		if (child.worktreePath) {
			expect(child.worktreePath.startsWith(parent.worktreePath)).toBe(false);
		}
	} finally {
		await deleteGoal(parent.id);
	}
});
