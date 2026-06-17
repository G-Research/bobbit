import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectPrimaryBranch } from "../src/server/skills/git.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [path.join(repoRoot, "src", "app"), path.join(repoRoot, "src", "ui")];
const ineffectiveDynamicImportTargets = new Set([
	"side-panel-workspace",
	"shortcut-registry",
	"proposal-panels-lazy",
	"render",
	"api",
	"routing",
	"preview-panel",
	"gate-status-events",
]);

/**
 * Temporary escape hatch for intentionally shared eager modules. Keep this small
 * and require a rationale so new Rollup INEFFECTIVE_DYNAMIC_IMPORT warnings are
 * either fixed or consciously documented in the regression test.
 */
const allowedIneffectiveDynamicImports: Record<string, string> = {
	// Example key: "src/app/example.ts -> src/app/already-eager.ts"
};

function normalizePath(p: string): string {
	return path.relative(repoRoot, p).split(path.sep).join("/");
}

function walkTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkTsFiles(full).forEach((f) => out.push(f));
		} else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isTypeOnlyImportClause(clause: string | undefined): boolean {
	if (!clause) return false; // side-effect import
	const trimmed = clause.trim();
	if (!trimmed || trimmed.startsWith("type ")) return true;
	const named = trimmed.match(/^\{([\s\S]*)\}$/);
	if (!named) return false; // default or namespace import is a runtime value
	const specifiers = named[1].split(",").map((s) => s.trim()).filter(Boolean);
	return specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("type "));
}

function collectStaticImports(file: string, source: string): Array<{ file: string; source: string; clause?: string }> {
	const imports: Array<{ file: string; source: string; clause?: string }> = [];
	const text = stripComments(source);
	const staticImportStatement = /\bimport\s+(?!\()(?<body>[\s\S]*?);/g;
	for (const match of text.matchAll(staticImportStatement)) {
		const body = (match.groups?.body ?? "").trim();
		const sideEffect = body.match(/^["'](?<source>[^"']+)["']$/);
		if (sideEffect?.groups?.source) {
			imports.push({ file, source: sideEffect.groups.source });
			continue;
		}
		const fromImport = body.match(/^(?<clause>[\s\S]*?)\s+from\s+["'](?<source>[^"']+)["']$/);
		if (fromImport?.groups?.source) {
			imports.push({ file, source: fromImport.groups.source, clause: fromImport.groups.clause });
		}
	}
	return imports;
}

function stripTypeOnlyImportExpressions(source: string): string {
	return source.replace(/\btypeof\s+import\s*\(\s*["'][^"']+["']\s*\)/g, "unknown");
}

function collectDynamicImports(file: string, source: string): Array<{ file: string; source: string }> {
	const imports: Array<{ file: string; source: string }> = [];
	const dynamicImport = /\bimport\s*\(\s*["'](?<source>[^"']+)["']\s*\)/g;
	for (const match of stripTypeOnlyImportExpressions(stripComments(source)).matchAll(dynamicImport)) {
		imports.push({ file, source: match.groups?.source ?? "" });
	}
	return imports;
}

function resolveRelativeModule(importer: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const resolved = path.resolve(path.dirname(importer), specifier);
	const candidates = [
		resolved,
		resolved.replace(/\.js$/, ".ts"),
		resolved.replace(/\.js$/, ".tsx"),
		`${resolved}.ts`,
		`${resolved}.tsx`,
		path.join(resolved, "index.ts"),
		path.join(resolved, "index.tsx"),
	];
	const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
	return found ? normalizePath(found) : normalizePath(resolved.replace(/\.js$/, ".ts"));
}

function moduleName(modulePath: string): string {
	return path.basename(modulePath).replace(/\.(tsx?|jsx?)$/, "");
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore", windowsHide: true });
}

function initCommittedRepo(dir: string, branch: string): void {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, ["init", "--initial-branch", branch]);
	git(dir, ["config", "user.email", "test@bobbit.local"]);
	git(dir, ["config", "user.name", "test"]);
	git(dir, ["commit", "--allow-empty", "-m", "init"]);
}

async function capturePrimaryBranchWarnings(run: () => Promise<void>): Promise<string[]> {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	try {
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		await run();
		return warnings;
	} finally {
		console.warn = originalWarn;
	}
}

function primaryBranchWarningCount(warnings: string[]): number {
	return warnings.filter((line) => line.includes("could not detect primary branch")).length;
}

describe("clean build warning regression tests", () => {
	const files = sourceRoots.flatMap(walkTsFiles).sort();
	const sources = new Map(files.map((file) => [file, fs.readFileSync(file, "utf-8")]));

	it("keeps browser code from importing pi-ai runtime values", () => {
		const offenders: string[] = [];
		for (const [file, source] of sources) {
			const rel = normalizePath(file);
			for (const imp of collectStaticImports(file, source)) {
				if (imp.source !== "@earendil-works/pi-ai") continue;
				if (isTypeOnlyImportClause(imp.clause)) continue;
				offenders.push(`${rel}: static browser value import from @earendil-works/pi-ai`);
			}
			for (const imp of collectDynamicImports(file, source)) {
				if (imp.source !== "@earendil-works/pi-ai") continue;
				offenders.push(`${rel}: dynamic browser value import from @earendil-works/pi-ai`);
			}
		}

		assert.deepEqual(offenders, [], [
			"Browser code must not use static or dynamic browser value imports from @earendil-works/pi-ai.",
			"Use a browser-safe route, narrower module boundary, or package export that does not pull node-only exports into browser chunks.",
			...offenders,
		].join("\n"));
	});

	it("does not dynamically import warning targets that are already statically imported", () => {
		const staticImportsByTarget = new Map<string, string[]>();
		const dynamicImports: Array<{ from: string; target: string }> = [];

		for (const [file, source] of sources) {
			for (const imp of collectStaticImports(file, source)) {
				if (isTypeOnlyImportClause(imp.clause)) continue;
				const resolved = resolveRelativeModule(file, imp.source);
				if (!resolved || !ineffectiveDynamicImportTargets.has(moduleName(resolved))) continue;
				const sites = staticImportsByTarget.get(resolved) ?? [];
				const site = `${normalizePath(file)} -> ${resolved}`;
				if (!sites.includes(site)) sites.push(site);
				staticImportsByTarget.set(resolved, sites);
			}

			for (const imp of collectDynamicImports(file, source)) {
				const resolved = resolveRelativeModule(file, imp.source);
				if (!resolved || !ineffectiveDynamicImportTargets.has(moduleName(resolved))) continue;
				dynamicImports.push({ from: normalizePath(file), target: resolved });
			}
		}

		const offenders: string[] = [];
		const seenOffenders = new Set<string>();
		for (const dyn of dynamicImports) {
			const staticSites = staticImportsByTarget.get(dyn.target) ?? [];
			if (staticSites.length === 0) continue;
			const key = `${dyn.from} -> ${dyn.target}`;
			if (seenOffenders.has(key)) continue;
			seenOffenders.add(key);
			const rationale = allowedIneffectiveDynamicImports[key];
			if (rationale && rationale.trim().length >= 20) continue;
			const shownStaticSites = staticSites.slice(0, 8).map((site) => `  static: ${site}`);
			if (staticSites.length > shownStaticSites.length) {
				shownStaticSites.push(`  static: ... ${staticSites.length - shownStaticSites.length} more static import site(s)`);
			}
			offenders.push([
				`${key}: ineffective dynamic import; target is also statically imported`,
				...shownStaticSites,
			].join("\n"));
		}

		assert.deepEqual(offenders, [], [
			"Dynamic imports of Rollup warning targets must either split a real chunk or be replaced with static/narrow imports.",
			"Use allowedIneffectiveDynamicImports only with a specific rationale for unavoidable eager sharing.",
			...offenders,
		].join("\n\n"));
	});

	it("keeps expected primary-branch fallback quiet for minimal test repos", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-primary-branch-fallback-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: tmp, windowsHide: true });

			const warnings = await capturePrimaryBranchWarnings(async () => {
				const primary = await detectPrimaryBranch(tmp);
				assert.equal(primary, "master");
			});

			assert.equal(
				primaryBranchWarningCount(warnings),
				0,
				`expected minimal test repo fallback to avoid noisy detectPrimaryBranch warnings, got:\n${warnings.join("\n")}`,
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("keeps expected non-git temp fallback paths quiet", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-e2e-"));
		const projectDir = path.join(tmpRoot, `proj-isolation-${Date.now()}`);
		try {
			fs.mkdirSync(projectDir, { recursive: true });

			const warnings = await capturePrimaryBranchWarnings(async () => {
				assert.equal(await detectPrimaryBranch(os.tmpdir()), "master");
				assert.equal(await detectPrimaryBranch(tmpRoot), "master");
				assert.equal(await detectPrimaryBranch(projectDir), "master");
			});

			assert.equal(
				primaryBranchWarningCount(warnings),
				0,
				`expected non-git temp fallback paths to avoid noisy detectPrimaryBranch warnings, got:\n${warnings.join("\n")}`,
			);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("keeps expected temp worktree fallback paths quiet when no primary refs exist", async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verif-restart-repo-"));
		const worktreeDir = path.join(`${tmpRoot}-wt`, "goal-test");
		try {
			initCommittedRepo(worktreeDir, "goal/test");

			const warnings = await capturePrimaryBranchWarnings(async () => {
				const primary = await detectPrimaryBranch(worktreeDir);
				assert.equal(primary, "master");
			});

			assert.equal(
				primaryBranchWarningCount(warnings),
				0,
				`expected temp worktree fallback paths to avoid noisy detectPrimaryBranch warnings, got:\n${warnings.join("\n")}`,
			);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
			fs.rmSync(`${tmpRoot}-wt`, { recursive: true, force: true });
		}
	});

	it("still warns once when a repo has an origin but no detectable primary branch", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-primary-branch-origin-"));
		try {
			initCommittedRepo(tmp, "feature/test");
			git(tmp, ["remote", "add", "origin", "https://example.invalid/repo.git"]);

			const warnings = await capturePrimaryBranchWarnings(async () => {
				assert.equal(await detectPrimaryBranch(tmp), "master");
				assert.equal(await detectPrimaryBranch(tmp), "master");
			});

			assert.equal(
				primaryBranchWarningCount(warnings),
				1,
				`expected one production diagnostic for origin-backed repo fallback, got:\n${warnings.join("\n")}`,
			);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
