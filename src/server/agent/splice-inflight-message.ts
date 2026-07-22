import { isMessageAuthor, LOCAL_USER_AUTHOR, type MessageAuthor } from "../../shared/message-author.js";
import {
	extractPromptModelText,
	promptAuthorBindingMatchesText,
	type PromptAuthorBinding,
} from "./author-sidecar.js";
import type { InFlightSteerRecord, PersistedInFlightSteer } from "./session-store.js";

/**
 * Splice an in-flight `message_update` payload into a snapshot messages
 * array returned by `session.rpcClient.getMessages()`. Pure helper, no
 * dependencies on the rest of the session-manager module graph so that
 * unit tests can import it without dragging in flexsearch / pi-coding-agent.
 *
 * Behaviour:
 *  - If `latest` is undefined or its `message` has empty content, returns
 *    the input array unchanged (same reference).
 *  - If `messages` already contains a row whose id matches `latest.id`,
 *    that row is replaced in place in a new array.
 *  - Otherwise the in-flight message is appended at the end of a new array.
 *
 * Used by every site that returns the snapshot to a client (WS
 * `get_messages`, `refreshAfterCompaction`, role-switch refresh,
 * `generateTitleForAnySession` live branch, `autoGenerateTitle`). See the
 * H3 design doc on the goal — the agent flushes to `.jsonl` only on
 * `message_end`, so without this splice a snapshot taken mid-stream drops
 * the in-flight assistant row entirely (the H3-D convergent-loss case).
 */
export function spliceInFlightMessage(
	messages: any[],
	latest?: { id?: string; message: any },
): any[] {
	if (!latest || !latest.message) return messages;
	const content = (latest.message as any).content;
	const hasContent =
		(typeof content === "string" && content.length > 0) ||
		(Array.isArray(content) && content.length > 0);
	if (!hasContent) return messages;
	if (latest.id && Array.isArray(messages)) {
		const idx = messages.findIndex((m: any) => m && m.id === latest.id);
		if (idx !== -1) {
			const next = messages.slice();
			next[idx] = latest.message;
			return next;
		}
	}
	return [...messages, latest.message];
}

/** Extract a user-message body as plain text (string or text-block array). */
function extractUserText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const blocks = message.content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text);
		return blocks.join("\n");
	}
	return "";
}

function userMessageId(message: any): string | undefined {
	for (const key of ["id", "entryId", "_entryId", "_bobbitEntryId"]) {
		const value = message?.[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function epochMilliseconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.length === 0) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

const ECHO_TIMESTAMP_TOLERANCE_MS = 2_000;

/**
 * A structured steer is represented only when the same prompt occurrence can
 * be proven. Text equality is deliberately insufficient: an older transcript
 * row may have the same body as a newly accepted steer.
 */
function hasStructuredSteerOccurrence(
	messages: any[],
	record: InFlightSteerRecord,
	bindings: readonly PromptAuthorBinding[],
): boolean {
	const syntheticId = `inflight-steer:${record.promptId}`;
	if (messages.some((message) => message?._inFlightSteer === true && message.id === syntheticId)) return true;

	const binding = bindings.find((candidate) =>
		candidate.promptId === record.promptId && candidate.settlement?.outcome === "echoed",
	);
	if (!binding?.settlement) return false;

	// The durable steer ledger intentionally keeps unprefixed base text, while a
	// trusted agent/system echo may contain a dispatch-only model prefix. Prove
	// the exact raw Pi occurrence against the settled sidecar digest before using
	// its id/timestamp. Base-text equality must never authorize a prefixed echo.
	if (typeof binding.modelTextDigest !== "string") return false;
	const { messageId, messageTimestamp } = binding.settlement;
	return messages.some((message) => {
		if (!message || (message.role !== "user" && message.role !== "user-with-attachments")) return false;
		const rawModelText = extractPromptModelText(message);
		if (rawModelText === undefined || !promptAuthorBindingMatchesText(binding, rawModelText)) return false;
		if (messageId && userMessageId(message) === messageId) return true;
		if (messageTimestamp === undefined) return false;
		const timestamp = epochMilliseconds(message.timestamp) ?? epochMilliseconds(message.ts);
		return timestamp !== undefined
			&& Math.abs(timestamp - messageTimestamp) <= ECHO_TIMESTAMP_TOLERANCE_MS;
	});
}

/**
 * Splice synthetic user-role messages for every entry in the steer shadow
 * ledger (`session.inFlightSteerTexts`) that is NOT already represented as
 * a user message in the snapshot. Both legacy string entries and structured
 * records are accepted at this persistence-facing boundary.
 *
 * Companion to `spliceInFlightMessage` (which handles in-flight assistant
 * `message_update`). Solves a steer-specific continuity race:
 *
 *   `_dispatchSteer()` removes the queue row and broadcasts the empty
 *   queue *before* awaiting `rpcClient.steer()`. The SDK only echoes the
 *   text back as `message_end(role:user)` after a roundtrip, and the
 *   agent only flushes that echo to `.jsonl` at that point. Between
 *   queue-removal and echo, a client `get_messages` (visibility resync,
 *   WS reconnect resume-fallback, second tab) sees a snapshot with
 *   neither the pill nor the transcript row — the steer text appears
 *   to vanish, only to reappear seconds later when the echo lands.
 *
 * The ledger is the in-process record of "steer texts the SDK has but
 * `.jsonl` doesn't yet". Splicing them into snapshot responses closes
 * the gap. Synthetic rows carry a stable id prefix `inflight-steer:` so
 * the client reducer can route them through the normal server-snapshot
 * dedup paths (multiset plain-text match against the real echo when a
 * later snapshot arrives, plus the `_origin: "server" && _order <= 0`
 * prior-snapshot drop for any leftover).
 *
 * Bounded by construction: the ledger only ever contains entries that
 * are paired with a future echo (which clears them) or an abort-drain
 * (which moves them back into `promptQueue`). It cannot grow without
 * bound.
 */
export function spliceInFlightSteers(
	messages: any[],
	inFlightSteerTexts?: readonly PersistedInFlightSteer[],
	promptAuthorBindings: readonly PromptAuthorBinding[] = [],
): any[] {
	if (!Array.isArray(messages)) return messages;
	if (!inFlightSteerTexts || inFlightSteerTexts.length === 0) return messages;

	// Legacy string ledgers have no occurrence identity, so retain their
	// historical multiset text correlation. Structured records must use their
	// prompt id plus settlement evidence instead: any historical same-text row
	// must remain available for a newly accepted occurrence.
	const legacyPresentCounts = new Map<string, number>();
	for (const message of messages) {
		if (!message) continue;
		if (message.role !== "user" && message.role !== "user-with-attachments") continue;
		const text = extractUserText(message);
		if (text) legacyPresentCounts.set(text, (legacyPresentCounts.get(text) ?? 0) + 1);
	}

	const additions: any[] = [];
	let i = 0;
	for (const entry of inFlightSteerTexts) {
		const legacy = typeof entry === "string";
		const record: InFlightSteerRecord | undefined = legacy
			? (entry.length > 0
				? {
					text: entry,
					promptId: `legacy-inflight-steer:${i}`,
					source: "user",
					author: LOCAL_USER_AUTHOR,
				}
				: undefined)
			: entry;
		const text = record?.text;
		if (!text) { i++; continue; }

		if (legacy) {
			const remaining = legacyPresentCounts.get(text) ?? 0;
			if (remaining > 0) {
				legacyPresentCounts.set(text, remaining - 1);
				i++;
				continue;
			}
		} else if (hasStructuredSteerOccurrence(messages, record, promptAuthorBindings)) {
			i++;
			continue;
		}

		const author: MessageAuthor | undefined = isMessageAuthor(record.author) ? record.author : undefined;
		additions.push({
			// New structured entries use their stable prompt identity. Keep the
			// legacy content-derived shape so reconnect behaviour is unchanged for
			// old persisted string ledgers.
			id: legacy
				? `inflight-steer:${i}:${text.slice(0, 32)}`
				: `inflight-steer:${record.promptId}`,
			role: "user",
			content: [{ type: "text", text }],
			...(author ? { author } : {}),
			_inFlightSteer: true,
		});
		i++;
	}
	if (additions.length === 0) return messages;
	return [...messages, ...additions];
}
