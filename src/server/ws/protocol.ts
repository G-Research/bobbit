/** Grant policy for tool access (self-contained — not imported from role-store for protocol independence). */
export type GrantPolicy = 'allow' | 'ask' | 'never';

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
	| { type: "steer_queued"; messageId: string }
	| { type: "remove_queued"; messageId: string }
	| { type: "abort" }
	| { type: "retry" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: string }
	| { type: "compact" }
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "set_title"; title: string }
	| { type: "generate_title" }
	| { type: "ping" }
	| { type: "task_create"; goalId: string; title: string; taskType: string; parentTaskId?: string; spec?: string; dependsOn?: string[] }
	| { type: "task_update"; taskId: string; updates: { title?: string; spec?: string; state?: string; assignedSessionId?: string; dependsOn?: string[] } }
	| { type: "task_delete"; taskId: string }
	| { type: "summarize_goal_title"; goalTitle: string }
	| { type: "grant_tool_permission"; toolName: string; scope: "tool" | "group"; group?: string; mode?: "persistent" | "session-only" | "one-time" }
	| { type: "deny_tool_permission"; toolName: string }
	| { type: "reorder_queue"; messageIds: string[] }
	| { type: "restart_agent" }
	| { type: "resume"; fromSeq: number };

/** Server → Client messages over WebSocket */
export type ServerMessage =
	| { type: "auth_ok" }
	| { type: "auth_failed" }
	| { type: "state"; data: unknown }
	| { type: "messages"; data: unknown[] }
	| { type: "event"; data: unknown; seq?: number; ts?: number }
	| { type: "resume_gap"; lastSeq: number }
	| { type: "client_joined"; clientId: string }
	| { type: "client_left"; clientId: string }
	| { type: "error"; message: string; code: string }
	| { type: "session_status"; status: string; streamingStartedAt?: number; archivedAt?: number; /* status includes "aborting" */ }
	| { type: "session_archived"; sessionId: string; archivedAt: number }
	| { type: "session_title"; sessionId: string; title: string }
	| { type: "pong" }
	| { type: "cost_update"; sessionId: string; goalId?: string; taskId?: string; cost: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalCost: number } }
	| { type: "queue_update"; sessionId: string; queue: QueuedMessage[] }
	| { type: "task_changed"; task: unknown }
	| { type: "tasks_list"; tasks: unknown[] }
	| { type: "bg_process_created"; process: { id: string; name: string; command: string; pid: number; status: string; exitCode: number | null; startTime: number } }
	| { type: "bg_process_output"; processId: string; stream: "stdout" | "stderr"; text: string; ts: number }
	| { type: "bg_process_exited"; processId: string; exitCode: number | null }
	| { type: "gate_signal_received"; goalId: string; gateId: string; signalId: string }
	| { type: "gate_verification_started"; goalId: string; gateId: string; signalId: string; startedAt?: number; steps?: Array<{ name: string; type: string; phase?: number }> }
	| { type: "gate_verification_phase_started"; goalId: string; gateId: string; signalId: string; phase: number; stepIndices: number[] }
	| { type: "gate_verification_step_started"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; startedAt?: number; sessionId?: string; phase?: number }
	| { type: "gate_verification_step_output"; goalId: string; gateId: string; signalId: string; stepIndex: number; stream: "stdout" | "stderr"; text: string; ts: number }
	| { type: "gate_verification_step_complete"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; status: "passed" | "failed" | "skipped"; durationMs: number; output: string; sessionId?: string; phase?: number }
	| { type: "gate_verification_complete"; goalId: string; gateId: string; signalId: string; status: string }
	| { type: "gate_status_changed"; goalId: string; gateId: string; status: string }
	| { type: "goal_setup_complete"; goalId: string }
	| { type: "goal_setup_error"; goalId: string; error: string }
	| { type: "team_agent_spawned"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_dismissed"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_finished"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "pr_status_changed"; goalId: string }
	| { type: "tool_permission_needed"; toolName: string; group: string; roleName: string; roleLabel: string; lastPromptText?: string }
	| { type: "index:progress"; projectId: string; phase: "rebuild" | "incremental"; total: number; completed: number; backlog: number }
	| { type: "index:complete"; projectId: string; phase: "rebuild" | "incremental"; durationMs: number; rowsWritten: number }
	| { type: "index:error"; projectId: string; message: string; recoverable: boolean }
	| {
		type: "skill_expansions";
		data: {
			originalText: string;
			modelText: string;
			ts: number;
			skillExpansions: Array<{
				name: string;
				args: string;
				source: string;
				filePath: string;
				range: [number, number];
				expanded: string;
			}>;
		};
	};
