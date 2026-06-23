import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  McpManager,
} = await import("../src/server/mcp/mcp-manager.ts");
const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { ProjectConfigStore } = await import("../src/server/agent/project-config-store.ts");
const { ProjectContextManager } = await import("../src/server/agent/project-context-manager.ts");
const { ProjectRegistry } = await import("../src/server/agent/project-registry.ts");
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
    assert.equal(mgr.getToolDocsRelativePath("gateway", "alpha"), mgr.getToolDocsRelativePath("gateway"));
    assert.ok(fs.existsSync(path.join(stateDir, ...mgr.getToolDocsRelativePath("gateway", "alpha").split("/"))));
  });

  it("redacts secret-bearing config values in server statuses", async () => {
    const { cwd, stateDir } = tmpDirs();
    const localConfig = {
      command: "node",
      args: ["--token", "stdio-secret"],
      env: { API_TOKEN: "stdio-secret", PLAIN: "visible-value" },
      cwd: ".",
    };
    const remoteConfig = {
      url: "https://user:pass@example.test/mcp?token=http-secret#frag",
      headers: { Authorization: "Bearer http-secret", "X-Plain": "visible-value" },
    };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("local", "local", localConfig),
      contrib("remote", "remote", remoteConfig),
    ];
    const mgr = new TestMcpManager(cwd, stateDir, new Map([
      ["local", new StubMcpClient("local")],
      ["remote", new StubMcpClient("remote")],
    ]), { marketplaceResolver: resolver }) as any;

    const result = await mgr.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    assert.equal(result.status, "ok");
    const statuses = mgr.getServerStatuses();
    const local = statuses.find((s: any) => s.name === "local")!;
    const remote = statuses.find((s: any) => s.name === "remote")!;

    assert.deepEqual(local.config.env, { API_TOKEN: "<redacted>", PLAIN: "<redacted>" });
    assert.deepEqual(local.config.args, ["<redacted>", "<redacted>"]);
    assert.deepEqual(local.ownerContributions[0].config.env, local.config.env);
    assert.deepEqual(remote.config.headers, { Authorization: "<redacted>", "X-Plain": "<redacted>" });
    assert.equal(remote.config.url, "https://example.test/mcp");
    assert.deepEqual(remote.ownerContributions[0].config.headers, remote.config.headers);
    assert.ok(!JSON.stringify(statuses).includes("stdio-secret"));
    assert.ok(!JSON.stringify(statuses).includes("http-secret"));
    assert.ok(!JSON.stringify(statuses).includes("visible-value"));
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

  it("updates ownership metadata for unchanged connected server configs", async () => {
    const { cwd, stateDir } = tmpDirs();
    const config = { command: "same" };
    const resolver: MarketplaceMcpResolver = () => [contrib("same", "same", config)];
    const stub = new StubMcpClient("same", { tools: [op("do")] });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["same", stub]]), { marketplaceResolver: resolver }) as any;

    await mgr.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    assert.equal(mgr.getServerStatuses()[0].origin.scope, "project");
    assert.equal(stub.connectCount, 1);

    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({
      mcpServers: { same: config },
    }));
    const unchanged = await mgr.reloadDiscoveredServers({ timeoutMs: 0 });

    assert.deepEqual(unchanged.unchanged, ["same"]);
    assert.equal(stub.connectCount, 1);
    const status = mgr.getServerStatuses()[0];
    assert.equal(status.origin?.scope, "manual");
    assert.equal(status.ownerContributions?.[0]?.origin.scope, "manual");
  });
});

describe("SessionManager scoped MCP manager creation", () => {
  it("uses the scoped project's config store for custom MCP config directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-scope-"));
    const serverConfigDir = path.join(root, "server-config");
    const serverCustomDir = path.join(root, "server-custom-mcp");
    const registryStateDir = path.join(root, "state");
    const projectRoot = path.join(root, "project");
    const projectCustomDir = path.join(root, "project-custom-mcp");
    fs.mkdirSync(serverCustomDir, { recursive: true });
    fs.mkdirSync(projectCustomDir, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".bobbit", "config"), { recursive: true });
    fs.mkdirSync(registryStateDir, { recursive: true });

    fs.writeFileSync(path.join(serverCustomDir, ".mcp.json"), JSON.stringify({
      mcpServers: { server_only: { command: "server-only" } },
    }));
    fs.writeFileSync(path.join(projectCustomDir, ".mcp.json"), JSON.stringify({
      mcpServers: { project_scoped: { command: "project-scoped" } },
    }));

    const serverStore = new ProjectConfigStore(serverConfigDir);
    serverStore.setConfigDirectories([{ path: serverCustomDir, types: ["mcp"] }]);
    const projectStore = new ProjectConfigStore(path.join(projectRoot, ".bobbit", "config"));
    projectStore.setConfigDirectories([{ path: projectCustomDir, types: ["mcp"] }]);

    const projectId = "project-scoped-mcp-config";
    fs.writeFileSync(path.join(registryStateDir, "projects.json"), JSON.stringify([{
      id: projectId,
      name: "Project Scoped MCP Config",
      rootPath: projectRoot,
      createdAt: Date.now(),
      colorLight: "#3b82f6",
      colorDark: "#60a5fa",
    }]));

    const registry = new ProjectRegistry(registryStateDir);
    const pcm = new ProjectContextManager(registry);
    const sessionManager = new SessionManager({ projectConfigStore: serverStore, projectContextManager: pcm });

    try {
      const defaultMgr = (sessionManager as any).createMcpManager(root) as InstanceType<typeof McpManager>;
      const defaultDiscovered = defaultMgr.discoverServers();
      assert.deepEqual(defaultDiscovered.server_only, { command: "server-only" });
      assert.equal(defaultDiscovered.project_scoped, undefined);

      const scopedMgr = (sessionManager as any).createMcpManager(projectRoot, {
        projectId,
        scopeKey: `project:${projectId}`,
      }) as InstanceType<typeof McpManager>;
      const scopedDiscovered = scopedMgr.discoverServers();
      assert.deepEqual(scopedDiscovered.project_scoped, { command: "project-scoped" });
      assert.equal(scopedDiscovered.server_only, undefined);
    } finally {
      await Promise.all(Array.from(pcm.all(), (ctx) => ctx.close()));
    }
  });

  it("does not substitute the default MCP manager for project pipeline context", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-session-project-route-"));
    const registryStateDir = path.join(root, "state");
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(path.join(projectRoot, ".bobbit", "config"), { recursive: true });
    fs.mkdirSync(registryStateDir, { recursive: true });
    const projectId = "project-route";
    fs.writeFileSync(path.join(registryStateDir, "projects.json"), JSON.stringify([{
      id: projectId,
      name: "Project Route",
      rootPath: projectRoot,
      createdAt: Date.now(),
      colorLight: "#3b82f6",
      colorDark: "#60a5fa",
    }]));

    const registry = new ProjectRegistry(registryStateDir);
    const pcm = new ProjectContextManager(registry);
    const sessionManager = new SessionManager({ projectContextManager: pcm }) as any;
    const defaultMgr = { marker: "default" };
    const scopedMgr = { marker: "scoped", connectAll: async () => {} };
    sessionManager.mcpManager = defaultMgr;
    sessionManager.createMcpManager = () => scopedMgr;

    try {
      assert.equal(sessionManager.buildPipelineContext(projectId, projectRoot).mcpManager, null);
      assert.equal(await sessionManager.ensureMcpManager({ projectId }), scopedMgr);
      assert.equal(sessionManager.buildPipelineContext(projectId, projectRoot).mcpManager, scopedMgr);
    } finally {
      await Promise.all(Array.from(pcm.all(), (ctx) => ctx.close()));
    }
  });

  it("routes no-project sessions to their cwd-scoped MCP manager when no scopeKey is supplied", async () => {
    const { cwd } = tmpDirs();
    const sessionManager = new SessionManager() as any;
    const defaultMgr = { marker: "default" };
    const cwdMgr = { marker: "cwd", connectAll: async () => {} };
    const sessionId = "cwd-session";
    sessionManager.mcpManager = defaultMgr;
    sessionManager.createMcpManager = () => cwdMgr;
    sessionManager.sessions.set(sessionId, { id: sessionId, cwd });

    assert.equal(await sessionManager.ensureMcpManagerForSession(sessionId), cwdMgr);
    assert.equal(sessionManager.getMcpManagerForSession(sessionId), cwdMgr);
    assert.equal(await sessionManager.resolveMcpManagerForSession(sessionId), cwdMgr);
    assert.notEqual(await sessionManager.resolveMcpManagerForSession(sessionId), defaultMgr);
  });

  it("refreshes external MCP tool registrations after pending marketplace reloads complete", async () => {
    const sessionManager = new SessionManager() as any;
    let release!: () => void;
    const done = new Promise<any>((resolve) => { release = () => resolve({
      status: "ok",
      connected: ["late"],
      disconnected: [],
      unchanged: [],
      skippedErrored: [],
      failed: [],
      statuses: [],
    }); });
    let refreshCount = 0;
    sessionManager.mcpManager = {
      getScopeKey: () => "default",
      reloadDiscoveredServers: async () => ({
        status: "pending",
        connected: [],
        disconnected: [],
        unchanged: [],
        skippedErrored: [],
        failed: [],
        statuses: [],
      }),
      currentReload: () => done,
    };
    sessionManager.refreshExternalMcpToolRegistrations = () => { refreshCount += 1; };

    const result = await sessionManager.reloadMcpAfterMarketplaceMutation("server");
    assert.equal(result?.status, "pending");
    assert.equal(refreshCount, 0);
    release();
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshCount, 1);
  });
});
