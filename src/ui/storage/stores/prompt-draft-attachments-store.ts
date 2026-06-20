import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";
import type { Attachment } from "../../utils/attachment-utils.js";

const STORE_NAME = "prompt-draft-attachments";

/** Hard cap on attachments persisted per session — mirrors MessageEditor.maxFiles
 *  (10). A composer can never legitimately hold more than this. */
const MAX_FILES_PER_SESSION = 10;
/** Best-effort cap on how many sessions retain attachment drafts. Oldest
 *  (by updatedAt) are evicted first so the store can't grow unbounded. */
const MAX_SESSIONS = 20;
/** Best-effort cap on total base64 bytes across all retained sessions. Pasted
 *  screenshots are large, so this keeps IndexedDB usage bounded. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MB

interface PromptDraftAttachmentsRecord {
	/** Session id — primary key. */
	sessionId: string;
	/** The composer's pending attachments (pasted/dragged images, documents). */
	attachments: Attachment[];
	/** Epoch ms of the last write — used for LRU eviction. */
	updatedAt: number;
}

/** Rough serialized size of a record's attachments (base64 dominates). */
function recordBytes(rec: PromptDraftAttachmentsRecord): number {
	let bytes = 0;
	for (const a of rec.attachments) {
		bytes += (a.content?.length ?? 0) + (a.preview?.length ?? 0) + (a.extractedText?.length ?? 0);
	}
	return bytes;
}

/**
 * Per-session persistence for unsent composer attachments (pasted/dragged
 * images and documents). Lives in IndexedDB — NOT in the server session draft —
 * because base64 image blobs are large and the server `prompt` draft is stored
 * inline in `sessions.json`. Keyed by session id with LRU + byte caps so it can
 * never grow unbounded.
 *
 * See docs/design/composer-draft-persistence.md.
 */
export class PromptDraftAttachmentsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: STORE_NAME,
			keyPath: "sessionId",
			indices: [{ name: "updatedAt", keyPath: "updatedAt" }],
		};
	}

	/** Return the persisted attachments for a session (empty array if none). */
	async getAttachments(sessionId: string): Promise<Attachment[]> {
		if (!sessionId) return [];
		try {
			const rec = await this.getBackend().get<PromptDraftAttachmentsRecord>(STORE_NAME, sessionId);
			return Array.isArray(rec?.attachments) ? rec!.attachments : [];
		} catch {
			return [];
		}
	}

	/** Persist the composer attachments for a session. An empty list deletes the
	 *  record. Applies per-session, per-session-count and total-byte caps. */
	async setAttachments(sessionId: string, attachments: Attachment[]): Promise<void> {
		if (!sessionId) return;
		const list = Array.isArray(attachments) ? attachments.slice(0, MAX_FILES_PER_SESSION) : [];
		if (list.length === 0) {
			await this.deleteAttachments(sessionId);
			return;
		}
		const backend = this.getBackend();
		try {
			const rec: PromptDraftAttachmentsRecord = {
				sessionId,
				attachments: list,
				updatedAt: Date.now(),
			};
			await backend.set(STORE_NAME, sessionId, rec);
			await this._evict(sessionId);
		} catch (err) {
			console.error("[prompt-draft-attachments] Failed to persist:", err);
		}
	}

	/** Delete the persisted attachments for a session. */
	async deleteAttachments(sessionId: string): Promise<void> {
		if (!sessionId) return;
		try {
			await this.getBackend().delete(STORE_NAME, sessionId);
		} catch {
			/* best effort */
		}
	}

	/** LRU + byte-budget eviction. Never evicts the session that was just written. */
	private async _evict(keepSessionId: string): Promise<void> {
		const backend = this.getBackend();
		let records: PromptDraftAttachmentsRecord[];
		try {
			records = await backend.getAllFromIndex<PromptDraftAttachmentsRecord>(STORE_NAME, "updatedAt", "asc");
		} catch {
			return;
		}
		// Oldest first (the index is ascending on updatedAt).
		const evictable = records.filter((r) => r.sessionId !== keepSessionId);
		let totalBytes = records.reduce((sum, r) => sum + recordBytes(r), 0);
		let count = records.length;

		for (const rec of evictable) {
			if (count <= MAX_SESSIONS && totalBytes <= MAX_TOTAL_BYTES) break;
			try {
				await backend.delete(STORE_NAME, rec.sessionId);
				count--;
				totalBytes -= recordBytes(rec);
			} catch {
				/* best effort */
			}
		}
	}
}
