/**
 * applyReviewModelOverrides — centralised helper for binding a review/QA
 * sub-session to the user's preferred review model.
 *
 * DESIRED CONTRACT (to be implemented in the implementation gate):
 *   - Parse `default.reviewModel` as `<provider>/<modelId>`.
 *   - Call `rpc.setModel(provider, modelId)` (with retry).
 *   - Call `rpc.getState()` and assert the bound model matches.
 *   - Throw on malformed pref, setModel failure, or read-back mismatch.
 *   - Resolve silently when the pref is unset.
 *   - Persist via sessionManager when provided.
 *
 * CURRENT STUB BEHAVIOR (mirrors today's silent-swallow bug in verification-harness.ts):
 *   - `setModel` failures are caught and logged to `console.warn`.
 *   - No `getState` read-back.
 *   - Malformed prefs are logged and ignored.
 *
 * The reproducing-test (tests/review-model-override.spec.ts) asserts the
 * DESIRED contract and therefore fails against this stub — by design.
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
}

export async function applyReviewModelOverrides(
	rpc: ReviewModelRpc,
	opts: ApplyReviewModelOptions,
): Promise<void> {
	const pref = opts.prefs.get("default.reviewModel");
	if (!pref) return;

	const slash = pref.indexOf("/");
	if (slash <= 0 || slash >= pref.length - 1) {
		// STUB: today's verification-harness logs and continues. Desired behavior: throw.
		console.warn(`[review-model-override] Malformed default.reviewModel preference: "${pref}", ignoring`);
		return;
	}
	const provider = pref.slice(0, slash);
	const modelId = pref.slice(slash + 1);

	try {
		await rpc.setModel(provider, modelId);
		if (opts.sessionManager && opts.sessionId) {
			opts.sessionManager.persistSessionModel(opts.sessionId, provider, modelId);
		}
		// STUB: no getState read-back — desired behavior should verify bound model matches.
	} catch (err) {
		// STUB: silent swallow — desired behavior should re-throw.
		console.warn(`[review-model-override] Failed to set review model "${pref}", using default:`, err);
	}
}
