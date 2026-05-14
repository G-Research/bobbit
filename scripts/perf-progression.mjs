#!/usr/bin/env node
/**
 * scripts/perf-progression.mjs
 *
 * Run ONE point of the "Shipped Progression" perf panel: the cumulative
 * effect of all shipped wins up to and including this point, measured on
 * the canonical realistic-large fixture with n=5 replicates.
 *
 * Each step gets exactly five history JSONs:
 *   docs/perf/history/<sha>-progression-step{N}-{label-slug}-{1..5}.json
 *
 * They are stamped:
 *   kind: "progression"
 *   progressionStep: N                  (0-indexed)
 *   progressionLabel: "<label>"          (human-readable, e.g. "baseline", "+Opt-A")
 *   progressionFlags: "<BOBBIT_PERF_FLAGS value>"   (exact env value at runtime)
 *   progressionShippedSince: [<ship-tag>, ...]      (wins included in this point)
 *
 * The perf-report.mjs detects `kind: "progression"` and renders a dedicated
 * top-of-report panel that shows the cumulative latency descent as wins land.
 *
 * Usage:
 *   node scripts/perf-progression.mjs \
 *     --step 0 --label baseline \
 *     --flags "-deferOffscreenRender" \
 *     --shipped "" \
 *     --n 5 --fixture-size large
 *
 *   node scripts/perf-progression.mjs \
 *     --step 1 --label "+Opt-A" \
 *     --flags "" \
 *     --shipped "opt-a" \
 *     --n 5 --fixture-size large
 *
 * Args:
 *   --step <N>             0-indexed progression step. Required.
 *   --label <text>         Human-readable step label. Required (e.g. "baseline", "+Opt-A").
 *   --flags <csv>          Exact BOBBIT_PERF_FLAGS value at runtime. Use "" for default flags.
 *   --shipped <csv>        Comma-separated ship-tags included at this point (e.g. "opt-a,opt-x").
 *                          Use "" for the no-wins baseline.
 *   --n <N>                Replicate count. Default 5.
 *   --fixture-size <s|m|l> BOBBIT_PERF_FIXTURE_SIZE. Default "large" (canonical).
 *   --dry-run              Print the bench command and the planned stamping; don't run.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_DIR = join(ROOT, "docs", "perf", "history");

function parseArgs(argv) {
	const out = { n: 5, fixtureSize: "large", dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case "--step": out.step = Number(next()); break;
			case "--label": out.label = next(); break;
			case "--flags": out.flags = next(); break;
			case "--shipped": out.shipped = next(); break;
			case "--n": out.n = Number(next()); break;
			case "--fixture-size": out.fixtureSize = next(); break;
			case "--dry-run": out.dryRun = true; break;
			case "-h": case "--help": printHelp(); process.exit(0);
			default:
				console.error(`[perf-progression] unknown arg: ${a}`);
				printHelp(); process.exit(2);
		}
	}
	if (!Number.isInteger(out.step) || out.step < 0) {
		console.error(`[perf-progression] --step is required (non-negative integer)`); process.exit(2);
	}
	if (!out.label || typeof out.label !== "string") {
		console.error(`[perf-progression] --label is required`); process.exit(2);
	}
	if (out.flags === undefined) {
		console.error(`[perf-progression] --flags is required (use "" for default flags)`); process.exit(2);
	}
	if (out.shipped === undefined) {
		console.error(`[perf-progression] --shipped is required (use "" for the no-wins baseline)`); process.exit(2);
	}
	if (!Number.isInteger(out.n) || out.n < 1 || out.n > 50) {
		console.error(`[perf-progression] --n must be 1..50, got ${out.n}`); process.exit(2);
	}
	return out;
}

function printHelp() {
	console.log(`Usage: node scripts/perf-progression.mjs \\
    --step <N> --label <label> --flags <csv> --shipped <csv> \\
    [--n 5] [--fixture-size large] [--dry-run]

Runs n=5 replicates of the canonical perf harness with the supplied flag
set, then stamps each resulting history JSON with progression metadata so
perf-report.mjs can render them in the "Shipped Progression" panel.`);
}

function slugify(s) {
	return String(s).toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-") || "step";
}

function getShortSha() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).toString().trim().slice(0, 12);
	} catch {
		return "unknown";
	}
}

function runBench({ tag, flags, n, fixtureSize, dryRun }) {
	// Spawn perf-bench.mjs in a child Node process so its existing
	// Windows-friendly spawn-of-Playwright logic (shell:true, npx.cmd) is
	// unchanged. perf-bench encodes the env-var contract with the harness;
	// we just feed it the right arguments.
	const benchPath = resolve(ROOT, "scripts", "perf-bench.mjs");
	const args = [
		benchPath,
		"--tag", tag,
		"--kind", "experiment",  // stamped, then overridden to "progression" in post.
		"--n", String(n),
		"--fixture-size", fixtureSize,
	];
	// Empty --flags means "default flags" — don't pass the arg at all,
	// because perf-bench skips `BOBBIT_PERF_FLAGS` when the value is empty.
	if (flags) { args.push("--flags", flags); }

	console.log(`[perf-progression] → ${process.execPath} ${args.map((a) => JSON.stringify(a)).join(" ")}`);
	if (dryRun) return 0;
	const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
	if (r.error) { console.error(`[perf-progression] bench spawn error:`, r.error); return 1; }
	return r.status ?? 1;
}

function patchHistoryFiles({ sha, tag, n, step, label, flags, shipped }) {
	// Find the N JSON files this bench just produced. perf-bench's tag
	// padding is `String(i).padStart(String(n).length, "0")`, so for n=5
	// the suffix is "-1".."-5" (width=1).
	const padWidth = String(n).length;
	const expected = [];
	for (let i = 1; i <= n; i++) {
		const suffix = String(i).padStart(padWidth, "0");
		expected.push(`${sha}-${tag}-${suffix}.json`);
	}

	const present = new Set(readdirSync(HISTORY_DIR));
	const missing = expected.filter((f) => !present.has(f));
	if (missing.length > 0) {
		console.error(`[perf-progression] missing expected history files:`);
		for (const f of missing) console.error(`  ${f}`);
		return false;
	}

	const shippedArr = String(shipped || "").split(",").map((s) => s.trim()).filter(Boolean);
	let patched = 0;
	for (const f of expected) {
		const p = join(HISTORY_DIR, f);
		const j = JSON.parse(readFileSync(p, "utf-8"));
		j.kind = "progression";
		j.progressionStep = step;
		j.progressionLabel = label;
		j.progressionFlags = String(flags ?? "");
		j.progressionShippedSince = shippedArr;
		// Strip the experiment-pair fields if perf-bench / the harness
		// stamped them — progression is not an A/B pair.
		delete j.experimentTag;
		delete j.experimentCondition;
		writeFileSync(p, JSON.stringify(j, null, 2));
		patched++;
	}
	console.log(`[perf-progression] patched ${patched} history JSON(s) with kind="progression" metadata`);
	return true;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const sha = getShortSha();
	const slug = slugify(opts.label);
	const tag = `progression-step${opts.step}-${slug}`;
	console.log(`[perf-progression] step=${opts.step} label="${opts.label}" flags="${opts.flags}" shipped="${opts.shipped}" sha=${sha} tag=${tag} n=${opts.n} fixture=${opts.fixtureSize}`);

	if (opts.dryRun) {
		const padWidth = String(opts.n).length;
		console.log(`[perf-progression] would produce:`);
		for (let i = 1; i <= opts.n; i++) {
			const suffix = String(i).padStart(padWidth, "0");
			console.log(`  docs/perf/history/${sha}-${tag}-${suffix}.json`);
		}
	}

	const status = runBench({
		tag,
		flags: opts.flags,
		n: opts.n,
		fixtureSize: opts.fixtureSize,
		dryRun: opts.dryRun,
	});
	if (status !== 0) {
		console.error(`[perf-progression] perf-bench failed with exit ${status}`);
		process.exit(status);
	}
	if (opts.dryRun) {
		console.log(`[perf-progression] dry-run complete (no files patched)`);
		return;
	}

	const ok = patchHistoryFiles({
		sha, tag, n: opts.n,
		step: opts.step,
		label: opts.label,
		flags: opts.flags,
		shipped: opts.shipped,
	});
	if (!ok) {
		console.error(`[perf-progression] failed to patch history files`);
		process.exit(1);
	}

	// Regenerate the cross-commit report so the new progression point
	// shows up immediately.
	try {
		execFileSync(process.execPath, [resolve(ROOT, "scripts", "perf-report.mjs")], {
			cwd: ROOT, stdio: "inherit",
		});
	} catch (err) {
		console.warn(`[perf-progression] perf-report.mjs failed:`, err);
	}
	console.log(`[perf-progression] step ${opts.step} ("${opts.label}") done — refresh docs/perf/sidebar-nav-report.html`);
}

main();
