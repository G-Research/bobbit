/**
 * Client-side projection of embedded Claude Agent SDK child work.
 *
 * This module deliberately owns only nested, parent-keyed presentation state.
 * Root transcript ordering remains in message-reducer.ts.
 */

export type ClaudeSdkSubagentPhase =
	| "pending"
	| "running"
	| "completed"
	| "error"
	| "aborted"
	| "unknown";

export interface ClaudeSdkSubagentIdentity {
	readonly parentToolUseId: string;
	readonly agentId?: string;
	readonly agentType?: string;
}

/** A source row is opaque: usage, cost, and SDK metadata stay on this object. */
export type ClaudeSdkSubagentMessage = Readonly<Record<string, unknown>>;

/** Renderer-facing nested work for one real root Agent tool-use id. */
export interface ClaudeSdkEmbeddedWork {
	readonly parentToolUseId: string;
	readonly agentId?: string;
	readonly agentType?: string;
	/** All admitted child identities for the same root Agent call. */
	readonly identities?: readonly ClaudeSdkSubagentIdentity[];
	readonly phase: ClaudeSdkSubagentPhase;
	readonly startedAt?: number;
	readonly stoppedAt?: number;
	/** Terminal failure stays local to the embedded work, never root prose. */
	readonly error?: string;
	readonly messages: readonly ClaudeSdkSubagentMessage[];
	readonly pendingToolCallIds: readonly string[];
	readonly diagnostic?: "unknown-parent" | "recovery-unavailable" | "recovery-mismatch";
}

/** The server semantic event contract, retained structurally for old servers. */
export interface ClaudeSdkEmbeddedWorkEvent {
	readonly type: "claude_sdk_subagent_work";
	readonly parentToolUseId: string;
	readonly kind: "start" | "message" | "tool_start" | "tool_end" | "stop" | "terminal" | "recovered";
	readonly identity?: ClaudeSdkSubagentIdentity;
	readonly message?: ClaudeSdkSubagentMessage;
	readonly toolEvent?: Readonly<Record<string, unknown>>;
	readonly terminal?: Readonly<{ phase: ClaudeSdkSubagentPhase; error?: string }>;
	/** Snapshot/recovery implementations may supply a complete replacement. */
	readonly work?: ClaudeSdkEmbeddedWork;
}

export type ClaudeSdkSubagentWorkByParent = ReadonlyMap<string, ClaudeSdkEmbeddedWork>;

export interface ClaudeSdkSubagentSnapshotProjection {
	readonly rootMessages: readonly unknown[];
	readonly subagentWorkByParent: Map<string, ClaudeSdkEmbeddedWork>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parentToolUseIdOf(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const id = value.parentToolUseId ?? value.parent_tool_use_id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** True only for an explicitly partitioned child row/event. Never infer a parent. */
export function isClaudeSdkSubagentFrame(value: unknown): boolean {
	return isRecord(value) && (value.type === "claude_sdk_subagent_work" || parentToolUseIdOf(value) !== undefined || parentToolUseIdOf(value.message) !== undefined);
}

function finiteTime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sourceTimestamp(row: ClaudeSdkSubagentMessage): number {
	return finiteTime(row.timestamp) ?? finiteTime(row.timestamp_ms) ?? 0;
}

function sourceId(row: ClaudeSdkSubagentMessage): string | undefined {
	const id = row.id ?? row.uuid;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function toolId(event: Readonly<Record<string, unknown>> | undefined): string | undefined {
	if (!event) return undefined;
	const id = event.toolCallId ?? event.toolUseId ?? event.toolId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function terminalPhase(value: unknown): ClaudeSdkSubagentPhase | undefined {
	return value === "pending" || value === "running" || value === "completed" || value === "error" || value === "aborted" || value === "unknown"
		? value
		: undefined;
}

function isTerminalPhase(phase: ClaudeSdkSubagentPhase): boolean {
	return phase === "completed" || phase === "error" || phase === "aborted";
}

function normalizeIdentities(parentToolUseId: string, value: unknown): ClaudeSdkSubagentIdentity[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const identities: ClaudeSdkSubagentIdentity[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate)) continue;
		// A snapshot partition is an exact-parent boundary. Never allow a stale
		// identity annotated for another Agent call to cross it during a refresh.
		const candidateParent = parentToolUseIdOf(candidate);
		if (candidateParent && candidateParent !== parentToolUseId) continue;
		const agentId = typeof candidate.agentId === "string" && candidate.agentId ? candidate.agentId : undefined;
		const agentType = typeof candidate.agentType === "string" && candidate.agentType ? candidate.agentType : undefined;
		if (!agentId && !agentType) continue;
		const key = agentId ? `id:${agentId}` : `type:${agentType}`;
		if (seen.has(key)) continue;
		seen.add(key);
		identities.push({ parentToolUseId, ...(agentId ? { agentId } : {}), ...(agentType ? { agentType } : {}) });
	}
	return identities;
}

function mergeIdentity(
	identities: readonly ClaudeSdkSubagentIdentity[] | undefined,
	identity: ClaudeSdkSubagentIdentity | undefined,
): ClaudeSdkSubagentIdentity[] | undefined {
	if (!identity?.agentId && !identity?.agentType) return identities ? [...identities] : undefined;
	if (identities?.some((candidate) => candidate.parentToolUseId !== identity.parentToolUseId)) return identities ? [...identities] : undefined;
	const key = identity.agentId ? `id:${identity.agentId}` : `type:${identity.agentType}`;
	const prior = identities ?? [];
	const index = prior.findIndex((candidate) => (candidate.agentId ? `id:${candidate.agentId}` : `type:${candidate.agentType}`) === key);
	const next = prior.slice();
	if (index >= 0) next[index] = { ...next[index], ...identity };
	else next.push(identity);
	return next;
}

function normalizeWork(parentToolUseId: string, value?: unknown): ClaudeSdkEmbeddedWork {
	const raw = isRecord(value) ? value : {};
	const messages = Array.isArray(raw.messages)
		? raw.messages.filter(isRecord).map((message) => ({ ...message }))
		: [];
	const pending = Array.isArray(raw.pendingToolCallIds)
		? raw.pendingToolCallIds.filter((id): id is string => typeof id === "string" && id.length > 0)
		: [];
	const phase = terminalPhase(raw.phase) ?? "unknown";
	const diagnostic = raw.diagnostic === "unknown-parent" || raw.diagnostic === "recovery-unavailable" || raw.diagnostic === "recovery-mismatch"
		? raw.diagnostic
		: undefined;
	const identities = normalizeIdentities(parentToolUseId, raw.identities);
	const agentId = typeof raw.agentId === "string" && raw.agentId ? raw.agentId : identities[0]?.agentId;
	const agentType = typeof raw.agentType === "string" && raw.agentType ? raw.agentType : identities[0]?.agentType;
	return {
		parentToolUseId,
		...(agentId ? { agentId } : {}),
		...(agentType ? { agentType } : {}),
		...(identities.length > 0 ? { identities } : {}),
		phase,
		...(finiteTime(raw.startedAt) !== undefined ? { startedAt: finiteTime(raw.startedAt) } : {}),
		...(finiteTime(raw.stoppedAt) !== undefined ? { stoppedAt: finiteTime(raw.stoppedAt) } : {}),
		...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
		messages: sortMessages(messages.filter((message) => {
			const messageParent = parentToolUseIdOf(message);
			return !messageParent || messageParent === parentToolUseId;
		})),
		// A terminal child cannot keep a tool pending. The renderer can still
		// display any unmatched call as its bounded terminal error result.
		pendingToolCallIds: isTerminalPhase(phase) ? [] : [...new Set(pending)],
		...(diagnostic ? { diagnostic } : {}),
	};
}

function sortMessages(messages: readonly ClaudeSdkSubagentMessage[]): ClaudeSdkSubagentMessage[] {
	return messages.slice().sort((left, right) => sourceTimestamp(left) - sourceTimestamp(right));
}

function upsertMessage(messages: readonly ClaudeSdkSubagentMessage[], message: ClaudeSdkSubagentMessage): ClaudeSdkSubagentMessage[] {
	const id = sourceId(message);
	const next = messages.slice();
	if (id) {
		const index = next.findIndex((candidate) => sourceId(candidate) === id);
		if (index >= 0) next[index] = { ...message };
		else next.push({ ...message });
	} else {
		// SDK normalized rows have UUIDs. Do not invent an identity for malformed
		// rows: preserving one delivery is safer than accidentally coalescing prose.
		next.push({ ...message });
	}
	return sortMessages(next);
}

function mergeMessages(
	prior: readonly ClaudeSdkSubagentMessage[],
	incoming: readonly ClaudeSdkSubagentMessage[],
): ClaudeSdkSubagentMessage[] {
	return incoming.reduce((merged, message) => upsertMessage(merged, message), prior.slice());
}

function snapshotMerge(prior: ClaudeSdkEmbeddedWork | undefined, incoming: ClaudeSdkEmbeddedWork): ClaudeSdkEmbeddedWork {
	// A recovery snapshot with an explicit phase is authoritative. Only an
	// unknown phase is incomplete enough to supplement with the live partition.
	if (!prior || incoming.phase !== "unknown") return incoming;
	const identities = normalizeIdentities(incoming.parentToolUseId, [
		...(prior.identities ?? []),
		...(incoming.identities ?? []),
	]);
	const phase = prior.phase;
	return {
		...incoming,
		...(incoming.agentId || !prior.agentId ? {} : { agentId: prior.agentId }),
		...(incoming.agentType || !prior.agentType ? {} : { agentType: prior.agentType }),
		...(identities.length > 0 ? { identities } : {}),
		phase,
		...(prior.startedAt === undefined && incoming.startedAt === undefined ? {} : {
			startedAt: Math.min(prior.startedAt ?? Infinity, incoming.startedAt ?? Infinity),
		}),
		...(prior.stoppedAt === undefined && incoming.stoppedAt === undefined ? {} : {
			stoppedAt: Math.max(prior.stoppedAt ?? -Infinity, incoming.stoppedAt ?? -Infinity),
		}),
		...(incoming.error || !prior.error ? {} : { error: prior.error }),
		messages: mergeMessages(prior.messages, incoming.messages),
		pendingToolCallIds: isTerminalPhase(phase)
			? []
			: [...new Set([...prior.pendingToolCallIds, ...incoming.pendingToolCallIds])],
		...(incoming.diagnostic || !prior.diagnostic ? {} : { diagnostic: prior.diagnostic }),
	};
}

function normalizedEventIdentity(parentToolUseId: string, value: unknown): ClaudeSdkSubagentIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const identityParent = parentToolUseIdOf(value);
	if (identityParent && identityParent !== parentToolUseId) return undefined;
	const agentId = typeof value.agentId === "string" && value.agentId ? value.agentId : undefined;
	const agentType = typeof value.agentType === "string" && value.agentType ? value.agentType : undefined;
	return agentId || agentType
		? { parentToolUseId, ...(agentId ? { agentId } : {}), ...(agentType ? { agentType } : {}) }
		: undefined;
}

function applyEvent(current: ClaudeSdkEmbeddedWork | undefined, raw: Record<string, unknown>): ClaudeSdkEmbeddedWork | undefined {
	const parentToolUseId = parentToolUseIdOf(raw);
	if (!parentToolUseId) return undefined;
	const event = raw as Partial<ClaudeSdkEmbeddedWorkEvent>;
	if (event.work) return normalizeWork(parentToolUseId, event.work);
	const base = current ?? normalizeWork(parentToolUseId);
	const identity = normalizedEventIdentity(parentToolUseId, event.identity);
	const eventMessage = isRecord(event.message) ? event.message : undefined;
	const eventTool = isRecord(event.toolEvent) ? event.toolEvent : raw;
	const kind = event.kind;
	let phase = base.phase;
	let messages = base.messages;
	let pendingToolCallIds = base.pendingToolCallIds;
	let startedAt = base.startedAt;
	let stoppedAt = base.stoppedAt;
	let error = base.error;
	const identities = mergeIdentity(base.identities, identity);

	if (kind === "start") {
		phase = "running";
		startedAt = finiteTime((raw as any).at) ?? finiteTime(raw.timestamp) ?? startedAt;
	} else if (kind === "message" || kind === "recovered") {
		if (eventMessage) messages = upsertMessage(messages, eventMessage);
		const ended = terminalPhase(event.terminal?.phase);
		if (ended) {
			phase = ended;
			stoppedAt = finiteTime((raw as any).at) ?? finiteTime(raw.timestamp) ?? stoppedAt;
		}
	} else if (kind === "tool_start") {
		const id = toolId(eventTool);
		if (id && !pendingToolCallIds.includes(id)) pendingToolCallIds = [...pendingToolCallIds, id];
	} else if (kind === "tool_end") {
		const id = toolId(eventTool);
		if (id) pendingToolCallIds = pendingToolCallIds.filter((candidate) => candidate !== id);
	} else if (kind === "stop") {
		phase = terminalPhase(event.terminal?.phase) ?? (phase === "error" || phase === "aborted" ? phase : "completed");
		stoppedAt = finiteTime((raw as any).at) ?? finiteTime(raw.timestamp) ?? stoppedAt;
	} else if (kind === "terminal") {
		phase = terminalPhase(event.terminal?.phase) ?? "unknown";
		stoppedAt = finiteTime((raw as any).at) ?? finiteTime(raw.timestamp) ?? stoppedAt;
	}
	if (typeof event.terminal?.error === "string" && event.terminal.error) error = event.terminal.error;

	if (isTerminalPhase(phase)) pendingToolCallIds = [];

	return {
		...base,
		...(typeof identity?.agentId === "string" && identity.agentId ? { agentId: identity.agentId } : {}),
		...(typeof identity?.agentType === "string" && identity.agentType ? { agentType: identity.agentType } : {}),
		...(identities && identities.length > 0 ? { identities } : {}),
		phase,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(stoppedAt !== undefined ? { stoppedAt } : {}),
		...(error ? { error } : {}),
		messages,
		pendingToolCallIds,
	};
}

function legacyKind(frame: Record<string, unknown>): ClaudeSdkEmbeddedWorkEvent["kind"] | undefined {
	switch (frame.type) {
		case "message_start":
		case "message_update":
		case "message_end": return "message";
		case "tool_execution_start": return "tool_start";
		case "tool_execution_end": return "tool_end";
		case "agent_end": return "terminal";
		default: return undefined;
	}
}

function legacyTerminal(frame: Record<string, unknown>): ClaudeSdkEmbeddedWorkEvent["terminal"] | undefined {
	const message = isRecord(frame.message) ? frame.message : undefined;
	const reason = message?.stopReason;
	if (reason === "error") return { phase: "error", ...(typeof message?.errorMessage === "string" ? { error: message.errorMessage } : {}) };
	if (reason === "aborted") return { phase: "aborted" };
	return frame.type === "agent_end" ? { phase: "completed" } : undefined;
}

/** Applies a semantic frame or a legacy parentToolUseId event without root side effects. */
export function applyClaudeSdkSubagentWorkFrame(
	current: ClaudeSdkSubagentWorkByParent,
	frame: unknown,
): Map<string, ClaudeSdkEmbeddedWork> {
	if (!isRecord(frame)) return new Map(current);
	const parentToolUseId = parentToolUseIdOf(frame) ?? parentToolUseIdOf(frame.message);
	if (!parentToolUseId) return new Map(current);
	const semantic = frame.type === "claude_sdk_subagent_work";
	const normalized: Record<string, unknown> = semantic
		? { ...frame, parentToolUseId }
		: {
			...frame,
			parentToolUseId,
			kind: legacyKind(frame),
			...(legacyTerminal(frame) ? { terminal: legacyTerminal(frame) } : {}),
		};
	const nextWork = applyEvent(current.get(parentToolUseId), normalized);
	if (!nextWork) return new Map(current);
	const next = new Map(current);
	next.set(parentToolUseId, nextWork);
	return next;
}

function snapshotWorkEntries(value: unknown): Array<[string, unknown]> {
	if (value instanceof Map) {
		return [...value.entries()].filter(([key, work]) =>
			typeof key === "string" && key.length > 0 && (!parentToolUseIdOf(work) || parentToolUseIdOf(work) === key),
		);
	}
	if (Array.isArray(value)) {
		return value.flatMap((work) => {
			const parent = parentToolUseIdOf(work);
			return parent ? [[parent, work] as [string, unknown]] : [];
		});
	}
	if (!isRecord(value)) return [];
	return Object.entries(value).filter(([key, work]) => {
		if (!key) return false;
		const annotatedParent = parentToolUseIdOf(work);
		return !annotatedParent || annotatedParent === key;
	});
}

/**
 * Split a snapshot before the root reducer receives it. Snapshot rows carrying
 * a parent id are nested by that exact id; semantic snapshot work replaces the
 * corresponding nested key. Unmentioned live keys survive for late recovery.
 */
export function projectClaudeSdkSubagentSnapshot(
	messages: readonly unknown[],
	subagentWork: unknown,
	current: ClaudeSdkSubagentWorkByParent = new Map(),
): ClaudeSdkSubagentSnapshotProjection {
	const rootMessages: unknown[] = [];
	let next = new Map(current);
	const rowsByParent = new Map<string, ClaudeSdkSubagentMessage[]>();
	for (const message of messages) {
		const parent = parentToolUseIdOf(message);
		if (!parent || !isRecord(message)) {
			rootMessages.push(message);
			continue;
		}
		const rows = rowsByParent.get(parent) ?? [];
		rows.push({ ...message });
		rowsByParent.set(parent, rows);
	}
	for (const [parent, rows] of rowsByParent) {
		const prior = next.get(parent) ?? normalizeWork(parent);
		next.set(parent, { ...prior, messages: sortMessages(rows) });
	}
	for (const [parent, work] of snapshotWorkEntries(subagentWork)) {
		const incoming = normalizeWork(parent, work);
		next.set(parent, snapshotMerge(next.get(parent), incoming));
	}
	return { rootMessages, subagentWorkByParent: next };
}
