import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient } from "./mcp-client.js";
import type {
  McpServerConfig,
  McpToolDef,
  McpToolResult,
  McpToolDocCache,
} from "./mcp-types.js";
import { bobbitConfigDir, bobbitStateDir } from "../bobbit-dir.js";
import { parseCustomDirectories } from "../agent/config-directories.js";
import type { ProjectConfigReader } from "../agent/config-directories.js";

/** Status of an MCP server */
export interface McpServerStatus {
  name: string;
  status: "connected" | "disconnected" | "error";
  toolCount: number;
  error?: string;
  config?: McpServerConfig;
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

export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolDefs = new Map<string, McpToolDef[]>();
  private configs = new Map<string, McpServerConfig>();
  private errors = new Map<string, string>();
  /** Maps truncated Bobbit tool names back to original MCP tool names. */
  private _toolNameMap = new Map<string, { serverName: string; mcpToolName: string }>();
  /** In-memory cache: serverName → toolName → summary */
  private _summaryCache = new Map<string, Map<string, string>>();

  private projectConfigStore: ProjectConfigReader | null;
  private additionalProjects: Array<{cwd: string, configStore: ProjectConfigReader}> = [];
  private stateDir: string | undefined;

  constructor(private cwd: string, projectConfigStore?: ProjectConfigReader, stateDir?: string) {
    this.projectConfigStore = projectConfigStore ?? null;
    this.stateDir = stateDir;
  }

  /** Register additional project directories for MCP server discovery. */
  setAdditionalProjects(projects: Array<{cwd: string, configStore: ProjectConfigReader}>): void {
    this.additionalProjects = projects;
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
      // Custom directories from the project's config
      const projCustomDirs = parseCustomDirectories(proj.configStore)
        .filter(d => d.types.includes("mcp"));
      for (const dir of projCustomDirs) {
        this._mergeConfigFile(merged, path.join(dir.path, ".mcp.json"), "mcpServers");
      }
      // Project-scoped built-in MCP locations
      this._mergeConfigFile(merged, path.join(proj.cwd, ".mcp.json"), "mcpServers");
      this._mergeConfigFile(merged, path.join(proj.cwd, ".claude", ".mcp.json"), "mcpServers");
      this._mergeConfigFile(merged, path.join(proj.cwd, ".bobbit", "config", "mcp.json"), "mcpServers");
    }

    // Discovery mirrors the same root directories used for skills.
    // Later entries override earlier ones (lowest → highest priority):
    //   1. ~/.claude.json          — legacy Claude Code user config
    //   2. ~/.claude/.mcp.json     — Claude Code user-level MCP
    //   3. ~/.bobbit/.mcp.json     — Bobbit user-level MCP
    //   4. <project>/.mcp.json     — project scope (shared via git)
    //   5. <project>/.claude/.mcp.json — Claude Code project-level MCP
    //   6. <project>/.bobbit/config/mcp.json — Bobbit project overrides

    const home = os.homedir();
    // User scope
    this._mergeConfigFile(merged, path.join(home, ".claude.json"), "mcpServers");
    this._mergeProjectConfigFromClaudeJson(merged, path.join(home, ".claude.json"));
    this._mergeConfigFile(merged, path.join(home, ".claude", ".mcp.json"), "mcpServers");
    this._mergeConfigFile(merged, path.join(home, ".bobbit", ".mcp.json"), "mcpServers");

    // Project scope
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
    // Disconnect existing client for this server if any
    if (this.clients.has(name)) {
      await this.disconnectServer(name);
    }

    this.configs.set(name, config);
    this.errors.delete(name);

    const client = new McpClient(name);
    try {
      await client.connect(config);
      this.clients.set(name, client);

      // Fetch and cache tool definitions
      const tools = await client.listTools();
      this.toolDefs.set(name, tools);

      // Generate/update doc cache and summaries
      this._updateDocCache(name, tools);

      console.log(
        `[mcp] Connected to server "${name}" — ${tools.length} tool(s) available`,
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
    }
  }

  /**
   * Discover all MCP servers and connect to them.
   * Partial failure is tolerated — failed servers are logged and skipped.
   */
  async connectAll(): Promise<void> {
    const servers = this.discoverServers();
    const names = Object.keys(servers);
    if (names.length === 0) {
      console.log("[mcp] No MCP servers discovered");
      return;
    }

    console.log(`[mcp] Discovered ${names.length} MCP server(s): ${names.join(", ")}`);

    await Promise.all(
      names.map((name) => this.connectServer(name, servers[name])),
    );
  }

  /** Disconnect a specific server and remove its cached state. */
  async disconnectServer(name: string): Promise<void> {
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
  }

  /** Disconnect all connected servers. */
  async disconnectAll(): Promise<void> {
    const names = [...this.clients.keys()];
    await Promise.all(names.map((name) => this.disconnectServer(name)));
    this.configs.clear();
  }

  // ── Tool queries ───────────────────────────────────────────────────

  /**
   * Get all MCP tools as Bobbit-compatible tool info objects.
   * Tool names use double-underscore separator: mcp__<server>__<tool>
   */
  getToolInfos(): McpToolInfo[] {
    const infos: McpToolInfo[] = [];

    for (const [serverName, tools] of this.toolDefs) {
      for (const tool of tools) {
        const summary = this._summaryCache.get(serverName)?.get(tool.name);
        const fullDesc = tool.description || `MCP tool ${tool.name} from ${serverName}`;
        const paramDocs = this._generateToolParamDocs(tool);
        const docs = paramDocs ? `${fullDesc}\n\n${paramDocs}` : fullDesc;

        infos.push({
          name: this._makeBobbitToolName(serverName, tool.name),
          description: tool.description || `MCP tool ${tool.name} from ${serverName}`,
          group: `MCP: ${serverName}`,
          docs,
          summary,
          serverName,
          mcpToolName: tool.name,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
    }

    return infos;
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
      const dir = path.join(this.stateDir ?? bobbitStateDir(), 'mcp-tool-docs');
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

      statuses.push({
        name,
        status,
        toolCount: tools?.length ?? 0,
        ...(error ? { error } : {}),
        config,
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
    const { serverName, toolName } = this._parseToolName(bobbitToolName);

    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(
        `MCP server "${serverName}" is not connected`,
      );
    }

    if (!client.connected) {
      throw new Error(
        `MCP server "${serverName}" is disconnected`,
      );
    }

    return client.callTool(toolName, args);
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
    this._toolNameMap.set(fullName, { serverName, mcpToolName });
    return fullName;
  }

  /**
   * Parse a Bobbit MCP tool name back to server + MCP tool name.
   * Uses the lookup map first (handles truncated names), falls back to parsing.
   */
  private _parseToolName(bobbitToolName: string): {
    serverName: string;
    toolName: string;
  } {
    // Check lookup map first (handles truncated names)
    const mapped = this._toolNameMap.get(bobbitToolName);
    if (mapped) {
      return { serverName: mapped.serverName, toolName: mapped.mcpToolName };
    }

    // Fallback: parse from the name structure
    const prefix = "mcp__";
    if (!bobbitToolName.startsWith(prefix)) {
      throw new Error(
        `Invalid MCP tool name "${bobbitToolName}": must start with "mcp__"`,
      );
    }

    const rest = bobbitToolName.slice(prefix.length);
    const sepIdx = rest.indexOf("__");
    if (sepIdx < 1) {
      throw new Error(
        `Invalid MCP tool name "${bobbitToolName}": cannot parse server and tool name`,
      );
    }

    return {
      serverName: rest.slice(0, sepIdx),
      toolName: rest.slice(sepIdx + 2),
    };
  }
}
