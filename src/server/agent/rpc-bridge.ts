import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitDir, bobbitExtensionsDir, bobbitStateDir } from "../bobbit-dir.js";

export interface RpcBridgeOptions {
	/** Path to pi-coding-agent cli.js. Auto-resolved if omitted. */
	cliPath?: string;
	/** Working directory for the agent process */
	cwd?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Path to a custom system prompt file. When set, passed as --system-prompt to the agent. */
	systemPromptPath?: string;
	/** Extra environment variables */
	env?: Record<string, string>;
}

export type RpcEventListener = (event: any) => void;

/**
 * Lightweight bridge to a pi-coding-agent running in RPC mode.
 * Communicates via JSONL (one JSON object per line) over stdin/stdout.
 */
export class RpcBridge {
	private process: ChildProcess | null = null;
	private requestId = 0;
	private pending = new Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: ReturnType<typeof setTimeout> }>();
	private eventListeners: RpcEventListener[] = [];
	private lineBuffer = "";

	constructor(private options: RpcBridgeOptions = {}) {}

	async start(): Promise<void> {
		const cliPath = this.options.cliPath || findAgentCli();
		const args = ["--mode", "rpc"];
		if (this.options.cwd) args.push("--cwd", this.options.cwd);
		if (this.options.systemPromptPath) args.push("--system-prompt", this.options.systemPromptPath);
		if (this.options.args) args.push(...this.options.args);

		// Enable all built-in tools EXCEPT bash (which is provided by our custom extension)
		// unless --tools was explicitly passed (e.g. by role-based tool activation).
		if (!args.includes("--tools") && !args.includes("--no-tools")) {
			args.push("--tools", "read,edit,write,grep,find,ls");
		}

		// Always load the custom bash tool extension (FD-safe bash + bash_bg)
		const bashExtPath = path.join(bobbitExtensionsDir(), "bash-tool.ts");
		if (!args.includes(bashExtPath)) {
			args.push("--extension", bashExtPath);
		}

		this.process = spawn("node", [cliPath, ...args], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.options.cwd,
			env: { ...process.env, BOBBIT_DIR: bobbitDir(), ...this.options.env },
		});

		this.process.stdout!.on("data", (chunk: Buffer) => {
			this.handleData(chunk.toString("utf-8"));
		});

		this.process.stderr!.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
		});

		this.process.on("exit", (code) => {
			for (const [, p] of this.pending) {
				clearTimeout(p.timeout);
				p.reject(new Error(`Agent process exited with code ${code}`));
			}
			this.pending.clear();
			this.process = null;
		});

		// Brief pause for process initialization
		await new Promise((r) => setTimeout(r, 200));
	}

	/** Subscribe to agent events. Returns unsubscribe function. */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	/** Send an RPC command and wait for its response. */
	sendCommand(command: Record<string, any>, timeoutMs = 30_000): Promise<any> {
		if (!this.process?.stdin) {
			throw new Error("Agent process not running");
		}

		const id = `req_${++this.requestId}`;
		const msg = { ...command, id };

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Command timed out: ${command.type}`));
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timeout });
			this.process!.stdin!.write(JSON.stringify(msg) + "\n");
		});
	}

	// --- Convenience methods matching the RPC protocol ---

	prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>) {
		if (images?.length) {
			console.log(`[rpc-bridge] Sending prompt with ${images.length} image(s), first image: type=${images[0].type}, mimeType=${images[0].mimeType}, data length=${images[0].data?.length}`);
		}
		return this.sendCommand({ type: "prompt", message: text, ...(images?.length ? { images } : {}) });
	}

	steer(text: string) {
		return this.sendCommand({ type: "steer", message: text });
	}

	followUp(text: string) {
		return this.sendCommand({ type: "follow_up", message: text });
	}

	abort() {
		return this.sendCommand({ type: "abort" });
	}

	getState() {
		return this.sendCommand({ type: "get_state" });
	}

	setModel(provider: string, modelId: string) {
		return this.sendCommand({ type: "set_model", provider, modelId });
	}

	compact(timeoutMs = 120_000) {
		return this.sendCommand({ type: "compact" }, timeoutMs);
	}

	getMessages() {
		return this.sendCommand({ type: "get_messages" });
	}

	async stop(): Promise<void> {
		if (!this.process) return;

		return new Promise((resolve) => {
			const killTimer = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 3000);

			this.process!.on("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});

			this.process!.kill("SIGTERM");
		});
	}

	get running(): boolean {
		return this.process !== null;
	}

	// --- Private ---

	private handleData(data: string) {
		this.lineBuffer += data;
		const lines = this.lineBuffer.split("\n");
		this.lineBuffer = lines.pop()!; // keep incomplete trailing fragment

		for (const line of lines) {
			const trimmed = line.replace(/\r$/, "").trim();
			if (!trimmed) continue;

			let parsed: any;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue; // skip non-JSON output (e.g. log lines)
			}

			// Debug: log events to file
			try {
				const debugPath = path.join(bobbitStateDir(), "rpc-debug.log");
				appendFileSync(debugPath, `EVENT: type=${parsed.type}, id=${parsed.id}, msg_role=${parsed.message?.role}, success=${parsed.success}\n`);
				if (parsed.type === "message_end" && parsed.message?.role === "user") {
					const content = parsed.message.content;
					const types = Array.isArray(content) ? content.map((c: any) => c.type) : [typeof content];
					appendFileSync(debugPath, `  User msg content types: ${JSON.stringify(types)}\n`);
				}
				if (parsed.type?.includes("compaction") || parsed.type?.includes("compact")) {
					appendFileSync(debugPath, `  Compact detail: ${JSON.stringify(parsed).substring(0, 500)}\n`);
				}
			} catch(e) {
				process.stderr.write(`Debug log error: ${e}\n`);
			}

			// Response to a pending request
			if (parsed.type === "response" && parsed.id && this.pending.has(parsed.id)) {
				const p = this.pending.get(parsed.id)!;
				clearTimeout(p.timeout);
				this.pending.delete(parsed.id);
				p.resolve(parsed);
			} else {
				// Agent event — forward to listeners
				for (const listener of this.eventListeners) {
					listener(parsed);
				}
			}
		}
	}
}

/** Resolve the pi-coding-agent cli.js path from the installed package */
function findAgentCli(): string {
	try {
		// import.meta.resolve returns the URL of the package's main entry
		const mainUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
		const mainPath = fileURLToPath(mainUrl);
		// Main entry is dist/index.js; cli.js is in the same directory
		return path.join(path.dirname(mainPath), "cli.js");
	} catch {
		throw new Error(
			"Could not find pi-coding-agent CLI. " +
				"Either install @mariozechner/pi-coding-agent or pass --agent-cli /path/to/cli.js",
		);
	}
}
