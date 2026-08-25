import type http from "node:http";
import type { SessionManager } from "./agent/session-manager.js";
import {
	listUploadedAttachments,
	readUploadedAttachmentRange,
	UploadedAttachmentStoreError,
} from "./agent/uploaded-attachment-store.js";

export const UPLOADED_ATTACHMENT_TOOL_NAME = "session_attachment";
const ROUTE = /^\/api\/sessions\/([^/]+)\/uploaded-attachments\/query$/;

interface RouteDependencies {
	sessionManager: SessionManager;
	readBody: (req: http.IncomingMessage, maxBytes?: number) => Promise<unknown>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function decodePart(value: string): string | null {
	try { return decodeURIComponent(value); } catch { return null; }
}

function writeError(res: http.ServerResponse, error: unknown): void {
	if (error instanceof UploadedAttachmentStoreError) {
		json(res, error.statusCode, { error: error.message, code: error.code, retryable: error.retryable });
		return;
	}
	json(res, 500, { error: "Uploaded attachment request failed", code: "UPLOADED_ATTACHMENT_READ_FAILED", retryable: true });
}

/**
 * Session-secret authenticated read-only route used by the first-party
 * `session_attachment` extension. The URL owner and capability owner must be
 * identical; the public session-id header alone never grants access.
 */
export async function handleUploadedAttachmentToolRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: RouteDependencies,
): Promise<boolean> {
	const match = ROUTE.exec(url.pathname);
	if (!match || req.method !== "POST") return false;
	const sessionId = decodePart(match[1]);
	if (!sessionId) {
		json(res, 400, { error: "Invalid session identity", code: "UPLOADED_ATTACHMENT_INVALID", retryable: false });
		return true;
	}

	const rawSecret = req.headers["x-bobbit-session-secret"];
	const secret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;
	const authenticatedSessionId = deps.sessionManager.sessionSecretStore.resolveSessionIdBySecret(
		typeof secret === "string" && secret.trim() ? secret.trim() : undefined,
	);
	const liveSession = deps.sessionManager.getSession(sessionId);
	if (authenticatedSessionId !== sessionId || !liveSession) {
		json(res, 403, { error: "Uploaded attachment access is forbidden", code: "UPLOADED_ATTACHMENT_FORBIDDEN", retryable: false });
		return true;
	}
	if (liveSession.allowedTools !== undefined
		&& !liveSession.allowedTools.some((tool) => tool.toLowerCase() === UPLOADED_ATTACHMENT_TOOL_NAME)) {
		json(res, 403, { error: "Uploaded attachment tool is not allowed for this session", code: "UPLOADED_ATTACHMENT_FORBIDDEN", retryable: false });
		return true;
	}

	try {
		const body = await deps.readBody(req, 16 * 1024);
		if (!isPlainObject(body)) throw new UploadedAttachmentStoreError(400, "UPLOADED_ATTACHMENT_INVALID", "Invalid uploaded attachment request");
		const operation = body.operation;
		const pointer = body.pointer;
		if (typeof pointer !== "string") throw new UploadedAttachmentStoreError(400, "UPLOADED_ATTACHMENT_INVALID", "Attachment pointer is required");
		if (operation === "list") {
			if (Object.keys(body).some((key) => key !== "operation" && key !== "pointer")) {
				throw new UploadedAttachmentStoreError(400, "UPLOADED_ATTACHMENT_INVALID", "Invalid attachment list request fields");
			}
			const attachments = await listUploadedAttachments(sessionId, pointer);
			json(res, 200, { operation: "list", attachments });
			return true;
		}
		if (operation === "read") {
			if (Object.keys(body).some((key) => !new Set(["operation", "pointer", "offset", "length"]).has(key))) {
				throw new UploadedAttachmentStoreError(400, "UPLOADED_ATTACHMENT_INVALID", "Invalid attachment read request fields");
			}
			const range = await readUploadedAttachmentRange({
				sessionId,
				pointer,
				offset: body.offset as number | undefined,
				length: body.length as number | undefined,
			});
			json(res, 200, { operation: "read", ...range });
			return true;
		}
		throw new UploadedAttachmentStoreError(400, "UPLOADED_ATTACHMENT_INVALID", "Attachment operation must be 'list' or 'read'");
	} catch (error) {
		writeError(res, error);
		return true;
	}
}
