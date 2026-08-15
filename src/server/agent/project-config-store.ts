import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "yaml";
import {
	cloneAdoptedExtension,
	normalizeAdoptedExtension,
	redactAdoptedExtension,
	type AdoptedExtension,
	type AdoptedExtensionsMap,
	type AdoptionConformance,
	type AdoptionScope,
	type AdoptionStoreWarning,
} from "./adopted-extensions.js";
import {
	DEFAULT_PROMPT_EXTENSION_BUDGET,
	normalizePromptExtensionBudget,
	normalizePromptExtensionOverrides,
	type PromptExtensionBudget,
	type PromptExtensionOverride,
} from "./prompt-extension-overrides.js";
import {
	isExtensionSettingValue,
	isWellFormedExtensionSettingsText,
	normalizeDurableMultiEnumValue,
	MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_BYTES_PER_TARGET,
	MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_VALUES_PER_TARGET,
	type ExtensionSettingValue,
} from "./extension-settings-schema.js";

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

/** A transactional project-config update. The callback only changes a private
 * candidate; the store publishes it once and commits it to memory on success. */
export interface ProjectConfigDraft {
	set(key: string, value: string): void;
	remove(key: string): void;
	setConfigDirectories(dirs: ConfigDirectoryEntry[]): void;
	setSandboxTokens(tokens: SandboxTokenEntry[]): void;
	setPackOrder(scope: PackOrderScope, order: string[]): void;
	setPackActivation(scope: PackOrderScope, packName: string, disabled: DisabledRefs): void;
	setExtensionGrants(grants: ExtensionGrantMap): void;
	setExtensionSettings(state: ExtensionSettingsState): void;
	setAdoptedExtensions(scope: AdoptionScope, entries: Record<string, AdoptedExtension>): void;
	setPromptExtensionBudget(budget: PromptExtensionBudget): void;
	setPromptExtensionOverrides(overrides: PromptExtensionOverride[]): void;
	setComponents(components: Component[]): void;
	setWorkflows(workflows: Record<string, InlineWorkflowDef> | undefined): void;
}

/** Thrown when a config file needs repair before it can be safely overwritten. */
export class ProjectConfigLoadError extends Error {
	readonly code = "PROJECT_CONFIG_LOAD_FAILED";
	constructor(configFile: string) {
		super(`Project config at ${configFile} could not be loaded. Repair it and call reload() before saving.`);
		this.name = "ProjectConfigLoadError";
	}
}

/** Thrown when an atomic project-config publication could not be completed. */
export class ProjectConfigPersistenceError extends Error {
	readonly code = "PROJECT_CONFIG_PERSIST_FAILED";
	constructor() {
		super("Project config could not be published. Verify the config directory is writable and retry.");
		this.name = "ProjectConfigPersistenceError";
	}
}

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
	optional?: boolean; label?: string; optionalLabel?: string; description?: string; failureGuidance?: string;
};

export type CommandStepComponentRun = {
	name: string; type: "command"; component: string; run: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; optionalLabel?: string; description?: string; failureGuidance?: string;
};

export type CommandStepFreeform = {
	name: string; type: "command"; run: string;
	phase?: number; expect?: "success" | "failure"; timeout?: number;
	optional?: boolean; label?: string; optionalLabel?: string; description?: string; failureGuidance?: string;
};

export type CommandStep = CommandStepStructural | CommandStepComponentRun | CommandStepFreeform;

export type LlmReviewStep = {
	name: string; type: "llm-review"; prompt: string;
	role?: string; phase?: number; expect?: "success" | "failure";
	timeout?: number; optional?: boolean; label?: string; optionalLabel?: string; description?: string; failureGuidance?: string;
};

export type AgentQaStep = {
	name: string; type: "agent-qa"; prompt: string;
	role?: string; component?: string; phase?: number; timeout?: number;
	optional?: boolean; label?: string; optionalLabel?: string; description?: string; failureGuidance?: string;
};

export type HumanSignoffStep = {
	name: string; type: "human-signoff"; prompt: string; label: string;
	phase?: number; optional?: boolean; optionalLabel?: string; description?: string; failureGuidance?: string;
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
// These native fields used to be JSON-encoded strings (or numeric strings)
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

/** Closed vocabulary for explicit extension capability grants. */
export type ExtensionCapability =
	| "decide" | "mutate" | "filter:tool-result" | "store" | "session" | "agents"
	| "prompt:system-static" | "prompt:system-author"
	| "service.manage" | "memory.read" | "memory.write" | "memory.reflect"
	| "memory.invalidate" | "memory.read.all" | "sandbox:build";
export const EXTENSION_CAPABILITIES: ReadonlySet<ExtensionCapability> = new Set([
	"decide", "mutate", "filter:tool-result", "store", "session", "agents",
	"prompt:system-static", "prompt:system-author",
	"service.manage", "memory.read", "memory.write", "memory.reflect",
	"memory.invalidate", "memory.read.all", "sandbox:build",
]);

/** The platform-owned capabilities available only to a non-hook pack principal. */
export const EXTENSION_PACK_CAPABILITIES: ReadonlySet<ExtensionCapability> = new Set([
	"service.manage", "memory.read", "memory.write", "memory.reflect",
	"memory.invalidate", "memory.read.all", "sandbox:build",
]);

/** Server-derived hook identity. Wildcards are deliberately unsupported. */
export interface ExtensionHookRef {
	packId: string;
	hookId: string;
}

/** Legacy persisted shape. An absent discriminator permanently means hook. */
export interface ExtensionHookGrant extends ExtensionHookRef {
	/** Deliberately absent from persisted hook rows; `principal: "hook"` is invalid. */
	principal?: never;
	capability: ExtensionCapability;
	grantedAt: string;
	grantedBy: string;
}

/** Durable exact grant for a non-hook pack principal. */
export interface ExtensionPackGrant {
	packId: string;
	principal: "pack";
	/** Pack rows must not name a hook. */
	hookId?: never;
	capability: ExtensionCapability;
	grantedAt: string;
	grantedBy: string;
}

/** A durable, exact per-project capability grant. */
export type ExtensionGrant = ExtensionHookGrant | ExtensionPackGrant;

export type ExtensionGrantMap = ExtensionGrant[];

/** Public, project-owned settings overlay. Secret fields are never represented here. */
export interface ExtensionSettingsRecord {
	enabled?: boolean;
	values: Record<string, ExtensionSettingValue>;
}

export type ExtensionSettingsMap = Record<string, ExtensionSettingsRecord>;

/** Storage schema (not contribution schema); revision supports CAS at the API boundary. */
export interface ExtensionSettingsState {
	schema: 1 | 2;
	revision: number;
	/** Opaque identity paired with the owner-only extension-secret envelope. */
	commitId?: string;
	targets: ExtensionSettingsMap;
}

export const EMPTY_EXTENSION_SETTINGS_STATE: Readonly<ExtensionSettingsState> = Object.freeze({
	schema: 2,
	revision: 0,
	targets: Object.freeze({}) as ExtensionSettingsMap,
});

const MAX_EXTENSION_SETTINGS_TARGETS = 256;
const MAX_EXTENSION_SETTINGS_VALUES_PER_TARGET = 64;
const MAX_EXTENSION_SETTINGS_TARGET_KEY_LENGTH = 512;
const EXTENSION_SETTINGS_COMMIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function cloneExtensionSettingValue(value: ExtensionSettingValue): ExtensionSettingValue {
	return Array.isArray(value) ? [...value] as ExtensionSettingValue : value;
}

function cloneExtensionSettings(state: ExtensionSettingsState): ExtensionSettingsState {
	const targets: ExtensionSettingsMap = {};
	for (const [target, record] of Object.entries(state.targets)) {
		const values: Record<string, ExtensionSettingValue> = {};
		for (const [key, value] of Object.entries(record.values)) values[key] = cloneExtensionSettingValue(value);
		targets[target] = { ...(record.enabled === undefined ? {} : { enabled: record.enabled }), values };
	}
	return { schema: state.schema, revision: state.revision, ...(state.commitId === undefined ? {} : { commitId: state.commitId }), targets };
}

function isPrimitiveExtensionSettingValue(value: unknown): value is Exclude<ExtensionSettingValue, string[]> {
	return !Array.isArray(value) && isExtensionSettingValue(value);
}

/**
 * Defensive storage normalization. Malformed rows are isolated and dropped so
 * one stale target cannot hide valid project settings; an invalid root returns
 * a safe empty state. Schema 1 is deliberately primitive-only; schema 2 adds
 * bounded, canonical native string arrays for declared multi-enum fields.
 */
export function normalizeExtensionSettings(raw: unknown): { value: ExtensionSettingsState; ok: boolean } {
	const empty = (): ExtensionSettingsState => ({ schema: 2, revision: 0, targets: {} });
	if (!isPlainObject(raw)) return { value: empty(), ok: false };
	const schema = raw.schema;
	const revision = raw.revision;
	const commitId = raw.commitId;
	const rawTargets = raw.targets;
	if ((schema !== 1 && schema !== 2) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
		|| (commitId !== undefined && (typeof commitId !== "string" || !EXTENSION_SETTINGS_COMMIT_ID_RE.test(commitId)))
		|| !isPlainObject(rawTargets)) {
		return { value: empty(), ok: false };
	}
	const targets: ExtensionSettingsMap = {};
	const entries = Object.entries(rawTargets);
	if (entries.length > MAX_EXTENSION_SETTINGS_TARGETS) return { value: empty(), ok: false };
	for (const [targetKey, candidate] of entries) {
		// Server-created identity has exactly packId, kind and contribution id.
		const parts = targetKey.split("\u0000");
		if (targetKey.length === 0 || targetKey.length > MAX_EXTENSION_SETTINGS_TARGET_KEY_LENGTH
			|| parts.length !== 3 || parts.some(part => part.length === 0)
			|| (parts[1] !== "provider" && parts[1] !== "hook" && parts[1] !== "runtime" && parts[1] !== "sandboxRequirement") || !isPlainObject(candidate)) continue;
		const enabled = candidate.enabled;
		if (enabled !== undefined && typeof enabled !== "boolean") continue;
		const rawValues = candidate.values === undefined ? {} : candidate.values;
		if (!isPlainObject(rawValues)) continue;
		const valueEntries = Object.entries(rawValues);
		if (valueEntries.length > MAX_EXTENSION_SETTINGS_VALUES_PER_TARGET) continue;
		const values: Record<string, ExtensionSettingValue> = {};
		let selectedCount = 0;
		let selectedBytes = 0;
		let valid = true;
		for (const [key, value] of valueEntries) {
			if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) { valid = false; break; }
			if (Array.isArray(value)) {
				// Never give an old malformed array a meaning after upgrading the reader.
				if (schema === 1) { valid = false; break; }
				const selected = normalizeDurableMultiEnumValue(value);
				if (!selected) { valid = false; break; }
				selectedCount += selected.length;
				selectedBytes += selected.reduce((total, member) => total + Buffer.byteLength(member, "utf8"), 0);
				if (selectedCount > MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_VALUES_PER_TARGET
					|| selectedBytes > MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_BYTES_PER_TARGET) { valid = false; break; }
				values[key] = selected as ExtensionSettingValue;
			} else if (!isPrimitiveExtensionSettingValue(value)
				|| (typeof value === "string" && (!isWellFormedExtensionSettingsText(value) || Buffer.byteLength(value, "utf8") > 4 * 1024))) {
				valid = false;
				break;
			} else values[key] = value;
		}
		if (!valid) continue;
		targets[targetKey] = { ...(enabled === undefined ? {} : { enabled }), values };
	}
	return { value: { schema, revision, ...(commitId === undefined ? {} : { commitId }), targets }, ok: true };
}

/** Shared strict bound for stored hook refs and server-derived principal labels. */
export const EXTENSION_GRANT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isExtensionCapability(value: unknown): value is ExtensionCapability {
	return typeof value === "string" && EXTENSION_CAPABILITIES.has(value as ExtensionCapability);
}

/** Pack-only capability matrix; hook capability support remains declaration-owned. */
export function isExtensionPackCapability(value: unknown): value is ExtensionCapability {
	return typeof value === "string" && EXTENSION_PACK_CAPABILITIES.has(value as ExtensionCapability);
}

export function isSafeExtensionGrantIdentifier(value: unknown): value is string {
	return typeof value === "string" && EXTENSION_GRANT_IDENTIFIER.test(value);
}

/** ISO instants are canonicalized by the server before being persisted. */
export function isCanonicalExtensionGrantTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = new Date(value);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

const MIGRATED_KEYS = new Set([
	"config_directories",
	"sandbox_tokens",
	"pack_order",
	"pack_activation",
	"extension_grants",
	"extension_settings",
	"adopted_extensions",
	"prompt_extension_budget",
	"extension_prompt_sections",
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
	/**
	 * Explicit-enable sentinel for ships-disabled-by-default packs
	 * (`PackManifest.defaultDisabled`). `true` opts the pack IN; absent/false ⇒
	 * the pack stays at its manifest default. For normal packs this is unused
	 * (enabled = absence of a disable override). See `isPackEffectivelyEnabled`.
	 */
	enabled?: boolean;
	roles?: string[];
	tools?: string[];
	skills?: string[];
	entrypoints?: string[];
	providers?: string[];
	hooks?: string[];
	mcp?: string[];
	mcpOperations?: Record<string, string[]>;
	piExtensions?: string[];
	runtimes?: string[];
	/** Schema-3 inert sandbox requirement list names. */
	sandboxRequirements?: string[];
	workflows?: string[];
	/** Schema-2 static system-prompt contribution list names. */
	systemPrompts?: string[];
}

/** scope → packName → disabled entity refs by kind. Default (absent) = all enabled. */
export type PackActivationMap = Partial<Record<PackOrderScope, Record<string, DisabledRefs>>>;

const ACTIVATION_KINDS = ["roles", "tools", "skills", "entrypoints", "providers", "hooks", "mcp", "piExtensions", "runtimes", "sandboxRequirements", "workflows", "systemPrompts"] as const;

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
	if (raw.enabled === true) out.enabled = true;
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

function hasOnlyExtensionGrantFields(candidate: Record<string, unknown>, fields: readonly string[]): boolean {
	return Object.keys(candidate).every(key => fields.includes(key));
}

/** Normalize, validate, and de-duplicate grants by their exact authority tuple. */
export function normalizeExtensionGrants(raw: unknown): { value: ExtensionGrantMap; ok: boolean } {
	if (!Array.isArray(raw)) return { value: [], ok: false };
	const byTuple = new Map<string, ExtensionGrant>();
	for (const candidate of raw) {
		if (!isPlainObject(candidate)) continue;
		const { packId, capability, grantedAt, grantedBy } = candidate;
		if (!isSafeExtensionGrantIdentifier(packId)
			|| !isExtensionCapability(capability)
			|| !isCanonicalExtensionGrantTimestamp(grantedAt)
			|| !isSafeExtensionGrantIdentifier(grantedBy)) continue;

		// Legacy hook rows keep their exact discriminator-free persisted shape.
		if (candidate.principal === undefined) {
			const { hookId } = candidate;
			// Legacy hook rows historically tolerated unknown keys. Retain that
			// compatibility while canonicalizing them to the durable hook shape.
			if (!isSafeExtensionGrantIdentifier(hookId)
				|| isExtensionPackCapability(capability)) continue;
			const grant: ExtensionHookGrant = { packId, hookId, capability, grantedAt, grantedBy };
			byTuple.set(`${packId}\u0000hook\u0000${hookId}\u0000${capability}`, grant);
			continue;
		}

		if (candidate.principal !== "pack"
			|| !hasOnlyExtensionGrantFields(candidate, ["packId", "principal", "capability", "grantedAt", "grantedBy"])
			|| !isExtensionPackCapability(capability)) continue;
		const grant: ExtensionPackGrant = { packId, principal: "pack", capability, grantedAt, grantedBy };
		byTuple.set(`${packId}\u0000pack\u0000${capability}`, grant);
	}
	return { value: [...byTuple.values()], ok: true };
}

function cloneExtensionGrants(grants: readonly ExtensionGrant[]): ExtensionGrantMap {
	return grants.map(grant => ({ ...grant }));
}

/** Each corrupt entry is dropped independently so it cannot hide healthy adoptions. */
function normalizeAdoptedExtensions(raw: unknown, warnings: AdoptionStoreWarning[]): { value: AdoptedExtensionsMap; ok: boolean } {
	if (!isPlainObject(raw)) return { value: {}, ok: false };
	const value: AdoptedExtensionsMap = {};
	for (const scope of ["server", "global-user", "project"] as const) {
		const entries = raw[scope];
		if (entries === undefined) continue;
		if (!isPlainObject(entries)) {
			warnings.push({ code: "invalid_adoption_record", scope });
			continue;
		}
		const accepted: Record<string, AdoptedExtension> = {};
		for (const [id, candidate] of Object.entries(entries)) {
			const record = normalizeAdoptedExtension(candidate);
			if (!record || record.id !== id || record.scope !== scope) {
				warnings.push({ code: "invalid_adoption_record", scope, ...(typeof id === "string" ? { id: id.slice(0, 48) } : {}) });
				continue;
			}
			accepted[id] = record;
		}
		if (Object.keys(accepted).length > 0) value[scope] = accepted;
	}
	return { value, ok: true };
}

type PresentFields = {
	config_directories: boolean;
	sandbox_tokens: boolean;
	pack_order: boolean;
	pack_activation: boolean;
	extension_grants: boolean;
	extension_settings: boolean;
	adopted_extensions: boolean;
	prompt_extension_budget: boolean;
	extension_prompt_sections: boolean;
};

type ConfigStoreState = {
	data: ProjectConfig;
	components: Component[];
	workflows: Record<string, InlineWorkflowDef> | undefined;
	configDirectories: ConfigDirectoryEntry[];
	sandboxTokens: SandboxTokenEntry[];
	packOrder: PackOrderMap;
	packActivation: PackActivationMap;
	extensionGrants: ExtensionGrantMap;
	extensionSettings: ExtensionSettingsState;
	adoptedExtensions: AdoptedExtensionsMap;
	promptExtensionBudget: PromptExtensionBudget;
	promptExtensionOverrides: PromptExtensionOverride[];
	present: PresentFields;
	dirty: boolean;
};

function emptyPresent(): PresentFields {
	return {
		config_directories: false, sandbox_tokens: false, pack_order: false, pack_activation: false,
		extension_grants: false, extension_settings: false, adopted_extensions: false, prompt_extension_budget: false, extension_prompt_sections: false,
	};
}

function cloneComponents(components: Component[]): Component[] {
	return components.map(c => ({
		...c,
		commands: c.commands ? { ...c.commands } : undefined,
		config: c.config ? { ...c.config } : undefined,
	}));
}

function clonePackOrder(packOrder: PackOrderMap): PackOrderMap {
	const out: PackOrderMap = {};
	for (const [scope, order] of Object.entries(packOrder)) {
		if (Array.isArray(order)) out[scope as PackOrderScope] = [...order];
	}
	return out;
}

function clonePackActivation(packActivation: PackActivationMap): PackActivationMap {
	const out: PackActivationMap = {};
	for (const [scope, byPack] of Object.entries(packActivation)) {
		if (!byPack) continue;
		const clone: Record<string, DisabledRefs> = {};
		for (const [packName, refs] of Object.entries(byPack)) {
			clone[packName] = normalizeDisabledRefs(refs);
		}
		out[scope as PackOrderScope] = clone;
	}
	return out;
}

function cloneAdoptedExtensions(entries: AdoptedExtensionsMap): AdoptedExtensionsMap {
	const out: AdoptedExtensionsMap = {};
	for (const scope of ["server", "global-user", "project"] as const) {
		const scopeEntries = entries[scope];
		if (!scopeEntries) continue;
		out[scope] = Object.fromEntries(Object.entries(scopeEntries).map(([id, record]) => [id, cloneAdoptedExtension(record)]));
	}
	return out;
}

/** The legacy string API is sometimes sent over API responses; never leak command arguments through it. */
function redactAdoptedExtensions(entries: AdoptedExtensionsMap): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const scope of ["server", "global-user", "project"] as const) {
		const scopeEntries = entries[scope];
		if (scopeEntries) out[scope] = Object.fromEntries(Object.entries(scopeEntries).map(([id, record]) => [id, redactAdoptedExtension(record)]));
	}
	return out;
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
 *   2. Structured fields (`components: []`, `workflows: {}`, plus the
 *      native-YAML fields above) — emitted as native YAML on save.
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
	private components: Component[] = [];
	private workflows: Record<string, InlineWorkflowDef> | undefined;
	private configDirectories: ConfigDirectoryEntry[] = [];
	private sandboxTokens: SandboxTokenEntry[] = [];
	private packOrder: PackOrderMap = {};
	private packActivation: PackActivationMap = {};
	private extensionGrants: ExtensionGrantMap = [];
	private extensionSettings: ExtensionSettingsState = cloneExtensionSettings(EMPTY_EXTENSION_SETTINGS_STATE);
	private adoptedExtensions: AdoptedExtensionsMap = {};
	private adoptionWarnings: AdoptionStoreWarning[] = [];
	private promptExtensionBudget: PromptExtensionBudget = { ...DEFAULT_PROMPT_EXTENSION_BUDGET };
	private promptExtensionOverrides: PromptExtensionOverride[] = [];
	private present: PresentFields = emptyPresent();
	/** Set when a legacy string representation needs a native-YAML rewrite. */
	private dirty = false;
	/** Existing config file was unreadable, malformed, or had a non-object root. */
	private loadFailed = false;

	private readonly configFile: string;
	private readonly fs: FsLike;

	constructor(configDir: string, fsImpl: FsLike = realFs) {
		this.fs = fsImpl;
		this.configFile = path.join(configDir, "project.yaml");
		this.load();
	}

	/** True iff the loaded file contained a legacy JSON-string shape. */
	isDirty(): boolean { return this.dirty; }

	/** Redacted load status for callers that need to report a repair action. */
	getLoadError(): ProjectConfigLoadError | undefined {
		return this.loadFailed ? new ProjectConfigLoadError(this.configFile) : undefined;
	}

	private resetForLoad(): void {
		this.data = {};
		this.components = [];
		this.workflows = undefined;
		this.configDirectories = [];
		this.sandboxTokens = [];
		this.packOrder = {};
		this.packActivation = {};
		this.extensionGrants = [];
		this.extensionSettings = cloneExtensionSettings(EMPTY_EXTENSION_SETTINGS_STATE);
		this.adoptedExtensions = {};
		this.adoptionWarnings = [];
		this.promptExtensionBudget = { ...DEFAULT_PROMPT_EXTENSION_BUDGET };
		this.promptExtensionOverrides = [];
		this.present = emptyPresent();
		this.dirty = false;
		this.loadFailed = false;
	}

	private load(): void {
		// A failed reload must never leave getters backed by stale state.
		this.resetForLoad();
		try {
			// existsSync deliberately hides all errors as false. Only an explicit
			// initial ENOENT is a healthy absent config; e.g. EACCES needs repair.
			this.fs.lstatSync(this.configFile);
		} catch (error) {
			const code = typeof error === "object" && error !== null
				? (error as { code?: unknown }).code
				: undefined;
			if (code === "ENOENT") return;
			this.loadFailed = true;
			console.error(`[project-config-store] Failed to probe project config: ${this.configFile}`);
			return;
		}

		try {
			// A successful probe followed by ENOENT is a replacement race, not an
			// absent config. Latch it rather than risk overwriting a new target.
			const raw = yaml.parse(this.fs.readFileSync(this.configFile, "utf-8"));
			if (!isPlainObject(raw)) {
				this.loadFailed = true;
				console.error(`[project-config-store] Project config has an invalid top-level shape: ${this.configFile}`);
				return;
			}

			const cleaned: ProjectConfig = {};
			for (const [k, v] of Object.entries(raw)) {
				if (!MIGRATED_KEYS.has(k) && typeof v === "string") cleaned[k] = v;
			}
			this.data = cleaned;
			this.components = Array.isArray(raw.components) ? normalizeComponents(raw.components as unknown[]) : [];
			this.workflows = isPlainObject(raw.workflows) ? raw.workflows as Record<string, InlineWorkflowDef> : undefined;
			this.loadMigrated(raw);
		} catch {
			// Do not include parser/I/O details: they can contain config contents or secrets.
			this.resetForLoad();
			this.loadFailed = true;
			console.error(`[project-config-store] Failed to load project config: ${this.configFile}`);
		}
	}

	private loadMigrated(raw: Record<string, unknown>): void {
		const loadLegacy = <T>(key: keyof PresentFields, normalize: (value: unknown) => { value: T; ok: boolean }, assign: (value: T) => void): void => {
			const value = raw[key];
			if (value === undefined || value === null) return;
			if (typeof value === "string") {
				if (value.length === 0) return;
				try {
					const normalized = normalize(JSON.parse(value));
					if (!normalized.ok) throw new Error("invalid legacy shape");
					assign(normalized.value);
					this.present[key] = true;
					this.dirty = true;
				} catch {
					console.warn(`[project-config-store] Failed to parse ${key}, treating as default`);
				}
				return;
			}
			const normalized = normalize(value);
			if (normalized.ok) {
				assign(normalized.value);
				this.present[key] = true;
			} else {
				console.warn(`[project-config-store] Failed to parse ${key}, treating as default`);
			}
		};
		loadLegacy("config_directories", normalizeConfigDirectories, value => { this.configDirectories = value; });
		loadLegacy("sandbox_tokens", normalizeSandboxTokens, value => { this.sandboxTokens = value; });
		loadLegacy("pack_order", normalizePackOrder, value => { this.packOrder = value; });
		loadLegacy("pack_activation", normalizePackActivation, value => { this.packActivation = value; });
		// Grants are native YAML only. Unlike the older migrated fields, no
		// JSON-string compatibility representation is accepted or emitted.
		const grants = raw.extension_grants;
		if (grants !== undefined && grants !== null) {
			const normalized = normalizeExtensionGrants(grants);
			if (normalized.ok) {
				this.extensionGrants = normalized.value;
				this.present.extension_grants = true;
			} else {
				console.warn("[project-config-store] Failed to parse extension_grants, treating as default");
			}
		}
		const extensionSettings = raw.extension_settings;
		if (extensionSettings !== undefined && extensionSettings !== null) {
			const normalized = normalizeExtensionSettings(extensionSettings);
			if (normalized.ok) {
				this.extensionSettings = normalized.value;
				this.present.extension_settings = true;
			} else console.warn("[project-config-store] Failed to parse extension_settings, treating as unavailable");
		}
		loadLegacy("adopted_extensions", value => normalizeAdoptedExtensions(value, this.adoptionWarnings), value => { this.adoptedExtensions = value; });
		const budget = raw.prompt_extension_budget;
		if (budget !== undefined && budget !== null) {
			const normalized = normalizePromptExtensionBudget(budget);
			if (normalized.ok) { this.promptExtensionBudget = normalized.value; this.present.prompt_extension_budget = true; }
			else console.warn("[project-config-store] Failed to parse prompt_extension_budget, treating as default");
		}
		const overrides = raw.extension_prompt_sections;
		if (overrides !== undefined && overrides !== null) {
			const normalized = normalizePromptExtensionOverrides(overrides);
			if (normalized.ok) { this.promptExtensionOverrides = normalized.value; this.present.extension_prompt_sections = true; }
			else console.warn("[project-config-store] Failed to parse extension_prompt_sections, treating as default");
		}
	}

	private snapshot(): ConfigStoreState {
		return {
			data: { ...this.data },
			components: cloneComponents(this.components),
			workflows: this.workflows ? structuredClone(this.workflows) : undefined,
			configDirectories: this.configDirectories.map(e => ({ path: e.path, types: [...e.types] })),
			sandboxTokens: this.sandboxTokens.map(e => ({ ...e })),
			packOrder: clonePackOrder(this.packOrder),
			packActivation: clonePackActivation(this.packActivation),
			extensionGrants: cloneExtensionGrants(this.extensionGrants),
			extensionSettings: cloneExtensionSettings(this.extensionSettings),
			adoptedExtensions: cloneAdoptedExtensions(this.adoptedExtensions),
			promptExtensionBudget: { ...this.promptExtensionBudget },
			promptExtensionOverrides: this.promptExtensionOverrides.map(override => ({ ...override })),
			present: { ...this.present },
			dirty: this.dirty,
		};
	}

	private apply(state: ConfigStoreState): void {
		this.data = state.data;
		this.components = state.components;
		this.workflows = state.workflows;
		this.configDirectories = state.configDirectories;
		this.sandboxTokens = state.sandboxTokens;
		this.packOrder = state.packOrder;
		this.packActivation = state.packActivation;
		this.extensionGrants = state.extensionGrants;
		this.extensionSettings = state.extensionSettings;
		this.adoptedExtensions = state.adoptedExtensions;
		this.promptExtensionBudget = state.promptExtensionBudget;
		this.promptExtensionOverrides = state.promptExtensionOverrides;
		this.present = state.present;
		this.dirty = state.dirty;
	}

	private assertCanSave(): void {
		if (this.loadFailed) throw new ProjectConfigLoadError(this.configFile);
	}

	private serialize(state: ConfigStoreState): string {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(state.data)) {
			if (!MIGRATED_KEYS.has(k)) out[k] = v;
		}
		if (state.components.length > 0) out.components = state.components.map(serializeComponent);
		if (state.workflows && Object.keys(state.workflows).length > 0) out.workflows = state.workflows;
		if (state.present.config_directories || state.configDirectories.length > 0) {
			out.config_directories = state.configDirectories.map(e => ({ path: e.path, types: [...e.types] }));
		}
		if (state.present.sandbox_tokens || state.sandboxTokens.length > 0) {
			// Values are accepted at API ingress only; project.yaml must never contain them.
			out.sandbox_tokens = state.sandboxTokens.map(e => ({ key: e.key, enabled: e.enabled }));
		}
		if (state.present.pack_order || this.packOrderNonEmpty(state.packOrder)) out.pack_order = this.serializePackOrder(state.packOrder);
		if (state.present.pack_activation || this.packActivationNonEmpty(state.packActivation)) out.pack_activation = this.serializePackActivation(state.packActivation);
		if (state.present.extension_grants || state.extensionGrants.length > 0) out.extension_grants = cloneExtensionGrants(state.extensionGrants);
		if (state.present.extension_settings) out.extension_settings = cloneExtensionSettings(state.extensionSettings);
		if (state.present.adopted_extensions || this.adoptedExtensionsNonEmpty(state.adoptedExtensions)) out.adopted_extensions = this.serializeAdoptedExtensions(state.adoptedExtensions);
		if (state.present.prompt_extension_budget) out.prompt_extension_budget = { ...state.promptExtensionBudget };
		if (state.present.extension_prompt_sections || state.promptExtensionOverrides.length > 0) out.extension_prompt_sections = state.promptExtensionOverrides.map(override => ({ ...override }));
		return yaml.stringify(out);
	}

	private existingTargetMode(): number | undefined {
		try {
			const mode = this.fs.statSync(this.configFile).mode;
			// Stats always has mode in Node. Test doubles without it use the
			// default create mode rather than accidentally creating mode 000.
			return typeof mode === "number" ? mode & 0o777 : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
			throw error;
		}
	}

	private publish(state: ConfigStoreState): void {
		const dir = path.dirname(this.configFile);
		const temp = `${this.configFile}.${process.pid}.${randomUUID()}.tmp`;
		try {
			// Rename publishes the temp inode's mode. Seed it from the existing
			// target before the POSIX atomic replacement, rather than chmodding the
			// destination after publication (which could widen a private config).
			const targetMode = this.existingTargetMode();
			if (!this.fs.existsSync(dir)) this.fs.mkdirSync(dir, { recursive: true });
			this.fs.writeFileSync(temp, this.serialize(state), targetMode === undefined
				? "utf-8"
				: { encoding: "utf-8", mode: targetMode });
			this.fs.renameSync(temp, this.configFile);
		} catch {
			try { this.fs.unlinkSync(temp); } catch { /* only clean this invocation's temp file */ }
			// Filesystem/YAML errors can contain config contents or token values.
			throw new ProjectConfigPersistenceError();
		}
	}

	private commit(candidate: ConfigStoreState): void {
		this.assertCanSave();
		this.publish(candidate);
		candidate.dirty = false;
		this.apply(candidate);
	}

	/** Apply several changes as one durable, all-or-nothing publication. */
	mutate(mutator: (draft: ProjectConfigDraft) => void): void {
		this.assertCanSave();
		const candidate = this.snapshot();
		const draft: ProjectConfigDraft = {
			set: (key, value) => this.setStateValue(candidate, key, value),
			remove: key => this.removeStateValue(candidate, key),
			setConfigDirectories: dirs => {
				candidate.configDirectories = dirs.map(e => ({ path: e.path, types: [...e.types] }));
				candidate.present.config_directories = candidate.configDirectories.length > 0;
			},
			setSandboxTokens: tokens => {
				candidate.sandboxTokens = tokens.map(e => ({ ...e }));
				candidate.present.sandbox_tokens = candidate.sandboxTokens.length > 0;
			},
			setPackOrder: (scope, order) => {
				candidate.packOrder = { ...candidate.packOrder, [scope]: order.filter((x): x is string => typeof x === "string") };
				candidate.present.pack_order = this.packOrderNonEmpty(candidate.packOrder);
			},
			setPackActivation: (scope, packName, disabled) => this.setStatePackActivation(candidate, scope, packName, disabled),
			setExtensionGrants: grants => {
				candidate.extensionGrants = normalizeExtensionGrants(grants).value;
				candidate.present.extension_grants = candidate.extensionGrants.length > 0;
			},
			setExtensionSettings: state => {
				const normalized = normalizeExtensionSettings(state);
				if (!normalized.ok) throw new Error("Invalid extension settings state");
				candidate.extensionSettings = normalized.value;
				candidate.present.extension_settings = true;
			},
			setAdoptedExtensions: (scope, entries) => {
				const normalizedEntries: Record<string, AdoptedExtension> = {};
				for (const [id, record] of Object.entries(entries)) {
					const normalized = normalizeAdoptedExtension(record);
					if (!normalized || normalized.id !== id || normalized.scope !== scope) throw new Error("Invalid adopted extension record");
					normalizedEntries[id] = cloneAdoptedExtension(normalized);
				}
				candidate.adoptedExtensions = { ...candidate.adoptedExtensions, [scope]: normalizedEntries };
				if (Object.keys(normalizedEntries).length === 0) delete candidate.adoptedExtensions[scope];
				candidate.present.adopted_extensions = this.adoptedExtensionsNonEmpty(candidate.adoptedExtensions);
			},
			setPromptExtensionBudget: budget => {
				const normalized = normalizePromptExtensionBudget(budget);
				if (!normalized.ok) throw new Error("Invalid prompt extension budget");
				candidate.promptExtensionBudget = normalized.value;
				candidate.present.prompt_extension_budget = true;
			},
			setPromptExtensionOverrides: overrides => {
				const normalized = normalizePromptExtensionOverrides(overrides);
				if (!normalized.ok) throw new Error("Invalid prompt extension overrides");
				candidate.promptExtensionOverrides = normalized.value;
				candidate.present.extension_prompt_sections = candidate.promptExtensionOverrides.length > 0;
			},
			setComponents: components => { candidate.components = cloneComponents(components); },
			setWorkflows: workflows => { candidate.workflows = workflows ? structuredClone(workflows) : undefined; },
		};
		mutator(draft);
		this.commit(candidate);
	}

	private setStateValue(state: ConfigStoreState, key: string, value: string): void {
		if (key.includes(".")) {
			throw new Error(`Project config key "${key}" must not contain dots — dots are reserved for namespace separators in {{project.key}} template variables`);
		}
		if (MIGRATED_KEYS.has(key)) {
			this.setMigratedStateFromString(state, key, value);
			return;
		}
		state.data[key] = value;
	}

	private setMigratedStateFromString(state: ConfigStoreState, key: string, value: string): void {
		if (value === "") { this.removeStateValue(state, key); return; }
		try {
			const parsed = JSON.parse(value);
			switch (key) {
				case "config_directories": {
					const norm = normalizeConfigDirectories(parsed);
					if (!norm.ok) throw new Error("Invalid config_directories shape");
					state.configDirectories = norm.value; state.present.config_directories = true; return;
				}
				case "sandbox_tokens": {
					const norm = normalizeSandboxTokens(parsed);
					if (!norm.ok) throw new Error("Invalid sandbox_tokens shape");
					state.sandboxTokens = norm.value; state.present.sandbox_tokens = true; return;
				}
				case "pack_order": {
					const norm = normalizePackOrder(parsed);
					if (!norm.ok) throw new Error("Invalid pack_order shape");
					state.packOrder = norm.value; state.present.pack_order = true; return;
				}
				case "pack_activation": {
					const norm = normalizePackActivation(parsed);
					if (!norm.ok) throw new Error("Invalid pack_activation shape");
					state.packActivation = norm.value; state.present.pack_activation = true; return;
				}
				case "extension_grants":
				case "extension_settings":
				case "prompt_extension_budget":
				case "extension_prompt_sections":
					throw new Error(`${key} must use its typed setter()`);
				case "adopted_extensions": {
					const norm = normalizeAdoptedExtensions(parsed, this.adoptionWarnings);
					if (!norm.ok) throw new Error("Invalid adopted_extensions shape");
					state.adoptedExtensions = norm.value; state.present.adopted_extensions = true; return;
				}
			}
		} catch (error) {
			throw new Error(`Failed to parse ${key} as JSON: ${(error as Error).message}`);
		}
	}

	private removeStateValue(state: ConfigStoreState, key: string): void {
		if (!MIGRATED_KEYS.has(key)) { delete state.data[key]; return; }
		switch (key) {
			case "config_directories": state.configDirectories = []; state.present.config_directories = false; return;
			case "sandbox_tokens": state.sandboxTokens = []; state.present.sandbox_tokens = false; return;
			case "pack_order": state.packOrder = {}; state.present.pack_order = false; return;
			case "pack_activation": state.packActivation = {}; state.present.pack_activation = false; return;
			case "extension_grants": state.extensionGrants = []; state.present.extension_grants = false; return;
			case "extension_settings": state.extensionSettings = cloneExtensionSettings(EMPTY_EXTENSION_SETTINGS_STATE); state.present.extension_settings = false; return;
			case "adopted_extensions": state.adoptedExtensions = {}; state.present.adopted_extensions = false; return;
			case "prompt_extension_budget": state.promptExtensionBudget = { ...DEFAULT_PROMPT_EXTENSION_BUDGET }; state.present.prompt_extension_budget = false; return;
			case "extension_prompt_sections": state.promptExtensionOverrides = []; state.present.extension_prompt_sections = false; return;
		}
	}

	private setStatePackActivation(state: ConfigStoreState, scope: PackOrderScope, packName: string, disabled: DisabledRefs): void {
		const norm = normalizeDisabledRefs(disabled);
		const scopeMap = { ...(state.packActivation[scope] ?? {}) };
		if (Object.keys(norm).length === 0) delete scopeMap[packName];
		else scopeMap[packName] = norm;
		const next = { ...state.packActivation };
		if (Object.keys(scopeMap).length === 0) delete next[scope]; else next[scope] = scopeMap;
		state.packActivation = next;
		state.present.pack_activation = this.packActivationNonEmpty(next);
	}

	private flatLegacyView(): Record<string, string> {
		const out: Record<string, string> = { ...this.data };
		if (this.present.config_directories || this.configDirectories.length > 0) out.config_directories = JSON.stringify(this.configDirectories);
		if (this.present.sandbox_tokens || this.sandboxTokens.length > 0) {
			out.sandbox_tokens = JSON.stringify(this.sandboxTokens.map(e => {
				const value: Record<string, unknown> = { key: e.key, enabled: e.enabled };
				if (e.value) value.value = e.value;
				return value;
			}));
		}
		if (this.present.pack_order || this.packOrderNonEmpty()) out.pack_order = JSON.stringify(this.serializePackOrder());
		if (this.present.pack_activation || this.packActivationNonEmpty()) out.pack_activation = JSON.stringify(this.serializePackActivation());
		if (this.present.adopted_extensions || this.adoptedExtensionsNonEmpty()) out.adopted_extensions = JSON.stringify(redactAdoptedExtensions(this.adoptedExtensions));
		if (this.present.prompt_extension_budget) out.prompt_extension_budget = JSON.stringify(this.promptExtensionBudget);
		if (this.present.extension_prompt_sections || this.promptExtensionOverrides.length > 0) out.extension_prompt_sections = JSON.stringify(this.promptExtensionOverrides);
		return out;
	}

	private packOrderNonEmpty(packOrder: PackOrderMap = this.packOrder): boolean {
		return Object.values(packOrder).some(arr => Array.isArray(arr) && arr.length > 0);
	}

	private serializePackOrder(packOrder: PackOrderMap = this.packOrder): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [k, v] of Object.entries(packOrder)) if (Array.isArray(v)) out[k] = [...v];
		return out;
	}

	private packActivationNonEmpty(packActivation: PackActivationMap = this.packActivation): boolean {
		return Object.values(packActivation).some(byPack => byPack && Object.keys(byPack).length > 0);
	}

	private serializePackActivation(packActivation: PackActivationMap = this.packActivation): Record<string, Record<string, DisabledRefs>> {
		const out: Record<string, Record<string, DisabledRefs>> = {};
		for (const [scope, byPack] of Object.entries(packActivation)) {
			if (!byPack) continue;
			const scopeOut: Record<string, DisabledRefs> = {};
			for (const [packName, refs] of Object.entries(byPack)) {
				const value: DisabledRefs = {};
				if (refs.enabled === true) value.enabled = true;
				for (const kind of ACTIVATION_KINDS) {
					const arr = refs[kind];
					if (Array.isArray(arr) && arr.length > 0) value[kind] = [...arr];
				}
				const mcpOperations = normalizeMcpOperations(refs.mcpOperations);
				if (mcpOperations) value.mcpOperations = mcpOperations;
				if (Object.keys(value).length > 0) scopeOut[packName] = value;
			}
			if (Object.keys(scopeOut).length > 0) out[scope] = scopeOut;
		}
		return out;
	}

	private adoptedExtensionsNonEmpty(entries: AdoptedExtensionsMap = this.adoptedExtensions): boolean {
		return Object.values(entries).some(scopeEntries => scopeEntries && Object.keys(scopeEntries).length > 0);
	}

	private serializeAdoptedExtensions(entries: AdoptedExtensionsMap = this.adoptedExtensions): AdoptedExtensionsMap {
		return cloneAdoptedExtensions(entries);
	}

	get(key: string): string | undefined {
		if (MIGRATED_KEYS.has(key)) {
			return this.flatLegacyView()[key];
		}
		return this.data[key];
	}

	set(key: string, value: string): void {
		this.mutate(draft => draft.set(key, value));
	}

	remove(key: string): void {
		this.mutate(draft => draft.remove(key));
	}
	getAll(): ProjectConfig {
		return this.flatLegacyView();
	}

	/** Returns a copy of the built-in defaults. */
	getDefaults(): Record<string, string> {
		return { ...DEFAULTS };
	}

	/** Returns all fields with defaults applied for any missing values.
	 * Call reload() to explicitly pick up external changes or repair a failed load.
	 */
	getWithDefaults(): Record<string, string> {
		return { ...DEFAULTS, ...this.flatLegacyView() };
	}

	// ── Native-YAML typed accessors (preferred over flat get/set) ────

	getConfigDirectories(): ConfigDirectoryEntry[] {
		return this.configDirectories.map(e => ({ path: e.path, types: [...e.types] }));
	}

	setConfigDirectories(dirs: ConfigDirectoryEntry[]): void {
		this.mutate(draft => draft.setConfigDirectories(dirs));
	}

	getSandboxTokens(): SandboxTokenEntry[] {
		return this.sandboxTokens.map(e => ({ key: e.key, enabled: e.enabled }));
	}

	setSandboxTokens(tokens: SandboxTokenEntry[]): void {
		this.mutate(draft => draft.setSandboxTokens(tokens));
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
		this.mutate(draft => draft.setPackOrder(scope, order));
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

	/** Read the disabled-entity refs for a pack at a scope (defensive copy).
	 *  Missing ⇒ {} (all enabled). */
	getPackActivation(scope: PackOrderScope, packName: string): DisabledRefs {
		const refs = this.packActivation[scope]?.[packName];
		if (!refs) return {};
		const out: DisabledRefs = {};
		if (refs.enabled === true) out.enabled = true;
		for (const kind of ACTIVATION_KINDS) {
			const arr = refs[kind];
			if (Array.isArray(arr) && arr.length > 0) out[kind] = [...arr];
		}
		const mcpOperations = normalizeMcpOperations(refs.mcpOperations);
		if (mcpOperations) out.mcpOperations = mcpOperations;
		return out;
	}

	/** Replace the disabled-entity refs for a pack at a scope. An all-empty
	 *  `disabled` clears the pack's override. Persists immediately. */
	setPackActivation(scope: PackOrderScope, packName: string, disabled: DisabledRefs): void {
		this.mutate(draft => draft.setPackActivation(scope, packName, disabled));
	}

	/** Native adopted-extension ledger accessors. Records are cloned at the boundary. */
	getAdoptedExtensions(scope: AdoptionScope): Record<string, AdoptedExtension>;
	getAdoptedExtensions(): AdoptedExtensionsMap;
	getAdoptedExtensions(scope?: AdoptionScope): AdoptedExtensionsMap | Record<string, AdoptedExtension> {
		if (scope) return Object.fromEntries(Object.entries(this.adoptedExtensions[scope] ?? {}).map(([id, record]) => [id, cloneAdoptedExtension(record)]));
		return cloneAdoptedExtensions(this.adoptedExtensions);
	}

	getAdoptionWarnings(): AdoptionStoreWarning[] {
		return this.adoptionWarnings.map(warning => ({ ...warning }));
	}

	upsertAdoptedExtension(scope: AdoptionScope, record: AdoptedExtension): void {
		const normalized = normalizeAdoptedExtension(record);
		if (!normalized || normalized.scope !== scope) throw new Error("Invalid adopted extension record");
		this.mutate(draft => {
			const current = this.getAdoptedExtensions(scope);
			current[normalized.id] = normalized;
			draft.setAdoptedExtensions(scope, current);
		});
	}

	removeAdoptedExtension(scope: AdoptionScope, id: string): boolean {
		const current = this.getAdoptedExtensions(scope);
		if (!current[id]) return false;
		delete current[id];
		this.mutate(draft => draft.setAdoptedExtensions(scope, current));
		return true;
	}

	/**
	 * Atomically replace a ledger row only when the caller's observed revision is
	 * current. Refreshes use this after awaiting network I/O so they cannot
	 * resurrect a deletion or overwrite a concurrent disable/selection change.
	 */
	compareAndSwapAdoptedExtension(scope: AdoptionScope, id: string, expectedRevision: number, replacement: AdoptedExtension): "updated" | "missing" | "conflict" {
		const current = this.getAdoptedExtensions(scope);
		const existing = current[id];
		if (!existing) return "missing";
		if (existing.revision !== expectedRevision) return "conflict";
		const normalized = normalizeAdoptedExtension(replacement);
		if (!normalized || normalized.scope !== scope || normalized.id !== id || normalized.revision !== expectedRevision + 1) {
			throw new Error("Invalid adopted extension compare-and-swap replacement");
		}
		current[id] = normalized;
		this.mutate(draft => draft.setAdoptedExtensions(scope, current));
		return "updated";
	}

	updateAdoptionConformance(scope: AdoptionScope, id: string, conformance: AdoptionConformance): boolean {
		const current = this.getAdoptedExtensions(scope);
		const record = current[id];
		if (!record) return false;
		const normalized = normalizeAdoptedExtension({
			...record,
			revision: record.revision + 1,
			conformance,
			provenance: { ...record.provenance, updatedAt: new Date().toISOString() },
		});
		if (!normalized) throw new Error("Invalid adoption conformance");
		current[id] = normalized;
		this.mutate(draft => draft.setAdoptedExtensions(scope, current));
		return true;
	}

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

	/** Exact active grants, copied so callers cannot mutate the stored snapshot. */
	getExtensionGrants(): ExtensionGrantMap {
		return cloneExtensionGrants(this.extensionGrants);
	}

	/** Replace grants atomically. Invalid rows are dropped and duplicate tuples replace metadata. */
	setExtensionGrants(grants: ExtensionGrantMap): void {
		this.mutate(draft => draft.setExtensionGrants(grants));
	}

	/** Safe public settings only; getters and setters are defensive and revision-preserving. */
	getExtensionSettings(): ExtensionSettingsState {
		return cloneExtensionSettings(this.extensionSettings);
	}

	setExtensionSettings(state: ExtensionSettingsState): void {
		this.mutate(draft => draft.setExtensionSettings(state));
	}


	/** Project hard caps for static prompt extensions (defensive copy). */
	getPromptExtensionBudget(): PromptExtensionBudget { return { ...this.promptExtensionBudget }; }

	/** Replace project caps atomically; caps may only lower platform defaults. */
	setPromptExtensionBudget(budget: PromptExtensionBudget): void { this.mutate(draft => draft.setPromptExtensionBudget(budget)); }

	/** Revisioned, project-effective static section replacements (defensive copy). */
	getPromptExtensionOverrides(): PromptExtensionOverride[] { return this.promptExtensionOverrides.map(override => ({ ...override })); }

	/** Internal acceptance seam. Extensions never receive direct access to this setter. */
	setPromptExtensionOverrides(overrides: PromptExtensionOverride[]): void { this.mutate(draft => draft.setPromptExtensionOverrides(overrides)); }

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
		return cloneComponents(this.components);
	}

	/** Lookup a component by name. */
	getComponent(name: string): Component | undefined {
		const c = this.components.find(x => x.name === name);
		return c ? cloneComponents([c])[0] : undefined;
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
		this.mutate(draft => draft.setComponents(components));
	}

	/** Returns the inline workflows map (or undefined). */
	getWorkflows(): Record<string, InlineWorkflowDef> | undefined {
		return this.workflows ? structuredClone(this.workflows) : undefined;
	}

	/** Replace the workflows{} map. Persists immediately. */
	setWorkflows(workflows: Record<string, InlineWorkflowDef> | undefined): void {
		this.mutate(draft => draft.setWorkflows(workflows));
	}

	/** Reload from disk — used by the migration to pick up out-of-band writes. */
	reload(): void {
		this.load();
	}

}
