import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "./_e2e/in-process-harness.js";
import { apiFetch, defaultProject, projectStateDirForRoot } from "./_e2e/e2e-setup.js";
import { WorktreeServiceCoordinator } from "../../src/server/extension-host/worktree-service-coordinator.ts";

const temporaryRoots: string[] = [];
test.afterEach(() => {
	for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.describe("managed-service gateway wiring", () => {
	test("replaces a live project root by fencing services and reopening its context", async ({ gateway }) => {
		const project = await defaultProject();
		const replacement = fs.mkdtempSync(path.join(project.rootPath, ".managed-service-replacement-"));
		temporaryRoots.push(replacement);

		const contexts = gateway.sessionManager.getProjectContextManager();
		const serviceDataSegments = ["managed-services", "v1", ".", "fixture-worktree", "fixture-pack", "fixture-service", "default"];
		const oldData = path.join(projectStateDirForRoot(project.rootPath), ...serviceDataSegments);
		const newData = path.join(projectStateDirForRoot(replacement), ...serviceDataSegments);
		fs.mkdirSync(oldData, { recursive: true });
		fs.mkdirSync(newData, { recursive: true });
		const calls: string[] = [];
		const originalSuspend = WorktreeServiceCoordinator.prototype.suspendProject;
		const originalStop = WorktreeServiceCoordinator.prototype.stopProject;
		WorktreeServiceCoordinator.prototype.suspendProject = async function (this: WorktreeServiceCoordinator, id: string) {
			// The gateway normally learns this record during reconciliation. Seed one
			// here to exercise the successful PUT transaction with a real owned tree.
			const ref = {
				projectId: id, component: ".", canonicalWorktreeRoot: project.rootPath,
				worktreeKey: "fixture-worktree", packId: "fixture-pack", serviceId: "fixture-service", discriminator: "default",
			};
			const key = [ref.projectId, ref.component, ref.canonicalWorktreeRoot, ref.packId, ref.serviceId, ref.discriminator].join("\0");
			(this as unknown as { knownInstances: Map<string, unknown> }).knownInstances.set(key, { ref, dataBase: oldData });
			calls.push(`suspend:${id}`);
			return originalSuspend.call(this, id);
		};
		WorktreeServiceCoordinator.prototype.stopProject = async function (this: WorktreeServiceCoordinator, id: string) {
			assert.ok([...contexts.all()].some(context => context.project.id === id), "old data is deleted only after the replacement context opens");
			calls.push(`stop:${id}`);
			return originalStop.call(this, id);
		};
		try {
			const response = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}`, {
				method: "PUT",
				body: JSON.stringify({ rootPath: replacement }),
			});
			assert.equal(response.status, 200);
			assert.equal((await response.json()).rootPath, replacement);
		} finally {
			WorktreeServiceCoordinator.prototype.suspendProject = originalSuspend;
			WorktreeServiceCoordinator.prototype.stopProject = originalStop;
		}
		assert.deepEqual(calls, [`suspend:${project.id}`, `stop:${project.id}`]);
		assert.equal(fs.existsSync(oldData), false, "the old root's owned managed-services tree is removed");
		assert.equal(fs.existsSync(newData), true, "the replacement root's managed-services tree remains untouched");
		assert.ok(contexts.getOrCreate(project.id));

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
		const originalStop = WorktreeServiceCoordinator.prototype.stopProject;
		let stopCalls = 0;
		WorktreeServiceCoordinator.prototype.stopProject = async function (this: WorktreeServiceCoordinator, id: string) {
			stopCalls++;
			return originalStop.call(this, id);
		};
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
			WorktreeServiceCoordinator.prototype.stopProject = originalStop;
		}
		assert.equal(stopCalls, 0, "a failed replacement preserves old-root managed-service data");
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
