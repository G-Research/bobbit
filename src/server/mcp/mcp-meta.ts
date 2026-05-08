/**
 * Pure helpers for MCP meta-tool aggregation (Track A of mcp-meta-tool-aggregation design).
 *
 * One meta-tool per MCP server (`mcp_<server>`) collapses N×M per-op tools into a
 * single tool surface for the model. Helpers here are protocol-only — execution
 * dispatch and on-disk identifiers (`mcp__<server>__<op>`) are unchanged.
 */
import type { McpToolDef } from "./mcp-types.js";

/** Stable export of the meta-tool name prefix. */
export const MCP_META_PREFIX = "mcp_";

/** Anthropic API tool-name max length. */
const MAX_TOOL_NAME_LEN = 64;

/** Hard cap on meta-tool description length (single short line). */
const MAX_DESCRIPTION_LEN = 150;

/** Sentinel op name surfaced when a server has no usable operations. */
const UNAVAILABLE_OP = "__unavailable__";

/**
 * Result of parsing a Bobbit MCP tool name. Pure structural parse — does not
 * check whether the server is connected or whether the operation exists.
 */
export interface ParsedMcpToolName {
	/** MCP server name (e.g. "gr", "playwright"). */
	server: string;
	/** Sub-namespace if any (e.g. "ai-adoption"). undefined ⇒ flat server. */
	sub?: string;
	/** Operation name (everything after the sub, or after the server if no sub). */
	op: string;
}

/**
 * Single source of truth for parsing canonical Bobbit MCP per-op tool names
 * of the form `mcp__<server>__<rest>`. Strips the `mcp__<server>__` prefix
 * and splits the remainder on the FIRST `__`:
 *
 *   - 0 separators → `{server, op}` (flat server)
 *   - ≥1 separator → `{server, sub: <left>, op: <right-literal-with-remaining-__>}`
 *
 * Returns `null` for any non-MCP name (no leading `mcp__`, missing op, etc.)
 * so callers can short-circuit cleanly.
 *
 * | Input                                  | server   | sub           | op              |
 * |----------------------------------------|----------|---------------|-----------------|
 * | mcp__gr__ai-adoption__list-articles    | gr       | ai-adoption   | list-articles   |
 * | mcp__gr__ai-adoption__create-article   | gr       | ai-adoption   | create-article  |
 * | mcp__gr__jira__get-queue               | gr       | jira          | get-queue       |
 * | mcp__playwright__click                 | playwright | (none)      | click           |
 * | mcp__foo__a__b__c                      | foo      | a             | b__c (literal)  |
 */
export function parseMcpToolName(bobbitName: string): ParsedMcpToolName | null {
	if (typeof bobbitName !== "string") return null;
	if (!bobbitName.startsWith("mcp__")) return null;
	const remainder = bobbitName.slice(5); // after "mcp__"
	const idx = remainder.indexOf("__");
	if (idx <= 0) return null; // no server or no op segment
	const server = remainder.slice(0, idx);
	const after = remainder.slice(idx + 2);
	if (after.length === 0) return null;
	const subIdx = after.indexOf("__");
	if (subIdx === -1) {
		return { server, op: after };
	}
	const sub = after.slice(0, subIdx);
	const op = after.slice(subIdx + 2);
	if (sub.length === 0 || op.length === 0) {
		// Treat malformed like flat to be defensive — fall back to flat.
		return { server, op: after };
	}
	return { server, sub, op };
}

/**
 * Sanitise a server (and optional sub-namespace) into a meta-tool name
 * matching Anthropic API rules (`[a-zA-Z0-9_-]+`, ≤64 chars total).
 *
 * Shapes:
 *   - `makeMetaToolName("playwright")`         → `"mcp_playwright"`
 *   - `makeMetaToolName("gr", "ai-adoption")`   → `"mcp_gr__ai-adoption"`
 *
 * 64-char cap preserves the server segment — when sub is provided and the
 * combined name would overflow, the sub-namespace is truncated first; if
 * even the bare `mcp_<server>` exceeds 64 chars we fall through to the
 * single-arg truncation behaviour.
 *
 * @throws if `serverName` is empty or whitespace-only, or if `sub` is
 *   provided but empty.
 */
export function makeMetaToolName(serverName: string, sub?: string): string {
	if (typeof serverName !== "string" || serverName.trim().length === 0) {
		throw new Error("makeMetaToolName: serverName must be a non-empty string");
	}
	const sanServer = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (sub === undefined) {
		const full = `${MCP_META_PREFIX}${sanServer}`;
		return full.length > MAX_TOOL_NAME_LEN ? full.slice(0, MAX_TOOL_NAME_LEN) : full;
	}
	if (typeof sub !== "string" || sub.trim().length === 0) {
		throw new Error("makeMetaToolName: sub must be a non-empty string when provided");
	}
	const sanSub = sub.replace(/[^a-zA-Z0-9_-]/g, "_");
	const head = `${MCP_META_PREFIX}${sanServer}__`;
	if (head.length >= MAX_TOOL_NAME_LEN) {
		// Server alone already saturates the budget — fall back to flat name.
		const flat = `${MCP_META_PREFIX}${sanServer}`;
		return flat.length > MAX_TOOL_NAME_LEN ? flat.slice(0, MAX_TOOL_NAME_LEN) : flat;
	}
	const budget = MAX_TOOL_NAME_LEN - head.length;
	const subTrunc = sanSub.length > budget ? sanSub.slice(0, budget) : sanSub;
	return head + subTrunc;
}

/**
 * True if a tool def carries a usable JSON Schema:
 *   - `inputSchema.type === "object"`
 *   - `properties` is missing OR a plain object
 *   - non-empty string `name`
 *
 * Logs `[mcp]` warning on rejection so server operators can spot bad servers.
 */
export function isValidOperationSchema(tool: McpToolDef): boolean {
	if (!tool || typeof tool.name !== "string" || tool.name.length === 0) {
		console.warn("[mcp] dropping op with missing/empty name");
		return false;
	}
	const schema = tool.inputSchema;
	if (!schema || typeof schema !== "object") {
		console.warn(`[mcp] dropping op '${tool.name}': inputSchema is not an object`);
		return false;
	}
	if ((schema as { type?: unknown }).type !== "object") {
		console.warn(`[mcp] dropping op '${tool.name}': inputSchema.type !== "object"`);
		return false;
	}
	const props = (schema as { properties?: unknown }).properties;
	if (props !== undefined) {
		if (props === null || typeof props !== "object" || Array.isArray(props)) {
			console.warn(`[mcp] dropping op '${tool.name}': inputSchema.properties is not a plain object`);
			return false;
		}
	}
	return true;
}

/**
 * Build the meta-tool input_schema. `operation` is constrained to an enum of
 * valid op names (preserving input order). `args` is an opaque object —
 * detailed schemas live in the per-server tool-docs file (fetched on demand
 * via `mcp_describe`).
 *
 * If no ops are valid, the enum becomes `["__unavailable__"]` so the model
 * can still see a stub but cannot fabricate a working call.
 */
export function buildMetaToolInputSchema(ops: McpToolDef[]): Record<string, unknown> {
	const valid = (ops ?? []).filter(isValidOperationSchema);
	const opNames = valid.length > 0 ? valid.map(op => op.name) : [UNAVAILABLE_OP];
	return {
		type: "object",
		required: ["operation", "args"],
		properties: {
			operation: { type: "string", enum: opNames },
			args: { type: "object" },
		},
	};
}

/**
 * Build the meta-tool description: a single short line with the server name,
 * operation count, and a pointer at the auto-generated docs file. Op names
 * are NOT inlined — per-op detail lives in the off-wire docs file fetched
 * via `mcp_describe`. Hard-capped at 150 chars.
 */
export function buildMetaToolDescription(
	serverName: string,
	ops: McpToolDef[],
	docsRelPath: string,
): string {
	const valid = (ops ?? []).filter(isValidOperationSchema);
	const n = valid.length;
	const docsRef = docsRelPath ? ` See ${docsRelPath}.` : "";
	const body =
		n === 0 ? "No operations available."
		: n === 1 ? "1 operation."
		: `${n} operations.`;
	const out = `${serverName} MCP server. ${body}${docsRef}`;
	return out.length <= MAX_DESCRIPTION_LEN ? out : out.slice(0, MAX_DESCRIPTION_LEN);
}
