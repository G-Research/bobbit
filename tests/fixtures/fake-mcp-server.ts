/**
 * Fake MCP server fixture for E2E tests.
 *
 * Speaks MCP JSON-RPC 2.0 over stdio with newline-delimited framing
 * (matches `src/server/mcp/mcp-client.ts` — readline + `JSON.stringify(req) + "\n"`).
 *
 * Two operations:
 *   - `echo({ text }) → { text }`
 *   - `add({ a, b }) → { sum }`
 *
 * Plus the standard MCP handshake: `initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call`.
 *
 * Optional behaviour overrides via env vars (used by failure-isolation tests):
 *   - `FAKE_MCP_LIST_DELAY_MS` — delay before responding to `tools/list`.
 *   - `FAKE_MCP_CALL_DELAY_MS` — delay before responding to `tools/call`.
 *   - `FAKE_MCP_FAIL_LIST=1`   — `tools/list` returns a JSON-RPC error.
 *   - `FAKE_MCP_BAD_SCHEMA=1`  — `tools/list` includes a tool with a malformed
 *                                inputSchema (for failure-isolation tests).
 *   - `DEBUG_FAKE_MCP=1`       — verbose stderr logging of incoming/outgoing.
 *
 * Run via `node tests/fixtures/fake-mcp-server.ts` (post-build) or
 * `tsx tests/fixtures/fake-mcp-server.ts` (dev).
 */
import { createInterface } from 'node:readline';
import process from 'node:process';

type JsonRpcId = number | string | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'fake-mcp', version: '0.0.1' };

const LIST_DELAY_MS = Number(process.env.FAKE_MCP_LIST_DELAY_MS || '0') || 0;
const CALL_DELAY_MS = Number(process.env.FAKE_MCP_CALL_DELAY_MS || '0') || 0;
const FAIL_LIST = process.env.FAKE_MCP_FAIL_LIST === '1';
const BAD_SCHEMA = process.env.FAKE_MCP_BAD_SCHEMA === '1';
const DEBUG = process.env.DEBUG_FAKE_MCP === '1';

function dlog(...args: unknown[]): void {
  if (DEBUG) console.error('[fake-mcp:debug]', ...args);
}

function send(msg: JsonRpcResponse): void {
  const line = JSON.stringify(msg) + '\n';
  process.stdout.write(line);
  dlog('→', line.trimEnd());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildToolsList(): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [
    {
      name: 'echo',
      description: 'Echo the input text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'add',
      description: 'Add two numbers.',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
  ];

  if (BAD_SCHEMA) {
    // Deliberately malformed schema — `inputSchema` is not an object, which
    // exercises the `isValidOperationSchema` drop path in mcp-meta.
    tools.push({
      name: 'broken',
      description: 'Tool with a malformed schema (failure-isolation fixture).',
      inputSchema: 'not-an-object',
    });
  }

  return tools;
}

async function handleToolsCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
): Promise<void> {
  if (CALL_DELAY_MS > 0) await sleep(CALL_DELAY_MS);

  const name = (params?.name ?? '') as string;
  const args = (params?.arguments ?? {}) as Record<string, unknown>;

  let resultText: string;
  try {
    if (name === 'echo') {
      const text = String(args.text ?? '');
      resultText = JSON.stringify({ text });
    } else if (name === 'add') {
      const a = Number(args.a);
      const b = Number(args.b);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        throw new Error(`add: invalid arguments (a=${args.a}, b=${args.b})`);
      }
      resultText = JSON.stringify({ sum: a + b });
    } else {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
      return;
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: (err as Error).message },
    });
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: resultText }] },
  });
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const { id, method, params } = msg;
  dlog('←', method, id);

  // Notifications have no id — handle and return without response.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      dlog('initialized notification received');
    }
    return;
  }

  switch (method) {
    case 'initialize': {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    case 'tools/list': {
      if (LIST_DELAY_MS > 0) await sleep(LIST_DELAY_MS);
      if (FAIL_LIST) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'fake-mcp: tools/list forced failure' },
        });
        return;
      }
      send({ jsonrpc: '2.0', id, result: { tools: buildToolsList() } });
      return;
    }
    case 'tools/call': {
      await handleToolsCall(id, params);
      return;
    }
    default: {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  }
}

function main(): void {
  console.error('[fake-mcp] starting');

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      console.error('[fake-mcp] invalid JSON:', trimmed.slice(0, 200), err);
      return;
    }
    void handleMessage(msg).catch((err) => {
      console.error('[fake-mcp] handler error:', err);
    });
  });

  rl.on('close', () => {
    dlog('stdin closed, exiting');
    process.exit(0);
  });

  // Don't crash on broken pipe (parent killed us).
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  });
}

main();
