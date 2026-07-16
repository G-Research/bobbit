/**
 * In-process RpcBridge for the mock agent.
 *
 * Drop-in replacement for RpcBridge that skips the Node subprocess: events
 * flow directly from MockAgentCore into the listener list, and RPC commands
 * resolve via in-memory async calls.
 *
 * Activation: set RpcBridgeOptions.cliPath to the sentinel value
 *   "<in-process-mock>"
 * (or pass the actual mock-agent.mjs path and rely on the auto-detection in
 * the RpcBridge factory).
 *
 * Public API mirrors RpcBridge exactly so SessionManager, TeamManager, and
 * the verification harness can construct either without branching.
 *
 * Isolation: each instance owns its own MockAgentCore; no module-level
 * state is shared between sessions. That is the whole point of the
 * in-process move — a single Node process can host hundreds of independent
 * "agent" instances cheaply.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MockAgentCore, mockModelFromString } from "./mock-agent-core.mjs";

export const IN_PROCESS_MOCK_SENTINEL = "<in-process-mock>";

function lastModelArg(args = []) {
	let model;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--model" && i + 1 < args.length) {
			model = args[++i];
		} else if (typeof arg === "string" && arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
		}
	}
	return mockModelFromString(model) ? model : undefined;
}

function extensionArgs(args = []) {
	const out = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--extension" && typeof args[i + 1] === "string") {
			out.push(args[++i]);
		}
	}
	return out;
}

function shouldLoadInMock(extensionPath) {
	const normalized = String(extensionPath || "").replace(/\\/g, "/");
	return normalized.includes("/pi-extensions/") || normalized.includes("/state/tool-guard/");
}

function parseToolRegistration(args) {
	let name;
	let description = "";
	let inputSchema;
	let handler;
	if (typeof args[0] === "string") {
		name = args[0];
		if (typeof args[1] === "function") {
			handler = args[1];
		} else {
			description = args[1]?.description || "";
			inputSchema = args[1]?.inputSchema || args[1]?.schema;
			handler = typeof args[2] === "function" ? args[2] : args[1]?.handler || args[1]?.execute;
		}
	} else if (args[0] && typeof args[0] === "object") {
		name = args[0].name;
		description = args[0].description || "";
		inputSchema = args[0].inputSchema || args[0].schema;
		handler = typeof args[1] === "function" ? args[1] : args[0].handler || args[0].execute;
	}
	if (!name || typeof handler !== "function") return null;
	return { name, description, inputSchema, handler };
}

const extensionModuleCache = new Map();
const extensionModuleLoadCounts = new Map();

/** Test-only observability for the immutable extension-module cache. */
export function __inProcessMockExtensionCacheStats(filePath) {
	const prefix = `${filePath}:`;
	const keys = [...extensionModuleCache.keys()].filter((key) => key.startsWith(prefix));
	return {
		entries: keys.length,
		loads: keys.reduce((total, key) => total + (extensionModuleLoadCounts.get(key) || 0), 0),
	};
}

async function importExtensionModule(filePath) {
	const stat = fs.statSync(filePath);
	const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
	let loaded = extensionModuleCache.get(key);
	if (loaded) return loaded;
	loaded = (async () => {
		if (!/\.tsx?$/i.test(filePath)) return import(pathToFileURL(filePath).href);
		const ts = await import("typescript");
		const source = fs.readFileSync(filePath, "utf-8");
		const transpiled = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 },
			fileName: filePath,
		});
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mock-pi-ext-"));
		const out = path.join(dir, path.basename(filePath).replace(/\.tsx?$/i, ".mjs"));
		fs.writeFileSync(out, transpiled.outputText, "utf-8");
		return import(pathToFileURL(out).href);
	})();
	extensionModuleCache.set(key, loaded);
	extensionModuleLoadCounts.set(key, (extensionModuleLoadCounts.get(key) || 0) + 1);
	try { return await loaded; }
	catch (error) {
		extensionModuleCache.delete(key);
		extensionModuleLoadCounts.delete(key);
		throw error;
	}
}

async function loadMockPiExtensions(args = [], env = {}) {
	const tools = new Map();
	const toolCallHandlers = [];
	const pi = {
		on(event, handler) {
			if (event === "tool_call" && typeof handler === "function") toolCallHandlers.push(handler);
		},
		tool(...registrationArgs) {
			const parsed = parseToolRegistration(registrationArgs);
			if (parsed) tools.set(parsed.name, parsed);
			return parsed;
		},
		registerTool(...registrationArgs) {
			return pi.tool(...registrationArgs);
		},
	};
	pi.tools = { register: (...registrationArgs) => pi.tool(...registrationArgs) };

	for (const extensionPath of extensionArgs(args)) {
		if (!shouldLoadInMock(extensionPath)) continue;
		try {
			const mod = await importExtensionModule(extensionPath);
			const activate = typeof mod.default === "function" ? mod.default : mod.default?.default;
			if (typeof activate === "function") {
				// Generated guards capture gateway-owned child env during synchronous
				// activation. Mirror only those values, then restore process-global state
				// before independent in-process sessions execute.
				const activationEnvKeys = ["BOBBIT_DIR", "BOBBIT_GATEWAY_URL", "BOBBIT_TOKEN", "BOBBIT_SESSION_ID"];
				const previousEnv = new Map(activationEnvKeys.map((key) => [key, process.env[key]]));
				let activationResult;
				try {
					for (const key of activationEnvKeys) {
						if (env[key] === undefined) delete process.env[key];
						else process.env[key] = env[key];
					}
					activationResult = activate(pi);
				} finally {
					for (const [key, value] of previousEnv) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				}
				if (activationResult && typeof activationResult.then === "function") await activationResult;
			}
		} catch (err) {
			// The real pi runtime reports extension-load failures without killing the
			// gateway. Mirror that behaviour for the mock: tests assert diagnostics via
			// server APIs, not stderr from this helper.
			console.warn(`[in-process-mock] failed to load extension ${extensionPath}: ${err?.message || err}`);
		}
	}
	return { tools, toolCallHandlers };
}

export class InProcessMockBridge {
	constructor(options = {}) {
		this.options = options;
		this._agent = null;
		// Field name matches the production RpcBridge so tests that reach into
		// `rpcClient.eventListeners` to simulate events (sandbox-recovery spec)
		// work identically against both transports.
		this.eventListeners = [];
		this._running = false;
		this._stopped = false;
		this._requestId = 0;
	}

	async start() {
		if (this._running) return;
		// Merge env: prefer process.env but overlay options.env (mirrors what
		// spawn() does in the real bridge). The core reads only env values,
		// not argv, so we pass cwd directly via opts.
		const env = { ...process.env, ...(this.options.env || {}) };
		const argModel = lastModelArg(this.options.args);
		const mockPi = await loadMockPiExtensions(this.options.args, env);
		this._agent = new MockAgentCore({
			cwd: this.options.cwd || process.cwd(),
			env,
			initialModel: argModel || this.options.initialModel,
			sleep: this.options.sleep,
			onEvent: (evt) => this._emit(evt),
			mockPiTools: mockPi.tools,
			mockPiToolCallHandlers: mockPi.toolCallHandlers,
		});
		this._running = true;
		// Mirror the child process's initial "session_status: idle" emission.
		// Some RpcBridge consumers wait for this to know the agent is alive.
		this._emit({ type: "session_status", status: "idle" });
	}

	/** Notify all subscribed listeners. Catch errors so one bad listener
	 *  can't break the rest (matches child-process bridge semantics). */
	_emit(event) {
		for (const listener of this.eventListeners) {
			try { listener(event); } catch { /* non-fatal */ }
		}
	}

	onEvent(listener) {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	async sendCommand(command, _timeoutMs = 30_000) {
		if (!this._running || this._stopped) {
			throw new Error("Agent process not running");
		}
		if (!this._agent) {
			throw new Error("Agent not initialized");
		}
		const id = `req_${++this._requestId}`;
		const res = await this._agent.handleCommand(command);
		// Shape the response like the real bridge does (bridge wraps the raw
		// response in `{type:"response", id, ...res}` on stdin parse).
		return { type: "response", id, ...res };
	}

	// --- Convenience methods matching RpcBridge ---

	prompt(text, images) {
		if (images?.length) {
			console.log(`[in-process-mock] Sending prompt with ${images.length} image(s)`);
		}
		return this.sendCommand({ type: "prompt", message: text, ...(images?.length ? { images } : {}) });
	}

	// Mirror RpcBridge.promptWhenReady: wait for the (cold) agent to be ready,
	// then prompt. This mock's prompt ignores the timeout arg, so we don't pass
	// one along.
	async promptWhenReady(text, images, opts) {
		await this.waitForReady(opts?.readyTimeoutMs ?? 90_000);
		return this.prompt(text, images);
	}

	steer(text) {
		return this.sendCommand({ type: "steer", message: text });
	}

	abort() {
		return this.sendCommand({ type: "abort" });
	}

	getState() {
		return this.sendCommand({ type: "get_state" });
	}

	async waitForReady(_overallTimeoutMs = 90_000) {
		// In-process agent is ready the moment start() returns. The real
		// bridge polls get_state for Docker readiness; we just verify it.
		if (!this._running || this._stopped) {
			throw new Error("Agent process not running");
		}
		try {
			await this.sendCommand({ type: "get_state" }, 5_000);
		} catch (err) {
			throw new Error(`In-process agent failed to respond: ${err.message}`);
		}
	}

	setModel(provider, modelId) {
		return this.sendCommand({ type: "set_model", provider, modelId });
	}

	setThinkingLevel(level) {
		return this.sendCommand({ type: "set_thinking_level", level });
	}

	compact(_timeoutMs = 120_000) {
		return this.sendCommand({ type: "compact" });
	}

	getMessages() {
		return this.sendCommand({ type: "get_messages" });
	}

	/** Inject an abortable delay for this agent. Omit it to restore real time. */
	setSleep(sleep) {
		this.options.sleep = sleep;
		this._agent?.setSleep(sleep);
	}

	async stop() {
		if (this._stopped) return;
		this._stopped = true;
		this._running = false;
		// Mirror the "agent process exited" notification so waitForIdle()
		// can unblock. Only emit if we had started.
		if (this._agent) {
			for (const listener of this.eventListeners) {
				try { listener({ type: "process_exit", code: 0, signal: null }); } catch { /* non-fatal */ }
			}
		}
		this._agent = null;
		this.eventListeners = [];
	}

	get running() {
		return this._running && !this._stopped;
	}
}

/**
 * Returns true if the given cliPath should route to the in-process mock
 * instead of spawning a child. Matches the sentinel or a path ending in
 * "mock-agent.mjs" (the E2E harness builds absolute paths to this file).
 */
export function shouldUseInProcessMock(cliPath) {
	if (!cliPath) return false;
	if (cliPath === IN_PROCESS_MOCK_SENTINEL) return true;
	// Accept both forward and back slashes (Windows).
	const normalized = String(cliPath).replace(/\\/g, "/");
	return normalized.endsWith("/mock-agent.mjs")
		|| normalized.endsWith("/tests/e2e/mock-agent.mjs");
}
