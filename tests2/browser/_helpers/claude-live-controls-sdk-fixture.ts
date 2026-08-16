type SdkQueryArgs = { prompt: AsyncIterable<unknown>; options: Record<string, unknown> };

type SdkModel = {
	value: string;
	resolvedModel: string;
	supportsEffort: boolean;
	supportedEffortLevels: string[];
};

/** These are the built-in stable SDK aliases, never custom-provider rows. */
export const CLAUDE_LIVE_MODELS = {
	sonnet: { value: "sonnet", resolvedModel: "sonnet", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
	haiku: { value: "haiku", resolvedModel: "haiku", supportsEffort: true, supportedEffortLevels: ["low", "medium"] },
	opus: { value: "opus", resolvedModel: "opus", supportsEffort: true, supportedEffortLevels: ["medium"] },
} as const satisfies Record<string, SdkModel>;

export const PACED_ROOT_PROMPT = "Stream the deterministic Claude SDK root response";
export const PACED_ROOT_PARTIAL = "PACED_ROOT_PARTIAL";
export const PACED_ROOT_RESPONSE = "PACED_ROOT_PARTIAL completes exactly once.";

const SDK_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_STREAM_ID = "paced-root-assistant";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A deterministic official-Query-shaped fake. The gateway still constructs the
 * production ClaudeAgentSdkBridge; only its SDK and official-history dependencies
 * are replaced, so this remains OAuth-free.
 */
class LiveControlsQuery implements AsyncIterable<unknown> {
	readonly setModels: string[] = [];
	readonly effortSettings: Array<{ effortLevel?: string | null }> = [];
	readonly thinkingBudgets: Array<number | null> = [];
	private closed = false;
	private initialized = false;
	private reader?: (result: IteratorResult<unknown>) => void;
	private queued: unknown[] = [];
	private streamedRoot = false;

	constructor(readonly args: SdkQueryArgs, private readonly history: Record<string, unknown>[]) {
		// The official SDK pulls the prompt stream before bridge-side capability
		// initialization settles. Consume every input as a real SDK Query does.
		void this.consumePrompts();
	}

	private async consumePrompts(): Promise<void> {
		for await (const prompt of this.args.prompt) {
			const text = (prompt as { message?: { content?: unknown } })?.message?.content;
			this.history.push({
				type: "user", uuid: `paced-root-user-${this.history.length}`, session_id: SDK_SESSION_ID,
				message: { content: typeof text === "string" ? text : "" },
			});
			if (!this.streamedRoot) {
				this.streamedRoot = true;
				await this.emitPacedRootStream();
			} else {
				this.emit({ type: "result", subtype: "success", result: "OK" });
			}
		}
	}

	private async emitPacedRootStream(): Promise<void> {
		const start = { id: ROOT_STREAM_ID, role: "assistant", content: [] };
		this.emit({ type: "stream_event", uuid: ROOT_STREAM_ID, session_id: SDK_SESSION_ID, event: { type: "message_start", message: start } });
		this.emit({ type: "stream_event", uuid: ROOT_STREAM_ID, session_id: SDK_SESSION_ID, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: PACED_ROOT_PARTIAL } } });
		await sleep(150);
		this.emit({ type: "stream_event", uuid: ROOT_STREAM_ID, session_id: SDK_SESSION_ID, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " completes" } } });
		await sleep(150);
		this.emit({ type: "stream_event", uuid: ROOT_STREAM_ID, session_id: SDK_SESSION_ID, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " exactly once." } } });
		this.emit({ type: "stream_event", uuid: ROOT_STREAM_ID, session_id: SDK_SESSION_ID, event: { type: "content_block_stop", index: 0 } });
		this.emit({ type: "stream_event", uuid: ROOT_STREAM_ID, session_id: SDK_SESSION_ID, event: { type: "message_stop" } });
		const final = {
			type: "assistant", uuid: ROOT_STREAM_ID, session_id: SDK_SESSION_ID,
			message: { id: ROOT_STREAM_ID, content: [{ type: "text", text: PACED_ROOT_RESPONSE }], stop_reason: "end_turn" },
		};
		this.history.push(final);
		this.emit(final);
		this.emit({ type: "result", subtype: "success", result: PACED_ROOT_RESPONSE });
	}

	async initializationResult(): Promise<{ models: SdkModel[] }> {
		return { models: Object.values(CLAUDE_LIVE_MODELS) };
	}

	supportedModels(): SdkModel[] {
		return Object.values(CLAUDE_LIVE_MODELS);
	}

	async setModel(model: string): Promise<void> {
		this.setModels.push(model);
		if (model === CLAUDE_LIVE_MODELS.opus.value) throw new Error("deterministic SDK setModel failure");
	}

	async applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> {
		this.effortSettings.push(settings);
	}

	async setMaxThinkingTokens(tokens: number | null): Promise<void> {
		this.thinkingBudgets.push(tokens);
	}

	async interrupt(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
		this.reader?.({ done: true, value: undefined });
		this.reader = undefined;
	}

	private emit(value: unknown): void {
		const reader = this.reader;
		if (reader) {
			this.reader = undefined;
			reader({ done: false, value });
		} else this.queued.push(value);
	}

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => {
				if (!this.initialized) {
					this.initialized = true;
					return Promise.resolve({ done: false, value: { type: "system", subtype: "init", session_id: SDK_SESSION_ID } });
				}
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				const next = this.queued.shift();
				if (next !== undefined) return Promise.resolve({ done: false, value: next });
				return new Promise<IteratorResult<unknown>>(resolve => { this.reader = resolve; });
			},
		};
	}
}

class LiveControlsSdk {
	readonly queries: LiveControlsQuery[] = [];
	readonly history: Record<string, unknown>[] = [];
	private nativeSdkLoadCalls = 0;

	reset(): void {
		this.queries.length = 0;
		this.history.length = 0;
		this.nativeSdkLoadCalls = 0;
	}

	get nativeSdkLoads(): number { return this.nativeSdkLoadCalls; }

	readonly depsFactory = () => ({
		query: ((args: SdkQueryArgs) => {
			const query = new LiveControlsQuery(args, this.history);
			this.queries.push(query);
			return query;
		}) as any,
		sessionAccess: {
			directSdk: {
				getSessionInfo: async (sessionId: string) => sessionId === SDK_SESSION_ID
					? { sessionId: SDK_SESSION_ID, summary: "paced root stream fixture", lastModified: this.history.length }
					: undefined,
				getSessionMessages: async (sessionId: string) => sessionId === SDK_SESSION_ID ? this.history.map(row => ({ ...row })) : [],
				listSubagents: async () => [],
				getSubagentMessages: async () => [],
			},
			loadSdk: async () => {
				this.nativeSdkLoadCalls++;
				throw new Error("live-controls journey must not use the native SDK fallback");
			},
		},
		clock: {
			now: () => Date.now(),
			setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
			clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
			setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
			clearInterval: (handle: ReturnType<typeof setInterval>) => clearInterval(handle),
		},
	});
}

export const claudeLiveControlsSdk = new LiveControlsSdk();
export const claudeLiveControlsDepsFactory = { create: claudeLiveControlsSdk.depsFactory };
