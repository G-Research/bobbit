import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

export interface RecordedMcpRequest {
	method: string;
	headers: http.IncomingHttpHeaders;
}

export interface RecordingMcpServer {
	url: string;
	requests: RecordedMcpRequest[];
	close(): Promise<void>;
}

/** Start a loopback Streamable HTTP MCP endpoint and retain only safe request metadata. */
export async function startRecordingMcpServer(toolName = "probe"): Promise<RecordingMcpServer> {
	const requests: RecordedMcpRequest[] = [];
	const server = http.createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk;
		let message: { id?: unknown; method?: unknown } = {};
		try { message = JSON.parse(raw || "{}"); } catch { /* test endpoint reports an empty method */ }
		const method = typeof message.method === "string" ? message.method : "";
		requests.push({ method, headers: req.headers });

		if (method === "notifications/initialized") {
			res.writeHead(202, { "content-type": "text/plain" });
			res.end();
			return;
		}
		const result = method === "initialize"
			? {
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "approval-boundary-fixture", version: "1.0.0" },
			}
			: method === "tools/list"
				? { tools: [{ name: toolName, description: "Approval boundary probe", inputSchema: { type: "object", properties: {} } }] }
				: {};
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Recording MCP server did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
	};
}

/** Write project-controlled .mcp.json definitions. */
export function writeProjectMcpServers(root: string, servers: Record<string, Record<string, unknown>>): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2), "utf8");
}

export function writeProjectMcpConfig(root: string, serverName: string, config: Record<string, unknown>): void {
	writeProjectMcpServers(root, { [serverName]: config });
}

/** Test double whose connect call is the stdio process-spawn sentinel. */
export class SpawnRecordingMcpClient {
	connected = false;
	constructor(readonly name: string, private readonly markerPath: string) {}
	async connect(): Promise<void> {
		appendFileSync(this.markerPath, "spawn\n", "utf8");
		this.connected = true;
	}
	async disconnect(): Promise<void> { this.connected = false; }
	async listTools(): Promise<Array<Record<string, unknown>>> {
		return [{ name: "probe", description: "Approval boundary probe", inputSchema: { type: "object", properties: {} } }];
	}
}

export function appendCount(file: string): number {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}
