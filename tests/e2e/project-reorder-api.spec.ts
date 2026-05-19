import { test, expect } from "./in-process-harness.js";
import { apiFetch, bobbitDir } from "./e2e-setup.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ProjectSummary {
	id: string;
	name: string;
	hidden?: boolean;
	position?: number;
}

async function listProjects(): Promise<ProjectSummary[]> {
	const res = await apiFetch("/api/projects");
	expect(res.status).toBe(200);
	return await res.json();
}

async function listVisibleProjects(): Promise<ProjectSummary[]> {
	return (await listProjects()).filter(project => !project.hidden);
}

async function clearVisibleProjects(): Promise<void> {
	for (const project of await listVisibleProjects()) {
		await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
	}
	expect(await listVisibleProjects()).toEqual([]);
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

async function expectVisibleOrder(expectedIds: string[]): Promise<void> {
	expect((await listVisibleProjects()).map(project => project.id)).toEqual(expectedIds);
}

test.describe("PUT /api/projects/order", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async () => {
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

			const putRes = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: order }),
			});
			expect(putRes.status).toBe(200);
			const putBody = await putRes.json();
			expect(projectNames(putBody.projects)).toEqual(["C", "A", "B"]);
			expect(putBody.projects.map((project: ProjectSummary) => project.position)).toEqual([0, 1, 2]);

			const getProjects = await listVisibleProjects();
			expect(projectNames(getProjects)).toEqual(["C", "A", "B"]);
			expect(getProjects.map(project => project.position)).toEqual([0, 1, 2]);

			const stored = JSON.parse(readFileSync(join(gateway.bobbitDir, "state", "projects.json"), "utf-8")) as ProjectSummary[];
			const storedVisible = stored.filter(project => order.includes(project.id));
			expect(storedVisible.map(project => project.id)).toEqual(order);
			expect(storedVisible.map(project => project.position)).toEqual([0, 1, 2]);

			const { ProjectRegistry } = await import("../../dist/server/agent/project-registry.js");
			const reloaded = new ProjectRegistry(join(gateway.bobbitDir, "state"));
			expect(reloaded.list().filter((project: ProjectSummary) => order.includes(project.id)).map((project: ProjectSummary) => project.id)).toEqual(order);
		} finally {
			await clearVisibleProjects();
		}
	});

	test("rejects malformed, duplicate, unknown, hidden/system, and stale orders without mutation", async () => {
		const projects = await seedProjects(["A", "B", "C"]);
		try {
			const [a, b, c] = projects;
			const original = [a.id, b.id, c.id];
			expect((await listProjects()).some(project => project.id === "system")).toBe(false);

			const malformed = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: "not-an-array" }),
			});
			expect(malformed.status).toBe(400);
			expect(await malformed.json()).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const nonString = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, 123] }),
			});
			expect(nonString.status).toBe(400);
			expect(await nonString.json()).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const duplicate = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, b.id] }),
			});
			expect(duplicate.status).toBe(400);
			expect(await duplicate.json()).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const unknown = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, "missing-project"] }),
			});
			expect(unknown.status).toBe(400);
			expect(await unknown.json()).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const system = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id, c.id, "system"] }),
			});
			expect(system.status).toBe(400);
			expect(await system.json()).toMatchObject({ code: "invalid_project_order" });
			await expectVisibleOrder(original);

			const stale = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [a.id, b.id] }),
			});
			expect(stale.status).toBe(409);
			expect(await stale.json()).toMatchObject({
				code: "stale_project_order",
				expectedProjectIds: original,
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
			const reordered = await apiFetch("/api/projects/order", {
				method: "PUT",
				body: JSON.stringify({ projectIds: [c.id, a.id, b.id] }),
			});
			expect(reordered.status).toBe(200);

			const del = await apiFetch(`/api/projects/${a.id}`, { method: "DELETE" });
			expect(del.status).toBe(200);
			let visible = await listVisibleProjects();
			expect(visible.map(project => project.id)).toEqual([c.id, b.id]);
			expect(visible.map(project => project.position)).toEqual([0, 1]);

			const d = await registerTmpProject("D");
			visible = await listVisibleProjects();
			expect(visible.map(project => project.id)).toEqual([c.id, b.id, d.id]);
			expect(visible.map(project => project.position)).toEqual([0, 1, 2]);
		} finally {
			await clearVisibleProjects();
		}
	});
});
