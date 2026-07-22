/**
 * `MessageIndexSource` — streams `.jsonl` lines from each session's agent
 * session file, applies the content policy, and yields one `Indexable`
 * per emitted block.
 *
 * Per design §5, a single agent message may contribute multiple entries
 * (one per text / tool_use / tool_result block). Each entry gets its own
 * row keyed by `message:<sid>:<msgIdx>:<blockKey>` — the blockKey is
 * produced by `content-policy.extractForIndexing` and encodes the block
 * type + index within the message.
 *
 * Chunking (§6) is NOT applied here — that's the Indexer's responsibility.
 * Sources stay single-purpose: iterate → extract → tag. If the agent
 * session file is missing (new session, not yet written) the session is
 * skipped gracefully.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import { isMessageAuthor, type MessageAuthor } from "../../../shared/message-author.js";
import type { IndexSource, IndexSourceContext, Indexable } from "../types.js";
import { extractForIndexing } from "../content-policy.js";
import { contentHashOf } from "./hash.js";
import { formatSessionSearchTitle } from "./session-title.js";
import {
	createPromptAuthorStreamCorrelation,
	projectCorrelatedPromptMessage,
	readAuthorSidecar,
	type PromptAuthorBinding,
} from "../../agent/author-sidecar.js";
import {
	isToolResultOnlyMessage,
	normalizeVisibleMessage,
	type NormalizeVisibleMessageContext,
} from "../../agent/message-author.js";

export interface MessageIndexSourceOptions {
	/**
	 * Legacy low-cap test/config seam. Raw transcript rows are no longer retained,
	 * so the streamed implementation remains below either positive cap.
	 */
	maxRetainedRows?: number;
	/** See `maxRetainedRows`; raw transcript bytes retained between rows are zero. */
	maxRetainedBytes?: number;
	/** Maximum compact author-sidecar bindings retained for one session. */
	maxAuthorBindings?: number;
	/** Maximum estimated UTF-8 bytes retained by compact author correlation state. */
	maxAuthorBindingBytes?: number;
}

interface ParsedRow {
	msgIdx: number;
	message: Record<string, unknown>;
	timestamp: number;
}

function parseTranscriptLine(
	line: string,
	msgIdx: number,
	fallbackTimestamp: number,
): ParsedRow | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;

	// Agent session files wrap the actual message in `{ message: {...} }`
	// for tool events; fall back to the envelope itself otherwise.
	const envelope = entry as Record<string, unknown>;
	const wrappedMessage = envelope.message;
	const rawMessage = wrappedMessage && typeof wrappedMessage === "object" && !Array.isArray(wrappedMessage)
		? wrappedMessage as Record<string, unknown>
		: envelope;

	// Timestamp precedence: per-message timestamp if present, else envelope
	// timestamp, else session lastActivity.
	const rawTs = rawMessage.timestamp ?? envelope.timestamp;
	const timestamp =
		typeof rawTs === "number"
			? rawTs
			: typeof rawTs === "string"
				? Date.parse(rawTs) || fallbackTimestamp
				: fallbackTimestamp;
	// Pi/transcript metadata is not a trusted author boundary.
	const { author: _untrustedAuthor, ...message } = rawMessage;
	return {
		msgIdx,
		timestamp,
		message: {
			...message,
			...(typeof envelope.id === "string" ? { entryId: envelope.id } : {}),
			...(rawTs !== undefined ? { timestamp: rawTs } : {}),
		},
	};
}

/**
 * Read one transcript pass while retaining only the current parsed row. Errors
 * end the pass after its complete prefix, preserving the historical best-effort
 * indexing contract without accumulating raw JSON, attachment, or tool blobs.
 */
async function* streamTranscriptRows(
	filePath: string,
	fallbackTimestamp: number,
): AsyncIterable<ParsedRow> {
	let stream: fs.ReadStream;
	try {
		stream = fs.createReadStream(filePath, { encoding: "utf-8" });
	} catch {
		return;
	}
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
	let msgIdx = 0;
	try {
		for await (let line of rl) {
			let row = parseTranscriptLine(line, msgIdx, fallbackTimestamp);
			// Release the raw JSON string before handing the compact row onward.
			line = "";
			if (!row) continue;
			msgIdx++;
			yield row;
			row = undefined;
		}
	} catch {
		// Unreadable mid-stream — consumers keep the complete prefix already read.
	} finally {
		rl.close();
		try { stream.close(); } catch { /* ignore */ }
	}
}

export class MessageIndexSource implements IndexSource {
	readonly sourceId = "messages" as const;

	constructor(
		private readonly readAuthorBindings: (sessionId: string) => PromptAuthorBinding[] = readAuthorSidecar,
		private readonly options: MessageIndexSourceOptions = {},
	) {}

	async *iterate(ctx: IndexSourceContext): AsyncIterable<Indexable> {
		const sessions = ctx.sessionStore.getAll();
		const goalTitleMap = new Map<string, string>();
		for (const g of ctx.goalStore.getAll()) {
			goalTitleMap.set(g.id, g.title ?? "");
		}

		for (const session of sessions) {
			const filePath = session.agentSessionFile;
			if (!filePath) continue;
			try {
				// fs.existsSync is cheap and avoids a thrown error on ENOENT
				// for the typical "session started but no messages yet" case.
				if (!fs.existsSync(filePath)) continue;
			} catch {
				continue;
			}

			const sessionTitle = (session.title ?? "").trim();
			const goalTitle = session.goalId
				? goalTitleMap.get(session.goalId) ?? ""
				: "";
			const displayTitle = formatSessionSearchTitle(sessionTitle, goalTitle);
			const normalizationContext: NormalizeVisibleMessageContext = {
				session,
				agentDeps: {
					getStaff: (id: string) => typeof ctx.staffStore.get === "function" ? ctx.staffStore.get(id) : undefined,
				},
			};

			let bindings: PromptAuthorBinding[] = [];
			try {
				bindings = this.readAuthorBindings(session.id);
			} catch {
				// Author precision is best-effort and never gates search indexing.
			}
			const correlation = createPromptAuthorStreamCorrelation(bindings, {
				maxBindings: this.options.maxAuthorBindings,
				maxBindingBytes: this.options.maxAuthorBindingBytes,
			});
			bindings = [];

			// The compact first pass reserves later exact id/timestamp occurrences.
			// This makes FIFO deterministic in pass two without retaining raw rows.
			// Sessions without usable sidecar state remain a single streamed pass.
			if (correlation.retainedBindings > 0) {
				for await (const row of streamTranscriptRows(filePath, session.lastActivity ?? 0)) {
					correlation.reserve(row.message, row.msgIdx);
				}
			}

			let precedingAuthor: MessageAuthor | undefined;
			let precedingAuthorIsUnknown = false;
			for await (const row of streamTranscriptRows(filePath, session.lastActivity ?? 0)) {
				// Resolve once while content is still the exact raw Pi text. Stable
				// id/timestamp correlation selects accountability; the projection helper
				// independently requires the raw digest before removing a prefix.
				const promptBinding = correlation.resolveBinding(row.message, row.msgIdx);
				const promptAuthor = promptBinding?.author;
				const isToolResult = isToolResultOnlyMessage(row.message);
				const isOrdinaryPrompt = !isToolResult
					&& (row.message.role === "user" || row.message.role === "user-with-attachments");
				// Once compact correlation exceeds its cap, role alone cannot distinguish
				// a human prompt from raw prefixed system/agent content. Never make that
				// injected attribution searchable. Assistant and tool rows remain safe.
				if (correlation.degraded && isOrdinaryPrompt) {
					precedingAuthor = undefined;
					precedingAuthorIsUnknown = true;
					continue;
				}
				const projectedMessage = promptBinding
					? projectCorrelatedPromptMessage(row.message, promptBinding)
					: row.message;
				const authorDependsOnDegradedCorrelation = correlation.degraded
					&& isToolResult
					&& precedingAuthorIsUnknown;
				const msg = normalizeVisibleMessage(projectedMessage, {
					...normalizationContext,
					existingAuthorIsTrusted: false,
					promptAuthor,
					precedingAuthor,
				});
				const indexedAuthor = !authorDependsOnDegradedCorrelation && isMessageAuthor(msg.author)
					? msg.author
					: undefined;
				if (authorDependsOnDegradedCorrelation) {
					precedingAuthor = undefined;
					precedingAuthorIsUnknown = true;
				} else if (indexedAuthor) {
					precedingAuthor = indexedAuthor;
					precedingAuthorIsUnknown = false;
				}

				const hit = extractForIndexing(msg);
				for (const entry of hit.entries) {
					const id = `message:${session.id}:${row.msgIdx}:${entry.blockKey}`;
					const metadata: Record<string, string | number | boolean> = {
						sessionId: session.id,
						msgIdx: row.msgIdx,
						blockKey: entry.blockKey,
						...(session.goalId ? { goalId: session.goalId } : {}),
					};
					if (goalTitle) metadata.goalTitle = goalTitle;
					if (displayTitle) metadata.sessionTitle = displayTitle;
					if (indexedAuthor) {
						metadata.authorKind = indexedAuthor.kind;
						metadata.authorId = indexedAuthor.id;
						metadata.authorLabel = indexedAuthor.label;
					}
					yield {
						id,
						sourceId: "messages",
						text: entry.text,
						metadata,
						contentHash: contentHashOf(
							`${entry.text}\n${displayTitle}`,
							entry.weight,
							entry.role,
							row.timestamp,
						),
						timestamp: row.timestamp,
						projectId: session.projectId ?? ctx.projectId,
						archived: session.archived === true,
						weight: entry.weight,
						role: entry.role,
						display: { title: displayTitle },
					};
				}
			}
		}
	}
}
