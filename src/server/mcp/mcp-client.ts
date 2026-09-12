import * as http from 'node:http';
import * as https from 'node:https';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { IncomingHttpHeaders } from 'node:http';
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
const REDACTED = '[redacted]';
const MAX_RUNTIME_ERROR_LENGTH = 1_000;

/**
 * Expand `${VAR}` patterns in a string using process.env.
 * Unresolved variables are replaced with empty string.
 */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Expand env vars in all values of a config env record.
 */
export function expandEnvRecord(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expandEnvVars(value)]));
}

export function buildMcpProcessEnv(env?: Record<string, string>): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ...Object.entries(process.env),
    ...Object.entries(env ? expandEnvRecord(env) : {}),
  ]);
}

function stringRecordValues(record: Record<string, string> | undefined): string[] {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.values(record).filter((value): value is string => typeof value === 'string');
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactedDiagnosticUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return REDACTED;
  }
}

function configuredRuntimeSecrets(config: McpServerConfig | null | undefined): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const rawValues = [
    ...stringRecordValues(config.env),
    ...stringRecordValues(config.headers),
  ];
  const values = [...rawValues, ...rawValues.map(expandEnvVars)];

  if (typeof config.url === 'string' && config.url) {
    for (const rawUrl of new Set([config.url, expandEnvVars(config.url)])) {
      try {
        const url = new URL(rawUrl);
        values.push(url.username, decodeUrlComponent(url.username));
        values.push(url.password, decodeUrlComponent(url.password));
        for (const value of url.searchParams.values()) {
          values.push(value, decodeUrlComponent(value));
        }
        for (const part of url.search.slice(1).split('&')) {
          const equals = part.indexOf('=');
          if (equals >= 0) values.push(part.slice(equals + 1));
        }
        const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
        values.push(fragment, decodeUrlComponent(fragment));
      } catch {
        // The complete malformed URL is still projected below. It has no safe
        // structure from which to extract individual credential components.
      }
    }
  }

  return [...new Set(values.filter((value) => value && value !== REDACTED))]
    .sort((a, b) => b.length - a.length);
}

/**
 * Project an MCP transport/runtime failure to bounded health text. Configured
 * environment/header values are expanded exactly as the transport expands env
 * values, and URL credentials are removed in both whole-URL and component form.
 */
export function sanitizeMcpRuntimeError(
  error: unknown,
  config: McpServerConfig | null | undefined,
): string {
  let message = error instanceof Error ? error.message : String(error);
  if (!message) message = 'Unknown MCP runtime error';

  if (config && typeof config === 'object' && !Array.isArray(config) && typeof config.url === 'string' && config.url) {
    const urls = [...new Set([config.url, expandEnvVars(config.url)])]
      .flatMap((raw) => {
        try {
          const parsed = new URL(raw);
          return [raw, parsed.href, decodeUrlComponent(raw), decodeUrlComponent(parsed.href)];
        } catch {
          return [raw];
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const rawUrl of urls) {
      message = message.split(rawUrl).join(redactedDiagnosticUrl(rawUrl));
    }
  }

  for (const secret of configuredRuntimeSecrets(config)) {
    message = message.split(secret).join(REDACTED);
  }
  return message.slice(0, MAX_RUNTIME_ERROR_LENGTH);
}

function jsonRpcErrorMessage(error: JsonRpcResponse['error']): string {
  if (!error) return 'unknown JSON-RPC error';
  return error.message || JSON.stringify(error);
}

function responseHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
}

class HttpRequestTimeoutError extends Error {
  constructor(serverName: string, method: string) {
    super(`[mcp:${serverName}] Request timeout (${REQUEST_TIMEOUT_MS}ms) for ${method}`);
    this.name = 'HttpRequestTimeoutError';
  }
}

type NativeHttpResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
};

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
  private _httpSessionId: string | null = null;

  constructor(private serverName: string) {}

  /** Whether the client is currently connected */
  get connected(): boolean {
    return this._connected;
  }

  /** Connect to MCP server. Spawns process (stdio) or validates URL (HTTP). Sends initialize handshake. */
  async connect(config: McpServerConfig): Promise<void> {
    this._config = config;
    this._httpSessionId = null;

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
    if (response.error) {
      const reason = sanitizeMcpRuntimeError(jsonRpcErrorMessage(response.error), this._config);
      throw new Error(`[mcp:${this.serverName}] tools/list failed: ${reason}`);
    }
    const result = response.result as { tools?: McpToolDef[] } | undefined;
    return result?.tools ?? [];
  }

  /** Call tools/call with the given tool name and arguments */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this._assertConnected();
    const response = await this._sendRequest('tools/call', { name, arguments: args });

    if (response.error) {
      const rawMessage = typeof response.error === 'object'
        ? (response.error.message || JSON.stringify(response.error))
        : String(response.error);
      const errMsg = sanitizeMcpRuntimeError(rawMessage, this._config);
      return {
        content: [{ type: 'text', text: errMsg }],
        isError: true,
      };
    }

    const result = response.result as McpToolResult | undefined;
    if (result && !Array.isArray(result.content)) {
      this._log(`Warning: tools/call "${name}" returned result with non-array content: ${JSON.stringify(result).slice(0, 500)}`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    }
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
    this._httpSessionId = null;
    this._log('Disconnected');
  }

  // ── Stdio transport ──────────────────────────────────────────────

  private async _connectStdio(config: McpServerConfig): Promise<void> {
    const { command, args = [], env, cwd } = config;

    // Object.fromEntries in buildMcpProcessEnv creates own data properties even
    // for names such as "__proto__", keeping spawned behavior aligned with
    // approval fingerprints.
    const childEnv = buildMcpProcessEnv(env);

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
        // On Windows we need shell: true so commands like `npx` resolve.
        // But passing args separately with shell: true triggers DEP0190, so
        // we join everything into a single shell string with no args array.
        const useShell = process.platform === 'win32';
        let spawnCmd: string;
        let spawnArgs: string[];
        if (useShell) {
          // Quote the command if it contains spaces, then append quoted args
          const quotedCmd = command!.includes(' ') ? `"${command!}"` : command!;
          const quotedArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
          spawnCmd = [quotedCmd, ...quotedArgs].join(' ');
          spawnArgs = [];
        } else {
          spawnCmd = command!;
          spawnArgs = args;
        }
        this._process = spawn(spawnCmd, spawnArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv,
          cwd: cwd || undefined,
          windowsHide: true,
          shell: useShell,
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

  private _postHttpJson(url: string, headers: Record<string, string>, body: string, method: string): Promise<NativeHttpResponse> {
    return new Promise((resolve, reject) => {
      const endpoint = new URL(url);
      const requestFn = endpoint.protocol === 'https:'
        ? https.request
        : endpoint.protocol === 'http:'
          ? http.request
          : null;
      if (!requestFn) {
        reject(new Error(`Unsupported HTTP protocol: ${endpoint.protocol}`));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: typeof resolve | typeof reject, value: NativeHttpResponse | Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        (fn as (value: NativeHttpResponse | Error) => void)(value);
      };

      const req = requestFn(endpoint, {
        method: 'POST',
        headers,
        agent: false,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          settle(resolve, {
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => settle(reject, err));
        res.on('aborted', () => settle(reject, new Error('HTTP response aborted')));
      });

      timer = setTimeout(() => {
        req.destroy(new HttpRequestTimeoutError(this.serverName, method));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();

      req.on('error', (err) => settle(reject, err));
      req.end(body);
    });
  }

  private _hasConfiguredHttpSessionHeader(): boolean {
    const headers = this._config?.headers;
    return !!headers && Object.keys(headers).some((name) => name.toLowerCase() === 'mcp-session-id');
  }

  private _httpRequestHeaders(): Record<string, string> {
    const configuredSessionHeader = this._hasConfiguredHttpSessionHeader();
    const entries: Array<[string, string]> = [
      ['Content-Type', 'application/json'],
      // Streamable HTTP transport spec: client MUST advertise both response shapes.
      ['Accept', 'application/json, text/event-stream'],
    ];
    // Server-assigned streamable-HTTP sessions are used only when the caller did not explicitly configure one.
    if (this._httpSessionId && !configuredSessionHeader) entries.push(['Mcp-Session-Id', this._httpSessionId]);
    entries.push(...Object.entries(this._config!.headers ?? {}));
    return Object.fromEntries(entries);
  }

  private _captureHttpSessionHeader(headers: IncomingHttpHeaders): void {
    if (this._hasConfiguredHttpSessionHeader()) return;
    const sessionId = responseHeader(headers, 'mcp-session-id').trim();
    if (sessionId) this._httpSessionId = sessionId;
  }

  private async _sendHttpRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const url = this._config!.url!;
    const headers = this._httpRequestHeaders();

    try {
      const response = await this._postHttpJson(url, headers, JSON.stringify(request), request.method);
      this._captureHttpSessionHeader(response.headers);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        // Response bodies are remote-controlled and may echo request secrets.
        // Health diagnostics need the status and operation, never body bytes.
        throw new Error(`HTTP ${response.statusCode} for ${request.method}`);
      }

      const contentType = responseHeader(response.headers, 'content-type');
      if (contentType.includes('text/event-stream')) {
        // SSE response — parse data: lines for JSON-RPC result
        let lastData: string | undefined;
        for (const line of response.body.split('\n')) {
          if (line.startsWith('data:')) {
            lastData = line.slice(5).trim();
          }
        }
        if (lastData) {
          try {
            return JSON.parse(lastData) as JsonRpcResponse;
          } catch {
            return { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: lastData }] } } as any;
          }
        }
        return { jsonrpc: '2.0', id: request.id, error: { code: -1, message: 'Empty SSE response' } } as any;
      }

      try {
        return JSON.parse(response.body) as JsonRpcResponse;
      } catch {
        throw new Error(`Invalid JSON response for ${request.method}`);
      }
    } catch (err) {
      if (err instanceof HttpRequestTimeoutError) {
        throw err;
      }
      const reason = sanitizeMcpRuntimeError(err, this._config);
      throw new Error(`[mcp:${this.serverName}] HTTP request failed: ${reason}`);
    }
  }

  private async _sendHttpNotification(notification: JsonRpcNotification): Promise<void> {
    const url = this._config!.url!;
    const headers = this._httpRequestHeaders();

    try {
      const response = await this._postHttpJson(url, headers, JSON.stringify(notification), notification.method);
      this._captureHttpSessionHeader(response.headers);
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
      const reason = sanitizeMcpRuntimeError(jsonRpcErrorMessage(response.error), this._config);
      throw new Error(`[mcp:${this.serverName}] Initialize failed: ${reason}`);
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
    console.error(`[mcp:${this.serverName}] ${sanitizeMcpRuntimeError(message, this._config)}`);
  }
}
