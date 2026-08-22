import { randomUUID } from "node:crypto";
import type { ProjectContextManager } from "./project-context-manager.js";
import type { StaffManager } from "./staff-manager.js";
import type { InboxNudger } from "./inbox-nudger.js";
import type { HostNotification } from "../../shared/extension-host/host-hooks.js";
import type { InboxStore, InboxEntry, InboxEntryState, InboxEntrySource, NotificationInboxMetadata } from "./inbox-store.js";

// Re-export for convenience so callers can import everything from
// `inbox-manager` without reaching into the store module directly.
export type { InboxEntry, InboxEntryState, InboxEntrySource, NotificationInboxMetadata } from "./inbox-store.js";

/** Browser-safe live projection. Canonical notification input and loop controls
 * remain available only through the authenticated staff inbox read surface. */
export type InboxLiveEntry = Omit<InboxEntry, "notificationInput">;

export type InboxLiveEvent =
	| { type: "inbox.entry.added"; staffId: string; entry: InboxLiveEntry }
	| { type: "inbox.entry.updated"; staffId: string; entry: InboxLiveEntry }
	| { type: "inbox.entry.removed"; staffId: string; entryId: string };

export interface InboxLiveAddress {
	readonly staffId: string;
	readonly staffSessionId: string;
	readonly projectId: string;
}

function bounded(value: string | undefined, max: number): string | undefined {
	return value === undefined ? undefined : value.slice(0, max);
}

/** Never return a source store object through WebSocket or operator publication. */
export function toInboxLiveEntry(entry: InboxEntry): InboxLiveEntry {
	const triggerId = bounded(entry.source.triggerId, 256);
	const actorId = bounded(entry.source.actorId, 256);
	const context = bounded(entry.context, 2_048);
	const result = bounded(entry.result, 2_048);
	const error = bounded(entry.error, 2_048);
	return Object.freeze({
		id: entry.id.slice(0, 256),
		staffId: entry.staffId.slice(0, 256),
		source: Object.freeze({
			type: entry.source.type,
			...(triggerId !== undefined ? { triggerId } : {}),
			...(actorId !== undefined ? { actorId } : {}),
		}),
		title: entry.title.slice(0, 512),
		prompt: entry.prompt.slice(0, 2_048),
		...(context !== undefined ? { context } : {}),
		state: entry.state,
		createdAt: entry.createdAt,
		...(entry.completedAt !== undefined ? { completedAt: entry.completedAt } : {}),
		...(result !== undefined ? { result } : {}),
		...(error !== undefined ? { error } : {}),
	});
}

/**
 * Facade over per-project `InboxStore`s. Provides a single point for
 * server.ts / REST handlers / inbox-tool extension code to enqueue work,
 * transition state, prune, and list — without having to know which
 * project's store actually owns a given staff record.
 *
 * Side effects per mutation:
 *  - Persists to the underlying `InboxStore` (synchronous JSON write).
 *  - Publishes a bounded WS invalidation only to the owning staff session:
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
	private readonly staffManager: StaffManager;
	private readonly publishLive: (event: InboxLiveEvent, address?: InboxLiveAddress) => void;

	constructor(
		pcm: ProjectContextManager,
		staffManager: StaffManager,
		publishLive: (event: InboxLiveEvent, address?: InboxLiveAddress) => void,
	) {
		this.pcm = pcm;
		this.staffManager = staffManager;
		this.publishLive = publishLive;
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

	private publishForStaff(staffId: string, event: InboxLiveEvent): void {
		const getStaff = (this.staffManager as StaffManager & { getStaff?: StaffManager["getStaff"] }).getStaff;
		const staff = typeof getStaff === "function" ? getStaff.call(this.staffManager, staffId) : undefined;
		const address = staff?.currentSessionId && staff.projectId ? {
			staffId,
			staffSessionId: staff.currentSessionId,
			projectId: staff.projectId,
		} : undefined;
		// The production publisher fails closed when address is absent. Keeping the
		// optional address also preserves narrow manager test doubles that observe
		// persistence events without constructing a SessionManager.
		this.publishLive(event, address);
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
		this.publishForStaff(staffId, { type: "inbox.entry.added", staffId, entry: toInboxLiveEntry(entry) });
		try {
			this.nudger?.poke(staffId);
		} catch (err) {
			console.error(`[inbox-manager] nudger.poke failed for staff ${staffId}:`, err);
		}
		return entry;
	}

	/**
	 * Idempotently accept one notification delivery under its deterministic ID.
	 * The full canonical event is host metadata, never interpolated into prompt.
	 */
	enqueueWithId(
		entryId: string,
		staffId: string,
		input: {
			title: string;
			triggerId: string;
			notification: HostNotification;
			rootCorrelationId: string;
			causationDepth: number;
		},
	): InboxEntry {
		const store = this.resolveStore(staffId);
		if (!store) throw new Error(`Staff agent not found: ${staffId}`);
		const notificationInput: NotificationInboxMetadata = {
			notification: input.notification,
			rootCorrelationId: input.rootCorrelationId,
			causationDepth: input.causationDepth,
		};
		const entry: InboxEntry = {
			id: entryId,
			staffId,
			source: { type: "notification", triggerId: input.triggerId },
			title: input.title,
			prompt: "A host notification is available in this inbox entry's notification metadata.",
			notificationInput,
			state: "pending",
			createdAt: Date.now(),
		};
		const accepted = store.putStrict(entry);
		if (accepted.inserted) {
			this.publishForStaff(staffId, { type: "inbox.entry.added", staffId, entry: toInboxLiveEntry(accepted.entry) });
			try {
				this.nudger?.poke(staffId);
			} catch (err) {
				console.error(`[inbox-manager] nudger.poke failed for staff ${staffId}:`, err);
			}
		}
		return accepted.entry;
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
		this.publishForStaff(staffId, { type: "inbox.entry.updated", staffId, entry: toInboxLiveEntry(entry) });
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
		this.publishForStaff(staffId, { type: "inbox.entry.updated", staffId, entry: toInboxLiveEntry(entry) });
		return entry;
	}

	/** Manual prune from the UI / DELETE endpoint. Returns false if no entry matched. */
	remove(staffId: string, entryId: string): boolean {
		const store = this.resolveStore(staffId);
		if (!store) return false;
		const ok = store.remove(staffId, entryId);
		if (ok) {
			this.publishForStaff(staffId, { type: "inbox.entry.removed", staffId, entryId: entryId.slice(0, 256) });
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
