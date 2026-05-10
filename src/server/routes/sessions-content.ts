/**
 * Per-session content/transcript/abort/draft/title/output/mark-read/tool-content/prompt-sections.
 * Extracted from server.ts (commit: split server.ts).
 */
import { bobbitStateDir } from "../bobbit-dir.js";
import { getPromptSections, loadPersistedPromptSections } from "../agent/system-prompt.js";
import { sessionFileRead, type SessionFsContext } from "../agent/session-fs.js";
import { readTranscript, TranscriptReaderError } from "../agent/transcript-reader.js";
import type { Route } from "./types.js";

export const sessionsContentRoutes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/output$/,
		handler: async ({ deps, params, json }) => {
			const id = params[1];
			try {
				const output = await deps.sessionManager.getSessionOutput(id);
				json({ output });
			} catch {
				json({ error: "Failed to get output" }, 500);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/mark-read$/,
		handler: ({ deps, params, json }) => {
			const id = params[1];
			const ok = deps.sessionManager.markSessionRead(id);
			if (!ok) { json({ error: "session not found" }, 404); return; }
			json({ ok: true });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/generate-title$/,
		handler: async ({ deps, params, json }) => {
			const id = params[1];
			try {
				const title = await deps.sessionManager.generateTitleForAnySession(id);
				if (!title) {
					json({ error: "Could not generate title (session not found or no messages)" }, 404);
					return;
				}
				json({ title });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/sessions\/([^/]+)\/title$/,
		handler: async ({ deps, params, readBody, json }) => {
			const id = params[1];
			const body = await readBody();
			const title = body?.title;
			if (!title || typeof title !== "string") {
				json({ error: "Missing title" }, 400);
				return;
			}
			const ok = deps.sessionManager.setTitle(id, title);
			if (!ok) {
				json({ error: "Session not found" }, 404);
				return;
			}
			json({ ok: true });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/tool-content\/(\d+)\/(\d+)$/,
		handler: async ({ deps, params, json, jsonError }) => {
			const id = params[1];
			const messageIndex = parseInt(params[2], 10);
			const blockIndex = parseInt(params[3], 10);
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			try {
				const msgsResp = await session.rpcClient.getMessages();
				const messages = msgsResp?.data?.messages || msgsResp?.data;
				if (!Array.isArray(messages)) { json({ error: "Could not retrieve messages" }, 500); return; }
				const msg = messages[messageIndex];
				if (!msg) { json({ error: "Message not found" }, 404); return; }
				const content = Array.isArray(msg.content) ? msg.content : [];
				const block = content[blockIndex];
				if (!block) { json({ error: "Block not found" }, 404); return; }
				let toolContent = block.arguments?.content ?? block.input?.content;
				if (toolContent === undefined && block.type === "text" && typeof block.text === "string") {
					toolContent = block.text;
				}
				if (toolContent === undefined) { json({ error: "No content in block" }, 404); return; }
				json({ content: toolContent });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/transcript$/,
		handler: async ({ deps, params, req, url, json, jsonError }) => {
			const targetId = params[1];
			const targetPs = deps.sessionManager.getPersistedSession(targetId);
			if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
			if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }

			const callerSid = req.headers["x-bobbit-session-id"];
			const callerSidStr = Array.isArray(callerSid) ? callerSid[0] : callerSid;
			if (callerSidStr) {
				const callerPs = deps.sessionManager.getPersistedSession(callerSidStr);
				if (callerPs && targetPs.projectId && callerPs.projectId && callerPs.projectId !== targetPs.projectId) {
					json({ error: "permission_denied" }, 403); return;
				}
			}

			const qp = url.searchParams;
			function parseIntParam(name: string): number | undefined {
				const raw = qp.get(name);
				if (raw === null) return undefined;
				const n = Number(raw);
				if (!Number.isFinite(n)) {
					throw new TranscriptReaderError("invalid_params", `${name} is not a number`);
				}
				return n;
			}
			try {
				const tparams = {
					offset: parseIntParam("offset"),
					limit: parseIntParam("limit"),
					pattern: qp.get("pattern") ?? undefined,
					caseSensitive: qp.get("case_sensitive") === "1" || qp.get("case_sensitive") === "true",
					context: parseIntParam("context"),
					verbose: qp.get("verbose") === "1" || qp.get("verbose") === "true",
				};
				const ctx: SessionFsContext = { sandboxed: targetPs.sandboxed, projectId: targetPs.projectId };
				const envelope = await readTranscript(tparams, {
					readContent: () => sessionFileRead(ctx, targetPs.agentSessionFile, deps.sandboxManager),
				});
				json(envelope);
			} catch (err) {
				if (err instanceof TranscriptReaderError) {
					const status = err.code === "transcript_unavailable" ? 404 : 400;
					json({ error: err.code, detail: err.message }, status);
				} else {
					jsonError(500, err, { error: "internal_error", detail: String(err) });
				}
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/abort$/,
		handler: async ({ deps, params, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			if (session.status !== "streaming") { json({ ok: true, status: session.status }); return; }
			await deps.sessionManager.forceAbort(id);
			json({ ok: true, status: "idle" });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/prompt-sections$/,
		handler: ({ deps, params, json }) => {
			const id = params[1];
			const persisted = loadPersistedPromptSections(id);
			if (persisted) {
				json(persisted);
				return;
			}
			const parts = deps.sessionManager.getPromptParts(id);
			if (!parts) { json({ error: "Session not found or no prompt data" }, 404); return; }
			if (!parts.toolDocs && deps.toolManager) {
				parts.toolDocs = deps.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
			}
			const sections = getPromptSections(parts);
			const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
			json({ sections, totalTokens });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/draft$/,
		handler: ({ deps, params, url, json }) => {
			const id = params[1];
			const type = url.searchParams.get("type");
			if (!type) { json({ error: "Missing type query param" }, 400); return; }
			const data = deps.sessionManager.getDraft(id, type);
			if (data === undefined) {
				const session = deps.sessionManager.getSession(id);
				if (!session) { json({ error: "Session not found" }, 404); return; }
				json({ error: "Draft not found" }, 404);
				return;
			}
			json({ type, data });
		},
	},
	{
		method: "PUT",
		pattern: /^\/api\/sessions\/([^/]+)\/draft$/,
		handler: async ({ deps, params, readBody, json }) => {
			const id = params[1];
			const body = await readBody();
			if (!body || typeof body.type !== "string") {
				json({ error: "Missing type" }, 400);
				return;
			}
			const ok = deps.sessionManager.setDraft(id, body.type, body.data);
			if (!ok) { json({ error: "Session not found" }, 404); return; }
			json({ ok: true });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/draft$/,
		handler: async ({ deps, params, readBody, json }) => {
			// Same handler as PUT — sendBeacon uses POST.
			const id = params[1];
			const body = await readBody();
			if (!body || typeof body.type !== "string") {
				json({ error: "Missing type" }, 400);
				return;
			}
			const ok = deps.sessionManager.setDraft(id, body.type, body.data);
			if (!ok) { json({ error: "Session not found" }, 404); return; }
			json({ ok: true });
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/sessions\/([^/]+)\/draft$/,
		handler: ({ deps, params, url, json }) => {
			const id = params[1];
			const type = url.searchParams.get("type");
			if (!type) { json({ error: "Missing type query param" }, 400); return; }
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			deps.sessionManager.deleteDraft(id, type);
			json({ ok: true });
		},
	},
];
