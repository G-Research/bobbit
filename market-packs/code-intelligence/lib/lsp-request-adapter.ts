import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The read-only actions declared by a language's LSP matrix entry. */
export const LSP_ACTIONS = [
	"definition", "references", "hover", "documentSymbols", "workspaceSymbols", "diagnostics",
] as const;
export type LspAction = (typeof LSP_ACTIONS)[number];
/** Status is a read-only tool action, but is not a server capability declaration. */
export type LspToolAction = LspAction | "status";

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspComponent {
	name: string;
	repo: string;
	relativePath?: string;
}

export interface LspToolchainRequirement {
	id: string;
	label: string;
	installHint: string;
	version?: { range: string; reason: string };
}

export interface LspLanguageDeclaration {
	id: string;
	label: string;
	evidence: { globs: readonly string[] };
	lsp?: {
		server: { id: string; command: string; args: readonly string[] };
		actions: readonly LspAction[];
		host: readonly LspToolchainRequirement[];
		sandbox: readonly (LspToolchainRequirement & { layerId: string })[];
	};
}

export interface LspRequestContext {
	projectId?: string;
	component: LspComponent;
	/** Canonical linked-worktree component root, supplied by the platform context. */
	componentRoot: string;
}

/** A future platform service may supply this read-only snapshot. It is never persisted or probed here. */
export interface LspRuntimeSnapshot {
	enabled?: boolean;
	toolchain?: "available" | "missing";
	/** The runtime whose matrix requirements were checked by the platform. */
	runtime?: "host" | "sandbox";
	/** Matrix requirement IDs validated missing by the platform in the selected runtime. */
	missingToolchainIds?: readonly string[];
	service?: "ready" | "starting" | "failed" | "stopped";
	reason?: string;
}

export type LspResultStatus = "ready" | "disabled" | "requires-toolchain" | "starting" | "unavailable" | "failed";
export type LspReasonCode =
	| "invalid-request"
	| "component-unavailable"
	| "invalid-path"
	| "unsupported-language"
	| "unsupported-action"
	| "disabled"
	| "requires-toolchain"
	| "service-starting"
	| "service-unavailable"
	| "service-failed";

export interface LspResult<T = undefined> {
	capability: "lsp";
	action: LspToolAction;
	component: string;
	languageId?: string;
	status: LspResultStatus;
	reason?: string;
	reasonCode?: LspReasonCode;
	result?: T;
}

export interface LspServiceRequest {
	key: {
		projectId?: string;
		component: LspComponent;
		worktreePath: string;
		languageId: string;
	};
	language: {
		id: string;
		server: { id: string; command: string; args: readonly string[] };
		actions: readonly LspAction[];
	};
	action: LspAction;
	uri?: string;
	position?: LspPosition;
	query?: string;
}

export interface LspToolRequest {
	action: LspToolAction;
	component?: string;
	language?: string;
	path?: string;
	position?: LspPosition;
	query?: string;
}

export interface LspRequestAdapterOptions {
	context: LspRequestContext;
	languages: readonly LspLanguageDeclaration[];
	runtime?: LspRuntimeSnapshot;
	fs?: Pick<typeof fs, "lstatSync" | "realpathSync">;
}

export interface LspRequestPreparation {
	result: LspResult;
	/** Present only after static validation. This adapter never submits or starts it. */
	request?: LspServiceRequest;
}

const MAX_PATH_LENGTH = 4_096;
const MAX_QUERY_LENGTH = 500;
const MAX_REASON_LENGTH = 240;

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function boundedReason(reason: unknown, fallback: string): string {
	const text = typeof reason === "string" ? reason.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim() : "";
	return redactRuntimeDetails(text || fallback).slice(0, MAX_REASON_LENGTH);
}

function redactRuntimeDetails(text: string): string {
	// Runtime output is untrusted. Keep the surrounding operator message, but
	// remove credentials before paths so a bearer value cannot survive a path match.
	const withoutSecrets = text
		.replace(/\b(?:proxy-)?authorization\s*[=:]\s*(?:bearer|basic|token)\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "authorization=[redacted]")
		.replace(/\bbearer\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "bearer [redacted]")
		.replace(/\b(token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]");
	// Windows drive paths and UNC paths can contain spaces. Stop at a known
	// delimiter or a structured credential field; otherwise prefer redacting the
	// remainder over risking a topology leak.
	const withoutWindowsPaths = withoutSecrets.replace(
		/(^|[\s("'`])(?:[A-Za-z]:[\\/]|\\\\)[^<>:"|?*]*?(?=\s+(?:token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|credential|authorization)\b\s*[=:]|[,:;]|$)/gi,
		"$1[redacted path]",
	);
	// Unix paths with a spaced directory retain text following the path unless it
	// is clearly another path segment. This preserves safe structured reasons.
	return withoutWindowsPaths.replace(
		/(^|[\s("'`])\/(?:[^/\s:]+\/)+[^\s:]+(?:\s+[^/\s:]+\/[^:;,]*)?/g,
		"$1[redacted path]",
	);
}

function normalizeRequirementId(value: string): string {
	return value.trim().toLowerCase();
}

function missingToolchainGuidance(language: NonNullable<LspLanguageDeclaration["lsp"]>, runtime: LspRuntimeSnapshot): string {
	if ((runtime.runtime !== "host" && runtime.runtime !== "sandbox") || !Array.isArray(runtime.missingToolchainIds)) {
		return "The LSP toolchain is unavailable, but the platform did not report validated missing requirement IDs and runtime.";
	}
	const reportedIds = new Set(runtime.missingToolchainIds
		.filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
		.map(normalizeRequirementId));
	if (runtime.runtime === "host") {
		const missing = language.host.filter((requirement) => reportedIds.has(normalizeRequirementId(requirement.id)));
		if (missing.length === 0) {
			return "The host LSP toolchain is unavailable, but no reported missing ID matches a matrix-declared requirement.";
		}
		return `The host runtime is missing host requirement IDs: ${missing.map((requirement) => requirement.id).join(", ")}. ${missing.map((requirement) => requirement.installHint).join(" ")}`;
	}
	const missing = language.sandbox.filter((requirement) => reportedIds.has(normalizeRequirementId(requirement.id)));
	if (missing.length === 0) {
		return "The sandbox LSP toolchain is unavailable, but no reported missing ID matches a matrix-declared requirement.";
	}
	return `The sandbox runtime is missing sandbox requirement IDs: ${missing.map((requirement) => `${requirement.id} (layer ${requirement.layerId})`).join(", ")}. ${missing.map((requirement) => requirement.installHint).join(" ")}`;
}

function result(action: LspToolAction, component: string, status: LspResultStatus, reasonCode: LspReasonCode, reason: string, languageId?: string): LspResult {
	return { capability: "lsp", action, component, ...(languageId ? { languageId } : {}), status, reasonCode, reason: boundedReason(reason, "LSP is unavailable.") };
}

function validPosition(position: unknown): position is LspPosition {
	return Boolean(position)
		&& typeof position === "object"
		&& Number.isSafeInteger((position as LspPosition).line)
		&& Number.isSafeInteger((position as LspPosition).character)
		&& (position as LspPosition).line >= 0
		&& (position as LspPosition).character >= 0
		&& (position as LspPosition).line <= 1_000_000
		&& (position as LspPosition).character <= 1_000_000;
}

function requiresDocument(action: LspToolAction): boolean {
	return action !== "workspaceSymbols" && action !== "status";
}

function requiresPosition(action: LspToolAction): boolean {
	return action === "definition" || action === "references" || action === "hover";
}

function extensionCandidates(file: string, languages: readonly LspLanguageDeclaration[]): LspLanguageDeclaration[] {
	const extension = path.extname(file).toLowerCase();
	return languages.filter((language) => language.evidence.globs.some((glob) => path.extname(glob).toLowerCase() === extension));
}

function resolveLanguage(input: LspToolRequest, languages: readonly LspLanguageDeclaration[]): LspLanguageDeclaration | undefined {
	const requestedLanguage = typeof input.language === "string" ? input.language.trim() : "";
	if (requestedLanguage) {
		return languages.find((language) => language.id === requestedLanguage.toLowerCase());
	}
	if (!input.path) return undefined;
	const candidates = extensionCandidates(input.path, languages);
	return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Validates and serializes a prospective EP-8 request. This is intentionally
 * pure with respect to process, settings, grants, decisions, and sandbox state:
 * callers must hand it platform-owned context and an optional read-only status.
 */
export function serializeLspRequest(input: LspToolRequest, options: LspRequestAdapterOptions): LspRequestPreparation {
	const action = input.action;
	if (input.component !== undefined && (typeof input.component !== "string" || !input.component.trim() || input.component.length > 160)) {
		return { result: result(action, options.context.component.name, "unavailable", "invalid-request", "component must be a non-empty component name.") };
	}
	if (input.language !== undefined && (typeof input.language !== "string" || !input.language.trim() || input.language.length > 80)) {
		return { result: result(action, typeof input.component === "string" && input.component.trim() ? input.component.trim() : options.context.component.name, "unavailable", "invalid-request", "language must be a declared language id.") };
	}
	const componentName = typeof input.component === "string" ? input.component.trim() : options.context.component.name;
	if (action !== "status" && !(LSP_ACTIONS as readonly string[]).includes(action)) {
		return { result: result("status", componentName, "unavailable", "invalid-request", "The requested LSP action is invalid.") };
	}
	if (componentName !== options.context.component.name) {
		return { result: result(action, componentName, "unavailable", "component-unavailable", "The requested component is not available in this linked worktree.") };
	}
	// Canonicalize the linked component root once, including for status and
	// workspace-wide actions. A removed worktree has no safe service identity.
	const fileSystem = options.fs ?? fs;
	let root: string;
	try {
		root = fileSystem.realpathSync(options.context.componentRoot);
		if (!fileSystem.lstatSync(root).isDirectory()) throw new Error("component root is not a directory");
	} catch {
		return { result: result(action, componentName, "unavailable", "component-unavailable", "The linked-worktree component is unavailable.") };
	}

	const language = resolveLanguage(input, options.languages);
	if (!language) {
		const reason = input.language
			? "The requested language is not declared by this project’s language matrix."
			: "Specify a declared language when it cannot be determined unambiguously from the path.";
		return { result: result(action, componentName, "unavailable", "unsupported-language", reason, typeof input.language === "string" ? input.language.trim().toLowerCase() : undefined) };
	}
	const lsp = language.lsp;
	if (!lsp) {
		return { result: result(action, componentName, "unavailable", "unsupported-language", `${language.label} has no declared LSP capability.`, language.id) };
	}
	if (action !== "status" && !lsp.actions.includes(action)) {
		return { result: result(action, componentName, "unavailable", "unsupported-action", `${language.label} does not declare LSP ${action}.`, language.id) };
	}

	let uri: string | undefined;
	if (requiresDocument(action)) {
		if (typeof input.path !== "string" || !input.path.trim() || input.path.length > MAX_PATH_LENGTH || input.path.includes("\0") || path.isAbsolute(input.path) || input.path.split(/[\\/]+/).includes("..")) {
			return { result: result(action, componentName, "unavailable", "invalid-path", "path must be a non-empty relative file path inside the linked component root.", language.id) };
		}
		try {
			const candidate = path.resolve(root, input.path);
			const stat = fileSystem.lstatSync(candidate);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
			const canonical = fileSystem.realpathSync(candidate);
			if (!isInside(root, canonical)) throw new Error("outside root");
			uri = pathToFileURL(canonical).href;
		} catch {
			return { result: result(action, componentName, "unavailable", "invalid-path", "path must name a readable, non-symlink file inside the linked component root.", language.id) };
		}
	}
	let position: LspPosition | undefined;
	if (requiresPosition(action)) {
		if (!validPosition(input.position)) {
			return { result: result(action, componentName, "unavailable", "invalid-request", "position must contain non-negative integer line and character values.", language.id) };
		}
		position = input.position;
	}
	if (action === "workspaceSymbols" && (typeof input.query !== "string" || input.query.length > MAX_QUERY_LENGTH)) {
		return { result: result(action, componentName, "unavailable", "invalid-request", `query must be a string of at most ${MAX_QUERY_LENGTH} characters.`, language.id) };
	}

	const request: LspServiceRequest | undefined = action === "status" ? undefined : {
		key: { projectId: options.context.projectId, component: options.context.component, worktreePath: root, languageId: language.id },
		language: { id: language.id, server: lsp.server, actions: lsp.actions },
		action,
		...(uri ? { uri } : {}),
		...(position ? { position } : {}),
		...(action === "workspaceSymbols" ? { query: input.query } : {}),
	};

	const runtime = options.runtime;
	if (runtime?.enabled === false) {
		return { result: result(action, componentName, "disabled", "disabled", "LSP is disabled for this language. Enable it through the project language settings.", language.id), request };
	}
	if (runtime?.toolchain === "missing") {
		return { result: result(action, componentName, "requires-toolchain", "requires-toolchain", missingToolchainGuidance(lsp, runtime), language.id), request };
	}
	if (runtime?.service === "failed") {
		return { result: result(action, componentName, "failed", "service-failed", boundedReason(runtime.reason, `${lsp.server.id} failed to initialize.`), language.id), request };
	}
	if (runtime?.service === "starting") {
		return { result: result(action, componentName, "starting", "service-starting", "The language service is starting; retry shortly.", language.id), request };
	}

	// The required public worktree-instance service seam has not been adopted.
	// Do not start a process, probe a toolchain, or create a private lifecycle here.
	return { result: result(action, componentName, "unavailable", "service-unavailable", "The managed per-worktree LSP service is unavailable. No language server was started.", language.id), request };
}

/** Exported for status surfaces that need the same bounded, non-sensitive wording. */
export function sanitizeLspReason(reason: unknown, fallback = "LSP is unavailable."): string {
	return boundedReason(reason, fallback);
}
