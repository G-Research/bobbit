import fs from "node:fs";
import path from "node:path";

export type LspAction =
	| "definition"
	| "references"
	| "hover"
	| "documentSymbols"
	| "workspaceSymbols"
	| "diagnostics";

export interface VersionConstraint {
	range: string;
	reason: string;
}

/** A visible, probe-only runtime prerequisite. It is never a command fragment. */
export interface ToolchainRequirement {
	id: string;
	label: string;
	version?: VersionConstraint;
	executable?: string;
	installHint: string;
}

/** A generic sandbox image layer declaration, not Dockerfile or shell text. */
export interface SandboxLayerRequirement extends ToolchainRequirement {
	layerId: string;
}

export interface LanguageEvidence {
	globs: readonly string[];
	rootMarkers: readonly string[];
	minimumFiles: number;
}

/**
 * Kept while the AST tool consumes `ast.grammar`. `structuralSearch` is the
 * public capability declaration; this compatibility view must agree with it.
 */
export interface AstCapability {
	supported: true;
	grammar: string;
}

export interface StructuralSearchCapability {
	state: "supported" | "unsupported";
	astGrepGrammar?: string;
}

export interface LspCapability {
	server: {
		id: string;
		command: string;
		args: readonly string[];
		version?: VersionConstraint;
	};
	rootMarkers: readonly string[];
	actions: readonly LspAction[];
	host: readonly ToolchainRequirement[];
	sandbox: readonly SandboxLayerRequirement[];
}

/**
 * The Code Intelligence language catalogue is the sole capability source.
 * Structural search and LSP are deliberately independent: an AST grammar does
 * not imply definitions, references, hover, symbols, or diagnostics.
 */
export interface CodeIntelligenceLanguage {
	id: string;
	label: string;
	evidence: LanguageEvidence;
	structuralSearch: StructuralSearchCapability;
	/** @deprecated Compatibility for the existing AST runner; use structuralSearch. */
	ast?: AstCapability;
	lsp?: LspCapability;
}

const allLspActions = ["definition", "references", "hover", "documentSymbols", "workspaceSymbols", "diagnostics"] as const satisfies readonly LspAction[];
const noMarkers: readonly string[] = [];
const nodeHost: ToolchainRequirement = {
	id: "node", label: "Node.js", executable: "node",
	version: { range: ">=20.0.0", reason: "language servers require a supported Node.js runtime" },
	installHint: "Install Node.js 20 or later.",
};
const nodeSandbox: SandboxLayerRequirement = { ...nodeHost, layerId: "nodejs-20" };

function structural(grammar: string): { structuralSearch: StructuralSearchCapability; ast: AstCapability } {
	return {
		structuralSearch: { state: "supported", astGrepGrammar: grammar },
		ast: { supported: true, grammar },
	};
}

/**
 * Add a language by adding one record here. No language-specific switch belongs
 * in detection, status derivation, or sandbox requirement derivation.
 */
export const CODE_INTELLIGENCE_LANGUAGE_MATRIX = [
	{ id: "bash", label: "Bash", evidence: { globs: ["**/*.sh", "**/*.bash", "**/*.zsh"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Bash") },
	{
		id: "c", label: "C", evidence: { globs: ["**/*.c", "**/*.h"], rootMarkers: ["CMakeLists.txt", "compile_commands.json", "compile_flags.txt", "meson.build"], minimumFiles: 1 }, ...structural("C"),
		lsp: {
			server: { id: "clangd", command: "clangd", args: ["--background-index"], version: { range: ">=16.0.0", reason: "C/C++ support needs a current clangd" } },
			rootMarkers: ["CMakeLists.txt", "compile_commands.json", "compile_flags.txt", "meson.build"], actions: allLspActions,
			host: [{ id: "clangd", label: "clangd", executable: "clangd", version: { range: ">=16.0.0", reason: "C support requires clangd" }, installHint: "Install clangd 16 or later." }],
			sandbox: [{ id: "clangd", label: "clangd", executable: "clangd", version: { range: ">=16.0.0", reason: "C support requires clangd" }, installHint: "Add clangd 16 or later to the project sandbox image.", layerId: "clangd-16" }],
		},
	},
	{
		id: "cpp", label: "C++", evidence: { globs: ["**/*.cc", "**/*.cp", "**/*.cpp", "**/*.cxx", "**/*.c++", "**/*.h", "**/*.hh", "**/*.hpp", "**/*.hxx", "**/*.h++"], rootMarkers: ["CMakeLists.txt", "compile_commands.json", "compile_flags.txt", "meson.build"], minimumFiles: 1 }, ...structural("Cpp"),
		lsp: {
			server: { id: "clangd", command: "clangd", args: ["--background-index"], version: { range: ">=16.0.0", reason: "C/C++ support needs a current clangd" } },
			rootMarkers: ["CMakeLists.txt", "compile_commands.json", "compile_flags.txt", "meson.build"], actions: allLspActions,
			host: [{ id: "clangd", label: "clangd", executable: "clangd", version: { range: ">=16.0.0", reason: "C++ support requires clangd" }, installHint: "Install clangd 16 or later." }],
			sandbox: [{ id: "clangd", label: "clangd", executable: "clangd", version: { range: ">=16.0.0", reason: "C++ support requires clangd" }, installHint: "Add clangd 16 or later to the project sandbox image.", layerId: "clangd-16" }],
		},
	},
	{
		id: "csharp", label: "C#", evidence: { globs: ["**/*.cs"], rootMarkers: ["*.sln", "*.csproj", "Directory.Build.props"], minimumFiles: 1 }, ...structural("CSharp"),
		lsp: {
			server: { id: "csharp-ls", command: "csharp-ls", args: [], version: { range: ">=0.14.0", reason: "C# support requires csharp-ls" } },
			rootMarkers: ["*.sln", "*.csproj", "Directory.Build.props"], actions: allLspActions,
			host: [
				{ id: "dotnet", label: ".NET SDK", executable: "dotnet", version: { range: ">=8.0.0", reason: "csharp-ls runs on the .NET SDK" }, installHint: "Install the .NET 8 SDK or later." },
				{ id: "csharp-ls", label: "csharp-ls", executable: "csharp-ls", version: { range: ">=0.14.0", reason: "C# support requires csharp-ls" }, installHint: "Install csharp-ls with dotnet tool install -g csharp-ls." },
			],
			sandbox: [
				{ id: "dotnet", label: ".NET SDK", executable: "dotnet", version: { range: ">=8.0.0", reason: "csharp-ls runs on the .NET SDK" }, installHint: "Add the .NET 8 SDK or later to the project sandbox image.", layerId: "dotnet-sdk-8" },
				{ id: "csharp-ls", label: "csharp-ls", executable: "csharp-ls", version: { range: ">=0.14.0", reason: "C# support requires csharp-ls" }, installHint: "Add csharp-ls to the project sandbox image.", layerId: "csharp-ls" },
			],
		},
	},
	{ id: "css", label: "CSS", evidence: { globs: ["**/*.css"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Css") },
	{ id: "elixir", label: "Elixir", evidence: { globs: ["**/*.ex", "**/*.exs"], rootMarkers: ["mix.exs"], minimumFiles: 1 }, ...structural("Elixir") },
	{
		id: "go", label: "Go", evidence: { globs: ["**/*.go"], rootMarkers: ["go.mod", "go.work"], minimumFiles: 1 }, ...structural("Go"),
		lsp: {
			server: { id: "gopls", command: "gopls", args: ["serve"], version: { range: ">=0.16.0", reason: "Go support requires a current gopls" } },
			rootMarkers: ["go.mod", "go.work"], actions: allLspActions,
			host: [
				{ id: "go", label: "Go toolchain", executable: "go", version: { range: ">=1.22.0", reason: "gopls requires a supported Go toolchain" }, installHint: "Install Go 1.22 or later." },
				{ id: "gopls", label: "gopls", executable: "gopls", version: { range: ">=0.16.0", reason: "Go support requires gopls" }, installHint: "Install gopls with go install golang.org/x/tools/gopls@latest." },
			],
			sandbox: [
				{ id: "go", label: "Go toolchain", executable: "go", version: { range: ">=1.22.0", reason: "gopls requires a supported Go toolchain" }, installHint: "Add Go 1.22 or later to the project sandbox image.", layerId: "go-1.22" },
				{ id: "gopls", label: "gopls", executable: "gopls", version: { range: ">=0.16.0", reason: "Go support requires gopls" }, installHint: "Add gopls to the project sandbox image.", layerId: "gopls" },
			],
		},
	},
	{ id: "haskell", label: "Haskell", evidence: { globs: ["**/*.hs", "**/*.lhs"], rootMarkers: ["cabal.project", "stack.yaml"], minimumFiles: 1 }, ...structural("Haskell") },
	{ id: "hcl", label: "HCL", evidence: { globs: ["**/*.hcl", "**/*.tf", "**/*.tfvars"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Hcl") },
	{ id: "html", label: "HTML", evidence: { globs: ["**/*.html", "**/*.htm"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Html") },
	{
		id: "java", label: "Java", evidence: { globs: ["**/*.java"], rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], minimumFiles: 1 }, ...structural("Java"),
		lsp: {
			server: { id: "eclipse-jdtls", command: "jdtls", args: [], version: { range: ">=1.40.0", reason: "Java support requires Eclipse JDT LS" } },
			rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], actions: allLspActions,
			host: [
				{ id: "java", label: "Java runtime", executable: "java", version: { range: ">=21.0.0", reason: "Eclipse JDT LS requires a supported Java runtime" }, installHint: "Install Java 21 or later." },
				{ id: "eclipse-jdtls", label: "Eclipse JDT LS", executable: "jdtls", version: { range: ">=1.40.0", reason: "Java support requires Eclipse JDT LS" }, installHint: "Install Eclipse JDT LS and expose jdtls on PATH." },
			],
			sandbox: [
				{ id: "java", label: "Java runtime", executable: "java", version: { range: ">=21.0.0", reason: "Eclipse JDT LS requires a supported Java runtime" }, installHint: "Add Java 21 or later to the project sandbox image.", layerId: "java-21" },
				{ id: "eclipse-jdtls", label: "Eclipse JDT LS", executable: "jdtls", version: { range: ">=1.40.0", reason: "Java support requires Eclipse JDT LS" }, installHint: "Add Eclipse JDT LS to the project sandbox image.", layerId: "eclipse-jdtls" },
			],
		},
	},
	{
		id: "javascript", label: "JavaScript", evidence: { globs: ["**/*.js", "**/*.cjs", "**/*.mjs", "**/*.jsx"], rootMarkers: ["package.json"], minimumFiles: 1 }, ...structural("JavaScript"),
		lsp: {
			server: { id: "typescript-language-server", command: "typescript-language-server", args: ["--stdio"], version: { range: ">=4.3.0", reason: "JavaScript support requires typescript-language-server" } },
			rootMarkers: ["package.json", "jsconfig.json", "tsconfig.json"], actions: allLspActions,
			host: [nodeHost, { id: "typescript-language-server", label: "TypeScript Language Server", executable: "typescript-language-server", version: { range: ">=4.3.0", reason: "JavaScript support requires TypeScript Language Server" }, installHint: "Install typescript-language-server and TypeScript." }, { id: "typescript", label: "TypeScript", executable: "tsc", version: { range: ">=5.0.0", reason: "TypeScript Language Server needs TypeScript" }, installHint: "Install TypeScript 5 or later." }],
			sandbox: [nodeSandbox, { id: "typescript-language-server", label: "TypeScript Language Server", executable: "typescript-language-server", version: { range: ">=4.3.0", reason: "JavaScript support requires TypeScript Language Server" }, installHint: "Add typescript-language-server to the project sandbox image.", layerId: "typescript-language-server" }, { id: "typescript", label: "TypeScript", executable: "tsc", version: { range: ">=5.0.0", reason: "TypeScript Language Server needs TypeScript" }, installHint: "Add TypeScript 5 or later to the project sandbox image.", layerId: "typescript-5" }],
		},
	},
	{ id: "json", label: "JSON", evidence: { globs: ["**/*.json", "**/*.jsonc"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Json") },
	{ id: "kotlin", label: "Kotlin", evidence: { globs: ["**/*.kt", "**/*.kts"], rootMarkers: ["build.gradle", "build.gradle.kts", "settings.gradle.kts"], minimumFiles: 1 }, ...structural("Kotlin") },
	{ id: "lua", label: "Lua", evidence: { globs: ["**/*.lua"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Lua") },
	{ id: "nix", label: "Nix", evidence: { globs: ["**/*.nix"], rootMarkers: ["flake.nix"], minimumFiles: 1 }, ...structural("Nix") },
	{ id: "php", label: "PHP", evidence: { globs: ["**/*.php"], rootMarkers: ["composer.json"], minimumFiles: 1 }, ...structural("Php") },
	{
		id: "python", label: "Python", evidence: { globs: ["**/*.py", "**/*.pyi"], rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"], minimumFiles: 1 }, ...structural("Python"),
		lsp: {
			server: { id: "pyright", command: "pyright-langserver", args: ["--stdio"], version: { range: ">=1.1.390", reason: "Python support requires Pyright" } },
			rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"], actions: allLspActions,
			host: [nodeHost, { id: "pyright", label: "Pyright", executable: "pyright-langserver", version: { range: ">=1.1.390", reason: "Python support requires Pyright" }, installHint: "Install Pyright." }],
			sandbox: [nodeSandbox, { id: "pyright", label: "Pyright", executable: "pyright-langserver", version: { range: ">=1.1.390", reason: "Python support requires Pyright" }, installHint: "Add Pyright to the project sandbox image.", layerId: "pyright" }],
		},
	},
	{ id: "ruby", label: "Ruby", evidence: { globs: ["**/*.rb", "**/*.rake", "**/*.gemspec"], rootMarkers: ["Gemfile"], minimumFiles: 1 }, ...structural("Ruby") },
	{
		id: "rust", label: "Rust", evidence: { globs: ["**/*.rs"], rootMarkers: ["Cargo.toml"], minimumFiles: 1 }, ...structural("Rust"),
		lsp: {
			server: { id: "rust-analyzer", command: "rust-analyzer", args: [], version: { range: ">=2024-10-01", reason: "Rust support requires rust-analyzer" } },
			rootMarkers: ["Cargo.toml"], actions: allLspActions,
			host: [
				{ id: "rust", label: "Rust toolchain", executable: "rustc", version: { range: ">=1.82.0", reason: "rust-analyzer needs a current Rust toolchain" }, installHint: "Install Rust 1.82 or later with rustup." },
				{ id: "rust-analyzer", label: "rust-analyzer", executable: "rust-analyzer", version: { range: ">=2024-10-01", reason: "Rust support requires rust-analyzer" }, installHint: "Install rust-analyzer with rustup component add rust-analyzer." },
			],
			sandbox: [
				{ id: "rust", label: "Rust toolchain", executable: "rustc", version: { range: ">=1.82.0", reason: "rust-analyzer needs a current Rust toolchain" }, installHint: "Add Rust 1.82 or later to the project sandbox image.", layerId: "rust-1.82" },
				{ id: "rust-analyzer", label: "rust-analyzer", executable: "rust-analyzer", version: { range: ">=2024-10-01", reason: "Rust support requires rust-analyzer" }, installHint: "Add rust-analyzer to the project sandbox image.", layerId: "rust-analyzer" },
			],
		},
	},
	{ id: "scala", label: "Scala", evidence: { globs: ["**/*.scala", "**/*.sc"], rootMarkers: ["build.sbt"], minimumFiles: 1 }, ...structural("Scala") },
	{ id: "solidity", label: "Solidity", evidence: { globs: ["**/*.sol"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Solidity") },
	{ id: "swift", label: "Swift", evidence: { globs: ["**/*.swift"], rootMarkers: ["Package.swift"], minimumFiles: 1 }, ...structural("Swift") },
	{
		id: "typescript", label: "TypeScript", evidence: { globs: ["**/*.ts", "**/*.cts", "**/*.mts"], rootMarkers: ["package.json", "tsconfig.json"], minimumFiles: 1 }, ...structural("TypeScript"),
		lsp: {
			server: { id: "typescript-language-server", command: "typescript-language-server", args: ["--stdio"], version: { range: ">=4.3.0", reason: "TypeScript support requires typescript-language-server" } },
			rootMarkers: ["package.json", "tsconfig.json"], actions: allLspActions,
			host: [nodeHost, { id: "typescript-language-server", label: "TypeScript Language Server", executable: "typescript-language-server", version: { range: ">=4.3.0", reason: "TypeScript support requires TypeScript Language Server" }, installHint: "Install typescript-language-server and TypeScript." }, { id: "typescript", label: "TypeScript", executable: "tsc", version: { range: ">=5.0.0", reason: "TypeScript Language Server needs TypeScript" }, installHint: "Install TypeScript 5 or later." }],
			sandbox: [nodeSandbox, { id: "typescript-language-server", label: "TypeScript Language Server", executable: "typescript-language-server", version: { range: ">=4.3.0", reason: "TypeScript support requires TypeScript Language Server" }, installHint: "Add typescript-language-server to the project sandbox image.", layerId: "typescript-language-server" }, { id: "typescript", label: "TypeScript", executable: "tsc", version: { range: ">=5.0.0", reason: "TypeScript Language Server needs TypeScript" }, installHint: "Add TypeScript 5 or later to the project sandbox image.", layerId: "typescript-5" }],
		},
	},
	{ id: "tsx", label: "TSX", evidence: { globs: ["**/*.tsx"], rootMarkers: ["package.json", "tsconfig.json"], minimumFiles: 1 }, ...structural("Tsx") },
	{ id: "yaml", label: "YAML", evidence: { globs: ["**/*.yaml", "**/*.yml"], rootMarkers: noMarkers, minimumFiles: 1 }, ...structural("Yaml") },
] as const satisfies readonly CodeIntelligenceLanguage[];

export type AstGrepLanguageAlias = (typeof CODE_INTELLIGENCE_LANGUAGE_MATRIX)[number]["id"];
export type AstGrepLanguage = CodeIntelligenceLanguage & { ast: AstCapability };

export const MAX_LANGUAGE_DETECTION_ENTRIES = 10_000;
const ignoredDirectories = new Set([
	".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".next", ".cache", "vendor",
]);

export function normalizeAstGrepLanguage(value: string): AstGrepLanguage | undefined {
	const language = languageForId(value);
	return language && supportsStructuralSearch(language) ? language : undefined;
}

export function languageForId(value: string): CodeIntelligenceLanguage | undefined {
	const id = value.trim().toLowerCase();
	return CODE_INTELLIGENCE_LANGUAGE_MATRIX.find((language) => language.id === id);
}

/** Derive aliases from canonical evidence globs; no parallel extension map. */
export function languagesForExtension(extension: string): readonly AstGrepLanguageAlias[] {
	const normalized = extension.toLowerCase();
	return CODE_INTELLIGENCE_LANGUAGE_MATRIX
		.filter((language) => supportsStructuralSearch(language) && language.evidence.globs.some((glob) => path.extname(glob).toLowerCase() === normalized))
		.map((language) => language.id);
}

function supportsStructuralSearch(language: CodeIntelligenceLanguage): language is AstGrepLanguage {
	return language.structuralSearch.state === "supported" && language.ast?.supported === true && Boolean(language.structuralSearch.astGrepGrammar);
}

export interface LanguageDetectorFs {
	lstatSync: typeof fs.lstatSync;
	readdirSync: typeof fs.readdirSync;
}

interface DirectoryFrame {
	directory: string;
	entries: readonly fs.Dirent[];
	index: number;
}

/**
 * Visit regular files in deterministic depth-first directory order. Every path
 * that reaches `lstatSync` consumes one unit of the shared scan budget; queued
 * directory entries do not. Symlinks and ignored directories are excluded
 * before they can expand the walk.
 */
export function walkLanguageDetectionPaths(
	roots: readonly string[],
	seams: LanguageDetectorFs,
	onFile: (filePath: string) => void,
): void {
	const orderedRoots = [...roots].sort(compareNames);
	const directories: DirectoryFrame[] = [];
	let rootIndex = 0;
	let processed = 0;

	while (processed < MAX_LANGUAGE_DETECTION_ENTRIES) {
		const current = nextPath();
		if (!current) return;
		processed += 1;

		let stat: fs.Stats;
		try { stat = seams.lstatSync(current); } catch { continue; }
		if (stat.isSymbolicLink()) continue;
		if (stat.isFile()) {
			onFile(current);
			continue;
		}
		if (!stat.isDirectory()) continue;

		try {
			const entries = seams.readdirSync(current, { withFileTypes: true }) as fs.Dirent[];
			directories.push({ directory: current, entries: [...entries].sort((left, right) => compareNames(left.name, right.name)), index: 0 });
		} catch { continue; }
	}

	function nextPath(): string | undefined {
		while (directories.length > 0) {
			const frame = directories[directories.length - 1];
			if (frame.index >= frame.entries.length) {
				directories.pop();
				continue;
			}
			const entry = frame.entries[frame.index++];
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
			return path.join(frame.directory, entry.name);
		}
		if (rootIndex >= orderedRoots.length) return undefined;
		return orderedRoots[rootIndex++];
	}
}

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Bounded, symlink-safe structural-language discovery. */
export function detectAstGrepLanguages(
	roots: readonly string[],
	seams: LanguageDetectorFs = fs,
): AstGrepLanguageAlias[] {
	const found = new Set<AstGrepLanguageAlias>();
	walkLanguageDetectionPaths(roots, seams, (filePath) => {
		for (const alias of languagesForExtension(path.extname(filePath))) found.add(alias);
	});
	return [...found].sort() as AstGrepLanguageAlias[];
}
