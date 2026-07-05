// src/server/routes/session-proposal-routes.ts
//
// STR-01 cohort 17: Editable proposal REST routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx and registry params
// used in place of url.pathname.match(...).
//
// LEGACY FALL-THROUGH PARITY: /api/sessions/:id/proposal/:type was a
// path-first block that returned 405 for unsupported methods after matching
// the path. To preserve that, all RouteTable-supported methods are registered
// for the proposal paths and the extracted handler keeps the legacy inner
// method branches. /api/sessions/:id/proposals was method-gated in the legacy
// condition, so only GET is registered and other methods still fall through to
// the terminal 404.

import { bobbitStateDir } from "../bobbit-dir.js";
import { readSubgoalNestingPrefs, checkCanSpawnChild } from "../agent/subgoal-nesting-limit.js";
import { openSidePanelWorkspaceTab } from "../side-panel-workspace-routes.js";
import {
	deleteProposalFile,
	editProposalFile,
	isProposalType,
	latestRev,
	listProposalFiles,
	parseProposalFile,
	readProposalFile,
	readSnapshot,
	restoreSnapshot,
	writeProposalFile,
	getProposalTypePlugin,
	type ProposalType,
} from "../proposals/proposal-files.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

type ProposalSuffix = "" | "/edit" | "/seed" | "/restore" | "/snapshot";

function proposalHandler(suffix: ProposalSuffix) {
	return async function handleSessionProposal(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
		const {
			broadcastToSession,
			configCascade,
			getGoalAcrossProjects,
			json,
			packContributionRegistry,
			preferencesStore,
			projectContextManager,
			readBody,
			req,
			res,
			sessionManager,
			url,
			validateGoalProposalWorkflow,
		} = ctx;
		const sessionId = params.id;
		const typeStr = params.type;
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (!isProposalType(typeStr)) {
			json({ error: `Unknown proposal type: ${typeStr}` }, 400);
			return;
		}
		const proposalType = typeStr as ProposalType;
		const proposalStateDir = bobbitStateDir();

		// GET /api/sessions/:id/proposal/:type — read raw file
		if (suffix === "" && req.method === "GET") {
			try {
				const content = await readProposalFile(proposalStateDir, sessionId, proposalType);
				if (content === undefined) {
					json({ ok: false, code: "FILE_NOT_FOUND", message: `No ${proposalType} proposal draft. Call propose_${proposalType} first.` }, 404);
					return;
				}
				const contentType = proposalType === "goal" ? "text/markdown; charset=utf-8" : "application/yaml; charset=utf-8";
				res.writeHead(200, { "Content-Type": contentType });
				res.end(content);
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// GET /api/sessions/:id/proposal/:type/snapshot?rev=N — read a historical snapshot without mutating the live draft.
		if (suffix === "/snapshot" && req.method === "GET") {
			const revParam = url.searchParams.get("rev") || "";
			const rev = Number.parseInt(revParam, 10);
			if (!Number.isInteger(rev) || rev < 1 || String(rev) !== revParam) {
				json({ ok: false, code: "INVALID_BODY", message: "rev must be a positive integer" }, 400);
				return;
			}
			try {
				const content = await readSnapshot(proposalStateDir, sessionId, proposalType, rev);
				if (content === undefined) {
					json({ ok: false, code: "SNAPSHOT_NOT_FOUND", message: `No snapshot rev ${rev} for ${proposalType} proposal` }, 404);
					return;
				}
				const parsed = getProposalTypePlugin(proposalType).parse(content);
				if (!parsed.ok) {
					json(parsed, 400);
					return;
				}
				json({ ok: true, rev, fields: parsed.value.fields });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// DELETE /api/sessions/:id/proposal/:type
		if (suffix === "" && req.method === "DELETE") {
			try {
				await deleteProposalFile(proposalStateDir, sessionId, proposalType);
				if (broadcastToSession) {
					broadcastToSession(sessionId, { type: "proposal_cleared", sessionId, proposalType });
				}
				res.writeHead(204);
				res.end();
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/edit — surgical edit
		if (suffix === "/edit" && req.method === "POST") {
			const body = await readBody(req);
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
				const result = await editProposalFile(proposalStateDir, sessionId, proposalType, old_text, new_text);
				if (!result.ok) {
					const status = result.code === "FILE_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				if (broadcastToSession) {
					broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: result.parsed.fields,
						rev: result.rev,
						streaming: false,
						source: "edit",
					});
				}
				json({ ok: true, newContent: result.newContent, rev: result.rev });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/seed — called from propose_* execute()
		if (suffix === "/seed" && req.method === "POST") {
			const body = await readBody(req);
			if (!body || typeof body !== "object") {
				json({ ok: false, code: "INVALID_BODY", message: "body must be JSON object" }, 400);
				return;
			}
			const args = (body as { args?: unknown }).args;
			if (!args || typeof args !== "object" || Array.isArray(args)) {
				json({ ok: false, code: "INVALID_BODY", message: "args must be an object" }, 400);
				return;
			}
			// Auto-inject parentGoalId for team-lead sessions proposing a goal,
			// but only when the current goal is actually allowed to spawn a child.
			// If subgoals are disabled globally or for this parent, an omitted
			// parentGoalId must remain omitted so accepting the proposal creates a
			// top-level goal instead of a hidden invalid child proposal.
			let enrichedArgs = args as Record<string, unknown>;
			// Workflows are project-scoped only (no Headquarters/system-scope
			// workflow store — see workflows-routes.ts), so a workflow proposal
			// needs the same resolvable-project guard as goal/staff.
			if (proposalType === "goal" || proposalType === "staff" || proposalType === "workflow") {
				const proposalSession = sessionManager.getSession(sessionId) ?? sessionManager.getPersistedSession(sessionId);
				const sessionProjectId = proposalSession?.projectId;
				if (!sessionProjectId) {
					json({ ok: false, code: "PROJECT_ID_REQUIRED", message: "projectId required for project-scoped proposals" }, 400);
					return;
				}
				const proposalProjectId = typeof enrichedArgs.projectId === "string" && enrichedArgs.projectId.trim().length > 0
					? enrichedArgs.projectId.trim()
					: undefined;
				if (proposalProjectId && proposalProjectId !== sessionProjectId) {
					json({ ok: false, code: "PROJECT_ID_MISMATCH", message: "proposal projectId must match the session projectId" }, 422);
					return;
				}
				enrichedArgs = { ...enrichedArgs, projectId: sessionProjectId };
			}
			if (proposalType === "goal") {
				const sess = sessionManager.getSession(sessionId);
				if (sess?.role === "team-lead" && sess.teamGoalId) {
					const existingParent = enrichedArgs.parentGoalId;
					if (!existingParent || (typeof existingParent === "string" && existingParent.trim() === "")) {
						const parent = getGoalAcrossProjects(sess.teamGoalId);
						const prefs = readSubgoalNestingPrefs((k) => preferencesStore.get(k));
						const canSpawnImplicitChild = !!parent && checkCanSpawnChild(
							parent,
							prefs,
							(id) => getGoalAcrossProjects(id),
						).ok;
						if (canSpawnImplicitChild) {
							enrichedArgs = { ...enrichedArgs, parentGoalId: sess.teamGoalId };
						}
					}
				}
			}
			// Validate workflow + optional steps for goal proposals BEFORE persisting,
			// so a stale/hallucinated workflow never produces a broken draft. Skipped
			// when the session has no resolvable project or the project has zero
			// workflows (empty-state behaviour preserved).
			if (proposalType === "goal") {
				const projectId = (sessionManager.getSession(sessionId) ?? sessionManager.getPersistedSession(sessionId))?.projectId;
				let workflows: import("../agent/workflow-store.js").Workflow[] = [];
				if (projectId) {
					workflows = configCascade.resolveWorkflows(projectId).map(r => r.item);
					if (workflows.length === 0) {
						const ctx = projectContextManager.getOrCreate(projectId);
						if (ctx) workflows = ctx.workflowStore.getAll();
					}
				}
				const wfErr = validateGoalProposalWorkflow(enrichedArgs, workflows);
				if (wfErr) { json(wfErr, 400); return; }
			}
			try {
				const writeRes = await writeProposalFile(proposalStateDir, sessionId, proposalType, enrichedArgs);
				const parsed = await parseProposalFile(proposalStateDir, sessionId, proposalType);
				if (!parsed.ok) {
					json(parsed, 400);
					return;
				}
				const proposalLabel = proposalType.charAt(0).toUpperCase() + proposalType.slice(1);
				await openSidePanelWorkspaceTab({
					sessionManager,
					readBody,
					broadcastToSession,
					packContributionRegistry,
				}, sessionId, {
					id: `proposal:${proposalType}`,
					kind: "proposal",
					title: `${proposalLabel} Proposal`,
					label: proposalLabel,
					source: { type: "proposal", sessionId, proposalType },
					updatedAt: Date.now(),
				}, { focus: true, placeAfterActive: true }).catch((err) => {
					console.warn(`[proposal/seed] failed to open side-panel workspace tab for ${sessionId}/${proposalType}:`, err);
				});
				if (broadcastToSession) {
					broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: parsed.value.fields,
						rev: writeRes.rev,
						streaming: false,
						source: "seed",
					});
				}
				json({ ok: true, rev: writeRes.rev });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		// POST /api/sessions/:id/proposal/:type/restore — restore a snapshot
		if (suffix === "/restore" && req.method === "POST") {
			const body = await readBody(req);
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
				const result = await restoreSnapshot(proposalStateDir, sessionId, proposalType, rev);
				if (!result.ok) {
					const status = (result as any).code === "SNAPSHOT_NOT_FOUND" ? 404 : 400;
					json(result, status);
					return;
				}
				const proposalLabel = proposalType.charAt(0).toUpperCase() + proposalType.slice(1);
				await openSidePanelWorkspaceTab({
					sessionManager,
					readBody,
					broadcastToSession,
					packContributionRegistry,
				}, sessionId, {
					id: `proposal:${proposalType}`,
					kind: "proposal",
					title: `${proposalLabel} Proposal`,
					label: proposalLabel,
					source: { type: "proposal", sessionId, proposalType },
					updatedAt: Date.now(),
				}, { focus: true, placeAfterActive: true }).catch((err) => {
					console.warn(`[proposal/restore] failed to open side-panel workspace tab for ${sessionId}/${proposalType}:`, err);
				});
				if (broadcastToSession) {
					broadcastToSession(sessionId, {
						type: "proposal_update",
						sessionId,
						proposalType,
						fields: result.fields,
						rev: result.newRev,
						streaming: false,
						source: "restore",
					});
				}
				json({ ok: true, newRev: result.newRev, fields: result.fields });
			} catch (err) {
				json({ error: String((err as Error)?.message ?? err) }, 500);
			}
			return;
		}

		json({ error: "Method not allowed" }, 405);
		return;
	};
}

// GET /api/sessions/:id/proposals — list all parsed proposal drafts for the session.
//
// Mirrors the WS-auth `proposal_update {source:"rehydrate"}` broadcast in
// `ws/handler.ts` but as a one-shot REST call. Used by the client's fast-path
// session switch-back (no fresh WS auth fires, so the broadcast doesn't run
// and the client's in-memory proposal slot would otherwise stay stale).
async function handleSessionProposalsList(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json } = ctx;
	const sessionId = params.id;
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
		json({ error: "Invalid sessionId" }, 400);
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
		json({ error: String((err as Error)?.message ?? err) }, 500);
	}
	return;
}

export function registerSessionProposalRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("GET", "/api/sessions/:id/proposal/:type", proposalHandler(""));
	table.register("POST", "/api/sessions/:id/proposal/:type", proposalHandler(""));
	table.register("PUT", "/api/sessions/:id/proposal/:type", proposalHandler(""));
	table.register("PATCH", "/api/sessions/:id/proposal/:type", proposalHandler(""));
	table.register("DELETE", "/api/sessions/:id/proposal/:type", proposalHandler(""));
	table.register("GET", "/api/sessions/:id/proposal/:type/edit", proposalHandler("/edit"));
	table.register("POST", "/api/sessions/:id/proposal/:type/edit", proposalHandler("/edit"));
	table.register("PUT", "/api/sessions/:id/proposal/:type/edit", proposalHandler("/edit"));
	table.register("PATCH", "/api/sessions/:id/proposal/:type/edit", proposalHandler("/edit"));
	table.register("DELETE", "/api/sessions/:id/proposal/:type/edit", proposalHandler("/edit"));
	table.register("GET", "/api/sessions/:id/proposal/:type/seed", proposalHandler("/seed"));
	table.register("POST", "/api/sessions/:id/proposal/:type/seed", proposalHandler("/seed"));
	table.register("PUT", "/api/sessions/:id/proposal/:type/seed", proposalHandler("/seed"));
	table.register("PATCH", "/api/sessions/:id/proposal/:type/seed", proposalHandler("/seed"));
	table.register("DELETE", "/api/sessions/:id/proposal/:type/seed", proposalHandler("/seed"));
	table.register("GET", "/api/sessions/:id/proposal/:type/restore", proposalHandler("/restore"));
	table.register("POST", "/api/sessions/:id/proposal/:type/restore", proposalHandler("/restore"));
	table.register("PUT", "/api/sessions/:id/proposal/:type/restore", proposalHandler("/restore"));
	table.register("PATCH", "/api/sessions/:id/proposal/:type/restore", proposalHandler("/restore"));
	table.register("DELETE", "/api/sessions/:id/proposal/:type/restore", proposalHandler("/restore"));
	table.register("GET", "/api/sessions/:id/proposal/:type/snapshot", proposalHandler("/snapshot"));
	table.register("POST", "/api/sessions/:id/proposal/:type/snapshot", proposalHandler("/snapshot"));
	table.register("PUT", "/api/sessions/:id/proposal/:type/snapshot", proposalHandler("/snapshot"));
	table.register("PATCH", "/api/sessions/:id/proposal/:type/snapshot", proposalHandler("/snapshot"));
	table.register("DELETE", "/api/sessions/:id/proposal/:type/snapshot", proposalHandler("/snapshot"));
	table.register("GET", "/api/sessions/:id/proposals", handleSessionProposalsList);
}
