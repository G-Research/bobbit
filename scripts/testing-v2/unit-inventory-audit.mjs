#!/usr/bin/env node
/**
 * Audit the complete Vitest inventory, explicit execution ownership, declaration
 * semantics, the two approved E2E owners, and the tier-1 subprocess boundary.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
	APPROVED_E2E_VITEST_PATHS,
	loadVitestExecutionMap,
} from "./test-map-execution.mjs";
import { readOptionalGitPath } from "./unit-inventory-git.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};
const upstream = valueAfter("--upstream") ?? "origin/master";
const outputPath = valueAfter("--json");
const semanticMapPath = path.join("scripts", "testing-v2", "unit-declaration-semantic-map.json");
const semanticMappings = JSON.parse(fs.readFileSync(semanticMapPath, "utf-8"));
const execution = loadVitestExecutionMap();
const currentUnit = [...execution.unit];
const currentE2eVitestFiles = [...execution.e2e];
const currentInventory = [...execution.all];

function gitText(gitArgs) {
	return execFileSync("git", gitArgs, {
		encoding: "utf-8",
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

const mergeBase = gitText(["merge-base", "HEAD", upstream]).trim();

function e2ePaths(source) {
	return [...source.matchAll(/"(tests2\/integration\/[^"]+\.test\.ts)"/g)].map((match) => match[1]);
}

function staticTestNames(source, file) {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const names = [];
	const rootName = (node) => {
		if (ts.isIdentifier(node)) return node.text;
		if (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) return rootName(node.expression);
		return "";
	};
	const visit = (node) => {
		if (ts.isCallExpression(node) && ["it", "test"].includes(rootName(node.expression))) {
			const name = node.arguments[0];
			if (name && (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))) names.push(name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return names;
}

function childProcessValueImports(source, file) {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const violations = [];
	const isChildProcess = (node) => node && ts.isStringLiteralLike(node)
		&& (node.text === "node:child_process" || node.text === "child_process");
	const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
	const add = (node, kind) => violations.push(`${file}:${lineOf(node)} — ${kind}`);
	const visit = (node) => {
		if (ts.isImportDeclaration(node) && isChildProcess(node.moduleSpecifier)) {
			const clause = node.importClause;
			const hasValueBinding = !clause
				|| (!clause.isTypeOnly && (
					Boolean(clause.name)
					|| !clause.namedBindings
					|| ts.isNamespaceImport(clause.namedBindings)
					|| clause.namedBindings.elements.some((element) => !element.isTypeOnly)
				));
			if (hasValueBinding) add(node, "value import from child_process");
		} else if (ts.isImportEqualsDeclaration(node)
			&& ts.isExternalModuleReference(node.moduleReference)
			&& isChildProcess(node.moduleReference.expression)) {
			add(node, "import-equals from child_process");
		} else if (ts.isExportDeclaration(node) && isChildProcess(node.moduleSpecifier) && !node.isTypeOnly) {
			add(node, "value re-export from child_process");
		} else if (ts.isCallExpression(node) && node.arguments.length > 0 && isChildProcess(node.arguments[0])) {
			if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, "dynamic import of child_process");
			else if (ts.isIdentifier(node.expression) && node.expression.text === "require") add(node, "require of child_process");
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return violations;
}

const FILESYSTEM_MUTATORS = new Set([
	"appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync", "copyFile", "copyFileSync",
	"cp", "cpSync", "createWriteStream", "link", "linkSync", "mkdir", "mkdirSync", "rename", "renameSync",
	"rm", "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink",
	"unlinkSync", "utimes", "utimesSync", "writeFile", "writeFileSync",
]);

function concurrentPathOwnershipViolations(source, file) {
	const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const declarations = new Map();
	const declarationNodes = new Map();
	const calls = [];
	const visit = (node) => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			if (node.initializer) declarations.set(node.name.text, node.initializer);
			declarationNodes.set(node.name.text, node);
		} else if (ts.isBinaryExpression(node)
			&& node.operatorToken.kind === ts.SyntaxKind.EqualsToken
			&& ts.isIdentifier(node.left)
			&& !declarations.has(node.left.text)) {
			declarations.set(node.left.text, node.right);
		} else if (ts.isCallExpression(node)) calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	const textOf = (node) => node.getText(sourceFile);
	const contains = (node, predicate) => {
		let found = false;
		const walk = (child) => {
			if (predicate(child)) found = true;
			else ts.forEachChild(child, walk);
		};
		walk(node);
		return found;
	};
	const references = (node, name) => contains(node, (child) => ts.isIdentifier(child) && child.text === name);
	const leafName = (expression) => {
		if (ts.isIdentifier(expression)) return expression.text;
		if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
		return "";
	};
	const emptyFacts = () => ({ hasDate: false, hasOwner: false, pathLike: false, sharedPath: false });
	const memo = new Map();
	let analyse;
	const factsFor = (initializer, name = "", visiting = new Set()) => {
		const directText = textOf(initializer);
		const result = {
			hasDate: contains(initializer, (node) => ts.isCallExpression(node)
				&& ts.isPropertyAccessExpression(node.expression)
				&& node.expression.expression.getText(sourceFile) === "Date"
				&& node.expression.name.text === "now"),
			hasOwner: contains(initializer, (node) => (ts.isCallExpression(node) && /^(?:mkdtempSync|randomUUID|uuid)$/i.test(leafName(node.expression)))
				|| (ts.isPropertyAccessExpression(node) && node.expression.getText(sourceFile) === "process" && node.name.text === "pid")),
			pathLike: /(?:^|\W)(?:join|resolve|tmpdir|mkdtempSync)\s*\(/.test(directText)
				|| /(?:dir|root|path|cwd|file|worktree|report|tool)/i.test(name),
			sharedPath: /(?:tmpdir\s*\(|(?:tmp|temp|worktree|report|tool))/i.test(directText),
		};
		for (const dependency of declarations.keys()) {
			if (dependency === name || !references(initializer, dependency)) continue;
			const inherited = analyse(dependency, visiting);
			result.hasDate ||= inherited.hasDate;
			result.hasOwner ||= inherited.hasOwner;
			result.pathLike ||= inherited.pathLike;
			result.sharedPath ||= inherited.sharedPath;
		}
		return result;
	};
	analyse = (name, visiting = new Set()) => {
		if (memo.has(name)) return memo.get(name);
		if (visiting.has(name) || !declarations.has(name)) return emptyFacts();
		const result = factsFor(declarations.get(name), name, new Set(visiting).add(name));
		memo.set(name, result);
		return result;
	};

	const usedBy = (name, isSink) => calls.some((call) => isSink(leafName(call.expression))
		&& call.arguments.some((argument) => references(argument, name)));
	const mutated = (name) => usedBy(name, (callee) => FILESYSTEM_MUTATORS.has(callee)
		|| /^(?:cleanup|remove)(?:Dir|Directory|File|Path|Root)?$/i.test(callee));
	const externallyOwned = (name) => {
		const initializer = declarations.get(name);
		const directText = initializer ? textOf(initializer) : "";
		return /Date\.now\s*\(/.test(directText)
			&& /(?:tmpdir\s*\(|(?:tmp|temp|worktree|report|tool))/i.test(directText)
			&& (/(?:^|\W)(?:join|resolve|tmpdir)\s*\(/.test(directText) || /(?:dir|root|path|cwd|file|worktree|report|tool)/i.test(name))
			&& usedBy(name, (callee) => /^(?:(?:api|admin|rawApi)Fetch|registerProject|callTool)$/i.test(callee));
	};
	const isUnsafe = (facts) => facts.hasDate && !facts.hasOwner && facts.pathLike && facts.sharedPath;
	const unsafeNames = [...declarations.keys()].filter((name) => isUnsafe(analyse(name)) && (mutated(name) || externallyOwned(name)));
	const violation = (node, label) => {
		const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
		return `${file}:${line} — concurrent isolate:false filesystem path ${label} uses Date.now() as its only owner token and is mutated or cleaned; use mkdtempSync, process.pid, randomUUID()/UUID, or place it beneath a clearly unique owner root`;
	};
	const violations = unsafeNames.map((name) => violation(declarationNodes.get(name) ?? declarations.get(name), JSON.stringify(name)));
	for (const call of calls) {
		const callee = leafName(call.expression);
		if (!FILESYSTEM_MUTATORS.has(callee) && !/^(?:cleanup|remove)(?:Dir|Directory|File|Path|Root)?$/i.test(callee)) continue;
		for (const argument of call.arguments) {
			if (!/Date\.now\s*\(/.test(textOf(argument))
				|| !isUnsafe(factsFor(argument))
				|| unsafeNames.some((name) => references(argument, name))) continue;
			violations.push(violation(argument, "expression"));
		}
	}
	return violations;
}

const historicalE2ePath = "scripts/testing-v2/integration-e2e-files.mjs";
const baseE2eSource = readOptionalGitPath(gitText, { path: historicalE2ePath, revision: mergeBase });
const formerlyRelocatedE2e = e2ePaths(baseE2eSource);
const requiredUnitFiles = gitText(["ls-tree", "-r", "--name-only", mergeBase, "--", "tests2/core", "tests2/dom", "tests2/integration"])
	.trim().split(/\r?\n/).filter((file) => /\.test\.ts$/.test(file));
const missingFiles = requiredUnitFiles.filter((file) => !currentInventory.includes(file));
const addedFiles = currentInventory.filter((file) => !requiredUnitFiles.includes(file));
const restoredFormerE2eFiles = formerlyRelocatedE2e.filter((file) => currentInventory.includes(file));

let baseDeclarations = 0;
let currentDeclarations = 0;
const missingDeclarations = [];
for (const file of requiredUnitFiles) {
	const baseNames = staticTestNames(gitText(["show", `${mergeBase}:${file}`]), file);
	baseDeclarations += baseNames.length;
	if (!fs.existsSync(file)) continue;
	const currentNames = staticTestNames(fs.readFileSync(file, "utf-8"), file);
	currentDeclarations += currentNames.length;
	const unmatched = [...currentNames];
	for (const name of baseNames) {
		const index = unmatched.indexOf(name);
		if (index >= 0) unmatched.splice(index, 1);
		else missingDeclarations.push({ file, name });
	}
}
let allCurrentDeclarations = 0;
const currentNamesByFile = new Map();
for (const file of currentInventory) {
	const names = staticTestNames(fs.readFileSync(file, "utf-8"), file);
	currentNamesByFile.set(file, names);
	allCurrentDeclarations += names.length;
}

const declarationKey = (file, name) => `${file}\0${name}`;
const missingKeys = new Set(missingDeclarations.map(({ file, name }) => declarationKey(file, name)));
const mappingByBase = new Map();
const invalidSemanticMappings = [];
for (const mapping of semanticMappings) {
	const key = declarationKey(mapping.baseFile, mapping.baseName);
	if (mappingByBase.has(key)) {
		invalidSemanticMappings.push(`${mapping.baseFile} :: ${mapping.baseName} — duplicate mapping`);
		continue;
	}
	mappingByBase.set(key, mapping);
	if (!missingKeys.has(key)) invalidSemanticMappings.push(`${mapping.baseFile} :: ${mapping.baseName} — stale mapping; base declaration is not missing`);
	if (!mapping.rationale?.trim()) invalidSemanticMappings.push(`${mapping.baseFile} :: ${mapping.baseName} — missing rationale`);
	if (!Array.isArray(mapping.current) || mapping.current.length === 0) {
		invalidSemanticMappings.push(`${mapping.baseFile} :: ${mapping.baseName} — no current semantic owner`);
		continue;
	}
	for (const target of mapping.current) {
		if (!currentNamesByFile.get(target.file)?.includes(target.name)) {
			invalidSemanticMappings.push(`${mapping.baseFile} :: ${mapping.baseName} — target not found: ${target.file} :: ${target.name}`);
		}
	}
}
const mappedDeclarations = missingDeclarations.filter(({ file, name }) => mappingByBase.has(declarationKey(file, name)));
const unmappedDeclarations = missingDeclarations.filter(({ file, name }) => !mappingByBase.has(declarationKey(file, name)));
const declarationSemanticsPreserved = unmappedDeclarations.length === 0 && invalidSemanticMappings.length === 0;
const childProcessImports = currentUnit.flatMap((file) => childProcessValueImports(fs.readFileSync(file, "utf-8"), file));
const concurrentPathViolations = [...execution.core, ...execution.integration]
	.flatMap((file) => concurrentPathOwnershipViolations(fs.readFileSync(file, "utf-8"), file));
const approvedE2e = [...APPROVED_E2E_VITEST_PATHS].sort();
const e2eOwnershipExact = JSON.stringify(currentE2eVitestFiles) === JSON.stringify(approvedE2e);
const scheduledInventoryPreserved = currentUnit.length + currentE2eVitestFiles.length === currentInventory.length;

const report = {
	mergeBase,
	upstream,
	requiredMergeBaseUnitFiles: requiredUnitFiles.length,
	currentVitestInventoryFiles: currentInventory.length,
	scheduledUnitFiles: currentUnit.length,
	scheduledE2eVitestFiles: currentE2eVitestFiles.length,
	missingRequiredUnitFiles: missingFiles,
	addedUnitFiles: addedFiles,
	formerlyRelocatedE2eFiles: formerlyRelocatedE2e.length,
	restoredFormerE2eFiles: restoredFormerE2eFiles.length,
	approvedE2eVitestFiles: approvedE2e,
	currentE2eVitestFiles,
	e2eOwnershipExact,
	scheduledInventoryPreserved,
	isolatedFiles: execution.isolated,
	childProcessValueImports: childProcessImports,
	concurrentPathOwnershipViolations: concurrentPathViolations,
	baseStaticTestDeclarations: baseDeclarations,
	currentStaticDeclarationsInBaseFiles: currentDeclarations,
	allCurrentStaticTestDeclarations: allCurrentDeclarations,
	missingBaseStaticDeclarationNames: missingDeclarations.map(({ file, name }) => `${file} :: ${name}`),
	mappedBaseStaticDeclarations: mappedDeclarations.map(({ file, name }) => {
		const mapping = mappingByBase.get(declarationKey(file, name));
		return {
			base: `${file} :: ${name}`,
			current: mapping.current.map((target) => `${target.file} :: ${target.name}`),
			rationale: mapping.rationale,
		};
	}),
	unmappedBaseStaticDeclarationNames: unmappedDeclarations.map(({ file, name }) => `${file} :: ${name}`),
	invalidSemanticMappings,
	declarationSemanticsPreserved,
	inventoryPreserved: missingFiles.length === 0
		&& restoredFormerE2eFiles.length === formerlyRelocatedE2e.length
		&& declarationSemanticsPreserved
		&& scheduledInventoryPreserved
		&& e2eOwnershipExact
		&& childProcessImports.length === 0
		&& concurrentPathViolations.length === 0,
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, json, "utf-8");
}
process.stdout.write(json);
if (!report.inventoryPreserved) process.exitCode = 1;
