import fs from "node:fs";
import path from "node:path";

export type InboxEntryState = "pending" | "completed" | "failed" | "cancelled";

export interface InboxEntrySource {
	type: "trigger" | "manual_api" | "manual_ui";
	/** Set when source.type === "trigger". The trigger id from PersistedStaff.triggers[].id. */
	triggerId?: string;
	/** Optional caller identifier for manual_api / manual_ui sources (e.g. user id, integration name). */
	actorId?: string;
}

export interface InboxEntry {
	id: string;
	staffId: string;
	source: InboxEntrySource;
	title: string;
	prompt: string;
	context?: string;
	state: InboxEntryState;
	createdAt: number;
	completedAt?: number;
	result?: string;
	error?: string;
}

/**
 * Per-staff JSON-file store of inbox entries.
 *
 * Persistence layout: `<stateDir>/inbox/<staffId>.json` — one file per staff,
 * containing a JSON object `{ staffId, entries: InboxEntry[] }` with entries
 * in insertion (FIFO) order.
 *
 * Loads are lazy: a staff's file is read on first access and cached in
 * memory. Writes flush the full file synchronously. The class mirrors
 * `StaffStore` semantics (synchronous fs, no migrations) so that the store
 * is safe to use from any code path that already deals with `StaffStore`.
 */
export class InboxStore {
	private readonly inboxDir: string;
	/** staffId → entries (in-memory cache; populated on first access). */
	private byStaff: Map<string, InboxEntry[]> = new Map();
	/** Marks the per-staff files we have already attempted to load. */
	private loaded: Set<string> = new Set();

	constructor(stateDir: string) {
		this.inboxDir = path.join(stateDir, "inbox");
	}

	private fileFor(staffId: string): string {
		return path.join(this.inboxDir, `${staffId}.json`);
	}

	private ensureLoaded(staffId: string): InboxEntry[] {
		if (this.loaded.has(staffId)) {
			return this.byStaff.get(staffId) ?? [];
		}
		this.loaded.add(staffId);
		const file = this.fileFor(staffId);
		try {
			if (fs.existsSync(file)) {
				const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as { staffId?: string; entries?: unknown };
				if (raw && Array.isArray(raw.entries)) {
					const entries = (raw.entries as InboxEntry[]).filter((e) => e && typeof e.id === "string");
					this.byStaff.set(staffId, entries);
					return entries;
				}
			}
		} catch (err) {
			console.error(`[inbox-store] Failed to load inbox for staff ${staffId}:`, err);
		}
		this.byStaff.set(staffId, []);
		return this.byStaff.get(staffId)!;
	}

	private save(staffId: string): void {
		const entries = this.byStaff.get(staffId) ?? [];
		try {
			if (!fs.existsSync(this.inboxDir)) {
				fs.mkdirSync(this.inboxDir, { recursive: true });
			}
			const file = this.fileFor(staffId);
			const payload = JSON.stringify({ staffId, entries }, null, 2);
			fs.writeFileSync(file, payload, "utf-8");
		} catch (err) {
			console.error(`[inbox-store] Failed to save inbox for staff ${staffId}:`, err);
		}
	}

	/** Insert or replace an entry. Last-writer-wins on id collision. */
	put(entry: InboxEntry): void {
		const entries = this.ensureLoaded(entry.staffId);
		const idx = entries.findIndex((e) => e.id === entry.id);
		if (idx >= 0) {
			entries[idx] = entry;
		} else {
			entries.push(entry);
		}
		this.save(entry.staffId);
	}

	get(staffId: string, entryId: string): InboxEntry | undefined {
		const entries = this.ensureLoaded(staffId);
		return entries.find((e) => e.id === entryId);
	}

	/** All entries for a staff, in FIFO (insertion) order. */
	list(staffId: string): InboxEntry[] {
		return this.ensureLoaded(staffId).slice();
	}

	listPending(staffId: string): InboxEntry[] {
		return this.ensureLoaded(staffId).filter((e) => e.state === "pending");
	}

	/**
	 * Apply a shallow patch to an entry. `id`, `staffId` and `createdAt` are
	 * immutable. Undefined values in `updates` are skipped; explicit `null`
	 * deletes the field. Returns false if the entry doesn't exist.
	 */
	update(
		staffId: string,
		entryId: string,
		updates: Partial<Omit<InboxEntry, "id" | "staffId" | "createdAt">>,
	): boolean {
		const entries = this.ensureLoaded(staffId);
		const idx = entries.findIndex((e) => e.id === entryId);
		if (idx < 0) return false;
		const existing = entries[idx];
		const rec = existing as unknown as Record<string, unknown>;
		for (const [k, v] of Object.entries(updates)) {
			if (v === undefined) continue;
			if (v === null) {
				delete rec[k];
			} else {
				rec[k] = v;
			}
		}
		this.save(staffId);
		return true;
	}

	remove(staffId: string, entryId: string): boolean {
		const entries = this.ensureLoaded(staffId);
		const idx = entries.findIndex((e) => e.id === entryId);
		if (idx < 0) return false;
		entries.splice(idx, 1);
		this.save(staffId);
		return true;
	}

	/** Wipe the entire inbox for a staff (used when a staff is deleted). */
	removeAll(staffId: string): void {
		this.byStaff.set(staffId, []);
		this.loaded.add(staffId);
		const file = this.fileFor(staffId);
		try {
			if (fs.existsSync(file)) fs.unlinkSync(file);
		} catch (err) {
			console.error(`[inbox-store] Failed to remove inbox for staff ${staffId}:`, err);
		}
	}
}
