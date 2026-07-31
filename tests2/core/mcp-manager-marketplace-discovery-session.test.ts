// Split from tests/mcp-manager-marketplace-discovery.test.ts to keep each focused core file within the tier-1 wall budget.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpManager } from "../../src/server/mcp/mcp-manager.ts";
import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.ts";
import { ProjectContextManager } from "../../src/server/agent/project-context-manager.ts";
import { ProjectRegistry } from "../../src/server/agent/project-registry.ts";
import { tmpDirs } from "./mcp-manager-marketplace-discovery-support.js";

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
    fs.mkdirSync(path.join(projectRoot, ".bobbit", "config"), {
      recursive: true,
    });
    fs.mkdirSync(registryStateDir, { recursive: true });

    fs.writeFileSync(
      path.join(serverCustomDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { server_only: { command: "server-only" } },
      }),
    );
    fs.writeFileSync(
      path.join(projectCustomDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { project_scoped: { command: "project-scoped" } },
      }),
    );

    const serverStore = new ProjectConfigStore(serverConfigDir);
    serverStore.setConfigDirectories([
      { path: serverCustomDir, types: ["mcp"] },
    ]);
    const projectStore = new ProjectConfigStore(
      path.join(projectRoot, ".bobbit", "config"),
    );
    projectStore.setConfigDirectories([
      { path: projectCustomDir, types: ["mcp"] },
    ]);

    const projectId = "project-scoped-mcp-config";
    fs.writeFileSync(
      path.join(registryStateDir, "projects.json"),
      JSON.stringify([
        {
          id: projectId,
          name: "Project Scoped MCP Config",
          rootPath: projectRoot,
          createdAt: Date.now(),
          colorLight: "#3b82f6",
          colorDark: "#60a5fa",
        },
      ]),
    );

    const registry = new ProjectRegistry(registryStateDir);
    const pcm = new ProjectContextManager(registry);
    const sessionManager = new SessionManager({
      projectConfigStore: serverStore,
      projectContextManager: pcm,
    });

    try {
      const defaultMgr = (sessionManager as any).createMcpManager(
        root,
      ) as InstanceType<typeof McpManager>;
      const defaultDiscovered = defaultMgr.discoverServers();
      assert.deepEqual(defaultDiscovered.server_only, {
        command: "server-only",
      });
      assert.equal(defaultDiscovered.project_scoped, undefined);

      const scopedMgr = (sessionManager as any).createMcpManager(projectRoot, {
        projectId,
        scopeKey: `project:${projectId}`,
      }) as InstanceType<typeof McpManager>;
      const scopedDiscovered = scopedMgr.discoverServers();
      assert.deepEqual(scopedDiscovered.project_scoped, {
        command: "project-scoped",
      });
      assert.equal(scopedDiscovered.server_only, undefined);
    } finally {
      await Promise.all(Array.from(pcm.all(), (ctx) => ctx.close()));
    }
  });

  it("does not substitute the default MCP manager for project pipeline context", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "mcp-session-project-route-"),
    );
    const registryStateDir = path.join(root, "state");
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(path.join(projectRoot, ".bobbit", "config"), {
      recursive: true,
    });
    fs.mkdirSync(registryStateDir, { recursive: true });
    const projectId = "project-route";
    fs.writeFileSync(
      path.join(registryStateDir, "projects.json"),
      JSON.stringify([
        {
          id: projectId,
          name: "Project Route",
          rootPath: projectRoot,
          createdAt: Date.now(),
          colorLight: "#3b82f6",
          colorDark: "#60a5fa",
        },
      ]),
    );

    const registry = new ProjectRegistry(registryStateDir);
    const pcm = new ProjectContextManager(registry);
    const sessionManager = new SessionManager({
      projectContextManager: pcm,
    }) as any;
    const defaultMgr = { marker: "default" };
    const scopedMgr = { marker: "scoped", connectAll: async () => {} };
    sessionManager.mcpManager = defaultMgr;
    sessionManager.createMcpManager = () => scopedMgr;

    try {
      assert.equal(
        sessionManager.buildPipelineContext(projectId, projectRoot).mcpManager,
        null,
      );
      assert.equal(
        await sessionManager.ensureMcpManager({ projectId }),
        scopedMgr,
      );
      assert.equal(
        sessionManager.buildPipelineContext(projectId, projectRoot).mcpManager,
        scopedMgr,
      );
    } finally {
      await Promise.all(Array.from(pcm.all(), (ctx) => ctx.close()));
    }
  });

  it("fails closed for no-project MCP sessions without cwd/default fallback", async () => {
    const { cwd } = tmpDirs();
    const sessionManager = new SessionManager() as any;
    const defaultMgr = { marker: "default" };
    const createMcpManagerCalls: unknown[] = [];
    const sessionId = "cwd-session";
    sessionManager.mcpManager = defaultMgr;
    sessionManager.createMcpManager = (...args: unknown[]) => {
      createMcpManagerCalls.push(args);
      throw new Error(
        "projectless sessions must not create cwd-scoped MCP managers",
      );
    };
    sessionManager.sessions.set(sessionId, { id: sessionId, cwd });

    assert.equal(
      await sessionManager.ensureMcpManagerForSession(sessionId),
      null,
    );
    assert.equal(sessionManager.getMcpManagerForSession(sessionId), null);
    assert.equal(
      await sessionManager.resolveMcpManagerForSession(sessionId),
      null,
    );
    assert.equal(
      await sessionManager.resolveMcpManagerForSession(
        sessionId,
        `cwd:${path.resolve(cwd)}`,
      ),
      null,
    );
    assert.deepEqual(createMcpManagerCalls, []);
  });

  it("refreshes external MCP tool registrations after pending marketplace reloads complete", async () => {
    const sessionManager = new SessionManager() as any;
    let release!: () => void;
    const done = new Promise<any>((resolve) => {
      release = () =>
        resolve({
          status: "ok",
          connected: ["late"],
          disconnected: [],
          unchanged: [],
          skippedErrored: [],
          failed: [],
          statuses: [],
        });
    });
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
    sessionManager.refreshExternalMcpToolRegistrations = () => {
      refreshCount += 1;
    };

    const result =
      await sessionManager.reloadMcpAfterMarketplaceMutation("server");
    assert.equal(result?.status, "pending");
    assert.equal(refreshCount, 0);
    release();
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshCount, 1);
  });
});
