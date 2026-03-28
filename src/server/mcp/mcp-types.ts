/** MCP server configuration (matches .mcp.json format) */
export interface McpServerConfig {
  command?: string;          // For stdio transport
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;              // For HTTP transport
  headers?: Record<string, string>;
}

/** MCP config file format */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no id, no response expected) */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/** MCP tool definition from tools/list */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

/** MCP tool call result content block */
export interface McpContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;      // base64 for images
  mimeType?: string;
}

/** MCP tool call result */
export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}
