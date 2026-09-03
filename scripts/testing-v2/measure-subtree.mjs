#!/usr/bin/env node
/**
 * Fair subtree-scoped wall/CPU measurement.
 *
 * Usage:
 *   node scripts/testing-v2/measure-subtree.mjs <label> <out.json> -- <cmd...>
 *
 * CPU is keyed by `(pid, creation)` on every supported OS. Processes created
 * before the measured command and Windows PID 0/4 are excluded, preventing PID
 * reuse and stale-PPID collisions from inflating qualification evidence.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createIdentityCpuSampler } from "./process-tree-sampler.mjs";

export function parseMeasureSubtreeArgs(argv) {
	const separator = argv.indexOf("--");
	if (separator < 2) throw new Error("usage: measure-subtree.mjs <label> <out.json> -- <cmd...>");
	const command = argv.slice(separator + 1);
	if (command.length === 0) throw new Error("measure-subtree.mjs: no command");
	return { label: argv[0], outPath: argv[1], command };
}

export async function measureSubtree({ label, outPath, command }, {
	platform = process.platform,
	spawnProcess = spawn,
	createSampler = createIdentityCpuSampler,
} = {}) {
	const startedAt = Date.now();
	// Resolve the two Windows command shims used by qualification to their JS
	// entrypoints. Node cannot spawn .cmd with shell:false; using the npm CLI
	// keeps every following token opaque instead of concatenating shell text.
	let executable = command[0];
	let commandArgs = command.slice(1);
	if (platform === "win32" && /^(?:npm|npx)$/i.test(command[0])) {
		const tool = command[0].toLowerCase();
		const inheritedNpmCli = process.env.npm_execpath;
		const npmBin = inheritedNpmCli && /npm-cli\.js$/i.test(basename(inheritedNpmCli))
			? dirname(inheritedNpmCli)
			: join(dirname(process.execPath), "node_modules", "npm", "bin");
		const cli = join(npmBin, `${tool}-cli.js`);
		if (!existsSync(cli)) throw new Error(`measure-subtree.mjs: cannot resolve ${tool} CLI at ${cli}`);
		executable = process.execPath;
		commandArgs = [cli, ...commandArgs];
	}
	const child = spawnProcess(executable, commandArgs, {
		stdio: ["inherit", "pipe", "pipe"],
		shell: false,
	});
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	const sampler = createSampler(child.pid, { runStartedAt: startedAt, intervalMs: 1000 });

	const exit = await new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.once("close", (code, signal) => finish({ code: code ?? (signal ? 1 : 0), signal: signal ?? null }));
		child.once("error", (error) => finish({ code: 1, signal: null, error: String(error) }));
	});
	const sample = sampler.stop();
	const endedAt = Date.now();
	const report = {
		schema: 3,
		kind: "subtree-measurement",
		label,
		cmd: command,
		code: exit.code,
		signal: exit.signal,
		...(exit.error ? { error: exit.error } : {}),
		wallMs: endedAt - startedAt,
		wallSec: +((endedAt - startedAt) / 1000).toFixed(1),
		cpuMin: +(sample.cpuMs / 60_000).toFixed(3),
		cpuMs: sample.cpuMs,
		peakProcesses: sample.peakProcesses,
		samples: sample.samples,
		trackedProcesses: sample.trackedProcesses,
		rootProcess: { pid: child.pid, creation: sample.processes.find((row) => row.pid === child.pid)?.creation ?? null },
		processes: sample.processes,
		startedAt: new Date(startedAt).toISOString(),
		endedAt: new Date(endedAt).toISOString(),
		accounting: {
			authority: "outer",
			boundary: "spawned-command-subtree",
			method: "pid-creation-subtree",
			identity: "pid+creation",
		},
		note: "authoritative outer subtree CPU keyed on (pid,creation); pre-run descendants and PID 0/4 excluded",
	};
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
	return report;
}

async function main() {
	let options;
	try {
		options = parseMeasureSubtreeArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error.message);
		process.exit(2);
	}
	const report = await measureSubtree(options);
	console.log(`\n[measure] ${report.label}: ${report.wallSec}s wall, ${report.cpuMin} CPU-min (peak procs ${report.peakProcesses}, tracked ${report.trackedProcesses}) → ${options.outPath}`);
	process.exit(report.code);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => {
	console.error("[measure] fatal:", error);
	process.exit(1);
});
