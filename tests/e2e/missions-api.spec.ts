/**
 * E2E: /api/missions CRUD + plan management + spawn-child preconditions.
 *
 * Phase 1 only — mission gates and integrate-child are stubbed (501) and
 * verified to return that status. Coder B + Coder C land the real logic.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, injectDefaultProjectId } from "./e2e-setup.js";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	const method = (opts?.method || "GET").toUpperCase();
	let body = opts?.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff|missions)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${base()}${path}`, {
		...opts,
		body,
		headers: { ...headers(), ...(opts?.headers || {}) },
	});
}

async function createMission(extra: Record<string, unknown> = {}): Promise<any> {
	const resp = await apiFetch("/api/missions", {
		method: "POST",
		body: JSON.stringify({ title: `Mission ${Date.now()}`, spec: "# Test", ...extra }),
	});
	expect(resp.status).toBe(201);
	return await resp.json();
}

test.beforeAll(() => { token = readE2EToken(); });

test.describe("Missions API", () => {
	test("create + get + list + update + archive @smoke", async () => {
		const created = await createMission({ maxConcurrentGoals: 4, divergencePolicy: "balanced" });
		expect(created.id).toBeTruthy();
		expect(created.state).toBe("planning");
		expect(created.maxConcurrentGoals).toBe(4);
		expect(created.divergencePolicy).toBe("balanced");
		expect(created.projects).toEqual([created.projectId]);
		expect(created.workflowId).toBe("mission");

		// GET single
		const detail = await (await apiFetch(`/api/missions/${created.id}`)).json();
		expect(detail.mission.id).toBe(created.id);
		expect(detail.plan).toBeNull();
		expect(detail.children).toEqual([]);

		// LIST
		const list = await (await apiFetch("/api/missions")).json();
		expect(Array.isArray(list.missions)).toBe(true);
		expect(list.missions.find((m: any) => m.id === created.id)).toBeTruthy();
		expect(typeof list.generation).toBe("number");

		// PUT
		const put = await apiFetch(`/api/missions/${created.id}`, {
			method: "PUT",
			body: JSON.stringify({ title: "Renamed", maxConcurrentGoals: 2 }),
		});
		expect(put.status).toBe(200);
		const after = await (await apiFetch(`/api/missions/${created.id}`)).json();
		expect(after.mission.title).toBe("Renamed");
		expect(after.mission.maxConcurrentGoals).toBe(2);

		// DELETE = archive
		const del = await apiFetch(`/api/missions/${created.id}`, { method: "DELETE" });
		expect(del.status).toBe(200);
		const live = await (await apiFetch("/api/missions")).json();
		expect(live.missions.find((m: any) => m.id === created.id)).toBeFalsy();
	});

	test("POST 400 when title missing", async () => {
		const resp = await apiFetch("/api/missions", { method: "POST", body: JSON.stringify({ spec: "x" }) });
		expect(resp.status).toBe(400);
	});

	test("PATCH /plan validates DAG", async () => {
		const m = await createMission();

		// Cycle should be rejected.
		const cycle = await apiFetch(`/api/missions/${m.id}/plan`, {
			method: "PATCH",
			body: JSON.stringify({
				plan: {
					goals: [
						{ planId: "a", title: "A", spec: "", workflowId: "feature" },
						{ planId: "b", title: "B", spec: "", workflowId: "feature" },
					],
					dependencies: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
					rationale: "",
					estimatedConcurrency: 1,
					version: 1,
				},
			}),
		});
		expect(cycle.status).toBe(400);

		// Valid plan accepted.
		const valid = await apiFetch(`/api/missions/${m.id}/plan`, {
			method: "PATCH",
			body: JSON.stringify({
				plan: {
					goals: [
						{ planId: "a", title: "A", spec: "spec A", workflowId: "feature" },
						{ planId: "b", title: "B", spec: "spec B", workflowId: "feature" },
					],
					dependencies: [{ from: "a", to: "b" }],
					rationale: "test",
					estimatedConcurrency: 1,
					version: 1,
				},
			}),
		});
		expect(valid.status).toBe(200);
		const body = await valid.json();
		expect(body.version).toBe(1);

		// GET /plan returns the stored plan.
		const planResp = await apiFetch(`/api/missions/${m.id}/plan`);
		expect(planResp.status).toBe(200);
		const plan = await planResp.json();
		expect(plan.goals).toHaveLength(2);
	});

	test("PATCH /plan rejects edits when frozen unless paused + replan_reason", async () => {
		const m = await createMission();

		// Set initial plan + freeze.
		await apiFetch(`/api/missions/${m.id}/plan`, {
			method: "PATCH",
			body: JSON.stringify({
				plan: {
					goals: [{ planId: "a", title: "A", spec: "", workflowId: "feature" }],
					dependencies: [],
					rationale: "",
					estimatedConcurrency: 1,
					version: 1,
				},
			}),
		});
		const freeze = await apiFetch(`/api/missions/${m.id}/plan/freeze`, { method: "POST" });
		expect(freeze.status).toBe(200);

		// Edit without pause → 403.
		const blocked = await apiFetch(`/api/missions/${m.id}/plan`, {
			method: "PATCH",
			body: JSON.stringify({
				plan: {
					goals: [{ planId: "a", title: "A2", spec: "", workflowId: "feature" }],
					dependencies: [],
					rationale: "",
					estimatedConcurrency: 1,
					version: 2,
				},
			}),
		});
		expect(blocked.status).toBe(403);

		// Pause + replan_reason → accepted.
		await apiFetch(`/api/missions/${m.id}/pause`, { method: "POST", body: JSON.stringify({ reason: "replan" }) });
		const ok = await apiFetch(`/api/missions/${m.id}/plan`, {
			method: "PATCH",
			body: JSON.stringify({
				plan: {
					goals: [{ planId: "a", title: "A2", spec: "", workflowId: "feature" }],
					dependencies: [],
					rationale: "v2",
					estimatedConcurrency: 1,
					version: 2,
				},
				replan_reason: "structural change",
			}),
		});
		expect(ok.status).toBe(200);
	});

	test("spawn-child blocked until plan frozen + dep complete", async () => {
		const m = await createMission();

		// No plan yet — 409.
		let resp = await apiFetch(`/api/missions/${m.id}/spawn-child/x`, { method: "POST" });
		expect(resp.status).toBe(409);

		// Set plan with two nodes, only the leaf has no deps.
		await apiFetch(`/api/missions/${m.id}/plan`, {
			method: "PATCH",
			body: JSON.stringify({
				plan: {
					goals: [
						{ planId: "a", title: "A", spec: "spec a", workflowId: "feature" },
						{ planId: "b", title: "B", spec: "spec b", workflowId: "feature" },
					],
					dependencies: [{ from: "a", to: "b" }],
					rationale: "",
					estimatedConcurrency: 1,
					version: 1,
				},
			}),
		});

		// Plan not frozen → 409.
		resp = await apiFetch(`/api/missions/${m.id}/spawn-child/a`, { method: "POST" });
		expect(resp.status).toBe(409);

		// Freeze plan.
		await apiFetch(`/api/missions/${m.id}/plan/freeze`, { method: "POST" });

		// Child b has unmet dep a → 409.
		resp = await apiFetch(`/api/missions/${m.id}/spawn-child/b`, { method: "POST" });
		expect(resp.status).toBe(409);

		// Child a (no deps) → 200/201, idempotent.
		resp = await apiFetch(`/api/missions/${m.id}/spawn-child/a`, { method: "POST" });
		expect(resp.status).toBe(200);
		const first = await resp.json();
		expect(first.goalId).toBeTruthy();
		expect(first.alreadySpawned).toBe(false);

		const second = await apiFetch(`/api/missions/${m.id}/spawn-child/a`, { method: "POST" });
		expect(second.status).toBe(200);
		const again = await second.json();
		expect(again.goalId).toBe(first.goalId);
		expect(again.alreadySpawned).toBe(true);

		// Spawned goal carries missionId/missionPlanId.
		const goalResp = await apiFetch(`/api/goals/${first.goalId}`);
		expect(goalResp.status).toBe(200);
		const goal = await goalResp.json();
		expect(goal.missionId).toBe(m.id);
		expect(goal.missionPlanId).toBe("a");
	});

	test("integrate-child returns 501 (phase-4 stub)", async () => {
		const m = await createMission();
		const resp = await apiFetch(`/api/missions/${m.id}/integrate-child/anything`, { method: "POST" });
		expect(resp.status).toBe(501);
	});

	test("mission gate routes return 501 (phase-2 stub)", async () => {
		const m = await createMission();
		const resp = await apiFetch(`/api/missions/${m.id}/gates`);
		expect(resp.status).toBe(501);
	});

	test("pause + resume lifecycle", async () => {
		const m = await createMission();
		const pause = await apiFetch(`/api/missions/${m.id}/pause`, {
			method: "POST",
			body: JSON.stringify({ reason: "human pause" }),
		});
		expect(pause.status).toBe(200);
		const afterPause = await (await apiFetch(`/api/missions/${m.id}`)).json();
		expect(afterPause.mission.state).toBe("paused");

		const resume = await apiFetch(`/api/missions/${m.id}/resume`, { method: "POST" });
		expect(resume.status).toBe(200);
		const afterResume = await (await apiFetch(`/api/missions/${m.id}`)).json();
		expect(afterResume.mission.state).toBe("planning");

		// Resume when not paused → 409.
		const noop = await apiFetch(`/api/missions/${m.id}/resume`, { method: "POST" });
		expect(noop.status).toBe(409);
	});
});
