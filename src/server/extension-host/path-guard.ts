import fs from "node:fs";
import path from "node:path";

/**
 * Validate that a pack-supplied target path stays within the PACK ROOT, both
 * LEXICALLY and after symlink resolution (realpath) — the single source of truth
 * for the pack-path resolution sites (renderer + panel asset endpoints in
 * `server.ts`; `resolveModulePath` in the action + route dispatchers; the worker
 * confinement hook).
 *
 * Renamed from `isPackPathWithinGroup` (pack-schema-v1 §2.2): the containment
 * root is now the PACK ROOT (`market-packs/<name>`), not the group dir, so a
 * tool YAML may reference a shared `../../lib/X.js` module while still being
 * contained. The signature + behaviour are otherwise unchanged — only the
 * argument's MEANING (pack root vs group dir) changed.
 *
 * The lexical `path.relative` check alone is insufficient: an entry that is
 * lexically inside its root but is a SYMLINK pointing outside the pack would be
 * followed by `fs.readFileSync` / dynamic `import`, disclosing (or importing)
 * arbitrary host files. We therefore also `fs.realpathSync` BOTH the root and the
 * target, and require the target's realpath to remain under the root's realpath.
 * The lexical check is kept as cheap defense-in-depth.
 *
 * ENOENT on the target is TOLERATED (returns true): a missing file is not a
 * disclosure, and every caller has an existing not-found path (a `readFileSync`
 * catch → 404, or a `statSync` catch → null). Any OTHER realpath error
 * (EACCES, ELOOP, a missing/unusable root, …) is treated as unsafe.
 *
 * @returns true when `fileAbs` is safe to read/import, false when it escapes.
 */
export function isPackPathWithinRoot(rootAbs: string, fileAbs: string): boolean {
	// 1. Lexical check (defense in depth): fileAbs must be inside rootAbs.
	const rel = path.relative(rootAbs, fileAbs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;

	// 2. Realpath check: resolve symlinks on BOTH paths and require the target's
	//    realpath to stay under the pack root's realpath (rejects symlink escape).
	let rootReal: string;
	try {
		rootReal = fs.realpathSync(rootAbs);
	} catch {
		// Cannot prove containment when the pack root itself is unresolvable.
		return false;
	}
	let fileReal: string;
	try {
		fileReal = fs.realpathSync(fileAbs);
	} catch (err: any) {
		// Missing target: tolerate — the caller's read/stat surfaces not-found.
		if (err && err.code === "ENOENT") return true;
		return false;
	}
	const realRel = path.relative(rootReal, fileReal);
	if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) return false;
	return true;
}
