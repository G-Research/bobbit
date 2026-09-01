import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";
import { extractProvenanceSource, RELEASE_WORKFLOW_PATH } from "../../../scripts/release/release-contract.mjs";
import { validateReleaseCommit } from "../../../scripts/release/validate-release-commit.mjs";

const roots: string[] = [];
const repository = "G-Research/bobbit";
const packageName = "@test/release";
const previousVersion = "1.0.0";
const version = "1.1.0";

function packageFiles(root: string, packageVersion: string, changelog: string): void {
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name: packageName, version: packageVersion }, null, 2)}\n`,
	);
	writeFileSync(
		join(root, "package-lock.json"),
		`${JSON.stringify(
			{
				name: packageName,
				version: packageVersion,
				lockfileVersion: 3,
				packages: { "": { name: packageName, version: packageVersion } },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(join(root, "CHANGELOG.md"), changelog);
}

type GitResult = { status: number; stdout: string; stderr: string };

async function releaseRepository(): Promise<{
	root: string;
	sha: string;
	runGit: (args: string[]) => GitResult;
}> {
	const root = await mkdtemp(join(tmpdir(), "bobbit-release-validator-"));
	roots.push(root);
	const sha = "a".repeat(40);
	const previousNotes = "Previous release notes remain immutable. ".repeat(4);
	const previousChangelog = `# Changelog\n\n## v${previousVersion}\n\n${previousNotes}\n`;
	const currentNotes = "Reviewed release notes explain the user-visible changes clearly. ".repeat(3);
	packageFiles(
		root,
		version,
		`# Changelog\n\n## v${version}\n\n${currentNotes}\n\n## v${previousVersion}\n\n${previousNotes}\n`,
	);

	const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });
	const runGit = (args: string[]): GitResult => {
		if (args.join(" ") === `show ${sha}^:package.json`) {
			return ok(`${JSON.stringify({ name: packageName, version: previousVersion })}\n`);
		}
		if (args.join(" ") === `rev-parse --verify ${sha}^^{commit}`) return ok(`${"b".repeat(40)}\n`);
		if (args.join(" ") === `show ${sha}^:CHANGELOG.md`) return ok(previousChangelog);
		return { status: 128, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
	};
	return { root, sha, runGit };
}

function pullRequest(sha: string): object {
	return {
		number: 42,
		merged_at: "2026-08-05T00:00:00Z",
		merge_commit_sha: sha,
		base: { ref: "main" },
		head: { ref: `release/v${version}`, repo: { full_name: repository } },
		title: `chore(release): v${version}`,
	};
}

function provenance(sha: string): object {
	const statement = {
		predicate: {
			buildDefinition: {
				externalParameters: {
					workflow: {
						repository: `https://github.com/${repository}`,
						path: RELEASE_WORKFLOW_PATH,
					},
				},
				resolvedDependencies: [
					{
						uri: `git+https://github.com/${repository}@refs/heads/main`,
						digest: { gitCommit: sha },
					},
				],
			},
		},
	};
	return {
		attestations: [
			{
				predicateType: "https://slsa.dev/provenance/v1",
				bundle: {
					dsseEnvelope: {
						payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
					},
				},
			},
		],
	};
}

type RegistryState = {
	published?: boolean;
	attestation?: object;
	distTagVersion?: string;
	releaseStatus?: number;
};

function responses(sha: string, state: RegistryState = {}): typeof fetch {
	return (async input => {
		const url = String(input);
		let status = 200;
		let body: object | null;
		if (url === `https://api.github.com/repos/${repository}/commits/${sha}/pulls`) {
			body = [pullRequest(sha)];
		} else if (url === `https://registry.npmjs.org/%40test%2Frelease/${version}`) {
			status = state.published ? 200 : 404;
			body = state.published ? { name: packageName, version } : null;
		} else if (url === "https://registry.npmjs.org/%40test%2Frelease/latest") {
			body = { version: state.distTagVersion ?? previousVersion };
		} else if (url === `https://registry.npmjs.org/-/npm/v1/attestations/%40test%2Frelease@${version}`) {
			body = state.attestation ?? provenance(sha);
		} else if (url === `https://api.github.com/repos/${repository}/releases/tags/v${version}`) {
			status = state.releaseStatus ?? 404;
			body = status === 200 ? { tag_name: `v${version}` } : null;
		} else {
			throw new Error(`unexpected request: ${url}`);
		}
		return new Response(body === null ? null : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("release validator integration", () => {
	it("validates a complete release commit and emits the publish baseline", async () => {
		const { root, sha, runGit } = await releaseRepository();
		const result = await validateReleaseCommit(
			{ mode: "merged", repository, sha },
			{ GITHUB_TOKEN: "test-token" },
			{ root, runGit, fetchImpl: responses(sha) },
		);
		assert.deepEqual(result, {
			tag: `v${version}`,
			version,
			"dist-tag": "latest",
			dist_tag_base: previousVersion,
			"need-publish": "true",
			"need-release": "true",
			"pull-request": "42",
		});
	});

	it("accepts an already-published version only with matching provenance", async () => {
		const { root, sha, runGit } = await releaseRepository();
		const result = await validateReleaseCommit(
			{ mode: "merged", repository, sha },
			{ GITHUB_TOKEN: "test-token" },
			{
				root,
				runGit,
				fetchImpl: responses(sha, {
					published: true,
					attestation: provenance(sha),
					releaseStatus: 200,
				}),
			},
		);
		assert.equal(result?.["need-publish"], "false");
		assert.equal(result?.["need-release"], "false");
		assert.equal(result?.dist_tag_base, "");
	});

	it("parses the captured npm attestation and rejects its different source commit", async () => {
		const fixture = JSON.parse(
			readFileSync(
				resolve("tests/support/fixtures/release/npm-attestations-bobbit-0.15.1.json"),
				"utf8",
			),
		);
		assert.deepEqual(extractProvenanceSource(fixture), {
			sha: "f4f8137f21d1d13d41bf52a7e1f871e0ba615cda",
			repository: "https://github.com/G-Research/bobbit",
			path: RELEASE_WORKFLOW_PATH,
		});

		const { root, sha, runGit } = await releaseRepository();
		await assert.rejects(
			validateReleaseCommit(
				{ mode: "merged", repository, sha },
				{ GITHUB_TOKEN: "test-token" },
				{ root, runGit, fetchImpl: responses(sha, { published: true, attestation: fixture }) },
			),
			/was published from commit f4f8137f/,
		);
	});

	it("fails closed on a stale dist-tag baseline or unexpected GitHub status", async () => {
		const { root, sha, runGit } = await releaseRepository();
		await assert.rejects(
			validateReleaseCommit(
				{ mode: "merged", repository, sha },
				{ GITHUB_TOKEN: "test-token" },
				{ root, runGit, fetchImpl: responses(sha, { distTagVersion: "1.2.0" }) },
			),
			/refusing to move latest backwards/,
		);
		await assert.rejects(
			validateReleaseCommit(
				{ mode: "merged", repository, sha },
				{ GITHUB_TOKEN: "test-token" },
				{ root, runGit, fetchImpl: responses(sha, { releaseStatus: 403 }) },
			),
			/release lookup for v1\.1\.0 returned 403/,
		);
	});
});
