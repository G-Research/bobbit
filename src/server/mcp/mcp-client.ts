import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type {
  McpServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  McpToolDef,
  McpToolResult,
} from './mcp-types.js';

const CONNECTION_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

const CLIENT_INFO = { name: 'bobbit', version: '0.1.6' };
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Expand `${VAR}` patterns in a string using process.env.
 * Unresolved variables are replaced with empty string.
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Expand env vars in all values of a config env record.
 */
function expandEnvRecord(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = expandEnvVars(value);
  }
  return result;
}

type PendingRequest = {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * MCP JSON-RPC 2.0 client supporting stdio and HTTP transports.
 */
export class McpClient {
  private _connected = false;
  private _config: McpServerConfig | null = null;
  private _nextId = 1;

  // Stdio transport state
  private _process: ChildProcess | null = null;
  private _readline: ReadlineInterface | null = null;
  private _pendingRequests = new Map<number, PendingRequest>();

  constructor(private serverName: string) {}

  /** Whether the client is currently connected */
  get connected(): boolean {
    return this._connected;
  }

  /** Connect to MCP server. Spawns process (stdio) or validates URL (HTTP). Sends initialize handshake. */
  async connect(config: McpServerConfig): Promise<void> {
    this._config = config;

    if (config.command) {
      await this._connectStdio(config);
    } else if (config.url) {
      await this._connectHttp(config);
    } else {
      throw new Error(`[mcp:${this.serverName}] Config must have either 'command' (stdio) or 'url' (HTTP)`);
    }
  }

  /** Call tools/list and return tool definitions */
  async listTools(): Promise<McpToolDef[]> {
    this._assertConnected();
    const response = await this._sendRequest('tools/list', {});
    const result = response.result as { tools?: McpToolDef[] } | undefined;
    return result?.tools ?? [];
  }

  /** Call tools/call with the given tool name and arguments */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this._assertConnected();
    const response = await this._sendRequest('tools/call', { name, arguments: args });

    if (response.error) {
      return {
        content: [{ type: 'text', text: response.error.message }],
        isError: true,
      };
    }

    const result = response.result as McpToolResult | undefined;
    return result ?? { content: [], isError: false };
  }

  /** Graceful shutdown */
  async disconnect(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;

    // Reject all pending requests
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`[mcp:${this.serverName}] Client disconnecting`));
      this._pendingRequests.delete(id);
    }

    if (this._process) {
      const proc = this._process;
      this._process = null;

      this._readline?.close();
      this._readline = null;

      // Try graceful shutdown, then force kill after 5s
      if (!proc.killed) {
        proc.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
        proc.once('exit', () => clearTimeout(killTimer));
      }
    }

    this._config = null;
    this._log('Disconnected');
  }

  // ── Stdio transport ──────────────────────────────────────────────

  private async _connectStdio(config: McpServerConfig): Promise<void> {
    const { command, args = [], env, cwd } = config;

    // Build environment: inherit process.env, overlay expanded config env
    const childEnv = { ...process.env };
    if (env) {
      const expanded = expandEnvRecord(env);
      Object.assign(childEnv, expanded);
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`[mcp:${this.serverName}] Connection timeout (${CONNECTION_TIMEOUT_MS}ms)`));
        // Kill process directly — this.disconnect() guards on this._connected which is still false
        if (this._process) {
          this._process.kill('SIGTERM');
          this._process = null;
        }
        if (this._readline) {
          this._readline.close();
          this._readline = null;
        }
      }, CONNECTION_TIMEOUT_MS);

      try {
        this._process = spawn(command!, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv,
          cwd: cwd || undefined,
          windowsHide: true,
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(new Error(`[mcp:${this.serverName}] Failed to spawn process: ${err}`));
        return;
      }

      const proc = this._process;

      // Handle spawn error
      proc.on('error', (err) => {
        clearTimeout(timeout);
        this._connected = false;
        this._log(`Process error: ${err.message}`);
        reject(new Error(`[mcp:${this.serverName}] Process error: ${err.message}`));
      });

      // Handle unexpected exit
      proc.on('exit', (code, signal) => {
        this._connected = false;
        this._process = null;
        this._readline?.close();
        this._readline = null;

        // Reject all pending requests
        for (const [id, pending] of this._pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`[mcp:${this.serverName}] Process exited (code=${code}, signal=${signal})`));
          this._pendingRequests.delete(id);
        }

        this._log(`Process exited (code=${code}, signal=${signal})`);
      });

      // Log stderr
      proc.stderr?.on('data', (data: Buffer) => {
        this._log(`stderr: ${data.toString().trimEnd()}`);
      });

      // Set up readline for newline-delimited JSON-RPC on stdout
      this._readline = createInterface({ input: proc.stdout! });
      this._readline.on('line', (line: string) => {
        this._handleStdioLine(line);
      });

      // Perform initialize handshake
      this._performInitialize()
        .then(() => {
          clearTimeout(timeout);
          this._connected = true;
          this._log('Connected (stdio)');
          resolve();
        })
        .catch((err) => {
          clearTimeout(timeout);
          this.disconnect();
          reject(err);
        });
    });
  }

  private _handleStdioLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this._log(`Invalid JSON from server: ${trimmed.slice(0, 200)}`);
      return;
    }

    // Match response to pending request
    if (typeof message.id === 'number') {
      const pending = this._pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingRequests.delete(message.id);
        pending.resolve(message);
      }
    }
    // Notifications from server (no id) are logged but ignored
  }

  private _sendStdioRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this._process?.stdin?.writable) {
        reject(new Error(`[mcp:${this.serverName}] stdin not writable`));
        return;
      }

      const timer = setTimeout(() => {
        this._pendingRequests.delete(request.id);
        reject(new Error(`[mcp:${this.serverName}] Request timeout (${REQUEST_TIMEOUT_MS}ms) for ${request.method}`));
      }, REQUEST_TIMEOUT_MS);

      this._pendingRequests.set(request.id, { resolve, reject, timer });

      const data = JSON.stringify(request) + '\n';
      this._process.stdin.write(data, (err) => {
        if (err) {
          clearTimeout(timer);
          this._pendingRequests.delete(request.id);
          reject(new Error(`[mcp:${this.serverName}] Failed to write to stdin: ${err.message}`));
        }
      });
    });
  }

  private _sendStdioNotification(notification: JsonRpcNotification): void {
    if (!this._process?.stdin?.writable) return;
    const data = JSON.stringify(notification) + '\n';
    this._process.stdin.write(data);
  }

  // ── HTTP transport ───────────────────────────────────────────────

  private async _connectHttp(config: McpServerConfig): Promise<void> {
    // Validate URL
    try {
      new URL(config.url!);
    } catch {
      throw new Error(`[mcp:${this.serverName}] Invalid URL: ${config.url}`);
    }

    // Perform initialize handshake over HTTP
    await this._performInitialize();
    this._connected = true;
    this._log('Connected (HTTP)');
  }

  private async _sendHttpRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const url = this._config!.url!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._config!.headers,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      return await response.json() as JsonRpcResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`[mcp:${this.serverName}] Request timeout (${REQUEST_TIMEOUT_MS}ms) for ${request.method}`);
      }
      throw new Error(`[mcp:${this.serverName}] HTTP request failed: ${err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async _sendHttpNotification(notification: JsonRpcNotification): Promise<void> {
    const url = this._config!.url!;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._config!.headers,
    };

    // Fire and forget — notifications don't expect responses
    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(notification),
      });
    } catch {
      // Ignore errors for notifications
    }
  }

  // ── Transport-agnostic helpers ───────────────────────────────────

  private _isStdio(): boolean {
    return !!this._config?.command;
  }

  private async _sendRequest(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this._nextId++,
      method,
      params,
    };

    if (this._isStdio()) {
      return this._sendStdioRequest(request);
    } else {
      return this._sendHttpRequest(request);
    }
  }

  private _sendNotification(method: string, params?: Record<string, unknown>): void | Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    };

    if (this._isStdio()) {
      this._sendStdioNotification(notification);
    } else {
      // HTTP notifications are async but we don't await in most call-sites
      return this._sendHttpNotification(notification);
    }
  }

  /** Perform the MCP initialize handshake */
  private async _performInitialize(): Promise<void> {
    const response = await this._sendRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });

    if (response.error) {
      throw new Error(`[mcp:${this.serverName}] Initialize failed: ${response.error.message}`);
    }

    // Send initialized notification
    await this._sendNotification('notifications/initialized', {});
  }

  private _assertConnected(): void {
    if (!this._connected) {
      throw new Error(`[mcp:${this.serverName}] Not connected`);
    }
  }

  private _log(message: string): void {
    console.error(`[mcp:${this.serverName}] ${message}`);
  }
}
