import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CODE_INTELLIGENCE_LANGUAGE_MATRIX } from "../../lib/language-matrix.ts";
import {
	serializeLspRequest,
	type LspLanguageDeclaration,
	type LspRequestAdapterOptions,
	type LspResult,
	type LspToolAction,
	type LspToolRequest,
} from "../../lib/lsp-request-adapter.ts";

/** Platform-owned linked-worktree context. Without it, this extension is inert. */
export interface LspExtensionOptions {
	adapterOptions?: () => Omit<LspRequestAdapterOptions, "languages">;
	languages?: readonly LspLanguageDeclaration[];
}

function unavailableResult(action: LspToolAction, component: string, languageId?: string): LspResult {
	return {
		capability: "lsp",
		action,
		component,
		...(languageId ? { languageId } : {}),
		status: "unavailable",
		reasonCode: "service-unavailable",
		reason: "The platform LSP adapter is unavailable. Check language-service status and retry.",
	};
}

function declaredLanguageId(params: Record<string, unknown>, languages: readonly LspLanguageDeclaration[]): string | undefined {
	if (typeof params.language !== "string") return undefined;
	const requested = params.language.trim().toLowerCase();
	return languages.find((language) => language.id === requested)?.id;
}

function response(action: LspToolAction, params: Record<string, unknown>, options: LspExtensionOptions): LspResult {
	const languages: readonly LspLanguageDeclaration[] = options.languages ?? CODE_INTELLIGENCE_LANGUAGE_MATRIX;
	const languageId = declaredLanguageId(params, languages);
	let component = "unavailable";
	try {
		const adapterOptions = options.adapterOptions!();
		component = adapterOptions.context.component.name;
		return serializeLspRequest({ action, ...params } as LspToolRequest, { ...adapterOptions, languages }).result;
	} catch {
		// Adapter errors may include paths or credentials; never expose their text.
		return unavailableResult(action, component, languageId);
	}
}

const componentParameter = Type.Optional(Type.String({ maxLength: 160, description: "Optional component name; defaults to this linked-worktree component." }));
const languageParameter = Type.Optional(Type.String({ maxLength: 80, description: "Declared language id. Required when the path cannot identify one unambiguously." }));
const pathParameter = Type.String({ maxLength: 4096, description: "Relative regular source file inside this linked-worktree component." });
const positionParameter = Type.Object({
	line: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
	character: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
}, { description: "Zero-based LSP position." });
const LSP_REVIEW_SNIPPET = "LSP: read-only precise navigation only when ready; read cited source and callers before findings or approval.";
const LSP_REVIEW_GUIDELINES = [
	"LSP is read-only: it never edits files, starts, or installs a language server.",
	"Use LSP for precise navigation only when the returned capability is lsp and status is ready.",
	"An unavailable LSP never falls back to structural search; use grep, read, or ast_grep separately.",
	"Before a finding or approval, use read on every cited definition, reference, source, and caller.",
	"Paths must stay below the linked-worktree component root.",
];

function register(pi: Parameters<ExtensionFactory>[0], name: string, label: string, description: string, action: LspToolAction, parameters: ReturnType<typeof Type.Object>, options: LspExtensionOptions) {
	pi.registerTool({
		name,
		label,
		description,
		promptSnippet: LSP_REVIEW_SNIPPET,
		promptGuidelines: LSP_REVIEW_GUIDELINES,
		parameters,
		async execute(_toolCallId, params) {
			const result = response(action, params as Record<string, unknown>, options);
			return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}

/**
 * Registers bounded read-only LSP contracts. Until the public managed-service
 * worktree seam exists, every validated request reports service-unavailable.
 */
export const createLspExtension = (options: LspExtensionOptions = {}): ExtensionFactory => (pi) => {
	if (!options.adapterOptions) return;
	register(pi, "lsp_definition", "LSP Definition", "Read-only precise definition navigation through an enabled, ready LSP; read cited source before review findings.", "definition", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter, position: positionParameter }), options);
	register(pi, "lsp_references", "LSP References", "Read-only precise reference navigation through an enabled, ready LSP; read cited source and callers before review findings.", "references", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter, position: positionParameter }), options);
	register(pi, "lsp_hover", "LSP Hover", "Read-only precise navigation through an enabled, ready LSP; read cited source before review findings.", "hover", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter, position: positionParameter }), options);
	pi.registerTool({
		name: "lsp_symbols",
		label: "LSP Symbols",
		description: "Read-only precise symbol navigation through an enabled, ready LSP; read cited source before review findings.",
		promptSnippet: LSP_REVIEW_SNIPPET,
		promptGuidelines: [
			...LSP_REVIEW_GUIDELINES,
			"Set scope to document with a path for one file, or workspace with a query for the selected language workspace.",
		],
		parameters: Type.Union([
			Type.Object({ component: componentParameter, language: languageParameter, scope: Type.Literal("document", { description: "List symbols in the specified path." }), path: pathParameter }),
			Type.Object({ component: componentParameter, language: Type.String({ maxLength: 80 }), scope: Type.Literal("workspace", { description: "Search workspace symbols using query." }), query: Type.String({ maxLength: 500 }) }),
		]),
		async execute(_toolCallId, params) {
			const symbolParams = params as Record<string, unknown>;
			const result = response(symbolParams.scope === "workspace" ? "workspaceSymbols" : "documentSymbols", symbolParams, options);
			return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
	register(pi, "lsp_diagnostics", "LSP Diagnostics", "Read-only diagnostics from an enabled, ready LSP; read the cited source before review findings.", "diagnostics", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter }), options);
	register(pi, "lsp_status", "LSP Status", "Read-only LSP readiness; only ready results support precise navigation, then read cited source.", "status", Type.Object({ component: componentParameter, language: Type.String({ maxLength: 80, description: "Declared language id." }) }), options);
};

export default createLspExtension();
