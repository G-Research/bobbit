import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

/** Fixed public error for an extension that cannot share Pi's protected realm. */
export const TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_CODE = "TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT";
export const TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_MESSAGE = "Tool-result filtering cannot run with untrusted extensions.";

/**
 * The only state-owned directories allowed to contribute ordinary Pi extensions
 * to a protected session. Each is written by core code; config, project, and
 * Marketplace paths intentionally have no entry here.
 */
export const TOOL_RESULT_FILTER_CORE_EXTENSION_STATE_DIRS = Object.freeze([
	"mcp-extensions",
	"tool-guard",
	"provider-bridge",
	"google-code-assist",
	"tool-result-error-bridge",
	"aigw-dns-guard",
] as const);

export interface ToolResultFilterExtensionTrustOptions {
	/** Server-derived shipped tools root, never a cascade/config tools root. */
	builtinToolsDir: string;
	/** Test seam; production uses the server-owned Bobbit state directory. */
	stateDir?: string;
}

type TrustFailure = Error & { code: string };

function trustFailure(): TrustFailure {
	const error = new Error(TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_MESSAGE) as TrustFailure;
	error.code = TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_CODE;
	return error;
}

function resolveDirectory(dir: string): string | undefined {
	try {
		// The closed-list state directory itself must not be redirected outside
		// server-owned state through a symlink.
		const initial = fs.lstatSync(dir);
		if (!initial.isDirectory() || initial.isSymbolicLink()) return undefined;
		const resolved = fs.realpathSync(dir);
		return fs.statSync(resolved).isDirectory() ? resolved : undefined;
	} catch {
		return undefined;
	}
}

function resolveRegularFile(file: string): string | undefined {
	try {
		const resolved = fs.realpathSync(file);
		return fs.statSync(resolved).isFile() ? resolved : undefined;
	} catch {
		return undefined;
	}
}

function isSameOrChildPath(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Verify and canonicalize every final ordinary `--extension` input for a
 * result-filter-protected Pi process. Realpaths make a symlink escape fail
 * closed and remove a trusted in-root symlink from the eventual spawn args.
 */
export function assertTrustedToolResultFilterExtensionArgs(
	args: readonly string[],
	options: ToolResultFilterExtensionTrustOptions,
): string[] {
	const stateDir = options.stateDir ?? bobbitStateDir();
	const trustedRoots = [
		resolveDirectory(options.builtinToolsDir),
		...TOOL_RESULT_FILTER_CORE_EXTENSION_STATE_DIRS.map(sub => resolveDirectory(path.join(stateDir, sub))),
	].filter((root): root is string => root !== undefined);

	const assertPath = (extensionPath: string | undefined): string => {
		if (!extensionPath) throw trustFailure();
		const resolved = resolveRegularFile(extensionPath);
		if (!resolved || !trustedRoots.some(root => isSameOrChildPath(resolved, root))) throw trustFailure();
		return resolved;
	};

	const trustedArgs = [...args];
	for (let i = 0; i < trustedArgs.length; i++) {
		const arg = trustedArgs[i];
		if (arg === "--extension") {
			trustedArgs[i + 1] = assertPath(trustedArgs[i + 1]);
			i++;
		} else if (arg.startsWith("--extension=")) {
			trustedArgs[i] = `--extension=${assertPath(arg.slice("--extension=".length))}`;
		}
	}
	return trustedArgs;
}
