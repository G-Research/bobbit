import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { IRpcBridge, RpcBridgeOptions, RpcEventListener } from "./rpc-bridge.js";
import { ClaudeCodeJsonlParser, ClaudeCodeStreamTranslator, createClaudeCodeTranslatorState } from "./claude-code-stream.js";

const COLD_REPROMPT_READY_TIMEOUT_MS = 90_000;
const COLD_REPROMPT_PROMPT_TIMEOUT_MS = 120_000;
const ATTACHMENT_ONLY_TEXT = "Attachments:";

function synthesizeClaudeCodeAttachmentText(text: string, images?: Array<unknown> | null): string {
	if (text && text.trim() !== "") return text;
	return Array.isArray(images) && images.length > 0 ? ATTACHMENT_ONLY_TEXT : text;
}

export type ClaudeCodePermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface ClaudeCodeBridgeOptions extends RpcBridgeOptions {
	claudeCodeExecutable?: string;
	claudeCodeModelAlias?: string;
	claudeCodePermissionMode?: ClaudeCodePermissionMode;
	claudeCodeAllowBypassPermissions?: boolean;
	claudeCodeSessionId?: string;
}

export function buildClaudeCodeArgs(options: ClaudeCodeBridgeOptions = {}): string[] {
	const args = [
		"--print",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--replay-user-messages",
	];

	const permissionMode = normalizePermissionMode(options.claudeCodePermissionMode, options.claudeCodeAllowBypassPermissions);
	if (permissionMode !== "default") {
		args.push("--permission-mode", permissionMode);
	}

	const resumeSessionId = normalizeResumeSessionId(options.claudeCodeSessionId);
	if (resumeSessionId) {
		args.push("--resume", resumeSessionId);
	}

	return args;
}

export function normalizeResumeSessionId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	// Claude Code session IDs are opaque but CLI-safe tokens. Reject anything
	// needing shell quoting even though spawn() does not use a shell.
	return /^[A-Za-z0-9._:@-]{1,200}$/.test(trimmed) ? trimmed : undefined;
}

export function normalizePermissionMode(mode: unknown, allowBypass = false): ClaudeCodePermissionMode {
	if (mode === "acceptEdits") return "acceptEdits";
	if (mode === "bypassPermissions") return allowBypass ? "bypassPermissions" : "default";
	return "default";
}

export function resolveClaudeCodeModelAlias(options: ClaudeCodeBridgeOptions = {}): string {
	const direct = options.claudeCodeModelAlias;
	if (direct && /^[A-Za-z0-9._-]{1,48}$/.test(direct)) return direct;
	const initial = options.initialModel;
	if (initial?.startsWith("claude-code/")) {
		const alias = initial.slice("claude-code/".length);
		if (/^[A-Za-z0-9._-]{1,48}$/.test(alias)) return alias;
	}
	return "sonnet";
}

export class ClaudeCodeBridge implements IRpcBridge {
	private process: ChildProcess | null = null;
	private eventListeners: RpcEventListener[] = [];
	private readonly parser = new ClaudeCodeJsonlParser();
	private readonly stderrDecoder = new StringDecoder("utf8");
	private stderrTail: string[] = [];
	private translator: ClaudeCodeStreamTranslator;
	private pendingPrompt: {
		resolve: (value: any) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	} | null = null;
	private stopping = false;
	private processExitEmitted = false;
	private lastResultCompleted = false;
	private promptCounter = 0;

	constructor(private readonly options: ClaudeCodeBridgeOptions = {}) {
		this.translator = new ClaudeCodeStreamTranslator(
			createClaudeCodeTranslatorState(resolveClaudeCodeModelAlias(options)),
			{ messageIdPrefix: "claude-code-live" },
		);
		if (options.claudeCodeSessionId) {
			this.translator.state.claudeCodeSessionId = options.claudeCodeSessionId;
		}
	}

	async start(): Promise<void> {
		if (this.process) return;
		if (this.options.sandboxed || this.options.containerId) {
			throw new Error("Claude Code local runtime is host-only in the MVP and cannot run inside a Bobbit sandbox");
		}

		const executable = this.options.claudeCodeExecutable || this.options.cliPath || "claude";
		const args = buildClaudeCodeArgs(this.options);
		this.stopping = false;
		this.processExitEmitted = false;
		this.lastResultCompleted = false;
		this.stderrTail = [];

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const child = spawn(executable, args, {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: this.options.cwd,
				env: { ...process.env, ...this.options.env },
			});
			this.process = child;
			this.attachProcessHandlers(child);

			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				this.process = null;
				reject(error);
			};
			const onError = (error: Error) => fail(error);
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				fail(new Error(`Claude Code process exited immediately (${signal ? `signal ${signal}` : `code ${code}`})`));
			};
			child.once("error", onError);
			child.once("exit", onExit);
			setTimeout(() => {
				if (settled) return;
				settled = true;
				child.removeListener("error", onError);
				child.removeListener("exit", onExit);
				resolve();
			}, 100);
		});
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.stopping = true;
		await new Promise<void>((resolve) => {
			const killTimer = setTimeout(() => {
				if (this.process === child) child.kill("SIGKILL");
				resolve();
			}, 3000);
			child.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	async prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, timeoutMs = 30_000): Promise<any> {
		if (!this.process?.stdin) await this.start();
		if (!this.process?.stdin) throw new Error("Claude Code process not running");
		if (this.pendingPrompt) throw new Error("Claude Code runtime is already processing a prompt");
		this.lastResultCompleted = false;

		const effectiveText = synthesizeClaudeCodeAttachmentText(text, images);
		const content: any[] = [{ type: "text", text: effectiveText }];
		if (images?.length) {
			content.push(...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })));
		}
		const payload = {
			type: "user",
			message: { role: "user", content },
		};

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pendingPrompt?.resolve === resolve) this.pendingPrompt = null;
				reject(new Error("Command timed out: prompt"));
			}, timeoutMs);
			this.pendingPrompt = { resolve, reject, timeout };
			this.process!.stdin!.write(JSON.stringify(payload) + "\n", (error) => {
				if (!error) return;
				if (this.pendingPrompt?.resolve === resolve) this.pendingPrompt = null;
				clearTimeout(timeout);
				reject(error);
			});
		});
	}

	async promptWhenReady(
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number },
	): Promise<any> {
		await this.waitForReady(opts?.readyTimeoutMs ?? COLD_REPROMPT_READY_TIMEOUT_MS);
		return this.prompt(text, images, opts?.promptTimeoutMs ?? COLD_REPROMPT_PROMPT_TIMEOUT_MS);
	}

	async steer(_text: string): Promise<any> {
		return { success: false, error: "Live steer is not supported by Claude Code runtime in the MVP" };
	}

	async abort(): Promise<any> {
		if (!this.process) return { success: false, error: "Claude Code process not running" };
		this.emitAbortedTurn();
		this.process.kill("SIGTERM");
		return { success: true };
	}

	async getState(): Promise<any> {
		return {
			success: true,
			data: {
				runtime: "claude-code",
				model: { provider: "claude-code", id: this.translator.state.modelAlias ?? resolveClaudeCodeModelAlias(this.options) },
				claudeCodeSessionId: this.translator.state.claudeCodeSessionId,
				running: this.running,
			},
		};
	}

	async getMessages(): Promise<any> {
		return { success: true, data: { messages: [...this.translator.state.messages] } };
	}

	async setModel(provider: string, modelId: string): Promise<any> {
		if (provider !== "claude-code") {
			return { success: false, error: "Switching between Pi and Claude Code runtimes requires a new session" };
		}
		if (modelId === this.translator.state.modelAlias) return { success: true };
		return { success: false, error: "Changing Claude Code model aliases mid-session requires a new Claude Code session" };
	}

	async setThinkingLevel(_level: string): Promise<any> {
		return { success: false, error: "Thinking level changes are not supported by Claude Code runtime in the MVP" };
	}

	async compact(_timeoutMs = 120_000): Promise<any> {
		return { success: false, error: "Compaction is not supported by Claude Code runtime in the MVP" };
	}

	async waitForReady(overallTimeoutMs = 90_000): Promise<void> {
		if (!this.process) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Claude Code process did not become ready within ${overallTimeoutMs}ms`)), overallTimeoutMs);
			});
			try {
				await Promise.race([this.start(), timeout]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		if (!this.process) throw new Error("Claude Code process not running");
	}

	async sendCommand(command: Record<string, any>, timeoutMs?: number): Promise<any> {
		switch (command.type) {
			case "prompt": return this.prompt(String(command.message ?? ""), command.images, timeoutMs);
			case "steer": return this.steer(String(command.message ?? ""));
			case "abort": return this.abort();
			case "get_state": return this.getState();
			case "get_messages": return this.getMessages();
			case "set_model": return this.setModel(String(command.provider ?? ""), String(command.modelId ?? ""));
			case "set_thinking_level": return this.setThinkingLevel(String(command.level ?? ""));
			case "compact": return this.compact(timeoutMs);
			default: return { success: false, error: `Unsupported Claude Code bridge command: ${String(command.type ?? "unknown")}` };
		}
	}

	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index >= 0) this.eventListeners.splice(index, 1);
		};
	}

	get running(): boolean {
		return this.process !== null;
	}

	private attachProcessHandlers(child: ChildProcess): void {
		child.stdout?.on("data", (chunk: Buffer) => {
			const parsed = this.parser.push(chunk);
			for (const diagnostic of parsed.diagnostics) {
				this.emit({ type: "diagnostic", source: "claude-code", diagnostic });
			}
			for (const rawEvent of parsed.events) this.handleClaudeEvent(rawEvent);
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			const lines = this.stderrDecoder.write(chunk).split("\n").map((line) => line.trim()).filter(Boolean);
			this.stderrTail.push(...lines);
			if (this.stderrTail.length > 20) this.stderrTail = this.stderrTail.slice(-20);
		});

		child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
			this.rejectPendingPrompt(error);
		});

		child.on("error", (error: Error) => {
			this.rejectPendingPrompt(error);
			this.process = null;
		});

		child.on("exit", (code, signal) => {
			if (this.process === child) this.process = null;
			const reason = signal ? `signal ${signal}` : `code ${code}`;
			const stderrContext = this.stderrTail.length > 0 ? `\n  Last stderr:\n    ${this.stderrTail.slice(-5).join("\n    ")}` : "";
			this.rejectPendingPrompt(new Error(`Claude Code process exited with ${reason}${stderrContext}`));
			const normalPrintExit = this.lastResultCompleted && code === 0 && !signal;
			if (!normalPrintExit && (!this.stopping || code !== 0 || signal)) this.emitProcessExit(code, signal);
		});
	}

	private handleClaudeEvent(rawEvent: any): void {
		if (rawEvent?.type === "user") this.resolvePendingPrompt(rawEvent);
		const events = this.translator.translate(rawEvent);
		for (const event of events) this.emit(event);
		if (rawEvent?.type === "result") {
			this.lastResultCompleted = true;
			if (this.pendingPrompt) this.resolvePendingPrompt(rawEvent);
		}
	}

	private resolvePendingPrompt(rawEvent: any): void {
		const pending = this.pendingPrompt;
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pendingPrompt = null;
		this.promptCounter += 1;
		pending.resolve({ success: true, id: `claude-code-prompt-${this.promptCounter}`, acceptedBy: rawEvent?.type ?? "unknown" });
	}

	private rejectPendingPrompt(error: Error): void {
		const pending = this.pendingPrompt;
		if (!pending) return;
		clearTimeout(pending.timeout);
		this.pendingPrompt = null;
		pending.reject(error);
	}

	private emit(event: any): void {
		for (const listener of [...this.eventListeners]) {
			try {
				listener(event);
			} catch {
				// Listener failures must not break bridge parsing.
			}
		}
	}

	private emitProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.processExitEmitted) return;
		this.processExitEmitted = true;
		this.emit({ type: "process_exit", code, signal, runtime: "claude-code" });
	}

	private emitAbortedTurn(): void {
		const message = {
			id: `claude-code-abort-${Date.now().toString(36)}`,
			role: "assistant",
			content: [{ type: "text", text: "Claude Code turn aborted." }],
			stopReason: "error",
			errorMessage: "Claude Code turn aborted.",
		};
		this.emit({ type: "message_end", message });
		this.emit({ type: "agent_end", stopReason: "abort", runtime: "claude-code" });
	}
}
