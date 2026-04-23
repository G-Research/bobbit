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
 */

export interface ReviewModelRpc {
	setModel(provider: string, modelId: string): Promise<unknown>;
	getState(): Promise<{ model?: { id?: string; provider?: string } } | undefined>;
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
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function applyReviewModelOverrides(
	rpc: ReviewModelRpc,
	opts: ApplyReviewModelOptions,
): Promise<void> {
	const prefKey = opts.prefKey ?? "default.reviewModel";
	const pref = opts.prefs.get(prefKey);
	if (!pref) return;

	const slash = pref.indexOf("/");
	if (slash <= 0 || slash >= pref.length - 1) {
		throw new Error(
			`malformed ${prefKey} preference: "${pref}" (expected "<provider>/<modelId>")`,
		);
	}
	const provider = pref.slice(0, slash);
	const modelId = pref.slice(slash + 1);

	const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
	const retryDelayMs = Math.max(0, opts.retryDelayMs ?? 250);

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
			`setModel failed for ${prefKey}="${pref}" after ${maxAttempts} attempt(s): ${msg}`,
		);
	}

	// Read-back verification
	let state: { model?: { id?: string; provider?: string } } | undefined;
	try {
		state = await rpc.getState();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`setModel read-back failed (getState threw) for "${pref}": ${msg}`);
	}
	const boundId = state?.model?.id;
	const boundProvider = state?.model?.provider;
	if (boundId !== modelId || boundProvider !== provider) {
		throw new Error(
			`setModel read-back mismatch for "${pref}": expected ${provider}/${modelId}, ` +
				`agent reports ${boundProvider ?? "?"}/${boundId ?? "?"}`,
		);
	}

	if (opts.sessionManager && opts.sessionId) {
		opts.sessionManager.persistSessionModel(opts.sessionId, provider, modelId);
	}
}
