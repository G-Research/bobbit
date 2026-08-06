/**
 * Resolve Graphify to one exact, capability-proven release before it reaches
 * GraphifyDeltaAdapter. This module is intentionally pure: package lookup and
 * feature probing happen outside it, then their immutable results are passed in.
 */
export const GRAPHIFY_DELTA_CAPABILITY = "incremental-delta" as const;
export type GraphifyCapability = typeof GRAPHIFY_DELTA_CAPABILITY;

export interface GraphifyPackageRelease {
	/** Concrete package version advertised by the package metadata. */
	version: string;
	/** Capabilities established by the host's public/compatibility feature probe. */
	capabilities: readonly GraphifyCapability[];
}

export interface GraphifyPackageMetadata {
	/** All installable releases known to the package resolver. */
	versions: readonly GraphifyPackageRelease[];
	/** The version presently loaded at startup, if a runtime is already installed. */
	installedVersion?: string;
}

export interface GraphifyVersionRecord {
	resolvedVersion: string;
	resolvedAt: string;
}

export interface ResolveGraphifyVersionInput {
	/** A user configuration value. Pins must be concrete versions, never ranges. */
	requestedVersion?: string;
	/** The runtime contract's supported Graphify range. */
	supportedRange: string;
	packageMetadata: GraphifyPackageMetadata;
	/** Exact identity written by the previous successful installation. */
	recorded?: GraphifyVersionRecord;
	/** Injectable clock so installation records are deterministic in tests. */
	now?: () => Date;
}

export interface GraphifyVersionResolution {
	requestedVersion?: string;
	resolvedVersion: string;
	/** The record callers persist in GraphMeta for reproducibility. */
	record: GraphifyVersionRecord;
	minimumVersion: string;
	requiredCapability: GraphifyCapability;
	/** A changed installed or recorded identity must make existing bases stale. */
	stale: boolean;
	/** Human-readable operator warnings; empty means all observed identities agree. */
	warnings: string[];
}

/** A structured compatibility failure suitable for routes/status surfaces. */
export class GraphifyVersionError extends Error {
	readonly requiredCapability = GRAPHIFY_DELTA_CAPABILITY;

	constructor(
		readonly installedVersion: string | undefined,
		readonly minimumVersion: string,
		detail: string,
	) {
		super(`Graphify ${installedVersion ?? "runtime"} is unsupported: minimum version ${minimumVersion}; required capability ${GRAPHIFY_DELTA_CAPABILITY}; ${detail}`);
		this.name = "GraphifyVersionError";
	}
}

/**
 * Pick the newest capability-proven release in the supported range, unless an
 * explicit exact pin was supplied. Both the selected and already-installed
 * versions are validated: an old loaded runtime must fail loudly rather than
 * being silently treated as the selected newer package.
 */
export function resolveGraphifyVersion(input: ResolveGraphifyVersionInput): GraphifyVersionResolution {
	const range = parseRange(input.supportedRange);
	const minimumVersion = formatSemVer(range.minimum);
	const releases = normaliseReleases(input.packageMetadata.versions);
	const requestedVersion = input.requestedVersion?.trim() || undefined;
	if (input.requestedVersion !== undefined && !requestedVersion) throw new Error("requested Graphify version must be an exact version");
	if (requestedVersion && !parseExactVersion(requestedVersion)) throw new Error("requested Graphify version must be an exact version, not a range");

	const selected = requestedVersion
		? releases.get(requestedVersion)
		: newestSupportedRelease(releases, range);
	if (!selected) {
		throw new GraphifyVersionError(
			requestedVersion ?? input.packageMetadata.installedVersion,
			minimumVersion,
			requestedVersion
				? `explicit pin ${requestedVersion} is not present in package metadata`
				: `no package release satisfies supported range ${input.supportedRange.trim() || "*"}`,
		);
	}
	assertSupportedRelease(selected, range, minimumVersion);

	const installedVersion = input.packageMetadata.installedVersion?.trim() || undefined;
	if (installedVersion) {
		const installed = releases.get(installedVersion);
		if (!installed) {
			throw new GraphifyVersionError(installedVersion, minimumVersion, "installed version is absent from package metadata and cannot be capability-probed");
		}
		assertSupportedRelease(installed, range, minimumVersion);
	}

	const warnings: string[] = [];
	if (installedVersion && installedVersion !== selected.version) {
		warnings.push(`Installed Graphify ${installedVersion} differs from resolved ${selected.version}; existing graph bases are stale.`);
	}
	if (input.recorded && input.recorded.resolvedVersion !== selected.version) {
		warnings.push(`Recorded Graphify ${input.recorded.resolvedVersion} differs from resolved ${selected.version}; existing graph bases are stale.`);
	}
	return {
		...(requestedVersion ? { requestedVersion } : {}),
		resolvedVersion: selected.version,
		record: { resolvedVersion: selected.version, resolvedAt: (input.now ?? (() => new Date()))().toISOString() },
		minimumVersion,
		requiredCapability: GRAPHIFY_DELTA_CAPABILITY,
		stale: warnings.length > 0,
		warnings,
	};
}

function normaliseReleases(releases: readonly GraphifyPackageRelease[]): Map<string, GraphifyPackageRelease> {
	const normalised = new Map<string, GraphifyPackageRelease>();
	for (const release of releases) {
		if (!release || typeof release.version !== "string" || !parseExactVersion(release.version)) throw new Error(`package metadata has an invalid Graphify version: ${String(release?.version)}`);
		if (!Array.isArray(release.capabilities)) throw new Error(`package metadata has invalid capabilities for Graphify ${release.version}`);
		if (normalised.has(release.version)) throw new Error(`package metadata repeats Graphify ${release.version}`);
		normalised.set(release.version, { version: release.version, capabilities: [...new Set(release.capabilities)].sort() as GraphifyCapability[] });
	}
	return normalised;
}

function newestSupportedRelease(releases: ReadonlyMap<string, GraphifyPackageRelease>, range: VersionRange): GraphifyPackageRelease | undefined {
	return [...releases.values()]
		.filter(release => satisfies(parseExactVersion(release.version)!, range) && release.capabilities.includes(GRAPHIFY_DELTA_CAPABILITY))
		.sort((left, right) => compareSemVer(parseExactVersion(right.version)!, parseExactVersion(left.version)!))[0];
}

function assertSupportedRelease(release: GraphifyPackageRelease, range: VersionRange, minimumVersion: string): void {
	const version = parseExactVersion(release.version)!;
	if (!satisfies(version, range)) {
		throw new GraphifyVersionError(release.version, minimumVersion, `version is outside supported range ${range.source}`);
	}
	if (!release.capabilities.includes(GRAPHIFY_DELTA_CAPABILITY)) {
		throw new GraphifyVersionError(release.version, minimumVersion, "the feature probe did not establish incremental-delta support");
	}
}

interface SemVer { major: bigint; minor: bigint; patch: bigint; prerelease: readonly string[] }
interface Comparator { operator: ">" | ">=" | "<" | "<=" | "="; version: SemVer }
interface RangeClause { comparators: readonly Comparator[] }
interface VersionRange { source: string; clauses: readonly RangeClause[]; minimum: SemVer }

function parseRange(source: string): VersionRange {
	const trimmed = source.trim();
	if (!trimmed || trimmed === "*") return { source: trimmed || "*", clauses: [{ comparators: [] }], minimum: zeroVersion() };
	const clauses = trimmed.split("||").map(part => parseClause(part.trim(), source));
	if (clauses.some(clause => clause.comparators.length === 0 && trimmed !== "*")) throw new Error(`invalid supported Graphify range: ${source}`);
	const lowerBounds = clauses.flatMap(clause => clause.comparators.filter(comparator => comparator.operator === ">" || comparator.operator === ">=").map(comparator => comparator.version));
	return {
		source: trimmed,
		clauses,
		minimum: lowerBounds.sort(compareSemVer)[0] ?? zeroVersion(),
	};
}

function parseClause(clause: string, original: string): RangeClause {
	if (!clause) throw new Error(`invalid supported Graphify range: ${original}`);
	const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clause);
	if (hyphen) return { comparators: [{ operator: ">=", version: parseRangeVersion(hyphen[1]!, original) }, { operator: "<=", version: parseRangeVersion(hyphen[2]!, original) }] };
	const comparators: Comparator[] = [];
	for (const token of clause.split(/\s+/)) {
		if (!token || token === "*") continue;
		const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
		if (!match) throw new Error(`invalid supported Graphify range: ${original}`);
		const operator = match[1] ?? "";
		const version = parseRangeVersion(match[2]!, original);
		if (operator === "^") {
			comparators.push({ operator: ">=", version }, { operator: "<", version: caretUpperBound(version) });
		} else if (operator === "~") {
			comparators.push({ operator: ">=", version }, { operator: "<", version: { ...version, minor: version.minor + 1n, patch: 0n, prerelease: [] } });
		} else {
			comparators.push({ operator: (operator || "=") as Comparator["operator"], version });
		}
	}
	return { comparators };
}

function parseRangeVersion(value: string, original: string): SemVer {
	const parsed = parseExactVersion(value);
	if (!parsed) throw new Error(`invalid supported Graphify range: ${original}`);
	return parsed;
}

function parseExactVersion(value: string): SemVer | null {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
	if (!match) return null;
	return { major: BigInt(match[1]!), minor: BigInt(match[2]!), patch: BigInt(match[3]!), prerelease: match[4]?.split(".") ?? [] };
}

function caretUpperBound(version: SemVer): SemVer {
	if (version.major > 0n) return { major: version.major + 1n, minor: 0n, patch: 0n, prerelease: [] };
	if (version.minor > 0n) return { major: 0n, minor: version.minor + 1n, patch: 0n, prerelease: [] };
	return { major: 0n, minor: 0n, patch: version.patch + 1n, prerelease: [] };
}
function zeroVersion(): SemVer { return { major: 0n, minor: 0n, patch: 0n, prerelease: [] }; }
function formatSemVer(version: SemVer): string { return `${version.major}.${version.minor}.${version.patch}`; }

function satisfies(version: SemVer, range: VersionRange): boolean {
	return range.clauses.some(clause => clause.comparators.every(comparator => {
		const comparison = compareSemVer(version, comparator.version);
		return comparator.operator === ">" ? comparison > 0
			: comparator.operator === ">=" ? comparison >= 0
				: comparator.operator === "<" ? comparison < 0
					: comparator.operator === "<=" ? comparison <= 0
						: comparison === 0;
	}));
}

function compareSemVer(left: SemVer, right: SemVer): number {
	for (const key of ["major", "minor", "patch"] as const) {
		if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
	}
	if (left.prerelease.length === 0 || right.prerelease.length === 0) return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
	for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
		const a = left.prerelease[index];
		const b = right.prerelease[index];
		if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
		if (a === b) continue;
		const aNumeric = /^\d+$/.test(a);
		const bNumeric = /^\d+$/.test(b);
		if (aNumeric && bNumeric) return BigInt(a) > BigInt(b) ? 1 : -1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return a > b ? 1 : -1;
	}
	return 0;
}
