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
	// Service output must already be sanitized by the platform. Preserve a short
	// operator reason while defensively removing common topology and secret forms.
	return (text || fallback)
		.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:]+/g, "[redacted path]")
		.replace(/\b(token|secret|password|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
		.slice(0, MAX_REASON_LENGTH);
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
	if (typeof input.language === "string" && input.language.trim()) {
		return languages.find((language) => language.id === input.language.trim().toLowerCase());
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
	const language = resolveLanguage(input, options.languages);
	if (!language) {
		const reason = input.language
			? "The requested language is not declared by this project’s language matrix."
			: "Specify a declared language when it cannot be determined unambiguously from the path.";
		return { result: result(action, componentName, "unavailable", "unsupported-language", reason, typeof input.language === "string" ? input.language.trim().toLowerCase() : undefined) };
	}
	if (!language.lsp) {
		return { result: result(action, componentName, "unavailable", "unsupported-language", `${language.label} has no declared LSP capability.`, language.id) };
	}
	if (action !== "status" && !language.lsp.actions.includes(action)) {
		return { result: result(action, componentName, "unavailable", "unsupported-action", `${language.label} does not declare LSP ${action}.`, language.id) };
	}

	let uri: string | undefined;
	if (requiresDocument(action)) {
		if (typeof input.path !== "string" || !input.path.trim() || input.path.length > MAX_PATH_LENGTH || input.path.includes("\0") || path.isAbsolute(input.path) || input.path.split(/[\\/]+/).includes("..")) {
			return { result: result(action, componentName, "unavailable", "invalid-path", "path must be a non-empty relative file path inside the linked component root.", language.id) };
		}
		try {
			const root = (options.fs ?? fs).realpathSync(options.context.componentRoot);
			const candidate = path.resolve(root, input.path);
			const stat = (options.fs ?? fs).lstatSync(candidate);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
			const canonical = (options.fs ?? fs).realpathSync(candidate);
			if (!isInside(root, canonical)) throw new Error("outside root");
			uri = pathToFileURL(canonical).href;
		} catch {
			return { result: result(action, componentName, "unavailable", "invalid-path", "path must name a readable, non-symlink file inside the linked component root.", language.id) };
		}
	}
	if (requiresPosition(action) && !validPosition(input.position)) {
		return { result: result(action, componentName, "unavailable", "invalid-request", "position must contain non-negative integer line and character values.", language.id) };
	}
	if (action === "workspaceSymbols" && (typeof input.query !== "string" || input.query.length > MAX_QUERY_LENGTH)) {
		return { result: result(action, componentName, "unavailable", "invalid-request", `query must be a string of at most ${MAX_QUERY_LENGTH} characters.`, language.id) };
	}

	const request: LspServiceRequest | undefined = action === "status" ? undefined : {
		key: { projectId: options.context.projectId, component: options.context.component, worktreePath: (options.fs ?? fs).realpathSync(options.context.componentRoot), languageId: language.id },
		language: { id: language.id, server: language.lsp.server, actions: language.lsp.actions },
		action,
		...(uri ? { uri } : {}),
		...(input.position ? { position: input.position } : {}),
		...(action === "workspaceSymbols" ? { query: input.query } : {}),
	};

	const runtime = options.runtime;
	if (runtime?.enabled === false) {
		return { result: result(action, componentName, "disabled", "disabled", "LSP is disabled for this language. Enable it through the project language settings.", language.id), request };
	}
	if (runtime?.toolchain === "missing") {
		const requirement = language.lsp.host[0] ?? language.lsp.sandbox[0];
		const guidance = requirement ? `${requirement.label} is required. ${requirement.installHint}` : "The matrix-declared LSP toolchain is unavailable.";
		return { result: result(action, componentName, "requires-toolchain", "requires-toolchain", guidance, language.id), request };
	}
	if (runtime?.service === "failed") {
		return { result: result(action, componentName, "failed", "service-failed", boundedReason(runtime.reason, `${language.lsp.server.id} failed to initialize.`), language.id), request };
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
