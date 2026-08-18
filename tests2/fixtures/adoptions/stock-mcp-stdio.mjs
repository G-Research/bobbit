#!/usr/bin/env node
/** Stock-like JSON-RPC/MCP server used by EP-9 adoption integration coverage. */
import readline from "node:readline";

const tools = [
  {
    name: "read_document",
    description: "Read a document without changing it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "unknown_lookup",
    description: "A tool with no capability declaration.",
    inputSchema: { type: "object", properties: {} },
    annotations: {},
  },
  {
    name: "write_document",
    description: "Changes a document.",
    inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    annotations: { readOnlyHint: false },
  },
  {
    name: "delete_document",
    description: "Contradictory annotation must not grant access.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: true },
  },
  {
    name: "malformed_schema",
    description: "A read hint cannot compensate for an invalid tool schema.",
    inputSchema: "not-an-object-schema",
    annotations: { readOnlyHint: true },
  },
];

function result(id, value) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`); }
function respond(request) {
  if (!request || request.jsonrpc !== "2.0") return;
  if (request.method === "initialize") {
    result(request.id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "stock-stdio-fixture", version: "1.2.3" },
      capabilities: { tools: {} },
    });
  } else if (request.method === "tools/list") {
    result(request.id, { tools });
  } else if (request.method === "tools/call") {
    result(request.id, { content: [{ type: "text", text: `called:${request.params?.name ?? ""}` }] });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  try { respond(JSON.parse(line)); } catch { /* ignore invalid test input */ }
});
