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
	name: string;
	if: string;
	"runs-on": string;
	"timeout-minutes": number;
	strategy: {
		"fail-fast": boolean;
		matrix: {
			os: string[];
			include?: Array<{ os: string; workers: number }>;
		};
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

	it("runs complete Browser and E2E suites as PR-only native matrices", () => {
		const jobs = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH).jobs;
		const expectedOs = ["ubuntu-latest", "windows-latest", "macos-latest"];
		const expectedCheckout = "actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd";
		const expectedSetupNode = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";

		for (const [jobId, job, expectedName, gateName, command] of [
			["browser", jobs.browser, "Browser (${{ matrix.os }}, Node 22.19.0)", "Browser gate", "npm run test:browser"],
			["e2e", jobs.e2e, "E2E (${{ matrix.os }}, Node 22.19.0)", "E2E gate", "npm run test:e2e"],
		] as const) {
			assert.equal(job.name, expectedName, `${jobId} check name must identify the runner and exact Node version`);
			assert.equal(job.if, "github.event_name == 'pull_request'", `${jobId} must not run on push or manual dispatch`);
			assert.equal(job["runs-on"], "${{ matrix.os }}");
			assert.equal(job["timeout-minutes"], 40);
			assert.equal(job.strategy["fail-fast"], false);
			assert.deepEqual(job.strategy.matrix.os, expectedOs);
			assert.equal(stepByName(job.steps, "Checkout").uses, expectedCheckout);
			assert.deepEqual(stepByName(job.steps, "Checkout").with, { "persist-credentials": false });
			assert.equal(stepByName(job.steps, "Set up Node").uses, expectedSetupNode);
			assert.deepEqual(stepByName(job.steps, "Set up Node").with, { "node-version": "22.19.0", cache: "npm" });
			assert.equal(stepByName(job.steps, "Install").run, "npm ci");
			assert.deepEqual(stepByName(job.steps, "Install Chromium with dependencies"), {
				name: "Install Chromium with dependencies",
				if: "runner.os == 'Linux'",
				run: "npx playwright install --with-deps chromium",
			});
			assert.deepEqual(stepByName(job.steps, "Install Chromium"), {
				name: "Install Chromium",
				if: "runner.os != 'Linux'",
				run: "npx playwright install chromium",
			});
			assert.equal(
				job.steps.filter((step) => step.name === gateName).length,
				1,
				`${jobId} must expose one authoritative gate step`,
			);
			assert.equal(
				job.steps.filter((step) => step.run === command).length,
				1,
				`${jobId} must invoke its complete suite exactly once`,
			);
			assert.equal(stepByName(job.steps, gateName).run, command, `${jobId} must use the standard retry-enabled command`);
		}

		assert.deepEqual(
			jobs.browser.strategy.matrix,
			{
				os: expectedOs,
				include: [
					{ os: "ubuntu-latest", workers: 2 },
					{ os: "windows-latest", workers: 1 },
					{ os: "macos-latest", workers: 2 },
				],
			},
			"hosted Windows must use one Browser worker while Linux and macOS retain two",
		);
		assert.deepEqual(stepByName(jobs.browser.steps, "Browser gate").env, {
			BOBBIT_V2_PLAYWRIGHT_WORKERS: "${{ matrix.workers }}",
		});
		assert.deepEqual(jobs.e2e.strategy.matrix, { os: expectedOs }, "the Browser pressure bound must not alter E2E");
		assert.equal(stepByName(jobs.e2e.steps, "E2E gate").env, undefined);
	});

	it("builds the version-matched sandbox image only for Linux E2E coverage", () => {
		const e2eSteps = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH).jobs.e2e.steps;
		const sandboxBuild = stepByName(e2eSteps, "Build sandbox image");
		const e2eGateIndex = e2eSteps.findIndex((step) => step.name === "E2E gate");
		const browserSteps = readWorkflow<BuildUnitGateWorkflow>(BUILD_UNIT_GATE_WORKFLOW_PATH).jobs.browser.steps;

		assert.equal(e2eSteps.filter((step) => step.name === "Build sandbox image").length, 1);
		assert.equal(browserSteps.some((step) => step.name === "Build sandbox image"), false);
		assert.equal(sandboxBuild.if, "runner.os == 'Linux'", "other runners must retain non-Docker E2E coverage");
		assert.equal(
			sandboxBuild.run?.trim(),
			[
				"PI_AGENT_VERSION=$(node -p \"require('./package.json').dependencies['@earendil-works/pi-coding-agent']\")",
				'docker build --build-arg "PI_AGENT_VERSION=$PI_AGENT_VERSION" -t bobbit-agent docker/',
			].join("\n"),
			"the Linux image must use the repository's exact Pi agent dependency version",
		);
		assert.ok(e2eSteps.indexOf(sandboxBuild) < e2eGateIndex, "the image must exist before image-backed E2E cases run");
	});

	it("preserves normal retry and failure policy in Browser and E2E PR checks", () => {
		const source = workflowSource(BUILD_UNIT_GATE_WORKFLOW_PATH);
		assert.doesNotMatch(source, /BOBBIT_V2_RETRY_FREE/, "PR checks must retain the repository's normal retry policy");
		assert.doesNotMatch(source, /continue-on-error/, "every Browser and E2E matrix failure must fail its check");
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
