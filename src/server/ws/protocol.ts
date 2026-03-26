/** A message waiting in the server-side prompt queue */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	/** True if this message was already dispatched mid-turn via steer RPC.
	 *  Kept in queue so the UI shows "Sent" until the turn ends. */
	dispatched?: boolean;
	createdAt: number;
}

/** Client → Server messages over WebSocket */
export type ClientMessage =
	| { type: "auth"; token: string }
	| { type: "prompt"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; attachments?: unknown[] }
	| { type: "steer"; text: string }
	| { type: "follow_up"; text: string }
	| { type: "steer_queued"; messageId: string }
	| { type: "remove_queued"; messageId: string }
	| { type: "abort" }
	| { type: "retry" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "compact" }
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "set_title"; title: string }
	| { type: "generate_title" }
	| { type: "ping" }
	| { type: "invoke_skill"; skillId: string; context?: Record<string, string> }
	| { type: "task_create"; goalId: string; title: string; taskType: string; parentTaskId?: string; spec?: string; dependsOn?: string[] }
	| { type: "task_update"; taskId: string; updates: { title?: string; spec?: string; state?: string; assignedSessionId?: string; dependsOn?: string[] } }
	| { type: "task_delete"; taskId: string }
	| { type: "summarize_goal_title"; goalTitle: string };

/** Server → Client messages over WebSocket */
export type ServerMessage =
	| { type: "auth_ok" }
	| { type: "auth_failed" }
	| { type: "state"; data: unknown }
	| { type: "messages"; data: unknown[] }
	| { type: "event"; data: unknown }
	| { type: "client_joined"; clientId: string }
	| { type: "client_left"; clientId: string }
	| { type: "error"; message: string; code: string }
	| { type: "session_status"; status: string; streamingStartedAt?: number }
	| { type: "session_archived"; sessionId: string; archivedAt: number }
	| { type: "session_title"; sessionId: string; title: string }
	| { type: "pong" }
	| { type: "skill_started"; skillId: string }
	| { type: "skill_completed"; skillId: string; result: string }
	| { type: "skill_failed"; skillId: string; error: string }
	| { type: "cost_update"; sessionId: string; goalId?: string; taskId?: string; cost: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCost: number } }
	| { type: "queue_update"; sessionId: string; queue: QueuedMessage[] }
	| { type: "task_changed"; task: unknown }
	| { type: "tasks_list"; tasks: unknown[] }
	| { type: "bg_process_created"; process: { id: string; command: string; pid: number; status: string; exitCode: number | null; startTime: number } }
	| { type: "bg_process_output"; processId: string; stream: "stdout" | "stderr"; text: string; ts: number }
	| { type: "bg_process_exited"; processId: string; exitCode: number | null }
	| { type: "gate_signal_received"; goalId: string; gateId: string; signalId: string }
	| { type: "gate_verification_started"; goalId: string; gateId: string; signalId: string; steps?: Array<{ name: string; type: string }> }
	| { type: "gate_verification_step_started"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; sessionId?: string }
	| { type: "gate_verification_step_complete"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; status: "passed" | "failed"; durationMs: number; output: string; sessionId?: string }
	| { type: "gate_verification_complete"; goalId: string; gateId: string; signalId: string; status: string }
	| { type: "gate_status_changed"; goalId: string; gateId: string; status: string }
	| { type: "goal_setup_complete"; goalId: string }
	| { type: "goal_setup_error"; goalId: string; error: string }
	| { type: "team_agent_spawned"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_dismissed"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_finished"; goalId: string; sessionId: string; role: string; name: string };
