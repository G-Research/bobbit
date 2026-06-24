import type { SessionInfo, SessionManager } from "../agent/session-manager.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import { applyModelString } from "../agent/review-model-override.js";
import { inferMeta } from "../agent/aigw-manager.js";
import type { ServerMessage } from "./protocol.js";

type RuntimeModelSessionManager = Pick<SessionManager, "persistSessionModel" | "getPersistedSession" | "updateModelNameFile">;
type RuntimeModelSession = Pick<SessionInfo, "id" | "rpcClient" | "clients">;
type RuntimeModelPrefs = Pick<PreferencesStore, "get">;
type BroadcastFn = (clients: RuntimeModelSession["clients"], msg: ServerMessage) => void;

export async function applyRuntimeSessionModelSelection(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	provider: string,
	modelId: string,
	preferencesStore?: RuntimeModelPrefs | null,
	broadcastModelState?: BroadcastFn,
): Promise<{ provider: string; id: string }> {
	const selectedModel = `${provider}/${modelId}`;
	const fallbackModel = preferencesStore?.get("default.sessionModel") as string | undefined;
	await applyModelString(session.rpcClient, selectedModel, {
		sessionManager,
		sessionId: session.id,
		contextLabel: "runtime session model",
		maxAttempts: 1,
		retryDelayMs: 0,
		controlledFallback: {
			enabled: preferencesStore?.get("allowSessionModelFallback") === true,
			model: fallbackModel,
		},
	});

	const persisted = sessionManager.getPersistedSession(session.id);
	const actualProvider = persisted?.modelProvider ?? provider;
	const actualId = persisted?.modelId ?? modelId;
	sessionManager.updateModelNameFile(session.id, `${actualProvider}/${actualId}`);
	const meta = inferMeta(actualId);
	broadcastModelState?.(session.clients, {
		type: "state",
		data: {
			model: {
				provider: actualProvider,
				id: actualId,
				contextWindow: meta.contextWindow,
				maxTokens: meta.maxTokens,
				reasoning: meta.reasoning,
			},
		},
	});
	if (actualProvider !== provider || actualId !== modelId) {
		console.log(`[ws-handler] Controlled fallback selected default.sessionModel "${actualProvider}/${actualId}" for session ${session.id} after runtime model "${selectedModel}" failed`);
	}
	return { provider: actualProvider, id: actualId };
}
