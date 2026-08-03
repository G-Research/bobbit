import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
	name: string;
	run?: string;
	uses?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};

type BuildUnitGateWorkflow = {
	on: {
		pull_request: { branches: string[] };
		push: { branches: string[] };
	};
	jobs: {
		"affected-feedback": {
			if: string;
			"runs-on": string;
			"timeout-minutes": number;
			steps: WorkflowStep[];
		};
		verify: {
			"timeout-minutes": number;
			strategy: {
				matrix: {
					os: string[];
					node: string[];
					include: Array<{ os: string; node: string }>;
				};
			};
			steps: WorkflowStep[];
		};
	};
};

const WORKFLOW_PATH = new URL("../../.github/workflows/build-unit-gate.yml", import.meta.url);

function workflowSource(): string {
	return readFileSync(WORKFLOW_PATH, "utf8");
}

function readWorkflow(): BuildUnitGateWorkflow {
	return YAML.parse(workflowSource()) as BuildUnitGateWorkflow;
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
		assert.equal(
			steps.some((step) => step.run?.includes("test:affected")),
			false,
			"affected feedback must not replace the authoritative full-suite job",
		);
	});

	it("adds PR-only affected feedback with full history and no persisted credentials", () => {
		const feedback = readWorkflow().jobs["affected-feedback"];
		assert.equal(feedback.if, "github.event_name == 'pull_request'");
		assert.equal(feedback["runs-on"], "ubuntu-latest");
		assert.equal(feedback["timeout-minutes"], 20);

		const checkout = feedback.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
		assert.ok(checkout, "affected feedback must check out the pull request");
		assert.equal(checkout.with?.["fetch-depth"], 0, "merge-base selection requires full history");
		assert.equal(checkout.with?.["persist-credentials"], false);

		const setup = feedback.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
		assert.equal(setup?.with?.["node-version"], "22.19.0");
		assert.equal(feedback.steps.some((step) => step.run === "npm ci"), true);
	});

	it("validates the explicit PR base and keeps affected results job-local", () => {
		const feedback = readWorkflow().jobs["affected-feedback"];
		const expectedBase = "${{ github.event.pull_request.base.sha }}";
		const validate = feedback.steps.find((step) => step.name === "Validate PR merge base");
		const affected = feedback.steps.find((step) => step.name === "Affected unit feedback");

		assert.equal(validate?.env?.PR_BASE_SHA, expectedBase);
		assert.match(validate?.run ?? "", /git merge-base "\$PR_BASE_SHA" HEAD/);
		assert.match(validate?.run ?? "", /test -n "\$merge_base"/);
		assert.equal(affected?.env?.PR_BASE_SHA, expectedBase);
		assert.equal(affected?.run, 'npm run test:affected -- --base "$PR_BASE_SHA" --no-cache');
		assert.doesNotMatch(
			workflowSource(),
			/\.profiles\/test-cache/,
			"local affected-result cache must never be uploaded, restored, or shared in CI",
		);
	});
});
