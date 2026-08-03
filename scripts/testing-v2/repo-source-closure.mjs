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

export function resolveBundledSource(specifier, importer, repoRoot) {
	if (!specifier.startsWith(".")) return undefined;
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
	for (const candidate of candidates) {
		const repoRelative = relative(repoRoot, candidate);
		if (repoRelative.startsWith("..") || isAbsolute(repoRelative)) continue;
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
	const runtimeEntry = join(absoluteRepoRoot, "tests2", "harness", "server-runtime-entry.ts");
	return bundledRepoSourceFiles(absoluteRepoRoot, [runtimeEntry]);
}
