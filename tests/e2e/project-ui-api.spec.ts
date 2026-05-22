/**
 * API/data-path coverage split out of project/add-project browser UI specs.
 * Browser specs keep the user-visible path, file-picker, modal, and navigation
 * assertions; this file owns registry/archive checks that do not need Chromium.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, registerProject } from "./e2e-setup.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmRoot(root: string | undefined): void {
	if (!root) return;
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

async function listProjects(): Promise<any[]> {
	const res = await apiFetch("/api/projects");
	expect(res.status).toBe(200);
	const body = await res.json();
	return Array.isArray(body) ? body : body.projects || [];
}

async function deleteProject(id: string | undefined): Promise<void> {
	if (!id) return;
	await apiFetch(`/api/projects/${id}`, { method: "DELETE" }).catch(() => {});
}

async function archiveBobbit(rootPath: string): Promise<any> {
	const res = await apiFetch("/api/projects/archive-bobbit", {
		method: "POST",
		body: JSON.stringify({ rootPath }),
	});
	expect(res.status).toBe(200);
	return res.json();
}

test.describe("Project/add-project API data paths", () => {
	test("API-created projects are listed and removable", async () => {
		const rootPath = tmpRoot("bobbit-project-ui-api-registry-");
		let projectId: string | undefined;
		try {
			const project = await registerProject({
				name: `project-ui-api-${Date.now()}`,
				rootPath,
				seedWorkflows: false,
			});
			projectId = project.id;

			let projects = await listProjects();
			expect(projects.find((p: any) => p.id === projectId && p.rootPath === rootPath)).toBeTruthy();

			await deleteProject(projectId);
			projectId = undefined;
			projects = await listProjects();
			expect(projects.find((p: any) => p.id === project.id)).toBeFalsy();
		} finally {
			await deleteProject(projectId);
			rmRoot(rootPath);
		}
	});

	test("archive-bobbit increments archives and preserves gateway-owned state", async () => {
		const root = tmpRoot("bobbit-project-ui-api-archive-");
		try {
			fs.mkdirSync(path.join(root, ".bobbit", "config"), { recursive: true });
			fs.mkdirSync(path.join(root, ".bobbit", "state"), { recursive: true });
			fs.writeFileSync(path.join(root, ".bobbit", "config", "system-prompt.md"), "test\n");
			fs.writeFileSync(path.join(root, ".bobbit", "state", "marker.json"), "{}");
			fs.writeFileSync(path.join(root, ".bobbit", "state", "gateway-url"), "https://localhost:3001\n");

			const first = await archiveBobbit(root);
			expect(first.gatewayOwned).toBe(true);
			expect(path.basename(first.archiveDir)).toBe(".bobbit-archive-001");
			expect(fs.existsSync(path.join(root, ".bobbit-archive-001", "config", "system-prompt.md"))).toBe(true);
			expect(fs.existsSync(path.join(root, ".bobbit-archive-001", "state", "marker.json"))).toBe(true);
			expect(fs.existsSync(path.join(root, ".bobbit", "state", "gateway-url"))).toBe(true);
			expect(fs.existsSync(path.join(root, ".bobbit", "config", "system-prompt.md"))).toBe(false);

			fs.writeFileSync(path.join(root, ".bobbit", "config", "system-prompt.md"), "round-2\n");
			const second = await archiveBobbit(root);
			expect(second.gatewayOwned).toBe(true);
			expect(path.basename(second.archiveDir)).toBe(".bobbit-archive-002");
			expect(fs.existsSync(path.join(root, ".bobbit-archive-002", "config", "system-prompt.md"))).toBe(true);
			expect(fs.existsSync(path.join(root, ".bobbit", "state", "gateway-url"))).toBe(true);
		} finally {
			rmRoot(root);
		}
	});
});
