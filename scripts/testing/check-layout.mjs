#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTestPath, validateTestInventory } from "./layout-policy.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..", "..");

/** Git's -z output is the only safe way to preserve spaces and newlines in file names. */
export function parseGitFileList(output) {
	const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output);
	return text.split("\0").filter((filePath) => filePath.length > 0);
}

export function listRepositoryFiles(root = REPO_ROOT, execFile = execFileSync) {
	const output = execFile(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
	);
	return parseGitFileList(output);
}

/**
 * Scan committed, staged, and untracked files. Dependencies are injectable so
 * the NUL protocol and source checks can be tested without mutating a real repo.
 */
export function collectLayoutDiagnostics({
	root = REPO_ROOT,
	listFiles = listRepositoryFiles,
	fileExists = existsSync,
	readSource = (absolutePath) => readFileSync(absolutePath, "utf8"),
} = {}) {
	const listed = listFiles(root);
	// `git ls-files --cached` includes an unstaged worktree deletion. It is not a
	// test that a runner can discover, so leave it to Git status rather than emit
	// a stale placement error. Unsafe synthetic paths stay in the inventory for
	// validation, but are never resolved or read outside the repository root.
	const paths = listed.filter((filePath) => {
		const normalized = normalizeTestPath(filePath);
		const unsafe = filePath.includes("\0")
			|| /^(?:[A-Za-z]:\/|\/)/.test(normalized)
			|| normalized.split("/").some((part) => part === "." || part === "..");
		return unsafe || fileExists(resolve(root, ...normalized.split("/")));
	});
	return validateTestInventory(paths, (filePath) => {
		if (filePath.includes("\0") || /^(?:[A-Za-z]:\/|\/)/.test(filePath) || filePath.split("/").some((part) => part === "." || part === "..")) {
			return undefined;
		}
		try {
			return readSource(resolve(root, ...filePath.split("/")));
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
			throw error;
		}
	});
}

export function formatLayoutDiagnostics(diagnostics) {
	return diagnostics.map(({ code, path, message }) => `  - [${code}] ${path}: ${message}`).join("\n");
}

export function main() {
	let diagnostics;
	try {
		diagnostics = collectLayoutDiagnostics();
	} catch (error) {
		console.error(`test-layout: unable to inventory repository files: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
	if (diagnostics.length > 0) {
		console.error(`test-layout: FAIL (${diagnostics.length} violation${diagnostics.length === 1 ? "" : "s"})`);
		console.error(formatLayoutDiagnostics(diagnostics));
		return 1;
	}
	console.log("test-layout: PASS — every test source is canonically placed and every runnable test has exactly one owner.");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
	process.exitCode = main();
}
