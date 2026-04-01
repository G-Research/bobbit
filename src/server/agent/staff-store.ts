import fs from "node:fs";
import path from "node:path";

export type StaffState = "active" | "paused" | "retired";
export type TriggerType = "schedule" | "git" | "manual";

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
	createdAt: number;
	updatedAt: number;
	lastWakeAt?: number;
	currentSessionId?: string;
	worktreePath?: string;
	branch?: string;
	projectId?: string;
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
							this.staff.set(s.id, s);
						}
					}
				}
			}
		} catch (err) {
			console.error("[staff-store] Failed to load persisted staff:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) {
				fs.mkdirSync(this.storeDir, { recursive: true });
			}
			const data = Array.from(this.staff.values());
			fs.writeFileSync(this.storeFile, JSON.stringify(data, null, 2), "utf-8");
		} catch (err) {
			console.error("[staff-store] Failed to save staff:", err);
		}
	}

	put(staff: PersistedStaff): void {
		this.staff.set(staff.id, staff);
		this.save();
	}

	get(id: string): PersistedStaff | undefined {
		return this.staff.get(id);
	}

	remove(id: string): void {
		this.staff.delete(id);
		this.save();
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
		this.save();
		return true;
	}
}
