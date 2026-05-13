/**
 * API E2E — DELETE /api/projects/:id succeeds even when it is the last
 * remaining (non-hidden) project.
 *
 * Previously the server returned 400 unless `BOBBIT_E2E=1 + ?force=1` was set.
 * The guard has been removed: any project may be deleted; the UI falls back to
 * the zero-project first-run state. This test pins the new behaviour.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function listVisibleProjects(): Promise<Array<{ id: string; hidden?: boolean }>> {
	const res = await apiFetch("/api/projects");
	if (!res.ok) return [];
	const body = await res.json();
	const list: Array<{ id: string; hidden?: boolean }> = Array.isArray(body) ? body : (body.projects ?? []);
	return list.filter(p => !p.hidden);
}

test.describe("DELETE /api/projects/:id — last project", () => {
	test("plain DELETE (no ?force=1) succeeds even when it is the last visible project", async () => {
		// Drain pre-existing visible projects so we set up a single-project state.
		for (const p of await listVisibleProjects()) {
			await apiFetch(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
		expect((await listVisibleProjects()).length, "drained to zero before seed").toBe(0);

		// Seed exactly one fresh project.
		const dir = mkdtempSync(join(tmpdir(), "bobbit-del-last-"));
		try {
			const createRes = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `del-last-${Date.now()}`, rootPath: dir }),
			});
			expect(createRes.status).toBe(201);
			const proj = await createRes.json();

			// One visible project now — exactly the case the old guard refused.
			expect((await listVisibleProjects()).length).toBe(1);

			// Plain DELETE with NO ?force=1. Must succeed.
			const delRes = await apiFetch(`/api/projects/${proj.id}`, { method: "DELETE" });
			expect(delRes.status).toBe(200);
			const delBody = await delRes.json();
			expect(delBody).toEqual({ ok: true });

			// No non-hidden projects remain.
			expect((await listVisibleProjects()).length).toBe(0);
		} finally {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});
