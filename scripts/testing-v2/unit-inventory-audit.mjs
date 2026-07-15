#!/usr/bin/env node
/**
 * Audits the current unit inventory against the branch merge base.
 *
 * Performance work may add tests or rearrange them between unit sub-projects,
 * but it must not remove a merge-base unit file or add a merge-base unit file
 * to the e2e exclusion list. Static declaration names are reported as a review
 * aid; parameterised tests can collect more than one runtime test per call.
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
const currentE2eSource = fs.readFileSync("scripts/testing-v2/integration-e2e-files.mjs", "utf-8");
const baseE2e = e2ePaths(baseE2eSource);
const currentE2e = e2ePaths(currentE2eSource);
const baseFiles = gitText(["ls-tree", "-r", "--name-only", mergeBase, "--", "tests2/core", "tests2/dom", "tests2/integration"])
	.trim().split(/\r?\n/).filter((file) => /\.test\.ts$/.test(file));
const baseUnit = baseFiles.filter((file) => !baseE2e.includes(file));
const currentFiles = [
	...currentTestFiles("tests2/core"),
	...currentTestFiles("tests2/dom"),
	...currentTestFiles("tests2/integration"),
];
const currentUnit = currentFiles.filter((file) => !currentE2e.includes(file));
const missingFiles = baseUnit.filter((file) => !currentUnit.includes(file));
const addedFiles = currentUnit.filter((file) => !baseUnit.includes(file));
const addedE2eExclusions = currentE2e.filter((file) => !baseE2e.includes(file));
const removedE2eExclusions = baseE2e.filter((file) => !currentE2e.includes(file));

let baseDeclarations = 0;
let currentDeclarations = 0;
const missingDeclarationNames = [];
for (const file of baseUnit) {
	const baseNames = staticTestNames(gitText(["show", `${mergeBase}:${file}`]), file);
	baseDeclarations += baseNames.length;
	if (!fs.existsSync(file)) continue;
	const currentNames = staticTestNames(fs.readFileSync(file, "utf-8"), file);
	currentDeclarations += currentNames.length;
	const unmatched = [...currentNames];
	for (const name of baseNames) {
		const index = unmatched.indexOf(name);
		if (index >= 0) unmatched.splice(index, 1);
		else missingDeclarationNames.push(`${file} :: ${name}`);
	}
}
let allCurrentDeclarations = 0;
for (const file of currentUnit) allCurrentDeclarations += staticTestNames(fs.readFileSync(file, "utf-8"), file).length;

const report = {
	mergeBase,
	upstream,
	baseUnitFiles: baseUnit.length,
	currentUnitFiles: currentUnit.length,
	missingBaseUnitFiles: missingFiles,
	addedUnitFiles: addedFiles,
	baseE2eExclusions: baseE2e.length,
	currentE2eExclusions: currentE2e.length,
	addedE2eExclusions,
	removedE2eExclusions,
	baseStaticTestDeclarations: baseDeclarations,
	currentStaticDeclarationsInBaseFiles: currentDeclarations,
	allCurrentStaticTestDeclarations: allCurrentDeclarations,
	missingBaseStaticDeclarationNames: missingDeclarationNames,
	inventoryPreserved: missingFiles.length === 0 && addedE2eExclusions.length === 0,
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, json, "utf-8");
}
process.stdout.write(json);
if (!report.inventoryPreserved) process.exitCode = 1;
