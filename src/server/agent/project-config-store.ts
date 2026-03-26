import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { bobbitConfigDir } from "../bobbit-dir.js";

const CONFIG_FILE = path.join(bobbitConfigDir(), "project.yaml");

export interface ProjectConfig {
	build_command?: string;
	test_command?: string;
	typecheck_command?: string;
	test_unit_command?: string;
	test_e2e_command?: string;
}

const DEFAULTS: Required<ProjectConfig> = {
	build_command: "npm run build",
	test_command: "npm test",
	typecheck_command: "npm run check",
	test_unit_command: "npm run test:unit",
	test_e2e_command: "npm run test:e2e",
};

/**
 * Project config store persisted to .bobbit/config/project.yaml.
 * Stores build/test/typecheck commands for the project.
 * Auto-saves on every set. Handles missing file gracefully.
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
					this.data = raw as ProjectConfig;
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

	get(key: keyof ProjectConfig): string | undefined {
		return this.data[key];
	}

	set(key: keyof ProjectConfig, value: string): void {
		this.data[key] = value;
		this.save();
	}

	getAll(): ProjectConfig {
		return { ...this.data };
	}

	/** Returns all fields with defaults applied for any missing values.
	 *  Re-reads from disk to pick up changes made by external processes (e.g. setup wizard agent).
	 */
	getWithDefaults(): Required<ProjectConfig> {
		this.load();
		return { ...DEFAULTS, ...this.data };
	}
}
