// deterministic structural reproducer for gateway event-loop starvation.

/**
 * The session WebSocket handler authenticates synchronously, so it can only miss
 * its connection deadline when the gateway event loop is monopolized. Search used
 * to reach FlexSearch, document preparation, and persistence from SearchService
 * itself; a mutation-triggered full export could therefore starve auth.
 *
 * This guard deliberately tests module ownership rather than a machine-dependent
 * 15-second timeout. The main-thread SearchService dependency graph must be an
 * RPC client only: it launches a worker but cannot reach index construction,
 * document preparation, or the FlexSearch store. A dedicated search worker must
 * own the FlexSearch dependency and expose a MessagePort endpoint.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const MARKER = "SEARCH_MAIN_THREAD_STARVATION_REGRESSION";
const SEARCH_DIR = fileURLToPath(new URL("../../../src/server/search/", import.meta.url));
const SEARCH_SERVICE = join(SEARCH_DIR, "search-service.ts");

function searchSourceFiles(dir = SEARCH_DIR): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const entryPath = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...searchSourceFiles(entryPath));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
	}
	return files;
}

/** Resolve runtime relative imports only; `import type` does not run on Node's main thread. */
function runtimeRelativeImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const imports = source.matchAll(/^\s*import\s+(?!type\b)[\s\S]*?\sfrom\s+["'](\.[^"']+)["'];?/gm);
	const resolved: string[] = [];
	for (const match of imports) {
		const specifier = match[1];
		const imported = resolve(dirname(file), specifier);
		const tsPath = extname(imported) === ".js"
			? `${imported.slice(0, -3)}.ts`
			: `${imported}.ts`;
		if (existsSync(tsPath)) resolved.push(tsPath);
	}
	return resolved;
}

function runtimeDependencyClosure(entry: string): Set<string> {
	const seen = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const dependency of runtimeRelativeImports(file)) pending.push(dependency);
	}
	return seen;
}

function ownsFlexSearchWorker(searchFiles: readonly string[]): boolean {
	return searchFiles.some((file) => {
		const source = readFileSync(file, "utf8");
		if (!/\bparentPort\b/.test(source)) return false;
		return [...runtimeDependencyClosure(file)].some((dependency) => basename(dependency) === "flex-store.ts");
	});
}

describe("session-connect timeout reproducer — search worker ownership", () => {
	it("keeps FlexSearch work out of the gateway main-thread SearchService graph", () => {
		const serviceGraph = runtimeDependencyClosure(SEARCH_SERVICE);
		const mainThreadSearchWork = [...serviceGraph]
			.filter((file) => {
				const name = basename(file);
				return name === "flex-store.ts"
					|| name === "indexer.ts"
					|| name === "chunker.ts"
					|| name === "content-policy.ts"
					|| dirname(file).endsWith(`${join("search", "sources")}`);
			})
			.map((file) => relative(SEARCH_DIR, file));
		const serviceStartsWorker = [...serviceGraph]
			.some((file) => /\bnew\s+Worker\s*\(/.test(readFileSync(file, "utf8")));
		const searchFiles = searchSourceFiles();

		assert.ok(
			mainThreadSearchWork.length === 0 && serviceStartsWorker && ownsFlexSearchWorker(searchFiles),
			`${MARKER}: SearchService must be a worker-RPC client so search persistence cannot starve synchronous WebSocket auth; `
				+ `main-thread search modules=${mainThreadSearchWork.join(",") || "none"}, `
				+ `startsWorker=${serviceStartsWorker}, workerOwnsFlexSearch=${ownsFlexSearchWorker(searchFiles)}.`,
		);
	});
});
