/**
 * Path-traversal defence for the preview content route (`/preview/<sid>/...`).
 *
 * Resolves a user-supplied relative `path` against a per-session `baseDir`
 * and rejects anything that escapes (including symlink-based escapes via
 * `realpathSync`). Implements the algorithm specified in the design doc §3.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type PathGuardResult =
	| { ok: true; resolved: string; size: number }
	| { ok: false; status: 400 | 404; error: string };

/**
 * Resolve `rel` under `baseDir` and return the absolute path if safe, or a
 * structured error for the asset route to translate to an HTTP response.
 *
 * Mutually exclusive outcomes (in order of precedence):
 *
 *   400 — input shape rejected (missing, NUL, absolute, backslash) or
 *         resolved path escapes baseDir (including via symlinks).
 *   404 — resolved path doesn't exist OR isn't a regular file.
 *   ok  — path is safe to stream, returns absolute resolved path + size.
 *
 * Note: there is no size cap here. Asset inclusion into the mount is
 * agent-driven and explicit (see `mountFile` in `mount.ts`); the agent is
 * responsible for declaring only what it needs.
 */
export function resolveAssetPath(baseDir: string, rel: string | null | undefined): PathGuardResult {
	// 2. Missing
	if (rel == null || rel === "") {
		return { ok: false, status: 400, error: "Missing path" };
	}
	// 3. Embedded NUL
	if (rel.indexOf("\0") >= 0) {
		return { ok: false, status: 400, error: "Path traversal rejected" };
	}
	// 4. Absolute paths
	if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
		return { ok: false, status: 400, error: "Path traversal rejected" };
	}
	// 5. Reject backslashes outright — force forward slashes from clients.
	if (rel.indexOf("\\") >= 0) {
		return { ok: false, status: 400, error: "Path traversal rejected" };
	}

	// 6. Resolve under baseDir.
	const resolved = path.resolve(baseDir, rel);

	// 7. realpath-aware containment check.
	let baseReal: string;
	try {
		baseReal = fs.realpathSync(baseDir);
	} catch {
		// baseDir doesn't exist — treat as 404 (no preview state).
		return { ok: false, status: 404, error: "Preview baseDir not found" };
	}
	let resolvedReal: string;
	try {
		resolvedReal = fs.realpathSync(resolved);
	} catch {
		// File doesn't exist; check that the *unresolved* path is contained
		// before reporting 404 (prevents leaking which paths exist outside).
		if (!isContained(resolved, baseReal)) {
			return { ok: false, status: 400, error: "Path traversal rejected" };
		}
		return { ok: false, status: 404, error: "File not found" };
	}

	if (!isContained(resolvedReal, baseReal)) {
		return { ok: false, status: 400, error: "Path traversal rejected" };
	}

	// 9-11. Existence + regular-file + size.
	let stat: fs.Stats;
	try {
		stat = fs.statSync(resolvedReal);
	} catch {
		return { ok: false, status: 404, error: "File not found" };
	}
	if (!stat.isFile()) {
		return { ok: false, status: 404, error: "Not a regular file" };
	}

	return { ok: true, resolved: resolvedReal, size: stat.size };
}

function isContained(child: string, parent: string): boolean {
	if (child === parent) return true;
	const sep = path.sep;
	const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(parentWithSep);
}
