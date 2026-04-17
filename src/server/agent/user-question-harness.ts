/**
 * In-memory harness for the `ask_user_choices` tool.
 *
 * The tool extension POSTs to `/api/internal/user-question` and blocks.
 * The server calls `register()` to park a Promise keyed by (sessionId, toolUseId).
 * The UI widget POSTs answers to `/api/internal/user-question/submit`, which
 * calls `submit()` to resolve the parked Promise — the HTTP response to the
 * tool extension then carries the answers back to the agent.
 *
 * Not persisted across restarts: if the server restarts while a question is
 * pending, the extension's HTTP call is severed and the tool returns an error.
 */

export interface UserQuestion {
	question: string;
	options: string[];
	allow_other?: boolean;
	/** When true, the UI renders checkboxes and `selected` is an array. */
	multi?: boolean;
	/** Minimum number of selections when `multi`. Defaults to 1. */
	min?: number;
	/** Maximum number of selections when `multi`. Defaults to options.length (+1 if allow_other). */
	max?: number;
}

export interface UserQuestionAnswer {
	question: string;
	/**
	 * Single-select: option text the user picked; "Other" when free-text.
	 * Multi-select: array of option texts (may include "Other").
	 */
	selected: string | string[];
	/** Free-text content when "Other" was picked, otherwise null. */
	other_text: string | null;
}

export interface PendingUserQuestion {
	sessionId: string;
	toolUseId: string;
	questions: UserQuestion[];
	createdAt: number;
	resolve: (answers: UserQuestionAnswer[]) => void;
	reject: (err: Error) => void;
}

/**
 * Validate the shape of `questions`. Returns null on success, or a human-readable
 * error message on failure.
 */
export function validateQuestions(questions: unknown): string | null {
	if (!Array.isArray(questions)) return "questions must be an array";
	if (questions.length < 1 || questions.length > 5) {
		return `questions must contain 1-5 items (got ${questions.length})`;
	}
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		if (!q || typeof q !== "object") return `questions[${i}] must be an object`;
		const qq = q as Record<string, unknown>;
		if (typeof qq.question !== "string" || qq.question.trim().length === 0) {
			return `questions[${i}].question must be a non-empty string`;
		}
		if (!Array.isArray(qq.options)) return `questions[${i}].options must be an array`;
		if (qq.options.length < 2 || qq.options.length > 8) {
			return `questions[${i}].options must contain 2-8 items (got ${qq.options.length})`;
		}
		for (let j = 0; j < qq.options.length; j++) {
			const opt = qq.options[j];
			if (typeof opt !== "string" || opt.length === 0) {
				return `questions[${i}].options[${j}] must be a non-empty string`;
			}
		}
		if (qq.allow_other !== undefined && typeof qq.allow_other !== "boolean") {
			return `questions[${i}].allow_other must be a boolean if present`;
		}
		if (qq.multi !== undefined && typeof qq.multi !== "boolean") {
			return `questions[${i}].multi must be a boolean if present`;
		}
		const maxOptionCount = qq.options.length + (qq.allow_other === true ? 1 : 0);
		if (qq.min !== undefined) {
			if (typeof qq.min !== "number" || !Number.isInteger(qq.min) || qq.min < 1) {
				return `questions[${i}].min must be a positive integer if present`;
			}
			if (qq.min > maxOptionCount) {
				return `questions[${i}].min (${qq.min}) exceeds the number of options (${maxOptionCount})`;
			}
		}
		if (qq.max !== undefined) {
			if (typeof qq.max !== "number" || !Number.isInteger(qq.max) || qq.max < 1) {
				return `questions[${i}].max must be a positive integer if present`;
			}
			if (qq.max > maxOptionCount) {
				return `questions[${i}].max (${qq.max}) exceeds the number of options (${maxOptionCount})`;
			}
		}
		if (qq.min !== undefined && qq.max !== undefined && (qq.min as number) > (qq.max as number)) {
			return `questions[${i}].min (${qq.min}) must be <= max (${qq.max})`;
		}
		// min/max only meaningful when multi:true — but we don't reject if
		// they're set without multi; they're silently ignored.
	}
	return null;
}

/**
 * Validate the raw shape of `answers` submitted by the UI (no cross-check
 * against questions — that happens inside submit()).
 */
export function validateAnswers(answers: unknown): string | null {
	if (!Array.isArray(answers)) return "answers must be an array";
	for (let i = 0; i < answers.length; i++) {
		const a = answers[i];
		if (!a || typeof a !== "object") return `answers[${i}] must be an object`;
		const aa = a as Record<string, unknown>;
		if (typeof aa.question !== "string") return `answers[${i}].question must be a string`;
		if (typeof aa.selected !== "string" && !Array.isArray(aa.selected)) {
			return `answers[${i}].selected must be a string or an array of strings`;
		}
		if (Array.isArray(aa.selected)) {
			for (let j = 0; j < aa.selected.length; j++) {
				if (typeof aa.selected[j] !== "string") {
					return `answers[${i}].selected[${j}] must be a string`;
				}
			}
		}
		if (aa.other_text !== null && typeof aa.other_text !== "string") {
			return `answers[${i}].other_text must be a string or null`;
		}
	}
	return null;
}

/**
 * Cross-check submitted answers against the registered question shape.
 * Returns null on success, or a human-readable error message on failure.
 */
function crossValidate(
	questions: UserQuestion[],
	answers: UserQuestionAnswer[],
): string | null {
	if (answers.length !== questions.length) {
		return `answers length (${answers.length}) does not match questions length (${questions.length})`;
	}
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const a = answers[i];
		const multi = q.multi === true;
		const maxOptionCount = q.options.length + (q.allow_other === true ? 1 : 0);
		const min = multi ? (q.min ?? 1) : 1;
		const max = multi ? (q.max ?? maxOptionCount) : 1;
		if (multi) {
			if (!Array.isArray(a.selected)) {
				return `answers[${i}].selected must be an array for multi-select question`;
			}
			if (a.selected.length < min) {
				return `answers[${i}].selected has ${a.selected.length} items, minimum is ${min}`;
			}
			if (a.selected.length > max) {
				return `answers[${i}].selected has ${a.selected.length} items, maximum is ${max}`;
			}
			const hasOther = a.selected.includes("Other");
			if (hasOther && (a.other_text === null || a.other_text.trim() === "")) {
				return `answers[${i}].other_text must be a non-empty string when "Other" is selected`;
			}
			if (!hasOther && a.other_text !== null) {
				return `answers[${i}].other_text must be null when "Other" is not selected`;
			}
		} else {
			if (typeof a.selected !== "string") {
				return `answers[${i}].selected must be a string for single-select question`;
			}
			const isOther = a.selected === "Other";
			if (isOther && (a.other_text === null || a.other_text.trim() === "")) {
				return `answers[${i}].other_text must be a non-empty string when "Other" is selected`;
			}
			if (!isOther && a.other_text !== null) {
				return `answers[${i}].other_text must be null when "Other" is not selected`;
			}
		}
	}
	return null;
}

export type SubmitResult =
	| { ok: true }
	| { ok: false; code: "not_found" | "invalid"; error: string };

export class UserQuestionHarness {
	/** keyed by `${sessionId}:${toolUseId}` — allows concurrent questions per session */
	private pending = new Map<string, PendingUserQuestion>();

	private key(sessionId: string, toolUseId: string): string {
		return `${sessionId}:${toolUseId}`;
	}

	/**
	 * Register a pending question and return a Promise that resolves when the
	 * user submits, or rejects if the session is terminated.
	 *
	 * Idempotent: if the same (sessionId, toolUseId) registers twice (e.g. agent
	 * replay), the second call receives the same resolution as the first.
	 */
	register(
		sessionId: string,
		toolUseId: string,
		questions: UserQuestion[],
	): Promise<UserQuestionAnswer[]> {
		const key = this.key(sessionId, toolUseId);
		const existing = this.pending.get(key);
		if (existing) {
			return new Promise<UserQuestionAnswer[]>((res, rej) => {
				const origResolve = existing.resolve;
				const origReject = existing.reject;
				existing.resolve = (a) => { origResolve(a); res(a); };
				existing.reject = (e) => { origReject(e); rej(e); };
			});
		}
		return new Promise<UserQuestionAnswer[]>((resolve, reject) => {
			this.pending.set(key, {
				sessionId,
				toolUseId,
				questions,
				createdAt: Date.now(),
				resolve,
				reject,
			});
		});
	}

	/**
	 * Resolve a pending question with the user's answers.
	 * Cross-validates the answers against the registered question shape.
	 */
	submit(
		sessionId: string,
		toolUseId: string,
		answers: UserQuestionAnswer[],
	): SubmitResult {
		const key = this.key(sessionId, toolUseId);
		const p = this.pending.get(key);
		if (!p) return { ok: false, code: "not_found", error: "No pending question for this session/toolUseId" };
		const crossErr = crossValidate(p.questions, answers);
		if (crossErr) return { ok: false, code: "invalid", error: crossErr };
		this.pending.delete(key);
		p.resolve(answers);
		return { ok: true };
	}

	/**
	 * Reject all pending questions for a given session — called on session
	 * termination or abort.
	 */
	rejectAllForSession(sessionId: string, reason = "Session terminated"): void {
		for (const [k, p] of this.pending) {
			if (p.sessionId === sessionId) {
				this.pending.delete(k);
				p.reject(new Error(reason));
			}
		}
	}

	/** Inspection helper — list pending questions for a session (UI rehydrate). */
	listForSession(sessionId: string): PendingUserQuestion[] {
		return [...this.pending.values()].filter(p => p.sessionId === sessionId);
	}

	/** Test-only: clear all pending. */
	clear(): void {
		this.pending.clear();
	}

	/** Total number of pending questions (for diagnostics). */
	size(): number {
		return this.pending.size;
	}
}
