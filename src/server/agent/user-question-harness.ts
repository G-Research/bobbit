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
}

export interface UserQuestionAnswer {
	question: string;
	/** Option text the user picked; "Other" when the user typed a free-text answer. */
	selected: string;
	/** Free-text content when `selected === "Other"`, otherwise null. */
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
	}
	return null;
}

/**
 * Validate the shape of `answers` submitted by the UI. Returns null on success.
 */
export function validateAnswers(answers: unknown): string | null {
	if (!Array.isArray(answers)) return "answers must be an array";
	for (let i = 0; i < answers.length; i++) {
		const a = answers[i];
		if (!a || typeof a !== "object") return `answers[${i}] must be an object`;
		const aa = a as Record<string, unknown>;
		if (typeof aa.question !== "string") return `answers[${i}].question must be a string`;
		if (typeof aa.selected !== "string") return `answers[${i}].selected must be a string`;
		if (aa.other_text !== null && typeof aa.other_text !== "string") {
			return `answers[${i}].other_text must be a string or null`;
		}
	}
	return null;
}

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
	 * Returns true if a pending entry was found and resolved, false otherwise.
	 */
	submit(
		sessionId: string,
		toolUseId: string,
		answers: UserQuestionAnswer[],
	): boolean {
		const key = this.key(sessionId, toolUseId);
		const p = this.pending.get(key);
		if (!p) return false;
		this.pending.delete(key);
		p.resolve(answers);
		return true;
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
