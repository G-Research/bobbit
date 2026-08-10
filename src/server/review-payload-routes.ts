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

export interface ReviewPayloadRouteDeps {
	sessionManager: SessionManager;
	readBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<any>;
	openReview: (payload: CanonicalReviewPayload) => Promise<unknown>;
	resolveExistingReview?: (
		sessionId: string,
		title: string,
		incomingReviewId: string,
		replace: boolean,
	) => Promise<{ reviewId: string; payload?: CanonicalReviewPayload }>;
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

/** Review-specific JSON reader. Unlike the generic reader it reports chunked overflow as 413. */
async function readLimitedJson(req: http.IncomingMessage, maxBytes: number): Promise<LimitedBodyResult> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let tooLarge = false;
		let settled = false;
		const finish = (result: LimitedBodyResult): void => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		req.on("data", (chunk: Buffer | string) => {
			if (settled) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.byteLength;
			if (total > maxBytes) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			if (!tooLarge) chunks.push(bytes);
		});
		req.on("end", () => {
			if (tooLarge) { finish({ ok: false, tooLarge: true }); return; }
			try { finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
			catch { finish({ ok: false, tooLarge: false }); }
		});
		req.on("error", () => finish({ ok: false, tooLarge }));
		req.on("aborted", () => finish({ ok: false, tooLarge }));
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

function reconcileReplacementFiles(raw: unknown, existing: CanonicalReviewPayload | undefined): unknown {
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
	let activeFileId = retainedIds.has(existing.activeFileId) ? existing.activeFileId : undefined;
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
			const result = await readLimitedJson(req, MAX_REVIEW_PAYLOAD_REQUEST_BYTES);
			if (!result.ok) {
				throw result.tooLarge
					? new ReviewPayloadError(413, "REVIEW_PAYLOAD_TOO_LARGE", "Review upload exceeds the bounded request limit")
					: new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Invalid review payload");
			}
			const identity = uploadReviewIdentity(result.body);
			const existing = identity && deps.resolveExistingReview
				? await deps.resolveExistingReview(sessionId, identity.title, identity.reviewId, identity.replace)
				: undefined;
			const reconciledBody = reconcileReplacementFiles(result.body, existing?.payload);
			const payload = await persistReviewPayload(sessionId, reconciledBody, existing?.reviewId);
			let automaticOpen: ReviewPayloadOpenOutcome;
			try {
				await deps.openReview(payload);
				automaticOpen = { ok: true, status: "opened" };
			} catch (error) {
				automaticOpen = openFailure(error);
			}
			json(res, 201, reviewPayloadReceipt(payload, automaticOpen));
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
			const payload = await readReviewPayload(sessionId, payloadId);
			assertReviewPayloadReference(payload, {
				toolCallId: url.searchParams.get("toolCallId") ?? undefined,
				reviewId: url.searchParams.has("reviewId") ? url.searchParams.get("reviewId") : undefined,
				hash: url.searchParams.has("hash") ? url.searchParams.get("hash") : undefined,
			});
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
			if (reference.payloadId !== undefined && reference.payloadId !== payloadId) {
				throw new ReviewPayloadError(409, "REVIEW_PAYLOAD_REFERENCE_MISMATCH", "Review content reference does not match");
			}
			const payload = await readReviewPayload(sessionId, payloadId);
			assertReviewPayloadReference(payload, { toolCallId: reference.toolCallId, reviewId: reference.reviewId, hash: reference.hash });
			if (reference.reviewId === undefined || reference.hash === undefined) {
				throw new ReviewPayloadError(400, "REVIEW_PAYLOAD_INVALID", "Complete review reference is required");
			}
			const workspace = await deps.openReview(payload);
			json(res, 200, { ok: true, status: "opened", reviewId: payload.reviewId, payloadId: payload.payloadId, workspace });
		} catch (error) {
			writeError(res, error);
		}
		return true;
	}

	return false;
}
