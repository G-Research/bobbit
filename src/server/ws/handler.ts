import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { SessionManager } from "../agent/session-manager.js";
import type { RateLimiter } from "../auth/rate-limit.js";
import { validateToken } from "../auth/token.js";
import type { SandboxTokenStore } from "../auth/sandbox-token.js";
import type { ProjectContextManager } from "../agent/project-context-manager.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { TaskState } from "../agent/task-store.js";
import { TaskManager } from "../agent/task-manager.js";
import { getSlashSkill, buildSlashSkillPrompt } from "../skills/slash-skills.js";
import { inferMeta } from "../agent/aigw-manager.js";
// patchModelContextWindow removed — model-registry returns correct context windows via inferMeta()

/** Send persisted model info as fallback when getState() is unavailable. */
function sendFallbackModelState(ws: WebSocket, sessionManager: SessionManager, sessionId: string): void {
	const persisted = sessionManager.getPersistedSession(sessionId);
	if (persisted?.modelProvider && persisted?.modelId) {
		const meta = inferMeta(persisted.modelId);
		send(ws, {
			type: "state",
			data: {
				model: {
					provider: persisted.modelProvider,
					id: persisted.modelId,
					contextWindow: meta.contextWindow,
					maxTokens: meta.maxTokens,
				}
			}
		});
	}
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (client.readyState === 1) {
			client.send(data);
		}
	}
}

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState === 1) {
		ws.send(JSON.stringify(msg));
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
					// Sandbox token must match the target session (own or child)
					if (sessionId !== scope.sessionId && !scope.childSessionIds.has(sessionId)) {
						console.log(`[gateway] Sandbox token denied for session ${sessionId} (scope: ${scope.sessionId})`);
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
				send(ws, { type: "auth_ok" });
				// Do NOT set (ws as any).sessionId — broadcastToGoal fallback will include this client
				// Read-only: ignore all subsequent messages
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
					send(ws, { type: "session_status", status: "archived", archivedAt: archived.archivedAt });
					send(ws, { type: "session_title", sessionId, title: archived.title });
					return;
				}
				send(ws, { type: "error", message: "Session not found", code: "SESSION_NOT_FOUND" });
				ws.close(4005, "Session not found");
				return;
			}

			// Register client in session
			sessionManager.addClient(sessionId, ws);

			send(ws, { type: "auth_ok" });

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
				session.rpcClient.getState().then((stateResponse) => {
					if (stateResponse.success) {
						send(ws, { type: "state", data: stateResponse.data });
						// If agent state lacks model info, supplement with persisted data
						const data = stateResponse.data as Record<string, unknown> | undefined;
						if (!data?.model) {
							sendFallbackModelState(ws, sessionManager, sessionId);
						}
					} else {
						sendFallbackModelState(ws, sessionManager, sessionId);
					}
				}).catch(() => {
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

			send(ws, { type: "session_status", status: session.status, ...(session.streamingStartedAt ? { streamingStartedAt: session.streamingStartedAt } : {}) });
			send(ws, { type: "session_title", sessionId, title: session.title });
			send(ws, { type: "queue_update", sessionId, queue: session.promptQueue.toArray() });

			// If there's a pending tool permission request, send it to the new client
			const pendingPerm = sessionManager.getPendingToolPermission(sessionId);
			if (pendingPerm) {
				send(ws, { type: "tool_permission_needed", ...pendingPerm });
			}
			return;
		}

		// Handle archived session commands (read-only)
		if ((ws as any).isArchived) {
			switch (msg.type) {
				case "get_state": {
					const archived = sessionManager.getArchivedSession(sessionId);
					if (archived) {
						const archivedData: Record<string, unknown> = { archived: true, archivedAt: archived.archivedAt, title: archived.title };
						if (archived.modelProvider && archived.modelId) {
							archivedData.model = { provider: archived.modelProvider, id: archived.modelId };
						}
						send(ws, { type: "state", data: archivedData });
					}
					break;
				}
				case "get_messages": {
					const messages = sessionManager.getArchivedMessages(sessionId);
					send(ws, { type: "messages", data: messages });
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
					send(ws, { type: "state", data: { preparing: true } });
					return;
				case "get_messages":
					send(ws, { type: "messages", data: [] });
					return;
				case "prompt":
				case "follow_up":
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
					let promptText = msg.text;

					// Check for slash skill invocation (e.g. "/deploy staging")
					const slashMatch = msg.text.match(/^\/([\w-]+)(?:\s+(.*))?$/);
					if (slashMatch) {
						const skillName = slashMatch[1];
						const skillArgs = slashMatch[2] || "";
						// Resolve per-project config store for skill lookup
						let resolvedConfigStore = projectConfigStore;
						if (session.projectId && projectContextManager) {
							const ctx = projectContextManager.getOrCreate(session.projectId);
							if (ctx) resolvedConfigStore = ctx.projectConfigStore;
						}
						const skill = getSlashSkill(session.cwd, skillName, resolvedConfigStore);
						if (skill) {
							promptText = buildSlashSkillPrompt(skill, skillArgs);
							console.log(`[ws-handler] Slash skill "${skillName}" invoked for session ${sessionId}`);
						}
					}

					await sessionManager.enqueuePrompt(sessionId, promptText, {
						images: msg.images,
						attachments: msg.attachments,
					});
					break;
				}
				case "steer":
					// Live steer: if agent is streaming, send directly via RPC
					// (real-time interrupt, bypasses queue intentionally).
					// Otherwise enqueue as a steered message and drain if idle.
					if (session.status === "streaming") {
						await session.rpcClient.steer(msg.text);
					} else {
						await sessionManager.enqueuePrompt(sessionId, msg.text, { isSteered: true });
					}
					break;
				case "follow_up":
					await sessionManager.enqueuePrompt(sessionId, msg.text, { isFollowUp: true });
					break;
				case "steer_queued":
					sessionManager.steerQueued(sessionId, msg.messageId);
					break;
				case "remove_queued":
					sessionManager.removeQueued(sessionId, msg.messageId);
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
					await session.rpcClient.setModel(msg.provider, msg.modelId);
					sessionManager.updateModelNameFile(session.id, msg.modelId);
					sessionManager.persistSessionModel(session.id, msg.provider, msg.modelId);
					break;
				case "set_thinking_level":
					await session.rpcClient.setThinkingLevel(msg.level);
					break;
				case "compact":
					// Fire-and-forget: don't block the WS message loop.
					// The async IIFE handles the full lifecycle.
					session.isCompacting = true;
					broadcast(session.clients, { type: "event", data: { type: "compaction_start" } });
					(async () => {
						try {
							console.log(`[ws-handler] Starting manual compact for session ${sessionId}`);
							const compactResult = await session.rpcClient.compact(120_000);
							console.log(`[ws-handler] Compact RPC resolved for session ${sessionId}`);
							session.isCompacting = false;
							// Send compaction_end BEFORE refreshing messages/state so
							// the client clears _isCompacting first and won't re-add
							// the placeholder when processing the refreshed messages.
							// Include tokensBefore so the UI can show how much was saved.
							const tokensBefore = compactResult?.data?.tokensBefore ?? null;
							broadcast(session.clients, { type: "event", data: { type: "compaction_end", success: true, tokensBefore } });
							// Refresh messages and state (updated context tokens)
							await sessionManager.refreshAfterCompaction(session);
						} catch (err: any) {
							console.error(`[ws-handler] Compact failed for session ${sessionId}:`, err.message);
							session.isCompacting = false;
							broadcast(session.clients, { type: "event", data: { type: "compaction_end", success: false, error: err.message } });
						}
					})().catch((err) => {
						console.error(`[ws-handler] Unexpected compact error for session ${sessionId}:`, err);
					});
					break;
				case "get_state": {
					try {
						const stateResp = await session.rpcClient.getState();
						if (stateResp.success) {
							send(ws, { type: "state", data: stateResp.data });
							// If agent state lacks model info, supplement with persisted data
							const data = stateResp.data as Record<string, unknown> | undefined;
							if (!data?.model) {
								sendFallbackModelState(ws, sessionManager, sessionId);
							}
						} else {
							sendFallbackModelState(ws, sessionManager, sessionId);
						}
					} catch {
						sendFallbackModelState(ws, sessionManager, sessionId);
					}
					break;
				}
				case "get_messages": {
					const msgsResp = await session.rpcClient.getMessages();
					if (msgsResp.success) {
						send(ws, { type: "messages", data: msgsResp.data as unknown[] });
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
					const tm = resolveTaskManagerForTask(sessionManager, msg.taskId);
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
					const tm = resolveTaskManagerForTask(sessionManager, msg.taskId);
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
				case "subscribe_goal": {
					(ws as any).subscribedGoals = (ws as any).subscribedGoals || new Set();
					(ws as any).subscribedGoals.add(msg.goalId);
					break;
				}
				case "ping":
					send(ws, { type: "pong" });
					break;
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

/** Resolve the correct TaskManager for a goal (uses per-project store if available). */
function resolveTaskManagerForGoal(sessionManager: SessionManager, goalId?: string): TaskManager {
	const pcm = sessionManager.getProjectContextManager();
	if (goalId && pcm) {
		const ctx = pcm.getContextForGoal(goalId);
		if (ctx) return new TaskManager(ctx.taskStore);
	}
	return sessionManager.taskManager;
}

/** Resolve the correct TaskManager for a task ID (finds via goalId lookup). */
function resolveTaskManagerForTask(sessionManager: SessionManager, taskId: string): TaskManager {
	// Try default first
	const task = sessionManager.taskManager.getTask(taskId);
	if (task) return sessionManager.taskManager;

	// Search across projects
	const pcm = sessionManager.getProjectContextManager();
	if (pcm) {
		for (const ctx of pcm.all()) {
			const candidateTm = new TaskManager(ctx.taskStore);
			if (candidateTm.getTask(taskId)) return candidateTm;
		}
	}
	return sessionManager.taskManager;
}
