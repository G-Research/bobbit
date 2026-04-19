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

export class MessageIndexSource implements IndexSource {
	readonly sourceId = "messages" as const;

	async *iterate(ctx: IndexSourceContext): AsyncIterable<Indexable> {
		const sessions = ctx.sessionStore.getAll();
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

			const rl = readline.createInterface({
				input: stream,
				crlfDelay: Infinity,
			});

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
					const msg = (envelope.message as Record<string, unknown> | undefined) ?? envelope;

					// Timestamp precedence: per-message timestamp if present, else
					// envelope timestamp, else session lastActivity.
					const rawTs =
						(msg as Record<string, unknown>).timestamp ??
						(envelope as Record<string, unknown>).timestamp;
					const timestamp =
						typeof rawTs === "number"
							? rawTs
							: typeof rawTs === "string"
								? Date.parse(rawTs) || (session.lastActivity ?? 0)
								: session.lastActivity ?? 0;

					const hit = extractForIndexing(msg);
					for (const entry of hit.entries) {
						const id = `message:${session.id}:${msgIdx}:${entry.blockKey}`;
						const indexable: Indexable = {
							id,
							sourceId: "messages",
							text: entry.text,
							metadata: {
								sessionId: session.id,
								msgIdx,
								blockKey: entry.blockKey,
								...(session.goalId ? { goalId: session.goalId } : {}),
							},
							contentHash: contentHashOf(
								entry.text,
								entry.weight,
								entry.role,
								timestamp,
							),
							timestamp,
							projectId: session.projectId ?? ctx.projectId,
							archived: session.archived === true,
							weight: entry.weight,
							role: entry.role,
							display: {
								title: session.title ?? "",
							},
						};
						yield indexable;
					}
					msgIdx++;
				}
			} catch {
				// Unreadable mid-stream — stop for this file, continue with others.
			} finally {
				rl.close();
				try { stream.close(); } catch { /* ignore */ }
			}
		}
	}
}
