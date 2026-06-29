import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient } from "./mcp-client.js";
import { isValidOperationSchema, parseMcpToolName } from "./mcp-meta.js";
import type {
  McpServerConfig,
  McpToolDef,
  McpToolResult,
  McpToolDocCache,
} from "./mcp-types.js";
import { bobbitConfigDir, bobbitStateDir } from "../bobbit-dir.js";
import { parseCustomDirectories } from "../agent/config-directories.js";
import type { ProjectConfigReader } from "../agent/config-directories.js";

export interface McpDiscoveryScope {
  cwd: string;
  projectId?: string;
}

export type McpContributionScope = "server" | "global-user" | "project" | "manual" | string;

export interface ResolvedMcpOrigin {
  scope: McpContributionScope;
  packName?: string;
  packId?: string;
  sourceUrl?: string;
  path?: string;
}

export interface ResolvedMcpContribution {
  /** Pack-local contents.mcp basename and DisabledRefs.mcp key. */
  listName: string;
  /** Public/model-facing MCP server name used in mcp__<server>__... tool names. */
  serverName: string;
  /** Runtime MCP client key. Manual JSON MCPs leave this equal to serverName. */
  runtimeServerKey?: string;
  /** Stable installed contribution identity used by marketplace activation. */
  contributionId?: string;
  /** Optional gateway sub-namespace owned by this contribution. */
  subNamespace?: string;
  /** Optional enabled operation allow-list after install activation is applied. */
  selectedOperations?: string[];
  /** Optional disabled operation names owned by this contribution. */
  disabledOperations?: string[];
  config: McpServerConfig;
  origin: ResolvedMcpOrigin;
}

export interface ResolvedMcpConnectionGroup {
  /** Runtime MCP client key. Kept as serverName for compatibility with existing status/config callers. */
  serverName: string;
  runtimeServerKey: string;
  config: McpServerConfig;
  ownerContributions: ResolvedMcpContribution[];
  /** undefined means a flat contribution owns all namespaces. */
  activeSubNamespaces?: Set<string>;
}

export interface McpRouteDiagnostic {
  type: "conflict";
  toolName: string;
  keptRuntimeServerKey: string;
  droppedRuntimeServerKey: string;
  keptContributionId?: string;
  droppedContributionId?: string;
}

interface McpToolRoute {
  name: string;
  runtimeServerKey: string;
  publicServerName: string;
  mcpToolName: string;
  tool: McpToolDef;
  contribution: ResolvedMcpContribution;
  group: string;
}

export interface RedactedMcpServerConfig {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export type RedactedResolvedMcpContribution = Omit<ResolvedMcpContribution, "config"> & {
  config: RedactedMcpServerConfig;
};

export type MarketplaceMcpResolver = (scope: McpDiscoveryScope) => ResolvedMcpContribution[];

export type McpReloadStatus = "ok" | "partial" | "error" | "pending";

export interface McpReloadResult {
  status: McpReloadStatus;
  connected: string[];
  disconnected: string[];
  unchanged: string[];
  skippedErrored: string[];
  failed: Array<{ name: string; error: string }>;
  statuses: McpServerStatus[];
}

export interface McpToolRegistrationRefresh {
  /** Remove these external-tool prefixes before registering toolInfos. */
  removePrefixes: string[];
  toolInfos: McpToolInfo[];
}

/** Status of an MCP server */
export interface McpServerStatus {
  name: string;
  status: "connected" | "disconnected" | "error" | "reconnecting";
  toolCount: number;
  error?: string;
  config?: RedactedMcpServerConfig;
  origin?: ResolvedMcpOrigin;
  ownerContributions?: RedactedResolvedMcpContribution[];
  activeSubNamespaces?: string[];
}

/** Bobbit-compatible tool info produced from MCP tool defs */
export interface McpToolInfo {
  name: string;
  description: string;
  group: string;
  docs?: string;
  summary?: string;
  serverName: string;
  mcpToolName: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Discovery and lifecycle management for MCP servers.
 *
 * Scans config files for MCP server definitions, connects to them,
 * caches tool definitions, and routes tool calls to the correct client.
 */
/** Max tool name length (Anthropic API limit). */
const MAX_TOOL_NAME_LENGTH = 64;

/** Per-call timeout for `tools/list` (failure isolation, design §5.1). */
const DEFAULT_LIST_TOOLS_TIMEOUT_MS = 10_000;

/** Per-call timeout for `tools/call` (failure isolation, design §5.1). */
const DEFAULT_CALL_TOOL_TIMEOUT_MS = 30_000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = stableValue(v);
    }
    return out;
  }
  return value;
}

function stableFingerprint(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function safeScopeSegment(scopeKey: string): string {
  const readable = scopeKey.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "scope";
  return `${readable}-${stableFingerprint(scopeKey).slice(0, 12)}`;
}

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return stableFingerprint(a) === stableFingerprint(b);
}

const REDACTED = "<redacted>";

function redactRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = REDACTED;
  return out;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return REDACTED;
  }
}

function redactMcpServerConfig(config: McpServerConfig): RedactedMcpServerConfig {
  const out: RedactedMcpServerConfig = { transport: config.url ? "http" : "stdio" };
  if (config.command) out.command = config.command;
  if (config.args) out.args = config.args.map(() => REDACTED);
  if (config.cwd) out.cwd = config.cwd;
  if (config.url) out.url = redactUrl(config.url);
  const env = redactRecord(config.env);
  if (env) out.env = env;
  const headers = redactRecord(config.headers);
  if (headers) out.headers = headers;
  return out;
}

function redactMcpContribution(contribution: ResolvedMcpContribution): RedactedResolvedMcpContribution {
  return { ...contribution, config: redactMcpServerConfig(contribution.config) };
}

function flatManualContribution(name: string, config: McpServerConfig): ResolvedMcpContribution {
  return {
    listName: name,
    serverName: name,
    config,
    origin: { scope: "manual" },
  };
}

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolDefs = new Map<string, McpToolDef[]>();
  private configs = new Map<string, McpServerConfig>();
  private errors = new Map<string, string>();
  /** Desired group from the latest discovery pass (marketplace + manual override). */
  private discoveredConnectionGroups = new Map<string, ResolvedMcpConnectionGroup>();
  /** Active/errored runtime group for each known server. */
  private connectionGroups = new Map<string, ResolvedMcpConnectionGroup>();
  private serverFingerprints = new Map<string, string>();
  private reloadPromise: Promise<McpReloadResult> | undefined;
  private marketplaceResolver: MarketplaceMcpResolver | null = null;
  private readonly discoveryScope: McpDiscoveryScope;
  /** Maps public Bobbit tool names to their authoritative runtime route. */
  private _toolRouteMap = new Map<string, McpToolRoute>();
  private _routeDiagnostics: McpRouteDiagnostic[] = [];
  private _routeMapDirty = true;
  /** Maps truncated Bobbit tool names back to original MCP tool names. Kept for legacy tests/introspection. */
  private _toolNameMap = new Map<string, { serverName: string; mcpToolName: string }>();
  /** In-memory cache: runtimeServerKey → toolName → summary */
  private _summaryCache = new Map<string, Map<string, string>>();

  private projectConfigStore: ProjectConfigReader | null;
  private additionalProjects: Array<{cwd: string, configStore: ProjectConfigReader}> = [];
  private stateDir: string | undefined;
  private readonly scopeKey: string;

  /** Override-able for tests via constructor opts. */
  private listToolsTimeoutMs: number = DEFAULT_LIST_TOOLS_TIMEOUT_MS;
  private callToolTimeoutMs: number = DEFAULT_CALL_TOOL_TIMEOUT_MS;

  constructor(
    private cwd: string,
    projectConfigStore?: ProjectConfigReader,
    stateDir?: string,
    opts?: {
      listToolsTimeoutMs?: number;
      callToolTimeoutMs?: number;
      projectId?: string;
      marketplaceResolver?: MarketplaceMcpResolver;
      scopeKey?: string;
    },
  ) {
    this.projectConfigStore = projectConfigStore ?? null;
    this.stateDir = stateDir;
    if (opts?.listToolsTimeoutMs !== undefined) this.listToolsTimeoutMs = opts.listToolsTimeoutMs;
    if (opts?.callToolTimeoutMs !== undefined) this.callToolTimeoutMs = opts.callToolTimeoutMs;
    if (opts?.marketplaceResolver) this.marketplaceResolver = opts.marketplaceResolver;
    this.discoveryScope = { cwd: this.cwd, ...(opts?.projectId ? { projectId: opts.projectId } : {}) };
    this.scopeKey = opts?.scopeKey ?? (opts?.projectId ? `project:${opts.projectId}` : "default");
  }

  /**
   * Construct a new MCP client. Test seam: subclasses / tests can override this
   * to return a stub without spawning a real subprocess.
   */
  protected _createClient(name: string): McpClient {
    return new McpClient(name);
  }

  /**
   * Race a promise against a timeout. On timeout, rejects with
   * `<label> timed out after <ms> ms`. Used for per-call failure isolation.
   */
  private _withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms} ms`));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Register additional project directories for MCP server discovery. */
  setAdditionalProjects(projects: Array<{cwd: string, configStore: ProjectConfigReader}>): void {
    this.additionalProjects = projects;
  }

  /** Bind or replace the scoped Marketplace MCP resolver. */
  setMarketplaceResolver(resolver: MarketplaceMcpResolver | null | undefined): void {
    this.marketplaceResolver = resolver ?? null;
  }

  /** Runtime discovery scope supplied to the Marketplace resolver seam. */
  getDiscoveryScope(): McpDiscoveryScope {
    return { ...this.discoveryScope };
  }

  /** Stable runtime scope identity used for routing and scoped cache paths. */
  getScopeKey(): string {
    return this.scopeKey;
  }

  /** Relative directory containing generated MCP tool docs for this manager. */
  getToolDocsRelativeDir(): string {
    return this.scopeKey === "default" ? "mcp-tool-docs" : path.join("mcp-tool-docs", safeScopeSegment(this.scopeKey));
  }

  getToolDocsRelativePath(serverName: string, _sub?: string): string {
    // _updateDocCache writes one flat docs file per runtime server. Sub-namespace
    // meta-tools deliberately point at that existing file instead of advertising
    // non-existent <server>__<sub>.md paths.
    return path.join(this.getToolDocsRelativeDir(), `${path.basename(serverName)}.md`).replace(/\\/g, "/");
  }

  // ── Discovery ──────────────────────────────────────────────────────

  /**
   * Discover MCP servers from config files.
   * Priority order (later overrides earlier):
   *   0. Custom directories (lowest priority)
   *   1. ~/.claude.json → mcpServers (global)
   *   1b. ~/.claude.json → projects[cwd] → mcpServers (per-project)
   *   2. ~/.claude/.mcp.json → mcpServers
   *   3. ~/.bobbit/.mcp.json → mcpServers
   *   4. .mcp.json in cwd
   *   5. .bobbit/config/mcp.json → mcpServers
   */
  discoverServers(): Record<string, McpServerConfig> {
    const groups = this.discoverConnectionGroups();
    const merged: Record<string, McpServerConfig> = {};
    for (const group of groups) {
      merged[group.serverName] = group.config;
    }
    return merged;
  }

  /**
   * Discover active connection groups from Marketplace first, then overlay the
   * unchanged manual MCP cascade. Manual config wins for same serverName.
   */
  discoverConnectionGroups(): ResolvedMcpConnectionGroup[] {
    const byServer = new Map<string, ResolvedMcpConnectionGroup>();

    for (const group of this.resolveMarketplaceConnectionGroups()) {
      byServer.set(group.serverName, group);
    }

    const manual = this._discoverManualServers();
    for (const [name, config] of Object.entries(manual)) {
      byServer.set(name, {
        serverName: name,
        runtimeServerKey: name,
        config,
        ownerContributions: [flatManualContribution(name, config)],
      });
    }

    this.discoveredConnectionGroups = new Map(byServer);
    return [...byServer.values()];
  }

  /** Resolve Marketplace MCP contributions for this manager's scope. */
  resolveMarketplaceContributions(): ResolvedMcpContribution[] {
    if (!this.marketplaceResolver) return [];
    try {
      return this.marketplaceResolver(this.getDiscoveryScope()).filter((c) => {
        return !!c && typeof c.listName === "string" && typeof c.serverName === "string" && !!c.config;
      }).map((c) => ({ ...c, runtimeServerKey: c.runtimeServerKey ?? c.serverName }));
    } catch (err) {
      console.error("[mcp] Marketplace MCP resolver failed:", (err as Error).message);
      return [];
    }
  }

  /**
   * Group ordered Marketplace contributions into runtime MCP client connections.
   * Later entries override earlier same-server entries when the config differs;
   * same-config sub-namespaces share one client. A flat contribution owns all
   * namespaces and therefore leaves activeSubNamespaces undefined.
   */
  resolveMarketplaceConnectionGroups(): ResolvedMcpConnectionGroup[] {
    return McpManager.groupMarketplaceContributions(this.resolveMarketplaceContributions());
  }

  static groupMarketplaceContributions(contributions: ResolvedMcpContribution[]): ResolvedMcpConnectionGroup[] {
    const byRuntime = new Map<string, ResolvedMcpConnectionGroup>();
    for (const rawContrib of contributions) {
      const contrib = { ...rawContrib, runtimeServerKey: rawContrib.runtimeServerKey ?? rawContrib.serverName };
      const runtimeKey = contrib.runtimeServerKey;
      const existing = byRuntime.get(runtimeKey);
      if (!existing || !sameConfig(existing.config, contrib.config)) {
        byRuntime.set(runtimeKey, {
          serverName: runtimeKey,
          runtimeServerKey: runtimeKey,
          config: contrib.config,
          ownerContributions: [contrib],
          activeSubNamespaces: contrib.subNamespace ? new Set([contrib.subNamespace]) : undefined,
        });
        continue;
      }

      existing.ownerContributions.push(contrib);
      if (!contrib.subNamespace) {
        existing.activeSubNamespaces = undefined;
      } else if (existing.activeSubNamespaces) {
        existing.activeSubNamespaces.add(contrib.subNamespace);
      }
    }
    return [...byRuntime.values()];
  }

  private _discoverManualServers(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};

    // 0. Custom directories (lowest priority — merged first, overridden by everything)
    if (this.projectConfigStore) {
      const customDirs = parseCustomDirectories(this.projectConfigStore)
        .filter(d => d.types.includes("mcp"));
      for (const dir of customDirs) {
        this._mergeConfigFile(merged, path.join(dir.path, ".mcp.json"), "mcpServers");
      }
    }

    // 0b. Additional registered projects (low priority — overridden by user and primary project)
    for (const proj of this.additionalProjects) {
      const projCustomDirs = parseCustomDirectories(proj.configStore)
        .filter(d => d.types.includes("mcp"));
      for (const dir of projCustomDirs) {
        this._mergeConfigFile(merged, path.join(dir.path, ".mcp.json"), "mcpServers");
      }
      this._mergeConfigFile(merged, path.join(proj.cwd, ".mcp.json"), "mcpServers");
      this._mergeConfigFile(merged, path.join(proj.cwd, ".claude", ".mcp.json"), "mcpServers");
      this._mergeConfigFile(merged, path.join(proj.cwd, ".bobbit", "config", "mcp.json"), "mcpServers");
    }

    const home = os.homedir();
    this._mergeConfigFile(merged, path.join(home, ".claude.json"), "mcpServers");
    this._mergeProjectConfigFromClaudeJson(merged, path.join(home, ".claude.json"));
    this._mergeConfigFile(merged, path.join(home, ".claude", ".mcp.json"), "mcpServers");
    this._mergeConfigFile(merged, path.join(home, ".bobbit", ".mcp.json"), "mcpServers");

    this._mergeConfigFile(merged, path.join(this.cwd, ".mcp.json"), "mcpServers");
    this._mergeConfigFile(merged, path.join(this.cwd, ".claude", ".mcp.json"), "mcpServers");
    this._mergeConfigFile(merged, path.join(bobbitConfigDir(), "mcp.json"), "mcpServers");

    return merged;
  }

  /** Read a JSON config file and merge its servers into the target. */
  private _mergeConfigFile(
    target: Record<string, McpServerConfig>,
    filePath: string,
    key: "mcpServers",
  ): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      const servers: Record<string, McpServerConfig> | undefined = parsed[key];
      if (servers && typeof servers === "object") {
        for (const [name, config] of Object.entries(servers)) {
          if (config && typeof config === "object") {
            target[name] = config;
          }
        }
      }
    } catch (err) {
      console.error(
        `[mcp] Failed to read config file ${filePath}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Read ~/.claude.json → projects → <matching-path> → mcpServers.
   * Claude Code stores per-project MCP config under a "projects" map keyed by
   * the project's absolute path. We match the current cwd against those keys
   * (case-insensitive on Windows, normalized separators).
   */
  private _mergeProjectConfigFromClaudeJson(
    target: Record<string, McpServerConfig>,
    filePath: string,
  ): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      const projects = parsed.projects;
      if (!projects || typeof projects !== "object") return;

      // Normalize a path for comparison: forward slashes, lowercase on win32
      const normalize = (p: string) => {
        let n = p.replace(/\\/g, "/").replace(/\/+$/, "");
        if (process.platform === "win32") n = n.toLowerCase();
        return n;
      };

      const cwdNorm = normalize(this.cwd);
      for (const [projectPath, projectConfig] of Object.entries(projects)) {
        if (normalize(projectPath) !== cwdNorm) continue;
        const servers = (projectConfig as any)?.mcpServers;
        if (servers && typeof servers === "object") {
          for (const [name, config] of Object.entries(servers)) {
            if (config && typeof config === "object") {
              target[name] = config as McpServerConfig;
            }
          }
        }
        break;
      }
    } catch (err) {
      console.error(
        `[mcp] Failed to read project config from ${filePath}:`,
        (err as Error).message,
      );
    }
  }

  // ── Connection lifecycle ───────────────────────────────────────────

  /**
   * Connect to a specific MCP server.
   * Creates a client, performs the initialize handshake, and caches tool definitions.
   */
  async connectServer(name: string, config: McpServerConfig): Promise<void> {
    const desiredGroup = this.discoveredConnectionGroups.get(name) ?? {
      serverName: name,
      runtimeServerKey: name,
      config,
      ownerContributions: [flatManualContribution(name, config)],
    };

    // Disconnect existing client for this server if any
    if (this.clients.has(name)) {
      await this.disconnectServer(name);
    }

    this.configs.set(name, config);
    this.connectionGroups.set(name, desiredGroup);
    this.serverFingerprints.set(name, this._fingerprintGroup(desiredGroup));
    this.errors.delete(name);

    const client = this._createClient(name);
    try {
      // Guard for test-injected stubs that may pre-set connected=true.
      if (!client.connected) {
        await client.connect(config);
      }
      this.clients.set(name, client);

      // Fetch tool definitions with a timeout — a hung `tools/list` must not
      // block sibling-server discovery (design §5.1).
      let rawTools: McpToolDef[];
      try {
        rawTools = await this._withTimeout(
          client.listTools(),
          this.listToolsTimeoutMs,
          `MCP server "${name}" tools/list`,
        );
      } catch (err) {
        const reason = (err as Error).message;
        console.error(`[mcp] tools/list failed for "${name}": ${reason}`);
        this.errors.set(name, reason);
        // Server stays in errored state with empty toolDefs — sibling servers
        // are unaffected. Keep the client around so getServerStatuses() can
        // report `error` while .connected is true; downstream callTool will
        // simply find no tools to dispatch.
        this.toolDefs.set(name, []);
        this._markRouteMapDirty();
        return;
      }

      // Filter out malformed-schema ops (design §5.2). Surviving ops are
      // still usable; the bad ones are dropped from the meta-tool's enum.
      const validTools: McpToolDef[] = [];
      for (const tool of rawTools) {
        if (isValidOperationSchema(tool)) {
          validTools.push(tool);
        } else {
          console.warn(
            `[mcp] dropping invalid op "${name}/${tool?.name ?? "<unnamed>"}": malformed schema`,
          );
        }
      }

      this.toolDefs.set(name, validTools);
      this._markRouteMapDirty();

      // Generate/update doc cache and summaries
      this._updateDocCache(name, validTools);

      console.log(
        `[mcp] Connected to server "${name}" — ${validTools.length} tool(s) available` +
          (validTools.length !== rawTools.length
            ? ` (${rawTools.length - validTools.length} dropped)`
            : ""),
      );
    } catch (err) {
      const msg = (err as Error).message;
      this.errors.set(name, msg);
      console.error(`[mcp] Failed to connect to server "${name}":`, msg);

      // Clean up partial state
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
      this.clients.delete(name);
      this.toolDefs.delete(name);
      this._markRouteMapDirty();
    }
  }

  private _fingerprintGroup(group: ResolvedMcpConnectionGroup): string {
    return stableFingerprint({
      runtimeServerKey: group.runtimeServerKey,
      config: group.config,
    });
  }

  /**
   * Discover all MCP servers and connect to them.
   * Partial failure is tolerated — failed servers are logged and skipped.
   */
  async connectAll(): Promise<void> {
    const result = await this.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    if (result.status === "pending") {
      await this.reloadPromise;
    }
  }

  async reloadDiscoveredServers(opts?: { force?: boolean; timeoutMs?: number }): Promise<McpReloadResult> {
    if (!this.reloadPromise) {
      this.reloadPromise = this._reloadDiscoveredServers(opts?.force === true)
        .finally(() => {
          this.reloadPromise = undefined;
        });
    }

    const timeoutMs = opts?.timeoutMs ?? 30_000;
    if (timeoutMs <= 0) return this.reloadPromise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<McpReloadResult>((resolve) => {
      timer = setTimeout(() => resolve(this._pendingReloadResult()), timeoutMs);
    });
    return Promise.race([this.reloadPromise, pending]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Return the in-flight reload, if any, so callers can refresh dependents after a pending response completes. */
  currentReload(): Promise<McpReloadResult> | undefined {
    return this.reloadPromise;
  }

  private _pendingReloadResult(): McpReloadResult {
    return {
      status: "pending",
      connected: [],
      disconnected: [],
      unchanged: [],
      skippedErrored: [],
      failed: [],
      statuses: this.getServerStatuses().map((s) => ({ ...s, status: s.status === "error" ? "reconnecting" : s.status })),
    };
  }

  private async _reloadDiscoveredServers(force: boolean): Promise<McpReloadResult> {
    const groups = this.discoverConnectionGroups();
    const desired = new Map(groups.map((g) => [g.serverName, g]));
    const connected: string[] = [];
    const disconnected: string[] = [];
    const unchanged: string[] = [];
    const skippedErrored: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const name of [...this.configs.keys()]) {
      if (!desired.has(name)) {
        await this.disconnectServer(name, { forget: true });
        disconnected.push(name);
      }
    }

    await Promise.all([...desired.values()].map(async (group) => {
      const name = group.serverName;
      const fp = this._fingerprintGroup(group);
      const unchangedConfig = this.serverFingerprints.get(name) === fp;
      this.discoveredConnectionGroups.set(name, group);
      if (!force && unchangedConfig) {
        // The connection can stay up, but ownership/origin metadata may have
        // changed under the same transport config (for example manual override
        // with identical config, or Marketplace disable while manual remains).
        this.configs.set(name, group.config);
        this.connectionGroups.set(name, group);
        this.serverFingerprints.set(name, fp);
        this._markRouteMapDirty();
        if (this.errors.has(name)) {
          skippedErrored.push(name);
          return;
        }
        if (this.clients.get(name)?.connected) {
          unchanged.push(name);
          return;
        }
      }
      await this.connectServer(name, group.config);
      if (this.errors.has(name)) {
        failed.push({ name, error: this.errors.get(name)! });
      } else {
        connected.push(name);
      }
    }));

    let status: McpReloadStatus = "ok";
    if (failed.length > 0) {
      status = connected.length > 0 || unchanged.length > 0 || skippedErrored.length > 0 || disconnected.length > 0 ? "partial" : "error";
    }

    return { status, connected, disconnected, unchanged, skippedErrored, failed, statuses: this.getServerStatuses() };
  }

  /** Disconnect a specific server and remove its cached state. */
  async disconnectServer(name: string, opts?: { forget?: boolean }): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        console.error(
          `[mcp] Error disconnecting server "${name}":`,
          (err as Error).message,
        );
      }
      this.clients.delete(name);
    }
    this.toolDefs.delete(name);
    this.errors.delete(name);
    this._markRouteMapDirty();
    if (opts?.forget) {
      this.configs.delete(name);
      this.connectionGroups.delete(name);
      this.discoveredConnectionGroups.delete(name);
      this.serverFingerprints.delete(name);
      for (const key of [...this._toolNameMap.keys()]) {
        if (this._toolNameMap.get(key)?.serverName === name) this._toolNameMap.delete(key);
      }
      this._summaryCache.delete(name);
    }
  }

  /** Disconnect all connected servers. */
  async disconnectAll(): Promise<void> {
    const names = [...new Set([...this.clients.keys(), ...this.configs.keys()])];
    await Promise.all(names.map((name) => this.disconnectServer(name, { forget: true })));
    this.configs.clear();
    this.connectionGroups.clear();
    this.discoveredConnectionGroups.clear();
    this.serverFingerprints.clear();
    this._markRouteMapDirty();
  }

  // ── Tool queries ───────────────────────────────────────────────────

  /**
   * Get all MCP tools as Bobbit-compatible tool info objects.
   * Tool names use double-underscore separator: mcp__<public-server>__<tool>
   */
  getToolInfos(): McpToolInfo[] {
    this._ensureRouteMapFresh();
    const infos: McpToolInfo[] = [];

    for (const route of this._toolRouteMap.values()) {
      const summary = this._summaryCache.get(route.runtimeServerKey)?.get(route.mcpToolName);
      // Compact inline docs — description is already in the summary line,
      // so docs only carry parameter names. Full tables live in the MD file.
      const paramNames = this._getParamNames(route.tool);
      const docs = paramNames ? `Parameters: ${paramNames}` : undefined;

      infos.push({
        name: route.name,
        description: route.tool.description || `MCP tool ${route.mcpToolName} from ${route.publicServerName}`,
        group: route.group,
        docs,
        summary,
        serverName: route.publicServerName,
        mcpToolName: route.mcpToolName,
        inputSchema: route.tool.inputSchema as Record<string, unknown>,
      });
    }

    return infos;
  }

  getRouteDiagnostics(): McpRouteDiagnostic[] {
    this._ensureRouteMapFresh();
    return this._routeDiagnostics.map((d) => ({ ...d }));
  }

  private _markRouteMapDirty(): void {
    this._routeMapDirty = true;
  }

  private _ensureRouteMapFresh(): void {
    if (!this._routeMapDirty) return;
    this._rebuildRouteMap();
  }

  private _rebuildRouteMap(): void {
    this._toolRouteMap.clear();
    this._toolNameMap.clear();
    this._routeDiagnostics = [];

    for (const [runtimeServerKey, tools] of this.toolDefs) {
      const group = this.connectionGroups.get(runtimeServerKey);
      const owners = group?.ownerContributions?.length
        ? group.ownerContributions
        : [flatManualContribution(runtimeServerKey, this.configs.get(runtimeServerKey) ?? {})];
      for (const tool of tools) {
        for (const contribution of owners) {
          const route = this._routeForContributionTool(runtimeServerKey, contribution, tool);
          if (!route) continue;
          const existing = this._toolRouteMap.get(route.name);
          if (existing) {
            const diagnostic: McpRouteDiagnostic = {
              type: "conflict",
              toolName: route.name,
              keptRuntimeServerKey: existing.runtimeServerKey,
              droppedRuntimeServerKey: route.runtimeServerKey,
              ...(existing.contribution.contributionId ? { keptContributionId: existing.contribution.contributionId } : {}),
              ...(route.contribution.contributionId ? { droppedContributionId: route.contribution.contributionId } : {}),
            };
            this._routeDiagnostics.push(diagnostic);
            console.warn(
              `[mcp] tool route conflict for "${route.name}" — keeping ${existing.runtimeServerKey}, dropping ${route.runtimeServerKey}`,
            );
            continue;
          }
          this._toolRouteMap.set(route.name, route);
          this._toolNameMap.set(route.name, { serverName: runtimeServerKey, mcpToolName: tool.name });
        }
      }
    }

    this._routeMapDirty = false;
  }

  private _routeForContributionTool(runtimeServerKey: string, contribution: ResolvedMcpContribution, tool: McpToolDef): McpToolRoute | undefined {
    const publicServerName = contribution.serverName;
    const name = this._makeBobbitToolName(publicServerName, tool.name);
    const parsed = parseMcpToolName(name);
    if (contribution.subNamespace && (!parsed?.sub || parsed.sub !== contribution.subNamespace)) return undefined;
    if (!this._operationSelected(contribution, tool.name, parsed?.op)) return undefined;
    return {
      name,
      runtimeServerKey,
      publicServerName,
      mcpToolName: tool.name,
      tool,
      contribution,
      group: `MCP: ${publicServerName}`,
    };
  }

  private _operationSelected(contribution: ResolvedMcpContribution, rawToolName: string, parsedOp?: string): boolean {
    const candidates = new Set([rawToolName]);
    if (parsedOp) candidates.add(parsedOp);

    if (contribution.selectedOperations !== undefined) {
      const selected = new Set(contribution.selectedOperations);
      if (![...candidates].some((name) => selected.has(name))) return false;
    }

    if (contribution.disabledOperations !== undefined) {
      const disabled = new Set(contribution.disabledOperations);
      if ([...candidates].some((name) => disabled.has(name))) return false;
    }

    return true;
  }

  /** Helper for callers that refresh external MCP tools without leaving stale rows. */
  getToolRegistrationRefresh(): McpToolRegistrationRefresh {
    return { removePrefixes: ["mcp__"], toolInfos: this.getToolInfos() };
  }

  /** Return a compact comma-separated list of parameter names, or empty string. */
  private _getParamNames(tool: McpToolDef): string {
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") return "";
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties) return "";
    return Object.keys(properties).join(", ");
  }

  /** Generate a parameter table from a tool's inputSchema. */
  private _generateToolParamDocs(tool: McpToolDef): string {
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") return "";

    const properties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) return "";

    const required = (schema.required as string[]) || [];
    const lines: string[] = [];

    lines.push("### Parameters\n");
    lines.push(
      "| Name | Type | Required | Description |",
      "|------|------|----------|-------------|",
    );

    for (const [paramName, paramSchema] of Object.entries(properties)) {
      const type = (paramSchema.type as string) || "any";
      const isRequired = required.includes(paramName);
      const description =
        (paramSchema.description as string) || "";
      lines.push(
        `| \`${paramName}\` | ${type} | ${isRequired ? "Yes" : "No"} | ${description} |`,
      );
    }

    return lines.join("\n");
  }

  /** Generate a deterministic one-line summary from a tool description. */
  private _generateSummary(description: string | undefined, toolName: string, serverName: string): string {
    if (!description) return `MCP tool ${toolName} from ${serverName}`;
    const match = description.match(/^(.+?[.!?])\s/);
    let summary = match ? match[1] : description;
    if (summary.length > 120) {
      summary = summary.slice(0, 117).replace(/\s+\S*$/, '') + '...';
    }
    return summary;
  }

  /**
   * Update the doc cache and MD file for an MCP server's tools.
   * Uses content hashing to skip regeneration when nothing changed.
   */
  private _updateDocCache(serverName: string, tools: McpToolDef[]): void {
    try {
      const dir = path.join(this.stateDir ?? bobbitStateDir(), ...this.getToolDocsRelativeDir().split(/[\\/]+/));
      fs.mkdirSync(dir, { recursive: true });

      const safeName = path.basename(serverName);
      const cacheFile = path.join(dir, `${safeName}.cache.json`);
      const mdFile = path.join(dir, `${safeName}.md`);

      // Read existing cache
      let oldCache: McpToolDocCache = {};
      try {
        oldCache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      } catch { /* no existing cache */ }

      // Build new cache
      const newCache: McpToolDocCache = {};
      const serverSummaries = new Map<string, string>();
      let changed = Object.keys(oldCache).length !== tools.length;

      for (const tool of tools) {
        const hash = crypto
          .createHash('sha256')
          .update(JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }))
          .digest('hex')
          .slice(0, 16);

        const oldEntry = oldCache[tool.name];
        let summary: string;
        if (oldEntry && oldEntry.hash === hash) {
          summary = oldEntry.summary;
        } else {
          summary = this._generateSummary(tool.description, tool.name, serverName);
          changed = true;
        }

        newCache[tool.name] = { hash, summary };
        serverSummaries.set(tool.name, summary);
      }

      // Update in-memory cache
      this._summaryCache.set(serverName, serverSummaries);

      // Write to disk only if something changed
      if (changed) {
        fs.writeFileSync(cacheFile, JSON.stringify(newCache, null, 2));

        // Generate MD file
        const mdParts: string[] = [`# ${serverName} — MCP Tool Documentation\n`];
        for (const tool of tools) {
          mdParts.push(`## ${tool.name}\n`);
          mdParts.push(`${tool.description || 'No description available.'}\n`);
          const paramDocs = this._generateToolParamDocs(tool);
          if (paramDocs) {
            mdParts.push(paramDocs + '\n');
          }
        }
        fs.writeFileSync(mdFile, mdParts.join('\n'));
      }
    } catch (err) {
      console.error(`[mcp] Failed to update doc cache for "${serverName}":`, (err as Error).message);
    }
  }

  /** Get status for all known servers (discovered + connected + errored). */
  getServerStatuses(): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];

    for (const [name, config] of this.configs) {
      const client = this.clients.get(name);
      const error = this.errors.get(name);
      const tools = this.toolDefs.get(name);

      let status: McpServerStatus["status"];
      if (error) {
        status = "error";
      } else if (client?.connected) {
        status = "connected";
      } else {
        status = "disconnected";
      }

      const group = this.connectionGroups.get(name) ?? this.discoveredConnectionGroups.get(name);
      const ownerContributions = group?.ownerContributions.map(redactMcpContribution);
      statuses.push({
        name,
        status,
        toolCount: tools?.length ?? 0,
        ...(error ? { error } : {}),
        config: redactMcpServerConfig(config),
        ...(group?.ownerContributions[0]?.origin ? { origin: group.ownerContributions[0].origin } : {}),
        ...(ownerContributions ? { ownerContributions } : {}),
        ...(group?.activeSubNamespaces ? { activeSubNamespaces: [...group.activeSubNamespaces].sort() } : {}),
      });
    }

    return statuses;
  }

  // ── Tool execution ─────────────────────────────────────────────────

  /**
   * Call an MCP tool by its prefixed Bobbit name.
   * Parses the server and tool name from the mcp__<server>__<tool> format.
   */
  async callTool(
    bobbitToolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    this._ensureRouteMapFresh();
    const route = this._toolRouteMap.get(bobbitToolName);
    if (!route) {
      // Preserve the old sub-namespace error shape for callers/tests that try a
      // namespace not owned by any installed contribution.
      const parsed = parseMcpToolName(bobbitToolName);
      if (parsed) {
        const rawMcpToolName = parsed.sub ? `${parsed.sub}__${parsed.op}` : parsed.op;
        const marketplacePublicServerKnown = [...this.connectionGroups.values()].some((group) =>
          group.ownerContributions.some((c) => c.serverName === parsed.server),
        );
        const subNamespaceKnown = parsed.sub && [...this.connectionGroups.values()].some((group) =>
          group.ownerContributions.some((c) => c.serverName === parsed.server && c.subNamespace === parsed.sub),
        );
        if (marketplacePublicServerKnown && parsed.sub && !subNamespaceKnown) {
          throw new Error(`MCP server "${parsed.server}" sub-namespace is not active for tool "${bobbitToolName}"`);
        }

        // Manual JSON MCPs historically forwarded unknown operation names to
        // the MCP server and returned its tool-call-layer isError payload. Keep
        // that compatibility without bypassing marketplace operation selection:
        // if the raw op is known locally but absent from the route map, it was
        // filtered out by namespace/selection/disablement and must stay denied.
        if (this.configs.has(parsed.server)) {
          const knownTools = this.toolDefs.get(parsed.server) ?? [];
          if (!knownTools.some((tool) => tool.name === rawMcpToolName)) {
            const fallbackRoute: McpToolRoute = {
              name: bobbitToolName,
              runtimeServerKey: parsed.server,
              publicServerName: parsed.server,
              mcpToolName: rawMcpToolName,
              tool: { name: rawMcpToolName, inputSchema: { type: "object" } },
              contribution: flatManualContribution(parsed.server, this.configs.get(parsed.server) ?? {}),
              group: `MCP: ${parsed.server}`,
            };
            return this._callRouteTool(fallbackRoute, args);
          }
        }
      }
      throw new Error(`MCP tool "${bobbitToolName}" is not available or is disabled`);
    }

    return this._callRouteTool(route, args);
  }

  private async _callRouteTool(route: McpToolRoute, args: Record<string, unknown>): Promise<McpToolResult> {
    const client = this.clients.get(route.runtimeServerKey);
    if (!client) {
      throw new Error(
        `MCP server "${route.runtimeServerKey}" is not connected`,
      );
    }

    if (!client.connected) {
      throw new Error(
        `MCP server "${route.runtimeServerKey}" is disconnected`,
      );
    }

    return this._withTimeout(
      client.callTool(route.mcpToolName, args),
      this.callToolTimeoutMs,
      `MCP tool "${route.name}"`,
    );
  }

  /**
   * Build a Bobbit tool name from server + MCP tool name, truncating if needed.
   * Registers the mapping so _parseToolName can reverse it.
   */
  private _makeBobbitToolName(serverName: string, mcpToolName: string): string {
    let fullName = `mcp__${serverName}__${mcpToolName}`;
    if (fullName.length > MAX_TOOL_NAME_LENGTH) {
      // Truncate the tool name portion, keeping the prefix and server intact
      const prefix = `mcp__${serverName}__`;
      const maxToolLen = MAX_TOOL_NAME_LENGTH - prefix.length;
      if (maxToolLen < 4) {
        // Server name itself is too long — truncate it too
        fullName = fullName.slice(0, MAX_TOOL_NAME_LENGTH);
      } else {
        fullName = prefix + mcpToolName.slice(0, maxToolLen);
      }
    }
    return fullName;
  }

}
