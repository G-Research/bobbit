import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { state } from "../../src/app/state.js";
import {
	resolveProjectMode,
	resolveProjectProposalTarget,
} from "../../src/app/session-manager.js";

const SESSION_ID = "source-session";

beforeEach(() => {
	state.projects = [
		{ id: "headquarters", provisional: false } as any,
		{ id: "registered-source", provisional: false } as any,
		{ id: "provisional-source", provisional: true } as any,
		{ id: "registered-target", provisional: false } as any,
		{ id: "provisional-target", provisional: true } as any,
	];
	state.gatewaySessions.length = 0;
});

afterEach(() => {
	state.projects = [];
	state.gatewaySessions.length = 0;
});

function bindSource(projectId: string): void {
	state.gatewaySessions.push({ id: SESSION_ID, projectId } as any);
}

describe("resolveProjectProposalTarget", () => {
	it.each([
		["registered source", "registered-source", undefined],
		["Headquarters source", "headquarters", {}],
		["provisional source", "provisional-source", { name: "New Project" }],
		["blank id", "registered-source", { projectId: "   " }],
	] as const)("classifies absent projectId as create for a %s", (_label, sourceId, fields) => {
		bindSource(sourceId);

		expect(resolveProjectProposalTarget(fields)).toEqual({ kind: "create" });
		expect(resolveProjectMode(fields)).toBe("create");
		// The compatibility overload must ignore the source session too.
		expect(resolveProjectMode(SESSION_ID, fields)).toBe("create");
	});

	it.each([
		[
			"registered",
			{ projectId: " registered-target " },
			{ kind: "existing", projectId: "registered-target", provisional: false },
			"registered",
		],
		[
			"provisional",
			{ projectId: "provisional-target" },
			{ kind: "existing", projectId: "provisional-target", provisional: true },
			"provisional",
		],
	] as const)("resolves an explicit %s target independently of its source", (_label, fields, target, mode) => {
		bindSource("provisional-source");
		expect(resolveProjectProposalTarget(fields)).toEqual(target);
		expect(resolveProjectMode(SESSION_ID, fields)).toBe(mode);

		state.gatewaySessions[0]!.projectId = "registered-source";
		expect(resolveProjectProposalTarget(fields)).toEqual(target);
		expect(resolveProjectMode(SESSION_ID, fields)).toBe(mode);
	});

	it.each(["registered-source", "provisional-source", "headquarters"])(
		"rejects an explicit unknown id instead of falling back to source %s",
		(sourceId) => {
			bindSource(sourceId);
			const fields = { projectId: " missing-project " };

			expect(resolveProjectProposalTarget(fields)).toEqual({
				kind: "unknown",
				projectId: "missing-project",
			});
			expect(resolveProjectMode(SESSION_ID, fields)).toBe("invalid");
		},
	);

	it("does not inspect session state when resolving a target", () => {
		bindSource("registered-source");
		expect(resolveProjectProposalTarget(undefined, [])).toEqual({ kind: "create" });
		expect(resolveProjectProposalTarget({ projectId: "registered-target" }, [])).toEqual({
			kind: "unknown",
			projectId: "registered-target",
		});
	});
});
