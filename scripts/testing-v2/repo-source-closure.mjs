import { readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const BUNDLED_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const BUNDLED_IMPORT_RE = /(?:\b(?:import|export)\s+(?:[^"'`;]*?\s+from\s*)?|\brequire\s*\(|\bimport\s*\()\s*(["'`])([^"'`]+)\1/gms;

export function normalizeRepoSourcePath(file) {
	const withoutQuery = file.replace(/[?#].*$/, "");
	const normalized = withoutQuery.replace(/\\/g, "/")
		.replace(/^\/@fs\/(?=[A-Za-z]:\/)/, "")
		.replace(/^\/(?=[A-Za-z]:\/)/, "");
	return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function bundledSourceCandidates(specifier, importer) {
	if (!specifier.startsWith(".")) return [];
	const unresolved = resolve(dirname(importer), specifier.replace(/[?#].*$/, ""));
	const extension = extname(unresolved);
	const candidates = [unresolved];
	if (extension) {
		const stem = unresolved.slice(0, -extension.length);
		if (extension === ".js" || extension === ".jsx") candidates.push(`${stem}.ts`, `${stem}.tsx`);
		else if (extension === ".mjs") candidates.push(`${stem}.mts`);
		else if (extension === ".cjs") candidates.push(`${stem}.cts`);
	} else {
		for (const candidateExtension of BUNDLED_SOURCE_EXTENSIONS) candidates.push(`${unresolved}${candidateExtension}`);
		for (const candidateExtension of BUNDLED_SOURCE_EXTENSIONS) candidates.push(join(unresolved, `index${candidateExtension}`));
	}
	return candidates;
}

function isRepoSourceCandidate(repoRoot, candidate) {
	const repoRelative = relative(repoRoot, candidate);
	return !repoRelative.startsWith("..") && !isAbsolute(repoRelative);
}

export function resolveBundledSource(specifier, importer, repoRoot) {
	for (const candidate of bundledSourceCandidates(specifier, importer)) {
		if (!isRepoSourceCandidate(repoRoot, candidate)) continue;
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
		}
	}
	return undefined;
}

/**
 * Follow only repo-local imports that esbuild can bundle. Returned paths are
 * absolute and stable-sorted by repository-relative path.
 */
export function bundledRepoSourceFiles(repoRoot, roots) {
	const absoluteRepoRoot = resolve(repoRoot);
	const pending = roots.map((root) => resolve(absoluteRepoRoot, root));
	const discovered = new Map();
	while (pending.length > 0) {
		const file = pending.pop();
		const key = normalizeRepoSourcePath(relative(absoluteRepoRoot, file));
		if (discovered.has(key)) continue;
		discovered.set(key, file);
		if (extname(file) === ".json") continue;
		const source = readFileSync(file, "utf8");
		BUNDLED_IMPORT_RE.lastIndex = 0;
		for (const match of source.matchAll(BUNDLED_IMPORT_RE)) {
			const dependency = resolveBundledSource(match[2], file, absoluteRepoRoot);
			if (dependency) pending.push(dependency);
		}
	}
	return [...discovered.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, file]) => file);
}

/** Repository-source closure of the gateway runtime umbrella, and no other prebundle entries. */
export function serverRuntimeRepoSourceFiles(repoRoot) {
	const absoluteRepoRoot = resolve(repoRoot);
	const runtimeEntry = join(absoluteRepoRoot, "tests", "support", "harnesses", "shared", "server-runtime-entry.ts");
	return bundledRepoSourceFiles(absoluteRepoRoot, [runtimeEntry]);
}

/**
 * Repository-source closure executed while Vitest loads its configuration.
 *
 * Missing repo-local import candidates remain in the returned closure. That
 * lets changed-path classification and content fingerprinting fail closed when
 * a configured dependency is deleted instead of silently shrinking the
 * boundary before the change is inspected.
 */
export function vitestConfigRepoSourceFiles(repoRoot) {
	const absoluteRepoRoot = resolve(repoRoot);
	const configEntry = join(absoluteRepoRoot, "vitest.config.ts");
	let files;
	try {
		files = bundledRepoSourceFiles(absoluteRepoRoot, [configEntry]);
	} catch (error) {
		if (error?.code === "ENOENT" && resolve(error.path ?? "") === configEntry) return [configEntry];
		throw error;
	}

	const closure = new Map(files.map((file) => [
		normalizeRepoSourcePath(relative(absoluteRepoRoot, file)),
		file,
	]));
	for (const file of files) {
		if (extname(file) === ".json") continue;
		const source = readFileSync(file, "utf8");
		BUNDLED_IMPORT_RE.lastIndex = 0;
		for (const match of source.matchAll(BUNDLED_IMPORT_RE)) {
			if (resolveBundledSource(match[2], file, absoluteRepoRoot)) continue;
			for (const candidate of bundledSourceCandidates(match[2], file)) {
				if (!isRepoSourceCandidate(absoluteRepoRoot, candidate)) continue;
				const key = normalizeRepoSourcePath(relative(absoluteRepoRoot, candidate));
				if (!closure.has(key)) closure.set(key, candidate);
			}
		}
	}
	return [...closure.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, file]) => file);
}
