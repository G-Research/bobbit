import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import type { StaffManager } from "./staff-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { InboxManager } from "./inbox-manager.js";
import type { PersistedStaff, StaffTrigger } from "./staff-store.js";

function childErrorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" || typeof code === "number" ? String(code) : "error";
}

function execGitSync(args: readonly string[], cwd: string, timeout = 5_000): Buffer {
	if (!cpuDiagnosticsEnabled()) {
		return execFileSync("git", args, {
			cwd,
			stdio: "pipe",
			timeout,
		});
	}
	const start = performance.now();
	let success = 0;
	let errorCode = "none";
	try {
		const result = execFileSync("git", args, {
			cwd,
			stdio: "pipe",
			timeout,
		});
		success = 1;
		return result;
	} catch (err) {
		errorCode = childErrorCode(err);
		throw err;
	} finally {
		getCpuDiagnostics().recordChildProcess("staff-trigger:git", performance.now() - start, {
			operation: args[0] || "git",
			success,
			errorCode,
			timeoutMs: timeout,
		});
	}
}

/**
 * Check whether a single cron field matches a given numeric value.
 *
 * Supported syntax per field:
 *   *       — any value
 *   N       — exact match
 *   N-M     — inclusive range
 *   N/S     — step from 0 (alias for * /S when N is *)
 *   N-M/S   — step within range (value in [N..M] and (value-N) % S === 0)
 *   A,B,C   — comma-separated list (each element may itself be range/step)
 */
export function fieldMatches(field: string, value: number): boolean {
	// Comma-separated list — any part matching is sufficient
	const parts = field.split(",");
	for (const part of parts) {
		if (partMatches(part.trim(), value)) return true;
	}
	return false;
}

function partMatches(part: string, value: number): boolean {
	if (part === "*") return true;

	if (part.includes("/")) {
		const [rangePart, stepStr] = part.split("/");
		const step = parseInt(stepStr, 10);
		if (isNaN(step) || step <= 0) return false;

		if (rangePart === "*") {
			return value % step === 0;
		}

		if (rangePart.includes("-")) {
			const [loStr, hiStr] = rangePart.split("-");
			const lo = parseInt(loStr, 10);
			const hi = parseInt(hiStr, 10);
			return value >= lo && value <= hi && (value - lo) % step === 0;
		}

		// Single value with step — treat like */step
		return value % step === 0;
	}

	if (part.includes("-")) {
		const [loStr, hiStr] = part.split("-");
		const lo = parseInt(loStr, 10);
		const hi = parseInt(hiStr, 10);
		return value >= lo && value <= hi;
	}

	return parseInt(part, 10) === value;
}

/**
 * Check whether a 5-field cron expression matches a given Date.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Day of week: 0 = Sunday, 7 = Sunday (both valid).
 */
export function cronMatches(expr: string, date: Date): boolean {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return false;

	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

	if (!fieldMatches(minute, date.getMinutes())) return false;
	if (!fieldMatches(hour, date.getHours())) return false;
	if (!fieldMatches(dayOfMonth, date.getDate())) return false;
	if (!fieldMatches(month, date.getMonth() + 1)) return false;

	// Day of week: normalize 7 → 0 (both mean Sunday)
	const dow = date.getDay(); // 0=Sun
	if (dayOfWeek !== "*") {
		// Normalize the field so that 7 → 0
		const normalized = dayOfWeek.replace(/\b7\b/g, "0");
		if (!fieldMatches(normalized, dow)) return false;
	}

	return true;
}

/**
 * TriggerEngine polls every 60 seconds, checking active staff agents' triggers.
 *
 * - Schedule triggers: cron expression evaluation against current time
 * - Git triggers: compare latest commit SHA to persisted lastSeenSha
 * - Manual triggers are never auto-fired (invoked via API only)
 *
 * Resource model: no processes run when staff agents are sleeping. Only the
 * 60-second interval and cheap git log checks consume resources.
 */
export class TriggerEngine {
	private intervalHandle: ReturnType<typeof setInterval> | null = null;

	constructor(
		private staffManager: StaffManager,
		private sessionManager: SessionManager,
		private inboxManager: InboxManager,
	) {
		// `sessionManager` kept on the instance for future use (e.g. trigger
		// preflight checks that need session state). `fireTrigger` itself no
		// longer touches it — enqueueing is pure I/O against the inbox store.
		void this.sessionManager;
	}

	start(): void {
		this.tick();
		this.intervalHandle = setInterval(() => this.tick(), 60_000);
		console.log("[trigger-engine] Started (60s poll interval)");
	}

	stop(): void {
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
			console.log("[trigger-engine] Stopped");
		}
	}

	private tick(): void {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? {
			ticks: 1,
			staffScanned: 0,
			activeStaff: 0,
			skippedInactive: 0,
			triggersScanned: 0,
			disabledTriggers: 0,
			scheduleChecks: 0,
			gitChecks: 0,
			manualTriggers: 0,
			fired: 0,
		} : undefined;
		try {
			const allStaff = this.staffManager.listStaff();
			if (counters) counters.staffScanned = allStaff.length;
			for (const staff of allStaff) {
				if (staff.state !== "active") { if (counters) counters.skippedInactive++; continue; }
				if (counters) counters.activeStaff++;

				// No streaming/starting skip and no in-flight guard — enqueueing is
				// synchronous against the JSON-backed inbox store, so there is no
				// race to gate. The InboxNudger separately decides when to deliver
				// the accumulated work to the agent.

				for (const trigger of staff.triggers) {
					if (!trigger.enabled) { if (counters) counters.disabledTriggers++; continue; }
					if (counters) counters.triggersScanned++;
					let fired = false;
					if (trigger.type === "schedule") {
						if (counters) counters.scheduleChecks++;
						fired = this.checkScheduleTrigger(staff, trigger);
					} else if (trigger.type === "git") {
						if (counters) counters.gitChecks++;
						fired = this.checkGitTrigger(staff, trigger);
					} else if (counters) {
						counters.manualTriggers++;
					}
					// "manual" triggers are only fired via the API, never by the engine

					// Once a trigger fires for this staff, skip remaining triggers this tick
					if (fired) { if (counters) counters.fired++; break; }
				}
			}
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("staff-trigger-engine:tick", performance.now() - diagStart, counters);
			}
		}
	}

	/** Returns true if the trigger was fired. */
	private checkScheduleTrigger(staff: PersistedStaff, trigger: StaffTrigger): boolean {
		if (!trigger.config.cron) return false;
		const now = new Date();
		if (!cronMatches(trigger.config.cron, now)) return false;

		// Don't re-fire in the same minute
		if (trigger.lastFired) {
			const lastFiredMinute = Math.floor(trigger.lastFired / 60_000);
			const currentMinute = Math.floor(now.getTime() / 60_000);
			if (lastFiredMinute === currentMinute) return false;
		}

		this.fireTrigger(staff, trigger);
		return true;
	}

	/** Returns true if the trigger was fired. */
	private checkGitTrigger(staff: PersistedStaff, trigger: StaffTrigger): boolean {
		const repo = trigger.config.repo || staff.cwd;
		const branch = trigger.config.branch || "HEAD";

		let sha: string;
		try {
			sha = execGitSync(["log", "--format=%H", "-1", branch], repo)
				.toString()
				.trim();
		} catch {
			// Git command failed — repo may not exist or branch is invalid. Skip silently.
			return false;
		}

		if (!sha) return false;

		const previousSha = trigger.lastSeenSha;

		if (previousSha && previousSha !== sha) {
			// New commit(s) detected — build context and fire
			let context = `New commit on ${branch}: ${sha}`;
			try {
				const log = execGitSync(["log", "--oneline", `${previousSha}..${sha}`], repo)
					.toString()
					.trim();
				if (log) context += "\n\nRecent commits:\n" + log;
			} catch {
				// Diff log failed — proceed with basic context
			}

			// Always update lastSeenSha before firing
			this.staffManager.updateTriggerState(staff.id, trigger.id, { lastSeenSha: sha });
			this.fireTrigger(staff, trigger, context);
			return true;
		}

		// Always update lastSeenSha (initializes on first tick, tracks on subsequent)
		this.staffManager.updateTriggerState(staff.id, trigger.id, { lastSeenSha: sha });
		return false;
	}

	/**
	 * Append a new entry to the staff's inbox. Synchronous — returns once
	 * the JSON file has been written. `InboxManager.enqueue` calls
	 * `nudger.poke(staffId)` so an already-idle staff is woken on the next
	 * microtask; otherwise the 15 s nudger tick picks it up the next time
	 * the staff goes idle.
	 */
	private fireTrigger(staff: PersistedStaff, trigger: StaffTrigger, extraContext?: string): void {
		console.log(`[trigger-engine] Firing ${trigger.type} trigger "${trigger.id}" for staff "${staff.name}"`);

		this.staffManager.updateTriggerState(staff.id, trigger.id, { lastFired: Date.now() });

		let prompt = trigger.prompt || `Trigger fired: ${trigger.type}`;
		if (extraContext) {
			prompt += "\n\n" + extraContext;
		}

		const titleHint = trigger.config.cron ?? trigger.config.branch ?? trigger.id;
		try {
			this.inboxManager.enqueue(staff.id, {
				title: `${trigger.type}: ${titleHint}`,
				prompt,
				context: extraContext,
				source: { type: "trigger", triggerId: trigger.id },
			});
		} catch (err) {
			console.error(`[trigger-engine] Failed to enqueue inbox entry for staff "${staff.name}":`, err);
		}
	}
}
