import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TEST_MAP = path.join(REPO_ROOT, "tests2", "tests-map.json");
const BLOCKED_MODULES = new Set(["child_process", "node:child_process", "worker_threads", "node:worker_threads"]);

type Violation = { file: string; line: number; reason: string };

function runtimeImport(declaration: ts.ImportDeclaration): boolean {
	const clause = declaration.importClause;
	if (!clause) return true;
	if (clause.isTypeOnly) return false;
	if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
	return clause.namedBindings.elements.some(element => !element.isTypeOnly);
}

function literalText(node: ts.Expression | undefined): string | undefined {
	return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node))
		? node.text
		: undefined;
}

function scanSource(file: string, source: string): Violation[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
			&& BLOCKED_MODULES.has(literalText(node.moduleReference.expression) ?? "")) {
			add(node, `runtime import-equals of ${literalText(node.moduleReference.expression)}`);
		} else if (ts.isExportDeclaration(node)
			&& !node.isTypeOnly
			&& node.moduleSpecifier
			&& ts.isStringLiteralLike(node.moduleSpecifier)
			&& BLOCKED_MODULES.has(node.moduleSpecifier.text)) {
			add(node, `runtime export from ${node.moduleSpecifier.text}`);
		} else if (ts.isCallExpression(node)) {
			const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
			const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const specifier = literalText(node.arguments[0]);
			if ((isRequire || isDynamicImport) && specifier && BLOCKED_MODULES.has(specifier)) {
				add(node, `${isRequire ? "require" : "dynamic import"} of ${specifier}`);
			}
		} else if (ts.isNewExpression(node)) {
			const name = ts.isIdentifier(node.expression)
				? node.expression.text
				: ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
			if (name === "Worker") add(node, "new Worker construction");
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

function localImports(file: string, source: string): string[] {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const specifiers: string[] = [];
	for (const statement of sourceFile.statements) {
		if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
			&& statement.moduleSpecifier
			&& ts.isStringLiteralLike(statement.moduleSpecifier)
			&& statement.moduleSpecifier.text.startsWith(".")) {
			specifiers.push(statement.moduleSpecifier.text);
		}
	}
	return specifiers;
}

function resolveOwnedHelper(fromFile: string, specifier: string): string | undefined {
	const unresolved = path.resolve(path.dirname(fromFile), specifier);
	const candidates = path.extname(unresolved)
		? [unresolved, unresolved.replace(/\.(?:m?js|cjs)$/u, ".ts"), unresolved.replace(/\.js$/u, ".tsx")]
		: [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, path.join(unresolved, "index.ts")];
	const coreRoot = path.join(REPO_ROOT, "tests2", "core");
	return candidates.find(candidate => {
		const relative = path.relative(coreRoot, candidate);
		return existsSync(candidate)
			&& !relative.startsWith("..")
			&& !path.isAbsolute(relative)
			&& (relative.split(path.sep).includes("helpers") || path.basename(relative).startsWith("affected-runner-"));
	});
}

function registeredTargets(): string[] {
	const testMap = JSON.parse(readFileSync(TEST_MAP, "utf8"));
	const paths = (testMap.v2Native as Array<{ path?: unknown }>)
		.map(entry => entry.path)
		.filter((value): value is string => typeof value === "string")
		.filter(value => /^tests2\/core\/affected-runner-(?:cli|git-cli)\.test\.ts$/u.test(value));
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
		for (const specifier of localImports(file, source)) {
			const helper = resolveOwnedHelper(file, specifier);
			if (helper && !targets.has(helper)) pending.push(helper);
		}
	}
	return [...targets].sort();
}

describe("affected runner Tier-1 no-escape guard", () => {
	it("derives registered runner matrices and their owned helpers from tests-map", () => {
		const relativeTargets = targetClosure().map(file => path.relative(REPO_ROOT, file).replace(/\\/gu, "/"));
		expect(relativeTargets).toEqual(expect.arrayContaining([
			"tests2/core/affected-runner-cli.test.ts",
			"tests2/core/affected-runner-git-cli.test.ts",
			"tests2/core/helpers/affected-runner-fixture.ts",
		]));
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
	])("rejects escape sample %#", (source, reason) => {
		expect(scanSource("sample.ts", source).map(violation => violation.reason).join("\n")).toContain(reason);
	});

	it("permits imports that are erased as types", () => {
		expect(scanSource("sample.ts", 'import type { ChildProcess } from "node:child_process";')).toEqual([]);
	});
});
