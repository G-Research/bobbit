import { getModel } from "@mariozechner/pi-ai";
import { PROPOSAL_PARSERS } from "./proposal-parsers.js";
import { state } from "./state.js";
import { showFaviconBadge } from "./favicon-badge.js";
import { refreshGateStatusForGoal } from "./api.js";
import { createSystemNotification } from "./custom-messages.js";

/**
 * A remote agent adapter that connects to the Bobbit Gateway via WebSocket.
 * Duck-types the Agent interface from pi-agent-core so it can be used
 * with ChatPanel / AgentInterface without changes.
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/** A message waiting in the server-side prompt queue (mirrors server QueuedMessage) */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	/** True if already dispatched mid-turn via steer RPC (kept in queue for UI) */
	dispatched?: boolean;
	createdAt: number;
}

export class RemoteAgent {
	private ws: WebSocket | null = null;
	private subscribers: Array<(event: any) => void> = [];
	private _state: any;
	private _gatewayUrl = "";
	private _authToken = "";
	private _sessionId = "";
	// Server-authoritative prompt queue
	private _serverQueue: QueuedMessage[] = [];
	// Assistant message deferred until tool execution completes to avoid
	// showing it simultaneously in both message-list and streaming-container.
	private _deferredAssistantMessage: any = null;
	// Attachments from the most recent prompt, used to enrich the echoed
	// user message so thumbnails render in the message list.
	private _pendingAttachments: any[] | null = null;

	// Messages added via live events (message_end) that might not yet be
	// reflected in the next server "messages" response.  When a wholesale
	// messages refresh arrives, any live-event messages missing from the
	// server list are re-appended so they aren't silently dropped.
	private _liveEventMessages: any[] = [];

	// Compaction tracking — persists across message refreshes.
	// Exposed on state so the UI can queue messages during compact.
	private _isCompacting = false;
	private _isAborting = false;

	// Synthetic messages added around compaction (/compact user msg + result).
	// Kept separately so they survive the server's post-compaction messages refresh.
	private _compactionSyntheticMessages: any[] = [];

	// Proposal deferral — when set, incoming messages are stored but
	// _checkProposals is skipped until runDeferredProposalCheck() is called.
	// This lets us fire requestMessages() early for fast loading while
	// draft restores finish without being overwritten by proposal detection.
	private _deferProposalCheck = false;
	private _hasDeferredProposals = false;

	// Task timing — track when the agent started working so we can
	// notify the user if a long task finishes while the tab is hidden.
	private _taskStartTime: number | null = null;

	// Auto-reconnect state
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _reconnectAttempt = 0;
	private _intentionalDisconnect = false;
	private _connectionStatus: ConnectionStatus = "disconnected";
	private _pendingReconnectNotif = false;
	private static readonly MAX_RECONNECT_DELAY = 30_000;
	private static readonly BASE_RECONNECT_DELAY = 1_000;

	// Agent interface properties (used by AgentInterface / ChatPanel)
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	streamFn: any;

	/** Callback fired when the session title changes (e.g. AI-generated summary). */
	onTitleChange?: (title: string) => void;
	onStatusChange?: (status: string) => void;
	/** Callback fired when connection status changes (connected/reconnecting/disconnected). */
	onConnectionStatusChange?: (status: ConnectionStatus) => void;
	/** Callback fired when a goal proposal is detected in an assistant message. */
	onGoalProposal?: (proposal: { title: string; spec: string; cwd?: string; workflow?: string }) => void;
	/** Callback fired when a role proposal is detected in an assistant message. */
	onRoleProposal?: (proposal: { name: string; label: string; prompt: string; tools: string; accessory: string }) => void;
	/** Callback fired when a tool proposal is detected in an assistant message. */
	onToolProposal?: (proposal: { tool: string; action: string; content: string }) => void;
	onPersonalityProposal?: (proposal: { name: string; label: string; description: string; prompt_fragment: string }) => void;
	/** Callback fired when a staff proposal is detected in an assistant message. */
	onStaffProposal?: (proposal: { name: string; description: string; prompt: string; triggers: string; cwd: string }) => void;
	/** Callback fired when a setup proposal is detected in an assistant message. */
	onSetupProposal?: (proposal: { action: string; content: string }) => void;
	/** Callback fired when a workflow proposal is detected in an assistant message. */
	onWorkflowProposal?: (proposal: { id: string; name: string; description: string; gates: string }) => void;
	/** Callback fired when tool execution updates (for real-time progress). */
	onWorkflowUpdate?: () => void;
	/** Callback fired when the server-side prompt queue changes. */
	onQueueUpdate?: (queue: QueuedMessage[]) => void;
	/** Callback fired when background process state changes. */
	/** Callback fired when goal setup status changes (worktree ready or failed). */
	onGoalSetupEvent?: () => void;
	onBgProcessEvent?: (msg: { type: string; processId?: string; stream?: string; text?: string; ts?: number; exitCode?: number | null; process?: any }) => void;
	/** Callback fired when preview panel flag changes for a session. */
	onPreviewChanged?: (sessionId: string, preview: boolean) => void;
	/** Callback fired when server detects PR creation and busts the cache. */
	onPrStatusChanged?: (goalId: string) => void;
	private _title = "New session";

	constructor() {
		this._state = {
			systemPrompt: "",
			model: getModel("anthropic", "claude-opus-4-6"),
			thinkingLevel: "off",
			tools: [],
			messages: [] as any[],
			isStreaming: false,
			isCompacting: false,
			isArchived: false,
			isPreparing: false,
			archivedAt: null as number | null,
			streamMessage: null as any,
			pendingToolCalls: new Set<string>(),
			error: undefined as string | undefined,
			turnStartTime: null as number | null,
		};
	}

	get state() {
		return this._state;
	}
	get sessionId() {
		return this._sessionId || undefined;
	}
	get thinkingBudgets() {
		return { minimal: 1024, low: 4096, medium: 10240, high: 32768 };
	}
	get transport() {
		return undefined;
	}
	get maxRetryDelayMs() {
		return undefined;
	}
	get connected() {
		return this.ws?.readyState === WebSocket.OPEN;
	}
	get connectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}
	get gatewaySessionId() {
		return this._sessionId;
	}
	get title() {
		return this._title;
	}

	/** Play a short two-tone beep using the Web Audio API (no file needed). */
	static playNotificationBeep(): void {
		try {
			const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
			const now = ctx.currentTime;

			// Two short tones: 880 Hz then 1046 Hz
			for (const [freq, start] of [[880, 0], [1046, 0.15]] as const) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = freq;
				gain.gain.setValueAtTime(0.15, now + start);
				gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.12);
				osc.connect(gain).connect(ctx.destination);
				osc.start(now + start);
				osc.stop(now + start + 0.12);
			}

			// Close the context after the beep finishes
			setTimeout(() => ctx.close().catch(() => {}), 500);
		} catch {
			// Web Audio not available — silently skip
		}
	}

	// ── Connection ────────────────────────────────────────────────────

	private static readonly CONNECT_TIMEOUT_MS = 15_000;

	async connect(gatewayUrl: string, token: string, sessionId: string): Promise<void> {
		this._gatewayUrl = gatewayUrl;
		this._authToken = token;
		this._sessionId = sessionId;
		this._intentionalDisconnect = false;
		this._reconnectAttempt = 0;

		// Race the WebSocket connect against a timeout so we don't hang
		// forever on degraded mobile networks.
		const timeout = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Connection timed out")), RemoteAgent.CONNECT_TIMEOUT_MS);
		});

		try {
			await Promise.race([this._connectWs(true), timeout]);
		} catch (err) {
			// If timed out, clean up the pending WebSocket
			this._intentionalDisconnect = true;
			this.ws?.close();
			this.ws = null;
			throw err;
		}
	}


	/**
	 * Internal WebSocket connect. When `initial` is true the returned promise
	 * resolves/rejects for the caller of `connect()`. On reconnect attempts
	 * (`initial` false) failures schedule the next retry silently.
	 */
	private _connectWs(initial: boolean): Promise<void> {
		const wsUrl = this._gatewayUrl.replace(/^http/, "ws");

		return new Promise<void>((resolve, reject) => {
			this.ws = new WebSocket(`${wsUrl}/ws/${this._sessionId}`);
			let settled = false;

			this.ws.onopen = () => {
				this.ws!.send(JSON.stringify({ type: "auth", token: this._authToken }));
			};

			this.ws.onmessage = (evt) => {
				let msg: any;
				try {
					msg = JSON.parse(evt.data);
				} catch {
					return;
				}

				if (!settled) {
					if (msg.type === "auth_ok") {
						settled = true;
						this._reconnectAttempt = 0;
						this._setConnectionStatus("connected");
						resolve();
						// On reconnect, request current messages to resync state
						if (!initial) {
							this._pendingReconnectNotif = true;
							this.requestMessages();
							this.send({ type: "get_state" });
						}
					} else if (msg.type === "auth_failed") {
						settled = true;
						if (initial) {
							reject(new Error("Authentication failed"));
						}
						return;
					} else if (msg.type === "error") {
						settled = true;
						if (initial) {
							reject(new Error(msg.message || "Connection error"));
						}
						return;
					}
				}

				this.handleServerMessage(msg);
			};

			this.ws.onerror = () => {
				if (!settled) {
					settled = true;
					if (initial) {
						reject(new Error("WebSocket connection failed"));
					}
				}
			};

			this.ws.onclose = () => {
				if (!settled) {
					settled = true;
					if (initial) {
						reject(new Error("Connection closed before auth"));
						return;
					}
				}
				// If this wasn't an intentional disconnect, attempt to reconnect
				if (!this._intentionalDisconnect) {
					this._scheduleReconnect();
				}
			};
		});
	}

	private _setConnectionStatus(status: ConnectionStatus): void {
		if (this._connectionStatus === status) return;
		this._connectionStatus = status;
		this.onConnectionStatusChange?.(status);
	}

	private _scheduleReconnect(): void {
		if (this._intentionalDisconnect) return;

		this._setConnectionStatus("reconnecting");

		const delay = Math.min(
			RemoteAgent.BASE_RECONNECT_DELAY * Math.pow(2, this._reconnectAttempt),
			RemoteAgent.MAX_RECONNECT_DELAY,
		);
		this._reconnectAttempt++;

		this._reconnectTimer = setTimeout(async () => {
			this._reconnectTimer = null;
			if (this._intentionalDisconnect) return;
			try {
				await this._connectWs(false);
			} catch {
				// _connectWs failure on reconnect — onclose will fire and
				// schedule the next attempt automatically.
			}
		}, delay);
	}

	disconnect(): void {
		this._intentionalDisconnect = true;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
		this._setConnectionStatus("disconnected");
	}

	// ── Event subscription (Agent interface) ─────────────────────────

	subscribe(fn: (event: any) => void): () => void {
		this.subscribers.push(fn);
		return () => {
			const idx = this.subscribers.indexOf(fn);
			if (idx >= 0) this.subscribers.splice(idx, 1);
		};
	}

	private emit(event: any) {
		for (const fn of this.subscribers) {
			fn(event);
		}
	}

	// ── Agent commands (proxied to gateway) ──────────────────────────

	async prompt(input: string | any | any[], _images?: any[]): Promise<void> {
		let text: string;
		let attachments: any[] | undefined;
		let imageData: any[] | undefined;

		if (typeof input === "string") {
			text = input;
		} else if (Array.isArray(input)) {
			text = input.map((m) => extractText(m)).join("\n");
		} else {
			text = extractText(input);
			// Preserve attachments from user-with-attachments messages
			if (input.role === "user-with-attachments" && input.attachments?.length) {
				attachments = input.attachments;
				// Extract image attachments as ImageContent objects for the LLM
				imageData = attachments
					?.filter((a: any) => a.type === "image" && a.content)
					.map((a: any) => ({ type: "image", data: a.content, mimeType: a.mimeType }));
			}
		}

		// Stash attachments so we can enrich the echoed user message
		this._pendingAttachments = attachments || null;

		// Clear compaction synthetic messages — they were only needed to survive
		// the post-compaction refresh; a new prompt starts a fresh turn.
		this._compactionSyntheticMessages = [];

		// Add the user message optimistically so it renders immediately —
		// but only when the agent is idle. If streaming, the prompt is queued
		// server-side and the server will echo it in the correct position
		// (interleaved with responses). Rendering it now would stack multiple
		// user messages together before any response.
		if (!this._state.isStreaming) {
			const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const optimisticMsg: any = {
				role: attachments?.length ? "user-with-attachments" : "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
				id: optimisticId,
				...(attachments?.length ? { attachments } : {}),
			};
			this._state.messages = [...this._state.messages, optimisticMsg];
			this._liveEventMessages.push(optimisticMsg);
			this.emit({ type: "message_end", message: optimisticMsg });
		}

		this.send({
			type: "prompt",
			text,
			...(imageData?.length ? { images: imageData } : {}),
			...(attachments?.length ? { attachments } : {}),
		});
	}

	steer(message: any): void {
		const text = typeof message === "string" ? message : extractText(message);
		this.send({ type: "steer", text });
	}

	followUp(message: any): void {
		const text = typeof message === "string" ? message : extractText(message);
		this.send({ type: "follow_up", text });
	}

	get isAborting(): boolean { return this._isAborting; }

	abort(): void {
		this._isAborting = true;
		this.send({ type: "abort" });
	}

	/** Retry after a model/API error. */
	retry(): void {
		this.send({ type: "retry" });
	}

	compact(): void {
		this.send({ type: "compact" });
	}

	/** Add or re-add the "Compacting context…" placeholder to the message list. */
	private _addCompactingPlaceholder(): void {
		this._state.messages = [...this._state.messages.filter((m: any) => m.id !== "compacting_placeholder"), {
			role: "assistant",
			content: [{ type: "text", text: "Compacting context…" }],
			timestamp: Date.now(),
			id: "compacting_placeholder",
		} as any];
	}

	requestMessages(): void {
		this.send({ type: "get_messages" });
	}

	/** Defer proposal checking on incoming messages until unlocked. */
	deferProposalCheck(): void {
		this._deferProposalCheck = true;
		this._hasDeferredProposals = false;
	}

	/** Run deferred proposal checks now (after draft restores are complete). */
	runDeferredProposalCheck(): void {
		this._deferProposalCheck = false;
		if (this._hasDeferredProposals) {
			this._hasDeferredProposals = false;
			for (const m of this._state.messages) {
				if (m.role === "assistant") {
					this._checkProposals(m);
				}
			}
		}
	}

	async continue(): Promise<void> {}

	async waitForIdle(): Promise<void> {
		if (!this._state.isStreaming) return;
		return new Promise<void>((resolve) => {
			const unsub = this.subscribe((ev) => {
				if (ev.type === "agent_end") {
					unsub();
					resolve();
				}
			});
		});
	}

	reset(): void {
		this._state.messages = [];
		this._state.streamMessage = null;
		this._state.isStreaming = false;
		this._state.pendingToolCalls = new Set();
		this._state.error = undefined;
		this._state.turnStartTime = null;
		this._deferredAssistantMessage = null;
		this._pendingAttachments = null;
		this._liveEventMessages = [];
	}

	// ── Setters (Agent interface) ────────────────────────────────────

	setModel(model: any): void {
		this._state.model = model;
		this.send({ type: "set_model", provider: model.provider, modelId: model.id });
		state.chatPanel?.agentInterface?.requestUpdate();
	}

	setThinkingLevel(level: any): void {
		this._state.thinkingLevel = level;
		this.send({ type: "set_thinking_level", level });
		state.chatPanel?.agentInterface?.requestUpdate();
	}

	setTools(_tools: any[]): void {
		// no-op: tools are server-side for the coding agent
	}

	setSystemPrompt(prompt: string): void {
		this._state.systemPrompt = prompt;
	}

	replaceMessages(msgs: any[]): void {
		this._state.messages = msgs.map(enrichUserMessage);
	}

	appendMessage(msg: any): void {
		this._state.messages = [...this._state.messages, msg];
	}

	setTitle(title: string): void {
		this._title = title;
		this.send({ type: "set_title", title });
		this.onTitleChange?.(title);
	}

	generateTitle(): void {
		this.send({ type: "generate_title" });
	}

	summarizeGoalTitle(goalTitle: string): void {
		this.send({ type: "summarize_goal_title", goalTitle });
	}

	clearSteeringQueue(): void {}
	clearFollowUpQueue(): void {}
	clearAllQueues(): void {}
	hasQueuedMessages(): boolean {
		return this._serverQueue.length > 0;
	}

	/** Get the current server-authoritative prompt queue. */
	getQueue(): QueuedMessage[] {
		return this._serverQueue;
	}

	/** Ask the server to promote a queued message to a steer. */
	steerQueued(messageId: string): void {
		this.send({ type: "steer_queued", messageId });
	}

	/** Ask the server to remove a message from the queue. */
	removeQueued(messageId: string): void {
		this.send({ type: "remove_queued", messageId });
	}

	// ── Internal ─────────────────────────────────────────────────────

	private send(msg: any): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		} else {
			console.warn("[RemoteAgent] Message dropped (WS not open):", msg.type, "readyState:", this.ws?.readyState);
		}
	}

	private handleServerMessage(msg: any) {
		switch (msg.type) {
			case "state":
				if (msg.data?.isStreaming !== undefined) {
					this._state.isStreaming = msg.data.isStreaming;
				}
				if (msg.data?.archived) {
					this._state.isArchived = true;
					this._state.archivedAt = msg.data.archivedAt;
				}
				// Always update model from server state (keeps context window accurate after compaction)
				if (msg.data?.model) {
					this._state.model = msg.data.model;
				}
				if (msg.data?.thinkingLevel) {
					this._state.thinkingLevel = msg.data.thinkingLevel;
				}
				this.emit({ type: "state_update", data: msg.data });
				break;

			case "messages": {
				const msgs = Array.isArray(msg.data) ? msg.data : msg.data?.messages;
				if (Array.isArray(msgs)) {
					this._state.messages = msgs.map(enrichUserMessage);

					// Re-append any live-event messages missing from the server
					// response.  This prevents the wholesale replacement from
					// silently dropping messages that arrived via message_end
					// between a get_messages request and its response.
					if (this._liveEventMessages.length > 0) {
						const serverTexts = new Set(
							this._state.messages
								.filter((m: any) => m.role === "user" || m.role === "user-with-attachments")
								.map((m: any) => extractText(m))
						);
						for (const liveMsg of this._liveEventMessages) {
							if (!serverTexts.has(extractText(liveMsg))) {
								this._state.messages = [...this._state.messages, liveMsg];
							}
						}
						this._liveEventMessages = [];
					}

					// Re-append synthetic compaction messages (/compact + result)
					// so they survive the server's post-compaction refresh.
					if (this._compactionSyntheticMessages.length > 0) {
						this._state.messages = [...this._state.messages, ...this._compactionSyntheticMessages];
					}
					// Emit message_end for each message so AgentInterface re-renders
					for (const m of this._state.messages) {
						this.emit({ type: "message_end", message: m });
					}
					// Scan loaded messages for goal proposals (e.g. reconnecting to an existing session).
					// If proposal checking is deferred (draft restores in progress),
					// just flag that we have proposals to check later.
					if (this._deferProposalCheck) {
						this._hasDeferredProposals = true;
					} else {
						for (const m of this._state.messages) {
							if (m.role === "assistant") {
								this._checkProposals(m);
							}
						}
					}
					// Re-add compacting placeholder if compaction is still in progress
					if (this._isCompacting) {
						this._addCompactingPlaceholder();
					}
					// Append reconnect notification after messages are refreshed
					if (this._pendingReconnectNotif) {
						this._pendingReconnectNotif = false;
						this._appendNotification("Reconnected to server", "system");
					}
					// Note: we intentionally do NOT try to reconstruct streamMessage
					// for late-joining clients. The message-list will show all messages
					// including pending tool calls. The streaming container will pick up
					// new events as they arrive.
				}
				break;
			}

			case "event":
				if (msg.data?.type === "agent_start" || msg.data?.type === "agent_end") {
					console.log(`[RemoteAgent] event: ${msg.data.type}, isStreaming: ${this._state.isStreaming}`);
				}
				this.handleAgentEvent(msg.data);
				break;

			case "session_status":
				console.log(`[RemoteAgent] session_status: ${msg.status}, isStreaming was: ${this._state.isStreaming}`);
				if (msg.status === "archived") {
					this._state.isStreaming = false;
					this._state.isArchived = true;
					this._state.isPreparing = false;
					if (msg.archivedAt) this._state.archivedAt = msg.archivedAt;
					this._state.turnStartTime = null;
				} else if (msg.status === "preparing") {
					this._state.isPreparing = true;
					this._state.isStreaming = false;
					this._state.isArchived = false;
					this._state.turnStartTime = null;
				} else {
					this._state.isStreaming = msg.status === "streaming";
					this._state.isArchived = false;
					this._state.isPreparing = false;
					if (msg.status === "streaming") {
						this._state.turnStartTime = msg.streamingStartedAt ?? this._state.turnStartTime ?? Date.now();
					} else {
						this._state.turnStartTime = null;
					}
				}
				if (msg.status !== "streaming") this._isAborting = false;
				this.onStatusChange?.(msg.status);
				break;

			case "session_title":
				this._title = msg.title;
				this.onTitleChange?.(msg.title);
				break;

			case "queue_update":
				this._serverQueue = Array.isArray(msg.queue) ? msg.queue : [];
				this.onQueueUpdate?.(this._serverQueue);
				break;

			case "goal_setup_complete":
			case "goal_setup_error":
				this.onGoalSetupEvent?.();
				break;

			case "task_changed": {
				const task = msg.task as any;
				if (task && !task._deleted) {
					if (task.state === "complete") {
						this._appendNotification(`Task "${task.title}" completed`, "task");
					} else if (task.state === "blocked") {
						this._appendNotification(`Task "${task.title}" blocked`, "task");
					} else if (task.state === "in-progress" && task.assignedSessionId) {
						this._appendNotification(`Task "${task.title}" assigned`, "task");
					}
				}
				break;
			}

			case "gate_status_changed": {
				const gateCat = (msg as any).status === "failed" ? "error" as const : "task" as const;
				this._appendNotification(`Gate "${(msg as any).gateId}" \u2192 ${(msg as any).status}`, gateCat);
				refreshGateStatusForGoal((msg as any).goalId);
				break;
			}

			case "gate_verification_started":
			case "gate_verification_step_complete":
			case "gate_verification_step_started":
			case "gate_verification_step_output":
				document.dispatchEvent(new CustomEvent("gate-verification-event", { detail: msg }));
				break;

			case "gate_verification_complete": {
				const gateVerifCat = (msg as any).status === "failed" ? "error" as const : "task" as const;
				this._appendNotification(`Gate "${(msg as any).gateId}" verification ${(msg as any).status}`, gateVerifCat);
				document.dispatchEvent(new CustomEvent("gate-verification-event", { detail: msg }));
				refreshGateStatusForGoal((msg as any).goalId);
				break;
			}

			case "team_agent_spawned":
				this._appendNotification(`Agent ${(msg as any).name} (${(msg as any).role}) started`, "team");
				break;

			case "team_agent_dismissed":
				this._appendNotification(`Agent ${(msg as any).name} (${(msg as any).role}) dismissed`, "team");
				break;

			case "team_agent_finished":
				this._appendNotification(`Agent ${(msg as any).name} (${(msg as any).role}) finished`, "team");
				break;

			case "preferences_changed":
				this._applyPreferences(msg.preferences);
				break;

			case "preview_changed":
				this.onPreviewChanged?.(msg.sessionId, msg.preview);
				break;

			case "bg_process_created":
			case "bg_process_output":
			case "bg_process_exited":
				this.onBgProcessEvent?.(msg as any);
				break;

			case "pr_status_changed":
				if ((msg as any).goalId) this.onPrStatusChanged?.((msg as any).goalId);
				break;

			case "error":
				console.error(`[RemoteAgent] Server error: ${msg.message} (${msg.code})`);
				// If we were streaming, stop. If there's a pending prompt that
				// failed, the user message was already cleared from the editor
				// but never echoed back — surface the error so the user knows.
				this._state.isStreaming = false;
				this._state.turnStartTime = null;
				this._state.error = msg.message || "Unknown server error";
				this._pendingAttachments = null;
				// Add a dismissable error message to the chat history
				this._state.messages = [...this._state.messages, {
					role: "error",
					content: msg.message || "Unknown server error",
					code: msg.code,
					timestamp: Date.now(),
					id: `err_${Date.now()}_${Math.random().toString(36).slice(2)}`,
				} as any];
				this._appendNotification(msg.message || "Unknown server error", "error");
				this.emit({ type: "error", error: msg.message });
				break;
		}
	}

	/**
	 * Move any deferred assistant message into the stable messages array
	 * and clear streamMessage. Called at points where the streaming container
	 * is simultaneously updated (message_update replaces its content,
	 * message_end of non-assistant clears it, agent_end clears it) so the
	 * tool call never appears in both message-list and streaming-container.
	 */
	/** Check an assistant message for proposal blocks and fire the matching callback. */
	private _checkProposals(message: any): void {
		let text = "";
		if (typeof message.content === "string") text = message.content;
		else if (Array.isArray(message.content)) {
			text = message.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("");
		}
		if (!text) return;

		for (const parser of PROPOSAL_PARSERS) {
			const callback = (this as any)[parser.callbackName];
			if (!callback) continue;

			const match = text.match(new RegExp(`<${parser.tag}>([\\s\\S]*?)<\\/${parser.tag}>`));
			if (!match) continue;

			const block = match[1];
			const result: Record<string, string> = {};
			for (const field of parser.fields) {
				const m = block.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
				result[field] = m ? m[1].trim() : "";
			}

			// Normalize hyphenated keys to camelCase
			const normalized: Record<string, string> = {};
			for (const [k, v] of Object.entries(result)) {
				normalized[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
			}

			const missing = parser.requiredFields.some(f => {
				const key = f.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
				return !normalized[key];
			});
			if (missing) continue;

			callback(normalized);
		}
	}

	private _applyPreferences(prefs: Record<string, unknown>): void {
		if (!prefs || typeof prefs !== "object") return;

		// Apply palette
		if ("palette" in prefs) {
			const palette = prefs.palette as string;
			if (!palette || palette === "forest") {
				delete document.documentElement.dataset.palette;
				localStorage.removeItem('palette');
			} else {
				document.documentElement.dataset.palette = palette;
				localStorage.setItem('palette', palette);
			}
		}

		// Apply showTimestamps
		if ("showTimestamps" in prefs) {
			document.documentElement.dataset.showTimestamps = prefs.showTimestamps ? "true" : "";
		}

		// Apply shortcuts
		if ("shortcuts" in prefs) {
			import("./shortcut-registry.js").then((m) => m.loadSavedBindings());
		}

	}

	private _appendNotification(message: string, category: "system" | "task" | "team" | "error"): void {
		const notif = createSystemNotification(message, category);
		this._state.messages = [...this._state.messages, notif];
		this.emit({ type: "message_end", message: notif });
	}

	private flushDeferredMessage() {
		if (this._deferredAssistantMessage) {
			this._state.messages = [...this._state.messages, this._deferredAssistantMessage];
			this._state.streamMessage = null;
			this._deferredAssistantMessage = null;
		}
	}

	private handleAgentEvent(event: any) {
		// Update local state BEFORE emitting (UI reads state in event handlers)
		switch (event.type) {
			case "agent_start":
				this._state.isStreaming = true;
				this._state.error = undefined;
				this._taskStartTime = Date.now();
				this._state.turnStartTime = this._taskStartTime;
				break;

			case "agent_end": {
				this.flushDeferredMessage();
				this._state.isStreaming = false;
				this._isAborting = false;
				this._state.streamMessage = null;
				this._state.pendingToolCalls = new Set();

				// Notify: beep + favicon badge
				RemoteAgent.playNotificationBeep();
				showFaviconBadge();

				this._taskStartTime = null;
				this._state.turnStartTime = null;
				break;
			}

			case "message_start":
				// Don't add messages here — wait for message_end which
				// carries the finalized message and allows proper ordering
				// with any deferred assistant message.
				break;

			case "message_update":
				// Flush any deferred assistant message now that a new message
				// is being streamed — the streaming container will switch to
				// the new message via setMessage(), so the old one only lives
				// in message-list from now on.
				this.flushDeferredMessage();
				if (event.message) {
					this._state.streamMessage = event.message;
					// Check for proposals during streaming so preview syncs live
					this._checkProposals(event.message);
				}
				break;

			case "message_end":
				if (event.message) {
					if (event.message.role === "assistant") {
						// Check for proposals in assistant message
						this._checkProposals(event.message);

						// Check whether this assistant message contains tool calls.
						const hasToolCalls = Array.isArray(event.message.content) &&
							event.message.content.some((c: any) => c.type === "toolCall");

						if (hasToolCalls) {
							// Defer adding the message to messages[]. The streaming
							// container still holds this message from the last
							// message_update, so it will keep rendering the tool
							// call. By NOT adding to messages[] we avoid a duplicate
							// in message-list. The deferred message will be flushed
							// when the next message_update arrives (which replaces
							// the streaming container content simultaneously).
							this._deferredAssistantMessage = event.message;
							// Keep streamMessage set so the AgentInterface
							// message_end handler does NOT clear the streaming
							// container.
						} else {
							// No tool calls — safe to add immediately.
							this._state.streamMessage = null;
							this._state.messages = [...this._state.messages, event.message];
						}
					} else {
						// Non-assistant messages (user, toolResult).
						// Flush any deferred assistant message first so it
						// appears before this message in the correct order.
						this.flushDeferredMessage();
						this._state.streamMessage = null;

						let msg = event.message;
						// Enrich echoed user messages with stashed attachments
						// so image thumbnails render in the message list.
						if (msg.role === "user" && this._pendingAttachments) {
							msg = {
								...msg,
								role: "user-with-attachments",
								attachments: this._pendingAttachments,
							};
							this._pendingAttachments = null;
						}

						// Deduplicate: if this is a server echo of an optimistic user
						// message, replace the optimistic one instead of appending.
						if (msg.role === "user" || msg.role === "user-with-attachments") {
							const msgText = extractText(msg);
							const optimisticIdx = this._state.messages.findIndex(
								(m: any) => m.id?.startsWith("optimistic_") && extractText(m) === msgText
							);
							if (optimisticIdx !== -1) {
								const replacedId = this._state.messages[optimisticIdx].id;
								const updated = [...this._state.messages];
								updated[optimisticIdx] = msg;
								this._state.messages = updated;
								// Update live tracking: swap optimistic for server-authoritative
								this._liveEventMessages = this._liveEventMessages
									.filter((m: any) => m.id !== replacedId);
								this._liveEventMessages.push(msg);
								break;
							}
						}

						this._state.messages = [...this._state.messages, msg];

						// Track user messages from live events so they survive
						// a wholesale messages refresh (reconnect, compaction).
						if (msg.role === "user" || msg.role === "user-with-attachments") {
							this._liveEventMessages.push(msg);
						}
					}
				}
				break;

			case "tool_execution_start":
				if (event.toolCallId) {
					this._state.pendingToolCalls = new Set(this._state.pendingToolCalls);
					this._state.pendingToolCalls.add(event.toolCallId);
				}
				break;

			case "tool_execution_update":
				// Store partial results from long-running tools (e.g., skill invocations)
				// so the UI can show real-time progress.
				if (event.toolCallId && event.partialResult) {
					if (!this._state.toolPartialResults) {
						this._state.toolPartialResults = {};
					}
					this._state.toolPartialResults = {
						...this._state.toolPartialResults,
						[event.toolCallId]: event.partialResult,
					};
					// Notify UI to re-render with partial results
					this.onWorkflowUpdate?.();
					this.emit(event);
					return; // skip default emit at end
				}
				break;

			case "tool_execution_end":
				if (event.toolCallId) {
					this._state.pendingToolCalls = new Set(this._state.pendingToolCalls);
					this._state.pendingToolCalls.delete(event.toolCallId);
					// Clean up partial result now that the tool is done
					if (this._state.toolPartialResults?.[event.toolCallId]) {
						const { [event.toolCallId]: _, ...rest } = this._state.toolPartialResults;
						this._state.toolPartialResults = Object.keys(rest).length > 0 ? rest : undefined;
					}
				}
				break;

			case "compaction_start":
			case "auto_compaction_start":
				// Don't set isStreaming — compaction uses its own blob animation
				this._isCompacting = true;
				// Add a placeholder message so compaction is visible in chat history
				this._addCompactingPlaceholder();
				// Normalize to compaction_start for UI subscribers
				if (event.type === "auto_compaction_start") {
					this.emit({ type: "compaction_start" } as any);
					return; // skip the default emit at the end
				}
				break;

			// The agent subprocess may send error responses with id:undefined
			// (upstream bug). These arrive as events rather than RPC responses.
			// Treat compact-related errors as compaction_end so the UI recovers.
			case "response":
				if (!event.success && event.error) {
					// Synthesize a compaction_end event so the blob animation ends
					this.emit({ type: "compaction_end", success: false, error: event.error });
				}
				break;

			case "compaction_end":
			case "auto_compaction_end": {
				this._isCompacting = false;
				// Replace the placeholder with the final result message
				const filtered = this._state.messages.filter((m: any) => m.id !== "compacting_placeholder");
				const success = event.type === "compaction_end" ? event.success : !event.aborted;
				const tokensBefore = (event as any).tokensBefore;
				let resultText = "Context compacted.";
				if (tokensBefore) {
					const fmt = tokensBefore < 1000 ? `${tokensBefore}` : tokensBefore < 1_000_000 ? `${(tokensBefore / 1000).toFixed(1)}k` : `${(tokensBefore / 1_000_000).toFixed(1)}M`;
					resultText = `Context compacted from ${fmt} tokens.`;
				}
				const resultMsg = success
					? {
						role: "assistant" as const,
						content: [{ type: "text", text: resultText }],
						timestamp: Date.now(),
						id: `compact_done_${Date.now()}`,
					}
					: {
						role: "assistant" as const,
						content: [{ type: "text", text: `Compaction failed: ${(event as any).error || ((event as any).aborted ? "Compaction aborted" : "Unknown error")}` }],
						timestamp: Date.now(),
						id: `compact_err_${Date.now()}`,
					};
				this._state.messages = [...filtered, resultMsg as any];
				// Store the result message so it survives the server's messages refresh
				this._compactionSyntheticMessages = [
					...this._compactionSyntheticMessages.filter((m: any) => m.role === "user"),
					resultMsg,
				];
				// Normalize to compaction_end for UI subscribers
				if (event.type === "auto_compaction_end") {
					this.emit({ type: "compaction_end", success } as any);
					return; // skip the default emit at the end
				}
				// State and messages refresh will arrive from the server
				break;
			}
		}

		// Forward event to UI subscribers
		this.emit(event);
	}
}

/**
 * When restoring messages from the server (page refresh, reconnect),
 * user messages with image content arrive as `{ role: "user", content: [...] }`
 * but the UI needs `role: "user-with-attachments"` with an `attachments` array
 * to render image thumbnails. This function reconstructs that format.
 */
function enrichUserMessage(msg: any): any {
	if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

	const imageChunks = msg.content.filter((c: any) => c.type === "image" && c.data);
	if (imageChunks.length === 0) return msg;

	const attachments = imageChunks.map((img: any, i: number) => ({
		id: `restored_${i}_${Date.now()}`,
		type: "image" as const,
		fileName: `image-${i + 1}.png`,
		mimeType: img.mimeType || img.media_type || "image/png",
		size: img.data?.length || 0,
		content: img.data,
		preview: img.data,
	}));

	return {
		...msg,
		role: "user-with-attachments",
		attachments,
	};
}

function extractText(message: any): string {
	if (!message) return "";
	if (typeof message === "string") return message;
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text || "")
			.join("\n");
	}
	return "";
}
