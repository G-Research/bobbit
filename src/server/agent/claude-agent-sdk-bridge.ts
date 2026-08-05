import fs from "node:fs";
import type { Clock } from "../gateway-deps.js";
import { realClock } from "../gateway-deps.js";
import {
	COLD_REPROMPT_PROMPT_TIMEOUT_MS,
	COLD_REPROMPT_READY_TIMEOUT_MS,
	synthesizeAttachmentText,
	type IRpcBridge,
	type RpcBridgeOptions,
	type RpcEventListener,
} from "./rpc-bridge.js";
import {
	createClaudeSdkTranslatorState,
	translateClaudeSdkEvent,
	type ClaudeSdkTranslatorState,
} from "./claude-sdk-event-translator.js";

import type { Options, Query, SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeAgentSdkState = "new" | "starting" | "ready" | "running" | "interrupting" | "failed" | "stopped";

export interface ClaudeAgentSdkBridgeOptions extends RpcBridgeOptions {
	runtime: "claude-agent-sdk";
	claudeAgentSdkSessionId?: string;
	onBeforeCompact?: (input: { span?: string; summary?: string }) => Promise<void>;
}

export interface ClaudeAgentSdkBridgeDeps {
	query: typeof sdkQuery;
	clock: Clock;
}

export class ClaudeAgentSdkUnavailableError extends Error {
	readonly code = "CLAUDE_AGENT_SDK_UNAVAILABLE";
	constructor(message = "Claude Agent SDK is unavailable") {
		super(message);
		this.name = "ClaudeAgentSdkUnavailableError";
	}
}

/** Fixed, explicit budgets keep the bridge's public thinking vocabulary stable. */
export function thinkingBudgetForLevel(level: string): number | null | undefined {
	switch (level) {
		case "off": return null;
		case "minimal": return 1_024;
		case "low": return 2_048;
		case "medium": return 4_096;
		case "high": return 8_192;
		case "xhigh": return 16_384;
		case "max": return 32_768;
		default: return undefined;
	}
}

/** Strictly accept the opaque UUID values issued by the Agent SDK. */
export function isClaudeAgentSdkSessionId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * The SDK replaces its child environment, so never inherit the gateway's
 * credentials wholesale. Subscription discovery uses the user's HOME store.
 */
export function buildClaudeAgentSdkEnv(options: Pick<RpcBridgeOptions, "env">): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
		const value = process.env[name];
		if (value) env[name] = value;
	}
	for (const name of ["BOBBIT_SESSION_ID", "BOBBIT_SESSION_SECRET"]) {
		const value = options.env?.[name];
		if (value) env[name] = value;
	}
	env.CLAUDE_AGENT_SDK_CLIENT_APP = "bobbit";
	return env;
}

class AsyncInputQueue implements AsyncIterable<SDKUserMessage> {
	private rows: Array<{ message: SDKUserMessage; resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }> = [];
	private reader?: { resolve: (result: IteratorResult<SDKUserMessage>) => void };
	private closed?: Error;

	push(message: SDKUserMessage, deadlineMs: number, clock: Clock): Promise<void> {
		if (this.closed) return Promise.reject(this.closed);
		return new Promise<void>((resolve, reject) => {
			const row = { message, resolve, reject } as typeof this.rows[number];
			if (deadlineMs > 0) row.timer = clock.setTimeout(() => {
				const index = this.rows.indexOf(row);
				if (index >= 0) this.rows.splice(index, 1);
				reject(new Error("Claude Agent SDK input delivery timed out"));
			}, deadlineMs);
			this.rows.push(row);
			this.flush();
		});
	}

	private flush(): void {
		if (!this.reader || this.rows.length === 0) return;
		const reader = this.reader;
		this.reader = undefined;
		const row = this.rows.shift()!;
		if (row.timer) clearTimeout(row.timer);
		row.resolve();
		reader.resolve({ done: false, value: row.message });
	}

	fail(error: Error): void {
		if (this.closed) return;
		this.closed = error;
		for (const row of this.rows.splice(0)) {
			if (row.timer) clearTimeout(row.timer);
			row.reject(error);
		}
		if (this.reader) {
			this.reader.resolve({ done: true, value: undefined });
			this.reader = undefined;
		}
	}

	close(): void { this.fail(new Error("Claude Agent SDK bridge stopped")); }

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				if (this.rows.length > 0) {
					const row = this.rows.shift()!;
					if (row.timer) clearTimeout(row.timer);
					row.resolve();
					return Promise.resolve({ done: false, value: row.message });
				}
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise<IteratorResult<SDKUserMessage>>((resolve) => { this.reader = { resolve }; });
			},
		};
	}
}

function errorMessage(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return raw.replace(/(?:token|secret|key|authorization)\s*[:=]\s*[^\s,;]+/ig, "$1=<redacted>").slice(0, 500);
}

function unsupported(error: string): { success: false; error: string } { return { success: false, error }; }

export class ClaudeAgentSdkBridge implements IRpcBridge {
	private readonly listeners = new Set<RpcEventListener>();
	private readonly abortController = new AbortController();
	private readonly input = new AsyncInputQueue();
	private readonly ready: Promise<void>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private startPromise?: Promise<void>;
	private queryHandle?: Query;
	private state: ClaudeAgentSdkState = "new";
	private terminalError?: Error;
	private closed = false;
	private initializedSessionId?: string;
	private modelId?: string;
	private thinkingLevel?: string;
	private translatorState: ClaudeSdkTranslatorState = createClaudeSdkTranslatorState();

	constructor(private readonly options: ClaudeAgentSdkBridgeOptions, private readonly deps: ClaudeAgentSdkBridgeDeps) {
		this.modelId = options.initialModel?.startsWith("claude-agent-sdk/") ? options.initialModel.slice("claude-agent-sdk/".length) : undefined;
		this.thinkingLevel = options.initialThinkingLevel;
		this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
	}

	get running(): boolean { return this.queryHandle !== undefined && this.state !== "failed" && this.state !== "stopped"; }

	onEvent(listener: RpcEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
	private emit(event: any): void { for (const listener of this.listeners) { try { listener(event); } catch { /* listener isolation */ } } }

	async start(): Promise<void> {
		if (this.startPromise) return this.startPromise;
		if (this.state === "stopped") throw new Error("Claude Agent SDK bridge cannot be restarted");
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	private async startInternal(): Promise<void> {
		this.state = "starting";
		try {
			const systemPrompt = this.options.systemPromptPath ? fs.readFileSync(this.options.systemPromptPath, "utf8") : undefined;
			const initialModel = this.options.initialModel?.startsWith("claude-agent-sdk/")
				? this.options.initialModel.slice("claude-agent-sdk/".length) : undefined;
			const sdkOptions: Options = {
				cwd: this.options.cwd,
				env: buildClaudeAgentSdkEnv(this.options),
				abortController: this.abortController,
				...(systemPrompt ? { systemPrompt } : {}),
				...(initialModel ? { model: initialModel } : {}),
				...(this.options.claudeAgentSdkSessionId ? { resume: this.options.claudeAgentSdkSessionId } : {}),
				...(this.options.onBeforeCompact ? { hooks: { PreCompact: [{ hooks: [async (input) => {
					const compact = input as import("@anthropic-ai/claude-agent-sdk").PreCompactHookInput;
					await this.options.onBeforeCompact?.({ summary: compact.custom_instructions ?? undefined });
					return {};
				}] }] } } : {}),
			};
			this.queryHandle = this.deps.query({ prompt: this.input, options: sdkOptions });
			void this.consume(this.queryHandle);
			const initialized = await this.queryHandle.initializationResult();
			const sessionId = (initialized as { session_id?: unknown }).session_id;
			if (isClaudeAgentSdkSessionId(sessionId)) this.initializedSessionId = sessionId;
			if (this.terminalError || this.closed) throw this.terminalError ?? new Error("Claude Agent SDK stopped during initialization");
			this.state = "ready";
			this.resolveReady();
		} catch (error) {
			this.fail(error);
			throw this.terminalError!;
		}
	}

	private async consume(query: Query): Promise<void> {
		try {
			for await (const sdkEvent of query) {
				if (this.closed || this.state === "failed") return;
				const sessionId = (sdkEvent as { session_id?: unknown }).session_id;
				if (isClaudeAgentSdkSessionId(sessionId)) this.initializedSessionId = sessionId;
				const translated = translateClaudeSdkEvent(this.translatorState, sdkEvent as unknown as Record<string, unknown>);
				this.translatorState = translated.state;
				for (const event of translated.events) this.emit(event);
			}
			if (!this.closed && this.state === "starting") this.fail(new Error("Claude Agent SDK ended before initialization"));
		} catch (error) {
			if (!this.closed) this.fail(error);
		}
	}

	private fail(error: unknown): void {
		if (this.state === "failed" || this.state === "stopped") return;
		const wrapped = error instanceof ClaudeAgentSdkUnavailableError ? error : new ClaudeAgentSdkUnavailableError(errorMessage(error));
		this.terminalError = wrapped;
		this.state = "failed";
		this.input.fail(wrapped);
		this.rejectReady(wrapped);
		this.emit({ type: "process_exit", code: 1, error: wrapped.message });
	}

	async waitForReady(overallTimeoutMs = COLD_REPROMPT_READY_TIMEOUT_MS): Promise<void> {
		if (this.state === "failed" || this.state === "stopped") throw this.terminalError ?? new Error("Claude Agent SDK bridge stopped");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([this.ready, new Promise<void>((_, reject) => { timer = this.deps.clock.setTimeout(() => reject(new Error("Claude Agent SDK readiness timed out")), overallTimeoutMs); })]);
		} finally { if (timer) this.deps.clock.clearTimeout(timer); }
	}

	private async enqueue(text: string, images: Array<{ type: "image"; data: string; mimeType: string }> | undefined, timeoutMs: number, priority?: "now"): Promise<void> {
		await this.waitForReady(Math.min(timeoutMs, COLD_REPROMPT_READY_TIMEOUT_MS));
		if (this.state === "failed" || this.state === "stopped") throw this.terminalError ?? new Error("Claude Agent SDK bridge stopped");
		const body = synthesizeAttachmentText(text, images);
		const content: Array<Record<string, unknown>> = [];
		if (body) content.push({ type: "text", text: body });
		for (const image of images ?? []) content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
		const message: SDKUserMessage = { type: "user", message: { role: "user", content: content.length === 1 && content[0].type === "text" ? body : content as any }, parent_tool_use_id: null, ...(priority ? { priority } : {}) };
		await this.input.push(message, timeoutMs, this.deps.clock);
		if (this.state === "ready") this.state = "running";
	}

	async prompt(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, timeoutMs = COLD_REPROMPT_PROMPT_TIMEOUT_MS): Promise<void> {
		return this.enqueue(text, images, timeoutMs);
	}
	async promptWhenReady(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>, opts?: { readyTimeoutMs?: number; promptTimeoutMs?: number }): Promise<void> {
		await this.waitForReady(opts?.readyTimeoutMs ?? COLD_REPROMPT_READY_TIMEOUT_MS);
		return this.enqueue(text, images, opts?.promptTimeoutMs ?? COLD_REPROMPT_PROMPT_TIMEOUT_MS);
	}
	async steer(text: string): Promise<void> { return this.enqueue(text, undefined, 30_000, "now"); }
	async abort(): Promise<any> {
		if (!this.queryHandle) return unsupported("Claude Agent SDK query is not running");
		this.state = "interrupting";
		try { return await this.queryHandle.interrupt(); } finally { if (this.state === "interrupting") this.state = "ready"; }
	}
	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.state = "stopped";
		this.input.close();
		this.abortController.abort();
		try { this.queryHandle?.close(); } finally { this.listeners.clear(); }
	}
	async getState(): Promise<any> {
		return { success: true, data: {
			provider: "claude-agent-sdk",
			model: { provider: "claude-agent-sdk", id: this.modelId },
			thinkingLevel: this.thinkingLevel,
			sessionId: this.initializedSessionId,
		} };
	}
	async getMessages(): Promise<any> { return unsupported("Claude Agent SDK does not expose a transcript snapshot"); }
	async sendCommand(): Promise<any> { return unsupported("Claude Agent SDK does not support Pi RPC commands"); }
	async setModel(provider: string, modelId: string): Promise<any> {
		if (provider !== "claude-agent-sdk") return unsupported("Switching runtimes requires a new session");
		if (!this.queryHandle) return unsupported("Claude Agent SDK query is not running");
		await this.queryHandle.setModel(modelId);
		this.modelId = modelId;
		return { success: true };
	}
	async setThinkingLevel(level: string): Promise<any> {
		const budget = thinkingBudgetForLevel(level);
		if (budget === undefined) return unsupported(`Unsupported thinking level: ${level}`);
		if (!this.queryHandle) return unsupported("Claude Agent SDK query is not running");
		await this.queryHandle.setMaxThinkingTokens(budget);
		this.thinkingLevel = level;
		return { success: true };
	}
	async compact(): Promise<any> { return unsupported("Claude Agent SDK does not expose manual compaction"); }
}

/** Production dependency seam; tests inject an explicit Query implementation. */
export const defaultClaudeAgentSdkBridgeDeps: ClaudeAgentSdkBridgeDeps = {
	query: (await import("@anthropic-ai/claude-agent-sdk")).query,
	clock: realClock,
};
