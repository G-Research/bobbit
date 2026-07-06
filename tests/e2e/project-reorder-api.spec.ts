import { test, expect } from "./in-process-harness.js";
import { apiFetch, bobbitDir } from "./e2e-setup.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HEADQUARTERS_PROJECT_ID = "headquarters";

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
	// HQ now participates in visible ordering and has a numeric position.
}

async function showHeadquarters(): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: true }),
	});
	expect(res.status).toBe(200);
}

async function clearVisibleProjects(): Promise<void> {
	for (const project of await listNormalVisibleProjects()) {
		await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	}
	expect(await listNormalVisibleProjects()).toEqual([]);
	await expectHeadquartersAnchored();
}

async function registerTmpProject(name: string): Promise<ProjectSummary> {
	const rootPath = mkdtempSync(join(bobbitDir(), `bobbit-reorder-${name}-`));
	const res = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, __e2e_seed_skip__: true }),
	});
	expect(res.status).toBe(201);
	return await res.json();
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

async function expectVisibleOrder(expectedNormalIds: string[]): Promise<void> {
	const visible = await listVisibleProjects();
	await expectHeadquartersAnchored(visible);
	expect(projectIds(normalProjects(visible))).toEqual(expectedNormalIds);
}

test.describe("PUT /api/projects/order", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async () => {
		await showHeadquarters();
		await clearVisibleProjects();
	});

	test.afterEach(async () => {
		await clearVisibleProjects();
	});

	test("saves C/A/B order, returns it from GET, and persists reloadable positions", async ({ gateway }) => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const order = [c.id, a.id, b.id];
			// HQ is a first-class reorderable project; it must be included in the
			// order payload. Keep HQ at position 0 (its default) in this test.
			const fullOrder = [HEADQUARTERS_PROJECT_ID, ...order];

			const putRes = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: fullOrder }),
			});
			const putBody = await expectProjectOrderJson<{ projects: ProjectSummary[] }>(putRes);
			expect(putRes.status).toBe(200);
			expect(putBody).toMatchObject({ projects: expect.any(Array) });
			await expectHeadquartersAnchored(putBody.projects);
			expect(projectIds(normalProjects(putBody.projects))).toEqual(order);
			expect(projectNames(normalProjects(putBody.projects))).toEqual(["C", "A", "B"]);
			// HQ is at position 0; normal projects follow at 1, 2, 3.
			expect(normalProjects(putBody.projects).map((project: ProjectSummary) => project.position)).toEqual([1, 2, 3]);

			const getProjects = await listProjects();
			await expectHeadquartersAnchored(getProjects);
			expect(projectIds(normalProjects(getProjects))).toEqual(order);
			expect(projectNames(normalProjects(getProjects))).toEqual(["C", "A", "B"]);
			expect(normalProjects(getProjects).map(project => project.position)).toEqual([1, 2, 3]);

			const stored = JSON.parse(readFileSync(join(gateway.bobbitDir, "state", "projects.json"), "utf-8")) as ProjectSummary[];
			const storedHeadquarters = stored.find(project => project.id === HEADQUARTERS_PROJECT_ID);
			expect(storedHeadquarters).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
			// HQ participates in visible ordering and has a numeric position.
			expect(storedHeadquarters?.position).toBe(0);
			const storedVisible = stored.filter(project => order.includes(project.id));
			expect(storedVisible.map(project => project.id)).toEqual(order);
			expect(storedVisible.map(project => project.position)).toEqual([1, 2, 3]);

			const { ProjectRegistry } = await import("../../dist/server/agent/project-registry.js");
			const reloaded = new ProjectRegistry(join(gateway.bobbitDir, "state"));
			const reloadedList = reloaded.list() as ProjectSummary[];
			expect(reloadedList[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
			expect(reloadedList.filter((project: ProjectSummary) => order.includes(project.id)).map((project: ProjectSummary) => project.id)).toEqual(order);
		} finally {
			await clearVisibleProjects();
		}
	});

	test("rejects malformed, duplicate, unknown, hidden/system/headquarters, and stale orders without mutation", async () => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const original = [a.id, b.id, c.id];
			expect((await listProjects()).some(project => project.id === "system")).toBe(false);

			const malformed = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: "not-an-array" }),
			});
			const malformedBody = await expectProjectOrderJson(malformed);
			expect(malformed.status).toBe(400);
			expect(malformedBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const nonString = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, 123] }),
			});
			const nonStringBody = await expectProjectOrderJson(nonString);
			expect(nonString.status).toBe(400);
			expect(nonStringBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const duplicate = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, b.id] }),
			});
			const duplicateBody = await expectProjectOrderJson(duplicate);
			expect(duplicate.status).toBe(400);
			expect(duplicateBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const unknown = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, "missing-project"] }),
			});
			const unknownBody = await expectProjectOrderJson(unknown);
			expect(unknown.status).toBe(400);
			expect(unknownBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			// HQ is a first-class reorderable project; sending [HQ, a, b, c] is
			// VALID (200). It preserves normal-project order so expectVisibleOrder
			// still passes.
			const headquarters = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [HEADQUARTERS_PROJECT_ID, a.id, b.id, c.id] }),
			});
			await expectProjectOrderJson(headquarters);
			expect(headquarters.status).toBe(200);
			await expectVisibleOrder(original);

			const systemProjectRes = await apiFetch("/api/projects/system");
			expect(systemProjectRes.status).toBe(200);
			expect(await systemProjectRes.json()).toMatchObject({ id: "system", hidden: true });

			const hiddenSystem = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, c.id, "system"] }),
			});
			const hiddenSystemBody = await expectProjectOrderJson(hiddenSystem);
			expect(hiddenSystem.status).toBe(400);
			expect(hiddenSystemBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const stale = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id] }),
			});
			const staleBody = await expectProjectOrderJson(stale);
			expect(stale.status).toBe(409);
			// HQ participates in ordering so expectedProjectIds includes it.
			expect(staleBody).toMatchObject({
				code: "stale_project_order",
				expectedProjectIds: [HEADQUARTERS_PROJECT_ID, ...original],
				receivedProjectIds: [a.id, b.id],
			});
			await expectVisibleOrder(original);
		} finally {
			await clearVisibleProjects();
		}
	});

	test("delete compacts remaining order and newly-created projects append", async () => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			// HQ is a first-class reorderable project; include it in the payload.
			const reordered = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [HEADQUARTERS_PROJECT_ID, c.id, a.id, b.id] }),
			});
			await expectProjectOrderJson(reordered);
			expect(reordered.status).toBe(200);

			const del = await apiFetch(`/api/projects/${a.id}`, { method: "DELETE" });
			expect(del.status).toBe(200);
			let visible = await listVisibleProjects();
			await expectHeadquartersAnchored(visible);
			let normalVisible = normalProjects(visible);
			expect(normalVisible.map(project => project.id)).toEqual([c.id, b.id]);
			// HQ is at position 0; normal projects follow from position 1.
			expect(normalVisible.map(project => project.position)).toEqual([1, 2]);

			const d = await registerTmpProject("D");
			visible = await listVisibleProjects();
			await expectHeadquartersAnchored(visible);
			normalVisible = normalProjects(visible);
			expect(normalVisible.map(project => project.id)).toEqual([c.id, b.id, d.id]);
			expect(normalVisible.map(project => project.position)).toEqual([1, 2, 3]);
		} finally {
			await clearVisibleProjects();
		}
	});
});
