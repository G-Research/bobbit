import type { ThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevel, isKnownThinkingLevel } from "../../shared/thinking-levels.js";
import type { SessionInfo, SessionManager } from "../agent/session-manager.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import { sanitizeModelErrorText } from "../agent/model-error-sanitizer.js";
import { applyModelString } from "../agent/review-model-override.js";
import { getAvailableModels, resolveModelStateMeta } from "../agent/model-registry.js";
import type { ServerMessage } from "./protocol.js";

type RuntimePersistedSession = {
	modelProvider?: string;
	modelId?: string;
	effectiveThinkingLevel?: string;
};

type RuntimeModelSessionManager = Omit<
	Pick<
		SessionManager,
		"getPersistedSession" | "updateModelNameFile" | "restartAgent" | "getSession" | "terminateSession" | "storeArchive"
	>,
	"getPersistedSession"
> & {
	getPersistedSession(sessionId: string): RuntimePersistedSession | undefined;
	/** Atomic durable tuple seam; SessionManager owns the store implementation. */
	persistSessionModel(sessionId: string, provider: string, modelId: string, effectiveThinkingLevel?: ThinkingLevel): void;
};
type RuntimeModelStateSessionManager = Pick<RuntimeModelSessionManager, "getPersistedSession">;
type RuntimeModelSession = Pick<
	SessionInfo,
	"id" | "rpcClient" | "clients" | "spawnPinnedModel" | "spawnPinnedThinkingLevel"
>;
type RuntimeModelRpcClient = RuntimeModelSession["rpcClient"];
type BroadcastFn = (clients: RuntimeModelSession["clients"], msg: ServerMessage) => void;

export type RuntimeModelTuple = {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
};

type RuntimeModelSnapshot = {
	provider?: string;
	id?: string;
	thinkingLevel?: ThinkingLevel;
};

function modelStateMessage(tuple: RuntimeModelTuple): ServerMessage {
	const meta = resolveModelStateMeta(tuple.provider, tuple.id);
	return {
		type: "state",
		data: {
			model: {
				provider: tuple.provider,
				id: tuple.id,
				contextWindow: meta.contextWindow,
				maxTokens: meta.maxTokens,
				reasoning: meta.reasoning,
				...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
			},
			thinkingLevel: tuple.thinkingLevel,
		},
	};
}

function extractRuntimeModelSnapshot(stateRaw: unknown): RuntimeModelSnapshot {
	const state = (stateRaw ?? {}) as {
		data?: { model?: { provider?: unknown; id?: unknown }; thinkingLevel?: unknown };
		model?: { provider?: unknown; id?: unknown };
		thinkingLevel?: unknown;
	};
	const data = state.data ?? state;
	const model = data.model;
	const thinkingLevel = isKnownThinkingLevel(data.thinkingLevel);
	return {
		...(typeof model?.provider === "string" ? { provider: model.provider } : {}),
		...(typeof model?.id === "string" ? { id: model.id } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

function completeTuple(snapshot: RuntimeModelSnapshot | null | undefined): RuntimeModelTuple | null {
	return snapshot?.provider && snapshot.id && snapshot.thinkingLevel
		? { provider: snapshot.provider, id: snapshot.id, thinkingLevel: snapshot.thinkingLevel }
		: null;
}

async function readRuntimeModelBridgeSnapshot(rpcClient: RuntimeModelRpcClient): Promise<RuntimeModelSnapshot | null> {
	try {
		return extractRuntimeModelSnapshot(await rpcClient.getState());
	} catch {
		return null;
	}
}

async function readRuntimeModelSnapshot(session: RuntimeModelSession): Promise<RuntimeModelSnapshot | null> {
	return readRuntimeModelBridgeSnapshot(session.rpcClient);
}

function persistedTuple(
	sessionManager: RuntimeModelStateSessionManager,
	sessionId: string,
	live?: RuntimeModelSnapshot | null,
): RuntimeModelTuple | null {
	const persisted = sessionManager.getPersistedSession(sessionId);
	if (!persisted?.modelProvider || !persisted.modelId) return completeTuple(live);
	const persistedThinking = isKnownThinkingLevel(persisted.effectiveThinkingLevel);
	const matchingLiveThinking = live?.provider === persisted.modelProvider && live.id === persisted.modelId
		? live.thinkingLevel
		: undefined;
	const thinkingLevel = persistedThinking ?? matchingLiveThinking;
	return thinkingLevel
		? { provider: persisted.modelProvider, id: persisted.modelId, thinkingLevel }
		: null;
}

function tuplesEqual(actual: RuntimeModelSnapshot | null | undefined, expected: RuntimeModelTuple): boolean {
	return actual?.provider === expected.provider
		&& actual.id === expected.id
		&& actual.thinkingLevel === expected.thinkingLevel;
}

function broadcastTuple(session: RuntimeModelSession, tuple: RuntimeModelTuple, broadcastModelState: BroadcastFn): void {
	broadcastModelState(session.clients, modelStateMessage(tuple));
}

function commitRuntimeTuple(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	tuple: RuntimeModelTuple,
): void {
	sessionManager.persistSessionModel(session.id, tuple.provider, tuple.id, tuple.thinkingLevel);
	session.spawnPinnedModel = `${tuple.provider}/${tuple.id}`;
	session.spawnPinnedThinkingLevel = tuple.thinkingLevel;
	sessionManager.updateModelNameFile(session.id, session.spawnPinnedModel);
}

/** Broadcast a complete live tuple, falling back to a complete durable tuple only when live state is unavailable. */
export async function broadcastRuntimeSessionActualModelState(
	sessionManager: RuntimeModelStateSessionManager,
	session: RuntimeModelSession,
	broadcastModelState: BroadcastFn,
): Promise<RuntimeModelTuple | null> {
	const live = await readRuntimeModelSnapshot(session);
	const actual = completeTuple(live) ?? persistedTuple(sessionManager, session.id, live);
	if (!actual) return null;
	broadcastTuple(session, actual, broadcastModelState);
	return actual;
}

async function rollbackRuntimeTuple(
	rpcClient: RuntimeModelRpcClient,
	target: RuntimeModelTuple,
): Promise<RuntimeModelTuple> {
	await applyModelString(rpcClient, `${target.provider}/${target.id}`, {
		contextLabel: "runtime selection rollback",
		maxAttempts: 1,
		retryDelayMs: 0,
		readBackAttempts: 1,
	});
	await rpcClient.setThinkingLevel(target.thinkingLevel);
	const rolledBack = await readRuntimeModelBridgeSnapshot(rpcClient);
	if (!tuplesEqual(rolledBack, target)) {
		throw new Error(
			`runtime selection rollback read-back mismatch: expected ${target.provider}/${target.id}/${target.thinkingLevel}, ` +
			`agent reports ${rolledBack?.provider ?? "?"}/${rolledBack?.id ?? "?"}/${rolledBack?.thinkingLevel ?? "?"}`,
		);
	}
	return target;
}

class StaleRuntimeBridgeRecoveryError extends Error {}

/**
 * A role/respawn may replace a SessionInfo's bridge in place while an older RPC
 * is still settling. Once that happens, only the detached bridge may be fenced;
 * recovery by session id would target the newer canonical process instead.
 */
async function retainVerifiedCanonicalReplacement(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	mutationRpcClient: RuntimeModelRpcClient,
	broadcastModelState: BroadcastFn | undefined,
): Promise<boolean> {
	const canonical = sessionManager.getSession(session.id);
	if (!canonical || (canonical === session && canonical.rpcClient === mutationRpcClient)) return false;

	const latestDurable = persistedTuple(sessionManager, session.id);
	const canonicalState = await readRuntimeModelSnapshot(canonical);
	try {
		await mutationRpcClient.stop();
	} catch (stopError) {
		throw new StaleRuntimeBridgeRecoveryError(
			`the superseded runtime bridge could not be stopped: ${errorText(stopError)}`,
		);
	}
	if (!latestDurable || !tuplesEqual(canonicalState, latestDurable)) {
		throw new StaleRuntimeBridgeRecoveryError(
			"a newer canonical session exists, but its latest durable model tuple could not be verified",
		);
	}
	if (broadcastModelState) broadcastTuple(canonical, latestDurable, broadcastModelState);
	return true;
}

async function recoverRuntimeTupleMutation(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	mutationRpcClient: RuntimeModelRpcClient,
	durable: RuntimeModelTuple | null,
	broadcastModelState: BroadcastFn | undefined,
	mutationStarted: boolean,
): Promise<void> {
	if (!mutationStarted) {
		const liveAfterFailure = await readRuntimeModelSnapshot(session);
		const correctionAfterFailure = completeTuple(liveAfterFailure) ?? durable;
		if (correctionAfterFailure && broadcastModelState) {
			broadcastTuple(session, correctionAfterFailure, broadcastModelState);
		}
		return;
	}

	// Re-read both canonical bridge ownership and the latest durable tuple at the
	// last safe point before rollback. An in-place role replacement keeps the same
	// SessionInfo object, so bridge identity—not only session identity—is required.
	if (await retainVerifiedCanonicalReplacement(
		sessionManager,
		session,
		mutationRpcClient,
		broadcastModelState,
	)) return;

	const liveAfterFailure = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
	const correctionAfterFailure = completeTuple(liveAfterFailure) ?? durable;
	if (correctionAfterFailure && broadcastModelState) {
		broadcastTuple(session, correctionAfterFailure, broadcastModelState);
	}

	if (durable) {
		try {
			const rolledBack = await rollbackRuntimeTuple(mutationRpcClient, durable);
			if (broadcastModelState) broadcastTuple(session, rolledBack, broadcastModelState);
			return;
		} catch {
			// One bounded rollback attempt failed or could not be verified. Replace the
			// bridge from unchanged durable state below; never continue it partially bound.
		}
	}

	// Rollback awaited RPCs, so a replacement could have committed meanwhile.
	// Recheck ownership immediately before the session-id restart boundary.
	if (await retainVerifiedCanonicalReplacement(
		sessionManager,
		session,
		mutationRpcClient,
		broadcastModelState,
	)) return;

	await sessionManager.restartAgent(session.id);
	const replacement = sessionManager.getSession(session.id);
	if (!replacement) throw new Error("runtime selection recovery restart returned no live session");
	const replacementState = await readRuntimeModelSnapshot(replacement);
	const replacementTuple = completeTuple(replacementState);
	if (!replacementTuple) throw new Error("runtime selection recovery restart state is incomplete or unreachable");
	if (durable && !tuplesEqual(replacementTuple, durable)) {
		throw new Error(
			`runtime selection recovery restart mismatch: expected ${durable.provider}/${durable.id}/${durable.thinkingLevel}, ` +
			`agent reports ${replacementTuple.provider}/${replacementTuple.id}/${replacementTuple.thinkingLevel}`,
		);
	}
	if (broadcastModelState) broadcastTuple(replacement, replacementTuple, broadcastModelState);
}

function errorText(error: unknown): string {
	return sanitizeModelErrorText(error);
}

async function quarantineUnverifiableRuntimeSession(
	sessionManager: RuntimeModelSessionManager,
	sessionId: string,
): Promise<void> {
	const terminated = await sessionManager.terminateSession(sessionId);
	if (terminated) return;
	if (await sessionManager.storeArchive(sessionId)) return;
	throw new Error("the unsafe session could not be terminated or archived");
}

async function throwAfterRuntimeRecovery(
	error: unknown,
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	mutationRpcClient: RuntimeModelRpcClient,
	durable: RuntimeModelTuple | null,
	broadcastModelState: BroadcastFn | undefined,
	mutationStarted: boolean,
): Promise<never> {
	try {
		await recoverRuntimeTupleMutation(
			sessionManager,
			session,
			mutationRpcClient,
			durable,
			broadcastModelState,
			mutationStarted,
		);
	} catch (recoveryError) {
		if (recoveryError instanceof StaleRuntimeBridgeRecoveryError) {
			throw new Error(
				`${errorText(error)}; stale runtime bridge recovery failed: ${errorText(recoveryError)}. ` +
				"The newer canonical session was retained; retry the selection after reconnecting.",
			);
		}
		try {
			await quarantineUnverifiableRuntimeSession(sessionManager, session.id);
		} catch (quarantineError) {
			throw new Error(
				`${errorText(error)}; runtime selection recovery failed: ${errorText(recoveryError)}; ` +
				`unsafe session quarantine failed: ${errorText(quarantineError)}`,
			);
		}
		throw new Error(
			`${errorText(error)}; runtime selection recovery failed: ${errorText(recoveryError)}. ` +
			"The session was terminated and archived because its runtime model state could not be verified; create a fresh session to continue.",
		);
	}
	throw error;
}

async function requireSessionSelectableModel(
	preferencesStore: PreferencesStore | undefined,
	provider: string,
	modelId: string,
) {
	if (!preferencesStore) {
		throw new Error(`Model ${provider}/${modelId} is unavailable: model preferences are not configured`);
	}
	const models = await getAvailableModels(preferencesStore);
	const selected = models.find((model) => model.provider === provider && model.id === modelId);
	if (!selected || selected.sessionSelectable === false) {
		const reason = selected?.sessionUnavailableReason ? `: ${selected.sessionUnavailableReason}` : "";
		throw new Error(`Model ${provider}/${modelId} is unavailable for Bobbit sessions${reason}`);
	}
	return selected;
}

function effectiveThinkingForSelection(
	requestedThinkingLevel: string | undefined,
	currentThinkingLevel: ThinkingLevel | undefined,
	selectedModel: Awaited<ReturnType<typeof requireSessionSelectableModel>>,
): ThinkingLevel {
	const requested = requestedThinkingLevel === undefined
		? currentThinkingLevel
		: isKnownThinkingLevel(requestedThinkingLevel);
	if (!requested) {
		throw new Error(`Unknown or unverifiable thinking level "${requestedThinkingLevel ?? "?"}"`);
	}
	const effective = clampThinkingLevel(requested, selectedModel);
	if (!effective) throw new Error(`Thinking level "${requested}" is unavailable for ${selectedModel.provider}/${selectedModel.id}`);
	return effective;
}

function runtimeBridgeIsCanonical(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	rpcClient: RuntimeModelRpcClient,
): boolean {
	const canonical = sessionManager.getSession(session.id);
	return canonical === session && canonical.rpcClient === rpcClient;
}

export async function applyRuntimeSessionModelSelection(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	provider: string,
	modelId: string,
	thinkingLevel: string | undefined,
	preferencesStore?: PreferencesStore,
	broadcastModelState?: BroadcastFn,
): Promise<RuntimeModelTuple> {
	const mutationRpcClient = session.rpcClient;
	const liveBefore = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
	const durable = persistedTuple(sessionManager, session.id, liveBefore);
	let mutationStarted = false;

	try {
		const selectedModel = await requireSessionSelectableModel(preferencesStore, provider, modelId);
		const effectiveThinkingLevel = effectiveThinkingForSelection(
			thinkingLevel,
			durable?.thinkingLevel ?? liveBefore?.thinkingLevel,
			selectedModel,
		);
		const requested: RuntimeModelTuple = { provider, id: modelId, thinkingLevel: effectiveThinkingLevel };
		if (!runtimeBridgeIsCanonical(sessionManager, session, mutationRpcClient)) {
			throw new Error("runtime model read-back mismatch: the session bridge was replaced before selection");
		}

		mutationStarted = true;
		await applyModelString(mutationRpcClient, `${provider}/${modelId}`, {
			contextLabel: "runtime session model",
			maxAttempts: 1,
			retryDelayMs: 0,
			readBackAttempts: 1,
		});
		if (!runtimeBridgeIsCanonical(sessionManager, session, mutationRpcClient)) {
			throw new Error("runtime model read-back mismatch: the session bridge was replaced during selection");
		}
		const modelReadBack = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
		if (modelReadBack?.provider !== provider || modelReadBack.id !== modelId) {
			throw new Error(
				`runtime model read-back mismatch before thinking: expected ${provider}/${modelId}, ` +
				`agent reports ${modelReadBack?.provider ?? "?"}/${modelReadBack?.id ?? "?"}`,
			);
		}
		await mutationRpcClient.setThinkingLevel(effectiveThinkingLevel);
		const finalState = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
		if (!tuplesEqual(finalState, requested)) {
			throw new Error(
				`runtime tuple read-back mismatch: expected ${provider}/${modelId}/${effectiveThinkingLevel}, ` +
				`agent reports ${finalState?.provider ?? "?"}/${finalState?.id ?? "?"}/${finalState?.thinkingLevel ?? "?"}`,
			);
		}
		if (!runtimeBridgeIsCanonical(sessionManager, session, mutationRpcClient)) {
			throw new Error("runtime tuple read-back mismatch: the session bridge was replaced before commit");
		}

		commitRuntimeTuple(sessionManager, session, requested);
		mutationStarted = false;
		if (broadcastModelState) broadcastTuple(session, requested, broadcastModelState);
		return requested;
	} catch (error) {
		return throwAfterRuntimeRecovery(
			error,
			sessionManager,
			session,
			mutationRpcClient,
			durable,
			broadcastModelState,
			mutationStarted,
		);
	}
}

export async function applyRuntimeSessionThinkingSelection(
	sessionManager: RuntimeModelSessionManager,
	session: RuntimeModelSession,
	thinkingLevel: string,
	broadcastModelState?: BroadcastFn,
): Promise<RuntimeModelTuple> {
	const mutationRpcClient = session.rpcClient;
	const liveBefore = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
	const durable = persistedTuple(sessionManager, session.id, liveBefore);
	let mutationStarted = false;

	try {
		const current = completeTuple(liveBefore);
		if (!current) {
			mutationStarted = durable !== null;
			throw new Error("Cannot verify the current model/thinking tuple");
		}
		if (durable && (current.provider !== durable.provider || current.id !== durable.id)) {
			mutationStarted = true;
			throw new Error(
				`Current model does not match durable state: expected ${durable.provider}/${durable.id}, ` +
				`agent reports ${current.provider}/${current.id}`,
			);
		}
		const requested = isKnownThinkingLevel(thinkingLevel);
		if (!requested) throw new Error(`Unknown thinking level "${thinkingLevel}"`);
		const meta = resolveModelStateMeta(current.provider, current.id);
		const effectiveThinkingLevel = clampThinkingLevel(requested, {
			provider: current.provider,
			id: current.id,
			reasoning: meta.reasoning,
			thinkingLevelMap: meta.thinkingLevelMap,
		});
		if (!effectiveThinkingLevel) {
			throw new Error(`Thinking level "${requested}" is unavailable for ${current.provider}/${current.id}`);
		}
		const expected: RuntimeModelTuple = { ...current, thinkingLevel: effectiveThinkingLevel };
		if (!runtimeBridgeIsCanonical(sessionManager, session, mutationRpcClient)) {
			throw new Error("runtime thinking read-back mismatch: the session bridge was replaced before selection");
		}

		mutationStarted = true;
		await mutationRpcClient.setThinkingLevel(effectiveThinkingLevel);
		const finalState = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
		if (!tuplesEqual(finalState, expected)) {
			throw new Error(
				`runtime thinking read-back mismatch: expected ${expected.provider}/${expected.id}/${effectiveThinkingLevel}, ` +
				`agent reports ${finalState?.provider ?? "?"}/${finalState?.id ?? "?"}/${finalState?.thinkingLevel ?? "?"}`,
			);
		}
		if (!runtimeBridgeIsCanonical(sessionManager, session, mutationRpcClient)) {
			throw new Error("runtime thinking read-back mismatch: the session bridge was replaced before commit");
		}

		commitRuntimeTuple(sessionManager, session, expected);
		mutationStarted = false;
		if (broadcastModelState) broadcastTuple(session, expected, broadcastModelState);
		return expected;
	} catch (error) {
		return throwAfterRuntimeRecovery(
			error,
			sessionManager,
			session,
			mutationRpcClient,
			durable,
			broadcastModelState,
			mutationStarted,
		);
	}
}
