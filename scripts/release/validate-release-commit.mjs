#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertDistTagAdvances } from "./dist-tag-guard.mjs";
import {
	assertChangelogAppendOnly,
	assertChangelogSection,
	assertExactOptionalDependencyPins,
	assertLockfileAgreement,
	assertPublishedArtifactMatches,
	assertPullRequestContract,
	assertReleaseVersion,
	assertVersionBump,
	distTagFor,
	extractProvenanceSource,
	fetchJson,
	fileAtCommit,
	GITHUB_API,
	githubHeaders,
	CHANGELOG_PATH,
	npmAttestationUrl,
	npmPackageUrl,
	releaseTagFor,
	ReleaseContractError,
} from "./release-contract.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
	const args = { mode: "merged" };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (!flag.startsWith("--")) continue;
		const key = flag.slice(2);
		const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[(i += 1)] : "true";
		args[key] = value;
	}
	return args;
}

async function resolvePullRequest({ repository, sha, number, token, fetchImpl }) {
	if (number) {
		const { body } = await fetchJson(`${GITHUB_API}/repos/${repository}/pulls/${number}`, {
			headers: githubHeaders(token),
			fetchImpl,
		});
		return body;
	}
	const { body } = await fetchJson(`${GITHUB_API}/repos/${repository}/commits/${sha}/pulls`, {
		headers: githubHeaders(token),
		fetchImpl,
	});
	const candidates = Array.isArray(body) ? body : [];
	return (
		candidates.find(pr => pr.merged_at && pr.base?.ref === "main" && pr.merge_commit_sha === sha) ??
		null
	);
}

async function isPublished(name, version, fetchImpl) {
	const { status } = await fetchJson(npmPackageUrl(name, version), { fetchImpl });
	if (status === 404) return false;
	if (status === 200) return true;
	throw new Error(`registry lookup for ${name}@${version} returned ${status}`);
}

async function assertOptionalDependenciesPublished(pkg, fetchImpl) {
	const pins = Object.entries(pkg.optionalDependencies ?? {});
	const missing = [];
	for (const [name, version] of pins) {
		if (!(await isPublished(name, version, fetchImpl))) missing.push(`${name}@${version}`);
	}
	if (missing.length > 0) {
		throw new ReleaseContractError(
			`optionalDependencies pins are not on the registry: ${missing.join(", ")}. ` +
				"Publish the binary sub-packages before merging the release PR.",
		);
	}
}

async function releaseExists({ repository, tag, token, fetchImpl }) {
	const { status } = await fetchJson(`${GITHUB_API}/repos/${repository}/releases/tags/${tag}`, {
		headers: githubHeaders(token),
		fetchImpl,
	});
	if (status === 200) return true;
	if (status === 404) return false;
	throw new Error(`release lookup for ${tag} returned ${status}`);
}

export async function validateReleaseCommit(args, env = process.env, options = {}) {
	const root = options.root ?? REPO_ROOT;
	const fetchImpl = options.fetchImpl ?? fetch;
	const runGit =
		options.runGit ?? (gitArgs => spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" }));
	const git = (...gitArgs) => {
		const result = runGit(gitArgs);
		if (result.status !== 0) {
			throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr?.trim() || result.status}`);
		}
		return result.stdout;
	};
	const readJson = relativePath => JSON.parse(readFileSync(join(root, relativePath), "utf8"));

	const mode = args.mode ?? "merged";
	if (mode !== "merged" && mode !== "pre-merge") {
		throw new Error(`unknown --mode ${mode} (expected merged or pre-merge)`);
	}

	const repository = args.repository ?? env.GITHUB_REPOSITORY;
	const sha = args.sha ?? env.GITHUB_SHA;
	const token = args.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
	if (!repository) throw new Error("--repository or GITHUB_REPOSITORY is required");
	if (!sha) throw new Error("--sha or GITHUB_SHA is required");

	const pkg = readJson("package.json");
	const version = assertReleaseVersion(pkg.version);
	const tag = releaseTagFor(version);

	const baseRev = mode === "pre-merge" ? "HEAD^1" : `${sha}^`;
	const baseVersion = JSON.parse(git("show", `${baseRev}:package.json`)).version;

	if (mode === "pre-merge" && baseVersion === version) {
		console.log(`package.json is unchanged at ${version}; not a release pull request`);
		return null;
	}

	assertLockfileAgreement(pkg, readJson("package-lock.json"));
	assertExactOptionalDependencyPins(pkg);

	let changelog = "";
	try {
		changelog = readFileSync(join(root, CHANGELOG_PATH), "utf8");
	} catch {
		throw new ReleaseContractError(`missing ${CHANGELOG_PATH}`);
	}
	assertChangelogSection(changelog, version);
	assertVersionBump(baseVersion, version, sha);
	assertChangelogAppendOnly(fileAtCommit(baseRev, CHANGELOG_PATH, runGit) ?? "", changelog);

	const pr = await resolvePullRequest({
		repository,
		sha,
		number: args["pull-request"],
		token,
		fetchImpl,
	});
	assertPullRequestContract(pr, { version, repository, sha });

	await assertOptionalDependenciesPublished(pkg, fetchImpl);

	const spec = `${pkg.name}@${version}`;
	const published = await isPublished(pkg.name, version, fetchImpl);
	let distTagBase = null;
	if (published) {
		const { body } = await fetchJson(npmAttestationUrl(pkg.name, version), { fetchImpl });
		assertPublishedArtifactMatches(extractProvenanceSource(body), { spec, repository, sha });
		console.log(`${spec} was already published from ${sha}; this run will not republish it`);
	} else {
		distTagBase = await assertDistTagAdvances({
			packageName: pkg.name,
			distTag: distTagFor(version),
			version,
			fetchImpl,
		});
	}

	const result = {
		tag,
		version,
		"dist-tag": distTagFor(version),
		dist_tag_base: distTagBase ?? "",
		"need-publish": String(!published),
		"need-release":
			mode === "merged"
				? String(!(await releaseExists({ repository, tag, token, fetchImpl })))
				: "false",
		"pull-request": String(pr?.number ?? ""),
	};

	console.log(`${spec} -> ${tag} at ${sha} (dist-tag ${result["dist-tag"]}), PR #${result["pull-request"]}`);
	return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	const args = parseArgs(process.argv.slice(2));
	validateReleaseCommit(args)
		.then(result => {
			const outputPath = args.output ?? process.env.GITHUB_OUTPUT;
			if (result && outputPath && args.mode !== "pre-merge") {
				appendFileSync(
					outputPath,
					Object.entries(result)
						.map(([key, value]) => `${key}=${value}\n`)
						.join(""),
				);
			}
		})
		.catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`::error::${message}`);
			if (!(error instanceof ReleaseContractError)) console.error(error);
			process.exitCode = 1;
		});
}
