import type { GrantPolicy } from "./role-store.js";
import { parseContributions, type ToolContributions } from "./tool-contributions.js";

export interface ToolProvider {
	type: "builtin" | "bobbit-extension" | "mcp" | "pi-extension";
	tool?: string;
	extension?: string;
	server?: string;
	mcpTool?: string;
	providerKey?: string;
}

/** Full parsed YAML definition retained only inside the server runtime. */
export interface ToolRuntimeDefinition {
	name: string;
	description: string;
	summary?: string;
	group: string;
	renderer?: string;
	docs?: string;
	detail_docs?: string;
	provider?: ToolProvider;
	grantPolicy?: GrantPolicy;
	params?: string[];
	groupDir: string;
	filePath: string;
	baseDir: string;
	contributions: ToolContributions;
}

/**
 * Symbol metadata survives in-process resolver projections and object spreads,
 * while remaining absent from JSON/API output (including absolute source paths).
 */
export const TOOL_RUNTIME_DEFINITION = Symbol("bobbit.tool-runtime-definition");

export interface ToolWithRuntimeDefinition {
	[TOOL_RUNTIME_DEFINITION]?: ToolRuntimeDefinition;
}

function parseParams(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const params = value
		.filter((candidate): candidate is string => typeof candidate === "string")
		.map((candidate) => candidate.trim())
		.filter(Boolean);
	return params.length > 0 ? params : undefined;
}

export function toolRuntimeDefinitionFromData(
	data: Record<string, unknown>,
	fallbackGroup: string,
	groupDir: string,
	baseDir: string,
	filePath: string,
): ToolRuntimeDefinition {
	return {
		name: data.name as string,
		description: typeof data.description === "string" ? data.description : "",
		summary: typeof data.summary === "string" ? data.summary : undefined,
		group: typeof data.group === "string" ? data.group : fallbackGroup,
		renderer: typeof data.renderer === "string" ? data.renderer : undefined,
		docs: typeof data.docs === "string" ? data.docs : undefined,
		detail_docs: typeof data.detail_docs === "string" ? data.detail_docs : undefined,
		provider: data.provider && typeof data.provider === "object"
			? data.provider as ToolProvider
			: undefined,
		grantPolicy: typeof data.grantPolicy === "string" ? data.grantPolicy as GrantPolicy : undefined,
		params: parseParams(data.params),
		groupDir,
		filePath,
		baseDir,
		contributions: parseContributions(data, filePath),
	};
}

export function attachToolRuntimeDefinition<T extends object>(
	tool: T,
	definition: ToolRuntimeDefinition,
): T & ToolWithRuntimeDefinition {
	Object.defineProperty(tool, TOOL_RUNTIME_DEFINITION, {
		value: definition,
		enumerable: true,
		configurable: false,
		writable: false,
	});
	return tool as T & ToolWithRuntimeDefinition;
}

export function getToolRuntimeDefinition(tool: unknown): ToolRuntimeDefinition | undefined {
	return tool && typeof tool === "object"
		? (tool as ToolWithRuntimeDefinition)[TOOL_RUNTIME_DEFINITION]
		: undefined;
}
