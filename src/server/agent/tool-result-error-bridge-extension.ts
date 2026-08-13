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
	return `function isObject(value) {
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
    if (isObject(next[1])) {
      const spec = { ...next[1] };
      installUnknownFieldRefinements(spec.parameters);
      if (typeof spec.handler === "function") spec.handler = wrapHandler(spec.handler);
      if (typeof spec.execute === "function") spec.execute = wrapHandler(spec.execute);
      next[1] = spec;
    } else if (typeof next[1] === "function") {
      next[1] = wrapHandler(next[1]);
    }
    if (typeof next[2] === "function") next[2] = wrapHandler(next[2]);
    return next;
  }
  if (isObject(next[0])) {
    const spec = { ...next[0] };
    installUnknownFieldRefinements(spec.parameters);
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
