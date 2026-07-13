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
import type { IndexSource, IndexSourceContext, Indexable } from "../types.js";
import { extractForIndexing } from "../content-policy.js";
import { contentHashOf } from "./hash.js";
import { formatSessionSearchTitle } from "./session-title.js";
import {
	readAuthorSidecar,
	mergeAuthorSidecarIntoMessages,
	type PromptAuthorBinding,
} from "../../agent/author-sidecar.js";

export class MessageIndexSource implements IndexSource {
	readonly sourceId = "messages" as const;

	constructor(
		private readonly readAuthorBindings: (sessionId: string) => PromptAuthorBinding[] = readAuthorSidecar,
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

			interface ParsedRow {
				msgIdx: number;
				message: Record<string, unknown>;
				timestamp: number;
			}
			const parsedRows: ParsedRow[] = [];
			let msgIdx = 0;
			try {
				for await (const line of rl) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					let entry: unknown;
					try {
						entry = JSON.parse(trimmed);
					} catch {
						continue;
					}
					// Agent session files wrap the actual message in `{ message: {...} }`
					// for tool events; fall back to the envelope itself otherwise.
					const envelope = entry as Record<string, unknown>;
					const rawMessage = (envelope.message as Record<string, unknown> | undefined) ?? envelope;

					// Timestamp precedence: per-message timestamp if present, else
					// envelope timestamp, else session lastActivity.
					const rawTs = rawMessage.timestamp ?? envelope.timestamp;
					const timestamp =
						typeof rawTs === "number"
							? rawTs
							: typeof rawTs === "string"
								? Date.parse(rawTs) || (session.lastActivity ?? 0)
								: session.lastActivity ?? 0;
					const { author: _untrustedAuthor, ...message } = rawMessage;
					parsedRows.push({
						msgIdx: msgIdx++,
						timestamp,
						message: {
							...message,
							...(typeof envelope.id === "string" ? { entryId: envelope.id } : {}),
							...(rawTs !== undefined ? { timestamp: rawTs } : {}),
						},
					});
				}
			} catch {
				// Unreadable mid-stream — index the complete prefix already read.
			} finally {
				rl.close();
				try { stream.close(); } catch { /* ignore */ }
			}

			// Fold the host-side sidecar once per session, then normalize the full
			// ordered sequence so duplicate prompt and tool-result attribution is stable.
			const authoredMessages = mergeAuthorSidecarIntoMessages(
				this.readAuthorBindings(session.id),
				parsedRows.map((row) => row.message),
				{
					session,
					agentDeps: {
						getStaff: (id: string) => typeof ctx.staffStore.get === "function" ? ctx.staffStore.get(id) : undefined,
					},
				},
			);
			for (let rowIndex = 0; rowIndex < parsedRows.length; rowIndex++) {
				const { msgIdx: index, timestamp } = parsedRows[rowIndex];
				const msg = authoredMessages[rowIndex];
				const hit = extractForIndexing(msg);
				for (const entry of hit.entries) {
					const id = `message:${session.id}:${index}:${entry.blockKey}`;
					const metadata: Record<string, string | number | boolean> = {
						sessionId: session.id,
						msgIdx: index,
						blockKey: entry.blockKey,
						...(session.goalId ? { goalId: session.goalId } : {}),
					};
					if (goalTitle) metadata.goalTitle = goalTitle;
					if (displayTitle) metadata.sessionTitle = displayTitle;
					if (msg.author) {
						metadata.authorKind = msg.author.kind;
						metadata.authorId = msg.author.id;
						metadata.authorLabel = msg.author.label;
					}
					const indexable: Indexable = {
						id,
						sourceId: "messages",
						text: entry.text,
						metadata,
						contentHash: contentHashOf(
							`${entry.text}\n${displayTitle}`,
							entry.weight,
							entry.role,
							timestamp,
						),
						timestamp,
						projectId: session.projectId ?? ctx.projectId,
						archived: session.archived === true,
						weight: entry.weight,
						role: entry.role,
						display: { title: displayTitle },
					};
					yield indexable;
				}
			}
		}
	}
}
