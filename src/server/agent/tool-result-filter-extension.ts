import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bobbitStateDir } from "../bobbit-dir.js";

/** The core-owned gate has less than the server's per-hook deadline. */
export const TOOL_RESULT_FILTER_TIMEOUT_MS = 2_500;
export const TOOL_RESULT_FILTER_MAX_INPUT_BYTES = 256 * 1024;
/** Private Pi-loader input; never exposed through the ordinary extension API. */
export const TOOL_RESULT_FILTER_GATE_ENV = "BOBBIT_TOOL_RESULT_FILTER_GATE";

/** Server-derived activation only; no filter policy or grant leaks into generated source. */
export interface ToolResultFilterActivation {
	toolResult?: boolean;
}

/**
 * Verify the private Pi-loader seam before spawning a protected session. This
 * is deliberately a setup-time fail-closed check: a normal `tool_result` hook
 * is downstream of streaming updates and is not a safe substitute.
 */
export function assertToolResultGatePiCompatibility(requireFn = createRequire(import.meta.url)): void {
	const packageDir = (name: "pi-agent-core" | "pi-coding-agent"): string | undefined =>
		(requireFn.resolve.paths(`@earendil-works/${name}`) ?? [])
			.map(root => path.join(root, "@earendil-works", name))
			.find(root => fs.existsSync(path.join(root, "package.json")));
	const codingAgentDir = packageDir("pi-coding-agent");
	const agentCoreDir = packageDir("pi-agent-core");
	if (!codingAgentDir || !agentCoreDir) throw new Error("Tool-result filtering requires the patched Pi result-gate API.");
	try {
		const types = fs.readFileSync(path.join(codingAgentDir, "dist", "core", "extensions", "types.d.ts"), "utf-8");
		const session = fs.readFileSync(path.join(codingAgentDir, "dist", "core", "agent-session.js"), "utf-8");
		const loader = fs.readFileSync(path.join(codingAgentDir, "dist", "core", "extensions", "loader.js"), "utf-8");
		const agentLoop = fs.readFileSync(path.join(agentCoreDir, "dist", "agent-loop.js"), "utf-8");
		if (!/setToolResultGate\s*\(/.test(types)
			&& loader.includes(TOOL_RESULT_FILTER_GATE_ENV)
			&& loader.includes("__bobbitCoreToolResultGate")
			&& session.includes("__bobbitCoreToolResultGate")
			&& session.includes('event.type === "tool_execution_update"')
			&& session.includes("replaceResult: true")
			&& agentLoop.includes("afterResult.replaceResult === true")) return;
	} catch { /* handled by the fixed diagnostic below */ }
	throw new Error("Tool-result filtering requires the patched Pi result-gate API.");
}

/**
 * Generate the only core-loaded pre-fan-out gate. Its factory receives no Pi
 * API. Pi loads it before ordinary extensions, and the transport binding is
 * captured in this private closure so later global fetch monkeypatches cannot
 * inspect or redirect raw result bytes.
 */
export function generateToolResultFilterExtension(sessionId: string): string {
	return `const coreFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;
const MAX_BYTES = ${TOOL_RESULT_FILTER_MAX_INPUT_BYTES};
const TIMEOUT_MS = ${TOOL_RESULT_FILTER_TIMEOUT_MS};

function ref() {
  try { return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2); }
  catch { return Math.random().toString(36).slice(2); }
}
function withheld() {
  return { content: [{ type: "text", text: "Tool result withheld by project result policy [ref: " + ref() + "]." }], isError: true };
}
function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return MAX_BYTES + 1; }
}
function jsonValue(value, depth) {
  if (value === undefined) return true;
  if (depth > 12 || value === null || typeof value === "string" || typeof value === "boolean") return depth <= 12;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => jsonValue(item, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  return keys.length <= 256 && keys.every(key => key.length <= 256 && jsonValue(value[key], depth + 1));
}
function validContent(content) {
  if (!Array.isArray(content) || content.length > 32) return false;
  return content.every(block => {
    if (!block || typeof block !== "object" || Object.getPrototypeOf(block) !== Object.prototype) return false;
    const keys = Object.keys(block).sort().join(",");
    if (block.type === "text") return keys === "text,type" && typeof block.text === "string";
    if (block.type === "image") return keys === "data,mediaType,type" && typeof block.data === "string"
      && (block.mediaType === "image/png" || block.mediaType === "image/jpeg" || block.mediaType === "image/webp");
    return false;
  });
}
function validResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort();
  if (!keys.every(key => ["content", "details", "isError", "usage"].includes(key))) return false;
  if (!validContent(value.content) || typeof value.isError !== "boolean") return false;
  if (Object.prototype.hasOwnProperty.call(value, "details") && !jsonValue(value.details, 0)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "usage") && !jsonValue(value.usage, 0)) return false;
  return byteLength(value) <= MAX_BYTES;
}

export default function createCoreToolResultGate() {
  const sessionId = ${JSON.stringify(sessionId)};
  const url = process.env.BOBBIT_GATEWAY_URL?.trim();
  const token = process.env.BOBBIT_TOKEN?.trim();
  return async function gate(event) {
    try {
      const result = { content: event?.result?.content, details: event?.result?.details, isError: event?.isError === true, usage: event?.result?.usage };
      if (!event || typeof event.toolCallId !== "string" || typeof event.toolName !== "string" || !validContent(result.content) || !jsonValue(result.details, 0) || byteLength(result) > MAX_BYTES || !url || !coreFetch) return withheld();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await coreFetch(url + "/api/sessions/" + encodeURIComponent(sessionId) + "/tool-result-filter", {
          method: "POST",
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName, result }),
          signal: controller.signal,
        });
        if (!response.ok) return withheld();
        const output = await response.json();
        return validResponse(output) ? output : withheld();
      } finally { clearTimeout(timer); }
    } catch { return withheld(); }
  };
}
`;
}

let cachedPath: string | undefined;

function hasExpectedRegularFile(filePath: string, expected: string): boolean {
	try {
		const stat = fs.lstatSync(filePath);
		return stat.isFile() && !stat.isSymbolicLink() && fs.readFileSync(filePath, "utf-8") === expected;
	} catch { return false; }
}

/** Write a content-addressed, read-only core input. Any mismatch fails closed. */
export function writeToolResultFilterExtension(sessionId: string): string | undefined {
	const code = generateToolResultFilterExtension(sessionId);
	if (cachedPath && hasExpectedRegularFile(cachedPath, code)) return cachedPath;
	cachedPath = undefined;
	try {
		const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
		const root = path.join(bobbitStateDir(), "tool-result-filter");
		const dir = path.join(root, hash);
		const filePath = path.join(dir, "gate.ts");
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		const rootStat = fs.lstatSync(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
		if (fs.existsSync(dir)) {
			const dirStat = fs.lstatSync(dir);
			if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return undefined;
		}
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (fs.existsSync(filePath)) {
			if (!hasExpectedRegularFile(filePath, code)) return undefined;
			fs.chmodSync(filePath, 0o444);
			return cachedPath = filePath;
		}
		const temp = path.join(dir, `.gate-${process.pid}-${randomUUID()}.tmp`);
		const fd = fs.openSync(temp, "wx", 0o600);
		try {
			fs.writeFileSync(fd, code, "utf-8");
			fs.fsyncSync(fd);
		} finally { fs.closeSync(fd); }
		fs.chmodSync(temp, 0o444);
		fs.renameSync(temp, filePath);
		if (!hasExpectedRegularFile(filePath, code)) return undefined;
		return cachedPath = filePath;
	} catch {
		return undefined;
	}
}

export function toolResultFilterGateEnvironment(gatePath: string): Record<string, string> {
	return { [TOOL_RESULT_FILTER_GATE_ENV]: gatePath };
}

export function resetToolResultFilterExtensionCache(): void {
	cachedPath = undefined;
}

/** A tiny test-only utility; production opaque references are generated in Pi. */
export function createToolResultFilterFallbackForTesting(): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text", text: `Tool result withheld by project result policy [ref: ${randomUUID()}].` }], isError: true };
}
