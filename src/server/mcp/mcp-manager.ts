import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient, expandEnvRecord } from "./mcp-client.js";
import {
  McpApprovalStore,
  validateMcpServerConfig,
  type McpApprovalClassification,
  type McpApprovalDecision,
  type McpApprovalIdentity,
} from "./mcp-approval-store.js";
import { isValidOperationSchema, parseMcpToolName } from "./mcp-meta.js";
import type {
  McpServerConfig,
  McpToolDef,
  McpToolResult,
  McpToolDocCache,
} from "./mcp-types.js";
import { bobbitConfigDir, bobbitStateDir, headquartersDir, normalProjectBobbitDir } from "../bobbit-dir.js";
import { parseCustomDirectories } from "../agent/config-directories.js";
import type { ProjectConfigReader } from "../agent/config-directories.js";
import { isHeadquartersProject, SYSTEM_PROJECT_ID } from "../agent/project-registry.js";

export interface McpDiscoveryScope {
  cwd: string;
  projectId?: string;
}

export type McpContributionScope = "server" | "global-user" | "project" | "manual" | string;
export type McpSourceAuthority = "marketplace" | "headquarters" | "user-home" | "project";
export type McpSourceTrust = "pretrusted" | "approval-required";

export interface ResolvedMcpOrigin {
  scope: McpContributionScope;
  /** Optional on resolver input for compatibility; normalized before discovery returns. */
  authority?: McpSourceAuthority;
  trust?: McpSourceTrust;
  sourceId?: string;
  file?: string;
  projectId?: string;
  projectName?: string;
  packName?: string;
  packId?: string;
  sourceUrl?: string;
  /** Internal physical path. Never persist or expose it as review metadata. */
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

export interface McpSourceSummary {
  sourceId: string;
  authority: McpSourceAuthority;
  projectId?: string;
  projectName?: string;
  file: string;
}

export type McpReviewConfig = RedactedMcpServerConfig;
export interface McpStatusDiagnostic { code: string; message: string; }

export interface EffectiveMcpDefinition {
  name: string;
  config: McpServerConfig;
  origin: ResolvedMcpOrigin;
  approval: McpApprovalClassification;
  validationError?: string;
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

export interface McpReloadOptions {
  force?: boolean;
  timeoutMs?: number;
  /** Queue one fresh reload after the active reload. Used when activation mutates while discovery is in flight. */
  queueIfInFlight?: boolean;
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
  approval?: McpApprovalClassification;
  source?: McpSourceSummary;
  reviewConfig?: McpReviewConfig;
  diagnostics?: McpStatusDiagnostic[];
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

export interface McpToolRouteSnapshot extends McpToolInfo {
  runtimeServerKey: string;
  publicServerName: string;
  contributionId?: string;
  listName: string;
  subNamespace?: string;
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

const REDACTED = "[redacted]";
const CREDENTIAL_FLAG = /(?:token|secret|password|passwd|api[-_]?key|authorization|credential|cookie)$/i;

export function redactRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) out[key] = REDACTED;
  return out;
}

export function redactUrl(raw: string): string {
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

export function redactMcpServerConfig(config: McpServerConfig): RedactedMcpServerConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) return { transport: "stdio" };
  const out: RedactedMcpServerConfig = { transport: config.url ? "http" : "stdio" };
  if (config.command) out.command = config.command;
  if (config.args) {
    const secretValues = new Set([
      ...Object.values(config.env ?? {}),
      ...Object.values(config.env ? expandEnvRecord(config.env) : {}),
      ...Object.values(config.headers ?? {}),
    ].filter(Boolean));
    let redactNext = false;
    out.args = config.args.map((arg) => {
      if (redactNext || secretValues.has(arg)) {
        redactNext = false;
        return REDACTED;
      }
      const equals = arg.match(/^(--?[^=]+)=(.*)$/);
      if (equals && CREDENTIAL_FLAG.test(equals[1])) return `${equals[1]}=${REDACTED}`;
      if (CREDENTIAL_FLAG.test(arg.replace(/^--?/, ""))) redactNext = true;
      return arg;
    });
  }
  if (config.cwd) out.cwd = config.cwd;
  if (config.url) out.url = redactUrl(config.url);
  const env = redactRecord(config.env);
  if (env) out.env = env;
  const headers = redactRecord(config.headers);
  if (headers) out.headers = headers;
  return out;
}

function safeOrigin(origin: ResolvedMcpOrigin): ResolvedMcpOrigin {
  const { path: _physicalPath, ...safe } = origin;
  if (safe.sourceUrl) safe.sourceUrl = redactUrl(safe.sourceUrl);
  return safe;
}

function redactMcpContribution(contribution: ResolvedMcpContribution): RedactedResolvedMcpContribution {
  return { ...contribution, origin: safeOrigin(contribution.origin), config: redactMcpServerConfig(contribution.config) };
}

function flatManualContribution(
  name: string,
  config: McpServerConfig,
  origin: ResolvedMcpOrigin = {
    scope: "manual",
    authority: "headquarters",
    trust: "pretrusted",
    sourceId: "programmatic-manual",
    file: "Runtime configuration",
  },
): ResolvedMcpContribution {
  return { listName: name, serverName: name, config, origin };
}

interface ResolvedManualServer {
  config: McpServerConfig;
  origin: ResolvedMcpOrigin;
}

export function canonicalCustomDirLocator(declaredPath: string): string {
  let locator = declaredPath.trim().replace(/\\/g, "/");
  const driveAbsolute = /^[A-Za-z]:\//.test(locator);
  const uncAbsolute = locator.startsWith("//");
  const posixAbsolute = locator.startsWith("/") && !uncAbsolute;
  const tilde = locator === "~" || locator.startsWith("~/");
  locator = uncAbsolute
    ? `//${path.posix.normalize(locator.slice(2) || ".")}`
    : path.posix.normalize(locator || ".");
  if (driveAbsolute) locator = `${locator[0].toLowerCase()}${locator.slice(1)}`;
  if (process.platform === "win32" && (driveAbsolute || uncAbsolute || posixAbsolute)) locator = locator.toLowerCase();
  if (tilde && locator === ".") return "~";
  return locator;
}

function customDirectorySourceId(declaredPath: string): string {
  const digest = crypto.createHash("sha256").update(canonicalCustomDirLocator(declaredPath)).digest("hex");
  return `project-custom-dir:v1:${digest}:.mcp.json`;
}

function normalizedMarketplaceOrigin(contribution: ResolvedMcpContribution): ResolvedMcpOrigin {
  const origin = contribution.origin ?? { scope: "manual" };
  return {
    ...origin,
    authority: "marketplace",
    trust: "pretrusted",
    sourceId: origin.sourceId ?? contribution.contributionId ?? origin.packId ?? `marketplace:${contribution.listName}`,
    file: origin.file ?? `${origin.packName ?? "Marketplace pack"}/${origin.path ? path.basename(origin.path) : contribution.listName}`,
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
  private queuedReloadPromise: Promise<McpReloadResult> | undefined;
  private queuedReloadStarted = false;
  private marketplaceResolver: MarketplaceMcpResolver | null = null;
  private readonly discoveryScope: McpDiscoveryScope;
  /** Maps public Bobbit tool names to their authoritative runtime route. */
  private _toolRouteMap = new Map<string, McpToolRoute>();
  private _routeDiagnostics: McpRouteDiagnostic[] = [];
  private _discoveryDiagnostics: McpStatusDiagnostic[] = [];
  private _routeMapDirty = true;
  /** Maps truncated Bobbit tool names back to original MCP tool names. Kept for legacy tests/introspection. */
  private _toolNameMap = new Map<string, { serverName: string; mcpToolName: string }>();
  /** In-memory cache: runtimeServerKey → toolName → summary */
  private _summaryCache = new Map<string, Map<string, string>>();

  private projectConfigStore: ProjectConfigReader | null;
  private additionalProjects: Array<{projectId?: string; projectName?: string; cwd: string; configStore: ProjectConfigReader}> = [];
  private stateDir: string | undefined;
  private readonly scopeKey: string;
  private approvalStore: McpApprovalStore | undefined;
  private readonly projectName?: string;

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
      projectName?: string;
      approvalStore?: McpApprovalStore;
    },
  ) {
    this.projectConfigStore = projectConfigStore ?? null;
    this.stateDir = stateDir;
    this.approvalStore = opts?.approvalStore;
    this.projectName = opts?.projectName;
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
  setAdditionalProjects(projects: Array<{projectId?: string; projectName?: string; cwd: string; configStore: ProjectConfigReader}>): void {
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
    for (const [name, resolved] of manual) {
      // Manual definitions have always won public-name route conflicts. Apply
      // that precedence before eligibility so a denied higher definition cannot
      // reveal and start a lower Marketplace fallback.
      for (const [runtimeKey, group] of [...byServer]) {
        const remainingOwners = group.ownerContributions.filter((owner) => owner.serverName !== name);
        if (runtimeKey === name || remainingOwners.length === 0) {
          byServer.delete(runtimeKey);
        } else if (remainingOwners.length !== group.ownerContributions.length) {
          byServer.set(runtimeKey, {
            ...group,
            ownerContributions: remainingOwners,
            activeSubNamespaces: remainingOwners.some((owner) => !owner.subNamespace)
              ? undefined
              : new Set(remainingOwners.map((owner) => owner.subNamespace!)),
          });
        }
      }
      byServer.set(name, {
        serverName: name,
        runtimeServerKey: name,
        config: resolved.config,
        ownerContributions: [flatManualContribution(name, resolved.config, resolved.origin)],
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
      }).map((c) => ({
        ...c,
        runtimeServerKey: c.runtimeServerKey ?? c.serverName,
        origin: normalizedMarketplaceOrigin(c),
      }));
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
      const contrib = {
        ...rawContrib,
        runtimeServerKey: rawContrib.runtimeServerKey ?? rawContrib.serverName,
        origin: normalizedMarketplaceOrigin(rawContrib),
      };
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

  private _sourceOrigin(
    projectId: string | undefined,
    projectName: string | undefined,
    sourceId: string,
    file: string,
    physicalPath: string,
  ): ResolvedMcpOrigin {
    const headquarters = (!!projectId && (isHeadquartersProject(projectId) || projectId === SYSTEM_PROJECT_ID))
      || (!projectId && path.resolve(this.cwd) === path.resolve(headquartersDir()));
    return {
      scope: "manual",
      authority: headquarters ? "headquarters" : "project",
      trust: headquarters ? "pretrusted" : "approval-required",
      sourceId,
      file,
      ...(projectId ? { projectId } : {}),
      ...(projectName ? { projectName } : {}),
      path: physicalPath,
    };
  }

  private _discoverManualServers(): Map<string, ResolvedManualServer> {
    const merged = new Map<string, ResolvedManualServer>();
    this._discoveryDiagnostics = [];
    const primaryId = this.discoveryScope.projectId;

    // 0. Custom directories (lowest priority — merged first, overridden by everything).
    if (this.projectConfigStore) {
      for (const dir of parseCustomDirectories(this.projectConfigStore).filter((entry) => entry.types.includes("mcp"))) {
        const filePath = path.join(dir.path, ".mcp.json");
        const declaredPath = dir.declaredPath ?? dir.path;
        this._mergeConfigFile(merged, filePath, this._sourceOrigin(
          primaryId,
          this.projectName,
          customDirectorySourceId(declaredPath),
          `${canonicalCustomDirLocator(declaredPath)}/.mcp.json`,
          filePath,
        ));
      }
    }

    // 0b. Additional registered projects (low priority — overridden by user and primary project).
    for (const proj of this.additionalProjects) {
      for (const dir of parseCustomDirectories(proj.configStore).filter((entry) => entry.types.includes("mcp"))) {
        const filePath = path.join(dir.path, ".mcp.json");
        const declaredPath = dir.declaredPath ?? dir.path;
        this._mergeConfigFile(merged, filePath, this._sourceOrigin(
          proj.projectId,
          proj.projectName,
          customDirectorySourceId(declaredPath),
          `${canonicalCustomDirLocator(declaredPath)}/.mcp.json`,
          filePath,
        ));
      }
      this._mergeConfigFile(merged, path.join(proj.cwd, ".mcp.json"), this._sourceOrigin(proj.projectId, proj.projectName, "project-file:.mcp.json", ".mcp.json", path.join(proj.cwd, ".mcp.json")));
      this._mergeConfigFile(merged, path.join(proj.cwd, ".claude", ".mcp.json"), this._sourceOrigin(proj.projectId, proj.projectName, "project-file:.claude/.mcp.json", ".claude/.mcp.json", path.join(proj.cwd, ".claude", ".mcp.json")));
      this._mergeConfigFile(merged, path.join(proj.cwd, ".bobbit", "config", "mcp.json"), this._sourceOrigin(proj.projectId, proj.projectName, "project-file:.bobbit/config/mcp.json", ".bobbit/config/mcp.json", path.join(proj.cwd, ".bobbit", "config", "mcp.json")));
    }

    const home = os.homedir();
    const userOrigin = (sourceId: string, file: string, physicalPath: string): ResolvedMcpOrigin => ({
      scope: "manual", authority: "user-home", trust: "pretrusted", sourceId, file, path: physicalPath,
    });
    this._mergeConfigFile(merged, path.join(home, ".claude.json"), userOrigin("user-home:.claude.json", "~/.claude.json", path.join(home, ".claude.json")));
    this._mergeProjectConfigFromClaudeJson(merged, path.join(home, ".claude.json"), userOrigin("user-home:.claude.json:project", "~/.claude.json (project entry)", path.join(home, ".claude.json")));
    this._mergeConfigFile(merged, path.join(home, ".claude", ".mcp.json"), userOrigin("user-home:.claude/.mcp.json", "~/.claude/.mcp.json", path.join(home, ".claude", ".mcp.json")));
    this._mergeConfigFile(merged, path.join(home, ".bobbit", ".mcp.json"), userOrigin("user-home:.bobbit/.mcp.json", "~/.bobbit/.mcp.json", path.join(home, ".bobbit", ".mcp.json")));

    this._mergeConfigFile(merged, path.join(this.cwd, ".mcp.json"), this._sourceOrigin(primaryId, this.projectName, "project-file:.mcp.json", ".mcp.json", path.join(this.cwd, ".mcp.json")));
    this._mergeConfigFile(merged, path.join(this.cwd, ".claude", ".mcp.json"), this._sourceOrigin(primaryId, this.projectName, "project-file:.claude/.mcp.json", ".claude/.mcp.json", path.join(this.cwd, ".claude", ".mcp.json")));

    const headquartersPath = path.join(bobbitConfigDir(), "mcp.json");
    this._mergeConfigFile(merged, headquartersPath, {
      scope: "manual", authority: "headquarters", trust: "pretrusted",
      sourceId: "headquarters:mcp.json", file: "Headquarters config/mcp.json", path: headquartersPath,
    });
    if (primaryId && !isHeadquartersProject(primaryId) && primaryId !== SYSTEM_PROJECT_ID) {
      const projectFile = path.join(normalProjectBobbitDir(this.cwd), "config", "mcp.json");
      this._mergeConfigFile(merged, projectFile, this._sourceOrigin(primaryId, this.projectName, "project-file:.bobbit/config/mcp.json", ".bobbit/config/mcp.json", projectFile));
    }

    return merged;
  }

  /** Read a JSON config file and merge its servers into the target. */
  private _mergeConfigFile(target: Map<string, ResolvedManualServer>, filePath: string, origin: ResolvedMcpOrigin): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const servers: Record<string, McpServerConfig> | undefined = parsed.mcpServers;
      if (servers && typeof servers === "object" && !Array.isArray(servers)) {
        for (const [name, config] of Object.entries(servers)) {
          target.set(name, { config: config as McpServerConfig, origin });
        }
      }
    } catch {
      this._discoveryDiagnostics.push({ code: "MCP_CONFIG_PARSE_FAILED", message: `Could not parse MCP configuration from ${origin.file ?? "the configured source"}.` });
      console.error(`[mcp] MCP_CONFIG_PARSE_FAILED (${origin.file ?? "unknown source"})`);
    }
  }

  private _mergeProjectConfigFromClaudeJson(
    target: Map<string, ResolvedManualServer>,
    filePath: string,
    origin: ResolvedMcpOrigin,
  ): void {
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const projects = parsed.projects;
      if (!projects || typeof projects !== "object") return;
      const normalize = (value: string) => {
        let normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
        if (process.platform === "win32") normalized = normalized.toLowerCase();
        return normalized;
      };
      const cwd = normalize(this.cwd);
      for (const [projectPath, projectConfig] of Object.entries(projects)) {
        if (normalize(projectPath) !== cwd) continue;
        const servers = (projectConfig as { mcpServers?: unknown })?.mcpServers;
        if (servers && typeof servers === "object" && !Array.isArray(servers)) {
          for (const [name, config] of Object.entries(servers)) {
            target.set(name, { config: config as McpServerConfig, origin });
          }
        }
        break;
      }
    } catch {
      this._discoveryDiagnostics.push({ code: "MCP_CONFIG_PARSE_FAILED", message: `Could not parse MCP configuration from ${origin.file ?? "the configured source"}.` });
      console.error(`[mcp] MCP_CONFIG_PARSE_FAILED (${origin.file ?? "unknown source"})`);
    }
  }

  getDiscoveryDiagnostics(): McpStatusDiagnostic[] {
    return this._discoveryDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  // ── Connection lifecycle ───────────────────────────────────────────

  private _getApprovalStore(): McpApprovalStore {
    return this.approvalStore ??= new McpApprovalStore(this.stateDir ?? bobbitStateDir());
  }

  private _definitionForGroup(group: ResolvedMcpConnectionGroup): EffectiveMcpDefinition {
    const origin = group.ownerContributions[0]?.origin ?? flatManualContribution(group.serverName, group.config).origin;
    const trust = origin.trust ?? (origin.authority === "marketplace" ? "pretrusted" : "approval-required");
    const sourceId = origin.sourceId ?? `unattributed:${group.serverName}`;
    const validationError = validateMcpServerConfig(group.config);
    const approval: McpApprovalClassification = trust === "pretrusted"
      ? { required: false, state: "trusted" }
      : validationError
        ? { required: true, state: "pending" }
        : this._getApprovalStore().classify({
          projectId: origin.projectId,
          sourceId,
          serverName: group.serverName,
          trust,
          config: group.config,
        });
    return {
      name: group.serverName,
      config: group.config,
      origin: { ...origin, trust, sourceId },
      approval,
      ...(validationError ? { validationError } : {}),
    };
  }

  private _isEligible(group: ResolvedMcpConnectionGroup): boolean {
    const definition = this._definitionForGroup(group);
    return !definition.validationError && (definition.approval.state === "trusted" || definition.approval.state === "approved");
  }

  private _isStillEligible(group: ResolvedMcpConnectionGroup): boolean {
    const current = this.discoveredConnectionGroups.get(group.serverName);
    if (!current) return group.ownerContributions[0]?.origin.sourceId === "programmatic-manual" && this._isEligible(group);
    if (this._fingerprintGroup(current) !== this._fingerprintGroup(group)) return false;
    return this._isEligible(current);
  }

  /** Freshly discover the effective winner used to validate an approval request. */
  getEffectiveDefinitionForDecision(name: string): EffectiveMcpDefinition | undefined {
    this.discoverConnectionGroups();
    const group = this.discoveredConnectionGroups.get(name);
    return group ? this._definitionForGroup(group) : undefined;
  }

  async decideApproval(identity: McpApprovalIdentity, decision: McpApprovalDecision): Promise<EffectiveMcpDefinition> {
    const current = this.getEffectiveDefinitionForDecision(identity.serverName);
    if (!current || current.origin.projectId !== identity.projectId || current.origin.sourceId !== identity.sourceId) {
      throw Object.assign(new Error("The MCP server configuration changed while it was being reviewed."), { code: "MCP_APPROVAL_STALE" });
    }
    if (current.origin.trust !== "approval-required") {
      throw Object.assign(new Error("This MCP server source does not require approval."), { code: "MCP_APPROVAL_NOT_REQUIRED" });
    }
    if (current.validationError) {
      throw Object.assign(new Error(current.validationError), { code: "MCP_CONFIG_INVALID" });
    }
    if (current.approval.fingerprint !== identity.fingerprint) {
      throw Object.assign(new Error("The MCP server configuration changed while it was being reviewed."), { code: "MCP_APPROVAL_STALE" });
    }
    await this._getApprovalStore().decide(identity, decision);
    return this._definitionForGroup(this.discoveredConnectionGroups.get(identity.serverName)!);
  }

  /** Reconcile one server through the same discovery and approval gate as normal startup. */
  async restartDiscoveredServer(name: string): Promise<McpServerStatus | undefined> {
    await this.reloadDiscoveredServers({ force: true, queueIfInFlight: true, timeoutMs: 0 });
    return this.getServerStatuses().find((status) => status.name === name);
  }

  /** Connect a discovered server without allowing callers to supply a fallback definition. */
  async connectServer(name: string, _config?: McpServerConfig): Promise<void> {
    const desiredGroup = this.discoveredConnectionGroups.get(name);
    if (!desiredGroup || !this._isEligible(desiredGroup)) {
      await this.disconnectServer(name, { runtimeOnly: true });
      return;
    }
    await this._connectEligibleServer(name, desiredGroup);
  }

  /** Explicit seam for trusted programmatic definitions and isolated client tests. */
  async connectPretrustedServer(name: string, config: McpServerConfig): Promise<void> {
    const group: ResolvedMcpConnectionGroup = {
      serverName: name,
      runtimeServerKey: name,
      config,
      ownerContributions: [flatManualContribution(name, config)],
    };
    await this._connectEligibleServer(name, group);
  }

  private async _connectEligibleServer(name: string, desiredGroup: ResolvedMcpConnectionGroup): Promise<void> {
    const config = desiredGroup.config;
    if (this.clients.has(name)) await this.disconnectServer(name);

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
      // A concurrent rejection/configuration change during initialize must not
      // reach tools/list or publish a stale route.
      if (!this._isStillEligible(desiredGroup)) {
        await this.disconnectServer(name, { runtimeOnly: true });
        return;
      }

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

      if (!this._isStillEligible(desiredGroup)) {
        await this.disconnectServer(name, { runtimeOnly: true });
        return;
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
    const origin = group.ownerContributions[0]?.origin;
    return stableFingerprint({
      runtimeServerKey: group.runtimeServerKey,
      config: group.config,
      sourceId: origin?.sourceId,
      projectId: origin?.projectId,
      authority: origin?.authority,
      trust: origin?.trust,
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

  async reloadDiscoveredServers(opts?: McpReloadOptions): Promise<McpReloadResult> {
    const force = opts?.force === true;
    const reload = this._reloadPromiseForRequest(force, opts?.queueIfInFlight === true);

    const timeoutMs = opts?.timeoutMs ?? 30_000;
    if (timeoutMs <= 0) return reload;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<McpReloadResult>((resolve) => {
      timer = setTimeout(() => resolve(this._pendingReloadResult()), timeoutMs);
    });
    return Promise.race([reload, pending]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private _reloadPromiseForRequest(force: boolean, queueIfInFlight: boolean): Promise<McpReloadResult> {
    if (!this.reloadPromise) {
      this.reloadPromise = this._makeReloadPromise(force);
      return this.reloadPromise;
    }
    if (!queueIfInFlight) return this.reloadPromise;
    if (!this.queuedReloadPromise || this.queuedReloadStarted) {
      const previous = this.reloadPromise;
      let queued!: Promise<McpReloadResult>;
      queued = previous
        .catch(() => undefined)
        .then(() => {
          if (this.queuedReloadPromise === queued) this.queuedReloadStarted = true;
          return this._reloadDiscoveredServers(force);
        })
        .finally(() => {
          if (this.queuedReloadPromise === queued) {
            this.queuedReloadPromise = undefined;
            this.queuedReloadStarted = false;
          }
          if (this.reloadPromise === queued) this.reloadPromise = undefined;
        });
      this.queuedReloadPromise = queued;
      this.queuedReloadStarted = false;
      this.reloadPromise = queued;
    }
    return this.queuedReloadPromise;
  }

  private _makeReloadPromise(force: boolean): Promise<McpReloadResult> {
    let promise!: Promise<McpReloadResult>;
    promise = this._reloadDiscoveredServers(force)
      .finally(() => {
        if (this.reloadPromise === promise) this.reloadPromise = undefined;
      });
    return promise;
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

    for (const name of [...new Set([...this.configs.keys(), ...this.clients.keys()])]) {
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

      if (!this._isEligible(group)) {
        if (this.clients.has(name) || this.configs.has(name)) {
          await this.disconnectServer(name, { runtimeOnly: true });
          disconnected.push(name);
        }
        return;
      }

      if (!force && unchangedConfig) {
        // The connection can stay up, but ownership metadata may have changed.
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
      await this._connectEligibleServer(name, group);
      if (this.errors.has(name)) failed.push({ name, error: this.errors.get(name)! });
      else if (this.clients.get(name)?.connected) connected.push(name);
    }));

    let status: McpReloadStatus = "ok";
    if (failed.length > 0) {
      status = connected.length > 0 || unchanged.length > 0 || skippedErrored.length > 0 || disconnected.length > 0 ? "partial" : "error";
    }

    return { status, connected, disconnected, unchanged, skippedErrored, failed, statuses: this.getServerStatuses() };
  }

  /** Disconnect a specific server and remove its cached state. */
  async disconnectServer(name: string, opts?: { forget?: boolean; runtimeOnly?: boolean }): Promise<void> {
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
    if (opts?.forget || opts?.runtimeOnly) {
      this.configs.delete(name);
      this.connectionGroups.delete(name);
      this.serverFingerprints.delete(name);
      if (opts.forget) this.discoveredConnectionGroups.delete(name);
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

  getToolRouteSnapshots(): McpToolRouteSnapshot[] {
    this._ensureRouteMapFresh();
    return [...this._toolRouteMap.values()].map((route) => {
      const summary = this._summaryCache.get(route.runtimeServerKey)?.get(route.mcpToolName);
      const paramNames = this._getParamNames(route.tool);
      const docs = paramNames ? `Parameters: ${paramNames}` : undefined;
      return {
        name: route.name,
        description: route.tool.description || `MCP tool ${route.mcpToolName} from ${route.publicServerName}`,
        group: route.group,
        docs,
        summary,
        serverName: route.publicServerName,
        mcpToolName: route.mcpToolName,
        inputSchema: route.tool.inputSchema as Record<string, unknown>,
        runtimeServerKey: route.runtimeServerKey,
        publicServerName: route.publicServerName,
        ...(route.contribution.contributionId ? { contributionId: route.contribution.contributionId } : {}),
        listName: route.contribution.listName,
        ...(route.contribution.subNamespace ? { subNamespace: route.contribution.subNamespace } : {}),
      };
    });
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

    const precedence = this._buildRoutePrecedenceRanks();
    const candidates: Array<{ route: McpToolRoute; rank: number; ownerIndex: number; toolIndex: number }> = [];

    for (const [runtimeServerKey, tools] of this.toolDefs) {
      const group = this.connectionGroups.get(runtimeServerKey) ?? this.discoveredConnectionGroups.get(runtimeServerKey);
      const owners = this._routeOwnersForRuntimeGroup(runtimeServerKey, group);
      tools.forEach((tool, toolIndex) => {
        owners.forEach((contribution, ownerIndex) => {
          const route = this._routeForContributionTool(runtimeServerKey, contribution, tool, owners.length);
          if (!route) return;
          candidates.push({
            route,
            rank: precedence.get(this._contributionPrecedenceKey(runtimeServerKey, contribution)) ?? Number.MAX_SAFE_INTEGER,
            ownerIndex,
            toolIndex,
          });
        });
      });
    }

    candidates.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const runtime = a.route.runtimeServerKey.localeCompare(b.route.runtimeServerKey);
      if (runtime !== 0) return runtime;
      if (a.ownerIndex !== b.ownerIndex) return a.ownerIndex - b.ownerIndex;
      if (a.toolIndex !== b.toolIndex) return a.toolIndex - b.toolIndex;
      return a.route.name.localeCompare(b.route.name);
    });

    for (const { route } of candidates) {
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
      this._toolNameMap.set(route.name, { serverName: route.runtimeServerKey, mcpToolName: route.mcpToolName });
    }

    this._routeMapDirty = false;
  }

  private _buildRoutePrecedenceRanks(): Map<string, number> {
    const ranks = new Map<string, number>();
    let rank = 0;
    const groups: Array<[string, ResolvedMcpConnectionGroup]> = [
      ...this.discoveredConnectionGroups,
      ...this.connectionGroups,
    ];
    const addGroup = (runtimeServerKey: string, group: ResolvedMcpConnectionGroup | undefined, manual: boolean) => {
      if (!group?.ownerContributions?.length) return;
      for (const contribution of group.ownerContributions) {
        if ((contribution.origin?.scope === "manual") !== manual) continue;
        const key = this._contributionPrecedenceKey(runtimeServerKey, contribution);
        if (!ranks.has(key)) ranks.set(key, rank++);
      }
    };

    // Manual JSON MCPs preserve legacy behavior and must win public-name
    // conflicts over marketplace/gateway contributions. Marketplace order then
    // remains deterministic for gateway-vs-gateway conflicts.
    for (const [runtimeServerKey, group] of groups) addGroup(runtimeServerKey, group, true);
    for (const [runtimeServerKey, group] of groups) addGroup(runtimeServerKey, group, false);
    return ranks;
  }

  private _contributionPrecedenceKey(runtimeServerKey: string, contribution: ResolvedMcpContribution): string {
    const origin = contribution.origin ?? { scope: "manual" };
    return [
      contribution.contributionId ?? "",
      runtimeServerKey,
      contribution.runtimeServerKey ?? "",
      contribution.serverName,
      contribution.listName,
      contribution.subNamespace ?? "",
      origin.scope ?? "",
      origin.packId ?? "",
      origin.packName ?? "",
      origin.sourceUrl ?? "",
      origin.path ?? "",
    ].join("\0");
  }

  private _routeOwnersForRuntimeGroup(runtimeServerKey: string, group: ResolvedMcpConnectionGroup | undefined): ResolvedMcpContribution[] {
    if (group?.ownerContributions?.length) return group.ownerContributions;
    const config = group?.config ?? this.configs.get(runtimeServerKey) ?? {};
    if (group?.activeSubNamespaces?.size) {
      return [...group.activeSubNamespaces]
        .sort()
        .map((subNamespace) => ({
          ...flatManualContribution(runtimeServerKey, config),
          runtimeServerKey,
          subNamespace,
        }));
    }
    return [flatManualContribution(runtimeServerKey, config)];
  }

  private _routeForContributionTool(runtimeServerKey: string, contribution: ResolvedMcpContribution, tool: McpToolDef, ownerCount = 1): McpToolRoute | undefined {
    const publicServerName = contribution.serverName;
    const publicMcpToolName = this._publicMcpToolNameForContribution(contribution, tool.name, ownerCount);
    if (!publicMcpToolName) return undefined;
    const name = this._makeBobbitToolName(publicServerName, publicMcpToolName);
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

  private _publicMcpToolNameForContribution(contribution: ResolvedMcpContribution, rawToolName: string, ownerCount: number): string | undefined {
    const subNamespace = contribution.subNamespace;
    if (!subNamespace) return rawToolName;

    const prefix = `${subNamespace}__`;
    if (rawToolName.startsWith(prefix) && rawToolName.length > prefix.length) {
      return rawToolName;
    }

    // Gateway sub-namespace contributions may expose raw, unprefixed operation
    // names. Publish them under Bobbit's package namespace while preserving the
    // raw MCP call name. A shared gateway endpoint can list sibling package
    // operations, so gateway packages must prove ownership by selected operation
    // metadata or the sub-namespace naming heuristic even when only one package
    // is installed. Non-gateway sub-namespace contributions keep the legacy
    // single-owner fallback for backwards compatibility.
    if (!rawToolName.includes("__")) {
      const selectedByContribution = contribution.selectedOperations?.includes(rawToolName) ?? false;
      const looksOwnedBySubNamespace = this._rawToolNameLooksOwnedBySubNamespace(subNamespace, rawToolName);
      const legacySingleOwnerFallback = ownerCount <= 1 && !this._isGatewaySubNamespaceContribution(contribution);
      if (legacySingleOwnerFallback || selectedByContribution || looksOwnedBySubNamespace) {
        return `${subNamespace}__${rawToolName}`;
      }
    }

    return undefined;
  }

  private _isGatewaySubNamespaceContribution(contribution: ResolvedMcpContribution): boolean {
    return Boolean(
      contribution.subNamespace
      && contribution.contributionId
      && contribution.contributionId !== contribution.listName
      && contribution.runtimeServerKey
      && contribution.runtimeServerKey !== contribution.serverName,
    );
  }

  private _rawToolNameLooksOwnedBySubNamespace(subNamespace: string, rawToolName: string): boolean {
    return rawToolName.startsWith(`${subNamespace}_`) || rawToolName.startsWith(`${subNamespace}-`);
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

  private _manualFallbackRuntimeKey(publicServerName: string): string | undefined {
    const isManualOnlyGroup = (group: ResolvedMcpConnectionGroup | undefined): boolean => {
      if (!group?.ownerContributions?.length) return true;
      return group.ownerContributions.some((c) => c.serverName === publicServerName && c.origin.scope === "manual");
    };

    const direct = this.connectionGroups.get(publicServerName) ?? this.discoveredConnectionGroups.get(publicServerName);
    if (this.configs.has(publicServerName) && isManualOnlyGroup(direct)) return publicServerName;

    for (const [runtimeServerKey, group] of this.connectionGroups) {
      if (group.serverName === publicServerName && isManualOnlyGroup(group)) return runtimeServerKey;
      if (group.ownerContributions.some((c) => c.serverName === publicServerName && c.origin.scope === "manual")) {
        return runtimeServerKey;
      }
    }
    return undefined;
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

  /** Get status for all effective winners, including definitions denied runtime eligibility. */
  getServerStatuses(): McpServerStatus[] {
    const statuses: McpServerStatus[] = [];
    const names = new Set([...this.discoveredConnectionGroups.keys(), ...this.configs.keys()]);

    for (const name of names) {
      const group = this.discoveredConnectionGroups.get(name) ?? this.connectionGroups.get(name);
      const config = group?.config ?? this.configs.get(name);
      if (!group || !config) continue;
      const definition = this._definitionForGroup(group);
      const eligible = !definition.validationError
        && (definition.approval.state === "trusted" || definition.approval.state === "approved");
      const client = this.clients.get(name);
      const error = eligible ? this.errors.get(name) : undefined;
      const tools = eligible ? this.toolDefs.get(name) : undefined;
      const origin = safeOrigin(definition.origin);
      const diagnostics: McpStatusDiagnostic[] = [];
      if (definition.validationError) {
        diagnostics.push({ code: "MCP_CONFIG_INVALID", message: definition.validationError });
      } else if (definition.approval.state === "pending") {
        diagnostics.push({ code: "MCP_APPROVAL_PENDING", message: "Server startup is awaiting approval." });
      } else if (definition.approval.state === "rejected") {
        diagnostics.push({ code: "MCP_APPROVAL_REJECTED", message: "Server startup was rejected." });
      } else if (definition.approval.state === "changed") {
        diagnostics.push({ code: "MCP_APPROVAL_CHANGED", message: "The server configuration changed and must be reviewed again." });
      }

      statuses.push({
        name,
        status: error ? "error" : client?.connected && eligible ? "connected" : "disconnected",
        toolCount: tools?.length ?? 0,
        ...(error ? { error } : {}),
        config: redactMcpServerConfig(config),
        origin,
        approval: definition.approval,
        source: {
          sourceId: definition.origin.sourceId!,
          authority: definition.origin.authority ?? "project",
          ...(definition.origin.projectId ? { projectId: definition.origin.projectId } : {}),
          ...(definition.origin.projectName ? { projectName: definition.origin.projectName } : {}),
          file: definition.origin.file ?? "Unknown source",
        },
        ...(definition.approval.required ? { reviewConfig: redactMcpServerConfig(config) } : {}),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
        ownerContributions: group.ownerContributions.map(redactMcpContribution),
        ...(group.activeSubNamespaces ? { activeSubNamespaces: [...group.activeSubNamespaces].sort() } : {}),
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
        const manualFallbackRuntimeKey = this._manualFallbackRuntimeKey(parsed.server);
        if (manualFallbackRuntimeKey) {
          const knownTools = this.toolDefs.get(manualFallbackRuntimeKey) ?? [];
          if (!knownTools.some((tool) => tool.name === rawMcpToolName)) {
            const fallbackRoute: McpToolRoute = {
              name: bobbitToolName,
              runtimeServerKey: manualFallbackRuntimeKey,
              publicServerName: parsed.server,
              mcpToolName: rawMcpToolName,
              tool: { name: rawMcpToolName, inputSchema: { type: "object" } },
              contribution: flatManualContribution(parsed.server, this.configs.get(manualFallbackRuntimeKey) ?? {}),
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
    const group = this.connectionGroups.get(route.runtimeServerKey);
    if (!group || !this._isEligible(group)) {
      await this.disconnectServer(route.runtimeServerKey, { runtimeOnly: true });
      throw new Error(`MCP server "${route.runtimeServerKey}" is not approved to run`);
    }
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
