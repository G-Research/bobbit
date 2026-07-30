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
		const matrix = readWorkflow().jobs.verify.strategy.matrix;
		assert.deepEqual(matrix.os, ["ubuntu-latest", "windows-latest", "macos-latest"]);
		assert.deepEqual(matrix.node, ["22.19.0"]);
		assert.deepEqual(matrix.include, [{ os: "ubuntu-latest", node: "26.x" }]);
	});

	it("rejects retry-masked qualification evidence", () => {
		const unitGate = readWorkflow().jobs.verify.steps.find((step) => step.name === "Unit gate (first attempt)");
		assert.ok(unitGate, "workflow must include the retry-free unit qualification step");
		assert.equal(unitGate.run, "npm run test:unit -- --retry=0");
	});
});
