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
	readAuthorSidecar,
	mergeAuthorSidecarIntoMessages,
	type PromptAuthorBinding,
} from "../../agent/author-sidecar.js";
import {
	normalizeVisibleMessage,
	type NormalizeVisibleMessageContext,
} from "../../agent/message-author.js";

const DEFAULT_MAX_RETAINED_ROWS = 10_000;
const DEFAULT_MAX_RETAINED_BYTES = 8 * 1024 * 1024;

export interface MessageIndexSourceOptions {
	/** Raw transcript rows retained solely for full-sequence sidecar matching. */
	maxRetainedRows?: number;
	/** UTF-8 transcript bytes retained solely for full-sequence sidecar matching. */
	maxRetainedBytes?: number;
}

interface ParsedRow {
	msgIdx: number;
	message: Record<string, unknown>;
	timestamp: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
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

export class MessageIndexSource implements IndexSource {
	readonly sourceId = "messages" as const;
	private readonly maxRetainedRows: number;
	private readonly maxRetainedBytes: number;

	constructor(
		private readonly readAuthorBindings: (sessionId: string) => PromptAuthorBinding[] = readAuthorSidecar,
		options: MessageIndexSourceOptions = {},
	) {
		this.maxRetainedRows = positiveInteger(options.maxRetainedRows, DEFAULT_MAX_RETAINED_ROWS);
		this.maxRetainedBytes = positiveInteger(options.maxRetainedBytes, DEFAULT_MAX_RETAINED_BYTES);
	}

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

			let stream: fs.ReadStream;
			try {
				stream = fs.createReadStream(filePath, { encoding: "utf-8" });
			} catch {
				continue;
			}

			const sessionTitle = (session.title ?? "").trim();
			const goalTitle = session.goalId
				? goalTitleMap.get(session.goalId) ?? ""
				: "";
			const displayTitle = formatSessionSearchTitle(sessionTitle, goalTitle);

			const rl = readline.createInterface({
				input: stream,
				crlfDelay: Infinity,
			});
			const normalizationContext: NormalizeVisibleMessageContext = {
				session,
				agentDeps: {
					getStaff: (id: string) => typeof ctx.staffStore.get === "function" ? ctx.staffStore.get(id) : undefined,
				},
			};
			const toIndexables = (row: ParsedRow, msg: Record<string, unknown>): Indexable[] => {
				const output: Indexable[] = [];
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
					if (isMessageAuthor(msg.author)) {
						metadata.authorKind = msg.author.kind;
						metadata.authorId = msg.author.id;
						metadata.authorLabel = msg.author.label;
					}
					output.push({
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
					});
				}
				return output;
			};

			let precedingAuthor: MessageAuthor | undefined;
			const inferAndIndex = (row: ParsedRow): Indexable[] => {
				const msg = normalizeVisibleMessage(row.message, {
					...normalizationContext,
					existingAuthorIsTrusted: false,
					precedingAuthor,
				});
				if (isMessageAuthor(msg.author)) precedingAuthor = msg.author;
				return toIndexables(row, msg);
			};

			let streamingInference = false;
			try {
				// A size preflight keeps even the first oversized row out of the
				// full-sequence author-matching buffer. Races are covered again below.
				streamingInference = fs.statSync(filePath).size > this.maxRetainedBytes;
			} catch {
				// Preserve the existing best-effort stream behavior when stat fails.
			}
			let parsedRows: ParsedRow[] = [];
			let retainedBytes = 0;
			let msgIdx = 0;
			try {
				for await (let line of rl) {
					const lineBytes = Buffer.byteLength(line, "utf8");
					let row = parseTranscriptLine(line, msgIdx, session.lastActivity ?? 0);
					// Drop the raw JSON string before yielding. In streaming mode only
					// compact search output, never attachment/image blobs, survives a yield.
					line = "";
					if (!row) continue;
					msgIdx++;

					if (!streamingInference && (
						parsedRows.length >= this.maxRetainedRows
						|| retainedBytes + lineBytes > this.maxRetainedBytes
					)) {
						streamingInference = true;
						// Once either cap is crossed, deliberately avoid all sidecar
						// sequence matching for this session. Convert the bounded prefix and
						// current row to compact output before the first yield, then release
						// their raw message objects.
						const pending: Indexable[] = [];
						for (const buffered of parsedRows) pending.push(...inferAndIndex(buffered));
						parsedRows = [];
						retainedBytes = 0;
						pending.push(...inferAndIndex(row));
						row = undefined;
						for (const indexable of pending) yield indexable;
						continue;
					}

					if (streamingInference) {
						const indexables = inferAndIndex(row);
						row = undefined;
						for (const indexable of indexables) yield indexable;
						continue;
					}

					parsedRows.push(row);
					retainedBytes += lineBytes;
				}
			} catch {
				// Unreadable mid-stream — index the complete prefix already read.
			} finally {
				rl.close();
				try { stream.close(); } catch { /* ignore */ }
			}

			if (streamingInference) continue;

			// Bounded histories retain exact id/timestamp/FIFO sidecar correlation.
			const authoredMessages = mergeAuthorSidecarIntoMessages(
				this.readAuthorBindings(session.id),
				parsedRows.map((row) => row.message),
				normalizationContext,
			);
			for (let rowIndex = 0; rowIndex < parsedRows.length; rowIndex++) {
				for (const indexable of toIndexables(parsedRows[rowIndex], authoredMessages[rowIndex])) {
					yield indexable;
				}
			}
		}
	}
}
