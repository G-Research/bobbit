import fs from "node:fs";
import path from "node:path";

export interface LanguageEvidence {
	globs: readonly string[];
	markers?: readonly string[];
	minFiles?: number;
}

export interface AstCapability {
	supported: true;
	grammar: string;
}

/**
 * The Code Intelligence language catalogue is the sole grammar source. AST
 * capability deliberately stands alone; the dependent LSP slice may add its
 * own capability data to these stable language records.
 */
export interface CodeIntelligenceLanguage {
	id: string;
	label: string;
	evidence: LanguageEvidence;
	ast: AstCapability;
}

export const CODE_INTELLIGENCE_LANGUAGE_MATRIX = [
	{ id: "bash", label: "Bash", evidence: { globs: ["**/*.sh", "**/*.bash", "**/*.zsh"] }, ast: { supported: true, grammar: "Bash" } },
	{ id: "c", label: "C", evidence: { globs: ["**/*.c", "**/*.h"] }, ast: { supported: true, grammar: "C" } },
	{ id: "cpp", label: "C++", evidence: { globs: ["**/*.cc", "**/*.cp", "**/*.cpp", "**/*.cxx", "**/*.c++", "**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx", "**/*.h++"] }, ast: { supported: true, grammar: "Cpp" } },
	{ id: "csharp", label: "C#", evidence: { globs: ["**/*.cs"] }, ast: { supported: true, grammar: "CSharp" } },
	{ id: "css", label: "CSS", evidence: { globs: ["**/*.css"] }, ast: { supported: true, grammar: "Css" } },
	{ id: "elixir", label: "Elixir", evidence: { globs: ["**/*.ex", "**/*.exs"] }, ast: { supported: true, grammar: "Elixir" } },
	{ id: "go", label: "Go", evidence: { globs: ["**/*.go"] }, ast: { supported: true, grammar: "Go" } },
	{ id: "haskell", label: "Haskell", evidence: { globs: ["**/*.hs", "**/*.lhs"] }, ast: { supported: true, grammar: "Haskell" } },
	{ id: "hcl", label: "HCL", evidence: { globs: ["**/*.hcl", "**/*.tf", "**/*.tfvars"] }, ast: { supported: true, grammar: "Hcl" } },
	{ id: "html", label: "HTML", evidence: { globs: ["**/*.html", "**/*.htm"] }, ast: { supported: true, grammar: "Html" } },
	{ id: "java", label: "Java", evidence: { globs: ["**/*.java"] }, ast: { supported: true, grammar: "Java" } },
	{ id: "javascript", label: "JavaScript", evidence: { globs: ["**/*.js", "**/*.cjs", "**/*.mjs", "**/*.jsx"] }, ast: { supported: true, grammar: "JavaScript" } },
	{ id: "json", label: "JSON", evidence: { globs: ["**/*.json", "**/*.jsonc"] }, ast: { supported: true, grammar: "Json" } },
	{ id: "kotlin", label: "Kotlin", evidence: { globs: ["**/*.kt", "**/*.kts"] }, ast: { supported: true, grammar: "Kotlin" } },
	{ id: "lua", label: "Lua", evidence: { globs: ["**/*.lua"] }, ast: { supported: true, grammar: "Lua" } },
	{ id: "nix", label: "Nix", evidence: { globs: ["**/*.nix"] }, ast: { supported: true, grammar: "Nix" } },
	{ id: "php", label: "PHP", evidence: { globs: ["**/*.php"] }, ast: { supported: true, grammar: "Php" } },
	{ id: "python", label: "Python", evidence: { globs: ["**/*.py", "**/*.pyi"] }, ast: { supported: true, grammar: "Python" } },
	{ id: "ruby", label: "Ruby", evidence: { globs: ["**/*.rb", "**/*.rake", "**/*.gemspec"] }, ast: { supported: true, grammar: "Ruby" } },
	{ id: "rust", label: "Rust", evidence: { globs: ["**/*.rs"] }, ast: { supported: true, grammar: "Rust" } },
	{ id: "scala", label: "Scala", evidence: { globs: ["**/*.scala", "**/*.sc"] }, ast: { supported: true, grammar: "Scala" } },
	{ id: "solidity", label: "Solidity", evidence: { globs: ["**/*.sol"] }, ast: { supported: true, grammar: "Solidity" } },
	{ id: "swift", label: "Swift", evidence: { globs: ["**/*.swift"] }, ast: { supported: true, grammar: "Swift" } },
	{ id: "typescript", label: "TypeScript", evidence: { globs: ["**/*.ts", "**/*.cts", "**/*.mts"] }, ast: { supported: true, grammar: "TypeScript" } },
	{ id: "tsx", label: "TSX", evidence: { globs: ["**/*.tsx"] }, ast: { supported: true, grammar: "Tsx" } },
	{ id: "yaml", label: "YAML", evidence: { globs: ["**/*.yaml", "**/*.yml"] }, ast: { supported: true, grammar: "Yaml" } },
] as const satisfies readonly CodeIntelligenceLanguage[];

export type AstGrepLanguageAlias = (typeof CODE_INTELLIGENCE_LANGUAGE_MATRIX)[number]["id"];
export type AstGrepLanguage = (typeof CODE_INTELLIGENCE_LANGUAGE_MATRIX)[number];

const ignoredDirectories = new Set([
	".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".next", ".cache", "vendor",
]);
const MAX_SCANNED_ENTRIES = 10_000;

export function normalizeAstGrepLanguage(value: string): AstGrepLanguage | undefined {
	const id = value.trim().toLowerCase();
	return CODE_INTELLIGENCE_LANGUAGE_MATRIX.find((language) => language.id === id);
}

/** Derive aliases from canonical evidence globs; no parallel extension map. */
export function languagesForExtension(extension: string): readonly AstGrepLanguageAlias[] {
	const normalized = extension.toLowerCase();
	return CODE_INTELLIGENCE_LANGUAGE_MATRIX
		.filter((language) => language.evidence.globs.some((glob) => path.extname(glob).toLowerCase() === normalized))
		.map((language) => language.id);
}

export interface LanguageDetectorFs {
	lstatSync: typeof fs.lstatSync;
	readdirSync: typeof fs.readdirSync;
}

/** Bounded, symlink-safe structural-language discovery. */
export function detectAstGrepLanguages(
	roots: readonly string[],
	seams: LanguageDetectorFs = fs,
): AstGrepLanguageAlias[] {
	const found = new Set<AstGrepLanguageAlias>();
	const pending = [...roots];
	let scanned = 0;
	while (pending.length > 0 && scanned < MAX_SCANNED_ENTRIES) {
		const current = pending.pop()!;
		let stat: fs.Stats;
		try { stat = seams.lstatSync(current); } catch { continue; }
		if (stat.isSymbolicLink()) continue;
		if (stat.isFile()) {
			for (const alias of languagesForExtension(path.extname(current))) found.add(alias);
			continue;
		}
		if (!stat.isDirectory()) continue;
		let entries: fs.Dirent[];
		try { entries = seams.readdirSync(current, { withFileTypes: true }) as fs.Dirent[]; } catch { continue; }
		for (const entry of entries) {
			if (scanned++ >= MAX_SCANNED_ENTRIES) break;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
			pending.push(path.join(current, entry.name));
		}
	}
	return [...found].sort() as AstGrepLanguageAlias[];
}
