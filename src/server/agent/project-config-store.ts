import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

// ── Component yaml normalization ────────────────────────────
// SECURITY: `component.repo` and `component.relativePath` are joined onto
// `project.rootPath` to compute on-disk locations. Reject `..` segments and
// absolute paths to prevent path traversal that would let an authenticated
// caller create or clobber files outside the project's declared rootPath.
//
// `path.isAbsolute()` is OS-aware (a Windows path on POSIX is "relative" to
// node), so we ALSO reject Windows-style absolute paths explicitly. This keeps
// the predicate identical on macOS, Linux, and Windows — a project.yaml
// authored on Windows must be rejected on Linux too.
export function isSafeRelPath(p: string): boolean {
	if (path.isAbsolute(p)) return false;
	// Windows drive-letter absolute (e.g. "C:\Windows", "c:/Users/x").
	if (/^[a-zA-Z]:[\\/]/.test(p) || /^[a-zA-Z]:$/.test(p)) return false;
	// Windows UNC path (e.g. "\\server\share\file").
	if (/^[\\/]{2}/.test(p)) return false;
	if (p.includes("\0")) return false;
	const parts = p.split(/[\\/]+/).filter(s => s.length > 0);
	return !parts.some(seg => seg === "..");
}

function normalizeComponents(arr: unknown[]): Component[] {
	const out: Component[] = [];
	for (const raw of arr) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		if (typeof r.name !== "string" || !r.name) continue;
		const rawRepo = typeof r.repo === "string" && r.repo ? r.repo : ".";
		if (rawRepo !== "." && !isSafeRelPath(rawRepo)) {
			console.warn(`[project-config-store] Rejecting component "${r.name}": unsafe repo path "${rawRepo}"`);
			continue;
		}
		const c: Component = {
			name: r.name,
			repo: rawRepo,
		};
		const rel = r.relative_path ?? r.relativePath;
		if (typeof rel === "string" && rel) {
			if (!isSafeRelPath(rel)) {
				console.warn(`[project-config-store] Rejecting component "${r.name}": unsafe relative_path "${rel}"`);
				continue;
			}
			c.relativePath = rel;
		}
		const hook = r.worktree_setup_command ?? r.worktreeSetupCommand;
		if (typeof hook === "string" && hook) c.worktreeSetupCommand = hook;
		if (r.commands && typeof r.commands === "object" && !Array.isArray(r.commands)) {
			const cmds: Record<string, string> = {};
			for (const [k, v] of Object.entries(r.commands as Record<string, unknown>)) {
				if (typeof v === "string" && v.length > 0) cmds[k] = v;
			}
			if (Object.keys(cmds).length > 0) c.commands = cmds;
		}
		if (r.config && typeof r.config === "object" && !Array.isArray(r.config)) {
			const cfg: Record<string, string> = {};
			let count = 0;
			for (const [k, v] of Object.entries(r.config as Record<string, unknown>)) {
				if (!k) continue;
				if (count >= 100) {
					console.warn(`[project-config-store] Component "${r.name}": config truncated at 100 entries`);
					break;
				}
				let str: string | undefined;
				if (typeof v === "string") str = v;
				else if (typeof v === "number" || typeof v === "boolean") str = String(v);
				if (str === undefined || str === "") continue;
				cfg[k] = str;
				count++;
			}
			if (Object.keys(cfg).length > 0) c.config = cfg;
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
	if (c.config && Object.keys(c.config).length > 0) out.config = { ...c.config };
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
	config?: Record<string, string>;    // opaque key→string map. Used by /qa-test skill etc.
}

// `label` is reserved exclusively for the `human-signoff` card title.
// `optionalLabel` is the goal-creation opt-in toggle label for any
// `optional: true` step (regardless of type). Old YAML overloaded `label`
// for both purposes — see workflow-store.ts::normalizeStep for the forward
// migration that moves the legacy shape onto `optionalLabel` on load.
export type CommandStepStructural = {
	name: string; type: "command"; component: string; command: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; optionalLabel?: string; description?: string;
};

export type CommandStepComponentRun = {
	name: string; type: "command"; component: string; run: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; optionalLabel?: string; description?: string;
};

export type CommandStepFreeform = {
	name: string; type: "command"; run: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; optionalLabel?: string; description?: string;
};

export type CommandStep = CommandStepStructural | CommandStepComponentRun | CommandStepFreeform;

export type LlmReviewStep = {
	name: string; type: "llm-review"; prompt: string;
	role?: string; phase?: number; expect?: "success" | "failure";
	timeout?: number; optional?: boolean; label?: string; optionalLabel?: string; description?: string;
};

export type AgentQaStep = {
	name: string; type: "agent-qa"; prompt: string;
	role?: string; component?: string; phase?: number; timeout?: number;
	optional?: boolean; label?: string; optionalLabel?: string; description?: string;
};

export type HumanSignoffStep = {
	name: string; type: "human-signoff"; prompt: string; label: string;
	phase?: number; optional?: boolean; optionalLabel?: string; description?: string;
};

export type InlineVerifyStep = CommandStep | LlmReviewStep | AgentQaStep | HumanSignoffStep;

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

// ── Native-YAML migrated fields (typed side-tables) ──────────────────
//
// These five fields used to be JSON-encoded strings (or numeric strings)
// in project.yaml. They are now first-class structured fields. The store
// keeps a back-compat surface: `get(key)` for these keys returns the
// JSON-stringified form computed on demand, so existing call sites that
// read `get("config_directories")` keep working. `set(key, value)`
// parses the string and routes to the typed setter.

export interface ConfigDirectoryEntry {
	path: string;
	types: string[];
}

export interface SandboxTokenEntry {
	key: string;
	enabled: boolean;
	/** Only used at API ingress (PUT redaction merge). Not persisted to disk. */
	value?: string;
}

const MIGRATED_KEYS = new Set([
	"config_directories",
	"sandbox_tokens",
]);

function isPlainObject(x: unknown): x is Record<string, unknown> {
	return !!x && typeof x === "object" && !Array.isArray(x);
}

function normalizeConfigDirectories(raw: unknown): { value: ConfigDirectoryEntry[]; ok: boolean } {
	if (!Array.isArray(raw)) return { value: [], ok: false };
	const out: ConfigDirectoryEntry[] = [];
	for (const e of raw) {
		if (!isPlainObject(e)) continue;
		if (typeof e.path !== "string") continue;
		const typesRaw = e.types;
		const types = Array.isArray(typesRaw)
			? typesRaw.filter((t): t is string => typeof t === "string")
			: [];
		out.push({ path: e.path, types });
	}
	return { value: out, ok: true };
}

function normalizeSandboxTokens(raw: unknown): { value: SandboxTokenEntry[]; ok: boolean } {
	if (!Array.isArray(raw)) return { value: [], ok: false };
	const out: SandboxTokenEntry[] = [];
	for (const e of raw) {
		if (!isPlainObject(e)) continue;
		if (typeof e.key !== "string") continue;
		const entry: SandboxTokenEntry = {
			key: e.key,
			enabled: e.enabled !== false, // default true
		};
		if (typeof e.value === "string" && e.value.length > 0) entry.value = e.value;
		out.push(entry);
	}
	return { value: out, ok: true };
}

const DEFAULTS: Record<string, string> = {
	build_command: "npm run build",
	test_command: "npm test",
	typecheck_command: "npm run check",
	test_unit_command: "npm run test:unit",
	test_e2e_command: "npm run test:e2e",
	worktree_setup_command: "",  // Empty = no setup runs on new worktrees
	base_ref: "",                      // Empty = today's behaviour (resolveRemotePrimary, typically origin/master). Else a branch ref — local ("master") or remote ("origin/develop"). See docs/design/base-ref.md.
	sandbox: "none",                    // "none" | "docker"
	sandbox_image: "bobbit-agent",      // Docker image name
	sandbox_credentials: "",            // DEPRECATED — use sandbox_tokens. JSON object: '{"GITHUB_TOKEN":"ghp_xxx"}'
	sandbox_github_token: "true",       // DEPRECATED — use sandbox_tokens. "true" | "false"
	sandbox_host_token_overrides: "",   // DEPRECATED — use sandbox_tokens. JSON object: '{"GITHUB_TOKEN":"false","NPM_TOKEN":"false"}'
	sandbox_mounts: "",                 // JSON array: '["/shared/data:/data:ro"]'
	worktree_pool_size: "2",            // Pre-built worktrees for instant session startup (0 = disable)
	sandbox_tokens: "",                 // Native YAML array; flat get() returns JSON-stringified form.
	// config_directories has no string default — empty array.
};

/**
 * Project config store persisted to .bobbit/config/project.yaml.
 *
 * Two coexisting shapes:
 *   1. Legacy flat string map (`build_command`, `test_command`, …) — preserved
 *      for back-compat. Reads continue to work after migration.
 *   2. Structured fields (`components: []`, `workflows: {}`, plus the five
 *      Native-YAML fields above) — emitted as native YAML on save.
 *
 * The store keeps a back-compat read surface for the migrated fields:
 * `get("config_directories")` etc. return the JSON-stringified form
 * computed on demand from the typed side-tables. Internal callers should
 * prefer the typed accessors (`getConfigDirectories()`, …).
 *
 * Auto-saves on every set/remove. Handles missing file gracefully.
 */
export class ProjectConfigStore {
	private data: ProjectConfig = {};
	/** Structured side-table — components[] and workflows{} from the same yaml file. */
	private components: Component[] = [];
	private workflows: Record<string, InlineWorkflowDef> | undefined;

	// ── Native-YAML migrated fields ──
	private configDirectories: ConfigDirectoryEntry[] = [];
	private sandboxTokens: SandboxTokenEntry[] = [];
	/** Track whether each migrated field was explicitly present on disk. */
	private present = {
		config_directories: false,
		sandbox_tokens: false,
	};
	/** Set when load() found legacy (string-encoded) shapes — triggers next save() to rewrite native. */
	private dirty = false;

	private readonly configFile: string;

	constructor(configDir: string) {
		this.configFile = path.join(configDir, "project.yaml");
		this.load();
		// Lazy migration: if any legacy shape was parsed, the next save() rewrites
		// in native form. Per design: "the legacy → native upgrade happens on first
		// write after load." We don't auto-save here to avoid stripping inline
		// `sandbox_tokens` values before the secrets-migration step in server.ts
		// has had a chance to extract them into the SecretsStore.
	}

	/** True iff the loaded file contained a legacy JSON-string or numeric-string
	 *  shape for any of the migrated fields. Cleared by save(). */
	isDirty(): boolean { return this.dirty; }

	private load(): void {
		// Reset migrated fields to defaults before loading.
		this.configDirectories = [];
		this.sandboxTokens = [];
		this.present = {
			config_directories: false,
			sandbox_tokens: false,
		};

		try {
			if (!fs.existsSync(this.configFile)) {
				this.data = {};
				this.components = [];
				this.workflows = undefined;
				return;
			}
			const raw = yaml.parse(fs.readFileSync(this.configFile, "utf-8"));
			if (!isPlainObject(raw)) return;

			// Flat string map for legacy keys — exclude migrated keys (handled below).
			const cleaned: ProjectConfig = {};
			for (const [k, v] of Object.entries(raw)) {
				if (MIGRATED_KEYS.has(k)) continue;
				if (typeof v === "string") cleaned[k] = v;
			}
			this.data = cleaned;

			// Structured side-table: components[] and workflows{}.
			this.components = Array.isArray(raw.components)
				? normalizeComponents(raw.components as unknown[])
				: [];
			this.workflows = isPlainObject(raw.workflows)
				? raw.workflows as Record<string, InlineWorkflowDef>
				: undefined;

			// ── Migrated fields — accept native, legacy JSON-string, or numeric-string ──
			this.loadMigrated(raw);
		} catch (err) {
			console.error("[project-config-store] Failed to load project config:", err);
		}
	}

	private loadMigrated(raw: Record<string, unknown>): void {
		// config_directories — array of {path, types[]}
		if (raw.config_directories !== undefined && raw.config_directories !== null) {
			const v = raw.config_directories;
			if (typeof v === "string") {
				if (v.length > 0) {
					try {
						const parsed = JSON.parse(v);
						const norm = normalizeConfigDirectories(parsed);
						if (norm.ok) {
							this.configDirectories = norm.value;
							this.present.config_directories = true;
							this.dirty = true;
						} else {
							console.warn("[project-config-store] Failed to parse config_directories, treating as default");
						}
					} catch (err) {
						console.warn("[project-config-store] Failed to parse config_directories, treating as default:", err);
					}
				}
			} else {
				const norm = normalizeConfigDirectories(v);
				if (norm.ok) {
					this.configDirectories = norm.value;
					this.present.config_directories = true;
				} else {
					console.warn("[project-config-store] Failed to parse config_directories, treating as default");
				}
			}
		}

		// sandbox_tokens — array of {key, enabled, value?}
		if (raw.sandbox_tokens !== undefined && raw.sandbox_tokens !== null) {
			const v = raw.sandbox_tokens;
			if (typeof v === "string") {
				if (v.length > 0) {
					try {
						const parsed = JSON.parse(v);
						const norm = normalizeSandboxTokens(parsed);
						if (norm.ok) {
							this.sandboxTokens = norm.value;
							this.present.sandbox_tokens = true;
							this.dirty = true;
						} else {
							console.warn("[project-config-store] Failed to parse sandbox_tokens, treating as default");
						}
					} catch (err) {
						console.warn("[project-config-store] Failed to parse sandbox_tokens, treating as default:", err);
					}
				}
			} else {
				const norm = normalizeSandboxTokens(v);
				if (norm.ok) {
					this.sandboxTokens = norm.value;
					this.present.sandbox_tokens = true;
				} else {
					console.warn("[project-config-store] Failed to parse sandbox_tokens, treating as default");
				}
			}
		}

	}

	private save(): void {
		try {
			const dir = path.dirname(this.configFile);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			// Merge structured side-tables (components[], workflows{}, native fields) with
			// the legacy flat keys. Migrated keys are NEVER written from `this.data` —
			// they live exclusively in their typed side-tables to avoid double-writes.
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(this.data)) {
				if (MIGRATED_KEYS.has(k)) continue;
				out[k] = v;
			}

			if (this.components.length > 0) {
				out.components = this.components.map(serializeComponent);
			}
			if (this.workflows && Object.keys(this.workflows).length > 0) {
				out.workflows = this.workflows;
			}

			// Native-YAML migrated fields. Only emit when explicitly set / non-default
			// to keep files terse and avoid noisy diffs.
			if (this.present.config_directories || this.configDirectories.length > 0) {
				out.config_directories = this.configDirectories.map(e => ({
					path: e.path,
					types: [...e.types],
				}));
			}
			if (this.present.sandbox_tokens || this.sandboxTokens.length > 0) {
				// Persisted form NEVER contains `value:` — secrets live in secrets.json.
				out.sandbox_tokens = this.sandboxTokens.map(e => ({ key: e.key, enabled: e.enabled }));
			}
			// Clear dirty flag — file is now in native form.
			this.dirty = false;

			fs.writeFileSync(this.configFile, yaml.stringify(out), "utf-8");
		} catch (err) {
			console.error("[project-config-store] Failed to save project config:", err);
		}
	}

	/** Compute the back-compat flat-string view including JSON-stringified migrated values.
	 *  Sandbox token values are included so legacy callers can still read them; save()
	 *  always strips values from the on-disk YAML. */
	private flatLegacyView(): Record<string, string> {
		const out: Record<string, string> = { ...this.data };
		if (this.present.config_directories || this.configDirectories.length > 0) {
			out.config_directories = JSON.stringify(this.configDirectories);
		}
		if (this.present.sandbox_tokens || this.sandboxTokens.length > 0) {
			out.sandbox_tokens = JSON.stringify(
				this.sandboxTokens.map(e => {
					const o: Record<string, unknown> = { key: e.key, enabled: e.enabled };
					if (e.value) o.value = e.value;
					return o;
				}),
			);
		}
		return out;
	}

	get(key: string): string | undefined {
		if (MIGRATED_KEYS.has(key)) {
			return this.flatLegacyView()[key];
		}
		return this.data[key];
	}

	set(key: string, value: string): void {
		if (key.includes(".")) {
			throw new Error(`Project config key "${key}" must not contain dots — dots are reserved for namespace separators in {{project.key}} template variables`);
		}
		if (MIGRATED_KEYS.has(key)) {
			this.setMigratedFromString(key, value);
			return;
		}
		this.data[key] = value;
		this.save();
	}

	private setMigratedFromString(key: string, value: string): void {
		// Empty string clears the field.
		if (value === "") {
			this.removeMigrated(key);
			return;
		}
		switch (key) {
			case "config_directories": {
				try {
					const parsed = JSON.parse(value);
					const norm = normalizeConfigDirectories(parsed);
					if (norm.ok) {
						this.configDirectories = norm.value;
						this.present.config_directories = true;
						this.save();
					} else {
						throw new Error("Invalid config_directories shape");
					}
				} catch (err) {
					throw new Error(`Failed to parse config_directories as JSON: ${(err as Error).message}`);
				}
				break;
			}
			case "sandbox_tokens": {
				try {
					const parsed = JSON.parse(value);
					const norm = normalizeSandboxTokens(parsed);
					if (norm.ok) {
						this.sandboxTokens = norm.value;
						this.present.sandbox_tokens = true;
						this.save();
					} else {
						throw new Error("Invalid sandbox_tokens shape");
					}
				} catch (err) {
					throw new Error(`Failed to parse sandbox_tokens as JSON: ${(err as Error).message}`);
				}
				break;
			}
		}
	}

	private removeMigrated(key: string): void {
		switch (key) {
			case "config_directories":
				this.configDirectories = [];
				this.present.config_directories = false;
				break;
			case "sandbox_tokens":
				this.sandboxTokens = [];
				this.present.sandbox_tokens = false;
				break;
		}
		this.save();
	}

	remove(key: string): void {
		if (MIGRATED_KEYS.has(key)) {
			this.removeMigrated(key);
			return;
		}
		delete this.data[key];
		this.save();
	}

	getAll(): ProjectConfig {
		return this.flatLegacyView();
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
		return { ...DEFAULTS, ...this.flatLegacyView() };
	}

	// ── Native-YAML typed accessors (preferred over flat get/set) ────

	getConfigDirectories(): ConfigDirectoryEntry[] {
		return this.configDirectories.map(e => ({ path: e.path, types: [...e.types] }));
	}

	setConfigDirectories(dirs: ConfigDirectoryEntry[]): void {
		this.configDirectories = dirs.map(e => ({ path: e.path, types: [...e.types] }));
		this.present.config_directories = this.configDirectories.length > 0;
		this.save();
	}

	getSandboxTokens(): SandboxTokenEntry[] {
		return this.sandboxTokens.map(e => ({ key: e.key, enabled: e.enabled }));
	}

	setSandboxTokens(tokens: SandboxTokenEntry[]): void {
		this.sandboxTokens = tokens.map(e => {
			const o: SandboxTokenEntry = { key: e.key, enabled: e.enabled };
			if (e.value) o.value = e.value;
			return o;
		});
		this.present.sandbox_tokens = this.sandboxTokens.length > 0;
		this.save();
	}

	/** Returns a defensive clone of the named component's `config` map (or {} if missing/unknown). */
	getComponentConfig(name: string): Record<string, string> {
		const c = this.components.find(x => x.name === name);
		return c?.config ? { ...c.config } : {};
	}

	/** Reads `components[name].config.qa_max_duration_minutes`, parses with Number(), falls back to 10. */
	getQaMaxDurationMinutes(componentName: string): number {
		const raw = this.getComponentConfig(componentName).qa_max_duration_minutes;
		const n = raw == null ? NaN : Number(raw);
		return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 10;
	}

	/** True iff any component has a non-empty `config.qa_start_command`. */
	isQaConfiguredOnAnyComponent(): boolean {
		return this.components.some(c =>
			typeof c.config?.qa_start_command === "string" && c.config.qa_start_command.length > 0
		);
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
		this.components = components.map(c => ({
			...c,
			commands: c.commands ? { ...c.commands } : undefined,
			config: c.config ? { ...c.config } : undefined,
		}));
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

}
