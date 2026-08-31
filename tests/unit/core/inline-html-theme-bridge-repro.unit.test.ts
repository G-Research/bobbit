import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";

const REPO_ROOT = path.resolve(".");
const RENDERER_PATH = path.join(REPO_ROOT, "src/ui/tools/renderers/HtmlRenderer.ts");
const THEME_BRIDGE_PATH = path.join(REPO_ROOT, "src/shared/preview-bridge-scripts.ts");
const FAILURE_MARKER = "INLINE_HTML_THEME_BRIDGE_MISSING";

function resolveSourceImport(importer: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const unresolved = path.resolve(path.dirname(importer), specifier);
	const withoutJsExtension = unresolved.replace(/\.js$/, "");
	const candidates = [
		unresolved,
		`${unresolved}.ts`,
		`${withoutJsExtension}.ts`,
		path.join(unresolved, "index.ts"),
		path.join(withoutJsExtension, "index.ts"),
	];
	return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** Follow static relative imports exactly as Vite does for the renderer bundle. */
function collectStaticImportGraph(entry: string): Set<string> {
	const visited = new Set<string>();
	const pending = [entry];
	const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

	while (pending.length > 0) {
		const file = path.normalize(pending.pop()!);
		if (visited.has(file)) continue;
		visited.add(file);

		const source = fs.readFileSync(file, "utf8");
		for (const match of source.matchAll(importPattern)) {
			const resolved = resolveSourceImport(file, match[1]);
			if (resolved && !visited.has(path.normalize(resolved))) pending.push(resolved);
		}
	}

	return visited;
}

describe("inline HtmlRenderer theme bridge reproducer", () => {
	it("injects the canonical bridge into completed srcdoc and streaming document.write payloads", () => {
		const source = fs.readFileSync(RENDERER_PATH, "utf8");
		const graph = collectStaticImportGraph(RENDERER_PATH);
		const completedBinding = source.match(/\.srcdoc\s*=\s*\$\{\s*([^}\n]+?)\s*\}/)?.[1].trim();
		const streamingWrite = source.match(/\bdoc\.write\(\s*([^);\n]+(?:\([^);\n]*\))?)\s*\)/)?.[1].trim();
		const missing: string[] = [];

		if (!graph.has(path.normalize(THEME_BRIDGE_PATH))) {
			missing.push("PREVIEW_THEME_BRIDGE is absent from HtmlRenderer's static Vite import graph");
		}
		if (!completedBinding || completedBinding === "htmlContent") {
			missing.push("completed .srcdoc still receives raw htmlContent");
		}
		if (!streamingWrite || streamingWrite === "content") {
			missing.push("streaming document.write still receives raw content");
		}

		assert.deepEqual(
			missing,
			[],
			`${FAILURE_MARKER}: ${missing.join("; ")}`,
		);
	});
});
