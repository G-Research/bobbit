/**
 * Maps role allowedTools to pi-coding-agent CLI flags.
 *
 * Tools come from two sources (defined in tools/<group>/*.yaml `provider` field):
 * 1. **Builtin tools** (pi-coding-agent built-in): read, bash, edit, write, grep, find, ls
 *    → Controlled via `--tools` flag
 * 2. **Bobbit extensions** (tools/<group>/extension.ts): delegate, browser_*, web_*, task_*, gate_*, team_*, bash_bg
 *    → Resolved from tools/<groupDir>/extension.ts, controlled via `--extension` flag
 *    → Goal/team extensions are also added separately by session-manager (duplicates are harmless)
 *
 * Provider info is read from tools/<group>/*.yaml via ToolManager instead of hardcoded maps.
 * All sessions use `--no-extensions` so Bobbit has complete control over extension loading.
 */

import path from "node:path";
import type { ToolManager, ToolProvider } from "./tool-manager.js";
import { TOOLS_CODE_DIR } from "./tool-manager.js";

export interface ToolActivationResult {
	/** CLI args to add (e.g. ["--tools", "read,bash", "--no-extensions", "--extension", "/path/to/ext"]) */
	args: string[];
}

/**
 * Resolve the absolute path for a bobbit-extension provider.
 * Path is: tools/<groupDir>/<extension>
 */
function resolveExtensionPath(provider: ToolProvider & { groupDir: string }): string {
	return path.join(TOOLS_CODE_DIR, provider.groupDir, provider.extension!);
}

/**
 * Given a role's allowedTools list and a ToolManager, compute the CLI args needed
 * to activate exactly those tools.
 *
 * If allowedTools is empty or undefined, all tools are enabled (all builtins + all bobbit extensions).
 * Always adds `--no-extensions` so Bobbit has complete control over extension loading.
 */
export function computeToolActivationArgs(allowedTools?: string[], toolManager?: ToolManager, cwd?: string): ToolActivationResult {
	const args: string[] = [];

	if (!toolManager) {
		// Fallback: no tool manager available, can't resolve providers.
		// Enable all base tools and disable extension auto-discovery for safety.
		console.warn("[tool-activation] No ToolManager provided — using fallback (all base tools, no extensions)");
		args.push("--tools", "read,bash,edit,write,grep,find,ls");
		args.push("--no-extensions");
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
		return { args };
	}

	// Restricted set — resolve each allowed tool via its provider
	const activeBaseTools: string[] = [];
	const neededExtensions = new Set<string>();

	for (const toolName of allowedTools) {
		const provider = providers.get(toolName);
		if (!provider) {
			// Unknown tool — log warning and skip
			console.warn(`[tool-activation] Tool "${toolName}" has no provider in tools/<group>/*.yaml — skipping`);
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

	return { args };
}
