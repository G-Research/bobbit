import fs from "node:fs";
import path from "node:path";

export interface PrStatusEntry {
	state: string;
	url?: string;
	number?: number;
	title?: string;
	reviewDecision?: string | null;
	mergeable?: string;
	viewerIsAdmin?: boolean;
	headRefName?: string;
	updatedAt?: string;
}

export class PrStatusStore {
	private cache: Map<string, PrStatusEntry> = new Map();
	private readonly storeDir: string;
	private readonly storeFile: string;

	constructor(stateDir: string) {
		this.storeDir = stateDir;
		this.storeFile = path.join(stateDir, "pr-status-cache.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const data = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (data && typeof data === "object" && !Array.isArray(data)) {
					for (const [id, entry] of Object.entries(data)) {
						if (entry && typeof entry === "object") this.cache.set(id, entry as PrStatusEntry);
					}
				}
			}
		} catch (err) {
			console.error("[pr-status-store] Failed to load:", err);
		}
	}

	private save(): void {
		try {
			if (!fs.existsSync(this.storeDir)) fs.mkdirSync(this.storeDir, { recursive: true });
			fs.writeFileSync(this.storeFile, JSON.stringify(Object.fromEntries(this.cache), null, 2), "utf-8");
		} catch (err) {
			console.error("[pr-status-store] Failed to save:", err);
		}
	}

	get(goalId: string): PrStatusEntry | undefined {
		return this.cache.get(goalId);
	}

	set(goalId: string, data: PrStatusEntry): void {
		this.cache.set(goalId, data);
		this.save();
	}

	getAll(): Record<string, PrStatusEntry> {
		return Object.fromEntries(this.cache);
	}

	remove(goalId: string): void {
		if (this.cache.delete(goalId)) this.save();
	}
}
