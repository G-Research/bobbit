import fs from "node:fs";
import path from "node:path";
import { recordDeletionTombstone } from "./deletion-tombstones.js";
import type { HostHookScope, HostNotificationName } from "../../shared/extension-host/host-hooks.js";

export type StaffState = "active" | "paused" | "retired";
export type LegacyTriggerType = "schedule" | "git" | "manual" | "goal_created" | "goal_archived";
export type TriggerType = LegacyTriggerType | "notification";

export interface TriggerConfig {
	cron?: string;
	timezone?: string;
	event?: "push" | "branch_created" | "tag";
	branch?: string;
	repo?: string;
}

export interface LegacyStaffTrigger {
	id: string;
	type: LegacyTriggerType;
	config: TriggerConfig;
	enabled: boolean;
	lastFired?: number;
	prompt?: string;
	lastSeenSha?: string;
}

export interface NotificationTriggerSelector<N extends HostNotificationName = HostNotificationName> {
	scope: HostHookScope;
	name: N;
}

/** Additive notification trigger. It never exposes notification data as prompt text. */
export interface NotificationStaffTrigger<N extends HostNotificationName = HostNotificationName> {
	id: string;
	type: "notification";
	notification: NotificationTriggerSelector<N>;
	filter: Readonly<Record<string, string | number | boolean>>;
	enabled: boolean;
	prompt?: string;
	lastFired?: number;
}

export type StaffTrigger = LegacyStaffTrigger | NotificationStaffTrigger;

const STAFF_ACCESSORY_IDS = new Set([
	"none",
	"crown",
	"bandana",
	"magnifier",
	"palette",
	"pencil",
	"shield",
	"set-square",
	"flask",
	"wizard-hat",
	"wand",
	"stamp",
	"clipboard",
	"nurse-cap",
	"headset",
	"ponytail",
]);

export function normalizeStaffAccessory(value: unknown): string {
	if (typeof value !== "string") return "none";
	const id = value.trim();
	return STAFF_ACCESSORY_IDS.has(id) ? id : "none";
}

function normalizeStaffRecord(staff: PersistedStaff): PersistedStaff {
	// Legacy records lack `sandboxed`; normalise to false.
	staff.sandboxed = !!staff.sandboxed;
	// Legacy/malformed records lack a valid `contextPolicy`; normalise to "compact".
	if (staff.contextPolicy !== "preserve" && staff.contextPolicy !== "compact" && staff.contextPolicy !== "clear") {
		staff.contextPolicy = "compact";
	}
	// Legacy/malformed records lack a valid accessory; normalise to "none".
	staff.accessory = normalizeStaffAccessory((staff as { accessory?: unknown }).accessory);
	return staff;
}

export interface StaffForkPublicationMarker {
	version: 1;
	/** Destination session ID. This is the only session allowed to commit the pending identity. */
	sessionId: string;
}

export interface PersistedStaff {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	state: StaffState;
	triggers: StaffTrigger[];
	memory: string;
	roleId?: string;
	/** Pixel-art accessory ID for the staff identity/avatar. */
	accessory: string;
	createdAt: number;
	updatedAt: number;
	lastWakeAt?: number;
	currentSessionId?: string;
	worktreePath?: string;
	branch?: string;
	/** Primary repo/container root used to provision the staff worktree. */
	repoPath?: string;
	/** Multi-repo staff worktrees keyed by component repo name. */
	repoWorktrees?: Record<string, string>;
	projectId?: string;
	/**
	 * Per-staff sandbox preference. Chosen at creation, persisted on the record,
	 * immutable for the staff's lifetime. Used directly on every spawn/wake —
	 * the project's sandbox config is NEVER consulted in the staff path.
	 * Legacy records loaded without this field normalise to `false`.
	 */
	sandboxed: boolean;
	/**
	 * What the InboxNudger does to context before injecting a wake digest.
	 * - "preserve" — leave conversation context as-is (long-running threads).
	 * - "compact"  — run /compact before nudging (default).
	 * - "clear"    — clear model-facing context in place before nudging.
	 *
	 * Optional at the type level so creation paths can omit it; both load
	 * normalisation (see `StaffStore.load`) and put-time normalisation
	 * (see `StaffStore.put`) coerce missing/invalid values to "compact".
	 * Clear reuses `SessionManager.clearContext`, preserving staff/session
	 * identity and the display-only transcript history.
	 */
	contextPolicy?: "preserve" | "compact" | "clear";
	/**
	 * Durable cross-store publication marker for a staff fork. Records carrying
	 * this marker are internal candidates, not public staff, until the exact
	 * destination session is durably present and the marker is atomically removed.
	 */
	forkPublication?: StaffForkPublicationMarker;
}

/**
 * Simple JSON file store for staff agents.
 * Staff persist across server restarts.
 */
export class StaffStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private staff: Map<string, PersistedStaff> = new Map();

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "staff.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (Array.isArray(data)) {
					for (const s of data) {
						if (s.id) {
							this.staff.set(s.id, normalizeStaffRecord(s));
						}
					}
				}
			}
		} catch (err) {
			console.error("[staff-store] Failed to load persisted staff:", err);
		}
	}

	private saveStrict(): void {
		if (!fs.existsSync(this.storeDir)) {
			fs.mkdirSync(this.storeDir, { recursive: true });
		}
		const data = Array.from(this.staff.values());
		const temporary = `${this.storeFile}.${process.pid}.${Date.now()}.tmp`;
		try {
			fs.writeFileSync(temporary, JSON.stringify(data, null, 2), "utf-8");
			fs.renameSync(temporary, this.storeFile);
		} catch (err) {
			try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original error */ }
			throw err;
		}
	}

	private save(): void {
		try {
			this.saveStrict();
		} catch (err) {
			console.error("[staff-store] Failed to save staff:", err);
		}
	}

	put(staff: PersistedStaff): void {
		// Normalise on every write so the in-memory record always carries
		// real values. Mirrors the load-side normalisation.
		this.staff.set(staff.id, normalizeStaffRecord(staff));
		this.save();
	}

	/** Fail-loud atomic publication used by authoritative staff lifecycle facts. */
	putStrict(staff: PersistedStaff): void {
		const previous = this.staff.get(staff.id);
		this.staff.set(staff.id, normalizeStaffRecord(staff));
		try {
			this.saveStrict();
		} catch (err) {
			if (previous) this.staff.set(staff.id, previous);
			else this.staff.delete(staff.id);
			throw err;
		}
	}

	get(id: string): PersistedStaff | undefined {
		const staff = this.staff.get(id);
		return staff?.forkPublication ? undefined : staff;
	}

	/** Internal recovery view; pending fork candidates never cross ordinary store reads. */
	getIncludingPending(id: string): PersistedStaff | undefined {
		return this.staff.get(id);
	}

	remove(id: string): void {
		this.staff.delete(id);
		this.save();
		// Durably tombstone this hard-delete so the boot-time headquarters
		// migration does not resurrect the record from a stale
		// `.pre-headquarters-id-migration` backup on the next restart.
		recordDeletionTombstone(this.storeDir, "staff.json", id);
	}

	/** Fail-loud removal used to abort an unpublished lifecycle candidate. */
	removeStrict(id: string): boolean {
		const previous = this.staff.get(id);
		if (!previous) return false;
		this.staff.delete(id);
		try {
			this.saveStrict();
		} catch (err) {
			this.staff.set(id, previous);
			throw err;
		}
		recordDeletionTombstone(this.storeDir, "staff.json", id);
		return true;
	}

	getAll(): PersistedStaff[] {
		return Array.from(this.staff.values()).filter(staff => !staff.forkPublication);
	}

	/** Internal recovery view; callers must resolve or abort every returned candidate. */
	getAllIncludingPending(): PersistedStaff[] {
		return Array.from(this.staff.values());
	}

	private applyUpdate(existing: PersistedStaff, updates: Partial<Omit<PersistedStaff, "id" | "createdAt">>): void {
		// Strip undefined values to avoid overwriting existing fields.
		// null is treated as "clear this field" (delete the key).
		const rec = existing as unknown as Record<string, unknown>;
		for (const [k, v] of Object.entries(updates)) {
			if (v === undefined) continue;
			if (v === null) delete rec[k];
			else rec[k] = v;
		}
		existing.updatedAt = Date.now();
		normalizeStaffRecord(existing);
	}

	update(id: string, updates: Partial<Omit<PersistedStaff, "id" | "createdAt">>): boolean {
		const existing = this.staff.get(id);
		if (!existing) return false;
		this.applyUpdate(existing, updates);
		this.save();
		return true;
	}

	/** Apply an update only if its atomic publication succeeds; otherwise restore memory. */
	updateStrict(id: string, updates: Partial<Omit<PersistedStaff, "id" | "createdAt">>): boolean {
		const existing = this.staff.get(id);
		if (!existing) return false;
		const previous = structuredClone(existing);
		this.applyUpdate(existing, updates);
		try {
			this.saveStrict();
			return true;
		} catch (err) {
			this.staff.set(id, previous);
			throw err;
		}
	}
}
