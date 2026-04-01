import fs from "node:fs";
import path from "node:path";

/**
 * Simple key-value store persisted to .bobbit/state/preferences.json.
 * Auto-saves on every set/remove. Handles missing file gracefully.
 */
export class PreferencesStore {
	private data: Record<string, unknown> = {};
	private readonly storeFile: string;

	constructor(stateDir: string) {
		this.storeFile = path.join(stateDir, "preferences.json");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.storeFile)) {
				const raw = JSON.parse(fs.readFileSync(this.storeFile, "utf-8"));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					this.data = raw as Record<string, unknown>;
				}
			}
		} catch (err) {
			console.error("[preferences-store] Failed to load preferences:", err);
		}
	}

	private save(): void {
		try {
			const dir = path.dirname(this.storeFile);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(this.storeFile, JSON.stringify(this.data, null, 2), "utf-8");
		} catch (err) {
			console.error("[preferences-store] Failed to save preferences:", err);
		}
	}

	get(key: string): unknown | undefined {
		return this.data[key];
	}

	set(key: string, value: unknown): void {
		this.data[key] = value;
		this.save();
	}

	getAll(): Record<string, unknown> {
		return { ...this.data };
	}

	remove(key: string): void {
		delete this.data[key];
		this.save();
	}
}
