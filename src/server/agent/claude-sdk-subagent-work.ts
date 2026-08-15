import { adaptSdkSessionMessages, type ClaudeAgentSdkHistoryMessage } from "./claude-agent-sdk-history-adapter.js";
import {
	readSdkSubagentMessages,
	readSdkSubagents,
	type ClaudeAgentSdkSessionAccessDeps,
	type SdkSessionMessage,
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
	/** Fixed public failure detail; provider error text is never projected. */
	readonly error?: "Subagent failed";
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
const SUBAGENT_FAILURE_DETAIL = "Subagent failed";
export const MAX_RECOVERY_SUBAGENTS = 32;
export const MAX_RECOVERY_CONCURRENCY = 4;
export const MAX_RECOVERY_ROWS = 1_000;
export const MAX_RECOVERY_BYTES = 16 * 1024 * 1024;
export const MAX_RECOVERY_MESSAGES_PER_SUBAGENT = 100;

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
	/** A replayed historical tool call must not re-open after its result. */
	completedToolCallIds: Set<string>;
	identities: Map<string, IdentityState>;
	phase: ClaudeSdkSubagentPhase;
	startedAt?: number;
	stoppedAt?: number;
	/** Never retain provider-controlled terminal details in UI-bound work state. */
	error?: "Subagent failed";
	diagnostic?: ClaudeSdkEmbeddedWork["diagnostic"];
};

function identityKey(identity: ClaudeSdkSubagentIdentity): string {
	return identity.agentId ? `agent:${identity.agentId}` : `type:${identity.agentType ?? "unknown"}`;
}

function initialState(parentToolUseId: string): WorkState {
	return { parentToolUseId, messages: new Map(), pendingToolCallIds: new Set(), completedToolCallIds: new Set(), identities: new Map(), phase: "unknown" };
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
		...(aggregatePhase(state) === "error" && state.error ? { error: state.error } : {}),
		messages: [...state.messages.values()],
		pendingToolCallIds: [...state.pendingToolCallIds],
		...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
	};
}

type RecoveredSubagentRows = {
	readonly rowsByParent: ReadonlyMap<string, readonly ClaudeAgentSdkHistoryMessage[]>;
	readonly unavailable: boolean;
	readonly boundedMismatch: boolean;
};

function recoverySubagentLimit(value: number | undefined): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? Math.min(value, MAX_RECOVERY_SUBAGENTS)
		: MAX_RECOVERY_SUBAGENTS;
}

function serializedByteLength(value: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads the official child store once for an entire root snapshot.  The SDK
 * child id only selects a bounded transcript request; every recovered row must
 * independently name an existing root Agent/Task call before it is admitted.
 */
async function recoverSubagentRows(
	parents: ReadonlySet<string>,
	recovery: ClaudeSdkSubagentRecoveryOptions,
): Promise<RecoveredSubagentRows> {
	const rowsByParent = new Map<string, ClaudeAgentSdkHistoryMessage[]>();
	for (const parent of parents) rowsByParent.set(parent, []);
	let listed: string[];
	try {
		listed = await readSdkSubagents({ sessionId: recovery.sessionId, cwd: recovery.cwd }, recovery.access);
	} catch {
		return { rowsByParent, unavailable: true, boundedMismatch: false };
	}

	const uniqueIds = [...new Set(listed)];
	const maxSubagents = recoverySubagentLimit(recovery.maxSubagents);
	const ids = uniqueIds.slice(0, maxSubagents);
	let boundedMismatch = uniqueIds.length > ids.length;
	let unavailable = false;
	let remainingRows = MAX_RECOVERY_ROWS;
	let remainingBytes = MAX_RECOVERY_BYTES;
	let next = 0;
	const sourceRows: SdkSessionMessage[][] = Array.from({ length: ids.length }, () => []);

	const worker = async (): Promise<void> => {
		while (next < ids.length && remainingRows > 0 && remainingBytes > 0) {
			const index = next++;
			const idsRemaining = ids.length - index;
			// Reserve the row allowance before awaiting. This makes concurrent calls
			// globally bounded while still allowing every capped child a chance.
			const limit = Math.min(MAX_RECOVERY_MESSAGES_PER_SUBAGENT, Math.max(1, Math.floor(remainingRows / idsRemaining)));
			remainingRows -= limit;
			let fetched: SdkSessionMessage[];
			try {
				fetched = await readSdkSubagentMessages({
					sessionId: recovery.sessionId,
					cwd: recovery.cwd,
					agentId: ids[index],
					limit,
				}, recovery.access);
			} catch {
				unavailable = true;
				continue;
			}
			if (!Array.isArray(fetched)) {
				unavailable = true;
				continue;
			}
			if (fetched.length > limit) boundedMismatch = true;
			for (const sourceRow of fetched.slice(0, limit)) {
				const bytes = serializedByteLength(sourceRow);
				if (bytes === undefined || bytes > remainingBytes) {
					boundedMismatch = true;
					break;
				}
				remainingBytes -= bytes;
				sourceRows[index].push(sourceRow);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(MAX_RECOVERY_CONCURRENCY, ids.length) }, worker));
	if (next < ids.length || remainingRows === 0 || remainingBytes === 0) boundedMismatch = true;

	// Flatten in SDK list order, not worker-completion order. Child-local order
	// comes directly from the one bounded SDK request for that child.
	let acceptedRows = 0;
	for (const childRows of sourceRows) {
		let rows: ClaudeAgentSdkHistoryMessage[];
		try { rows = adaptSdkSessionMessages(childRows); }
		catch { boundedMismatch = true; continue; }
		for (const row of rows) {
			if (acceptedRows >= MAX_RECOVERY_ROWS) {
				boundedMismatch = true;
				break;
			}
			const parent = boundedId(row.parentToolUseId) ? row.parentToolUseId : undefined;
			if (!parent || !parents.has(parent)) {
				boundedMismatch = true;
				continue;
			}
			rowsByParent.get(parent)!.push(row);
			acceptedRows += 1;
		}
	}
	return { rowsByParent, unavailable, boundedMismatch };
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
		for (const toolCallId of toolCalls(message)) {
			if (!state.completedToolCallIds.has(toolCallId)) state.pendingToolCallIds.add(toolCallId);
		}
		const resultId = toolResultId(message);
		if (resultId) {
			state.completedToolCallIds.add(resultId);
			state.pendingToolCallIds.delete(resultId);
		}
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
		const safeTerminal = terminal.phase === "error"
			? { phase: terminal.phase, error: SUBAGENT_FAILURE_DETAIL } as const
			: { phase: terminal.phase } as const;
		this.addIdentity(parentToolUseId, identity, safeTerminal.phase);
		const state = this.state(parentToolUseId);
		if (!identity) state.phase = safeTerminal.phase;
		if (safeTerminal.phase === "error") state.error = SUBAGENT_FAILURE_DETAIL;
		else if (!identity) state.error = undefined;
		return [{ type: "claude_sdk_subagent_work", parentToolUseId, kind: "terminal", identity, terminal: safeTerminal }];
	}

	ingestLiveEvent(event: unknown): readonly ClaudeSdkEmbeddedWorkEvent[] {
		if (!isRecord(event)) return [];
		const parentToolUseId = eventParent(event);
		if (!parentToolUseId) return [];
		const identity = eventIdentity(event, parentToolUseId);
		const type = event.type;
		if (type === "tool_execution_start" && boundedId(event.toolCallId)) {
			const state = this.state(parentToolUseId);
			if (!state.completedToolCallIds.has(event.toolCallId)) state.pendingToolCallIds.add(event.toolCallId);
			return [{ type: "claude_sdk_subagent_work", parentToolUseId, kind: "tool_start", identity, toolEvent: event }];
		}
		if (type === "tool_execution_end" && boundedId(event.toolCallId)) {
			const state = this.state(parentToolUseId);
			state.completedToolCallIds.add(event.toolCallId);
			state.pendingToolCallIds.delete(event.toolCallId);
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
		const recovered = await recoverSubagentRows(new Set([parentToolUseId]), this.recovery!);
		const events = recovered.rowsByParent.get(parentToolUseId)?.flatMap(row => this.ingestMessage(row, "recovered")) ?? [];
		if (recovered.unavailable) state.diagnostic = "recovery-unavailable";
		else if (recovered.boundedMismatch) state.diagnostic = "recovery-mismatch";
		else if (events.length > 0 && state.diagnostic === "recovery-unavailable") state.diagnostic = undefined;
		return events;
	}
}

/**
 * Split an official root history snapshot without admitting child rows to root
 * ordering. A non-empty parent id is the only partition key, even before its
 * root Agent card has appeared.
 */
function rootAgentParentBoundaries(messages: readonly ClaudeAgentSdkHistoryMessage[]): Map<string, number> {
	const boundaries = new Map<string, number>();
	for (const [index, message] of messages.entries()) {
		// A child can itself issue an Agent-shaped call. It is not a root parent
		// and must not make a grandchild recoverable into the root snapshot.
		if (message.parentToolUseId !== undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isRecord(block) && block.type === "toolCall" && (block.name === "Agent" || block.name === "Task") && boundedId(block.id) && !boundaries.has(block.id)) {
				boundaries.set(block.id, index);
			}
		}
	}
	return boundaries;
}

function rootAgentParentToolUseIds(messages: readonly ClaudeAgentSdkHistoryMessage[]): Set<string> {
	return new Set(rootAgentParentBoundaries(messages).keys());
}

/**
 * Root Agent/Task results are the only durable terminal authority in history.
 * A child row may name its parent but must never settle that parent's card.
 */
function rootSubagentTerminal(
	message: ClaudeAgentSdkHistoryMessage,
	parents: ReadonlySet<string>,
): { parentToolUseId: string; phase: "completed" | "error" } | undefined {
	if (message.role !== "toolResult" || message.parentToolUseId !== undefined) return undefined;
	const parentToolUseId = toolResultId(message);
	if (!parentToolUseId || !parents.has(parentToolUseId)) return undefined;
	return { parentToolUseId, phase: message.isError === true ? "error" : "completed" };
}

/** Bounded official-SDK recovery for a snapshot with real root Agent/Task
 * parents. It never infers a parent from an agent id and returns only rows
 * annotated with an exact real root parent. */
export async function recoverClaudeSdkEmbeddedWork(
	messages: readonly ClaudeAgentSdkHistoryMessage[],
	recovery: ClaudeSdkSubagentRecoveryOptions,
): Promise<ClaudeAgentSdkHistoryMessage[]> {
	const invocationBoundaries = rootAgentParentBoundaries(messages);
	if (invocationBoundaries.size === 0) return [...messages];
	const parents = new Set(invocationBoundaries.keys());
	const terminalBoundaries = new Map<string, number>();
	for (const [index, message] of messages.entries()) {
		const terminal = rootSubagentTerminal(message, parents);
		if (terminal && !terminalBoundaries.has(terminal.parentToolUseId)) terminalBoundaries.set(terminal.parentToolUseId, index);
	}
	const existing = new Set(messages.flatMap((message) => {
		const parent = boundedId(message.parentToolUseId) ? message.parentToolUseId : undefined;
		const id = sourceId(message);
		return parent && id ? [`${parent}:${id}`] : [];
	}));
	const recovered = await recoverSubagentRows(parents, recovery);
	const recoveredAtBoundary = new Map<number, ClaudeAgentSdkHistoryMessage[]>();
	for (const [parent, invocationBoundary] of invocationBoundaries) {
		const boundary = terminalBoundaries.get(parent) ?? invocationBoundary;
		const accepted = (recovered.rowsByParent.get(parent) ?? []).filter((message) => {
			const id = sourceId(message);
			if (!id || existing.has(`${parent}:${id}`)) return false;
			existing.add(`${parent}:${id}`);
			return true;
		});
		if (accepted.length > 0) {
			const atBoundary = recoveredAtBoundary.get(boundary) ?? [];
			atBoundary.push(...accepted);
			recoveredAtBoundary.set(boundary, atBoundary);
		}
	}

	const combined: ClaudeAgentSdkHistoryMessage[] = [];
	for (const [index, message] of messages.entries()) {
		combined.push(message);
		// A finalized parent uses its exact root Agent/Task result boundary. A live
		// parent has no terminal authority yet, so its immutable invocation boundary
		// is the conservative fallback. Both preserve root ordering after projection
		// and keep every parent's recovered rows in official child-source order,
		// rather than appending a global child tail.
		combined.push(...(recoveredAtBoundary.get(index) ?? []));
	}
	return combined;
}

export function projectClaudeSdkEmbeddedWork(messages: readonly ClaudeAgentSdkHistoryMessage[]): ClaudeSdkEmbeddedWorkProjection {
	const assembler = new ClaudeSdkSubagentWorkAssembler();
	const rootMessages: ClaudeAgentSdkHistoryMessage[] = [];
	const parents = rootAgentParentToolUseIds(messages);
	assembler.setKnownParentToolUseIds([...parents]);
	for (const message of messages) {
		if (boundedId(message.parentToolUseId)) assembler.ingestMessage(message);
		else rootMessages.push(message);
	}
	// History can be replayed in either result/call order. Resolve only after
	// the complete root call set is known, and only through exact tool-call ids.
	for (const message of messages) {
		const terminal = rootSubagentTerminal(message, parents);
		if (terminal) assembler.ingestTerminal(terminal.parentToolUseId, terminal);
	}
	const workByParent = assembler.snapshot();
	return {
		rootMessages,
		workByParent,
		diagnostics: [...workByParent.values()].flatMap(work => work.diagnostic ? [`${work.parentToolUseId}:${work.diagnostic}`] : []),
	};
}
