/**
 * `Indexer` — orchestrates the flow from `Indexable`s to FlexSearch
 * documents.
 *
 * Responsibilities (design §3, §9, §13):
 *   - Incremental upsert: dedup by `contentHash`, chunk long text, push
 *     to the store.
 *   - Backlog counter + debounced `index:progress` emission.
 *   - Full rebuild from a set of `IndexSource`s: clear the store,
 *     drain each source, write meta.
 *
 * This module is store-agnostic in spirit — it talks to `FlexSearchStore`
 * through a narrow surface (`upsert` / `deleteByIds` / `deleteWhere` /
 * `clear` / `getHashForEntry` / `writeMeta`). Source iteration lives in
 * `sources/*.ts`.
 *
 * Design reference: docs/design/portable-search.md §3, §6, §13.
 */

import { isMessageAuthor } from "../../shared/message-author.js";
import type { Indexable, IndexSource, IndexSourceContext } from "./types.js";
import { FlexSearchStore, FLEX_VERSION, type FlexDoc } from "./flex-store.js";
import type { ProgressBus } from "./progress-bus.js";
import { chunkText, approxTokenCount } from "./chunker.js";
import { CONTENT_POLICY_VERSION } from "./content-policy.js";
import { buildCurrentMeta } from "./meta.js";

// ── Tunables ─────────────────────────────────────────────────────────

const UPSERT_BATCH_SIZE = 128;
const MAX_TOKENS = 2000;
const CHUNK_OVERLAP = 200;
const PROGRESS_DEBOUNCE_MS = 500;

// ── Options ──────────────────────────────────────────────────────────

export interface IndexerOptions {
	store: FlexSearchStore;
	progressBus: ProgressBus;
	projectId: string;
	/** Override debounce window for tests. Defaults to 500ms. */
	progressDebounceMs?: number;
	/** Override max tokens per chunk. Defaults to 2000. */
	maxTokens?: number;
	/** Override chunk overlap tokens. Defaults to 200. */
	chunkOverlap?: number;
}

// ── Indexer ──────────────────────────────────────────────────────────

export class Indexer {
	readonly projectId: string;
	private readonly store: FlexSearchStore;
	private readonly progressBus: ProgressBus;
	private readonly progressDebounceMs: number;
	private readonly maxTokens: number;
	private readonly chunkOverlap: number;

	private _backlog = 0;
	private _lastProgressEmit = 0;
	private _progressTimer: NodeJS.Timeout | null = null;
	private _pendingPhase: "rebuild" | "incremental" = "incremental";
	private _pendingTotal = 0;
	private _pendingCompleted = 0;

	constructor(opts: IndexerOptions) {
		this.store = opts.store;
		this.progressBus = opts.progressBus;
		this.projectId = opts.projectId;
		this.progressDebounceMs = opts.progressDebounceMs ?? PROGRESS_DEBOUNCE_MS;
		this.maxTokens = opts.maxTokens ?? MAX_TOKENS;
		this.chunkOverlap = opts.chunkOverlap ?? CHUNK_OVERLAP;
	}

	get backlog(): number {
		return this._backlog;
	}

	// ── Public API ───────────────────────────────────────────────────

	async upsertEntries(entries: Indexable[]): Promise<void> {
		if (entries.length === 0) return;

		this._backlog += entries.length;
		this._pendingPhase = "incremental";
		this._pendingTotal = entries.length;
		this._pendingCompleted = 0;
		this._scheduleProgress();

		try {
			// Dedup by contentHash.
			const fresh = this._filterUnchanged(entries);
			const skipped = entries.length - fresh.length;
			if (skipped > 0) {
				this._backlog = Math.max(0, this._backlog - skipped);
				this._pendingCompleted += skipped;
				this._scheduleProgress();
			}

			const expanded = this._expandWithChunks(fresh);
			for (let i = 0; i < expanded.length; i += UPSERT_BATCH_SIZE) {
				await this.store.upsert(expanded.slice(i, i + UPSERT_BATCH_SIZE).map((b) => b.doc));

				const originalsInBatch = new Set(
					expanded.slice(i, i + UPSERT_BATCH_SIZE).map((b) => b.originalIndex),
				).size;
				this._backlog = Math.max(0, this._backlog - originalsInBatch);
				this._pendingCompleted = Math.min(fresh.length, this._pendingCompleted + originalsInBatch);
				this._scheduleProgress();
			}

			this._flushProgress();
		} catch (err) {
			this._backlog = Math.max(0, this._backlog - entries.length);
			this._flushProgress();
			const message = err instanceof Error ? err.message : String(err);
			this.progressBus.emit("index:error", {
				projectId: this.projectId,
				message,
				recoverable: true,
			});
			throw err;
		}
	}

	async removeEntries(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await this.store.deleteByIds(ids);
	}

	/**
	 * Back-compat shim for the legacy SQL-filter API. The only call-site
	 * today is `removeMessagesForSession` which passes
	 * `session_id = '<sid>' AND source_id = 'messages'`. Parse that
	 * narrow shape; throw for anything else.
	 */
	async removeByFilter(filter: string | { session_id?: string; source_id?: Indexable["sourceId"] }): Promise<void> {
		if (typeof filter === "object") {
			await this.store.deleteWhere(filter);
			return;
		}
		// Structured parse of "k = 'v' AND k = 'v'" — fine for the one
		// historic caller, safer than a general SQL parser.
		const parts = filter.split(/\s+AND\s+/i);
		const where: { session_id?: string; source_id?: Indexable["sourceId"] } = {};
		for (const p of parts) {
			const m = p.trim().match(/^(\w+)\s*=\s*'([^']*)'$/);
			if (!m) throw new Error(`Indexer.removeByFilter: cannot parse "${filter}"`);
			const [, k, v] = m;
			if (k === "session_id") where.session_id = v;
			else if (k === "source_id") where.source_id = v as Indexable["sourceId"];
			else throw new Error(`Indexer.removeByFilter: unsupported filter key "${k}"`);
		}
		await this.store.deleteWhere(where);
	}

	async rebuildFromSources(sources: IndexSource[], ctx: IndexSourceContext): Promise<void> {
		const startedAt = Date.now();
		this._pendingPhase = "rebuild";
		this._pendingTotal = 0;
		this._pendingCompleted = 0;

		try {
			await this.store.clear();

			let rowsWritten = 0;
			let buffer: Indexable[] = [];
			const FLUSH_AT = UPSERT_BATCH_SIZE;

			const yieldToLoop = () =>
				new Promise<void>((resolve) => setImmediate(resolve));

			const flush = async () => {
				if (buffer.length === 0) return;
				const expanded = this._expandWithChunks(buffer);
				for (let i = 0; i < expanded.length; i += UPSERT_BATCH_SIZE) {
					const batch = expanded.slice(i, i + UPSERT_BATCH_SIZE).map((b) => b.doc);
					await this.store.upsert(batch);
					rowsWritten += batch.length;
					await yieldToLoop();
				}
				this._pendingCompleted += buffer.length;
				this._scheduleProgress();
				buffer = [];
			};

			for (const src of sources) {
				for await (const entry of src.iterate(ctx)) {
					buffer.push(entry);
					this._pendingTotal++;
					if (buffer.length >= FLUSH_AT) await flush();
				}
			}
			await flush();
			this._flushProgress();

			await this.store.writeMeta(
				buildCurrentMeta({
					engine: "flexsearch",
					engineVersion: FLEX_VERSION,
					contentPolicyVersion: CONTENT_POLICY_VERSION,
				}),
			);

			this.progressBus.emit("index:complete", {
				projectId: this.projectId,
				phase: "rebuild",
				durationMs: Date.now() - startedAt,
				rowsWritten,
			});
		} catch (err) {
			this._flushProgress();
			const message = err instanceof Error ? err.message : String(err);
			this.progressBus.emit("index:error", {
				projectId: this.projectId,
				message,
				recoverable: true,
			});
			throw err;
		}
	}

	// ── Internals ────────────────────────────────────────────────────

	private _filterUnchanged(entries: Indexable[]): Indexable[] {
		return entries.filter((e) => this.store.getHashForEntry(e.id) !== e.contentHash);
	}

	private _expandWithChunks(entries: Indexable[]): Array<{
		originalIndex: number;
		doc: FlexDoc;
	}> {
		const out: Array<{ originalIndex: number; doc: FlexDoc }> = [];
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			if (!e.text || e.text.trim().length === 0) continue;

			const tokenCount = approxTokenCount(e.text);
			if (tokenCount <= this.maxTokens) {
				out.push({ originalIndex: i, doc: indexableToDoc(e, e.text, null) });
				continue;
			}

			const chunks = chunkText(e.text, e.id, {
				maxTokens: this.maxTokens,
				overlap: this.chunkOverlap,
			});
			for (const c of chunks) {
				const doc = indexableToDoc(e, c.text, e.id);
				doc.id = c.id;
				out.push({ originalIndex: i, doc });
			}
		}
		return out;
	}

	private _scheduleProgress(): void {
		const now = Date.now();
		const elapsed = now - this._lastProgressEmit;
		if (elapsed >= this.progressDebounceMs) {
			this._flushProgress();
			return;
		}
		if (this._progressTimer) return;
		const delay = this.progressDebounceMs - elapsed;
		this._progressTimer = setTimeout(() => {
			this._progressTimer = null;
			this._flushProgress();
		}, delay);
		if (typeof this._progressTimer.unref === "function") this._progressTimer.unref();
	}

	private _flushProgress(): void {
		if (this._progressTimer) {
			clearTimeout(this._progressTimer);
			this._progressTimer = null;
		}
		this._lastProgressEmit = Date.now();
		this.progressBus.emit("index:progress", {
			projectId: this.projectId,
			phase: this._pendingPhase,
			total: this._pendingTotal,
			completed: this._pendingCompleted,
			backlog: this._backlog,
		});
	}
}

// ── Pure helpers ─────────────────────────────────────────────────────

export function indexableToDoc(e: Indexable, text: string, parentId: string | null): FlexDoc {
	const md = e.metadata ?? {};
	const goalId = pickString(md.goal_id ?? md.goalId);
	const sessionId = pickString(md.session_id ?? md.sessionId);
	const sessionTitle = pickString(md.session_title ?? md.sessionTitle);
	const authorCandidate = {
		kind: md.author_kind ?? md.authorKind,
		id: md.author_id ?? md.authorId,
		label: md.author_label ?? md.authorLabel,
	};
	const author = isMessageAuthor(authorCandidate) ? authorCandidate : null;

	const title = e.display?.title ?? null;
	const filePath = e.display?.filePath ?? null;
	const startLine = typeof e.display?.startLine === "number" ? e.display.startLine : null;
	const endLine = typeof e.display?.endLine === "number" ? e.display.endLine : null;

	const archived = e.archived === true;
	return {
		id: e.id,
		source_id: e.sourceId,
		project_id: e.projectId,
		entity_type: entityTypeFor(e.sourceId),
		parent_id: parentId,
		archived,
		archived_tag: archived ? "true" : "false",
		timestamp: e.timestamp,
		content_hash: e.contentHash,
		weight: e.weight,
		role: e.role ?? null,
		title,
		text,
		identifier_text: "", // derived inside FlexSearchStore._prepare
		goal_id: goalId,
		session_id: sessionId,
		session_title: sessionTitle,
		author_kind: author?.kind ?? null,
		author_id: author?.id ?? null,
		author_label: author?.label ?? null,
		file_path: filePath,
		start_line: startLine,
		end_line: endLine,
	};
}

function entityTypeFor(sourceId: Indexable["sourceId"]): FlexDoc["entity_type"] {
	switch (sourceId) {
		case "goals": return "goal";
		case "sessions": return "session";
		case "messages": return "message";
		case "staff": return "staff";
		case "files": return "file";
	}
}

function pickString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}
