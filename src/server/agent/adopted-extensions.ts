import crypto from "node:crypto";
import path from "node:path";
import { normalizeMcpContribution } from "./pack-contributions.js";
import type { ResolvedMcpContribution } from "../mcp/mcp-manager.js";

/** Durable scopes owned by the project config cascade. */
export type AdoptionScope = "server" | "global-user" | "project";
export type AdoptionKind = "mcp" | "skills";
export type AdoptionConformanceState = "pending" | "loaded" | "partial" | "rejected" | "unreachable";
export type AdoptionOperationClassification = "read-only-hint" | "unknown" | "mutation-or-contradictory";

export interface AdoptionMcpSource {
	transport: "stdio" | "http";
	command?: string;
	args?: string[];
	url?: string;
}

export interface AdoptionSkillSource {
	directory: string;
}

export type AdoptionSource = AdoptionMcpSource | AdoptionSkillSource;

export interface AdoptionOperation {
	name: string;
	classification: AdoptionOperationClassification;
	selected: boolean;
	/** Auto selections are revoked if a server later reports a mutation hint. */
	selection?: "auto" | "explicit";
}

export interface AdoptionFailure {
	code: AdoptionFailureCode;
	message: string;
}

export type AdoptionFailureCode =
	| "invalid_command"
	| "connection_failed"
	| "initialize_failed"
	| "tools_list_failed"
	| "invalid_operation_schema"
	| "missing_directory"
	| "malformed_frontmatter"
	| "invalid_adoption_record";

export interface AdoptionConformance {
	state: AdoptionConformanceState;
	checkedAt?: string;
	mcp?: {
		requestedProtocol?: string;
		negotiatedProtocol?: string;
		serverName?: string;
		serverVersion?: string;
		loadedTools: string[];
		rejectedTools: Array<{ name?: string; reason: string }>;
	};
	skills?: {
		loadedSkills: string[];
		rejectedSkills: Array<{ path: string; reason: string }>;
	};
	failures: AdoptionFailure[];
}

export interface AdoptedExtension {
	id: string;
	/** Monotonic ledger revision prevents an async refresh overwriting a newer mutation. */
	revision: number;
	kind: AdoptionKind;
	scope: AdoptionScope;
	projectId?: string;
	namespace: string;
	source: AdoptionSource;
	enabled: boolean;
	operations?: AdoptionOperation[];
	provenance: {
		class: "adopted";
		sourceType: "stdio" | "http" | "claude-skills-directory";
		sourceLocation: string;
		createdAt: string;
		updatedAt: string;
	};
	conformance: AdoptionConformance;
}

export type AdoptedExtensionsMap = Partial<Record<AdoptionScope, Record<string, AdoptedExtension>>>;

export interface AdoptionStoreWarning {
	code: "invalid_adoption_record";
	scope: AdoptionScope;
	id?: string;
}

const SCOPES = new Set<AdoptionScope>(["server", "global-user", "project"]);
const KINDS = new Set<AdoptionKind>(["mcp", "skills"]);
const CONFORMANCE_STATES = new Set<AdoptionConformanceState>(["pending", "loaded", "partial", "rejected", "unreachable"]);
const OPERATION_CLASSIFICATIONS = new Set<AdoptionOperationClassification>(["read-only-hint", "unknown", "mutation-or-contradictory"]);
const FAILURE_MESSAGES: Record<AdoptionFailureCode, string> = {
	invalid_command: "The command could not be started.",
	connection_failed: "The extension could not be reached.",
	initialize_failed: "The extension did not complete initialization.",
	tools_list_failed: "The extension did not provide a tool list.",
	invalid_operation_schema: "An operation has an unsupported schema.",
	missing_directory: "The skills directory is unavailable.",
	malformed_frontmatter: "A skill has malformed frontmatter.",
	invalid_adoption_record: "The saved adoption record is invalid.",
};
const FAILURE_CODES = new Set<AdoptionFailureCode>(Object.keys(FAILURE_MESSAGES) as AdoptionFailureCode[]);
const REJECTION_REASONS = new Set([
	"invalid_operation_schema",
	"missing_directory",
	"malformed_frontmatter",
	"duplicate_name",
	"missing_skill_file",
	"unreadable_directory",
]);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const OPERATION_NAME_RE = /^[^\0\n\r]{1,256}$/;

export class AdoptionValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdoptionValidationError";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every(key => allowed.has(key));
}

function cleanString(value: unknown, max = 256): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0") ? value : undefined;
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validProjectId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

function canonicalHttpUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new AdoptionValidationError("HTTP endpoint must be a non-empty URL");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new AdoptionValidationError("HTTP endpoint must be a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new AdoptionValidationError("HTTP endpoint must use http or https");
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new AdoptionValidationError("HTTP endpoint must not include credentials, query parameters, or fragments");
	}
	return parsed.toString();
}

/**
 * Strictly normalize a source before it enters the durable ledger. This is
 * deliberately narrower than generic MCP config: adoption owns no cwd, env,
 * or headers, and endpoints cannot become a credential/query persistence path.
 */
export function normalizeAdoptionSource(kind: AdoptionKind, raw: unknown): AdoptionSource {
	if (!isPlainObject(raw)) throw new AdoptionValidationError("Adoption source must be an object");
	if (kind === "skills") {
		if (!hasOnlyKeys(raw, ["directory"])) throw new AdoptionValidationError("Skills source has unsupported fields");
		const directory = cleanString(raw.directory, 4096);
		if (!directory || !path.isAbsolute(directory)) throw new AdoptionValidationError("Skills directory must be an absolute path");
		return { directory: path.normalize(directory) };
	}
	if (!hasOnlyKeys(raw, ["transport", "command", "args", "url"])) throw new AdoptionValidationError("MCP source has unsupported fields");
	if (raw.transport === "stdio") {
		const command = cleanString(raw.command, 4096);
		if (!command || command.trim().length === 0) throw new AdoptionValidationError("Stdio command must be non-empty");
		if (raw.url !== undefined) throw new AdoptionValidationError("Stdio source must not include an endpoint");
		if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === "string" && !arg.includes("\0")))) {
			throw new AdoptionValidationError("Stdio arguments must be strings");
		}
		const args = raw.args as string[] | undefined;
		return args && args.length > 0 ? { transport: "stdio", command, args: [...args] } : { transport: "stdio", command };
	}
	if (raw.transport === "http") {
		if (raw.command !== undefined || raw.args !== undefined) throw new AdoptionValidationError("HTTP source must not include command arguments");
		return { transport: "http", url: canonicalHttpUrl(raw.url) };
	}
	throw new AdoptionValidationError("MCP source transport must be stdio or http");
}

export function adoptionSourceType(source: AdoptionSource): AdoptedExtension["provenance"]["sourceType"] {
	return "directory" in source ? "claude-skills-directory" : source.transport;
}

/** Safe presentation value. It intentionally omits stdio arguments. */
export function adoptionSourceLocation(source: AdoptionSource): string {
	if ("directory" in source) return source.directory;
	return source.transport === "http" ? source.url! : source.command!;
}

/** Canonical full identity used only for exact idempotence comparisons. */
export function adoptionIdentity(scope: AdoptionScope, kind: AdoptionKind, projectId: string | undefined, source: AdoptionSource): string {
	const owner = scope === "project" ? projectId! : "";
	const sourceIdentity = "directory" in source
		? source.directory
		: source.transport === "http"
			? source.url
			: `${source.command}\u0000${(source.args ?? []).join("\u0000")}`;
	return `${scope}\u0000${owner}\u0000${kind}\u0000${sourceIdentity}`;
}

/** Secret-free stable identity used for public ids and namespaces. */
export function adoptionPublicIdentity(scope: AdoptionScope, kind: AdoptionKind, projectId: string | undefined, source: AdoptionSource): string {
	const owner = scope === "project" ? projectId! : "";
	return `${scope}\u0000${owner}\u0000${kind}\u0000${adoptionSourceLocation(source)}`;
}

function idSlug(source: AdoptionSource): string {
	const raw = "directory" in source
		? path.basename(source.directory)
		: source.transport === "http"
			? new URL(source.url!).hostname.split(".")[0]
			: path.basename(source.command!);
	const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	return slug || "extension";
}

/** Generates a stable non-secret id. Suffixing distinguishes distinct private identities sharing a public base. */
export function generateAdoptionId(publicIdentity: string, source: AdoptionSource, occupiedIds: Iterable<string> = []): string {
	const hash = crypto.createHash("sha256").update(publicIdentity).digest("hex").slice(0, 12);
	const maxSlugLength = 48 - hash.length - 1;
	const slug = idSlug(source).slice(0, maxSlugLength);
	const base = `${slug}-${hash}`;
	const used = new Set(occupiedIds);
	if (!used.has(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const suffixText = `-${suffix}`;
		// Keep the public digest intact: normalization validates it independently
		// of the collision suffix, so only the human-readable slug may shrink.
		const candidate = `${slug.slice(0, maxSlugLength - suffixText.length)}-${hash}${suffixText}`;
		if (!used.has(candidate)) return candidate;
	}
}

export function adoptionNamespace(id: string): string {
	if (!ID_RE.test(id)) throw new AdoptionValidationError("Adoption id is unsafe");
	return `adopt_${id}`;
}

/** Creates the only record shape callers may persist. The server may first realpath a skills directory. */
export function createAdoptedExtension(input: {
	kind: AdoptionKind;
	scope: AdoptionScope;
	projectId?: string;
	source: unknown;
	now?: Date;
}, occupiedIds: Iterable<string> = []): AdoptedExtension {
	if (!KINDS.has(input.kind) || !SCOPES.has(input.scope)) throw new AdoptionValidationError("Invalid adoption kind or scope");
	if ((input.scope === "project") !== validProjectId(input.projectId)) {
		throw new AdoptionValidationError("Project scope requires a project id");
	}
	const source = normalizeAdoptionSource(input.kind, input.source);
	const publicIdentity = adoptionPublicIdentity(input.scope, input.kind, input.projectId, source);
	const id = generateAdoptionId(publicIdentity, source, occupiedIds);
	const timestamp = (input.now ?? new Date()).toISOString();
	const record: AdoptedExtension = {
		id,
		revision: 1,
		kind: input.kind,
		scope: input.scope,
		namespace: adoptionNamespace(id),
		source,
		enabled: true,
		provenance: {
			class: "adopted",
			sourceType: adoptionSourceType(source),
			sourceLocation: adoptionSourceLocation(source),
			createdAt: timestamp,
			updatedAt: timestamp,
		},
		conformance: { state: "pending", failures: [] },
	};
	if (input.scope === "project") record.projectId = input.projectId;
	if (input.kind === "mcp") record.operations = [];
	return record;
}

/** Finds a canonical duplicate before an API allocates a second id. */
export function findAdoptedExtensionByIdentity(records: Iterable<AdoptedExtension>, input: { scope: AdoptionScope; kind: AdoptionKind; projectId?: string; source: unknown }): AdoptedExtension | undefined {
	const source = normalizeAdoptionSource(input.kind, input.source);
	const identity = adoptionIdentity(input.scope, input.kind, input.projectId, source);
	return [...records].find(record => adoptionIdentity(record.scope, record.kind, record.projectId, record.source) === identity);
}

/** Idempotent create primitive for the Market route: an equal canonical identity wins over id allocation. */
export function findOrCreateAdoptedExtension(records: Iterable<AdoptedExtension>, input: {
	kind: AdoptionKind;
	scope: AdoptionScope;
	projectId?: string;
	source: unknown;
	now?: Date;
}): { record: AdoptedExtension; created: boolean } {
	const existing = [...records];
	const found = findAdoptedExtensionByIdentity(existing, input);
	if (found) return { record: cloneAdoptedExtension(found), created: false };
	return { record: createAdoptedExtension(input, existing.map(record => record.id)), created: true };
}

function normalizeOperation(raw: unknown): AdoptionOperation | undefined {
	if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["name", "classification", "selected", "selection"])) return undefined;
	if (typeof raw.name !== "string" || !OPERATION_NAME_RE.test(raw.name)) return undefined;
	if (!OPERATION_CLASSIFICATIONS.has(raw.classification as AdoptionOperationClassification) || typeof raw.selected !== "boolean") return undefined;
	// Legacy entries predate selection provenance and are conservatively auto.
	if (raw.selection !== undefined && raw.selection !== "auto" && raw.selection !== "explicit") return undefined;
	return { name: raw.name, classification: raw.classification as AdoptionOperationClassification, selected: raw.selected, selection: raw.selection === "explicit" ? "explicit" : "auto" };
}

function normalizeFailures(raw: unknown): AdoptionFailure[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: AdoptionFailure[] = [];
	for (const item of raw) {
		if (!isPlainObject(item) || typeof item.code !== "string" || !FAILURE_CODES.has(item.code as AdoptionFailureCode)) return undefined;
		const code = item.code as AdoptionFailureCode;
		out.push({ code, message: FAILURE_MESSAGES[code] });
	}
	return out;
}

function normalizeRejected(raw: unknown, key: "name" | "path"): Array<{ name?: string; path?: string; reason: string }> | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: Array<{ name?: string; path?: string; reason: string }> = [];
	for (const item of raw) {
		if (!isPlainObject(item) || typeof item.reason !== "string" || !REJECTION_REASONS.has(item.reason)) return undefined;
		const target = item[key];
		if (target !== undefined && (typeof target !== "string" || target.length === 0 || target.length > 256 || target.includes("\0"))) return undefined;
		out.push(target === undefined ? { reason: item.reason } : { [key]: target, reason: item.reason });
	}
	return out;
}

function normalizeNames(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw) || !raw.every(item => typeof item === "string" && item.length > 0 && item.length <= 256 && !item.includes("\0"))) return undefined;
	return [...new Set(raw as string[])];
}

/** Accept only controlled, secret-free conformance output. */
export function normalizeAdoptionConformance(raw: unknown): AdoptionConformance | undefined {
	if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["state", "checkedAt", "mcp", "skills", "failures"])) return undefined;
	if (!CONFORMANCE_STATES.has(raw.state as AdoptionConformanceState)) return undefined;
	if (raw.checkedAt !== undefined && !validTimestamp(raw.checkedAt)) return undefined;
	const failures = normalizeFailures(raw.failures);
	if (!failures) return undefined;
	const out: AdoptionConformance = { state: raw.state as AdoptionConformanceState, failures };
	if (raw.checkedAt) out.checkedAt = raw.checkedAt;
	if (raw.mcp !== undefined) {
		if (!isPlainObject(raw.mcp) || !hasOnlyKeys(raw.mcp, ["requestedProtocol", "negotiatedProtocol", "serverName", "serverVersion", "loadedTools", "rejectedTools"])) return undefined;
		const loadedTools = normalizeNames(raw.mcp.loadedTools);
		const rejectedTools = normalizeRejected(raw.mcp.rejectedTools, "name");
		if (!loadedTools || !rejectedTools) return undefined;
		const mcp: NonNullable<AdoptionConformance["mcp"]> = { loadedTools, rejectedTools: rejectedTools.map(item => ({ name: item.name, reason: item.reason })) };
		for (const key of ["requestedProtocol", "negotiatedProtocol", "serverName", "serverVersion"] as const) {
			if (raw.mcp[key] !== undefined) {
				const value = cleanString(raw.mcp[key]);
				if (!value) return undefined;
				mcp[key] = value;
			}
		}
		out.mcp = mcp;
	}
	if (raw.skills !== undefined) {
		if (!isPlainObject(raw.skills) || !hasOnlyKeys(raw.skills, ["loadedSkills", "rejectedSkills"])) return undefined;
		const loadedSkills = normalizeNames(raw.skills.loadedSkills);
		const rejectedSkills = normalizeRejected(raw.skills.rejectedSkills, "path");
		if (!loadedSkills || !rejectedSkills || rejectedSkills.some(item => !item.path)) return undefined;
		out.skills = { loadedSkills, rejectedSkills: rejectedSkills.map(item => ({ path: item.path!, reason: item.reason })) };
	}
	return out;
}

/** Validate a persisted record; malformed records return undefined, never throw. */
export function normalizeAdoptedExtension(raw: unknown): AdoptedExtension | undefined {
	if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["id", "revision", "kind", "scope", "projectId", "namespace", "source", "enabled", "operations", "provenance", "conformance"])) return undefined;
	if (typeof raw.id !== "string" || !ID_RE.test(raw.id) || !KINDS.has(raw.kind as AdoptionKind) || !SCOPES.has(raw.scope as AdoptionScope) || typeof raw.enabled !== "boolean") return undefined;
	if (raw.revision !== undefined && (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 1)) return undefined;
	const kind = raw.kind as AdoptionKind;
	const scope = raw.scope as AdoptionScope;
	if ((scope === "project") !== validProjectId(raw.projectId)) return undefined;
	if (scope !== "project" && raw.projectId !== undefined) return undefined;
	let source: AdoptionSource;
	try { source = normalizeAdoptionSource(kind, raw.source); } catch { return undefined; }
	const publicIdentity = adoptionPublicIdentity(scope, kind, scope === "project" ? raw.projectId as string : undefined, source);
	const identityHash = crypto.createHash("sha256").update(publicIdentity).digest("hex").slice(0, 12);
	if (!new RegExp(`-${identityHash}(?:-(?:[2-9]|[1-9][0-9]+))?$`).test(raw.id)) return undefined;
	if (typeof raw.namespace !== "string" || raw.namespace !== adoptionNamespace(raw.id)) return undefined;
	if ((kind === "mcp") !== ("transport" in source)) return undefined;
	if (kind === "mcp") {
		if (!Array.isArray(raw.operations)) return undefined;
	} else if (raw.operations !== undefined) return undefined;
	const operations = kind === "mcp" ? (raw.operations as unknown[]).map(normalizeOperation) : undefined;
	if (operations?.some(operation => !operation) || (operations && new Set(operations.map(operation => operation!.name)).size !== operations.length)) return undefined;
	if (!isPlainObject(raw.provenance) || !hasOnlyKeys(raw.provenance, ["class", "sourceType", "sourceLocation", "createdAt", "updatedAt"]) || raw.provenance.class !== "adopted" || !validTimestamp(raw.provenance.createdAt) || !validTimestamp(raw.provenance.updatedAt)) return undefined;
	if (raw.provenance.sourceType !== adoptionSourceType(source) || raw.provenance.sourceLocation !== adoptionSourceLocation(source)) return undefined;
	const conformance = normalizeAdoptionConformance(raw.conformance);
	if (!conformance || (kind === "mcp" && conformance.skills) || (kind === "skills" && conformance.mcp)) return undefined;
	const record: AdoptedExtension = {
		id: raw.id,
		revision: typeof raw.revision === "number" ? raw.revision : 1,
		kind,
		scope,
		namespace: raw.namespace,
		source,
		enabled: raw.enabled,
		provenance: { class: "adopted", sourceType: adoptionSourceType(source), sourceLocation: adoptionSourceLocation(source), createdAt: raw.provenance.createdAt, updatedAt: raw.provenance.updatedAt },
		conformance,
	};
	if (scope === "project") record.projectId = raw.projectId as string;
	if (operations) record.operations = operations as AdoptionOperation[];
	return record;
}

export function cloneAdoptedExtension(record: AdoptedExtension): AdoptedExtension {
	return structuredClone(record);
}

/** Fail closed: an asserted hint is meaningful only when every supplied hint is boolean. */
export function classifyAdoptionMcpHints(annotations: unknown): AdoptionOperationClassification {
	if (!isPlainObject(annotations)) return "unknown";
	const readOnly = annotations.readOnlyHint;
	const destructive = annotations.destructiveHint;
	if ((readOnly !== undefined && typeof readOnly !== "boolean") || (destructive !== undefined && typeof destructive !== "boolean")) return "unknown";
	if (readOnly === true && destructive !== true) return "read-only-hint";
	if (readOnly === false || destructive === true) return "mutation-or-contradictory";
	return "unknown";
}

/** One-time baseline only; later discovery never grants a newly listed operation. */
export function reconcileAdoptionOperations(previous: readonly AdoptionOperation[], tools: Iterable<{ name?: unknown; annotations?: unknown }>, initialBaseline: boolean): AdoptionOperation[] {
	const existing = new Map(previous.map(operation => [operation.name, operation]));
	const seen = new Set<string>();
	const operations: AdoptionOperation[] = [];
	for (const tool of tools) {
		if (typeof tool.name !== "string" || !OPERATION_NAME_RE.test(tool.name) || seen.has(tool.name)) continue;
		seen.add(tool.name);
		const classification = classifyAdoptionMcpHints(tool.annotations);
		const prior = existing.get(tool.name);
		if (!prior) {
			operations.push({ name: tool.name, classification, selected: initialBaseline && classification === "read-only-hint", selection: "auto" });
			continue;
		}
		const selection = prior.selection === "explicit" ? "explicit" : "auto";
		operations.push({
			name: tool.name,
			classification,
			selection,
			// Auto selection is an initial read-only baseline, not a durable grant.
			selected: selection === "explicit" ? prior.selected : classification === "read-only-hint" ? prior.selected : false,
		});
	}
	return operations;
}

export function nextAdoptedExtensionRevision(record: AdoptedExtension): number {
	return record.revision + 1;
}

/** Records in deterministic resolver precedence order, with project isolation. */
export function aggregateAdoptedExtensions(records: AdoptedExtensionsMap, projectId?: string): AdoptedExtension[] {
	const out: AdoptedExtension[] = [];
	for (const scope of ["server", "global-user", "project"] as const) {
		for (const record of Object.values(records[scope] ?? {}).sort((a, b) => a.id.localeCompare(b.id))) {
			if (scope !== "project" || record.projectId === projectId) out.push(cloneAdoptedExtension(record));
		}
	}
	return out;
}

/** Returns a standard MCP contribution; generic MCP normalization remains the transport authority. */
export function adoptedMcpContribution(record: AdoptedExtension): ResolvedMcpContribution | undefined {
	if (record.kind !== "mcp" || !record.enabled) return undefined;
	const source = record.source as AdoptionMcpSource;
	const listName = `adopt-${record.id}`;
	try {
		const normalized = normalizeMcpContribution({
			server: adoptionNamespace(record.id),
			selectedOperations: (record.operations ?? []).filter(operation => operation.selected).map(operation => operation.name),
			transport: source.transport === "stdio"
				? { type: "stdio", command: source.command, ...(source.args?.length ? { args: source.args } : {}) }
				: { type: "http", url: source.url },
		}, { listName, sourceFile: `adopted:${record.id}`, packRoot: process.cwd() });
		return {
			listName: normalized.listName,
			serverName: normalized.serverName,
			// The runtime key reaches client caches, docs, and generated meta extensions;
			// keep it identical to the validated namespace rather than using the scoped
			// contribution identity (which contains filesystem-unsafe colons).
			runtimeServerKey: adoptionNamespace(record.id),
			contributionId: `adopt:${record.scope}:${record.id}`,
			selectedOperations: normalized.selectedOperations,
			config: normalized.config,
			origin: { scope: record.scope, packId: `adopt:${record.id}`, path: record.provenance.sourceLocation },
		};
	} catch {
		// A corrupt persisted record is isolated rather than allowed to break MCP discovery.
		return undefined;
	}
}

export function adoptedMcpContributions(records: Iterable<AdoptedExtension>): ResolvedMcpContribution[] {
	return [...records].sort((a, b) => a.id.localeCompare(b.id)).flatMap(record => {
		const contribution = adoptedMcpContribution(record);
		return contribution ? [contribution] : [];
	});
}

/** Safe wire shape: no command arguments and never any auth-bearing transport fields. */
export function redactAdoptedExtension(record: AdoptedExtension): Omit<AdoptedExtension, "source" | "operations"> & { operations?: Array<Omit<AdoptionOperation, "selection">>; source: { transport: "stdio" | "http"; command?: string; url?: string } | { directory: string } } {
	const source = "directory" in record.source
		? { directory: record.source.directory }
		: record.source.transport === "http"
			? { transport: "http" as const, url: record.source.url! }
			: { transport: "stdio" as const, command: record.source.command! };
	const { source: _privateSource, operations, ...safeRecord } = cloneAdoptedExtension(record);
	return { ...safeRecord, ...(operations ? { operations: operations.map(({ selection: _selection, ...operation }) => operation) } : {}), source };
}
