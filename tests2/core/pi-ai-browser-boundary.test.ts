// v2-native — Pi runtime browser boundary canary. Listed in tests-map.json `v2Native`.
//
// Pi 0.81.1 exposes browser-compatible runtime modules under
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
const browserFixtureRoot = path.join(repoRoot, "tests", "fixtures");

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

function walkTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkTsFiles(full));
		} else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

function rel(file: string): string {
	return path.relative(repoRoot, file).split(path.sep).join("/");
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

	it("resolves every lazy runtime module to a Pi 0.81.1 streamSimple export", async () => {
		const runtimePiImports = [...new Set(
			dynamicImports(source).filter((specifier) => specifier.startsWith("@earendil-works/pi-ai")),
		)];
		expect(runtimePiImports.length).toBeGreaterThan(0);

		for (const specifier of runtimePiImports) {
			// `import.meta.resolve` applies the package's ESM `import` export condition;
			// importing the resolved module then verifies that the browser boundary's
			// expected value export still exists in the selected Pi patch.
			const resolved = import.meta.resolve(specifier);
			const module = await import(resolved);
			expect(typeof module.streamSimple, `${specifier} must export streamSimple`).toBe("function");
		}
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

describe("browser fixture pi-ai boundary", () => {
	it("keeps bundled browser fixtures off the bare pi-ai runtime index", () => {
		const offenders: string[] = [];
		for (const file of walkTsFiles(browserFixtureRoot)) {
			const fixtureSource = fs.readFileSync(file, "utf-8");
			for (const imp of staticImports(fixtureSource)) {
				if (!imp.source.startsWith("@earendil-works/pi-ai")) continue;
				if (isTypeOnlyImportClause(imp.clause)) continue;
				if (imp.source === "@earendil-works/pi-ai") {
					offenders.push(`${rel(file)}: static value import from bare @earendil-works/pi-ai`);
				} else if (!imp.source.startsWith("@earendil-works/pi-ai/api/") && !imp.source.startsWith("@earendil-works/pi-ai/providers/")) {
					offenders.push(`${rel(file)}: static value import from unsupported pi-ai subpath ${imp.source}`);
				}
			}
			for (const specifier of dynamicImports(fixtureSource)) {
				if (!specifier.startsWith("@earendil-works/pi-ai")) continue;
				if (specifier === "@earendil-works/pi-ai") {
					offenders.push(`${rel(file)}: dynamic import from bare @earendil-works/pi-ai`);
				} else if (!specifier.startsWith("@earendil-works/pi-ai/api/") && !specifier.startsWith("@earendil-works/pi-ai/providers/")) {
					offenders.push(`${rel(file)}: dynamic import from unsupported pi-ai subpath ${specifier}`);
				}
			}
		}

		expect(
			offenders,
			[
				"Browser fixture runtime imports from pi-ai must use package-exported api/provider subpaths, never the bare runtime index.",
				...offenders,
			].join("\n"),
		).toEqual([]);
	});
});
