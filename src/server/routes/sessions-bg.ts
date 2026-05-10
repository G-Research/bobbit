/**
 * Per-session background-process (bash_bg) endpoints.
 * Extracted from server.ts (commit: split server.ts).
 */
import type { Route } from "./types.js";

export const sessionsBgRoutes: Route[] = [
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes$/,
		handler: async ({ deps, params, readBody, json }) => {
			const id = params[1];
			const session = deps.sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			const body = await readBody();
			if (!body?.command) { json({ error: "command is required" }, 400); return; }
			try {
				const info = deps.bgProcessManager.create(id, body.command, session.cwd, session.containerId, session.sandboxed, body.name);
				json(info, 201);
			} catch (err: any) {
				if (err?.message?.includes("Sandboxed session without containerId")) {
					json({ error: "Sandboxed session cannot run host processes" }, 403);
				} else {
					throw err;
				}
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes$/,
		handler: ({ deps, params, json }) => {
			json({ processes: deps.bgProcessManager.list(params[1]) });
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/logs$/,
		handler: ({ deps, params, url, json }) => {
			const [, sessionId, processId] = params;
			const logs = deps.bgProcessManager.getLogs(sessionId, processId);
			if (!logs) { json({ error: "Process not found" }, 404); return; }
			const tail = parseInt(url.searchParams.get("tail") || "200", 10);
			json({
				log: logs.log.slice(-tail),
				stdout: logs.stdout.slice(-tail),
				stderr: logs.stderr.slice(-tail),
			});
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/grep$/,
		handler: ({ deps, params, url, json }) => {
			const [, sessionId, processId] = params;
			const pattern = url.searchParams.get("pattern") || "";
			if (!pattern) { json({ error: "pattern is required" }, 400); return; }
			const context = parseInt(url.searchParams.get("context") || "0", 10);
			const maxResults = parseInt(url.searchParams.get("max") || "50", 10);
			const result = deps.bgProcessManager.grepLogs(sessionId, processId, pattern, context, maxResults);
			if (!result) { json({ error: "Process not found" }, 404); return; }
			json(result);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/head$/,
		handler: ({ deps, params, url, json }) => {
			const [, sessionId, processId] = params;
			const lines = parseInt(url.searchParams.get("lines") || "50", 10);
			const result = deps.bgProcessManager.headLogs(sessionId, processId, lines);
			if (!result) { json({ error: "Process not found" }, 404); return; }
			json(result);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/slice$/,
		handler: ({ deps, params, url, json }) => {
			const [, sessionId, processId] = params;
			const from = parseInt(url.searchParams.get("from") || "1", 10);
			const to = parseInt(url.searchParams.get("to") || "50", 10);
			const result = deps.bgProcessManager.sliceLogs(sessionId, processId, from, to);
			if (!result) { json({ error: "Process not found" }, 404); return; }
			json(result);
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/wait$/,
		handler: async ({ deps, params, url, json }) => {
			const [, sessionId, processId] = params;
			const timeout = parseInt(url.searchParams.get("timeout") || "300", 10);
			const controller = new AbortController();
			deps.bgProcessManager.registerWait(sessionId, controller);
			try {
				const result = await deps.bgProcessManager.waitForExit(sessionId, processId, timeout * 1000, controller.signal);
				if (!result) { json({ error: "Process not found" }, 404); return; }
				json(result);
			} finally {
				deps.bgProcessManager.unregisterWait(sessionId, controller);
			}
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)$/,
		handler: ({ deps, params, json }) => {
			const [, sessionId, processId] = params;
			const killed = deps.bgProcessManager.kill(sessionId, processId);
			if (!killed) {
				const removed = deps.bgProcessManager.remove(sessionId, processId);
				if (!removed) { json({ error: "Process not found" }, 404); return; }
			}
			json({ ok: true });
		},
	},
];
