/**
 * Bobbit archive — owns the `GATEWAY_OWNED_FILES` allowlist and implements
 * `archiveProjectBobbitDir`, the "start fresh" operation that moves the
 * project-scoped contents of `<rootPath>/.bobbit/` aside into a numbered
 * `.bobbit-archive-NNN/` directory while never touching gateway-owned state.
 *
 * Design: docs/design/robust-add-project.md
 *
 * The allowlist is the single source of truth for "what does the running
 * gateway own at `<rootPath>/.bobbit/`?". A pinning unit test
 * (`tests/bobbit-archive-allowlist.spec.ts`) re-greps writers under
 * `src/server/` for `bobbitStateDir(` / `bobbitConfigDir(` joins and asserts
 * every distinct `state/` child segment is in this allowlist or annotated
 * `// archive-safe` near the call site. Drift = test failure.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Paths (relative to `<rootPath>/.bobbit/`) that the running gateway owns
 * when the user's chosen rootPath happens to be the gateway's own working
 * directory. Bias toward false positives — preserving extra files is cheap,
 * accidentally archiving gateway state kills the running server.
 *
 * Three entry shapes:
 *   - "state/file"   — exact path match
 *   - "state/dir/"   — directory subtree (skip-and-record as a unit)
 *   - "state/foo-*"  — filename prefix (matches everything starting with
 *                      "foo-" in the parent dir; one segment only)
 *
 * `bobbitConfigDir()` (under `config/`) writes are all project-scoped
 * (system-prompt.md, tools/, mcp.json) and ARE archived. Do not add
 * `config/...` entries here.
 */
export const GATEWAY_OWNED_FILES: readonly string[] = [
	// Cross-project gateway state — the running server depends on these
	"state/gateway-url",          // server.ts via cli.ts (gateway URL discovery)
	"state/watchdog.json",        // src/server/watchdog.ts
	"state/setup-complete",       // src/server/setup-status.ts
	"state/gateway-restart",      // src/server/harness.ts SENTINEL
	"state/token",                // src/server/auth/token.ts (admin token)
	"state/sessions.json",        // global session registry (spans projects)
	"state/projects.json",        // global project registry (spans projects)

	// TLS / OAuth / DNS challenge
	"state/tls/",                 // src/server/auth/tls.ts (ca.crt, server.crt, server.key)
	"state/desec.json",           // src/server/auth/desec.ts (DNS challenge state)

	// Regenerated per restart but kept to avoid cold-start work
	"state/tool-docs/",           // server.ts (tool-docs generation)
	"state/mcp-tool-docs/",       // src/server/mcp/mcp-manager.ts

	// Per-session scratch — relevant while the server is running
	"state/preview/",             // src/server/preview/mount.ts
	"state/preview-artifacts/",   // src/server/preview/artifacts.ts
	"state/tool-guard/",          // src/server/agent/tool-activation.ts
	"state/mcp-extensions/",      // src/server/agent/tool-activation.ts, rpc-bridge.ts
	"state/html-snapshots/",      // server.ts
	"state/proposal-drafts/",     // server.ts / session-manager.ts
	"state/pr-walkthrough/",      // src/server/pr-walkthrough/routes.ts persisted walkthrough payloads
	"state/model-name-*",         // src/server/agent/session-manager.ts per-session model-name files
	"state/sessions/",            // per-session JSONL transcripts (rpc-bridge.ts container mount)
	"state/session-prompts/",     // per-session prompt scratch (rpc-bridge.ts)
	"state/sandbox-agent-auth/",  // scoped sandbox auth mounts (host-tokens.ts)
	"state/system-project/",      // synthetic system-project anchor (server.ts)
];

export interface ArchiveResult {
	/** Absolute path of the created archive directory. */
	archiveDir: string;
	/** ISO timestamp of when the archive started. */
	archivedAt: string;
	/** Relative paths (from `<rootPath>/.bobbit/`) of entries that moved. */
	movedPaths: string[];
	/** Relative paths (from `<rootPath>/.bobbit/`) of entries that were preserved. */
	preservedPaths: string[];
	/** Whether the rootPath was detected as gateway-owned. */
	gatewayOwned: boolean;
	/** Partial-failure info if any per-entry move failed. */
	partial?: { failed: Array<{ path: string; error: string }> };
}

export class ArchiveError extends Error {
	constructor(public readonly code: "no-bobbit-dir" | "empty-bobbit-dir" | "bad-path", message: string) {
		super(message);
		this.name = "ArchiveError";
	}
}

/**
 * Match a single relative path against an allowlist entry.
 * - "state/foo"   → exact match
 * - "state/foo/"  → entry is preserved-dir AND relPath is the dir itself OR
 *                   strictly under it
 * - "state/foo-*" → relPath's basename starts with "foo-" and parent matches
 */
function matchesAllowlistEntry(relPath: string, entry: string): { match: boolean; isDirRoot: boolean } {
	const norm = relPath.replace(/\\/g, "/");
	if (entry.endsWith("/")) {
		const dir = entry.slice(0, -1);
		if (norm === dir) return { match: true, isDirRoot: true };
		if (norm.startsWith(dir + "/")) return { match: true, isDirRoot: false };
		return { match: false, isDirRoot: false };
	}
	if (entry.includes("*")) {
		// Single-segment wildcard at the tail, e.g. "state/model-name-*"
		const star = entry.indexOf("*");
		const prefix = entry.slice(0, star);
		const suffix = entry.slice(star + 1);
		if (norm.startsWith(prefix) && norm.endsWith(suffix) && !norm.slice(prefix.length).includes("/")) {
			return { match: true, isDirRoot: false };
		}
		return { match: false, isDirRoot: false };
	}
	return { match: norm === entry, isDirRoot: false };
}

/**
 * Returns true if `relPath` is preserved by the allowlist.
 * Used while walking — caller short-circuits recursion for matched dirs.
 */
export function isPreserved(relPath: string, allowlist: readonly string[]): { preserved: boolean; isDirRoot: boolean } {
	for (const entry of allowlist) {
		const { match, isDirRoot } = matchesAllowlistEntry(relPath, entry);
		if (match) return { preserved: true, isDirRoot };
	}
	return { preserved: false, isDirRoot: false };
}

/**
 * Compute the next free `.bobbit-archive-NNN` suffix (zero-padded, 3-digit,
 * starting at 001).
 */
function nextArchiveSuffix(rootPath: string): string {
	const re = /^\.bobbit-archive-(\d{3})$/;
	let highest = 0;
	try {
		for (const entry of fs.readdirSync(rootPath)) {
			const m = entry.match(re);
			if (m) {
				const n = parseInt(m[1], 10);
				if (n > highest) highest = n;
			}
		}
	} catch { /* dir missing — fine, we'll start at 001 */ }
	return String(highest + 1).padStart(3, "0");
}

/** Recursive move with EXDEV fallback (copy + unlink). */
function moveEntry(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	try {
		fs.renameSync(src, dst);
		return;
	} catch (err: any) {
		if (err?.code !== "EXDEV" && err?.code !== "EPERM") throw err;
		// Cross-volume (EXDEV) or Windows EPERM on rename across drives —
		// fall back to recursive copy + remove.
		copyRecursive(src, dst);
		fs.rmSync(src, { recursive: true, force: true });
	}
}

function copyRecursive(src: string, dst: string): void {
	const st = fs.lstatSync(src);
	if (st.isDirectory()) {
		fs.mkdirSync(dst, { recursive: true });
		for (const child of fs.readdirSync(src)) {
			copyRecursive(path.join(src, child), path.join(dst, child));
		}
	} else if (st.isSymbolicLink()) {
		const target = fs.readlinkSync(src);
		try { fs.symlinkSync(target, dst); }
		catch { fs.copyFileSync(src, dst); }
	} else {
		fs.copyFileSync(src, dst);
	}
}

/**
 * Archive the project-scoped contents of `<rootPath>/.bobbit/` to a fresh
 * `<rootPath>/.bobbit-archive-NNN/` directory. Skips entries that match
 * `GATEWAY_OWNED_FILES` when `gatewayOwned` is true.
 *
 * Throws `ArchiveError` for caller-recoverable problems:
 *   - "bad-path"        rootPath missing / not a directory
 *   - "no-bobbit-dir"   `<rootPath>/.bobbit/` does not exist
 *   - "empty-bobbit-dir" `<rootPath>/.bobbit/` exists but contains nothing
 *
 * Partial per-entry failures are NOT raised — they are surfaced via
 * `result.partial.failed` and the manifest. We do not roll back.
 */
export function archiveProjectBobbitDir(
	rootPath: string,
	opts: { gatewayOwned: boolean; allowlist?: readonly string[] },
): ArchiveResult {
	if (!path.isAbsolute(rootPath)) {
		throw new ArchiveError("bad-path", `rootPath must be absolute, got: ${rootPath}`);
	}
	if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
		throw new ArchiveError("bad-path", `rootPath is not an existing directory: ${rootPath}`);
	}
	const bobbitDir = path.join(rootPath, ".bobbit");
	if (!fs.existsSync(bobbitDir)) {
		throw new ArchiveError("no-bobbit-dir", `${bobbitDir} does not exist`);
	}
	// Check it has SOMETHING (config/state may exist but be empty)
	const topEntries = fs.readdirSync(bobbitDir);
	if (topEntries.length === 0) {
		throw new ArchiveError("empty-bobbit-dir", `${bobbitDir} is empty`);
	}
	// Treat empty-config + empty-state as also empty
	let totalChildren = 0;
	for (const top of topEntries) {
		const topPath = path.join(bobbitDir, top);
		try {
			const st = fs.statSync(topPath);
			if (st.isDirectory()) {
				totalChildren += fs.readdirSync(topPath).length;
			} else {
				totalChildren++;
			}
		} catch { /* ignore */ }
	}
	if (totalChildren === 0) {
		throw new ArchiveError("empty-bobbit-dir", `${bobbitDir} contains only empty subdirs`);
	}

	const allowlist = opts.allowlist ?? (opts.gatewayOwned ? GATEWAY_OWNED_FILES : []);
	const archivedAt = new Date().toISOString();
	const suffix = nextArchiveSuffix(rootPath);
	const archiveDir = path.join(rootPath, `.bobbit-archive-${suffix}`);
	fs.mkdirSync(archiveDir, { recursive: true });

	const moved: string[] = [];
	const preserved: string[] = [];
	const failed: Array<{ path: string; error: string }> = [];

	// BFS walk under .bobbit/. Queue holds entries to consider.
	// Each entry is an absolute path with its relative-to-.bobbit form.
	const queue: Array<{ abs: string; rel: string }> = [];
	for (const top of topEntries) {
		queue.push({ abs: path.join(bobbitDir, top), rel: top });
	}

	while (queue.length > 0) {
		const { abs, rel } = queue.shift()!;
		// Compute the canonical "state/..." / "config/..." form for matching.
		const relForMatch = rel.replace(/\\/g, "/");
		const { preserved: isPres, isDirRoot } = isPreserved(relForMatch, allowlist);
		if (isPres) {
			preserved.push(relForMatch);
			// Whether file or dir-root: do not recurse; do not move.
			continue;
		}
		// Determine if this is a directory we should descend into.
		let isDir = false;
		try {
			isDir = fs.lstatSync(abs).isDirectory();
		} catch (err: any) {
			failed.push({ path: relForMatch, error: err?.message ?? String(err) });
			continue;
		}

		if (isDir) {
			// Check if ANY descendant is preserved. If so, recurse.
			// If not, we can move the whole directory in one shot.
			if (containsPreservedDescendant(relForMatch, allowlist)) {
				let children: string[] = [];
				try { children = fs.readdirSync(abs); }
				catch (err: any) {
					failed.push({ path: relForMatch, error: err?.message ?? String(err) });
					continue;
				}
				for (const c of children) {
					queue.push({ abs: path.join(abs, c), rel: path.join(rel, c) });
				}
				continue;
			}
			// No preserved descendants — move the whole dir.
			try {
				moveEntry(abs, path.join(archiveDir, rel));
				moved.push(relForMatch);
			} catch (err: any) {
				failed.push({ path: relForMatch, error: err?.message ?? String(err) });
			}
			continue;
		}
		// Plain file / symlink — move it.
		try {
			moveEntry(abs, path.join(archiveDir, rel));
			moved.push(relForMatch);
		} catch (err: any) {
			failed.push({ path: relForMatch, error: err?.message ?? String(err) });
		}
		// Note: ignore that isDirRoot is unused for non-preserved entries.
		void isDirRoot;
	}

	// Re-scaffold empty .bobbit/config and .bobbit/state if missing.
	try { fs.mkdirSync(path.join(bobbitDir, "config"), { recursive: true }); } catch { /* ignore */ }
	try { fs.mkdirSync(path.join(bobbitDir, "state"), { recursive: true }); } catch { /* ignore */ }

	const result: ArchiveResult = {
		archiveDir,
		archivedAt,
		movedPaths: moved.sort(),
		preservedPaths: preserved.sort(),
		gatewayOwned: opts.gatewayOwned,
		...(failed.length > 0 ? { partial: { failed } } : {}),
	};

	// Write MANIFEST.json for manual undo audit.
	try {
		fs.writeFileSync(
			path.join(archiveDir, "MANIFEST.json"),
			JSON.stringify(result, null, 2),
			"utf-8",
		);
	} catch { /* manifest failure is non-fatal */ }

	return result;
}

/**
 * Does any allowlist entry preserve something strictly under `relDir`?
 * If yes, we must recurse rather than move-as-unit.
 */
function containsPreservedDescendant(relDir: string, allowlist: readonly string[]): boolean {
	const dirWithSlash = relDir.endsWith("/") ? relDir : relDir + "/";
	for (const entry of allowlist) {
		const stripStar = entry.replace(/\*$/, "");
		const stripTrail = stripStar.endsWith("/") ? stripStar : stripStar;
		if (stripTrail.startsWith(dirWithSlash)) return true;
	}
	return false;
}
