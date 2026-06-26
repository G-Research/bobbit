import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
	computePiExtensionDiscoveryCacheKeyWithDiagnostics,
	makePiExtensionDiagnostic,
	type PiExtensionDiagnostic,
	type PiExtensionDiscoveryResult,
	type PiExtensionToolInfo,
} from "./pi-extension-contributions.js";

export interface DiscoverPiExtensionToolsOptions {
	timeoutMs?: number;
	cwd?: string;
	trustAccepted: boolean;
}

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const RESULT_MARKER = "__BOBBIT_PI_EXTENSION_DISCOVERY_RESULT__";

function diagnostic(status: PiExtensionDiagnostic["status"], code: string, message: string): PiExtensionDiagnostic {
	return makePiExtensionDiagnostic(status, code, message);
}

function skipped(cacheKey?: string): PiExtensionDiscoveryResult {
	return {
		status: "skipped",
		tools: [],
		...(cacheKey ? { cacheKey } : {}),
		diagnostic: diagnostic("ok", "trust_required", "Executable discovery is skipped until the marketplace source is trusted."),
	};
}

function failed(code: string, message: string, cacheKey?: string): PiExtensionDiscoveryResult {
	return {
		status: "failed",
		tools: [],
		...(cacheKey ? { cacheKey } : {}),
		diagnostic: diagnostic("discovery-failed", code, message),
	};
}

function ok(tools: PiExtensionToolInfo[], cacheKey?: string): PiExtensionDiscoveryResult {
	return {
		status: "ok",
		tools,
		...(cacheKey ? { cacheKey } : {}),
	};
}

function absolutizeNodeFlagValue(flag: string, value: string): string {
	// Unit tests often run under tsx via a relative --import/--loader hook. The
	// probe process intentionally runs from an empty temp cwd, so relative hook
	// paths must be anchored to the parent process cwd before forwarding them.
	if ((flag === "--import" || flag === "--loader" || flag === "--experimental-loader" || flag === "--require" || flag === "-r")
		&& value.startsWith(".") && !value.startsWith("data:") && !value.startsWith("node:")) {
		const absolute = path.resolve(process.cwd(), value);
		return (flag === "--import" || flag === "--loader" || flag === "--experimental-loader")
			? pathToFileURL(absolute).href
			: absolute;
	}
	return value;
}

function safeExecArgv(argv: readonly string[]): string[] {
	const out: string[] = [];
	const flagsWithValue = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]);
	const safePrefixes = ["--require=", "--import=", "--loader=", "--experimental-loader=", "--conditions="];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const prefix = safePrefixes.find((p) => arg.startsWith(p));
		if (prefix) {
			const flag = prefix.slice(0, -1);
			out.push(prefix + absolutizeNodeFlagValue(flag, arg.slice(prefix.length)));
			continue;
		}
		if (flagsWithValue.has(arg)) {
			const value = argv[i + 1];
			if (typeof value === "string") {
				out.push(arg, absolutizeNodeFlagValue(arg, value));
				i++;
			}
		}
	}
	return out;
}

function minimalEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "HOME", "USERPROFILE"]) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	// Explicitly remove Bobbit/provider/session secrets from executable discovery.
	for (const key of Object.keys(env)) {
		if (/^(BOBBIT_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AWS_|AZURE_)/i.test(key)) delete env[key];
	}
	return env;
}

function boundedAppend(current: string, chunk: Buffer): string {
	const next = current + chunk.toString("utf-8");
	if (Buffer.byteLength(next, "utf-8") <= MAX_OUTPUT_BYTES) return next;
	return next.slice(-MAX_OUTPUT_BYTES);
}

function sanitizeMessage(value: unknown): string {
	const raw = value instanceof Error ? value.message : String(value ?? "unknown error");
	return raw.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 1000) || "unknown error";
}

function parseProbeResult(stdout: string): { status: "ok"; tools: PiExtensionToolInfo[] } | { status: "failed"; code: string; message: string } | null {
	const idx = stdout.lastIndexOf(RESULT_MARKER);
	if (idx < 0) return null;
	const tail = stdout.slice(idx + RESULT_MARKER.length).trimStart();
	const line = tail.split(/\r?\n/, 1)[0] ?? "";
	try {
		const parsed = JSON.parse(line) as any;
		if (parsed?.status === "ok" && Array.isArray(parsed.tools)) return { status: "ok", tools: normalizeTools(parsed.tools) };
		if (parsed?.status === "failed") return { status: "failed", code: String(parsed.code || "probe_failed"), message: sanitizeMessage(parsed.message) };
	} catch { /* fall through */ }
	return null;
}

function normalizeTools(raw: unknown[]): PiExtensionToolInfo[] {
	const out: PiExtensionToolInfo[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const obj = item as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name.trim() : "";
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const tool: PiExtensionToolInfo = { name };
		if (typeof obj.description === "string" && obj.description.trim()) tool.description = obj.description.trim();
		if (obj.inputSchema && typeof obj.inputSchema === "object" && !Array.isArray(obj.inputSchema)) tool.inputSchema = obj.inputSchema as Record<string, unknown>;
		out.push(tool);
	}
	return out;
}

function probeScript(): string {
	return `
import { pathToFileURL } from "node:url";
const MARKER = ${JSON.stringify(RESULT_MARKER)};
const tools = [];
const seen = new Set();
function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function pickSchema(v) {
  if (!isObj(v)) return undefined;
  for (const key of ["inputSchema", "schema", "parameters", "args", "argsSchema"]) {
    if (isObj(v[key])) return v[key];
  }
  return undefined;
}
function recordTool(...args) {
  let name;
  let description;
  let inputSchema;
  const first = args[0];
  const second = args[1];
  const third = args[2];
  if (typeof first === "string") {
    name = first;
    if (typeof second === "string") description = second;
    if (isObj(second)) {
      if (typeof second.description === "string") description = second.description;
      inputSchema = pickSchema(second);
    }
    if (!inputSchema && isObj(third)) inputSchema = pickSchema(third);
  } else if (isObj(first)) {
    if (typeof first.name === "string") name = first.name;
    else if (typeof first.id === "string") name = first.id;
    if (typeof first.description === "string") description = first.description;
    inputSchema = pickSchema(first);
  }
  if (!name || seen.has(name)) return;
  seen.add(name);
  const tool = { name };
  if (description) tool.description = description;
  if (inputSchema) tool.inputSchema = inputSchema;
  tools.push(tool);
}
const noOp = () => undefined;
const registrar = (...args) => { recordTool(...args); return undefined; };
const toolsApi = new Proxy({}, { get(_target, prop) {
  if (["register", "registerTool", "tool", "add", "addTool", "define", "create"].includes(String(prop))) return registrar;
  return noOp;
}});
const pi = new Proxy({
  registerTool: registrar,
  tool: registrar,
  addTool: registrar,
  register: registrar,
  defineTool: registrar,
  tools: toolsApi,
  on: noOp,
  once: noOp,
  off: noOp,
  emit: noOp,
  log: { debug: noOp, info: noOp, warn: noOp, error: noOp },
}, { get(target, prop) {
  if (prop in target) return target[prop];
  if (String(prop).toLowerCase().includes("tool") || String(prop).toLowerCase().includes("register")) return registrar;
  return noOp;
}});
globalThis.pi = pi;
try {
  const entry = process.argv[2];
  const mod = await import(pathToFileURL(entry).href);
  let activate = typeof mod.default === "function" ? mod.default : undefined;
  if (!activate && mod.default && typeof mod.default.activate === "function") activate = mod.default.activate.bind(mod.default);
  if (!activate && typeof mod.activate === "function") activate = mod.activate;
  if (!activate && typeof mod.register === "function") activate = mod.register;
  if (!activate && typeof mod.extension === "function") activate = mod.extension;
  if (activate) await activate(pi);
  console.log(MARKER + JSON.stringify({ status: "ok", tools }));
} catch (err) {
  const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "probe_failed";
  console.log(MARKER + JSON.stringify({ status: "failed", code, message }));
}
`;
}

export async function discoverPiExtensionTools(entryPath: string, opts: DiscoverPiExtensionToolsOptions): Promise<PiExtensionDiscoveryResult> {
	const cache = computePiExtensionDiscoveryCacheKeyWithDiagnostics(entryPath);
	if (cache.diagnostic) return failed(cache.diagnostic.code, cache.diagnostic.message, cache.cacheKey);
	const cacheKey = cache.cacheKey;
	if (!opts.trustAccepted) return skipped(cacheKey);
	const st = (() => {
		try { return fs.statSync(entryPath); } catch { return null; }
	})();
	if (!st?.isFile()) return failed("entry_not_found", `Pi extension entry does not exist or is not a file: ${entryPath}`, cacheKey);

	const tempRoot = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-probe-"));
	let createdTemp = !opts.cwd;
	try {
		fs.mkdirSync(tempRoot, { recursive: true });
		const probePath = path.join(tempRoot, "probe.mjs");
		fs.writeFileSync(probePath, probeScript(), "utf-8");
		const result = await runProbe(probePath, entryPath, tempRoot, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		if (result.timedOut) return failed("probe_timeout", `Pi extension discovery timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`, cacheKey);
		const parsed = parseProbeResult(result.stdout);
		if (!parsed) {
			const stderr = sanitizeMessage(result.stderr || result.stdout || `probe exited with code ${result.exitCode ?? "unknown"}`);
			return failed("probe_invalid_output", `Pi extension discovery did not return a valid result: ${stderr}`, cacheKey);
		}
		if (parsed.status === "failed") return failed(parsed.code || "probe_failed", parsed.message, cacheKey);
		return ok(parsed.tools, cacheKey);
	} finally {
		if (createdTemp) {
			try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}
}

export function discoverPiExtensionToolsSync(entryPath: string, opts: DiscoverPiExtensionToolsOptions): PiExtensionDiscoveryResult {
	const cache = computePiExtensionDiscoveryCacheKeyWithDiagnostics(entryPath);
	if (cache.diagnostic) return failed(cache.diagnostic.code, cache.diagnostic.message, cache.cacheKey);
	const cacheKey = cache.cacheKey;
	if (!opts.trustAccepted) return skipped(cacheKey);
	const st = (() => {
		try { return fs.statSync(entryPath); } catch { return null; }
	})();
	if (!st?.isFile()) return failed("entry_not_found", `Pi extension entry does not exist or is not a file: ${entryPath}`, cacheKey);

	const tempRoot = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-probe-"));
	let createdTemp = !opts.cwd;
	try {
		fs.mkdirSync(tempRoot, { recursive: true });
		const probePath = path.join(tempRoot, "probe.mjs");
		fs.writeFileSync(probePath, probeScript(), "utf-8");
		const result = runProbeSync(probePath, entryPath, tempRoot, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		if (result.timedOut) return failed("probe_timeout", `Pi extension discovery timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`, cacheKey);
		const parsed = parseProbeResult(result.stdout);
		if (!parsed) {
			const stderr = sanitizeMessage(result.stderr || result.stdout || `probe exited with code ${result.exitCode ?? "unknown"}`);
			return failed("probe_invalid_output", `Pi extension discovery did not return a valid result: ${stderr}`, cacheKey);
		}
		if (parsed.status === "failed") return failed(parsed.code || "probe_failed", parsed.message, cacheKey);
		return ok(parsed.tools, cacheKey);
	} finally {
		if (createdTemp) {
			try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}
}

function runProbeSync(probePath: string, entryPath: string, cwd: string, timeoutMs: number): { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean } {
	const result = spawnSync(process.execPath, [...safeExecArgv(process.execArgv), probePath, entryPath], {
		cwd,
		env: minimalEnv(),
		encoding: "utf-8",
		windowsHide: true,
		timeout: timeoutMs,
		maxBuffer: MAX_OUTPUT_BYTES,
	});
	const stdout = String(result.stdout ?? "").slice(-MAX_OUTPUT_BYTES);
	let stderr = String(result.stderr ?? "").slice(-MAX_OUTPUT_BYTES);
	if (result.error) stderr = boundedAppend(stderr, Buffer.from(sanitizeMessage(result.error)));
	const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
	return { stdout, stderr, exitCode: result.status, timedOut };
}

function runProbe(probePath: string, entryPath: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;
		let timedOut = false;
		const child = spawn(process.execPath, [...safeExecArgv(process.execArgv), probePath, entryPath], {
			cwd,
			env: minimalEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		const finish = (exitCode: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				try { child.kill("SIGKILL"); } catch { /* ignore */ }
			}
			finish(null);
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
		child.stderr?.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });
		child.on("error", (err) => {
			stderr = boundedAppend(stderr, Buffer.from(sanitizeMessage(err)));
			finish(null);
		});
		child.on("exit", (code) => finish(code));
	});
}
