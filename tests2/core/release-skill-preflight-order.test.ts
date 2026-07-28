import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
	buildRestrictedNpmEnv,
	evaluatePackedConsumerAudit,
	packedConsumerInstallArgs,
	packedConsumerPackArgs,
	parseAuditJson,
	runPackedConsumerAudit,
} from "../../scripts/release-packed-consumer-audit.mjs";

const skill = readFileSync(resolve(process.cwd(), ".claude/skills/release/SKILL.md"), "utf8");
const releaseWorkflowSource = readFileSync(
	resolve(process.cwd(), ".github/workflows/release-publish.yml"),
	"utf8",
);
type WorkflowStep = {
	name?: string;
	uses?: string;
	with?: Record<string, unknown>;
	run?: string;
};
type WorkflowJob = {
	if?: string;
	needs?: string;
	permissions?: Record<string, string>;
	steps?: WorkflowStep[];
};
const releaseWorkflow = parseYaml(releaseWorkflowSource) as {
	on?: {
		pull_request?: { branches?: string[]; types?: string[] };
		push?: unknown;
		pull_request_target?: unknown;
	};
	concurrency?: { group?: string; "cancel-in-progress"?: boolean };
	jobs?: { tag?: WorkflowJob; publish?: WorkflowJob };
};
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
	name?: string;
	scripts?: Record<string, string>;
};
const preflight = skill.match(/## 2\. Pre-flight quality gates[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];

function workflowStep(job: WorkflowJob | undefined, name: string): WorkflowStep {
	const step = job?.steps?.find(candidate => candidate.name === name);
	assert.ok(step, `release workflow is missing step: ${name}`);
	return step;
}

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

describe("merge-triggered release workflow", () => {
	it("runs only for merged same-repository release PRs targeting main", () => {
		assert.deepEqual(releaseWorkflow.on?.pull_request, {
			branches: ["main"],
			types: ["closed"],
		});
		assert.equal(releaseWorkflow.on?.push, undefined);
		assert.equal(releaseWorkflow.on?.pull_request_target, undefined);
		assert.equal(releaseWorkflow.concurrency?.group, "release-publish");
		assert.equal(releaseWorkflow.concurrency?.["cancel-in-progress"], false);

		const condition = releaseWorkflow.jobs?.tag?.if ?? "";
		assert.match(condition, /pull_request\.merged == true/);
		assert.match(condition, /pull_request\.base\.ref == 'main'/);
		assert.match(condition, /pull_request\.head\.repo\.full_name == github\.repository/);
		assert.match(condition, /startsWith\(github\.event\.pull_request\.head\.ref, 'release\/v'\)/);
	});

	it("validates and tags the exact squash commit with an idempotent collision guard", () => {
		const tagJob = releaseWorkflow.jobs?.tag;
		assert.deepEqual(tagJob?.permissions, { contents: "write" });

		const checkout = workflowStep(tagJob, "Checkout exact merge commit");
		assert.equal(checkout.with?.ref, "${{ github.event.pull_request.merge_commit_sha }}");
		assert.equal(checkout.with?.["persist-credentials"], false);

		const validation = workflowStep(tagJob, "Validate merged release PR").run ?? "";
		assert.match(validation, /ACTUAL_SHA.*MERGE_SHA/);
		assert.match(validation, /0\|\[1-9\]\\d\*/);
		assert.match(validation, /prereleasePart/);
		assert.match(validation, /release\/\$TAG/);
		assert.match(validation, /chore\(release\): \$TAG/);
		assert.match(validation, /lock\.packages\?\.\[""\]\?\.version/);
		assert.match(validation, /RELEASE_NOTES_\$TAG\.md/);

		const protection = workflowStep(tagJob, "Verify release tag protection").run ?? "";
		assert.match(protection, /Release tag creation/);
		assert.match(protection, /Immutable release tags/);
		assert.match(protection, /\.type == "creation"/);
		assert.match(protection, /\.type == "update"/);
		assert.match(protection, /\.type == "deletion"/);
		assert.match(protection, /current_user_can_bypass == "always"/);
		assert.match(protection, /current_user_can_bypass == "never"/);
		assert.doesNotMatch(protection, /bypass_actors/);

		const createTag = workflowStep(tagJob, "Create or verify release tag").run ?? "";
		assert.match(createTag, /git\/ref\/tags\/\$TAG/);
		assert.match(createTag, /object_type.*commit/);
		assert.match(createTag, /object_sha.*MERGE_SHA/);
		assert.match(createTag, /refs\/tags\/\$TAG/);

		const names = tagJob?.steps?.map(step => step.name) ?? [];
		assert.ok(names.indexOf("Verify release tag protection") < names.indexOf("Create or verify release tag"));
	});

	it("publishes in the same run with read-only contents and short-lived npm OIDC", () => {
		const publishJob = releaseWorkflow.jobs?.publish;
		assert.equal(publishJob?.needs, "tag");
		assert.deepEqual(publishJob?.permissions, {
			contents: "read",
			"id-token": "write",
		});

		const checkout = workflowStep(publishJob, "Checkout tagged merge commit");
		assert.equal(checkout.with?.ref, "${{ needs.tag.outputs.merge-sha }}");
		assert.equal(checkout.with?.["persist-credentials"], false);
		workflowStep(publishJob, "Verify release tag");
		workflowStep(publishJob, "Install");
		const publish = workflowStep(publishJob, "Publish (OIDC trusted publishing)").run ?? "";
		assert.match(publish, /npm publish --provenance --tag "\$DIST_TAG"/);
		assert.doesNotMatch(publish, /npm view|already published/);

		const names = publishJob?.steps?.map(step => step.name) ?? [];
		assert.ok(names.indexOf("Verify release tag") < names.indexOf("Install"));
		assert.ok(names.indexOf("Install") < names.indexOf("Publish (OIDC trusted publishing)"));
	});

	it("keeps the runbook aligned with action-owned tags and merge-as-publish", () => {
		assert.match(skill, /Merging publishes/);
		assert.match(skill, /release workflow owns the tag/i);
		assert.match(skill, /Release tag creation.*Immutable release tags/s);
		assert.match(skill, /before.*release\nPR merge in §8/s);
		assert.doesNotMatch(skill, /git tag -[sa]|git push origin v<new-version>|user\.signingkey/);
	});
});

describe("release skill pre-flight order", () => {
	it("audits the built tarball consumer before type-checking and tests", () => {
		assert.equal(
			packageJson.scripts?.["audit:packed-consumer"],
			"node scripts/release-packed-consumer-audit.mjs",
		);
		assert.ok(position("npm ci") < position("npm audit --omit=dev"));
		assert.ok(position("npm audit --omit=dev") < position("npm run build"));
		assert.ok(position("npm run build") < position("npm run audit:packed-consumer"));
		assert.ok(position("npm run audit:packed-consumer") < position("npm run check"));
		assert.ok(position("npm run check") < position("npm run test:unit"));
		assert.ok(position("npm run test:unit") < position("npm run test:browser"));
		assert.ok(position("npm run test:browser") < position("npm run test:e2e"));
	});

	it("keeps mutable advisory availability release-only and blocks every finding", () => {
		assert.match(skill, /Registry advisory availability is deliberately release-only/);
		assert.match(skill, /Any finding blocks publish; there are no release exceptions/);
	});
});

describe("packed-consumer audit subprocess isolation", () => {
	it("disables lifecycle scripts for both pack and consumer installation", () => {
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

		try {
			Object.assign(process.env, secretEnv);
			await runPackedConsumerAudit({ npmRunner });

			assert.deepEqual(calls.map(call => call.args[0]), ["pack", "config", "install", "audit"]);
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
