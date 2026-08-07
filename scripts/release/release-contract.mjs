import { compareReleaseVersions, isExactVersion } from "./dist-tag-guard.mjs";

export { compareReleaseVersions } from "./dist-tag-guard.mjs";

export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
export const GITHUB_API = "https://api.github.com";

const MIN_RELEASE_NOTES_CHARS = 80;

export const CHANGELOG_PATH = "CHANGELOG.md";

export class ReleaseContractError extends Error {
	constructor(message) {
		super(message);
		this.name = "ReleaseContractError";
	}
}

function fail(message) {
	throw new ReleaseContractError(message);
}

export function releaseTagFor(version) {
	return `v${version}`;
}

function parseChangelog(changelog) {
	const text = String(changelog ?? "");
	const headings = [...text.matchAll(/^## v(\S+)[^\S\n]*$/gm)];
	const sections = headings.map((heading, index) => {
		const start = heading.index;
		const end = headings[index + 1]?.index ?? text.length;
		return {
			version: heading[1],
			body: text.slice(start + heading[0].length, end).trim(),
			raw: text.slice(start, end),
		};
	});
	return {
		preamble: text.slice(0, headings[0]?.index ?? text.length),
		sections,
	};
}

export function changelogSections(changelog) {
	return parseChangelog(changelog).sections.map(({ version, body }) => ({ version, body }));
}

export function changelogSectionFor(changelog, version) {
	return changelogSections(changelog).find(section => section.version === version)?.body ?? null;
}

function assertUniqueChangelogVersions(sections) {
	const seen = new Set();
	for (const { version } of sections) {
		if (seen.has(version)) {
			fail(`${CHANGELOG_PATH} contains more than one \`## v${version}\` section`);
		}
		seen.add(version);
	}
}

export function assertChangelogSection(changelog, version) {
	const { sections } = parseChangelog(changelog);
	assertUniqueChangelogVersions(sections);
	const section = sections.find(entry => entry.version === version);
	if (!section) {
		fail(
			`${CHANGELOG_PATH} has no \`## v${version}\` section. The release notes are ` +
				"written by hand and reviewed in the release PR; they are not generated.",
		);
	}
	if (sections[0].version !== version) {
		fail(
			`${CHANGELOG_PATH} lists v${sections[0].version} above v${version}. ` +
				"Newest release first: prepend the new section rather than appending it.",
		);
	}
	if (section.body.length < MIN_RELEASE_NOTES_CHARS) {
		fail(
			`the \`## v${version}\` section is too short to publish ` +
				`(${section.body.length} chars, need ${MIN_RELEASE_NOTES_CHARS}). ` +
				"It becomes the public GitHub release.",
		);
	}
	return section.body;
}

export function assertChangelogAppendOnly(previousChangelog, currentChangelog) {
	const previous = parseChangelog(previousChangelog);
	const current = parseChangelog(currentChangelog);
	assertUniqueChangelogVersions(previous.sections);
	assertUniqueChangelogVersions(current.sections);
	if (String(previousChangelog ?? "") !== "" && current.preamble !== previous.preamble) {
		fail(`${CHANGELOG_PATH} rewrites text before the first release; a release may add its own entry only`);
	}

	const currentByVersion = new Map(current.sections.map(section => [section.version, section.raw]));
	for (const { version, raw } of previous.sections) {
		if (!currentByVersion.has(version)) {
			fail(`${CHANGELOG_PATH} drops the released v${version} section; releases are a record`);
		}
		if (currentByVersion.get(version) !== raw) {
			fail(
				`${CHANGELOG_PATH} rewrites the released v${version} section. ` +
					"A release may add its own entry and nothing else.",
			);
		}
	}
}

export function fileAtCommit(rev, path, run) {
	const resolved = run(["rev-parse", "--verify", `${rev}^{commit}`]);
	if (resolved.status !== 0) {
		throw new Error(
			`cannot resolve ${rev}: ${resolved.stderr?.trim() || `git exited ${resolved.status}`}. ` +
				"Fetch enough history to reach it — treating it as absent would skip the append-only check.",
		);
	}
	const shown = run(["show", `${rev}:${path}`]);
	return shown.status === 0 ? shown.stdout : null;
}

export function releaseBranchFor(version) {
	return `release/v${version}`;
}

export function isReleaseBranchFor(ref, version) {
	const expected = releaseBranchFor(version);
	if (ref === expected) return true;
	const retryPrefix = `${expected}-retry-`;
	return typeof ref === "string" && ref.startsWith(retryPrefix) && /^[1-9]\d*$/.test(ref.slice(retryPrefix.length));
}

export function releaseTitleFor(version) {
	return `chore(release): v${version}`;
}

export function distTagFor(version) {
	return version.includes("-") ? "next" : "latest";
}

export function assertReleaseVersion(version) {
	if (!isExactVersion(version) || version.includes("+")) {
		fail(`package.json version is not a release version: ${version}`);
	}
	return version;
}

export function assertLockfileAgreement(pkg, lock) {
	const root = lock?.packages?.[""]?.version;
	if (lock?.version !== pkg?.version || root !== pkg?.version) {
		fail(
			`package-lock (${lock?.version}, ${root}) does not match package.json ${pkg?.version}. ` +
				"Run `npm install --package-lock-only` on the release branch.",
		);
	}
}

export function assertExactOptionalDependencyPins(pkg) {
	for (const [name, version] of Object.entries(pkg?.optionalDependencies ?? {})) {
		if (!isExactVersion(version)) {
			fail(
				`optionalDependencies.${name} must be pinned to an exact version, got ${String(version)}. ` +
					"Ranges and dist-tags can change after the root package is published.",
			);
		}
	}
}

export function assertVersionBump(parentVersion, version, sha) {
	const order = compareReleaseVersions(version, parentVersion);
	if (order === 0) {
		fail(
			`${sha} does not bump the version; its parent is already ${version}. ` +
				"Only the release merge commit itself may be released.",
		);
	}
	if (order < 0) {
		fail(
			`${sha} moves the version backwards: ${parentVersion} -> ${version}. ` +
				"A lower version still takes the latest dist-tag, which would downgrade every consumer.",
		);
	}
}

export function assertPullRequestContract(pr, { version, repository, sha }) {
	if (!pr) {
		fail(
			`no merged pull request produced ${sha}. A release must come from a ` +
				`${releaseBranchFor(version)} pull request merged into main.`,
		);
	}
	if (pr.base?.ref !== "main") {
		fail(`release pull request #${pr.number} targets ${pr.base?.ref}, expected main`);
	}
	if (pr.head?.repo?.full_name !== repository) {
		fail(
			`release pull request #${pr.number} comes from ${pr.head?.repo?.full_name ?? "an unknown repository"}, ` +
				`expected ${repository}. Release branches must live in this repository.`,
		);
	}
	if (!isReleaseBranchFor(pr.head?.ref, version)) {
		fail(
			`release branch ${pr.head?.ref} does not match version ${version} ` +
				`(expected ${releaseBranchFor(version)} or ${releaseBranchFor(version)}-retry-<number>). ` +
				"A release must be opened as a release, not be the side effect of a version change.",
		);
	}
	if (pr.title !== releaseTitleFor(version)) {
		fail(`release pull request title must be: ${releaseTitleFor(version)}`);
	}
	return pr;
}

export const RELEASE_WORKFLOW_PATH = ".github/workflows/release-publish.yml";

export function extractProvenanceSource(response) {
	const attestations = Array.isArray(response?.attestations) ? response.attestations : [];
	const provenance = attestations.find(entry =>
		String(entry?.predicateType ?? "").startsWith("https://slsa.dev/provenance/"),
	);
	const payload = provenance?.bundle?.dsseEnvelope?.payload;
	if (typeof payload !== "string") return null;

	let statement;
	try {
		statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
	} catch {
		return null;
	}

	const build = statement?.predicate?.buildDefinition ?? {};
	const dependencies = Array.isArray(build.resolvedDependencies) ? build.resolvedDependencies : [];
	const workflow = build?.externalParameters?.workflow ?? {};
	const repository = typeof workflow.repository === "string" ? workflow.repository : null;
	const source = repository
		? dependencies.find(
				entry =>
					typeof entry?.digest?.gitCommit === "string" &&
					typeof entry?.uri === "string" &&
					entry.uri.startsWith(`git+${repository}@`),
			)
		: null;

	return {
		sha: source?.digest?.gitCommit ?? null,
		repository,
		path: typeof workflow.path === "string" ? workflow.path : null,
	};
}

export function assertPublishedArtifactMatches(source, { spec, repository, sha }) {
	const recover =
		`${spec} is already on the registry and npm versions are immutable. ` +
		"Confirm what was published, then release the next version instead.";

	if (!source) {
		fail(`${spec} is already published but carries no readable provenance attestation. ${recover}`);
	}
	if (source.sha !== sha) {
		fail(`${spec} was published from commit ${source.sha ?? "<unknown>"}, not ${sha}. ${recover}`);
	}
	const expectedRepository = `https://github.com/${repository}`;
	if (source.repository !== expectedRepository) {
		fail(
			`${spec} was published from ${source.repository ?? "<unknown>"}, not ${expectedRepository}. ${recover}`,
		);
	}
	if (source.path !== RELEASE_WORKFLOW_PATH) {
		fail(
			`${spec} was published by ${source.path ?? "<unknown>"}, not ${RELEASE_WORKFLOW_PATH}. ${recover}`,
		);
	}
	return true;
}

export function npmAttestationUrl(name, version) {
	return `${PUBLIC_NPM_REGISTRY}/-/npm/v1/attestations/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

export async function fetchJson(url, { headers = {}, fetchImpl = fetch, attempts = 3 } = {}) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await fetchImpl(url, { headers: { accept: "application/json", ...headers } });
			if (response.status === 404) return { status: 404, body: null };
			if (response.ok) return { status: response.status, body: await response.json() };
			if (response.status < 500 && response.status !== 429) {
				return { status: response.status, body: null };
			}
			lastError = new Error(`${url} responded ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
	}
	throw new Error(`request failed after ${attempts} attempts: ${url}`, { cause: lastError });
}

export function githubHeaders(token) {
	return {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

export function npmPackageUrl(name, version) {
	return `${PUBLIC_NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}
