// Migrated from tests/e2e/project-delete-last.spec.ts (v2-integration tier).
// DELETE /api/projects/:id succeeds for the last NORMAL project while the
// immutable Headquarters project remains visible. The freshly-created project is
// tracked in scope() as a safety net (the test deletes it itself on the happy
// path); the default project is restored by scope.cleanup().
import { mkdirSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";
import { createScope, type TestScope } from "../harness/scope.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";

type ProjectSummary = { id: string; name?: string; kind?: string; hidden?: boolean };

let gw: GatewayFixture;
let scope: TestScope;

beforeAll(async () => { gw = await getGateway(); });
afterEach(async () => { await scope.cleanup(); });

function isHeadquarters(p: ProjectSummary): boolean {
	return p.id === HEADQUARTERS_PROJECT_ID || p.kind === "headquarters";
}

async function listVisibleProjects(): Promise<ProjectSummary[]> {
	const body = await gw.apiJson<any>("/api/projects");
	const list: ProjectSummary[] = Array.isArray(body) ? body : (body.projects ?? []);
	return list.filter(p => !p.hidden);
}

async function listNormalVisibleProjects(): Promise<ProjectSummary[]> {
	return (await listVisibleProjects()).filter(p => !isHeadquarters(p));
}

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (pred(v)) return v;
		if (Date.now() > deadline) throw new Error("poll timed out");
		await new Promise(r => setTimeout(r, 25));
	}
}

describe("DELETE /api/projects/:id — last normal project", () => {
	it("plain DELETE (no ?force=1) succeeds for the last normal project while Headquarters remains", async () => {
		scope = createScope(gw);

		// Show Headquarters in project lists.
		const prefRes = await gw.api("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ showHeadquartersInProjectLists: true }),
		});
		expect(prefRes.status).toBe(200);

		// Drain pre-existing normal projects (Headquarters is server-owned).
		for (const p of await listNormalVisibleProjects()) {
			await gw.api(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
		}
		await poll(async () => (await listNormalVisibleProjects()).length, n => n === 0);

		expect((await listVisibleProjects())[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });

		// Headquarters is immutable.
		const hqDelete = await gw.api(`/api/projects/${HEADQUARTERS_PROJECT_ID}`, { method: "DELETE" });
		expect(hqDelete.status).toBe(403);
		expect(await hqDelete.json()).toMatchObject({ code: "HEADQUARTERS_IMMUTABLE" });

		// Seed exactly one fresh normal project. The happy path deletes it itself
		// below, so it is intentionally NOT tracked in scope (which only tolerates a
		// 404 on re-delete); scope.cleanup still restores the drained default project.
		const dir = `${gw.bobbitDir}/del-last-${Date.now()}`;
		mkdirSync(dir, { recursive: true });
		await gw.api("/api/projects", { method: "POST", body: JSON.stringify({ name: `mk-${Date.now()}`, rootPath: dir }) })
			.then(async r => { expect(r.status).toBe(201); return r.json(); });

		await poll(async () => (await listNormalVisibleProjects()).length, n => n === 1);
		const [normal] = await listNormalVisibleProjects();

		// Plain DELETE with NO ?force=1 must succeed.
		const delRes = await gw.api(`/api/projects/${normal.id}`, { method: "DELETE" });
		expect(delRes.status).toBe(200);
		expect(await delRes.json()).toEqual({ ok: true });

		// No normal projects remain, Headquarters still visible.
		await poll(async () => (await listNormalVisibleProjects()).length, n => n === 0);
		expect((await listVisibleProjects())[0]).toMatchObject({ id: HEADQUARTERS_PROJECT_ID, kind: "headquarters" });
	});
});
