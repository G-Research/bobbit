import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bobbitStateDir } from "../bobbit-dir.js";

/** The core-owned gate has less than the server's per-hook deadline. */
export const TOOL_RESULT_FILTER_TIMEOUT_MS = 2_500;
export const TOOL_RESULT_FILTER_MAX_INPUT_BYTES = 256 * 1024;

/** Server-derived activation only; no filter policy or grant leaks into generated source. */
export interface ToolResultFilterActivation {
	toolResult?: boolean;
}

/**
 * Verify the patched Pi public API before spawning a protected session. This is
 * deliberately a setup-time fail-closed check: a normal `tool_result` hook is
 * downstream of streaming updates and is not a safe substitute.
 */
export function assertToolResultGatePiCompatibility(requireFn = createRequire(import.meta.url)): void {
	// Pi's package exports are ESM-only, so `createRequire.resolve()` cannot
	// resolve their import-only entrypoints. Its regular Node lookup paths still
	// safely identify installed package directories.
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
		const agentLoop = fs.readFileSync(path.join(agentCoreDir, "dist", "agent-loop.js"), "utf-8");
		if (/setToolResultGate\s*\(/.test(types)
			&& session.includes("_toolResultGate")
			&& session.includes('event.type === "tool_execution_update"')
			&& session.includes("replaceResult: true")
			&& agentLoop.includes("afterResult.replaceResult === true")) return;
	} catch { /* handled by the fixed diagnostic below */ }
	throw new Error("Tool-result filtering requires the patched Pi result-gate API.");
}

/** Generate the only extension that may install Pi's pre-fan-out result gate. */
export function generateToolResultFilterExtension(sessionId: string): string {
	return `import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const MAX_BYTES = ${TOOL_RESULT_FILTER_MAX_INPUT_BYTES};
const TIMEOUT_MS = ${TOOL_RESULT_FILTER_TIMEOUT_MS};

function ref() {
  try { return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2); }
  catch { return Math.random().toString(36).slice(2); }
}
function withheld() {
  return {
    content: [{ type: "text", text: "Tool result withheld by project result policy [ref: " + ref() + "]." }],
    isError: true,
  };
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

export default function(pi) {
  if (!pi || typeof pi.setToolResultGate !== "function") {
    throw new Error("Tool-result gate API unavailable");
  }
  const sessionId = ${JSON.stringify(sessionId)};
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  function state(name, env) {
    const configured = process.env[env];
    if (configured) return configured.trim();
    try { return fs.readFileSync(path.join(bobbitDir, "state", name), "utf8").trim(); }
    catch { return ""; }
  }
  pi.setToolResultGate(async (event) => {
    try {
      const result = { content: event?.result?.content, details: event?.result?.details, isError: event?.isError === true, usage: event?.result?.usage };
      if (!event || typeof event.toolCallId !== "string" || typeof event.toolName !== "string" || !validContent(result.content) || !jsonValue(result.details, 0) || byteLength(result) > MAX_BYTES) return withheld();
      const url = state("gateway-url", "BOBBIT_GATEWAY_URL");
      const token = state("token", "BOBBIT_TOKEN");
      if (!url) return withheld();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await globalThis.fetch(url + "/api/sessions/" + encodeURIComponent(sessionId) + "/tool-result-filter", {
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
  });
}
`;
}

let cachedPath: string | undefined;

/** Write an immutable, content-addressed result-gate extension for one session. */
export function writeToolResultFilterExtension(sessionId: string): string | undefined {
	const code = generateToolResultFilterExtension(sessionId);
	if (cachedPath) {
		try {
			if (fs.readFileSync(cachedPath, "utf-8") === code) return cachedPath;
		} catch { /* repair below */ }
		cachedPath = undefined;
	}
	try {
		const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);
		const dir = path.join(bobbitStateDir(), "tool-result-filter", hash);
		const filePath = path.join(dir, "gate.ts");
		fs.mkdirSync(dir, { recursive: true });
		try {
			if (fs.readFileSync(filePath, "utf-8") === code) {
				cachedPath = filePath;
				return filePath;
			}
		} catch { /* missing or unreadable */ }
		fs.writeFileSync(filePath, code, "utf-8");
		cachedPath = filePath;
		return filePath;
	} catch {
		return undefined;
	}
}

export function resetToolResultFilterExtensionCache(): void {
	cachedPath = undefined;
}

/** A tiny test-only utility; production opaque references are generated in Pi. */
export function createToolResultFilterFallbackForTesting(): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text", text: `Tool result withheld by project result policy [ref: ${randomUUID()}].` }], isError: true };
}
