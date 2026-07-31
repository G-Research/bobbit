import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import YAML from "yaml";

type BuildUnitGateWorkflow = {
	on: {
		pull_request: { branches: string[] };
		push: { branches: string[] };
	};
	jobs: {
		verify: {
			"timeout-minutes": number;
			strategy: {
				matrix: {
					os: string[];
					node: string[];
					include: Array<{ os: string; node: string }>;
				};
			};
			steps: Array<{ name: string; run?: string }>;
		};
	};
};

const WORKFLOW_PATH = new URL("../../.github/workflows/build-unit-gate.yml", import.meta.url);

function readWorkflow(): BuildUnitGateWorkflow {
	return YAML.parse(readFileSync(WORKFLOW_PATH, "utf8")) as BuildUnitGateWorkflow;
}

describe("build-unit-gate CI qualification", () => {
	it("qualifies pull requests and pushes to the primary branch", () => {
		const workflow = readWorkflow();
		assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
		assert.deepEqual(workflow.on.push.branches, ["main"]);
	});

	it("runs the unit inventory natively on every supported OS with Node 26 coverage", () => {
		const verify = readWorkflow().jobs.verify;
		const matrix = verify.strategy.matrix;
		assert.equal(verify["timeout-minutes"], 20, "qualification must retain the original timeout");
		assert.deepEqual(matrix.os, ["ubuntu-latest", "windows-latest", "macos-latest"]);
		assert.deepEqual(matrix.node, ["22.19.0"]);
		assert.deepEqual(matrix.include, [{ os: "ubuntu-latest", node: "26.x" }]);
	});

	it("runs the standard unit gate once after build and type-check", () => {
		const steps = readWorkflow().jobs.verify.steps;
		const buildIndex = steps.findIndex((step) => step.name === "Build");
		const typeCheckIndex = steps.findIndex((step) => step.name === "Type-check");
		const unitGates = steps.filter((step) => step.name === "Unit gate");

		assert.ok(buildIndex >= 0, "workflow must build before qualification");
		assert.ok(typeCheckIndex > buildIndex, "workflow must type-check after building");
		assert.equal(unitGates.length, 1, "workflow must run the unit suite once");
		assert.equal(steps[typeCheckIndex + 1]?.name, "Unit gate", "unit gate must start immediately after type-checking");
		assert.equal(unitGates[0]?.run, "npm run test:unit", "branch checks use the normal Vitest retry policy");
	});
});
