import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { SessionManager } from "../agent/session-manager.js";
import type { RateLimiter } from "../auth/rate-limit.js";
import { validateToken } from "../auth/token.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import type { TaskState } from "../agent/task-store.js";
import { getSkill } from "../skills/registry.js";
import { runSkillAgent, createSkillRequest } from "../skills/sub-agent.js";

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
	skipAuth = false,
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

				if (!validateToken(msg.token, authToken)) {
					rateLimiter.recordFailure(ip);
					console.log(`[gateway] Auth failed from ${ip}`);
					send(ws, { type: "auth_failed" });
					ws.close(4004, "Invalid token");
					return;
				}
			}

			clearTimeout(authTimeout);
			authenticated = true;
			(ws as any).authenticated = true;

			const session = sessionManager.getSession(sessionId);
			if (!session) {
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
			session.rpcClient.getState().then((stateResponse) => {
				if (stateResponse.success) {
					send(ws, { type: "state", data: stateResponse.data });
				}
			}).catch(() => {
				// State not available yet — client will get events as they come
			});

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
			return;
		}

		// Authenticated — route commands to agent
		const session = sessionManager.getSession(sessionId);
		if (!session) {
			send(ws, { type: "error", message: "Session not found", code: "SESSION_NOT_FOUND" });
			return;
		}

		try {
			switch (msg.type) {
				case "prompt":
					console.log(`[ws-handler] Prompt received: text="${msg.text?.substring(0, 50)}...", images=${msg.images?.length ?? 0}`);
					await sessionManager.enqueuePrompt(sessionId, msg.text, {
						images: msg.images,
						attachments: msg.attachments,
					});
					break;
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
					const stateResp = await session.rpcClient.getState();
					if (stateResp.success) {
						send(ws, { type: "state", data: stateResp.data });
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
				case "task_create": {
					const task = sessionManager.taskManager.createTask(
						msg.goalId,
						msg.title,
						msg.taskType,
						{ parentTaskId: msg.parentTaskId, spec: msg.spec, dependsOn: msg.dependsOn },
					);
					broadcast(session.clients, { type: "task_changed", task });
					break;
				}
				case "task_update": {
					const updates = { ...msg.updates, state: msg.updates.state as TaskState | undefined };
					const updated = sessionManager.taskManager.updateTask(msg.taskId, updates);
					if (updated) {
						const task = sessionManager.taskManager.getTask(msg.taskId);
						broadcast(session.clients, { type: "task_changed", task });
					} else {
						send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" });
					}
					break;
				}
				case "task_delete": {
					const task = sessionManager.taskManager.getTask(msg.taskId);
					if (task) {
						sessionManager.taskManager.deleteTask(msg.taskId);
						broadcast(session.clients, { type: "task_changed", task: { ...task, _deleted: true } });
					} else {
						send(ws, { type: "error", message: `Task ${msg.taskId} not found`, code: "TASK_NOT_FOUND" });
					}
					break;
				}
				case "invoke_skill": {
					const skill = getSkill(msg.skillId);
					if (!skill) {
						send(ws, { type: "skill_failed", skillId: msg.skillId, error: `Unknown skill: ${msg.skillId}` });
						break;
					}
					const session = sessionManager.getSession(sessionId);
					if (!session) {
						send(ws, { type: "skill_failed", skillId: msg.skillId, error: "Session not found" });
						break;
					}
					send(ws, { type: "skill_started", skillId: msg.skillId });
					const request = createSkillRequest(skill, session.cwd, sessionId, msg.context);
					runSkillAgent(request).then((result) => {
						if (result.status === "completed") {
							broadcast(session.clients, { type: "skill_completed", skillId: msg.skillId, result: result.output });
						} else {
							broadcast(session.clients, { type: "skill_failed", skillId: msg.skillId, error: result.error || "Skill execution failed" });
						}
					}).catch((err) => {
						broadcast(session.clients, { type: "skill_failed", skillId: msg.skillId, error: String(err) });
					});
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
