#!/usr/bin/env node
/**
 * scripts/perf-bench.mjs
 *
 * Run the manual perf harness N times in sequence with a tag pattern.
 * Each replicate gets a distinct `BOBBIT_PERF_HISTORY_TAG=<tag>-<i>`,
 * which lands a separate `docs/perf/history/<sha>-<tag>-<i>.json` file.
 * The cross-commit report (scripts/perf-report.mjs) groups files that
 * share `(commit, tag-base)` and renders median ± min/max bands.
 *
 * Replicates are how we kill single-run noise. The decision rule in
 * docs/perf/README.md says a "win" must show both
 *   (a) ≥100 ms p50 reduction on the target span, AND
 *   (b) median delta exceeds the min/max range of either condition
 * — so n=1 per condition is no longer enough to call a hypothesis.
 *
 * Usage:
 *   node scripts/perf-bench.mjs --tag opt-x-on --kind experiment --n 5 \
 *     --flags deferOffscreenRender --fixture-size large
 *
 * Args (all optional):
 *   --tag <name>            Tag base. Required for replicates so files don't collide.
 *   --kind <baseline|experiment>  Stamped into the history JSON. Default heuristic
 *                           in the harness: "experiment" if --flags set, else "baseline".
 *   --n <N>                 Replicate count. Default 5.
 *   --flags <csv>           BOBBIT_PERF_FLAGS (comma-separated perf flags).
 *   --fixture-size <s|m|l>  BOBBIT_PERF_FIXTURE_SIZE. Default unchanged (medium).
 *   --grep <pattern>        Override the Playwright --grep. Default "perf-sidebar-nav".
 *   --dry-run               Print commands without executing.
 *
 * Exits non-zero if any replicate fails.
 */
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
	const out = { n: 5, grep: "perf-sidebar-nav", dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case "--tag": out.tag = next(); break;
			case "--kind": out.kind = next(); break;
			case "--n": out.n = Number(next()); break;
			case "--flags": out.flags = next(); break;
			case "--fixture-size": out.fixtureSize = next(); break;
			case "--grep": out.grep = next(); break;
			case "--dry-run": out.dryRun = true; break;
			case "-h":
			case "--help": printHelp(); process.exit(0);
			default:
				console.error(`[perf-bench] unknown arg: ${a}`);
				printHelp(); process.exit(2);
		}
	}
	if (!Number.isInteger(out.n) || out.n < 1 || out.n > 50) {
		console.error(`[perf-bench] --n must be an integer 1..50, got ${out.n}`);
		process.exit(2);
	}
	if (out.n > 1 && !out.tag) {
		console.error(`[perf-bench] --tag is required when --n > 1 (replicates must not collide)`);
		process.exit(2);
	}
	if (out.kind && !["baseline", "experiment"].includes(out.kind)) {
		console.error(`[perf-bench] --kind must be "baseline" or "experiment", got ${out.kind}`);
		process.exit(2);
	}
	return out;
}

function printHelp() {
	console.log(`Usage: node scripts/perf-bench.mjs --tag <name> [--kind baseline|experiment] [--n N]
                              [--flags csv] [--fixture-size small|medium|large]
                              [--grep pattern] [--dry-run]

Runs the manual perf harness N times. Each replicate writes a separate
history JSON tagged "<tag>-<i>". The report aggregates them as min/max
bands around the median.`);
}

function runOnce({ replicateTag, kind, flags, fixtureSize, grep, dryRun }) {
	const env = { ...process.env, BOBBIT_TIMING_LOG: process.env.BOBBIT_TIMING_LOG ?? "1" };
	env.BOBBIT_PERF_HISTORY_TAG = replicateTag;
	if (kind) env.BOBBIT_PERF_HISTORY_KIND = kind;
	if (flags) env.BOBBIT_PERF_FLAGS = flags;
	if (fixtureSize) env.BOBBIT_PERF_FIXTURE_SIZE = fixtureSize;

	// `npx` resolves to a .cmd on Windows; spawn it via the shell so the
	// PATHEXT-aware lookup actually works.
	const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
	const args = [
		"playwright", "test",
		"--config", "playwright-manual.config.ts",
		"--grep", grep,
	];

	console.log(`[perf-bench] → tag=${replicateTag} kind=${kind ?? "(default)"} flags=${flags ?? "(none)"} fixture=${fixtureSize ?? "(default)"}`);
	if (dryRun) {
		console.log(`[perf-bench]   would run: ${cmd} ${args.join(" ")}`);
		return 0;
	}
	const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: "inherit" });
	if (r.error) { console.error(`[perf-bench] spawn error:`, r.error); return 1; }
	return r.status ?? 1;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	console.log(`[perf-bench] running ${opts.n} replicate(s)${opts.tag ? ` of tag "${opts.tag}"` : ""}`);

	let failures = 0;
	const padWidth = String(opts.n).length;
	for (let i = 1; i <= opts.n; i++) {
		const replicateTag = opts.tag
			? `${opts.tag}-${String(i).padStart(padWidth, "0")}`
			: undefined;
		if (!replicateTag) {
			console.error(`[perf-bench] missing tag for replicate ${i}`);
			failures++; continue;
		}
		const status = runOnce({
			replicateTag,
			kind: opts.kind,
			flags: opts.flags,
			fixtureSize: opts.fixtureSize,
			grep: opts.grep,
			dryRun: opts.dryRun,
		});
		if (status !== 0) {
			console.error(`[perf-bench] replicate ${i}/${opts.n} FAILED (exit ${status})`);
			failures++;
		} else {
			console.log(`[perf-bench] replicate ${i}/${opts.n} ok`);
		}
	}

	if (failures > 0) {
		console.error(`[perf-bench] ${failures}/${opts.n} replicate(s) failed`);
		process.exit(1);
	}
	console.log(`[perf-bench] all ${opts.n} replicate(s) ok — refresh docs/perf/sidebar-nav-report.html`);
}

main();
