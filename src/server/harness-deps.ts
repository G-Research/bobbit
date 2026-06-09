/**
 * Dev-harness dependency self-heal.
 *
 * Why this exists
 * ---------------
 * A running Bobbit dev stack (vite, and the gateway itself) loads native
 * `.node` addons into memory — e.g. `lightningcss.win32-x64-msvc.node`,
 * `@mariozechner/clipboard-*`, `photon-node`. On Windows you cannot `unlink`
 * a native module file while a live process has it loaded.
 *
 * So when a *destructive* npm operation runs while the stack is up
 * (`npm ci`, `npm install --force`, `npm audit fix --force`), npm wipes and
 * rewrites `node_modules`, removes additive deps as planned, then aborts with
 * `EPERM` the moment it tries to unlink the locked native binary. The result
 * is a half-wiped `node_modules` with core runtime packages (e.g.
 * `@earendil-works/pi-ai`) missing — and the gateway can no longer import
 * them, so the app stops functioning.
 *
 * The fix is a cheap, non-destructive self-heal on every server (re)start: we
 * verify each declared dependency is physically present and, only if some are
 * missing, run a plain additive `npm install` (which never pre-wipes the tree,
 * so it restores the missing packages around any locked native file). A
 * healthy tree skips the install entirely, keeping the common restart fast.
 *
 * See docs/dev-workflow.md ("node_modules gets wiped while the dev server is
 * running").
 */

import fs from "node:fs";
import path from "node:path";

interface PackageManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/**
 * Return the names of declared (prod + dev) dependencies that are NOT
 * physically present in `<projectRoot>/node_modules`.
 *
 * "Present" means the package's own `package.json` exists on disk — a bare
 * directory left behind by a partial wipe does not count. Returns an empty
 * array (and never throws) if the project manifest can't be read, so callers
 * can treat a result of `[]` as "nothing to heal".
 */
export function missingDependencies(projectRoot: string): string[] {
	let pkg: PackageManifest;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8")) as PackageManifest;
	} catch {
		return [];
	}

	const declared = [
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
	];

	return declared.filter(
		(name) => !fs.existsSync(path.join(projectRoot, "node_modules", name, "package.json")),
	);
}
