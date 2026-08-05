import fs from "node:fs";
import path from "node:path";

export const AST_GREP_LANGUAGES = [
	{ alias: "bash", cliLanguage: "Bash", extensions: [".sh", ".bash", ".zsh"], structuralSearch: true },
	{ alias: "c", cliLanguage: "C", extensions: [".c", ".h"], structuralSearch: true },
	{ alias: "cpp", cliLanguage: "Cpp", extensions: [".cc", ".cp", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++"], structuralSearch: true },
	{ alias: "csharp", cliLanguage: "CSharp", extensions: [".cs"], structuralSearch: true },
	{ alias: "css", cliLanguage: "Css", extensions: [".css"], structuralSearch: true },
	{ alias: "elixir", cliLanguage: "Elixir", extensions: [".ex", ".exs"], structuralSearch: true },
	{ alias: "go", cliLanguage: "Go", extensions: [".go"], structuralSearch: true },
	{ alias: "haskell", cliLanguage: "Haskell", extensions: [".hs", ".lhs"], structuralSearch: true },
	{ alias: "hcl", cliLanguage: "Hcl", extensions: [".hcl", ".tf", ".tfvars"], structuralSearch: true },
	{ alias: "html", cliLanguage: "Html", extensions: [".html", ".htm"], structuralSearch: true },
	{ alias: "java", cliLanguage: "Java", extensions: [".java"], structuralSearch: true },
	{ alias: "javascript", cliLanguage: "JavaScript", extensions: [".js", ".cjs", ".mjs", ".jsx"], structuralSearch: true },
	{ alias: "json", cliLanguage: "Json", extensions: [".json", ".jsonc"], structuralSearch: true },
	{ alias: "kotlin", cliLanguage: "Kotlin", extensions: [".kt", ".kts"], structuralSearch: true },
	{ alias: "lua", cliLanguage: "Lua", extensions: [".lua"], structuralSearch: true },
	{ alias: "nix", cliLanguage: "Nix", extensions: [".nix"], structuralSearch: true },
	{ alias: "php", cliLanguage: "Php", extensions: [".php"], structuralSearch: true },
	{ alias: "python", cliLanguage: "Python", extensions: [".py", ".pyi"], structuralSearch: true },
	{ alias: "ruby", cliLanguage: "Ruby", extensions: [".rb", ".rake", ".gemspec"], structuralSearch: true },
	{ alias: "rust", cliLanguage: "Rust", extensions: [".rs"], structuralSearch: true },
	{ alias: "scala", cliLanguage: "Scala", extensions: [".scala", ".sc"], structuralSearch: true },
	{ alias: "solidity", cliLanguage: "Solidity", extensions: [".sol"], structuralSearch: true },
	{ alias: "swift", cliLanguage: "Swift", extensions: [".swift"], structuralSearch: true },
	{ alias: "typescript", cliLanguage: "TypeScript", extensions: [".ts", ".cts", ".mts"], structuralSearch: true },
	{ alias: "tsx", cliLanguage: "Tsx", extensions: [".tsx"], structuralSearch: true },
	{ alias: "yaml", cliLanguage: "Yaml", extensions: [".yaml", ".yml"], structuralSearch: true },
] as const;

export type AstGrepLanguageAlias = (typeof AST_GREP_LANGUAGES)[number]["alias"];
export type AstGrepLanguage = (typeof AST_GREP_LANGUAGES)[number];

const ignoredDirectories = new Set([
	".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".next", ".cache", "vendor",
]);
const MAX_SCANNED_ENTRIES = 10_000;

const byAlias = new Map<string, AstGrepLanguage>(AST_GREP_LANGUAGES.map((language) => [language.alias, language]));
const byExtension = new Map<string, AstGrepLanguageAlias[]>();
for (const language of AST_GREP_LANGUAGES) {
	for (const extension of language.extensions) {
		const aliases = byExtension.get(extension) ?? [];
		aliases.push(language.alias);
		byExtension.set(extension, aliases);
	}
}

export function normalizeAstGrepLanguage(value: string): AstGrepLanguage | undefined {
	return byAlias.get(value.trim().toLowerCase());
}

export function languagesForExtension(extension: string): readonly AstGrepLanguageAlias[] {
	return byExtension.get(extension.toLowerCase()) ?? [];
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
