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

export interface HealDependenciesDeps {
	exec: (argv: string[], cwd: string) => void;
	log?: (msg: string) => void;
}

export interface HealResult {
	beforeMissing: string[];
	afterMissing: string[];
	restored: string[];
	stillMissing: string[];
	regressed: string[];
	lockedFile?: string;
}

export class DependencyHealError extends Error {
	constructor(message: string, public readonly result: HealResult, public readonly cause?: unknown) {
		super(message);
		this.name = "DependencyHealError";
	}
}

function errorText(err: unknown): string {
	if (!err) return "";
	const parts: string[] = [];
	if (err instanceof Error) parts.push(err.message);
	if (typeof err === "object") {
		const record = err as Record<string, unknown>;
		for (const key of ["stderr", "stdout"]) {
			const value = record[key];
			if (Buffer.isBuffer(value)) parts.push(value.toString("utf-8"));
			else if (typeof value === "string") parts.push(value);
		}
		const output = record.output;
		if (Array.isArray(output)) {
			for (const value of output) {
				if (Buffer.isBuffer(value)) parts.push(value.toString("utf-8"));
				else if (typeof value === "string") parts.push(value);
			}
		}
	}
	return parts.filter(Boolean).join("\n");
}

export function extractNpmLockedFile(err: unknown): string | undefined {
	if (err && typeof err === "object") {
		const maybePath = (err as { path?: unknown }).path;
		if (typeof maybePath === "string" && maybePath.trim()) return maybePath.trim();
	}

	const text = errorText(err);
	const pathLine = text.match(/(?:^|\n)\s*npm\s+(?:ERR!|error)\s+path\s+(.+?)\s*(?:\n|$)/i);
	if (pathLine?.[1]) return pathLine[1].trim();
	const syscallLine = text.match(/(?:^|\n)\s*path\s*[:=]\s*(.+?)\s*(?:\n|$)/i);
	if (syscallLine?.[1]) return syscallLine[1].trim();
	return undefined;
}

function isBusyOrPermError(err: unknown): boolean {
	const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
	if (typeof code === "string" && /^(EBUSY|EPERM)$/i.test(code)) return true;
	return /\b(?:EBUSY|EPERM)\b/i.test(errorText(err));
}

function buildResult(beforeMissing: string[], afterMissing: string[], lockedFile?: string): HealResult {
	return {
		beforeMissing,
		afterMissing,
		restored: beforeMissing.filter((name) => !afterMissing.includes(name)),
		stillMissing: afterMissing.filter((name) => beforeMissing.includes(name)),
		regressed: afterMissing.filter((name) => !beforeMissing.includes(name)),
		lockedFile,
	};
}

function describeList(names: string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

/**
 * Testable dependency-repair seam for the dev harness.
 *
 * Runs only the injected safe repair command (`npm install` in production),
 * snapshots declared dependency presence before/after, and fails loud if repair
 * makes the tree worse. EBUSY/EPERM errors include npm's exact locked native
 * file path plus the stop-vite/gateway instruction.
 */
export function healDependencies(projectRoot: string, deps: HealDependenciesDeps): HealResult {
	const beforeMissing = missingDependencies(projectRoot);
	let execError: unknown;
	let lockedFile: string | undefined;

	deps.log?.(`[harness] dependency self-heal argv=npm install cwd=${projectRoot}`);
	try {
		deps.exec(["npm", "install"], projectRoot);
	} catch (err) {
		execError = err;
		if (isBusyOrPermError(err)) lockedFile = extractNpmLockedFile(err);
	}

	const afterMissing = missingDependencies(projectRoot);
	const result = buildResult(beforeMissing, afterMissing, lockedFile);

	if (result.regressed.length > 0 || execError) {
		const parts: string[] = ["Dependency self-heal failed."];
		if (result.regressed.length > 0) {
			parts.push(`Repair regressed declared dependencies that were present before repair: ${describeList(result.regressed)}.`);
		}
		if (lockedFile) {
			parts.push(`npm reported a locked native file: ${lockedFile}. Stop vite/gateway, then retry \`npm install\`.`);
		} else if (execError) {
			parts.push("The npm install repair command failed. Stop vite/gateway, then retry `npm install`.");
		}
		parts.push(`beforeMissing=${beforeMissing.length} afterMissing=${afterMissing.length}`);
		throw new DependencyHealError(parts.join(" "), result, execError);
	}

	return result;
}
