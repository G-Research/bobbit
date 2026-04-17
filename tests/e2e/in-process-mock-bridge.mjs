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
import { MockAgentCore } from "./mock-agent-core.mjs";

export const IN_PROCESS_MOCK_SENTINEL = "<in-process-mock>";

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
		this._agent = new MockAgentCore({
			cwd: this.options.cwd || process.cwd(),
			env,
			onEvent: (evt) => this._emit(evt),
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
