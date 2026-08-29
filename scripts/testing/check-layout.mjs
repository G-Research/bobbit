#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectIntroducedPaths, parseNullDelimitedGitPaths } from "../testing-v2/unit-inventory-git.mjs";
import {
	classifyTestPath,
	classifyTransitionalTestPath,
	isRunnableTestPath,
	normalizeTestPath,
	validateTestInventory,
	validateTestPath,
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

function gitText(args, root = REPO_ROOT) {
	return gitOutput(args, root).toString("utf8").trim();
}

export function listRepositoryFiles(root = REPO_ROOT, readGitOutput = gitOutput) {
	return parseNullDelimitedGitPaths(readGitOutput(
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		root,
	));
}

export function resolveMergeBase(root = REPO_ROOT, upstream, readGitText = gitText) {
	let selected = upstream;
	if (!selected) {
		try {
			selected = readGitText(["symbolic-ref", "refs/remotes/origin/HEAD"], root);
		} catch {
			selected = "origin/main";
		}
	}
	const mergeBase = readGitText(["merge-base", "HEAD", selected], root);
	if (!/^[0-9a-f]{40,64}$/i.test(mergeBase)) {
		throw new Error(`git merge-base returned an invalid revision for ${selected}: ${JSON.stringify(mergeBase)}`);
	}
	return { mergeBase, upstream: selected };
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

/** Validate only canonical inventory and paths introduced during the transition. */
export function collectLayoutDiagnostics({
	root = REPO_ROOT,
	allPaths,
	introducedPaths,
	fileExists = existsSync,
	readSource = (absolutePath) => readFileSync(absolutePath, "utf8"),
} = {}) {
	if (!allPaths || !introducedPaths) throw new Error("allPaths and introducedPaths are required");
	const sourceForPath = safeSourceReader(root, fileExists, readSource);
	const canonicalPaths = allPaths.filter((filePath) => classifyTestPath(filePath));
	const diagnostics = validateTestInventory(canonicalPaths, sourceForPath);
	for (const filePath of [...new Set(introducedPaths.map(normalizeTestPath))].sort()) {
		// Canonical paths were source-validated with the complete inventory above.
		if (classifyTestPath(filePath)) continue;
		diagnostics.push(...validateTestPath(filePath, isRunnableTestPath(filePath) ? sourceForPath(filePath) : undefined));
	}
	return diagnostics;
}

export function countLayoutState(paths) {
	let canonical = 0;
	let transitional = 0;
	let unowned = 0;
	for (const filePath of new Set(paths.map(normalizeTestPath))) {
		if (!isRunnableTestPath(filePath)) continue;
		if (classifyTestPath(filePath)) canonical += 1;
		else if (classifyTransitionalTestPath(filePath)) transitional += 1;
		else unowned += 1;
	}
	return Object.freeze({ canonical, transitional, unowned, runnable: canonical + transitional + unowned });
}

export function formatLayoutDiagnostics(diagnostics) {
	return diagnostics.map(({ code, path, message }) => `  - [${code}] ${path}: ${message}`).join("\n");
}

export function auditLayout({ root = REPO_ROOT, upstream, readGitOutput = gitOutput, readGitText = gitText } = {}) {
	const base = resolveMergeBase(root, upstream, readGitText);
	const allPaths = listRepositoryFiles(root, readGitOutput);
	const introducedPaths = collectIntroducedPaths((args) => readGitOutput(args, root), { mergeBase: base.mergeBase });
	const diagnostics = collectLayoutDiagnostics({ root, allPaths, introducedPaths });
	return Object.freeze({ ...base, allPaths, introducedPaths, diagnostics, counts: countLayoutState(allPaths) });
}

export function main(argv = process.argv.slice(2)) {
	const upstreamIndex = argv.indexOf("--upstream");
	const upstream = upstreamIndex >= 0 ? argv[upstreamIndex + 1] : process.env.BOBBIT_TEST_LAYOUT_UPSTREAM;
	try {
		const { diagnostics, counts, introducedPaths, mergeBase } = auditLayout({ upstream });
		if (diagnostics.length > 0) {
			console.error(`test-layout: FAIL (${diagnostics.length} violation${diagnostics.length === 1 ? "" : "s"})`);
			console.error(formatLayoutDiagnostics(diagnostics));
			return 1;
		}
		console.log(`test-layout: PASS — ${counts.canonical} canonical, ${counts.transitional} transitional, ${counts.unowned} legacy/unowned, ${counts.runnable} runnable-shaped total.`);
		console.log(`  validated ${introducedPaths.length} introduced path(s) since ${mergeBase}`);
		return 0;
	} catch (error) {
		console.error(`test-layout: unable to audit repository: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) process.exitCode = main();
