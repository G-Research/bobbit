import type { MessageAuthor } from "../../shared/message-author.js";
import { readSkillSidecarEntries, mergeSidecarEntriesIntoMessages } from "../skills/skill-sidecar.js";
import { mergeAuthorSidecarIntoMessages, readAuthorSidecar } from "./author-sidecar.js";
import { mergeCompactionSidecarIntoMessages } from "./compaction-sidecar.js";
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
}

function stripUntrustedSnapshotAuthors(messages: any[]): any[] {
	let changed = false;
	const stripped = messages.map((message) => {
		if (!message || typeof message !== "object" || Array.isArray(message) || !("author" in message)) {
			return message;
		}
		const { author: _untrustedAuthor, ...withoutAuthor } = message;
		changed = true;
		return withoutAuthor;
	});
	return changed ? stripped : messages;
}

function transformMessages(messages: any[], context: VisibleMessageSnapshotContext): any[] {
	// Pi transcript rows are untrusted at this boundary. Remove even
	// valid-looking author metadata before Bobbit adds its trusted live,
	// compaction, and sidecar identities below.
	const trustedBase = stripUntrustedSnapshotAuthors(messages);
	const authorBindings = readAuthorSidecar(context.sessionId);
	const withInFlight = spliceInFlightSteers(
		spliceInFlightMessage(trustedBase, context.latestMessageUpdate),
		context.inFlightSteerTexts,
		authorBindings,
	);
	const withCompaction = mergeCompactionSidecarIntoMessages(context.sessionId, withInFlight);
	// Author correlation must see exact model text, before skill/file sidecars
	// replace it with the user-facing original text.
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
	const skillEntries = readSkillSidecarEntries(context.sessionId);
	return skillEntries.length > 0
		? mergeSidecarEntriesIntoMessages(skillEntries, truncated)
		: truncated;
}

/**
 * Build the Bobbit-visible snapshot without mutating Pi-owned messages.
 * Author metadata is added only after all model-facing RPC work is complete;
 * this function never feeds its result back to Pi or a provider.
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
