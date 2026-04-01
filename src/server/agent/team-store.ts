import fs from "node:fs";
import path from "node:path";

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

export class TeamStore {
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly legacyStoreFile: string;
	private teams: Map<string, PersistedTeamEntry> = new Map();

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "team-state.json");
		this.legacyStoreFile = path.join(stateDir, "gateway-swarms.json");
		this.load();
	}

	private load(): void {
		try {
			let filePath = this.storeFile;
			if (!fs.existsSync(this.storeFile) && fs.existsSync(this.legacyStoreFile)) {
				filePath = this.legacyStoreFile;
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
			if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
			fs.writeFileSync(this.storeFile, JSON.stringify(Array.from(this.teams.values()), null, 2), "utf-8");
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
