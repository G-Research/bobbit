import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	buildPerComponentWorkflow,
	buildAllComponentsWorkflow,
} from "../src/server/state-migration/per-component-workflows.ts";
import type { Component } from "../src/server/agent/project-config-store.ts";
import { validateAllWorkflows, type WorkflowComponentRef } from "../src/server/agent/workflow-validator.ts";

const COMPONENTS: Component[] = [
	{
		name: "api",
		repo: "api",
		commands: { build: "npm run build", check: "npm run check", unit: "npm test", e2e: "npm run e2e" },
	},
	{
		name: "web",
		repo: "web",
		commands: { build: "vite build", check: "tsc --noEmit", unit: "vitest" },
	},
	{
		name: "shared-data",
		repo: "shared-data",
		// data-only, no commands
	},
];

const COMPONENT_REFS: WorkflowComponentRef[] = COMPONENTS.map((c) => ({ name: c.name, commands: c.commands }));

describe("buildPerComponentWorkflow", () => {
	it("scopes all { component, command } refs to the chosen component", () => {
		const wf = buildPerComponentWorkflow("api", COMPONENTS);
		assert.equal(wf.id, "feature-api");
		assert.equal(wf.name, "Feature (api)");
		for (const gate of wf.gates) {
			for (const s of gate.verify ?? []) {
				if (s.command) {
					assert.equal(s.component, "api", `step "${s.name}" should target api`);
				}
			}
		}
	});

	it("inherits design-time and post-impl gap-analyses from feature", () => {
		const wf = buildPerComponentWorkflow("api", COMPONENTS);
		const designDoc = wf.gates.find((g) => g.id === "design-doc")!;
		assert.ok(designDoc.verify?.some((s) => s.name === "Gap analysis"));
		const impl = wf.gates.find((g) => g.id === "implementation")!;
		const gap = impl.verify?.find((s) => s.name === "Gap analysis");
		assert.ok(gap);
		assert.equal(gap!.phase, 2);
	});

	it("derived per-component workflow passes the validator", () => {
		const wf = buildPerComponentWorkflow("api", COMPONENTS);
		const errors = validateAllWorkflows({ [wf.id]: wf as any }, COMPONENT_REFS);
		assert.deepEqual(errors, [], `unexpected validator errors: ${JSON.stringify(errors)}`);
	});
});

describe("buildAllComponentsWorkflow", () => {
	it("fans out one build step per buildable component", () => {
		const wf = buildAllComponentsWorkflow(COMPONENTS);
		const impl = wf.gates.find((g) => g.id === "implementation")!;
		const builds = (impl.verify ?? []).filter((s) => s.command === "build");
		assert.equal(builds.length, 2, "api + web each contribute a build step");
		assert.deepEqual(
			builds.map((s) => s.component).sort(),
			["api", "web"],
		);
	});

	it("skips data-only components (no commands)", () => {
		const wf = buildAllComponentsWorkflow(COMPONENTS);
		const impl = wf.gates.find((g) => g.id === "implementation")!;
		const fromShared = (impl.verify ?? []).filter((s) => s.component === "shared-data");
		assert.equal(fromShared.length, 0);
	});

	it("includes design-time and post-impl gap-analyses", () => {
		const wf = buildAllComponentsWorkflow(COMPONENTS);
		const designDoc = wf.gates.find((g) => g.id === "design-doc")!;
		assert.ok(designDoc.verify?.some((s) => s.name === "Gap analysis"));
		const impl = wf.gates.find((g) => g.id === "implementation")!;
		const postImpl = impl.verify?.find((s) => s.name === "Gap analysis");
		assert.ok(postImpl);
		assert.equal(postImpl!.phase, 2);
	});

	it("derived all-components workflow passes the validator", () => {
		const wf = buildAllComponentsWorkflow(COMPONENTS);
		const errors = validateAllWorkflows({ [wf.id]: wf as any }, COMPONENT_REFS);
		assert.deepEqual(errors, [], `unexpected validator errors: ${JSON.stringify(errors)}`);
	});
});
