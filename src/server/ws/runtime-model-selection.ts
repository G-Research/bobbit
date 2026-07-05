import type { SessionInfo, SessionManager } from "../agent/session-manager.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import { applyModelString } from "../agent/review-model-override.js";
import { inferMeta } from "../agent/aigw-manager.js";
import { assertRuntimeSwitchAllowed, resolveSessionRuntime } from "../agent/session-runtime.js";
import type { ServerMessage } from "./protocol.js";

type RuntimeModelSessionManager = Pick<SessionManager, "persistSessionModel" | "getPersistedSession" | "updateModelNameFile">;
type RuntimeModelSession = Pick<SessionInfo, "id" | "rpcClient" | "clients">;
type RuntimeModelPrefs = Pick<PreferencesStore, "get">;
type BroadcastFn = (clients: RuntimeModelSession["clients"], msg: ServerMessage) => void;

/**
 * Live `set_model` requests only ever carry a plain `{ provider, modelId }`
 * pair over the wire — nothing upstream of this function checks whether the
 * requested provider crosses the Pi/Claude Code runtime boundary. Without
 * this guard a `set_model` for `claude-code/*` on a Pi session (or vice
 * versa) falls straight through to `applyModelString`, which drives
 * whichever `IRpcBridge` the session already has — i.e. it would try to bind
 * an Anthropic/OpenAI model onto a running Claude Code CLI process (or a
 * Claude Code alias onto Pi), rather than being rejected the same way
 * session creation/restore are via `assertRuntimeSwitchAllowed()`. The UI
 * model picker already blocks this by prompting for a new session (see
 * `ModelSelector.ts`), but the server must not rely on client cooperation —
 * see `docs/design/claude-code-runtime-reconcile.md` "Runtime dispatch seam".
 * Throws `RuntimeSwitchError` (code `RUNTIME_SWITCH_REQUIRES_NEW_SESSION`),
 * caught by `ws/handler.ts`'s `set_model` case and surfaced with that code.
 */
export async function applyRuntimeSessionModelSelection(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	provider: string,
	modelId: string,
	preferencesStore?: RuntimeModelPrefs | null,
	broadcastModelState?: BroadcastFn,
): Promise<{ provider: string; id: string }> {
	const persistedBefore = sessionManager.getPersistedSession(session.id);
	const currentRuntime = resolveSessionRuntime({ runtime: persistedBefore?.runtime, modelProvider: persistedBefore?.modelProvider });
	assertRuntimeSwitchAllowed(currentRuntime, provider);

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
