import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CORE_ROOT = path.join(REPO_ROOT, "tests2", "core");
const TEST_MAP = path.join(REPO_ROOT, "tests2", "tests-map.json");
const GUARD_BASENAME = "affected-runner-no-escape.test.ts";
const BLOCKED_MODULES = new Set(["child_process", "node:child_process", "worker_threads", "node:worker_threads"]);

type Violation = { file: string; line: number; reason: string };

function runtimeImport(declaration: ts.ImportDeclaration): boolean {
	const clause = declaration.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
	return clause.namedBindings.elements.some(element => !element.isTypeOnly);
}

function runtimeExport(declaration: ts.ExportDeclaration): boolean {
	if (declaration.isTypeOnly) return false;
	if (!declaration.exportClause || ts.isNamespaceExport(declaration.exportClause)) return true;
	return declaration.exportClause.elements.some(element => !element.isTypeOnly);
}

function literalText(node: ts.Expression | undefined): string | undefined {
	return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;
}

function constInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
	const initializers = new Map<string, ts.Expression>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node)
			&& ts.isIdentifier(node.name)
			&& node.initializer
			&& ts.isVariableDeclarationList(node.parent)
			&& (node.parent.flags & ts.NodeFlags.Const) !== 0) {
			initializers.set(node.name.text, node.initializer);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return initializers;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;
	while (ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isSatisfiesExpression(current)
		|| ts.isNonNullExpression(current)) {
		current = current.expression;
	}
	return current;
}

function staticText(
	expression: ts.Expression | undefined,
	initializers: Map<string, ts.Expression>,
	seen = new Set<string>(),
): string | undefined {
	if (!expression) return undefined;
	const node = unwrapExpression(expression);
	const literal = literalText(node);
	if (literal !== undefined) return literal;
	if (ts.isIdentifier(node)) {
		if (seen.has(node.text)) return undefined;
		const initializer = initializers.get(node.text);
		if (!initializer) return undefined;
		return staticText(initializer, initializers, new Set([...seen, node.text]));
	}
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = staticText(node.left, initializers, seen);
		const right = staticText(node.right, initializers, seen);
		return left === undefined || right === undefined ? undefined : left + right;
	}
	if (ts.isTemplateExpression(node)) {
		let value = node.head.text;
		for (const span of node.templateSpans) {
			const interpolation = staticText(span.expression, initializers, seen);
			if (interpolation === undefined) return undefined;
			value += interpolation + span.literal.text;
		}
		return value;
	}
	return undefined;
}

function resolvesAlias(
	expression: ts.Expression,
	target: "require" | "Worker",
	initializers: Map<string, ts.Expression>,
	seen = new Set<string>(),
): boolean {
	const node = unwrapExpression(expression);
	if (ts.isIdentifier(node)) {
		if (node.text === target) return true;
		if (seen.has(node.text)) return false;
		const initializer = initializers.get(node.text);
		return Boolean(initializer && resolvesAlias(initializer, target, initializers, new Set([...seen, node.text])));
	}
	return target === "Worker" && ts.isPropertyAccessExpression(node) && node.name.text === "Worker";
}

function scanSource(file: string, source: string): Violation[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const initializers = constInitializers(sourceFile);
	const violations: Violation[] = [];
	const add = (node: ts.Node, reason: string): void => {
		const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		violations.push({ file, line: line + 1, reason });
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)
			&& BLOCKED_MODULES.has(node.moduleSpecifier.text) && runtimeImport(node)) {
			add(node, `runtime import of ${node.moduleSpecifier.text}`);
		} else if (ts.isImportEqualsDeclaration(node)
			&& !node.isTypeOnly
			&& ts.isExternalModuleReference(node.moduleReference)
			&& BLOCKED_MODULES.has(staticText(node.moduleReference.expression, initializers) ?? "")) {
			add(node, `runtime import-equals of ${staticText(node.moduleReference.expression, initializers)}`);
		} else if (ts.isExportDeclaration(node)
			&& runtimeExport(node)
			&& node.moduleSpecifier
			&& ts.isStringLiteralLike(node.moduleSpecifier)
			&& BLOCKED_MODULES.has(node.moduleSpecifier.text)) {
			add(node, `runtime export from ${node.moduleSpecifier.text}`);
		} else if (ts.isCallExpression(node)) {
			const isRequire = resolvesAlias(node.expression, "require", initializers);
			const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const literalSpecifier = literalText(node.arguments[0]);
			const specifier = staticText(node.arguments[0], initializers);
			if ((isRequire || isDynamicImport) && specifier && BLOCKED_MODULES.has(specifier)) {
				add(node, `${isRequire ? "require" : "dynamic import"} of ${specifier}`);
			} else if ((isRequire || isDynamicImport) && literalSpecifier === undefined) {
				add(node, `non-literal ${isRequire ? "require" : "dynamic import"} escape`);
			}
		} else if (ts.isNewExpression(node) && resolvesAlias(node.expression, "Worker", initializers)) {
			add(node, "new Worker construction");
		}

		if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			const embedded = node.text;
			const embedsBlockedImport = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["'](?:node:)?(?:child_process|worker_threads)["']/u.test(embedded);
			if (embedsBlockedImport || /\bnew\s+Worker\s*\(/u.test(embedded)) {
				add(node, "embedded worker/subprocess source");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return violations;
}

function localRuntimeSpecifiers(file: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const initializers = constInitializers(sourceFile);
	const specifiers = new Set<string>();
	const addLocal = (value: string | undefined): void => {
		if (value?.startsWith(".")) specifiers.add(value);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && runtimeImport(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
			addLocal(node.moduleSpecifier.text);
		} else if (ts.isExportDeclaration(node)
			&& runtimeExport(node)
			&& node.moduleSpecifier
			&& ts.isStringLiteralLike(node.moduleSpecifier)) {
			addLocal(node.moduleSpecifier.text);
		} else if (ts.isImportEqualsDeclaration(node)
			&& !node.isTypeOnly
			&& ts.isExternalModuleReference(node.moduleReference)) {
			addLocal(literalText(node.moduleReference.expression));
		} else if (ts.isCallExpression(node)) {
			const isRequire = resolvesAlias(node.expression, "require", initializers);
			const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			if (isRequire || isDynamicImport) addLocal(literalText(node.arguments[0]));
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return [...specifiers];
}

function candidatePaths(fromFile: string, specifier: string): string[] {
	const unresolved = path.resolve(path.dirname(fromFile), specifier);
	if (/\.(?:[cm]?[jt]sx?)$/u.test(unresolved)) {
		const candidates = [unresolved];
		if (/\.mjs$/u.test(unresolved)) candidates.push(unresolved.replace(/\.mjs$/u, ".mts"));
		else if (/\.cjs$/u.test(unresolved)) candidates.push(unresolved.replace(/\.cjs$/u, ".cts"));
		else if (/\.jsx?$/u.test(unresolved)) {
			candidates.push(unresolved.replace(/\.jsx?$/u, ".ts"), unresolved.replace(/\.jsx?$/u, ".tsx"));
		}
		return candidates;
	}
	return [
		unresolved,
		...([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"] as const).map(extension => `${unresolved}${extension}`),
		...(["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.mjs", "index.cjs"] as const)
			.map(index => path.join(unresolved, index)),
	];
}

function resolveOwnedDependency(fromFile: string, specifier: string): string | undefined {
	return candidatePaths(fromFile, specifier).find(candidate => {
		const relative = path.relative(CORE_ROOT, candidate);
		return existsSync(candidate)
			&& !relative.startsWith("..")
			&& !path.isAbsolute(relative)
			&& path.basename(relative).startsWith("affected-runner-");
	});
}

function isRunnerMatrix(relative: string): boolean {
	return relative.startsWith("tests2/core/affected-runner-")
		&& relative.endsWith(".test.ts")
		&& path.posix.basename(relative) !== GUARD_BASENAME;
}

function registeredTargets(): string[] {
	const testMap = JSON.parse(readFileSync(TEST_MAP, "utf8"));
	const paths = (testMap.v2Native as Array<{ path?: unknown }>)
		.map(entry => entry.path)
		.filter((value): value is string => typeof value === "string")
		.filter(isRunnerMatrix);
	return paths.map(relative => path.join(REPO_ROOT, ...relative.split("/")));
}

function targetClosure(): string[] {
	const pending = registeredTargets();
	const targets = new Set<string>();
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (targets.has(file)) continue;
		targets.add(file);
		const source = readFileSync(file, "utf8");
		for (const specifier of localRuntimeSpecifiers(file, source)) {
			const dependency = resolveOwnedDependency(file, specifier);
			if (dependency && !targets.has(dependency)) pending.push(dependency);
		}
	}
	return [...targets].sort();
}

function relativeTargets(): string[] {
	return targetClosure().map(file => path.relative(REPO_ROOT, file).replace(/\\/gu, "/"));
}

describe("affected runner Tier-1 no-escape guard", () => {
	it("derives every registered runner matrix and its owned runtime dependencies from tests-map", () => {
		const registered = registeredTargets().map(file => path.relative(REPO_ROOT, file).replace(/\\/gu, "/")).sort();
		const targets = relativeTargets();
		expect(registered).toEqual(expect.arrayContaining([
			"tests2/core/affected-runner-cli.test.ts",
			"tests2/core/affected-runner-git-cli.test.ts",
		]));
		expect(targets).toEqual(expect.arrayContaining([
			...registered,
			"tests2/core/helpers/affected-runner-fixture.ts",
		]));
	});

	it("follows runtime static, export, literal dynamic-import, and literal require dependencies only", () => {
		const source = [
			'import "./affected-runner-static.js";',
			'export { fixture } from "./affected-runner-export.js";',
			'await import("./affected-runner-dynamic.js");',
			'const fixture = require("./affected-runner-required.js");',
			'const load = require; load("./affected-runner-required-renamed.js");',
			'import type { Fixture } from "./affected-runner-type-only.js";',
			'export type { OtherFixture } from "./affected-runner-export-type-only.js";',
			'type LazyFixture = import("./affected-runner-import-type-only.js").Fixture;',
		].join("\n");
		expect(localRuntimeSpecifiers("sample.ts", source).sort()).toEqual([
			"./affected-runner-dynamic.js",
			"./affected-runner-export.js",
			"./affected-runner-required-renamed.js",
			"./affected-runner-required.js",
			"./affected-runner-static.js",
		]);
	});

	it("contains no subprocess, worker, dynamic-import, or embedded-script escape", () => {
		const violations = targetClosure().flatMap(file => scanSource(
			path.relative(REPO_ROOT, file).replace(/\\/gu, "/"),
			readFileSync(file, "utf8"),
		));
		expect(violations).toEqual([]);
	});

	it.each([
		['import { spawnSync } from "node:child_process";', "runtime import"],
		['const cp = require("child_process");', "require"],
		['await import("node:worker_threads");', "dynamic import"],
		['const worker = new Worker("fixture.mjs");', "new Worker"],
		['const source = `import { spawn } from "node:child_process";`;', "embedded"],
		['const load = require; load("node:child_process");', "require"],
		['const family = "worker_threads"; await import(`node:${family}`);', "dynamic import"],
		['await import(process.env.ESCAPE_TARGET);', "non-literal dynamic import escape"],
		['const Thread = globalThis.Worker; new Thread("fixture.mjs");', "new Worker"],
	])("rejects direct, renamed, or computed escape sample %#", (source, reason) => {
		expect(scanSource("sample.ts", source).map(violation => violation.reason).join("\n")).toContain(reason);
	});

	it("permits imports and exports that are erased as types", () => {
		const source = [
			'import type { ChildProcess } from "node:child_process";',
			'import { type Worker } from "node:worker_threads";',
			'export type { ChildProcess } from "child_process";',
			'type Child = import("node:child_process").ChildProcess;',
		].join("\n");
		expect(scanSource("sample.ts", source)).toEqual([]);
	});
});
