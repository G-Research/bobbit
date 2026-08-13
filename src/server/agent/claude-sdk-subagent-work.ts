import { adaptSdkSessionMessages, type ClaudeAgentSdkHistoryMessage } from "./claude-agent-sdk-history-adapter.js";
import {
	readSdkSubagentMessages,
	readSdkSubagents,
	type ClaudeAgentSdkSessionAccessDeps,
} from "./claude-agent-sdk-session-access.js";

export type ClaudeSdkSubagentPhase = "pending" | "running" | "completed" | "error" | "aborted" | "unknown";

export interface ClaudeSdkSubagentIdentity {
	readonly parentToolUseId: string;
	readonly agentId?: string;
	readonly agentType?: string;
}

export interface ClaudeSdkEmbeddedWork {
	readonly parentToolUseId: string;
	readonly agentId?: string;
	readonly agentType?: string;
	/** Every verified/recovered identity that contributed work to this parent. */
	readonly identities?: readonly ClaudeSdkSubagentIdentity[];
	readonly phase: ClaudeSdkSubagentPhase;
	readonly startedAt?: number;
	readonly stoppedAt?: number;
	/** Ordered child-only source rows. Opaque SDK metadata remains on each row. */
	readonly messages: readonly ClaudeAgentSdkHistoryMessage[];
	readonly pendingToolCallIds: readonly string[];
	readonly diagnostic?: "unknown-parent" | "recovery-unavailable" | "recovery-mismatch";
}

export interface ClaudeSdkEmbeddedWorkEvent {
	readonly type: "claude_sdk_subagent_work";
	readonly parentToolUseId: string;
	readonly kind: "start" | "message" | "tool_start" | "tool_end" | "stop" | "terminal" | "recovered";
	readonly identity?: ClaudeSdkSubagentIdentity;
	readonly message?: ClaudeAgentSdkHistoryMessage;
	readonly toolEvent?: Record<string, unknown>;
	readonly terminal?: { phase: ClaudeSdkSubagentPhase; error?: string };
}

export interface ClaudeSdkSubagentLifecycleRecord {
	readonly kind: "start" | "stop" | "aborted";
	readonly entry: Readonly<{ toolUseId: string; agentId: string; agentType: string }>;
	readonly at: number;
}

export interface ClaudeSdkEmbeddedWorkProjection {
	readonly rootMessages: readonly ClaudeAgentSdkHistoryMessage[];
	readonly workByParent: ReadonlyMap<string, ClaudeSdkEmbeddedWork>;
	readonly diagnostics: readonly string[];
}

export interface ClaudeSdkSubagentRecoveryOptions {
	readonly sessionId: string;
	readonly cwd?: string;
	readonly access: ClaudeAgentSdkSessionAccessDeps;
	/** Bounds calls to listSubagents; ids still do not establish a parent join. */
	readonly maxSubagents?: number;
}

const MAX_ID_BYTES = 512;
const MAX_RECOVERY_SUBAGENTS = 32;

function boundedId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function sourceId(message: ClaudeAgentSdkHistoryMessage): string | undefined {
	return boundedId(message.id) ? message.id : undefined;
}

function toolCalls(message: ClaudeAgentSdkHistoryMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block: unknown) => isRecord(block) && block.type === "toolCall" && boundedId(block.id) ? [block.id] : []);
}

function toolResultId(message: ClaudeAgentSdkHistoryMessage): string | undefined {
	return message.role === "toolResult" && boundedId(message.toolCallId) ? message.toolCallId : undefined;
}

function eventParent(event: unknown): string | undefined {
	return isRecord(event) && boundedId(event.parentToolUseId) ? event.parentToolUseId : undefined;
}

function eventIdentity(event: Record<string, unknown>, parentToolUseId: string): ClaudeSdkSubagentIdentity | undefined {
	const agentId = boundedId(event.agentId) ? event.agentId : undefined;
	const agentType = typeof event.agentType === "string" && event.agentType.length > 0 ? event.agentType.slice(0, MAX_ID_BYTES) : undefined;
	return agentId || agentType ? { parentToolUseId, ...(agentId ? { agentId } : {}), ...(agentType ? { agentType } : {}) } : undefined;
}

function phaseForTerminal(value: unknown): { phase: ClaudeSdkSubagentPhase; error?: string } {
	const terminal = isRecord(value) ? value : {};
	const error = typeof terminal.error === "string" ? terminal.error.slice(0, 2_000) : undefined;
	const reason = typeof terminal.terminalReason === "string" ? terminal.terminalReason : "";
	if (error || /^error/i.test(reason)) return { phase: "error", ...(error ? { error } : {}) };
	if (/^abort/i.test(reason)) return { phase: "aborted", ...(error ? { error } : {}) };
	return { phase: "completed" };
}

type IdentityState = ClaudeSdkSubagentIdentity & {
	phase: ClaudeSdkSubagentPhase;
	startedAt?: number;
	stoppedAt?: number;
};

type WorkState = {
	parentToolUseId: string;
	messages: Map<string, ClaudeAgentSdkHistoryMessage>;
	pendingToolCallIds: Set<string>;
	identities: Map<string, IdentityState>;
	phase: ClaudeSdkSubagentPhase;
	startedAt?: number;
	stoppedAt?: number;
	diagnostic?: ClaudeSdkEmbeddedWork["diagnostic"];
};

function identityKey(identity: ClaudeSdkSubagentIdentity): string {
	return identity.agentId ? `agent:${identity.agentId}` : `type:${identity.agentType ?? "unknown"}`;
}

function initialState(parentToolUseId: string): WorkState {
	return { parentToolUseId, messages: new Map(), pendingToolCallIds: new Set(), identities: new Map(), phase: "unknown" };
}

function aggregatePhase(state: WorkState): ClaudeSdkSubagentPhase {
	const phases = [...state.identities.values()].map(identity => identity.phase);
	if (phases.includes("running")) return "running";
	if (phases.includes("pending")) return "pending";
	if (phases.includes("error")) return "error";
	if (phases.includes("aborted")) return "aborted";
	if (phases.includes("completed")) return "completed";
	return state.phase;
}

function publicWork(state: WorkState): ClaudeSdkEmbeddedWork {
	const identities = [...state.identities.values()].map(({ parentToolUseId, agentId, agentType }) => ({
		parentToolUseId,
		...(agentId ? { agentId } : {}),
		...(agentType ? { agentType } : {}),
	}));
	const first = identities[0];
	const startedAt = [...state.identities.values()].map(value => value.startedAt).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0] ?? state.startedAt;
	const stoppedAt = [...state.identities.values()].map(value => value.stoppedAt).filter((value): value is number => value !== undefined).sort((a, b) => b - a)[0] ?? state.stoppedAt;
	return {
		parentToolUseId: state.parentToolUseId,
		...(first?.agentId ? { agentId: first.agentId } : {}),
		...(first?.agentType ? { agentType: first.agentType } : {}),
		...(identities.length > 0 ? { identities } : {}),
		phase: aggregatePhase(state),
		...(startedAt !== undefined ? { startedAt } : {}),
		...(stoppedAt !== undefined ? { stoppedAt } : {}),
		messages: [...state.messages.values()],
		pendingToolCallIds: [...state.pendingToolCallIds],
		...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
	};
}

/**
 * The only replay identity for source rows is `parentToolUseId + source UUID`.
 * It deliberately never examines usage/cost, which remains opaque source data.
 */
export class ClaudeSdkSubagentWorkAssembler {
	private readonly work = new Map<string, WorkState>();
	private readonly knownParents = new Set<string>();
	private readonly recoveryInFlight = new Map<string, Promise<readonly ClaudeSdkEmbeddedWorkEvent[]>>();
	private readonly recovery: ClaudeSdkSubagentRecoveryOptions | undefined;

	constructor(options: { recovery?: ClaudeSdkSubagentRecoveryOptions } = {}) {
		this.recovery = options.recovery;
	}

	setKnownParentToolUseIds(parentToolUseIds: readonly string[]): void {
		for (const parent of parentToolUseIds) {
			if (!boundedId(parent)) continue;
			this.knownParents.add(parent);
			const state = this.work.get(parent);
			if (state?.diagnostic === "unknown-parent") state.diagnostic = undefined;
		}
	}

	private state(parentToolUseId: string): WorkState {
		let state = this.work.get(parentToolUseId);
		if (!state) {
			state = initialState(parentToolUseId);
			if (!this.knownParents.has(parentToolUseId)) state.diagnostic = "unknown-parent";
			this.work.set(parentToolUseId, state);
		}
		return state;
	}

	private addIdentity(parentToolUseId: string, identity: ClaudeSdkSubagentIdentity | undefined, phase: ClaudeSdkSubagentPhase, at?: number): void {
		if (!identity) return;
		const state = this.state(parentToolUseId);
		const key = identityKey(identity);
		const existing = state.identities.get(key);
		state.identities.set(key, {
			...existing,
			...identity,
			phase,
			...(phase === "running" ? { startedAt: existing?.startedAt ?? at } : {}),
			...(phase === "completed" || phase === "error" || phase === "aborted" ? { stoppedAt: at } : {}),
		});
		if (phase === "running") state.startedAt ??= at;
		if (phase === "completed" || phase === "error" || phase === "aborted") state.stoppedAt = at ?? state.stoppedAt;
		state.phase = aggregatePhase(state);
	}

	ingestMessage(message: ClaudeAgentSdkHistoryMessage, kind: "message" | "recovered" = "message"): readonly ClaudeSdkEmbeddedWorkEvent[] {
		const parentToolUseId = boundedId(message.parentToolUseId) ? message.parentToolUseId : undefined;
		const id = sourceId(message);
		if (!parentToolUseId || !id) return [];
		const state = this.state(parentToolUseId);
		state.messages.set(id, message);
		for (const toolCallId of toolCalls(message)) state.pendingToolCallIds.add(toolCallId);
		const resultId = toolResultId(message);
		if (resultId) state.pendingToolCallIds.delete(resultId);
		this.addIdentity(parentToolUseId, message.parentAgentId && boundedId(message.parentAgentId)
			? { parentToolUseId, agentId: message.parentAgentId } : undefined, "unknown");
		return [{ type: "claude_sdk_subagent_work", parentToolUseId, kind, message }];
	}

	ingestLifecycle(record: ClaudeSdkSubagentLifecycleRecord): readonly ClaudeSdkEmbeddedWorkEvent[] {
		const { entry } = record;
		if (!boundedId(entry.toolUseId) || !boundedId(entry.agentId) || !boundedId(entry.agentType)) return [];
		const identity: ClaudeSdkSubagentIdentity = { parentToolUseId: entry.toolUseId, agentId: entry.agentId, agentType: entry.agentType };
		const phase = record.kind === "start" ? "running" : record.kind === "stop" ? "completed" : "aborted";
		this.addIdentity(entry.toolUseId, identity, phase, record.at);
		return [{
			type: "claude_sdk_subagent_work", parentToolUseId: entry.toolUseId,
			kind: record.kind === "start" ? "start" : "stop", identity,
			...(record.kind === "start" ? {} : { terminal: { phase } }),
		}];
	}

	ingestTerminal(
		parentToolUseId: string,
		terminal: { phase: ClaudeSdkSubagentPhase; error?: string },
		identity?: ClaudeSdkSubagentIdentity,
	): readonly ClaudeSdkEmbeddedWorkEvent[] {
		if (!boundedId(parentToolUseId)) return [];
		this.addIdentity(parentToolUseId, identity, terminal.phase);
		const state = this.state(parentToolUseId);
		if (!identity) state.phase = terminal.phase;
		return [{ type: "claude_sdk_subagent_work", parentToolUseId, kind: "terminal", identity, terminal }];
	}

	ingestLiveEvent(event: unknown): readonly ClaudeSdkEmbeddedWorkEvent[] {
		if (!isRecord(event)) return [];
		const parentToolUseId = eventParent(event);
		if (!parentToolUseId) return [];
		const identity = eventIdentity(event, parentToolUseId);
		const type = event.type;
		if (type === "tool_execution_start" && boundedId(event.toolCallId)) {
			this.state(parentToolUseId).pendingToolCallIds.add(event.toolCallId);
			return [{ type: "claude_sdk_subagent_work", parentToolUseId, kind: "tool_start", identity, toolEvent: event }];
		}
		if (type === "tool_execution_end" && boundedId(event.toolCallId)) {
			this.state(parentToolUseId).pendingToolCallIds.delete(event.toolCallId);
			return [{ type: "claude_sdk_subagent_work", parentToolUseId, kind: "tool_end", identity, toolEvent: event }];
		}
		if (type === "agent_end") {
			return this.ingestTerminal(parentToolUseId, phaseForTerminal(isRecord(event.claudeSdk) ? event.claudeSdk.terminal : undefined), identity);
		}
		if ((type === "message_update" || type === "message_end") && isRecord(event.message)) {
			const candidate = event.message as ClaudeAgentSdkHistoryMessage;
			const row: ClaudeAgentSdkHistoryMessage = {
				...candidate,
				id: boundedId(candidate.id) ? candidate.id : (boundedId(event.sourceId) ? event.sourceId : ""),
				...(candidate.parentToolUseId ? {} : { parentToolUseId }),
			};
			return this.ingestMessage(row);
		}
		return [];
	}

	snapshot(): ReadonlyMap<string, ClaudeSdkEmbeddedWork> {
		return new Map([...this.work].map(([parent, state]) => [parent, publicWork(state)]));
	}

	async recover(parentToolUseId: string): Promise<readonly ClaudeSdkEmbeddedWorkEvent[]> {
		if (!boundedId(parentToolUseId) || !this.recovery) return [];
		const inFlight = this.recoveryInFlight.get(parentToolUseId);
		if (inFlight) return inFlight;
		const recovery = this.recoverOnce(parentToolUseId).finally(() => this.recoveryInFlight.delete(parentToolUseId));
		this.recoveryInFlight.set(parentToolUseId, recovery);
		return recovery;
	}

	private async recoverOnce(parentToolUseId: string): Promise<readonly ClaudeSdkEmbeddedWorkEvent[]> {
		const state = this.state(parentToolUseId);
		try {
			const knownIds = [...state.identities.values()].map(identity => identity.agentId).filter((id): id is string => !!id);
			const listed = knownIds.length > 0 ? knownIds : await readSdkSubagents({ sessionId: this.recovery!.sessionId, cwd: this.recovery!.cwd }, this.recovery!.access);
			const ids = [...new Set(listed)].slice(0, this.recovery!.maxSubagents ?? MAX_RECOVERY_SUBAGENTS);
			const events: ClaudeSdkEmbeddedWorkEvent[] = [];
			let mismatch = false;
			for (const agentId of ids) {
				const messages = await readSdkSubagentMessages({ sessionId: this.recovery!.sessionId, cwd: this.recovery!.cwd, agentId }, this.recovery!.access);
				const rows = adaptSdkSessionMessages(messages);
				const parents = new Set(rows.map(row => row.parentToolUseId).filter((parent): parent is string => boundedId(parent)));
				// An SDK child id is not a parent join. Accept only one exact annotated parent.
				if (parents.size !== 1 || !parents.has(parentToolUseId)) { mismatch = true; continue; }
				for (const row of rows) if (row.parentToolUseId === parentToolUseId) events.push(...this.ingestMessage(row, "recovered"));
			}
			if (mismatch) state.diagnostic = "recovery-mismatch";
			else if (events.length > 0 && state.diagnostic === "recovery-unavailable") state.diagnostic = undefined;
			return events;
		} catch {
			state.diagnostic = "recovery-unavailable";
			return [];
		}
	}
}

/**
 * Split an official root history snapshot without admitting child rows to root
 * ordering. A non-empty parent id is the only partition key, even before its
 * root Agent card has appeared.
 */
export function projectClaudeSdkEmbeddedWork(messages: readonly ClaudeAgentSdkHistoryMessage[]): ClaudeSdkEmbeddedWorkProjection {
	const assembler = new ClaudeSdkSubagentWorkAssembler();
	const rootMessages: ClaudeAgentSdkHistoryMessage[] = [];
	const parents = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (isRecord(block) && block.type === "toolCall" && block.name === "Agent" && boundedId(block.id)) parents.add(block.id);
			}
		}
	}
	assembler.setKnownParentToolUseIds([...parents]);
	for (const message of messages) {
		if (boundedId(message.parentToolUseId)) assembler.ingestMessage(message);
		else rootMessages.push(message);
	}
	const workByParent = assembler.snapshot();
	return {
		rootMessages,
		workByParent,
		diagnostics: [...workByParent.values()].flatMap(work => work.diagnostic ? [`${work.parentToolUseId}:${work.diagnostic}`] : []),
	};
}
