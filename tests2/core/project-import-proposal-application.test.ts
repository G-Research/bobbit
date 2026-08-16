import { describe, expect, it } from "vitest";
import {
	ProjectImportProposalApplicationService,
	ProjectImportApplicationError,
} from "../../src/server/proposals/project-import-proposal-application.ts";

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

	it("keeps single-flight state per gateway instance", async () => {
		let calls = 0;
		let release!: (value: {}) => void;
		const pending = new Promise<{}>(resolve => { release = resolve; });
		const first = service(async () => { calls++; return pending; });
		const second = service(async () => { calls++; return {}; });
		const one = first.apply(input());
		const duplicate = first.apply(input());
		await second.apply(input());
		expect(calls).toBe(2);
		release({});
		await Promise.all([one, duplicate]);
	});
});
