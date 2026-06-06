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
import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { TaskState } from "../agent/task-store.js";
import { TaskManager } from "../agent/task-manager.js";
import { resolveSkillExpansions } from "../skills/resolve-skill-expansions.js";
import { resolveFileMentions, toWireMention } from "../skills/resolve-file-mentions.js";
import { buildMergedModelText } from "../skills/merge-mentions.js";
import { inferMeta } from "../agent/aigw-manager.js";
import { clampThinkingLevel, isKnownThinkingLevel } from "../../shared/thinking-levels.js";
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
// patchModelContextWindow removed — model-registry returns correct context windows via inferMeta()

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

/** Send persisted model info as fallback when getState() is unavailable. */
function sendFallbackModelState(ws: WebSocket, sessionManager: SessionManager, sessionId: string): void {
	const persisted = sessionManager.getPersistedSession(sessionId);
	const data: Record<string, unknown> = {};
	if (persisted?.modelProvider && persisted?.modelId) {
		const meta = inferMeta(persisted.modelId);
		data.model = {
			provider: persisted.modelProvider,
			id: persisted.modelId,
			contextWindow: meta.contextWindow,
			maxTokens: meta.maxTokens,
			reasoning: meta.reasoning,
		};
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
		const meta = inferMeta(archived.modelId);
		data.model = {
			provider: archived.modelProvider,
			id: archived.modelId,
			contextWindow: meta.contextWindow,
			maxTokens: meta.maxTokens,
			reasoning: meta.reasoning,
		};
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
): void {
	const ip = getClientIp(req);
	let authenticated = false;
	const clientId = randomUUID();

	// 5-second window to authenticate before disconnection
	const authTimeout = setTimeout(() => {
		if (!authenticated) {
			ws.close(4001, "Auth timeout");
		}
	}, 5000);

	ws.on("message", async (data) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(data.toString());
		} catch {
			send(ws, { type: "error", message: "Invalid JSON", code: "INVALID_JSON" });
			return;
		}

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

			send(ws, { type: "auth_ok" });
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
						const spliced = { ...(stateResponse.data as Record<string, unknown> | undefined ?? {}), status: session.status, statusVersion: session.statusVersion ?? 0 };
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
				default:
					send(ws, { type: "error", message: "Session is still being set up", code: "SESSION_PREPARING" });
					return;
			}
		}

		try {
			switch (msg.type) {
				case "prompt": {
					console.log(`[ws-handler] Prompt received: text="${msg.text?.substring(0, 50)}...", images=${msg.images?.length ?? 0}`);

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
					// two resolvers never produce overlapping ranges. A bad
					// reference never tears down the send — it degrades to a
					// literal `@path` plus a warning.
					//
					// IMPORTANT: file mentions resolve against the session's HOST
					// worktree, NOT skillCwd. skillCwd redirects to the project
					// rootPath for SKILL discovery (correct there), but that tree
					// misses the goal/session worktree's branch-local, untracked
					// and gitignored files. worktreePath is the host path; for
					// sandboxed sessions session.cwd is a container path, so
					// worktreePath is required to reach the real files.
					const fileMentionCwd = session.worktreePath || session.cwd;
					const fileMentionResult = resolveFileMentions(msg.text, fileMentionCwd);
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
						await session.rpcClient.setModel(msg.provider, msg.modelId);
						sessionManager.updateModelNameFile(session.id, msg.modelId);
						sessionManager.persistSessionModel(session.id, msg.provider, msg.modelId);
					} catch (err: any) {
						// Surface set_model failures to the UI instead of silently swallowing
						// them — otherwise the client keeps showing the new model while the
						// agent stays bound to the previous one and subsequent prompts go
						// to the wrong model.
						console.error(`[ws-handler] set_model failed for session ${session.id} (${msg.provider}/${msg.modelId}):`, err?.message || err);
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
						const meta = inferMeta(persisted.modelId);
						const clamped = clampThinkingLevel(level, {
							id: persisted.modelId,
							provider: persisted.modelProvider,
							reasoning: meta.reasoning,
						});
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
					(async () => {
						try {
							console.log(`[ws-handler] Starting manual compact for session ${sessionId}`);
							const compactResult = await session.rpcClient.compact(120_000);
							console.log(`[ws-handler] Compact RPC resolved for session ${sessionId}`);
							const endedAtMs = Date.now();
							session.isCompacting = false;
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
						} catch (err: any) {
							console.error(`[ws-handler] Compact failed for session ${sessionId}:`, err.message);
							const endedAtMs = Date.now();
							session.isCompacting = false;
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
							const spliced = { ...(stateResp.data as Record<string, unknown> | undefined ?? {}), status: session.status, statusVersion: session.statusVersion ?? 0 };
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
					const msgsResp = await session.rpcClient.getMessages();
					if (diagEnabled) {
						getCpuDiagnostics().recordTimer("ws-handler:getMessages", performance.now() - diagStart, { success: msgsResp.success ? 1 : 0 });
					}
					const tRpc = perf ? performance.now() : 0;
					if (msgsResp.success) {
						const raw = msgsResp.data as any;
						// msgsResp.data may be an array or { messages: [...] }
						let data: any = raw;
						if (Array.isArray(raw)) {
							// H3: splice in-flight message_update before truncation/sidecar/stamp.
							const spliced = spliceInFlightSteers(
								spliceInFlightMessage(raw, (session as any).latestMessageUpdate),
								(session as any).inFlightSteerTexts,
							);
							const withCompaction = mergeCompactionSidecarIntoMessages(sessionId, spliced);
							data = mergeSkillSidecarIntoMessages(sessionId, truncateLargeToolContentInMessages(withCompaction));
						} else if (raw && Array.isArray(raw.messages)) {
							const spliced = spliceInFlightSteers(
								spliceInFlightMessage(raw.messages, (session as any).latestMessageUpdate),
								(session as any).inFlightSteerTexts,
							);
							const withCompaction = mergeCompactionSidecarIntoMessages(sessionId, spliced);
							const truncated = truncateLargeToolContentInMessages(withCompaction);
							const merged = mergeSkillSidecarIntoMessages(sessionId, truncated);
							data = merged === raw.messages ? raw : { ...raw, messages: merged };
						}
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
					sessionManager.grantToolPermission(sessionId, msg.toolName, msg.scope, msg.group, msg.mode).catch((err: any) => {
						send(ws, { type: "error", message: `Grant failed: ${err}`, code: "GRANT_ERROR" });
					});
					break;
				}
				case "deny_tool_permission": {
					sessionManager.denyToolPermission(sessionId, msg.toolName);
					break;
				}
				case "restart_agent":
					sessionManager.restartAgent(sessionId).then(() => {
						// Refresh messages after restart so the client sees the full history
						const restored = sessionManager.getSession(sessionId);
						if (restored) {
							restored.rpcClient.getMessages?.()
								.then((msgs: any) => {
									if (!msgs) return;
									const raw = msgs.data ?? msgs;
									let data: any = raw;
									if (Array.isArray(raw)) {
										const withCompaction = mergeCompactionSidecarIntoMessages(sessionId, raw);
										data = mergeSkillSidecarIntoMessages(sessionId, truncateLargeToolContentInMessages(withCompaction));
									} else if (raw && Array.isArray(raw.messages)) {
										const withCompaction = mergeCompactionSidecarIntoMessages(sessionId, raw.messages);
										const truncated = truncateLargeToolContentInMessages(withCompaction);
										const merged = mergeSkillSidecarIntoMessages(sessionId, truncated);
										data = merged === raw.messages ? raw : { ...raw, messages: merged };
									}
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
					// will fall back to a full get_messages snapshot.
					const diagEnabled = cpuDiagnosticsEnabled();
					const diagStart = diagEnabled ? performance.now() : 0;
					let replayed = 0;
					let bytes = 0;
					const fromSeq = typeof msg.fromSeq === "number" ? msg.fromSeq : 0;
					if (!session.eventBuffer.canResumeFrom(fromSeq)) {
						send(ws, { type: "resume_gap", lastSeq: session.eventBuffer.lastSeq });
						if (diagEnabled) {
							getCpuDiagnostics().recordWsBroadcast("ws-handler:resume", "resume_gap", { frames: 1, recipients: 1, bytes: 0, replayed: 0, gaps: 1, sendMs: performance.now() - diagStart });
						}
						break;
					}
					for (const entry of session.eventBuffer.since(fromSeq)) {
						if (diagEnabled) {
							const frame = { type: "event" as const, data: entry.event, seq: entry.seq, ts: entry.ts };
							const data = JSON.stringify(frame);
							if (ws.readyState === 1) ws.send(data);
							bytes += Buffer.byteLength(data);
						} else {
							send(ws, { type: "event", data: entry.event, seq: entry.seq, ts: entry.ts });
						}
						replayed++;
					}
					if (diagEnabled) {
						getCpuDiagnostics().recordWsBroadcast("ws-handler:resume", "event", { frames: replayed, recipients: replayed, bytes, replayed, sendMs: performance.now() - diagStart });
					}
					break;
				}
				default:
					send(ws, { type: "error", message: "Unknown message type", code: "UNKNOWN_TYPE" });
			}
		} catch (err) {
			send(ws, { type: "error", message: String(err), code: "COMMAND_ERROR" });
		}
	});

	ws.on("close", () => {
		clearTimeout(authTimeout);
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
