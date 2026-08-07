import type { ThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevel, isKnownThinkingLevel } from "../../shared/thinking-levels.js";
import type { SessionBridgeOwner, SessionInfo, SessionManager } from "../agent/session-manager.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import { sanitizeModelErrorText } from "../agent/model-error-sanitizer.js";
import { applyModelString } from "../agent/review-model-override.js";
import { getAvailableModels, resolveModelStateMeta } from "../agent/model-registry.js";
import { resolveSessionRuntime, type SessionRuntime } from "../agent/session-runtime.js";
import type { ServerMessage } from "./protocol.js";

type RuntimePersistedSession = {
	modelProvider?: string;
	modelId?: string;
	effectiveThinkingLevel?: string;
	runtime?: SessionRuntime;
};

type RuntimeModelSessionManager = Omit<
	Pick<
		SessionManager,
		"getPersistedSession" | "updateModelNameFile" | "restartAgent" | "getSession" | "terminateSession" | "storeArchive"
	>,
	"getPersistedSession" | "restartAgent"
> & {
	getPersistedSession(sessionId: string): RuntimePersistedSession | undefined;
	restartAgent(sessionId: string, expectedOwner?: SessionBridgeOwner): Promise<void>;
	/** Atomic durable tuple seam; SessionManager owns the store implementation. */
	persistSessionModel(sessionId: string, provider: string, modelId: string, effectiveThinkingLevel?: ThinkingLevel): void;
};
type RuntimeModelStateSessionManager = Pick<RuntimeModelSessionManager, "getPersistedSession">;
type RuntimeModelSession = Pick<
	SessionInfo,
	"id" | "rpcClient" | "clients" | "runtime" | "spawnPinnedModel" | "spawnPinnedThinkingLevel"
>;
type RuntimeModelRpcClient = RuntimeModelSession["rpcClient"];
type RuntimeRecoveryOwner = {
	session: RuntimeModelSession;
	rpcClient: RuntimeModelRpcClient;
};
type BroadcastFn = (clients: RuntimeModelSession["clients"], msg: ServerMessage) => void;

export type RuntimeModelTuple = {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
};

type RuntimeThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

type RuntimeModelSnapshot = {
	provider?: string;
	id?: string;
	thinkingLevel?: ThinkingLevel;
	/** Live runtime capabilities, authoritative only for the active SDK bridge. */
	reasoning?: boolean;
	thinkingLevelMap?: RuntimeThinkingLevelMap;
};

function modelStateMessage(tuple: RuntimeModelTuple, live?: RuntimeModelSnapshot | null): ServerMessage {
	const meta = resolveModelStateMeta(tuple.provider, tuple.id);
	const liveSdkCapabilities = tuple.provider === "claude-agent-sdk"
		&& live?.provider === tuple.provider
		&& live.id === tuple.id;
	return {
		type: "state",
		data: {
			model: {
				provider: tuple.provider,
				id: tuple.id,
				contextWindow: meta.contextWindow,
				maxTokens: meta.maxTokens,
				// SDK models are not registry-owned. Do not re-publish a configured
				// manual row's capabilities when a live SDK bridge has stated its own.
				reasoning: liveSdkCapabilities ? live.reasoning === true : meta.reasoning,
				...(liveSdkCapabilities
					? (live.thinkingLevelMap ? { thinkingLevelMap: live.thinkingLevelMap } : {})
					: (meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {})),
			},
			thinkingLevel: tuple.thinkingLevel,
		},
	};
}

function extractThinkingLevelMap(value: unknown): RuntimeThinkingLevelMap | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: RuntimeThinkingLevelMap = {};
	for (const [level, mapped] of Object.entries(value)) {
		const known = isKnownThinkingLevel(level);
		if (known && (typeof mapped === "string" || mapped === null)) result[known] = mapped;
	}
	return result;
}

function extractRuntimeModelSnapshot(stateRaw: unknown): RuntimeModelSnapshot {
	const state = (stateRaw ?? {}) as {
		data?: { model?: { provider?: unknown; id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown }; thinkingLevel?: unknown };
		model?: { provider?: unknown; id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown };
		thinkingLevel?: unknown;
	};
	const data = state.data ?? state;
	const model = data.model;
	const thinkingLevel = isKnownThinkingLevel(data.thinkingLevel);
	const thinkingLevelMap = extractThinkingLevelMap(model?.thinkingLevelMap);
	return {
		...(typeof model?.provider === "string" ? { provider: model.provider } : {}),
		...(typeof model?.id === "string" ? { id: model.id } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		...(typeof model?.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
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

function broadcastTuple(
	session: RuntimeModelSession,
	tuple: RuntimeModelTuple,
	broadcastModelState: BroadcastFn,
	live?: RuntimeModelSnapshot | null,
): void {
	broadcastModelState(session.clients, modelStateMessage(tuple, live));
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
	broadcastTuple(session, actual, broadcastModelState, live);
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

class OwnedRuntimeRecoveryError extends Error {
	readonly owner: RuntimeRecoveryOwner;
	readonly recoveryError: unknown;

	constructor(recoveryError: unknown, owner: RuntimeRecoveryOwner) {
		super(errorText(recoveryError));
		this.name = "OwnedRuntimeRecoveryError";
		this.owner = owner;
		this.recoveryError = recoveryError;
	}
}

function recoveryOwnerIsCanonical(
	sessionManager: RuntimeModelSessionManager,
	owner: RuntimeRecoveryOwner,
): boolean {
	const canonical = sessionManager.getSession(owner.session.id);
	return canonical === owner.session && canonical.rpcClient === owner.rpcClient;
}

/**
 * A role/respawn may replace a SessionInfo's bridge in place while an older RPC
 * is still settling. Once that happens, only the detached bridge may be fenced;
 * recovery by session id would target the newer canonical process instead.
 */
async function retainVerifiedCanonicalReplacement(
	sessionManager: RuntimeModelSessionManager,
	owner: RuntimeRecoveryOwner,
	broadcastModelState: BroadcastFn | undefined,
): Promise<boolean> {
	const initialCanonical = sessionManager.getSession(owner.session.id);
	if (!initialCanonical || (initialCanonical === owner.session && initialCanonical.rpcClient === owner.rpcClient)) return false;

	try {
		await owner.rpcClient.stop();
	} catch (stopError) {
		throw new StaleRuntimeBridgeRecoveryError(
			`the superseded runtime bridge could not be stopped: ${errorText(stopError)}`,
		);
	}

	// Stopping the detached owner awaited an RPC. Capture the candidate and its
	// complete durable authority only afterwards, then fence both again once its
	// asynchronous read-back settles.
	const candidate = sessionManager.getSession(owner.session.id);
	const candidateDurable = persistedTuple(sessionManager, owner.session.id);
	if (!candidate || !candidateDurable || (candidate === owner.session && candidate.rpcClient === owner.rpcClient)) {
		throw new StaleRuntimeBridgeRecoveryError(
			"the superseded bridge was stopped, but no complete newer canonical tuple was available to verify",
		);
	}
	const candidateRpcClient = candidate.rpcClient;
	const candidateState = await readRuntimeModelBridgeSnapshot(candidateRpcClient);
	const current = sessionManager.getSession(owner.session.id);
	const currentDurable = persistedTuple(sessionManager, owner.session.id);
	if (
		current !== candidate
		|| current.rpcClient !== candidateRpcClient
		|| !currentDurable
		|| !tuplesEqual(candidateState, currentDurable)
	) {
		throw new StaleRuntimeBridgeRecoveryError(
			"a newer canonical session exists, but its latest durable model tuple could not be verified without another ownership change",
		);
	}
	if (broadcastModelState) broadcastTuple(candidate, currentDurable, broadcastModelState, candidateState);
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
			broadcastTuple(session, correctionAfterFailure, broadcastModelState, liveAfterFailure);
		}
		return;
	}

	// Re-read both canonical bridge ownership and the latest durable tuple at the
	// last safe point before rollback. An in-place role replacement keeps the same
	// SessionInfo object, so bridge identity—not only session identity—is required.
	if (await retainVerifiedCanonicalReplacement(
		sessionManager,
		{ session, rpcClient: mutationRpcClient },
		broadcastModelState,
	)) return;

	const liveAfterFailure = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
	const correctionAfterFailure = completeTuple(liveAfterFailure) ?? durable;
	if (correctionAfterFailure && broadcastModelState) {
		broadcastTuple(session, correctionAfterFailure, broadcastModelState, liveAfterFailure);
	}

	if (durable) {
		try {
			const rolledBack = await rollbackRuntimeTuple(mutationRpcClient, durable);
			const rollbackState = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
			if (await retainVerifiedCanonicalReplacement(
				sessionManager,
				{ session, rpcClient: mutationRpcClient },
				broadcastModelState,
			)) return;
			if (broadcastModelState) broadcastTuple(session, rolledBack, broadcastModelState, rollbackState);
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
		{ session, rpcClient: mutationRpcClient },
		broadcastModelState,
	)) return;

	await sessionManager.restartAgent(session.id, { session, rpcClient: mutationRpcClient });
	const replacement = sessionManager.getSession(session.id);
	if (!replacement) throw new Error("runtime selection recovery restart returned no live session");
	const recoveryOwner: RuntimeRecoveryOwner = { session: replacement, rpcClient: replacement.rpcClient };
	try {
		const replacementState = await readRuntimeModelBridgeSnapshot(recoveryOwner.rpcClient);
		const replacementTuple = completeTuple(replacementState);
		if (!replacementTuple) throw new Error("runtime selection recovery restart state is incomplete or unreachable");
		if (durable && !tuplesEqual(replacementTuple, durable)) {
			throw new Error(
				`runtime selection recovery restart mismatch: expected ${durable.provider}/${durable.id}/${durable.thinkingLevel}, ` +
				`agent reports ${replacementTuple.provider}/${replacementTuple.id}/${replacementTuple.thinkingLevel}`,
			);
		}
		const currentDurable = persistedTuple(sessionManager, session.id, replacementState);
		if (!recoveryOwnerIsCanonical(sessionManager, recoveryOwner) || !currentDurable || !tuplesEqual(replacementTuple, currentDurable)) {
			throw new Error("runtime selection recovery restart was superseded before its complete durable tuple could be accepted");
		}
		if (broadcastModelState) broadcastTuple(replacement, replacementTuple, broadcastModelState, replacementState);
	} catch (recoveryError) {
		throw new OwnedRuntimeRecoveryError(recoveryError, recoveryOwner);
	}
}

function errorText(error: unknown): string {
	return sanitizeModelErrorText(error);
}

async function quarantineOwnedRuntimeSession(
	sessionManager: RuntimeModelSessionManager,
	owner: RuntimeRecoveryOwner,
): Promise<boolean> {
	// The comparison and coordinated termination admission are intentionally
	// synchronous. Once terminateSession is invoked, its existing replacement
	// coordinator owns terminal intent for this exact canonical bridge.
	if (!recoveryOwnerIsCanonical(sessionManager, owner)) return false;
	const terminated = await sessionManager.terminateSession(owner.session.id);
	if (terminated) return true;

	// terminateSession awaited. Never archive by id if a replacement acquired the
	// canonical slot while termination was settling.
	if (!recoveryOwnerIsCanonical(sessionManager, owner)) return false;
	if (await sessionManager.storeArchive(owner.session.id)) return true;
	throw new Error("the unsafe session could not be terminated or archived");
}

function staleRuntimeRecoveryFailure(error: unknown, recoveryError: unknown): Error {
	return new Error(
		`${errorText(error)}; stale runtime bridge recovery failed: ${errorText(recoveryError)}. ` +
		"The newer canonical session was retained; retry the selection after reconnecting.",
	);
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
	} catch (caughtRecoveryError) {
		if (caughtRecoveryError instanceof StaleRuntimeBridgeRecoveryError) {
			throw staleRuntimeRecoveryFailure(error, caughtRecoveryError);
		}

		const recoveryOwner = caughtRecoveryError instanceof OwnedRuntimeRecoveryError
			? caughtRecoveryError.owner
			: { session, rpcClient: mutationRpcClient };
		const recoveryError = caughtRecoveryError instanceof OwnedRuntimeRecoveryError
			? caughtRecoveryError.recoveryError
			: caughtRecoveryError;

		let quarantined: boolean;
		try {
			quarantined = await quarantineOwnedRuntimeSession(sessionManager, recoveryOwner);
		} catch (quarantineError) {
			throw new Error(
				`${errorText(error)}; runtime selection recovery failed: ${errorText(recoveryError)}; ` +
				`unsafe session quarantine failed: ${errorText(quarantineError)}`,
			);
		}
		if (quarantined) {
			throw new Error(
				`${errorText(error)}; runtime selection recovery failed: ${errorText(recoveryError)}. ` +
				"The session was terminated and archived because its runtime model state could not be verified; create a fresh session to continue.",
			);
		}

		try {
			const retained = await retainVerifiedCanonicalReplacement(
				sessionManager,
				recoveryOwner,
				broadcastModelState,
			);
			if (!retained) {
				throw new StaleRuntimeBridgeRecoveryError(
					"the recovery owner lost its canonical slot, but no newer canonical session was available to verify",
				);
			}
		} catch (staleError) {
			throw staleRuntimeRecoveryFailure(error, staleError);
		}
		throw staleRuntimeRecoveryFailure(error, recoveryError);
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

function resolveRequestedThinkingLevel(
	requestedThinkingLevel: string | undefined,
	currentThinkingLevel: ThinkingLevel | undefined,
): ThinkingLevel {
	const requested = requestedThinkingLevel === undefined
		? currentThinkingLevel
		: isKnownThinkingLevel(requestedThinkingLevel);
	if (!requested) {
		throw new Error(`Unknown or unverifiable thinking level "${requestedThinkingLevel ?? "?"}"`);
	}
	return requested;
}

function effectiveSdkThinkingLevel(requested: ThinkingLevel, current: RuntimeModelSnapshot): ThinkingLevel {
	// Capability metadata dies with the SDK Query. Absent metadata is deliberately
	// conservative: older SDKs may always disable thinking, but `off` remains an
	// explicit and supported setMaxThinkingTokens(null) operation. Unlike Pi's
	// sparse maps, SDK maps list only levels the initialized Query advertised.
	if (!current.thinkingLevelMap) {
		if (requested === "off") return requested;
		throw new Error(`Thinking level "${requested}" is unavailable for ${current.provider ?? "claude-agent-sdk"}/${current.id ?? "?"}`);
	}
	if (current.thinkingLevelMap[requested] === undefined || current.thinkingLevelMap[requested] === null) {
		throw new Error(`Thinking level "${requested}" is unavailable for ${current.provider}/${current.id}`);
	}
	if (requested !== "off" && current.reasoning !== true) {
		throw new Error(`Thinking level "${requested}" is unavailable for ${current.provider}/${current.id}`);
	}
	return requested;
}

function effectiveThinkingForSelection(
	requested: ThinkingLevel,
	selectedModel: Awaited<ReturnType<typeof requireSessionSelectableModel>>,
	liveModel?: RuntimeModelSnapshot | null,
): ThinkingLevel {
	if (liveModel?.provider === "claude-agent-sdk") return effectiveSdkThinkingLevel(requested, liveModel);
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

function runtimeLabel(runtime: SessionRuntime): string {
	return runtime === "claude-agent-sdk" ? "Claude Agent SDK" : "Pi";
}

/**
 * Runtime is fixed when a live bridge starts. Reject a runtime change before
 * reading or mutating that bridge so recovery never touches an incompatible
 * process. The persisted model tuple wins over its denormalized runtime field.
 */
function currentRuntimeForModelSelection(
	sessionManager: RuntimeModelStateSessionManager,
	session: RuntimeModelSession,
): SessionRuntime {
	const persisted = sessionManager.getPersistedSession(session.id);
	return resolveSessionRuntime({
		modelProvider: persisted?.modelProvider,
		persistedRuntime: session.runtime ?? persisted?.runtime,
	});
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
	const requestedRuntime = resolveSessionRuntime({ modelProvider: provider });
	const currentRuntime = currentRuntimeForModelSelection(sessionManager, session);
	if (requestedRuntime !== currentRuntime) {
		throw new Error(
			`Cannot change a live session from ${runtimeLabel(currentRuntime)} to ${runtimeLabel(requestedRuntime)}. ` +
			`Create a new session with ${provider}/${modelId} instead.`,
		);
	}

	const mutationRpcClient = session.rpcClient;
	const liveBefore = await readRuntimeModelBridgeSnapshot(mutationRpcClient);
	const durable = persistedTuple(sessionManager, session.id, liveBefore);
	let mutationStarted = false;

	try {
		const selectedModel = await requireSessionSelectableModel(preferencesStore, provider, modelId);
		const requestedThinkingLevel = resolveRequestedThinkingLevel(
			thinkingLevel,
			durable?.thinkingLevel ?? liveBefore?.thinkingLevel,
		);
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
		// The configured picker remains the source for model availability. The live
		// SDK Query is the source for the selected model's thinking capabilities.
		const effectiveThinkingLevel = effectiveThinkingForSelection(requestedThinkingLevel, selectedModel, modelReadBack);
		const requested: RuntimeModelTuple = { provider, id: modelId, thinkingLevel: effectiveThinkingLevel };
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
		if (broadcastModelState) broadcastTuple(session, requested, broadcastModelState, finalState);
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
		const effectiveThinkingLevel = current.provider === "claude-agent-sdk"
			? effectiveSdkThinkingLevel(requested, liveBefore ?? {})
			: (() => {
				const meta = resolveModelStateMeta(current.provider, current.id);
				return clampThinkingLevel(requested, {
					provider: current.provider,
					id: current.id,
					reasoning: meta.reasoning,
					thinkingLevelMap: meta.thinkingLevelMap,
				});
			})();
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
		if (broadcastModelState) broadcastTuple(session, expected, broadcastModelState, finalState);
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
