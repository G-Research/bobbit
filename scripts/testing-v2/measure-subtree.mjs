/**
 * measure-subtree.mjs — fair subtree-scoped wall+CPU measurement (task 7862db76).
 *
 * Re-implements the head-to-head §2/§5 methodology as a committed, reusable tool
 * (the original `measure.mjs` was kept out-of-tree). It spawns a command and
 * samples the CPU of ONLY the spawned command's process subtree, correcting the
 * two Windows over-count failure modes the pid-only sampler suffers (§5):
 *   1. PID reuse — key cumulative CPU on (pid, CreationDate), not pid alone.
 *   2. Stale-ppid / Idle (PID 0/4) misattribution — EXCLUDE any subtree process
 *      created BEFORE the run started (and PID 0/4), so the Windows Idle process,
 *      the dev server, Defender, etc. can never leak in via a reused-ppid collision.
 *
 * Usage:
 *   node scripts/testing-v2/measure-subtree.mjs <label> <out.json> -- <cmd...>
 * Emits a JSON report and prints a one-line summary. Exit code = child's code.
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep < 2) {
	console.error("usage: measure-subtree.mjs <label> <out.json> -- <cmd...>");
	process.exit(2);
}
const label = argv[0];
const outPath = argv[1];
const cmd = argv.slice(sep + 1);
if (cmd.length === 0) { console.error("no command"); process.exit(2); }

const isWin = process.platform === "win32";

/** Parse a CIM/WMI CreationDate (either "/Date(ms)/" or ISO/CIM string) → epoch ms, or null. */
function parseCreation(raw) {
	if (raw == null) return null;
	if (typeof raw === "number") return raw;
	const s = String(raw);
	const m = s.match(/\/Date\((\d+)\)\//);
	if (m) return Number(m[1]);
	// CIM DMTF datetime: yyyymmddHHMMSS.ffffff+zzz
	const dmtf = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
	if (dmtf) {
		const [, y, mo, d, h, mi, se] = dmtf;
		const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
		return Number.isFinite(t) ? t : null;
	}
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : null;
}

function listProcesses() {
	if (!isWin) {
		// ps: pid,ppid,etimes(seconds),time(cpu). Good enough on posix; CI is Windows-first.
		const res = spawnSync("ps", ["-eo", "pid=,ppid=,time=,lstart="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		if (res.status !== 0 || !res.stdout) return [];
		return res.stdout.trim().split("\n").map((ln) => {
			const parts = ln.trim().split(/\s+/);
			const pid = Number(parts[0]); const ppid = Number(parts[1]);
			const time = parts[2];
			const [hh, mm, ss] = time.includes(":") ? time.split(":") : ["0", "0", time];
			const cpuMs = ((+hh || 0) * 3600 + (+mm || 0) * 60 + (+ss || 0)) * 1000;
			return { pid, ppid, cpuMs, creation: null };
		}).filter((r) => Number.isFinite(r.pid));
	}
	const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
	const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
	if (res.status !== 0 || !res.stdout) return [];
	let rows;
	try { rows = JSON.parse(res.stdout); } catch { return []; }
	if (!Array.isArray(rows)) rows = [rows];
	return rows.map((r) => ({
		pid: Number(r.ProcessId),
		ppid: Number(r.ParentProcessId),
		creation: parseCreation(r.CreationDate),
		cpuMs: ((Number(r.KernelModeTime) || 0) + (Number(r.UserModeTime) || 0)) / 10_000,
	})).filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.ppid));
}

function descendants(all, root) {
	const byParent = new Map();
	for (const r of all) { if (!byParent.has(r.ppid)) byParent.set(r.ppid, []); byParent.get(r.ppid).push(r); }
	const out = []; const seen = new Set(); const stack = [root];
	while (stack.length) {
		const pid = stack.pop();
		for (const child of byParent.get(pid) || []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid); out.push(child); stack.push(child.pid);
		}
	}
	return out;
}

const runStart = Date.now();
// small grace so a child created in the same ms as runStart is not excluded
const CREATION_FLOOR = runStart - 1500;

const perKey = new Map(); // `${pid}|${creation}` -> max cumulative cpuMs
let peakProcesses = 0;
let samples = 0;
let excludedCpuMs = 0; // CPU attributed to excluded (pre-run / PID 0/4) procs — reported for transparency

const child = spawn(cmd[0], cmd.slice(1), {
	stdio: ["inherit", "pipe", "pipe"],
	shell: isWin, // npm.cmd / npx.cmd need a shell on Windows
});
// Explicitly forward child output: under shell:true on Windows, plain
// stdio:"inherit" did not always propagate the grandchild TAP stream to a
// captured pipe. Piping guarantees the run's pass/fail summary is visible.
child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);

function sampleOnce(rootPid) {
	const all = listProcesses();
	const tree = descendants(all, rootPid);
	// include the root itself
	const rootRow = all.find((r) => r.pid === rootPid);
	if (rootRow) tree.push(rootRow);
	let live = 0;
	for (const r of tree) {
		const included = r.pid !== 0 && r.pid !== 4 && r.creation != null && r.creation >= CREATION_FLOOR;
		if (!included) { excludedCpuMs = Math.max(excludedCpuMs, excludedCpuMs); continue; }
		live++;
		const key = `${r.pid}|${r.creation}`;
		perKey.set(key, Math.max(perKey.get(key) || 0, r.cpuMs));
	}
	peakProcesses = Math.max(peakProcesses, live);
	samples++;
}

const timer = setInterval(() => { try { sampleOnce(child.pid); } catch { /* ignore */ } }, 1000);

child.on("close", (code, signal) => {
	clearInterval(timer);
	try { sampleOnce(child.pid); } catch { /* ignore */ }
	let cpuMs = 0;
	for (const v of perKey.values()) cpuMs += v;
	const wallMs = Math.round(performance.now() - performance.timeOrigin + performance.timeOrigin) && (Date.now() - runStart);
	const report = {
		label,
		cmd,
		code: code ?? (signal ? 1 : 0),
		signal: signal || null,
		wallMs: Date.now() - runStart,
		wallSec: +((Date.now() - runStart) / 1000).toFixed(1),
		cpuMin: +(cpuMs / 60000).toFixed(2),
		cpuMs: Math.round(cpuMs),
		peakProcesses,
		samples,
		trackedProcesses: perKey.size,
		startedAt: new Date(runStart).toISOString(),
		note: "subtree CPU keyed on (pid,CreationDate); procs created before run start and PID 0/4 excluded (corrects head-to-head §5 over-count).",
	};
	try { mkdirSync(dirname(outPath), { recursive: true }); } catch { /* ignore */ }
	writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
	console.log(`\n[measure] ${label}: ${report.wallSec}s wall, ${report.cpuMin} CPU-min (peak procs ${peakProcesses}, tracked ${perKey.size}) → ${outPath}`);
	process.exit(report.code);
});
child.on("error", (e) => { clearInterval(timer); console.error("[measure] spawn error:", e); process.exit(1); });
