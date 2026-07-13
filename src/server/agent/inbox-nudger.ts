import { performance } from "node:perf_hooks";
import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import type { SessionManager } from "./session-manager.js";
import type { StaffManager } from "./staff-manager.js";
import type { InboxStore } from "./inbox-store.js";
import type { PersistedStaff } from "./staff-store.js";

/**
 * Periodic check that wakes idle staff agents whose inbox has pending
 * entries. Mirrors the structure of `TeamManager.startIdleNudgeTimer`
 * (`team-manager.ts:148, 384, 419, 543-560`) but with the inverse
 * invariant: inbox nudges only fire against **idle** sessions, never
 * productive ones — so there is no exponential backoff. A staff that
 * idles with `pending > 0` gets nudged on the next tick or sooner.
 *
 * Latency:
 *  - **trigger → nudge edge**: `InboxManager.enqueue` calls `poke(staffId)`
 *    which schedules a one-shot `tickOne` on the next microtask, so an
 *    already-idle staff is woken with effectively zero latency.
 *  - **idle → nudge edge**: the periodic 15 s `setInterval` is the
 *    fallback for the case where the staff becomes idle some time
 *    *after* the enqueue (so `poke` ran while still streaming and was
 *    gated out by `tickOne`'s status check).
 *
 * State transitions (per staff):
 *  - `nudgePending` is set inside `applyPolicyThenNudge` before the
 *    digest prompt is delivered, and cleared either by a successful
 *    `onAgentStart` hook (the agent has begun its turn) or by an
 *    exception caught inside `applyPolicyThenNudge` (so a transient
 *    failure doesn't permanently silence the staff).
 */
export interface InboxNudgerDeps {
	sessionManager: SessionManager;
	staffManager: StaffManager;
	inboxStore: InboxStore;
	clock?: Clock;
}

export class InboxNudger {
	static readonly TICK_INTERVAL_MS = 15_000;

	private intervalHandle: ReturnType<Clock["setInterval"]> | null = null;
	private readonly nudgePending: Map<string, boolean> = new Map();
	private readonly sessionManager: SessionManager;
	private readonly staffManager: StaffManager;
	private readonly inboxStore: InboxStore;
	private readonly clock: Clock;

	constructor(deps: InboxNudgerDeps) {
		this.sessionManager = deps.sessionManager;
		this.staffManager = deps.staffManager;
		this.inboxStore = deps.inboxStore;
		this.clock = deps.clock ?? realClock;
	}

	start(): void {
		if (this.intervalHandle) return;
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("inbox-nudger:interval", 0, { starts: 1, intervalMs: InboxNudger.TICK_INTERVAL_MS });
		}
		this.intervalHandle = this.clock.setInterval(() => {
			this.tick();
		}, InboxNudger.TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.intervalHandle) {
			this.clock.clearInterval(this.intervalHandle);
			this.intervalHandle = null;
			if (cpuDiagnosticsEnabled()) {
				getCpuDiagnostics().recordTimer("inbox-nudger:interval", 0, { stops: 1 });
			}
		}
	}

	/**
	 * Hint from `InboxManager.enqueue` that an entry was just appended for
	 * `staffId`. Schedules a one-shot `tickOne` on the next microtask so
	 * an idle staff can be woken without waiting up to 15 s for the next
	 * periodic tick. Idempotent across multiple pokes — the eventual
	 * `tickOne` consults `nudgePending` exactly like the periodic tick.
	 */
	poke(staffId: string): void {
		if (cpuDiagnosticsEnabled()) {
			getCpuDiagnostics().recordTimer("inbox-nudger:poke", 0, { pokes: 1 });
		}
		queueMicrotask(() => {
			try {
				this.tickOne(staffId);
			} catch (err) {
				console.error(`[inbox-nudger] poke->tickOne failed for staff ${staffId}:`, err);
			}
		});
	}

	/**
	 * Called from the session-manager `agent_start` event hook for any
	 * session whose `staffId` is set. Clears `nudgePending` so a fresh
	 * batch can be delivered next time the staff goes idle.
	 */
	onAgentStart(sessionId: string): void {
		// Find the staff whose currentSessionId matches.
		for (const staff of this.staffManager.listStaff()) {
			if (staff.currentSessionId === sessionId) {
				this.nudgePending.delete(staff.id);
				return;
			}
		}
	}

	private tick(): void {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		let staffScanned = 0;
		let errors = 0;
		try {
			for (const staff of this.staffManager.listStaff()) {
				if (diagEnabled) staffScanned++;
				try {
					this.tickOne(staff.id, staff);
				} catch (err) {
					if (diagEnabled) errors++;
					console.error(`[inbox-nudger] tickOne failed for staff ${staff.id}:`, err);
				}
			}
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("inbox-nudger:tick", performance.now() - diagStart, {
					ticks: 1,
					staffScanned,
					errors,
				});
			}
		}
	}

	private tickOne(staffId: string, staffArg?: PersistedStaff): void {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? {
			tickOneCalls: 1,
			skippedInactive: 0,
			skippedNoSession: 0,
			skippedNotIdle: 0,
			skippedNudgePending: 0,
			pendingListCalls: 0,
			pendingEntries: 0,
			skippedNoPending: 0,
			nudgesScheduled: 0,
		} : undefined;
		try {
			const staff = staffArg ?? this.staffManager.getStaff(staffId);
			if (!staff || staff.state !== "active") { if (counters) counters.skippedInactive = 1; return; }
			if (!staff.currentSessionId) { if (counters) counters.skippedNoSession = 1; return; }
			const session = this.sessionManager.getSession(staff.currentSessionId);
			if (!session || session.status !== "idle") { if (counters) counters.skippedNotIdle = 1; return; } // mirrors team-manager.ts:388
			if (this.nudgePending.get(staff.id)) { if (counters) counters.skippedNudgePending = 1; return; }
			if (counters) counters.pendingListCalls = 1;
			const pending = this.inboxStore.listPending(staff.id);
			if (counters) counters.pendingEntries = pending.length;
			if (pending.length === 0) { if (counters) counters.skippedNoPending = 1; return; }
			if (counters) counters.nudgesScheduled = 1;
			void this.applyPolicyThenNudge(staff, pending.length);
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("inbox-nudger:tickOne", performance.now() - diagStart, counters);
			}
		}
	}

	private async applyPolicyThenNudge(staff: PersistedStaff, count: number): Promise<void> {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		const counters = diagEnabled ? { attempts: 1, compactCalls: 0, updateStaffErrors: 0, nudgesSent: 0, errors: 0 } : undefined;
		this.nudgePending.set(staff.id, true);
		try {
			if (staff.contextPolicy === "compact") {
				if (counters) counters.compactCalls = 1;
				await this.runCompact(staff.currentSessionId!);
			}
			const word = count === 1 ? "item" : "items";
			const msg =
				`[INBOX] You have ${count} pending ${word}. ` +
				`Use inbox_list to inspect, then process each with inbox_complete or inbox_dismiss.`;
			// `lastWakeAt` is now owned by the nudger — the sole driver of staff
			// wakes post-inbox (the legacy public method on StaffManager is
			// removed; see docs/design/staff-inbox.md §9). Persists across
			// restart for UI "last seen" displays. Set before enqueuePrompt so even if
			// delivery fails the user can see the attempt timestamp.
			try {
				this.staffManager.updateStaff(staff.id, { lastWakeAt: this.clock.now() });
			} catch (err) {
				if (counters) counters.updateStaffErrors = 1;
				console.warn(`[inbox-nudger] updateStaff(lastWakeAt) failed for ${staff.id} (non-fatal):`, err);
			}
			await this.sessionManager.enqueuePrompt(staff.currentSessionId!, msg, { isSteered: true, source: "system" });
			if (counters) counters.nudgesSent = 1;
		} catch (err) {
			if (counters) counters.errors = 1;
			// Allow the next tick to retry.
			this.nudgePending.delete(staff.id);
			console.error(`[inbox-nudger] applyPolicyThenNudge failed for staff ${staff.id}:`, err);
		} finally {
			if (diagEnabled) {
				getCpuDiagnostics().recordTimer("inbox-nudger:applyPolicyThenNudge", performance.now() - diagStart, counters);
			}
		}
	}

	/**
	 * Invoke the bridge-side compaction so the upcoming digest prompt
	 * lands in a fresh context. Matches the call surface used by the
	 * manual `/compact` skill (`ws/handler.ts:598`).
	 *
	 * Tolerant of test doubles that don't expose `compact` — we treat the
	 * absence as a no-op rather than throwing, since the test seam's only
	 * job is to verify the call shape.
	 */
	private async runCompact(sessionId: string): Promise<void> {
		const session = this.sessionManager.getSession(sessionId);
		if (!session || session.status !== "idle") return; // double-check race
		const rpc: any = session.rpcClient;
		if (!rpc || typeof rpc.compact !== "function") return;
		await rpc.compact(120_000);
	}
}
