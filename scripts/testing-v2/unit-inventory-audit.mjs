#!/usr/bin/env node
/**
 * Audits the current unit inventory against the branch merge base.
 *
 * Performance work may add tests or rearrange them between unit sub-projects,
 * but every merge-base core/DOM/integration file—including the twelve files
 * formerly relocated to E2E—must remain in the unit gate. Static declaration
 * names are reported as a review aid; parameterised tests can collect more than
 * one runtime test per call.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
};
const upstream = valueAfter("--upstream") ?? "origin/master";
const outputPath = valueAfter("--json");
const semanticMapPath = path.join("scripts", "testing-v2", "unit-declaration-semantic-map.json");
const semanticMappings = JSON.parse(fs.readFileSync(semanticMapPath, "utf-8"));
const testsMap = JSON.parse(fs.readFileSync(path.join("tests2", "tests-map.json"), "utf-8"));
const currentE2eVitestFiles = (testsMap.entries ?? [])
	.filter((entry) => (entry.tier ?? entry.bucket) === "daily" && entry.method === "vitest-e2e")
	.map((entry) => entry.v2Path ?? entry.file)
	.filter(Boolean)
	.sort();
const mergeBase = execFileSync("git", ["merge-base", "HEAD", upstream], { encoding: "utf-8" }).trim();

function gitText(gitArgs) {
	return execFileSync("git", gitArgs, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
}

function e2ePaths(source) {
	return [...source.matchAll(/"(tests2\/integration\/[^"]+\.test\.ts)"/g)].map((match) => match[1]);
}

function currentTestFiles(root, out = []) {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) currentTestFiles(file, out);
		else if (/\.test\.ts$/.test(entry.name)) out.push(file.split(path.sep).join("/"));
	}
	return out;
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

const baseE2eSource = gitText(["show", `${mergeBase}:scripts/testing-v2/integration-e2e-files.mjs`]);
const formerlyRelocatedE2e = e2ePaths(baseE2eSource);
const requiredUnitFiles = gitText(["ls-tree", "-r", "--name-only", mergeBase, "--", "tests2/core", "tests2/dom", "tests2/integration"])
	.trim().split(/\r?\n/).filter((file) => /\.test\.ts$/.test(file));
const currentUnit = [
	...currentTestFiles("tests2/core"),
	...currentTestFiles("tests2/dom"),
	...currentTestFiles("tests2/integration"),
];
const missingFiles = requiredUnitFiles.filter((file) => !currentUnit.includes(file));
const addedFiles = currentUnit.filter((file) => !requiredUnitFiles.includes(file));
const restoredFormerE2eFiles = formerlyRelocatedE2e.filter((file) => currentUnit.includes(file));

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
for (const file of currentUnit) {
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
	if (!missingKeys.has(key)) {
		invalidSemanticMappings.push(`${mapping.baseFile} :: ${mapping.baseName} — stale mapping; base declaration is not missing`);
	}
	if (!mapping.rationale?.trim()) {
		invalidSemanticMappings.push(`${mapping.baseFile} :: ${mapping.baseName} — missing rationale`);
	}
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

const report = {
	mergeBase,
	upstream,
	requiredMergeBaseUnitFiles: requiredUnitFiles.length,
	currentUnitFiles: currentUnit.length,
	missingRequiredUnitFiles: missingFiles,
	addedUnitFiles: addedFiles,
	formerlyRelocatedE2eFiles: formerlyRelocatedE2e.length,
	restoredFormerE2eFiles: restoredFormerE2eFiles.length,
	currentE2eExclusions: currentE2eVitestFiles.length,
	currentE2eVitestFiles,
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
		&& declarationSemanticsPreserved,
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, json, "utf-8");
}
process.stdout.write(json);
if (!report.inventoryPreserved) process.exitCode = 1;
