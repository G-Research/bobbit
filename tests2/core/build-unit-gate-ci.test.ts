import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import YAML from "yaml";

type BranchTrigger = { branches: string[] };
type NoInputDispatch = Record<string, never>;
type WorkflowStep = {
	name: string;
	if?: string;
	run?: string;
	uses?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
};

type CrossOsGateJob = {
	if: string;
	"runs-on": string;
	"timeout-minutes": number;
	strategy: {
		"fail-fast": boolean;
		matrix: { os: string[] };
	};
	steps: WorkflowStep[];
};

type BuildUnitGateWorkflow = {
	on: {
		pull_request: BranchTrigger;
		push: BranchTrigger;
		workflow_dispatch: NoInputDispatch;
	};
	permissions: { contents: string; "pull-requests": string };
	jobs: {
		verify: {
			"runs-on": string;
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
		browser: CrossOsGateJob;
		e2e: CrossOsGateJob;
	};
};

type CodeQlWorkflow = {
	on: {
		pull_request: BranchTrigger;
		push: BranchTrigger;
		schedule: Array<{ cron: string }>;
		workflow_dispatch: NoInputDispatch;
	};
	permissions: { contents: string };
	jobs: {
		analyze: {
			"runs-on": string;
			permissions: Record<string, string>;
			strategy: { matrix: { language: string[] } };
			steps: Array<{ name: string; uses?: string }>;
		};
	};
};

const BUILD_UNIT_GATE_WORKFLOW_PATH = new URL("../../.github/workflows/build-unit-gate.yml", import.meta.url);
const CODEQL_WORKFLOW_PATH = new URL("../../.github/workflows/codeql.yml", import.meta.url);

function workflowSource(path: URL): string {
	return readFileSync(path, "utf8");
}

function readWorkflow<T>(path: URL): T {
	return YAML.parse(workflowSource(path)) as T;
}

function stepByName(steps: WorkflowStep[], name: string): WorkflowStep {
	const step = steps.find((candidate) => candidate.name === name);
	assert.ok(step, `workflow must include ${name}`);
	return step;
}

describe("native CI qualification workflows", () => {
	it("retains build-unit branch triggers and permits no-input exact-head dispatch", () => {
		const workflow = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH);
		assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
		assert.deepEqual(workflow.on.push.branches, ["main"]);
		assert.deepEqual(workflow.on.workflow_dispatch, {});
		assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "read" });
	});

	it("runs the unit inventory natively on every supported OS with Node 26 coverage", () => {
		const verify = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH).jobs.verify;
		const matrix = verify.strategy.matrix;
		assert.equal(verify["runs-on"], "${{ matrix.os }}");
		assert.equal(verify["timeout-minutes"], 20, "qualification must retain the original timeout");
		assert.deepEqual(matrix.os, ["ubuntu-latest", "windows-latest", "macos-latest"]);
		assert.deepEqual(matrix.node, ["22.19.0"]);
		assert.deepEqual(matrix.include, [{ os: "ubuntu-latest", node: "26.x" }]);
		assert.equal(stepByName(verify.steps, "Checkout").uses, "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd");
		assert.equal(stepByName(verify.steps, "Set up Node").uses, "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
	});

	it("runs the standard unit gate once after build and type-check", () => {
		const steps = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH).jobs.verify.steps;
		const buildIndex = steps.findIndex((step) => step.name === "Build");
		const typeCheckIndex = steps.findIndex((step) => step.name === "Type-check");
		const unitGates = steps.filter((step) => step.name === "Unit gate");

		assert.ok(buildIndex >= 0, "workflow must build before qualification");
		assert.ok(typeCheckIndex > buildIndex, "workflow must type-check after building");
		assert.deepEqual(
			steps[typeCheckIndex]?.env,
			{ NODE_OPTIONS: "--max-old-space-size=4096" },
			"type-checking must have enough heap for the complete tests2 program on native CI",
		);
		assert.equal(unitGates.length, 1, "workflow must run the unit suite once");
		assert.equal(steps[typeCheckIndex + 1]?.name, "Unit gate", "unit gate must start immediately after type-checking");
		assert.equal(unitGates[0]?.run, "npm run test:unit", "branch checks use the normal Vitest retry policy");
		assert.equal(
			steps.some((step) => step.run?.includes("test:affected")),
			false,
			"affected feedback must not replace the authoritative full-suite job",
		);
	});

	it("runs browser and E2E PR checks natively on every supported OS", () => {
		const jobs = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH).jobs;
		const expectedOs = ["ubuntu-latest", "windows-latest", "macos-latest"];

		for (const [name, job, gateStep, command] of [
			["browser", jobs.browser, "Browser gate", "npm run test:browser"],
			["e2e", jobs.e2e, "E2E gate", "npm run test:e2e"],
		] as const) {
			assert.equal(job.if, "github.event_name == 'pull_request'", `${name} must run only for PR checks`);
			assert.equal(job["runs-on"], "${{ matrix.os }}");
			assert.equal(job["timeout-minutes"], 40);
			assert.equal(job.strategy["fail-fast"], false);
			assert.deepEqual(job.strategy.matrix.os, expectedOs);
			assert.equal(stepByName(job.steps, "Checkout").uses, "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd");
			assert.equal(stepByName(job.steps, "Set up Node").uses, "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
			assert.equal(stepByName(job.steps, "Install").run, "npm ci");
			assert.deepEqual(
				stepByName(job.steps, "Install Chromium with dependencies"),
				{
					name: "Install Chromium with dependencies",
					if: "runner.os == 'Linux'",
					run: "npx playwright install --with-deps chromium",
				},
			);
			assert.deepEqual(
				stepByName(job.steps, "Install Chromium"),
				{
					name: "Install Chromium",
					if: "runner.os != 'Linux'",
					run: "npx playwright install chromium",
				},
			);
			assert.equal(stepByName(job.steps, gateStep).run, command);
		}

		const sandboxBuild = stepByName(jobs.e2e.steps, "Build sandbox image");
		assert.equal(sandboxBuild.if, "runner.os == 'Linux'", "only the Linux runner exposes Docker");
		assert.match(sandboxBuild.run ?? "", /PI_AGENT_VERSION=.*@earendil-works\/pi-coding-agent/);
		assert.match(sandboxBuild.run ?? "", /docker build --build-arg .* -t bobbit-agent docker\//);
		assert.doesNotMatch(
			workflowSource(BUILD_UNIT_GATE_WORKFLOW_PATH),
			/BOBBIT_V2_RETRY_FREE/,
			"ordinary PR checks must retain the repository's normal workflow retry policy",
		);
	});

	it("keeps affected testing out of CI", () => {
		const workflow = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH);
		assert.equal("affected-feedback" in workflow.jobs, false);
		assert.doesNotMatch(workflowSource(BUILD_UNIT_GATE_WORKFLOW_PATH), /test:affected/);
	});

	it("retains CodeQL branch and scheduled triggers while permitting no-input exact-head dispatch", () => {
		const workflow = readWorkflow<CodeQlWorkflow>(CODEQL_WORKFLOW_PATH);
		assert.deepEqual(workflow.on.push.branches, ["main"]);
		assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
		assert.deepEqual(workflow.on.schedule, [{ cron: "27 4 * * 1" }]);
		assert.deepEqual(workflow.on.workflow_dispatch, {});
		assert.deepEqual(workflow.permissions, { contents: "read" });
	});

	it("retains the CodeQL job security permissions, languages, and pinned actions", () => {
		const analyze = readWorkflow<CodeQlWorkflow>(CODEQL_WORKFLOW_PATH).jobs.analyze;
		assert.equal(analyze["runs-on"], "ubuntu-latest");
		assert.deepEqual(analyze.permissions, {
			"security-events": "write",
			contents: "read",
			actions: "read",
		});
		assert.deepEqual(analyze.strategy.matrix.language, ["javascript-typescript", "actions"]);
		assert.equal(stepByName(analyze.steps, "Checkout").uses, "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd");
		assert.equal(stepByName(analyze.steps, "Initialize CodeQL").uses, "github/codeql-action/init@7188fc363630916deb702c7fdcf4e481b751f97a");
		assert.equal(stepByName(analyze.steps, "Perform CodeQL analysis").uses, "github/codeql-action/analyze@7188fc363630916deb702c7fdcf4e481b751f97a");
	});
});
