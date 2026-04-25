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
 *
 * Access control is handled by a single tool_call guard extension (see tool-guard-extension.ts)
 * instead of stub extensions and error regex matching.
 */


import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolManager, ToolProvider } from "./tool-manager.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { GrantPolicy } from "./role-store.js";
import { generateToolGuardExtension, type ToolPolicyEntry } from "./tool-guard-extension.js";

import { bobbitStateDir } from "../bobbit-dir.js";

/** Interface for the group policy store to avoid circular dependency on the class. */
export interface GroupPolicyProvider {
	getGroupPolicy(group: string): GrantPolicy | null;
	/** Optional bulk-read used by cache fingerprinting. */
	getAll?(): Record<string, GrantPolicy>;
}

// ── Process-level caches ────────────────────────────────────────────────────
// These caches memoize the expensive tool-activation pipeline steps. Inputs
// rarely change during a server lifetime (role policies, tool YAML, MCP tool
// schemas), and we create ~200 sessions per full test run, so caching saves
// substantial wall-time. Cache entries are keyed by content-based fingerprints
// (sha256 of a stable canonical JSON serialization). No eviction — entries are
// cleared only on process restart. Correctness is preserved by (a) hashing all
// inputs that affect output, and (b) verifying on-disk paths still exist
// before returning a cached fs path.

function stableStringify(v: unknown): string {
	if (v === null || v === undefined) return JSON.stringify(v ?? null);
	if (typeof v !== 'object') return JSON.stringify(v);
	if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function hashKey(parts: unknown): string {
	return createHash('sha256').update(stableStringify(parts)).digest('hex');
}

function readGroupPolicies(gp?: GroupPolicyProvider): Record<string, GrantPolicy> | null {
	if (!gp) return null;
	if (typeof gp.getAll === 'function') return gp.getAll();
	return null;
}

/** Cached output of `computeEffectiveAllowedTools`. Keyed by a content hash of role/policy/tool inputs. */
const allowedToolsCache = new Map<string, string[]>();
/** Cached output of `computeToolPolicies`. */
const policiesCache = new Map<string, Record<string, ToolPolicyEntry>>();
/** Cached result of `writeMcpProxyExtensions` — value must be validated via fs.existsSync before return. */
const mcpProxyCache = new Map<string, string[]>();
/** Cached generated guard-extension source (skips the template-gen step). Keyed by (sessionId, policies, grantedTools). */
const guardCodeCache = new Map<string, string>();
/** Cached guard-extension file path (skips fs read-compare-write when the same code was already persisted). Must be validated via fs.existsSync before return. */
const guardFileCache = new Map<string, string>();

/**
 * Normalize old grant policy values to the new simplified set.
 * - `always-allow` → `allow`
 * - `ask-once` / `always-ask` → `ask`
 * - `never-ask` → `never`
 * - New values (`allow`, `ask`, `never`) pass through unchanged.
 */
function normalizePolicy(policy: string): GrantPolicy {
	switch (policy) {
		case 'always-allow':
		case 'allow': return 'allow';
		case 'ask-once':
		case 'always-ask':
		case 'ask': return 'ask';
		case 'never-ask':
		case 'never': return 'never';
		default:
			return 'allow';
	}
}

/**
 * Check if a policy (after normalization) means "allow" (tool executes immediately).
 */
function isAllowPolicy(policy: GrantPolicy): boolean {
	return policy === 'allow';
}

/**
 * Check if a policy (after normalization) means "ask" (guard blocks until granted).
 */
function isAskPolicy(policy: GrantPolicy): boolean {
	return policy === 'ask';
}

/**
 * Check if a policy (after normalization) means "never" (tool not registered).
 */
function isNeverPolicy(policy: GrantPolicy): boolean {
	return policy === 'never';
}

/**
 * Resolve the effective grant policy for a tool.
 * Priority: role tool-specific > role group-level > tool YAML default > group default > system fallback.
 * Always returns a concrete policy (never null).
 *
 * Normalizes old policy values internally: `always-allow`→allow, `ask-once`/`always-ask`→ask, `never-ask`→never.
 */
export function resolveGrantPolicy(
	toolName: string,
	toolGroup: string | undefined,
	role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
	toolManager: ToolManager | undefined,
	groupPolicyStore?: GroupPolicyProvider,
): GrantPolicy {
	const mcpPrefix = mcpPolicyPrefix(toolName);

	// 1. Role-level tool-specific override
	if (role?.toolPolicies?.[toolName]) return normalizePolicy(role.toolPolicies[toolName]);

	// 2. Role-level group override (e.g. "mcp__playwright" matches "mcp__playwright__snap")
	if (mcpPrefix && role?.toolPolicies?.[mcpPrefix]) return normalizePolicy(role.toolPolicies[mcpPrefix]);
	if (toolGroup && role?.toolPolicies?.[toolGroup]) return normalizePolicy(role.toolPolicies[toolGroup]);

	// 3. Tool definition default from YAML
	const toolDef = toolManager?.getToolByName(toolName);
	if (toolDef?.grantPolicy) return normalizePolicy(toolDef.grantPolicy);

	// 4. Group-level default policy
	if (groupPolicyStore) {
		if (mcpPrefix) {
			const mcpGp = groupPolicyStore.getGroupPolicy(mcpPrefix);
			if (mcpGp) return normalizePolicy(mcpGp);
		}
		if (toolGroup) {
			const gp = groupPolicyStore.getGroupPolicy(toolGroup);
			if (gp) return normalizePolicy(gp);
		}
	}

	// 5. System fallback — always allow
	return 'allow';
}

function mcpPolicyPrefix(toolName: string): string | undefined {
	const match = toolName.match(/^(mcp__.+?)__/);
	return match?.[1];
}

/**
 * Compute the effective allowed tools for a role by running every known tool
 * through the full resolveGrantPolicy cascade. Tools whose resolved policy
 * is `allow` OR `ask` are returned (both need to be registered — the guard
 * controls access for `ask` tools).
 *
 * Only `never` tools are excluded.
 */
export function computeEffectiveAllowedTools(
	toolManager: ToolManager,
	role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
	groupPolicyStore?: GroupPolicyProvider,
	mcpManager?: { getToolInfos(): Array<{ name: string; group: string }> },
): string[] {
	const availableTools = toolManager.getAvailableTools();
	const mcpInfos = mcpManager?.getToolInfos() ?? [];

	// Content-based fingerprint: same inputs → same cache key → same output.
	const cacheKey = hashKey({
		kind: 'effectiveAllowedTools',
		toolPolicies: role?.toolPolicies ?? null,
		groupPolicies: readGroupPolicies(groupPolicyStore),
		tools: availableTools.map(t => [t.name, t.group, t.grantPolicy ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		mcp: mcpInfos.map(i => [i.name, i.group]).sort((a, b) => a[0].localeCompare(b[0])),
	});
	const cached = allowedToolsCache.get(cacheKey);
	if (cached) return cached.slice();

	const result: string[] = [];
	const seen = new Set<string>();

	// Builtin + bobbit-extension tools
	for (const tool of availableTools) {
		if (seen.has(tool.name.toLowerCase())) continue;
		seen.add(tool.name.toLowerCase());
		const policy = resolveGrantPolicy(tool.name, tool.group, role, toolManager, groupPolicyStore);
		// Include tools with allow OR ask policy (not never)
		if (!isNeverPolicy(policy)) result.push(tool.name);
	}

	// MCP tools
	for (const info of mcpInfos) {
		if (seen.has(info.name.toLowerCase())) continue;
		seen.add(info.name.toLowerCase());
		const policy = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
		if (!isNeverPolicy(policy)) result.push(info.name);
	}

	allowedToolsCache.set(cacheKey, result.slice());
	return result;
}

export interface ToolActivationResult {
	/** CLI args to add (e.g. ["--tools", "read,bash", "--no-extensions", "--extension", "/path/to/ext"]) */
	args: string[];
}

/**
 * Resolve the absolute path for a bobbit-extension provider.
 * Uses the provider's baseDir (resolved from the cascade) instead of a hardcoded TOOLS_DIR.
 */
function resolveExtensionPath(provider: ToolProvider & { groupDir: string; baseDir: string }): string {
	return path.join(provider.baseDir, provider.groupDir, provider.extension!);
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
	tools: Array<{ name: string; bobbitName: string; description?: string; inputSchema: Record<string, unknown> }>,
): string {
	const toolRegistrations = tools.map(tool => {
		const fullName = tool.bobbitName;
		const schema = jsonSchemaToTypeBox(tool.inputSchema);
		const desc = tool.description ? JSON.stringify(tool.description) : `"MCP tool ${tool.name} from ${serverName}"`;
		return `
  pi.registerTool({
    name: ${JSON.stringify(fullName)},
    description: ${desc},
    parameters: ${schema},
    execute: async (toolCallId, params) => {
      const body = JSON.stringify({ tool: ${JSON.stringify(fullName)}, args: params });
      const url = new URL(gwUrl + "/api/internal/mcp-call");
      const mod = url.protocol === "https:" ? await import("node:https") : await import("node:http");
      const result = await new Promise((resolve, reject) => {
        const req = mod.request(url, {
          method: "POST",
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-Bobbit-Session-Id": process.env.BOBBIT_SESSION_ID || "" },
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
      let text;
      if (r && r.content && Array.isArray(r.content)) {
        text = r.content.map(c => c.text || "").join("\\n");
      } else if (r && r.error) {
        text = "Error: " + r.error + (r.stack ? "\\n" + r.stack : "");
      } else {
        text = JSON.stringify(r);
      }
      return { content: [{ type: "text", text: text || "(no output)" }] };
    }
  });`;
	}).join('\n');

	return `import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function(pi) {
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  const gwUrl = process.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8").trim();
  const token = process.env.BOBBIT_TOKEN || fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8").trim();
${toolRegistrations}
}
`;
}

/**
 * Compute the effective policy and group for every known tool.
 * Returns a map of tool name → { policy: 'allow'|'ask'|'never', group }.
 */
export function computeToolPolicies(
	toolManager: ToolManager,
	mcpManager: McpManager | undefined,
	role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
	groupPolicyStore?: GroupPolicyProvider,
): Record<string, ToolPolicyEntry> {
	const availableTools = toolManager.getAvailableTools();
	const mcpInfos = mcpManager?.getToolInfos() ?? [];

	const cacheKey = hashKey({
		kind: 'toolPolicies',
		toolPolicies: role?.toolPolicies ?? null,
		groupPolicies: readGroupPolicies(groupPolicyStore),
		tools: availableTools.map(t => [t.name, t.group, t.grantPolicy ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		mcp: mcpInfos.map(i => [i.name, i.group]).sort((a, b) => a[0].localeCompare(b[0])),
	});
	const cachedPolicies = policiesCache.get(cacheKey);
	if (cachedPolicies) return { ...cachedPolicies };

	const result: Record<string, ToolPolicyEntry> = {};

	// Builtin + bobbit-extension tools
	for (const tool of availableTools) {
		const rawPolicy = resolveGrantPolicy(tool.name, tool.group, role, toolManager, groupPolicyStore);
		let policy: string;
		if (isAllowPolicy(rawPolicy)) policy = 'allow';
		else if (isAskPolicy(rawPolicy)) policy = 'ask';
		else policy = 'never';
		result[tool.name] = { policy, group: tool.group };
	}

	// MCP tools
	for (const info of mcpInfos) {
		if (result[info.name]) continue; // already seen
		const rawPolicy = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
		let policy: string;
		if (isAllowPolicy(rawPolicy)) policy = 'allow';
		else if (isAskPolicy(rawPolicy)) policy = 'ask';
		else policy = 'never';
		result[info.name] = { policy, group: info.group };
	}

	policiesCache.set(cacheKey, { ...result });
	return result;
}

/**
 * Write the tool_call guard extension if any tools have 'ask' policy.
 * Returns the file path of the written extension, or undefined if no guard is needed.
 */
export function writeToolGuardExtension(
	sessionId: string,
	toolManager: ToolManager,
	mcpManager: McpManager | undefined,
	role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
	groupPolicyStore?: GroupPolicyProvider,
	grantedTools?: string[],
): string | undefined {
	const policies = computeToolPolicies(toolManager, mcpManager, role, groupPolicyStore);

	// Generate the guard if any tool needs interception — 'ask' (long-poll for
	// user grant) or 'never' (hard-block). 'allow' tools don't need the guard.
	const hasGuardedTools = Object.values(policies).some(p => p.policy === 'ask' || p.policy === 'never');
	if (!hasGuardedTools) return undefined;

	// Fingerprint of all inputs that affect the generated code. Used to cache
	// both the generated source (skip template gen) and the written file path
	// (skip fs read-compare-write).
	const genKey = hashKey({
		kind: 'guardCode',
		sessionId,
		policies,
		grantedTools: (grantedTools ?? []).slice().sort(),
	});

	// Fast path: same code was already written to disk — reuse path if it still exists.
	const cachedPath = guardFileCache.get(genKey);
	if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;

	// Generate (or fetch cached) source code
	let code = guardCodeCache.get(genKey);
	if (!code) {
		code = generateToolGuardExtension(sessionId, policies, grantedTools ?? []);
		guardCodeCache.set(genKey, code);
	}

	// Write to .bobbit/state/tool-guard/ with content hash for dedup
	const baseDir = path.join(bobbitStateDir(), "tool-guard");
	const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
	const extDir = path.join(baseDir, hash);
	fs.mkdirSync(extDir, { recursive: true });

	const filePath = path.join(extDir, "guard.ts");
	// Only write if content changed (avoid unnecessary fs writes)
	try {
		const existing = fs.readFileSync(filePath, "utf-8");
		if (existing === code) {
			guardFileCache.set(genKey, filePath);
			return filePath;
		}
	} catch { /* file doesn't exist yet */ }
	fs.writeFileSync(filePath, code, "utf-8");
	guardFileCache.set(genKey, filePath);

	return filePath;
}

/**
 * Write proxy extension files for all connected MCP servers.
 * Returns array of written file paths.
 *
 * Generates proxy extensions for ALL MCP tools except those with `never` policy.
 * Access control for `ask` tools is handled by the tool_call guard extension,
 * not by stub extensions.
 */
export function writeMcpProxyExtensions(
	mcpManager: McpManager,
	allowedTools?: string[],
	role?: { toolPolicies?: Record<string, GrantPolicy> },
	toolManager?: ToolManager,
	groupPolicyStore?: GroupPolicyProvider,
): string[] {
	const infos = mcpManager.getToolInfos();

	// Content-based cache key: MCP tool schemas + filter + role/group policy.
	// On cache hit, every file path is validated before returning; if any was
	// deleted externally we fall through and regenerate.
	const cacheKey = hashKey({
		kind: 'mcpProxy',
		infos: infos.map(i => ({
			name: i.name,
			server: i.serverName,
			mcpToolName: i.mcpToolName,
			description: i.description,
			inputSchema: i.inputSchema ?? null,
			group: i.group,
		})).sort((a, b) => a.name.localeCompare(b.name)),
		allowedTools: allowedTools ? allowedTools.slice().sort() : null,
		toolPolicies: role?.toolPolicies ?? null,
		groupPolicies: readGroupPolicies(groupPolicyStore),
	});
	const cachedPaths = mcpProxyCache.get(cacheKey);
	if (cachedPaths && cachedPaths.every(p => fs.existsSync(p))) {
		return cachedPaths.slice();
	}

	// Determine if we're filtering
	const filtering = allowedTools && allowedTools.length > 0;
	const allowedSet = filtering
		? new Set(allowedTools!.map(t => t.toLowerCase()))
		: undefined;

	// Choose output directory: hash-based subdir for filtered, root for unrestricted
	const baseExtDir = path.join(bobbitStateDir(), "mcp-extensions");
	let extDir: string;
	if (filtering) {
		// Collect only the MCP tool names from allowedTools for the hash
		const mcpAllowed = allowedTools!.filter(t => t.toLowerCase().startsWith("mcp__")).sort();
		const hashInput = mcpAllowed.join(",").toLowerCase();
		const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
		extDir = path.join(baseExtDir, hash);
	} else {
		extDir = baseExtDir;
	}
	fs.mkdirSync(extDir, { recursive: true });

	const extensionPaths: string[] = [];

	// Group tool infos by server — only include tools that are not 'never'
	const toolsByServer = new Map<string, typeof infos>();
	for (const info of infos) {
		// If filtering, check if tool is in allowed set
		if (allowedSet && !allowedSet.has(info.name.toLowerCase())) {
			continue; // Not in allowed tools — skip (it's either 'never' or wasn't included)
		}

		// Double-check policy: skip 'never' tools explicitly
		if (role || toolManager || groupPolicyStore) {
			const p = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
			if (isNeverPolicy(p)) continue;
		}

		if (!toolsByServer.has(info.serverName)) toolsByServer.set(info.serverName, []);
		toolsByServer.get(info.serverName)!.push(info);
	}

	// Write proxy extensions (real implementations for all allowed + ask tools)
	for (const [serverName, tools] of toolsByServer) {
		const toolDefs = tools.map(t => ({
			name: t.mcpToolName,
			bobbitName: t.name,
			description: t.description,
			inputSchema: t.inputSchema || { type: "object" as const, properties: {} } as Record<string, unknown>,
		}));
		const code = generateMcpProxyExtension(serverName, toolDefs);
		const filePath = path.join(extDir, `${serverName}.ts`);
		// Skip rewrite if existing content matches (avoids needless fs writes).
		let needWrite = true;
		try {
			if (fs.readFileSync(filePath, "utf-8") === code) needWrite = false;
		} catch { /* file doesn't exist */ }
		if (needWrite) fs.writeFileSync(filePath, code, "utf-8");
		extensionPaths.push(filePath);
	}

	mcpProxyCache.set(cacheKey, extensionPaths.slice());
	return extensionPaths;
}



/**
 * Given a role's allowedTools list and a ToolManager, compute the CLI args needed
 * to activate exactly those tools.
 *
 * If allowedTools is empty or undefined, all tools are enabled (all builtins + all bobbit extensions).
 * Always adds `--no-extensions` so Bobbit has complete control over extension loading.
 *
 * No leaked tool detection — the tool_call guard extension handles access control.
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
				// Skip bash from --tools — it's provided by shell/extension.ts
				// (which is loaded via bash_bg's provider entry or explicitly below)
				if (provider.tool === "bash") {
					// Ensure shell/extension.ts is loaded for bash
					const bashProvider = providers.get("bash_bg");
					if (bashProvider?.type === "bobbit-extension" && bashProvider.extension) {
						extensionPaths.add(resolveExtensionPath(bashProvider));
					} else if (toolManager) {
						// Fallback: load shell/extension.ts via cascade resolution
						extensionPaths.add(toolManager.getExtensionPath("shell", "extension.ts"));
					}
					continue;
				}
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
			// Skip bash from --tools — it's provided by shell/extension.ts
			if (provider.tool === "bash") {
				// bash is allowed: ensure shell/extension.ts is loaded
				if (toolManager) {
					neededExtensions.add(toolManager.getExtensionPath("shell", "extension.ts"));
				}
				continue;
			}
			activeBaseTools.push(provider.tool);
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
