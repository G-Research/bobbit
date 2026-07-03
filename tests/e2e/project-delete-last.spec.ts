/**
 * API E2E — DELETE /api/projects/:id succeeds when deleting the last normal
 * project while the immutable Headquarters project remains visible.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HEADQUARTERS_PROJECT_ID = "headquarters";

type ProjectSummary = { id: string; name?: string; kind?: string; hidden?: boolean };

function isHeadquartersProject(project: ProjectSummary): boolean {
	return project.id === HEADQUARTERS_PROJECT_ID || project.kind === "headquarters";
}

async function listVisibleProjects(): Promise<ProjectSummary[]> {
	const res = await apiFetch("/api/projects");
	if (!res.ok) return [];
	const body = await res.json();
	const list: ProjectSummary[] = Array.isArray(body) ? body : (body.projects ?? []);
	return list.filter(p => !p.hidden);
}

async function listNormalVisibleProjects(): Promise<ProjectSummary[]> {
	return (await listVisibleProjects()).filter(p => !isHeadquartersProject(p));
}

async function showHeadquarters(): Promise<void> {
	const res = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ showHeadquartersInProjectLists: true }),
	});
	expect(res.status).toBe(200);
}

test.describe("DELETE /api/projects/:id — last normal project", () => {
	test("plain DELETE (no ?force=1) succeeds for the last normal project while Headquarters remains", async () => {
		await showHeadquarters();

		// Drain pre-existing normal projects only. Headquarters is server-owned and
		// must remain visible/immutable rather than being deleted to reach zero.
		for (const p of await listNormalVisibleProjects()) {
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
		await expect
			.poll(async () => (await listNormalVisibleProjects()).length, { timeout: 10_000 })
			.toBe(0);

		const visibleAfterDrain = await listVisibleProjects();
		expect(visibleAfterDrain[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });

		const hqDelete = await apiFetch(`/api/projects/${HEADQUARTERS_PROJECT_ID}`, { method: "DELETE" });
		expect(hqDelete.status).toBe(403);
		expect(await hqDelete.json()).toMatchObject({ code: "HEADQUARTERS_IMMUTABLE" });

		// Seed exactly one fresh normal project.
		const dir = mkdtempSync(join(tmpdir(), "bobbit-del-last-"));
		try {
			const createRes = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `del-last-${Date.now()}`, rootPath: dir }),
			});
			expect(createRes.status).toBe(201);
			const proj = await createRes.json();

			// One normal project now — exactly the case the old guard refused.
			await expect
				.poll(async () => (await listNormalVisibleProjects()).length, { timeout: 10_000 })
				.toBe(1);
			expect((await listVisibleProjects())[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });

			// Plain DELETE with NO ?force=1. Must succeed.
			const delRes = await apiFetch(`/api/projects/${proj.id}`, { method: "DELETE" });
			expect(delRes.status).toBe(200);
			const delBody = await delRes.json();
			expect(delBody).toEqual({ ok: true });

			// No normal projects remain, but Headquarters is still visible.
			await expect
				.poll(async () => (await listNormalVisibleProjects()).length, { timeout: 10_000 })
				.toBe(0);
			expect((await listVisibleProjects())[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
		} finally {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});
