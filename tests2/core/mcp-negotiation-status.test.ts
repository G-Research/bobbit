import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "vitest";

import { McpClient } from "../../src/server/mcp/mcp-client.ts";
import { McpManager } from "../../src/server/mcp/mcp-manager.ts";
import type { McpInitializeSnapshot, McpServerConfig, McpToolDef, McpToolResult } from "../../src/server/mcp/mcp-types.ts";

const INIT_RESULT = {
  protocolVersion: "2025-06-18",
  serverInfo: { name: "stock-mcp", version: "1.2.3" },
};

const STDIO_SERVER = [
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  for (;;) {",
  "    const end = buffer.indexOf('\\n');",
  "    if (end < 0) return;",
  "    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);",
  "    if (!line) continue;",
  "    const request = JSON.parse(line);",
  "    if (request.method === 'initialize') {",
  "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: " + JSON.stringify(INIT_RESULT) + " }) + '\\n');",
  "    }",
  "  }",
  "});",
].join("\n");

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("MCP initialize negotiation status", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("captures a defensive stdio handshake snapshot without changing initialize", async () => {
    const client = new McpClient("stdio-stock");
    await client.connect({ command: process.execPath, args: ["-e", STDIO_SERVER] });
    try {
      assert.deepEqual(client.initializeSnapshot, {
        requestedProtocol: "2024-11-05",
        negotiatedProtocol: "2025-06-18",
        serverName: "stock-mcp",
        serverVersion: "1.2.3",
      });

      const copy = client.initializeSnapshot!;
      copy.serverName = "mutated";
      assert.equal(client.initializeSnapshot?.serverName, "stock-mcp");
    } finally {
      await client.disconnect();
    }
    assert.equal(client.initializeSnapshot, undefined);
  });

  it("captures HTTP handshake identity and ignores malformed server-controlled fields", async () => {
    let initializeRequest: Record<string, unknown> | undefined;
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (rpc.method === "initialize") initializeRequest = rpc;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "not-a-protocol",
            serverInfo: { name: "stock-http", version: "bad\nversion" },
          },
        }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const client = new McpClient("http-stock");
    await client.connect({ url: `http://127.0.0.1:${address.port}/mcp` });
    try {
      assert.equal((initializeRequest?.params as { protocolVersion?: string }).protocolVersion, "2024-11-05");
      assert.deepEqual(client.initializeSnapshot, { requestedProtocol: "2024-11-05", serverName: "stock-http" });
    } finally {
      await client.disconnect();
    }
  });

  it("propagates a client's safe snapshot through the manager status", async () => {
    const snapshot: McpInitializeSnapshot = {
      requestedProtocol: "2024-11-05",
      negotiatedProtocol: "2025-06-18",
      serverName: "stock-manager",
      serverVersion: "4.0.0",
    };
    const client = new StubMcpClient(snapshot);
    const manager = new TestMcpManager(client);

    await manager.connectServer("adopt_runtime", { command: "stock-command" });

    const status = manager.getServerStatuses()[0];
    assert.deepEqual(status.negotiation, snapshot);
    assert.notEqual(status.negotiation, client.initializeSnapshot);
  });
});

class StubMcpClient {
  connected = false;

  constructor(private readonly snapshot: McpInitializeSnapshot) {}

  get initializeSnapshot(): McpInitializeSnapshot {
    return { ...this.snapshot };
  }

  async connect(_config: McpServerConfig): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<McpToolDef[]> {
    return [];
  }

  async callTool(_name: string, _args: Record<string, unknown>): Promise<McpToolResult> {
    return { content: [] };
  }
}

class TestMcpManager extends (McpManager as any) {
  constructor(private readonly client: StubMcpClient) {
    super("/tmp/mcp-negotiation-status");
  }

  protected _createClient(_name: string): McpClient {
    return this.client as unknown as McpClient;
  }
}
