import ts from "typescript";

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
const DIRECT_TEST_ROOT_EXECUTABLE_RE = /^tests\/[^/]+\.(?:[cm]?[jt]s|[jt]sx)$/i;
const DECLARATION_SOURCE_RE = /\.d\.(?:[cm]?ts|tsx)$/i;
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

/**
 * Temporary execution conventions retained until every runnable file reaches a
 * canonical destination. These are conventions, never per-file records.
 */
export const TRANSITIONAL_TEST_ROOTS = Object.freeze([
	"tests2/core",
	"tests2/dom",
	"tests2/integration",
	"tests2/browser",
	"tests/e2e",
	"tests/manual-integration",
	"tests/*.e2e.test.ts",
]);

function transitionalPlacementError(filePath, remedy) {
	throw new Error(`Unsupported transitional test placement ${JSON.stringify(filePath)}. ${remedy}`);
}

/** Return the legacy discovery leaf for a pre-cutover path, or null. */
export function classifyTransitionalTestPath(filePath) {
	const normalized = normalizeTestPath(filePath);
	if (/^(?:\/|[A-Za-z]:)/.test(normalized) || normalized.split("/").includes("..")) {
		transitionalPlacementError(normalized, "Use a repository-relative path without '..' traversal.");
	}
	if (!/\.(?:test|spec)\.ts$/.test(normalized)) return null;
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	const isolated = basename.includes(".isolated.");
	const e2e = basename.includes(".e2e.");
	if (isolated && e2e) transitionalPlacementError(normalized, "Use exactly one semantic suffix: '*.isolated.test.ts' or '*.e2e.test.ts'.");

	if (/^tests2\/(?:core|integration)\/.+\.isolated\.test\.ts$/.test(normalized)) return "isolated";
	if (/^tests2\/(?:core|integration)\/.+\.e2e\.test\.ts$/.test(normalized)) return "vitestE2E";
	if (/^tests2\/core\/.+\.test\.ts$/.test(normalized)) return "core";
	if (/^tests2\/dom\/.+\.test\.ts$/.test(normalized)) {
		if (isolated || e2e) transitionalPlacementError(normalized, "Semantic Vitest tests belong in tests2/core or tests2/integration.");
		return "dom";
	}
	if (/^tests2\/integration\/.+\.test\.ts$/.test(normalized)) return "integration";
	if (/^tests2\/browser\/e2e\/.+\.spec\.ts$/.test(normalized)) return "browserE2E";
	if (/^tests2\/browser\/.+\.spec\.ts$/.test(normalized)) return "browser";
	if (/^tests\/[^/]+\.e2e\.test\.ts$/.test(normalized)) return "e2eNode";
	if (/^tests\/e2e\/.+\.e2e\.spec\.ts$/.test(normalized)) return "e2ePlaywright";
	if (/^tests\/manual-integration\/.+\.(?:test|spec)\.ts$/.test(normalized)) return "manual";

	if (/^tests2\/(?:core|dom|integration)(?:\/|$)/.test(normalized)) transitionalPlacementError(normalized, "Vitest tests here must use '*.test.ts'; Playwright journeys belong in tests/browser/journeys.");
	if (/^tests2\/browser(?:\/|$)/.test(normalized)) transitionalPlacementError(normalized, "Browser journeys must use '*.spec.ts'; API/Vitest tests belong in canonical Vitest directories.");
	if (normalized.startsWith("tests2/")) transitionalPlacementError(normalized, "Use a canonical destination under tests/.");
	return null;
}

export function isDirectTestsRootExecutablePath(filePath) {
	if (typeof filePath !== "string") return false;
	const normalized = normalizeTestPath(filePath);
	return DIRECT_TEST_ROOT_EXECUTABLE_RE.test(normalized) && !DECLARATION_SOURCE_RE.test(normalized);
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

function parseTestSource(filePath, source) {
	return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasRuntimeNamedSpecifiers(namedBindings) {
	return !namedBindings || !ts.isNamedImports(namedBindings)
		|| namedBindings.elements.some((specifier) => !specifier.isTypeOnly);
}

/** Collect literal runtime module references without executing or resolving them. */
function extractImportedModules(sourceFile) {
	const modules = new Set();
	const addLiteral = (candidate) => {
		if (candidate && ts.isStringLiteralLike(candidate)) modules.add(candidate.text);
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			if (!clause || (!clause.isTypeOnly && (clause.name || hasRuntimeNamedSpecifiers(clause.namedBindings)))) {
				addLiteral(node.moduleSpecifier);
			}
		} else if (ts.isExportDeclaration(node)) {
			const hasRuntimeExport = !node.isTypeOnly
				&& (!node.exportClause || !ts.isNamedExports(node.exportClause)
					|| node.exportClause.elements.some((specifier) => !specifier.isTypeOnly));
			if (hasRuntimeExport) addLiteral(node.moduleSpecifier);
		} else if (ts.isImportEqualsDeclaration(node)
			&& !node.isTypeOnly
			&& ts.isExternalModuleReference(node.moduleReference)) {
			addLiteral(node.moduleReference.expression);
		} else if (ts.isCallExpression(node) && node.arguments.length === 1) {
			const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
			if (isDynamicImport || isRequire) addLiteral(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return modules;
}

const API_BROWSER_PRIMITIVES = new Set(["chromium", "firefox", "webkit", "page", "browser", "context"]);

function unwrapExpression(expression) {
	let current = expression;
	while (ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isNonNullExpression(current)
		|| ts.isAwaitExpression(current)) {
		current = current.expression;
	}
	return current;
}

function expressionPath(expression) {
	const parts = [];
	let current = unwrapExpression(expression);
	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		if (ts.isPropertyAccessExpression(current)) parts.unshift(current.name.text);
		else if (current.argumentExpression && ts.isStringLiteralLike(current.argumentExpression)) parts.unshift(current.argumentExpression.text);
		else return null;
		current = unwrapExpression(current.expression);
	}
	return ts.isIdentifier(current) ? { root: current.text, parts } : null;
}

function importedName(specifier) {
	return (specifier.propertyName ?? specifier.name).text;
}

function bindingElementName(element) {
	if (element.dotDotDotToken) return null;
	if (element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))) {
		return element.propertyName.text;
	}
	return ts.isIdentifier(element.name) ? element.name.text : null;
}

const API_BROWSER_FIXTURES = new Set(["page", "browser", "context"]);

function browserFixtureInCallback(callback) {
	const parameter = callback.parameters[0];
	if (!parameter) return null;

	const fixtureObjectBindings = new Set();
	const bindFixtureObjectPattern = (pattern) => {
		for (const element of pattern.elements) {
			const name = bindingElementName(element);
			if (name && API_BROWSER_FIXTURES.has(name)) return name;
			if (element.dotDotDotToken && ts.isIdentifier(element.name)) fixtureObjectBindings.add(element.name.text);
		}
		return null;
	};

	if (ts.isObjectBindingPattern(parameter.name)) {
		const fixture = bindFixtureObjectPattern(parameter.name);
		if (fixture) return fixture;
	} else if (ts.isIdentifier(parameter.name)) {
		fixtureObjectBindings.add(parameter.name.text);
	} else {
		return null;
	}

	const declarations = [];
	const collectDeclarations = (node) => {
		if (ts.isVariableDeclaration(node)) declarations.push(node);
		ts.forEachChild(node, collectDeclarations);
	};
	collectDeclarations(callback.body);

	// Follow only static aliases and object destructuring derived from the callback's
	// fixture-object parameter. A fixed point covers aliases declared before or after
	// one another without interpreting arbitrary helper return values.
	let bindingsChanged = true;
	while (bindingsChanged) {
		bindingsChanged = false;
		for (const declaration of declarations) {
			if (!declaration.initializer) continue;
			const path = expressionPath(declaration.initializer);
			if (!path || !fixtureObjectBindings.has(path.root) || path.parts.length !== 0) continue;
			if (ts.isIdentifier(declaration.name) && !fixtureObjectBindings.has(declaration.name.text)) {
				fixtureObjectBindings.add(declaration.name.text);
				bindingsChanged = true;
			} else if (ts.isObjectBindingPattern(declaration.name)) {
				const before = fixtureObjectBindings.size;
				const fixture = bindFixtureObjectPattern(declaration.name);
				if (fixture) return fixture;
				bindingsChanged ||= fixtureObjectBindings.size !== before;
			}
		}
	}

	let browserFixture = null;
	const inspectAccess = (node) => {
		if (browserFixture) return;
		if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
			const path = expressionPath(node);
			if (path && fixtureObjectBindings.has(path.root) && API_BROWSER_FIXTURES.has(path.parts[0])) {
				browserFixture = path.parts[0];
				return;
			}
		}
		ts.forEachChild(node, inspectAccess);
	};
	inspectAccess(callback.body);
	return browserFixture;
}

function loadedModuleName(expression) {
	const candidate = unwrapExpression(expression);
	if (!ts.isCallExpression(candidate)
		|| candidate.arguments.length !== 1
		|| !ts.isStringLiteralLike(candidate.arguments[0])) return null;
	const isRequire = ts.isIdentifier(candidate.expression) && candidate.expression.text === "require";
	const isDynamicImport = candidate.expression.kind === ts.SyntaxKind.ImportKeyword;
	return isRequire || isDynamicImport ? candidate.arguments[0].text : null;
}

const PLAYWRIGHT_BROWSER_MODULES = new Set(["@playwright/test", "playwright", "playwright-core"]);

function loadedModulePrimitive(expression) {
	const parts = [];
	let current = unwrapExpression(expression);
	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		if (ts.isPropertyAccessExpression(current)) parts.unshift(current.name.text);
		else if (current.argumentExpression && ts.isStringLiteralLike(current.argumentExpression)) parts.unshift(current.argumentExpression.text);
		else return null;
		current = unwrapExpression(current.expression);
	}
	const moduleName = loadedModuleName(current);
	return moduleName && PLAYWRIGHT_BROWSER_MODULES.has(moduleName) && API_BROWSER_PRIMITIVES.has(parts[0])
		? parts[0]
		: null;
}

/** Analyze Playwright bindings so API/browser boundaries are syntax-aware. */
function analyzePlaywrightApiUsage(sourceFile) {
	const testBindings = new Set();
	const namespaceBindings = new Set();
	const callbackBindings = new Map();
	let browserImport = null;

	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)
			&& ts.isStringLiteralLike(statement.moduleSpecifier)
			&& statement.importClause
			&& !statement.importClause.isTypeOnly) {
			const moduleName = statement.moduleSpecifier.text;
			const clause = statement.importClause;
			if (PLAYWRIGHT_BROWSER_MODULES.has(moduleName)) {
				if (clause.name) namespaceBindings.add(clause.name.text);
				if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
					namespaceBindings.add(clause.namedBindings.name.text);
				} else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					for (const specifier of clause.namedBindings.elements) {
						if (specifier.isTypeOnly) continue;
						const imported = importedName(specifier);
						if (moduleName === "@playwright/test" && imported === "test") testBindings.add(specifier.name.text);
						if (!browserImport && API_BROWSER_PRIMITIVES.has(imported)) browserImport = imported;
					}
				}
			} else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
				for (const specifier of clause.namedBindings.elements) {
					if (!specifier.isTypeOnly && importedName(specifier) === "test") testBindings.add(specifier.name.text);
				}
			}
		} else if (ts.isImportEqualsDeclaration(statement)
			&& !statement.isTypeOnly
			&& ts.isExternalModuleReference(statement.moduleReference)
			&& statement.moduleReference.expression
			&& ts.isStringLiteralLike(statement.moduleReference.expression)
			&& PLAYWRIGHT_BROWSER_MODULES.has(statement.moduleReference.expression.text)) {
			namespaceBindings.add(statement.name.text);
		}
	}

	const collectModuleBindings = (node) => {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			const moduleName = loadedModuleName(node.initializer);
			if (moduleName && PLAYWRIGHT_BROWSER_MODULES.has(moduleName)) {
				if (ts.isIdentifier(node.name)) namespaceBindings.add(node.name.text);
				else if (ts.isObjectBindingPattern(node.name)) {
					for (const element of node.name.elements) {
						const imported = bindingElementName(element);
						if (moduleName === "@playwright/test" && imported === "test" && ts.isIdentifier(element.name)) testBindings.add(element.name.text);
						if (!browserImport && imported && API_BROWSER_PRIMITIVES.has(imported)) browserImport = imported;
					}
				}
			}
		}
		ts.forEachChild(node, collectModuleBindings);
	};
	collectModuleBindings(sourceFile);

	const variableDeclarations = [];
	const collectBindings = (node) => {
		if (ts.isFunctionDeclaration(node) && node.name) callbackBindings.set(node.name.text, node);
		if (ts.isVariableDeclaration(node)) {
			variableDeclarations.push(node);
			if (ts.isIdentifier(node.name)
				&& node.initializer
				&& (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
				callbackBindings.set(node.name.text, node.initializer);
			}
		}
		ts.forEachChild(node, collectBindings);
	};
	collectBindings(sourceFile);

	const isNamespaceReference = (expression) => {
		const path = expressionPath(expression);
		return Boolean(path && namespaceBindings.has(path.root) && path.parts.length === 0);
	};
	const isTestReference = (expression) => {
		const path = expressionPath(expression);
		return Boolean(path && (testBindings.has(path.root)
			|| (namespaceBindings.has(path.root) && path.parts[0] === "test")));
	};
	const extendedTestCall = (expression) => {
		const candidate = unwrapExpression(expression);
		if (!ts.isCallExpression(candidate)) return null;
		const callee = unwrapExpression(candidate.expression);
		if (ts.isPropertyAccessExpression(callee)) {
			return callee.name.text === "extend" && isTestReference(callee.expression) ? candidate : null;
		}
		return ts.isElementAccessExpression(callee)
			&& Boolean(callee.argumentExpression)
			&& ts.isStringLiteralLike(callee.argumentExpression)
			&& callee.argumentExpression.text === "extend"
			&& isTestReference(callee.expression)
			? candidate
			: null;
	};
	const isExtendedTest = (expression) => Boolean(extendedTestCall(expression));

	// Test fixtures commonly wrap the imported binding before declaring cases. Resolve
	// only static variable bindings, to a fixed point, so normal aliases remain visible
	// without treating arbitrary helper calls or source text as Playwright tests.
	let bindingsChanged = true;
	while (bindingsChanged) {
		bindingsChanged = false;
		for (const declaration of variableDeclarations) {
			if (!declaration.initializer) continue;
			if (ts.isIdentifier(declaration.name)) {
				if (!namespaceBindings.has(declaration.name.text) && isNamespaceReference(declaration.initializer)) {
					namespaceBindings.add(declaration.name.text);
					bindingsChanged = true;
				}
				if (!testBindings.has(declaration.name.text)
					&& (isTestReference(declaration.initializer) || isExtendedTest(declaration.initializer))) {
					testBindings.add(declaration.name.text);
					bindingsChanged = true;
				}
			} else if (ts.isObjectBindingPattern(declaration.name) && isNamespaceReference(declaration.initializer)) {
				for (const element of declaration.name.elements) {
					if (bindingElementName(element) !== "test" || !ts.isIdentifier(element.name) || testBindings.has(element.name.text)) continue;
					testBindings.add(element.name.text);
					bindingsChanged = true;
				}
			}
		}
	}

	const resolveCallback = (expression) => {
		const candidate = unwrapExpression(expression);
		if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) return candidate;
		return ts.isIdentifier(candidate) ? callbackBindings.get(candidate.text) : undefined;
	};
	const fixtureFactoryCallbacks = (extendCall) => {
		const fixtureObject = extendCall.arguments[0] && unwrapExpression(extendCall.arguments[0]);
		if (!fixtureObject || !ts.isObjectLiteralExpression(fixtureObject)) return [];
		const callbacks = [];
		for (const property of fixtureObject.properties) {
			if (ts.isMethodDeclaration(property)) {
				callbacks.push(property);
				continue;
			}
			let initializer;
			if (ts.isPropertyAssignment(property)) initializer = property.initializer;
			else if (ts.isShorthandPropertyAssignment(property)) initializer = property.name;
			else continue;
			let candidate = unwrapExpression(initializer);
			if (ts.isArrayLiteralExpression(candidate)) {
				const first = candidate.elements[0];
				if (!first || ts.isOmittedExpression(first) || ts.isSpreadElement(first)) continue;
				candidate = unwrapExpression(first);
			}
			const callback = resolveCallback(candidate);
			if (callback) callbacks.push(callback);
		}
		return callbacks;
	};

	let browserFixture = null;
	const inspect = (node) => {
		if (browserFixture && browserImport) return;
		if (!browserImport && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
			const path = expressionPath(node);
			if (path && namespaceBindings.has(path.root) && API_BROWSER_PRIMITIVES.has(path.parts[0])) {
				browserImport = path.parts[0];
			} else {
				browserImport = loadedModulePrimitive(node);
			}
		}
		if (!browserImport && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
			const path = expressionPath(node.initializer);
			if (path && namespaceBindings.has(path.root) && path.parts.length === 0) {
				browserImport = node.name.elements.map(bindingElementName).find((name) => name && API_BROWSER_PRIMITIVES.has(name)) ?? null;
			}
		}
		if (!browserFixture && ts.isCallExpression(node)) {
			if (isTestReference(node.expression)) {
				for (const argument of node.arguments) {
					const callback = resolveCallback(argument);
					if (callback) browserFixture = browserFixtureInCallback(callback) ?? browserFixture;
				}
			}
			const extendCall = extendedTestCall(node);
			if (extendCall) {
				for (const callback of fixtureFactoryCallbacks(extendCall)) {
					browserFixture = browserFixtureInCallback(callback) ?? browserFixture;
				}
			}
		}
		ts.forEachChild(node, inspect);
	};
	inspect(sourceFile);
	return { browserFixture, browserImport };
}

function validateRunnerImports(filePath, source, owner) {
	const diagnostics = [];
	const sourceFile = parseTestSource(filePath, source);
	const importedModules = extractImportedModules(sourceFile);
	for (const moduleName of importedModules) {
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
		const { browserFixture, browserImport } = analyzePlaywrightApiUsage(sourceFile);
		if (browserFixture) {
			diagnostics.push(diagnostic(
				"api-browser-fixture",
				filePath,
				`${owner.pattern} is API/process-only and cannot request Playwright's "${browserFixture}" browser fixture; move real-browser coverage to tests/e2e/browser/**/*.browser-e2e.spec.ts.`,
				"tests/e2e/browser/**/*.browser-e2e.spec.ts",
			));
		}

		if (browserImport) {
			diagnostics.push(diagnostic(
				"api-browser-import",
				filePath,
				`${owner.pattern} cannot import or access Playwright browser primitive "${browserImport}"; move real-browser coverage to tests/e2e/browser/**/*.browser-e2e.spec.ts.`,
				"tests/e2e/browser/**/*.browser-e2e.spec.ts",
			));
		}

		const boundary = [...importedModules].find((moduleName) => /(?:^|\/)(?:_helpers|support)(?:\/.*)?\/browser(?:\/|[-.])/.test(moduleName));
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
	if (isDirectTestsRootExecutablePath(normalized)) {
		return [diagnostic(
			"direct-tests-root-executable",
			normalized,
			`Executable JavaScript and TypeScript cannot live directly under tests/. Real-model workflows belong at tests/manual/**/*.manual.spec.ts; real Git/worktree/process scripts belong at tests/e2e/node/**/*.node-e2e.test.ts; non-runnable shared code belongs under tests/support/{harnesses,helpers,fixtures,data,templates}/<lane>/.`,
		)];
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
