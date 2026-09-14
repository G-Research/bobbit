import fs from "node:fs";
import path from "node:path";

import type { McpServerConfig } from "./mcp-types.js";

export class MarketplaceMcpSnapshotConfigError extends Error {
	readonly code = "MARKETPLACE_MCP_SNAPSHOT_CONFIG_INVALID";
	constructor() {
		super("Installed Marketplace MCP snapshot configuration could not be verified.");
		this.name = "MarketplaceMcpSnapshotConfigError";
	}
}

function configFailure(): never {
	throw new MarketplaceMcpSnapshotConfigError();
}

function isWindowsPath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

function isContained(pathApi: typeof path.posix | typeof path.win32, root: string, candidate: string): boolean {
	const relative = pathApi.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}

function resolveWithExistingAncestor(value: string, pathApi: typeof path.posix | typeof path.win32): string {
	let candidate = pathApi.normalize(value);
	const suffix: string[] = [];
	while (!fs.existsSync(candidate)) {
		const parent = pathApi.dirname(candidate);
		if (parent === candidate) return pathApi.normalize(value);
		suffix.unshift(pathApi.basename(candidate));
		candidate = parent;
	}
	try {
		return pathApi.normalize(pathApi.join(fs.realpathSync.native(candidate), ...suffix));
	} catch {
		return pathApi.normalize(value);
	}
}

function entersThenEscapesLiveRoot(
	value: string,
	liveRoot: string,
	pathApi: typeof path.posix | typeof path.win32,
	resolveAliases: boolean,
): boolean {
	const parsed = pathApi.parse(value);
	let cursor = parsed.root;
	let entered = false;
	for (const segment of value.slice(parsed.root.length).split(/[\\/]+/)) {
		if (!segment || segment === ".") continue;
		cursor = segment === ".." ? pathApi.dirname(cursor) : pathApi.join(cursor, segment);
		const candidate = resolveAliases ? resolveWithExistingAncestor(cursor, pathApi) : pathApi.normalize(cursor);
		if (isContained(pathApi, liveRoot, candidate)) entered = true;
	}
	const finalCandidate = resolveAliases ? resolveWithExistingAncestor(value, pathApi) : pathApi.normalize(value);
	return entered && !isContained(pathApi, liveRoot, finalCandidate);
}

/**
 * Map one absolute reference into the immutable snapshot when filesystem path
 * semantics identify it as part of the repository-visible pack. Relative
 * references remain relative to the snapshot cwd and external paths remain
 * external. A lexical attempt to enter and then escape the live pack fails
 * closed instead of being reclassified as an unrelated external path.
 */
function rebaseAbsolutePath(value: string, repositoryPackRoot: string, snapshotPackRoot: string): string {
	const windows = isWindowsPath(repositoryPackRoot);
	const pathApi = windows ? path.win32 : path.posix;
	if (!pathApi.isAbsolute(value)) return value;

	const privateRoot = pathApi.normalize(snapshotPackRoot);
	const canInspectNativePaths = windows === (process.platform === "win32");
	const liveRoot = canInspectNativePaths
		? resolveWithExistingAncestor(repositoryPackRoot, pathApi)
		: pathApi.normalize(repositoryPackRoot);
	const candidate = canInspectNativePaths
		? resolveWithExistingAncestor(value, pathApi)
		: pathApi.normalize(value);
	let relative: string | undefined;
	if (isContained(pathApi, liveRoot, candidate)) {
		relative = pathApi.relative(liveRoot, candidate);
	} else if (entersThenEscapesLiveRoot(value, liveRoot, pathApi, canInspectNativePaths)) {
		configFailure();
	}
	if (relative === undefined) return value;

	const rebased = relative ? pathApi.join(privateRoot, relative) : privateRoot;
	if (!isContained(pathApi, privateRoot, pathApi.normalize(rebased))) configFailure();
	return rebased;
}

function rebaseCwd(value: string, repositoryPackRoot: string, snapshotPackRoot: string): string {
	const windows = isWindowsPath(repositoryPackRoot);
	const pathApi = windows ? path.win32 : path.posix;
	// Authored Marketplace cwd values are normalized to absolute pack paths by
	// normalizeMcpContribution(). A relative or different-dialect value cannot
	// be classified safely here, so never let it inherit the gateway cwd.
	if (isWindowsPath(value) !== windows || !pathApi.isAbsolute(value)) configFailure();
	return rebaseAbsolutePath(value, repositoryPackRoot, snapshotPackRoot);
}

function rebaseValue(value: string, repositoryPackRoot: string, snapshotPackRoot: string): string {
	if (!value) return value;

	const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
		|| (value.startsWith("'") && value.endsWith("'")));
	if (quoted) {
		return `${value[0]}${rebaseValue(value.slice(1, -1), repositoryPackRoot, snapshotPackRoot)}${value[0]}`;
	}

	const equals = value.indexOf("=");
	if (equals > 0) {
		return `${value.slice(0, equals + 1)}${rebaseValue(value.slice(equals + 1), repositoryPackRoot, snapshotPackRoot)}`;
	}

	const delimiter = isWindowsPath(repositoryPackRoot) ? ";" : ":";
	if (value.includes(delimiter)) {
		const parts = value.split(delimiter);
		const rebased = parts.map((part) => rebaseAbsolutePath(part, repositoryPackRoot, snapshotPackRoot));
		if (rebased.some((part, index) => part !== parts[index])) return rebased.join(delimiter);
	}

	return rebaseAbsolutePath(value, repositoryPackRoot, snapshotPackRoot);
}

/** Bind all pack-local stdio references to one immutable private snapshot. */
export function snapshotBackedMcpConfig(
	config: McpServerConfig,
	repositoryPackRoot: string,
	snapshotPackRoot: string,
): McpServerConfig {
	if (!config.command) return config;
	return {
		...config,
		command: rebaseValue(config.command, repositoryPackRoot, snapshotPackRoot),
		...(config.args ? { args: config.args.map((value) => rebaseValue(value, repositoryPackRoot, snapshotPackRoot)) } : {}),
		...(config.env ? { env: Object.fromEntries(Object.entries(config.env)
			.map(([name, value]) => [name, rebaseValue(value, repositoryPackRoot, snapshotPackRoot)])) } : {}),
		cwd: config.cwd === undefined
			? snapshotPackRoot
			: rebaseCwd(config.cwd, repositoryPackRoot, snapshotPackRoot),
	};
}
