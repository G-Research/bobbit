import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

const STORE_FILE = path.join(bobbitStateDir(), "preferences.json");

/**
 * Simple key-value store persisted to .bobbit/state/preferences.json.
 * Auto-saves on every set/remove. Handles missing file gracefully.
 */
export class PreferencesStore {
	private data: Record<string, unknown> = {};

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(STORE_FILE)) {
				const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf-8"));
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
			const dir = path.dirname(STORE_FILE);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(STORE_FILE, JSON.stringify(this.data, null, 2), "utf-8");
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
