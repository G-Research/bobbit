import type http from "node:http";
import type { SessionManager } from "./agent/session-manager.js";
import type { PackContributionRegistry } from "./extension-host/pack-contribution-registry.js";
import type { SidePanelWorkspace } from "../shared/side-panel-workspace.js";
import { isSidePanelSizeMode } from "../shared/side-panel-workspace.js";
import {
	applyWorkspaceMutation,
	canonicalizeWorkspace,
	SidePanelWorkspaceError,
	SidePanelWorkspaceLocks,
	type SidePanelWorkspaceValidators,
} from "./side-panel-workspace.js";

const locks = new SidePanelWorkspaceLocks();

type ReadBody = (req: http.IncomingMessage, maxBytes?: number) => Promise<any>;

export interface SidePanelWorkspaceRouteDeps {
	sessionManager: SessionManager;
	readBody: ReadBody;
	broadcastToSession?: (sessionId: string, event: any) => void;
	packContributionRegistry?: PackContributionRegistry;
}

function writeJson(res: http.ServerResponse, data: unknown, status = 200): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, status: number, message: string, code = "SIDE_PANEL_WORKSPACE_ERROR", extra?: Record<string, unknown>): void {
	writeJson(res, { error: message, code, ...extra }, status);
}

function decodePathPart(value: string): string | null {
	try { return decodeURIComponent(value); } catch { return null; }
}

function revisionFromRequest(req: http.IncomingMessage, body: unknown): number | undefined {
	const header = req.headers["if-match"];
	const raw = Array.isArray(header) ? header[0] : header;
	const headerText = typeof raw === "string" ? raw.trim().replace(/^W\//, "").replace(/^"|"$/g, "") : "";
	const headerNumber = headerText ? Number(headerText) : NaN;
	if (Number.isInteger(headerNumber) && headerNumber >= 0) return headerNumber;
	const bodyRev = body && typeof body === "object" ? (body as Record<string, unknown>).baseRevision : undefined;
	return typeof bodyRev === "number" && Number.isInteger(bodyRev) && bodyRev >= 0 ? bodyRev : undefined;
}

function strictRevision(body: unknown): boolean {
	return !!(body && typeof body === "object" && (body as Record<string, unknown>).strictRevision === true);
}

function resolveSessionStore(deps: SidePanelWorkspaceRouteDeps, sessionId: string) {
	const persisted = deps.sessionManager.getPersistedSession(sessionId);
	if (!persisted) return null;
	try {
		return deps.sessionManager.getSessionStore(persisted.projectId);
	} catch {
		return null;
	}
}

function validatorsFor(deps: SidePanelWorkspaceRouteDeps, sessionId: string): SidePanelWorkspaceValidators {
	const persisted = deps.sessionManager.getPersistedSession(sessionId);
	const projectId = persisted?.projectId;
	return {
		isKnownPackPanel: deps.packContributionRegistry
			? (packId: string, panelId: string) => !!deps.packContributionRegistry?.getPanel(projectId, packId, panelId)
			: undefined,
	};
}

function currentWorkspace(deps: SidePanelWorkspaceRouteDeps, sessionId: string): { workspace: SidePanelWorkspace; store: ReturnType<typeof resolveSessionStore> } | null {
	const store = resolveSessionStore(deps, sessionId);
	if (!store) return null;
	const persisted = store.get(sessionId);
	if (!persisted) return null;
	return { workspace: canonicalizeWorkspace(persisted.sidePanelWorkspace, sessionId, validatorsFor(deps, sessionId)), store };
}

function persistAndBroadcast(deps: SidePanelWorkspaceRouteDeps, sessionId: string, before: SidePanelWorkspace, after: SidePanelWorkspace, store: NonNullable<ReturnType<typeof resolveSessionStore>>): void {
	store.update(sessionId, { sidePanelWorkspace: after });
	if (after.revision !== before.revision) {
		deps.broadcastToSession?.(sessionId, { type: "side_panel_workspace", sessionId, workspace: after });
	}
}

async function mutate(
	deps: SidePanelWorkspaceRouteDeps,
	sessionId: string,
	fn: (workspace: SidePanelWorkspace) => SidePanelWorkspace,
): Promise<{ status: 200; workspace: SidePanelWorkspace } | { status: 404; error: string }> {
	return locks.with(sessionId, async () => {
		const current = currentWorkspace(deps, sessionId);
		if (!current) return { status: 404 as const, error: "Session not found" };
		const next = fn(current.workspace);
		if (next !== current.workspace && next.revision !== current.workspace.revision) {
			persistAndBroadcast(deps, sessionId, current.workspace, next, current.store!);
		}
		return { status: 200 as const, workspace: next };
	});
}

export async function handleSidePanelWorkspaceRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	deps: SidePanelWorkspaceRouteDeps,
): Promise<boolean> {
	const rootMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/side-panel-workspace$/);
	if (rootMatch) {
		const sessionId = decodePathPart(rootMatch[1]);
		if (!sessionId) { error(res, 400, "Invalid session id", "INVALID_SESSION_ID"); return true; }
		if (req.method !== "GET") return false;
		const current = currentWorkspace(deps, sessionId);
		if (!current) { error(res, 404, "Session not found", "SESSION_NOT_FOUND"); return true; }
		// Persist canonical shape when legacy/corrupt data was read; this does not bump workspace revision.
		if (JSON.stringify(current.store!.get(sessionId)?.sidePanelWorkspace ?? null) !== JSON.stringify(current.workspace)) {
			current.store!.update(sessionId, { sidePanelWorkspace: current.workspace });
		}
		writeJson(res, current.workspace);
		return true;
	}

	const opMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/side-panel-workspace\/(open|active|reorder|resize|migrate)$/);
	if (opMatch && req.method === "POST") {
		const sessionId = decodePathPart(opMatch[1]);
		const op = opMatch[2];
		if (!sessionId) { error(res, 400, "Invalid session id", "INVALID_SESSION_ID"); return true; }
		const body = await deps.readBody(req);
		try {
			const baseRevision = revisionFromRequest(req, body);
			const result = await mutate(deps, sessionId, (workspace) => {
				if ((op === "reorder" || strictRevision(body)) && baseRevision !== undefined && baseRevision !== workspace.revision) {
					throw new SidePanelWorkspaceError("Stale side-panel workspace revision", 409, "STALE_REVISION");
				}
				if (op === "open") {
					if (!body || typeof body !== "object") throw new SidePanelWorkspaceError("Invalid request body", 400, "INVALID_BODY");
					return applyWorkspaceMutation(workspace, {
						type: "open",
						tab: (body as Record<string, unknown>).tab,
						focus: (body as Record<string, unknown>).focus !== false,
						placeAfterActive: (body as Record<string, unknown>).placeAfterActive === true,
					}, validatorsFor(deps, sessionId));
				}
				if (op === "active") {
					const activeTabId = body && typeof body === "object" && typeof (body as Record<string, unknown>).activeTabId === "string" ? (body as Record<string, unknown>).activeTabId as string : "";
					return applyWorkspaceMutation(workspace, { type: "active", activeTabId }, validatorsFor(deps, sessionId));
				}
				if (op === "reorder") {
					if (baseRevision === undefined) throw new SidePanelWorkspaceError("Reorder requires baseRevision or If-Match", 409, "REVISION_REQUIRED");
					const tabIds = body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).tabIds)
						? ((body as Record<string, unknown>).tabIds as unknown[]).filter((id): id is string => typeof id === "string")
						: [];
					return applyWorkspaceMutation(workspace, { type: "reorder", tabIds }, validatorsFor(deps, sessionId));
				}
				if (op === "resize") {
					const sizeMode = body && typeof body === "object" ? (body as Record<string, unknown>).sizeMode : undefined;
					if (!isSidePanelSizeMode(sizeMode)) throw new SidePanelWorkspaceError("Invalid side-panel size mode", 400, "INVALID_SIZE_MODE");
					return applyWorkspaceMutation(workspace, { type: "resize", sizeMode }, validatorsFor(deps, sessionId));
				}
				if (op === "migrate") {
					const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
					return applyWorkspaceMutation(workspace, {
						type: "migrate",
						tabs: Array.isArray(payload.tabs) ? payload.tabs : [],
						activeTabId: typeof payload.activeTabId === "string" ? payload.activeTabId : undefined,
						sizeMode: payload.sizeMode,
						metadata: payload.metadata,
					}, validatorsFor(deps, sessionId));
				}
				return workspace;
			});
			if (result.status === 404) { error(res, 404, result.error, "SESSION_NOT_FOUND"); return true; }
			writeJson(res, result.workspace);
			return true;
		} catch (err) {
			if (err instanceof SidePanelWorkspaceError) {
				const current = currentWorkspace(deps, sessionId)?.workspace;
				error(res, err.status, err.message, err.code, current ? { workspace: current } : undefined);
				return true;
			}
			throw err;
		}
	}

	const tabMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/side-panel-workspace\/tabs\/(.+)$/);
	if (tabMatch && (req.method === "PATCH" || req.method === "DELETE")) {
		const sessionId = decodePathPart(tabMatch[1]);
		const tabId = decodePathPart(tabMatch[2]);
		if (!sessionId || !tabId) { error(res, 400, "Invalid path", "INVALID_PATH"); return true; }
		const body = req.method === "PATCH" ? await deps.readBody(req) : undefined;
		try {
			const baseRevision = revisionFromRequest(req, body);
			const result = await mutate(deps, sessionId, (workspace) => {
				if (strictRevision(body) && baseRevision !== undefined && baseRevision !== workspace.revision) {
					throw new SidePanelWorkspaceError("Stale side-panel workspace revision", 409, "STALE_REVISION");
				}
				return req.method === "PATCH"
					? applyWorkspaceMutation(workspace, { type: "update", tabId, patch: body }, validatorsFor(deps, sessionId))
					: applyWorkspaceMutation(workspace, { type: "close", tabId }, validatorsFor(deps, sessionId));
			});
			if (result.status === 404) { error(res, 404, result.error, "SESSION_NOT_FOUND"); return true; }
			writeJson(res, result.workspace);
			return true;
		} catch (err) {
			if (err instanceof SidePanelWorkspaceError) {
				const current = currentWorkspace(deps, sessionId)?.workspace;
				error(res, err.status, err.message, err.code, current ? { workspace: current } : undefined);
				return true;
			}
			throw err;
		}
	}

	return false;
}
