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
import type { ThinkingLevel } from "../../shared/thinking-levels.js";

import type { Options, Query, SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFactory = (input: Parameters<typeof sdkQuery>[0]) => ReturnType<typeof sdkQuery> | Promise<ReturnType<typeof sdkQuery>>;

export type ClaudeAgentSdkState = "new" | "starting" | "ready" | "running" | "interrupting" | "failed" | "stopped";

export interface ClaudeAgentSdkBridgeOptions extends RpcBridgeOptions {
	runtime: "claude-agent-sdk";
	claudeAgentSdkSessionId?: string;
	onBeforeCompact?: (input: { span?: string; summary?: string }) => Promise<void>;
}

export interface ClaudeAgentSdkBridgeDeps {
	/** May be asynchronous so the production SDK is not imported until an SDK session starts. */
	query: QueryFactory;
	clock: Clock;
}

export class ClaudeAgentSdkUnavailableError extends Error {
	readonly code = "CLAUDE_AGENT_SDK_UNAVAILABLE";
	constructor(message = "Claude Agent SDK is unavailable") {
		super(message);
		this.name = "ClaudeAgentSdkUnavailableError";
	}
}

const CLAUDE_SDK_FIXED_TOKEN_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const CLAUDE_SDK_EFFORT_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_SDK_ALL_LEVELS: readonly ThinkingLevel[] = ["off", ...CLAUDE_SDK_FIXED_TOKEN_LEVELS];

export interface ClaudeAgentSdkModelInfo {
	value: string;
	resolvedModel?: string;
	supportsEffort?: boolean;
	supportedEffortLevels?: readonly string[];
	supportsAdaptiveThinking?: boolean;
}

/** A session-local SDK capability record. `wireValue` is the value Query.setModel accepts. */
export interface ClaudeAgentSdkModelCapability {
	id: string;
	wireValue: string;
	reasoning: boolean;
	thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>;
	effortLevels: readonly ThinkingLevel[];
	fixedTokenLevels: readonly ThinkingLevel[];
}

function isClaudeAgentSdkModelInfo(value: unknown): value is ClaudeAgentSdkModelInfo {
	return !!value && typeof value === "object" && typeof (value as ClaudeAgentSdkModelInfo).value === "string";
}


/**
 * Convert SDK model rows without relying on process-global model catalog state.
 * The explicit map prevents the generic Pi-family fallback from inventing levels
 * (notably `minimal`) that the SDK did not advertise.
 */
export function normalizeClaudeAgentSdkModelCapabilities(models: unknown): ClaudeAgentSdkModelCapability[] | undefined {
	if (!Array.isArray(models)) return undefined;
	return models.filter(isClaudeAgentSdkModelInfo).map((model) => {
		const effortLevels = model.supportsEffort === true
			? (model.supportedEffortLevels ?? []).filter((level): level is ThinkingLevel => (CLAUDE_SDK_EFFORT_LEVELS as readonly string[]).includes(level))
			: [];
		const fixedTokenLevels = model.supportsAdaptiveThinking === true
			? CLAUDE_SDK_FIXED_TOKEN_LEVELS.filter(level => !effortLevels.includes(level))
			: [];
		const reasoning = model.supportsEffort === true || model.supportsAdaptiveThinking === true;
		const supported = new Set<ThinkingLevel>(["off", ...effortLevels, ...fixedTokenLevels]);
		const thinkingLevelMap = Object.fromEntries(CLAUDE_SDK_ALL_LEVELS.map(level => [level, supported.has(level) ? level : null])) as Partial<Record<ThinkingLevel, string | null>>;
		return {
			id: model.resolvedModel || model.value,
			wireValue: model.value,
			reasoning,
			thinkingLevelMap,
			effortLevels,
			fixedTokenLevels,
		};
	});
}

/** Resolve SDK aliases and canonical resolved ids while preserving their SDK wire value. */
export function resolveClaudeAgentSdkModelCapability(
	capabilities: readonly ClaudeAgentSdkModelCapability[] | undefined,
	modelId: string | undefined,
): ClaudeAgentSdkModelCapability | undefined {
	if (!capabilities || !modelId) return undefined;
	return capabilities.find(capability => capability.id === modelId)
		?? capabilities.find(capability => capability.wireValue === modelId);
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
	private rows: Array<{ message: SDKUserMessage; resolve: () => void; reject: (error: Error) => void; clock: Clock; timer?: ReturnType<typeof setTimeout> }> = [];
	private reader?: { resolve: (result: IteratorResult<SDKUserMessage>) => void };
	private closed?: Error;

	push(message: SDKUserMessage, deadlineMs: number, clock: Clock): Promise<void> {
		if (this.closed) return Promise.reject(this.closed);
		return new Promise<void>((resolve, reject) => {
			const row = { message, resolve, reject, clock } as typeof this.rows[number];
			if (deadlineMs > 0) row.timer = clock.setTimeout(() => {
				const index = this.rows.indexOf(row);
				if (index >= 0) this.rows.splice(index, 1);
				reject(new Error("Claude Agent SDK input delivery timed out"));
			}, deadlineMs);
			this.rows.push(row);
			this.flush();
		});
	}

	private settle(row: typeof this.rows[number]): void {
		if (row.timer) row.clock.clearTimeout(row.timer);
		row.resolve();
	}

	private flush(): void {
		if (!this.reader || this.rows.length === 0) return;
		const reader = this.reader;
		this.reader = undefined;
		const row = this.rows.shift()!;
		this.settle(row);
		reader.resolve({ done: false, value: row.message });
	}

	fail(error: Error): void {
		if (this.closed) return;
		this.closed = error;
		for (const row of this.rows.splice(0)) {
			if (row.timer) row.clock.clearTimeout(row.timer);
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
					this.settle(row);
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
	return raw.replace(/(token|secret|key|authorization)\s*[:=]\s*[^\s,;]+/ig, "$1=<redacted>").slice(0, 500);
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return typeof (value as Promise<T>)?.then === "function";
}

function unsupported(error: string): { success: false; error: string } { return { success: false, error }; }

export class ClaudeAgentSdkBridge implements IRpcBridge {
	private readonly listeners = new Set<RpcEventListener>();
	private readonly abortController = new AbortController();
	private readonly input = new AsyncInputQueue();
	private readonly ready: Promise<void>;
	private readonly terminal: Promise<never>;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private rejectTerminal!: (error: Error) => void;
	private startPromise?: Promise<void>;
	private cleanupPromise?: Promise<void>;
	private queryHandle?: Query;
	private state: ClaudeAgentSdkState = "new";
	private terminalError?: Error;
	private closed = false;
	private initializedSessionId?: string;
	private modelId?: string;
	private thinkingLevel?: string;
	/** Undefined means an older SDK did not provide model data; [] means it did and no model is selectable. */
	private modelCapabilities?: ClaudeAgentSdkModelCapability[];
	private activeModelCapability?: ClaudeAgentSdkModelCapability;
	private translatorState: ClaudeSdkTranslatorState = createClaudeSdkTranslatorState();
	/** A locally-running turn becomes observable only after SDK input acceptance. */
	private pendingTurnStart?: symbol;
	private diagnosticsRemaining = 20;

	constructor(private readonly options: ClaudeAgentSdkBridgeOptions, private readonly deps: ClaudeAgentSdkBridgeDeps) {
		this.modelId = options.initialModel?.startsWith("claude-agent-sdk/") ? options.initialModel.slice("claude-agent-sdk/".length) : undefined;
		this.thinkingLevel = options.initialThinkingLevel;
		this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
		this.terminal = new Promise<never>((_, reject) => { this.rejectTerminal = reject; });
		// A failed start is normally observed through start(); retain waitForReady's rejection semantics without process-wide noise.
		void this.ready.catch(() => undefined);
		void this.terminal.catch(() => undefined);
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

	private async withinStartupWindow<T>(operation: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation,
				this.terminal,
				new Promise<never>((_, reject) => { timer = this.deps.clock.setTimeout(() => reject(new Error("Claude Agent SDK readiness timed out")), COLD_REPROMPT_READY_TIMEOUT_MS); }),
			]);
		} finally {
			if (timer) this.deps.clock.clearTimeout(timer);
		}
	}

	private async startInternal(): Promise<void> {
		this.state = "starting";
		try {
			// The SDK's default process launcher is host-local. Do not silently escape Bobbit's project container boundary.
			if (this.options.sandboxed || this.options.containerId) {
				throw new ClaudeAgentSdkUnavailableError("Claude Agent SDK sessions are not supported in Docker sandboxes");
			}
			const systemPrompt = this.options.systemPromptPath ? fs.readFileSync(this.options.systemPromptPath, "utf8") : undefined;
			const initialModel = this.options.initialModel?.startsWith("claude-agent-sdk/")
				? this.options.initialModel.slice("claude-agent-sdk/".length) : undefined;
			const sdkOptions: Options = {
				cwd: this.options.cwd,
				env: buildClaudeAgentSdkEnv(this.options),
				abortController: this.abortController,
				settingSources: [],
				tools: [],
				...(systemPrompt ? { systemPrompt } : {}),
				...(initialModel ? { model: initialModel } : {}),
				...(this.options.claudeAgentSdkSessionId ? { resume: this.options.claudeAgentSdkSessionId } : {}),
				...(this.options.onBeforeCompact ? { hooks: { PreCompact: [{ hooks: [async (input) => {
					const compact = input as import("@anthropic-ai/claude-agent-sdk").PreCompactHookInput;
					await this.options.onBeforeCompact?.({ summary: compact.custom_instructions ?? undefined });
					return {};
				}] }] } } : {}),
			};
			const query = this.deps.query({ prompt: this.input, options: sdkOptions });
			if (isPromise(query)) {
				// A loader that resolves after startup timed out must not leave a newly spawned query alive.
				void query.then((lateQuery) => {
					if (this.closed || this.state === "failed") {
						try { void Promise.resolve(lateQuery.close()).catch(() => undefined); } catch { /* terminal cleanup is best effort */ }
					}
				}, () => undefined);
			}
			this.queryHandle = isPromise(query) ? await this.withinStartupWindow(query) : query;
			void this.consume(this.queryHandle);
			const initialized = await this.withinStartupWindow(this.queryHandle.initializationResult());
			const sessionId = (initialized as { session_id?: unknown }).session_id;
			if (isClaudeAgentSdkSessionId(sessionId)) this.initializedSessionId = sessionId;
			await this.captureModelCapabilities(initialized);
			if (this.terminalError || this.closed) throw this.terminalError ?? new Error("Claude Agent SDK stopped during initialization");
			this.state = "ready";
			this.resolveReady();
		} catch (error) {
			this.fail(error);
			await this.cleanupTerminal();
			throw this.terminalError!;
		}
	}

	private async captureModelCapabilities(initialized: unknown): Promise<void> {
		const initializationModels = (initialized as { models?: unknown }).models;
		let models = initializationModels;
		const supportedModels = (this.queryHandle as unknown as { supportedModels?: () => Promise<unknown> } | undefined)?.supportedModels;
		if (supportedModels) {
			try {
				const discovered = await this.withinStartupWindow(supportedModels.call(this.queryHandle));
				if (Array.isArray(discovered)) models = discovered;
			} catch { /* SDKs that cannot refresh models still expose initialization models. */ }
		}
		this.modelCapabilities = normalizeClaudeAgentSdkModelCapabilities(models);
		// Keep the configured/requested identity for exact runtime read-back. The
		// capability resolver accepts canonical ids and SDK aliases, while wireValue
		// remains the only value sent to Query.setModel().
		this.activeModelCapability = resolveClaudeAgentSdkModelCapability(this.modelCapabilities, this.modelId);
	}

	private modelState(): Record<string, unknown> {
		const capability = this.activeModelCapability;
		return {
			provider: "claude-agent-sdk",
			id: this.modelId,
			reasoning: capability?.reasoning ?? false,
			thinkingLevelMap: capability?.thinkingLevelMap ?? { off: "off", minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
		};
	}

	private reportDiagnostics(diagnostics: readonly { code: string }[]): void {
		if (diagnostics.length === 0 || this.diagnosticsRemaining <= 0) return;
		this.diagnosticsRemaining--;
		console.warn("[claude-agent-sdk] translator diagnostics", {
			count: diagnostics.length,
			codes: [...new Set(diagnostics.map(diagnostic => diagnostic.code))],
		});
	}

	private async consume(query: Query): Promise<void> {
		try {
			for await (const sdkEvent of query) {
				if (this.closed || this.state === "failed") return;
				const sessionId = (sdkEvent as { session_id?: unknown }).session_id;
				if (isClaudeAgentSdkSessionId(sessionId)) this.initializedSessionId = sessionId;
				const translated = translateClaudeSdkEvent(this.translatorState, sdkEvent as unknown as Record<string, unknown>);
				this.reportDiagnostics(translated.diagnostics);
				// A synchronous SDK turn can emit its terminal result before the input
				// push continuation runs. The translated event proves the input was
				// accepted; publish its start before every event in that turn.
				if (translated.events.length > 0) this.emitPendingTurnStart();
				for (const event of translated.events) this.emit(event);
				const rootTurnEnd = translated.events.some(event => event.type === "agent_end" && event.parentToolUseId === undefined);
				this.translatorState = rootTurnEnd ? createClaudeSdkTranslatorState() : translated.state;
				if (rootTurnEnd && this.state === "running") this.state = "ready";
			}
			if (!this.closed && this.state === "starting") this.fail(new Error("Claude Agent SDK ended before initialization"));
		} catch (error) {
			if (!this.closed) this.fail(error);
		}
	}

	private emitPendingTurnStart(turn = this.pendingTurnStart): void {
		if (!turn || this.pendingTurnStart !== turn) return;
		this.pendingTurnStart = undefined;
		this.emit({ type: "agent_start" });
	}

	private clearPendingTurnStart(turn?: symbol): void {
		if (!turn || this.pendingTurnStart === turn) this.pendingTurnStart = undefined;
	}

	private cleanupTerminal(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;
		this.clearPendingTurnStart();
		this.input.fail(this.terminalError ?? new Error("Claude Agent SDK bridge stopped"));
		this.abortController.abort();
		this.cleanupPromise = Promise.resolve()
			.then(() => this.queryHandle?.close())
			.catch(() => undefined)
			.then(() => undefined);
		return this.cleanupPromise;
	}

	private fail(error: unknown): void {
		if (this.state === "failed" || this.state === "stopped") return;
		const wrapped = error instanceof ClaudeAgentSdkUnavailableError ? error : new ClaudeAgentSdkUnavailableError(errorMessage(error));
		this.terminalError = wrapped;
		this.state = "failed";
		this.rejectTerminal(wrapped);
		this.input.fail(wrapped);
		this.rejectReady(wrapped);
		void this.cleanupTerminal();
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
		// Mark bridge-local state before exposing the input: the SDK may complete a
		// turn synchronously while pulling it. Its public start remains pending until
		// delivery succeeds (or a translated event proves delivery), so an unpulled
		// timeout/stop/failure cannot advance SessionManager's acceptance fence.
		const turn = this.state === "ready" ? Symbol("claude-sdk-turn") : undefined;
		if (turn) {
			this.state = "running";
			this.pendingTurnStart = turn;
		}
		try {
			await this.input.push(message, timeoutMs, this.deps.clock);
			if (turn) this.emitPendingTurnStart(turn);
		} catch (error) {
			if (turn && this.pendingTurnStart === turn) {
				this.clearPendingTurnStart(turn);
				// Do not resurrect terminal or interrupting states while undoing an
				// input that the SDK never pulled.
				if (this.state === "running") this.state = "ready";
			}
			throw error;
		}
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
		if (this.state === "failed" || this.state === "stopped") return unsupported(this.terminalError?.message ?? "Claude Agent SDK bridge stopped");
		if (!this.queryHandle) return unsupported("Claude Agent SDK query is not running");
		const previous = this.state;
		if (previous === "ready" || previous === "running") this.state = "interrupting";
		try { return await this.queryHandle.interrupt(); }
		finally {
			if (this.state === "interrupting" && !this.terminalError && !this.closed) this.state = "ready";
		}
	}
	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.state = "stopped";
		this.terminalError ??= new Error("Claude Agent SDK bridge stopped");
		this.rejectTerminal(this.terminalError);
		this.rejectReady(this.terminalError);
		await this.cleanupTerminal();
		this.listeners.clear();
	}
	async getState(): Promise<any> {
		return { success: true, data: {
			provider: "claude-agent-sdk",
			model: this.modelState(),
			thinkingLevel: this.thinkingLevel,
			sessionId: this.initializedSessionId,
		} };
	}
	async getMessages(): Promise<any> { return unsupported("Claude Agent SDK does not expose a transcript snapshot"); }
	async sendCommand(): Promise<any> { return unsupported("Claude Agent SDK does not support Pi RPC commands"); }
	async setModel(provider: string, modelId: string): Promise<any> {
		if (provider !== "claude-agent-sdk") return unsupported("Switching runtimes requires a new session");
		if (!this.queryHandle) return unsupported("Claude Agent SDK query is not running");
		const capability = resolveClaudeAgentSdkModelCapability(this.modelCapabilities, modelId);
		if (this.modelCapabilities && !capability) return unsupported(`Unsupported Claude Agent SDK model: ${modelId}`);
		await this.queryHandle.setModel(capability?.wireValue ?? modelId);
		// Do not let an SDK failure mutate the tuple the runtime selector reads back.
		// `modelId` remains public so aliases round-trip exactly; capability.id is
		// only for resolving SDK metadata and capability.wireValue is SDK-private.
		this.activeModelCapability = capability;
		this.modelId = modelId;
		return { success: true };
	}
	async setThinkingLevel(level: string): Promise<any> {
		if (!this.queryHandle) return unsupported("Claude Agent SDK query is not running");
		const capability = this.activeModelCapability;
		const budget = thinkingBudgetForLevel(level);
		if (budget === undefined) return unsupported(`Unsupported thinking level: ${level}`);
		if (level !== "off" && (!capability || (!capability.effortLevels.includes(level as ThinkingLevel) && !capability.fixedTokenLevels.includes(level as ThinkingLevel)))) {
			return unsupported(`Unsupported thinking level for ${this.modelId ?? "current model"}: ${level}`);
		}
		const usesEffort = capability?.effortLevels.includes(level as ThinkingLevel) === true;
		// The SDK merges flag settings, so clear a prior effort before selecting a
		// fixed budget or off. Likewise clear a prior fixed budget before effort.
		// This is intentionally unconditional: a model switch may have left the
		// other family active even when the newly selected model does not advertise it.
		if (!usesEffort) {
			await this.queryHandle.applyFlagSettings({ effortLevel: null });
			await this.queryHandle.setMaxThinkingTokens(level === "off" ? null : budget!);
		} else {
			await this.queryHandle.setMaxThinkingTokens(null);
			await this.queryHandle.applyFlagSettings({ effortLevel: level as "low" | "medium" | "high" | "xhigh" | "max" });
		}
		// Do not let an SDK failure mutate the tuple the runtime selector reads back.
		this.thinkingLevel = level;
		return { success: true };
	}
	async compact(): Promise<any> { return unsupported("Claude Agent SDK does not expose manual compaction"); }
}

let sdkModulePromise: Promise<typeof import("@anthropic-ai/claude-agent-sdk")> | undefined;
function loadSdkQuery(input: Parameters<typeof sdkQuery>[0]): Promise<ReturnType<typeof sdkQuery>> {
	sdkModulePromise ??= import("@anthropic-ai/claude-agent-sdk");
	return sdkModulePromise.then(sdk => sdk.query(input));
}

/** Production dependency seam; importing Pi runtime does not load the optional SDK bundle. */
export const defaultClaudeAgentSdkBridgeDeps: ClaudeAgentSdkBridgeDeps = {
	query: loadSdkQuery,
	clock: realClock,
};
