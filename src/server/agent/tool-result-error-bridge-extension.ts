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
 * errors so pi persists/broadcasts the paired toolResult as errored. It also
 * refines closed schemas after session setup so normal TypeBox errors name each
 * rejected property instead of reporting only a root additional-property error.
 */
export function generateToolResultErrorBridgeExtension(): string {
	return `// The client deadline must leave enough margin for the host router's 2s
// protected-operation deadline to settle and serialize its decision.
const HOST_HOOK_TIMEOUT_MS = 2500;
const HOST_PROTECTED_TOOL_CALL_FAILURE = Object.freeze({ action: "block", reasonCode: "not_permitted" });
const HOST_PROTECTED_RESULT_FAILURE = Object.freeze({ action: "syntheticError", code: "handler_error" });

async function postHostHook(route, body, fallback) {
  if (process.env.BOBBIT_HOST_HOOKS_ENABLED !== "1") return fallback;
  const gatewayUrl = process.env.BOBBIT_GATEWAY_URL;
  const sessionId = process.env.BOBBIT_SESSION_ID;
  const token = process.env.BOBBIT_TOKEN;
  const sessionSecret = process.env.BOBBIT_SESSION_SECRET;
  if (!gatewayUrl || !sessionId || typeof globalThis.fetch !== "function") return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOST_HOOK_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(gatewayUrl + "/api/sessions/" + encodeURIComponent(sessionId) + route, {
      method: "POST",
      headers: {
        ...(token ? { "Authorization": "Bearer " + token } : {}),
        ...(sessionSecret ? { "X-Bobbit-Session-Secret": sessionSecret } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) return fallback;
    const decision = await response.json();
    if (!isObject(decision) || (typeof decision.action !== "string" && typeof decision.decision !== "string")) return fallback;
    return decision;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function isObject(value) {
  return !!value && typeof value === "object";
}

function unknownFields(schema, value) {
  if (!isObject(value) || Array.isArray(value)) return [];
  const properties = isObject(schema.properties) ? schema.properties : {};
  const patterns = isObject(schema.patternProperties)
    ? Object.keys(schema.patternProperties).map(pattern => new RegExp(pattern))
    : [];
  return Object.keys(value).filter(field => !Object.prototype.hasOwnProperty.call(properties, field) && !patterns.some(pattern => pattern.test(field)));
}

function installUnknownFieldRefinements(schema, seen = new Set()) {
  if (!isObject(schema) || seen.has(schema)) return;
  seen.add(schema);

  if (schema.additionalProperties === false) {
    const refinements = Array.isArray(schema["~refine"]) ? schema["~refine"] : [];
    if (!refinements.some(refinement => refinement?.__bobbitUnknownFields === true)) {
      // TypeBox discovers schema keys with Object.getOwnPropertyNames, while
      // provider converters and JSON serialization consume enumerable keys.
      // A hidden catch-all lets TypeBox reach the refinement without changing
      // the provider-visible closed schema or declared patternProperties.
      const patterns = isObject(schema.patternProperties) ? schema.patternProperties : {};
      if (!Object.prototype.hasOwnProperty.call(patterns, "[^]*")) {
        Object.defineProperty(patterns, "[^]*", { value: true, configurable: true });
      }
      if (!isObject(schema.patternProperties)) {
        Object.defineProperty(schema, "patternProperties", { value: patterns, configurable: true });
      }

      const refinement = {
        __bobbitUnknownFields: true,
        check: value => unknownFields(schema, value).length === 0,
        error: value => unknownFields(schema, value)
          .map(field => \`Unrecognized field: \${field}\`)
          .join("; "),
      };
      Object.defineProperty(schema, "~refine", {
        value: [...refinements, refinement],
        configurable: true,
      });
    }
  }

  for (const key of ["properties", "patternProperties"]) {
    if (isObject(schema[key])) {
      for (const nested of Object.values(schema[key])) installUnknownFieldRefinements(nested, seen);
    }
  }
  if (isObject(schema.additionalProperties)) installUnknownFieldRefinements(schema.additionalProperties, seen);
  if (Array.isArray(schema.items)) {
    for (const item of schema.items) installUnknownFieldRefinements(item, seen);
  } else if (isObject(schema.items)) {
    installUnknownFieldRefinements(schema.items, seen);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      for (const nested of schema[key]) installUnknownFieldRefinements(nested, seen);
    }
  }
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

function hostSyntheticError(code) {
  return {
    content: [{ type: "text", text: "Tool result was rejected by host policy (" + code + ")." }],
    isError: true,
  };
}

function beforeDecision(response, originalArgs) {
  const decision = response && (response.action || response.decision || response.result?.decision);
  if (response?.block === true || decision === "block") return { block: true };
  const replacement = response?.args ?? response?.result?.args ?? response?.value?.args;
  return { block: false, args: isObject(replacement) ? replacement : originalArgs };
}

function syntheticErrorDecision(response) {
  const decision = response && (response.action || response.decision || response.result?.decision);
  if (decision !== "syntheticError" && response?.syntheticError !== true) return undefined;
  const code = typeof response?.code === "string" ? response.code : "handler_error";
  return hostSyntheticError(code);
}

function afterDecision(response, originalResult) {
  const synthetic = syntheticErrorDecision(response);
  if (synthetic !== undefined) return synthetic;
  const replacement = response?.result ?? response?.replacement ?? response?.value?.result;
  return replacement === undefined ? originalResult : replacement;
}

function wrapHandler(handler, toolName) {
  if (typeof handler !== "function" || handler.__bobbitErrorBridgeWrapped) return handler;
  async function bobbitToolResultErrorBridgeHandler(...args) {
    const toolCallId = typeof args[0] === "string" ? args[0] : "unknown";
    const originalArgs = isObject(args[1]) ? args[1] : {};
    const beforeFallback = process.env.BOBBIT_HOST_BEFORE_TOOL_CALL_FAIL_CLOSED === "1"
      ? HOST_PROTECTED_TOOL_CALL_FAILURE
      : undefined;
    const before = beforeDecision(await postHostHook("/host-hooks/before-tool-call", {
      toolCallId,
      toolName,
      args: originalArgs,
    }, beforeFallback), originalArgs);
    if (before.block) {
      const denied = hostSyntheticError("not_permitted");
      const err = new Error(messageFromToolResult(denied));
      err.name = "BobbitToolPolicyError";
      err.isError = true;
      err.is_error = true;
      err.bobbitToolResult = denied;
      throw err;
    }
    if (args.length > 1) args[1] = before.args;

    const afterFallback = process.env.BOBBIT_HOST_AFTER_TOOL_RESULT_FAIL_CLOSED === "1"
      ? HOST_PROTECTED_RESULT_FAILURE
      : undefined;
    let result;
    let afterAlreadyApplied = false;
    try {
      result = await handler.apply(this, args);
    } catch (error) {
      const afterThrown = await postHostHook("/host-hooks/after-tool-result", {
        toolCallId,
        toolName,
        result: { isError: true },
      }, afterFallback);
      // The host sees only the bounded failure flag. An allow/replace response
      // cannot safely replace a result body that the host deliberately never
      // received, so preserve the exact original exception unless policy made
      // this operation terminal.
      const synthetic = syntheticErrorDecision(afterThrown);
      if (synthetic === undefined) throw error;
      result = synthetic;
      afterAlreadyApplied = true;
    }

    if (!afterAlreadyApplied) {
      result = afterDecision(await postHostHook("/host-hooks/after-tool-result", {
        toolCallId,
        toolName,
        result,
      }, afterFallback), result);
    }
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
    const toolName = next[0];
    if (isObject(next[1])) {
      const spec = { ...next[1] };
      installUnknownFieldRefinements(spec.parameters);
      if (typeof spec.handler === "function") spec.handler = wrapHandler(spec.handler, toolName);
      if (typeof spec.execute === "function") spec.execute = wrapHandler(spec.execute, toolName);
      next[1] = spec;
    } else if (typeof next[1] === "function") {
      next[1] = wrapHandler(next[1], toolName);
    }
    if (typeof next[2] === "function") next[2] = wrapHandler(next[2], toolName);
    return next;
  }
  if (isObject(next[0])) {
    const spec = { ...next[0] };
    const toolName = typeof spec.name === "string" ? spec.name : "unknown";
    installUnknownFieldRefinements(spec.parameters);
    if (typeof next[1] === "function") {
      next[1] = wrapHandler(next[1], toolName);
    } else {
      if (typeof spec.handler === "function") spec.handler = wrapHandler(spec.handler, toolName);
      if (typeof spec.execute === "function") spec.execute = wrapHandler(spec.execute, toolName);
    }
    next[0] = spec;
  }
  return next;
}

export default function(pi) {
  if (!pi || pi.__bobbitToolResultErrorBridgeInstalled) return;
  Object.defineProperty(pi, "__bobbitToolResultErrorBridgeInstalled", { value: true });

  if (typeof pi.on === "function") {
    pi.on("session_start", () => {
      if (typeof pi.getAllTools !== "function") return;
      for (const tool of pi.getAllTools()) installUnknownFieldRefinements(tool?.parameters);
    });
  }

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

export function writeToolResultErrorBridgeExtension(): string | undefined {
	const code = generateToolResultErrorBridgeExtension();

	// Revalidate a cached path before reuse. The file lives under a shared,
	// content-addressed dir that is bind-mounted into Docker sandboxes. Even
	// with a read-only sandbox mount, repair-on-reuse prevents a tampered or
	// truncated bridge.ts from being loaded into later sessions.
	if (cachedPath) {
		try {
			if (fs.readFileSync(cachedPath, "utf-8") === code) return cachedPath;
		} catch { /* missing/unreadable — fall through to rewrite below */ }
		cachedPath = undefined;
	}

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
		// File missing OR contents drifted from the freshly generated source
		// (tampering / partial write) — repair by rewriting canonical bytes.
		fs.writeFileSync(filePath, code, "utf-8");
		cachedPath = filePath;
		return filePath;
	} catch {
		return undefined;
	}
}

/** Reset the in-memory codegen cache (test seam). */
export function resetToolResultErrorBridgeExtensionCache(): void {
	cachedPath = undefined;
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
