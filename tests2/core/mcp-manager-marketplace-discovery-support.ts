import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { McpManager } = await import("../../src/server/mcp/mcp-manager.ts");
import type {
  MarketplaceMcpResolver,
  ResolvedMcpContribution,
} from "../../src/server/mcp/mcp-manager.ts";
import type {
  McpServerConfig,
  McpToolDef,
  McpToolResult,
} from "../../src/server/mcp/mcp-types.ts";

export type { MarketplaceMcpResolver, ResolvedMcpContribution };

export class StubMcpClient {
  public connected = false;
  public connectCount = 0;
  public disconnectCount = 0;
  public calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  constructor(
    public name: string,
    private opts: {
      tools?: McpToolDef[];
      connectImpl?: () => Promise<void>;
      listToolsImpl?: () => Promise<McpToolDef[]>;
    } = {},
  ) {}

  async connect(_config: McpServerConfig): Promise<void> {
    this.connectCount += 1;
    if (this.opts.connectImpl) await this.opts.connectImpl();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    this.connected = false;
  }

  async listTools(): Promise<McpToolDef[]> {
    if (this.opts.listToolsImpl) return this.opts.listToolsImpl();
    return this.opts.tools ?? [];
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    this.calls.push({ toolName, args });
    return { content: [{ type: "text", text: toolName }] };
  }
}

export class TestMcpManager extends (McpManager as any) {
  constructor(
    cwd: string,
    stateDir: string,
    private stubs: Map<string, StubMcpClient>,
    opts?: { marketplaceResolver?: MarketplaceMcpResolver; projectId?: string },
  ) {
    super(cwd, undefined, stateDir, opts);
  }

  protected _createClient(name: string): any {
    const stub = this.stubs.get(name);
    if (!stub) throw new Error(`No stub registered for ${name}`);
    return stub;
  }
}

export function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-market-"));
  const cwd = path.join(root, "cwd");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, cwd, stateDir };
}

export function op(name: string): McpToolDef {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
  };
}

export const contrib = (
  listName: string,
  serverName: string,
  config: McpServerConfig,
  subNamespace?: string,
  extra: Partial<ResolvedMcpContribution> = {},
): ResolvedMcpContribution => ({
  listName,
  serverName,
  ...(subNamespace ? { subNamespace } : {}),
  ...extra,
  config,
  origin: {
    scope: "project",
    packName: `pack-${listName}`,
    ...(extra.origin ?? {}),
  },
});
