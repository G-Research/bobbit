import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

const STORE_FILE = path.join(bobbitStateDir(), "pr-status-cache.json");

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

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
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
			const dir = bobbitStateDir();
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(this.cache), null, 2), "utf-8");
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
