/**
 * Per-session proposal CRUD + edit + seed + restore + list.
 * Extracted from server.ts (commit: split server.ts).
 *
 * docs/design/editable-proposals.md §6.4
 */
import { bobbitStateDir } from "../bobbit-dir.js";
import {
	deleteProposalFile,
	editProposalFile,
	isProposalType,
	latestRev,
	listProposalFiles,
	parseProposalFile,
	readProposalFile,
	restoreSnapshot,
	writeProposalFile,
	type ProposalType,
} from "../proposals/proposal-files.js";
import type { Route } from "./types.js";

export const sessionsProposalsRoutes: Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/proposals$/,
		handler: async ({ params, json, jsonError }) => {
			const sessionId = params[1];
			if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
				jsonError(400, new Error("Invalid sessionId"));
				return;
			}
			const stateDir = bobbitStateDir();
			try {
				const types = await listProposalFiles(stateDir, sessionId);
				const proposals: Array<{ proposalType: string; fields: Record<string, unknown>; rev: number }> = [];
				for (const proposalType of types) {
					const parsed = await parseProposalFile(stateDir, sessionId, proposalType);
					if (parsed.ok) {
						const rev = await latestRev(stateDir, sessionId, proposalType);
						proposals.push({ proposalType, fields: parsed.value.fields, rev });
					}
				}
				json({ proposals });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	// Proposal :type sub-routes — register most-specific (suffix) first.
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)\/edit$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const sessionId = params[1];
			const typeStr = params[2];
			if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) { jsonError(400, new Error("Invalid sessionId")); return; }
			if (!isProposalType(typeStr)) { jsonError(400, new Error(`Unknown proposal type: ${typeStr}`)); return; }
			const proposalType = typeStr as ProposalType;
			const stateDir = bobbitStateDir();
			const body = await readBody();
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const { old_text, new_text } = body as { old_text?: unknown; new_text?: unknown };
			if (typeof old_text !== "string" || typeof new_text !== "string") {
				json({ ok: false, code: "INVALID_BODY", message: "old_text and new_text must be strings" }, 400);
				return;
			}
			try {
				const result = await editProposalFile(stateDir, sessionId, proposalType, old_text, new_text);
				if (!result.ok) {
					const status = result.code === "FILE_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				deps.broadcastToSession(sessionId, {
					type: "proposal_update",
					sessionId,
					proposalType,
					fields: result.parsed.fields,
					rev: result.rev,
					streaming: false,
					source: "edit",
				});
				json({ ok: true, newContent: result.newContent, rev: result.rev });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)\/seed$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const sessionId = params[1];
			const typeStr = params[2];
			if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) { jsonError(400, new Error("Invalid sessionId")); return; }
			if (!isProposalType(typeStr)) { jsonError(400, new Error(`Unknown proposal type: ${typeStr}`)); return; }
			const proposalType = typeStr as ProposalType;
			const stateDir = bobbitStateDir();
			const body = await readBody();
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const args = (body as { args?: unknown }).args;
			if (!args || typeof args !== "object" || Array.isArray(args)) {
				json({ ok: false, code: "INVALID_BODY", message: "args must be an object" }, 400);
				return;
			}
			try {
				const writeRes = await writeProposalFile(stateDir, sessionId, proposalType, args as Record<string, unknown>);
				const parsed = await parseProposalFile(stateDir, sessionId, proposalType);
				if (!parsed.ok) {
					json(parsed, 400);
					return;
				}
				deps.broadcastToSession(sessionId, {
					type: "proposal_update",
					sessionId,
					proposalType,
					fields: parsed.value.fields,
					rev: writeRes.rev,
					streaming: false,
					source: "seed",
				});
				json({ ok: true, rev: writeRes.rev });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)\/restore$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const sessionId = params[1];
			const typeStr = params[2];
			if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) { jsonError(400, new Error("Invalid sessionId")); return; }
			if (!isProposalType(typeStr)) { jsonError(400, new Error(`Unknown proposal type: ${typeStr}`)); return; }
			const proposalType = typeStr as ProposalType;
			const stateDir = bobbitStateDir();
			const body = await readBody();
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const rev = (body as { rev?: unknown }).rev;
			if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
				json({ ok: false, code: "INVALID_BODY", message: "rev must be a positive integer" }, 400);
				return;
			}
			try {
				const result = await restoreSnapshot(stateDir, sessionId, proposalType, rev);
				if (!result.ok) {
					const status = (result as any).code === "SNAPSHOT_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				deps.broadcastToSession(sessionId, {
					type: "proposal_update",
					sessionId,
					proposalType,
					fields: result.fields,
					rev: result.newRev,
					streaming: false,
					source: "restore",
				});
				json({ ok: true, newRev: result.newRev, fields: result.fields });
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)$/,
		handler: async ({ params, res, json, jsonError }) => {
			const sessionId = params[1];
			const typeStr = params[2];
			if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) { jsonError(400, new Error("Invalid sessionId")); return; }
			if (!isProposalType(typeStr)) { jsonError(400, new Error(`Unknown proposal type: ${typeStr}`)); return; }
			const proposalType = typeStr as ProposalType;
			const stateDir = bobbitStateDir();
			try {
				const content = await readProposalFile(stateDir, sessionId, proposalType);
				if (content === undefined) {
					json({ ok: false, code: "FILE_NOT_FOUND", message: `No ${proposalType} proposal draft. Call propose_${proposalType} first.` }, 404);
					return;
				}
				const contentType = proposalType === "goal" ? "text/markdown; charset=utf-8" : "application/yaml; charset=utf-8";
				res.writeHead(200, { "Content-Type": contentType });
				res.end(content);
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)$/,
		handler: async ({ deps, params, res, jsonError }) => {
			const sessionId = params[1];
			const typeStr = params[2];
			if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) { jsonError(400, new Error("Invalid sessionId")); return; }
			if (!isProposalType(typeStr)) { jsonError(400, new Error(`Unknown proposal type: ${typeStr}`)); return; }
			const proposalType = typeStr as ProposalType;
			const stateDir = bobbitStateDir();
			try {
				await deleteProposalFile(stateDir, sessionId, proposalType);
				deps.broadcastToSession(sessionId, { type: "proposal_cleared", sessionId, proposalType });
				res.writeHead(204);
				res.end();
			} catch (err) {
				jsonError(500, err);
			}
		},
	},
];
