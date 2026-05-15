/**
 * LSP symbol-lookup hint injected into every agent's system prompt when
 * `lsp_*` tools are active.  Produced once at module load — static string,
 * zero per-session cost.
 *
 * Why: agents that have the seven `lsp_*` tools registered but whose
 * project AGENTS.md contains no LSP guidance still reach for `grep` for
 * symbol lookups.  The hint below nudges them to the correct tool class
 * without duplicating the per-tool descriptions they already receive.
 */

/** Marker text used by tests to assert presence/absence of the hint. */
export const LSP_HINT_MARKER = "## Symbol-lookup hint";

/** Static hint paragraph appended to the system prompt. */
export const LSP_SYMBOL_LOOKUP_HINT = `## Symbol-lookup hint

For source-code queries about symbols (functions, classes, types, variables) — prefer the \`lsp_*\` tools over \`grep\`/\`rg\`/\`read\`/shell text search:

- "Where is X defined?" → \`lsp_workspace_symbol("X")\` or \`lsp_definition(...)\` on a use-site.
- "What calls X?" → \`lsp_references(file, line, char)\`.
- "What's X's type/signature?" → \`lsp_hover(file, line, char)\`.
- "Is this file clean?" → \`lsp_diagnostics(file)\` (faster than \`npm run check\`).
- "What's in this file?" → \`lsp_document_symbols(file)\` (outline tree).

Fall back to text search (\`grep\`, \`rg\`, \`git grep\`, etc.) for free-text matching, comments, config files, or non-source content. Line/character args are 0-indexed (\`read.offset\` is 1-indexed — be careful).`;

/**
 * Return the LSP symbol-lookup hint when the session's allowed-tools list
 * contains at least one `lsp_*` tool, and LSP is not explicitly disabled.
 *
 * @param allowedTools  Tool names for this session (undefined = unrestricted).
 * @param lspDisabled   Whether the project has `lsp_disabled: true` set.
 *                      When true, lsp_* tools return `lsp_unavailable` at
 *                      runtime so the hint would be misleading — suppress it.
 */
export function buildLspSymbolLookupHint(
	allowedTools: string[] | undefined,
	lspDisabled = false,
): string | undefined {
	// Never inject when the operator has explicitly disabled LSP for the project.
	if (lspDisabled) return undefined;

	if (allowedTools && allowedTools.some(t => t.startsWith("lsp_"))) {
		return LSP_SYMBOL_LOOKUP_HINT;
	}
	// No allowedTools restriction means all tools are active (team-lead, general
	// sessions).  We inject the hint unconditionally in that case too — the
	// hint is harmless for non-coders and correctly fires when lsp_* are
	// available but allowedTools is omitted.
	if (!allowedTools) {
		return LSP_SYMBOL_LOOKUP_HINT;
	}
	return undefined;
}
