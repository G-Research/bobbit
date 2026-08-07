import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { McpClient } from "../../src/server/mcp/mcp-client.ts";
import { McpManager } from "../../src/server/mcp/mcp-manager.ts";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpInitializeSnapshot,
  McpServerConfig,
  McpToolDef,
  McpToolResult,
} from "../../src/server/mcp/mcp-types.ts";

const INIT_RESULT = {
  protocolVersion: "2025-06-18",
  serverInfo: { name: "stock-mcp", version: "1.2.3" },
};

type ClientInternals = {
  _connected: boolean;
  _connectHttp: (config: McpServerConfig) => Promise<void>;
  _connectStdio: (config: McpServerConfig) => Promise<void>;
  _performInitialize: () => Promise<void>;
  _sendHttpNotification: (notification: JsonRpcNotification) => Promise<void>;
  _sendHttpRequest: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  _sendStdioNotification: (notification: JsonRpcNotification) => void;
  _sendStdioRequest: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
};

/**
 * Drives the real connect/initialize code with message-level transport fakes.
 * Core tests must not spawn a stock stdio server or bind an HTTP listener.
 */
async function connectWithFakeTransport(config: McpServerConfig, result: unknown) {
  const client = new McpClient(config.command ? "stdio-stock" : "http-stock");
  const internal = client as unknown as ClientInternals;
  const transports: string[] = [];
  const requests: JsonRpcRequest[] = [];
  const notifications: JsonRpcNotification[] = [];

  const respond = async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
    requests.push(request);
    return { jsonrpc: "2.0", id: request.id, result };
  };
  const notify = (notification: JsonRpcNotification): void => {
    notifications.push(notification);
  };

  internal._sendStdioRequest = respond;
  internal._sendStdioNotification = notify;
  internal._sendHttpRequest = respond;
  internal._sendHttpNotification = async (notification) => notify(notification);
  internal._connectStdio = async () => {
    transports.push("stdio");
    await internal._performInitialize();
    internal._connected = true;
  };
  internal._connectHttp = async () => {
    transports.push("http");
    await internal._performInitialize();
    internal._connected = true;
  };

  await client.connect(config);
  return { client, notifications, requests, transports };
}

function assertInitializeRequest(request: JsonRpcRequest): void {
  assert.equal(request.method, "initialize");
  assert.deepEqual(request.params, {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "bobbit", version: "0.1.6" },
  });
}

describe("MCP initialize negotiation status", () => {
  it("captures a defensive stdio handshake snapshot without changing initialize", async () => {
    const { client, notifications, requests, transports } = await connectWithFakeTransport(
      { command: "stock-command", args: ["--serve"] },
      INIT_RESULT,
    );
    try {
      assert.deepEqual(transports, ["stdio"]);
      assert.equal(requests.length, 1);
      assertInitializeRequest(requests[0]);
      assert.deepEqual(notifications, [{ jsonrpc: "2.0", method: "notifications/initialized", params: {} }]);
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
    const { client, notifications, requests, transports } = await connectWithFakeTransport(
      { url: "http://stock.test/mcp" },
      {
        protocolVersion: "not-a-protocol",
        serverInfo: { name: "stock-http", version: "bad\nversion" },
      },
    );
    try {
      assert.deepEqual(transports, ["http"]);
      assert.equal(requests.length, 1);
      assertInitializeRequest(requests[0]);
      assert.deepEqual(notifications, [{ jsonrpc: "2.0", method: "notifications/initialized", params: {} }]);
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
    status.negotiation!.serverName = "mutated";
    assert.equal(manager.getServerStatuses()[0].negotiation?.serverName, "stock-manager");
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
