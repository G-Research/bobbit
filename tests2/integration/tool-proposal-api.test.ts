import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root = "";
let projectId = "";

function uniqueTool(): string {
	return `proposal-tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function content(name: string, description: string): string {
	return `name: ${name}\ndescription: ${description}\ngroup: Proposal Fixture\n`;
}

async function apply(body: Record<string, unknown>): Promise<Response> {
	return apiFetch("/api/tools/proposal", { method: "POST", body: JSON.stringify({ projectId, ...body }) });
}

test.beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "bobbit-tool-proposal-api-"));
	mkdirSync(join(root, ".bobbit", "config", "tools"), { recursive: true });
	const res = await apiFetch("/api/projects", { method: "POST", body: JSON.stringify({ name: "tool proposal api", rootPath: root, __e2e_seed_skip__: true }) });
	expect(res.status).toBe(201);
	projectId = (await res.json()).id;
});

test.afterAll(async () => {
	if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => undefined);
	if (root) rmSync(root, { recursive: true, force: true });
});

test("public tool proposal application is loader-visible, updates, deletes, and rejects invalid bytes before write", async () => {
	const tool = uniqueTool();
	const create = await apply({ action: "create", tool, content: content(tool, "first") });
	expect(create.status).toBe(201);
	let listed = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(projectId)}`)).json();
	expect(listed.tools.find((entry: any) => entry.name === tool)).toMatchObject({ description: "first", origin: "project" });

	const update = await apply({ action: "update", tool, content: content(tool, "second") });
	expect(update.status).toBe(200);
	listed = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(projectId)}`)).json();
	expect(listed.tools.find((entry: any) => entry.name === tool)).toMatchObject({ description: "second" });

	const malformed = await apply({ action: "update", tool, content: `name: ${tool}\ndescription: bad\ngroup: Proposal Fixture\nprovider: broken\n` });
	expect(malformed.status).toBe(422);
	listed = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(projectId)}`)).json();
	expect(listed.tools.find((entry: any) => entry.name === tool)).toMatchObject({ description: "second" });

	const traversal = await apply({ action: "create", tool: "../escape", content: content("escape", "no") });
	expect(traversal.status).toBe(400);
	listed = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(projectId)}`)).json();
	expect(listed.tools.some((entry: any) => entry.name === "escape")).toBe(false);

	const remove = await apply({ action: "delete", tool });
	expect(remove.status).toBe(200);
	listed = await (await apiFetch(`/api/tools?projectId=${encodeURIComponent(projectId)}`)).json();
	expect(listed.tools.some((entry: any) => entry.name === tool)).toBe(false);
});
