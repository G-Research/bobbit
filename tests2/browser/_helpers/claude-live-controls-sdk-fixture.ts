type SdkQueryArgs = { prompt: AsyncIterable<unknown>; options: Record<string, unknown> };

type SdkModel = {
	value: string;
	resolvedModel: string;
	supportsEffort: boolean;
	supportedEffortLevels: string[];
};

export const CLAUDE_LIVE_MODELS = {
	sonnet: { value: "sonnet-sdk-wire", resolvedModel: "sonnet-live", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
	haiku: { value: "haiku-sdk-wire", resolvedModel: "haiku-live", supportsEffort: true, supportedEffortLevels: ["medium"] },
	broken: { value: "broken-sdk-wire", resolvedModel: "broken-live", supportsEffort: true, supportedEffortLevels: ["medium"] },
} as const satisfies Record<string, SdkModel>;

const SDK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A deterministic official-Query-shaped fake. The gateway still constructs the
 * production ClaudeAgentSdkBridge; only its SDK dependency is replaced.
 */
class LiveControlsQuery implements AsyncIterable<unknown> {
	readonly setModels: string[] = [];
	readonly effortSettings: Array<{ effortLevel?: string | null }> = [];
	readonly thinkingBudgets: Array<number | null> = [];
	private closed = false;
	private initialized = false;
	private reader?: (result: IteratorResult<unknown>) => void;

	constructor(readonly args: SdkQueryArgs) {
		// The official SDK pulls the prompt stream before bridge-side capability
		// initialization settles. Consume the first test prompt the same way, so
		// this fake proves controls only after a real input is admitted.
		void this.consumeFirstPrompt();
	}

	private async consumeFirstPrompt(): Promise<void> {
		await this.args.prompt[Symbol.asyncIterator]().next();
	}

	async initializationResult(): Promise<{ models: SdkModel[] }> {
		return { models: Object.values(CLAUDE_LIVE_MODELS) };
	}

	supportedModels(): SdkModel[] {
		return Object.values(CLAUDE_LIVE_MODELS);
	}

	async setModel(model: string): Promise<void> {
		this.setModels.push(model);
		if (model === CLAUDE_LIVE_MODELS.broken.value) throw new Error("deterministic SDK setModel failure");
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

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => {
				if (!this.initialized) {
					this.initialized = true;
					return Promise.resolve({ done: false, value: { type: "system", subtype: "init", session_id: SDK_SESSION_ID } });
				}
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise<IteratorResult<unknown>>(resolve => { this.reader = resolve; });
			},
		};
	}
}

class LiveControlsSdk {
	readonly queries: LiveControlsQuery[] = [];

	reset(): void {
		this.queries.length = 0;
	}

	readonly depsFactory = () => ({
		query: ((args: SdkQueryArgs) => {
			const query = new LiveControlsQuery(args);
			this.queries.push(query);
			return query;
		}) as any,
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
