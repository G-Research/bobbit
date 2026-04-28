import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

// ── Component yaml normalization ────────────────────────────
function normalizeComponents(arr: unknown[]): Component[] {
	const out: Component[] = [];
	for (const raw of arr) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.name !== "string" || !r.name) continue;
		const c: Component = {
			name: r.name,
			repo: typeof r.repo === "string" && r.repo ? r.repo : ".",
		};
		const rel = r.relative_path ?? r.relativePath;
		if (typeof rel === "string" && rel) c.relativePath = rel;
		const hook = r.worktree_setup_command ?? r.worktreeSetupCommand;
		if (typeof hook === "string" && hook) c.worktreeSetupCommand = hook;
		if (r.commands && typeof r.commands === "object" && !Array.isArray(r.commands)) {
			const cmds: Record<string, string> = {};
			for (const [k, v] of Object.entries(r.commands as Record<string, unknown>)) {
				if (typeof v === "string" && v.length > 0) cmds[k] = v;
			}
			if (Object.keys(cmds).length > 0) c.commands = cmds;
		}
		out.push(c);
	}
	return out;
}

function serializeComponent(c: Component): Record<string, unknown> {
	const out: Record<string, unknown> = { name: c.name, repo: c.repo };
	if (c.relativePath) out.relative_path = c.relativePath;
	if (c.worktreeSetupCommand) out.worktree_setup_command = c.worktreeSetupCommand;
	if (c.commands && Object.keys(c.commands).length > 0) out.commands = { ...c.commands };
	return out;
}

export type ProjectConfig = Record<string, string>;

// ── Multi-repo / components types (Phase 1 foundation) ───────────────
//
// See docs/design/multi-repo-components.md §1.
//
// These types are loaded from the inline `components:` and `workflows:`
// blocks in project.yaml. Phase 1 adds the type surface and a small set
// of read helpers; legacy top-level command keys remain readable for
// back-compat. Existing single-repo projects will pick up a synthesized
// components[] array on first server boot via the migration in
// state-migration/migrate-project-yaml.ts.

export interface Component {
	name: string;
	repo: string;                       // "." for single-repo, else a subfolder of rootPath
	relativePath?: string;              // optional sub-path inside the repo
	worktreeSetupCommand?: string;      // per-component runtime hook
	commands?: Record<string, string>;  // flat name → shell. Absent ⇒ data-only.
}

export type CommandStepStructural = {
	name: string; type: "command"; component: string; command: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; description?: string;
};

export type CommandStepComponentRun = {
	name: string; type: "command"; component: string; run: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; description?: string;
};

export type CommandStepFreeform = {
	name: string; type: "command"; run: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; description?: string;
};

export type CommandStep = CommandStepStructural | CommandStepComponentRun | CommandStepFreeform;

export type LlmReviewStep = {
	name: string; type: "llm-review"; prompt: string;
	role?: string; phase?: number; expect?: "success" | "failure";
	timeout?: number; optional?: boolean; label?: string; description?: string;
};

export type AgentQaStep = {
	name: string; type: "agent-qa"; prompt: string;
	role?: string; phase?: number; timeout?: number;
	optional?: boolean; label?: string; description?: string;
};

export type InlineVerifyStep = CommandStep | LlmReviewStep | AgentQaStep;

export interface InlineWorkflowGate {
	id: string;
	name: string;
	dependsOn?: string[];
	content?: boolean;
	injectDownstream?: boolean;
	optional?: boolean;
	manual?: boolean;
	metadata?: Record<string, string>;
	verify?: InlineVerifyStep[];
}

export interface InlineWorkflowDef {
	id: string;
	name: string;
	description?: string;
	hidden?: boolean;
	gates: InlineWorkflowGate[];
}

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
	sandbox_tokens: "",                 // JSON array: '[{"key":"GITHUB_TOKEN","value":"","enabled":true}]' — unified token list
	sandbox_credentials: "",            // DEPRECATED — use sandbox_tokens. JSON object: '{"GITHUB_TOKEN":"ghp_xxx"}'
	sandbox_github_token: "true",       // DEPRECATED — use sandbox_tokens. "true" | "false"
	sandbox_host_token_overrides: "",   // DEPRECATED — use sandbox_tokens. JSON object: '{"GITHUB_TOKEN":"false","NPM_TOKEN":"false"}'
	sandbox_mounts: "",                 // JSON array: '["/shared/data:/data:ro"]'
	worktree_pool_size: "2",            // Pre-built worktrees for instant session startup (0 = disable)
	qa_start_command: "",               // How to start an isolated server for QA
	qa_build_command: "",               // Build command for QA (defaults to build_command)
	qa_health_check: "",                // URL to check server health
	qa_browser_entry: "",               // Browser entry point URL
	qa_max_duration_minutes: "10",      // Max QA session duration
	qa_max_scenarios: "5",              // Max QA scenarios to run
};

/**
 * Project config store persisted to .bobbit/config/project.yaml.
 *
 * Two coexisting shapes:
 *   1. Legacy flat string map (`build_command`, `test_command`, …) — preserved
 *      for back-compat. Reads continue to work after migration.
 *   2. Structured fields (`components: []`, `workflows: {}`) — Phase 1 adds
 *      the type surface and read/write helpers. The migration synthesizes
 *      a one-element `components[]` from legacy fields on first boot.
 *
 * Auto-saves on every set/remove. Handles missing file gracefully.
 */
export class ProjectConfigStore {
	private data: ProjectConfig = {};
	/** Structured side-table — components[] and workflows{} from the same yaml file. */
	private components: Component[] = [];
	private workflows: Record<string, InlineWorkflowDef> | undefined;
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
					// Only keep string values for the flat map (back-compat surface).
					const cleaned: ProjectConfig = {};
					for (const [k, v] of Object.entries(raw)) {
						if (typeof v === "string") {
							cleaned[k] = v;
						}
					}
					this.data = cleaned;

					// Structured side-table: components[] and workflows{}.
					this.components = Array.isArray((raw as Record<string, unknown>).components)
						? normalizeComponents((raw as Record<string, unknown>).components as unknown[])
						: [];
					const wfBlock = (raw as Record<string, unknown>).workflows;
					this.workflows = (wfBlock && typeof wfBlock === "object" && !Array.isArray(wfBlock))
						? wfBlock as Record<string, InlineWorkflowDef>
						: undefined;
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
			// Merge structured side-tables (components[], workflows{}) into the
			// emitted yaml without losing the legacy flat keys.
			const out: Record<string, unknown> = { ...this.data };
			if (this.components.length > 0) {
				out.components = this.components.map(serializeComponent);
			}
			if (this.workflows && Object.keys(this.workflows).length > 0) {
				out.workflows = this.workflows;
			}
			fs.writeFileSync(this.configFile, yaml.stringify(out), "utf-8");
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

	// ── Component & workflow accessors (Phase 1) ─────────────────────

	/** Returns all components declared in project.yaml, in declared order. */
	getComponents(): Component[] {
		return this.components.map(c => ({ ...c, commands: c.commands ? { ...c.commands } : undefined }));
	}

	/** Lookup a component by name. */
	getComponent(name: string): Component | undefined {
		const c = this.components.find(x => x.name === name);
		return c ? { ...c, commands: c.commands ? { ...c.commands } : undefined } : undefined;
	}

	/** Group components by their `repo` value. */
	componentsByRepo(): Map<string, Component[]> {
		const map = new Map<string, Component[]>();
		for (const c of this.components) {
			const arr = map.get(c.repo) ?? [];
			arr.push(c);
			map.set(c.repo, arr);
		}
		return map;
	}

	/** Distinct repo names ("." for single-repo). */
	repoNames(): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const c of this.components) {
			if (!seen.has(c.repo)) {
				seen.add(c.repo);
				out.push(c.repo);
			}
		}
		return out;
	}

	/** True iff any component has `repo !== "."`. */
	isMultiRepo(): boolean {
		return this.components.some(c => c.repo !== ".");
	}

	/** True iff the component has no `commands` map (or it's empty). */
	isDataOnly(c: Component): boolean {
		return !c.commands || Object.keys(c.commands).length === 0;
	}

	/** Replace the components[] array. Persists immediately. */
	setComponents(components: Component[]): void {
		this.components = components.map(c => ({ ...c, commands: c.commands ? { ...c.commands } : undefined }));
		this.save();
	}

	/** Returns the inline workflows map (or undefined). */
	getWorkflows(): Record<string, InlineWorkflowDef> | undefined {
		return this.workflows ? structuredClone(this.workflows) : undefined;
	}

	/** Replace the workflows{} map. Persists immediately. */
	setWorkflows(workflows: Record<string, InlineWorkflowDef> | undefined): void {
		this.workflows = workflows ? structuredClone(workflows) : undefined;
		this.save();
	}

	/** Reload from disk — used by the migration to pick up out-of-band writes. */
	reload(): void {
		this.load();
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
