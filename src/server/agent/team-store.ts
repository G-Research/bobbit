import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export interface PersistedTeamEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: Array<{
		sessionId: string;
		role: string;
		worktreePath?: string;
		branch?: string;
		task: string;
		createdAt: number;
	}>;
	maxConcurrent: number;
}

const STORE_DIR = bobbitStateDir();
const STORE_FILE = path.join(STORE_DIR, "team-state.json");
const LEGACY_STORE_FILE = path.join(STORE_DIR, "gateway-swarms.json");

export class TeamStore {
	private teams: Map<string, PersistedTeamEntry> = new Map();

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			let filePath = STORE_FILE;
			if (!fs.existsSync(STORE_FILE) && fs.existsSync(LEGACY_STORE_FILE)) {
				filePath = LEGACY_STORE_FILE;
			}
			if (fs.existsSync(filePath)) {
				const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				if (Array.isArray(data)) {
					for (const s of data) {
						if (s.goalId) this.teams.set(s.goalId, s);
					}
				}
			}
		} catch (err) {
			console.error("[team-store] Failed to load:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
			fs.writeFileSync(STORE_FILE, JSON.stringify(Array.from(this.teams.values()), null, 2), "utf-8");
		} catch (err) {
			console.error("[team-store] Failed to save:", err);
		}
	}

	put(entry: PersistedTeamEntry): void {
		this.teams.set(entry.goalId, entry);
		this.save();
	}

	get(goalId: string): PersistedTeamEntry | undefined {
		return this.teams.get(goalId);
	}

	remove(goalId: string): void {
		this.teams.delete(goalId);
		this.save();
	}

	getAll(): PersistedTeamEntry[] {
		return Array.from(this.teams.values());
	}
}
