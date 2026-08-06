/**
 * Core-owned markers embedded in system prompts. Extension-authored content
 * must never contain these namespaces: doing so could forge attribution or
 * create a dynamic-context tail that the provider bridge later strips.
 */
export const EXTENSION_PROMPT_REGION_START = "<!-- bobbit:extension-prompt-region:start -->";
export const EXTENSION_PROMPT_REGION_END = "<!-- bobbit:extension-prompt-region:end -->";
export const EXTENSION_PROMPT_SECTION_START = "<!-- bobbit:extension-prompt-section:start";
export const EXTENSION_PROMPT_SECTION_END = "<!-- bobbit:extension-prompt-section:end";
export const DYNAMIC_CONTEXT_START = "<!-- bobbit:dynamic-context:start -->";
export const DYNAMIC_CONTEXT_END = "<!-- bobbit:dynamic-context:end -->";

/** Escape dynamic identifiers before putting them in a core-owned HTML comment. */
function delimiterAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r?\n/g, " ")
		.replace(/"/g, "&quot;");
}

export function extensionPromptSectionStart(packId: string, sectionId: string): string {
	return `<!-- bobbit:extension-prompt-section:start pack="${delimiterAttribute(packId)}" section="${delimiterAttribute(sectionId)}" -->`;
}

export function extensionPromptSectionEnd(packId: string, sectionId: string): string {
	return `<!-- bobbit:extension-prompt-section:end pack="${delimiterAttribute(packId)}" section="${delimiterAttribute(sectionId)}" -->`;
}

/**
 * Validation tokens deliberately reserve the complete extension namespaces so
 * malformed variants cannot forge a core wrapper. Dynamic-context markers have
 * no attributes, so their exact start and end tokens are sufficient; either one
 * alone is rejected.
 */
export const CORE_PROMPT_RESERVED_DELIMITER_TOKENS = [
	"<!-- bobbit:extension-prompt-region:",
	"<!-- bobbit:extension-prompt-section:",
	DYNAMIC_CONTEXT_START,
	DYNAMIC_CONTEXT_END,
] as const;

export function containsReservedCorePromptDelimiter(content: string): boolean {
	return CORE_PROMPT_RESERVED_DELIMITER_TOKENS.some((token) => content.includes(token));
}
