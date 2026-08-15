import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "./_e2e/in-process-harness.js";
import { apiFetch, defaultProject } from "./_e2e/e2e-setup.js";

const temporaryRoots: string[] = [];
test.afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.describe("managed-service gateway wiring", () => {
	test("replaces a live project root by fencing services and reopening its context", async ({ gateway }) => {
		const project = await defaultProject();
		const replacement = fs.mkdtempSync(path.join(project.rootPath, ".managed-service-replacement-"));
		temporaryRoots.push(replacement);

		const response = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
			method: "PUT",
			body: JSON.stringify({ rootPath: replacement }),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).rootPath, replacement);
		assert.ok(gateway.sessionManager.getProjectContextManager().getOrCreate(project.id));

		// A second settings-like edit proves the replacement did not retain an old
		// closed context or leave the project registry/context roots mismatched.
		const followUp = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
			method: "PUT",
			body: JSON.stringify({ name: "Replacement remains live" }),
		});
		assert.equal(followUp.status, 200);
		assert.equal((await followUp.json()).name, "Replacement remains live");

		// Restore the shared default fixture root before its temporary replacement is
		// removed, so the harness does not self-heal it into a leaked project.
		const restored = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
			method: "PUT",
			body: JSON.stringify({ rootPath: project.rootPath }),
		});
		assert.equal(restored.status, 200);
	});

	test("rolls the registry and live context back when reopening a replacement root fails", async ({ gateway }) => {
		const project = await defaultProject();
		const replacement = fs.mkdtempSync(path.join(project.rootPath, ".managed-service-reopen-failure-"));
		temporaryRoots.push(replacement);
		const contexts: any = gateway.sessionManager.getProjectContextManager();
		const originalGetOrCreate = contexts.getOrCreate.bind(contexts);
		let failNextProjectOpen = true;
		contexts.getOrCreate = (id: string) => {
			if (id === project.id && failNextProjectOpen) {
				failNextProjectOpen = false;
				throw new Error("replacement context open failed");
			}
			return originalGetOrCreate(id);
		};
		try {
			const response = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
				method: "PUT",
				body: JSON.stringify({ rootPath: replacement }),
			});
			assert.notEqual(response.status, 200);
		} finally {
			contexts.getOrCreate = originalGetOrCreate;
		}
		const projectAfterFailure = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`);
		assert.equal((await projectAfterFailure.json()).rootPath, project.rootPath);
		assert.ok(contexts.getOrCreate(project.id));
	});

	test("restores a live old-root context when removal reports a close failure", async ({ gateway }) => {
		const project = await defaultProject();
		const replacement = fs.mkdtempSync(path.join(project.rootPath, ".managed-service-remove-failure-"));
		temporaryRoots.push(replacement);
		const contexts: any = gateway.sessionManager.getProjectContextManager();
		const originalRemove = contexts.remove.bind(contexts);
		contexts.remove = async (id: string) => {
			await originalRemove(id);
			throw new Error("context close failed");
		};
		try {
			const response = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
				method: "PUT",
				body: JSON.stringify({ rootPath: replacement }),
			});
			assert.notEqual(response.status, 200);
		} finally {
			contexts.remove = originalRemove;
		}
		const projectAfterFailure = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`);
		assert.equal((await projectAfterFailure.json()).rootPath, project.rootPath);
		assert.ok(contexts.getOrCreate(project.id));
	});
});
