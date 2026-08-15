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

function register(pi: Parameters<ExtensionFactory>[0], name: string, label: string, description: string, action: LspToolAction, parameters: ReturnType<typeof Type.Object>, options: LspExtensionOptions) {
	pi.registerTool({
		name,
		label,
		description,
		promptSnippet: "Read-only LSP query. It never edits files, starts, or installs a language server.",
		promptGuidelines: [
			"Use LSP results only when the returned capability is lsp and status is ready.",
			"An unavailable LSP never falls back to structural search; use grep, read, or ast_grep separately.",
			"Paths must stay below the linked-worktree component root.",
		],
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
	register(pi, "lsp_definition", "LSP Definition", "Find a definition through an enabled language service.", "definition", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter, position: positionParameter }), options);
	register(pi, "lsp_references", "LSP References", "Find references through an enabled language service.", "references", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter, position: positionParameter }), options);
	register(pi, "lsp_hover", "LSP Hover", "Read hover information through an enabled language service.", "hover", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter, position: positionParameter }), options);
	pi.registerTool({
		name: "lsp_symbols",
		label: "LSP Symbols",
		description: "List document or workspace symbols through an enabled language service.",
		promptSnippet: "Read-only LSP symbol query. It never edits files, starts, or installs a language server.",
		promptGuidelines: ["Set scope to document with a path for one file, or workspace with a query for the selected language workspace."],
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
	register(pi, "lsp_diagnostics", "LSP Diagnostics", "Read the last published diagnostics for one file; it never invents a clean result.", "diagnostics", Type.Object({ component: componentParameter, language: languageParameter, path: pathParameter }), options);
	register(pi, "lsp_status", "LSP Status", "Report the truthful language-service status for this component and language.", "status", Type.Object({ component: componentParameter, language: Type.String({ maxLength: 80, description: "Declared language id." }) }), options);
};

export default createLspExtension();
