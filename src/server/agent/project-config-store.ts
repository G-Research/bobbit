import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";

const CONFIG_FILE = path.join(bobbitConfigDir(), "project.yaml");

export type ProjectConfig = Record<string, string>;

const DEFAULTS: Record<string, string> = {
	build_command: "npm run build",
	test_command: "npm test",
	typecheck_command: "npm run check",
	test_unit_command: "npm run test:unit",
	test_e2e_command: "npm run test:e2e",
};

/**
 * Project config store persisted to .bobbit/config/project.yaml.
 * Stores arbitrary string key-value pairs (build/test commands, custom settings, etc.).
 * Auto-saves on every set/remove. Handles missing file gracefully.
 */
export class ProjectConfigStore {
	private data: ProjectConfig = {};

	constructor() {
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(CONFIG_FILE)) {
				const raw = yaml.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					// Only keep string values
					const cleaned: ProjectConfig = {};
					for (const [k, v] of Object.entries(raw)) {
						if (typeof v === "string") {
							cleaned[k] = v;
						}
					}
					this.data = cleaned;
				}
			}
		} catch (err) {
			console.error("[project-config-store] Failed to load project config:", err);
		}
	}

	private save(): void {
		try {
			const dir = path.dirname(CONFIG_FILE);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(CONFIG_FILE, yaml.stringify(this.data), "utf-8");
		} catch (err) {
			console.error("[project-config-store] Failed to save project config:", err);
		}
	}

	get(key: string): string | undefined {
		return this.data[key];
	}

	set(key: string, value: string): void {
		if (key.includes(".")) {
			throw new Error(`Project config key "${key}" must not contain dots — dots are reserved for namespace separators in {{project.key}} template variables`);
		}
		this.data[key] = value;
		this.save();
	}

	remove(key: string): void {
		delete this.data[key];
		this.save();
	}

	getAll(): ProjectConfig {
		return { ...this.data };
	}

	/** Returns a copy of the built-in defaults. */
	getDefaults(): Record<string, string> {
		return { ...DEFAULTS };
	}

	/** Returns all fields with defaults applied for any missing values.
	 *  Re-reads from disk to pick up changes made by external processes (e.g. setup wizard agent).
	 */
	getWithDefaults(): Record<string, string> {
		this.load();
		return { ...DEFAULTS, ...this.data };
	}
}
