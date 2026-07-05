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
	expect(visible[0].position).toBe(0);
}

async function showHeadquarters(): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: true }),
	});
	expect(res.status).toBe(200);
}

async function hideHeadquarters(): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: false }),
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

async function expectVisibleProjectOrder(expectedIds: string[]): Promise<void> {
	const visible = await listVisibleProjects();
	expect(projectIds(visible)).toEqual(expectedIds);
	expect(visible.map(project => project.position)).toEqual(expectedIds.map((_, index) => index));
}

test.describe("PUT /api/projects/order", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async () => {
		await showHeadquarters();
		await clearVisibleProjects();
	});

	test.afterEach(async () => {
		await showHeadquarters();
		await clearVisibleProjects();
	});

	test("saves C/HQ/A/B order, returns it from GET, and persists reloadable positions", async ({ gateway }) => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const order = [c.id, HEADQUARTERS_PROJECT_ID, a.id, b.id];

			const putRes = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: order }),
			});
			const putBody = await expectProjectOrderJson<{ projects: ProjectSummary[] }>(putRes);
			expect(putRes.status).toBe(200);
			expect(putBody).toMatchObject({ projects: expect.any(Array) });
			expect(projectIds(putBody.projects)).toEqual(order);
			expect(projectNames(normalProjects(putBody.projects))).toEqual(["C", "A", "B"]);
			expect(putBody.projects.map((project: ProjectSummary) => project.position)).toEqual([0, 1, 2, 3]);

			const getProjects = await listProjects();
			expect(projectIds(getProjects)).toEqual(order);
			expect(projectNames(normalProjects(getProjects))).toEqual(["C", "A", "B"]);
			expect(getProjects.map(project => project.position)).toEqual([0, 1, 2, 3]);

			const stored = JSON.parse(readFileSync(join(gateway.bobbitDir, "state", "projects.json"), "utf-8")) as ProjectSummary[];
			const storedHeadquarters = stored.find(project => project.id === HEADQUARTERS_PROJECT_ID);
			expect(storedHeadquarters).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
			expect(storedHeadquarters?.position).toBe(1);
			const storedVisible = stored.filter(project => order.includes(project.id)).sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
			expect(storedVisible.map(project => project.id)).toEqual(order);
			expect(storedVisible.map(project => project.position)).toEqual([0, 1, 2, 3]);

			const { ProjectRegistry } = await import("../../dist/server/agent/project-registry.js");
			const reloaded = new ProjectRegistry(join(gateway.bobbitDir, "state"));
			const reloadedList = reloaded.list() as ProjectSummary[];
			expect(reloadedList.filter((project: ProjectSummary) => order.includes(project.id)).map((project: ProjectSummary) => project.id)).toEqual(order);
		} finally {
			await showHeadquarters();
			await clearVisibleProjects();
		}
	});

	test("rejects malformed, duplicate, unknown, hidden/system, and stale orders without mutation", async () => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const original = [HEADQUARTERS_PROJECT_ID, a.id, b.id, c.id];
			expect((await listProjects()).some(project => project.id === "system")).toBe(false);

			const malformed = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: "not-an-array" }),
			});
			const malformedBody = await expectProjectOrderJson(malformed);
			expect(malformed.status).toBe(400);
			expect(malformedBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleProjectOrder(original);

			const nonString = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, 123] }),
			});
			const nonStringBody = await expectProjectOrderJson(nonString);
			expect(nonString.status).toBe(400);
			expect(nonStringBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleProjectOrder(original);

			const duplicate = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, b.id] }),
			});
			const duplicateBody = await expectProjectOrderJson(duplicate);
			expect(duplicate.status).toBe(400);
			expect(duplicateBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleProjectOrder(original);

			const unknown = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [HEADQUARTERS_PROJECT_ID, a.id, b.id, "missing-project"] }),
			});
			const unknownBody = await expectProjectOrderJson(unknown);
			expect(unknown.status).toBe(400);
			expect(unknownBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleProjectOrder(original);

			const systemProjectRes = await apiFetch("/api/projects/system");
			expect(systemProjectRes.status).toBe(200);
			expect(await systemProjectRes.json()).toMatchObject({ id: "system", hidden: true });

			const hiddenSystem = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [HEADQUARTERS_PROJECT_ID, a.id, b.id, c.id, "system"] }),
			});
			const hiddenSystemBody = await expectProjectOrderJson(hiddenSystem);
			expect(hiddenSystem.status).toBe(400);
			expect(hiddenSystemBody).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleProjectOrder(original);

			const stale = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, c.id] }),
			});
			const staleBody = await expectProjectOrderJson(stale);
			expect(stale.status).toBe(409);
			expect(staleBody).toMatchObject({
				code: "stale_project_order",
				expectedProjectIds: original,
				receivedProjectIds: [a.id, b.id, c.id],
			});
			await expectVisibleProjectOrder(original);
		} finally {
			await showHeadquarters();
			await clearVisibleProjects();
		}
	});

	test("hidden Headquarters is omitted from reorder payloads while preserving its slot", async ({ gateway }) => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			await expectVisibleProjectOrder([HEADQUARTERS_PROJECT_ID, a.id, b.id, c.id]);
			await hideHeadquarters();

			const reordered = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [c.id, a.id, b.id] }),
			});
			const body = await expectProjectOrderJson<{ projects: ProjectSummary[] }>(reordered);
			expect(reordered.status).toBe(200);
			expect(projectIds(body.projects)).toEqual([c.id, a.id, b.id]);

			const stored = JSON.parse(readFileSync(join(gateway.bobbitDir, "state", "projects.json"), "utf-8")) as ProjectSummary[];
			const storedVisible = stored
				.filter(project => [HEADQUARTERS_PROJECT_ID, a.id, b.id, c.id].includes(project.id))
				.sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
			expect(storedVisible.map(project => project.id)).toEqual([HEADQUARTERS_PROJECT_ID, c.id, a.id, b.id]);
			expect(storedVisible.map(project => project.position)).toEqual([0, 1, 2, 3]);
		} finally {
			await showHeadquarters();
			await clearVisibleProjects();
		}
	});

	test("delete compacts remaining order and newly-created projects append", async () => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const reordered = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [c.id, HEADQUARTERS_PROJECT_ID, a.id, b.id] }),
			});
			await expectProjectOrderJson(reordered);
			expect(reordered.status).toBe(200);

			const del = await apiFetch(`/api/projects/${a.id}`, { method: "DELETE" });
			expect(del.status).toBe(200);
			let visible = await listVisibleProjects();
			expect(projectIds(visible)).toEqual([c.id, HEADQUARTERS_PROJECT_ID, b.id]);
			expect(visible.map(project => project.position)).toEqual([0, 1, 2]);

			const d = await registerTmpProject("D");
			visible = await listVisibleProjects();
			expect(projectIds(visible)).toEqual([c.id, HEADQUARTERS_PROJECT_ID, b.id, d.id]);
			expect(visible.map(project => project.position)).toEqual([0, 1, 2, 3]);
		} finally {
			await showHeadquarters();
			await clearVisibleProjects();
		}
	});
});
