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
}

export class InboxNudger {
	static readonly TICK_INTERVAL_MS = 15_000;

	private intervalHandle: ReturnType<typeof setInterval> | null = null;
	private readonly nudgePending: Map<string, boolean> = new Map();
	private readonly sessionManager: SessionManager;
	private readonly staffManager: StaffManager;
	private readonly inboxStore: InboxStore;

	constructor(deps: InboxNudgerDeps) {
		this.sessionManager = deps.sessionManager;
		this.staffManager = deps.staffManager;
		this.inboxStore = deps.inboxStore;
	}

	start(): void {
		if (this.intervalHandle) return;
		this.intervalHandle = setInterval(() => {
			this.tick();
		}, InboxNudger.TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
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
		for (const staff of this.staffManager.listStaff()) {
			try {
				this.tickOne(staff.id, staff);
			} catch (err) {
				console.error(`[inbox-nudger] tickOne failed for staff ${staff.id}:`, err);
			}
		}
	}

	private tickOne(staffId: string, staffArg?: PersistedStaff): void {
		const staff = staffArg ?? this.staffManager.getStaff(staffId);
		if (!staff || staff.state !== "active") return;
		if (!staff.currentSessionId) return;
		const session = this.sessionManager.getSession(staff.currentSessionId);
		if (!session || session.status !== "idle") return; // mirrors team-manager.ts:388
		if (this.nudgePending.get(staff.id)) return;
		const pending = this.inboxStore.listPending(staff.id);
		if (pending.length === 0) return;
		void this.applyPolicyThenNudge(staff, pending.length);
	}

	private async applyPolicyThenNudge(staff: PersistedStaff, count: number): Promise<void> {
		this.nudgePending.set(staff.id, true);
		try {
			if (staff.contextPolicy === "compact") {
				await this.runCompact(staff.currentSessionId!);
			}
			const word = count === 1 ? "item" : "items";
			const msg =
				`[INBOX] You have ${count} pending ${word}. ` +
				`Use inbox_list to inspect, then process each with inbox_complete or inbox_dismiss.`;
			await this.sessionManager.enqueuePrompt(staff.currentSessionId!, msg, { isSteered: true });
		} catch (err) {
			// Allow the next tick to retry.
			this.nudgePending.delete(staff.id);
			console.error(`[inbox-nudger] applyPolicyThenNudge failed for staff ${staff.id}:`, err);
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
