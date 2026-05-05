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

/** Cap meta-tool description size to keep per-server context overhead tiny. */
const MAX_DESCRIPTION_LEN = 400;

/** Sentinel op name surfaced when a server has no usable operations. */
const UNAVAILABLE_OP = "__unavailable__";

/**
 * Sanitise a server name into a meta-tool name matching Anthropic API rules
 * (`[a-zA-Z0-9_-]+`, ≤64 chars total). Replaces invalid chars with `_` and
 * truncates to 64 chars including the `mcp_` prefix.
 *
 * @throws if `serverName` is empty or whitespace-only.
 */
export function makeMetaToolName(serverName: string): string {
	if (typeof serverName !== "string" || serverName.trim().length === 0) {
		throw new Error("makeMetaToolName: serverName must be a non-empty string");
	}
	const sanitised = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
	const full = `${MCP_META_PREFIX}${sanitised}`;
	return full.length > MAX_TOOL_NAME_LEN ? full.slice(0, MAX_TOOL_NAME_LEN) : full;
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
 * Build the ~80-token meta-tool description: server label, comma-separated op
 * names, plus a pointer at the auto-generated docs file. Capped at ~400 chars;
 * overflow trims the op list and appends `... (N more)`.
 */
export function buildMetaToolDescription(
	serverName: string,
	ops: McpToolDef[],
	docsRelPath: string,
): string {
	const valid = (ops ?? []).filter(isValidOperationSchema);
	const head = `${serverName} MCP server. Operations: `;
	const tail = `. See ${docsRelPath} for full schemas.`;
	const opNames = valid.map(op => op.name);

	if (opNames.length === 0) {
		return `${serverName} MCP server. No operations available.${tail}`.slice(0, MAX_DESCRIPTION_LEN);
	}

	// Try the full list first.
	const full = `${head}${opNames.join(", ")}${tail}`;
	if (full.length <= MAX_DESCRIPTION_LEN) return full;

	// Trim from the end — find the largest N such that head + first-N + ", ... (M more)" + tail fits.
	for (let n = opNames.length - 1; n >= 1; n--) {
		const more = opNames.length - n;
		const candidate = `${head}${opNames.slice(0, n).join(", ")}, ... (${more} more)${tail}`;
		if (candidate.length <= MAX_DESCRIPTION_LEN) return candidate;
	}

	// Fallback: even one op blows the budget — emit minimum and hard-truncate.
	const minimum = `${head}... (${opNames.length} more)${tail}`;
	return minimum.length <= MAX_DESCRIPTION_LEN ? minimum : minimum.slice(0, MAX_DESCRIPTION_LEN);
}
