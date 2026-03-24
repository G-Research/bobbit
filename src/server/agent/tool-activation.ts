/**
 * Maps role allowedTools to pi-coding-agent CLI flags.
 *
 * Tools come from three sources (defined in tools/<group>/*.yaml `provider` field):
 * 1. **Builtin tools** (pi-coding-agent built-in): read, bash, edit, write, grep, find, ls
 *    → Controlled via `--tools` flag
 * 2. **User extensions** (pi-coding-agent bundled): delegate, web_search, web_fetch, browser_*
 *    → Resolved from bobbitExtensionsDir(), controlled via `--extension` flags
 * 3. **Bobbit extensions** (tools/<group>/extension.ts): task_*, gate_*, team_*, bash_bg
 *    → Resolved from tools/<groupDir>/extension.ts, controlled via `--extension` flag
 *    → Goal/team extensions are added separately by session-manager
 *
 * Provider info is read from tools/<group>/*.yaml via ToolManager instead of hardcoded maps.
 * All sessions use `--no-extensions` so Bobbit has complete control over extension loading.
 */

import path from "node:path";
import { bobbitDir } from "../bobbit-dir.js";
import type { ToolManager, ToolProvider } from "./tool-manager.js";
import { TOOLS_DIR } from "./tool-manager.js";

export interface ToolActivationResult {
	/** CLI args to add (e.g. ["--tools", "read,bash", "--no-extensions", "--extension", "/path/to/ext"]) */
	args: string[];
}

/**
 * Resolve the absolute path for an extension based on provider type.
 * - bobbit-extension: resolved from tools/<groupDir>/<extension>
 * - user-extension: resolved from .bobbit/extensions/<extension>
 */
function resolveExtensionPath(provider: ToolProvider & { groupDir: string }): string {
	const extDir = path.join(bobbitDir(), "extensions");
	if (provider.type === "bobbit-extension" && provider.extension) {
		return path.join(TOOLS_DIR, provider.groupDir, provider.extension);
	}
	// user-extension: resolve from bobbitExtensionsDir (pi-coding-agent resolves these)
	return path.join(extDir, provider.extension!);
}

/**
 * Given a role's allowedTools list and a ToolManager, compute the CLI args needed
 * to activate exactly those tools (plus Bobbit extensions which are handled separately).
 *
 * If allowedTools is empty or undefined, all tools are enabled (all builtins + all user extensions).
 * Always adds `--no-extensions` so Bobbit has complete control over extension loading.
 */
export function computeToolActivationArgs(allowedTools?: string[], toolManager?: ToolManager): ToolActivationResult {
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

	// No restrictions — enable all builtins and all user extensions
	if (!allowedTools || allowedTools.length === 0) {
		const builtins: string[] = [];
		const extensionPaths = new Set<string>();

		for (const [, provider] of providers) {
			if (provider.type === "builtin" && provider.tool) {
				// Skip bash — provided by custom bash-tool.ts extension (loaded by rpc-bridge)
				if (provider.tool === "bash") continue;
				builtins.push(provider.tool);
			} else if (provider.type === "user-extension" && provider.extension) {
				extensionPaths.add(resolveExtensionPath(provider));
			}
			// bobbit-extension: skip, handled by session-manager
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
		} else if (provider.type === "user-extension" && provider.extension) {
			neededExtensions.add(resolveExtensionPath(provider));
		}
		// bobbit-extension: skip, handled by session-manager
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
