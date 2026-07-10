// v2-native — Pi runtime browser boundary canary. Listed in tests-map.json `v2Native`.
//
// Pi 0.80 exposes browser-compatible runtime modules under
// `@earendil-works/pi-ai/api/*` for streamSimple and provider modules under
// `@earendil-works/pi-ai/providers/*`; legacy direct subpaths such as
// `@earendil-works/pi-ai/anthropic` are not package exports. Keep Bobbit's UI
// streaming boundary lazy, provider/API-specific, and away from the bare pi-ai
// runtime index.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lazyBoundaryPath = path.join(repoRoot, "src", "app", "pi-ai-lazy.ts");
const source = fs.readFileSync(lazyBoundaryPath, "utf-8");

function stripTypeOnlyImportExpressions(text: string): string {
	return text.replace(/\btypeof\s+import\s*\(\s*["'][^"']+["']\s*\)/g, "unknown");
}

function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function dynamicImports(text: string): string[] {
	const imports: string[] = [];
	const re = /\bimport\s*\(\s*["'](?<source>[^"']+)["']\s*\)/g;
	for (const match of stripTypeOnlyImportExpressions(stripComments(text)).matchAll(re)) {
		imports.push(match.groups?.source ?? "");
	}
	return imports;
}

function staticImports(text: string): Array<{ source: string; clause?: string }> {
	const imports: Array<{ source: string; clause?: string }> = [];
	const re = /\bimport\s+(?!\()(?<body>[\s\S]*?);/g;
	for (const match of stripComments(text).matchAll(re)) {
		const body = (match.groups?.body ?? "").trim();
		const sideEffect = body.match(/^["'](?<source>[^"']+)["']$/);
		if (sideEffect?.groups?.source) {
			imports.push({ source: sideEffect.groups.source });
			continue;
		}
		const fromImport = body.match(/^(?<clause>[\s\S]*?)\s+from\s+["'](?<source>[^"']+)["']$/);
		if (fromImport?.groups?.source) {
			imports.push({ source: fromImport.groups.source, clause: fromImport.groups.clause });
		}
	}
	return imports;
}

function isTypeOnlyImportClause(clause: string | undefined): boolean {
	if (!clause) return false;
	const trimmed = clause.trim();
	if (!trimmed || trimmed.startsWith("type ")) return true;
	const named = trimmed.match(/^\{([\s\S]*)\}$/);
	if (!named) return false;
	const specifiers = named[1].split(",").map((s) => s.trim()).filter(Boolean);
	return specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("type "));
}

describe("src/app/pi-ai-lazy.ts browser pi-ai boundary", () => {
	it("uses only Pi 0.80 package-exported api/provider subpaths for runtime streaming imports", () => {
		const runtimePiImports = dynamicImports(source).filter((specifier) => specifier.startsWith("@earendil-works/pi-ai"));
		expect(runtimePiImports.length, "expected API/provider-specific dynamic imports in streamSimplePiAi").toBeGreaterThan(0);

		const offenders = runtimePiImports.filter(
			(specifier) => !specifier.startsWith("@earendil-works/pi-ai/api/") && !specifier.startsWith("@earendil-works/pi-ai/providers/"),
		);
		expect(
			offenders,
			[
				"Browser runtime imports from pi-ai must use package-exported api/provider subpaths.",
				"Pi 0.80 exports ./api/* and ./providers/*, not legacy direct subpaths like @earendil-works/pi-ai/anthropic.",
				...offenders.map((specifier) => `  - ${specifier}`),
			].join("\n"),
		).toEqual([]);
	});

	it("does not introduce a bare pi-ai runtime value import while updating api/provider subpaths", () => {
		const offenders: string[] = [];
		for (const imp of staticImports(source)) {
			if (imp.source === "@earendil-works/pi-ai" && !isTypeOnlyImportClause(imp.clause)) {
				offenders.push(`static value import from ${imp.source}`);
			}
		}
		for (const specifier of dynamicImports(source)) {
			if (specifier === "@earendil-works/pi-ai") offenders.push(`dynamic import from ${specifier}`);
		}
		expect(offenders).toEqual([]);
	});
});
