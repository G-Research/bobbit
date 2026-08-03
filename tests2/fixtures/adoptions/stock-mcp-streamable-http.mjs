#!/usr/bin/env node
/** Stock-like streamable-HTTP MCP server used by EP-9 adoption coverage. */
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

const tools = [
  {
    name: "list_records",
    description: "A safe stock operation.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "discover_records",
    description: "Capability not declared by stock server.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_record",
    description: "A mutation that must stay unselected.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    annotations: { readOnlyHint: false },
  },
  {
    name: "bad_schema",
    description: "Malformed schema fixture.",
    inputSchema: [],
    annotations: { readOnlyHint: true },
  },
];

function createFixtureServer() {
  return http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404).end(); return; }
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      let message;
      try { message = JSON.parse(raw); } catch { res.writeHead(400).end("bad json"); return; }
      if (!message.id) { res.writeHead(202).end(); return; }
      let result;
      if (message.method === "initialize") {
        result = { protocolVersion: "2024-11-05", serverInfo: { name: "stock-http-fixture", version: "4.5.6" }, capabilities: { tools: {} } };
      } else if (message.method === "tools/list") {
        result = { tools };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: `called:${message.params?.name ?? ""}` }] };
      } else {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }));
        return;
      }
      // Exercise the client streamable-HTTP SSE response parser.
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "stock-http-session" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    });
  });
}

/** Starts the stock endpoint in the test process; tier-1 must not spawn fixtures. */
export async function startStockHttpFixture() {
  const server = createFixtureServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP MCP fixture did not bind a loopback port");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

// Retain a directly runnable fixture for the browser/E2E tier without starting
// anything when this module is imported by tier-1 integration coverage.
const outputFile = process.argv[2];
if (process.argv[1] === fileURLToPath(import.meta.url) && outputFile) {
  const fixture = await startStockHttpFixture();
  fs.writeFileSync(outputFile, fixture.endpoint, "utf8");
  const stop = () => { void fixture.close().then(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
