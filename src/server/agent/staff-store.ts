import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

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
}

const STORE_DIR = bobbitStateDir();
const STORE_FILE = path.join(STORE_DIR, "staff.json");

/**
 * Simple JSON file store for staff agents.
 * Staff persist across server restarts.
 */
export class StaffStore {
	private staff: Map<string, PersistedStaff> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
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
			if (!fs.existsSync(STORE_DIR)) {
				fs.mkdirSync(STORE_DIR, { recursive: true });
			}
			const data = Array.from(this.staff.values());
			fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf-8");
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
