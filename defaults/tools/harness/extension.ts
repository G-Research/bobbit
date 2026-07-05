/**
 * Harness self-service tools: `orient` (self-description / "whoami") and
 * `search` (read-only full-text search over goals/sessions/messages/staff
 * and repo docs).
 *
 * `orient` proxies to `GET /api/internal/orient`. The server-side endpoint
 * assembles the payload from state it already holds (SessionInfo/
 * PersistedSession, GoalRecord, RegisteredProject, package.json version) —
 * see `src/server/agent/orient.ts` for the shape and design rationale
 * (Finding W2.15).
 *
 * Response shape from the gateway:
 *   { gateway, apiRouteFamilies, session, project, goal }   // success
 *   { error: string }                                        // failure
 *
 * `search` proxies to the existing `GET /api/search` endpoint (the same
 * BM25/FlexSearch path the web UI's full search page uses —
 * `projectContextManager.searchAll()`), closing NAV-doc-knowledge-retrieval
 * / F10: agents previously had no way to query this index, only ripgrep.
 * Results are always `{ type, id, title, snippet, filePath?, startLine?,
 * endLine?, ... }` — snippets are ~300-char highlighted excerpts, never
 * whole file/message/spec bodies (see `src/server/search/snippet.ts`).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function getGatewayUrl(): string {
	if (process.env.BOBBIT_GATEWAY_URL) return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
	const urlPath = path.join(bobbitDir, "state", "gateway-url");
	return fs.readFileSync(urlPath, "utf-8").trim();
}

function getGatewayToken(): string {
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
	const tokenPath = path.join(bobbitDir, "state", "token");
	return fs.readFileSync(tokenPath, "utf-8").trim();
}

/** Shared GET helper for the small internal/no-body gateway endpoints this group calls. */
async function gatewayGet(urlPathAndQuery: string): Promise<any> {
	const gwUrl = getGatewayUrl();
	const token = getGatewayToken();
	const url = new URL(gwUrl + urlPathAndQuery);
	const mod: any = url.protocol === "https:" ? await import("node:https") : await import("node:http");
	return await new Promise((resolve, reject) => {
		const req = mod.request(url, {
			method: "GET",
			headers: {
				"Authorization": "Bearer " + token,
				"X-Bobbit-Session-Id": process.env.BOBBIT_SESSION_ID || "",
			},
			...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
		}, (res: any) => {
			let data = "";
			res.on("data", (chunk: Buffer | string) => { data += chunk; });
			res.on("end", () => {
				try { resolve(JSON.parse(data)); }
				catch { resolve({ error: data || `HTTP ${res.statusCode}` }); }
			});
		});
		req.on("error", reject);
		req.end();
	});
}

async function callOrient(): Promise<any> {
	return gatewayGet("/api/internal/orient");
}

interface SearchParams {
	q: string;
	type?: "all" | "goals" | "sessions" | "messages" | "staff" | "files";
	limit?: number;
	offset?: number;
	project_id?: string;
}

async function callSearch(params: SearchParams): Promise<any> {
	const qs = new URLSearchParams();
	qs.set("q", params.q);
	if (params.type) qs.set("type", params.type);
	if (params.limit !== undefined) qs.set("limit", String(params.limit));
	if (params.offset !== undefined) qs.set("offset", String(params.offset));
	if (params.project_id) qs.set("projectId", params.project_id);
	return gatewayGet(`/api/search?${qs.toString()}`);
}

/** Compact one-line rendering of a single search hit — path/title + snippet, never full content. */
function formatHit(hit: any): string {
	const loc = hit?.filePath
		? `${hit.filePath}${hit.startLine ? `:${hit.startLine}` : ""}`
		: (hit?.sessionTitle || hit?.title || hit?.id);
	const snippet = typeof hit?.snippet === "string" ? hit.snippet.replace(/<\/?b>/g, "") : "";
	return `- [${hit?.type ?? "?"}] ${loc} — ${snippet}`;
}

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "orient",
		label: "Orient",
		description: "Return your own session/goal/project identity and gateway facts (whoami). No parameters.",
		promptSnippet:
			"orient() - Who/where am I: session id, goal, role, project, worktree, gateway version/URL. No params.",
		promptGuidelines: [
			"Call orient() instead of guessing your own session id, goal, role, or worktree path from context.",
			"orient() reports only YOUR OWN identity — for the whole team roster use team_list (team-lead only).",
		],
		parameters: Type.Object({}),

		async execute() {
			let result: any;
			try {
				result = await callOrient();
			} catch (err: any) {
				return {
					isError: true,
					content: [{ type: "text", text: `error: ${err?.message ?? String(err)}` }],
				};
			}
			if (result && typeof result.error === "string") {
				return {
					isError: true,
					content: [{ type: "text", text: `error: ${result.error}` }],
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});

	pi.registerTool({
		name: "search",
		label: "Search",
		description: "Read-only full-text search over goals, sessions, messages, staff, and repo docs.",
		promptSnippet:
			"search(q) - Full-text search goals/sessions/messages/staff/docs (docs/**, AGENTS.md). Returns paths+snippets, not whole files.",
		promptGuidelines: [
			"Use search() to find prior decisions, session/goal history, or doc/AGENTS.md guidance instead of guessing a ripgrep keyword",
			"type:'files' restricts to repo docs (docs/**, AGENTS.md, CLAUDE.md); omit type to search everything",
			"Results are short snippets with ids/paths — follow up with read_session or read for full context",
		],
		parameters: Type.Object({
			q: Type.String({ description: "Search query." }),
			type: Type.Optional(Type.Union(
				[Type.Literal("all"), Type.Literal("goals"), Type.Literal("sessions"), Type.Literal("messages"), Type.Literal("staff"), Type.Literal("files")],
				{ description: "Restrict to one kind. Default 'all'.", default: "all" },
			)),
			limit: Type.Optional(Type.Number({ description: "Max results. Default 20, max 100." })),
			offset: Type.Optional(Type.Number({ description: "Pagination offset. Default 0." })),
			project_id: Type.Optional(Type.String({ description: "Restrict to one project. Default: all projects." })),
		}),

		async execute(_toolCallId, params) {
			let result: any;
			try {
				result = await callSearch(params as SearchParams);
			} catch (err: any) {
				return {
					isError: true,
					content: [{ type: "text", text: `error: ${err?.message ?? String(err)}` }],
				};
			}
			if (result && typeof result.error === "string") {
				return {
					isError: true,
					content: [{ type: "text", text: `error: ${result.error}` }],
				};
			}
			const hits = Array.isArray(result?.results) ? result.results : [];
			const total = typeof result?.total === "number" ? result.total : hits.length;
			const lines = [
				`${hits.length} of ${total} result(s):`,
				...hits.map(formatHit),
			];
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { total, results: hits },
			};
		},
	});
};

export default extension;
