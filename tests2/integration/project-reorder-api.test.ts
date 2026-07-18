import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, bobbitDir } from "./_e2e/e2e-setup.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadServerTestRuntime } from "../harness/server-runtime.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const createdProjectIds = new Set<string>();
let baselineNormalProjectIds: string[] = [];

interface ProjectSummary {
	id: string;
	name: string;
	kind?: string;
	hidden?: boolean;
	position?: number;
}

function isHeadquartersProject(project: ProjectSummary): boolean {
	return project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters";
}

function normalProjects(projects: ProjectSummary[]): ProjectSummary[] {
	return projects.filter(project => !isHeadquartersProject(project));
}

function createdProjects(projects: ProjectSummary[]): ProjectSummary[] {
	return projects.filter(project => createdProjectIds.has(project.id));
}

async function listProjects(): Promise<ProjectSummary[]> {
	const res = await apiFetch("/api/projects");
	expect(res.status).toBe(200);
	return await res.json();
}

async function listVisibleProjects(): Promise<ProjectSummary[]> {
	return (await listProjects()).filter(project => !project.hidden);
}

async function listNormalVisibleProjects(): Promise<ProjectSummary[]> {
	return normalProjects(await listVisibleProjects());
}

async function expectHeadquartersAnchored(projects?: ProjectSummary[]): Promise<void> {
	const visible = projects ?? await listVisibleProjects();
	expect(visible[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
	// Since #933 Headquarters participates in user-controlled ordering (position=0 by default)
	expect(visible[0].position).toBe(0);
}

async function showHeadquarters(): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: true }),
	});
	expect(res.status).toBe(200);
}

async function cleanupCreatedProjects(): Promise<void> {
	const existingIds = new Set((await listProjects()).map(project => project.id));
	const ids = Array.from(createdProjectIds);
	for (const id of ids) {
		if (!existingIds.has(id)) continue;
		await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
	}
	const remaining = projectIds(await listNormalVisibleProjects());
	for (const id of ids) expect(remaining).not.toContain(id);
	createdProjectIds.clear();
	await restoreBaselineProjectOrder();
	await expectHeadquartersAnchored();
}

async function restoreBaselineProjectOrder(): Promise<void> {
	const normalIds = projectIds(await listNormalVisibleProjects());
	const baselineIds = baselineNormalProjectIds.filter(id => normalIds.includes(id));
	const otherIds = normalIds.filter(id => !baselineIds.includes(id));
	const res = await apiFetch("/api/projects/order", {
		method: "PUT",
		body: JSON.stringify({ projectIds: [HEADQUARTERS_PROJECT_ID, ...baselineIds, ...otherIds] }),
	});
	expect(res.status).toBe(200);
}

async function registerTmpProject(name: string): Promise<ProjectSummary> {
	const rootPath = mkdtempSync(join(bobbitDir(), `bobbit-reorder-${name}-`));
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, __e2e_seed_skip__: true }),
	});
	expect(res.status).toBe(201);
	const project = await res.json() as ProjectSummary;
	createdProjectIds.add(project.id);
	return project;
}

async function seedProjects(names: string[]): Promise<ProjectSummary[]> {
	const projects: ProjectSummary[] = [];
	for (const name of names) {
		projects.push(await registerTmpProject(name));
	}
	return projects;
}

function projectNames(projects: ProjectSummary[]): string[] {
	return projects.map(project => project.name);
}

function projectIds(projects: ProjectSummary[]): string[] {
	return projects.map(project => project.id);
}

async function expectProjectOrderJson<T = any>(res: Response): Promise<T> {
	const text = await res.text();
	expect(text, "PUT /api/projects/order must not be routed to PUT /api/projects/:id").not.toContain("Project not found: order");
	return JSON.parse(text) as T;
}

async function orderPayloadWithCreatedFirst(createdOrder: string[]): Promise<string[]> {
	const currentNormalIds = projectIds(await listNormalVisibleProjects());
	const preservedIds = currentNormalIds.filter(id => !createdProjectIds.has(id));
	return [HEADQUARTERS_PROJECT_ID, ...createdOrder, ...preservedIds];
}

async function expectCreatedVisibleOrder(expectedCreatedIds: string[]): Promise<void> {
	const visible = await listVisibleProjects();
	await expectHeadquartersAnchored(visible);
	expect(projectIds(createdProjects(normalProjects(visible)))).toEqual(expectedCreatedIds);
}

test.describe("PUT /api/projects/order", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeAll(async () => {
		await showHeadquarters();
		baselineNormalProjectIds = projectIds(await listNormalVisibleProjects());
	});

	test.beforeEach(async () => {
		await showHeadquarters();
		await cleanupCreatedProjects();
	});

	test.afterEach(async () => {
		await cleanupCreatedProjects();
	});

	test("saves C/A/B order, returns it from GET, and persists reloadable positions", async ({ gateway }) => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const normalOrder = [c.id, a.id, b.id];
			// Since #933 HQ participates in ordering and all pre-existing visible projects must be included in the payload.
			const fullOrder = await orderPayloadWithCreatedFirst(normalOrder);

			const putRes = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: fullOrder }),
			});
			const putBody = await expectProjectOrderJson<{ projects: ProjectSummary[] }>(putRes);
			expect(putRes.status).toBe(200);
			expect(putBody).toMatchObject({ projects: expect.any(Array) });
			await expectHeadquartersAnchored(putBody.projects);
			expect(projectIds(createdProjects(normalProjects(putBody.projects)))).toEqual(normalOrder);
			expect(projectNames(createdProjects(normalProjects(putBody.projects)))).toEqual(["C", "A", "B"]);
			// HQ is position 0, created projects are first and occupy positions 1, 2, 3.
			expect(createdProjects(normalProjects(putBody.projects)).map((project: ProjectSummary) => project.position)).toEqual([1, 2, 3]);

			const getProjects = await listProjects();
			await expectHeadquartersAnchored(getProjects);
			expect(projectIds(createdProjects(normalProjects(getProjects)))).toEqual(normalOrder);
			expect(projectNames(createdProjects(normalProjects(getProjects)))).toEqual(["C", "A", "B"]);
			expect(createdProjects(normalProjects(getProjects)).map(project => project.position)).toEqual([1, 2, 3]);

			const stored = JSON.parse(readFileSync(join(gateway.bobbitDir, "state", "projects.json"), "utf-8")) as ProjectSummary[];
			const storedHeadquarters = stored.find(project => project.id === HEADQUARTERS_PROJECT_ID);
			expect(storedHeadquarters).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
			expect(storedHeadquarters?.position).toBe(0); // #933: HQ now participates in ordering
			const storedVisible = stored.filter(project => normalOrder.includes(project.id));
			expect(storedVisible.map(project => project.id)).toEqual(normalOrder);
			expect(storedVisible.map(project => project.position)).toEqual([1, 2, 3]);

			const { ProjectRegistry } = (await loadServerTestRuntime()).projectRegistry;
			const reloaded = new ProjectRegistry(join(gateway.bobbitDir, "state"));
			const reloadedList = reloaded.list() as ProjectSummary[];
			expect(reloadedList[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
			expect(reloadedList.filter((project: ProjectSummary) => normalOrder.includes(project.id)).map((project: ProjectSummary) => project.id)).toEqual(normalOrder);
		} finally {
			await cleanupCreatedProjects();
		}
	});

	test("rejects malformed, duplicate, unknown, hidden/system, and stale orders without mutation", async () => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const original = [a.id, b.id, c.id];
			const validFullOrder = await orderPayloadWithCreatedFirst(original);
			const seedOrder = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: validFullOrder }),
			});
			expect(seedOrder.status).toBe(200);
			await seedOrder.json();
			expect((await listProjects()).some(project => project.id === "system")).toBe(false);

			const malformed = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: "not-an-array" }),
			});
			const malformedBody = await expectProjectOrderJson(malformed);
			expect(malformed.status).toBe(400);
			expect(malformedBody).toMatchObject({ code: "invalid_project_order" });
			await expectCreatedVisibleOrder(original);

			const nonString = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, 123] }),
			});
			const nonStringBody = await expectProjectOrderJson(nonString);
			expect(nonString.status).toBe(400);
			expect(nonStringBody).toMatchObject({ code: "invalid_project_order" });
			await expectCreatedVisibleOrder(original);

			const duplicate = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, b.id] }),
			});
			const duplicateBody = await expectProjectOrderJson(duplicate);
			expect(duplicate.status).toBe(400);
			expect(duplicateBody).toMatchObject({ code: "invalid_project_order" });
			await expectCreatedVisibleOrder(original);

			const unknown = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, "missing-project"] }),
			});
			const unknownBody = await expectProjectOrderJson(unknown);
			expect(unknown.status).toBe(400);
			expect(unknownBody).toMatchObject({ code: "invalid_project_order" });
			await expectCreatedVisibleOrder(original);

			// #933: HQ now MUST be included; omitting it → stale (409), not invalid (400)
			const missingHq = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: validFullOrder.filter(id => id !== HEADQUARTERS_PROJECT_ID) }),
			});
			const missingHqBody = await expectProjectOrderJson(missingHq);
			expect(missingHq.status).toBe(409);
			expect(missingHqBody).toMatchObject({ code: "stale_project_order" });
			await expectCreatedVisibleOrder(original);

			const systemProjectRes = await apiFetch("/api/projects/system");
			expect(systemProjectRes.status).toBe(200);
			expect(await systemProjectRes.json()).toMatchObject({ id: "system", hidden: true });

			const hiddenSystem = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [...validFullOrder, "system"] }),
			});
			const hiddenSystemBody = await expectProjectOrderJson(hiddenSystem);
			expect(hiddenSystem.status).toBe(400);
			expect(hiddenSystemBody).toMatchObject({ code: "invalid_project_order" });
			await expectCreatedVisibleOrder(original);

			// Stale: missing a normal project (payload has HQ + all visible projects except C)
			const stale = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: validFullOrder.filter(id => id !== c.id) }),
			});
			const staleBody = await expectProjectOrderJson(stale);
			expect(stale.status).toBe(409);
			expect(staleBody).toMatchObject({ code: "stale_project_order" });
			await expectCreatedVisibleOrder(original);
		} finally {
			await cleanupCreatedProjects();
		}
	});

	test("delete compacts remaining order and newly-created projects append", async () => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			// #933: must include HQ and any pre-existing visible projects in the payload.
			const reordered = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: await orderPayloadWithCreatedFirst([c.id, a.id, b.id]) }),
			});
			await expectProjectOrderJson(reordered);
			expect(reordered.status).toBe(200);

			const del = await apiFetch(`/api/projects/${a.id}`, { method: "DELETE" });
			expect(del.status).toBe(200);
			createdProjectIds.delete(a.id);
			let visible = await listVisibleProjects();
			await expectHeadquartersAnchored(visible);
			let normalVisible = normalProjects(visible);
			expect(projectIds(createdProjects(normalVisible))).toEqual([c.id, b.id]);
			// HQ=0; created projects were ordered first, so remaining created projects compact to 1, 2.
			expect(createdProjects(normalVisible).map(project => project.position)).toEqual([1, 2]);

			const d = await registerTmpProject("D");
			visible = await listVisibleProjects();
			await expectHeadquartersAnchored(visible);
			normalVisible = normalProjects(visible);
			expect(projectIds(createdProjects(normalVisible))).toEqual([c.id, b.id, d.id]);
			expect(normalVisible.at(-1)?.id).toBe(d.id);
		} finally {
			await cleanupCreatedProjects();
		}
	});
});
