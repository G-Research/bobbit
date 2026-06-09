import fs from "node:fs";
import path from "node:path";

/**
 * Validate that a pack-supplied target path stays within its group root, both
 * LEXICALLY and after symlink resolution (realpath) — the single source of truth
 * for the four pack-path resolution sites (renderer + panel asset endpoints in
 * `server.ts`; `resolveModulePath` in the action + route dispatchers).
 *
 * The lexical `path.relative` check alone is insufficient: an entry that is
 * lexically inside its group dir but is a SYMLINK pointing outside the pack would
 * be followed by `fs.readFileSync` / dynamic `import`, disclosing (or importing)
 * arbitrary host files. We therefore also `fs.realpathSync` BOTH the group root
 * and the target, and require the target's realpath to remain under the group
 * root's realpath. The lexical check is kept as cheap defense-in-depth.
 *
 * ENOENT on the target is TOLERATED (returns true): a missing file is not a
 * disclosure, and every caller has an existing not-found path (a `readFileSync`
 * catch → 404, or a `statSync` catch → null). Any OTHER realpath error
 * (EACCES, ELOOP, a missing/unsable group root, …) is treated as unsafe.
 *
 * @returns true when `fileAbs` is safe to read/import, false when it escapes.
 */
export function isPackPathWithinGroup(groupAbs: string, fileAbs: string): boolean {
	// 1. Lexical check (defense in depth): fileAbs must be inside groupAbs.
	const rel = path.relative(groupAbs, fileAbs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;

	// 2. Realpath check: resolve symlinks on BOTH paths and require the target's
	//    realpath to stay under the group root's realpath (rejects symlink escape).
	let groupReal: string;
	try {
		groupReal = fs.realpathSync(groupAbs);
	} catch {
		// Cannot prove containment when the group root itself is unresolvable.
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
	const realRel = path.relative(groupReal, fileReal);
	if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) return false;
	return true;
}
