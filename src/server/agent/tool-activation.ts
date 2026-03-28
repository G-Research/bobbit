/**
 * Maps role allowedTools to pi-coding-agent CLI flags.
 *
 * Tools come from two sources (defined in .bobbit/config/tools/<group>/*.yaml `provider` field):
 * 1. **Builtin tools** (pi-coding-agent built-in): read, bash, edit, write, grep, find, ls
 *    → Controlled via `--tools` flag
 * 2. **Bobbit extensions** (.bobbit/config/tools/<group>/extension.ts): delegate, browser_*, web_*, task_*, gate_*, team_*, bash_bg
 *    → Resolved from .bobbit/config/tools/<groupDir>/extension.ts, controlled via `--extension` flag
 *    → Goal/team extensions are also added separately by session-manager (duplicates are harmless)
 *
 * Provider info is read from .bobbit/config/tools/<group>/*.yaml via ToolManager instead of hardcoded maps.
 * All sessions use `--no-extensions` so Bobbit has complete control over extension loading.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolManager, ToolProvider } from "./tool-manager.js";
import { TOOLS_DIR } from "./tool-manager.js";
import type { McpManager } from "../mcp/mcp-manager.js";

import { bobbitStateDir } from "../bobbit-dir.js";

export interface ToolActivationResult {
	/** CLI args to add (e.g. ["--tools", "read,bash", "--no-extensions", "--extension", "/path/to/ext"]) */
	args: string[];
}

/**
 * Resolve the absolute path for a bobbit-extension provider.
 * Path is: .bobbit/config/tools/<groupDir>/<extension>
 */
function resolveExtensionPath(provider: ToolProvider & { groupDir: string }): string {
	return path.join(TOOLS_DIR, provider.groupDir, provider.extension!);
}

/** Convert a JSON Schema object to a TypeBox code string. */
export function jsonSchemaToTypeBox(schema: Record<string, unknown>): string {
	if (!schema || typeof schema !== 'object') return 'Type.Any()';

	// Handle enum
	const enumVals = schema.enum as unknown[] | undefined;
	if (enumVals && Array.isArray(enumVals)) {
		const literals = enumVals.map(v => `Type.Literal(${JSON.stringify(v)})`).join(', ');
		return `Type.Union([${literals}])`;
	}

	const type = schema.type as string | undefined;
	switch (type) {
		case 'string': return 'Type.String()';
		case 'number': return 'Type.Number()';
		case 'integer': return 'Type.Number()';
		case 'boolean': return 'Type.Boolean()';
		case 'array': {
			const items = schema.items as Record<string, unknown> | undefined;
			return `Type.Array(${items ? jsonSchemaToTypeBox(items) : 'Type.Any()'})`;
		}
		case 'object': {
			const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
			if (!properties) return 'Type.Any()';
			const required = (schema.required as string[]) || [];
			const entries = Object.entries(properties).map(([key, propSchema]) => {
				const tb = jsonSchemaToTypeBox(propSchema);
				const isRequired = required.includes(key);
				return `${JSON.stringify(key)}: ${isRequired ? tb : `Type.Optional(${tb})`}`;
			});
			return `Type.Object({${entries.join(', ')}})`;
		}
		default: return 'Type.Any()';
	}
}

/**
 * Generate a pi-coding-agent extension that proxies MCP tool calls through the gateway.
 */
export function generateMcpProxyExtension(
	serverName: string,
	tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>,
): string {
	const toolRegistrations = tools.map(tool => {
		const fullName = `mcp__${serverName}__${tool.name}`;
		const schema = jsonSchemaToTypeBox(tool.inputSchema);
		const desc = tool.description ? JSON.stringify(tool.description) : `"MCP tool ${tool.name} from ${serverName}"`;
		return `
  pi.registerTool({
    name: ${JSON.stringify(fullName)},
    description: ${desc},
    parameters: ${schema},
    execute: async (args) => {
      const body = JSON.stringify({ tool: ${JSON.stringify(fullName)}, args });
      const url = new URL(gwUrl + "/api/internal/mcp-call");
      const mod = url.protocol === "https:" ? await import("node:https") : await import("node:http");
      const result = await new Promise((resolve, reject) => {
        const req = mod.request(url, {
          method: "POST",
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
        }, (res) => {
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ content: [{ type: "text", text: data }] }); }
          });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      const r = result;
      if (r && r.content && Array.isArray(r.content)) {
        return r.content.map(c => c.text || "").join("\\n");
      }
      if (r && r.error) return "Error: " + r.error;
      return JSON.stringify(r);
    }
  });`;
	}).join('\n');

	return `import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function(pi) {
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  const gwUrl = fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8").trim();
  const token = fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8").trim();
${toolRegistrations}
}
`;
}

/**
 * Write proxy extension files for all connected MCP servers.
 * Returns array of written file paths.
 */
export function writeMcpProxyExtensions(mcpManager: McpManager): string[] {
	const infos = mcpManager.getToolInfos();

	const extensionPaths: string[] = [];
	const extDir = path.join(bobbitStateDir(), "mcp-extensions");
	fs.mkdirSync(extDir, { recursive: true });

	// Group tool infos by server
	const byServer = new Map<string, typeof infos>();
	for (const info of infos) {
		if (!byServer.has(info.serverName)) byServer.set(info.serverName, []);
		byServer.get(info.serverName)!.push(info);
	}

	for (const [serverName, tools] of byServer) {
		const toolDefs = tools.map(t => ({
			name: t.mcpToolName,
			description: t.description,
			inputSchema: t.inputSchema || { type: "object" as const, properties: {} } as Record<string, unknown>,
		}));
		const code = generateMcpProxyExtension(serverName, toolDefs);
		const filePath = path.join(extDir, `${serverName}.ts`);
		fs.writeFileSync(filePath, code, "utf-8");
		extensionPaths.push(filePath);
	}

	return extensionPaths;
}

/**
 * Given a role's allowedTools list and a ToolManager, compute the CLI args needed
 * to activate exactly those tools.
 *
 * If allowedTools is empty or undefined, all tools are enabled (all builtins + all bobbit extensions).
 * Always adds `--no-extensions` so Bobbit has complete control over extension loading.
 */
export function computeToolActivationArgs(allowedTools?: string[], toolManager?: ToolManager, _cwd?: string, mcpExtensionPaths?: string[]): ToolActivationResult {
	const args: string[] = [];

	if (!toolManager) {
		// Fallback: no tool manager available, can't resolve providers.
		// Enable all base tools and disable extension auto-discovery for safety.
		console.warn("[tool-activation] No ToolManager provided — using fallback (all base tools, no extensions)");
		args.push("--tools", "read,bash,edit,write,grep,find,ls");
		args.push("--no-extensions");
		if (mcpExtensionPaths) {
			for (const extPath of mcpExtensionPaths) {
				args.push("--extension", extPath);
			}
		}
		return { args };
	}

	// Load all providers in a single YAML scan
	const providers = toolManager.getToolProviders();

	// No restrictions — enable all builtins and all bobbit extensions
	if (!allowedTools || allowedTools.length === 0) {
		const builtins: string[] = [];
		const extensionPaths = new Set<string>();

		for (const [, provider] of providers) {
			if (provider.type === "builtin" && provider.tool) {
				// Skip bash — provided by custom bash-tool.ts extension (loaded by rpc-bridge)
				if (provider.tool === "bash") continue;
				builtins.push(provider.tool);
			} else if (provider.type === "bobbit-extension" && provider.extension) {
				extensionPaths.add(resolveExtensionPath(provider));
			}
		}

		if (builtins.length > 0) {
			args.push("--tools", builtins.join(","));
		}
		args.push("--no-extensions");
		for (const extPath of extensionPaths) {
			args.push("--extension", extPath);
		}
		if (mcpExtensionPaths) {
			for (const extPath of mcpExtensionPaths) {
				args.push("--extension", extPath);
			}
		}
		return { args };
	}

	// Restricted set — resolve each allowed tool via its provider
	const activeBaseTools: string[] = [];
	const neededExtensions = new Set<string>();

	for (const toolName of allowedTools) {
		const provider = providers.get(toolName);
		if (!provider) {
			// Unknown tool — log warning and skip
			console.warn(`[tool-activation] Tool "${toolName}" has no provider in .bobbit/config/tools/<group>/*.yaml — skipping`);
			continue;
		}
		if (provider.type === "builtin" && provider.tool) {
			// Skip bash — provided by custom bash-tool.ts extension (loaded by rpc-bridge)
			if (provider.tool !== "bash") activeBaseTools.push(provider.tool);
		} else if (provider.type === "bobbit-extension" && provider.extension) {
			neededExtensions.add(resolveExtensionPath(provider));
		}
	}

	if (activeBaseTools.length > 0) {
		args.push("--tools", activeBaseTools.join(","));
	} else {
		args.push("--no-tools");
	}

	// Always use --no-extensions so Bobbit controls all extension loading
	args.push("--no-extensions");
	for (const extPath of neededExtensions) {
		args.push("--extension", extPath);
	}

	if (mcpExtensionPaths) {
		for (const extPath of mcpExtensionPaths) {
			args.push("--extension", extPath);
		}
	}

	return { args };
}
