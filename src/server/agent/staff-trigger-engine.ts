import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import type { StaffManager } from "./staff-manager.js";
import type { SessionManager } from "./session-manager.js";
import type { InboxManager } from "./inbox-manager.js";
import type { LegacyStaffTrigger, PersistedStaff } from "./staff-store.js";

/**
 * Minimal coordinator dependency used by Git-trigger polling. The coordinator
 * owns canonical repository identity and joins concurrent refreshes; this
 * engine only needs to wait for its repository snapshot before comparing the
 * watched ref. `data.fetched` is the coordinator's internal indication that
 * this canonical repository has an origin; `hasRemote` supports adapters that
 * expose the identity result directly.
 */
export interface RepositorySnapshotFreshener {
	ensureFreshRepository(repo: string, options: { reason: "staff-trigger" }): Promise<{
		stale?: boolean;
		lastError?: unknown;
		hasRemote?: boolean;
		data?: { fetched?: boolean };
	}>;
}

type StaffGitRunner = (args: readonly string[], cwd: string, timeout?: number) => Buffer;

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

/** Ordered refs used after the coordinator has refreshed remote-tracking refs. */
function comparisonRefCandidates(branch: string, hasRemote: boolean): string[] {
	if (!hasRemote) return [branch];
	if (branch === "HEAD") return ["@{u}", "HEAD"];
	// Explicit remote-qualified and fully-qualified refs already identify exactly
	// what the trigger author wants to watch.
	if (branch.startsWith("origin/") || branch.startsWith("refs/")) return [branch];
	return [`refs/remotes/origin/${branch}`, branch];
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
	private intervalHandle: ReturnType<Clock["setInterval"]> | null = null;
	private tickInFlight = false;

	constructor(
		private staffManager: StaffManager,
		private sessionManager: SessionManager,
		private inboxManager: InboxManager,
		private readonly clock: Clock = realClock,
		private readonly repositoryFreshener?: RepositorySnapshotFreshener,
		private readonly gitRunner: StaffGitRunner = execGitSync,
	) {
		// `sessionManager` kept on the instance for future use (e.g. trigger
		// preflight checks that need session state). `fireTrigger` itself no
		// longer touches it — enqueueing is pure I/O against the inbox store.
		void this.sessionManager;
	}

	start(): void {
		void this.tick();
		this.intervalHandle = this.clock.setInterval(() => void this.tick(), 60_000);
		console.log("[trigger-engine] Started (60s poll interval)");
	}

	stop(): void {
		if (this.intervalHandle) {
			this.clock.clearInterval(this.intervalHandle);
			this.intervalHandle = null;
			console.log("[trigger-engine] Stopped");
		}
	}

	private async tick(): Promise<void> {
		// A repository refresh may outlive the 60-second interval. Skip an
		// overlapping callback rather than comparing and firing the same trigger
		// concurrently; the next interval will observe the completed refresh.
		if (this.tickInFlight) return;
		this.tickInFlight = true;

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
						fired = await this.checkGitTrigger(staff, trigger);
					} else if (counters) {
						counters.manualTriggers++;
					}
					// "manual" triggers are only fired via the API, never by the engine

					// Once a trigger fires for this staff, skip remaining triggers this tick
					if (fired) { if (counters) counters.fired++; break; }
				}
			}
		} finally {
			this.tickInFlight = false;
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("staff-trigger-engine:tick", performance.now() - diagStart, counters);
			}
		}
	}

	/** Returns true if the trigger was fired. */
	private checkScheduleTrigger(staff: PersistedStaff, trigger: LegacyStaffTrigger): boolean {
		if (!trigger.config.cron) return false;
		const now = new Date(this.clock.now());
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
	private async checkGitTrigger(staff: PersistedStaff, trigger: LegacyStaffTrigger): Promise<boolean> {
		const repo = trigger.config.repo || staff.cwd;
		const branch = trigger.config.branch || "HEAD";
		let hasRemote = false;

		if (this.repositoryFreshener) {
			try {
				const snapshot = await this.repositoryFreshener.ensureFreshRepository(repo, { reason: "staff-trigger" });
				// Only a fresh successful snapshot may order the comparison. Stale
				// last-good state can also be returned when cadence/backoff prevents a
				// refresh, so an error marker alone is not sufficient.
				if (snapshot.stale || snapshot.lastError) return false;
				hasRemote = snapshot.hasRemote ?? snapshot.data?.fetched === true;
			} catch {
				// Coordinator resolution/refresh failures must not produce a trigger.
				return false;
			}
		}

		const candidates = comparisonRefCandidates(branch, hasRemote);
		let sha: string | undefined;
		for (const candidate of candidates) {
			try {
				const candidateSha = this.gitRunner(["log", "--format=%H", "-1", candidate], repo)
					.toString()
					.trim();
				// `%H` must yield exactly one full object id. Besides rejecting broken
				// probes, this keeps repository-controlled text out of the staff prompt.
				if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(candidateSha)) {
					sha = candidateSha.toLowerCase();
					break;
				}
			} catch {
				// A missing upstream/tracking ref falls through to the local ref.
			}
		}

		if (!sha) return false;

		const previousSha = trigger.lastSeenSha;

		if (previousSha && previousSha !== sha) {
			// The configured ref is operator-owned and the object id is validated
			// above. Never read commit subjects here: fetched remote history is an
			// untrusted detection source, not an instruction channel for staff.
			const context = [
				"Git ref changed.",
				`Configured ref: ${JSON.stringify(branch)}`,
				`Commit: ${sha}`,
			].join("\n");

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
	private fireTrigger(staff: PersistedStaff, trigger: LegacyStaffTrigger, extraContext?: string): void {
		console.log(`[trigger-engine] Firing ${trigger.type} trigger "${trigger.id}" for staff "${staff.name}"`);

		this.staffManager.updateTriggerState(staff.id, trigger.id, { lastFired: this.clock.now() });

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
