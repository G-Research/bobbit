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
import {
	makeMetaToolName,
	buildMetaToolInputSchema,
	buildMetaToolDescription,
	parseMcpToolName,
} from "../mcp/mcp-meta.js";
import type { McpToolDef } from "../mcp/mcp-types.js";

import { bobbitStateDir } from "../bobbit-dir.js";

/** Interface for the group policy store to avoid circular dependency on the class. */
export interface GroupPolicyProvider {
	getGroupPolicy(group: string): GrantPolicy | null;
	/** Optional bulk-read used by cache fingerprinting. */
	getAll?(): Record<string, GrantPolicy>;
	/**
	 * Optional system-scope feature gate for the nested-goals (Subgoals)
	 * surface. When set and returning false, every tool in the `Children`
	 * group is forced to `never` regardless of role / group overrides.
	 * See docs/design/subgoals-experimental-toggle.md.
	 */
	getSubgoalsEnabled?(): boolean;
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
const allowedToolsCache = new Map<string, EffectiveTool[]>();
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
	// Step 0: system-scope Subgoals feature gate. When the flag is OFF, every
	// tool in the `Children` group resolves to `never` regardless of role /
	// group overrides. See docs/design/subgoals-experimental-toggle.md.
	if (toolGroup === "Children" && groupPolicyStore?.getSubgoalsEnabled
		&& !groupPolicyStore.getSubgoalsEnabled()) {
		return 'never';
	}

	const mcpKeys = mcpPolicyKeys(toolName);

	// 1. Role-level tool-specific override (exact tool name match)
	if (role?.toolPolicies?.[toolName]) return normalizePolicy(role.toolPolicies[toolName]);

	// 2. Role-level overrides — prefer the most specific MCP key (tool > group),
	//    then non-MCP toolGroup. Examples:
	//      tool name `mcp__gr__ai-adoption__list-articles`
	//        → tool key `mcp__gr__ai-adoption` beats group key `mcp__gr`.
	//      tool name `mcp__playwright__snap` (flat)
	//        → tool=group=`mcp__playwright` (single lookup).
	if (mcpKeys) {
		if (mcpKeys.tool !== mcpKeys.group && role?.toolPolicies?.[mcpKeys.tool]) {
			return normalizePolicy(role.toolPolicies[mcpKeys.tool]);
		}
		if (role?.toolPolicies?.[mcpKeys.group]) return normalizePolicy(role.toolPolicies[mcpKeys.group]);
	}
	if (toolGroup && role?.toolPolicies?.[toolGroup]) return normalizePolicy(role.toolPolicies[toolGroup]);

	// 3. Tool definition default from YAML
	const toolDef = toolManager?.getToolByName(toolName);
	if (toolDef?.grantPolicy) return normalizePolicy(toolDef.grantPolicy);

	// 4. Group-level default policy — same precedence (tool key > group key).
	if (groupPolicyStore) {
		if (mcpKeys) {
			if (mcpKeys.tool !== mcpKeys.group) {
				const mcpToolGp = groupPolicyStore.getGroupPolicy(mcpKeys.tool);
				if (mcpToolGp) return normalizePolicy(mcpToolGp);
			}
			const mcpGp = groupPolicyStore.getGroupPolicy(mcpKeys.group);
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

/**
 * Two-level MCP policy keys derived from a tool name. Used by
 * `resolveGrantPolicy` to consult the most-specific match first.
 *
 *   - `group` covers an entire MCP server (every sub-namespace under it).
 *   - `tool`  covers one sub-namespace meta-tool (or, for flat servers,
 *             equals `group`).
 *
 * Examples (all four name shapes):
 *
 *   | Tool name                                   | group              | tool                          |
 *   |---------------------------------------------|--------------------|-------------------------------|
 *   | `mcp__gr__ai-adoption__list-articles`       | `mcp__gr`          | `mcp__gr__ai-adoption`        |
 *   | `mcp__playwright__click` (flat)             | `mcp__playwright`  | `mcp__playwright`             |
 *   | `mcp_gr__ai-adoption` (meta + sub)          | `mcp__gr`          | `mcp__gr__ai-adoption`        |
 *   | `mcp_playwright` (meta flat)                | `mcp__playwright`  | `mcp__playwright`             |
 */
export interface McpPolicyKeys {
	group: string;
	tool: string;
}

/**
 * Compute the `{group, tool}` policy keys for a Bobbit tool name. Returns
 * `undefined` for non-MCP tool names. Single source of truth — callers
 * should not parse MCP names directly.
 */
export function mcpPolicyKeys(toolName: string): McpPolicyKeys | undefined {
	if (typeof toolName !== "string" || toolName.length === 0) return undefined;

	// Legacy per-op shape: `mcp__<server>__<rest>`. Use parseMcpToolName so
	// gateway-style names with a sub-namespace produce the granular tool key.
	if (toolName.startsWith("mcp__")) {
		const parsed = parseMcpToolName(toolName);
		if (!parsed) return undefined;
		const group = `mcp__${parsed.server}`;
		const tool = parsed.sub ? `mcp__${parsed.server}__${parsed.sub}` : group;
		return { group, tool };
	}

	// Meta-tool shape: `mcp_<server>` or `mcp_<server>__<sub>` (single
	// underscore prefix). First char after `mcp_` must NOT be `_` — that
	// would make it the legacy `mcp__…` form already handled above.
	const meta = toolName.match(/^mcp_([^_][^_]*(?:_[^_][^_]*)*)((?:__.*)?)$/);
	if (!meta) {
		// Looser fallback: anything starting with `mcp_` followed by a non-`_` char.
		const fallback = toolName.match(/^mcp_([^_].*)$/);
		if (!fallback) return undefined;
		const rest = fallback[1];
		const idx = rest.indexOf("__");
		if (idx === -1) {
			const group = `mcp__${rest}`;
			return { group, tool: group };
		}
		const server = rest.slice(0, idx);
		const sub = rest.slice(idx + 2);
		if (server.length === 0 || sub.length === 0) {
			const group = `mcp__${rest}`;
			return { group, tool: group };
		}
		return { group: `mcp__${server}`, tool: `mcp__${server}__${sub}` };
	}
	const server = meta[1];
	const tail = meta[2]; // either "" or `__<sub>`
	if (!tail) {
		const group = `mcp__${server}`;
		return { group, tool: group };
	}
	const sub = tail.slice(2);
	return { group: `mcp__${server}`, tool: `mcp__${server}__${sub}` };
}

/**
 * Backward-compat helper — returns the **group**-level MCP policy key for a
 * tool name, or `undefined` for non-MCP names. New code should call
 * `mcpPolicyKeys` to also get the tool-level key.
 *
 * Unchanged for legacy callers: `mcp__<server>__<op>` → `mcp__<server>`,
 * `mcp_<server>` → `mcp__<server>`.
 */
export function mcpPolicyPrefix(toolName: string): string | undefined {
	return mcpPolicyKeys(toolName)?.group;
}

/**
 * Tagged tool name. The activation pipeline must distinguish between two
 * fundamentally different kinds of tools that look identical at the string
 * level:
 *
 *   - `yaml`: a builtin or bobbit-extension tool with a YAML provider
 *     definition under `defaults/tools/<group>/*.yaml`. Resolvable through
 *     `ToolManager.getToolProviders()`. Includes `mcp_describe` (which is
 *     a builtin discovery tool with its own YAML).
 *   - `mcp`:  an MCP meta-tool name (`mcp_<server>` or
 *     `mcp_<server>__<sub>`) — NOT registered in the YAML provider registry.
 *     Served externally via `writeMcpProxyExtensions()` whose generated
 *     extension files are passed to `computeToolActivationArgs()` as the
 *     `mcpExtensionPaths` argument and emitted as `--extension <path>` flags.
 *
 * Each consumer must dispatch on `kind`. Yaml entries flow through the
 * provider registry; mcp entries are no-ops there. The `EffectiveTool[]`
 * shape removes the implicit name-shape detection that previously caused
 * `computeToolActivationArgs` to log spurious `"has no provider"` warnings
 * for every MCP meta-tool on every session spawn.
 */
export type EffectiveTool =
	| { kind: "yaml"; name: string }
	| { kind: "mcp"; name: string };

/**
 * Tag a flat tool name into an `EffectiveTool` at the boundary where a
 * caller has only a `string[]` (e.g. session restoration, where
 * `session.allowedTools` is persisted as plain strings, or grant flows where
 * the user grants a tool by name). Centralised so the kind-detection logic
 * lives in exactly one place.
 *
 * Resolution order:
 *   1. If `toolManager` knows a provider for `name` → `yaml` (covers
 *      builtin/extension tools AND `mcp_describe`).
 *   2. Otherwise, if `name` parses as an MCP meta-tool shape → `mcp`.
 *   3. Otherwise → `yaml` (so unknown-tool typos still surface through the
 *      provider-lookup `"has no provider"` warn in `computeToolActivationArgs`).
 */
export function tagAllowedTool(name: string, toolManager?: ToolManager): EffectiveTool {
	if (toolManager) {
		try {
			if (toolManager.getToolProviders().has(name)) return { kind: "yaml", name };
		} catch { /* providers unavailable; fall through */ }
	}
	if (mcpPolicyKeys(name)) return { kind: "mcp", name };
	return { kind: "yaml", name };
}

/**
 * Compute the effective allowed tools for a role by running every known tool
 * through the full resolveGrantPolicy cascade. Tools whose resolved policy
 * is `allow` OR `ask` are returned (both need to be registered — the guard
 * controls access for `ask` tools).
 *
 * Only `never` tools are excluded.
 *
 * Returns `EffectiveTool[]` — each entry is tagged at the producer with the
 * kind that determines downstream resolution (`yaml` via provider registry,
 * `mcp` via `mcpExtensionPaths`). See `EffectiveTool` for the contract.
 */
export function computeEffectiveAllowedTools(
	toolManager: ToolManager,
	role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
	groupPolicyStore?: GroupPolicyProvider,
	mcpManager?: { getToolInfos(): Array<{ name: string; group: string; serverName: string }> },
): EffectiveTool[] {
	const availableTools = toolManager.getAvailableTools();
	const mcpInfos = mcpManager?.getToolInfos() ?? [];

	// Content-based fingerprint: same inputs → same cache key → same output.
	const cacheKey = hashKey({
		kind: 'effectiveAllowedTools_v3',
		toolPolicies: role?.toolPolicies ?? null,
		groupPolicies: readGroupPolicies(groupPolicyStore),
		subgoalsEnabled: groupPolicyStore?.getSubgoalsEnabled?.() ?? null,
		tools: availableTools.map(t => [t.name, t.group, t.grantPolicy ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		mcp: mcpInfos.map(i => [i.name, i.group]).sort((a, b) => a[0].localeCompare(b[0])),
	});
	const cached = allowedToolsCache.get(cacheKey);
	if (cached) return cached.slice();

	const result: EffectiveTool[] = [];
	const seen = new Set<string>();

	// Builtin + bobbit-extension tools — always `kind: "yaml"` (have providers).
	for (const tool of availableTools) {
		if (seen.has(tool.name.toLowerCase())) continue;
		seen.add(tool.name.toLowerCase());
		const policy = resolveGrantPolicy(tool.name, tool.group, role, toolManager, groupPolicyStore);
		// Include tools with allow OR ask policy (not never)
		if (!isNeverPolicy(policy)) result.push({ kind: "yaml", name: tool.name });
	}

	// MCP tools — collapse per-op entries into one meta-tool per (server, sub-namespace).
	// Gateway-style servers expose two-level names like `mcp__gr__ai-adoption__list`;
	// each distinct sub-namespace becomes its own meta-tool `mcp_<server>__<sub>`.
	// Flat servers (no sub) collapse to one meta-tool `mcp_<server>`.
	const byKey = new Map<string /* server\0sub */, { server: string; sub?: string }>();
	for (const info of mcpInfos) {
		const opPolicy = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
		if (isNeverPolicy(opPolicy)) continue;
		const parsed = parseMcpToolName(info.name);
		if (!parsed) continue;
		// Drop ops blocked at the meta level — the meta-tool name's own policy
		// (which cascades through `mcpPolicyKeys` to the group / tool keys).
		const metaName = makeMetaToolName(parsed.server, parsed.sub);
		const serverPolicy = resolveGrantPolicy(metaName, info.group, role, toolManager, groupPolicyStore);
		if (isNeverPolicy(serverPolicy)) continue;
		const k = `${parsed.server}\u0000${parsed.sub ?? ""}`;
		if (!byKey.has(k)) byKey.set(k, { server: parsed.server, sub: parsed.sub });
	}
	for (const { server, sub } of byKey.values()) {
		const metaName = makeMetaToolName(server, sub);
		if (seen.has(metaName.toLowerCase())) continue;
		seen.add(metaName.toLowerCase());
		result.push({ kind: "mcp", name: metaName });
	}
	// Always include the discovery tool when any MCP server is registered,
	// unless policy denies it (role override or group policy on `mcp_describe`).
	// `mcp_describe` is a YAML-backed builtin discovery tool, NOT an MCP meta-tool.
	if (mcpInfos.length > 0 && !seen.has('mcp_describe')) {
		const policy = resolveGrantPolicy('mcp_describe', 'MCP', role, toolManager, groupPolicyStore);
		if (!isNeverPolicy(policy)) result.push({ kind: "yaml", name: 'mcp_describe' });
	}

	allowedToolsCache.set(cacheKey, result.slice());
	return result;
}

export interface ToolActivationResult {
	/** CLI args to add (e.g. ["--no-builtin-tools", "--no-extensions", "--extension", "/path/to/ext"]) */
	args: string[];
	/**
	 * Env vars to set on the spawned agent process. Currently used only for
	 * `BOBBIT_BUILTIN_TOOLS`, which the `_builtins` extension reads to decide
	 * which pi file-tool builtins to re-register for this session.
	 *
	 * Always present (even when empty): for sessions with no builtin tools the
	 * value is `""` so the extension registers nothing.
	 */
	env: Record<string, string>;
}

/** Pi file-tool builtins re-registered via defaults/tools/_builtins/extension.ts. */
const FILE_TOOL_BUILTIN_NAMES = new Set(["read", "edit", "write", "grep", "find", "ls"]);

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
 *
 * @deprecated Use `generateMcpMetaExtension` (track E of the MCP meta-tool
 * aggregation design). This per-op generator is retained for one cycle so any
 * out-of-tree consumers surface as TS deprecation warnings rather than
 * silently breaking. No in-tree callers remain.
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
 * Generate a pi-coding-agent extension that registers ONE meta-tool
 * `mcp_<serverName>` covering all of `ops`. Replaces the per-op registrations
 * produced by `generateMcpProxyExtension`.
 *
 * The model sees a single tool with `operation` constrained to a
 * `Type.Union([Type.Literal(...)])` over valid op names, plus an opaque
 * `args` object. The generated execute body POSTs the canonical per-op
 * tool name `mcp__<server>__<operation>` to `/api/internal/mcp-call` —
 * the dispatcher and on-disk routing identifier are completely unchanged.
 *
 * When `unavailableReason` is provided OR `ops` is empty, emits a stub
 * meta-tool whose execute returns a structured unavailable message. The
 * agent turn never aborts at the protocol level when an MCP server is
 * down — the model gets a text result and moves on. (See §5.3 of the
 * MCP meta-tool aggregation design doc.)
 */
export function generateMcpMetaExtension(
	serverName: string,
	ops: McpToolDef[],
	unavailableReason?: string,
	sub?: string,
): string {
	const metaName = makeMetaToolName(serverName, sub);
	const docsKey = sub ? `${serverName}__${sub}` : serverName;
	const docsRelPath = `mcp-tool-docs/${docsKey}.md`;

	const isStub = unavailableReason !== undefined || ops.length === 0;

	if (isStub) {
		const reason = unavailableReason ?? "no operations available";
		const description = `MCP server '${serverName}' is unavailable: ${reason}`;
		const stubSchema = jsonSchemaToTypeBox({
			type: "object",
			required: ["operation", "args"],
			properties: {
				operation: { type: "string", enum: ["__unavailable__"] },
				args: { type: "object" },
			},
		});
		return `import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function(pi) {
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  const gwUrl = process.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8").trim();
  const token = process.env.BOBBIT_TOKEN || fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8").trim();
  void gwUrl; void token;
  pi.registerTool({
    name: ${JSON.stringify(metaName)},
    description: ${JSON.stringify(description)},
    parameters: ${stubSchema},
    execute: async (toolCallId, params) => {
      void toolCallId; void params;
      return { content: [{ type: "text", text: ${JSON.stringify(`MCP server ${serverName} is unavailable: ${reason}`)} }] };
    }
  });
}
`;
	}

	const description = buildMetaToolDescription(serverName, ops, docsRelPath);
	const schema = jsonSchemaToTypeBox(buildMetaToolInputSchema(ops));
	const opNames = ops.map(o => o.name);

	return `import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function(pi) {
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  const gwUrl = process.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8").trim();
  const token = process.env.BOBBIT_TOKEN || fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8").trim();
  const validOps = new Set(${JSON.stringify(opNames)});
  pi.registerTool({
    name: ${JSON.stringify(metaName)},
    description: ${JSON.stringify(description)},
    parameters: ${schema},
    execute: async (toolCallId, params) => {
      void toolCallId;
      const operation = params && params.operation;
      const args = (params && params.args) || {};
      if (typeof operation !== "string" || !validOps.has(operation)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "invalid_operation", server: ${JSON.stringify(serverName)}, operation: operation }) }] };
      }
      const fullName = ${sub
			? `"mcp__" + ${JSON.stringify(serverName)} + "__" + ${JSON.stringify(sub)} + "__" + operation`
			: `"mcp__" + ${JSON.stringify(serverName)} + "__" + operation`};
      const body = JSON.stringify({ tool: fullName, args: args });
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
        text = JSON.stringify({ error: r.error, server: r.server || ${JSON.stringify(serverName)}, operation: r.operation || operation });
      } else {
        text = JSON.stringify(r);
      }
      return { content: [{ type: "text", text: text || "(no output)" }] };
    }
  });
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
		kind: 'toolPolicies_v2',
		toolPolicies: role?.toolPolicies ?? null,
		groupPolicies: readGroupPolicies(groupPolicyStore),
		subgoalsEnabled: groupPolicyStore?.getSubgoalsEnabled?.() ?? null,
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

	// MCP per-op tools — kept for Layer B server-side enforcement inside
	// /api/internal/mcp-call (the meta extension only sees `mcp_<server>`,
	// but the dispatcher resolves the per-op policy after parsing the
	// tool name and rejects `never` ops even when the meta-tool is granted).
	for (const info of mcpInfos) {
		if (result[info.name]) continue; // already seen
		const rawPolicy = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
		let policy: string;
		if (isAllowPolicy(rawPolicy)) policy = 'allow';
		else if (isAskPolicy(rawPolicy)) policy = 'ask';
		else policy = 'never';
		result[info.name] = { policy, group: info.group };
	}

	// MCP meta-tools — Layer A pre-flight surface the guard sees. One
	// `mcp_<server>__<sub>` entry per (server, sub-namespace) with at least one
	// non-`never` op (or `mcp_<server>` for flat servers). Aggregates the
	// per-op policies:
	//   - any 'ask' → 'ask'   (most cautious; user is prompted on first use)
	//   - all 'allow' → 'allow'
	//   - all 'never' → entry omitted (the meta-tool isn't registered)
	//
	// Per-op `ask` aggregated up to the (server,sub) level fires once on
	// first use; subsequent ops in the same sub-namespace flow through. Real
	// per-op gating is only honoured at level `never` (Layer B).
	const opsByKey = new Map<string, {
		server: string;
		sub?: string;
		ops: { name: string; group: string; policy: GrantPolicy }[];
	}>();
	for (const info of mcpInfos) {
		const parsed = parseMcpToolName(info.name);
		if (!parsed) continue;
		const opPolicy = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
		const k = `${parsed.server}\u0000${parsed.sub ?? ""}`;
		let entry = opsByKey.get(k);
		if (!entry) {
			entry = { server: parsed.server, sub: parsed.sub, ops: [] };
			opsByKey.set(k, entry);
		}
		entry.ops.push({ name: info.name, group: info.group, policy: opPolicy });
	}
	for (const { server, sub, ops } of opsByKey.values()) {
		const nonNever = ops.filter(o => !isNeverPolicy(o.policy));
		if (nonNever.length === 0) continue; // all ops blocked — don't surface meta-tool
		const metaName = makeMetaToolName(server, sub);
		if (result[metaName]) continue;
		const group = ops[0]?.group ?? `MCP: ${server}`;
		// Honour an explicit role-level meta-tool override first.
		const rawMetaPolicy = resolveGrantPolicy(metaName, group, role, toolManager, groupPolicyStore);
		let aggregated: 'allow' | 'ask' | 'never';
		if (isNeverPolicy(rawMetaPolicy)) {
			aggregated = 'never';
		} else if (isAskPolicy(rawMetaPolicy) || nonNever.some(o => isAskPolicy(o.policy))) {
			aggregated = 'ask';
		} else {
			aggregated = 'allow';
		}
		result[metaName] = { policy: aggregated, group };
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
		kind: 'mcpProxy_v2',
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
		// Include both legacy per-op names (`mcp__<server>__<op>`) and meta-tool
		// names (`mcp_<server>`, `mcp_describe`). The single-underscore prefix
		// already covers both `mcp_describe` and `mcp_<server>`.
		const mcpAllowed = allowedTools!.filter(t => {
			const lower = t.toLowerCase();
			return lower.startsWith("mcp__") || lower.startsWith("mcp_");
		}).sort();
		const hashInput = mcpAllowed.join(",").toLowerCase();
		const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
		extDir = path.join(baseExtDir, hash);
	} else {
		extDir = baseExtDir;
	}
	fs.mkdirSync(extDir, { recursive: true });

	const extensionPaths: string[] = [];

	// Group tool infos by (server, sub-namespace) — only include tools that
	// are not 'never'. Each (server, sub) pair becomes one meta-tool / one
	// emitted extension file.
	interface KeyEntry {
		server: string;
		sub?: string;
		tools: Array<{ info: typeof infos[number]; op: string }>;
	}
	const toolsByKey = new Map<string, KeyEntry>();
	for (const info of infos) {
		const parsed = parseMcpToolName(info.name);
		if (!parsed) continue;
		// If filtering, check if the bobbit name is in the allowed set OR if
		// the meta-tool for this (server, sub) is. The model-facing surface
		// only includes `mcp_<server>__<sub>` — per-op names are hidden.
		if (allowedSet) {
			const metaName = makeMetaToolName(parsed.server, parsed.sub).toLowerCase();
			if (!allowedSet.has(info.name.toLowerCase()) && !allowedSet.has(metaName)) {
				continue;
			}
		}

		// Double-check policy: skip 'never' tools explicitly
		if (role || toolManager || groupPolicyStore) {
			const p = resolveGrantPolicy(info.name, info.group, role, toolManager, groupPolicyStore);
			if (isNeverPolicy(p)) continue;
			const metaName = makeMetaToolName(parsed.server, parsed.sub);
			const sp = resolveGrantPolicy(metaName, info.group, role, toolManager, groupPolicyStore);
			if (isNeverPolicy(sp)) continue;
		}

		const k = `${parsed.server}\u0000${parsed.sub ?? ""}`;
		let entry = toolsByKey.get(k);
		if (!entry) {
			entry = { server: parsed.server, sub: parsed.sub, tools: [] };
			toolsByKey.set(k, entry);
		}
		entry.tools.push({ info, op: parsed.op });
	}

	// Failure-isolation: emit a stub meta-tool for any configured server in
	// `error` state (see §5.3) so the model still sees a tool but every call
	// returns a structured unavailable message instead of crashing the turn.
	const statuses = mcpManager.getServerStatuses();
	const writeFile = (server: string, sub: string | undefined, code: string): void => {
		const basename = sub ? `${server}__${sub}` : server;
		const filePath = path.join(extDir, `${basename}.ts`);
		let needWrite = true;
		try {
			if (fs.readFileSync(filePath, "utf-8") === code) needWrite = false;
		} catch { /* file doesn't exist */ }
		if (needWrite) fs.writeFileSync(filePath, code, "utf-8");
		extensionPaths.push(filePath);
	};

	const handled = new Set<string>(); // keys: `server\0sub`
	const handledServersErrored = new Set<string>();

	// Stubs for error-state servers — no sub knowledge possible (server
	// failed before listing tools), so always land at `<server>.ts`.
	for (const status of statuses) {
		if (status.status !== "error") continue;
		const code = generateMcpMetaExtension(status.name, [], status.error ?? "server in error state");
		writeFile(status.name, undefined, code);
		handled.add(`${status.name}\u0000`);
		handledServersErrored.add(status.name);
	}

	// Real meta extensions for each (server, sub) with at least one allowed op.
	for (const entry of toolsByKey.values()) {
		const k = `${entry.server}\u0000${entry.sub ?? ""}`;
		if (handled.has(k)) continue;
		// If the server itself is in error state we already emitted a stub at
		// `<server>.ts` and shouldn't shadow it with a connected meta extension.
		if (handledServersErrored.has(entry.server) && !entry.sub) continue;
		const opDefs = entry.tools.map(({ info, op }) => ({
			name: op,
			description: info.description,
			inputSchema: info.inputSchema || { type: "object" as const, properties: {} } as Record<string, unknown>,
		}));
		const code = generateMcpMetaExtension(entry.server, opDefs, undefined, entry.sub);
		writeFile(entry.server, entry.sub, code);
		handled.add(k);
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
export function computeToolActivationArgs(allowedTools?: EffectiveTool[], toolManager?: ToolManager, _cwd?: string, mcpExtensionPaths?: string[]): ToolActivationResult {
	// pi 0.70+ unified `--tools <list>` into an allowlist over BOTH builtins and
	// extension-registered tools, which broke our old "--tools <only-builtins>
	// + --extension shell" pattern (every extension tool got stripped). We now
	// always pass --no-builtin-tools to disable pi's internal builtins entirely
	// and re-register the desired file-tool subset via _builtins/extension.ts.
	// BOBBIT_BUILTIN_TOOLS tells that extension which names to register.
	const args: string[] = ["--no-builtin-tools", "--no-extensions"];
	const env: Record<string, string> = {};

	const builtinsToRegister = new Set<string>();
	const extensionPaths = new Set<string>();

	if (!toolManager) {
		// Fallback: no tool manager available, can't resolve providers.
		// Register all six file builtins, no bobbit extensions.
		console.warn("[tool-activation] No ToolManager provided — using fallback (all base tools, no extensions)");
		for (const name of FILE_TOOL_BUILTIN_NAMES) builtinsToRegister.add(name);
		env.BOBBIT_BUILTIN_TOOLS = [...builtinsToRegister].sort().join(",");
		if (mcpExtensionPaths) {
			for (const extPath of mcpExtensionPaths) args.push("--extension", extPath);
		}
		return { args, env };
	}

	// Always load the _builtins extension; it reads BOBBIT_BUILTIN_TOOLS to
	// decide which pi file-tool builtins to re-register for this session.
	const builtinsExtPath = toolManager.getExtensionPath("_builtins", "extension.ts");
	args.push("--extension", builtinsExtPath);

	const providers = toolManager.getToolProviders();

	// `kind:"mcp"` entries are satisfied externally via `mcpExtensionPaths` and
	// MUST NOT be looked up in the YAML provider registry — doing so would
	// trigger a spurious `"has no provider"` warn for every MCP meta-tool on
	// every session spawn. The `"has no provider"` branch below fires only for
	// genuinely unknown YAML tool names (typos in role allowedTools, etc.).
	const collect = (entries: Iterable<{ kind?: "yaml" | "mcp"; name: string }>) => {
		for (const entry of entries) {
			if (entry.kind === "mcp") continue;
			const provider = providers.get(entry.name);
			if (!provider) {
				console.warn(`[tool-activation] Tool "${entry.name}" has no provider in .bobbit/config/tools/<group>/*.yaml — skipping`);
				continue;
			}
			if (provider.type === "builtin" && provider.tool) {
				if (provider.tool === "bash") {
					// bash comes from shell/extension.ts, not from the file-builtins set.
					extensionPaths.add(toolManager.getExtensionPath("shell", "extension.ts"));
					continue;
				}
				if (FILE_TOOL_BUILTIN_NAMES.has(provider.tool)) {
					builtinsToRegister.add(provider.tool);
				}
			} else if (provider.type === "bobbit-extension" && provider.extension) {
				extensionPaths.add(resolveExtensionPath(provider));
			}
		}
	};

	if (!allowedTools || allowedTools.length === 0) {
		// No restrictions — enable all builtins (sans bash) and all bobbit extensions.
		const allEntries: { kind: "yaml"; name: string }[] = [];
		for (const [name] of providers) allEntries.push({ kind: "yaml", name });
		collect(allEntries);
	} else {
		collect(allowedTools);
	}

	env.BOBBIT_BUILTIN_TOOLS = [...builtinsToRegister].sort().join(",");
	for (const extPath of extensionPaths) args.push("--extension", extPath);
	if (mcpExtensionPaths) {
		for (const extPath of mcpExtensionPaths) args.push("--extension", extPath);
	}
	return { args, env };
}
