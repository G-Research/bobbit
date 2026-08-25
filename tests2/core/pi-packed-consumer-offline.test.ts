import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import YAML from "yaml";

const PACKED_CONSUMER_SOURCE = readFileSync(
	new URL("../../tests/e2e/pi-packed-consumer.spec.ts", import.meta.url),
	"utf8",
);
const COMMAND_HELPER_SOURCE = readFileSync(
	new URL("../../tests/e2e/test-utils/pi-packed-consumer-command.ts", import.meta.url),
	"utf8",
);
const WORKFLOW_SOURCE = readFileSync(
	new URL("../../.github/workflows/build-unit-gate.yml", import.meta.url),
	"utf8",
);

type WorkflowStep = {
	name: string;
	run?: string;
	with?: Record<string, unknown>;
};

type Workflow = {
	jobs: {
		e2e: { steps: WorkflowStep[] };
	};
};

describe("packed-consumer offline install contract", () => {
	it("uses the workflow-populated npm cache without a registry fallback", () => {
		const workflow = YAML.parse(WORKFLOW_SOURCE) as Workflow;
		const steps = workflow.jobs.e2e.steps;
		const setupIndex = steps.findIndex(step => step.name === "Set up Node");
		const installIndex = steps.findIndex(step => step.name === "Install");
		const gateIndex = steps.findIndex(step => step.name === "E2E gate");

		assert.ok(setupIndex >= 0, "E2E must configure Node and the npm cache");
		assert.deepEqual(steps[setupIndex]?.with, { "node-version": "22.19.0", cache: "npm" });
		assert.ok(installIndex > setupIndex, "npm ci must populate the restored cache after setup-node");
		assert.equal(steps[installIndex]?.run, "npm ci");
		assert.ok(gateIndex > installIndex, "the packed-consumer test must run only after npm ci populates the cache");
		assert.equal(steps[gateIndex]?.run, "npm run test:e2e", "the workflow must retain the normal retry-enabled suite command");

		const helper = COMMAND_HELPER_SOURCE;
		assert.match(helper, /const env: NodeJS\.ProcessEnv = \{ \.\.\.process\.env \};/,
			"the clean consumer must inherit setup-node/npm ci's cache location");
		assert.doesNotMatch(helper, /["']npm_config_cache["']|env\.(?:npm_config_cache|NPM_CONFIG_CACHE)\s*=/,
			"the helper must not redirect offline resolution to an empty per-test cache");
	});

	it("installs the actual local tarball strictly offline with the existing safety timeout", () => {
		const packedConsumer = PACKED_CONSUMER_SOURCE;
		assert.match(
			packedConsumer,
			/const packed = await runNpm\(\["pack", "--json", "--pack-destination", packDir\], PROJECT_ROOT, 3 \* 60_000\);/,
			"the test must create the real publishable tarball",
		);
		assert.match(
			packedConsumer,
			/const tarballPath = resolve\(packDir, packEntry\.filename as string\);\s*expect\(existsSync\(tarballPath\), `npm pack did not create \$\{tarballPath\}`\)\.toBe\(true\);/s,
			"the install target must be npm pack's actual emitted tarball",
		);

		const installCall = packedConsumer.match(
			/const install = await runNpm\((\["install"[^\n]+), consumerDir, (10 \* 60_000), consumerEnv\);/,
		);
		assert.ok(installCall, "packed consumer must retain one explicit npm install call");
		assert.equal(installCall[1], '["install", "--offline", tarballPath]',
			"npm must fail closed on cache misses instead of consulting the registry");
		assert.equal(installCall[2], "10 * 60_000", "the unchanged ten-minute timeout remains only a hard safety bound");
		assert.doesNotMatch(installCall[0], /prefer-offline|registry|cache|force/,
			"the install must not add a best-effort or registry fallback");
		assert.doesNotMatch(packedConsumer, /test\.describe\.configure\(\{[^}]*retries|testInfo\.retry/,
			"the real E2E must retain the suite's normal retry policy");
	});

	it("retains a clean consumer and the published security assertions", () => {
		const packedConsumer = PACKED_CONSUMER_SOURCE;
		assert.match(packedConsumer, /const packDir = join\(tempRoot, "pack"\);\s*const consumerDir = join\(tempRoot, "consumer"\);/s,
			"packing and consumer installation must stay in separate directories");
		assert.match(packedConsumer, /name: "bobbit-packed-consumer-e2e",\s*version: "1\.0\.0",\s*private: true,/s,
			"the consumer must begin as an empty package rather than a seeded dependency graph");
		assert.match(packedConsumer, /"clean consumer must use npm's normal package-lock=true default"/);
		assert.match(packedConsumer, /"consumer install must create its own lockfile"/);
		assert.match(packedConsumer, /"published pi-coding-agent must include its dependency-owned shrinkwrap"/);
		assert.match(packedConsumer, /"npm ls must have no invalid, missing, stale, or extraneous edges"/);
		assert.match(packedConsumer, /"packed Bobbit must pin Pi exactly to the supported version"/);
		assert.match(packedConsumer, /`every brace-expansion edge must be 5\.0\.7\+:/);
		assert.match(packedConsumer, /`Pi \$\{selectedPiVersion\} must resolve every protobufjs edge to 7\.6\.5\+:/);
		assert.match(packedConsumer, /expect\(resolution\.source, `\$\{tool\} must resolve from \$\{expectedBinaryPackage\}`\)\.toBe\("bundled"\)/);
		assert.match(packedConsumer, /runPiPackedConsumerCommand\(resolution\.path!, \["--version"\]/,
			"the installed bundled binaries must still execute from the clean consumer");
	});
});
