/**
 * Scripted-agent bridge — Step 1 prototype.
 *
 * An IRpcBridge implementation that replays a declarative script (loaded
 * from `BOBBIT_FIDELITY_SCRIPT`) instead of spawning an agent process or
 * pattern-matching prompts.
 *
 * Activation: registered as an additional RpcBridge factory by the
 * fidelity harness. The mock-agent factory still wins for pre-existing
 * tests; this factory only intercepts when the env var is set.
 *
 * Public surface mirrors RpcBridge / InProcessMockBridge so SessionManager
 * can use either without branching. See ../in-process-mock-bridge.mjs for
 * the canonical reference.
 *
 * NOT a replacement for mock-agent-core: this bridge is driven entirely
 * from an external script, with no prompt-keyed branches. That's the
 * point — deterministic by construction.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Parse `"+30ms"` / `"30ms"` / `"+0ms"` etc. into a positive integer.
 * Accepts "ms" suffix only; bare numbers also accepted.
 */
function parseDuration(spec) {
	if (typeof spec === "number") return Math.max(0, spec | 0);
	if (typeof spec !== "string") throw new Error(`Bad duration: ${JSON.stringify(spec)}`);
	const m = spec.trim().match(/^([+]?)(-?\d+)ms?$/);
	if (!m) throw new Error(`Bad duration: ${spec}`);
	return Math.max(0, parseInt(m[2], 10) | 0);
}

function loadScript(path) {
	const raw = fs.readFileSync(path, "utf-8");
	const obj = JSON.parse(raw);
	if (!obj || typeof obj !== "object") throw new Error("Script root must be an object");
	if (!Array.isArray(obj.steps)) throw new Error("Script.steps must be an array");
	return obj;
}

export class ScriptedAgentBridge {
	constructor(options = {}) {
		this.options = options;
		this.eventListeners = [];
		this._running = false;
		this._stopped = false;
		this._requestId = 0;
		this._scriptPath = options.env?.BOBBIT_FIDELITY_SCRIPT
			|| process.env.BOBBIT_FIDELITY_SCRIPT
			|| null;
		this._script = null;
		// Pending resolvers for `on: user_prompt` / future `on:` directives.
		this._waiters = { user_prompt: [] };
		this._stepRunner = null;
		this._cwd = options.cwd || process.cwd();
		this._env = options.env || process.env;
		this._sessionFilePath = null;
		this._currentModel = { provider: "fidelity", id: "scripted", contextWindow: 128000, maxTokens: 16384 };
	}

	async start() {
		if (this._running) return;
		if (!this._scriptPath) {
			throw new Error("ScriptedAgentBridge: BOBBIT_FIDELITY_SCRIPT not set");
		}
		this._script = loadScript(this._scriptPath);
		this._running = true;
		// Mirror "session_status: idle" on startup like the real bridge does.
		this._emit({ type: "session_status", status: "idle" });
	}

	_emit(event) {
		for (const l of this.eventListeners) {
			try { l(event); } catch { /* listener errors are non-fatal */ }
		}
	}

	onEvent(listener) {
		this.eventListeners.push(listener);
		return () => {
			const i = this.eventListeners.indexOf(listener);
			if (i >= 0) this.eventListeners.splice(i, 1);
		};
	}

	/**
	 * Drive the script forward. Each `at:` step is awaited in order; an
	 * `on: user_prompt` step blocks until the next prompt arrives.
	 *
	 * Lifecycle: when the script's last step completes, `_stepRunner` is
	 * cleared so the NEXT incoming prompt restarts the script from step
	 * 0. This makes multi-iteration tests work without re-creating the
	 * session — each prompt either wakes a pending `on: user_prompt`
	 * waiter (mid-script) or kicks off a fresh run (post-script).
	 */
	_runScript() {
		if (this._stepRunner) return this._stepRunner;
		this._stepRunner = (async () => {
			const steps = this._script.steps;
			for (const step of steps) {
				if (this._stopped) return;
				if (step.on === "user_prompt") {
					await new Promise((resolve) => this._waiters.user_prompt.push(resolve));
					continue;
				}
				if (step.at !== undefined) {
					const ms = parseDuration(step.at);
					if (ms > 0) await new Promise((r) => setTimeout(r, ms));
					if (step.emit) this._emit(step.emit);
					continue;
				}
				if (step.emit) {
					this._emit(step.emit);
					continue;
				}
				// Unknown step shape — skip with a console warn so script
				// authors notice typos.
				console.warn("[scripted-agent] Unknown step:", JSON.stringify(step));
			}
		})().finally(() => {
			// Clear so a new prompt starts a fresh run.
			this._stepRunner = null;
		});
		return this._stepRunner;
	}

	async sendCommand(command, _timeoutMs = 30_000) {
		if (!this._running || this._stopped) {
			throw new Error("Agent process not running");
		}
		const id = `req_${++this._requestId}`;
		switch (command.type) {
			case "prompt":
			case "follow_up": {
				// Echo the user message exactly like the real agent does, so the
				// reducer puts a <user-message> in the transcript.
				const text = command.message || "";
				const userMsg = { role: "user", content: [{ type: "text", text }] };
				this._emit({ type: "message_end", message: userMsg });
				// Kick off the script if not already running (post-script
				// restarts a fresh run from step 0; mid-script no-ops). Then
				// yield so the script's IIFE registers its `on: user_prompt`
				// waiter, and wake it.
				this._runScript();
				await Promise.resolve();
				const waiters = this._waiters.user_prompt.splice(0);
				for (const w of waiters) w();
				return { type: "response", id, success: true };
			}
			case "steer": {
				const text = command.message || command.text || "";
				if (text) {
					const userMsg = { role: "user", content: [{ type: "text", text }] };
					this._emit({ type: "message_end", message: userMsg });
					this._runScript();
					await Promise.resolve();
					const waiters = this._waiters.user_prompt.splice(0);
					for (const w of waiters) w();
				}
				return { type: "response", id, success: true };
			}
			case "abort":
				this._stopped = false; // soft abort — script keeps running for the prototype
				return { type: "response", id, success: true };
			case "get_state": {
				// SessionManager retries get_state up to 4 times waiting for a
				// real `sessionFile` path; missing it logs CRITICAL and the
				// session can later be marked unrecoverable, which manifests as
				// later prompts being silently dropped (slots=0 / no_idle_status
				// in the fidelity oracle). Provide a real, on-disk file like
				// MockAgentCore does, scoped to the worker's BOBBIT_AGENT_DIR.
				const sf = this._ensureSessionFile();
				return {
					type: "response", id,
					success: true,
					data: {
						status: "idle",
						sessionFile: sf,
						model: this._currentModel,
					},
				};
			}
			case "get_messages":
				return { type: "response", id, success: true, data: [] };
			case "set_model":
			case "set_thinking_level":
			case "compact":
				return { type: "response", id, success: true };
			default:
				return { type: "response", id, success: true };
		}
	}

	prompt(text) { return this.sendCommand({ type: "prompt", message: text }); }
	steer(text) { return this.sendCommand({ type: "steer", message: text }); }
	abort() { return this.sendCommand({ type: "abort" }); }
	getState() { return this.sendCommand({ type: "get_state" }); }
	getMessages() { return this.sendCommand({ type: "get_messages" }); }
	setModel(p, m) { return this.sendCommand({ type: "set_model", provider: p, modelId: m }); }
	setThinkingLevel(l) { return this.sendCommand({ type: "set_thinking_level", level: l }); }
	compact() { return this.sendCommand({ type: "compact" }); }

	async waitForReady() {
		if (!this._running || this._stopped) {
			throw new Error("Scripted agent not running");
		}
	}

	_ensureSessionFile() {
		if (this._sessionFilePath) return this._sessionFilePath;
		const agentDir = this._env.BOBBIT_AGENT_DIR
			|| path.join(this._env.HOME || this._env.USERPROFILE || "/tmp", ".bobbit", "agent");
		const slug = this._cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").substring(0, 60) || "--workspace--";
		const dir = path.join(agentDir, "sessions", slug);
		fs.mkdirSync(dir, { recursive: true });
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const uuid = (typeof crypto !== "undefined" && crypto.randomUUID?.()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		this._sessionFilePath = path.join(dir, `${ts}_${uuid}.jsonl`);
		fs.writeFileSync(this._sessionFilePath, "");
		return this._sessionFilePath;
	}

	async stop() {
		if (this._stopped) return;
		this._stopped = true;
		this._running = false;
		// Resolve any pending prompt waiters so awaits don't hang.
		const waiters = this._waiters.user_prompt.splice(0);
		for (const w of waiters) w();
		for (const l of this.eventListeners) {
			try { l({ type: "process_exit", code: 0, signal: null }); } catch { /* */ }
		}
		this.eventListeners = [];
	}

	get running() { return this._running && !this._stopped; }
}

/**
 * Returns true if this session should be routed to the scripted bridge.
 * The harness sets BOBBIT_FIDELITY_SCRIPT before any session is created;
 * we honour that for any session.
 */
export function shouldUseScriptedAgent() {
	return !!process.env.BOBBIT_FIDELITY_SCRIPT;
}
