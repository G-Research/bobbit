// v2-native — transactional sandbox plan recreation regression coverage. Listed in tests-map.json `v2Native`.

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ProjectSandbox, type ProjectSandboxOptions } from "../../src/server/agent/project-sandbox.js";
import { SandboxManager } from "../../src/server/agent/sandbox-manager.js";
import { sandboxImageRequirements } from "../../src/server/agent/sandbox-image-requirements.js";

function options(projectId: string, image: string, fingerprint: string): ProjectSandboxOptions {
	return {
		projectId,
		projectDir: process.cwd(),
		repoUrl: "https://example.test/repo.git",
		image,
		sandboxImageFingerprint: fingerprint,
	};
}

describe("transactional sandbox plan recreation", () => {
	it("aborts on a generic remove failure without changing applied container authority", async () => {
		const planA = options("transaction-a", "image-a", "fingerprint-a");
		const planB = options("transaction-a", "image-b", "fingerprint-b");
		const sandbox = new ProjectSandbox(planA);
		const events: string[] = [];
		(sandbox as any).containerId = "container-a";
		(sandbox as any)._status = "ready";
		(sandbox as any)._removeContainer = async () => { throw new Error("docker daemon permission denied"); };
		(sandbox as any).init = async () => { throw new Error("B must not initialize"); };
		sandbox.onHealthEvent((event) => events.push(`${event.type}:${event.containerId}`));

		await assert.rejects(() => sandbox.recreate(planB), /permission denied/);
		assert.equal((sandbox as any).options, planA);
		assert.equal(sandbox.getStatus().containerId, "container-a");
		assert.equal(sandbox.getStatus().status, "ready");
		assert.deepEqual(events, []);
	});

	it("ignores only Docker's exact no-such-container response", async () => {
		const containerId = "a".repeat(64);
		const exactAbsent = new ProjectSandbox(options("exact-absence", "image-a", "fingerprint-a"), {
			commandRunner: {
				execFile: async () => {
					const error = new Error("docker failed") as Error & { stderr?: string };
					error.stderr = `Error response from daemon: No such container: ${containerId}`;
					throw error;
				},
			},
		});
		await assert.doesNotReject(() => (exactAbsent as any)._removeContainer(containerId));

		const genericFailure = new ProjectSandbox(options("generic-failure", "image-a", "fingerprint-a"), {
			commandRunner: { execFile: async () => { throw new Error("docker daemon unavailable"); } },
		});
		await assert.rejects(() => (genericFailure as any)._removeContainer(containerId), /daemon unavailable/);
	});

	it("restores A from its prior options when B initialization fails", async () => {
		const planA = options("rollback-project", "image-a", "fingerprint-a");
		const planB = options("rollback-project", "image-b", "fingerprint-b");
		const sandbox = new ProjectSandbox(planA);
		const calls: string[] = [];
		const events: string[] = [];
		(sandbox as any).containerId = "container-a";
		(sandbox as any)._status = "ready";
		(sandbox as any)._removeContainer = async (id: string) => calls.push(`remove:${id}`);
		(sandbox as any).init = async () => {
			calls.push(`init:${(sandbox as any).options.image}`);
			(sandbox as any).containerId = "container-b-partial";
			throw new Error("B initialization failed");
		};
		(sandbox as any)._initializeFreshContainer = async () => {
			calls.push(`restore:${(sandbox as any).options.image}`);
			(sandbox as any).containerId = "container-a-restored";
			(sandbox as any)._status = "ready";
		};
		sandbox.onHealthEvent((event) => events.push(`${event.type}:${event.containerId}`));

		await assert.rejects(() => sandbox.recreate(planB), /B initialization failed/);
		assert.equal((sandbox as any).options, planA);
		assert.equal(sandbox.getStatus().containerId, "container-a-restored");
		assert.equal(sandbox.getStatus().status, "ready");
		assert.deepEqual(calls, [
			"remove:container-a",
			"init:image-b",
			"remove:container-b-partial",
			"restore:image-a",
		]);
		assert.deepEqual(events, ["container-died:container-a", "container-recovered:container-a-restored"]);
	});

	it("commits the desired identity only after B is ready and isolates another project", async () => {
		const planA = options("project-a", "image-a", "fingerprint-a");
		const planB = options("project-a", "image-b", "fingerprint-b");
		const planC = options("project-b", "image-c", "fingerprint-c");
		const manager = new SandboxManager({
			bootstrap: async (projectId) => projectId === "project-a" ? planB : planC,
		});
		const failedA = {
			getStatus: () => ({ projectId: "project-a", status: "ready", containerId: "container-a" }),
			recreate: async () => { throw new Error("B failed after transition"); },
		};
		const readyB = {
			getStatus: () => ({ projectId: "project-b", status: "ready", containerId: "container-c" }),
			recreate: async () => { throw new Error("second project must not recreate"); },
		};
		(manager as any).sandboxes = new Map([["project-a", failedA], ["project-b", readyB]]);
		(manager as any)._appliedImagePlans = new Map([
			["project-a", { image: planA.image, fingerprint: planA.sandboxImageFingerprint }],
			["project-b", { image: planC.image, fingerprint: planC.sandboxImageFingerprint }],
		]);

		try {
			await assert.rejects(() => manager.ensureForProject("project-a"), /B failed after transition/);
			assert.deepEqual((manager as any)._appliedImagePlans.get("project-a"), {
				image: planA.image,
				fingerprint: planA.sandboxImageFingerprint,
			});
			assert.deepEqual((manager as any)._appliedImagePlans.get("project-b"), {
				image: planC.image,
				fingerprint: planC.sandboxImageFingerprint,
			});
			assert.equal(manager.get("project-b"), readyB);
			assert.equal(sandboxImageRequirements.getBuildFailure("project-a", "fingerprint-b")?.code, "build-failed");
		} finally {
			sandboxImageRequirements.recordBuildSuccess("project-a", "fingerprint-b");
		}
	});

	it("replaces A with B only after B becomes ready", async () => {
		const planA = options("successful-replacement", "image-a", "fingerprint-a");
		const planB = options("successful-replacement", "image-b", "fingerprint-b");
		const sandbox = new ProjectSandbox(planA);
		const events: string[] = [];
		(sandbox as any).containerId = "container-a";
		(sandbox as any)._status = "ready";
		(sandbox as any)._removeContainer = async () => {};
		(sandbox as any).init = async () => {
			assert.equal((sandbox as any).options, planB);
			(sandbox as any).containerId = "container-b";
			(sandbox as any)._status = "ready";
		};
		sandbox.onHealthEvent((event) => events.push(`${event.type}:${event.containerId}`));

		await sandbox.recreate(planB);
		assert.equal((sandbox as any).options, planB);
		assert.equal(sandbox.getStatus().containerId, "container-b");
		assert.deepEqual(events, ["container-died:container-a", "container-recovered:container-b"]);

		const manager = new SandboxManager({ bootstrap: async () => planB });
		const managerSandbox = {
			getStatus: () => ({ projectId: planA.projectId, status: "ready", containerId: "container-a" }),
			recreate: async () => {
				assert.deepEqual((manager as any)._appliedImagePlans.get(planA.projectId), {
					image: planA.image,
					fingerprint: planA.sandboxImageFingerprint,
				});
			},
		};
		(manager as any).sandboxes.set(planA.projectId, managerSandbox);
		(manager as any)._appliedImagePlans.set(planA.projectId, {
			image: planA.image,
			fingerprint: planA.sandboxImageFingerprint,
		});
		await manager.ensureForProject(planA.projectId);
		assert.deepEqual((manager as any)._appliedImagePlans.get(planA.projectId), {
			image: planB.image,
			fingerprint: planB.sandboxImageFingerprint,
		});
	});
});
