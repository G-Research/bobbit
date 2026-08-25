const RAW_CONVENTIONS = [
	{
		semantic: "unit-core",
		lane: "unit",
		runner: "vitest",
		directory: "tests/unit/core",
		suffix: ".unit.test.ts",
		pattern: "tests/unit/core/**/*.unit.test.ts",
	},
	{
		semantic: "unit-isolated",
		lane: "unit",
		runner: "vitest",
		directory: "tests/unit/isolated",
		suffix: ".isolated.test.ts",
		pattern: "tests/unit/isolated/**/*.isolated.test.ts",
	},
	{
		semantic: "dom",
		lane: "unit",
		runner: "vitest",
		directory: "tests/dom",
		suffix: ".dom.test.ts",
		pattern: "tests/dom/**/*.dom.test.ts",
	},
	{
		semantic: "gateway-integration",
		lane: "unit",
		runner: "vitest",
		directory: "tests/integration/gateway",
		suffix: ".gateway.test.ts",
		pattern: "tests/integration/gateway/**/*.gateway.test.ts",
	},
	{
		semantic: "browser-fixture",
		lane: "browser",
		runner: "playwright",
		directory: "tests/browser/fixtures",
		suffix: ".fixture.spec.ts",
		pattern: "tests/browser/fixtures/**/*.fixture.spec.ts",
	},
	{
		semantic: "browser-journey",
		lane: "browser",
		runner: "playwright",
		directory: "tests/browser/journeys",
		suffix: ".journey.spec.ts",
		pattern: "tests/browser/journeys/**/*.journey.spec.ts",
	},
	{
		semantic: "node-e2e",
		lane: "e2e",
		runner: "node",
		directory: "tests/e2e/node",
		suffix: ".node-e2e.test.ts",
		pattern: "tests/e2e/node/**/*.node-e2e.test.ts",
	},
	{
		semantic: "vitest-e2e",
		lane: "e2e",
		runner: "vitest",
		directory: "tests/e2e/vitest",
		suffix: ".vitest-e2e.test.ts",
		pattern: "tests/e2e/vitest/**/*.vitest-e2e.test.ts",
	},
	{
		semantic: "api-e2e",
		lane: "e2e",
		runner: "playwright",
		directory: "tests/e2e/api",
		suffix: ".api-e2e.spec.ts",
		pattern: "tests/e2e/api/**/*.api-e2e.spec.ts",
	},
	{
		semantic: "browser-e2e",
		lane: "e2e",
		runner: "playwright",
		directory: "tests/e2e/browser",
		suffix: ".browser-e2e.spec.ts",
		pattern: "tests/e2e/browser/**/*.browser-e2e.spec.ts",
	},
	{
		semantic: "manual",
		lane: "manual",
		runner: "playwright",
		directory: "tests/manual",
		suffix: ".manual.spec.ts",
		pattern: "tests/manual/**/*.manual.spec.ts",
	},
];

/** The complete, immutable source of test ownership. It contains conventions, never file records. */
export const TEST_LAYOUT = Object.freeze(RAW_CONVENTIONS.map((entry) => Object.freeze({ ...entry })));
export const TEST_SEMANTICS = Object.freeze(TEST_LAYOUT.map(({ semantic }) => semantic));

const RUNNABLE_SUFFIX_RE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i;
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:\/|\/\/|\/)/;
const RUNNER_MODULES = Object.freeze({
	vitest: "vitest",
	"@playwright/test": "playwright",
	"node:test": "node",
});

export function normalizeTestPath(filePath) {
	if (typeof filePath !== "string") throw new TypeError("Test path must be a string.");
	return filePath.replace(/\\/g, "/").replace(/^\.\/(?:\.\/)*|^\.\/$/g, "").replace(/\/{2,}/g, "/");
}

export function isRunnableTestPath(filePath) {
	return typeof filePath === "string" && RUNNABLE_SUFFIX_RE.test(normalizeTestPath(filePath));
}

function hasUnsafeShape(filePath) {
	return filePath.includes("\0")
		|| ABSOLUTE_PATH_RE.test(filePath)
		|| filePath.split("/").some((part) => part === ".." || part === ".");
}

function isRunnableHelper(filePath) {
	return filePath.startsWith("tests/support/") || filePath.includes("/_helpers/");
}

function matchesConvention(filePath, convention) {
	if (isRunnableHelper(filePath)) return false;
	if (!filePath.startsWith(`${convention.directory}/`) || !filePath.endsWith(convention.suffix)) return false;
	return filePath.length > convention.directory.length + convention.suffix.length + 1;
}

function matchingConventions(filePath) {
	if (typeof filePath !== "string") return [];
	const normalized = normalizeTestPath(filePath);
	if (hasUnsafeShape(normalized)) return [];
	return TEST_LAYOUT.filter((entry) => matchesConvention(normalized, entry));
}

/** Return the one semantic owner for a canonical path, or null for invalid/unowned paths. */
export function classifyTestPath(filePath) {
	const matches = matchingConventions(filePath);
	if (matches.length !== 1) return null;
	const { semantic, lane, runner, pattern } = matches[0];
	return Object.freeze({ semantic, lane, runner, pattern });
}

/** Return canonical discovery patterns owned by a semantic, lane, or runner. */
export function patternsFor(owner) {
	const matches = owner === undefined || owner === "all"
		? TEST_LAYOUT
		: TEST_LAYOUT.filter((entry) => entry.semantic === owner || entry.lane === owner || entry.runner === owner);
	return Object.freeze(matches.map(({ pattern }) => pattern));
}

function diagnostic(code, filePath, message, expectedPattern) {
	return Object.freeze({ code, path: filePath, message, ...(expectedPattern ? { expectedPattern } : {}) });
}

function conventionsForSuffix(filePath) {
	return TEST_LAYOUT.filter(({ suffix }) => filePath.endsWith(suffix));
}

function conventionsForDirectory(filePath) {
	return TEST_LAYOUT.filter(({ directory }) => filePath.startsWith(`${directory}/`));
}

function extractImportedModules(source) {
	const modules = new Set();
	// Runner ownership is determined from real, line-leading import declarations.
	// Anchoring avoids treating examples, comments, and source snippets as imports.
	const patterns = [
		/^[ \t]*import(?:\s+type)?[^;]*?\bfrom\s*["']([^"']+)["'][^;]*;?/gm,
		/^[ \t]*import\s*["']([^"']+)["'][^;]*;?/gm,
		/^[ \t]*(?:const|let|var)\b[^;]*?\brequire\s*\(\s*["']([^"']+)["']\s*\)[^;]*;?/gm,
	];
	const executableSource = maskStringsAndComments(source);
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const codeAtMatch = executableSource.slice(match.index, match.index + match[0].length).trimStart();
			if (/^(?:import|const\b|let\b|var\b)/.test(codeAtMatch)) modules.add(match[1]);
		}
	}
	return modules;
}

function maskStringsAndComments(source) {
	let out = "";
	let mode = "code";
	let quote = "";
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		const next = source[index + 1];
		if (mode === "code") {
			if (character === "/" && next === "/") {
				mode = "line-comment";
				out += "  ";
				index += 1;
			} else if (character === "/" && next === "*") {
				mode = "block-comment";
				out += "  ";
				index += 1;
			} else if (character === "\"" || character === "'" || character === "`") {
				mode = "string";
				quote = character;
				out += " ";
			} else out += character;
		} else if (mode === "line-comment") {
			if (character === "\n") {
				mode = "code";
				out += "\n";
			} else out += " ";
		} else if (mode === "block-comment") {
			if (character === "*" && next === "/") {
				mode = "code";
				out += "  ";
				index += 1;
			} else out += character === "\n" ? "\n" : " ";
		} else if (character === "\\") {
			out += "  ";
			index += 1;
		} else if (character === quote) {
			mode = "code";
			out += " ";
		} else out += character === "\n" ? "\n" : " ";
	}
	return out;
}

function validateRunnerImports(filePath, source, owner) {
	const diagnostics = [];
	for (const moduleName of extractImportedModules(source)) {
		const observedRunner = RUNNER_MODULES[moduleName];
		if (observedRunner && observedRunner !== owner.runner) {
			diagnostics.push(diagnostic(
				"runner-import-mismatch",
				filePath,
				`${owner.pattern} is owned by ${owner.runner}, but this file imports ${moduleName} (${observedRunner}).`,
				owner.pattern,
			));
		}
	}

	if (owner.semantic === "api-e2e") {
		const executableSource = maskStringsAndComments(source);
		const browserFixture = /(?:async\s*)?\(\s*\{[^}]*\b(page|browser|context)\b[^}]*\}\s*\)\s*=>/m.exec(executableSource);
		if (browserFixture) {
			diagnostics.push(diagnostic(
				"api-browser-fixture",
				filePath,
				`${owner.pattern} is API/process-only and cannot request Playwright's "${browserFixture[1]}" browser fixture; move real-browser coverage to tests/e2e/browser/**/*.browser-e2e.spec.ts.`,
				"tests/e2e/browser/**/*.browser-e2e.spec.ts",
			));
		}

		const browserImport = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*["']@playwright\/test["']/gm;
		for (const match of source.matchAll(browserImport)) {
			if (!executableSource.slice(match.index, match.index + match[0].length).trimStart().startsWith("import")) continue;
			const names = match[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]);
			const forbidden = names.find((name) => ["chromium", "firefox", "webkit", "page", "browser", "context"].includes(name));
			if (forbidden) {
				diagnostics.push(diagnostic(
					"api-browser-import",
					filePath,
					`${owner.pattern} cannot import Playwright browser primitive "${forbidden}"; move real-browser coverage to tests/e2e/browser/**/*.browser-e2e.spec.ts.`,
					"tests/e2e/browser/**/*.browser-e2e.spec.ts",
				));
				break;
			}
		}

		const boundary = [...extractImportedModules(source)].find((moduleName) => /(?:^|\/)(?:_helpers|support)(?:\/.*)?\/browser(?:\/|[-.])/.test(moduleName));
		if (boundary) {
			diagnostics.push(diagnostic(
				"api-browser-boundary",
				filePath,
				`${owner.pattern} cannot import browser-only helper "${boundary}"; move real-browser coverage to tests/e2e/browser/**/*.browser-e2e.spec.ts.`,
				"tests/e2e/browser/**/*.browser-e2e.spec.ts",
			));
		}
	}
	return diagnostics;
}

/** Validate one path and, when supplied, its source-level runner boundaries. */
export function validateTestPath(filePath, source) {
	if (typeof filePath !== "string") {
		return [diagnostic("invalid-path", String(filePath), "Test path must be a string.")];
	}
	const normalized = normalizeTestPath(filePath);
	if (filePath.includes("\0")) {
		return [diagnostic("nul-path", normalized, "Test paths cannot contain a NUL byte.")];
	}
	if (ABSOLUTE_PATH_RE.test(normalized)) {
		return [diagnostic("absolute-path", normalized, "Test paths must be repository-relative and live under tests/.")];
	}
	if (normalized.split("/").some((part) => part === ".." || part === ".")) {
		return [diagnostic("path-traversal", normalized, "Test paths cannot contain '.' or '..' traversal segments.")];
	}
	if (!isRunnableTestPath(normalized)) return [];

	if (normalized.startsWith("tests/support/") || normalized.includes("/_helpers/")) {
		return [diagnostic(
			"runnable-support-file",
			normalized,
			`Runnable suffixes are forbidden in support and _helpers directories. Move the test to its semantic pattern (${TEST_LAYOUT.map(({ pattern }) => pattern).join(", ")}) or rename it as non-runnable support code.`,
		)];
	}

	const matches = matchingConventions(normalized);
	if (matches.length > 1) {
		return [diagnostic("multiple-owners", normalized, `Test matches multiple canonical owners: ${matches.map(({ pattern }) => pattern).join(", ")}.`)];
	}
	if (matches.length === 1) {
		return typeof source === "string" ? validateRunnerImports(normalized, source, matches[0]) : [];
	}

	const suffixOwners = conventionsForSuffix(normalized);
	if (suffixOwners.length === 1) {
		const owner = suffixOwners[0];
		return [diagnostic(
			"wrong-directory",
			normalized,
			`Observed semantic suffix "${owner.suffix}" (${owner.semantic}); it belongs at ${owner.pattern}.`,
			owner.pattern,
		)];
	}

	const directoryOwners = conventionsForDirectory(normalized);
	if (directoryOwners.length === 1) {
		const owner = directoryOwners[0];
		return [diagnostic(
			"wrong-suffix",
			normalized,
			`Tests under ${owner.directory}/ must use semantic suffix "${owner.suffix}"; expected ${owner.pattern}.`,
			owner.pattern,
		)];
	}

	return [diagnostic(
		"unclassified-test",
		normalized,
		`Runnable test has no canonical owner. Create it with "npm run test:new -- <semantic> <name>"; expected one of: ${TEST_LAYOUT.map(({ pattern }) => pattern).join(", ")}.`,
	)];
}

/** Validate an inventory and additionally reject exact duplicates and case-fold collisions. */
export function validateTestInventory(filePaths, sourceForPath) {
	const diagnostics = [];
	const exact = new Map();
	const folded = new Map();
	for (const originalPath of filePaths) {
		if (typeof originalPath !== "string") {
			diagnostics.push(...validateTestPath(originalPath));
			continue;
		}
		const normalized = normalizeTestPath(originalPath);
		exact.set(normalized, (exact.get(normalized) ?? 0) + 1);
		const lower = normalized.toLocaleLowerCase("en-US");
		const variants = folded.get(lower) ?? new Set();
		variants.add(normalized);
		folded.set(lower, variants);
		let source;
		if (isRunnableTestPath(normalized)) {
			if (typeof sourceForPath === "function") source = sourceForPath(normalized);
			else if (sourceForPath instanceof Map) source = sourceForPath.get(normalized);
		}
		diagnostics.push(...validateTestPath(originalPath, source));
	}
	for (const [filePath, count] of exact) {
		if (count > 1) diagnostics.push(diagnostic("duplicate-path", filePath, `${filePath} appears ${count} times; every test must be discovered exactly once.`));
	}
	for (const variants of folded.values()) {
		if (variants.size > 1) {
			const paths = [...variants].sort();
			diagnostics.push(diagnostic("case-collision", paths[0], `Case-fold collision: ${paths.join(", ")}. Test paths must be unique on Windows and macOS.`));
		}
	}
	return diagnostics;
}
