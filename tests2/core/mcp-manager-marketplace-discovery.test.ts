// Split from tests/mcp-manager-marketplace-discovery.test.ts to keep each focused core file within the tier-1 wall budget.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseMcpToolName } from "../../src/server/mcp/mcp-meta.ts";
import {
  gatewayMcpActivationContributionId,
  gatewayMcpRuntimeKey,
} from "../../src/server/agent/mcp-gateway-runtime-identity.ts";
import {
  StubMcpClient,
  TestMcpManager,
  contrib,
  op,
  tmpDirs,
} from "./mcp-manager-marketplace-discovery-support.js";
import type { MarketplaceMcpResolver } from "./mcp-manager-marketplace-discovery-support.js";

describe("McpManager marketplace routing discovery", () => {
  it("generates source-qualified gateway runtime keys for identical provider fingerprints", () => {
    const baseEntry = {
      manifest: { name: "mcp-jira" },
      meta: { commit: "same-provider-fingerprint", packName: "mcp-jira" },
    } as any;
    const mcp = { listName: "jira", serverName: "gr", subNamespace: "jira" };
    const first = gatewayMcpRuntimeKey(baseEntry, mcp, {
      sourceType: "mcp-gateway",
      sourceId: "mcp-gateway-a",
      gatewayProviderId: "jira",
      gatewayFingerprint: "same-provider-fingerprint",
    });
    const second = gatewayMcpRuntimeKey(baseEntry, mcp, {
      sourceType: "mcp-gateway",
      sourceId: "mcp-gateway-b",
      gatewayProviderId: "jira",
      gatewayFingerprint: "same-provider-fingerprint",
    });

    assert.notEqual(first, second);
    assert.match(
      first,
      /^gateway_gr_jira_mcp-gateway-a_[a-f0-9]{12}_[a-f0-9]{12}$/,
    );
    assert.match(
      second,
      /^gateway_gr_jira_mcp-gateway-b_[a-f0-9]{12}_[a-f0-9]{12}$/,
    );
  });

  it("keeps gateway operation activation ids stable across catalogue fingerprint changes", () => {
    const mcp = { listName: "jira", serverName: "gr", subNamespace: "jira" };
    const firstEntry = {
      manifest: { name: "mcp-jira-gateway" },
      meta: {
        commit: "fingerprint-v1",
        packName: "mcp-jira-gateway",
        sourceUrl: "https://gateway.example.test/readonly/mcp",
      },
    } as any;
    const secondEntry = {
      manifest: { name: "mcp-jira-gateway" },
      meta: {
        commit: "fingerprint-v2",
        packName: "mcp-jira-gateway",
        sourceUrl: "https://gateway.example.test/readonly/mcp",
      },
    } as any;
    const firstMeta = {
      sourceType: "mcp-gateway",
      sourceId: "gateway-source-1",
      sourceUrl: "https://gateway.example.test/readonly/mcp",
      gatewayProviderId: "jira",
      gatewayFingerprint: "fingerprint-v1",
    };
    const secondMeta = {
      ...firstMeta,
      gatewayFingerprint: "fingerprint-v2",
    };

    const firstActivationId = gatewayMcpActivationContributionId(
      firstEntry,
      mcp,
      firstMeta,
    );
    const secondActivationId = gatewayMcpActivationContributionId(
      secondEntry,
      mcp,
      secondMeta,
    );

    assert.equal(secondActivationId, firstActivationId);
    assert.notEqual(
      gatewayMcpRuntimeKey(firstEntry, mcp, firstMeta),
      gatewayMcpRuntimeKey(secondEntry, mcp, secondMeta),
    );

    const disabledOperations: Record<string, string[]> = {
      [firstActivationId]: ["jira_search"],
    };
    const selected = ["jira_search", "jira_get_issue"].filter(
      (opName) => !disabledOperations[secondActivationId]?.includes(opName),
    );
    assert.deepEqual(selected, ["jira_get_issue"]);
  });

  it("uses persisted source id for activation identity and URL fallback only when needed", () => {
    const entry = {
      manifest: { name: "mcp-jira-gateway" },
      meta: {
        commit: "fingerprint",
        packName: "mcp-jira-gateway",
        sourceUrl: "https://old.example.test/readonly/mcp",
      },
    } as any;
    const mcp = { listName: "jira", serverName: "gr", subNamespace: "jira" };

    const withSourceId = gatewayMcpActivationContributionId(entry, mcp, {
      sourceType: "mcp-gateway",
      sourceId: "gateway-source-1",
      sourceUrl: "https://new.example.test/readonly/mcp",
      gatewayProviderId: "jira",
      gatewayFingerprint: "new-fingerprint",
    });
    const sameSourceDifferentUrl = gatewayMcpActivationContributionId(
      entry,
      mcp,
      {
        sourceType: "mcp-gateway",
        sourceId: "gateway-source-1",
        sourceUrl: "https://other.example.test/readonly/mcp",
        gatewayProviderId: "jira",
        gatewayFingerprint: "other-fingerprint",
      },
    );
    assert.equal(sameSourceDifferentUrl, withSourceId);

    const fallbackUrlA = gatewayMcpActivationContributionId(
      {
        ...entry,
        meta: {
          ...entry.meta,
          sourceUrl: "https://a.example.test/readonly/mcp",
        },
      },
      mcp,
      {
        sourceType: "mcp-gateway",
        gatewayProviderId: "jira",
      },
    );
    const fallbackUrlB = gatewayMcpActivationContributionId(
      {
        ...entry,
        meta: {
          ...entry.meta,
          sourceUrl: "https://b.example.test/readonly/mcp",
        },
      },
      mcp,
      {
        sourceType: "mcp-gateway",
        gatewayProviderId: "jira",
      },
    );
    assert.notEqual(fallbackUrlA, fallbackUrlB);
  });

  it("groups MCP gateway read/write provider namespaces and preserves canonical call names", async () => {
    const { cwd, stateDir } = tmpDirs();
    const readTransport = { url: "https://gateway.example.test/readonly/mcp" };
    const writeTransport = { url: "https://gateway.example.test/write/mcp" };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("jira", "gr", { ...readTransport }, "jira"),
      contrib("confluence", "gr", { ...readTransport }, "confluence"),
      contrib("jira-write", "gr-write", { ...writeTransport }, "jira"),
      contrib(
        "confluence-write",
        "gr-write",
        { ...writeTransport },
        "confluence",
      ),
    ];
    const readStub = new StubMcpClient("gr", {
      tools: [
        op("jira__jira_search"),
        op("confluence__page_search"),
        op("jira_search"),
        op("slack__hidden"),
      ],
    });
    const writeStub = new StubMcpClient("gr-write", {
      tools: [
        op("jira__jira_create"),
        op("confluence__page_update"),
        op("slack__hidden_write"),
      ],
    });
    const mgr = new TestMcpManager(
      cwd,
      stateDir,
      new Map([
        ["gr", readStub],
        ["gr-write", writeStub],
      ]),
      { marketplaceResolver: resolver },
    ) as any;

    assert.deepEqual(parseMcpToolName("mcp__gr__jira__jira_search"), {
      server: "gr",
      sub: "jira",
      op: "jira_search",
    });
    assert.deepEqual(parseMcpToolName("mcp__gr__jira_search"), {
      server: "gr",
      op: "jira_search",
    });

    const groups = mgr.resolveMarketplaceConnectionGroups();
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g: any) => g.serverName).sort(), [
      "gr",
      "gr-write",
    ]);
    assert.deepEqual(
      [
        ...groups.find((g: any) => g.serverName === "gr").activeSubNamespaces,
      ].sort(),
      ["confluence", "jira"],
    );
    assert.deepEqual(
      [
        ...groups.find((g: any) => g.serverName === "gr-write")
          .activeSubNamespaces,
      ].sort(),
      ["confluence", "jira"],
    );

    const result = await mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 0,
    });
    assert.equal(result.status, "ok");
    assert.equal(readStub.connectCount, 1);
    assert.equal(writeStub.connectCount, 1);

    assert.deepEqual(
      mgr
        .getToolInfos()
        .map((t: any) => t.name)
        .sort(),
      [
        "mcp__gr-write__confluence__page_update",
        "mcp__gr-write__jira__jira_create",
        "mcp__gr__confluence__page_search",
        "mcp__gr__jira__jira_search",
      ],
    );
    assert.deepEqual(
      mgr
        .getServerStatuses()
        .map((s: any) => ({
          name: s.name,
          activeSubNamespaces: s.activeSubNamespaces,
        }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      [
        { name: "gr", activeSubNamespaces: ["confluence", "jira"] },
        { name: "gr-write", activeSubNamespaces: ["confluence", "jira"] },
      ],
    );

    await mgr.callTool("mcp__gr__jira__jira_search", { query: "BUG-1" });
    await mgr.callTool("mcp__gr-write__jira__jira_create", {
      summary: "create",
    });
    assert.deepEqual(readStub.calls, [
      { toolName: "jira__jira_search", args: { query: "BUG-1" } },
    ]);
    assert.deepEqual(writeStub.calls, [
      { toolName: "jira__jira_create", args: { summary: "create" } },
    ]);
    await assert.rejects(
      () => mgr.callTool("mcp__gr__slack__hidden", {}),
      /sub-namespace is not active/,
    );
  });

  it("routes unprefixed gateway sub-namespace operations with namespaced public names", async () => {
    const { cwd, stateDir } = tmpDirs();
    const config = { url: "https://gateway.example.test/mcp" };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("confluence", "gr", config, "confluence", {
        runtimeServerKey: "gw-gr",
        contributionId: "source:confluence",
        disabledOperations: ["confluence_remove_page"],
      }),
      contrib("jira", "gr", config, "jira", {
        runtimeServerKey: "gw-gr",
        contributionId: "source:jira",
        selectedOperations: ["jira_search"],
      }),
    ];
    const stub = new StubMcpClient("gw-gr", {
      tools: [
        op("confluence_add_comment"),
        op("confluence_remove_page"),
        op("confluence__already_prefixed"),
        op("jira_search"),
        op("page_read"),
      ],
    });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["gw-gr", stub]]), {
      marketplaceResolver: resolver,
    }) as any;

    const result = await mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 0,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      mgr
        .getToolInfos()
        .map((t: any) => ({ name: t.name, mcpToolName: t.mcpToolName }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      [
        {
          name: "mcp__gr__confluence__already_prefixed",
          mcpToolName: "confluence__already_prefixed",
        },
        {
          name: "mcp__gr__confluence__confluence_add_comment",
          mcpToolName: "confluence_add_comment",
        },
        { name: "mcp__gr__jira__jira_search", mcpToolName: "jira_search" },
      ],
    );
    assert.deepEqual(
      mgr
        .getToolRouteSnapshots()
        .map((t: any) => ({
          name: t.name,
          op: parseMcpToolName(t.name)?.op,
          subNamespace: t.subNamespace,
        })),
      [
        {
          name: "mcp__gr__confluence__confluence_add_comment",
          op: "confluence_add_comment",
          subNamespace: "confluence",
        },
        {
          name: "mcp__gr__confluence__already_prefixed",
          op: "already_prefixed",
          subNamespace: "confluence",
        },
        {
          name: "mcp__gr__jira__jira_search",
          op: "jira_search",
          subNamespace: "jira",
        },
      ],
    );

    await mgr.callTool("mcp__gr__confluence__confluence_add_comment", {
      text: "hello",
    });
    await mgr.callTool("mcp__gr__confluence__already_prefixed", { ok: true });
    await mgr.callTool("mcp__gr__jira__jira_search", { q: "BUG-1" });
    assert.deepEqual(stub.calls, [
      { toolName: "confluence_add_comment", args: { text: "hello" } },
      { toolName: "confluence__already_prefixed", args: { ok: true } },
      { toolName: "jira_search", args: { q: "BUG-1" } },
    ]);
    await assert.rejects(
      () => mgr.callTool("mcp__gr__confluence__confluence_remove_page", {}),
      /not available or is disabled/,
    );
    await assert.rejects(
      () => mgr.callTool("mcp__gr__confluence__page_read", {}),
      /not available or is disabled/,
    );
  });

  it("scopes a single gateway sub-namespace contribution without operation metadata to owned-looking raw tools", async () => {
    const { cwd, stateDir } = tmpDirs();
    const config = { url: "https://gateway.example.test/mcp" };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("jira", "gr", config, "jira", {
        runtimeServerKey: "gw-gr",
        contributionId: "source:jira",
      }),
    ];
    const stub = new StubMcpClient("gw-gr", {
      tools: [op("confluence_add_comment"), op("jira_search"), op("page_read")],
    });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["gw-gr", stub]]), {
      marketplaceResolver: resolver,
    }) as any;

    const result = await mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 0,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      mgr
        .getToolInfos()
        .map((t: any) => ({ name: t.name, mcpToolName: t.mcpToolName })),
      [{ name: "mcp__gr__jira__jira_search", mcpToolName: "jira_search" }],
    );
    assert.deepEqual(
      mgr
        .getToolRouteSnapshots()
        .map((t: any) => ({
          name: t.name,
          op: parseMcpToolName(t.name)?.op,
          subNamespace: t.subNamespace,
        })),
      [
        {
          name: "mcp__gr__jira__jira_search",
          op: "jira_search",
          subNamespace: "jira",
        },
      ],
    );

    await mgr.callTool("mcp__gr__jira__jira_search", { q: "BUG-1" });
    assert.deepEqual(stub.calls, [
      { toolName: "jira_search", args: { q: "BUG-1" } },
    ]);
    await assert.rejects(
      () => mgr.callTool("mcp__gr__jira__confluence_add_comment", {}),
      /not available or is disabled/,
    );
    await assert.rejects(
      () => mgr.callTool("mcp__gr__jira__page_read", {}),
      /not available or is disabled/,
    );
  });

  it("preserves legacy single-owner unprefixed routing for non-gateway sub-namespace contributions", async () => {
    const { cwd, stateDir } = tmpDirs();
    const config = { command: "legacy" };
    const resolver: MarketplaceMcpResolver = () => [
      contrib("jira", "legacy", config, "jira"),
    ];
    const stub = new StubMcpClient("legacy", {
      tools: [op("confluence_add_comment"), op("jira_search")],
    });
    const mgr = new TestMcpManager(cwd, stateDir, new Map([["legacy", stub]]), {
      marketplaceResolver: resolver,
    }) as any;

    const result = await mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 0,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      mgr
        .getToolInfos()
        .map((t: any) => ({ name: t.name, mcpToolName: t.mcpToolName }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name)),
      [
        {
          name: "mcp__legacy__jira__confluence_add_comment",
          mcpToolName: "confluence_add_comment",
        },
        { name: "mcp__legacy__jira__jira_search", mcpToolName: "jira_search" },
      ],
    );
  });

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
    const mgr = new TestMcpManager(
      cwd,
      stateDir,
      new Map([["gateway", stub]]),
      { marketplaceResolver: resolver },
    ) as any;

    const groups = mgr.resolveMarketplaceConnectionGroups();
    assert.equal(groups.length, 1);
    assert.deepEqual([...groups[0].activeSubNamespaces].sort(), [
      "alpha",
      "beta",
    ]);

    const result = await mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 0,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      mgr
        .getToolInfos()
        .map((t: any) => t.name)
        .sort(),
      ["mcp__gateway__alpha__one", "mcp__gateway__beta__two"],
    );
    assert.deepEqual(mgr.getServerStatuses()[0].activeSubNamespaces, [
      "alpha",
      "beta",
    ]);
    assert.equal(
      mgr.getToolDocsRelativePath("gateway", "alpha"),
      mgr.getToolDocsRelativePath("gateway"),
    );
    assert.ok(
      fs.existsSync(
        path.join(
          stateDir,
          ...mgr.getToolDocsRelativePath("gateway", "alpha").split("/"),
        ),
      ),
    );
  });

  it("exposes gateway union across distinct runtime keys and routes calls by public names", async () => {
    const { cwd, stateDir } = tmpDirs();
    const resolver: MarketplaceMcpResolver = () => [
      contrib("jira-a", "gr-a", { url: "https://gateway-a.test/mcp" }, "jira", {
        runtimeServerKey: "gw-a-gr",
        contributionId: "source-a:jira",
        selectedOperations: ["jira_search"],
      }),
      contrib(
        "confluence-b",
        "gr-b",
        { url: "https://gateway-b.test/mcp" },
        "confluence",
        {
          runtimeServerKey: "gw-b-gr",
          contributionId: "source-b:confluence",
          selectedOperations: ["page_search"],
        },
      ),
    ];
    const aStub = new StubMcpClient("gw-a-gr", {
      tools: [op("jira__jira_search"), op("jira__jira_delete")],
    });
    const bStub = new StubMcpClient("gw-b-gr", {
      tools: [op("confluence__page_search")],
    });
    const mgr = new TestMcpManager(
      cwd,
      stateDir,
      new Map([
        ["gw-a-gr", aStub],
        ["gw-b-gr", bStub],
      ]),
      { marketplaceResolver: resolver },
    ) as any;

    const result = await mgr.reloadDiscoveredServers({
      force: true,
      timeoutMs: 0,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(
      mgr
        .getToolInfos()
        .map((t: any) => t.name)
        .sort(),
      ["mcp__gr-a__jira__jira_search", "mcp__gr-b__confluence__page_search"],
    );

    await mgr.callTool("mcp__gr-a__jira__jira_search", { q: "A" });
    await mgr.callTool("mcp__gr-b__confluence__page_search", { q: "B" });
    assert.deepEqual(aStub.calls, [
      { toolName: "jira__jira_search", args: { q: "A" } },
    ]);
    assert.deepEqual(bStub.calls, [
      { toolName: "confluence__page_search", args: { q: "B" } },
    ]);
    await assert.rejects(
      () => mgr.callTool("mcp__gr-a__jira__jira_delete", {}),
      /not available or is disabled/,
    );
  });

  it("keeps deterministic first contribution on public tool-name conflicts and records diagnostics", async () => {
    const { cwd, stateDir } = tmpDirs();
    const resolver: MarketplaceMcpResolver = () => [
      contrib("first", "gr", { url: "https://gateway-a.test/mcp" }, "jira", {
        runtimeServerKey: "gw-a-gr",
        contributionId: "first-contribution",
      }),
      contrib("second", "gr", { url: "https://gateway-b.test/mcp" }, "jira", {
        runtimeServerKey: "gw-b-gr",
        contributionId: "second-contribution",
      }),
    ];
    const first = new StubMcpClient("gw-a-gr", { tools: [op("jira__search")] });
    const second = new StubMcpClient("gw-b-gr", {
      tools: [op("jira__search")],
    });
    const mgr = new TestMcpManager(
      cwd,
      stateDir,
      new Map([
        ["gw-a-gr", first],
        ["gw-b-gr", second],
      ]),
      { marketplaceResolver: resolver },
    ) as any;

    await mgr.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    assert.deepEqual(
      mgr.getToolInfos().map((t: any) => t.name),
      ["mcp__gr__jira__search"],
    );
    assert.deepEqual(
      mgr
        .getToolRouteSnapshots()
        .map((t: any) => ({
          name: t.name,
          runtimeServerKey: t.runtimeServerKey,
          contributionId: t.contributionId,
        })),
      [
        {
          name: "mcp__gr__jira__search",
          runtimeServerKey: "gw-a-gr",
          contributionId: "first-contribution",
        },
      ],
    );
    assert.deepEqual(mgr.getRouteDiagnostics(), [
      {
        type: "conflict",
        toolName: "mcp__gr__jira__search",
        keptRuntimeServerKey: "gw-a-gr",
        droppedRuntimeServerKey: "gw-b-gr",
        keptContributionId: "first-contribution",
        droppedContributionId: "second-contribution",
      },
    ]);

    await mgr.callTool("mcp__gr__jira__search", { q: "winner" });
    assert.deepEqual(first.calls, [
      { toolName: "jira__search", args: { q: "winner" } },
    ]);
    assert.deepEqual(second.calls, []);
  });

  it("gives manual JSON MCP routes precedence over gateway marketplace routes with the same public name", async () => {
    const { cwd, stateDir } = tmpDirs();
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: { gr: { command: "manual" } },
      }),
    );
    const resolver: MarketplaceMcpResolver = () => [
      contrib(
        "jira",
        "gr",
        { url: "https://gateway.example.test/mcp" },
        "jira",
        {
          runtimeServerKey: "gw-gr",
          contributionId: "gateway-contribution",
          origin: { scope: "project", packName: "gateway-pack" },
        },
      ),
    ];
    const manual = new StubMcpClient("gr", { tools: [op("jira__search")] });
    const gateway = new StubMcpClient("gw-gr", { tools: [op("jira__search")] });
    const mgr = new TestMcpManager(
      cwd,
      stateDir,
      new Map([
        ["gr", manual],
        ["gw-gr", gateway],
      ]),
      { marketplaceResolver: resolver },
    ) as any;

    await mgr.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    assert.deepEqual(
      mgr
        .getToolRouteSnapshots()
        .map((t: any) => ({
          name: t.name,
          runtimeServerKey: t.runtimeServerKey,
          contributionId: t.contributionId,
        })),
      [
        {
          name: "mcp__gr__jira__search",
          runtimeServerKey: "gr",
          contributionId: undefined,
        },
      ],
    );
    assert.deepEqual(mgr.getRouteDiagnostics(), [
      {
        type: "conflict",
        toolName: "mcp__gr__jira__search",
        keptRuntimeServerKey: "gr",
        droppedRuntimeServerKey: "gw-gr",
        droppedContributionId: "gateway-contribution",
      },
    ]);

    await mgr.callTool("mcp__gr__jira__search", { q: "manual" });
    assert.deepEqual(manual.calls, [
      { toolName: "jira__search", args: { q: "manual" } },
    ]);
    assert.deepEqual(gateway.calls, []);
  });

  it("keeps conflict precedence stable when a lower-priority connection lists tools first", async () => {
    const { cwd, stateDir } = tmpDirs();
    const resolver: MarketplaceMcpResolver = () => [
      contrib("first", "gr", { url: "https://gateway-a.test/mcp" }, "jira", {
        runtimeServerKey: "gw-a-gr",
        contributionId: "first-contribution",
      }),
      contrib("second", "gr", { url: "https://gateway-b.test/mcp" }, "jira", {
        runtimeServerKey: "gw-b-gr",
        contributionId: "second-contribution",
      }),
    ];
    const events: string[] = [];
    const first = new StubMcpClient("gw-a-gr", {
      listToolsImpl: async () => {
        events.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        events.push("first-done");
        return [op("jira__search")];
      },
    });
    const second = new StubMcpClient("gw-b-gr", {
      listToolsImpl: async () => {
        events.push("second-done");
        return [op("jira__search")];
      },
    });
    const mgr = new TestMcpManager(
      cwd,
      stateDir,
      new Map([
        ["gw-a-gr", first],
        ["gw-b-gr", second],
      ]),
      { marketplaceResolver: resolver },
    ) as any;

    await mgr.reloadDiscoveredServers({ force: true, timeoutMs: 0 });
    assert.ok(events.indexOf("second-done") < events.indexOf("first-done"));
    assert.deepEqual(
      mgr
        .getToolRouteSnapshots()
        .map((t: any) => ({
          name: t.name,
          runtimeServerKey: t.runtimeServerKey,
        })),
      [{ name: "mcp__gr__jira__search", runtimeServerKey: "gw-a-gr" }],
    );
    await mgr.callTool("mcp__gr__jira__search", { q: "winner" });
    assert.deepEqual(first.calls, [
      { toolName: "jira__search", args: { q: "winner" } },
    ]);
    assert.deepEqual(second.calls, []);
  });
});
