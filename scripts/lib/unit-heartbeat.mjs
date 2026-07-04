/**
 * Shared helper for scripts/run-unit.mjs — render the node-logic runner's
 * hung-test heartbeat (written by tests/helpers/hung-test-reporter.mjs) into
 * human diagnostics that NAME the test file(s) still in flight when the wrapper's
 * runner-timeout fires. Extracted so the diagnostic logic is unit-tested directly
 * rather than only string-matched against the runner source.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * @param {string} heartbeatFile absolute path to the heartbeat JSON
 * @param {number} [now] injectable clock for deterministic tests
 * @returns {string[]} diagnostic lines (already prefixed for the gate tail)
 */
export function readHeartbeatDiagnostics(heartbeatFile, now = Date.now()) {
	if (!existsSync(heartbeatFile)) {
		return [`[run-unit] no node heartbeat file at ${heartbeatFile} — cannot name in-flight test files (runner may have hung before any file dequeued).`];
	}
	let hb;
	try {
		hb = JSON.parse(readFileSync(heartbeatFile, "utf8"));
	} catch (err) {
		return [`[run-unit] could not parse node heartbeat ${heartbeatFile}: ${err?.message || err}`];
	}
	const lines = [];
	const sinceMs = Number.isFinite(hb?.lastEventAt) ? now - hb.lastEventAt : undefined;
	lines.push(
		`[run-unit] node heartbeat: ${hb?.completedFiles ?? "?"} test file(s) completed; last node:test event ${sinceMs != null ? `${(sinceMs / 1000).toFixed(1)}s ago` : "at an unknown time"}.`,
	);
	const active = Array.isArray(hb?.activeFiles) ? hb.activeFiles : [];
	if (active.length === 0) {
		lines.push("[run-unit] no test files were still in flight — the hang is likely outside a test file (leaked handle/descendant, or between files).");
	} else {
		lines.push(`[run-unit] ${active.length} test file(s) still in flight at timeout (most likely hung):`);
		for (const entry of active) {
			const heldMs = Number.isFinite(entry?.startedAt) ? now - entry.startedAt : undefined;
			lines.push(`[run-unit]   HUNG FILE: ${entry?.file}${heldMs != null ? ` (running ${(heldMs / 1000).toFixed(1)}s)` : ""}`);
		}
	}
	const running = Array.isArray(hb?.runningTests) ? hb.runningTests : [];
	for (const t of running) {
		lines.push(`[run-unit]   in-flight test: ${t?.name} (${t?.file})`);
	}
	return lines;
}
