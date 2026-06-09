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

/**
 * WRITE/CREATE-SAFE containment — the variant the confined fs wrapper
 * (`module-host-bootstrap.ts`) uses for EVERY pack fs op (reads AND writes).
 *
 * `isPackPathWithinGroup` tolerates ENOENT on the FULL target (returns true) so a
 * not-found read/stat surfaces a normal 404 — correct for the HTTP entry-serving
 * callers, but a BYPASS for the fs grant: `workingDir/link -> /outside` then
 * `writeFile("link/x")` (or `readFile("link/x")` before `x` exists) has a
 * non-existent FULL target, so realpath ENOENTs and the lenient helper passes —
 * yet the write would land at `/outside/x` through the symlinked ancestor.
 *
 * This helper closes that hole WITHOUT touching the lenient helper's semantics
 * (other callers depend on ENOENT-true): instead of realpath-ing the full target,
 * it resolves the NEAREST EXISTING ANCESTOR via realpath (collapsing every symlink
 * in the existing prefix) and re-attaches the not-yet-existent remainder LEXICALLY,
 * then requires that reconstructed real target to stay under the group root's
 * realpath. So a symlinked ANCESTOR is resolved and rejected even when the leaf
 * does not exist; an ordinary deep create under a real in-bounds dir still passes.
 *
 * @returns true when `fileAbs` is safe to read/create/write, false when it escapes.
 */
export function isPackPathWithinGroupStrict(groupAbs: string, fileAbs: string): boolean {
	// 1. Lexical check (defense in depth): fileAbs must be inside groupAbs.
	const rel = path.relative(groupAbs, fileAbs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return false;

	// 2. Resolve the group root's realpath (containment is measured against it).
	let groupReal: string;
	try {
		groupReal = fs.realpathSync(groupAbs);
	} catch {
		return false; // cannot prove containment when the group root is unresolvable
	}

	// 3. Walk UP from the target to the nearest EXISTING ancestor, realpath it (so
	//    a symlinked ancestor is collapsed), then re-attach the non-existent
	//    remainder lexically. ENOENT/ENOTDIR on the target therefore does NOT
	//    blanket-pass — the realpath of the existing prefix is what we check.
	const segments: string[] = [];
	let cur = path.resolve(fileAbs);
	let nearestReal: string | undefined;
	for (let i = 0; i < 4096; i++) {
		try {
			nearestReal = fs.realpathSync(cur);
			break;
		} catch (err: any) {
			const code = err && err.code;
			// Only a missing path / non-dir ancestor is "keep walking up"; any other
			// realpath error (EACCES, ELOOP, …) is treated as unsafe.
			if (code !== "ENOENT" && code !== "ENOTDIR") return false;
			const parent = path.dirname(cur);
			if (parent === cur) return false; // reached filesystem root, nothing existed
			segments.unshift(path.basename(cur));
			cur = parent;
		}
	}
	if (nearestReal === undefined) return false;

	const targetReal = segments.length ? path.resolve(nearestReal, ...segments) : nearestReal;
	const realRel = path.relative(groupReal, targetReal);
	if (realRel === "" || realRel.startsWith("..") || path.isAbsolute(realRel)) return false;
	return true;
}
