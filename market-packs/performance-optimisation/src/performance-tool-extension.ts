import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { executePerformanceTool, formatPerformanceToolError, PERFORMANCE_TOOL_DEFINITIONS } from "./performance-tools.ts";

function toolResult(value: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		...(isError ? { isError: true } : {}),
		details: value,
	};
}

export function createPerformanceToolExtension(context: { nativeBinding?: string } = {}): ExtensionFactory {
	return (pi) => {
		for (const definition of PERFORMANCE_TOOL_DEFINITIONS) {
			pi.registerTool({
				name: definition.name,
				label: definition.label,
				description: definition.description,
				parameters: Type.Unsafe(definition.parameters),
				async execute(_toolCallId, input) {
					try {
						return toolResult(executePerformanceTool(definition.name, input, context));
					} catch (error) {
						return toolResult(formatPerformanceToolError(error), true);
					}
				},
			});
		}
	};
}

export default createPerformanceToolExtension();
