import { spawnSync } from "node:child_process";

/** Parse a Windows CIM, ISO, or POSIX `ps lstart` timestamp. */
export function parseProcessCreation(raw) {
	if (raw == null) return null;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
	const text = String(raw).trim();
	const dotNet = text.match(/\/Date\((\d+)\)\//);
	if (dotNet) return Number(dotNet[1]);
	const dmtf = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-])(\d{3})/);
	if (dmtf) {
		const [, year, month, day, hour, minute, second, sign, offsetMinutes] = dmtf;
		const localAsUtc = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
		const offset = Number(offsetMinutes) * 60_000 * (sign === "+" ? 1 : -1);
		const parsed = localAsUtc - offset;
		return Number.isFinite(parsed) ? parsed : null;
	}
	const parsed = Date.parse(text);
	return Number.isFinite(parsed) ? parsed : null;
}

export function parsePosixCpuTime(value) {
	let days = 0;
	let rest = String(value ?? "");
	if (rest.includes("-")) {
		const split = rest.split("-", 2);
		days = Number(split[0]) || 0;
		rest = split[1];
	}
	const parts = rest.split(":").map(Number);
	let hours = 0;
	let minutes = 0;
	let seconds = 0;
	if (parts.length === 3) [hours, minutes, seconds] = parts;
	else if (parts.length === 2) [minutes, seconds] = parts;
	else seconds = parts[0] || 0;
	return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** Return process rows with a stable `(pid, creation)` identity on every OS. */
export function listProcessTreeRows(platform = process.platform, run = spawnSync) {
	if (platform === "win32") {
		const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
		const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8",
			windowsHide: true,
			maxBuffer: 128 * 1024 * 1024,
		});
		if (result.status !== 0 || !result.stdout?.trim()) return [];
		let rows;
		try {
			const parsed = JSON.parse(result.stdout);
			rows = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			return [];
		}
		return rows.map((row) => ({
			pid: Number(row.ProcessId),
			ppid: Number(row.ParentProcessId),
			creation: parseProcessCreation(row.CreationDate),
			cpuMs: ((Number(row.KernelModeTime) || 0) + (Number(row.UserModeTime) || 0)) / 10_000,
		})).filter(validProcessRow);
	}

	const result = run("ps", ["-eo", "pid=,ppid=,time=,lstart="], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0 || !result.stdout?.trim()) return [];
	return result.stdout.trim().split(/\r?\n/).map((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
		if (!match) return null;
		return {
			pid: Number(match[1]),
			ppid: Number(match[2]),
			cpuMs: parsePosixCpuTime(match[3]),
			creation: parseProcessCreation(match[4]),
		};
	}).filter(validProcessRow);
}

function validProcessRow(row) {
	return row && Number.isFinite(row.pid) && Number.isFinite(row.ppid)
		&& Number.isFinite(row.cpuMs) && Number.isFinite(row.creation);
}

export function processDescendants(rows, rootPid, include = () => true) {
	const byParent = new Map();
	for (const row of rows) {
		if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
		byParent.get(row.ppid).push(row);
	}
	const descendants = [];
	const seen = new Set();
	const stack = [rootPid];
	while (stack.length > 0) {
		const pid = stack.pop();
		for (const child of byParent.get(pid) ?? []) {
			const identity = `${child.pid}|${child.creation}`;
			if (seen.has(identity) || !include(child)) continue;
			seen.add(identity);
			descendants.push(child);
			stack.push(child.pid);
		}
	}
	return descendants;
}

/**
 * Sample cumulative CPU by stable process identity. The creation floor rejects
 * stale-PPID/PID-reuse collisions while retaining the explicitly owned root.
 */
export function createIdentityCpuSampler(rootPid, {
	intervalMs = 1000,
	runStartedAt = Date.now(),
	listProcesses = () => listProcessTreeRows(),
	subtractRootBaseline = false,
} = {}) {
	const creationFloor = runStartedAt - 1500;
	const records = new Map();
	let peakProcesses = 0;
	let samples = 0;
	let previousMarkCpuMs = 0;
	let previousMarkSamples = 0;
	let previousMarkAt = runStartedAt;
	let phasePeakProcesses = 0;
	let initializing = true;

	const sample = () => {
		const rows = listProcesses();
		const root = rows.find((row) => row.pid === rootPid);
		const tree = processDescendants(rows, rootPid, (row) => row.pid !== 0 && row.pid !== 4 && row.creation >= creationFloor);
		if (root) tree.push(root);
		let live = 0;
		for (const row of tree) {
			if (row.pid === 0 || row.pid === 4) continue;
			if (row.pid !== rootPid && row.creation < creationFloor) continue;
			live += 1;
			const identity = `${row.pid}|${row.creation}`;
			const existing = records.get(identity);
			if (!existing) {
				records.set(identity, {
					pid: row.pid,
					ppid: row.ppid,
					creation: row.creation,
					firstSeenAt: Date.now(),
					lastSeenAt: Date.now(),
					baselineCpuMs: initializing && subtractRootBaseline && row.pid === rootPid ? Math.max(0, row.cpuMs) : 0,
					cumulativeCpuMs: Math.max(0, row.cpuMs),
				});
			} else {
				existing.lastSeenAt = Date.now();
				existing.cumulativeCpuMs = Math.max(existing.cumulativeCpuMs, row.cpuMs);
			}
		}
		peakProcesses = Math.max(peakProcesses, live);
		phasePeakProcesses = Math.max(phasePeakProcesses, live);
		samples += 1;
		initializing = false;
	};

	const cpuTotal = () => [...records.values()].reduce((sum, row) => sum + Math.max(0, row.cumulativeCpuMs - row.baselineCpuMs), 0);
	const snapshot = () => ({
		cpuMs: Math.round(cpuTotal()),
		peakProcesses,
		samples,
		trackedProcesses: records.size,
		processes: [...records.values()].map(({ baselineCpuMs, cumulativeCpuMs, ...row }) => ({
			...row,
			cpuMs: Math.max(0, cumulativeCpuMs - baselineCpuMs),
		})).sort((a, b) => a.creation - b.creation || a.pid - b.pid),
	});

	sample();
	const timer = setInterval(sample, intervalMs);
	if (typeof timer.unref === "function") timer.unref();
	return {
		sampleNow: sample,
		snapshot,
		mark(label, markedAt = Date.now()) {
			sample();
			const current = snapshot();
			const phase = {
				label,
				startedAt: new Date(previousMarkAt).toISOString(),
				endedAt: new Date(markedAt).toISOString(),
				cpuMs: Math.max(0, current.cpuMs - previousMarkCpuMs),
				peakProcesses: phasePeakProcesses,
				samples: Math.max(0, current.samples - previousMarkSamples),
			};
			previousMarkCpuMs = current.cpuMs;
			previousMarkSamples = current.samples;
			previousMarkAt = markedAt;
			phasePeakProcesses = 0;
			return phase;
		},
		stop() {
			clearInterval(timer);
			sample();
			return snapshot();
		},
	};
}
