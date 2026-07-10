import type { SessionInfo, SessionManager } from "../agent/session-manager.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import { applyModelString } from "../agent/review-model-override.js";
import { resolveModelStateMeta } from "../agent/model-registry.js";
import type { ServerMessage } from "./protocol.js";

type RuntimeModelSessionManager = Pick<SessionManager, "persistSessionModel" | "getPersistedSession" | "updateModelNameFile">;
type RuntimeModelStateSessionManager = Pick<SessionManager, "getPersistedSession">;
type RuntimeModelSession = Pick<SessionInfo, "id" | "rpcClient" | "clients">;
type RuntimeModelPrefs = Pick<PreferencesStore, "get">;
type BroadcastFn = (clients: RuntimeModelSession["clients"], msg: ServerMessage) => void;

type RuntimeBoundModel = { provider: string; id: string };

function modelStateMessage(provider: string, id: string): ServerMessage {
	const meta = resolveModelStateMeta(provider, id);
	return {
		type: "state",
		data: {
			model: {
				provider,
				id,
				contextWindow: meta.contextWindow,
				maxTokens: meta.maxTokens,
				reasoning: meta.reasoning,
				...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
			},
		},
	};
}

function extractBoundModel(stateRaw: unknown): RuntimeBoundModel | null {
	const s = (stateRaw ?? {}) as { data?: { model?: { provider?: unknown; id?: unknown } }; model?: { provider?: unknown; id?: unknown } };
	const model = s.data?.model ?? s.model;
	return typeof model?.provider === "string" && typeof model?.id === "string"
		? { provider: model.provider, id: model.id }
		: null;
}

export async function broadcastRuntimeSessionActualModelState(
	sessionManager: RuntimeModelStateSessionManager,
	session: RuntimeModelSession,
	broadcastModelState: BroadcastFn,
): Promise<RuntimeBoundModel | null> {
	let actual: RuntimeBoundModel | null = null;
	try {
		actual = extractBoundModel(await session.rpcClient.getState());
	} catch {
		// Fall back to persisted state below; the original set_model error remains
		// the user-visible failure.
	}
	if (!actual) {
		const persisted = sessionManager.getPersistedSession(session.id);
		if (persisted?.modelProvider && persisted?.modelId) {
			actual = { provider: persisted.modelProvider, id: persisted.modelId };
		}
	}
	if (!actual) return null;
	broadcastModelState(session.clients, modelStateMessage(actual.provider, actual.id));
	return actual;
}

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
		retryDelayMs: 250,
		readBackAttempts: 2,
		controlledFallback: {
			enabled: preferencesStore?.get("allowSessionModelFallback") === true,
			model: fallbackModel,
		},
	});

	const persisted = sessionManager.getPersistedSession(session.id);
	const actualProvider = persisted?.modelProvider ?? provider;
	const actualId = persisted?.modelId ?? modelId;
	sessionManager.updateModelNameFile(session.id, `${actualProvider}/${actualId}`);
	broadcastModelState?.(session.clients, modelStateMessage(actualProvider, actualId));
	if (actualProvider !== provider || actualId !== modelId) {
		console.log(`[ws-handler] Controlled fallback selected default.sessionModel "${actualProvider}/${actualId}" for session ${session.id} after runtime model "${selectedModel}" failed`);
	}
	return { provider: actualProvider, id: actualId };
}
