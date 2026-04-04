import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

export type ProjectConfig = Record<string, string>;

export interface QaTestingConfig {
	buildCommand: string;
	startCommand: string;
	healthCheck: string;
	browserEntry: string;
	env: Record<string, string>;
	maxDurationMinutes: number;
	maxScenarios: number;
}

const DEFAULTS: Record<string, string> = {
	build_command: "npm run build",
	test_command: "npm test",
	typecheck_command: "npm run check",
	test_unit_command: "npm run test:unit",
	test_e2e_command: "npm run test:e2e",
	worktree_setup_command: "",  // Empty = no setup runs on new worktrees
	default_thinking_level: "",  // Empty = use agent's built-in default ("medium")
	sandbox: "none",                    // "none" | "docker"
	sandbox_image: "bobbit-agent",      // Docker image name
	sandbox_credentials: "",            // JSON object: '{"GITHUB_TOKEN":"ghp_xxx"}'
	sandbox_github_token: "true",       // "true" | "false" — auto-inject GITHUB_TOKEN from host
	sandbox_mounts: "",                 // JSON array: '["/shared/data:/data:ro"]'
	sandbox_pool_size: "2",             // Pre-warmed containers (0 = disable pooling)
	sandbox_pool_max_idle: "300",       // Seconds before excess idle containers culled
	qa_start_command: "",               // How to start an isolated server for QA
	qa_build_command: "",               // Build command for QA (defaults to build_command)
	qa_health_check: "",                // URL to check server health
	qa_browser_entry: "",               // Browser entry point URL
	qa_max_duration_minutes: "10",      // Max QA session duration
	qa_max_scenarios: "5",              // Max QA scenarios to run
};

/**
 * Project config store persisted to .bobbit/config/project.yaml.
 * Stores arbitrary string key-value pairs (build/test commands, custom settings, etc.).
 * Auto-saves on every set/remove. Handles missing file gracefully.
 */
export class ProjectConfigStore {
	private data: ProjectConfig = {};
	private readonly configFile: string;

	constructor(configDir: string) {
		this.configFile = path.join(configDir, "project.yaml");
		this.load();
	}

	private load(): void {
		try {
			if (fs.existsSync(this.configFile)) {
				const raw = yaml.parse(fs.readFileSync(this.configFile, "utf-8"));
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
			const dir = path.dirname(this.configFile);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			fs.writeFileSync(this.configFile, yaml.stringify(this.data), "utf-8");
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

	/** Parse QA testing config from qa_* keys. Returns null if not configured (no qa_start_command). */
	getQaTestingConfig(): QaTestingConfig | null {
		const all = this.getWithDefaults();
		if (!all.qa_start_command) return null;
		return {
			buildCommand: all.qa_build_command || all.build_command || "npm run build",
			startCommand: all.qa_start_command,
			healthCheck: all.qa_health_check || "",
			browserEntry: all.qa_browser_entry || "",
			env: all.qa_env ? JSON.parse(all.qa_env) : {},
			maxDurationMinutes: parseInt(all.qa_max_duration_minutes || "10", 10),
			maxScenarios: parseInt(all.qa_max_scenarios || "5", 10),
		};
	}
}
