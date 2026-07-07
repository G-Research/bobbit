#!/usr/bin/env node
/**
 * Browser-dimension chaos comparison proof — Test Suite v2 (switchover prereq D8).
 *
 * The node-tier chaos.mjs proves parity for logic/store/scheduler code but NEVER
 * touches browser/Playwright code (0/54 node mutants are browser-only). This is
 * the missing adversarial evidence for the 184→~35 browser-e2e journey
 * consolidation: for each mutant in browser-only code (src/ui/**, src/app/** UI
 * paths), it runs BOTH
 *   - the targeted LEGACY browser spec (tests/e2e/ui/*.spec.ts, playwright-e2e), and
 *   - the replacement v2 JOURNEY (tests2/browser/journeys/*.journey.spec.ts, playwright-v2),
 * and records caught/missed with test-name attribution. The acceptance bar:
 * every mutant the legacy browser suite catches MUST also be caught by the
 * replacement journey. A legacy-caught-but-journey-missed mutant is a REAL hole
 * in the consolidated journey — fix it by strengthening the journey's
 * assertions (do NOT delete the mutant), then re-run.
 *
 *   node scripts/testing-v2/browser-chaos.mjs [--id BR01] [--ids BR01,BR02] [--all]
 *   node scripts/testing-v2/browser-chaos.mjs --dry-run   # list mutants, don't run
 *   node scripts/testing-v2/browser-chaos.mjs --regen-report
 *
 * Outputs:
 *   .profiles/chaos/browser-comparison-report.json   full per-mutant matrix
 *   .profiles/chaos/browser-comparison-report.md      report
 *   docs/testing-v2/browser-chaos-report.md           committed summary copy
 *
 * ─── HEAVY / gated ─────────────────────────────────────────────────────────────
 * Browser tests run against BUILT dist (dist/server + dist/ui), NOT src, so each
 * mutant requires a dist rebuild of the affected target before its Playwright
 * runs. The campaign is therefore heavy (a UI mutant ≈ one `vite build` + two
 * Playwright specs). It gates the switchover only — it is NOT part of test:v2.
 *
 * ─── Junction-safe teardown ─────────────────────────────────────────────────────
 * The ephemeral worktree's node_modules is a Windows junction into the primary
 * repo's node_modules. `unlinkNodeModulesJunction` UNLINKS the reparse point
 * (non-recursively) BEFORE any recursive delete, so neither `git worktree remove`
 * nor `fs.rmSync` can descend THROUGH the junction and wipe the shared tree.
 * This is the same fix chaos.mjs carries (see docs/testing-v2/node-modules-
 * corruption-rca.md) — do NOT reintroduce delete-through-junction.
 *
 * ─── Honest attribution ─────────────────────────────────────────────────────────
 * caught    = a Playwright JSON report names a FAILING test in the targeted spec
 * missed    = the targeted spec ran and reported NO failures (bug not detected)
 * invalid   = the mutation did not compile / the required dist target failed to build
 * error     = the run crashed before tests ran (global-setup/gateway/report absent)
 * A bare non-zero exit with NO attributed failing test is an ERROR, never a kill.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths / repo resolution (mirrors chaos.mjs) ────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function findPrimaryFromWorktreeGit(repoRoot) {
	const gitFile = path.join(repoRoot, ".git");
	try {
		const stat = fs.statSync(gitFile);
		if (stat.isFile()) {
			const content = fs.readFileSync(gitFile, "utf-8").trim();
			const match = content.match(/^gitdir:\s*(.+)$/);
			if (match) {
				const gitDir = path.resolve(repoRoot, match[1].trim());
				const worktreesIdx = gitDir.lastIndexOf(path.sep + "worktrees" + path.sep);
				if (worktreesIdx !== -1) {
					const primaryGit = gitDir.slice(0, worktreesIdx);
					return path.dirname(primaryGit);
				}
			}
		}
	} catch { /* ignore */ }
	return repoRoot;
}

const PRIMARY_REPO = findPrimaryFromWorktreeGit(REPO_ROOT);

// Locate a node_modules that actually contains the Playwright CLI. Prefer this
// worktree, then the primary repo, then sibling worktrees under the shared -wt
// root — never a sibling repo whose Playwright version could differ.
function hasPlaywright(nm) {
	try { return fs.existsSync(path.join(nm, "playwright", "cli.js")); } catch { return false; }
}
function resolveToolchain() {
	const stable = [
		path.join(REPO_ROOT, "node_modules"),
		path.join(PRIMARY_REPO, "node_modules"),
	];
	const siblings = [];
	try {
		const wtRoot = path.dirname(REPO_ROOT);
		for (const name of fs.readdirSync(wtRoot)) {
			const nm = path.join(wtRoot, name, "node_modules");
			if (!stable.includes(nm)) siblings.push(nm);
		}
	} catch { /* ignore */ }
	const candidates = [...stable, ...siblings];
	const chosen = candidates.find(hasPlaywright) || path.join(PRIMARY_REPO, "node_modules");
	return { nm: chosen, hasPlaywright: !!candidates.find(hasPlaywright), stable, siblingCount: siblings.length };
}

const TOOLCHAIN = resolveToolchain();
const PRIMARY_NODE_MODULES = TOOLCHAIN.nm;
const PLAYWRIGHT_CLI = path.join(PRIMARY_NODE_MODULES, "playwright", "cli.js");

const MUTANTS_FILE = path.join(REPO_ROOT, "tests2", "chaos", "browser-mutants.json");
const REPORT_JSON = path.join(REPO_ROOT, ".profiles", "chaos", "browser-comparison-report.json");
const REPORT_MD = path.join(REPO_ROOT, ".profiles", "chaos", "browser-comparison-report.md");
const REPORT_MD_DOCS = path.join(REPO_ROOT, "docs", "testing-v2", "browser-chaos-report.md");

const LEGACY_CONFIG = "playwright-e2e.config.ts";
const V2_CONFIG = "playwright-v2.config.ts";

// ── CLI parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let targetIds = null;
let dryRun = false;
let keepWorktree = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--all") targetIds = null;
	else if (args[i] === "--dry-run") dryRun = true;
	else if (args[i] === "--keep-worktree") keepWorktree = true;
	else if (args[i] === "--id" && args[i + 1]) targetIds = [args[++i]];
	else if (args[i] === "--ids" && args[i + 1]) targetIds = args[++i].split(",");
}

// ── Load mutants ─────────────────────────────────────────────────────────────

const ALL_MUTANTS = JSON.parse(fs.readFileSync(MUTANTS_FILE, "utf-8"));
const mutants = targetIds ? ALL_MUTANTS.filter(m => targetIds.includes(m.id)) : ALL_MUTANTS;

if (dryRun) {
	console.log(`Browser mutants (${mutants.length}):`);
	for (const m of mutants) {
		const tag = m.nullMutant ? " [null]" : "";
		console.log(`  ${m.id}${tag}  [${m.area}]  ${m.file}  (target=${m.target})`);
		console.log(`    op: ${m.operator}`);
		console.log(`    legacy: ${m.expectedLegacyCatchers.join(", ") || "(none)"}`);
		console.log(`    v2:     ${m.expectedV2Catchers.join(", ") || "(none)"}`);
	}
	process.exit(0);
}

// ── Mutation + dist-target helpers ────────────────────────────────────────────

/** Which dist target(s) must be rebuilt for a mutation in `file`. */
function targetsFor(mutant) {
	if (mutant.target === "ui" || mutant.target === "server") return [mutant.target];
	const f = mutant.file.replace(/\\/g, "/");
	if (f.startsWith("src/ui/") || f.startsWith("src/app/")) return ["ui"];
	if (f.startsWith("src/server/")) return ["server"];
	return ["ui", "server"]; // shared/unknown — rebuild both to be safe
}

function applyMutation(filePath, search, replace) {
	const content = fs.readFileSync(filePath, "utf-8");
	if (!content.includes(search)) return null;
	const idx = content.indexOf(search);
	const patched = content.slice(0, idx) + replace + content.slice(idx + search.length);
	fs.writeFileSync(filePath, patched, "utf-8");
	return content;
}

function buildTarget(worktreePath, target) {
	const script = target === "ui" ? "build:ui" : "build:server";
	const t0 = Date.now();
	const result = spawnSync("npm", ["run", script], {
		cwd: worktreePath,
		encoding: "utf-8",
		timeout: 480_000,
		shell: process.platform === "win32",
		env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
	});
	const ok = (result.status ?? 1) === 0;
	return { ok, durationMs: Date.now() - t0, stderr: (result.stderr || "").slice(-800), status: result.status, signal: result.signal };
}

// ── Playwright invocation + JSON report parsing ────────────────────────────────

/**
 * Recursively walk a Playwright JSON report's suite tree and collect the titles
 * of specs that have at least one FAILING test result. Playwright's JSON shape:
 *   { suites: [ { title, file, specs: [ { title, ok, tests: [ { results:[{status}] } ] } ], suites:[...] } ], stats, errors }
 */
function collectFailingSpecs(node, trail, out) {
	if (!node) return;
	const suites = node.suites || [];
	const specs = node.specs || [];
	for (const spec of specs) {
		const tests = spec.tests || [];
		const failed = tests.some(t => {
			// spec.ok is false when unexpected; also inspect results for robustness.
			const results = t.results || [];
			return t.status === "unexpected" || results.some(r => r.status === "failed" || r.status === "timedOut");
		});
		if (failed || spec.ok === false) {
			const title = [...trail, spec.title].filter(Boolean).join(" › ");
			out.push(title);
		}
	}
	for (const s of suites) {
		collectFailingSpecs(s, [...trail, s.title].filter(Boolean), out);
	}
}

function parsePlaywrightReport(reportPath) {
	if (!fs.existsSync(reportPath)) return { hasReport: false, failingSpecs: [], stats: null, errors: [] };
	let data;
	try { data = JSON.parse(fs.readFileSync(reportPath, "utf-8")); }
	catch { return { hasReport: false, failingSpecs: [], stats: null, errors: [] }; }
	const failing = [];
	for (const s of data.suites || []) collectFailingSpecs(s, [s.title].filter(Boolean), failing);
	const seen = new Set();
	const failingSpecs = failing.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
	return { hasReport: true, failingSpecs, stats: data.stats || null, errors: data.errors || [] };
}

/**
 * Run one targeted Playwright spec under a given config. Returns
 *   { exitCode, timedOut, hasReport, failingSpecs, testsRan, stderrTail }.
 */
function runPlaywrightSpec(worktreePath, tier, specRel) {
	const reportPath = path.join(worktreePath, `.browser-chaos-${tier}-${Date.now()}.json`);
	const config = tier === "legacy" ? LEGACY_CONFIG : V2_CONFIG;
	const cliArgs = [
		PLAYWRIGHT_CLI, "test",
		"--config", config,
		"--workers=1",
		"--retries=0",
		"--reporter=json",
		specRel,
	];
	if (tier === "legacy") { cliArgs.push("--project", "browser"); }

	const runId = `browser-chaos-${tier}-${process.pid}-${Date.now()}`;
	const result = spawnSync("node", cliArgs, {
		cwd: worktreePath,
		encoding: "utf-8",
		timeout: 600_000,
		shell: false,
		env: {
			...process.env,
			PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
			// Skip the legacy e2e no-new-sleeps guard — irrelevant to mutation runs.
			BOBBIT_E2E_SKIP_GUARDS: "1",
			// Fail-closed external access (mirrors the browser global setups).
			BOBBIT_TEST_NO_EXTERNAL: process.env.BOBBIT_TEST_NO_EXTERNAL || "1",
			BOBBIT_TEST_NO_REMOTE: process.env.BOBBIT_TEST_NO_REMOTE || "1",
			BOBBIT_V2_BROWSER_RUN_ID: runId,
			BOBBIT_E2E_RUN_ID: runId,
			NODE_DISABLE_COMPILE_CACHE: "1",
			NO_COLOR: "1",
			FORCE_COLOR: "0",
		},
	});
	const parsed = parsePlaywrightReport(reportPath);
	if (process.env.BOBBIT_BROWSER_CHAOS_DEBUG) {
		try {
			const dbg = path.join(REPO_ROOT, ".profiles", "chaos", `debug-${tier}-${path.basename(specRel)}.txt`);
			fs.mkdirSync(path.dirname(dbg), { recursive: true });
			fs.writeFileSync(dbg, `STATUS=${result.status} SIGNAL=${result.signal}\nERROR=${result.error}\nhasReport=${parsed.hasReport} stats=${JSON.stringify(parsed.stats)}\nfailing=${JSON.stringify(parsed.failingSpecs)}\n--- STDOUT ---\n${(result.stdout || "").slice(-4000)}\n--- STDERR ---\n${(result.stderr || "").slice(-4000)}\n`, "utf-8");
		} catch { /* ignore */ }
	}
	try { fs.rmSync(reportPath, { force: true }); } catch { /* ignore */ }
	const stats = parsed.stats || {};
	const testsRan = (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0);
	return {
		exitCode: result.status ?? (result.error ? 1 : 0),
		timedOut: result.signal === "SIGTERM" || result.signal === "SIGKILL",
		hasReport: parsed.hasReport,
		failingSpecs: parsed.failingSpecs,
		testsRan,
		errors: parsed.errors,
		stderrTail: (result.stderr || "").slice(-400),
	};
}

/** Classify a Playwright run into caught/missed/error + a human detail string. */
function classifyRun(r, durationMs) {
	if (!r) return { result: "skipped", detail: "no catcher", tests: [] };
	if (r.timedOut) return { result: "error", detail: `timed out (${durationMs}ms)`, tests: [] };
	if (r.failingSpecs.length > 0) {
		return { result: "caught", detail: `killed by "${r.failingSpecs[0]}"${r.failingSpecs.length > 1 ? ` (+${r.failingSpecs.length - 1})` : ""} (${durationMs}ms)`, tests: r.failingSpecs };
	}
	if (!r.hasReport) {
		return { result: "error", detail: `no JSON report written — run crashed before tests (exit ${r.exitCode}): ${r.stderrTail}`, tests: [] };
	}
	if (r.testsRan === 0) {
		// Report exists but zero tests ran (all skipped / no match) — inconclusive.
		return { result: "error", detail: `report written but 0 tests ran (all skipped/no-match) (${durationMs}ms)`, tests: [] };
	}
	if (r.exitCode === 0) {
		return { result: "missed", detail: `${r.testsRan} test(s) ran, none failed — mutant MISSED (${durationMs}ms)`, tests: [] };
	}
	// Non-zero exit, report present, tests ran, but no attributed failing spec ⇒
	// a harness/config error, NOT a kill.
	return { result: "error", detail: `exit ${r.exitCode} but NO attributed failing spec — harness error (${durationMs}ms)`, tests: [] };
}

// ── Worktree management (junction-safe teardown reused from chaos.mjs) ──────────

function createEphemeralWorktree(label) {
	const tmpDir = path.join(os.tmpdir(), `bobbit-browser-chaos-${label}-${Date.now()}`);
	try {
		execFileSync("git", ["worktree", "add", "--detach", tmpDir, "HEAD"], { cwd: REPO_ROOT, stdio: "pipe" });
		return tmpDir;
	} catch (err) {
		throw new Error(`git worktree add failed: ${err.stderr || err.message}`);
	}
}

function ensureNodeModulesJunction(worktreePath) {
	const link = path.join(worktreePath, "node_modules");
	if (fs.existsSync(link)) return;
	if (!fs.existsSync(PRIMARY_NODE_MODULES)) {
		console.warn(`[browser-chaos] Warning: primary node_modules not found at ${PRIMARY_NODE_MODULES}`);
		return;
	}
	try {
		const type = process.platform === "win32" ? "junction" : "dir";
		fs.symlinkSync(PRIMARY_NODE_MODULES, link, type);
	} catch (err) {
		console.warn(`[browser-chaos] Warning: failed to create node_modules junction: ${err.message}`);
	}
}

// Remove the node_modules reparse point (junction/symlink) WITHOUT following it.
// On Windows both `git worktree remove --force` and Node's recursive fs.rmSync
// can descend THROUGH a directory junction and delete the target's contents (the
// shared node_modules tree) instead of just unlinking the link. We therefore
// unlink the link itself, non-recursively, first. (Same fix as chaos.mjs.)
function unlinkNodeModulesJunction(worktreePath) {
	const link = path.join(worktreePath, "node_modules");
	let st;
	try { st = fs.lstatSync(link); } catch { return; } // absent
	void st;

	// GUARD (fail loud): the junction target must live OUTSIDE the worktree we
	// are about to delete. If it were inside, unlinking wouldn't protect it and a
	// recursive delete would wipe it — refuse rather than risk the shared tree.
	try {
		const rawTarget = fs.readlinkSync(link); // throws if not a link
		const resolvedTarget = path.resolve(path.dirname(link), rawTarget);
		const resolvedRoot = path.resolve(worktreePath);
		const rel = path.relative(resolvedRoot, resolvedTarget);
		const targetInsideRoot = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
		if (targetInsideRoot) {
			throw new Error(
				`[browser-chaos] REFUSING to remove worktree: node_modules junction target\n` +
				`  (${resolvedTarget}) is INSIDE the removal path (${resolvedRoot}).\n` +
				`  A recursive delete would wipe the shared tree. Aborting to protect it.`,
			);
		}
	} catch (err) {
		if (/REFUSING to remove worktree/.test(err.message)) throw err;
	}

	// Unlink the reparse point ONLY (never recursive).
	const attempts = [
		() => fs.unlinkSync(link),                       // POSIX symlink / Windows file-symlink
		() => fs.rmdirSync(link),                        // Windows directory junction
		() => fs.rmSync(link, { recursive: false, force: true }),
	];
	for (const attempt of attempts) {
		try { attempt(); return; } catch { /* try next */ }
	}
	if (fs.existsSync(link)) {
		console.warn(`[browser-chaos] WARNING: could not unlink node_modules junction at ${link} non-recursively; skipping worktree delete to avoid deleting through it.`);
		throw new Error(`[browser-chaos] node_modules junction at ${link} could not be safely unlinked`);
	}
}

function removeEphemeralWorktree(worktreePath) {
	if (!worktreePath) return;
	try {
		unlinkNodeModulesJunction(worktreePath);
	} catch (err) {
		console.error(err.message);
		return; // leave worktree rather than risk corrupting shared node_modules
	}
	try {
		execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: REPO_ROOT, stdio: "pipe" });
	} catch {
		// Safe now: the node_modules reparse point has already been unlinked.
		try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

// Assert the worktree source tree is clean (only expected file, if any, changed).
function assertCleanTree(worktreePath, allowFile) {
	const diff = spawnSync("git", ["diff", "--name-only"], { cwd: worktreePath, encoding: "utf-8" });
	const changed = (diff.stdout || "").trim().split("\n").filter(Boolean).map(f => f.replace(/\\/g, "/"));
	const unexpected = changed.filter(f => f !== allowFile);
	return { clean: unexpected.length === 0, changed, unexpected };
}

function revertFile(worktreePath, file) {
	spawnSync("git", ["checkout", "--", file], { cwd: worktreePath, encoding: "utf-8" });
}

// ── Result builder ─────────────────────────────────────────────────────────────

function buildResult(mutant, legacy, v2, detail, durationMs, extra = {}) {
	return {
		id: mutant.id,
		area: mutant.area,
		file: mutant.file,
		target: mutant.target,
		operator: mutant.operator,
		description: mutant.description,
		nullMutant: mutant.nullMutant || false,
		legacyResult: legacy.result,
		v2Result: v2.result,
		legacyCatchers: mutant.expectedLegacyCatchers,
		v2Catchers: mutant.expectedV2Catchers,
		legacyCatchTests: legacy.tests || [],
		v2CatchTests: v2.tests || [],
		detail,
		durationMs,
		timestamp: new Date().toISOString(),
		...extra,
	};
}

// ── Run one mutant in the shared worktree ────────────────────────────────────

function runMutant(mutant, worktreePath, distDirty) {
	const start = Date.now();
	console.log(`\n[browser-chaos] ${mutant.id} [${mutant.area}]  ${mutant.file}`);

	const targetFile = path.join(worktreePath, mutant.file);
	if (!fs.existsSync(targetFile)) {
		return { result: buildResult(mutant, { result: "invalid" }, { result: "invalid" }, `File not found: ${mutant.file}`, Date.now() - start), distDirty };
	}
	const original = applyMutation(targetFile, mutant.search, mutant.replace);
	if (original === null) {
		return { result: buildResult(mutant, { result: "invalid" }, { result: "invalid" }, `Search pattern not found in ${mutant.file}`, Date.now() - start), distDirty };
	}
	console.log(`  mutation applied ✓`);

	const needed = new Set(targetsFor(mutant));
	const toBuild = new Set([...distDirty, ...needed]);
	let buildFailed = null;
	for (const t of toBuild) {
		process.stdout.write(`  build:${t} … `);
		const b = buildTarget(worktreePath, t);
		console.log(b.ok ? `ok (${(b.durationMs / 1000).toFixed(1)}s)` : `FAILED (${(b.durationMs / 1000).toFixed(1)}s)`);
		// A build failure of a NEEDED target means the mutation does not compile →
		// invalid. A failure rebuilding a stale (previously-dirty) target is also
		// fatal to determinism (dist would be inconsistent) — bail either way.
		if (!b.ok) { buildFailed = { target: t, needed: needed.has(t), stderr: b.stderr }; break; }
	}

	let newDirty = needed;
	if (buildFailed) {
		// Revert and mark invalid. dist for `needed` targets may be partially built;
		// mark them dirty so the NEXT mutant rebuilds them from clean source.
		revertFile(worktreePath, mutant.file);
		newDirty = new Set([...distDirty, ...needed]);
		const verdict = buildFailed.needed ? "invalid" : "error";
		const detail = buildFailed.needed
			? `mutation did not compile — build:${buildFailed.target} failed: ${buildFailed.stderr.split(/\r?\n/).slice(-3).join(" ")}`
			: `stale dist rebuild build:${buildFailed.target} failed (env): ${buildFailed.stderr.split(/\r?\n/).slice(-3).join(" ")}`;
		console.log(`  → ${verdict} (build)`);
		return { result: buildResult(mutant, { result: verdict }, { result: verdict }, detail, Date.now() - start), distDirty: newDirty };
	}

	// Run legacy targeted spec.
	let legacy = { result: "skipped", detail: "no legacy catcher", tests: [] };
	if (mutant.expectedLegacyCatchers.length > 0) {
		const spec = mutant.expectedLegacyCatchers[0];
		console.log(`  legacy: ${spec}`);
		const t0 = Date.now();
		const r = runPlaywrightSpec(worktreePath, "legacy", spec);
		legacy = classifyRun(r, Date.now() - t0);
		console.log(`  legacy: ${legacy.result}  — ${legacy.detail}`);
	} else {
		console.log(`  legacy: skipped (no catcher)`);
	}

	// Run v2 journey.
	let v2 = { result: "skipped", detail: "no v2 catcher", tests: [] };
	if (mutant.expectedV2Catchers.length > 0) {
		const spec = mutant.expectedV2Catchers[0];
		console.log(`  v2:     ${spec}`);
		const t0 = Date.now();
		const r = runPlaywrightSpec(worktreePath, "v2", spec);
		v2 = classifyRun(r, Date.now() - t0);
		console.log(`  v2:     ${v2.result}  — ${v2.detail}`);
	} else {
		console.log(`  v2:     skipped (no catcher)`);
	}

	// Null-mutant integrity: a no-op patch must NOT be caught by either suite.
	if (mutant.nullMutant) {
		const ok = legacy.result !== "caught" && v2.result !== "caught";
		console.log(ok ? `  ✓ null mutant integrity OK (neither suite falsely caught)` : `  ❌ NULL MUTANT INTEGRITY FAILURE — a suite caught a no-op patch!`);
	}

	// Revert source and restore a clean tree for the next mutant.
	revertFile(worktreePath, mutant.file);
	const clean = assertCleanTree(worktreePath, null);
	if (!clean.clean) {
		console.warn(`  ⚠️ tree not clean after revert: ${clean.unexpected.join(", ")}`);
		// Hard reset tracked files to be safe (never touches node_modules junction).
		spawnSync("git", ["checkout", "--", "."], { cwd: worktreePath, encoding: "utf-8" });
	}

	const detail = `legacy: ${legacy.detail} | v2: ${v2.detail}`;
	return { result: buildResult(mutant, legacy, v2, detail, Date.now() - start, { treeCleanAfter: clean.clean }), distDirty: newDirty };
}

// ── Report generation ──────────────────────────────────────────────────────────

function generateMarkdown(results, meta) {
	const L = [];
	const content = results.filter(r => !r.nullMutant);
	const nulls = results.filter(r => r.nullMutant);

	const legacyCaught = content.filter(r => r.legacyResult === "caught").length;
	const v2Caught = content.filter(r => r.v2Result === "caught").length;
	const legacyMissed = content.filter(r => r.legacyResult === "missed").length;
	const v2Missed = content.filter(r => r.v2Result === "missed").length;
	const legacyKillable = content.filter(r => r.legacyCatchers.length > 0).length;
	const v2Killable = content.filter(r => r.v2Catchers.length > 0).length;
	const invalid = content.filter(r => r.legacyResult === "invalid" || r.v2Result === "invalid").length;
	const errors = content.filter(r => r.legacyResult === "error" || r.v2Result === "error").length;

	L.push("# Browser-dimension Chaos Comparison — Test Suite v2");
	L.push("");
	L.push(`Generated: ${meta.date}  |  Run duration: ${(meta.totalDurationMs / 1000 / 60).toFixed(1)} min`);
	L.push("");
	L.push("Adversarial proof that the consolidated v2 **journeys** catch every browser-only");
	L.push("mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted");
	L.push("spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.");
	L.push("");
	L.push("## Summary");
	L.push("");
	L.push("| Metric | Legacy suite | V2 journeys |");
	L.push("|--------|-------------|-------------|");
	L.push(`| Content mutants | ${content.length} | ${content.length} |`);
	L.push(`| With targeted catchers | ${legacyKillable} | ${v2Killable} |`);
	L.push(`| Caught | ${legacyCaught} | ${v2Caught} |`);
	L.push(`| Missed | ${legacyMissed} | ${v2Missed} |`);
	L.push(`| Invalid (did not compile) | ${content.filter(r => r.legacyResult === "invalid").length} | ${content.filter(r => r.v2Result === "invalid").length} |`);
	L.push(`| Error (harness/env) | ${content.filter(r => r.legacyResult === "error").length} | ${content.filter(r => r.v2Result === "error").length} |`);
	L.push(`| **Kill rate (of killable)** | **${legacyKillable ? (legacyCaught / legacyKillable * 100).toFixed(1) : "N/A"}%** | **${v2Killable ? (v2Caught / v2Killable * 100).toFixed(1) : "N/A"}%** |`);
	L.push("");

	const nullOk = nulls.every(r => r.legacyResult !== "caught" && r.v2Result !== "caught");
	L.push(`**Null-mutant integrity:** ${nulls.length === 0 ? "— (no null mutant this run)" : (nullOk ? "✅ PASSED (no suite caught a no-op patch)" : "❌ FAILED")}`);
	L.push("");

	// Acceptance.
	L.push("## Acceptance Criteria");
	L.push("");
	const legacyOnly = content.filter(r => r.legacyResult === "caught" && r.v2Result !== "caught");
	const realHoles = legacyOnly.filter(r => r.v2Result === "missed");
	const inconclusive = legacyOnly.filter(r => r.v2Result === "error" || r.v2Result === "invalid");
	L.push(`- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ${realHoles.length === 0 ? "✅ PASS" : "❌ FAIL"}`);
	if (realHoles.length) {
		L.push(`  - ❌ ${realHoles.length} REAL journey hole(s) — the journey RAN and MISSED. Strengthen the journey's assertions (do NOT delete the mutant), then re-run:`);
		for (const r of realHoles) {
			L.push(`    - **${r.id}** (${r.area}): ${r.description} — legacy caught via \`${r.legacyCatchers[0]}\`; v2 journey \`${r.v2Catchers[0]}\` = MISSED`);
		}
	}
	if (inconclusive.length) {
		L.push(`- **Inconclusive (env/harness, NOT a hole):** ⚠️ ${inconclusive.length} legacy-caught mutant(s) whose journey run errored/failed-to-build. Re-run:`);
		for (const r of inconclusive) L.push(`    - **${r.id}** (${r.area}): v2 = ${r.v2Result}`);
	}
	L.push(`- **V2 ≥ legacy overall (kill count):** ${v2Caught >= legacyCaught ? "✅ PASS" : "❌ FAIL"} (v2 ${v2Caught} vs legacy ${legacyCaught})`);

	const bothMissed = content.filter(r => r.legacyResult === "missed" && r.v2Result === "missed");
	if (bothMissed.length) {
		L.push(`- **Both-missed (coverage gap — new test or tracked justification needed):** ⚠️ ${bothMissed.length}:`);
		for (const r of bothMissed) L.push(`  - ${r.id} (${r.area}): ${r.description}`);
	} else {
		L.push(`- **Both-missed gaps:** ✅ None`);
	}

	const v2Kills = content.filter(r => r.v2Result === "caught");
	const unattributed = v2Kills.filter(r => !(r.v2CatchTests && r.v2CatchTests.length));
	L.push(`- **All journey kills attributed to a specific test:** ${unattributed.length === 0 ? `✅ PASS (${v2Kills.length}/${v2Kills.length})` : `❌ ${unattributed.length} unattributed`}`);
	L.push("");

	// Per-area comparison.
	L.push("## Per-area Comparison (v2 journeys ≥ legacy is the verdict)");
	L.push("");
	L.push("| Area | Mutants | Legacy caught | V2 caught | Real journey miss | Inconclusive | v2 ≥ legacy (runnable) |");
	L.push("|------|---------|---------------|-----------|-------------------|--------------|------------------------|");
	const areas = [...new Set(content.map(r => r.area))];
	let allGeq = true;
	for (const area of areas) {
		const a = content.filter(r => r.area === area);
		const lc = a.filter(r => r.legacyResult === "caught").length;
		const vc = a.filter(r => r.v2Result === "caught").length;
		const legacyCaughtHere = a.filter(r => r.legacyResult === "caught");
		const realMiss = legacyCaughtHere.filter(r => r.v2Result === "missed").length;
		const inc = legacyCaughtHere.filter(r => r.v2Result === "error" || r.v2Result === "invalid").length;
		const ok = realMiss === 0;
		if (!ok) allGeq = false;
		L.push(`| ${area} | ${a.length} | ${lc} | ${vc} | ${realMiss || "—"} | ${inc || "—"} | ${ok ? (inc ? "✅*" : "✅") : "❌"} |`);
	}
	L.push("");
	L.push(`**Per-area v2 ≥ legacy:** ${allGeq ? "✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)" : "❌ FAIL — an area has a REAL journey miss; strengthen the journey and re-run"}`);
	L.push("");

	// Full matrix.
	L.push("## Full Mutant Matrix");
	L.push("");
	L.push("| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |");
	L.push("|----|------|------|----|--------|-----|---------------------|----------|");
	const ICON = { caught: "🔴", missed: "⚪", skipped: "—", error: "⚠️", invalid: "⛔" };
	for (const r of results) {
		const nt = r.nullMutant ? " *(null)*" : "";
		const killedBy = r.v2Result === "caught" ? ((r.v2CatchTests && r.v2CatchTests[0]) ? `\`${String(r.v2CatchTests[0]).replace(/\|/g, "\\|").slice(0, 90)}\`` : "⚠️ unattributed") : "—";
		L.push(`| ${r.id}${nt} | ${r.area} | \`${r.file}\` | ${r.operator} | ${ICON[r.legacyResult] || "?"} ${r.legacyResult} | ${ICON[r.v2Result] || "?"} ${r.v2Result} | ${killedBy} | ${(r.durationMs / 1000).toFixed(1)}s |`);
	}
	L.push("");
	L.push("**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)");
	L.push("");

	L.push("## Methodology");
	L.push("");
	L.push("- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).");
	L.push("- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).");
	L.push("- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.");
	L.push("- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).");
	L.push("- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.");
	L.push("- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.");
	L.push("");
	L.push(`*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*`);
	return L.join("\n");
}

function writeReports(results, meta) {
	fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
	fs.mkdirSync(path.dirname(REPORT_MD_DOCS), { recursive: true });
	fs.writeFileSync(REPORT_JSON, JSON.stringify({ meta, results }, null, 2), "utf-8");
	const md = generateMarkdown(results, meta);
	fs.writeFileSync(REPORT_MD, md, "utf-8");
	fs.writeFileSync(REPORT_MD_DOCS, md, "utf-8");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	if (args.includes("--regen-report")) {
		const prev = JSON.parse(fs.readFileSync(REPORT_JSON, "utf-8"));
		writeReports(prev.results, prev.meta || { date: new Date().toISOString(), totalDurationMs: 0 });
		console.log(`Regenerated reports from ${REPORT_JSON}`);
		return;
	}

	console.log(`\n╔════════════════════════════════════════════════════════╗`);
	console.log(`║      Browser-dimension Chaos Comparison Proof            ║`);
	console.log(`╚════════════════════════════════════════════════════════╝`);
	console.log(`Repo root:      ${REPO_ROOT}`);
	console.log(`Primary repo:   ${PRIMARY_REPO}`);
	console.log(`toolchain nm:   ${PRIMARY_NODE_MODULES}`);
	console.log(`playwright cli: ${fs.existsSync(PLAYWRIGHT_CLI) ? "✓ " + PLAYWRIGHT_CLI : "✗ MISSING"}`);
	console.log(`Mutants:        ${mutants.length} (of ${ALL_MUTANTS.length})`);

	if (!fs.existsSync(PLAYWRIGHT_CLI)) {
		console.error("\n[browser-chaos] ERROR: playwright/cli.js not found in any candidate node_modules.");
		console.error("  Run in an environment with playwright installed (primary repo or a worktree with `npm ci`).");
		process.exit(1);
	}

	const totalStart = Date.now();
	let worktreePath;
	try {
		worktreePath = createEphemeralWorktree("campaign");
	} catch (err) {
		console.error(`[browser-chaos] worktree error: ${err.message}`);
		process.exit(1);
	}
	console.log(`Worktree:       ${worktreePath}`);

	const results = [];
	try {
		ensureNodeModulesJunction(worktreePath);

		// Initial full build so dist/server + dist/ui exist and are CLEAN.
		console.log(`\n[browser-chaos] initial full build (packs + server + ui)…`);
		const initBuild = spawnSync("npm", ["run", "build"], {
			cwd: worktreePath, encoding: "utf-8", timeout: 900_000,
			shell: process.platform === "win32",
			env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
		});
		if ((initBuild.status ?? 1) !== 0) {
			console.error(`[browser-chaos] initial build FAILED — cannot run browser mutation campaign.`);
			console.error((initBuild.stderr || "").slice(-1200));
			removeEphemeralWorktree(worktreePath);
			process.exit(1);
		}
		console.log(`[browser-chaos] initial build ok. dist is clean.`);

		// Process mutants grouped by target to minimise cross-target rebuilds.
		const ordered = [...mutants].sort((a, b) => targetsFor(a).join().localeCompare(targetsFor(b).join()));
		let distDirty = new Set(); // dist targets currently carrying a mutation

		for (const mutant of ordered) {
			const { result, distDirty: nd } = runMutant(mutant, worktreePath, distDirty);
			distDirty = nd;
			results.push(result);
			// Stream partial report after every mutant.
			writeReports(results, { date: new Date().toISOString(), totalDurationMs: Date.now() - totalStart, partial: true, runner: "browser-chaos.mjs" });
		}
	} finally {
		if (!keepWorktree) removeEphemeralWorktree(worktreePath);
		else console.log(`[browser-chaos] --keep-worktree: leaving ${worktreePath} in place (remember to \`git worktree remove\`).`);
	}

	const meta = { date: new Date().toISOString(), totalDurationMs: Date.now() - totalStart, mutantCount: mutants.length, runner: "browser-chaos.mjs", partial: false };
	writeReports(results, meta);

	// Console summary.
	const content = results.filter(r => !r.nullMutant);
	const legacyCaught = content.filter(r => r.legacyResult === "caught").length;
	const v2Caught = content.filter(r => r.v2Result === "caught").length;
	const realHoles = content.filter(r => r.legacyResult === "caught" && r.v2Result === "missed");
	console.log(`\n╔═══ BROWSER CHAOS RESULTS ═══════════════════════════════╗`);
	console.log(`║ Content mutants:  ${String(content.length).padEnd(37)}║`);
	console.log(`║ Legacy caught:    ${String(legacyCaught).padEnd(37)}║`);
	console.log(`║ V2 journeys caught: ${String(v2Caught).padEnd(35)}║`);
	console.log(`║ REAL journey holes: ${String(realHoles.length).padEnd(35)}║`);
	console.log(`║ Duration:         ${(((Date.now() - totalStart) / 1000 / 60).toFixed(1) + " min").padEnd(37)}║`);
	console.log(`╚═════════════════════════════════════════════════════════╝`);
	console.log(`\nReports:\n  ${REPORT_JSON}\n  ${REPORT_MD}\n  ${REPORT_MD_DOCS}`);

	// Null-mutant integrity is the only hard exit-1 (a broken harness invalidates
	// the whole comparison). Real holes are reported for the coordinator to fix.
	const nullFailed = results.some(r => r.nullMutant && (r.legacyResult === "caught" || r.v2Result === "caught"));
	if (nullFailed) {
		console.error("\n❌ NULL-MUTANT INTEGRITY CHECK FAILED — harness may be broken (a no-op patch was 'caught').");
		process.exit(1);
	}
	if (realHoles.length) {
		console.error(`\n⚠️ ${realHoles.length} REAL journey hole(s) — see the report. Strengthen the journey assertions (coordinate first), then re-run those mutants.`);
	}
	console.log("\n✓ browser-chaos.mjs complete");
}

main().catch(err => {
	console.error("[browser-chaos] Fatal error:", err);
	process.exit(1);
});
