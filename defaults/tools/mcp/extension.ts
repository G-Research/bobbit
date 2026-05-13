/**
 * mcp_describe extension — discovery tool for MCP server operations.
 *
 * Registers a single `mcp_describe(server, operation?)` tool that proxies to
 * the gateway endpoint `POST /api/internal/mcp-describe`. The server-side
 * endpoint is responsible for resolving the per-server operation list and
 * JSON Schemas.
 *
 * Response shape from the gateway:
 *   { tools: Array<{ name, description?, inputSchema }> }   // operation omitted
 *   { tool:  {       name, description?, inputSchema   } }   // operation given
 *   { error: string }                                         // failure
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

function getGatewayUrl(): string {
	if (process.env.BOBBIT_GATEWAY_URL) return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
	const urlPath = path.join(bobbitDir, "state", "gateway-url");
	return fs.readFileSync(urlPath, "utf-8").trim();
}

function getGatewayToken(): string {
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
	const tokenPath = path.join(bobbitDir, "state", "token");
	return fs.readFileSync(tokenPath, "utf-8").trim();
}

async function callDescribe(server: string, operation?: string): Promise<any> {
	const gwUrl = getGatewayUrl();
	const token = getGatewayToken();
	const body = JSON.stringify(operation ? { server, operation } : { server });
	const url = new URL(gwUrl + "/api/internal/mcp-describe");
	const mod: any = url.protocol === "https:" ? await import("node:https") : await import("node:http");
	return await new Promise((resolve, reject) => {
		const req = mod.request(url, {
			method: "POST",
			headers: {
				"Authorization": "Bearer " + token,
				"Content-Type": "application/json",
				"Content-Length": Buffer.byteLength(body),
				"X-Bobbit-Session-Id": process.env.BOBBIT_SESSION_ID || "",
			},
			...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
		}, (res: any) => {
			let data = "";
			res.on("data", (chunk: Buffer | string) => { data += chunk; });
			res.on("end", () => {
				try { resolve(JSON.parse(data)); }
				catch { resolve({ error: data || `HTTP ${res.statusCode}` }); }
			});
		});
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}

function formatTool(t: McpToolDescriptor): string {
	const parts: string[] = [];
	parts.push(`## ${t.name}`);
	if (t.description && t.description.trim()) {
		parts.push("");
		parts.push(t.description.trim());
	}
	parts.push("");
	parts.push("```json");
	parts.push(JSON.stringify(t.inputSchema ?? {}, null, 2));
	parts.push("```");
	return parts.join("\n");
}

function formatResponse(server: string, result: any): { text: string; isError: boolean } {
	if (result && typeof result.error === "string") {
		return { text: `error: ${result.error}`, isError: true };
	}
	if (result && result.tool && typeof result.tool === "object") {
		return { text: `# ${server}\n\n${formatTool(result.tool as McpToolDescriptor)}`, isError: false };
	}
	if (result && Array.isArray(result.tools)) {
		const tools = result.tools as McpToolDescriptor[];
		if (tools.length === 0) {
			return { text: `# ${server}\n\n(no operations available)`, isError: false };
		}
		const sections = tools.map(formatTool).join("\n\n");
		return { text: `# ${server} (${tools.length} operation${tools.length === 1 ? "" : "s"})\n\n${sections}`, isError: false };
	}
	return { text: `error: unexpected response from gateway: ${JSON.stringify(result)}`, isError: true };
}

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "mcp_describe",
		label: "MCP Describe",
		description: "Return JSON Schema for MCP server operations. Omit `operation` to list all.",
		promptSnippet:
			"mcp_describe(server, operation?) - Fetch operation schemas for an MCP server on demand.",
		promptGuidelines: [
			"Call mcp_describe(server) once when you need to discover what an MCP server can do.",
			"Call mcp_describe(server, operation) to get just one op's schema before invoking it.",
			"After describing, invoke the operation via the `mcp_<server>` meta-tool.",
		],
		parameters: Type.Object({
			server: Type.String(),
			operation: Type.Optional(Type.String()),
		}),

		async execute(_toolCallId, params) {
			const server = String((params as any).server || "").trim();
			const operation = (params as any).operation ? String((params as any).operation).trim() : undefined;
			if (!server) {
				return {
					isError: true,
					content: [{ type: "text", text: "error: `server` is required" }],
				};
			}
			let result: any;
			try {
				result = await callDescribe(server, operation);
			} catch (err: any) {
				return {
					isError: true,
					content: [{ type: "text", text: `error: ${err?.message ?? String(err)}` }],
				};
			}
			const { text, isError } = formatResponse(server, result);
			return {
				...(isError ? { isError: true } : {}),
				content: [{ type: "text", text }],
			};
		},
	});
};

export default extension;
