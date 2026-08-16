import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	ProjectImportProposalApplicationService,
	ProjectImportApplicationError,
	projectImportApplicationKey,
	projectImportSnapshotSha256,
} from "../../src/server/proposals/project-import-proposal-application.ts";
import { proposalDraftOwnerId } from "../../src/server/proposals/proposal-seed-service.ts";
import { writeSnapshot } from "../../src/server/proposals/proposal-files.ts";

const snapshot = "name: imported-role\n";

function input(projectId = "project-1") {
	return {
		projectId,
		importId: "import-1",
		requestId: "request-1",
		type: "role" as const,
		rev: 1,
		snapshot,
		proposal: { type: "role" as const, fields: { name: "imported-role" } },
	};
}

function service(operation: () => Promise<{}>) {
	return new ProjectImportProposalApplicationService({
		goal: operation,
		project: operation,
		workflow: operation,
		role: operation,
		tool: operation,
		staff: operation,
	});
}

describe("ProjectImportProposalApplicationService", () => {
	it("allows an owner-bound draft to omit projectId but rejects a declared cross-project target", () => {
		const application = service(async () => ({}));
		expect(() => application.validate(input())).not.toThrow();
		expect(() => application.validate({ ...input(), proposal: { type: "role", fields: { projectId: "project-2" } } }))
			.toThrow(ProjectImportApplicationError);
	});

	it("dispatches every proposal type through its matching canonical operation", async () => {
		const observed: Array<{ type: string; fields: Record<string, unknown>; key: string }> = [];
		const operations = Object.fromEntries(["goal", "project", "workflow", "role", "tool", "staff"].map(type => [type, async (fields: Record<string, unknown>, application: any) => {
			observed.push({ type, fields, key: application.applicationKey });
			return { outcome: { type } };
		}])) as any;
		const application = new ProjectImportProposalApplicationService(operations);
		for (const type of ["goal", "project", "workflow", "role", "tool", "staff"] as const) {
			const proposal = { type, fields: { projectId: "project-1", marker: `${type}-effect` } } as any;
			await application.apply({ ...input(), requestId: `${type}-request`, type, rev: 1, snapshot: `${type}: snapshot`, proposal });
		}
		expect(observed.map(effect => effect.type)).toEqual(["goal", "project", "workflow", "role", "tool", "staff"]);
		expect(observed.map(effect => effect.fields.marker)).toEqual(["goal-effect", "project-effect", "workflow-effect", "role-effect", "tool-effect", "staff-effect"]);
		expect(new Set(observed.map(effect => effect.key)).size).toBe(6);
	});

	it("shares concurrent callers, retries deterministic failures, and never carries flights into another gateway", async () => {
		let calls = 0;
		let release!: (value: {}) => void;
		const pending = new Promise<{}>(resolve => { release = resolve; });
		const first = service(async () => { calls++; return pending; });
		const second = service(async () => { calls++; return {}; });
		const one = first.apply(input());
		const duplicate = first.apply(input());
		await second.apply(input());
		expect(calls).toBe(2);
		release({ outcome: "shared" });
		expect(await one).toEqual({ outcome: "shared" });
		expect(await duplicate).toEqual({ outcome: "shared" });

		let attempts = 0;
		const retry = service(async () => {
			attempts++;
			if (attempts === 1) throw new ProjectImportApplicationError(422, "INVALID_PROPOSAL", "deterministic pre-effect rejection");
			return { outcome: "retried" };
		});
		await expect(retry.apply(input())).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
		expect(await retry.apply(input())).toEqual({ outcome: "retried" });
		expect(attempts).toBe(2);
	});

	it("adopts an applying contextless boot claim only from its immutable snapshot and rejects persistence ambiguity", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-import-boot-adoption-"));
		const projectId = "project-boot";
		const importId = "import-boot";
		const requestId = "request-boot";
		const snapshot = "name: adopted-role\nlabel: Adopted role\nprompt: Adopted safely\n";
		const owner = proposalDraftOwnerId({ kind: "project-import", projectId, importId, requestId });
		let applied = 0;
		const application = service(async () => { applied++; return { outcome: { role: "adopted-role" } }; });
		const identity: any = {
			projectId, importId, requestId, type: "role", rev: 1,
			snapshotSha256: projectImportSnapshotSha256(snapshot),
			key: projectImportApplicationKey({ projectId, importId, requestId, type: "role", rev: 1, snapshot }),
		};
		const applying = { proposal: { status: "applying", application: identity } } as any;
		try {
			await writeSnapshot(stateDir, owner, "role", 1, snapshot);
			expect(await application.reconcileApplying(stateDir, applying, identity)).toEqual({ outcome: { role: "adopted-role" } });
			expect(applied).toBe(1);
			// A boot record has no session id; adoption is bound to durable identity,
			// not a fabricated session context.
			expect((applying as any).sessionId).toBeUndefined();
			fs.rmSync(path.join(stateDir, "proposal-drafts", owner, "role.history", "1.yaml"));
			await expect(application.reconcileApplying(stateDir, applying, identity)).rejects.toMatchObject({ code: "SNAPSHOT_MISMATCH" });
			await writeSnapshot(stateDir, owner, "role", 1, "name: only-name\n");
			const invalidIdentity = { ...identity, snapshotSha256: projectImportSnapshotSha256("name: only-name\n") };
			await expect(application.reconcileApplying(stateDir, { proposal: { status: "applying", application: invalidIdentity } } as any, invalidIdentity)).rejects.toMatchObject({ code: "INVALID_PROPOSAL" });
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});
});
