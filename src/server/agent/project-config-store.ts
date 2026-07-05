import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { atomicWriteFileSync, bakPath } from "./atomic-json.js";

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
	"pack_order",
	"pack_activation",
]);

/**
 * Scope keys for the {@link ProjectConfigStore.getPackOrder} scoped map.
 * `project` lives in the project config; `server` + `global-user` live in the
 * server config (they share a file but stay independent — design §3.3).
 */
export type PackOrderScope = "server" | "global-user" | "project";
const PACK_ORDER_SCOPES: ReadonlySet<string> = new Set(["server", "global-user", "project"]);

/** A scope→ordered-pack-name-list map persisted as a native-YAML field. */
export type PackOrderMap = Partial<Record<PackOrderScope, string[]>>;

/** Disabled (de-activated) user-facing entity refs by kind, for one pack at one
 *  scope (pack-schema-v1 §6.7). Absent kind ⇒ all enabled. Entrypoints are keyed
 *  by `listName` (the contents.entrypoints[] basename), so one toggle disables
 *  both the launcher id and the deep-link routeId derived from that file. */
export interface DisabledRefs {
	roles?: string[];
	tools?: string[];
	skills?: string[];
	entrypoints?: string[];
	providers?: string[];
	mcp?: string[];
	mcpOperations?: Record<string, string[]>;
	piExtensions?: string[];
	runtimes?: string[];
}

/** scope → packName → disabled entity refs by kind. Default (absent) = all enabled. */
export type PackActivationMap = Partial<Record<PackOrderScope, Record<string, DisabledRefs>>>;

// `hooks` and `workflows` are deliberately EXCLUDED (finding EXT-03): `hooks` was
// removed as a contribution kind entirely (see pack-manifest.ts); `workflows` is
// reserved-but-not-loadable, so it stays parseable on the manifest
// (pack-types.ts) but is NOT activation-toggleable — toggling a kind with zero
// runtime effect is exactly the phantom-capability bug this excludes.
const ACTIVATION_KINDS = ["roles", "tools", "skills", "entrypoints", "providers", "mcp", "piExtensions", "runtimes"] as const;

function normalizeMcpOperations(raw: unknown): Record<string, string[]> | undefined {
	if (!isPlainObject(raw)) return undefined;
	const out: Record<string, string[]> = {};
	for (const [contributionId, ops] of Object.entries(raw)) {
		if (typeof contributionId !== "string" || contributionId.length === 0 || !Array.isArray(ops)) continue;
		const names = [...new Set(ops.filter((x): x is string => typeof x === "string" && x.length > 0))];
		if (names.length > 0) out[contributionId] = names;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizePackOrder(raw: unknown): { value: PackOrderMap; ok: boolean } {
	if (!isPlainObject(raw)) return { value: {}, ok: false };
	const out: PackOrderMap = {};
	for (const [k, v] of Object.entries(raw)) {
		if (!PACK_ORDER_SCOPES.has(k)) continue;
		if (!Array.isArray(v)) continue;
		const names = v.filter((x): x is string => typeof x === "string");
		out[k as PackOrderScope] = names;
	}
	return { value: out, ok: true };
}

function normalizeDisabledRefs(raw: unknown): DisabledRefs {
	const out: DisabledRefs = {};
	if (!isPlainObject(raw)) return out;
	for (const kind of ACTIVATION_KINDS) {
		const v = raw[kind];
		if (!Array.isArray(v)) continue;
		const names = v.filter((x): x is string => typeof x === "string");
		if (names.length > 0) out[kind] = names;
	}
	const mcpOperations = normalizeMcpOperations(raw.mcpOperations);
	if (mcpOperations) out.mcpOperations = mcpOperations;
	return out;
}

function normalizePackActivation(raw: unknown): { value: PackActivationMap; ok: boolean } {
	if (!isPlainObject(raw)) return { value: {}, ok: false };
	const out: PackActivationMap = {};
	for (const [scope, byPack] of Object.entries(raw)) {
		if (!PACK_ORDER_SCOPES.has(scope)) continue;
		if (!isPlainObject(byPack)) continue;
		const scopeMap: Record<string, DisabledRefs> = {};
		for (const [packName, refs] of Object.entries(byPack)) {
			const norm = normalizeDisabledRefs(refs);
			if (Object.keys(norm).length > 0) scopeMap[packName] = norm;
		}
		if (Object.keys(scopeMap).length > 0) out[scope as PackOrderScope] = scopeMap;
	}
	return { value: out, ok: true };
}

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
	worktree_setup_timeout_ms: "",  // Empty = default 120000ms. Project-level default for worktree setup command timeout (goal override > this > 120000).
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
 *
 * ── CON-02: crash-safe write + corrupt-file guard ──────────────────────
 * `project.yaml` is the highest-value user-authored config (workflows,
 * components, pack activation/order, build/test commands), so it gets two
 * protections beyond the CON-01 atomic-write discipline it now shares with
 * gate/team/task/inbox stores (`atomic-json.ts` — tmp-write → fsync → rename
 * → dir fsync, `BACKUP_COUNT`-deep `.bak.N` rotation):
 *
 *   1. `load()` never lets a corrupt-or-unreadable-but-PRESENT file collapse
 *      into an empty in-memory state that a subsequent save() would then
 *      serialize back over the corrupt file, destroying it for good. On
 *      failure it first tries the newest parseable `.bak.N` (a valid state
 *      to resume from — recovering clears `loadFailed`); if nothing parses,
 *      it sets `loadFailed` and leaves the in-memory state exactly as it was
 *      (fresh boot: pristine `{}`; live `reload()`: last known-good
 *      snapshot) WITHOUT touching disk.
 *   2. `save()` refuses (throws) while `loadFailed` is set, so no setter can
 *      ever write over a corrupt-but-recoverable-by-hand file. `loadFailed`
 *      is re-evaluated on every `load()`/`reload()` call, so fixing the file
 *      by hand (or restoring a `.bak.N`) and re-reading clears it.
 *   3. A MISSING file is never `loadFailed` UNLESS a `.bak.N` generation
 *      exists on disk (which only happens after this store has saved at
 *      least once) — i.e. missing-with-no-history is a fresh project, but
 *      missing-with-history is far more likely an accidental deletion, and
 *      is treated like a corrupt primary (try backups, else `loadFailed`).
 *      A PRESENT-BUT-EMPTY file is always treated as an intentional reset
 *      (fresh, not `loadFailed`) and deliberately does NOT fall back to a
 *      `.bak.N` — resurrecting old content the user just emptied would
 *      violate their intent (mirrors the CON-01 "resurrection guard" for
 *      deliberate deletes elsewhere in the durable-store layer).
 */
export class ProjectConfigStore {
	/** Number of `.bak.N` generations to keep alongside project.yaml (matches gate/team/task/inbox). */
	private static readonly BACKUP_COUNT = 3;

	private data: ProjectConfig = {};
	/** Structured side-table — components[] and workflows{} from the same yaml file. */
	private components: Component[] = [];
	private workflows: Record<string, InlineWorkflowDef> | undefined;
	/** Set when the on-disk file existed (or had prior `.bak.N` history) but could not be
	 *  parsed into a usable config and no backup generation recovered it either. While set,
	 *  save() refuses — see the class-level CON-02 doc comment above. Cleared by the next
	 *  successful load()/reload(). */
	private loadFailed = false;
	/** Rate limiter for the loadFailed / recovered-from-backup operator logs: load() runs on
	 *  every getWithDefaults() call (i.e. per REST GET), so a persistently corrupt file would
	 *  otherwise spam the log line per request. Log once per failure/recovery episode; reset
	 *  when the primary parses cleanly again. */
	private failureLogged = false;
	private recoveryLogged = false;

	// ── Native-YAML migrated fields ──
	private configDirectories: ConfigDirectoryEntry[] = [];
	private sandboxTokens: SandboxTokenEntry[] = [];
	private packOrder: PackOrderMap = {};
	private packActivation: PackActivationMap = {};
	/** Optional read-time overlay for default-disabled built-in packs (injected by
	 *  server.ts). Given (scope, packName, rawStoredRefs) it returns a synthesized
	 *  all-disabled override to make a dormant default-disabled pack resolve as
	 *  disabled, or `undefined` to use the raw stored refs. The overlay is NEVER
	 *  persisted — see src/server/agent/pack-default-activation.ts. */
	private defaultActivationResolver?: (
		scope: PackOrderScope,
		packName: string,
		stored: DisabledRefs,
	) => DisabledRefs | undefined;
	/** Track whether each migrated field was explicitly present on disk. */
	private present = {
		config_directories: false,
		sandbox_tokens: false,
		pack_order: false,
		pack_activation: false,
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

	/** True iff the on-disk file failed to load (corrupt/unreadable, no recoverable
	 *  backup) — while true, save() refuses. See the class-level CON-02 doc comment. */
	isLoadFailed(): boolean { return this.loadFailed; }

	private load(): void {
		this.loadFailed = false;

		const primaryExists = fs.existsSync(this.configFile);

		if (!primaryExists) {
			// No primary. `.bak.N` files can only exist if this store previously
			// saved at this path, so their presence means "accidentally deleted",
			// not "fresh project" — recover from them instead of starting empty.
			let anyBackupExists = false;
			for (let i = 1; i <= ProjectConfigStore.BACKUP_COUNT; i++) {
				if (fs.existsSync(bakPath(this.configFile, i))) { anyBackupExists = true; break; }
			}
			if (!anyBackupExists) {
				this.resetToEmpty();
				this.resetEpisodeLogs();
				return;
			}
			if (this.recoverFromBackups()) return;
			this.enterLoadFailed(
				`[project-config-store] project.yaml is missing and no .bak.N generation is parseable — ` +
				`refusing further saves until the file is restored manually. File: ${this.configFile}`,
			);
			return;
		}

		let text: string | undefined;
		try {
			text = fs.readFileSync(this.configFile, "utf-8");
		} catch (err) {
			if (!this.failureLogged) console.error(`[project-config-store] Failed to read ${this.configFile}:`, err);
		}

		if (text !== undefined) {
			if (text.trim().length === 0) {
				// Present-but-empty file: treat as an intentional reset, not
				// corruption. Deliberately do NOT fall back to a .bak.N here —
				// resurrecting old content over a file the user just emptied
				// would violate their intent (mirrors the CON-01 resurrection
				// guard for deliberate deletes elsewhere in the durable-store layer).
				this.resetToEmpty();
				this.resetEpisodeLogs();
				return;
			}
			if (this.tryApplyYaml(text)) {
				// Primary parsed cleanly — any prior failure/recovery episode is over.
				this.resetEpisodeLogs();
				return;
			}
			if (!this.failureLogged) {
				console.error(`[project-config-store] Failed to parse project config (invalid YAML or unexpected shape): ${this.configFile}`);
			}
		}

		if (this.recoverFromBackups()) return;

		// No parseable primary or backup. Leave the FULL in-memory state exactly
		// as it was — flat keys, components, workflows, and migrated side-tables
		// alike (fresh boot: still pristine defaults; live reload(): last
		// known-good snapshot) — and do NOT touch disk. Setting loadFailed is
		// what actually prevents the next set()/setWorkflows()/… from
		// serializing that state (empty or stale) back over the still-present,
		// possibly hand-recoverable corrupt file.
		this.enterLoadFailed(
			`[project-config-store] project.yaml is corrupt/unreadable with no parseable backup — ` +
			`refusing further saves until the file is fixed or restored manually. File: ${this.configFile}`,
		);
	}

	/** Mark this load as failed, logging the operator error once per episode.
	 *  (load() runs per getWithDefaults() call, i.e. per REST GET — unthrottled
	 *  logging would spam a line per request while the file stays corrupt.) */
	private enterLoadFailed(message: string): void {
		this.loadFailed = true;
		if (!this.failureLogged) {
			console.error(message);
			this.failureLogged = true;
		}
	}

	/** Clear the per-episode log rate limiters after a clean primary load. */
	private resetEpisodeLogs(): void {
		this.failureLogged = false;
		this.recoveryLogged = false;
	}

	/** Reset the full in-memory state to a fresh empty config (missing file /
	 *  intentionally emptied file). */
	private resetToEmpty(): void {
		this.data = {};
		this.components = [];
		this.workflows = undefined;
		this.resetMigratedFields();
	}

	private resetMigratedFields(): void {
		this.configDirectories = [];
		this.sandboxTokens = [];
		this.packOrder = {};
		this.packActivation = {};
		this.present = {
			config_directories: false,
			sandbox_tokens: false,
			pack_order: false,
			pack_activation: false,
		};
	}

	/** Try each `.bak.N` (newest first), applying the first one that parses. Returns
	 *  true (and leaves loadFailed false) on success. */
	private recoverFromBackups(): boolean {
		for (let i = 1; i <= ProjectConfigStore.BACKUP_COUNT; i++) {
			const bak = bakPath(this.configFile, i);
			let bakText: string;
			try {
				bakText = fs.readFileSync(bak, "utf-8");
			} catch {
				continue;
			}
			if (this.tryApplyYaml(bakText)) {
				if (!this.recoveryLogged) {
					console.warn(
						`[project-config-store] Recovered project config from backup ${path.basename(bak)} — ` +
						`the primary was corrupt/missing. The bad primary (if any) is left on disk untouched; ` +
						`the next successful save() rotates it into .bak.1 before writing the recovered state. ` +
						`See docs/debugging.md.`,
					);
					this.recoveryLogged = true;
				}
				return true;
			}
		}
		return false;
	}

	/** Parse `text` as YAML and, if it is a plain object, apply it as the current
	 *  config (components/workflows/migrated fields included). Returns false
	 *  (without mutating any state) if the text fails to parse or isn't a plain
	 *  object — callers can then try the next candidate (a backup generation). */
	private tryApplyYaml(text: string): boolean {
		let raw: unknown;
		try {
			raw = yaml.parse(text);
		} catch {
			return false;
		}
		if (!isPlainObject(raw)) return false;

		// Parse + shape check passed — safe to replace state now. Migrated
		// side-tables reset first because loadMigrated() only assigns fields
		// that are present in `raw`.
		this.resetMigratedFields();

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
		return true;
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

		// pack_order — scoped map { server?, "global-user"?, project? }: string[]
		if (raw.pack_order !== undefined && raw.pack_order !== null) {
			const v = raw.pack_order;
			if (typeof v === "string") {
				if (v.length > 0) {
					try {
						const parsed = JSON.parse(v);
						const norm = normalizePackOrder(parsed);
						if (norm.ok) {
							this.packOrder = norm.value;
							this.present.pack_order = true;
							this.dirty = true;
						} else {
							console.warn("[project-config-store] Failed to parse pack_order, treating as default");
						}
					} catch (err) {
						console.warn("[project-config-store] Failed to parse pack_order, treating as default:", err);
					}
				}
			} else {
				const norm = normalizePackOrder(v);
				if (norm.ok) {
					this.packOrder = norm.value;
					this.present.pack_order = true;
				} else {
					console.warn("[project-config-store] Failed to parse pack_order, treating as default");
				}
			}
		}

		// pack_activation — scoped map { scope: { packName: DisabledRefs } }
		if (raw.pack_activation !== undefined && raw.pack_activation !== null) {
			const v = raw.pack_activation;
			if (typeof v === "string") {
				if (v.length > 0) {
					try {
						const parsed = JSON.parse(v);
						const norm = normalizePackActivation(parsed);
						if (norm.ok) {
							this.packActivation = norm.value;
							this.present.pack_activation = true;
							this.dirty = true;
						} else {
							console.warn("[project-config-store] Failed to parse pack_activation, treating as default");
						}
					} catch (err) {
						console.warn("[project-config-store] Failed to parse pack_activation, treating as default:", err);
					}
				}
			} else {
				const norm = normalizePackActivation(v);
				if (norm.ok) {
					this.packActivation = norm.value;
					this.present.pack_activation = true;
				} else {
					console.warn("[project-config-store] Failed to parse pack_activation, treating as default");
				}
			}
		}
	}

	private save(): void {
		if (this.loadFailed) {
			// CON-02 guard: never serialize whatever is currently in memory (empty
			// or stale) over a project.yaml that failed to load and has no
			// recoverable backup — that would make the loss permanent. Throwing
			// (rather than silently no-op'ing) matches the existing precedent of
			// setMigratedFromString() already throwing synchronously from these
			// same public setters on bad input, so callers get a catchable signal
			// instead of a misleading "success".
			const msg = `ProjectConfigStore: refusing to save — ${this.configFile} is corrupt/unreadable and has no recoverable backup; fix or restore the file manually, then retry`;
			console.error(`[project-config-store] ${msg}`);
			throw new Error(msg);
		}
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
			if (this.present.pack_order || this.packOrderNonEmpty()) {
				out.pack_order = this.serializePackOrder();
			}
			if (this.present.pack_activation || this.packActivationNonEmpty()) {
				out.pack_activation = this.serializePackActivation();
			}
			// Clear dirty flag — file is now in native form.
			this.dirty = false;

			// CON-02: crash-safe write (tmp-write → fsync → rename → dir fsync) with
			// BACKUP_COUNT-deep .bak.N rotation, shared with gate/team/task/inbox via
			// atomic-json.ts. rotateBackups() (inside atomicWriteFileSync) always
			// copies the CURRENT on-disk file into .bak.1 before the rename, so even
			// if this write is ever reached against a not-yet-detected-bad primary,
			// that primary is preserved as a backup generation, never silently lost.
			atomicWriteFileSync(this.configFile, yaml.stringify(out), { backups: ProjectConfigStore.BACKUP_COUNT });
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
		if (this.present.pack_order || this.packOrderNonEmpty()) {
			out.pack_order = JSON.stringify(this.serializePackOrder());
		}
		if (this.present.pack_activation || this.packActivationNonEmpty()) {
			out.pack_activation = JSON.stringify(this.serializePackActivation());
		}
		return out;
	}

	private packOrderNonEmpty(): boolean {
		return Object.values(this.packOrder).some(arr => Array.isArray(arr) && arr.length > 0);
	}

	/** Emit only scopes that have a (possibly empty) explicit array. */
	private serializePackOrder(): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(this.packOrder)) {
			if (Array.isArray(v)) out[k] = [...v];
		}
		return out;
	}

	private packActivationNonEmpty(): boolean {
		return Object.values(this.packActivation).some(
			(byPack) => byPack && Object.keys(byPack).length > 0,
		);
	}

	private serializePackActivation(): Record<string, Record<string, DisabledRefs>> {
		const out: Record<string, Record<string, DisabledRefs>> = {};
		for (const [scope, byPack] of Object.entries(this.packActivation)) {
			if (!byPack) continue;
			const scopeOut: Record<string, DisabledRefs> = {};
			for (const [packName, refs] of Object.entries(byPack)) {
				const o: DisabledRefs = {};
				for (const kind of ACTIVATION_KINDS) {
					const arr = refs[kind];
					if (Array.isArray(arr) && arr.length > 0) o[kind] = [...arr];
				}
				const mcpOperations = normalizeMcpOperations(refs.mcpOperations);
				if (mcpOperations) o.mcpOperations = mcpOperations;
				if (Object.keys(o).length > 0) scopeOut[packName] = o;
			}
			if (Object.keys(scopeOut).length > 0) out[scope] = scopeOut;
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
			case "pack_order": {
				try {
					const parsed = JSON.parse(value);
					const norm = normalizePackOrder(parsed);
					if (norm.ok) {
						this.packOrder = norm.value;
						this.present.pack_order = true;
						this.save();
					} else {
						throw new Error("Invalid pack_order shape");
					}
				} catch (err) {
					throw new Error(`Failed to parse pack_order as JSON: ${(err as Error).message}`);
				}
				break;
			}
			case "pack_activation": {
				try {
					const parsed = JSON.parse(value);
					const norm = normalizePackActivation(parsed);
					if (norm.ok) {
						this.packActivation = norm.value;
						this.present.pack_activation = true;
						this.save();
					} else {
						throw new Error("Invalid pack_activation shape");
					}
				} catch (err) {
					throw new Error(`Failed to parse pack_activation as JSON: ${(err as Error).message}`);
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
			case "pack_order":
				this.packOrder = {};
				this.present.pack_order = false;
				break;
			case "pack_activation":
				this.packActivation = {};
				this.present.pack_activation = false;
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

	/**
	 * Read a scope's market-pack order (highest priority LAST). Returns a
	 * defensive copy; missing scope ⇒ []. `project` lives in the project config;
	 * `server` + `global-user` live in the server config (design §3.3).
	 */
	getPackOrder(scope: PackOrderScope): string[] {
		return [...(this.packOrder[scope] ?? [])];
	}

	/** Replace a scope's market-pack order. Persists immediately. */
	setPackOrder(scope: PackOrderScope, order: string[]): void {
		const names = order.filter((x): x is string => typeof x === "string");
		this.packOrder = { ...this.packOrder, [scope]: names };
		this.present.pack_order = this.packOrderNonEmpty();
		this.save();
	}

	/** Full scoped map (defensive copy) — used by buildPackList wiring. */
	getPackOrderMap(): PackOrderMap {
		const out: PackOrderMap = {};
		for (const [k, v] of Object.entries(this.packOrder)) {
			if (Array.isArray(v)) out[k as PackOrderScope] = [...v];
		}
		return out;
	}

	// ── Pack activation overrides (pack-schema-v1 §6.7) ──────────────

	/** Inject the default-disabled overlay resolver (server.ts wires it after the
	 *  pack registries are built). A no-op until set; only the SERVER-scope store
	 *  needs it (built-in packs toggle at server scope). */
	setDefaultActivationResolver(
		fn: (scope: PackOrderScope, packName: string, stored: DisabledRefs) => DisabledRefs | undefined,
	): void {
		this.defaultActivationResolver = fn;
	}

	/** Read the EFFECTIVE disabled-entity refs for a pack at a scope (defensive
	 *  copy). Missing ⇒ {} (all enabled), UNLESS the injected default-disabled
	 *  overlay synthesizes an all-disabled set for a dormant built-in pack (e.g.
	 *  Hindsight before it is enabled/configured). The overlay is read-time only —
	 *  it never mutates or persists `this.packActivation`. */
	getPackActivation(scope: PackOrderScope, packName: string): DisabledRefs {
		const refs = this.packActivation[scope]?.[packName];
		const out: DisabledRefs = {};
		if (refs) {
			for (const kind of ACTIVATION_KINDS) {
				const arr = refs[kind];
				if (Array.isArray(arr) && arr.length > 0) out[kind] = [...arr];
			}
		}
		if (this.defaultActivationResolver) {
			const overlay = this.defaultActivationResolver(scope, packName, out);
			if (overlay) return overlay;
		}
		const mcpOperations = normalizeMcpOperations(refs?.mcpOperations);
		if (mcpOperations) out.mcpOperations = mcpOperations;
		return out;
	}

	/** Replace the disabled-entity refs for a pack at a scope. An all-empty
	 *  `disabled` clears the pack's override. Persists immediately. */
	setPackActivation(scope: PackOrderScope, packName: string, disabled: DisabledRefs): void {
		const norm = normalizeDisabledRefs(disabled);
		const scopeMap = { ...(this.packActivation[scope] ?? {}) };
		if (Object.keys(norm).length === 0) {
			delete scopeMap[packName];
		} else {
			scopeMap[packName] = norm;
		}
		const next = { ...this.packActivation };
		if (Object.keys(scopeMap).length === 0) delete next[scope];
		else next[scope] = scopeMap;
		this.packActivation = next;
		this.present.pack_activation = this.packActivationNonEmpty();
		this.save();
	}

	/** Full scoped activation map (defensive copy). */
	getPackActivationMap(): PackActivationMap {
		const out: PackActivationMap = {};
		for (const [scope, byPack] of Object.entries(this.packActivation)) {
			if (!byPack) continue;
			const scopeOut: Record<string, DisabledRefs> = {};
			for (const packName of Object.keys(byPack)) {
				scopeOut[packName] = this.getPackActivation(scope as PackOrderScope, packName);
			}
			out[scope as PackOrderScope] = scopeOut;
		}
		return out;
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
