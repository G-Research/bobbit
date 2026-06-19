/**
 * Account-backed Gemini model list for the `google-gemini-cli` (Code Assist / OAuth)
 * provider. Metadata is derived from pi-ai's built-in `google` catalog so context
 * windows / costs stay in sync, but the models are re-emitted under provider
 * `google-gemini-cli` with `api: "google-code-assist"` so the runtime routes them to
 * the Code Assist Bearer adapter instead of the API-key Gemini Developer API.
 *
 * Models are only emitted when a Google account credential is present (see
 * `hasGoogleCodeAssistCredential`), so the selector is not cluttered with
 * non-functional account models for users who never log in with Google.
 *
 * IMPORTANT: these models are NOT yet runnable inside an agent/session. The Code
 * Assist adapter is only wired into server-side `completeModelText` — the
 * pi-coding-agent runtime has no `google-gemini-cli` provider / `google-code-assist`
 * api, so `setModel("google-gemini-cli", …)` fails and a session silently falls
 * back to a different model. Until agent-side Code Assist exists we emit them with
 * `sessionSelectable: false` so the ModelSelector shows them as authenticated but
 * visibly unavailable-for-sessions and refuses to bind them. The API-key `google`
 * (Gemini Developer API) provider is unaffected and stays fully selectable.
 *
 * Design: docs/design/google-oauth-model-auth.md §4.5.
 */

import { getModels } from "@earendil-works/pi-ai";

import type { ApiModel } from "./model-registry.js";
import {
	GOOGLE_CODE_ASSIST_API,
	GOOGLE_GEMINI_CLI_PROVIDER,
	hasGoogleCodeAssistCredential,
} from "./google-code-assist.js";

/**
 * Gemini ids the Code Assist API serves. Restricted to first-party `gemini-*`
 * models (Gemma and Vertex-only variants are excluded). A model is included only
 * when pi-ai's `google` catalog also carries it, so we never emit a stale id.
 */
function isCodeAssistEligible(id: string): boolean {
	const s = id.toLowerCase();
	return s.startsWith("gemini-") && !s.includes("customtools");
}

/**
 * Why a logged-in Google account model can't be picked for a session yet. Shown
 * as the ModelSelector tooltip/copy. Exported so tests can pin it in lockstep.
 */
export const GOOGLE_CODE_ASSIST_SESSION_UNAVAILABLE_REASON =
	"Signed in, but Google account (Code Assist) models can't run in agent sessions yet — " +
	"the agent runtime has no Code Assist provider. For Gemini in sessions, add a Google AI " +
	"Studio API key (provider \u201Cgoogle\u201D) under Settings \u2192 Models.";

export function getGoogleCodeAssistModels(): ApiModel[] {
	if (!hasGoogleCodeAssistCredential()) return [];

	let base: Array<Record<string, any>> = [];
	try {
		base = getModels("google" as any) as unknown as Array<Record<string, any>>;
	} catch {
		return [];
	}

	const models: ApiModel[] = [];
	for (const m of base) {
		if (!isCodeAssistEligible(String(m.id))) continue;
		models.push({
			id: m.id,
			name: `${m.name || m.id} (Google account)`,
			provider: GOOGLE_GEMINI_CLI_PROVIDER,
			api: GOOGLE_CODE_ASSIST_API,
			baseUrl: "https://cloudcode-pa.googleapis.com",
			contextWindow: m.contextWindow || 1_048_576,
			maxTokens: m.maxTokens || 65_536,
			reasoning: !!m.reasoning,
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> } : {}),
			input: (m.input || ["text"]) as ("text" | "image")[],
			cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			// `authenticated` is set by the registry via detectProviderAuth.
			authenticated: false,
			// Account-backed Code Assist models are authenticated but not yet runnable
			// in an agent session (no agent-side Code Assist provider). Gate selection.
			sessionSelectable: false,
			sessionUnavailableReason: GOOGLE_CODE_ASSIST_SESSION_UNAVAILABLE_REASON,
		});
	}
	return models;
}
