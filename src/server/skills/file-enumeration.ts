/**
 * Bounded directory enumeration backing `GET /api/file-mentions` (design §3).
 *
 * Walks the tree under `cwd` and returns relative (forward-slash) paths for
 * autocomplete. **Includes gitignored/untracked files** — we intentionally do
 * NOT consult `.gitignore`. A short, documented exclusion list keeps obvious
 * noise (`.git`, `node_modules`, build output) out of the results.
 *
 * Hard caps keep large trees from blocking the event loop:
 *   - `walkCap`   — max directory entries visited (default ~20k).
 *   - `resultCap` — max files returned after filtering (`limit`, default 500,
 *                   clamped to 1000). The walk stops early once this is hit.
 *
 * Filtering: case-insensitive substring match on the relative path. Ranking
 * promotes basename matches (exact > prefix > substring) ahead of path-only
 * matches, then shorter paths, then lexicographic — no fuzzy library.
 *
 * Pure aside from reading the directory tree; unit-testable with a `file://`
 * fixture tree.
 */

import fs from "node:fs";
import path from "node:path";

/** Directory names excluded from the walk. Kept short and documented. */
const EXCLUDED_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	".bobbit",
	".next",
	"coverage",
	"build",
]);

export const DEFAULT_RESULT_CAP = 500;
export const MAX_RESULT_CAP = 1000;
export const DEFAULT_WALK_CAP = 20_000;

export interface EnumerateFilesOptions {
	/** Case-insensitive substring query on the relative path. */
	query?: string;
	/** Max files returned after filtering (clamped to {@link MAX_RESULT_CAP}). */
	limit?: number;
	/** Max directory entries visited before the walk stops. */
	walkCap?: number;
}

/**
 * Enumerate files under `cwd`. Returns relative forward-slash paths, ranked
 * and bounded. Never throws — unreadable directories are skipped. Async so the
 * directory walk never blocks the HTTP event loop on large/slow trees.
 */
export async function enumerateFiles(cwd: string, opts?: EnumerateFilesOptions): Promise<string[]> {
	const query = (opts?.query ?? "").trim().toLowerCase();
	const resultCap = Math.max(1, Math.min(opts?.limit ?? DEFAULT_RESULT_CAP, MAX_RESULT_CAP));
	const walkCap = opts?.walkCap ?? DEFAULT_WALK_CAP;

	const matches: string[] = [];
	let visited = 0;

	// Iterative BFS to avoid deep recursion on large trees.
	const queue: string[] = [cwd];
	walk: while (queue.length > 0) {
		const dir = queue.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue; // unreadable dir — skip
		}
		for (const entry of entries) {
			if (++visited > walkCap) break walk;
			if (entry.isSymbolicLink()) continue; // avoid symlink loops / escapes
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry.name)) continue;
				queue.push(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			const rel = path.relative(cwd, abs).replace(/\\/g, "/");
			if (query && !rel.toLowerCase().includes(query)) continue;
			matches.push(rel);
			// Collect more than the cap when filtering so ranking can pick the
			// best; bound the buffer to avoid unbounded growth on huge trees.
			if (!query && matches.length >= resultCap) break walk;
			if (matches.length >= resultCap * 4) break walk;
		}
	}

	if (query) rankMatches(matches, query);
	else matches.sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));

	return matches.slice(0, resultCap);
}

/** Rank matches: basename exact > basename prefix > basename substring > path-only. */
function rankMatches(matches: string[], query: string): void {
	const score = (rel: string): number => {
		const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
		if (base === query) return 0;
		if (base.startsWith(query)) return 1;
		if (base.includes(query)) return 2;
		return 3; // matched only elsewhere in the path
	};
	matches.sort((a, b) => {
		const sa = score(a);
		const sb = score(b);
		if (sa !== sb) return sa - sb;
		if (a.length !== b.length) return a.length - b.length;
		return a < b ? -1 : a > b ? 1 : 0;
	});
}
