// src/server/routes/session-content-routes.ts
//
// STR-01 cohort 25: session content/readback routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// replacing regex/split path captures.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition. A method
// mismatch skipped the block and fell through to the terminal 404; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";
import { findCompactionSidecarEntry } from "../agent/compaction-sidecar.js";
import { ensureCodeAssistProject, getGoogleAccessToken, hasGoogleCodeAssistCredential } from "../agent/google-code-assist.js";
import { sessionFileRead, sessionFsContextForAgentFile } from "../agent/session-fs.js";
import { readOrphanedBeforeCompaction, readTranscript, TranscriptReaderError } from "../agent/transcript-reader.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// GET /api/sessions/:id/file-content?path=<relative-or-absolute>&snapshotId=<id>
// Reads a text file for inline preview. When snapshotId is provided:
//   - If a snapshot exists on disk, returns the snapshot (historical state)
//   - Otherwise reads the live file and saves a snapshot for future refreshes
async function handleSessionFileContent(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager, url } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) { json({ error: "Session not found" }, 404); return; }

	const filePath = url.searchParams.get("path");
	if (!filePath) { json({ error: "Missing path parameter" }, 400); return; }

	const snapshotId = url.searchParams.get("snapshotId");
	const snapshotDir = path.join(bobbitStateDir(), "html-snapshots");
	const snapshotFile = snapshotId ? path.join(snapshotDir, `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "")}.html`) : null;

	// Return existing snapshot if available
	if (snapshotFile && fs.existsSync(snapshotFile)) {
		try {
			const content = fs.readFileSync(snapshotFile, "utf-8");
			json({ content });
		} catch {
			json({ error: "Snapshot read failed" }, 500);
		}
		return;
	}

	// Read live file
	const resolved = path.isAbsolute(filePath)
		? path.resolve(filePath)
		: path.resolve(session.cwd, filePath);

	try {
		const stat = fs.statSync(resolved);
		if (stat.isDirectory() || stat.size > 512 * 1024) {
			json({ error: "File too large or is a directory" }, 400);
			return;
		}
		const content = fs.readFileSync(resolved, "utf-8");

		// Save snapshot for future refreshes
		if (snapshotFile) {
			try {
				fs.mkdirSync(snapshotDir, { recursive: true });
				fs.writeFileSync(snapshotFile, content, "utf-8");
			} catch { /* best-effort */ }
		}

		json({ content });
	} catch {
		json({ error: "File not found" }, 404);
	}
	return;
}

// GET /api/sessions/:id/google-code-assist/token — short-lived runtime material
// for the agent-side Code Assist provider extension. Returns a fresh Google
// account Bearer access token and the Code Assist project id. This is the only
// way the spawned pi-coding-agent runtime obtains credentials for
// google-gemini-cli session models, so it can refresh per request instead of
// relying on a stale env-only token. Never returns the OAuth refresh token.
async function handleSessionGoogleCodeAssistToken(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, sessionManager } = ctx;
	const id = params.id;
	const session = sessionManager.getSession(id);
	if (!session) {
		json({ error: "Session not found" }, 404);
		return;
	}
	// Provider isolation: this endpoint is exclusively the Google account
	// (OAuth / Code Assist) path. It must never touch the API-key-only `google`
	// provider. A 401 here means "re-auth your Google account", not "add an API key".
	if (!hasGoogleCodeAssistCredential()) {
		json(
			{
				error: "No Google account is signed in. Re-authenticate via Settings \u2192 Account \u2192 Google (Gemini).",
				code: "GOOGLE_CODE_ASSIST_REAUTH",
			},
			401,
		);
		return;
	}
	let accessToken: string | null;
	try {
		accessToken = await getGoogleAccessToken();
	} catch (err) {
		jsonError(401, err, { code: "GOOGLE_CODE_ASSIST_REAUTH" });
		return;
	}
	if (!accessToken) {
		json(
			{
				error: "Google account token could not be refreshed. Sign in again via Settings \u2192 Account \u2192 Google (Gemini).",
				code: "GOOGLE_CODE_ASSIST_REAUTH",
			},
			401,
		);
		return;
	}
	// Project selection: an explicit GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID
	// (paid Code Assist / GCP-billed subscriptions) wins; otherwise resolve/onboard
	// the free-tier project via the Code Assist API.
	let projectId: string | undefined =
		(process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || "").trim() || undefined;
	if (!projectId) {
		try {
			projectId = await ensureCodeAssistProject(accessToken);
		} catch (err) {
			// Token is valid but project onboarding failed — surface as a non-auth
			// error so the runtime doesn't misreport it as a re-auth requirement.
			jsonError(502, err, { code: "GOOGLE_CODE_ASSIST_PROJECT" });
			return;
		}
	}
	json({ accessToken, projectId: projectId ?? null });
	return;
}

// GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex — lazy-load full tool input content
async function handleSessionToolContent(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, sessionManager } = ctx;
	const id = params.id;
	const messageIndex = parseInt(params.messageIndex, 10);
	const blockIndex = parseInt(params.blockIndex, 10);
	const session = sessionManager.getSession(id);
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
		// Fallback: text blocks (e.g. preview_open snapshot blocks in
		// toolResult messages) store their payload in `block.text`.
		if (toolContent === undefined && block.type === "text" && typeof block.text === "string") {
			toolContent = block.text;
		}
		if (toolContent === undefined) { json({ error: "No content in block" }, 404); return; }
		json({ content: toolContent });
	} catch (err) {
		jsonError(500, err);
	}
	return;
}

// GET /api/sessions/:id/transcript — paginated, regex-filterable transcript reader
// Backs the `read_session` tool extension. See `src/server/agent/transcript-reader.ts`.
async function handleSessionTranscript(ctx: CoreRouteCtx, routeParams: Record<string, string>): Promise<void> {
	const { json, jsonError, sandboxManager, sessionManager, url } = ctx;
	const targetId = routeParams.id;
	// Resolve target session (live or persisted).
	const targetPs = sessionManager.getPersistedSession(targetId);
	if (!targetPs) { json({ error: "session_not_found" }, 404); return; }

	// Parse query params.
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
	function parseBoolParam(...names: string[]): boolean | undefined {
		let raw: string | null = null;
		let foundName = "";
		for (const name of names) {
			raw = qp.get(name);
			if (raw !== null) { foundName = name; break; }
		}
		if (raw === null) return undefined;
		const normalized = raw.toLowerCase();
		if (normalized === "1" || normalized === "true") return true;
		if (normalized === "0" || normalized === "false") return false;
		throw new TranscriptReaderError("invalid_params", `${foundName} must be a boolean`);
	}
	try {
		const params = {
			offset: parseIntParam("offset"),
			limit: parseIntParam("limit"),
			pattern: qp.get("pattern") ?? undefined,
			caseSensitive: qp.get("case_sensitive") === "1" || qp.get("case_sensitive") === "true",
			context: parseIntParam("context"),
			verbose: qp.get("verbose") === "1" || qp.get("verbose") === "true",
			includeToolResults: parseBoolParam("include_tool_results", "includeToolResults"),
		};
		const ctx = sessionFsContextForAgentFile(targetPs, targetPs.agentSessionFile);
		const envelope = await readTranscript(params, {
			readContent: async () => {
				if (targetPs.agentSessionFile) return sessionFileRead(ctx, targetPs.agentSessionFile, sandboxManager ?? null);
				// Claude Code local-runtime sessions may have no on-disk
				// agentSessionFile yet (the CLI owns its own transcript) — fall
				// back to the live bridge's in-process `get_messages` so the
				// transcript endpoint still resolves instead of 404ing.
				const live = sessionManager.getSession(targetId);
				const isClaudeCode = targetPs.runtime === "claude-code" || targetPs.modelProvider === "claude-code";
				if (!isClaudeCode || !live?.rpcClient?.getMessages) return null;
				const msgsResp = await live.rpcClient.getMessages();
				const messages = Array.isArray(msgsResp?.data) ? msgsResp.data : msgsResp?.data?.messages;
				if (!msgsResp?.success || !Array.isArray(messages) || messages.length === 0) return null;
				return messages.map((message: any) => JSON.stringify({
					type: "message",
					id: message?.id,
					ts: new Date().toISOString(),
					message,
				})).join("\n") + "\n";
			},
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
	return;
}

// GET /api/sessions/:id/transcript/before-compaction — orphaned
// pre-compaction history for the named sidecar compaction id, paginated.
// See docs/design/persist-compaction-history.md §4.2.
async function handleSessionTranscriptBeforeCompaction(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, jsonError, sandboxManager, sessionManager, url } = ctx;
	const targetId = params.id;
	const targetPs = sessionManager.getPersistedSession(targetId);
	if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
	if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }


	const compactionId = url.searchParams.get("compactionId");
	if (!compactionId) {
		json({ error: "invalid_params", detail: "compactionId required" }, 400);
		return;
	}
	const entry = findCompactionSidecarEntry(targetId, compactionId);
	if (!entry) {
		json({ error: "compaction_not_found" }, 404);
		return;
	}
	const qp2 = url.searchParams;
	let cursor: number | undefined;
	let limit: number | undefined;
	const verbose = qp2.get("verbose") === "1" || qp2.get("verbose") === "true";
	try {
		if (qp2.has("cursor")) {
			const c = Number(qp2.get("cursor"));
			if (!Number.isFinite(c) || !Number.isInteger(c) || c < 0) {
				throw new TranscriptReaderError("invalid_params", "cursor must be a non-negative integer");
			}
			cursor = c;
		}
		if (qp2.has("limit")) {
			const n = Number(qp2.get("limit"));
			if (!Number.isFinite(n) || !Number.isInteger(n)) {
				throw new TranscriptReaderError("invalid_params", "limit must be an integer");
			}
			limit = n;
		}
	} catch (err) {
		if (err instanceof TranscriptReaderError) {
			json({ error: err.code, detail: err.message }, 400);
		} else {
			jsonError(500, err, { error: "internal_error", detail: String(err) });
		}
		return;
	}
	const ctx2 = sessionFsContextForAgentFile(targetPs, targetPs.agentSessionFile);
	try {
		const envelope = await readOrphanedBeforeCompaction(
			{ compactionId, cursor, limit, verbose },
			{
				readContent: () => sessionFileRead(ctx2, targetPs.agentSessionFile!, sandboxManager ?? null),
				firstKeptEntryId: entry.firstKeptEntryId,
			},
		);
		json(envelope);
	} catch (err) {
		if (err instanceof TranscriptReaderError) {
			const status = err.code === "transcript_unavailable" ? 404 : 400;
			json({ error: err.code, detail: err.message }, status);
		} else {
			jsonError(500, err, { error: "internal_error", detail: String(err) });
		}
	}
	return;
}

export function registerSessionContentRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/sessions/:id/file-content", handleSessionFileContent);
	table.register("GET", "/api/sessions/:id/google-code-assist/token", handleSessionGoogleCodeAssistToken);
	table.register("GET", "/api/sessions/:id/tool-content/:messageIndex/:blockIndex", handleSessionToolContent);
	table.register("GET", "/api/sessions/:id/transcript", handleSessionTranscript);
	table.register("GET", "/api/sessions/:id/transcript/before-compaction", handleSessionTranscriptBeforeCompaction);
}
