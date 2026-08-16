import fs from "node:fs";
import path from "node:path";
import { recordDeletionTombstone } from "./deletion-tombstones.js";

export type StaffState = "active" | "paused" | "retired";
export type TriggerType = "schedule" | "git" | "manual" | "goal_created" | "goal_archived";

export interface TriggerConfig {
	cron?: string;
	timezone?: string;
	event?: "push" | "branch_created" | "tag";
	branch?: string;
	repo?: string;
}

export interface StaffTrigger {
	id: string;
	type: TriggerType;
	config: TriggerConfig;
	enabled: boolean;
	lastFired?: number;
	prompt?: string;
	lastSeenSha?: string;
}

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
	// Legacy records lack `contextPolicy`; normalise to "compact".
	if (staff.contextPolicy !== "preserve" && staff.contextPolicy !== "compact") {
		staff.contextPolicy = "compact";
	}
	// Legacy/malformed records lack a valid accessory; normalise to "none".
	staff.accessory = normalizeStaffAccessory((staff as { accessory?: unknown }).accessory);
	return staff;
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
	 *
	 * Optional at the type level so creation paths can omit it; both load
	 * normalisation (see `StaffStore.load`) and put-time normalisation
	 * (see `StaffStore.put`) coerce missing/invalid values to "compact".
	 * A future "clear" policy (terminate + respawn) is deferred — see
	 * docs/design/staff-inbox.md §10.
	 */
	contextPolicy?: "preserve" | "compact";
	/** Server-owned replay marker for an atomic proposal application. */
	canonicalMutationKey?: string;
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

	private save(): void {
		if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
		const temporary = `${this.storeFile}.${process.pid}.${Date.now()}.tmp`;
		try {
			fs.writeFileSync(temporary, JSON.stringify(Array.from(this.staff.values()), null, 2), "utf-8");
			fs.renameSync(temporary, this.storeFile);
		} finally {
			try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
		}
	}

	put(staff: PersistedStaff): void {
		// Normalise on every write so the in-memory record always carries
		// real values. Mirrors the load-side normalisation.
		const previous = this.staff.get(staff.id);
		this.staff.set(staff.id, normalizeStaffRecord(staff));
		try { this.save(); } catch (error) { previous ? this.staff.set(staff.id, previous) : this.staff.delete(staff.id); throw error; }
	}

	get(id: string): PersistedStaff | undefined {
		return this.staff.get(id);
	}

	remove(id: string): void {
		const previous = this.staff.get(id);
		this.staff.delete(id);
		try { this.save(); } catch (error) { if (previous) this.staff.set(id, previous); throw error; }
		// Durably tombstone this hard-delete so the boot-time headquarters
		// migration does not resurrect the record from a stale
		// `.pre-headquarters-id-migration` backup on the next restart.
		recordDeletionTombstone(this.storeDir, "staff.json", id);
	}

	getAll(): PersistedStaff[] {
		return Array.from(this.staff.values());
	}

	update(id: string, updates: Partial<Omit<PersistedStaff, "id" | "createdAt">>): boolean {
		const existing = this.staff.get(id);
		if (!existing) return false;
		// Strip undefined values to avoid overwriting existing fields.
		// null is treated as "clear this field" (delete the key).
		const rec = existing as unknown as Record<string, unknown>;
		for (const [k, v] of Object.entries(updates)) {
			if (v === undefined) continue;
			if (v === null) {
				delete rec[k];
			} else {
				rec[k] = v;
			}
		}
		existing.updatedAt = Date.now();
		const previous = structuredClone(existing);
		normalizeStaffRecord(existing);
		try { this.save(); } catch (error) { this.staff.set(id, previous); throw error; }
		return true;
	}
}
