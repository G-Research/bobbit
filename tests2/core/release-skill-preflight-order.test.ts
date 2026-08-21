import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
	buildRestrictedNpmEnv,
	evaluatePackedConsumerAudit,
	packedConsumerInstallArgs,
	packedConsumerPackArgs,
	packedConsumerTempPrefix,
	parseAuditJson,
	runPackedConsumerAudit,
} from "../../scripts/release-packed-consumer-audit.mjs";
import {
	assertLockfileAgreement,
	assertPublishedArtifactMatches,
	assertPullRequestContract,
	assertChangelogAppendOnly,
	assertChangelogSection,
	assertExactOptionalDependencyPins,
	assertReleaseVersion,
	assertVersionBump,
	changelogSectionFor,
	compareReleaseVersions,
	distTagFor,
	extractProvenanceSource,
	npmAttestationUrl,
	npmPackageUrl,
	RELEASE_WORKFLOW_PATH,
	fileAtCommit,
} from "../../scripts/release/release-contract.mjs";
import { assertDistTagAdvances } from "../../scripts/release/dist-tag-guard.mjs";

const skill = readFileSync(resolve(process.cwd(), ".claude/skills/release/SKILL.md"), "utf8");
const releaseDocs = readFileSync(resolve(process.cwd(), "docs/releasing.md"), "utf8");

type WorkflowStep = { name?: string; uses?: string; with?: Record<string, unknown>; run?: string };
type WorkflowJob = {
	if?: string;
	needs?: string | string[];
	outputs?: Record<string, string>;
	permissions?: Record<string, string>;
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	steps?: WorkflowStep[];
	strategy?: { matrix?: { node?: string[]; include?: { node?: string }[] } };
};
const releaseWorkflow = parseYaml(
	readFileSync(resolve(process.cwd(), ".github/workflows/release-publish.yml"), "utf8"),
) as {
	on?: {
		push?: { branches?: string[] };
		pull_request?: unknown;
		pull_request_target?: unknown;
		workflow_dispatch?: unknown;
	};
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	permissions?: Record<string, string>;
	jobs?: Record<string, WorkflowJob>;
};

const prGateWorkflow = parseYaml(
	readFileSync(resolve(process.cwd(), ".github/workflows/build-unit-gate.yml"), "utf8"),
) as { jobs?: Record<string, WorkflowJob> };

function toolchainOf(job: WorkflowJob | undefined): { node?: unknown; cache?: unknown; runs: string[] } {
	const steps = job?.steps ?? [];
	const setup = steps.find(step => (step.uses ?? "").startsWith("actions/setup-node@"));
	return {
		node: setup?.with?.["node-version"],
		cache: setup?.with?.cache,
		runs: steps
			.map(step => (step.run ?? "").trim())
			.filter(run => run.startsWith("npm ")),
	};
}

function releaseJob(name: string): WorkflowJob {
	const job = releaseWorkflow.jobs?.[name];
	assert.ok(job, `release workflow is missing job: ${name}`);
	return job;
}

function releaseStep(job: string, name: string): WorkflowStep {
	const step = releaseJob(job).steps?.find(candidate => candidate.name === name);
	assert.ok(step, `release workflow job ${job} is missing step: ${name}`);
	return step;
}
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
	name?: string;
	scripts?: Record<string, string>;
};
const preflight = skill.match(/## 2\. Pre-flight quality gates[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];

const zeroCounts = {
	info: 0,
	low: 0,
	moderate: 0,
	high: 0,
	critical: 0,
	total: 0,
};

function position(command: string): number {
	assert.ok(preflight, "release skill must contain a fenced pre-flight command block");
	const index = preflight.indexOf(command);
	assert.notEqual(index, -1, `pre-flight command is missing: ${command}`);
	return index;
}

async function withRunRoot<T>(runRoot: string | undefined, action: () => Promise<T>): Promise<T> {
	const key = "BOBBIT_V2_RUN_ROOT";
	const previous = Object.getOwnPropertyDescriptor(process.env, key);
	try {
		if (runRoot === undefined) delete process.env[key];
		else process.env[key] = runRoot;
		return await action();
	} finally {
		if (previous) Object.defineProperty(process.env, key, previous);
		else delete process.env[key];
	}
}

describe("release skill scoped package identity", () => {
	it("verifies and reports the package published by CI", () => {
		assert.equal(packageJson.name, "@gresearch/bobbit");
		assert.match(skill, /npm install @gresearch\/bobbit@<new-version>/);
		assert.match(skill, /import\('@gresearch\/bobbit\/dist\/server\/binaries\.js'\)/);
		assert.match(
			skill,
			/https:\/\/www\.npmjs\.com\/package\/@gresearch\/bobbit\/v\/<new-version>/,
		);
		assert.doesNotMatch(skill, /npm install bobbit@/);
		assert.doesNotMatch(skill, /import\('bobbit\//);
		assert.doesNotMatch(skill, /npmjs\.com\/package\/bobbit\//);
	});
});

describe("release skill primary branch", () => {
	it("cuts and merges releases from main", () => {
		assert.match(skill, /git rev-parse origin\/main/);
		assert.match(skill, /git worktree add --detach "\$RELDIR" origin\/main/);
		assert.match(skill, /--base main/);
		assert.match(skill, /git merge-base --is-ancestor "\$MERGE_SHA" origin\/main/);
		assert.match(skill, /git pull origin main/);
		assert.doesNotMatch(skill, /origin\/master|--base master|origin master/);
	});
});

describe("push-triggered release workflow", () => {
	it("releases from the push to main and offers no second authorization path", () => {
		assert.deepEqual(releaseWorkflow.on?.push, { branches: ["main"] });
		assert.equal(releaseWorkflow.on?.workflow_dispatch, undefined);
		assert.equal(releaseWorkflow.on?.pull_request, undefined);
		assert.equal(releaseWorkflow.on?.pull_request_target, undefined);
	});

	it("never checks out a ref chosen by an expression", () => {
		for (const [name, job] of Object.entries(releaseWorkflow.jobs ?? {})) {
			for (const step of job.steps ?? []) {
				if (!(step.uses ?? "").startsWith("actions/checkout@")) continue;
				assert.equal(
					step.with?.ref,
					undefined,
					`release job ${name} pins a checkout ref instead of using GITHUB_SHA`,
				);
			}
		}
	});

	it("serialises only publishing and rejects stale dist-tag state", () => {
		assert.equal(releaseWorkflow.concurrency, undefined);
		assert.deepEqual(releaseJob("publish").concurrency, {
			group: "release-publish-root",
			"cancel-in-progress": false,
		});
		const check = releaseStep("publish", "Confirm dist-tag state is unchanged").run ?? "";
		assert.match(check, /node --input-type=module/);
		assert.match(check, /registry\.npmjs\.org/);
		assert.match(check, /current !== expected/);
		assert.doesNotMatch(check, /gh api|dist-tag-guard\.mjs/);
		const validator = readFileSync(
			resolve(process.cwd(), "scripts/release/validate-release-commit.mjs"),
			"utf8",
		);
		assert.match(validator, /distTagBase = await assertDistTagAdvances/);
		assert.match(releaseJob("verify").outputs?.dist_tag_base ?? "", /steps\.state\.outputs\.dist_tag_base/);
		const publishSteps = releaseJob("publish").steps ?? [];
		assert.ok(
			publishSteps.indexOf(releaseStep("publish", "Confirm dist-tag state is unchanged")) <
				publishSteps.indexOf(
					releaseStep("publish", "Publish verified artifact (OIDC trusted publishing)"),
				),
		);
	});

	it("releases only when a push advances the version, not by its message", () => {
		const detect = releaseStep("detect", "Did this commit bump the version?").run ?? "";
		assert.match(detect, /HEAD\^:package\.json/);
		assert.match(detect, /compareReleaseVersions/);
		assert.match(detect, /> 0/);
		assert.match(detect, /is-release=true/);
		assert.match(detect, /is-release=false/);
		assert.equal(releaseJob("verify").needs, "detect");
		assert.match(releaseJob("verify").if ?? "", /needs\.detect\.outputs\.is-release == 'true'/);
	});

	it("verifies provenance before treating an existing npm version as a safe rerun", () => {
		const validator = readFileSync(
			resolve(process.cwd(), "scripts/release/validate-release-commit.mjs"),
			"utf8",
		);
		const guard = validator.slice(validator.indexOf("if (published) {"));
		assert.match(guard, /assertPublishedArtifactMatches\(extractProvenanceSource\(/);
	});

	it("validates the release contract before running anything expensive", () => {
		const steps = releaseJob("verify").steps ?? [];
		const names = steps.map(step => step.name ?? "");
		const validateIndex = names.indexOf("Validate release contract");
		const installIndex = names.indexOf("Install");
		assert.ok(validateIndex >= 0, "verify must validate the release contract");
		assert.ok(
			installIndex > validateIndex,
			"validation must run before `npm ci` executes third-party lifecycle scripts",
		);
		const setupIndex = steps.findIndex(step => (step.uses ?? "").startsWith("actions/setup-node@"));
		assert.ok(setupIndex >= 0 && setupIndex < validateIndex, "validation must run on the pinned Node");
		assert.match(steps[validateIndex]?.run ?? "", /validate-release-commit\.mjs --mode merged/);
	});

	it("builds and type-checks the release commit without rerunning the PR unit gate", () => {
		const runs = (releaseJob("verify").steps ?? []).map(step => step.run ?? "");
		assert.ok(runs.some(run => run.includes("npm run build")));
		assert.ok(runs.some(run => run.includes("npm run check")));
		assert.ok(!runs.some(run => run.includes("npm run test:unit")));
		assert.ok(!runs.some(run => /npm audit|audit:packed-consumer/.test(run)));
		assert.equal(releaseJob("publish").needs, "verify");
	});

	it("gates the release with a toolchain the PR gate actually exercises", () => {
		const gate = prGateWorkflow.jobs?.verify;
		const release = toolchainOf(releaseJob("verify"));

		// The PR gate fans out across operating systems and Node versions; the
		// release publishes from one. Identical config is therefore the wrong
		// thing to require -- what matters is that the version the release is
		// gated on is one the PR gate really ran.
		const matrix = gate?.strategy?.matrix;
		const gateNodes = [
			...(matrix?.node ?? []),
			...(matrix?.include ?? []).map(entry => entry.node).filter(Boolean),
		];
		assert.ok(gateNodes.length > 0, "the PR gate must pin its Node versions");
		assert.ok(
			gateNodes.includes(String(release.node)),
			`release verify runs Node ${release.node}, which the PR gate never exercises (${gateNodes.join(", ")})`,
		);

		// Build and type-check must not drift. The PR additionally runs the unit
		// suite, which is deliberately not repeated after merge approval.
		const gateRuns = toolchainOf(gate).runs;
		for (const run of release.runs) assert.ok(gateRuns.includes(run), `${run} is not exercised by the PR gate`);
		assert.ok(gateRuns.some(run => run.includes("npm run test:unit")));
		assert.ok(!release.runs.some(run => run.includes("npm run test:unit")));
		assert.equal(release.cache, toolchainOf(gate).cache);
	});

	it("bounds every release job", () => {
		for (const [name, job] of Object.entries(releaseWorkflow.jobs ?? {})) {
			assert.equal(
				typeof (job as { "timeout-minutes"?: number })["timeout-minutes"],
				"number",
				`release job ${name} needs a timeout-minutes`,
			);
		}
	});

	it("never grants repository write access to the verifying or publishing jobs", () => {
		assert.deepEqual(releaseWorkflow.permissions, {
			contents: "read",
			"pull-requests": "read",
		});
		assert.equal(releaseJob("detect").permissions, undefined);
		assert.equal(releaseJob("verify").permissions, undefined);
		assert.deepEqual(releaseJob("publish").permissions, {
			"contents": "read",
			"id-token": "write",
		});
		assert.deepEqual(releaseJob("tag").permissions, { contents: "write" });
		assert.deepEqual(releaseJob("release").permissions, { contents: "write" });
		assert.equal(releaseJob("tag").permissions?.["id-token"], undefined);
		assert.equal(releaseJob("release").permissions?.["id-token"], undefined);
	});

	it("publishes before creating the immutable source tag", () => {
		assert.equal(releaseJob("publish").needs, "verify");
		assert.deepEqual(releaseJob("tag").needs, ["verify", "publish"]);
		assert.match(releaseJob("tag").if ?? "", /needs\.publish\.result == 'success'/);
		assert.match(releaseJob("tag").if ?? "", /needs\.publish\.result == 'skipped'/);
		assert.deepEqual(releaseJob("release").needs, ["verify", "tag"]);

		const tagStep = releaseStep("tag", "Create release tag").run ?? "";
		assert.match(tagStep, /git\/ref\/tags\/\$TAG/);
		assert.match(tagStep, /points at \$existing, not \$GITHUB_SHA/);
		assert.match(tagStep, /-f ref="refs\/tags\/\$TAG" -f sha="\$GITHUB_SHA"/);
		assert.match(tagStep, /existing=""/);
		assert.match(tagStep, /if found="\$\(gh api/);
		assert.doesNotMatch(tagStep, /gh api[^\n]*\|\| true/);

		assert.match(releaseStep("release", "Create release").run ?? "", /--verify-tag/);

		const mergeSection = skill.match(/## 8\. Squash-merge[\s\S]*?## 9\./)?.[0] ?? "";
		assert.ok(
			mergeSection.indexOf("publishes the verified tarball") <
				mergeSection.indexOf("creates the `v<new-version>` tag"),
			"the release skill must document publish-before-tag ordering",
		);
	});

	it("publishes only artifacts built and tested without OIDC authority", () => {
		const prepare = releaseStep("verify", "Prepare verified release artifacts").run ?? "";
		assert.match(prepare, /npm pack --ignore-scripts --json/);
		assert.match(prepare, /release-artifact\/bobbit\.tgz/);
		assert.match(prepare, /release-artifact\/release-notes\.md/);
		const upload = releaseStep("verify", "Upload verified release artifacts");
		assert.match(upload.uses ?? "", /^actions\/upload-artifact@[0-9a-f]{40}$/);
		assert.equal(upload.with?.["if-no-files-found"], "error");

		for (const privilegedJob of ["publish", "release"]) {
			const steps = releaseJob(privilegedJob).steps ?? [];
			assert.ok(!steps.some(step => (step.uses ?? "").startsWith("actions/checkout@")));
			assert.ok(!steps.some(step => /npm ci|npm run|node scripts\//.test(step.run ?? "")));
			const download = releaseStep(privilegedJob, "Download verified release artifacts");
			assert.match(download.uses ?? "", /^actions\/download-artifact@[0-9a-f]{40}$/);
			assert.match(String(download.with?.name ?? ""), /needs\.verify\.outputs\.artifact_name/);
		}
		const publishSteps = releaseJob("publish").steps ?? [];
		assert.ok(
			publishSteps.indexOf(releaseStep("publish", "Confirm dist-tag state is unchanged")) <
				publishSteps.indexOf(releaseStep("publish", "Download verified release artifacts")),
			"the registry state check must run before the publish tarball enters the privileged job",
		);
	});

	it("gives the publish job an npm new enough for OIDC trusted publishing", () => {
		const setup = (releaseJob("publish").steps ?? []).find(step =>
			(step.uses ?? "").startsWith("actions/setup-node@"),
		);
		const nodeVersion = String(setup?.with?.["node-version"] ?? "");
		assert.ok(nodeVersion, "publish must configure Node explicitly");
		assert.ok(
			Number.parseInt(nodeVersion, 10) >= 24,
			`publish needs a Node major bundling npm >= 11.5.1, got ${nodeVersion}`,
		);
		assert.equal(setup?.with?.["registry-url"], "https://registry.npmjs.org");

		const publish =
			releaseStep("publish", "Publish verified artifact (OIDC trusted publishing)").run ?? "";
		assert.match(publish, /cannot use OIDC trusted publishing/);
	});

	it("publishes the verified tarball with provenance and no lifecycle scripts", () => {
		const publish =
			releaseStep("publish", "Publish verified artifact (OIDC trusted publishing)").run ?? "";
		assert.match(
			publish,
			/npm publish \.\/release-artifact\/bobbit\.tgz --ignore-scripts --provenance --tag "\$DIST_TAG"/,
		);
		assert.doesNotMatch(publish, /NODE_AUTH_TOKEN|NPM_TOKEN/);
		assert.equal(distTagFor("0.16.0"), "latest");
		assert.equal(distTagFor("0.16.0-rc.1"), "next");
	});

	it("leads with the verified notes and appends the generated changelog", () => {
		assert.deepEqual(releaseJob("release").needs, ["verify", "tag"]);
		const release = releaseStep("release", "Create release").run ?? "";
		assert.match(release, /gh release create "\$TAG"/);
		assert.match(release, /--repo "\$GITHUB_REPOSITORY"/);
		assert.match(release, /--notes-file release-artifact\/release-notes\.md/);
		assert.match(release, /--generate-notes/);
		assert.match(release, /PRERELEASE=\(\)/);
		assert.match(release, /"\$\{PRERELEASE\[@\]\}"/);
	});

	it("pins every action to a full commit sha", () => {
		const uses = Object.values(releaseWorkflow.jobs ?? {})
			.flatMap(job => job.steps ?? [])
			.map(step => step.uses)
			.filter((value): value is string => typeof value === "string");
		assert.ok(uses.length > 0, "release workflow must use at least one action");
		for (const action of uses) {
			assert.match(action, /@[0-9a-f]{40}$/, `action is not pinned to a sha: ${action}`);
		}
	});

	it("checks the release contract before the merge, not only after it", () => {
		const gate = prGateWorkflow.jobs?.["release-contract"];
		assert.ok(gate, "the PR gate must check release PRs against the same contract");
		const validate = (gate.steps ?? []).find(step => step.name === "Validate release contract");
		assert.match(validate?.run ?? "", /validate-release-commit\.mjs --mode pre-merge/);

		assert.doesNotMatch(
			gate.if ?? "",
			/head_ref/,
			"gating on the branch name means the job never runs except on a release PR, " +
				"so its wiring is first exercised by a real release",
		);
		assert.match(gate.if ?? "", /github\.event_name == 'pull_request'/);

		const checkout = (gate.steps ?? []).find(step => (step.uses ?? "").startsWith("actions/checkout@"));
		assert.equal(checkout?.with?.["fetch-depth"], 2, "the base version is read from HEAD^1");
	});
});

describe("release contract rules", () => {
	const repository = "G-Research/bobbit";
	const sha = "f4f8137f21d1d13d41bf52a7e1f871e0ba615cda";
	const mergedPr = {
		number: 1063,
		title: "chore(release): v0.16.0",
		base: { ref: "main" },
		head: { ref: "release/v0.16.0", repo: { full_name: repository } },
		merged_at: "2026-07-30T10:00:00Z",
		merge_commit_sha: sha,
	};
	const contract = { version: "0.16.0", repository, sha };

	it("accepts only release-shaped versions", () => {
		for (const good of ["0.15.1", "1.0.0", "0.16.0-rc.1", "2.3.4-beta.10"]) {
			assert.equal(assertReleaseVersion(good), good);
		}
		for (const bad of ["0.15", "v0.15.1", "0.15.1+build", "01.2.3", ""]) {
			assert.throws(() => assertReleaseVersion(bad), /not a release version/);
		}
	});

	it("requires package.json and both package-lock versions to agree", () => {
		const pkg = { version: "0.16.0" };
		assertLockfileAgreement(pkg, { version: "0.16.0", packages: { "": { version: "0.16.0" } } });
		assert.throws(
			() => assertLockfileAgreement(pkg, { version: "0.16.0", packages: { "": { version: "0.15.1" } } }),
			/does not match package\.json/,
		);
		assert.throws(
			() => assertLockfileAgreement(pkg, { version: "0.15.1", packages: { "": { version: "0.16.0" } } }),
			/does not match package\.json/,
		);
	});

	it("requires optional dependencies to be immutable exact-version pins", () => {
		assertExactOptionalDependencyPins({
			optionalDependencies: {
				"@bobbit/binaries-linux-x64": "0.9.0",
				"@example/build": "1.2.3+build.7",
			},
		});
		for (const mutable of ["latest", "^0.9.0", "~0.9.0", ">=0.9.0", "*"]) {
			assert.throws(
				() =>
					assertExactOptionalDependencyPins({
						optionalDependencies: { "@bobbit/binaries-linux-x64": mutable },
					}),
				/must be pinned to an exact version/,
			);
		}
	});

	it("requires this release's changelog entry, at the top, with substance", () => {
		const entry = (version: string, body: string) => `## v${version}\n\n${body}\n\n`;
		const real = "x".repeat(200);

		const good = `# Changelog\n\n${entry("0.16.0", real)}${entry("0.15.1", real)}`;
		assert.equal(assertChangelogSection(good, "0.16.0"), real);
		assert.equal(changelogSectionFor(good, "0.15.1"), real);
		assert.equal(changelogSectionFor(good, "9.9.9"), null);

		assert.throws(
			() => assertChangelogSection(`# Changelog\n\n${entry("0.15.1", real)}`, "0.16.0"),
			/has no `## v0\.16\.0` section/,
		);
		assert.throws(
			() => assertChangelogSection(`# Changelog\n\n${entry("0.15.1", real)}${entry("0.16.0", real)}`, "0.16.0"),
			/Newest release first/,
		);
		assert.throws(
			() => assertChangelogSection(`# Changelog\n\n${entry("0.16.0", "tiny")}`, "0.16.0"),
			/too short to publish/,
		);
		const nested = `# Changelog\n\n## v0.16.0\n\n### Features\n\n${real}\n`;
		assert.match(assertChangelogSection(nested, "0.16.0"), /### Features/);

		const duplicate = `# Changelog\n\n${entry("0.16.0", real)}${entry("0.15.1", "forged")}${entry("0.15.1", real)}`;
		assert.throws(() => assertChangelogSection(duplicate, "0.16.0"), /more than one `## v0\.15\.1`/);
	});

	it("lets a release add its own entry and nothing else", () => {
		const before = `# Changelog\n\n## v0.15.1\n\n${"x".repeat(200)}\n`;
		const added = `# Changelog\n\n## v0.16.0\n\n${"y".repeat(200)}\n\n## v0.15.1\n\n${"x".repeat(200)}\n`;
		assertChangelogAppendOnly("", before);
		assertChangelogAppendOnly(before, added);

		const rewritten = `# Changelog\n\n## v0.16.0\n\n${"y".repeat(200)}\n\n## v0.15.1\n\n${"z".repeat(200)}\n`;
		assert.throws(() => assertChangelogAppendOnly(before, rewritten), /rewrites the released v0\.15\.1/);
		assert.throws(
			() => assertChangelogAppendOnly(before, `# Changelog\n\n## v0.16.0\n\n${"y".repeat(200)}\n`),
			/drops the released v0\.15\.1/,
		);
		assert.throws(
			() => assertChangelogAppendOnly(`${before}\n## v0.15.1\n\nduplicate\n`, added),
			/more than one `## v0\.15\.1`/,
		);
		assert.throws(
			() => assertChangelogAppendOnly(before, added.replace("# Changelog", "# Release history")),
			/rewrites text before the first release/,
		);
		assert.throws(
			() => assertChangelogAppendOnly(before, added.replace("x".repeat(200), `${"x".repeat(200)} `)),
			/rewrites the released v0\.15\.1/,
		);
	});

	it("requires the version to increase, not merely to change", () => {
		assertVersionBump("0.15.1", "0.16.0", sha);
		assertVersionBump("0.16.0-rc.1", "0.16.0", sha);

		assert.throws(() => assertVersionBump("0.16.0", "0.16.0", sha), /does not bump the version/);
		// Only 0.15.x is on the registry, so a 0.1.0 release PR passes every other
		// rule — and would take the `latest` dist-tag, downgrading every consumer.
		assert.throws(() => assertVersionBump("0.15.1", "0.1.0", sha), /moves the version backwards/);
		assert.throws(() => assertVersionBump("0.16.0", "0.16.0-rc.1", sha), /moves the version backwards/);
	});

	it("refuses to move an npm dist-tag backwards", async () => {
		const response = (status: number, version?: string) => ({
			status,
			ok: status >= 200 && status < 300,
			json: async () => ({ version }),
		});
		const args = { packageName: "@gresearch/bobbit", distTag: "latest", version: "0.16.0" };
		assert.equal(await assertDistTagAdvances({ ...args, fetchImpl: async () => response(404) }), null);
		assert.equal(
			await assertDistTagAdvances({ ...args, fetchImpl: async () => response(200, "0.15.1") }),
			"0.15.1",
		);
		await assert.rejects(
			assertDistTagAdvances({ ...args, fetchImpl: async () => response(200, "0.16.0") }),
			/refusing to move latest backwards/,
		);
		await assert.rejects(
			assertDistTagAdvances({ ...args, fetchImpl: async () => response(200, "0.17.0") }),
			/refusing to move latest backwards/,
		);
	});

	it("orders versions by semver precedence, not by string", () => {
		const cases: [string, string, number][] = [
			["0.16.0", "0.15.1", 1],
			["0.1.0", "0.15.1", -1],
			["0.15.1", "0.15.1", 0],
			["1.0.0", "0.99.99", 1],
			// A prerelease sorts below its release, numeric identifiers compare as
			// numbers, and a longer identifier set wins a tie.
			["0.16.0", "0.16.0-rc.1", 1],
			["0.16.0-rc.2", "0.16.0-rc.10", -1],
			["0.16.0-alpha", "0.16.0-beta", -1],
			["0.16.0-rc.1", "0.16.0-rc.1.1", -1],
			["9007199254740993.0.0", "9007199254740992.0.0", 1],
			["0.16.0-rc.9007199254740993", "0.16.0-rc.9007199254740992", 1],
		];
		for (const [a, b, expected] of cases) {
			assert.equal(compareReleaseVersions(a, b), expected, `${a} vs ${b}`);
			assert.equal(compareReleaseVersions(b, a), -expected || 0, `${b} vs ${a}`);
		}
	});

	it("escapes every path segment of a package name in registry urls", () => {
		assert.equal(
			npmPackageUrl("@gresearch/bobbit", "0.15.1"),
			"https://registry.npmjs.org/%40gresearch%2Fbobbit/0.15.1",
		);
		// Encoding only the first slash left the rest as live path segments, which
		// fetch normalises — a crafted optionalDependencies key could then resolve
		// against an unrelated registry path and read as "already published".
		const crafted = npmPackageUrl("@evil/../../-/user/x", "1.0.0");
		assert.ok(!crafted.includes("/../"), crafted);
		assert.equal(crafted.split("/").length, "https://registry.npmjs.org/x/y".split("/").length);
	});

	it("requires the release to have been opened as a release", () => {
		assertPullRequestContract(mergedPr, contract);

		assert.throws(() => assertPullRequestContract(null, contract), /no merged pull request produced/);
		assert.throws(
			() => assertPullRequestContract({ ...mergedPr, base: { ref: "develop" } }, contract),
			/targets develop/,
		);
		assert.throws(
			() =>
				assertPullRequestContract(
					{ ...mergedPr, head: { ...mergedPr.head, repo: { full_name: "someone/bobbit" } } },
					contract,
				),
			/Release branches must live in this repository/,
		);
		assert.throws(
			() => assertPullRequestContract({ ...mergedPr, head: { ...mergedPr.head, ref: "deps/bump" } }, contract),
			/not be the side effect of a version change/,
		);
		assert.throws(
			() => assertPullRequestContract({ ...mergedPr, title: "release 0.16.0" }, contract),
			/title must be/,
		);
	});

	it("checks the published artifact's own provenance, not just the tag", () => {
		// Tag rulesets identify the repository-wide Actions app, not this workflow.
		// Only registry-verified provenance identifies the publishing path and commit.
		const spec = "@gresearch/bobbit@0.16.0";
		const repository = "G-Research/bobbit";
		const good = {
			sha,
			repository: `https://github.com/${repository}`,
			path: RELEASE_WORKFLOW_PATH,
		};
		assert.equal(assertPublishedArtifactMatches(good, { spec, repository, sha }), true);

		assert.throws(
			() => assertPublishedArtifactMatches(null, { spec, repository, sha }),
			/no readable provenance attestation/,
		);
		assert.throws(
			() => assertPublishedArtifactMatches({ ...good, sha: "0".repeat(40) }, { spec, repository, sha }),
			/was published from commit/,
		);
		assert.throws(
			() =>
				assertPublishedArtifactMatches(
					{ ...good, repository: "https://github.com/someone/bobbit" },
					{ spec, repository, sha },
				),
			/was published from https:\/\/github\.com\/someone\/bobbit/,
		);
		assert.throws(
			() =>
				assertPublishedArtifactMatches(
					{ ...good, repository: "https://evil.example/G-Research/bobbit" },
					{ spec, repository, sha },
				),
			/was published from https:\/\/evil\.example/,
		);
		// A different workflow in this repository is still not this release path.
		assert.throws(
			() =>
				assertPublishedArtifactMatches(
					{ ...good, path: ".github/workflows/something-else.yml" },
					{ spec, repository, sha },
				),
			/was published by \.github\/workflows\/something-else\.yml/,
		);
	});

	it("reads the source commit, repository and workflow out of an attestation", () => {
		const statement = {
			predicate: {
				buildDefinition: {
					externalParameters: {
						workflow: { repository: "https://github.com/G-Research/bobbit", path: RELEASE_WORKFLOW_PATH },
					},
					resolvedDependencies: [
						{ uri: "git+https://github.com/evil/example@refs/heads/main", digest: { gitCommit: "bad" } },
						{
							uri: "git+https://github.com/G-Research/bobbit@refs/heads/main",
							digest: { gitCommit: sha },
						},
					],
				},
			},
		};
		const response = {
			attestations: [
				{ predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", bundle: {} },
				{
					predicateType: "https://slsa.dev/provenance/v1",
					bundle: {
						dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64") },
					},
				},
			],
		};
		assert.deepEqual(extractProvenanceSource(response), {
			sha,
			repository: "https://github.com/G-Research/bobbit",
			path: RELEASE_WORKFLOW_PATH,
		});
		assert.equal(extractProvenanceSource({ attestations: [] }), null);
		assert.equal(extractProvenanceSource(null), null);
	});

	it("escapes the package name in the attestation url too", () => {
		assert.equal(
			npmAttestationUrl("@gresearch/bobbit", "0.15.1"),
			"https://registry.npmjs.org/-/npm/v1/attestations/%40gresearch%2Fbobbit@0.15.1",
		);
	});

	it("never reads an unreachable commit as an empty file", () => {
		type GitResult = { status: number; stdout: string; stderr: string };
		const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
		const no = (stderr: string): GitResult => ({ status: 128, stdout: "", stderr });
		const runner =
			(replies: Record<string, GitResult>) =>
			(args: string[]): GitResult =>
				replies[args[0]] ?? no("unexpected git call");

		assert.equal(
			fileAtCommit("HEAD^", "CHANGELOG.md", runner({ "rev-parse": ok("sha\n"), show: ok("# Changelog\n") })),
			"# Changelog\n",
		);

		// The parent is reachable and simply has no such file — the first release
		// after CHANGELOG.md is introduced. Nothing to compare against.
		assert.equal(
			fileAtCommit(
				"HEAD^",
				"CHANGELOG.md",
				runner({ "rev-parse": ok("sha\n"), show: no("fatal: path 'CHANGELOG.md' does not exist in 'HEAD^'") }),
			),
			null,
		);

		// git reports a missing *object* with the same "…but not in…" wording it
		// uses for a missing *path*. A clone too shallow to hold the parent must
		// raise: resolving it to null would leave assertChangelogAppendOnly
		// comparing against an empty file, silently passing every rewrite.
		assert.throws(
			() =>
				fileAtCommit(
					"HEAD^",
					"CHANGELOG.md",
					runner({
						"rev-parse": no("fatal: Needed a single revision"),
						show: no("fatal: path 'CHANGELOG.md' exists on disk, but not in 'HEAD^'"),
					}),
				),
			/cannot resolve HEAD\^.*append-only/s,
		);
	});
});

describe("release skill pre-flight order", () => {
	it("runs deterministic quality gates without runtime registry audits", () => {
		assert.equal(
			packageJson.scripts?.["audit:packed-consumer"],
			"node scripts/release-packed-consumer-audit.mjs",
		);
		assert.doesNotMatch(skill, /^npm audit|^npm run audit:packed-consumer/gm);
		assert.ok(position("npm ci") < position("npm run build"));
		assert.ok(position("npm run build") < position("npm run check"));
		assert.ok(position("npm run check") < position("npm run test:unit"));
		assert.ok(position("npm run test:unit") < position("npm run test:browser"));
		assert.ok(position("npm run test:browser") < position("npm run test:e2e"));
	});

	it("documents runtime registry audits as optional diagnostics only", () => {
		assert.match(skill, /Runtime registry audits are deliberately outside the release process/);
		assert.match(releaseDocs, /## Optional manual packed-consumer audit/);
		assert.match(releaseDocs, /advisory findings do not determine release eligibility/);
	});
});

describe("packed-consumer audit subprocess isolation", () => {
	it("disables lifecycle scripts for pack and install", () => {
		const packArgs = packedConsumerPackArgs("isolated-pack-dir");
		assert.equal(packArgs[0], "pack");
		assert.equal(packArgs.filter((arg: string) => arg === "--ignore-scripts").length, 1);

		assert.deepEqual(packedConsumerInstallArgs("bobbit.tgz"), [
			"install",
			"--ignore-scripts",
			"bobbit.tgz",
		]);
	});

	it("wires the restricted environment into every npm child without contacting the registry", async () => {
		const secretEnv = {
			NPM_TOKEN: "publish-secret",
			NODE_AUTH_TOKEN: "node-auth-secret",
			_auth: "legacy-auth-secret",
			_authToken: "legacy-token-secret",
			npm_config__auth: "config-auth-secret",
			npm_config__authToken: "config-token-secret",
			"npm_config_//registry.npmjs.org/:_authToken": "scoped-token-secret",
			npm_config_userconfig: resolve("credentials/npmrc"),
			npm_config_globalconfig: resolve("credentials/global-npmrc"),
			npm_config_registry: "https://private-registry.example.invalid/",
			npm_config_always_auth: "true",
			npm_config_otp: "123456",
			GITHUB_TOKEN: "github-secret",
		};
		const previousEnv = new Map(Object.keys(secretEnv).map(key => [key, process.env[key]]));
		const calls: Array<{
			args: string[];
			cwd: string;
			env: Record<string, string>;
		}> = [];
		const nativeCalls: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> = [];
		const npmRunner = async (
			args: string[],
			options: { cwd: string; env: Record<string, string> },
		) => {
			assert.equal(readFileSync(options.env.npm_config_userconfig, "utf8"), "\n");
			assert.equal(readFileSync(options.env.npm_config_globalconfig, "utf8"), "\n");
			calls.push({ args, cwd: options.cwd, env: { ...options.env } });
			const result = { code: 0, stdout: "", stderr: "", rendered: `npm ${args.join(" ")}` };
			if (args[0] === "pack") {
				const packDir = args[args.indexOf("--pack-destination") + 1];
				writeFileSync(join(packDir, "bobbit-test.tgz"), "fake tarball");
				result.stdout = JSON.stringify([{ filename: "bobbit-test.tgz" }]);
			} else if (args[0] === "config") {
				result.stdout = "true\n";
			} else if (args[0] === "install") {
				writeFileSync(join(options.cwd, "package-lock.json"), "{}\n");
			} else if (args[0] === "audit") {
				result.stdout = JSON.stringify({
					auditReportVersion: 2,
					vulnerabilities: {},
					metadata: { vulnerabilities: zeroCounts },
				});
			} else {
				assert.fail(`unexpected npm command: ${args[0]}`);
			}
			return result;
		};

		const commandRunner = async (
			command: string,
			args: string[],
			options: { cwd: string; env: Record<string, string> },
		) => {
			assert.equal(readFileSync(options.env.npm_config_userconfig, "utf8"), "\n");
			assert.equal(readFileSync(options.env.npm_config_globalconfig, "utf8"), "\n");
			nativeCalls.push({ command, args, cwd: options.cwd, env: { ...options.env } });
			return { code: 0, stdout: "", stderr: "", rendered: `${command} ${args.join(" ")}` };
		};

		try {
			Object.assign(process.env, secretEnv);
			await runPackedConsumerAudit({ npmRunner, commandRunner });

			assert.deepEqual(calls.map(call => call.args[0]), ["pack", "config", "install", "audit"]);
			assert.equal(nativeCalls.length, 1);
			assert.equal(nativeCalls[0].command, process.execPath);
			assert.ok(nativeCalls[0].args.join(" ").includes("better-sqlite3"));
			assert.notEqual(calls[0].cwd, resolve(process.cwd()), "pack must not inherit repository project config");
			for (const call of calls) {
				const childKeys = new Set(Object.keys(call.env).map(key => key.toLowerCase()));
				for (const forbiddenKey of Object.keys(secretEnv).map(key => key.toLowerCase())) {
					if (["npm_config_userconfig", "npm_config_globalconfig", "npm_config_registry"].includes(forbiddenKey)) {
						continue;
					}
					assert.equal(childKeys.has(forbiddenKey), false, `${forbiddenKey} reached ${call.args[0]}`);
				}
				assert.equal(call.env.npm_config_registry, "https://registry.npmjs.org/");
				assert.equal(call.env.npm_config_ignore_scripts, "true");
				assert.notEqual(call.env.npm_config_userconfig, secretEnv.npm_config_userconfig);
				assert.notEqual(call.env.npm_config_globalconfig, secretEnv.npm_config_globalconfig);
				assert.match(call.env.npm_config_userconfig, /user\.npmrc$/);
				assert.match(call.env.npm_config_globalconfig, /global\.npmrc$/);
				assert.ok(call.env.npm_config_cache);
				assert.ok(call.env.HOME);
				assert.equal(call.env.USERPROFILE, call.env.HOME);
			}
			for (const call of nativeCalls) {
				const childKeys = new Set(Object.keys(call.env).map(key => key.toLowerCase()));
				for (const forbiddenKey of Object.keys(secretEnv).map(key => key.toLowerCase())) {
					if (["npm_config_userconfig", "npm_config_globalconfig", "npm_config_registry"].includes(forbiddenKey)) continue;
					assert.equal(childKeys.has(forbiddenKey), false, `${forbiddenKey} reached native smoke`);
				}
				assert.equal(call.env.npm_config_registry, "https://registry.npmjs.org/");
			}
			assert.ok(calls[0].args.includes("--ignore-scripts"));
			assert.ok(calls[2].args.includes("--ignore-scripts"));
		} finally {
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("passes only process essentials and public network settings without inherited credentials", () => {
		const paths = {
			homeDir: resolve("isolated/home"),
			cacheDir: resolve("isolated/cache"),
			tempDir: resolve("isolated/tmp"),
			appDataDir: resolve("isolated/home/AppData/Roaming"),
			localAppDataDir: resolve("isolated/home/AppData/Local"),
			xdgConfigDir: resolve("isolated/home/.config"),
			userConfigPath: resolve("isolated/config/user.npmrc"),
			globalConfigPath: resolve("isolated/config/global.npmrc"),
		};
		const inherited = {
			Path: "safe-bin-path",
			SystemRoot: "safe-system-root",
			HTTPS_PROXY: "https://proxy.example.invalid",
			NODE_EXTRA_CA_CERTS: resolve("public-network-ca.pem"),
			NPM_TOKEN: "publish-secret",
			NODE_AUTH_TOKEN: "node-auth-secret",
			_auth: "legacy-auth-secret",
			_authToken: "legacy-token-secret",
			npm_config__auth: "config-auth-secret",
			npm_config__authToken: "config-token-secret",
			"npm_config_//registry.npmjs.org/:_authToken": "scoped-token-secret",
			npm_config_always_auth: "true",
			npm_config_otp: "123456",
			npm_config_userconfig: resolve("credentials/npmrc"),
			npm_config_globalconfig: resolve("credentials/global-npmrc"),
			npm_config_registry: "https://private-registry.example.invalid/",
			GITHUB_TOKEN: "github-secret",
			GH_TOKEN: "gh-secret",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			NODE_OPTIONS: "--require=credential-stealer.cjs",
			INIT_CWD: resolve("credential-bearing-release-worktree"),
			npm_lifecycle_event: "publish",
			UNRELATED_SETTING: "not-an-essential",
		};

		const childEnv = buildRestrictedNpmEnv(inherited, paths);
		assert.equal(childEnv.PATH, inherited.Path);
		assert.equal(childEnv.SystemRoot, inherited.SystemRoot);
		assert.equal(childEnv.HTTPS_PROXY, inherited.HTTPS_PROXY);
		assert.equal(childEnv.NODE_EXTRA_CA_CERTS, inherited.NODE_EXTRA_CA_CERTS);
		assert.equal(childEnv.HOME, paths.homeDir);
		assert.equal(childEnv.USERPROFILE, paths.homeDir);
		assert.equal(childEnv.npm_config_userconfig, paths.userConfigPath);
		assert.equal(childEnv.npm_config_globalconfig, paths.globalConfigPath);
		assert.equal(childEnv.npm_config_cache, paths.cacheDir);
		assert.equal(childEnv.npm_config_registry, "https://registry.npmjs.org/");
		assert.equal(childEnv.npm_config_ignore_scripts, "true");

		const childKeys = new Set(Object.keys(childEnv).map(key => key.toLowerCase()));
		for (const forbiddenKey of [
			"npm_token",
			"node_auth_token",
			"_auth",
			"_authtoken",
			"npm_config__auth",
			"npm_config__authtoken",
			"npm_config_//registry.npmjs.org/:_authtoken",
			"npm_config_always_auth",
			"npm_config_otp",
			"github_token",
			"gh_token",
			"aws_secret_access_key",
			"node_options",
			"init_cwd",
			"npm_lifecycle_event",
			"unrelated_setting",
		]) {
			assert.equal(childKeys.has(forbiddenKey), false, `${forbiddenKey} must not reach npm children`);
		}
	});
});

describe("packed-consumer audit run-root ownership", () => {
	it("allocates and removes only an audit child of the supplied canonical run root", async () => {
		const runRoot = await mkdtemp(join(tmpdir(), "bobbit-packed-audit-owner-"));
		let auditRoot = "";
		const operationFailure = new Error("intentional packed-consumer audit failure");

		try {
			assert.equal(
				packedConsumerTempPrefix({ BOBBIT_V2_RUN_ROOT: runRoot }),
				join(realpathSync(runRoot), "bobbit-release-packed-audit-"),
			);
			assert.equal(
				packedConsumerTempPrefix({}, "/custom-os-temp"),
				join("/custom-os-temp", "bobbit-release-packed-audit-"),
			);

			await withRunRoot(runRoot, async () => {
				await assert.rejects(
					runPackedConsumerAudit({
						npmRunner: async (
							_args: string[],
							options: { cwd: string; env: Record<string, string> },
						) => {
							auditRoot = options.cwd;
							throw operationFailure;
						},
					}),
					error => error === operationFailure,
				);
			});

			assert.equal(dirname(auditRoot), realpathSync(runRoot));
			assert.match(auditRoot, /bobbit-release-packed-audit-/);
			assert.equal(existsSync(auditRoot), false, "audit cleanup must remove its owned child");
			assert.equal(existsSync(runRoot), true, "audit cleanup must not remove the coordinator root");
		} finally {
			await rm(runRoot, { recursive: true, force: true });
		}
	});

	it("rejects an unusable supplied run root before invoking npm", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "bobbit-packed-audit-invalid-root-"));
		const unusableRoot = join(fixtureRoot, "not-a-directory");
		let npmCalls = 0;

		try {
			await writeFile(unusableRoot, "not a directory");
			await withRunRoot(unusableRoot, async () => {
				await assert.rejects(
					runPackedConsumerAudit({
						npmRunner: async () => {
							npmCalls += 1;
							return { code: 0, stdout: "", stderr: "", rendered: "npm" };
						},
					}),
					error => {
						const code = error && typeof error === "object"
							? (error as NodeJS.ErrnoException).code
							: undefined;
						return code === "ENOENT" || code === "ENOTDIR";
					},
				);
			});
			assert.equal(npmCalls, 0);
			assert.equal(existsSync(unusableRoot), true, "allocation failure must not remove the supplied root");
			assert.equal(existsSync(fixtureRoot), true, "allocation failure must not remove the supplied parent");
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});
});

describe("packed-consumer audit decision", () => {
	it("accepts only a zero exit with explicit zero counts at every severity", () => {
		const report = parseAuditJson(JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {},
			metadata: { vulnerabilities: zeroCounts },
		}));

		assert.deepEqual(evaluatePackedConsumerAudit(report, 0), {
			clean: true,
			counts: zeroCounts,
			diagnostics: [],
		});
	});

	it("retains actionable package, path, and advisory details from a vulnerability exit", () => {
		const report = parseAuditJson(JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {
				protobufjs: {
					name: "protobufjs",
					severity: "moderate",
					range: "<=7.6.4",
					nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs"],
					via: [{
						source: 1109682,
						title: "Prototype pollution in protobufjs",
						severity: "moderate",
						range: "<=7.6.4",
						url: "https://github.com/advisories/GHSA-j3f2-48v5-ccww",
					}],
				},
			},
			metadata: {
				vulnerabilities: { ...zeroCounts, moderate: 1, total: 1 },
			},
		}));

		const evaluation = evaluatePackedConsumerAudit(report, 1);
		assert.equal(evaluation.clean, false);
		const diagnostics = evaluation.diagnostics.join("\n");
		assert.match(diagnostics, /1 moderate vulnerability/);
		assert.match(diagnostics, /protobufjs/);
		assert.match(diagnostics, /pi-coding-agent/);
		assert.match(diagnostics, /GHSA-j3f2-48v5-ccww/);
		assert.match(diagnostics, /exited with code 1/);
	});

	it("fails closed on malformed counts, inconsistent entries, and nonzero clean exits", () => {
		const missingSeverity = evaluatePackedConsumerAudit({
			vulnerabilities: {},
			metadata: { vulnerabilities: { ...zeroCounts, critical: undefined } },
		}, 0);
		assert.equal(missingSeverity.clean, false);
		assert.match(missingSeverity.diagnostics.join("\n"), /invalid critical vulnerability count/);

		const hiddenFinding = evaluatePackedConsumerAudit({
			vulnerabilities: { unexpected: { severity: "low", via: [], nodes: [] } },
			metadata: { vulnerabilities: zeroCounts },
		}, 0);
		assert.equal(hiddenFinding.clean, false);
		assert.match(hiddenFinding.diagnostics.join("\n"), /unexpected: severity=low/);

		const failedCleanAudit = evaluatePackedConsumerAudit({
			vulnerabilities: {},
			metadata: { vulnerabilities: zeroCounts },
		}, 2);
		assert.equal(failedCleanAudit.clean, false);
		assert.match(failedCleanAudit.diagnostics.join("\n"), /exited with code 2/);
	});

	it("rejects absent and malformed npm audit JSON", () => {
		assert.throws(() => parseAuditJson(""), /emitted no JSON/);
		assert.throws(() => parseAuditJson("npm error"), /malformed JSON/);
		assert.throws(() => parseAuditJson("[]"), /root must be an object/);
	});
});
