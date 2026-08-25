#!/usr/bin/env node
/**
 * Mock MCP server for E2E tests.
 * Implements a minimal MCP server via stdio (JSON-RPC 2.0 over newline-delimited JSON).
 *
 * Supports:
 * - initialize handshake
 * - notifications/initialized (no response)
 * - tools/list — returns echo and add tools
 * - tools/call — executes echo (returns message) and add (returns sum)
 *
 * Usage: node mock-mcp-server.mjs
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

/** Send a JSON-RPC response to stdout */
function sendResponse(response) {
	process.stdout.write(JSON.stringify(response) + "\n");
}

/** Handle a JSON-RPC request or notification */
function handleMessage(msg) {
	const { jsonrpc, id, method, params } = msg;

	// Notifications have no id — no response expected
	if (id === undefined || id === null) {
		// notifications/initialized — just acknowledge silently
		return;
	}

	switch (method) {
		case "initialize":
			sendResponse({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "mock-mcp", version: "1.0.0" },
				},
			});
			break;

		case "tools/list":
			sendResponse({
				jsonrpc: "2.0",
				id,
				result: {
					tools: [
						{
							name: "echo",
							description: "Echoes back the provided message",
							inputSchema: {
								type: "object",
								properties: {
									message: { type: "string", description: "Message to echo" },
								},
								required: ["message"],
							},
						},
						{
							name: "add",
							description: "Adds two numbers together",
							inputSchema: {
								type: "object",
								properties: {
									a: { type: "number", description: "First number" },
									b: { type: "number", description: "Second number" },
								},
								required: ["a", "b"],
							},
						},
					],
				},
			});
			break;

		case "tools/call": {
			const toolName = params?.name;
			const args = params?.arguments || {};

			if (toolName === "echo") {
				sendResponse({
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: String(args.message ?? "") }],
					},
				});
			} else if (toolName === "add") {
				const sum = Number(args.a ?? 0) + Number(args.b ?? 0);
				sendResponse({
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: String(sum) }],
					},
				});
			} else {
				sendResponse({
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: "Unknown tool" }],
						isError: true,
					},
				});
			}
			break;
		}

		default:
			sendResponse({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32601,
					message: `Method not found: ${method}`,
				},
			});
			break;
	}
}

// Read newline-delimited JSON-RPC from stdin
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;

	try {
		const msg = JSON.parse(trimmed);
		handleMessage(msg);
	} catch (err) {
		// Malformed JSON — send parse error if we can
		process.stderr.write(`[mock-mcp] Parse error: ${err.message}\n`);
	}
});

// Clean shutdown
process.on("SIGTERM", () => {
	process.exit(0);
});

process.on("SIGINT", () => {
	process.exit(0);
});

// Keep alive until stdin closes
rl.on("close", () => {
	process.exit(0);
});
