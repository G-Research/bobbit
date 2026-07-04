import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync, loadJsonWithBackupFallback } from "./atomic-json.js";

export interface PersistedTeamEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: Array<{
		sessionId: string;
		role: string;
		/**
		 * Distinguishes verification reviewer sessions (managed by VerificationHarness)
		 * from regular worker agents. Defaults to "worker" when missing on load
		 * (back-compat with pre-fix persisted entries).
		 */
		kind?: "worker" | "reviewer";
		worktreePath?: string;
		branch?: string;
		baseSha?: string;
		task: string;
		createdAt: number;
	}>;
	maxConcurrent: number;
}

export class TeamStore {
	private readonly storeFile: string;
	private readonly legacyStoreFile: string;
	private teams: Map<string, PersistedTeamEntry> = new Map();
	/** Number of .bak generations to keep alongside team-state.json. */
	private static readonly BACKUP_COUNT = 3;

	constructor(stateDir: string) {
		this.storeFile = path.join(stateDir, "team-state.json");
		this.legacyStoreFile = path.join(stateDir, "gateway-swarms.json");
		this.load();
	}

	private load(): void {
		let data: PersistedTeamEntry[] | undefined;
		if (fs.existsSync(this.storeFile)) {
			data = loadJsonWithBackupFallback<PersistedTeamEntry[]>(this.storeFile, {
				backups: TeamStore.BACKUP_COUNT,
				onBackupUsed: (usedFile) =>
					console.warn(`[team-store] Loaded from backup ${path.basename(usedFile)} — primary missing/corrupt`),
			});
		} else if (fs.existsSync(this.legacyStoreFile)) {
			try {
				data = JSON.parse(fs.readFileSync(this.legacyStoreFile, "utf-8"));
			} catch (err) {
				console.error("[team-store] Failed to load legacy team file:", err);
			}
		}
		if (Array.isArray(data)) {
			for (const s of data) {
				if (s.goalId) this.teams.set(s.goalId, s);
			}
		}
	}

	private save(): void {
		try {
			atomicWriteJsonSync(this.storeFile, Array.from(this.teams.values()), { backups: TeamStore.BACKUP_COUNT });
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
