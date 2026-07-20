import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { SessionManager } from "../agent/session-manager.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "../agent/cpu-diagnostics.js";
import { spliceInFlightMessage, spliceInFlightSteers } from "../agent/splice-inflight-message.js";
import type { RateLimiter } from "../auth/rate-limit.js";
import { validateToken } from "../auth/token.js";
import type { SandboxTokenStore } from "../auth/sandbox-token.js";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { ChannelInfo, ClientMessage, HostChannelFrame, ServerMessage } from "./protocol.js";
import type { TaskState } from "../agent/task-store.js";
import { TaskManager } from "../agent/task-manager.js";
import { resolveSkillExpansions } from "../skills/resolve-skill-expansions.js";
import {
	FileMentionBudgetError,
	resolveFileMentions,
	toWireMention,
} from "../skills/resolve-file-mentions.js";
import { buildMergedModelText } from "../skills/merge-mentions.js";
import { resolveModelStateMeta } from "../agent/model-registry.js";
import { isKnownThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "../agent/thinking-level-clamp.js";
import { truncateLargeToolContentInMessages } from "../agent/truncate-large-content.js";
import { readSkillSidecarEntries, mergeSidecarEntriesIntoMessages } from "../skills/skill-sidecar.js";
import {
	appendCompactionSidecarEntry,
	makeCompactionId,
	mergeCompactionSidecarIntoMessages,
} from "../agent/compaction-sidecar.js";
import { EventBuffer } from "../agent/event-buffer.js";
import { latestRev, listProposalFiles, parseProposalFile } from "../proposals/proposal-files.js";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { ToolManager } from "../agent/tool-manager.js";
import { resolveActionToolManager } from "../extension-host/action-dispatcher.js";
import { resolvePackIdentityForTool } from "../extension-host/pack-identity.js";
import { mintSurfaceToken, resolveSurfaceIdentity } from "../extension-host/surface-binding.js";
import type { PackContributionResolver } from "../extension-host/pack-contribution-registry.js";
import { handleSessionPost } from "../extension-host/session-write.js";
import type { PreferencesStore } from "../agent/preferences-store.js";
import { applyRuntimeSessionModelSelection, broadcastRuntimeSessionActualModelState } from "./runtime-model-selection.js";
import { mintWritePermit, consumeWritePermit } from "../extension-host/session-write-permit.js";
import type { ActionGuardSession } from "../extension-host/action-guard.js";
import { decideResumeReplay, paceAndSend, RESUME_REPLAY_DRAIN_TIMEOUT_MS, PACE_TIMEOUT_MS, waitForReplayDrain } from "../replay-pacing.js";
import { SessionCommandSerialiser } from "./session-command-serialiser.js";

/**
 * Stamp `_order` on every message in a snapshot for the unified message
 * ordering reducer. Position-derived: index `i` gets `EventBuffer.SNAPSHOT_ORDER_FLOOR + i`,
 * which keeps every snapshot order strictly less than every live `seq` (live
 * seq starts at 1, snapshot floor is -1e9). Old clients ignore the field.
 * Accepts either a bare array or `{ messages: [...] }` shape; non-object
 * entries pass through untouched. Mutates messages in place for cheapness;
 * callers already produce fresh arrays via truncate/merge.
 * See docs/design/unified-message-ordering-reducer.md §3.1–3.2.
 */
function stampSnapshotOrder(data: unknown): unknown {
	const stamp = (arr: any[]): any[] => {
		for (let i = 0; i < arr.length; i++) {
			const m = arr[i];
			if (m && typeof m === "object") {
				(m as any)._order = EventBuffer.SNAPSHOT_ORDER_FLOOR + i;
			}
		}
		return arr;
	};
	if (Array.isArray(data)) return stamp(data);
	if (data && typeof data === "object" && Array.isArray((data as any).messages)) {
		stamp((data as any).messages);
	}
	return data;
}
// patchModelContextWindow removed — live model-state frames now resolve context
// windows, reasoning, and thinkingLevelMap via resolveModelStateMeta() (registry
// cache → pi-ai catalog → inferMeta), matching the ModelSelector dropdown.

/**
 * Merge persisted skill-expansion sidecar entries into a list of agent
 * messages. For each user message whose text body equals a sidecar
 * `modelText`, rewrite the body to `originalText` and attach
 * `skillExpansions` AND `fileMentions` (mirroring the live broadcast splice
 * in `spliceSkillExpansionsIntoEvent`, so @-mention chips survive reload /
 * the authoritative post-turn snapshot). Idempotent: messages without
 * matching sidecar entries pass through unchanged.
 */
function mergeSkillSidecarIntoMessages(sessionId: string, messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	const entries = readSkillSidecarEntries(sessionId);
	if (entries.length === 0) return messages;
	return mergeSidecarEntriesIntoMessages(entries, messages);
}

export interface LiveSnapshotTransformCollaborators {
	mergeCompactionSidecar?: (sessionId: string, messages: any[]) => any[];
	mergeSkillSidecar?: (sessionId: string, messages: any[]) => any[];
}

/**
 * Apply the mutable/live half of snapshot assembly to a fresh shallow copy.
 * The memoized base must never receive `_order`, overlay, truncation, or
 * sidecar mutations: cache hits deliberately rerun all of this work.
 */
export function applyLiveSnapshotTransforms(
	sessionId: string,
	session: { latestMessageUpdate?: { id?: string; message: any }; inFlightSteerTexts?: string[] },
	rawBase: any,
	collaborators: LiveSnapshotTransformCollaborators = {},
): any {
	const mergeCompaction = collaborators.mergeCompactionSidecar ?? mergeCompactionSidecarIntoMessages;
	const mergeSkill = collaborators.mergeSkillSidecar ?? mergeSkillSidecarIntoMessages;
	const cloneMessages = (messages: any[]): any[] => messages.map((message) =>
		message && typeof message === "object" ? { ...message } : message,
	);

	if (Array.isArray(rawBase)) {
		const base = cloneMessages(rawBase);
		const spliced = spliceInFlightSteers(
			spliceInFlightMessage(base, session.latestMessageUpdate),
			session.inFlightSteerTexts,
		);
		const withCompaction = mergeCompaction(sessionId, spliced);
		return mergeSkill(sessionId, truncateLargeToolContentInMessages(withCompaction));
	}
	if (rawBase && typeof rawBase === "object" && Array.isArray(rawBase.messages)) {
		const base = { ...rawBase, messages: cloneMessages(rawBase.messages) };
		const spliced = spliceInFlightSteers(
			spliceInFlightMessage(base.messages, session.latestMessageUpdate),
			session.inFlightSteerTexts,
		);
		const withCompaction = mergeCompaction(sessionId, spliced);
		const truncated = truncateLargeToolContentInMessages(withCompaction);
		const merged = mergeSkill(sessionId, truncated);
		return { ...base, messages: merged };
	}
	return rawBase;
}

const isPositiveNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Build the `state.model` payload for a live/rehydrated frame.
 *
 * Authoritative metadata (registry cache / pi-ai catalog) always wins so stale
 * or incorrect live frames get corrected — e.g. Claude Fable 5's 1M context,
 * `reasoning:true`, and `thinkingLevelMap {..., max:"max"}`.
 *
 * When the resolver only produced INFERRED defaults (custom / aigw / unknown
 * providers that legitimately fall through to `inferMeta`), those defaults must
 * NOT clobber more-accurate live fields already present on `base` (the agent's
 * live `state.model`). Inferred values are used only as a fallback for fields
 * the live frame does not already carry.
 */
export function buildResolvedModelStateModel(provider: string, id: string, base?: Record<string, unknown>): Record<string, unknown> {
	const meta = resolveModelStateMeta(provider, id);
	const model: Record<string, unknown> = {
		...(base ?? {}),
		provider,
		id,
	};
	const inferredFallback = meta.source === "inferred";

	// contextWindow / maxTokens: authoritative overwrites; inferred only fills gaps.
	model.contextWindow = inferredFallback && isPositiveNumber(base?.contextWindow)
		? base!.contextWindow
		: meta.contextWindow;
	model.maxTokens = inferredFallback && isPositiveNumber(base?.maxTokens)
		? base!.maxTokens
		: meta.maxTokens;

	// reasoning: authoritative overwrites; inferred keeps a live boolean when present.
	model.reasoning = inferredFallback && typeof base?.reasoning === "boolean"
		? base!.reasoning
		: meta.reasoning;

	// thinkingLevelMap: authoritative source is the sole owner. On inferred
	// fallback keep a live map when present (else drop it so the client applies
	// its family heuristic).
	if (meta.thinkingLevelMap) {
		model.thinkingLevelMap = meta.thinkingLevelMap;
	} else if (inferredFallback && base?.thinkingLevelMap && typeof base.thinkingLevelMap === "object") {
		model.thinkingLevelMap = base.thinkingLevelMap;
	} else {
		delete model.thinkingLevelMap;
	}
	return model;
}

function normalizeStateModelSnapshot(
	data: Record<string, unknown>,
	sessionManager: SessionManager,
	sessionId: string,
): Record<string, unknown> {
	const model = data.model;
	if (!model || typeof model !== "object") return data;
	const modelRecord = model as Record<string, unknown>;
	const persisted = sessionManager.getPersistedSession(sessionId);
	const provider = typeof modelRecord.provider === "string" ? modelRecord.provider : persisted?.modelProvider;
	const id = typeof modelRecord.id === "string" ? modelRecord.id : persisted?.modelId;
	if (!provider || !id) return data;
	return {
		...data,
		model: buildResolvedModelStateModel(provider, id, modelRecord),
	};
}

/** Send persisted model info as fallback when getState() is unavailable. */
function sendFallbackModelState(ws: WebSocket, sessionManager: SessionManager, sessionId: string): void {
	const persisted = sessionManager.getPersistedSession(sessionId);
	const data: Record<string, unknown> = {};
	if (persisted?.modelProvider && persisted?.modelId) {
		data.model = buildResolvedModelStateModel(persisted.modelProvider, persisted.modelId);
	}
	const imageModel = sessionManager.getImageModelForSession(sessionId);
	if (imageModel) {
		data.imageGenerationModel = imageModel;
	}
	const withCost = sessionManager.withSessionCostInState(sessionId, data) as Record<string, unknown>;
	if (Object.keys(withCost).length > 0) {
		send(ws, { type: "state", data: withCost });
	}
}

function sendImageModelState(ws: WebSocket, sessionManager: SessionManager, sessionId: string): void {
	const imageModel = sessionManager.getImageModelForSession(sessionId);
	if (imageModel) sendStateWithCost(ws, sessionManager, sessionId, { imageGenerationModel: imageModel });
}

function sendStateWithCost(ws: WebSocket, sessionManager: SessionManager, sessionId: string, data: unknown): void {
	send(ws, { type: "state", data: sessionManager.withSessionCostInState(sessionId, data) });
}

function sendSessionCostUpdate(ws: WebSocket, sessionManager: SessionManager, sessionId: string): void {
	const update = sessionManager.getSessionCostUpdate(sessionId);
	if (update) send(ws, update);
}

/**
 * Build a `state` payload for an archived session: archived metadata plus the
 * persisted model and image-generation model. Without this, the client falls
 * back to its hardcoded default placeholder model (e.g. claude-opus-4-6) until
 * the user reconnects, because archived sessions never receive a live
 * `getState()` push.
 */
function buildArchivedStateData(
	archived: { archivedAt?: number; title: string; modelProvider?: string; modelId?: string },
	sessionManager: SessionManager,
	sessionId: string,
): Record<string, unknown> {
	const data: Record<string, unknown> = {
		archived: true,
		archivedAt: archived.archivedAt,
		title: archived.title,
		status: "archived",
		statusVersion: 0,
	};
	if (archived.modelProvider && archived.modelId) {
		data.model = buildResolvedModelStateModel(archived.modelProvider, archived.modelId);
	}
	const imageModel = sessionManager.getImageModelForSession(sessionId);
	if (imageModel) data.imageGenerationModel = imageModel;
	return sessionManager.withSessionCostInState(sessionId, data) as Record<string, unknown>;
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	if (!cpuDiagnosticsEnabled()) {
		const data = JSON.stringify(msg);
		for (const client of clients) {
			if (client.readyState === 1) {
				client.send(data);
			}
		}
		return;
	}

	const stringifyStart = performance.now();
	const data = JSON.stringify(msg);
	const stringifyMs = performance.now() - stringifyStart;
	const sendStart = performance.now();
	let scanned = 0;
	let recipients = 0;
	let skipped = 0;
	for (const client of clients) {
		scanned++;
		if (client.readyState === 1) {
			client.send(data);
			recipients++;
		} else {
			skipped++;
		}
	}
	getCpuDiagnostics().recordWsBroadcast("ws-handler:broadcast", (msg as { type?: string }).type || "unknown", {
		frames: 1,
		scanned,
		recipients,
		skipped,
		bytes: Buffer.byteLength(data) * recipients,
		stringifyMs,
		sendMs: performance.now() - sendStart,
	});
}

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState === 1) {
		ws.send(JSON.stringify(msg));
	}
}

function sendAsync(ws: WebSocket, msg: ServerMessage): Promise<void> {
	if (ws.readyState !== 1) return Promise.reject(new Error("websocket is not open"));
	return new Promise((resolve, reject) => {
		ws.send(JSON.stringify(msg), (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function getViewerGoalIds(ws: WebSocket): Set<string> {
	const existing = (ws as any).viewerGoalIds;
	if (existing instanceof Set) return existing;
	const next = new Set<string>();
	(ws as any).viewerGoalIds = next;
	return next;
}

function handleViewerMessage(ws: WebSocket, msg: ClientMessage): void {
	const viewerMsg = msg as unknown as { type?: string; goalId?: unknown };
	if (viewerMsg.type === "subscribe_goal") {
		if (typeof viewerMsg.goalId === "string" && viewerMsg.goalId.trim()) {
			getViewerGoalIds(ws).add(viewerMsg.goalId);
		}
		return;
	}
	if (viewerMsg.type === "unsubscribe_goal") {
		if (typeof viewerMsg.goalId === "string") getViewerGoalIds(ws).delete(viewerMsg.goalId);
		return;
	}
	if (viewerMsg.type === "clear_goal_subscriptions") {
		getViewerGoalIds(ws).clear();
		return;
	}
	if (viewerMsg.type === "ping") {
		send(ws, { type: "pong" });
	}
}

function getClientIp(req: IncomingMessage): string {
	return req.socket.remoteAddress || "unknown";
}

type ChannelOpenPermitBinding = {
	sessionId: string;
	packId: string;
	contributionId: string;
	channelName: string;
	singletonKey?: string;
};

type ChannelOpenPermitService = {
	mint(binding: ChannelOpenPermitBinding): string;
	consume?(openPermit: string | undefined, binding: ChannelOpenPermitBinding): unknown;
};

type ExtensionChannelClient = {
	onFrame(frame: HostChannelFrame): void | Promise<void>;
	onClose(ev: { reason?: string; error?: string }): void;
};

type ChannelContributionLike = { name: string; protocol?: string; module?: string; handler?: string; quotas?: unknown; capabilities?: unknown };

type ExtensionChannelRegistry = {
	open(input: { sessionId: string; projectId?: string; packId: string; contribution: ChannelContributionLike & { contributionId: string }; init?: { data?: unknown; singletonKey?: string }; openPermit: string; clientId: string; client: ExtensionChannelClient }): Promise<ChannelInfo> | ChannelInfo;
	attach(input: { sessionId: string; packId: string; channelId: string; clientId: string; client: ExtensionChannelClient }): Promise<ChannelInfo> | ChannelInfo;
	list(input: { sessionId: string; packId: string; clientId?: string; name?: string; includeClosed?: boolean }): Promise<ChannelInfo[]> | ChannelInfo[];
	send(input: { sessionId: string; packId: string; channelId: string; clientId: string; frame: HostChannelFrame }): Promise<void> | void;
	close(input: { sessionId: string; packId: string; channelId: string; clientId?: string; reason?: string }): Promise<void> | void;
	detach(input: { sessionId: string; packId: string; channelId: string; clientId?: string }): Promise<void> | void;
};

const MAX_EXTENSION_CHANNEL_WS_ENVELOPE_BYTES = 1024 * 1024;
const MAX_UNAUTHENTICATED_WS_ENVELOPE_BYTES = 1024 * 1024;
/** Generic authenticated text ceiling for prompts, steers, and pack posts. */
export const MAX_AUTHENTICATED_PROMPT_TEXT_BYTES = 8 * 1024 * 1024;
const SESSION_COMMAND_SERIALISER = new SessionCommandSerialiser();
const EXTENSION_CHANNEL_WS_ENVELOPE_TOO_LARGE_MESSAGE = `Extension channel frame exceeds maximum envelope size (${MAX_EXTENSION_CHANNEL_WS_ENVELOPE_BYTES} bytes)`;

type ExtensionChannelClientMessageType = Extract<ClientMessage, { type: `ext_channel_${string}` }>['type'];

const EXTENSION_CHANNEL_CLIENT_MESSAGE_TYPES: ReadonlySet<ExtensionChannelClientMessageType> = new Set([
	"ext_channel_open_grant",
	"ext_channel_open",
	"ext_channel_attach",
	"ext_channel_list",
	"ext_channel_send",
	"ext_channel_close",
	"ext_channel_detach",
]);

function rawWsMessageBytes(data: unknown): number {
	if (Array.isArray(data)) return data.reduce((sum, part) => sum + rawWsMessageBytes(part), 0);
	if (typeof data === "string") return Buffer.byteLength(data);
	if (Buffer.isBuffer(data)) return data.byteLength;
	if (data instanceof ArrayBuffer) return data.byteLength;
	if (ArrayBuffer.isView(data)) return data.byteLength;
	return Buffer.byteLength(String(data));
}

function isExtensionChannelClientMessageType(type: unknown): type is ExtensionChannelClientMessageType {
	return typeof type === "string" && EXTENSION_CHANNEL_CLIENT_MESSAGE_TYPES.has(type as ExtensionChannelClientMessageType);
}

function isHostChannelFrame(frame: unknown): frame is HostChannelFrame {
	if (!frame || typeof frame !== "object") return false;
	const f = frame as { kind?: unknown; data?: unknown };
	return (f.kind === "text" && typeof f.data === "string")
		|| (f.kind === "json" && Object.prototype.hasOwnProperty.call(f, "data") && f.data !== undefined);
}

export function handleWebSocketConnection(
	ws: WebSocket,
	sessionId: string,
	req: IncomingMessage,
	sessionManager: SessionManager,
	authToken: string,
	rateLimiter: RateLimiter,
	projectConfigStore?: { get(key: string): string | undefined },
	skipAuth = false,
	sandboxTokenStore?: SandboxTokenStore,
	projectContextManager?: ProjectContextManager,
	toolManager?: ToolManager,
	packContributionRegistry?: PackContributionResolver,
	preferencesStore?: PreferencesStore,
	channelRegistry?: ExtensionChannelRegistry,
	channelOpenPermits?: ChannelOpenPermitService,
): void {
	const ip = getClientIp(req);
	let authenticated = false;
	const clientId = randomUUID();
	const commandSerialisationKey = sessionId === "__viewer__"
		? `viewer:${clientId}`
		: `session:${sessionId}`;
	let surfaceTokenAuthorityKey: string | undefined;
	const attachedExtChannels = new Map<string, { sessionId: string; packId: string }>();

	const sendCommandFailure = (err: unknown): void => {
		send(ws, { type: "error", message: String(err), code: "COMMAND_ERROR" });
	};

	const rejectInvalidPromptText = (msg: ClientMessage): boolean => {
		if (msg.type !== "prompt" && msg.type !== "steer" && msg.type !== "ext_session_post") {
			return false;
		}
		const promptText = (msg as { text?: unknown }).text;
		const invalid = typeof promptText !== "string";
		const tooLarge = !invalid && Buffer.byteLength(promptText, "utf8") > MAX_AUTHENTICATED_PROMPT_TEXT_BYTES;
		if (!invalid && !tooLarge) return false;

		const code = invalid ? "INVALID_PROMPT_TEXT" : "PROMPT_TOO_LARGE";
		const message = invalid
			? "Prompt text must be a string"
			: `Prompt text exceeds maximum size (${MAX_AUTHENTICATED_PROMPT_TEXT_BYTES} UTF-8 bytes)`;
		if (msg.type === "ext_session_post") {
			const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
			send(ws, { type: "ext_session_post_result", requestId, ok: false, error: code });
		} else {
			send(ws, { type: "error", message, code });
		}
		return true;
	};

	const sendExtChannelFailure = (requestId: string, err: unknown, fallback = "channel operation failed"): void => {
		const record = err as { code?: unknown; status?: unknown; message?: unknown };
		const message = typeof record?.message === "string" && record.message.length > 0 ? record.message : fallback;
		const error = typeof record?.code === "string" && record.code.length > 0 ? record.code : message;
		const status = typeof record?.status === "number" ? record.status : undefined;
		send(ws, { type: "ext_channel_result", requestId, ok: false, error, message, status });
	};
	const sendExtChannelEnvelopeTooLarge = (msg: Extract<ClientMessage, { type: `ext_channel_${string}` }>): void => {
		const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
		if (!requestId) {
			send(ws, { type: "error", message: EXTENSION_CHANNEL_WS_ENVELOPE_TOO_LARGE_MESSAGE, code: "FRAME_TOO_LARGE" });
			return;
		}
		if (msg.type === "ext_channel_open_grant") {
			send(ws, { type: "ext_channel_open_grant_result", requestId, ok: false, error: "FRAME_TOO_LARGE" });
			return;
		}
		send(ws, {
			type: "ext_channel_result",
			requestId,
			ok: false,
			error: "FRAME_TOO_LARGE",
			message: EXTENSION_CHANNEL_WS_ENVELOPE_TOO_LARGE_MESSAGE,
			status: 413,
		});
	};

	// 5-second window to authenticate before disconnection
	const authTimeout = setTimeout(() => {
		if (!authenticated) {
			ws.close(4001, "Auth timeout");
		}
	}, 5000);

	const handleMessage = async (msg: ClientMessage, frameBytes: number): Promise<void> => {
		// First message must be auth
		if (!authenticated) {
			if (msg.type !== "auth") {
				ws.close(4002, "Auth required");
				return;
			}

			if (!skipAuth) {
				if (rateLimiter.isRateLimited(ip)) {
					ws.close(4003, "Rate limited");
					return;
				}

				// Admin token first, then sandbox token
				if (!validateToken(msg.token, authToken)) {
					const scope = sandboxTokenStore?.lookup(msg.token);
					if (!scope) {
						rateLimiter.recordFailure(ip);
						console.log(`[gateway] Auth failed from ${ip}`);
						send(ws, { type: "auth_failed" });
						ws.close(4004, "Invalid token");
						return;
					}
					// Sandbox token must match a session in the project scope
					if (!scope.sessionIds.has(sessionId)) {
						console.log(`[gateway] Sandbox token denied for session ${sessionId} (project: ${scope.projectId})`);
						send(ws, { type: "auth_failed" });
						ws.close(4003, "Session not in sandbox scope");
						return;
					}
				}
			}

			clearTimeout(authTimeout);
			authenticated = true;
			(ws as any).authenticated = true;

			// Viewer-only connection (no session) — used by goal dashboard for live events
			if (sessionId === "__viewer__") {
				(ws as any).isViewer = true;
				(ws as any).viewerGoalIds = new Set<string>();
				const initialGoalId = (msg as unknown as { goalId?: unknown }).goalId;
				if (typeof initialGoalId === "string" && initialGoalId.trim()) {
					getViewerGoalIds(ws).add(initialGoalId);
				}
				send(ws, { type: "auth_ok" });
				// Do NOT set (ws as any).sessionId — goal broadcasts identify viewer sockets explicitly.
				// Viewer sockets are read-only except for explicit goal subscription messages.
				return;
			}

			const session = sessionManager.getSession(sessionId);
			if (!session) {
				// Check if it's an archived session
				const archived = sessionManager.getArchivedSession(sessionId);
				if (archived) {
					(ws as any).sessionId = sessionId;
					(ws as any).isArchived = true;
					send(ws, { type: "auth_ok" });
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					send(ws, { type: "session_status", status: "archived", statusVersion: 0, archivedAt: archived.archivedAt });
					send(ws, { type: "session_title", sessionId, title: archived.title });
					// Push persisted model + image model immediately. Without this, the
					// client renders its hardcoded default model (claude-opus-4-6) in
					// the footer picker until the user reconnects (which retriggers
					// `get_state`). The archived `get_state` handler below produces
					// the same payload — keep them in sync via buildArchivedStateData.
					send(ws, { type: "state", data: buildArchivedStateData(archived, sessionManager, sessionId) });
					return;
				}
				send(ws, { type: "error", message: "Session not found", code: "SESSION_NOT_FOUND" });
				ws.close(4005, "Session not found");
				return;
			}

			// Register client in session. Server-level broadcast helpers use this
			// tag to avoid falling back regular session sockets into unrelated goal
			// dashboard events.
			(ws as any).sessionId = sessionId;
			sessionManager.addClient(sessionId, ws);

			// Pack-bound surface-token minting uses an app-connection protocol key so
			// sanctioned Host API calls bind to this authenticated session and an active
			// pack contribution. `clientKind` is routing/product metadata, not a browser
			// security boundary against same-origin code that already has the bearer token.
			// Authority is per app connection, not singleton per session, so multiple tabs
			// can each mint scoped pack surface tokens without stealing lifecycle state.
			const authMsg = msg as Extract<ClientMessage, { type: "auth" }>;
			if (authMsg.clientKind === "app") {
				surfaceTokenAuthorityKey = randomUUID();
			}

			// The sanctioned C2 session WRITE (`host.session.postMessage`) path is driven
			// over this authenticated connection (see `ext_session_post` below). Server-side
			// session binding, surface-token resolution, and one-time content-bound permits
			// are the authorization/provenance checks; the WS client kind is not a durable
			// same-origin security boundary.
			send(ws, { type: "auth_ok", ...(surfaceTokenAuthorityKey ? { surfaceTokenKey: surfaceTokenAuthorityKey } : {}) });
			sendSessionCostUpdate(ws, sessionManager, sessionId);

			// Notify about compaction immediately (before any awaits) so the
			// client sets _isCompacting before a racing get_messages response.
			if (session.isCompacting) {
				send(ws, { type: "event", data: { type: "compaction_start" } });
			}

			// Send current agent state (don't block auth on this — fire async
			// so the client gets auth_ok immediately and can start rendering).
			// Skip for "preparing" sessions (agent not launched yet) and fresh
			// sessions with no history (avoids sending getState ahead of the
			// user's first prompt on the agent's sequential RPC pipeline).
			if (session.status !== "preparing" && session.eventBuffer.size > 0) {
				const diagEnabled = cpuDiagnosticsEnabled();
				const diagStart = diagEnabled ? performance.now() : 0;
				session.rpcClient.getState().then((stateResponse) => {
					if (diagEnabled) {
						getCpuDiagnostics().recordTimer("ws-handler:attachGetState", performance.now() - diagStart, { success: stateResponse.success ? 1 : 0 });
					}
					if (stateResponse.success) {
						// Splice canonical session status + version so the client's `case "state"`
						// can prime `_lastStatusVersion` from the snapshot.
						const spliced = normalizeStateModelSnapshot(
							{ ...(stateResponse.data as Record<string, unknown> | undefined ?? {}), status: session.status, statusVersion: session.statusVersion ?? 0 },
							sessionManager,
							sessionId,
						);
						sendStateWithCost(ws, sessionManager, sessionId, spliced);
						sendImageModelState(ws, sessionManager, sessionId);
						// If agent state lacks model info, supplement with persisted data
						const data = stateResponse.data as Record<string, unknown> | undefined;
						if (!data?.model) {
							sendFallbackModelState(ws, sessionManager, sessionId);
						}
					} else {
						sendFallbackModelState(ws, sessionManager, sessionId);
					}
				}).catch(() => {
					if (diagEnabled) getCpuDiagnostics().recordTimer("ws-handler:attachGetState", performance.now() - diagStart, { errors: 1 });
					sendFallbackModelState(ws, sessionManager, sessionId);
				});
			} else {
				// Session preparing or dormant — send persisted model info immediately
				sendFallbackModelState(ws, sessionManager, sessionId);
			}

			// Notify other clients that a new device connected
			const joinMsg: ServerMessage = { type: "client_joined", clientId };
			const joinData = JSON.stringify(joinMsg);
			for (const client of session.clients) {
				if (client !== ws && client.readyState === 1) {
					client.send(joinData);
				}
			}

			send(ws, { type: "session_status", status: session.status, statusVersion: session.statusVersion ?? 0, ...(session.streamingStartedAt ? { streamingStartedAt: session.streamingStartedAt } : {}) });
			send(ws, { type: "session_title", sessionId, title: session.title });
			send(ws, { type: "queue_update", sessionId, queue: session.promptQueue.toArray() });

			// Rehydrate any on-disk proposal drafts for this session so the
			// client can rebuild its activeProposals slot after a server restart
			// or fresh attach. Fire-and-forget; never blocks auth.
			(async () => {
				try {
					const stateDir = bobbitStateDir();
					const types = await listProposalFiles(stateDir, sessionId);
					for (const proposalType of types) {
						const parsed = await parseProposalFile(stateDir, sessionId, proposalType);
						if (parsed.ok) {
							const rev = await latestRev(stateDir, sessionId, proposalType);
							send(ws, {
								type: "proposal_update",
								sessionId,
								proposalType,
								fields: parsed.value.fields,
								rev,
								streaming: false,
								source: "rehydrate",
							});
						}
					}
				} catch (err) {
					console.warn(`[ws] proposal rehydrate failed for ${sessionId}:`, err);
				}
			})();

			// If there's a pending tool permission request, replay it to the new
			// client. We REUSE the original broadcast's seq/ts (stashed on the
			// pending-grant record) instead of allocating a fresh seq — a fresh
			// unicast seq would leave already-attached clients gap-buffering the
			// next live event forever. Pinned by
			// tests/perm-frame-late-joiner-seq-gap.test.ts.
			const pendingPerm = sessionManager.getPendingToolPermission(sessionId);
			if (pendingPerm) {
				send(ws, { type: "tool_permission_needed", ...pendingPerm });
			}
			return;
		}

		if (isExtensionChannelClientMessageType(msg.type) && frameBytes > MAX_EXTENSION_CHANNEL_WS_ENVELOPE_BYTES) {
			sendExtChannelEnvelopeTooLarge(msg as Extract<ClientMessage, { type: `ext_channel_${string}` }>);
			return;
		}

		// Viewer-only connections receive project broadcasts plus explicitly subscribed goal broadcasts.
		if ((ws as any).isViewer) {
			handleViewerMessage(ws, msg);
			return;
		}

		// Handle archived session commands (read-only)
		if ((ws as any).isArchived) {
			switch (msg.type) {
				case "get_state": {
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					const archived = sessionManager.getArchivedSession(sessionId);
					if (archived) {
						send(ws, { type: "state", data: buildArchivedStateData(archived, sessionManager, sessionId) });
					}
					break;
				}
				case "get_messages": {
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					const messages = await sessionManager.getArchivedMessages(sessionId);
					send(ws, { type: "messages", data: stampSnapshotOrder(messages) as unknown[] });
					break;
				}
				case "ping":
					send(ws, { type: "pong" });
					break;
				default:
					send(ws, { type: "error", message: "This session is archived (read-only)", code: "SESSION_ARCHIVED" });
			}
			return;
		}

		// Authenticated — route commands to agent
		const session = sessionManager.getSession(sessionId);
		if (!session) {
			send(ws, { type: "error", message: "Session not found", code: "SESSION_NOT_FOUND" });
			return;
		}

		// Block commands while session is still preparing (worktree being created)
		// or starting (agent process launched but setup commands still running).
		// Return safe responses for read-only commands; let prompts through to
		// be queued (they'll drain when the session becomes idle).
		if (session.status === "preparing" || session.status === "starting") {
			switch (msg.type) {
				case "ping":
					send(ws, { type: "pong" });
					return;
				case "get_state":
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					sendStateWithCost(ws, sessionManager, sessionId, { preparing: true });
					return;
				case "get_messages":
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					send(ws, { type: "messages", data: stampSnapshotOrder([]) as unknown[] });
					return;
				case "prompt":
					// Allow prompts — they'll be queued by enqueuePrompt since status != idle
					break;
				case "ext_surface_token":
					// Pack-bound Host API calls (session-menu launchers, panels) may be clicked
					// while a newly-created session is still preparing. Surface-token minting is
					// authorization-only and does not touch the agent turn, so let it proceed;
					// the subsequent scoped REST/route call carries the minted token and remains
					// server-authorized. Blocking this frame makes launchers hang waiting for an
					// ext_surface_token_result that never arrives.
					break;
				default:
					send(ws, { type: "error", message: "Session is still being set up", code: "SESSION_PREPARING" });
					return;
			}
		}

		try {
			const mintPackSurfaceToken = (tokenMsg: Extract<ClientMessage, { type: "ext_surface_token" }>): { ok: true; token: string } | { ok: false; error: string } => {
				if (!surfaceTokenAuthorityKey || tokenMsg.surfaceTokenKey !== surfaceTokenAuthorityKey) {
					return { ok: false, error: "pack-bound surface-token mint requires app surface-token key" };
				}
				const packId = typeof tokenMsg.packId === "string" ? tokenMsg.packId : "";
				const contributionKind = typeof tokenMsg.contributionKind === "string" ? tokenMsg.contributionKind : "";
				const contributionRef = typeof tokenMsg.contributionId === "string" ? tokenMsg.contributionId : "";
				if (contributionKind !== "panel" && contributionKind !== "entrypoint" && contributionKind !== "route") return { ok: false, error: "invalid contributionKind" };
				if (!packId || !contributionRef) return { ok: false, error: "packId and contributionId are required" };
				if (!packContributionRegistry) return { ok: false, error: "surface tokens are available only to installed, active pack contributions" };
				const pack = packContributionRegistry.getPack(session.projectId, packId);
				let exists = false;
				if (pack) {
					if (contributionKind === "panel") exists = !!packContributionRegistry.getPanel(session.projectId, packId, contributionRef);
					else if (contributionKind === "entrypoint") exists = !!packContributionRegistry.getEntrypoint(session.projectId, packId, contributionRef);
					else exists = packContributionRegistry.hasRoute(session.projectId, packId, contributionRef);
				}
				if (!pack || !exists) return { ok: false, error: "surface tokens are available only to installed, active pack contributions" };
				return { ok: true, token: mintSurfaceToken({ sessionId, packId, contributionId: `${contributionKind}:${contributionRef}` }) };
			};
			const resolveExtChannelSurface = (surfaceToken: unknown): ReturnType<typeof resolveSurfaceIdentity> => {
				const projectTm = session.projectId && projectContextManager
					? projectContextManager.getOrCreate(session.projectId)?.toolManager
					: undefined;
				const extToolManager = toolManager
					? resolveActionToolManager(toolManager, projectTm)
					: projectTm;
				return extToolManager
					? resolveSurfaceIdentity({ token: surfaceToken, headerSessionId: sessionId, resolver: extToolManager, contributions: packContributionRegistry, projectId: session.projectId })
					: ({ ok: false, status: 403, error: "channels are available only to market-pack contributions" } as const);
			};
			const hasChannelContribution = (packId: string, name: string): boolean => {
				const resolver = packContributionRegistry as (PackContributionResolver & { getChannel?: (projectId: string | undefined, packId: string, name: string) => unknown }) | undefined;
				if (!resolver?.getChannel) return true; // Core schema branch supplies this; until then registry.open remains authoritative.
				return !!resolver.getChannel(session.projectId, packId, name);
			};
			switch (msg.type) {
				case "ext_surface_token": {
					const tokenMsg = msg as Extract<ClientMessage, { type: "ext_surface_token" }>;
					const requestId = typeof tokenMsg.requestId === "string" ? tokenMsg.requestId : "";
					const minted = mintPackSurfaceToken(tokenMsg);
					if (minted.ok) send(ws, { type: "ext_surface_token_result", requestId, ok: true, token: minted.token });
					else send(ws, { type: "ext_surface_token_result", requestId, ok: false, error: minted.error });
					break;
				}
				case "prompt": {
					// The prompt text is rendered in the UI transcript — debug-only here.
					if (process.env.BOBBIT_DEBUG) console.log(`[ws-handler] Prompt received: text="${msg.text?.substring(0, 50)}...", images=${msg.images?.length ?? 0}`);

					// Resolve per-project config store and host-side cwd for skill lookup.
					// For sandbox sessions, session.cwd is a container-internal path
					// (e.g. /workspace-wt/<branch>) that doesn't exist on the host.
					// Skill discovery runs on the host, so fall back to the project's
					// rootPath for sandboxed sessions.
					let resolvedConfigStore = projectConfigStore;
					let skillCwd = session.cwd;
					if (session.projectId && projectContextManager) {
						const ctx = projectContextManager.getOrCreate(session.projectId);
						if (ctx) {
							resolvedConfigStore = ctx.projectConfigStore;
							if (session.sandboxed) {
								skillCwd = ctx.project.rootPath;
							}
						}
					}

					const sandboxPathRewrite = session.sandboxed
						? (hostPath: string): string | null => {
							const normHost = hostPath.replace(/\\/g, "/");
							const projectRoot = (session.projectId && projectContextManager)
								? projectContextManager.getOrCreate(session.projectId)?.project.rootPath?.replace(/\\/g, "/")
								: undefined;
							const sessionCwdNorm = session.cwd.replace(/\\/g, "/");
							for (const candidate of [projectRoot, sessionCwdNorm]) {
								if (candidate && (normHost === candidate || normHost.startsWith(candidate + "/"))) {
									const rel = normHost.slice(candidate.length).replace(/^\/+/, "");
									return "/workspace" + (rel ? "/" + rel : "");
								}
							}
							return null;
						}
						: undefined;
					const { originalText, expansions, unknown } = resolveSkillExpansions(
						msg.text,
						skillCwd,
						resolvedConfigStore,
						sandboxPathRewrite,
					);
					for (const name of unknown) {
						console.warn(`[ws-handler] Slash skill "${name}" not found for session ${sessionId} (cwd=${session.cwd})`);
					}
					if (expansions.length > 0) {
						console.log(`[ws-handler] Resolved ${expansions.length} slash-skill expansion(s) for session ${sessionId}`);
					}

					// Resolve `@path` file mentions on the SAME verbatim text. The
					// `/` and `@` token sets are disjoint by construction, so the
					// two resolvers never produce overlapping ranges. Genuine
					// absence stays plain text without a warning; only an existing
					// target that later fails delivery stays literal and warns.
					//
					// IMPORTANT: file mentions resolve against the session's HOST
					// worktree, NOT skillCwd. skillCwd redirects to the project
					// rootPath for SKILL discovery (correct there), but that tree
					// misses the goal/session worktree's branch-local, untracked
					// and gitignored files. worktreePath is the host path; for
					// sandboxed sessions session.cwd is a container path, so
					// worktreePath is required to reach the real files.
					const fileMentionCwd = session.worktreePath || session.cwd;
					const fileMentionResult = await resolveFileMentions(
						msg.text,
						fileMentionCwd,
					).catch((error: unknown) => {
						if (error instanceof FileMentionBudgetError) {
							send(ws, { type: "error", message: error.message, code: error.code });
							return undefined;
						}
						throw error;
					});
					if (!fileMentionResult) return;
					for (const w of fileMentionResult.warnings) {
						console.warn(`[ws-handler] File mention ${w} (session ${sessionId}, cwd=${fileMentionCwd})`);
					}
					if (fileMentionResult.mentions.length > 0) {
						console.log(`[ws-handler] Resolved ${fileMentionResult.mentions.length} file mention(s) for session ${sessionId}`);
					}

					// Merge skill expansions + text file mentions into one
					// right-to-left splice over the original text. Prefix-only
					// slash skills overlap any @file token; on overlap the skill
					// wins and the file mention is not inlined (chip still
					// renders). See buildMergedModelText for the full rationale.
					const mergedModelText = buildMergedModelText(originalText, expansions, fileMentionResult.mentions);

					// Route image mentions through the image frame and binary
					// mentions through the document-attachment pipeline (text
					// mentions are inlined into modelText above). Binary mentions
					// are attached for UI chip + snapshot parity with
					// user-uploaded documents; model-side delivery of document
					// bytes is an existing platform concern (the prompt RPC
					// carries text + images), NOT a regression of this feature.
					const sendImages = msg.images ? [...msg.images] : [];
					const sendAttachments = msg.attachments ? [...msg.attachments] : [];
					for (const mention of fileMentionResult.mentions) {
						if (mention.kind === "image" && mention.data && mention.mimeType) {
							sendImages.push({ type: "image", data: mention.data, mimeType: mention.mimeType });
						} else if (mention.kind === "binary" && mention.data) {
							const norm = mention.path.replace(/\\/g, "/");
							sendAttachments.push({
								id: `mention-${Date.now()}-${mention.range[0]}`,
								type: "document",
								fileName: norm.slice(norm.lastIndexOf("/") + 1) || norm,
								mimeType: mention.mimeType ?? "application/octet-stream",
								size: mention.bytes ?? 0,
								content: mention.data,
							});
						}
					}

					const hasFileMentions = fileMentionResult.mentions.length > 0;
					const modelChanged = mergedModelText !== originalText;

					// Strip the internal canonical `absPath` before the mention
					// crosses the wire / is persisted to the sidecar — the UI
					// never needs it and it would leak host filesystem layout.
					const wireFileMentions = hasFileMentions
						? fileMentionResult.mentions.map(toWireMention)
						: undefined;

					await sessionManager.enqueuePrompt(sessionId, originalText, {
						images: sendImages.length ? sendImages : undefined,
						attachments: sendAttachments.length ? sendAttachments : undefined,
						skillExpansions: expansions.length ? expansions : undefined,
						fileMentions: wireFileMentions,
						modelText: modelChanged ? mergedModelText : undefined,
						// Assistant auto-kickoff prompts opt out of first-message title-gen.
						suppressTitleGen: msg.suppressTitleGen === true,
					});
					break;
				}
				case "steer":
					// Live steer: if agent is streaming, send directly via RPC
					// (real-time interrupt, bypasses queue intentionally).
					// Otherwise enqueue as a steered message and drain if idle.
					if (session.status === "streaming") {
						await sessionManager.deliverLiveSteer(sessionId, msg.text);
					} else {
						await sessionManager.enqueuePrompt(sessionId, msg.text, { isSteered: true });
					}
					break;
				case "steer_queued":
					sessionManager.steerQueued(sessionId, msg.messageId);
					break;
				case "remove_queued":
					sessionManager.removeQueued(sessionId, msg.messageId);
					break;
				case "reorder_queue":
					sessionManager.reorderQueue(sessionId, msg.messageIds);
					break;
				case "abort":
					sessionManager.forceAbort(sessionId).catch((err) => {
						send(ws, { type: "error", message: `Abort failed: ${err}`, code: "ABORT_ERROR" });
					});
					break;
				case "retry":
					sessionManager.retryLastPrompt(sessionId).catch((err) => {
						send(ws, { type: "error", message: `Retry failed: ${err}`, code: "RETRY_ERROR" });
					});
					break;
				case "set_model":
					try {
						await applyRuntimeSessionModelSelection(sessionManager, session, msg.provider, msg.modelId, preferencesStore, broadcast);
					} catch (err: any) {
						// Surface set_model failures to the UI instead of silently swallowing
						// them — otherwise the client keeps showing the new model while the
						// agent stays bound to the previous one and subsequent prompts go
						// to the wrong model. First broadcast the authoritative actual model
						// so optimistic clients reconcile before seeing the failure banner.
						console.error(`[ws-handler] set_model failed for session ${session.id} (${msg.provider}/${msg.modelId}):`, err?.message || err);
						await broadcastRuntimeSessionActualModelState(sessionManager, session, broadcast);
						send(ws, { type: "error", message: `Failed to switch model: ${err?.message || err}`, code: "SET_MODEL_FAILED" });
					}
					break;
				case "set_image_model": {
					const provider = typeof msg.provider === "string" ? msg.provider : "";
					const modelId = typeof msg.modelId === "string" ? msg.modelId : "";
					if (!provider || !modelId || !sessionManager.isKnownImageModel(provider, modelId)) {
						// Defence-in-depth: reject unknown (provider, modelId) without
						// mutating session state. UI should never reach this branch
						// because picker only surfaces registry models.
						send(ws, { type: "error", message: "unknown image model", code: "UNKNOWN_IMAGE_MODEL" });
						break;
					}
					sessionManager.persistSessionImageModel(session.id, provider, modelId);
					broadcast(session.clients, {
						type: "state",
						data: { imageGenerationModel: { provider, id: modelId } },
					});
					break;
				}
				case "set_thinking_level": {
					// Defence in depth: drop unknown tokens; clamp against the
					// session's current model so xhigh on a non-supporting model
					// degrades to high (etc.) at the server boundary.
					const known = isKnownThinkingLevel(msg.level);
					if (!known) break;
					let level: string = known;
					const persisted = sessionManager.getPersistedSession(session.id);
					if (persisted?.modelId) {
						const clamped = clampThinkingLevelForModel(level, persisted.modelProvider, persisted.modelId);
						if (clamped) level = clamped;
					}
					await session.rpcClient.setThinkingLevel(level);
					break;
				}
				case "compact": {
					// Fire-and-forget: don't block the WS message loop.
					//
					// pi-coding-agent 0.74.0+ emits its OWN `compaction_start` and
					// `compaction_end` events from inside the compact() RPC, with
					// `reason: "manual"` and a full `result` payload. Those are
					// already broadcast to clients via session-manager's event
					// listener, and session-manager itself triggers
					// `refreshAfterCompaction` on the compaction_end branch.
					//
					// Re-broadcasting our own wrapper events here would land a
					// second `compaction_end` AFTER the agent's, transitioning the
					// card to "complete" twice and (because the agent's lands
					// before this handler finishes) showing the finished render
					// during the still-in-flight compaction. So we DO NOT
					// broadcast wrapper events here — we only need to:
					//   1. Flip `session.isCompacting` so server-side state matches.
					//   2. Append the manual sidecar row (session-manager skips
					//      manual on its own compaction_end branch).
					const startedAtMs = Date.now();
					const compactionId = makeCompactionId(startedAtMs);
					session.isCompacting = true;
					// Stash the shared compactionId on the session BEFORE awaiting the
					// RPC so session-manager's manual `compaction_end` branch can stamp
					// the broadcast event with it. That lets the client's live
					// `compact_active` card mount the pre-compaction affordance in the
					// same session (it polls the sidecar, written below once the RPC
					// resolves).
					(session as any)._manualCompactionId = compactionId;
					(async () => {
						try {
							console.log(`[ws-handler] Starting manual compact for session ${sessionId}`);
							const compactResult = await session.rpcClient.compact(120_000);
							console.log(`[ws-handler] Compact RPC resolved for session ${sessionId}`);
							const endedAtMs = Date.now();
							session.isCompacting = false;
							// session-manager's manual `compaction_end` branch writes
							// the SUCCESS sidecar row synchronously BEFORE its
							// refreshAfterCompaction() so the post-compaction snapshot
							// carries the orphan-boundary anchor (otherwise the live
							// card stays positive-ordered and sorts after the preserved
							// tail). The agent emits that event before this RPC promise
							// resolves, so by here the row is already persisted. Skip our
							// own success append to avoid a duplicate sidecar line. We
							// only write here as a fallback when session-manager did NOT
							// (e.g. the agent emitted no successful manual compaction_end
							// with a result payload).
							const alreadyWritten = (session as any)._manualSidecarWritten === compactionId;
							(session as any)._manualSidecarWritten = undefined;
							if (!alreadyWritten) {
								const tokensBefore = compactResult?.data?.tokensBefore ?? null;
								const firstKeptEntryId = compactResult?.data?.firstKeptEntryId ?? null;
								// Persist the sidecar row so the card survives reload.
								appendCompactionSidecarEntry(sessionId, {
									schemaVersion: 1,
									id: compactionId,
									trigger: "manual",
									tokensBefore,
									tokensAfter: null,
									durationMs: endedAtMs - startedAtMs,
									startedAt: new Date(startedAtMs).toISOString(),
									endedAt: new Date(endedAtMs).toISOString(),
									success: true,
									firstKeptEntryId,
								});
							}
						} catch (err: any) {
							console.error(`[ws-handler] Compact failed for session ${sessionId}:`, err.message);
							const endedAtMs = Date.now();
							session.isCompacting = false;
							// RPC rejected: own the failure append. session-manager only
							// writes the success row, so clear the dedup marker defensively.
							(session as any)._manualSidecarWritten = undefined;
							appendCompactionSidecarEntry(sessionId, {
								schemaVersion: 1,
								id: compactionId,
								trigger: "manual",
								tokensBefore: null,
								tokensAfter: null,
								durationMs: endedAtMs - startedAtMs,
								startedAt: new Date(startedAtMs).toISOString(),
								endedAt: new Date(endedAtMs).toISOString(),
								success: false,
								error: err.message,
								firstKeptEntryId: null,
							});
						}
					})().catch((err) => {
						console.error(`[ws-handler] Unexpected compact error for session ${sessionId}:`, err);
					});
					break;
				}
				case "get_state": {
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					const diagEnabled = cpuDiagnosticsEnabled();
					const diagStart = diagEnabled ? performance.now() : 0;
					try {
						const stateResp = await session.rpcClient.getState();
						if (diagEnabled) {
							getCpuDiagnostics().recordTimer("ws-handler:getState", performance.now() - diagStart, { success: stateResp.success ? 1 : 0 });
						}
						if (stateResp.success) {
							// Splice canonical session status + version into the snapshot so
							// the client's `case "state"` can prime `_lastStatusVersion` from
							// the snapshot path (e.g. on reconnect via get_state).
							const spliced = normalizeStateModelSnapshot(
								{ ...(stateResp.data as Record<string, unknown> | undefined ?? {}), status: session.status, statusVersion: session.statusVersion ?? 0 },
								sessionManager,
								sessionId,
							);
							sendStateWithCost(ws, sessionManager, sessionId, spliced);
							sendImageModelState(ws, sessionManager, sessionId);
							// If agent state lacks model info, supplement with persisted data
							const data = stateResp.data as Record<string, unknown> | undefined;
							if (!data?.model) {
								sendFallbackModelState(ws, sessionManager, sessionId);
							}
						} else {
							sendFallbackModelState(ws, sessionManager, sessionId);
						}
					} catch {
						if (diagEnabled) getCpuDiagnostics().recordTimer("ws-handler:getState", performance.now() - diagStart, { errors: 1 });
						sendFallbackModelState(ws, sessionManager, sessionId);
					}
					break;
				}
				case "status_resync": {
					// Client detected a gap (statusVersion jumped). Send a fresh
					// `session_status` frame carrying the current status + version.
					// Indistinguishable from a heartbeat; client treats it idempotently.
					send(ws, {
						type: "session_status",
						status: session.status,
						statusVersion: session.statusVersion ?? 0,
						...(session.streamingStartedAt ? { streamingStartedAt: session.streamingStartedAt } : {}),
					});
					break;
				}
				case "get_messages": {
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					// Perf attribution (dev harness only): split the snapshot build
					// into agent RPC assembly vs. server transform vs. serialize, and
					// attach it to the frame so the client's boot-timing sample
					// captures it. See SnapshotServerTiming. Zero cost when off.
					const perf = process.env.BOBBIT_DEV_HARNESS === "1";
					const tStart = perf ? performance.now() : 0;
					const diagEnabled = cpuDiagnosticsEnabled();
					const diagStart = diagEnabled ? performance.now() : 0;
					const msgsResp = await sessionManager.getMessagesSnapshotBase(session);
					if (diagEnabled) {
						getCpuDiagnostics().recordTimer("ws-handler:getMessages", performance.now() - diagStart, { success: msgsResp.success ? 1 : 0 });
					}
					const tRpc = perf ? performance.now() : 0;
					if (msgsResp.success) {
						// The memo covers only RPC + normalization. Mutable overlays,
						// sidecars, truncation and order stamps are rebuilt on every hit.
						const data = applyLiveSnapshotTransforms(sessionId, session, msgsResp.data as any);
						const tPipeline = perf ? performance.now() : 0;
						const stamped = stampSnapshotOrder(data);
						const tStamp = perf ? performance.now() : 0;
						if (perf) {
							const arr = Array.isArray(stamped)
								? stamped
								: (stamped && Array.isArray((stamped as any).messages) ? (stamped as any).messages : []);
							const sStart = performance.now();
							const bytes = JSON.stringify(stamped).length;
							const stringifyMs = performance.now() - sStart;
							const r1 = (n: number) => Math.round(n * 10) / 10;
							send(ws, {
								type: "messages",
								data: stamped as unknown[],
								serverTiming: {
									rpcMs: r1(tRpc - tStart),
									pipelineMs: r1(tPipeline - tRpc),
									stampMs: r1(tStamp - tPipeline),
									stringifyMs: r1(stringifyMs),
									bytes,
									msgCount: arr.length,
								},
							});
						} else {
							send(ws, { type: "messages", data: stamped as unknown[] });
						}
					}
					break;
				}
				case "set_title":
					sessionManager.setTitle(sessionId, msg.title);
					break;
				case "generate_title":
					sessionManager.autoGenerateTitle(session).catch((err) => {
						send(ws, { type: "error", message: `Title generation failed: ${err}`, code: "TITLE_GEN_ERROR" });
					});
					break;
				case "summarize_goal_title": {
					const goalTitle = typeof msg.goalTitle === "string" ? msg.goalTitle.trim() : "";
					if (goalTitle.length >= 3) {
						sessionManager.generateGoalTitle(sessionId, goalTitle);
					}
					break;
				}
				case "task_create": {
					const tm = resolveTaskManagerForGoal(sessionManager, msg.goalId);
					const task = tm.createTask(
						msg.goalId,
						msg.title,
						msg.taskType,
						{ parentTaskId: msg.parentTaskId, spec: msg.spec, dependsOn: msg.dependsOn },
					);
					broadcast(session.clients, { type: "task_changed", task });
					break;
				}
				case "task_update": {
					let tm: TaskManager;
					try { tm = resolveTaskManagerForTask(sessionManager, msg.taskId); }
					catch { send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" }); break; }
					const updates = { ...msg.updates, state: msg.updates.state as TaskState | undefined };
					const updated = tm.updateTask(msg.taskId, updates);
					if (updated) {
						const task = tm.getTask(msg.taskId);
						broadcast(session.clients, { type: "task_changed", task });
					} else {
						send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" });
					}
					break;
				}
				case "task_delete": {
					let tm: TaskManager;
					try { tm = resolveTaskManagerForTask(sessionManager, msg.taskId); }
					catch { send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" }); break; }
					const task = tm.getTask(msg.taskId);
					if (task) {
						tm.deleteTask(msg.taskId);
						broadcast(session.clients, { type: "task_changed", task: { ...task, _deleted: true } });
					} else {
						send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" });
					}
					break;
				}
				case "grant_tool_permission": {
					sessionManager.grantToolPermission(sessionId, msg.toolName, msg.scope, msg.group, msg.mode, msg.permissionId).catch((err: any) => {
						const message = String(err?.message ?? err);
						if (message.startsWith("Ignored stale permission grant")) return;
						send(ws, { type: "error", message: `Grant failed: ${err}`, code: "GRANT_ERROR" });
					});
					break;
				}
				case "deny_tool_permission": {
					sessionManager.denyToolPermission(sessionId, msg.toolName, msg.permissionId);
					break;
				}
				case "restart_agent":
					sessionManager.restartAgent(sessionId).then(() => {
						// Refresh messages after restart so the client sees the full history
						const restored = sessionManager.getSession(sessionId);
						if (restored) {
							sessionManager.getMessagesSnapshotBase(restored)
								.then((msgs: any) => {
									if (!msgs) return;
									const raw = msgs.data ?? msgs;
									const data = applyLiveSnapshotTransforms(sessionId, restored, raw);
									send(ws, { type: "messages", data: stampSnapshotOrder(data) as unknown[] });
								})
								.catch(() => {});
						}
					}).catch((err: any) => {
						send(ws, { type: "error", message: `Restart failed: ${err}`, code: "RESTART_ERROR" });
					});
					break;
				case "ping":
					send(ws, { type: "pong" });
					break;
				case "resume": {
					sendSessionCostUpdate(ws, sessionManager, sessionId);
					// Client requesting resume-from-seq. If the requested seq is
					// still in the EventBuffer window, replay buffered entries as
					// individual {type:"event"} frames with their original seq/ts
					// so the client can dedupe. Otherwise signal a gap — the client
					// will fall back to a full get_messages snapshot. Replay is now
					// byte-budgeted and paced so reconnect cannot immediately rebuild
					// enough buffered output to trip the overflow guard again.
					const diagEnabled = cpuDiagnosticsEnabled();
					const diagStart = diagEnabled ? performance.now() : 0;
					let replayed = 0;
					const fromSeq = typeof msg.fromSeq === "number" ? msg.fromSeq : 0;
					const sendResumeGap = (_reason: string, bytes = 0) => {
						send(ws, { type: "resume_gap", lastSeq: session.eventBuffer.lastSeq });
						if (diagEnabled) {
							getCpuDiagnostics().recordWsBroadcast("ws-handler:resume", "resume_gap", { frames: 1, recipients: 1, bytes, replayed, gaps: 1, sendMs: performance.now() - diagStart });
						}
					};
					if (!session.eventBuffer.canResumeFrom(fromSeq)) {
						sendResumeGap("window_miss");
						break;
					}
					const frames = session.eventBuffer.since(fromSeq).map((entry) => {
						const frame = { type: "event" as const, data: entry.event, seq: entry.seq, ts: entry.ts };
						const data = JSON.stringify(frame);
						return { data, bytes: Buffer.byteLength(data) };
					});
					if (frames.length === 0) {
						if (diagEnabled) {
							getCpuDiagnostics().recordWsBroadcast("ws-handler:resume", "event", { frames: 0, recipients: 0, bytes: 0, replayed: 0, sendMs: performance.now() - diagStart });
						}
						break;
					}
					const decision = decideResumeReplay(frames);
					if (decision.kind === "resume_gap") {
						sendResumeGap(decision.reason, decision.bytes);
						break;
					}
					const drained = await waitForReplayDrain(
						ws as any,
						Date.now() + RESUME_REPLAY_DRAIN_TIMEOUT_MS,
					);
					if (!drained) {
						sendResumeGap("backpressure", decision.bytes);
						break;
					}
					const deadline = Date.now() + PACE_TIMEOUT_MS;
					for (const frame of frames) {
						await paceAndSend(ws as any, frame.data, deadline);
						replayed++;
					}
					if (diagEnabled) {
						getCpuDiagnostics().recordWsBroadcast("ws-handler:resume", "event", { frames: replayed, recipients: replayed, bytes: decision.bytes, replayed, sendMs: performance.now() - diagStart });
					}
					break;
				}
				case "ext_channel_open_grant": {
					const grantMsg = msg as Extract<ClientMessage, { type: "ext_channel_open_grant" }>;
					const requestId = typeof grantMsg.requestId === "string" ? grantMsg.requestId : "";
					const name = typeof grantMsg.name === "string" ? grantMsg.name.trim() : "";
					const singletonKey = typeof grantMsg.singletonKey === "string" ? grantMsg.singletonKey : undefined;
					if (!channelOpenPermits) {
						send(ws, { type: "ext_channel_open_grant_result", requestId, ok: false, error: "channel open grants are not configured" });
						break;
					}
					const surf = resolveExtChannelSurface(grantMsg.surfaceToken);
					if (!surf.ok || !name) {
						send(ws, { type: "ext_channel_open_grant_result", requestId, ok: false, error: surf.ok ? "missing channel name" : surf.error });
						break;
					}
					if (!hasChannelContribution(surf.packId, name)) {
						send(ws, { type: "ext_channel_open_grant_result", requestId, ok: false, error: "channel is not declared by this pack" });
						break;
					}
					const openGrant = channelOpenPermits.mint({ sessionId, packId: surf.packId, contributionId: surf.contributionId, channelName: name, singletonKey });
					send(ws, { type: "ext_channel_open_grant_result", requestId, ok: true, openGrant });
					break;
				}
				case "ext_channel_open": {
					const openMsg = msg as Extract<ClientMessage, { type: "ext_channel_open" }>;
					const requestId = typeof openMsg.requestId === "string" ? openMsg.requestId : "";
					try {
						const name = typeof openMsg.name === "string" ? openMsg.name.trim() : "";
						if (!channelRegistry || !channelOpenPermits) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "channel registry/open grants are not configured" });
							break;
						}
						const surf = resolveExtChannelSurface(openMsg.surfaceToken);
						if (!surf.ok || !name) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: surf.ok ? "missing channel name" : surf.error });
							break;
						}
						const resolver = packContributionRegistry as (PackContributionResolver & { getChannel?: (projectId: string | undefined, packId: string, name: string) => ChannelContributionLike | undefined }) | undefined;
						const contribution = resolver?.getChannel?.(session.projectId, surf.packId, name);
						if (!contribution) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "channel is not declared by this pack" });
							break;
						}
						let openedChannelId = "";
						const pendingChannelEvents: Array<{ type: "frame"; frame: HostChannelFrame } | { type: "close"; ev: { reason?: string; error?: string } }> = [];
						const flushPendingChannelEvents = () => {
							for (const event of pendingChannelEvents.splice(0)) {
								if (event.type === "frame") send(ws, { type: "ext_channel_frame", channelId: openedChannelId, frame: event.frame });
								else {
									attachedExtChannels.delete(openedChannelId);
									send(ws, { type: "ext_channel_close", channelId: openedChannelId, reason: event.ev.reason, error: event.ev.error });
								}
							}
						};
						const channel = await channelRegistry.open({
							sessionId,
							projectId: session.projectId,
							packId: surf.packId,
							contribution: { ...contribution, contributionId: surf.contributionId },
							init: openMsg.init,
							openPermit: openMsg.openGrant,
							clientId,
							client: {
								onFrame: (frame) => {
									if (!openedChannelId) {
										pendingChannelEvents.push({ type: "frame", frame });
										return;
									}
									return sendAsync(ws, { type: "ext_channel_frame", channelId: openedChannelId, frame });
								},
								onClose: (ev) => {
									if (!openedChannelId) pendingChannelEvents.push({ type: "close", ev });
									else {
										attachedExtChannels.delete(openedChannelId);
										send(ws, { type: "ext_channel_close", channelId: openedChannelId, reason: ev.reason, error: ev.error });
									}
								},
							},
						});
						openedChannelId = channel.id;
						attachedExtChannels.set(channel.id, { sessionId, packId: surf.packId });
						send(ws, { type: "ext_channel_result", requestId, ok: true, channel });
						flushPendingChannelEvents();
					} catch (err) {
						sendExtChannelFailure(requestId, err);
					}
					break;
				}
				case "ext_channel_attach": {
					const attachMsg = msg as Extract<ClientMessage, { type: "ext_channel_attach" }>;
					const requestId = typeof attachMsg.requestId === "string" ? attachMsg.requestId : "";
					try {
						const channelId = typeof attachMsg.channelId === "string" ? attachMsg.channelId : "";
						if (!channelRegistry) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "channel registry is not configured" });
							break;
						}
						const surf = resolveExtChannelSurface(attachMsg.surfaceToken);
						if (!surf.ok || !channelId) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: surf.ok ? "missing channel id" : surf.error });
							break;
						}
						let attachedChannelId = "";
						const pendingChannelEvents: Array<{ type: "frame"; frame: HostChannelFrame } | { type: "close"; ev: { reason?: string; error?: string } }> = [];
						const flushPendingChannelEvents = () => {
							for (const event of pendingChannelEvents.splice(0)) {
								if (event.type === "frame") send(ws, { type: "ext_channel_frame", channelId: attachedChannelId, frame: event.frame });
								else {
									attachedExtChannels.delete(attachedChannelId);
									send(ws, { type: "ext_channel_close", channelId: attachedChannelId, reason: event.ev.reason, error: event.ev.error });
								}
							}
						};
						const channel = await channelRegistry.attach({
							sessionId,
							packId: surf.packId,
							channelId,
							clientId,
							client: {
								onFrame: (frame) => {
									if (!attachedChannelId) {
										pendingChannelEvents.push({ type: "frame", frame });
										return;
									}
									return sendAsync(ws, { type: "ext_channel_frame", channelId: attachedChannelId, frame });
								},
								onClose: (ev) => {
									if (!attachedChannelId) pendingChannelEvents.push({ type: "close", ev });
									else {
										attachedExtChannels.delete(attachedChannelId);
										send(ws, { type: "ext_channel_close", channelId: attachedChannelId, reason: ev.reason, error: ev.error });
									}
								},
							},
						});
						attachedChannelId = channel.id;
						attachedExtChannels.set(channel.id, { sessionId, packId: surf.packId });
						send(ws, { type: "ext_channel_result", requestId, ok: true, channel });
						flushPendingChannelEvents();
					} catch (err) {
						sendExtChannelFailure(requestId, err);
					}
					break;
				}
				case "ext_channel_list": {
					const listMsg = msg as Extract<ClientMessage, { type: "ext_channel_list" }>;
					const requestId = typeof listMsg.requestId === "string" ? listMsg.requestId : "";
					try {
						if (!channelRegistry) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "channel registry is not configured" });
							break;
						}
						const surf = resolveExtChannelSurface(listMsg.surfaceToken);
						if (!surf.ok) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: surf.error });
							break;
						}
						const channels = await channelRegistry.list({
							sessionId,
							packId: surf.packId,
							clientId,
							name: typeof listMsg.opts?.name === "string" ? listMsg.opts.name : undefined,
							includeClosed: listMsg.opts?.includeClosed === true,
						});
						send(ws, { type: "ext_channel_result", requestId, ok: true, channels });
					} catch (err) {
						sendExtChannelFailure(requestId, err);
					}
					break;
				}
				case "ext_channel_send": {
					const sendMsg = msg as Extract<ClientMessage, { type: "ext_channel_send" }>;
					const requestId = typeof sendMsg.requestId === "string" ? sendMsg.requestId : "";
					try {
						const attached = attachedExtChannels.get(sendMsg.channelId);
						if (!channelRegistry || !attached || attached.sessionId !== sessionId) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "channel is not attached to this connection" });
							break;
						}
						if (!isHostChannelFrame(sendMsg.frame)) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "invalid channel frame" });
							break;
						}
						await channelRegistry.send({ sessionId, packId: attached.packId, channelId: sendMsg.channelId, clientId, frame: sendMsg.frame });
						send(ws, { type: "ext_channel_result", requestId, ok: true });
					} catch (err) {
						sendExtChannelFailure(requestId, err);
					}
					break;
				}
				case "ext_channel_close": {
					const closeMsg = msg as Extract<ClientMessage, { type: "ext_channel_close" }>;
					const requestId = typeof closeMsg.requestId === "string" ? closeMsg.requestId : "";
					try {
						const attached = attachedExtChannels.get(closeMsg.channelId);
						if (!channelRegistry || !attached || attached.sessionId !== sessionId) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "channel is not attached to this connection" });
							break;
						}
						await channelRegistry.close({ sessionId, packId: attached.packId, channelId: closeMsg.channelId, clientId, reason: closeMsg.reason });
						attachedExtChannels.delete(closeMsg.channelId);
						send(ws, { type: "ext_channel_result", requestId, ok: true });
					} catch (err) {
						sendExtChannelFailure(requestId, err);
					}
					break;
				}
				case "ext_channel_detach": {
					const detachMsg = msg as Extract<ClientMessage, { type: "ext_channel_detach" }>;
					const requestId = typeof detachMsg.requestId === "string" ? detachMsg.requestId : "";
					try {
						const attached = attachedExtChannels.get(detachMsg.channelId);
						if (!channelRegistry || !attached || attached.sessionId !== sessionId) {
							send(ws, { type: "ext_channel_result", requestId, ok: false, error: "channel is not attached to this connection" });
							break;
						}
						await channelRegistry.detach({ sessionId, packId: attached.packId, channelId: detachMsg.channelId, clientId });
						attachedExtChannels.delete(detachMsg.channelId);
						send(ws, { type: "ext_channel_result", requestId, ok: true });
					} catch (err) {
						sendExtChannelFailure(requestId, err);
					}
					break;
				}
				case "ext_session_write_permit": {
					// C2 session-WRITE permit MINT (design extension-host-phase2.md §8 C2.1).
					// Mints a server-minted, one-time, content-bound nonce over this authenticated
					// WS. The binding's sessionId is ALWAYS this connection's OWN authenticated
					// session; the packId is SERVER-derived from `tool` (never a frame field). The
					// sanctioned client requests this only after its synchronous transient-
					// activation assertion passes; the matching `ext_session_post` must then carry
					// the returned nonce. See session-write-permit.ts.
					const mintMsg = msg as Extract<ClientMessage, { type: "ext_session_write_permit" }>;
					const requestId = typeof mintMsg.requestId === "string" ? mintMsg.requestId : "";
					const contentHash = typeof mintMsg.contentHash === "string" ? mintMsg.contentHash : "";
					const projectTm = session.projectId && projectContextManager
						? projectContextManager.getOrCreate(session.projectId)?.toolManager
						: undefined;
					const extToolManager = toolManager
						? resolveActionToolManager(toolManager, projectTm)
						: projectTm;
					// DERIVE {packId, tool} from the SERVER-MINTED surface token (never a
					// caller-supplied `tool`). The token's bound session must equal THIS
					// connection's authenticated session (cross-session token use rejected).
					const surf = extToolManager
						? resolveSurfaceIdentity({ token: mintMsg.surfaceToken, headerSessionId: sessionId, resolver: extToolManager, contributions: packContributionRegistry, projectId: session.projectId })
						: ({ ok: false, status: 403, error: "session messaging is available only to market-pack contributions" } as const);
					if (!surf.ok || !contentHash) {
						send(ws, { type: "ext_session_write_permit_result", requestId, ok: false, error: surf.ok ? "missing content hash" : surf.error });
						break;
					}
					// Pack-bound surfaces (no tool) bind the permit with an empty tool
					// surrogate — packId is the server-derived scope key either way.
					const nonce = mintWritePermit({ sessionId, packId: surf.packId, tool: surf.tool ?? "", contentHash });
					send(ws, { type: "ext_session_write_permit_result", requestId, ok: true, nonce });
					break;
				}
				case "ext_session_post": {
					// C2 session WRITE (`host.session.postMessage`) — design
					// extension-host-phase2.md §8 C2.1. The sanctioned client path routes over this
					// authenticated WS instead of a pack-callable fetch, but transport shape is not
					// the security boundary. The TARGET session is ALWAYS this connection's OWN
					// authenticated `sessionId`, never a frame field, and the server derives pack
					// identity from the surface token. REQUIRES the server-minted, one-time,
					// content-bound `nonce` from the preceding `ext_session_write_permit` mint: a
					// replayed/forged/tampered frame fails permit consumption and is rejected with
					// NO post.
					const postMsg = msg as Extract<ClientMessage, { type: "ext_session_post" }>;
					const requestId = typeof postMsg.requestId === "string" ? postMsg.requestId : "";
					const projectTm = session.projectId && projectContextManager
						? projectContextManager.getOrCreate(session.projectId)?.toolManager
						: undefined;
					const extToolManager = toolManager
						? resolveActionToolManager(toolManager, projectTm)
						: projectTm;
					const resolveSession = (id: string): ActionGuardSession | undefined => {
						const live = sessionManager.getSession(id);
						if (live) return { allowedTools: live.allowedTools };
						const persisted = sessionManager.getPersistedSession(id);
						if (persisted) return { allowedTools: persisted.allowedTools };
						return undefined;
					};
					// DERIVE the `tool` from the SERVER-MINTED surface token (never a caller-
					// supplied `tool`), session-bound to THIS connection. A missing/invalid/
					// wrong-session token is rejected with NO post.
					const surf = extToolManager
						? resolveSurfaceIdentity({ token: postMsg.surfaceToken, headerSessionId: sessionId, resolver: extToolManager, contributions: packContributionRegistry, projectId: session.projectId })
						: ({ ok: false, status: 403, error: "session messaging is available only to market-pack contributions" } as const);
					if (!surf.ok) {
						send(ws, { type: "ext_session_post_result", requestId, ok: false, error: surf.error });
						break;
					}
					const result = await handleSessionPost({
						tool: surf.tool,
						packId: surf.packId,
						// The server-authenticated bound session of THIS connection.
						sessionId,
						role: postMsg.role,
						text: postMsg.text,
						resumeTurn: postMsg.resumeTurn,
						nonce: postMsg.nonce,
						resolveSession,
						resolvePackIdentity: (tool) => extToolManager
							? resolvePackIdentityForTool(extToolManager, tool)
							: { isPack: false, packId: "" },
						consumePermit: (nonce, binding) => consumeWritePermit(nonce, binding),
						post: async (sid, text, opts) => {
							// Role-aware delivery (text is already system-framed by the handler
							// for role "system"). "user"/"system" share the user/steer transport;
							// resumeTurn !== false resumes the turn, === false delivers without.
							if (opts.resume) {
								await sessionManager.enqueuePrompt(sid, text, { source: "extension" });
							} else {
								await sessionManager.deliverLiveSteer(sid, text, { source: "extension" });
							}
						},
						audit: (rec) => {
							const tail = rec.outcome === "error" ? `: ${rec.error}` : "";
							console.log(
								`[ext-session-message] tool=${rec.tool} packId=${rec.packId} session=${rec.sessionId} role=${rec.role} resumeTurn=${rec.resumeTurn} outcome=${rec.outcome} durationMs=${rec.ms}${tail}`,
							);
						},
					});
					if (result.ok) {
						send(ws, { type: "ext_session_post_result", requestId, ok: true });
					} else {
						send(ws, { type: "ext_session_post_result", requestId, ok: false, error: result.error });
					}
					break;
				}
				default:
					send(ws, { type: "error", message: "Unknown message type", code: "UNKNOWN_TYPE" });
			}
		} catch (err) {
			sendCommandFailure(err);
		}
	};

	ws.on("message", (data) => {
		const frameBytes = rawWsMessageBytes(data);
		if (!authenticated && frameBytes > MAX_UNAUTHENTICATED_WS_ENVELOPE_BYTES) {
			send(ws, { type: "error", message: "Unauthenticated WebSocket frame exceeds maximum envelope size", code: "FRAME_TOO_LARGE" });
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString());
		} catch {
			send(ws, { type: "error", message: "Invalid JSON", code: "INVALID_JSON" });
			return;
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			typeof (parsed as Record<string, unknown>).type !== "string"
		) {
			send(ws, {
				type: "error",
				message: "WebSocket message must be a non-null object with a string type",
				code: "INVALID_MESSAGE",
			});
			return;
		}
		const msg = parsed as ClientMessage;

		// Validate text-bearing commands before they enter Markdown parsing, a
		// session queue, or the extension-post permit flow.
		if (authenticated && rejectInvalidPromptText(msg)) return;

		const dispatch = () => handleMessage(msg, frameBytes);
		const liveSession = authenticated && sessionId !== "__viewer__"
			? sessionManager.getSession(sessionId)
			: undefined;
		const liveStreamingSteer = msg.type === "steer" && liveSession?.status === "streaming";
		const serialisedSessionCommand = msg.type === "prompt" ||
			(msg.type === "steer" && !liveStreamingSteer);
		const result = authenticated && serialisedSessionCommand
			? SESSION_COMMAND_SERIALISER.serialise(commandSerialisationKey, dispatch)
			: dispatch();
		void result.catch((err) => {
			// Covers authentication/archive branches and any future routing added
			// outside the command-level try/catch. The serialiser's fulfilled tail
			// still permits the next same-session prompt or steer to run.
			console.error(`[ws-handler] Unhandled command failure for ${sessionId}:`, err);
			sendCommandFailure(err);
		});
	});

	ws.on("close", () => {
		clearTimeout(authTimeout);
		if (channelRegistry && attachedExtChannels.size > 0) {
			for (const [channelId, attached] of attachedExtChannels) {
				void Promise.resolve(channelRegistry.detach({ sessionId: attached.sessionId, packId: attached.packId, channelId, clientId })).catch((err) => {
					console.warn(`[ext-channel] detach failed for ${channelId}:`, err);
				});
			}
			attachedExtChannels.clear();
		}
		if (authenticated) {
			sessionManager.removeClient(sessionId, ws);

			// Notify remaining clients
			const session = sessionManager.getSession(sessionId);
			if (session) {
				const leaveMsg: ServerMessage = { type: "client_left", clientId };
				const leaveData = JSON.stringify(leaveMsg);
				for (const client of session.clients) {
					if (client.readyState === 1) {
						client.send(leaveData);
					}
				}
			}
		}
	});

	ws.on("error", (err) => {
		console.error(`[gateway] WebSocket error from ${ip}:`, err.message);
	});
}

/** Resolve the correct TaskManager for a goal (uses per-project store). Throws if not found. */
function resolveTaskManagerForGoal(sessionManager: SessionManager, goalId?: string): TaskManager {
	const pcm = sessionManager.getProjectContextManager();
	if (goalId && pcm) {
		const ctx = pcm.getContextForGoal(goalId);
		if (ctx) return new TaskManager(ctx.taskStore);
	}
	throw new Error(`Cannot resolve TaskManager: goal "${goalId}" not found in any project`);
}

/** Resolve the correct TaskManager for a task ID (finds via goalId lookup). Throws if not found. */
function resolveTaskManagerForTask(sessionManager: SessionManager, taskId: string): TaskManager {
	const pcm = sessionManager.getProjectContextManager();
	if (pcm) {
		for (const ctx of pcm.all()) {
			const candidateTm = new TaskManager(ctx.taskStore);
			if (candidateTm.getTask(taskId)) return candidateTm;
		}
	}
	throw new Error(`Cannot resolve TaskManager: task "${taskId}" not found in any project`);
}
