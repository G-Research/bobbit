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
 * Generate the only core-loaded pre-fan-out gate. The module snapshots every
 * intrinsic used with tool-result data while Pi's private loader runs it,
 * before ordinary extensions share the realm. Raw values are read only through
 * captured own data descriptors and copied into null-prototype containers
 * before serialization. This intentionally fails closed for accessors,
 * inherited values, holes, symbols, or unexpected prototypes.
 *
 * This seals ordinary global/prototype monkeypatches, but it is not a sandbox:
 * protected-session activation must reject untrusted same-realm code that can
 * replace Pi internals.
 */
export function generateToolResultFilterExtension(sessionId: string): string {
	return `const $Object = Object;
const $Array = Array;
const $JSON = JSON;
const $Buffer = Buffer;
const $ObjectPrototype = $Object.prototype;
const $ArrayPrototype = $Array.prototype;
const $getPrototypeOf = $Object.getPrototypeOf;
const $getOwnPropertyDescriptor = $Object.getOwnPropertyDescriptor;
const $getOwnPropertyNames = $Object.getOwnPropertyNames;
const $defineProperty = $Object.defineProperty;
const $getOwnPropertySymbols = $Object.getOwnPropertySymbols;
const $create = $Object.create;
const $setPrototypeOf = $Object.setPrototypeOf;
const $arrayIsArray = $Array.isArray;
const $numberIsFinite = Number.isFinite;
const $numberIsSafeInteger = Number.isSafeInteger;
const $stringify = $JSON.stringify;
const $byteLength = $Buffer.byteLength.bind($Buffer);
const $encodeURIComponent = encodeURIComponent;
const $setTimeout = setTimeout;
const $clearTimeout = clearTimeout;
const $AbortController = AbortController;
const $fetch = typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;
const $responseJson = typeof globalThis.Response?.prototype?.json === "function" ? globalThis.Response.prototype.json : undefined;
const $responseJsonCall = $responseJson ? Function.prototype.call.bind($responseJson) : undefined;
const $responseOk = globalThis.Response ? $getOwnPropertyDescriptor(globalThis.Response.prototype, "ok")?.get : undefined;
const $responseOkCall = $responseOk ? Function.prototype.call.bind($responseOk) : undefined;
const $randomUUID = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID.bind(globalThis.crypto) : undefined;
const $random = Math.random.bind(Math);
const $gatewayUrl = typeof process.env.BOBBIT_GATEWAY_URL === "string" ? process.env.BOBBIT_GATEWAY_URL.trim() : "";
const $token = typeof process.env.BOBBIT_TOKEN === "string" ? process.env.BOBBIT_TOKEN.trim() : "";
const MAX_BYTES = ${TOOL_RESULT_FILTER_MAX_INPUT_BYTES};
const TIMEOUT_MS = ${TOOL_RESULT_FILTER_TIMEOUT_MS};

function ref() {
  try { return $randomUUID ? $randomUUID() : $random().toString(36).slice(2); }
  catch { return $random().toString(36).slice(2); }
}
function withheld() {
  return { content: [{ type: "text", text: "Tool result withheld by project result policy [ref: " + ref() + "]." }], isError: true };
}
function own(object, name) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = $getOwnPropertyDescriptor(object, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function ownData(object, name) {
  if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
  const descriptor = $getOwnPropertyDescriptor(object, name);
  return descriptor && "value" in descriptor ? descriptor : undefined;
}
function isRecord(value) {
  if (!value || typeof value !== "object" || $arrayIsArray(value)) return false;
  const prototype = $getPrototypeOf(value);
  return prototype === $ObjectPrototype || prototype === null;
}
function isArray(value) {
  if (!$arrayIsArray(value)) return false;
  const prototype = $getPrototypeOf(value);
  return prototype === $ArrayPrototype || prototype === null;
}
function emptyArray() {
  const value = [];
  $setPrototypeOf(value, null);
  return value;
}
function defineData(object, name, value) {
  $defineProperty(object, name, { value, enumerable: true, configurable: true, writable: true });
}
function hasOnlyOwnData(object, names) {
  if ($getOwnPropertySymbols(object).length !== 0) return false;
  const actual = $getOwnPropertyNames(object);
  if (actual.length !== names.length) return false;
  for (let index = 0; index < names.length; index++) {
    let found = false;
    for (let candidate = 0; candidate < actual.length; candidate++) if (actual[candidate] === names[index]) { found = true; break; }
    const descriptor = ownData(object, names[index]);
    if (!found || !descriptor || descriptor.enumerable !== true) return false;
  }
  return true;
}
function cloneJson(value, depth) {
  if (depth > 12) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return $numberIsFinite(value) ? value : undefined;
  if (isArray(value)) {
    const lengthDescriptor = ownData(value, "length");
    const length = lengthDescriptor?.value;
    if (!$numberIsSafeInteger(length) || length < 0 || length > 256 || $getOwnPropertySymbols(value).length !== 0) return undefined;
    const names = $getOwnPropertyNames(value);
    if (names.length !== length + 1) return undefined;
    const copy = emptyArray();
    for (let index = 0; index < length; index++) {
      const descriptor = ownData(value, "" + index);
      if (!descriptor || descriptor.enumerable !== true) return undefined;
      const item = cloneJson(descriptor.value, depth + 1);
      if (item === undefined) return undefined;
      copy[index] = item;
    }
    return copy;
  }
  if (!isRecord(value) || $getOwnPropertySymbols(value).length !== 0) return undefined;
  const names = $getOwnPropertyNames(value);
  if (names.length > 256) return undefined;
  const copy = $create(null);
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (name.length > 256) return undefined;
    const descriptor = ownData(value, name);
    if (!descriptor || descriptor.enumerable !== true) return undefined;
    const item = cloneJson(descriptor.value, depth + 1);
    if (item === undefined) return undefined;
    copy[name] = item;
  }
  return copy;
}
function cloneContent(value) {
  const copy = cloneJson(value, 0);
  if (!isArray(copy) || copy.length > 32) return undefined;
  for (let index = 0; index < copy.length; index++) {
    const block = copy[index];
    if (!isRecord(block)) return undefined;
    const type = own(block, "type");
    if (type === "text") {
      if (!hasOnlyOwnData(block, ["type", "text"]) || typeof own(block, "text") !== "string") return undefined;
    } else if (type === "image") {
      const mediaType = own(block, "mediaType");
      if (!hasOnlyOwnData(block, ["type", "mediaType", "data"]) || typeof own(block, "data") !== "string"
        || (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp")) return undefined;
    } else return undefined;
  }
  return copy;
}
function encode(value) {
  try { return $stringify(value); }
  catch { return undefined; }
}
function bounded(value) {
  const text = encode(value);
  if (typeof text !== "string") return undefined;
  try { return $byteLength(text, "utf8") <= MAX_BYTES ? text : undefined; }
  catch { return undefined; }
}
function requestFrom(event) {
  if (!isRecord(event) || $getOwnPropertySymbols(event).length !== 0) return undefined;
  const eventNames = $getOwnPropertyNames(event);
  if (eventNames.length < 4 || eventNames.length > 5) return undefined;
  for (let index = 0; index < eventNames.length; index++) {
    const name = eventNames[index];
    if ((name !== "toolCallId" && name !== "toolName" && name !== "result" && name !== "isError" && name !== "input") || !ownData(event, name)) return undefined;
  }
  if (!hasOnlyOwnData(event, eventNames)) return undefined;
  const toolCallId = own(event, "toolCallId");
  const toolName = own(event, "toolName");
  const rawResult = own(event, "result");
  if (typeof toolCallId !== "string" || typeof toolName !== "string" || typeof own(event, "isError") !== "boolean" || !isRecord(rawResult)) return undefined;
  const resultNames = $getOwnPropertyNames(rawResult);
  if (resultNames.length < 1 || resultNames.length > 3 || $getOwnPropertySymbols(rawResult).length !== 0) return undefined;
  for (let index = 0; index < resultNames.length; index++) {
    const name = resultNames[index];
    if ((name !== "content" && name !== "details" && name !== "usage") || !ownData(rawResult, name)) return undefined;
  }
  if (!hasOnlyOwnData(rawResult, resultNames)) return undefined;
  const rawContent = ownData(rawResult, "content");
  if (!rawContent) return undefined;
  const content = cloneContent(rawContent.value);
  if (!content) return undefined;
  const result = $create(null);
  defineData(result, "content", content);
  // Pi carries the terminal error bit beside `result`; the gateway contract
  // requires it inside the canonical result envelope.
  defineData(result, "isError", own(event, "isError"));
  const details = ownData(rawResult, "details");
  if (details && details.value !== undefined) {
    const value = cloneJson(details.value, 0);
    if (value === undefined) return undefined;
    defineData(result, "details", value);
  }
  const usage = ownData(rawResult, "usage");
  if (usage && usage.value !== undefined) {
    const value = cloneJson(usage.value, 0);
    if (value === undefined) return undefined;
    defineData(result, "usage", value);
  }
  const request = $create(null);
  defineData(request, "toolCallId", toolCallId);
  defineData(request, "toolName", toolName);
  defineData(request, "result", result);
  return bounded(request) ? request : undefined;
}
function materializeForPi(value, depth) {
  if (depth > 12 || value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (isArray(value)) {
    const length = ownData(value, "length")?.value;
    if (!$numberIsSafeInteger(length) || length < 0 || length > 256) return undefined;
    const output = [];
    for (let index = 0; index < length; index++) {
      const item = ownData(value, "" + index);
      if (!item || item.enumerable !== true) return undefined;
      const materialized = materializeForPi(item.value, depth + 1);
      if (materialized === undefined) return undefined;
      defineData(output, "" + index, materialized);
    }
    return output;
  }
  if (!isRecord(value)) return undefined;
  const output = {};
  const names = $getOwnPropertyNames(value);
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    const item = ownData(value, name);
    if (!item || item.enumerable !== true) return undefined;
    const materialized = materializeForPi(item.value, depth + 1);
    if (materialized === undefined) return undefined;
    // Use the loader-time primitive so inherited setters cannot observe a
    // response while it is rehydrated for Pi's ordinary object consumers.
    defineData(output, name, materialized);
  }
  return output;
}
function responseFrom(value) {
  if (!isRecord(value)) return undefined;
  const content = ownData(value, "content");
  const isError = ownData(value, "isError");
  if (!content || !isError || typeof isError.value !== "boolean") return undefined;
  const safeContent = cloneContent(content.value);
  if (!safeContent) return undefined;
  const safe = $create(null);
  defineData(safe, "content", safeContent);
  defineData(safe, "isError", isError.value);
  const details = ownData(value, "details");
  if (details) { const cloned = cloneJson(details.value, 0); if (cloned === undefined) return undefined; defineData(safe, "details", cloned); }
  const usage = ownData(value, "usage");
  if (usage) { const cloned = cloneJson(usage.value, 0); if (cloned === undefined) return undefined; defineData(safe, "usage", cloned); }
  if (!hasOnlyOwnData(value, $getOwnPropertyNames(safe)) || !bounded(safe)) return undefined;
  const output = materializeForPi(safe, 0);
  if (!isRecord(output) || !isArray(own(output, "content")) || typeof own(output, "isError") !== "boolean") return undefined;
  return output;
}

export default function createCoreToolResultGate() {
  const sessionId = ${JSON.stringify(sessionId)};
  return async function gate(event) {
    try {
      const request = requestFrom(event);
      if (!request || !$gatewayUrl || !$fetch || !$responseJsonCall || !$responseOkCall) return withheld();
      const body = bounded(request);
      if (!body) return withheld();
      const controller = new $AbortController();
      const timer = $setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await $fetch($gatewayUrl + "/api/sessions/" + $encodeURIComponent(sessionId) + "/tool-result-filter", {
          method: "POST",
          headers: { "Authorization": "Bearer " + $token, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!response || $responseOkCall(response) !== true) return withheld();
        const output = await $responseJsonCall(response);
        return responseFrom(output) || withheld();
      } finally { $clearTimeout(timer); }
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
		// This directory is a read-only Docker bind-mount. The sandbox runs as
		// uid 1000, so both mount root and content-addressed directory must be
		// traversable even when an inherited umask or a prior writer made them private.
		fs.mkdirSync(root, { recursive: true, mode: 0o755 });
		const rootStat = fs.lstatSync(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
		fs.chmodSync(root, 0o755);
		fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
		const dirStat = fs.lstatSync(dir);
		if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return undefined;
		fs.chmodSync(dir, 0o755);
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
