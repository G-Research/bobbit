#!/usr/bin/env node
/** Local streamable-HTTP MCP fixture. argv[2] receives the bound endpoint URL. */
import fs from "node:fs";
import http from "node:http";

const outputFile = process.argv[2];
if (!outputFile) throw new Error("usage: stock-mcp-streamable-http.mjs <endpoint-output-file>");

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

const server = http.createServer((req, res) => {
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
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  fs.writeFileSync(outputFile, `http://127.0.0.1:${address.port}/mcp`, "utf8");
});
function stop() { server.close(() => process.exit(0)); }
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
