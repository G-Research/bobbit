import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";

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
	private readonly storeDir: string;
	private readonly storeFile: string;
	private readonly legacyStoreFile: string;
	private readonly fs: FsLike;
	private teams: Map<string, PersistedTeamEntry> = new Map();
	private asyncSaveInFlight: Promise<void> | null = null;
	private asyncSaveRequested = false;

	constructor(stateDir: string, fsImpl: FsLike = realFs) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "team-state.json");
		this.legacyStoreFile = path.join(stateDir, "gateway-swarms.json");
		this.fs = fsImpl;
		this.load();
	}

	private load(): void {
		try {
			let filePath = this.storeFile;
			if (!this.fs.existsSync(this.storeFile) && this.fs.existsSync(this.legacyStoreFile)) {
				filePath = this.legacyStoreFile;
			}
			if (this.fs.existsSync(filePath)) {
				const data = JSON.parse(this.fs.readFileSync(filePath, "utf-8"));
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
		// Fold synchronous mutations into an active purge write instead of letting
		// two snapshots race for team-state.json.
		if (this.asyncSaveInFlight) {
			this.asyncSaveRequested = true;
			return;
		}
		try {
			if (!this.fs.existsSync(this.storeDir)) this.fs.mkdirSync(this.storeDir, { recursive: true });
			this.fs.writeFileSync(this.storeFile, JSON.stringify(Array.from(this.teams.values()), null, 2), "utf-8");
		} catch (err) {
			console.error("[team-store] Failed to save:", err);
		}
	}

	private async saveAsyncOnce(): Promise<void> {
		try {
			await this.fs.promises.mkdir(this.storeDir, { recursive: true });
			await this.fs.promises.writeFile(
				this.storeFile,
				JSON.stringify(Array.from(this.teams.values()), null, 2),
				"utf-8",
			);
		} catch (err) {
			console.error("[team-store] Failed to save:", err);
		}
	}

	private async drainAsyncSaves(): Promise<void> {
		do {
			this.asyncSaveRequested = false;
			await this.saveAsyncOnce();
		} while (this.asyncSaveRequested);
	}

	private requestAsyncSave(): Promise<void> {
		this.asyncSaveRequested = true;
		if (!this.asyncSaveInFlight) {
			const task = this.drainAsyncSaves();
			this.asyncSaveInFlight = task;
			void task.then(() => {
				if (this.asyncSaveInFlight === task) this.asyncSaveInFlight = null;
			});
		}
		return this.asyncSaveInFlight;
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

	/** Promise-based, serialized removal used by team-lead archive purge. */
	async removeAsync(goalId: string): Promise<void> {
		this.teams.delete(goalId);
		await this.requestAsyncSave();
	}

	getAll(): PersistedTeamEntry[] {
		return Array.from(this.teams.values());
	}
}
