import { gatewayFetch } from "./gateway-fetch.js";
import { loadReviewSources } from "./review-sources-lazy.js";
import { applySidePanelWorkspaceFromServer, hydrateSidePanelWorkspace } from "./side-panel-workspace.js";
import { renderApp } from "./state.js";
import { isReviewArtifactIdentity, isReviewArtifactPayloadId, reviewArtifactTabId } from "../shared/review-artifact-identity.js";

export const REVIEW_PAYLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const REVIEW_PAYLOAD_MAX_FILES = 64;
export const REVIEW_PAYLOAD_MAX_TITLE_BYTES = 320;

export interface ReviewOpenReceiptFile {
	fileId: string;
	title: string;
	bytes: number;
}

export interface ReviewOpenReceipt {
	action: "review_open";
	version: 2;
	toolCallId: string;
	payloadId: string;
	reviewId: string;
	title: string;
	contentHash: string;
	totalBytes: number;
	files: ReviewOpenReceiptFile[];
	activeFileId: string;
	replace: boolean;
	open?: Record<string, unknown>;
}

export interface CanonicalReviewPayload {
	reviewId: string;
	title: string;
	files: Array<{ fileId: string; title: string; markdown: string }>;
	activeFileId: string;
	replace: boolean;
	contentHash: string;
	totalBytes: number;
}

export type ReviewOpenErrorCode =
	| "REVIEW_PAYLOAD_UNAVAILABLE"
	| "REVIEW_REFERENCE_INVALID"
	| "REVIEW_PAYLOAD_TOO_LARGE"
	| "REVIEW_PAYLOAD_QUOTA_EXCEEDED"
	| "REVIEW_UNAUTHORIZED"
	| "REVIEW_PERSISTENCE_FAILED"
	| "REVIEW_WORKSPACE_CONFLICT"
	| "REVIEW_SESSION_UNAVAILABLE"
	| "REVIEW_CLIENT_OPEN_FAILED";

export type ReviewOpenState =
	| { phase: "available"; receipt: ReviewOpenReceipt }
	| { phase: "pending"; receipt: ReviewOpenReceipt }
	| { phase: "success"; receipt: ReviewOpenReceipt; openedAt: number }
	| { phase: "error" | "unavailable"; receipt?: ReviewOpenReceipt; code: ReviewOpenErrorCode; retryable: boolean; message: string };

export type ReviewOpenIntent = "automatic" | "manual";

export interface ReviewOpenRequest {
	sessionId: string;
	toolUseId: string;
	receipt: ReviewOpenReceipt;
	intent: ReviewOpenIntent;
}

interface ArtifactReviewReference {
	sessionId: string;
	reviewId: string;
	title: string;
	toolCallId: string;
	payloadId: string;
	contentHash: string;
	activeFileId: string;
}

interface ArtifactReviewSources {
	getArtifactReviewWorkspaceReferences(sessionId: string): ArtifactReviewReference[];
	commitArtifactReviewGroup(reference: ArtifactReviewReference, rawCanonicalGroup: unknown): unknown;
}

type ReviewOpenSubscriber = (state: ReviewOpenState, key: string) => void;

const states = new Map<string, ReviewOpenState>();
const inFlight = new Map<string, Promise<ReviewOpenState>>();
const subscribers = new Set<ReviewOpenSubscriber>();

const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedIdentity(value: unknown, maxBytes: number): string {
	if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) return "";
	return new TextEncoder().encode(value).byteLength <= maxBytes ? value : "";
}

function boundedTitle(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return "";
	return new TextEncoder().encode(value).byteLength <= REVIEW_PAYLOAD_MAX_TITLE_BYTES ? value : "";
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function receiptFingerprint(receipt: ReviewOpenReceipt): string {
	return JSON.stringify(receipt);
}

export function reviewOpenKey(sessionId: string, toolUseId: string, payloadId: string): string {
	return JSON.stringify([sessionId, toolUseId, payloadId]);
}

/** Central route contract shared by automatic opens and renderer retries. */
export function reviewPayloadRoute(
	sessionId: string,
	payloadId: string,
	toolCallId: string,
	reviewId?: string,
	contentHash?: string,
): string {
	const params = new URLSearchParams({ toolCallId });
	if (reviewId) params.set("reviewId", reviewId);
	if (contentHash) params.set("hash", contentHash);
	return `/api/sessions/${encodeURIComponent(sessionId)}/review-payloads/${encodeURIComponent(payloadId)}?${params}`;
}

/** Reference-only mutation used by an explicit renderer retry/reopen. */
export function reviewPayloadOpenRoute(sessionId: string, payloadId: string, toolCallId: string): string {
	return `/api/sessions/${encodeURIComponent(sessionId)}/review-payloads/${encodeURIComponent(payloadId)}/open?toolCallId=${encodeURIComponent(toolCallId)}`;
}

export function parseReviewOpenReceipt(value: unknown, expectedToolUseId?: string): ReviewOpenReceipt | null {
	const raw = asRecord(value);
	if (!raw || raw.action !== "review_open" || raw.version !== 2) return null;
	const toolCallId = isReviewArtifactIdentity(raw.toolCallId, "toolCallId") ? raw.toolCallId : "";
	const payloadId = isReviewArtifactPayloadId(raw.payloadId) ? raw.payloadId : "";
	const reviewId = isReviewArtifactIdentity(raw.reviewId, "reviewId") ? raw.reviewId : "";
	const title = boundedTitle(raw.title);
	const contentHashValue = raw.contentHash ?? raw.hash;
	const contentHash = typeof contentHashValue === "string" ? contentHashValue.trim().toLowerCase() : "";
	const totalBytes = nonNegativeInteger(raw.totalBytes);
	const activeFileId = isReviewArtifactIdentity(raw.activeFileId, "fileId") ? raw.activeFileId : "";
	if (!toolCallId || (expectedToolUseId && toolCallId !== expectedToolUseId) || !payloadId || !reviewId || !title
		|| !CONTENT_HASH_RE.test(contentHash) || totalBytes === undefined || totalBytes > REVIEW_PAYLOAD_MAX_BYTES || !activeFileId) return null;
	if (!Array.isArray(raw.files) || raw.files.length < 1 || raw.files.length > REVIEW_PAYLOAD_MAX_FILES) return null;
	const seen = new Set<string>();
	const files: ReviewOpenReceiptFile[] = [];
	let declaredTotal = 0;
	for (const item of raw.files) {
		const file = asRecord(item);
		if (!file || "markdown" in file || "content" in file) return null;
		const fileId = isReviewArtifactIdentity(file.fileId, "fileId") ? file.fileId : "";
		const fileTitle = boundedTitle(file.title);
		const bytes = nonNegativeInteger(file.bytes ?? file.markdownBytes);
		if (!fileId || seen.has(fileId) || !fileTitle || bytes === undefined || bytes > REVIEW_PAYLOAD_MAX_BYTES) return null;
		seen.add(fileId);
		declaredTotal += bytes;
		if (!Number.isSafeInteger(declaredTotal) || declaredTotal > REVIEW_PAYLOAD_MAX_BYTES) return null;
		files.push({ fileId, title: fileTitle, bytes });
	}
	if (declaredTotal !== totalBytes || !seen.has(activeFileId)) return null;
	const open = asRecord(raw.automaticOpen ?? raw.openOutcome ?? raw.open) ?? undefined;
	return {
		action: "review_open",
		version: 2,
		toolCallId,
		payloadId,
		reviewId,
		title,
		contentHash,
		totalBytes,
		files,
		activeFileId,
		replace: raw.replace !== false,
		...(open ? { open } : {}),
	};
}

/**
 * Read exactly one v2 receipt from its own typed tool-result envelope. This is
 * pure: transcript render/hydration can call it without opening a workspace.
 */
export function reviewOpenReceiptFromToolResult(result: unknown, expectedToolUseId: string): ReviewOpenReceipt | null {
	const envelope = asRecord(result);
	if (!envelope) return null;
	const typed = envelope.role === "toolResult" || envelope.role === "tool_result"
		|| envelope.type === "toolResult" || envelope.type === "tool_result";
	if (!typed || (envelope.toolName !== undefined && envelope.toolName !== "review_open")) return null;
	const envelopeIdentity = envelope.toolCallId ?? envelope.tool_use_id;
	const envelopeId = isReviewArtifactIdentity(envelopeIdentity, "toolCallId") ? envelopeIdentity : "";
	if (!envelopeId || envelopeId !== expectedToolUseId) return null;
	const candidates: ReviewOpenReceipt[] = [];
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			try {
				const parsed = JSON.parse(value.trim());
				const receipt = parseReviewOpenReceipt(parsed, expectedToolUseId);
				if (receipt) candidates.push(receipt);
			} catch { /* ordinary text */ }
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = asRecord(value);
		if (!record) return;
		const direct = parseReviewOpenReceipt(record, expectedToolUseId);
		if (direct) candidates.push(direct);
		else if (record.type === "text") visit(record.text);
	};
	visit(envelope.content);
	visit(envelope.output);
	visit(envelope.result);
	return candidates.length === 1 ? candidates[0] : null;
}

function stateMessage(code: ReviewOpenErrorCode): string {
	switch (code) {
		case "REVIEW_PAYLOAD_UNAVAILABLE": return "This review is no longer available.";
		case "REVIEW_REFERENCE_INVALID": return "The review reference is invalid. Run the review tool again.";
		case "REVIEW_PAYLOAD_TOO_LARGE": return "This review exceeds the 10 MiB limit.";
		case "REVIEW_PAYLOAD_QUOTA_EXCEEDED": return "Review content storage is full for this session.";
		case "REVIEW_UNAUTHORIZED": return "This review is unavailable for this session.";
		case "REVIEW_PERSISTENCE_FAILED": return "The review could not be saved. Retry opening it.";
		case "REVIEW_WORKSPACE_CONFLICT": return "The review workspace changed. Retry opening it.";
		case "REVIEW_SESSION_UNAVAILABLE": return "The review session is unavailable. Retry after reconnecting.";
		case "REVIEW_CLIENT_OPEN_FAILED": return "The review was saved but could not be shown. Retry opening it.";
	}
}

function failure(code: ReviewOpenErrorCode, receipt?: ReviewOpenReceipt): ReviewOpenState {
	const retryable = code === "REVIEW_PERSISTENCE_FAILED"
		|| code === "REVIEW_WORKSPACE_CONFLICT"
		|| code === "REVIEW_SESSION_UNAVAILABLE"
		|| code === "REVIEW_CLIENT_OPEN_FAILED";
	return { phase: retryable ? "error" : "unavailable", receipt, code, retryable, message: stateMessage(code) };
}

function setState(key: string, next: ReviewOpenState): ReviewOpenState {
	states.delete(key);
	states.set(key, next);
	while (states.size > 256) states.delete(states.keys().next().value as string);
	for (const subscriber of subscribers) {
		try { subscriber(next, key); } catch { /* one renderer cannot break coordination */ }
	}
	try {
		if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("bobbit-review-open-state", { detail: { key, state: next } }));
	} catch { /* non-DOM/test environment */ }
	// Pending and automatic outcomes arrive after the tool card's original render.
	// Route them through the app's coalesced repaint boundary so both automatic
	// opens and renderer clicks expose their latest exact-correlated state.
	renderApp();
	return next;
}

export function subscribeReviewOpenStates(subscriber: ReviewOpenSubscriber): () => void {
	subscribers.add(subscriber);
	return () => subscribers.delete(subscriber);
}

/** Registering a receipt is passive and never mutates review or workspace state. */
export function registerReviewOpenReceipt(sessionId: string, toolUseId: string, value: unknown): ReviewOpenState {
	const receipt = parseReviewOpenReceipt(value, toolUseId);
	if (!boundedIdentity(sessionId, 200) || !receipt) return failure("REVIEW_REFERENCE_INVALID");
	const key = reviewOpenKey(sessionId, toolUseId, receipt.payloadId);
	const existing = states.get(key);
	if (existing?.receipt && receiptFingerprint(existing.receipt) === receiptFingerprint(receipt)) return existing;
	return setState(key, { phase: "available", receipt });
}

export function getReviewOpenState(sessionId: string, toolUseId: string, payloadId: string): ReviewOpenState | undefined {
	return states.get(reviewOpenKey(sessionId, toolUseId, payloadId));
}

function validateCanonicalPayload(value: unknown, receipt: ReviewOpenReceipt, sessionId: string): CanonicalReviewPayload | null {
	const outer = asRecord(value);
	if (!outer || outer.sessionId !== sessionId || outer.toolCallId !== receipt.toolCallId || outer.payloadId !== receipt.payloadId) return null;
	const container = asRecord(outer.payload) ?? outer;
	const group = asRecord(container.group) ?? asRecord(container.review) ?? container;
	const contentHashValue = group.contentHash ?? group.hash ?? container.contentHash ?? container.hash ?? outer.contentHash ?? outer.hash;
	const contentHash = typeof contentHashValue === "string" ? contentHashValue.trim().toLowerCase() : "";
	if (group.reviewId !== receipt.reviewId || group.title !== receipt.title || contentHash !== receipt.contentHash
		|| !Array.isArray(group.files) || group.files.length !== receipt.files.length || group.activeFileId !== receipt.activeFileId
		|| (group.replace !== undefined && (group.replace !== false) !== receipt.replace)) return null;
	let totalBytes = 0;
	const files: CanonicalReviewPayload["files"] = [];
	for (let index = 0; index < group.files.length; index++) {
		const file = asRecord(group.files[index]);
		const expected = receipt.files[index];
		if (!file || file.fileId !== expected.fileId || file.title !== expected.title || typeof file.markdown !== "string") return null;
		const bytes = new TextEncoder().encode(file.markdown).byteLength;
		if (bytes !== expected.bytes) return null;
		totalBytes += bytes;
		if (totalBytes > REVIEW_PAYLOAD_MAX_BYTES) return null;
		files.push({ fileId: expected.fileId, title: expected.title, markdown: file.markdown });
	}
	if (totalBytes !== receipt.totalBytes) return null;
	return { reviewId: receipt.reviewId, title: receipt.title, files, activeFileId: receipt.activeFileId, replace: receipt.replace, contentHash, totalBytes };
}

function workspaceFromOpenResponse(value: unknown): unknown {
	const raw = asRecord(value);
	return raw?.workspace;
}

function validateWorkspace(value: unknown, request: ReviewOpenRequest): boolean {
	const workspace = asRecord(value);
	if (!workspace || workspace.sessionId !== request.sessionId || !Array.isArray(workspace.tabs)) return false;
	const expectedId = reviewArtifactTabId(request.receipt.reviewId);
	if (!expectedId) return false;
	const tab = workspace.tabs.find((candidate) => asRecord(candidate)?.id === expectedId);
	const record = asRecord(tab);
	const source = asRecord(record?.source);
	const tabState = asRecord(record?.state);
	return !!record && record.kind === "review" && source?.type === "review"
		&& source.sessionId === request.sessionId
		&& source.reviewId === request.receipt.reviewId
		&& source.toolCallId === request.toolUseId
		&& source.payloadId === request.receipt.payloadId
		&& (source.contentHash === request.receipt.contentHash || source.hash === request.receipt.contentHash)
		&& typeof tabState?.activeFileId === "string"
		&& request.receipt.files.some((file) => file.fileId === tabState.activeFileId);
}

function allowlistedServerCode(value: unknown, status: number): ReviewOpenErrorCode {
	const raw = asRecord(value);
	const outcome = asRecord(raw?.outcome) ?? raw;
	const code = outcome?.code;
	if (code === "REVIEW_PAYLOAD_UNAVAILABLE" || code === "REVIEW_REFERENCE_INVALID" || code === "REVIEW_PAYLOAD_TOO_LARGE"
		|| code === "REVIEW_PAYLOAD_QUOTA_EXCEEDED" || code === "REVIEW_UNAUTHORIZED" || code === "REVIEW_PERSISTENCE_FAILED" || code === "REVIEW_WORKSPACE_CONFLICT"
		|| code === "REVIEW_SESSION_UNAVAILABLE" || code === "REVIEW_CLIENT_OPEN_FAILED") return code;
	if (code === "REVIEW_PAYLOAD_SESSION_UNAVAILABLE") return "REVIEW_SESSION_UNAVAILABLE";
	if (code === "REVIEW_PAYLOAD_NOT_FOUND") return "REVIEW_PAYLOAD_UNAVAILABLE";
	if (code === "REVIEW_PAYLOAD_INVALID" || code === "REVIEW_PAYLOAD_INVALID_REFERENCE"
		|| code === "REVIEW_PAYLOAD_REFERENCE_MISMATCH" || code === "REVIEW_PAYLOAD_RESPONSE_INVALID") return "REVIEW_REFERENCE_INVALID";
	if (code === "REVIEW_PAYLOAD_PERSISTENCE_FAILED" || code === "REVIEW_PAYLOAD_READ_FAILED"
		|| code === "REVIEW_PAYLOAD_INTERNAL_ERROR") return "REVIEW_PERSISTENCE_FAILED";
	if (code === "REVIEW_PAYLOAD_WORKSPACE_CONFLICT") return "REVIEW_WORKSPACE_CONFLICT";
	if (code === "REVIEW_PAYLOAD_UPLOAD_FORBIDDEN") return "REVIEW_UNAUTHORIZED";
	if (code === "REVIEW_PAYLOAD_GATEWAY_UNAVAILABLE") return "REVIEW_SESSION_UNAVAILABLE";
	if (code === "REVIEW_OPEN_FAILED") return "REVIEW_CLIENT_OPEN_FAILED";
	if (status === 401 || status === 403) return "REVIEW_UNAUTHORIZED";
	if (status === 404 || status === 410) return "REVIEW_PAYLOAD_UNAVAILABLE";
	if (status === 409 || status === 412) return "REVIEW_WORKSPACE_CONFLICT";
	if (status === 413) return "REVIEW_PAYLOAD_TOO_LARGE";
	if (status >= 500) return "REVIEW_PERSISTENCE_FAILED";
	return "REVIEW_REFERENCE_INVALID";
}

function openReferenceBody(receipt: ReviewOpenReceipt): Record<string, unknown> {
	return {
		toolCallId: receipt.toolCallId,
		payloadId: receipt.payloadId,
		reviewId: receipt.reviewId,
		hash: receipt.contentHash,
	};
}

async function artifactReviewSources(): Promise<ArtifactReviewSources> {
	const sources = await loadReviewSources() as unknown as Partial<ArtifactReviewSources>;
	if (typeof sources.getArtifactReviewWorkspaceReferences !== "function"
		|| typeof sources.commitArtifactReviewGroup !== "function") {
		throw new Error("Artifact review hydration is unavailable");
	}
	return sources as ArtifactReviewSources;
}

function exactWorkspaceReference(
	references: ArtifactReviewReference[],
	request: ReviewOpenRequest,
): ArtifactReviewReference | undefined {
	return references.find((reference) => reference.sessionId === request.sessionId
		&& reference.reviewId === request.receipt.reviewId
		&& reference.title === request.receipt.title
		&& reference.toolCallId === request.toolUseId
		&& reference.payloadId === request.receipt.payloadId
		&& reference.contentHash === request.receipt.contentHash
		&& request.receipt.files.some((file) => file.fileId === reference.activeFileId));
}

export async function openReviewReceipt(request: ReviewOpenRequest): Promise<ReviewOpenState> {
	const receipt = parseReviewOpenReceipt(request.receipt, request.toolUseId);
	if (!boundedIdentity(request.sessionId, 200) || !receipt) return failure("REVIEW_REFERENCE_INVALID", request.receipt);
	const normalizedRequest = { ...request, receipt };
	const key = reviewOpenKey(request.sessionId, request.toolUseId, receipt.payloadId);
	const existing = inFlight.get(key);
	if (existing) return existing;
	setState(key, { phase: "pending", receipt });
	const operation = (async (): Promise<ReviewOpenState> => {
		try {
			let workspace: unknown;
			if (request.intent === "automatic") {
				// Upload already performed the authoritative open. A delayed receipt must
				// never repeat that mutation: doing so could recreate a review after the
				// user closed or submitted it. Honor the upload outcome, then read the
				// latest workspace before loading any potentially large content.
				const automaticOpen = receipt.open;
				const automaticFailed = automaticOpen?.ok === false
					|| automaticOpen?.status === "failed"
					|| automaticOpen?.status === "error";
				const automaticSucceeded = !automaticFailed
					&& (automaticOpen?.ok === true || automaticOpen?.status === "opened");
				if (!automaticSucceeded) {
					const code = automaticFailed
						? allowlistedServerCode(automaticOpen, 0)
						: "REVIEW_REFERENCE_INVALID";
					return setState(key, failure(code, receipt));
				}
				workspace = await hydrateSidePanelWorkspace(request.sessionId, { throwOnError: true });
				if (!validateWorkspace(workspace, normalizedRequest)) {
					// Authoritative absence is not an open failure. Keep the exact receipt as
					// the explicit recovery path without recreating a tab or clearing its
					// replay tombstone.
					return setState(key, { phase: "available", receipt });
				}
			}

			const payloadResponse = await gatewayFetch(reviewPayloadRoute(
				request.sessionId,
				receipt.payloadId,
				request.toolUseId,
				receipt.reviewId,
				receipt.contentHash,
			));
			let payloadBody: unknown;
			try { payloadBody = await payloadResponse.json(); } catch { payloadBody = undefined; }
			if (!payloadResponse.ok) return setState(key, failure(allowlistedServerCode(payloadBody, payloadResponse.status), receipt));
			if (!validateCanonicalPayload(payloadBody, receipt, request.sessionId)) {
				return setState(key, failure("REVIEW_REFERENCE_INVALID", receipt));
			}

			if (request.intent === "manual") {
				const openResponse = await gatewayFetch(reviewPayloadOpenRoute(request.sessionId, receipt.payloadId, request.toolUseId), {
					method: "POST",
					body: JSON.stringify(openReferenceBody(receipt)),
				});
				let openBody: unknown;
				try { openBody = await openResponse.json(); } catch { openBody = undefined; }
				if (!openResponse.ok) return setState(key, failure(allowlistedServerCode(openBody, openResponse.status), receipt));
				const openRecord = asRecord(openBody);
				const openOutcome = asRecord(openRecord?.outcome);
				if (openRecord?.ok === false || openOutcome?.ok === false || openOutcome?.status === "failed" || openOutcome?.status === "error") {
					return setState(key, failure(allowlistedServerCode(openBody, openResponse.status), receipt));
				}
				// Older gateways may acknowledge the atomic open without echoing the
				// workspace. Read it back rather than constructing a client tab from the
				// receipt.
				workspace = workspaceFromOpenResponse(openBody)
					?? await hydrateSidePanelWorkspace(request.sessionId);
				if (!validateWorkspace(workspace, normalizedRequest)) return setState(key, failure("REVIEW_CLIENT_OPEN_FAILED", receipt));
				// Manual open has durably committed this authoritative workspace. Apply
				// it before artifact hydration so content requires the exact tab tuple.
				applySidePanelWorkspaceFromServer(workspace, { source: "rest" });
			}

			const reviewSources = await artifactReviewSources();
			const reference = exactWorkspaceReference(
				reviewSources.getArtifactReviewWorkspaceReferences(request.sessionId),
				normalizedRequest,
			);
			if (!reference) {
				return request.intent === "automatic"
					? setState(key, { phase: "available", receipt })
					: setState(key, failure("REVIEW_CLIENT_OPEN_FAILED", receipt));
			}
			reviewSources.commitArtifactReviewGroup(reference, payloadBody);
			return setState(key, { phase: "success", receipt, openedAt: Date.now() });
		} catch {
			return setState(key, failure("REVIEW_CLIENT_OPEN_FAILED", receipt));
		} finally {
			inFlight.delete(key);
		}
	})();
	inFlight.set(key, operation);
	return operation;
}

function receiptFromCanonicalPayload(value: unknown, reference: ArtifactReviewReference): ReviewOpenReceipt | null {
	const raw = asRecord(value);
	if (!raw || !Array.isArray(raw.files)) return null;
	return parseReviewOpenReceipt({
		action: raw.action,
		version: raw.version,
		toolCallId: raw.toolCallId,
		payloadId: raw.payloadId,
		reviewId: raw.reviewId,
		title: raw.title,
		contentHash: raw.contentHash ?? raw.hash,
		totalBytes: raw.totalBytes,
		files: raw.files.map((item) => {
			const file = asRecord(item);
			return file ? { fileId: file.fileId, title: file.title, bytes: file.bytes ?? file.markdownBytes } : item;
		}),
		activeFileId: raw.activeFileId,
		replace: raw.replace,
	}, reference.toolCallId);
}

/**
 * Hydrate only payloads named by complete authoritative workspace tabs. This is
 * deliberately GET-only: reload/reconnect may restore content for an existing
 * tab, but can never create a tab, focus a session, or clear a tombstone.
 */
export async function hydrateArtifactReviewsForWorkspace(sessionId: string): Promise<void> {
	if (!boundedIdentity(sessionId, 200)) return;
	let reviewSources: ArtifactReviewSources;
	try { reviewSources = await artifactReviewSources(); }
	catch { return; }
	const initialReferences = reviewSources.getArtifactReviewWorkspaceReferences(sessionId);
	for (const initial of initialReferences) {
		const key = reviewOpenKey(sessionId, initial.toolCallId, initial.payloadId);
		try {
			const response = await gatewayFetch(reviewPayloadRoute(
				sessionId,
				initial.payloadId,
				initial.toolCallId,
				initial.reviewId,
				initial.contentHash,
			));
			let raw: unknown;
			try { raw = await response.json(); } catch { raw = undefined; }
			if (!response.ok) {
				setState(key, failure(allowlistedServerCode(raw, response.status)));
				continue;
			}
			const receipt = receiptFromCanonicalPayload(raw, initial);
			if (!receipt || receipt.reviewId !== initial.reviewId || receipt.title !== initial.title
				|| receipt.payloadId !== initial.payloadId || receipt.contentHash !== initial.contentHash
				|| !validateCanonicalPayload(raw, receipt, sessionId)) {
				setState(key, failure("REVIEW_REFERENCE_INVALID"));
				continue;
			}
			const request: ReviewOpenRequest = {
				sessionId,
				toolUseId: initial.toolCallId,
				receipt,
				intent: "automatic",
			};
			// File selection can legitimately advance while the GET is pending. Re-read
			// the authoritative tab and accept its active file only when it still belongs
			// to this exact fetched payload.
			const current = exactWorkspaceReference(
				reviewSources.getArtifactReviewWorkspaceReferences(sessionId),
				request,
			);
			if (!current) {
				setState(key, failure("REVIEW_CLIENT_OPEN_FAILED", receipt));
				continue;
			}
			reviewSources.commitArtifactReviewGroup(current, raw);
			setState(key, { phase: "success", receipt, openedAt: Date.now() });
		} catch {
			setState(key, failure("REVIEW_CLIENT_OPEN_FAILED"));
		}
	}
}

/** Test-only reset for isolated DOM fixtures. */
export function resetReviewOpenCoordinatorForTests(): void {
	states.clear();
	inFlight.clear();
	subscribers.clear();
}
