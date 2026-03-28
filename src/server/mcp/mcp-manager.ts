import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient } from "./mcp-client.js";
import type {
  McpServerConfig,
  McpToolDef,
  McpToolResult,
} from "./mcp-types.js";
import { bobbitConfigDir } from "../bobbit-dir.js";

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
export class McpManager {
  private clients = new Map<string, McpClient>();
  private toolDefs = new Map<string, McpToolDef[]>();
  private configs = new Map<string, McpServerConfig>();
  private errors = new Map<string, string>();

  constructor(private cwd: string) {}

  // ── Discovery ──────────────────────────────────────────────────────

  /**
   * Discover MCP servers from config files.
   * Priority order (later overrides earlier):
   *   1. ~/.claude.json → mcpServers
   *   2. .mcp.json in cwd
   *   3. .bobbit/config/mcp.json → mcpServers
   */
  discoverServers(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};

    // 1. User scope: ~/.claude.json
    const userConfigPath = path.join(os.homedir(), ".claude.json");
    this._mergeConfigFile(merged, userConfigPath, "mcpServers");

    // 2. Project scope: .mcp.json in cwd
    const projectConfigPath = path.join(this.cwd, ".mcp.json");
    this._mergeConfigFile(merged, projectConfigPath, "mcpServers");

    // 3. Bobbit overrides: .bobbit/config/mcp.json
    const bobbitConfigPath = path.join(bobbitConfigDir(), "mcp.json");
    this._mergeConfigFile(merged, bobbitConfigPath, "mcpServers");

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
        infos.push({
          name: `mcp__${serverName}__${tool.name}`,
          description: tool.description || `MCP tool ${tool.name} from ${serverName}`,
          group: `MCP: ${serverName}`,
          docs: this._generateToolDocs(tool),
          serverName,
          mcpToolName: tool.name,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
    }

    return infos;
  }

  /** Auto-generate docs from inputSchema. */
  private _generateToolDocs(tool: McpToolDef): string {
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== "object") return "";

    const properties = schema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) return "";

    const required = (schema.required as string[]) || [];
    const lines: string[] = [];

    lines.push("## Parameters\n");
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
   * Parse a Bobbit MCP tool name (mcp__server__tool) into server and tool parts.
   * Uses first double-underscore after "mcp" as server separator,
   * second double-underscore as tool name start. Tool name may contain __.
   */
  private _parseToolName(bobbitToolName: string): {
    serverName: string;
    toolName: string;
  } {
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
