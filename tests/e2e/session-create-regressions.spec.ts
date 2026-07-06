import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect } from "./in-process-harness.js";
import { apiFetch, bobbitDir, defaultProject, registerProject } from "./e2e-setup.js";

test.describe.configure({ mode: "serial" });

const tempRoots: string[] = [];
const createdProjectIds: string[] = [];

function tempProjectRoot(prefix: string): string {
	const root = mkdtempSync(join(dirname(bobbitDir()), `${prefix}-`));
	tempRoots.push(root);
	return root;
}

async function readJson(resp: Response): Promise<{ text: string; json: any }> {
	const text = await resp.text();
	try { return { text, json: JSON.parse(text) }; }
	catch { return { text, json: {} }; }
}

async function setHeadquartersSandbox(value: "docker" | null): Promise<void> {
	const resp = await apiFetch("/api/project-config", {
		method: "PUT",
		body: JSON.stringify({ sandbox: value }),
	});
	expect(resp.status, `set Headquarters sandbox=${value}: ${await resp.text()}`).toBe(200);
}

async function setProjectSandbox(projectId: string, value: "docker" | null): Promise<void> {
	const resp = await apiFetch(`/api/projects/${projectId}/config`, {
		method: "PUT",
		body: JSON.stringify({ sandbox: value }),
	});
	expect(resp.status, `set project ${projectId} sandbox=${value}: ${await resp.text()}`).toBe(200);
}

async function createTempProject(name: string): Promise<{ id: string; rootPath: string }> {
	// Let registerProject's default auto-seed apply (post-#231 strict NO_WORKFLOWS
	// cascade): the "leaves a goal todo" test below creates a real goal on one of
	// these temp projects, and none of this file's tests assert the zero-workflows
	// shape, so opting out with seedWorkflows:false is unnecessary and unsafe here.
	const project = await registerProject({
		name,
		rootPath: tempProjectRoot(name),
	});
	createdProjectIds.push(project.id);
	return { id: project.id, rootPath: project.rootPath };
}

test.afterAll(async () => {
	await setHeadquartersSandbox(null).catch(() => undefined);
	for (const projectId of [...createdProjectIds].reverse()) {
		await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
	}
	for (const root of tempRoots.reverse()) {
		rmSync(root, { recursive: true, force: true });
	}
});

test("POST /api/sessions rejects an explicit nonexistent cwd outside the selected project", async () => {
	const project = await defaultProject();
	const missingOutsideCwd = join(dirname(project.rootPath), `missing-outside-${Date.now()}`, "child");

	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: missingOutsideCwd,
			worktree: false,
		}),
	});
	const body = await readJson(resp);

	expect(resp.status, body.text).toBe(422);
	expect(body.json.code).toBe("CWD_OUTSIDE_PROJECT");
});

test("POST /api/sessions checks sandbox config on the selected normal project", async () => {
	const project = await createTempProject(`sandbox-selected-${Date.now()}`);
	await setHeadquartersSandbox(null);
	await setProjectSandbox(project.id, "docker");

	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
			sandboxed: true,
			// Stop after sandbox preflight without creating a real sandboxed session.
			roleId: "__missing_sandbox_regression_role__",
		}),
	});
	const body = await readJson(resp);

	// With selected project config, the endpoint reaches Docker preflight (503 on
	// hosts without Docker) or later role validation (404 on hosts with Docker).
	// A 400 "not configured" response would mean it read Headquarters config.
	expect([404, 503], body.text).toContain(resp.status);
	if (resp.status === 404) expect(body.json.error).toContain("Role");
	if (resp.status === 503) expect(body.json.error).toContain("Docker is not available");
});

test("POST /api/sessions does not let Headquarters sandbox config authorize a normal project", async () => {
	const project = await createTempProject(`sandbox-unconfigured-${Date.now()}`);
	await setHeadquartersSandbox("docker");

	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
			sandboxed: true,
			roleId: "__missing_sandbox_regression_role__",
		}),
	});
	const body = await readJson(resp);

	expect(resp.status, body.text).toBe(400);
	expect(body.json.error).toContain("Docker sandbox is not configured");
});

test("POST /api/sessions leaves a goal todo when projectId validation fails", async () => {
	const projectA = await createTempProject(`session-goal-a-${Date.now()}`);
	const projectB = await createTempProject(`session-goal-b-${Date.now()}`);
	let goalId = "";
	try {
		const createGoalResp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				projectId: projectA.id,
				cwd: projectA.rootPath,
				title: `Validation ordering ${Date.now()}`,
				spec: "Pin that failed session creation does not mutate the source goal state.",
				worktree: false,
			}),
		});
		const created = await readJson(createGoalResp);
		expect(createGoalResp.status, created.text).toBe(201);
		goalId = created.json.id;

		const before = await apiFetch(`/api/goals/${goalId}`);
		expect((await before.json()).state).toBe("todo");

		const resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				projectId: projectB.id,
				goalId,
				worktree: false,
			}),
		});
		const body = await readJson(resp);

		expect(resp.status, body.text).toBe(422);
		expect(body.json.code).toBe("PROJECT_ID_MISMATCH");

		const after = await apiFetch(`/api/goals/${goalId}`);
		expect((await after.json()).state).toBe("todo");
	} finally {
		if (goalId) await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => undefined);
	}
});

// A custom-provider model id (PR #144) commonly looks like "z-ai/glm-5.2" —
// the id itself contains a "/". The REST create-with-model shortcut used to
// normalize a posted `model` string with a regex that required EXACTLY one
// "/" total, so any id-with-slash silently normalized to `undefined` and the
// session spawned with the default model instead of the requested one — no
// error, no warning. The WS `set_model {provider, modelId}` path was never
// affected because provider and id travel as separate fields there. These
// tests pin: (1) a canonical `provider/id` string where `id` itself contains
// a "/" resolves end-to-end, matching the `indexOf("/")` (first-slash-only)
// split convention already used downstream (SessionManager.resolveInitialModel,
// clampRoleThinking); (2) the structured `{ provider, id }` form with a
// slash-containing `id` also resolves; (3) a genuinely malformed `model` is a
// loud 400, never a silent fallback to the default model.
test("POST /api/sessions accepts a custom-provider model id string that itself contains a slash", async () => {
	const project = await defaultProject();
	const create = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
			model: "my-custom-provider/z-ai/glm-5.2",
		}),
	});
	const created = await readJson(create);
	expect(create.status, created.text).toBe(201);
	const sessionId = created.json.id;
	try {
		const detail = await readJson(await apiFetch(`/api/sessions/${sessionId}`));
		// Must reflect the REQUESTED slash-containing model, not the server
		// default — a silent fallback is exactly the bug this test pins.
		expect(detail.json.modelProvider).toBe("my-custom-provider");
		expect(detail.json.modelId).toBe("z-ai/glm-5.2");
	} finally {
		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
	}
});

test("POST /api/sessions accepts the structured { provider, id } model form when id contains a slash", async () => {
	const project = await defaultProject();
	const create = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
			model: { provider: "my-custom-provider", id: "z-ai/glm-5.2" },
		}),
	});
	const created = await readJson(create);
	expect(create.status, created.text).toBe(201);
	const sessionId = created.json.id;
	try {
		const detail = await readJson(await apiFetch(`/api/sessions/${sessionId}`));
		expect(detail.json.modelProvider).toBe("my-custom-provider");
		expect(detail.json.modelId).toBe("z-ai/glm-5.2");
	} finally {
		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => undefined);
	}
});

test("POST /api/sessions rejects a malformed model with a loud 400, never a silent default-model fallback", async () => {
	const project = await defaultProject();
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			projectId: project.id,
			cwd: project.rootPath,
			worktree: false,
			model: "no-slash-at-all",
		}),
	});
	const body = await readJson(resp);

	expect(resp.status, body.text).toBe(400);
	expect(body.json.code).toBe("INVALID_MODEL");
	expect(body.json.error).toContain("no-slash-at-all");
});
