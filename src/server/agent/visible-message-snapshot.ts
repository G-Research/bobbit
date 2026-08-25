import {
	PI_TRANSCRIPT_ENTRY_ID_SOURCE,
	isAccountablePromptMessage,
	isPiTranscriptEntryId,
	type MessageAuthor,
} from "../../shared/message-author.js";
import { projectPromptDisplayMessagesForSession } from "../skills/skill-sidecar.js";
import {
	extractPromptModelText,
	mergeAuthorSidecarIntoMessages,
	readAuthorSidecar,
} from "./author-sidecar.js";
import { mergeCompactionSidecarIntoMessages } from "./compaction-sidecar.js";
import {
	contextClearExcludedCompactionIds,
	mergeContextClearBoundariesIntoMessages,
} from "./context-clear-boundary.js";
import { EventBuffer } from "./event-buffer.js";
import type { AgentSessionIdentity, NormalizeVisibleMessageContext } from "./message-author.js";
import type { PersistedInFlightSteer } from "./session-store.js";
import { spliceInFlightMessage, spliceInFlightSteers } from "./splice-inflight-message.js";
import { normalizeToolResultErrorSnapshot } from "./tool-result-error-normalizer.js";
import { truncateLargeToolContentInMessages } from "./truncate-large-content.js";

export interface VisibleMessageSnapshotContext {
	sessionId: string;
	session?: AgentSessionIdentity;
	agentAuthor?: MessageAuthor;
	systemAuthor?: MessageAuthor;
	agentDeps?: NormalizeVisibleMessageContext["agentDeps"];
	latestMessageUpdate?: { id?: string; message: any };
	inFlightSteerTexts?: readonly PersistedInFlightSteer[];
	/** Server-confirmed Pi entry ids aligned to the unmodified get_messages rows. */
	transcriptPromptEntryIds?: readonly (string | undefined)[];
	/** Validated durable boundaries injected only into this outward snapshot. */
	contextClearBoundaries?: unknown;
}

export interface TranscriptCursorSnapshot {
	forkMessages: unknown;
	entries: unknown;
	leafId: unknown;
}

interface CursorEntry {
	id: string;
	parentId: string | null;
	type: string;
	message?: Record<string, unknown>;
	firstKeptEntryId?: string;
}

function parseCursorEntries(snapshot: TranscriptCursorSnapshot): {
	branch: CursorEntry[];
	forkTextById: Map<string, string>;
} | undefined {
	if (!Array.isArray(snapshot.entries) || !Array.isArray(snapshot.forkMessages)) return undefined;
	const byId = new Map<string, CursorEntry>();
	for (const value of snapshot.entries) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const raw = value as Record<string, unknown>;
		if (!isPiTranscriptEntryId(raw.id)
			|| (raw.parentId !== null && !isPiTranscriptEntryId(raw.parentId))
			|| typeof raw.type !== "string"
			|| byId.has(raw.id)) return undefined;
		byId.set(raw.id, {
			id: raw.id,
			parentId: raw.parentId as string | null,
			type: raw.type,
			...(raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)
				? { message: raw.message as Record<string, unknown> }
				: {}),
			...(typeof raw.firstKeptEntryId === "string" ? { firstKeptEntryId: raw.firstKeptEntryId } : {}),
		});
	}

	if (snapshot.leafId === null && byId.size === 0) return { branch: [], forkTextById: new Map() };
	if (!isPiTranscriptEntryId(snapshot.leafId) || !byId.has(snapshot.leafId)) return undefined;
	const branch: CursorEntry[] = [];
	const seen = new Set<string>();
	let cursor: string | null = snapshot.leafId;
	while (cursor !== null) {
		if (seen.has(cursor)) return undefined;
		seen.add(cursor);
		const entry = byId.get(cursor);
		if (!entry) return undefined;
		branch.push(entry);
		cursor = entry.parentId;
	}
	branch.reverse();

	const forkTextById = new Map<string, string>();
	for (const value of snapshot.forkMessages) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const raw = value as Record<string, unknown>;
		if (!isPiTranscriptEntryId(raw.entryId)
			|| typeof raw.text !== "string"
			|| forkTextById.has(raw.entryId)) return undefined;
		const entry = byId.get(raw.entryId);
		if (!entry || entry.type !== "message" || !isAccountablePromptMessage(entry.message)) return undefined;
		const modelText = extractPromptModelText(entry.message!);
		if (modelText === undefined || modelText !== raw.text) return undefined;
		forkTextById.set(raw.entryId, raw.text);
	}
	return { branch, forkTextById };
}

/**
 * Correlate Pi's id-less get_messages view with its read-only session tree.
 * Matching is positional within Pi's active, compaction-aware context, so
 * duplicate prompt text cannot move a cursor to an older or newer occurrence.
 * An in-memory prompt may exist only as a trailing get_messages row while Pi is
 * streaming; callers can permit that tail, but it never receives a cursor.
 */
export function correlateTranscriptPromptEntryIds(
	messages: readonly unknown[],
	snapshot: TranscriptCursorSnapshot,
	options: { allowUnpersistedTail?: boolean } = {},
): Array<string | undefined> | undefined {
	if (!Array.isArray(messages)) return undefined;
	const parsed = parseCursorEntries(snapshot);
	if (!parsed) return undefined;

	let contextEntries = parsed.branch;
	let latestCompactionIndex = -1;
	for (let index = 0; index < parsed.branch.length; index++) {
		if (parsed.branch[index].type === "compaction") latestCompactionIndex = index;
	}
	if (latestCompactionIndex !== -1) {
		const compaction = parsed.branch[latestCompactionIndex];
		const retainedBefore: CursorEntry[] = [];
		let retaining = false;
		for (let index = 0; index < latestCompactionIndex; index++) {
			const entry = parsed.branch[index];
			if (entry.id === compaction.firstKeptEntryId) retaining = true;
			if (retaining) retainedBefore.push(entry);
		}
		contextEntries = [compaction, ...retainedBefore, ...parsed.branch.slice(latestCompactionIndex + 1)];
	}

	const expected = contextEntries.filter((entry) =>
		entry.type === "message" && isAccountablePromptMessage(entry.message),
	);
	const visibleUserIndexes: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (isAccountablePromptMessage(messages[index])) visibleUserIndexes.push(index);
	}
	if (visibleUserIndexes.length < expected.length) return undefined;
	const unpersistedTail = visibleUserIndexes.length - expected.length;
	if (unpersistedTail > 0 && !options.allowUnpersistedTail) return undefined;

	const entryIds = new Array<string | undefined>(messages.length);
	for (let index = 0; index < expected.length; index++) {
		const messageIndex = visibleUserIndexes[index];
		const message = messages[messageIndex] as Record<string, unknown>;
		const expectedEntry = expected[index];
		const visibleText = extractPromptModelText(message);
		const authoritativeText = parsed.forkTextById.get(expectedEntry.id);
		if (visibleText === undefined || authoritativeText === undefined || visibleText !== authoritativeText) {
			return undefined;
		}
		entryIds[messageIndex] = expectedEntry.id;
	}
	return entryIds;
}

function stripUntrustedSnapshotMetadata(messages: any[]): any[] {
	let changed = false;
	const stripped = messages.map((message) => {
		if (!message || typeof message !== "object" || Array.isArray(message)
			|| (!("author" in message)
				&& !("attachments" in message)
				&& !("_entryIdSource" in message)
				&& !("_inFlightSteer" in message)
				&& !("_deliveryRecoveryProjection" in message))) {
			return message;
		}
		const {
			author: _untrustedAuthor,
			attachments: _untrustedAttachments,
			_entryIdSource: _untrustedEntryIdSource,
			_inFlightSteer: _untrustedInFlightSteer,
			_deliveryRecoveryProjection: _untrustedDeliveryRecoveryProjection,
			...withoutUntrustedMetadata
		} = message;
		changed = true;
		return withoutUntrustedMetadata;
	});
	return changed ? stripped : messages;
}

function projectTranscriptPromptEntryIds(
	messages: any[],
	entryIds: readonly (string | undefined)[] | undefined,
): any[] {
	if (!entryIds || entryIds.length !== messages.length) return messages;
	let changed = false;
	const projected = messages.map((message, index) => {
		const entryId = entryIds[index];
		if (!isPiTranscriptEntryId(entryId) || !isAccountablePromptMessage(message)) return message;
		changed = true;
		return { ...message, entryId, _entryIdSource: PI_TRANSCRIPT_ENTRY_ID_SOURCE };
	});
	return changed ? projected : messages;
}

function transformMessages(messages: any[], context: VisibleMessageSnapshotContext): any[] {
	// Pi transcript rows are untrusted at this boundary. Remove even
	// valid-looking Bobbit metadata before trusted cursor, compaction, and sidecar
	// projection below. Raw entryId values are never granted provenance.
	const trustedBase = stripUntrustedSnapshotMetadata(messages);
	const withTranscriptCursors = projectTranscriptPromptEntryIds(
		trustedBase,
		context.transcriptPromptEntryIds,
	);
	const authorBindings = readAuthorSidecar(context.sessionId);
	const withInFlight = spliceInFlightSteers(
		spliceInFlightMessage(withTranscriptCursors, context.latestMessageUpdate),
		context.inFlightSteerTexts,
		authorBindings,
	);
	const withCompaction = mergeCompactionSidecarIntoMessages(
		context.sessionId,
		withInFlight,
		contextClearExcludedCompactionIds(context.contextClearBoundaries),
	);
	// This is the raw-content boundary. Binding-aware author correlation must
	// see exact Pi model text so its digest can authorize removal of one injected
	// prefix. Run it before truncation, cloning/order fields, or skill/file
	// sidecars replace content with the user-facing original text.
	const withAuthors = mergeAuthorSidecarIntoMessages(
		authorBindings,
		withCompaction,
		{
			session: context.session ?? { id: context.sessionId },
			agentAuthor: context.agentAuthor,
			systemAuthor: context.systemAuthor,
			agentDeps: context.agentDeps,
		},
	);
	const truncated = truncateLargeToolContentInMessages(withAuthors);
	const withPromptDisplay = projectPromptDisplayMessagesForSession(context.sessionId, truncated);
	return mergeContextClearBoundariesIntoMessages(context.contextClearBoundaries, withPromptDisplay);
}

/**
 * Build the Bobbit-visible snapshot without mutating Pi-owned messages.
 * Author metadata and digest-gated prefix projection are applied only after all
 * model-facing RPC work is complete; this result is an outward view and must
 * never be fed back to Pi or a provider.
 */
export function buildVisibleMessageSnapshot<T>(snapshot: T, context: VisibleMessageSnapshotContext): T {
	const normalized = normalizeToolResultErrorSnapshot(snapshot);
	const raw: any = normalized;
	let visible: any = raw;
	if (Array.isArray(raw)) {
		visible = transformMessages(raw, context);
	} else if (raw && typeof raw === "object" && Array.isArray(raw.messages)) {
		const messages = transformMessages(raw.messages, context);
		visible = messages === raw.messages ? raw : { ...raw, messages };
	}

	const messages = Array.isArray(visible)
		? visible
		: visible && typeof visible === "object" && Array.isArray(visible.messages)
			? visible.messages
			: undefined;
	if (!messages) return visible as T;
	const ordered = messages.map((message: any, index: number) =>
		message && typeof message === "object"
			? { ...message, _order: EventBuffer.SNAPSHOT_ORDER_FLOOR + index }
			: message,
	);
	return (Array.isArray(visible) ? ordered : { ...visible, messages: ordered }) as T;
}
