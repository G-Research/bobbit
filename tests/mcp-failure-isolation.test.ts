/**
 * Unit tests for failure isolation in McpManager (Track B of mcp-meta-tool-aggregation).
 *
 * Covers:
 *  - `tools/list` timeout on one server doesn't break a sibling server.
 *  - Malformed-schema ops are dropped, valid siblings on the same server survive.
 *  - `callTool` timeout throws a clean error message.
 *  - `getServerStatuses()` reports `error` after a failed `connectServer`.
 *
 * Uses stub `McpClient` instances injected via a `_createClient` override
 * (no real subprocesses). Test timeouts are tiny (20–50 ms) via constructor opts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const { McpManager } = await import("../src/server/mcp/mcp-manager.ts");
import type { McpToolDef, McpToolResult, McpServerConfig } from "../src/server/mcp/mcp-types.ts";

/** Minimal stub matching the surface of McpClient used by McpManager. */
class StubMcpClient {
  public connected = false;
  constructor(
    public name: string,
    private opts: {
      listToolsImpl?: () => Promise<McpToolDef[]>;
      callToolImpl?: (toolName: string, args: Record<string, unknown>) => Promise<McpToolResult>;
      connectImpl?: () => Promise<void>;
    } = {},
  ) {}

  async connect(_config: McpServerConfig): Promise<void> {
    if (this.opts.connectImpl) await this.opts.connectImpl();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<McpToolDef[]> {
    if (!this.opts.listToolsImpl) return [];
    return this.opts.listToolsImpl();
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    if (!this.opts.callToolImpl) {
      return { content: [{ type: "text", text: "ok" }] };
    }
    return this.opts.callToolImpl(toolName, args);
  }
}

/** Subclass that injects per-name stub clients via the protected factory hook. */
class TestMcpManager extends (McpManager as any) {
  private _stubs: Map<string, StubMcpClient>;
  constructor(
    cwd: string,
    stateDir: string,
    stubs: Map<string, StubMcpClient>,
    opts?: { listToolsTimeoutMs?: number; callToolTimeoutMs?: number },
  ) {
    super(cwd, undefined, stateDir, opts);
    this._stubs = stubs;
  }
  protected _createClient(name: string): any {
    const stub = this._stubs.get(name);
    if (!stub) throw new Error(`No stub registered for "${name}"`);
    return stub;
  }
}

/** Build a fresh isolated TestMcpManager. */
function makeManager(
  stubs: Record<string, StubMcpClient>,
  opts?: { listToolsTimeoutMs?: number; callToolTimeoutMs?: number },
) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fi-"));
  const cwd = path.join(tmpRoot, "cwd");
  const stateDir = path.join(tmpRoot, "state");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const stubMap = new Map(Object.entries(stubs));
  const mgr = new TestMcpManager(cwd, stateDir, stubMap, opts) as any;
  return mgr;
}

const validOp = (name: string, props: Record<string, unknown> = {}): McpToolDef => ({
  name,
  description: `${name} description.`,
  inputSchema: { type: "object", properties: props },
});

const STUB_CONFIG: McpServerConfig = { command: "stub" };

describe("McpManager failure isolation", () => {
  it("one server's tools/list timeout does not break a sibling server", async () => {
    const slow = new StubMcpClient("slow", {
      // never resolves within the timeout window
      listToolsImpl: () => new Promise(() => {}),
    });
    const fast = new StubMcpClient("fast", {
      listToolsImpl: async () => [validOp("ping"), validOp("pong")],
    });

    const mgr = makeManager({ slow, fast }, { listToolsTimeoutMs: 30 });

    await Promise.all([
      mgr.connectServer("slow", STUB_CONFIG),
      mgr.connectServer("fast", STUB_CONFIG),
    ]);

    const statuses = mgr.getServerStatuses();
    const byName = Object.fromEntries(statuses.map((s: any) => [s.name, s]));

    assert.equal(byName.slow.status, "error");
    assert.match(byName.slow.error ?? "", /timed out after 30 ms/);
    assert.equal(byName.slow.toolCount, 0);

    assert.equal(byName.fast.status, "connected");
    assert.equal(byName.fast.toolCount, 2);

    const fastTools = mgr.getToolInfos().filter((t: any) => t.serverName === "fast");
    assert.deepEqual(
      fastTools.map((t: any) => t.mcpToolName).sort(),
      ["ping", "pong"],
    );
  });

  it("server with one malformed-schema op keeps its valid ops", async () => {
    const mixed = new StubMcpClient("mixed", {
      listToolsImpl: async () => [
        validOp("good_a"),
        // Malformed: type is not "object"
        { name: "bad_array", inputSchema: { type: "array" } } as McpToolDef,
        validOp("good_b"),
        // Malformed: empty name
        { name: "", inputSchema: { type: "object" } } as McpToolDef,
      ],
    });

    const mgr = makeManager({ mixed }, { listToolsTimeoutMs: 200 });
    await mgr.connectServer("mixed", STUB_CONFIG);

    const statuses = mgr.getServerStatuses();
    const status = statuses.find((s: any) => s.name === "mixed");
    assert.ok(status);
    assert.equal(status.status, "connected");
    assert.equal(status.toolCount, 2);

    const tools = mgr.getToolInfos().filter((t: any) => t.serverName === "mixed");
    const names = tools.map((t: any) => t.mcpToolName).sort();
    assert.deepEqual(names, ["good_a", "good_b"]);
    assert.ok(!names.includes("bad_array"));
    assert.ok(!names.includes(""));
  });

  it("callTool times out cleanly with a useful error message", async () => {
    const hung = new StubMcpClient("hung", {
      listToolsImpl: async () => [validOp("op1")],
      callToolImpl: () => new Promise(() => {}),
    });

    const mgr = makeManager(
      { hung },
      { listToolsTimeoutMs: 200, callToolTimeoutMs: 25 },
    );
    await mgr.connectServer("hung", STUB_CONFIG);

    const start = Date.now();
    await assert.rejects(
      () => mgr.callTool("mcp__hung__op1", {}),
      (err: Error) => {
        assert.match(err.message, /MCP tool "mcp__hung__op1" timed out after 25 ms/);
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `callTool took ${elapsed} ms, expected < 2000`);
  });

  it("getServerStatuses() reports `error` with the failure message after listTools timeout", async () => {
    const broken = new StubMcpClient("broken", {
      listToolsImpl: () => new Promise(() => {}),
    });
    const mgr = makeManager({ broken }, { listToolsTimeoutMs: 20 });

    await mgr.connectServer("broken", STUB_CONFIG);

    const statuses = mgr.getServerStatuses();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].name, "broken");
    assert.equal(statuses[0].status, "error");
    assert.ok(statuses[0].error);
    assert.match(statuses[0].error, /tools\/list timed out/);
  });

  it("listTools that throws synchronously is captured as error, not propagated", async () => {
    const throwy = new StubMcpClient("throwy", {
      listToolsImpl: async () => {
        throw new Error("RPC blew up");
      },
    });
    const mgr = makeManager({ throwy }, { listToolsTimeoutMs: 200 });

    // Must not throw out of connectServer.
    await mgr.connectServer("throwy", STUB_CONFIG);

    const status = mgr.getServerStatuses().find((s: any) => s.name === "throwy");
    assert.equal(status?.status, "error");
    assert.match(status?.error ?? "", /RPC blew up/);
  });
});
