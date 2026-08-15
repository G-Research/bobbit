import type { FsLike } from "./gateway-deps.js";
import { realFs } from "./gateway-deps.js";
import path from "node:path";

export interface ReviewAnnotation {
	id: string;
	quote: string;
	comment: string;
	prefix?: string;
	suffix?: string;
	start?: number;
	end?: number;
	isCode?: boolean;
}

export type ReviewTombstoneState = "submitted" | "closed";

export interface ReviewAnnotationData {
	annotations: Record<string, ReviewAnnotation[]>; // keyed by document identity (legacy data uses docTitle)
	/** Legacy session-wide flag. New callers should use per-review tombstones. */
	submitted: boolean;
	submittedReviewIds: string[];
	closedReviewIds: string[];
	activeFileIds: Record<string, string>;
}

const emptyData = (): ReviewAnnotationData => ({
	annotations: {},
	submitted: false,
	submittedReviewIds: [],
	closedReviewIds: [],
	activeFileIds: {},
});

function stringIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
}

function activeFileIds(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
		entry[0].trim().length > 0 && typeof entry[1] === "string" && entry[1].trim().length > 0));
}

/**
 * Server-side store for review annotations. One JSON file per session.
 * Persisted to `.bobbit/state/review-annotations-{sessionId}.json`.
 */
export class ReviewAnnotationStore {
	constructor(private stateDir: string, private readonly fs: FsLike = realFs) {}

	private filePath(sessionId: string): string {
		return path.join(this.stateDir, `review-annotations-${sessionId}.json`);
	}

	private parse(raw: unknown): ReviewAnnotationData {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid review annotation data");
		const value = raw as Record<string, unknown>;
		return {
			annotations: value.annotations && typeof value.annotations === "object" && !Array.isArray(value.annotations)
				? value.annotations as Record<string, ReviewAnnotation[]>
				: {},
			submitted: value.submitted === true,
			submittedReviewIds: stringIds(value.submittedReviewIds),
			closedReviewIds: stringIds(value.closedReviewIds),
			activeFileIds: activeFileIds(value.activeFileIds),
		};
	}

	private readChecked(sessionId: string): ReviewAnnotationData {
		const fp = this.filePath(sessionId);
		if (!this.fs.existsSync(fp)) return emptyData();
		return this.parse(JSON.parse(this.fs.readFileSync(fp, "utf-8")));
	}

	private read(sessionId: string): ReviewAnnotationData {
		try {
			return this.readChecked(sessionId);
		} catch (err) {
			console.error("[review-annotation-store] Failed to read:", err);
			return emptyData();
		}
	}

	private writeChecked(sessionId: string, data: ReviewAnnotationData): void {
		if (!this.fs.existsSync(this.stateDir)) this.fs.mkdirSync(this.stateDir, { recursive: true });
		this.fs.writeFileSync(this.filePath(sessionId), JSON.stringify(data, null, 2), "utf-8");
	}

	private write(sessionId: string, data: ReviewAnnotationData): void {
		try {
			this.writeChecked(sessionId, data);
		} catch (err) {
			console.error("[review-annotation-store] Failed to write:", err);
		}
	}

	getAll(sessionId: string): ReviewAnnotationData {
		return this.read(sessionId);
	}

	addAnnotation(sessionId: string, docTitle: string, annotation: ReviewAnnotation): void {
		const data = this.read(sessionId);
		if (!data.annotations[docTitle]) {
			data.annotations[docTitle] = [];
		}
		// Replace if same id exists (upsert), otherwise append
		const idx = data.annotations[docTitle].findIndex((a) => a.id === annotation.id);
		if (idx >= 0) {
			data.annotations[docTitle][idx] = annotation;
		} else {
			data.annotations[docTitle].push(annotation);
		}
		this.write(sessionId, data);
	}

	removeAnnotation(sessionId: string, docTitle: string, annotationId: string): void {
		const data = this.read(sessionId);
		if (data.annotations[docTitle]) {
			data.annotations[docTitle] = data.annotations[docTitle].filter((a) => a.id !== annotationId);
			if (data.annotations[docTitle].length === 0) {
				delete data.annotations[docTitle];
			}
			this.write(sessionId, data);
		}
	}

	clearAnnotations(sessionId: string, docTitle: string): void {
		const data = this.read(sessionId);
		if (data.annotations[docTitle]) {
			delete data.annotations[docTitle];
			this.write(sessionId, data);
		}
	}

	clearAll(sessionId: string): void {
		const data = this.read(sessionId);
		data.annotations = {};
		this.write(sessionId, data);
	}

	/** Legacy session-wide submitted API. Per-review tombstones are not modified. */
	setSubmitted(sessionId: string, value: boolean): void {
		const data = this.read(sessionId);
		data.submitted = value;
		this.write(sessionId, data);
	}

	/** Legacy session-wide submitted API. */
	isSubmitted(sessionId: string): boolean {
		return this.read(sessionId).submitted;
	}

	getReviewTombstones(sessionId: string): Pick<ReviewAnnotationData, "submittedReviewIds" | "closedReviewIds"> & { legacySubmitted: boolean } {
		const data = this.read(sessionId);
		return {
			submittedReviewIds: data.submittedReviewIds,
			closedReviewIds: data.closedReviewIds,
			legacySubmitted: data.submitted,
		};
	}

	/**
	 * Read an exact review tombstone. A legacy `submitted: true` file is claimed
	 * by the first exact review lookup and durably migrated. Legacy data could
	 * only represent one review, so assigning it once avoids suppressing every
	 * review in a new multi-review session.
	 */
	getReviewTombstone(sessionId: string, reviewId: string): ReviewTombstoneState | undefined {
		const data = this.read(sessionId);
		if (data.submittedReviewIds.includes(reviewId)) return "submitted";
		if (data.closedReviewIds.includes(reviewId)) return "closed";
		if (!data.submitted) return undefined;

		data.submitted = false;
		data.submittedReviewIds.push(reviewId);
		this.write(sessionId, data);
		return "submitted";
	}

	setReviewTombstone(sessionId: string, reviewId: string, state: ReviewTombstoneState, activeFileId?: string): void {
		const data = this.read(sessionId);
		data.submittedReviewIds = data.submittedReviewIds.filter((id) => id !== reviewId);
		data.closedReviewIds = data.closedReviewIds.filter((id) => id !== reviewId);
		if (state === "submitted") data.submittedReviewIds.push(reviewId);
		else data.closedReviewIds.push(reviewId);
		if (activeFileId) data.activeFileIds[reviewId] = activeFileId;
		else delete data.activeFileIds[reviewId];
		this.write(sessionId, data);
	}

	getReviewActiveFile(sessionId: string, reviewId: string): string | undefined {
		return this.read(sessionId).activeFileIds[reviewId];
	}

	clearReviewTombstone(
		sessionId: string,
		reviewId: string,
		options: { clearLegacySubmitted?: boolean } = {},
	): void {
		const data = this.read(sessionId);
		const submittedReviewIds = data.submittedReviewIds.filter((id) => id !== reviewId);
		const closedReviewIds = data.closedReviewIds.filter((id) => id !== reviewId);
		const clearsExact = submittedReviewIds.length !== data.submittedReviewIds.length
			|| closedReviewIds.length !== data.closedReviewIds.length;
		const clearsLegacy = options.clearLegacySubmitted === true && data.submitted;
		const clearsActiveFile = Object.prototype.hasOwnProperty.call(data.activeFileIds, reviewId);
		if (!clearsExact && !clearsLegacy && !clearsActiveFile) return;
		data.submittedReviewIds = submittedReviewIds;
		data.closedReviewIds = closedReviewIds;
		delete data.activeFileIds[reviewId];
		if (options.clearLegacySubmitted) data.submitted = false;
		this.write(sessionId, data);
	}

	/**
	 * Overwrite annotations for a session (used by bulk save / sendBeacon).
	 * Tombstones are always merged from the latest disk state, never accepted
	 * from the bulk payload, so an unload beacon cannot resurrect a review.
	 */
	writeAll(sessionId: string, annotations: Record<string, ReviewAnnotation[]>, submitted?: boolean): void {
		const data = this.read(sessionId);
		data.annotations = annotations;
		if (typeof submitted === "boolean") data.submitted = submitted;
		this.write(sessionId, data);
	}

	deleteFile(sessionId: string): void {
		try {
			const fp = this.filePath(sessionId);
			if (this.fs.existsSync(fp)) {
				this.fs.unlinkSync(fp);
			}
		} catch (err) {
			console.error("[review-annotation-store] Failed to delete:", err);
		}
	}
}
