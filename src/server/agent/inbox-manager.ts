import { randomUUID } from "node:crypto";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { StaffManager } from "./staff-manager.js";
import type { InboxNudger } from "./inbox-nudger.js";
import type { InboxStore, InboxEntry, InboxEntryState, InboxEntrySource } from "./inbox-store.js";

// Re-export for convenience so callers can import everything from
// `inbox-manager` without reaching into the store module directly.
export type { InboxEntry, InboxEntryState, InboxEntrySource } from "./inbox-store.js";

/**
 * Facade over per-project `InboxStore`s. Provides a single point for
 * server.ts / REST handlers / inbox-tool extension code to enqueue work,
 * transition state, prune, and list — without having to know which
 * project's store actually owns a given staff record.
 *
 * Side effects per mutation:
 *  - Persists to the underlying `InboxStore` (synchronous JSON write).
 *  - Broadcasts a WS event via the injected `broadcastToAll`:
 *      "inbox.entry.added" | "inbox.entry.updated" | "inbox.entry.removed".
 *  - `enqueue` additionally calls `nudger.poke(staffId)` so an idle staff
 *    session is woken on the next tick (or earlier — `poke` schedules a
 *    one-shot tickOne on the next microtask).
 *
 * The nudger is wired in via `setNudger` after both objects are
 * constructed, breaking the construction-time cycle between
 * `InboxManager` and `InboxNudger`.
 */
export class InboxManager {
	private nudger: InboxNudger | null = null;
	private readonly pcm: ProjectContextManager;
	/** Held for API parity with the design doc; reserved for higher-layer lookups. */
	private readonly staffManager: StaffManager;
	private readonly broadcastToAll: (event: unknown) => void;

	constructor(pcm: ProjectContextManager, staffManager: StaffManager, broadcastToAll: (event: unknown) => void) {
		this.pcm = pcm;
		this.staffManager = staffManager;
		this.broadcastToAll = broadcastToAll;
		// Touch staffManager so the unused-private-property check stays happy
		// while preserving the constructor signature the design doc pins.
		void this.staffManager;
	}

	/**
	 * Look up the staff record across all projects. Equivalent to
	 * `staffManager.getStaff` but kept here so InboxManager can be unit-tested
	 * with a thin PCM-only mock that doesn't require a full StaffManager.
	 */
	hasStaff(staffId: string): boolean {
		return this.resolveStore(staffId) !== null;
	}

	setNudger(nudger: InboxNudger): void {
		this.nudger = nudger;
	}

	private resolveStore(staffId: string): InboxStore | null {
		for (const ctx of this.pcm.all()) {
			if (ctx.staffStore.get(staffId)) return ctx.inboxStore;
		}
		return null;
	}

	/**
	 * Append a new entry. The returned entry has `id`, `createdAt` and
	 * `state: "pending"` populated. Throws if no staff record with the
	 * given id can be found across any project.
	 */
	enqueue(
		staffId: string,
		input: { title: string; prompt: string; context?: string; source: InboxEntrySource },
	): InboxEntry {
		const store = this.resolveStore(staffId);
		if (!store) throw new Error(`Staff agent not found: ${staffId}`);

		const entry: InboxEntry = {
			id: randomUUID(),
			staffId,
			source: input.source,
			title: input.title,
			prompt: input.prompt,
			context: input.context,
			state: "pending",
			createdAt: Date.now(),
		};
		store.put(entry);
		this.broadcastToAll({ type: "inbox.entry.added", staffId, entry });
		try {
			this.nudger?.poke(staffId);
		} catch (err) {
			console.error(`[inbox-manager] nudger.poke failed for staff ${staffId}:`, err);
		}
		return entry;
	}

	listForStaff(staffId: string, state?: InboxEntryState, limit?: number): InboxEntry[] {
		const store = this.resolveStore(staffId);
		if (!store) return [];
		const all = store.list(staffId);
		const filtered = state ? all.filter((e) => e.state === state) : all;
		if (typeof limit === "number" && limit >= 0) return filtered.slice(0, limit);
		return filtered;
	}

	/**
	 * Mark an entry as completed. The entry must currently be in the
	 * `pending` state — calls with any other state throw. Sets
	 * `completedAt` and (optionally) `result`.
	 */
	transitionToCompleted(staffId: string, entryId: string, summary?: string): InboxEntry {
		const store = this.resolveStore(staffId);
		if (!store) throw new Error(`Staff agent not found: ${staffId}`);
		const existing = store.get(staffId, entryId);
		if (!existing) throw new Error(`Inbox entry not found: ${entryId}`);
		if (existing.state !== "pending") {
			throw new Error(`Inbox entry ${entryId} is ${existing.state}, expected pending`);
		}
		store.update(staffId, entryId, {
			state: "completed",
			completedAt: Date.now(),
			result: summary,
		});
		const entry = store.get(staffId, entryId)!;
		this.broadcastToAll({ type: "inbox.entry.updated", staffId, entry });
		return entry;
	}

	/**
	 * Move a pending entry to one of the non-success terminal states
	 * (`failed` or `cancelled`). The required `reason` is stored on
	 * `entry.error` for UI/audit. Throws if the entry isn't currently
	 * pending.
	 */
	transitionToTerminal(
		staffId: string,
		entryId: string,
		outcome: Exclude<InboxEntryState, "pending" | "completed">,
		reason: string,
	): InboxEntry {
		const store = this.resolveStore(staffId);
		if (!store) throw new Error(`Staff agent not found: ${staffId}`);
		const existing = store.get(staffId, entryId);
		if (!existing) throw new Error(`Inbox entry not found: ${entryId}`);
		if (existing.state !== "pending") {
			throw new Error(`Inbox entry ${entryId} is ${existing.state}, expected pending`);
		}
		store.update(staffId, entryId, {
			state: outcome,
			completedAt: Date.now(),
			error: reason,
		});
		const entry = store.get(staffId, entryId)!;
		this.broadcastToAll({ type: "inbox.entry.updated", staffId, entry });
		return entry;
	}

	/** Manual prune from the UI / DELETE endpoint. Returns false if no entry matched. */
	remove(staffId: string, entryId: string): boolean {
		const store = this.resolveStore(staffId);
		if (!store) return false;
		const ok = store.remove(staffId, entryId);
		if (ok) {
			this.broadcastToAll({ type: "inbox.entry.removed", staffId, entryId });
		}
		return ok;
	}

	/**
	 * Wipe the entire inbox for a staff (used by `StaffManager.deleteStaff`).
	 * Resolves the owning store via `resolveStore`; falls back to a scan of
	 * every project's `inboxStore` when the staff record has already been
	 * removed from `staffStore` (e.g. delete order is `staffStore.remove`
	 * before `inboxManager.removeAll`). No WS event — clients learn via the
	 * staff deletion broadcast.
	 */
	removeAll(staffId: string): void {
		const store = this.resolveStore(staffId);
		if (store) {
			store.removeAll(staffId);
			return;
		}
		// Fall back: staff record already gone — wipe any orphaned inbox file.
		for (const ctx of this.pcm.all()) {
			ctx.inboxStore.removeAll(staffId);
		}
	}
}
