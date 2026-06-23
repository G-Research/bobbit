import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  McpManager,
} = await import("../src/server/mcp/mcp-manager.ts");
import type {
  MarketplaceMcpResolver,
  ResolvedMcpContribution,
} from "../src/server/mcp/mcp-manager.ts";
import type { McpServerConfig, McpToolDef, McpToolResult } from "../src/server/mcp/mcp-types.ts";

class StubMcpClient {
  public connected = false;
  public connectCount = 0;
  public disconnectCount = 0;

  constructor(
    public name: string,
    private opts: {
      tools?: McpToolDef[];
      connectImpl?: () => Promise<void>;
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
    return this.opts.tools ?? [];
  }

  async callTool(toolName: string, _args: Record<string, unknown>): Promise<McpToolResult> {
    return { content: [{ type: "text", text: toolName }] };
  }
}

class TestMcpManager extends (McpManager as any) {
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

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-market-"));
  const cwd = path.join(root, "cwd");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, cwd, stateDir };
}

function op(name: string): McpToolDef {
  return { name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } };
}

const contrib = (
  listName: string,
  serverName: string,
  config: McpServerConfig,
  subNamespace?: string,
): ResolvedMcpContribution => ({
  listName,
  serverName,
  ...(subNamespace ? { subNamespace } : {}),
  config,
  origin: { scope: "project", packName: `pack-${listName}` },
});

describe("McpManager marketplace discovery primitives", () => {
  it("groups same-config subNamespace contributions and filters tool infos", async () => {
    const { cwd, stateDir } = tmpDirs();
    const config = { command: "stub" };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("alpha", "gateway", config, "alpha"),
      contrib("beta", "gateway", config, "beta"),
    ];
    const stub = new StubMcpClient("gateway", {
      tools: [op("alpha__one"), op("beta__two"), op("gamma__hidden")],
    });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["gateway", stub]]), { marketplaceResolver: resolver }) as any;

    const groups = mgr.resolveMarketplaceConnectionGroups();
    assert.equal(groups.length, 1);
    assert.deepEqual([...groups[0].activeSubNamespaces].sort(), ["alpha", "beta"]);

    const result = await mgr.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    assert.equal(result.status, "ok");
    assert.deepEqual(mgr.getToolInfos().map((t: any) => t.name).sort(), [
      "mcp__gateway__alpha__one",
      "mcp__gateway__beta__two",
    ]);
    assert.deepEqual(mgr.getServerStatuses()[0].activeSubNamespaces, ["alpha", "beta"]);
  });

  it("passes project scope to marketplace resolver", () => {
    const { cwd, stateDir } = tmpDirs();
    const seen: any[] = [];
    const resolver: MarketplaceMcpResolver = (scope) => {
      seen.push(scope);
      return [contrib("project", "project_server", { command: "project" })];
    };
    const mgr = new TestMcpManager(cwd, stateDir, new Map(), { marketplaceResolver: resolver, projectId: "project-1" }) as any;

    assert.deepEqual(mgr.discoverServers(), { project_server: { command: "project" } });
    assert.deepEqual(seen, [{ cwd, projectId: "project-1" }]);
  });

  it("overlays manual MCP config over marketplace contributions", () => {
    const { cwd, stateDir } = tmpDirs();
    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({
      mcpServers: {
        same: { command: "manual" },
        manualOnly: { url: "https://mcp.example.test" },
      },
    }));
    const resolver: MarketplaceMcpResolver = () => [
      contrib("same", "same", { command: "market" }),
      contrib("marketOnly", "marketOnly", { command: "market-only" }),
    ];
    const mgr = new TestMcpManager(cwd, stateDir, new Map(), { marketplaceResolver: resolver }) as any;

    const discovered = mgr.discoverServers();
    assert.deepEqual(discovered.same, { command: "manual" });
    assert.deepEqual(discovered.marketOnly, { command: "market-only" });
    assert.deepEqual(discovered.manualOnly, { url: "https://mcp.example.test" });

    const sameGroup = mgr.discoverConnectionGroups().find((g: any) => g.serverName === "same");
    assert.equal(sameGroup.ownerContributions[0].origin.scope, "manual");
  });

  it("reloadDiscoveredServers is single-flight, fingerprints unchanged servers, and forgets removed tools", async () => {
    const { cwd, stateDir } = tmpDirs();
    let current: ResolvedMcpContribution[] = [contrib("one", "one", { command: "one" })];
    const resolver: MarketplaceMcpResolver = () => current;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stub = new StubMcpClient("one", { tools: [op("do")], connectImpl: () => gate });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["one", stub]]), { marketplaceResolver: resolver }) as any;

    const p1 = mgr.reloadDiscoveredServers({ force: true, timeoutMs: 1000 });
    const p2 = mgr.reloadDiscoveredServers({ force: true, timeoutMs: 1000 });
    assert.equal(stub.connectCount, 1);
    release();
    assert.equal((await p1).status, "ok");
    assert.equal((await p2).status, "ok");
    assert.equal(stub.connectCount, 1);

    const unchanged = await mgr.reloadDiscoveredServers({ timeoutMs: 0 });
    assert.deepEqual(unchanged.unchanged, ["one"]);
    assert.equal(stub.connectCount, 1);
    assert.deepEqual(mgr.getToolRegistrationRefresh().removePrefixes, ["mcp__"]);
    assert.deepEqual(mgr.getToolInfos().map((t: any) => t.name), ["mcp__one__do"]);

    current = [];
    const removed = await mgr.reloadDiscoveredServers({ timeoutMs: 0 });
    assert.deepEqual(removed.disconnected, ["one"]);
    assert.deepEqual(mgr.getServerStatuses(), []);
    assert.deepEqual(mgr.getToolInfos(), []);
  });
});
