import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { IRpcBridge, RpcBridgeOptions, RpcEventListener } from "./rpc-bridge.js";
import {
	CLAUDE_CODE_STREAM_LIMITS,
	ClaudeCodeJsonlParser,
	ClaudeCodeStreamTranslator,
	createClaudeCodeTranslatorState,
} from "./claude-code-stream.js";
import {
	buildClaudeCodeSanitizedEnv,
	getClaudeCodeProbeCwd,
	isValidModelAlias as isValidClaudeCodeModelAliasToken,
	resolveClaudeCodeExecutable,
	toClaudeCodeCliModelAlias,
	toClaudeCodeDisplayModelAlias,
} from "./claude-code-config.js";

const COLD_REPROMPT_READY_TIMEOUT_MS = 90_000;
const COLD_REPROMPT_PROMPT_TIMEOUT_MS = 120_000;
const ATTACHMENT_ONLY_TEXT = "Attachments:";
const STDERR_TAIL_LINES = 20;
const STDERR_LINE_LIMIT = CLAUDE_CODE_STREAM_LIMITS.maxDiagnosticLineLength;

function synthesizeClaudeCodeAttachmentText(text: string, images?: Array<unknown> | null): string {
	if (text && text.trim() !== "") return text;
	return Array.isArray(images) && images.length > 0 ? ATTACHMENT_ONLY_TEXT : text;
}

export type ClaudeCodePermissionMode = "default" | "acceptEdits" | "bypassPermissions";
export type ClaudeCodeEffectivePermissionMode = ClaudeCodePermissionMode | "plan";

export interface ClaudeCodeBridgeOptions extends RpcBridgeOptions {
	claudeCodeExecutable?: string;
	claudeCodeModelAlias?: string;
	claudeCodePermissionMode?: ClaudeCodePermissionMode;
	claudeCodeAllowBypassPermissions?: boolean;
	claudeCodeSessionId?: string;
	readOnly?: boolean;
}

export function buildClaudeCodeArgs(options: ClaudeCodeBridgeOptions = {}): string[] {
	const args = [
		"--print",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--replay-user-messages",
	];

	const modelAlias = resolveClaudeCodeCliModelAlias(options);
	if (modelAlias) {
		args.push("--model", modelAlias);
	}

	const appendSystemPrompt = readClaudeCodeAppendSystemPrompt(options.systemPromptPath);
	if (appendSystemPrompt) {
		// Claude Code does not accept Bobbit's Pi-only --system-prompt file flag.
		// Its supported non-interactive mechanism is --append-system-prompt <text>;
		// pass the assembled prompt as a single spawn argv element, never via a shell.
		args.push("--append-system-prompt", appendSystemPrompt);
	}

	const permissionMode = resolveClaudeCodePermissionMode(options);
	args.push("--permission-mode", permissionMode);

	const effort = normalizeClaudeCodeEffort(options.initialThinkingLevel);
	if (effort) args.push("--effort", effort);

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

export function resolveClaudeCodePermissionMode(options: ClaudeCodeBridgeOptions = {}): ClaudeCodeEffectivePermissionMode {
	if (options.readOnly) return "plan";
	const configured = normalizePermissionMode(options.claudeCodePermissionMode, options.claudeCodeAllowBypassPermissions);
	return configured === "default" ? "acceptEdits" : configured;
}

export function normalizeClaudeCodeEffort(level: unknown): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
	if (level === "off" || level === "minimal" || level === "low") return "low";
	if (level === "medium" || level === "high" || level === "xhigh" || level === "max") return level;
	return undefined;
}

export function resolveClaudeCodeModelAlias(options: ClaudeCodeBridgeOptions = {}): string {
	const direct = options.claudeCodeModelAlias;
	if (isValidClaudeCodeModelAlias(direct)) return toClaudeCodeDisplayModelAlias(direct) ?? direct;
	const initial = options.initialModel;
	if (initial?.startsWith("claude-code/")) {
		const alias = initial.slice("claude-code/".length);
		if (isValidClaudeCodeModelAlias(alias)) return toClaudeCodeDisplayModelAlias(alias) ?? alias;
	}
	return "local-claude-sonnet-4-6";
}

export function resolveClaudeCodeCliModelAlias(options: ClaudeCodeBridgeOptions = {}): string | undefined {
	const direct = options.claudeCodeModelAlias;
	if (isValidClaudeCodeModelAlias(direct)) return toClaudeCodeCliModelAlias(direct);
	const initial = options.initialModel;
	if (initial?.startsWith("claude-code/")) {
		const alias = initial.slice("claude-code/".length);
		if (isValidClaudeCodeModelAlias(alias)) return toClaudeCodeCliModelAlias(alias);
	}
	return undefined;
}

function isValidClaudeCodeModelAlias(value: unknown): value is string {
	return typeof value === "string" && isValidClaudeCodeModelAliasToken(value);
}

function readClaudeCodeAppendSystemPrompt(systemPromptPath: string | undefined): string | undefined {
	if (!systemPromptPath) return undefined;
	const prompt = readFileSync(systemPromptPath, "utf8");
	return prompt.trim() === "" ? undefined : prompt;
}

function safeSpawnCwd(cwd: string | undefined): string {
	if (!cwd) return getClaudeCodeProbeCwd();
	return path.resolve(cwd);
}

function truncateDiagnosticLine(line: string): string {
	return line.length <= STDERR_LINE_LIMIT ? line : `${line.slice(0, STDERR_LINE_LIMIT - 1)}…`;
}

export class ClaudeCodeBridge implements IRpcBridge {
	private process: ChildProcess | null = null;
	private eventListeners: RpcEventListener[] = [];
	private parser = new ClaudeCodeJsonlParser();
	private readonly stderrDecoder = new StringDecoder("utf8");
	private stderrTail: string[] = [];
	private translator: ClaudeCodeStreamTranslator;
	private pendingPrompt: {
		resolve: (value: any) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	} | null = null;
	private stopping = false;
	private expectedAbortExit = false;
	private processExitEmitted = false;
	private lastResultCompleted = false;
	private promptCounter = 0;
	private streamFailureEmitted = false;
	private expectedModelSwitchExit = false;
	private switchingModel = false;
	private turnActive = false;
	private turnStartedAtMs: number | null = null;

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

		const executable = resolveClaudeCodeExecutable(this.options.claudeCodeExecutable || this.options.cliPath || "claude", { cwd: this.options.cwd });
		const args = buildClaudeCodeArgs({
			...this.options,
			claudeCodeSessionId: this.translator.state.claudeCodeSessionId ?? this.options.claudeCodeSessionId,
		});
		this.parser = new ClaudeCodeJsonlParser();
		this.stopping = false;
		this.expectedAbortExit = false;
		this.processExitEmitted = false;
		this.lastResultCompleted = false;
		this.stderrTail = [];
		this.streamFailureEmitted = false;

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const child = spawn(executable.executablePath, args, {
				stdio: ["pipe", "pipe", "pipe"],
				cwd: safeSpawnCwd(this.options.cwd),
				env: buildClaudeCodeSanitizedEnv(this.options.env, { cwd: this.options.cwd, pathEnv: executable.pathEnv }),
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
		if (this.pendingPrompt || this.turnActive) throw new Error("Claude Code runtime is already processing a prompt");
		this.lastResultCompleted = false;
		this.turnActive = true;
		this.turnStartedAtMs = Date.now();

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
				if (this.pendingPrompt?.resolve === resolve) {
					this.pendingPrompt = null;
					this.turnActive = false;
					this.turnStartedAtMs = null;
				}
				reject(new Error("Command timed out: prompt"));
			}, timeoutMs);
			this.pendingPrompt = { resolve, reject, timeout };
			this.process!.stdin!.write(JSON.stringify(payload) + "\n", (error) => {
				if (!error) return;
				if (this.pendingPrompt?.resolve === resolve) {
					this.pendingPrompt = null;
					this.turnActive = false;
					this.turnStartedAtMs = null;
				}
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
		this.expectedAbortExit = true;
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
				thinkingLevel: this.options.initialThinkingLevel,
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
		if (!isValidClaudeCodeModelAlias(modelId)) {
			return { success: false, error: "Invalid Claude Code model alias" };
		}
		const previousAlias = this.translator.state.modelAlias ?? resolveClaudeCodeModelAlias(this.options);
		const nextAlias = toClaudeCodeDisplayModelAlias(modelId) ?? modelId;
		if (nextAlias === previousAlias) return { success: true };
		if (this.switchingModel) {
			return { success: false, error: "Claude Code model switch already in progress" };
		}
		if (this.pendingPrompt || this.turnActive || this.translator.state.assistantOpen) {
			return { success: false, error: "Cannot switch Claude Code model while a turn is active; wait for the turn to finish first" };
		}

		const resumeSessionId = normalizeResumeSessionId(this.translator.state.claudeCodeSessionId ?? this.options.claudeCodeSessionId);
		const hasConversation = this.translator.state.messages.length > 0;
		if (!resumeSessionId && hasConversation) {
			return {
				success: false,
				error: "Cannot switch Claude Code model alias because no Claude Code session id is available for resume",
			};
		}

		this.switchingModel = true;
		const wasRunning = !!this.process;
		try {
			if (this.process) await this.stopForModelSwitch();
			this.options.claudeCodeModelAlias = nextAlias;
			this.options.initialModel = `claude-code/${nextAlias}`;
			if (resumeSessionId) this.options.claudeCodeSessionId = resumeSessionId;
			this.translator.state.modelAlias = nextAlias;
			if (wasRunning || resumeSessionId || hasConversation) await this.start();
			return { success: true, runtime: "claude-code", model: { provider: "claude-code", id: nextAlias }, claudeCodeSessionId: resumeSessionId };
		} catch (err: any) {
			this.options.claudeCodeModelAlias = previousAlias;
			this.options.initialModel = `claude-code/${previousAlias}`;
			if (resumeSessionId) this.options.claudeCodeSessionId = resumeSessionId;
			this.translator.state.modelAlias = previousAlias;
			return { success: false, error: `Failed to restart Claude Code with model alias "${nextAlias}": ${err?.message || err}` };
		} finally {
			this.switchingModel = false;
		}
	}

	async setThinkingLevel(level: string): Promise<any> {
		const effort = normalizeClaudeCodeEffort(level);
		if (!effort) return { success: false, error: `Invalid Claude Code effort level: ${level}` };
		const previousLevel = this.options.initialThinkingLevel;
		if (normalizeClaudeCodeEffort(previousLevel) === effort) {
			this.options.initialThinkingLevel = level;
			return { success: true, runtime: "claude-code", thinkingLevel: level, effort };
		}
		if (this.switchingModel) return { success: false, error: "Claude Code restart already in progress" };
		if (this.pendingPrompt || this.turnActive || this.translator.state.assistantOpen) {
			return { success: false, error: "Cannot change Claude Code effort while a turn is active; wait for the turn to finish first" };
		}

		const resumeSessionId = normalizeResumeSessionId(this.translator.state.claudeCodeSessionId ?? this.options.claudeCodeSessionId);
		const hasConversation = this.translator.state.messages.length > 0;
		if (!resumeSessionId && hasConversation) {
			return { success: false, error: "Cannot change Claude Code effort because no Claude Code session id is available for resume" };
		}

		this.switchingModel = true;
		const wasRunning = !!this.process;
		try {
			if (this.process) await this.stopForModelSwitch();
			this.options.initialThinkingLevel = level;
			if (resumeSessionId) this.options.claudeCodeSessionId = resumeSessionId;
			if (wasRunning || resumeSessionId || hasConversation) await this.start();
			return { success: true, runtime: "claude-code", thinkingLevel: level, effort, claudeCodeSessionId: resumeSessionId };
		} catch (err: any) {
			this.options.initialThinkingLevel = previousLevel;
			if (resumeSessionId) this.options.claudeCodeSessionId = resumeSessionId;
			return { success: false, error: `Failed to restart Claude Code with effort "${effort}": ${err?.message || err}` };
		} finally {
			this.switchingModel = false;
		}
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

	private async stopForModelSwitch(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.expectedModelSwitchExit = true;
		await new Promise<void>((resolve) => {
			const killTimer = setTimeout(() => {
				if (this.process === child) {
					child.kill("SIGKILL");
					this.process = null;
				}
				resolve();
			}, 3000);
			child.once("close", () => {
				clearTimeout(killTimer);
				if (this.process === child) this.process = null;
				resolve();
			});
			child.kill("SIGTERM");
		});
		if (this.process === child) this.process = null;
	}

	private attachProcessHandlers(child: ChildProcess): void {
		let stdoutFlushed = false;
		const flushStdout = () => {
			if (stdoutFlushed) return;
			stdoutFlushed = true;
			try {
				const parsed = this.parser.end();
				for (const diagnostic of parsed.diagnostics) {
					this.emit({ type: "diagnostic", source: "claude-code", diagnostic });
				}
				for (const rawEvent of parsed.events) this.handleClaudeEvent(rawEvent);
			} catch (err: any) {
				this.handleStreamFailure(err);
			}
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			try {
				const parsed = this.parser.push(chunk);
				for (const diagnostic of parsed.diagnostics) {
					this.emit({ type: "diagnostic", source: "claude-code", diagnostic });
				}
				for (const rawEvent of parsed.events) this.handleClaudeEvent(rawEvent);
			} catch (err: any) {
				this.handleStreamFailure(err);
			}
		});
		child.stdout?.on("close", flushStdout);
		child.stdout?.on("end", flushStdout);

		child.stderr?.on("data", (chunk: Buffer) => {
			const lines = this.stderrDecoder.write(chunk).split("\n").map((line) => truncateDiagnosticLine(line.trim())).filter(Boolean);
			this.stderrTail.push(...lines);
			if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_LINES);
		});

		child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
			this.rejectPendingPrompt(error);
		});

		child.on("error", (error: Error) => {
			this.rejectPendingPrompt(error);
			this.process = null;
		});

		child.on("close", (code, signal) => {
			flushStdout();
			if (this.process === child) this.process = null;
			const reason = signal ? `signal ${signal}` : `code ${code}`;
			const stderrContext = this.stderrTail.length > 0 ? `\n  Last stderr:\n    ${this.stderrTail.slice(-5).join("\n    ")}` : "";
			this.rejectPendingPrompt(new Error(`Claude Code process exited with ${reason}${stderrContext}`));
			const normalPrintExit = this.lastResultCompleted && code === 0 && !signal;
			const expectedAbortExit = this.expectedAbortExit && (signal === "SIGTERM" || code === 143 || code === null);
			const expectedModelSwitchExit = this.expectedModelSwitchExit && (signal === "SIGTERM" || code === 143 || code === null);
			this.expectedAbortExit = false;
			this.expectedModelSwitchExit = false;
			if (!normalPrintExit && !expectedAbortExit && !expectedModelSwitchExit && (!this.stopping || code !== 0 || signal)) this.emitProcessExit(code, signal);
		});
	}

	private handleClaudeEvent(rawEvent: any): void {
		if (rawEvent?.type === "user") this.resolvePendingPrompt(rawEvent);
		const translatedEvent = this.withInferredTurnTiming(rawEvent);
		let events: any[];
		try {
			events = this.translator.translate(translatedEvent);
		} catch (err: any) {
			this.handleStreamFailure(err);
			return;
		}
		for (const event of events) this.emit(event);
		if (rawEvent?.type === "result") {
			this.lastResultCompleted = true;
			this.turnActive = false;
			this.turnStartedAtMs = null;
			if (this.pendingPrompt) this.resolvePendingPrompt(rawEvent);
		}
	}

	private withInferredTurnTiming(rawEvent: any): any {
		if (rawEvent?.type !== "result") return rawEvent;
		const hasDuration = typeof rawEvent.duration_ms === "number" || typeof rawEvent.durationMs === "number";
		if (hasDuration || this.turnStartedAtMs === null) return rawEvent;
		return { ...rawEvent, duration_ms: Math.max(0, Date.now() - this.turnStartedAtMs) };
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
		if (!pending) {
			this.turnActive = false;
			this.turnStartedAtMs = null;
			return;
		}
		clearTimeout(pending.timeout);
		this.pendingPrompt = null;
		this.turnActive = false;
		this.turnStartedAtMs = null;
		pending.reject(error);
	}

	private handleStreamFailure(error: Error): void {
		if (this.streamFailureEmitted) return;
		this.streamFailureEmitted = true;
		const message = truncateDiagnosticLine(error?.message || String(error));
		this.rejectPendingPrompt(new Error(message));
		this.emit({
			type: "diagnostic",
			source: "claude-code",
			diagnostic: {
				level: "warning",
				message: "Claude Code stream limit exceeded",
				line: "",
				error: message,
			},
		});
		this.emit({ type: "agent_end", stopReason: "error", runtime: "claude-code", error: message });
		this.turnActive = false;
		this.turnStartedAtMs = null;
		this.process?.kill("SIGTERM");
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
			timestamp: Date.now(),
			stopReason: "error",
			errorMessage: "Claude Code turn aborted.",
		};
		this.emit({ type: "message_end", message });
		this.emit({ type: "agent_end", stopReason: "abort", runtime: "claude-code" });
		this.turnActive = false;
		this.turnStartedAtMs = null;
	}
}
