// Split from tests/mcp-manager-marketplace-discovery.test.ts to keep each focused core file within the tier-1 wall budget.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpManager } from "../../src/server/mcp/mcp-manager.ts";
import {
  StubMcpClient,
  TestMcpManager,
  contrib,
  op,
  tmpDirs,
} from "./mcp-manager-marketplace-discovery-support.js";
import type {
  MarketplaceMcpResolver,
  ResolvedMcpContribution,
} from "./mcp-manager-marketplace-discovery-support.js";

describe("McpManager marketplace config and reload discovery", () => {
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
      headers: {
        Authorization: "Bearer http-secret",
        "X-Plain": "visible-value",
      },
    };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("local", "local", localConfig),
      contrib("remote", "remote", remoteConfig),
    ];
    const mgr = new TestMcpManager(
      cwd,
      stateDir,
      new Map([
        ["local", new StubMcpClient("local")],
        ["remote", new StubMcpClient("remote")],
      ]),
      { marketplaceResolver: resolver },
    ) as any;

    const result = await mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 0,
    });
    assert.equal(result.status, "ok");
    const statuses = mgr.getServerStatuses();
    const local = statuses.find((s: any) => s.name === "local")!;
    const remote = statuses.find((s: any) => s.name === "remote")!;

    assert.deepEqual(local.config.env, {
      API_TOKEN: "<redacted>",
      PLAIN: "<redacted>",
    });
    assert.deepEqual(local.config.args, ["<redacted>", "<redacted>"]);
    assert.deepEqual(local.ownerContributions[0].config.env, local.config.env);
    assert.deepEqual(remote.config.headers, {
      Authorization: "<redacted>",
      "X-Plain": "<redacted>",
    });
    assert.equal(remote.config.url, "https://example.test/mcp");
    assert.deepEqual(
      remote.ownerContributions[0].config.headers,
      remote.config.headers,
    );
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
    const mgr = new TestMcpManager(cwd, stateDir, new Map(), {
      marketplaceResolver: resolver,
      projectId: "project-1",
    }) as any;

    assert.deepEqual(mgr.discoverServers(), {
      project_server: { command: "project" },
    });
    assert.deepEqual(seen, [{ cwd, projectId: "project-1" }]);
  });

  it("overlays manual MCP config over marketplace contributions", () => {
    const { cwd, stateDir } = tmpDirs();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          same: { command: "manual" },
          manualOnly: { url: "https://mcp.example.test" },
        },
      }),
    );
    const resolver: MarketplaceMcpResolver = () => [
      contrib("same", "same", { command: "market" }),
      contrib("marketOnly", "marketOnly", { command: "market-only" }),
    ];
    const mgr = new TestMcpManager(cwd, stateDir, new Map(), {
      marketplaceResolver: resolver,
    }) as any;

    const discovered = mgr.discoverServers();
    assert.deepEqual(discovered.same, { command: "manual" });
    assert.deepEqual(discovered.marketOnly, { command: "market-only" });
    assert.deepEqual(discovered.manualOnly, {
      url: "https://mcp.example.test",
    });

    const sameGroup = mgr
      .discoverConnectionGroups()
      .find((g: any) => g.serverName === "same");
    assert.equal(sameGroup.ownerContributions[0].origin.scope, "manual");
  });

  it("loads Bobbit MCP config from the selected project scope", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "mcp-selected-project-config-"),
    );
    const stateDir = path.join(root, "state");
    const headquartersDir = path.join(root, "headquarters");
    const projectRoot = path.join(root, "normal-project");
    const projectServerName = `project_selected_${path.basename(root).replace(/[^a-zA-Z0-9]/g, "_")}`;
    const headquartersServerName = `hq_selected_${path.basename(root).replace(/[^a-zA-Z0-9]/g, "_")}`;
    fs.mkdirSync(path.join(headquartersDir, "config"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".bobbit", "config"), {
      recursive: true,
    });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(headquartersDir, "config", "mcp.json"),
      JSON.stringify({
        mcpServers: { [headquartersServerName]: { command: "headquarters" } },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, ".bobbit", "config", "mcp.json"),
      JSON.stringify({
        mcpServers: { [projectServerName]: { command: "normal-project" } },
      }),
    );

    const oldBobbitDir = process.env.BOBBIT_DIR;
    process.env.BOBBIT_DIR = headquartersDir;
    try {
      const projectMgr = new McpManager(projectRoot, undefined, stateDir, {
        projectId: "normal-project",
      });
      const projectDiscovered = projectMgr.discoverServers();
      assert.deepEqual(projectDiscovered[projectServerName], {
        command: "normal-project",
      });
      // Server-level (Headquarters) config is the global base layer — it is loaded
      // for ALL scopes including normal projects, so project-level configs layer ON
      // TOP of (not replace) the server config. The project manager therefore also
      // discovers servers from bobbitConfigDir()/mcp.json.
      assert.deepEqual(projectDiscovered[headquartersServerName], {
        command: "headquarters",
      });

      const headquartersMgr = new McpManager(
        headquartersDir,
        undefined,
        stateDir,
        { projectId: "headquarters" },
      );
      const headquartersDiscovered = headquartersMgr.discoverServers();
      assert.deepEqual(headquartersDiscovered[headquartersServerName], {
        command: "headquarters",
      });
      assert.equal(headquartersDiscovered[projectServerName], undefined);
    } finally {
      if (oldBobbitDir === undefined) delete process.env.BOBBIT_DIR;
      else process.env.BOBBIT_DIR = oldBobbitDir;
    }
  });

  it("reloadDiscoveredServers is single-flight, fingerprints unchanged servers, and forgets removed tools", async () => {
    const { cwd, stateDir } = tmpDirs();
    let current: ResolvedMcpContribution[] = [
      contrib("one", "one", { command: "one" }),
    ];
    const resolver: MarketplaceMcpResolver = () => current;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = new StubMcpClient("one", {
      tools: [op("do")],
      connectImpl: () => gate,
    });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["one", stub]]), {
      marketplaceResolver: resolver,
    }) as any;

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
    assert.deepEqual(mgr.getToolRegistrationRefresh().removePrefixes, [
      "mcp__",
    ]);
    assert.deepEqual(
      mgr.getToolInfos().map((t: any) => t.name),
      ["mcp__one__do"],
    );

    current = [];
    const removed = await mgr.reloadDiscoveredServers({ timeoutMs: 0 });
    assert.deepEqual(removed.disconnected, ["one"]);
    assert.deepEqual(mgr.getServerStatuses(), []);
    assert.deepEqual(mgr.getToolInfos(), []);
  });

  it("queues one fresh reload when explicitly requested during an in-flight reload", async () => {
    const { cwd, stateDir } = tmpDirs();
    let current: ResolvedMcpContribution[] = [
      contrib("one", "one", { command: "one" }),
    ];
    const resolver: MarketplaceMcpResolver = () => current;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = new StubMcpClient("one", {
      tools: [op("do")],
      connectImpl: () => gate,
    });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["one", stub]]), {
      marketplaceResolver: resolver,
    }) as any;

    const active = mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 1000,
    });
    assert.equal(stub.connectCount, 1);
    current = [];
    const queued = mgr.reloadDiscoveredServers({
      timeoutMs: 1000,
      queueIfInFlight: true,
    });
    const coalesced = mgr.reloadDiscoveredServers({
      timeoutMs: 1000,
      queueIfInFlight: true,
    });
    assert.equal(stub.connectCount, 1);

    release();
    assert.equal((await active).status, "ok");
    const [queuedResult, coalescedResult] = await Promise.all([
      queued,
      coalesced,
    ]);
    assert.equal(queuedResult.status, "ok");
    assert.deepEqual(queuedResult.disconnected, ["one"]);
    assert.deepEqual(coalescedResult.disconnected, ["one"]);
    assert.equal(stub.connectCount, 1);
    assert.equal(stub.disconnectCount, 1);
    assert.deepEqual(mgr.getServerStatuses(), []);
    assert.deepEqual(mgr.getToolInfos(), []);
  });

  it("updates ownership metadata for unchanged connected server configs", async () => {
    const { cwd, stateDir } = tmpDirs();
    const config = { command: "same" };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("same", "same", config),
    ];
    const stub = new StubMcpClient("same", { tools: [op("do")] });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["same", stub]]), {
      marketplaceResolver: resolver,
    }) as any;

    await mgr.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    assert.equal(mgr.getServerStatuses()[0].origin.scope, "project");
    assert.equal(stub.connectCount, 1);

    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { same: config },
      }),
    );
    const unchanged = await mgr.reloadDiscoveredServers({ timeoutMs: 0 });

    assert.deepEqual(unchanged.unchanged, ["same"]);
    assert.equal(stub.connectCount, 1);
    const status = mgr.getServerStatuses()[0];
    assert.equal(status.origin?.scope, "manual");
    assert.equal(status.ownerContributions?.[0]?.origin.scope, "manual");
  });
});
