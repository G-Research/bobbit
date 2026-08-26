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

function attachmentToolAllowed(session: { allowedTools?: string[] }): boolean {
	return session.allowedTools === undefined
		|| session.allowedTools.some((tool) => tool.toLowerCase() === UPLOADED_ATTACHMENT_TOOL_NAME);
}

function writeAuthorityUnavailable(res: http.ServerResponse, sandboxed: boolean): void {
	if (sandboxed) {
		json(res, 403, {
			error: "Uploaded attachment sandbox runtime is unavailable",
			code: "UPLOADED_ATTACHMENT_SANDBOX_UNAVAILABLE",
			retryable: false,
		});
		return;
	}
	json(res, 403, {
		error: "Uploaded attachment access is forbidden",
		code: "UPLOADED_ATTACHMENT_FORBIDDEN",
		retryable: false,
	});
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
	const normalizedSecret = typeof secret === "string" && secret.trim() ? secret.trim() : undefined;
	const authenticatedSessionId = deps.sessionManager.sessionSecretStore.resolveSessionIdBySecret(normalizedSecret);
	const liveSession = deps.sessionManager.getSession(sessionId);
	if (authenticatedSessionId !== sessionId || !liveSession) {
		json(res, 403, { error: "Uploaded attachment access is forbidden", code: "UPLOADED_ATTACHMENT_FORBIDDEN", retryable: false });
		return true;
	}

	// Capture only server-owned authority. Reads have asynchronous file/hash work,
	// so object identity alone is insufficient: respawn can replace its runtime on
	// the same SessionInfo object, while termination/replacement bumps lifecycle
	// state. This exact tuple is synchronously compared again immediately before
	// response bytes are emitted.
	const replacementAdmission = deps.sessionManager.getSessionReplacementAdmission(sessionId);
	const admittedAuthority = {
		session: liveSession,
		status: liveSession.status,
		statusVersion: liveSession.statusVersion,
		rpcClient: liveSession.rpcClient,
		sandboxed: liveSession.sandboxed,
		projectId: liveSession.projectId,
		containerId: liveSession.containerId,
		replacementGeneration: replacementAdmission.generation,
	};
	const authorityIsCurrent = (): boolean => {
		const currentSession = deps.sessionManager.getSession(sessionId);
		const currentReplacement = deps.sessionManager.getSessionReplacementAdmission(sessionId);
		return deps.sessionManager.sessionSecretStore.resolveSessionIdBySecret(normalizedSecret) === sessionId
			&& currentSession === admittedAuthority.session
			&& currentSession.status !== "terminated"
			&& currentSession.status === admittedAuthority.status
			&& currentSession.statusVersion === admittedAuthority.statusVersion
			&& currentSession.rpcClient === admittedAuthority.rpcClient
			&& currentSession.sandboxed === admittedAuthority.sandboxed
			&& currentSession.projectId === admittedAuthority.projectId
			&& currentSession.containerId === admittedAuthority.containerId
			&& currentReplacement.active === false
			&& currentReplacement.generation === admittedAuthority.replacementGeneration
			&& attachmentToolAllowed(currentSession);
	};
	if (liveSession.status === "terminated" || replacementAdmission.active || !attachmentToolAllowed(liveSession)) {
		writeAuthorityUnavailable(res, liveSession.sandboxed === true);
		return true;
	}

	// A session secret and transcript pointer can both be observed by code in a
	// sandbox. Before parsing caller-controlled input or consulting the store,
	// require the server-owned runtime registry and Docker Engine to attest the
	// exact live project/session/container tuple. Re-check the canonical session
	// after the async attestation so a replaced or terminated runtime cannot win a
	// time-of-check/time-of-use race. Direct agents have no container to attest.
	if (liveSession.sandboxed === true) {
		const projectId = typeof liveSession.projectId === "string" && liveSession.projectId.trim()
			? liveSession.projectId
			: undefined;
		const containerId = typeof liveSession.containerId === "string" && liveSession.containerId.trim()
			? liveSession.containerId
			: undefined;
		const sandboxManager = deps.sessionManager.getSandboxManager();
		let attested = false;
		if (projectId && containerId && sandboxManager) {
			try {
				attested = await sandboxManager.isSessionRuntimeIsolated(projectId, sessionId, containerId);
			} catch {
				attested = false;
			}
		}
		if (!attested || !authorityIsCurrent()) {
			writeAuthorityUnavailable(res, true);
			return true;
		}
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
			// No await may be introduced between this exact authority check and the
			// synchronous response write: the captured session owns this payload.
			if (!authorityIsCurrent()) {
				writeAuthorityUnavailable(res, admittedAuthority.sandboxed === true);
				return true;
			}
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
			// The store serializes reads with purge, but the session/runtime owner can
			// be revoked after store completion. Revalidate the exact admitted tuple
			// immediately before the synchronous byte response.
			if (!authorityIsCurrent()) {
				writeAuthorityUnavailable(res, admittedAuthority.sandboxed === true);
				return true;
			}
			json(res, 200, { operation: "read", ...range });
			return true;
		}
		throw new UploadedAttachmentStoreError(400, "UPLOADED_ATTACHMENT_INVALID", "Attachment operation must be 'list' or 'read'");
	} catch (error) {
		writeError(res, error);
		return true;
	}
}
