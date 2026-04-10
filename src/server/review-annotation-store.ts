import fs from "node:fs";
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

interface ReviewAnnotationData {
	annotations: Record<string, ReviewAnnotation[]>; // keyed by docTitle
	submitted: boolean;
}

const EMPTY_DATA: ReviewAnnotationData = { annotations: {}, submitted: false };

/**
 * Server-side store for review annotations. One JSON file per session.
 * Persisted to `.bobbit/state/review-annotations-{sessionId}.json`.
 */
export class ReviewAnnotationStore {
	constructor(private stateDir: string) {}

	private filePath(sessionId: string): string {
		return path.join(this.stateDir, `review-annotations-${sessionId}.json`);
	}

	private read(sessionId: string): ReviewAnnotationData {
		try {
			const fp = this.filePath(sessionId);
			if (fs.existsSync(fp)) {
				const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
				if (raw && typeof raw === "object" && !Array.isArray(raw)) {
					return {
						annotations: raw.annotations ?? {},
						submitted: !!raw.submitted,
					};
				}
			}
		} catch (err) {
			console.error("[review-annotation-store] Failed to read:", err);
		}
		return { annotations: {}, submitted: false };
	}

	private write(sessionId: string, data: ReviewAnnotationData): void {
		try {
			if (!fs.existsSync(this.stateDir)) fs.mkdirSync(this.stateDir, { recursive: true });
			fs.writeFileSync(this.filePath(sessionId), JSON.stringify(data, null, 2), "utf-8");
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

	setSubmitted(sessionId: string, value: boolean): void {
		const data = this.read(sessionId);
		data.submitted = value;
		this.write(sessionId, data);
	}

	isSubmitted(sessionId: string): boolean {
		return this.read(sessionId).submitted;
	}

	deleteFile(sessionId: string): void {
		try {
			const fp = this.filePath(sessionId);
			if (fs.existsSync(fp)) {
				fs.unlinkSync(fp);
			}
		} catch (err) {
			console.error("[review-annotation-store] Failed to delete:", err);
		}
	}
}
