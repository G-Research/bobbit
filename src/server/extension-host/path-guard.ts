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
 * arbitrary host files. We therefore require both that the candidate's spelling
 * is contained by either the lexical or canonical root (to preserve macOS
 * `/var` → `/private/var` aliases) and that its `realpath` remains under the
 * root's `realpath`. The spelling check prevents a mutable symlink located
 * outside the pack from being accepted merely because it currently targets an
 * in-pack file.
 *
 * ENOENT on the target is TOLERATED (returns true): a missing file is not a
 * disclosure, and every caller has an existing not-found path (a `readFileSync`
 * catch → 404, or a `statSync` catch → null). Any OTHER realpath error
 * (EACCES, ELOOP, a missing/unusable root, …) is treated as unsafe.
 *
 * @returns true when `fileAbs` is safe to read/import, false when it escapes.
 */
function isStrictlyContained(rootAbs: string, candidateAbs: string): boolean {
	const relative = path.relative(rootAbs, candidateAbs);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function isPackPathWithinRoot(rootAbs: string, fileAbs: string): boolean {
	let rootReal: string;
	try {
		rootReal = fs.realpathSync(rootAbs);
	} catch {
		// Cannot prove containment when the pack root itself is unresolvable.
		return false;
	}

	// A file may use either the root's lexical spelling or its canonical spelling:
	// on macOS $TMPDIR can be /var/... while realpath resolves /private/var/....
	// Do not accept a file merely because the file it currently resolves to is
	// in-root: an outside symlink can be swapped after this check.
	const spellingContained = isStrictlyContained(rootAbs, fileAbs) || isStrictlyContained(rootReal, fileAbs);
	if (!spellingContained) return false;

	// Resolve the target after its spelling has been proven safe, then reject an
	// in-root symlink that resolves outside the pack.
	let fileReal: string;
	try {
		fileReal = fs.realpathSync(fileAbs);
	} catch (err: any) {
		// Missing target is safe only after the lexical/canonical spelling check;
		// callers retain their existing not-found handling.
		if (err && err.code === "ENOENT") return true;
		return false;
	}
	return isStrictlyContained(rootReal, fileReal);
}
