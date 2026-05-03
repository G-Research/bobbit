/**
 * applyReviewModelOverrides — centralised helper for binding a review/QA
 * sub-session to the user's preferred review model.
 *
 * Behavior:
 *   - Parse `default.reviewModel` as `<provider>/<modelId>`.
 *   - Call `rpc.setModel(provider, modelId)` with up to 2 attempts (250ms delay).
 *   - Call `rpc.getState()` and assert the bound model matches.
 *   - Throw on malformed pref, setModel failure, or read-back mismatch.
 *   - Resolve silently when the pref is unset.
 *   - Persist via sessionManager when both sessionManager and sessionId are provided.
 *
 * applyModelString — sibling helper for binding a session to a literal
 * "<provider>/<modelId>" string (e.g. sourced from a role override). Same
 * hard-fail-on-mismatch contract as applyReviewModelOverrides.
 */

interface ModelShape { id?: string; provider?: string }
/**
 * The real RpcBridge.getState() resolves to `{ success, data: { model, ... } }`
 * (see src/server/agent/rpc-bridge.ts). Some unit-test mocks return the
 * `{ model }` shape directly. Accept both so the helper works in both places.
 */
export interface ReviewModelRpc {
	setModel(provider: string, modelId: string): Promise<unknown>;
	getState(): Promise<
		| { success?: boolean; data?: { model?: ModelShape } }
		| { model?: ModelShape }
		| undefined
	>;
}

export interface ReviewModelPrefs {
	get(key: string): string | undefined;
}

export interface ReviewModelPersister {
	persistSessionModel(sessionId: string, provider: string, modelId: string): void;
}

export interface ApplyReviewModelOptions {
	prefs: ReviewModelPrefs;
	sessionManager?: ReviewModelPersister | null;
	sessionId?: string | null;
	role?: "reviewer" | "qa" | "subsession";
	/** Pref key to read. Defaults to "default.reviewModel". */
	prefKey?: string;
	/** Retry attempts for setModel. Defaults to 2. */
	maxAttempts?: number;
	/** Delay between retries in ms. Defaults to 250. */
	retryDelayMs?: number;
	/**
	 * Skip the `setModel` RPC and go straight to read-back verification.
	 * Use when the agent was spawned with `--model <provider>/<modelId>`
	 * already — the read-back still hard-fails on mismatch, preserving the
	 * contract.
	 */
	skipSetModel?: boolean;
}

export interface ApplyModelStringOptions {
	sessionManager?: ReviewModelPersister | null;
	sessionId?: string | null;
	/** Label used in error messages, e.g. "role.coder.model". */
	contextLabel?: string;
	/** Retry attempts for setModel. Defaults to 2. */
	maxAttempts?: number;
	/** Delay between retries in ms. Defaults to 250. */
	retryDelayMs?: number;
	/**
	 * Skip the `setModel` RPC and go straight to read-back verification.
	 * Use when the agent was spawned with `--model <provider>/<modelId>`
	 * already — the read-back still hard-fails on mismatch.
	 */
	skipSetModel?: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bind an RPC client to a literal `<provider>/<modelId>` model string.
 *
 * Hard-fail contract: throws on malformed input, setModel failure (after
 * retries), or read-back mismatch. Caller is responsible for converting the
 * thrown error into the appropriate user-visible failure (e.g. failed gate,
 * red Unavailable badge).
 */
export async function applyModelString(
	rpc: ReviewModelRpc,
	modelString: string,
	opts: ApplyModelStringOptions = {},
): Promise<void> {
	const label = opts.contextLabel ?? "model";

	const slash = modelString.indexOf("/");
	if (slash <= 0 || slash >= modelString.length - 1) {
		throw new Error(
			`malformed ${label}: "${modelString}" (expected "<provider>/<modelId>")`,
		);
	}
	const provider = modelString.slice(0, slash);
	const modelId = modelString.slice(slash + 1);

	const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
	const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 250);

	if (!opts.skipSetModel) {
		let lastErr: unknown;
		let succeeded = false;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await rpc.setModel(provider, modelId);
				succeeded = true;
				break;
			} catch (err) {
				lastErr = err;
				if (attempt < maxAttempts) {
					await sleep(retryDelayMs);
				}
			}
		}
		if (!succeeded) {
			const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
			throw new Error(
				`setModel failed for ${label}="${modelString}" after ${maxAttempts} attempt(s): ${msg}`,
			);
		}
	}

	// Read-back verification
	let stateRaw: unknown;
	try {
		stateRaw = await rpc.getState();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`setModel read-back failed (getState threw) for "${modelString}": ${msg}`);
	}
	// Accept both the real RpcBridge shape `{ success, data: { model } }` and
	// the simpler `{ model }` shape used by unit-test mocks.
	const s = (stateRaw ?? {}) as { data?: { model?: ModelShape }; model?: ModelShape };
	const boundModel: ModelShape | undefined = s.data?.model ?? s.model;
	const boundId = boundModel?.id;
	const boundProvider = boundModel?.provider;
	if (boundId !== modelId || boundProvider !== provider) {
		throw new Error(
			`setModel read-back mismatch for "${modelString}": expected ${provider}/${modelId}, ` +
				`agent reports ${boundProvider ?? "?"}/${boundId ?? "?"}`,
		);
	}

	if (opts.sessionManager && opts.sessionId) {
		opts.sessionManager.persistSessionModel(opts.sessionId, provider, modelId);
	}
}

export async function applyReviewModelOverrides(
	rpc: ReviewModelRpc,
	opts: ApplyReviewModelOptions,
): Promise<void> {
	const prefKey = opts.prefKey ?? "default.reviewModel";
	const pref = opts.prefs.get(prefKey);
	if (!pref) return;

	return applyModelString(rpc, pref, {
		sessionManager: opts.sessionManager,
		sessionId: opts.sessionId,
		contextLabel: prefKey,
		maxAttempts: opts.maxAttempts,
		retryDelayMs: opts.retryDelayMs,
		skipSetModel: opts.skipSetModel,
	});
}
