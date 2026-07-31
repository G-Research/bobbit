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

	it("runs five retry-free unit-gate attempts after build and type-check", () => {
		const steps = readWorkflow().jobs.verify.steps;
		const buildIndex = steps.findIndex((step) => step.name === "Build");
		const typeCheckIndex = steps.findIndex((step) => step.name === "Type-check");
		const unitGates = steps.filter((step) => step.name?.startsWith("Unit gate (attempt "));
		const expectedUnitGateNames = [
			"Unit gate (attempt 1 of 5)",
			"Unit gate (attempt 2 of 5)",
			"Unit gate (attempt 3 of 5)",
			"Unit gate (attempt 4 of 5)",
			"Unit gate (attempt 5 of 5)",
		];

		assert.ok(buildIndex >= 0, "workflow must build before qualification");
		assert.ok(typeCheckIndex > buildIndex, "workflow must type-check after building");
		assert.equal(unitGates.length, 5, "workflow must qualify five consecutive unit-gate attempts");
		assert.deepEqual(unitGates.map((step) => step.name), expectedUnitGateNames);
		assert.deepEqual(
			steps.slice(typeCheckIndex + 1, typeCheckIndex + 1 + expectedUnitGateNames.length).map((step) => step.name),
			expectedUnitGateNames,
			"unit qualification must start immediately after type-checking and remain consecutive",
		);
		for (const unitGate of unitGates) {
			assert.equal(unitGate.run, "npm run test:unit -- --retry=0");
		}
	});
});
