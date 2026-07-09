/**
 * Resolve the absolute paths to Bobbit's bundled `docs/` and `src/` directories.
 *
 * The Support assistant reads Bobbit's own documentation and source to ground
 * its answers. For npm-installed users these ship inside the package (see
 * package.json `files`), and an installed HQ session's cwd is the user's
 * workspace — NOT the package root — so we resolve from `import.meta.url`.
 *
 * Two layouts are supported (dev-vs-built fallback, mirroring project-assistant.ts):
 *   - tsx dev:  src/server/agent/bundled-paths.ts   -> ../../../<name>
 *   - built:    dist/server/agent/bundled-paths.js  -> ../../../<name>
 * In both layouts the package root is three levels above this file. A second
 * candidate two levels up is tried as a defensive fallback. The first existing
 * directory wins; otherwise the first candidate is returned so callers still get
 * a stable absolute path.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __bp_dirname = dirname(fileURLToPath(import.meta.url));

const _cache: Record<string, string> = {};

function resolveBundledDir(name: string): string {
	if (_cache[name]) return _cache[name];
	const candidates = [
		join(__bp_dirname, "..", "..", "..", name),
		join(__bp_dirname, "..", "..", name),
	];
	const resolved = candidates.find((p) => existsSync(p)) ?? candidates[0];
	_cache[name] = resolved;
	return resolved;
}

/** Absolute path to the bundled `docs/` directory. */
export function resolveBundledDocsDir(): string {
	return resolveBundledDir("docs");
}

/** Absolute path to the bundled `src/` directory. */
export function resolveBundledSrcDir(): string {
	return resolveBundledDir("src");
}
