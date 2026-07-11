/**
 * Boot/shutdown timing tee.
 *
 * The gateway logs boot- and shutdown-phase timings to stdout, which the dev
 * harness inherits into the operator's terminal. An agent session running
 * *inside* the gateway cannot read that terminal, so these same lines are also
 * appended to `<stateDir>/boot-timings.log`. That gives a readable, persistent
 * record of the most recent boot + shutdown cycle for post-restart diagnosis.
 *
 * Best-effort only: any filesystem error is swallowed so instrumentation can
 * never affect gateway startup/shutdown behaviour.
 */

import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "./bobbit-dir.js";

const MAX_BYTES = 256 * 1024;

/** Phase-timer log threshold: only phases at/above this are logged. */
export const SLOW_PHASE_MS = 50;

function logFilePath(): string | null {
	try {
		return path.join(bobbitStateDir(), "boot-timings.log");
	} catch {
		return null;
	}
}

function append(line: string): void {
	const p = logFilePath();
	if (!p) return;
	try {
		// Ensure the state dir exists so the earliest boot lines aren't dropped
		// on a fresh install (append would otherwise ENOENT and be swallowed).
		fs.mkdirSync(path.dirname(p), { recursive: true });
		// Bound the file so repeated restarts can't grow it without limit: once it
		// exceeds MAX_BYTES, keep only the trailing half (from the next line break,
		// so we never leave a partial fragment as the first line) before appending.
		try {
			const st = fs.statSync(p);
			if (st.size > MAX_BYTES) {
				const buf = fs.readFileSync(p);
				let tail = buf.subarray(buf.length - Math.floor(MAX_BYTES / 2));
				const nl = tail.indexOf(0x0a); // drop the leading partial line
				if (nl >= 0 && nl + 1 < tail.length) tail = tail.subarray(nl + 1);
				fs.writeFileSync(p, tail);
			}
		} catch { /* file may not exist yet */ }
		fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`);
	} catch { /* best-effort */ }
}

/**
 * Build an async phase timer that logs `<prefix> <name> in <ms>` (tee'd to the
 * timings file) when a phase takes at least SLOW_PHASE_MS. Shared by the
 * pre-listen boot path and the shutdown path so the two timers can't drift.
 */
export function makePhaseTimer(prefix: string): <T>(name: string, fn: () => T | Promise<T>) => Promise<T> {
	return async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
		const t0 = Date.now();
		try {
			return await fn();
		} finally {
			const dt = Date.now() - t0;
			if (dt >= SLOW_PHASE_MS) bootLog(`${prefix} ${name} in ${dt}ms`);
		}
	};
}

/** Log a boot/shutdown line to stdout AND append it to the timings file. */
export function bootLog(line: string): void {
	console.log(line);
	append(line);
}

/** Write a cycle separator (boot/shutdown start) to stdout and the file. */
export function bootMark(marker: string): void {
	const line = `===== ${marker} =====`;
	console.log(line);
	append(line);
}
