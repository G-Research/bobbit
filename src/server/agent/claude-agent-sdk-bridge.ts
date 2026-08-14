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
import { ClaudeSdkSubagentWorkAssembler, recoverClaudeSdkEmbeddedWork } from "./claude-sdk-subagent-work.js";
import type { ThinkingLevel } from "../../shared/thinking-levels.js";
import { adaptSdkSessionMessages } from "./claude-agent-sdk-history-adapter.js";
import { defaultClaudeAgentSdkSessionAccessDeps, type ClaudeAgentSdkSessionAccessDeps } from "./claude-agent-sdk-session-access.js";
import { ClaudeAgentSdkUnavailableError, normalizeClaudeAgentSdkUnavailableError } from "./claude-agent-sdk-error.js";
import { buildClaudeAgentSdkQueryOptions, buildEmptyClaudeSdkToolSurface, normalizeClaudeSdkMcpToolName, type ClaudeSdkToolSurface } from "./claude-agent-sdk-tool-surface.js";
import { CLAUDE_AGENT_SDK_DOCKER_HOME, createClaudeSdkDockerSpawn, isSandboxContainerCwd, type ClaudeSdkDockerSpawn } from "./docker-exec-spawn.js";

import type { Options, Query, SDKUserMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

type QueryFactory = (input: Parameters<typeof sdkQuery>[0]) => ReturnType<typeof sdkQuery> | Promise<ReturnType<typeof sdkQuery>>;

export type ClaudeAgentSdkState = "new" | "starting" | "ready" | "running" | "interrupting" | "failed" | "stopped";

/** Ephemeral, SDK-only sandbox launch authority. Never persist or reuse for Pi. */
export interface ClaudeAgentSdkSandboxLaunch {
	containerId: string;
	cwd: string;
	sessionId: string;
	sessionSecret?: string;
	goalId?: string;
	gatewayToken: string;
	gatewayUrl: string;
	oauthAccessToken: string;
}

/** Ephemeral direct SDK authority; its private config root belongs to the Bobbit session. */
export interface ClaudeAgentSdkDirectLaunch {
	sessionId: string;
	configDir: string;
	oauthAccessToken: string;
}

/** A provider-owned compaction boundary for the SessionManager coordinator. */
export interface ClaudeSdkPreCompactObservation {
	readonly source: "claude-agent-sdk";
	readonly trigger?: string;
	/** SDK custom instructions are a provider summary, not the lost transcript span. */
	readonly summary?: string;
}

export interface ClaudeAgentSdkBridgeOptions extends RpcBridgeOptions {
	runtime: "claude-agent-sdk";
	/** Created after sandbox setup; contains only the current per-process OAuth access token. */
	claudeSdkSandboxLaunch?: ClaudeAgentSdkSandboxLaunch;
	/** Created through Bobbit's OAuth resolver for a direct SDK process only. */
	claudeSdkDirectLaunch?: ClaudeAgentSdkDirectLaunch;
	claudeAgentSdkSessionId?: string;
	onBeforeCompact?: (input: ClaudeSdkPreCompactObservation) => Promise<void>;
	/** Session-local Bobbit MCP surface. Direct bridge tests receive an equally strict empty surface. */
	claudeSdkToolSurface?: ClaudeSdkToolSurface;
}

export interface ClaudeAgentSdkBridgeDeps {
	/** May be asynchronous so the production SDK is not imported until an SDK session starts. */
	query: QueryFactory;
	clock: Clock;
	/** Optional deterministic seam for SDK-owned transcript access. */
	sessionAccess?: ClaudeAgentSdkSessionAccessDeps;
	/** Narrow test seam; production uses the shared Docker-exec adapter. */
	createDockerSpawn?: (input: ClaudeSdkDockerSpawn) => ReturnType<typeof createClaudeSdkDockerSpawn>;
}

export { ClaudeAgentSdkUnavailableError } from "./claude-agent-sdk-error.js";

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
 * credentials wholesale. Production direct and sandbox sessions receive only a
 * current Bobbit OAuth access token and a Bobbit-owned private config root.
 */
export function buildClaudeAgentSdkEnv(options: Pick<ClaudeAgentSdkBridgeOptions, "env" | "claudeSdkSandboxLaunch" | "claudeSdkDirectLaunch">): Record<string, string> {
	const launch = options.claudeSdkSandboxLaunch;
	const directLaunch = options.claudeSdkDirectLaunch;
	if (launch) {
		// A closed container environment: do not inherit host config or credentials.
		return {
			HOME: CLAUDE_AGENT_SDK_DOCKER_HOME,
			PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			TMPDIR: "/tmp",
			LANG: "C.UTF-8",
			BOBBIT_SESSION_ID: launch.sessionId,
			...(launch.sessionSecret ? { BOBBIT_SESSION_SECRET: launch.sessionSecret } : {}),
			CLAUDE_CONFIG_DIR: `/bobbit-state/claude-agent-sdk/${launch.sessionId}`,
			CLAUDE_AGENT_SDK_CLIENT_APP: "bobbit",
			// Keep foreground helpers bounded to one level in the container too.
			CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
		};
	}
	if (directLaunch) {
		// Never consult the native Claude CLI config. The config root is durable for
		// this Bobbit session, while the access token exists only in this child env.
		return {
			HOME: directLaunch.configDir,
			PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
			TMPDIR: process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp",
			LANG: process.env.LANG || "C.UTF-8",
			BOBBIT_SESSION_ID: directLaunch.sessionId,
			CLAUDE_CONFIG_DIR: directLaunch.configDir,
			CLAUDE_CODE_OAUTH_TOKEN: directLaunch.oauthAccessToken,
			CLAUDE_AGENT_SDK_CLIENT_APP: "bobbit",
			CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
		};
	}
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

function boundedString(value: unknown, maxLength = 2_000): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
	return typeof (value as Promise<T>)?.then === "function";
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
	return { promise, resolve, reject };
}

function unsupported(error: string): { success: false; error: string } { return { success: false, error }; }

export class ClaudeAgentSdkBridge implements IRpcBridge {
	private readonly listeners = new Set<RpcEventListener>();
	private readonly abortController = new AbortController();
	private readonly input = new AsyncInputQueue();
	private readonly ready: Promise<void>;
	/** The official Query initialization result has controls, not the resume UUID.
	 * The UUID is authoritative only on the streamed `system:init` event. */
	private readonly initializationIdentity = deferred<string>();
	private identityObserved = false;
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
	/** A generation prevents a disposed/replaced policy surface from publishing stale child work. */
	private subagentLifecycleGeneration = 0;
	private subagentLifecycleUnsubscribe?: () => void;
	private activeToolSurface?: ClaudeSdkToolSurface;
	/** Surface allocation precedes hook attachment; retain it so early startup
	 * failures still dispose the G9 dispatcher exactly once. */
	private allocatedToolSurface?: ClaudeSdkToolSurface;
	private subagentWork = new ClaudeSdkSubagentWorkAssembler();
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
		void this.initializationIdentity.promise.catch(() => undefined);
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
			if (this.options.args?.some(arg => arg === "--extension" || arg.startsWith("--extension="))) {
				throw new ClaudeAgentSdkUnavailableError("Claude Agent SDK does not accept extension arguments");
			}
			const sandboxLaunch = this.options.claudeSdkSandboxLaunch;
			const directLaunch = this.options.claudeSdkDirectLaunch;
			if ((this.options.sandboxed || this.options.containerId) && !sandboxLaunch) {
				throw new ClaudeAgentSdkUnavailableError("CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE: Docker sandbox launch is unavailable; rebuild the Docker sandbox image and retry");
			}
			if (sandboxLaunch && (!sandboxLaunch.containerId || !sandboxLaunch.oauthAccessToken || !sandboxLaunch.gatewayToken || !sandboxLaunch.gatewayUrl || !isSandboxContainerCwd(sandboxLaunch.cwd))) {
				throw new ClaudeAgentSdkUnavailableError("CLAUDE_AGENT_SDK_SANDBOX_UNAVAILABLE: Docker sandbox launch is invalid; rebuild the Docker sandbox image and retry");
			}
			if (!sandboxLaunch && this.options.env?.BOBBIT_SESSION_ID && (!directLaunch || !directLaunch.sessionId || !directLaunch.configDir || !directLaunch.oauthAccessToken)) {
				throw new ClaudeAgentSdkUnavailableError("CLAUDE_AGENT_SDK_AUTH_UNAVAILABLE: connect Anthropic OAuth in Bobbit and retry");
			}
			const systemPrompt = this.options.systemPromptPath ? fs.readFileSync(this.options.systemPromptPath, "utf8") : undefined;
			const initialModel = this.options.initialModel?.startsWith("claude-agent-sdk/")
				? this.options.initialModel.slice("claude-agent-sdk/".length) : undefined;
			const preCompact = this.options.onBeforeCompact ? [{ hooks: [async (input: unknown) => {
				const compact = input as import("@anthropic-ai/claude-agent-sdk").PreCompactHookInput;
				// This is a provider-owned checkpoint observation. The callback's
				// coordinator decides persistence/refresh; do not emit Pi compaction
				// completion events merely because the SDK is about to compact.
				const trigger = boundedString((compact as { trigger?: unknown }).trigger, 120);
				const summary = boundedString(compact.custom_instructions);
				await this.options.onBeforeCompact?.({
					source: "claude-agent-sdk",
					...(trigger ? { trigger } : {}),
					...(summary ? { summary } : {}),
				});
				return {};
			}] }] : undefined;
			// Both production paths use a Bobbit-owned config root. Query options below
			// independently prohibit settings, plugins, MCP, and memory leakage.
			const env = buildClaudeAgentSdkEnv(this.options);
			if (this.abortController.signal.aborted || this.closed) throw new Error("Claude Agent SDK startup cancelled");
			// Bounded SDK definitions plus this process-local depth ceiling prevent
			// approved foreground helpers from creating grandchildren.
			env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "1";
			const sdkBase = {
				cwd: sandboxLaunch?.cwd ?? this.options.cwd,
				env,
				abortController: this.abortController,
				...(sandboxLaunch ? { spawnClaudeCodeProcess: (this.deps.createDockerSpawn ?? createClaudeSdkDockerSpawn)({
					containerId: sandboxLaunch.containerId,
					cwd: sandboxLaunch.cwd,
					// Docker does not inherit the SDK replacement environment. Forward the
					// complete closed allowlist, then add only this exec's authority.
					env: {
						...env,
						BOBBIT_GOAL_ID: sandboxLaunch.goalId,
						BOBBIT_TOKEN: sandboxLaunch.gatewayToken,
						BOBBIT_GATEWAY_URL: sandboxLaunch.gatewayUrl,
						CLAUDE_CODE_OAUTH_TOKEN: sandboxLaunch.oauthAccessToken,
					},
					command: ["/usr/local/bin/bobbit-claude-agent-sdk"],
					logPrefix: "claude-agent-sdk",
				}) } : {}),
				...(systemPrompt ? { systemPrompt } : {}),
				...(initialModel ? { model: initialModel } : {}),
				...(this.options.claudeAgentSdkSessionId ? { resume: this.options.claudeAgentSdkSessionId } : {}),
			};
			// Direct bridge construction is retained only through an equally strict,
			// explicit empty Bobbit surface; never let the SDK load its defaults.
			const surface = this.options.claudeSdkToolSurface ?? buildEmptyClaudeSdkToolSurface(this.options.claudeAgentSdkSessionId ?? "direct-bridge");
			this.allocatedToolSurface = surface;
			this.attachSubagentLifecycle(surface);
			const sdkOptions: Options = buildClaudeAgentSdkQueryOptions(surface, sdkBase, preCompact);

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
			// The streamed init and initializationResult are independently ordered by
			// the SDK. Require both: controls from initializationResult and a validated
			// resume identity from system:init. Never read identity from the result.
			const [initialized] = await this.withinStartupWindow(Promise.all([
				this.queryHandle.initializationResult(),
				this.initializationIdentity.promise,
			]));
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

	private canonicalizeToolNames(events: readonly any[]): readonly any[] {
		const surface = this.options.claudeSdkToolSurface;
		if (!surface) return events;
		const canonical = (name: unknown) => normalizeClaudeSdkMcpToolName(name, surface.entriesBySdkRawLower)?.canonicalName ?? name;
		return events.map((event) => {
			const toolName = canonical(event.toolName);
			const content = event.message?.content;
			const message = Array.isArray(content) ? {
				...event.message,
				...(event.message?.toolName ? { toolName: canonical(event.message.toolName) } : {}),
				content: content.map((block: any) => block?.type === "toolCall" ? { ...block, name: canonical(block.name) } : block),
			} : event.message;
			return toolName === event.toolName && message === event.message ? event : { ...event, ...(toolName !== event.toolName ? { toolName } : {}), ...(message !== event.message ? { message } : {}) };
		});
	}

	private reportDiagnostics(diagnostics: readonly { code: string }[]): void {
		if (diagnostics.length === 0 || this.diagnosticsRemaining <= 0) return;
		this.diagnosticsRemaining--;
		console.warn("[claude-agent-sdk] translator diagnostics", {
			count: diagnostics.length,
			codes: [...new Set(diagnostics.map(diagnostic => diagnostic.code))],
		});
	}

	private emitSubagentWork(frames: readonly any[]): void {
		for (const frame of frames) this.emit(frame);
	}

	/** Provider error bodies may contain credentials or local paths. Never put them on a UI-bound frame. */
	private static readonly SUBAGENT_FAILURE_DETAIL = "Subagent failed";

	/** Preserve the raw child source identity only inside the semantic projection. */
	private subagentProjectionEvent(event: any, source: Record<string, unknown>): Record<string, unknown> {
		const sourceId = typeof source.uuid === "string" ? source.uuid : undefined;
		const agentId = typeof source.parent_agent_id === "string" ? source.parent_agent_id : undefined;
		const message = event.message && typeof event.message === "object" && agentId
			? { ...event.message, parentAgentId: agentId } : event.message;
		// Translator terminal rows intentionally remain root-lifecycle-neutral.
		// Keep only a stable terminal state and public failure detail: SDK errors
		// are provider-controlled and can include credentials or private paths.
		const sourceError = typeof source.error === "string" && source.error.length > 0;
		const failed = source.is_error === true || sourceError || /^error/.test(String(source.subtype ?? ""));
		const terminal = event.type === "agent_end"
			? {
				terminalReason: source.aborted === true ? "aborted" : failed ? "error" : "completed",
				...(failed ? { error: ClaudeAgentSdkBridge.SUBAGENT_FAILURE_DETAIL } : {}),
			}
			: undefined;
		return {
			...event,
			...(sourceId ? { sourceId } : {}),
			...(agentId ? { agentId } : {}),
			...(message !== event.message ? { message } : {}),
			...(terminal ? { claudeSdk: { ...(event.claudeSdk ?? {}), terminal } } : {}),
		};
	}

	/** Child terminal results are intentionally not root `agent_end` events in the
	 * translator. Project them only into the already-admitted child partition. */
	private emitSubagentTerminalFromSource(source: Record<string, unknown>): void {
		const parentToolUseId = typeof source.parent_tool_use_id === "string" && source.parent_tool_use_id ? source.parent_tool_use_id : undefined;
		const type = source.type;
		const terminal = type === "result" || (type === "assistant" && (source.aborted === true || typeof source.error === "string"));
		if (!parentToolUseId || !terminal) return;
		const agentId = typeof source.parent_agent_id === "string" && source.parent_agent_id ? source.parent_agent_id : undefined;
		const sourceError = typeof source.error === "string" && source.error.length > 0;
		const phase = source.aborted === true ? "aborted"
			: source.is_error === true || sourceError || /^error/.test(String(source.subtype ?? "")) ? "error"
			: "completed";
		this.emitSubagentWork(this.subagentWork.ingestTerminal(
			parentToolUseId,
			{ phase, ...(phase === "error" ? { error: ClaudeAgentSdkBridge.SUBAGENT_FAILURE_DETAIL } : {}) },
			agentId ? { parentToolUseId, agentId } : undefined,
		));
	}

	private attachSubagentLifecycle(surface: ClaudeSdkToolSurface): void {
		this.releaseSubagentLifecycle();
		this.activeToolSurface = surface;
		this.subagentWork = new ClaudeSdkSubagentWorkAssembler();
		const generation = ++this.subagentLifecycleGeneration;
		this.subagentLifecycleUnsubscribe = surface.subagentPolicy?.subscribe((event) => {
			if (generation !== this.subagentLifecycleGeneration) return;
			this.emitSubagentWork(this.subagentWork.ingestLifecycle(event));
		});
	}

	/** Abort live entries while subscribed, then sever the generation before disposal. */
	private releaseSubagentLifecycle(): void {
		const surface = this.activeToolSurface;
		if (!surface) return;
		// Clear while subscribed so every active entry becomes an embedded aborted
		// terminal before a stale generation is detached.
		surface.subagentPolicy?.clear();
		this.subagentLifecycleUnsubscribe?.();
		this.subagentLifecycleUnsubscribe = undefined;
		this.activeToolSurface = undefined;
		this.subagentLifecycleGeneration++;
	}

	private observeInitializationIdentity(sdkEvent: unknown): void {
		const event = sdkEvent as { type?: unknown; subtype?: unknown; session_id?: unknown };
		if (event.type !== "system" || event.subtype !== "init") return;
		if (this.identityObserved) {
			// The SDK contract emits exactly one init. A second event could otherwise
			// replace the durable identity after readiness.
			this.fail(new ClaudeAgentSdkUnavailableError("Claude Agent SDK emitted duplicate initialization identity"));
			return;
		}
		this.identityObserved = true;
		if (!isClaudeAgentSdkSessionId(event.session_id)) {
			// Never include provider-controlled identity data in an exposed error.
			this.fail(new ClaudeAgentSdkUnavailableError("Claude Agent SDK did not provide a valid resumable session id"));
			return;
		}
		this.initializedSessionId = event.session_id;
		this.initializationIdentity.resolve(event.session_id);
	}

	private async consume(query: Query): Promise<void> {
		try {
			for await (const sdkEvent of query) {
				if (this.closed || this.state === "failed") return;
				this.observeInitializationIdentity(sdkEvent);
				if (this.closed || this.state === "failed") return;
				const translated = translateClaudeSdkEvent(this.translatorState, sdkEvent as unknown as Record<string, unknown>);
				this.reportDiagnostics(translated.diagnostics);
				const events = this.canonicalizeToolNames(translated.events);
				// A synchronous SDK turn can emit its terminal result before the input
				// push continuation runs. The translated event proves the input was
				// accepted; publish its start before every event in that turn.
				if (events.length > 0) this.emitPendingTurnStart();
				for (const event of events) {
					// The translator already owns partition ordering. A child partition is
					// never emitted as a root transcript/lifecycle event.
					if (event.parentToolUseId !== undefined) {
						this.emitSubagentWork(this.subagentWork.ingestLiveEvent(this.subagentProjectionEvent(event, sdkEvent as Record<string, unknown>)));
					} else this.emit(event);
				}
				this.emitSubagentTerminalFromSource(sdkEvent as Record<string, unknown>);
				const rootTurnEnd = events.some(event => event.type === "agent_end" && event.parentToolUseId === undefined);
				this.translatorState = rootTurnEnd ? createClaudeSdkTranslatorState() : translated.state;
				if (rootTurnEnd) this.activeToolSurface?.subagentPolicy?.clear();
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
		// This publishes an aborted terminal exactly once for each still-live
		// admitted child before the policy observer is unsubscribed/disposed.
		const surface = this.activeToolSurface ?? this.allocatedToolSurface ?? this.options.claudeSdkToolSurface;
		this.releaseSubagentLifecycle();
		this.cleanupPromise = Promise.resolve()
			.then(() => this.queryHandle?.close())
			.catch(() => undefined)
			.then(() => surface?.dispose?.())
			.catch(() => undefined)
			.then(() => {
				if (this.allocatedToolSurface === surface) this.allocatedToolSurface = undefined;
			})
			.catch(() => undefined)
			.then(() => undefined);
		return this.cleanupPromise;
	}

	private fail(error: unknown): void {
		if (this.state === "failed" || this.state === "stopped") return;
		const wrapped = normalizeClaudeAgentSdkUnavailableError(error);
		this.terminalError = wrapped;
		this.state = "failed";
		this.rejectTerminal(wrapped);
		this.initializationIdentity.reject(wrapped);
		this.input.fail(wrapped);
		this.rejectReady(wrapped);
		void this.cleanupTerminal();
		this.emit({ type: "process_exit", code: 1, error: wrapped.message });
	}

	async waitForReady(overallTimeoutMs = COLD_REPROMPT_READY_TIMEOUT_MS): Promise<void> {
		if (this.state === "failed" || this.state === "stopped") throw this.terminalError ?? new Error("Claude Agent SDK bridge stopped");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			// This deadline belongs only to this caller. `startInternal()` owns the
			// terminal startup deadline, so a short-lived steer must not poison a
			// still-viable cold query for other callers.
			await Promise.race([this.ready, new Promise<void>((_, reject) => {
				timer = this.deps.clock.setTimeout(
					() => reject(new ClaudeAgentSdkUnavailableError("Claude Agent SDK unavailable: readiness timed out")),
					overallTimeoutMs,
				);
			})]);
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
		this.initializationIdentity.reject(this.terminalError);
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
	async getMessages(): Promise<any> {
		if (!isClaudeAgentSdkSessionId(this.initializedSessionId)) {
			return unsupported("SDK_SESSION_UNAVAILABLE: Claude Agent SDK has no valid resumable session id");
		}
		try {
			// Keep the optional SDK bundle lazy for Pi-only gateway processes. The
			// official SDK session store remains the only transcript authority.
			const { readSdkSessionMessages } = await import("./claude-agent-sdk-session-access.js");
			const messages = await readSdkSessionMessages({
				sessionId: this.initializedSessionId,
				cwd: this.options.cwd,
			}, this.deps.sessionAccess);
			const adapted = adaptSdkSessionMessages(messages);
			// Official history may omit archived child rows. Recovery is bounded by
			// real root Agent/Task IDs and still rejects agent-id-only joins.
			const recovered = await recoverClaudeSdkEmbeddedWork(adapted, {
				sessionId: this.initializedSessionId,
				cwd: this.options.cwd,
				access: this.deps.sessionAccess ?? defaultClaudeAgentSdkSessionAccessDeps,
			});
			return { success: true, data: recovered };
		} catch (error) {
			return unsupported(normalizeClaudeAgentSdkUnavailableError(error).message);
		}
	}
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
		// Old SDKs expose token controls but not flag settings. They can still clear
		// thinking; advertised effort must remain unavailable rather than emulated.
		const applyFlagSettings = typeof this.queryHandle.applyFlagSettings === "function"
			? this.queryHandle.applyFlagSettings.bind(this.queryHandle)
			: undefined;
		if (usesEffort && !applyFlagSettings) {
			return unsupported("Claude Agent SDK does not support advertised effort controls");
		}
		// The SDK merges flag settings, so clear a prior effort before selecting a
		// fixed budget or off when the API is available. Likewise clear a prior fixed
		// budget before effort. A model switch may have left the other family active.
		if (!usesEffort) {
			if (applyFlagSettings) await applyFlagSettings({ effortLevel: null });
			await this.queryHandle.setMaxThinkingTokens(level === "off" ? null : budget!);
		} else {
			await this.queryHandle.setMaxThinkingTokens(null);
			await applyFlagSettings!({ effortLevel: level as "low" | "medium" | "high" | "xhigh" | "max" });
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
