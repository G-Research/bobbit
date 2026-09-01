#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNullDelimitedGitPaths } from "./git-paths.mjs";
import {
	classifyTestPath,
	isRunnableTestPath,
	normalizeTestPath,
	validateTestInventory,
} from "./layout-policy.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..", "..");

function gitOutput(args, root = REPO_ROOT) {
	return execFileSync("git", args, {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

export function listRepositoryFiles(root = REPO_ROOT, readGitOutput = gitOutput) {
	return parseNullDelimitedGitPaths(readGitOutput(
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		root,
	));
}

function safeSourceReader(root, fileExists, readSource) {
	return (filePath) => {
		const normalized = normalizeTestPath(filePath);
		if (filePath.includes("\0")
			|| /^(?:[A-Za-z]:\/|\/)/.test(normalized)
			|| normalized.split("/").some((part) => part === "." || part === "..")) return undefined;
		const absolutePath = resolve(root, ...normalized.split("/"));
		if (!fileExists(absolutePath)) return undefined;
		return readSource(absolutePath);
	};
}

/** Validate the complete runnable inventory so every runnable path must have one canonical owner. */
export function collectLayoutDiagnostics({
	root = REPO_ROOT,
	allPaths,
	fileExists = existsSync,
	readSource = (absolutePath) => readFileSync(absolutePath, "utf8"),
} = {}) {
	if (!allPaths) throw new Error("allPaths is required");
	return validateTestInventory(allPaths.filter(isRunnableTestPath), safeSourceReader(root, fileExists, readSource));
}

export function countLayoutState(paths) {
	let canonical = 0;
	let unowned = 0;
	for (const filePath of new Set(paths.map(normalizeTestPath))) {
		if (!isRunnableTestPath(filePath)) continue;
		if (classifyTestPath(filePath)) canonical += 1;
		else unowned += 1;
	}
	return Object.freeze({ canonical, unowned, runnable: canonical + unowned });
}

export function formatLayoutDiagnostics(diagnostics) {
	return diagnostics.map(({ code, path, message }) => `  - [${code}] ${path}: ${message}`).join("\n");
}

export function auditLayout({ root = REPO_ROOT, readGitOutput = gitOutput } = {}) {
	const allPaths = listRepositoryFiles(root, readGitOutput);
	const diagnostics = collectLayoutDiagnostics({ root, allPaths });
	return Object.freeze({ allPaths, diagnostics, counts: countLayoutState(allPaths) });
}

export function main() {
	try {
		const { diagnostics, counts } = auditLayout();
		if (diagnostics.length > 0) {
			console.error(`test-layout: FAIL (${diagnostics.length} violation${diagnostics.length === 1 ? "" : "s"})`);
			console.error(formatLayoutDiagnostics(diagnostics));
			return 1;
		}
		console.log(`test-layout: PASS — ${counts.canonical} canonical, ${counts.unowned} legacy/unowned, ${counts.runnable} runnable-shaped total.`);
		return 0;
	} catch (error) {
		console.error(`test-layout: unable to audit repository: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) process.exitCode = main();
