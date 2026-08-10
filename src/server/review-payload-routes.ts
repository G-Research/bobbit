import type http from "node:http";
import type { SessionManager } from "./agent/session-manager.js";
import {
	assertReviewPayloadReference,
	MAX_REVIEW_PAYLOAD_REQUEST_BYTES,
	persistReviewPayload,
	readReviewPayload,
	reviewPayloadReceipt,
	ReviewPayloadError,
	type CanonicalReviewPayload,
	type ReviewPayloadOpenOutcome,
} from "./review-payload-store.js";

type ReviewPayloadSessionOperation = <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;

export interface ReviewPayloadSessionCoordinator {
	/** Serialize review route mutations unless purge permanently fenced the owner. */
	run: ReviewPayloadSessionOperation;
	/** Permanently fence new work, wait for accepted work, then remove owner state. */
	purge: ReviewPayloadSessionOperation;
}

/**
 * Coordinate every review-payload mutation for one session. The queue is
 * deliberately separate from SidePanelWorkspaceLocks: an operation may call
 * the workspace mutation API without recursively acquiring the same lock.
 */
export function createReviewPayloadSessionCoordinator(): ReviewPayloadSessionCoordinator {
	const tails = new Map<string, Promise<void>>();
	const purgedSessions = new Set<string>();

	const enqueue: ReviewPayloadSessionOperation = async (sessionId, operation) => {
		const previous = tails.get(sessionId) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
		tails.set(sessionId, current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (tails.get(sessionId) === current) tails.delete(sessionId);
		}
	};

	const run: ReviewPayloadSessionOperation = (sessionId, operation) => {
		if (purgedSessions.has(sessionId)) {
			return Promise.reject(new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable"));
		}
		return enqueue(sessionId, async () => {
			if (purgedSessions.has(sessionId)) {
				throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
			}
			return operation();
		});
	};

	const purge: ReviewPayloadSessionOperation = (sessionId, operation) => {
		purgedSessions.add(sessionId);
		return enqueue(sessionId, operation);
	};

	return { run, purge };
}

export interface ReviewPayloadRouteDeps {
	sessionManager: SessionManager;
	readBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<any>;
	openReview: (payload: CanonicalReviewPayload) => Promise<unknown>;
	operations: ReviewPayloadSessionCoordinator;
	resolveExistingReview?: (
		sessionId: string,
		title: string,
		incomingReviewId: string,
		replace: boolean,
	) => Promise<{ reviewId: string; payload?: CanonicalReviewPayload; activeFileId?: string }>;
}

type LimitedBodyResult = { ok: true; body: unknown } | { ok: false; tooLarge: boolean };

function json(res: http.ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function safeError(error: unknown): ReviewPayloadError {
	if (error instanceof ReviewPayloadError) return error;
	return new ReviewPayloadError(500, "REVIEW_PAYLOAD_INTERNAL_ERROR", "Review content could not be processed", true);
}

function writeError(res: http.ServerResponse, error: unknown): void {
	const safe = safeError(error);
	json(res, safe.statusCode, {
		ok: false,
		status: "failed",
		code: safe.code,
		retryable: safe.retryable,
		message: safe.message,
	});
}

function openFailure(error: unknown): ReviewPayloadOpenOutcome {
	const safe = safeError(error);
	return { ok: false, status: "failed", code: safe.code, retryable: safe.retryable, message: safe.message };
}

function decodePart(value: string): string | null {
	try { return decodeURIComponent(value); } catch { return null; }
}

function header(req: http.IncomingMessage, name: string): string | undefined {
	const value = req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function hasSession(deps: ReviewPayloadRouteDeps, sessionId: string): boolean {
	return !!(deps.sessionManager.getSession(sessionId) ?? deps.sessionManager.getPersistedSession(sessionId));
}

function requireOwningSessionSecret(req: http.IncomingMessage, deps: ReviewPayloadRouteDeps, sessionId: string): void {
	const authentic = deps.sessionManager.sessionSecretStore.resolveSessionIdBySecret(header(req, "x-bobbit-session-secret"));
	if (authentic !== sessionId) {
		throw new ReviewPayloadError(403, "REVIEW_PAYLOAD_UPLOAD_FORBIDDEN", "Review content upload is not authorized");
	}
}

/** Review-specific JSON reader. Chunked overflow settles before `end` and stops input. */
export async function readLimitedReviewJson(req: http.IncomingMessage, maxBytes: number): Promise<LimitedBodyResult> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const finish = (result: LimitedBodyResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		const onData = (chunk: Buffer | string): void => {
			if (settled) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.byteLength;
			if (total > maxBytes) {
				chunks.length = 0;
				req.removeListener("data", onData);
				try { req.pause(); } catch { /* best-effort until the 413 is flushed */ }
				finish({ ok: false, tooLarge: true });
				return;
			}
			chunks.push(bytes);
		};
		req.on("data", onData);
		req.on("end", () => {
			if (settled) return;
			try { finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
			catch { finish({ ok: false, tooLarge: false }); }
		});
		req.on("error", () => finish({ ok: false, tooLarge: false }));
		req.on("aborted", () => finish({ ok: false, tooLarge: false }));
	});
}

function uploadReviewIdentity(raw: unknown): { title: string; reviewId: string; replace: boolean } | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const review = (raw as Record<string, unknown>).review;
	if (!review || typeof review !== "object" || Array.isArray(review)) return null;
	const values = review as Record<string, unknown>;
	return typeof values.title === "string" && typeof values.reviewId === "string" && typeof values.replace === "boolean"
		? { title: values.title, reviewId: values.reviewId, replace: values.replace }
		: null;
}

function reconcileReplacementFiles(raw: unknown, existing: CanonicalReviewPayload | undefined, authoritativeActiveFileId?: string): unknown {
	if (!existing || !raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const root = raw as Record<string, unknown>;
	if (!root.review || typeof root.review !== "object" || Array.isArray(root.review)) return raw;
	const review = root.review as Record<string, unknown>;
	if (!Array.isArray(review.files)) return raw;
	const available = new Map<string, CanonicalReviewPayload["files"]>();
	for (const file of existing.files) {
		const queue = available.get(file.title) ?? [];
		queue.push(file);
		available.set(file.title, queue);
	}
	const incomingActiveId = review.activeFileId;
	const reconciled = review.files.map((file) => {
		if (!file || typeof file !== "object" || Array.isArray(file)) return file;
		const entry = file as Record<string, unknown>;
		const queue = typeof entry.title === "string" ? available.get(entry.title) : undefined;
		const prior = queue?.shift();
		return prior ? { ...entry, fileId: prior.fileId } : entry;
	});
	const retainedIds = new Set(reconciled.flatMap((file) => file && typeof file === "object" && !Array.isArray(file) && typeof (file as Record<string, unknown>).fileId === "string"
		? [(file as Record<string, unknown>).fileId as string]
		: []));
	let activeFileId = authoritativeActiveFileId && retainedIds.has(authoritativeActiveFileId)
		? authoritativeActiveFileId
		: retainedIds.has(existing.activeFileId) ? existing.activeFileId : undefined;
	if (!activeFileId) {
		const incomingActiveIndex = review.files.findIndex((file) => file && typeof file === "object" && !Array.isArray(file) && (file as Record<string, unknown>).fileId === incomingActiveId);
		const active = incomingActiveIndex >= 0 ? reconciled[incomingActiveIndex] : undefined;
		activeFileId = active && typeof active === "object" && !Array.isArray(active) && typeof (active as Record<string, unknown>).fileId === "string"
			? (active as Record<string, unknown>).fileId as string
			: undefined;
	}
	return { ...root, review: { ...review, files: reconciled, ...(activeFileId ? { activeFileId } : {}) } };
}

export async function handleReviewPayloadRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: ReviewPayloadRouteDeps,
): Promise<boolean> {
	const collection = url.pathname.match(/^\/api\/sessions\/([^/]+)\/review-payloads$/);
	if (collection && req.method === "POST") {
		const sessionId = decodePart(collection[1]);
		if (!sessionId) { writeError(res, new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid session identity")); return true; }
		try {
			if (!hasSession(deps, sessionId)) throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
			requireOwningSessionSecret(req, deps, sessionId);
			const result = await readLimitedReviewJson(req, MAX_REVIEW_PAYLOAD_REQUEST_BYTES);
			if (!result.ok && result.tooLarge) {
				// Do not wait for a terminal chunk from an attacker. Pause immediately,
				// flush the structured response, then close the unread connection.
				res.setHeader("Connection", "close");
				res.once("finish", () => { try { req.destroy(); } catch { /* best-effort */ } });
				writeError(res, new ReviewPayloadError(413, "REVIEW_PAYLOAD_TOO_LARGE", "Review upload exceeds the bounded request limit"));
				return true;
			}
			if (!result.ok) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review payload");
			const identity = uploadReviewIdentity(result.body);
			const receipt = await deps.operations.run(sessionId, async () => {
				if (!hasSession(deps, sessionId)) throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
				const existing = identity && deps.resolveExistingReview
					? await deps.resolveExistingReview(sessionId, identity.title, identity.reviewId, identity.replace)
					: undefined;
				const reconciledBody = reconcileReplacementFiles(result.body, existing?.payload, existing?.activeFileId);
				// Replacement lookup can perform artifact I/O. Recheck immediately before
				// admitting durable bytes so a queued purge cannot be raced.
				if (!hasSession(deps, sessionId)) throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
				const payload = await persistReviewPayload(sessionId, reconciledBody, existing?.reviewId, { enforceSessionQuota: true });
				let automaticOpen: ReviewPayloadOpenOutcome;
				try {
					if (!hasSession(deps, sessionId)) throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
					await deps.openReview(payload);
					automaticOpen = { ok: true, status: "opened" };
				} catch (error) {
					automaticOpen = openFailure(error);
				}
				return reviewPayloadReceipt(payload, automaticOpen);
			});
			json(res, 201, receipt);
		} catch (error) {
			writeError(res, error);
		}
		return true;
	}

	const item = url.pathname.match(/^\/api\/sessions\/([^/]+)\/review-payloads\/([^/]+)$/);
	if (item && req.method === "GET") {
		const sessionId = decodePart(item[1]);
		const payloadId = decodePart(item[2]);
		if (!sessionId || !payloadId) { writeError(res, new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review content reference")); return true; }
		try {
			if (!hasSession(deps, sessionId)) throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
			const reference = {
				toolCallId: url.searchParams.get("toolCallId"),
				reviewId: url.searchParams.get("reviewId"),
				hash: url.searchParams.get("hash"),
			};
			if (!reference.toolCallId || !reference.reviewId || !reference.hash) {
				throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Complete review reference is required");
			}
			const payload = await readReviewPayload(sessionId, payloadId);
			assertReviewPayloadReference(payload, reference);
			json(res, 200, payload);
		} catch (error) {
			writeError(res, error);
		}
		return true;
	}

	const open = url.pathname.match(/^\/api\/sessions\/([^/]+)\/review-payloads\/([^/]+)\/open$/);
	if (open && req.method === "POST") {
		const sessionId = decodePart(open[1]);
		const payloadId = decodePart(open[2]);
		if (!sessionId || !payloadId) { writeError(res, new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review content reference")); return true; }
		try {
			if (!hasSession(deps, sessionId)) throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
			const body = await deps.readBody(req);
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review open request");
			const reference = body as Record<string, unknown>;
			if (typeof reference.payloadId !== "string" || !reference.payloadId) {
				throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Complete review reference is required");
			}
			if (reference.payloadId !== payloadId) {
				throw new ReviewPayloadError(409, "REVIEW_PAYLOAD_REFERENCE_MISMATCH", "Review content reference does not match");
			}
			if (typeof reference.toolCallId !== "string" || !reference.toolCallId
				|| typeof reference.reviewId !== "string" || !reference.reviewId
				|| typeof reference.hash !== "string" || !reference.hash) {
				throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Complete review reference is required");
			}
			const opened = await deps.operations.run(sessionId, async () => {
				if (!hasSession(deps, sessionId)) throw new ReviewPayloadError(404, "REVIEW_PAYLOAD_SESSION_UNAVAILABLE", "Review session is unavailable");
				const payload = await readReviewPayload(sessionId, payloadId);
				assertReviewPayloadReference(payload, { toolCallId: reference.toolCallId, reviewId: reference.reviewId, hash: reference.hash });
				const workspace = await deps.openReview(payload);
				return { payload, workspace };
			});
			json(res, 200, { ok: true, status: "opened", reviewId: opened.payload.reviewId, payloadId: opened.payload.payloadId, workspace: opened.workspace });
		} catch (error) {
			writeError(res, error);
		}
		return true;
	}

	return false;
}
