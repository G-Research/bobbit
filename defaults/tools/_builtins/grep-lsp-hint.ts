/**
 * Heuristic: when a `grep` call looks like a symbol lookup against TS/JS source
 * AND grep returned something, emit a one-line hint nudging the agent toward
 * the equivalent `lsp_*` tool. The hint is prepended to the grep result.
 *
 * Disable via env: `BOBBIT_GREP_LSP_HINT=0`.
 *
 * Pure module — no I/O for hint computation — so it can be unit-tested with
 * synthetic inputs. The wrapper additionally fires a best-effort telemetry
 * ping (`recordHintEmitted`) so the gateway can track adoption; that call
 * is fire-and-forget and never blocks the result.
 */

import { recordHintEmitted } from "../_shared/lsp-telemetry.ts";

export interface GrepLikeParams {
	pattern?: string;
	path?: string;
	glob?: string;
	[key: string]: unknown;
}

export interface GrepLikeContentItem {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

export interface GrepLikeResult {
	content?: GrepLikeContentItem[];
	/**
	 * MCP-style error flag. When true the tool failed and `content` typically
	 * carries the error message rather than grep matches — we must NOT treat
	 * that text as grep output worth annotating with an LSP hint.
	 */
	isError?: boolean;
	[key: string]: unknown;
}

const HINT_PREFIX = "[lsp-hint]";
const MAX_HINT_LEN = 200;

// Match a TS/JS source extension token in a glob, with non-word boundaries on
// both sides so we accept dotted forms (`*.ts`, `**/*.test.ts`) AND brace
// expansions (`*.{ts,tsx}`, `**/*.{ts,tsx,js,jsx,mts,cts}`). A lookaround on
// each side ensures we don't match inside longer identifiers like `json`
// (which contains `js`) or `tsconfig` (which starts with `ts`).
const SOURCE_EXT_RE = /(?<![A-Za-z0-9_])(?:ts|tsx|js|jsx|mts|cts)(?![A-Za-z0-9_])/;

// Identifier with optional declaration prefix and optional escaped call suffix.
// Declaration prefixes are stripped via the alternation in this regex.
const IDENT_BRANCH_RE =
	/^(?:function\s+|const\s+|let\s+|class\s+|interface\s+|type\s+|export\s+function\s+|export\s+async\s+function\s+)?([A-Za-z_$][A-Za-z0-9_$]*)(\\\()?$/;

// Top-level allowed-character guard. The whole pattern (before splitting on
// `|`) must contain only word characters, pipe, parens, backslash, dot,
// dollar, and whitespace (to permit `function foo` style branches). Any
// other character — slash, `*`, `+`, `?`, `[`, `]`, `{`, `}`, etc. — means
// the pattern is doing path or regex work that LSP cannot replace, so we
// must NOT emit a hint even if one branch happens to look symbol-shaped
// (e.g. `foo|bar.*` or `foo|team/teardown`).
const ALLOWED_PATTERN_RE = /^[A-Za-z0-9_|()\\.$\s]+$/;

function isHintDisabled(): boolean {
	return process.env.BOBBIT_GREP_LSP_HINT === "0";
}

/**
 * Parse a grep pattern. Returns the first identifier branch that matches
 * the symbol shape, and whether the pattern used the call-site form `foo\(`.
 * Returns null when no branch is symbol-shaped.
 */
export function parseSymbolPattern(pattern: string): { identifier: string; isCallSite: boolean } | null {
	if (!pattern) return null;
	if (!ALLOWED_PATTERN_RE.test(pattern)) return null;
	const branches = pattern.split("|");
	for (const raw of branches) {
		const branch = raw.trim();
		if (!branch) continue;
		const m = IDENT_BRANCH_RE.exec(branch);
		if (m) {
			return { identifier: m[1], isCallSite: Boolean(m[2]) };
		}
	}
	return null;
}

/**
 * True if the glob (if any) suggests TS/JS source territory.
 *  - no glob → true (default search includes source)
 *  - glob mentions a source ext token, including inside brace expansions
 *    like `*.{ts,tsx}` or `**\/*.{ts,tsx,js,jsx,mts,cts}` → true
 *  - glob only mentions non-source extensions (e.g. `*.md`, `*.{md,txt}`,
 *    `*.json`) → false
 */
export function globIsTsJs(glob: string | undefined): boolean {
	if (!glob) return true;
	return SOURCE_EXT_RE.test(glob);
}

/**
 * True if the grep result has at least one non-empty text item, indicating
 * grep found output worth annotating.
 */
export function resultHasOutput(result: GrepLikeResult | undefined | null): boolean {
	if (!result) return false;
	const content = result.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	for (const item of content) {
		if (!item || item.type !== "text") continue;
		const text = typeof item.text === "string" ? item.text : "";
		if (text.trim().length > 0) return true;
	}
	return false;
}

function buildHint(identifier: string, isCallSite: boolean): string {
	const suggestion = isCallSite
		? `\`lsp_references\` on a use-site of \`${identifier}\``
		: `\`lsp_workspace_symbol("${identifier}")\` or \`lsp_definition\` on a use-site`;
	const msg = `${HINT_PREFIX} Symbol-shaped query — for .ts/.js code, ${suggestion} is faster and authoritative. Grep results follow.`;
	if (msg.length <= MAX_HINT_LEN) return msg;
	// Defensive truncation; should not trigger with normal identifiers.
	return `${msg.slice(0, MAX_HINT_LEN - 1)}…`;
}

/**
 * Wrap a grep-shaped tool definition so that symbol-shaped queries against
 * TS/JS source get a one-line `[lsp-hint]` line prepended to the result.
 *
 * Lives in this module — not `extension.ts` — so unit tests can exercise it
 * without dragging in the pi-coding-agent runtime imports.
 */
export function wrapGrepWithLspHint<T extends { execute: (...args: any[]) => any }>(def: T): T {
	const originalExecute = def.execute.bind(def);
	const wrappedExecute = async (...args: unknown[]): Promise<unknown> => {
		const result: any = await originalExecute(...(args as Parameters<typeof originalExecute>));
		const params = args[1] as GrepLikeParams | undefined;
		const hint = lspHintFor(params, result);
		if (!hint) return result;
		const existingContent = Array.isArray(result?.content) ? result.content : [];
		// Best-effort telemetry: fire-and-forget; failures are swallowed by
		// `recordHintEmitted` itself so they cannot affect the tool result.
		void recordHintEmitted();
		return {
			...result,
			content: [{ type: "text", text: hint }, ...existingContent],
		};
	};
	return { ...def, execute: wrappedExecute as unknown as T["execute"] };
}

/**
 * Compute the LSP hint for a grep call, or null when no hint applies.
 */
export function lspHintFor(params: GrepLikeParams | undefined | null, result: GrepLikeResult | undefined | null): string | null {
	if (isHintDisabled()) return null;
	if (!params || typeof params.pattern !== "string") return null;
	const parsed = parseSymbolPattern(params.pattern);
	if (!parsed) return null;
	if (!globIsTsJs(params.glob)) return null;
	// Suppress hints when the tool surfaced an error result. The `content`
	// array on an error result is the error message, not grep matches —
	// prepending an `[lsp-hint]` line would be misleading noise.
	if (result && (result as GrepLikeResult).isError === true) return null;
	if (!resultHasOutput(result)) return null;
	return buildHint(parsed.identifier, parsed.isCallSite);
}
