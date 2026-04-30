import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDefaultWorkflows, RALPH_LOOP_DESCRIPTION } from "../src/server/state-migration/seed-default-workflows.ts";

describe("buildDefaultWorkflows", () => {
	const wfs = buildDefaultWorkflows("myproj");

	function findGate(workflow: ReturnType<typeof buildDefaultWorkflows>[string], id: string) {
		const g = workflow.gates.find((x) => x.id === id);
		assert.ok(g, `gate ${id} should exist in workflow ${workflow.id}`);
		return g!;
	}

	it("general has design-time gap-analysis", () => {
		const designDoc = findGate(wfs.general, "design-doc");
		const has = designDoc.verify?.some((s) => s.name === "Gap analysis");
		assert.equal(has, true);
	});

	it("general has post-impl gap-analysis (phase 2)", () => {
		const impl = findGate(wfs.general, "implementation");
		const gap = impl.verify?.find((s) => s.name === "Gap analysis");
		assert.ok(gap);
		assert.equal(gap!.phase, 2);
		assert.equal(gap!.role, "spec-auditor");
	});

	it("feature still has both gap-analyses", () => {
		const f = wfs.feature;
		assert.ok(findGate(f, "design-doc").verify?.some((s) => s.name === "Gap analysis"));
		const impl = findGate(f, "implementation");
		const gap = impl.verify?.find((s) => s.name === "Gap analysis");
		assert.ok(gap);
		assert.equal(gap!.phase, 2);
	});

	it("quick-fix has neither gap-analysis", () => {
		const qf = wfs["quick-fix"];
		for (const g of qf.gates) {
			for (const s of g.verify ?? []) {
				assert.notEqual(s.name, "Gap analysis");
			}
		}
	});

	it("implementation gates carry Ralph-loop description for general/feature/bug-fix", () => {
		for (const id of ["general", "feature", "bug-fix"]) {
			const impl = findGate(wfs[id], "implementation");
			assert.equal(impl.description, RALPH_LOOP_DESCRIPTION, `${id}.implementation.description`);
		}
	});

	it("quick-fix implementation has a (shorter) Ralph-loop description", () => {
		const impl = findGate(wfs["quick-fix"], "implementation");
		assert.ok(impl.description && impl.description.toLowerCase().includes("ralph loop"));
	});
});
