import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

/**
 * Generate a pi-coding-agent extension that preserves returned tool-result
 * error flags from extension tools.
 *
 * pi 0.79 treats a tool handler that returns normally as a successful tool
 * result even when the returned MCP-style payload carries `isError:true` (or
 * `is_error:true`). Bobbit tools use that payload shape to report validation
 * failures while preserving the result body. This bridge wraps subsequently
 * registered tool handlers and converts flagged returned payloads into thrown
 * errors so pi persists/broadcasts the paired toolResult as errored.
 */
export function generateToolResultErrorBridgeExtension(): string {
	return `function isObject(value) {
  return !!value && typeof value === "object";
}

function isErroredToolResult(value) {
  return isObject(value) && (value.isError === true || value.is_error === true);
}

function stringifyBlock(block) {
  if (typeof block === "string") return block;
  if (!isObject(block)) return String(block);
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  try { return JSON.stringify(block); } catch { return String(block); }
}

function messageFromToolResult(result) {
  if (!isObject(result)) return String(result);
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.map(stringifyBlock).filter(Boolean).join("\\n").trim();
    if (text) return text;
  }
  if (typeof content === "string" && content.trim()) return content.trim();
  if (typeof result.error === "string" && result.error.trim()) return result.error.trim();
  if (typeof result.message === "string" && result.message.trim()) return result.message.trim();
  try { return JSON.stringify(result); } catch { return "Tool returned an errored result."; }
}

function wrapHandler(handler) {
  if (typeof handler !== "function" || handler.__bobbitErrorBridgeWrapped) return handler;
  async function bobbitToolResultErrorBridgeHandler(...args) {
    const result = await handler.apply(this, args);
    if (isErroredToolResult(result)) {
      const err = new Error(messageFromToolResult(result));
      err.name = "BobbitToolResultError";
      err.isError = true;
      err.is_error = true;
      err.bobbitToolResult = result;
      throw err;
    }
    return result;
  }
  Object.defineProperty(bobbitToolResultErrorBridgeHandler, "__bobbitErrorBridgeWrapped", { value: true });
  return bobbitToolResultErrorBridgeHandler;
}

function wrapRegistrationArgs(args) {
  const next = Array.from(args);
  if (typeof next[0] === "string") {
    if (typeof next[1] === "function") {
      next[1] = wrapHandler(next[1]);
    } else if (typeof next[2] === "function") {
      next[2] = wrapHandler(next[2]);
    } else if (isObject(next[1])) {
      const spec = { ...next[1] };
      if (typeof spec.handler === "function") spec.handler = wrapHandler(spec.handler);
      if (typeof spec.execute === "function") spec.execute = wrapHandler(spec.execute);
      next[1] = spec;
    }
    return next;
  }
  if (isObject(next[0])) {
    const spec = { ...next[0] };
    if (typeof next[1] === "function") {
      next[1] = wrapHandler(next[1]);
    } else {
      if (typeof spec.handler === "function") spec.handler = wrapHandler(spec.handler);
      if (typeof spec.execute === "function") spec.execute = wrapHandler(spec.execute);
    }
    next[0] = spec;
  }
  return next;
}

export default function(pi) {
  if (!pi || pi.__bobbitToolResultErrorBridgeInstalled) return;
  Object.defineProperty(pi, "__bobbitToolResultErrorBridgeInstalled", { value: true });

  if (typeof pi.tool === "function") {
    const originalTool = pi.tool.bind(pi);
    pi.tool = (...args) => originalTool(...wrapRegistrationArgs(args));
  }

  if (typeof pi.registerTool === "function") {
    const originalRegisterTool = pi.registerTool.bind(pi);
    pi.registerTool = (...args) => originalRegisterTool(...wrapRegistrationArgs(args));
  }

  if (pi.tools && typeof pi.tools.register === "function") {
    const originalToolsRegister = pi.tools.register.bind(pi.tools);
    pi.tools.register = (...args) => originalToolsRegister(...wrapRegistrationArgs(args));
  }
}
`;
}

let cachedPath: string | undefined;
let cachedCode: string | undefined;

export function writeToolResultErrorBridgeExtension(): string | undefined {
	if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
	const code = cachedCode ?? generateToolResultErrorBridgeExtension();
	cachedCode = code;
	try {
		const baseDir = path.join(bobbitStateDir(), "tool-result-error-bridge");
		const hash = createHash("sha256").update(code).digest("hex").slice(0, 12);
		const extDir = path.join(baseDir, hash);
		fs.mkdirSync(extDir, { recursive: true });
		const filePath = path.join(extDir, "bridge.ts");
		try {
			if (fs.readFileSync(filePath, "utf-8") === code) {
				cachedPath = filePath;
				return filePath;
			}
		} catch { /* file does not exist yet */ }
		fs.writeFileSync(filePath, code, "utf-8");
		cachedPath = filePath;
		return filePath;
	} catch {
		return undefined;
	}
}

export function prependToolResultErrorBridge(args: string[]): string[] {
	const bridgePath = writeToolResultErrorBridgeExtension();
	if (!bridgePath) return args;
	const out = [...args];
	const noExtensionsIndex = out.indexOf("--no-extensions");
	const insertAt = noExtensionsIndex >= 0 ? noExtensionsIndex + 1 : 0;
	out.splice(insertAt, 0, "--extension", bridgePath);
	return out;
}
