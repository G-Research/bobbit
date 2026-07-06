// src/server/routes/session-mutation-routes.ts
//
// STR-01 cohort 21: session mutation/lifecycle routes migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler bodies below preserve the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. Every legacy
// block here gated on path and method in the same `if` condition or branched
// by method inside a path match that otherwise fell through to the terminal
// 404; RouteTable's method-scoped matching preserves that by leaving other
// methods unregistered.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { bobbitStateDir } from "../bobbit-dir.js";
import { buildStaffSystemPrompt } from "../agent/role-prompt.js";
import { sessionFsContextForAgentFile } from "../agent/session-fs.js";
import { resolveWorktreeSupport } from "../agent/worktree-support.js";
import { getRepoRoot, isGitRepo } from "../skills/git.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

// DELETE /api/sessions/:id
async function handleDeleteSession(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager, url } = ctx;
	const id = params.id;
	const purge = url.searchParams.get("purge") === "true";
	// Check if it's an archived session — purge immediately
	const archivedSession = sessionManager.getArchivedSession(id);
	if (archivedSession) {
		await sessionManager.purgeArchivedSession(id);
		json({ ok: true });
		return;
	}
	const terminated = await sessionManager.terminateSession(id);
	if (!terminated) {
		// Session not live. It may still exist as a dormant / store-only entry
		// (e.g. a completed delegate parent, or a parent that went dormant after
		// a restart). Archiving such a parent MUST still cascade-reap its children
		// (design §6 — the "parent dormant/not-live" path), so route it through the
		// cascade-archive seam regardless of `purge` rather than 404-ing without
		// archiving. `terminateSession` already cascades for the live case.
		const persisted = sessionManager.getPersistedSession(id);
		if (!persisted) {
			// Truly unknown — not live, not in any store.
			json({ error: "Session not found" }, 404);
			return;
		}
		// storeArchive → archiveWithCascade → cascadeReapOwner(children) then archive,
		// so the dormant parent's live children are reaped before it is archived.
		await sessionManager.storeArchive(id);
		if (purge) {
			await sessionManager.purgeArchivedSession(id);
		}
		json({ ok: true });
		return;
	}
	// If purge requested, also purge the now-archived session immediately
	if (purge) {
		await sessionManager.purgeArchivedSession(id);
	}
	json({ ok: true });
	return;
}

// POST /api/sessions/:id/fork — fork a live plain session: clone the source
// transcript (and tool-content / proposal drafts) into a fresh session and
// preserve its project/goal/task/model/role context. The caller chooses
// whether to spin up a new worktree (default) or reuse the source's worktree.
async function handleForkSession(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		isUnsupportedForkSource,
		json,
		jsonError,
		projectRegistry,
		readBody,
		req,
		resolveRoleForProject,
		roleCreateOptions,
		roleManager,
		sandboxManager,
		sessionManager,
		staffManager,
	} = ctx;
	const sourceId = params.id;
	const forkBody = await readBody(req).catch(() => ({} as any));
	// Default to a NEW worktree when the flag is omitted.
	const newWorktree = forkBody?.newWorktree === undefined ? true : !!forkBody.newWorktree;

	const source = sessionManager.getSession(sourceId);
	const ps = sessionManager.getPersistedSession(sourceId);
	if (!ps) { json({ error: "session not found" }, 404); return; }
	if (ps.archived) { json({ error: "archived sessions cannot be forked" }, 422); return; }
	if (!source) { json({ error: "only live sessions can be forked" }, 422); return; }

	const unsupported = isUnsupportedForkSource(source, ps);
	if (unsupported) { json({ error: unsupported }, 422); return; }

	const projectId = ps.projectId || source.projectId;
	if (!projectId || !projectRegistry.get(projectId)) {
		json({ error: "source project no longer registered" }, 410);
		return;
	}

	const goal = ps.goalId ? getGoalAcrossProjects(ps.goalId) : undefined;
	if (ps.goalId && !goal) { json({ error: "source goal not found" }, 410); return; }
	if (goal?.state === "todo") {
		await getGoalManagerForGoal(goal.id).updateGoal(goal.id, { state: "in-progress" });
	}

	const { sessionFileCopy, CrossRealmCopyError } = await import("../agent/session-fs.js");
	const { formatAgentSessionFilePath } = await import("../agent/agent-session-path.js");
	const { copyToolContentDirIfPresent, copyProposalDirIfPresent, cleanupFailedContinue } = await import("../agent/continue-archived.js");

	// Resolve the source `.jsonl`, with the recovery-scan fallback for legacy
	// rows that never persisted `agentSessionFile`.
	let sourceJsonl = ps.agentSessionFile;
	if (!sourceJsonl) {
		const recovered = sessionManager.recoverSessionFile(ps);
		if (recovered) sourceJsonl = recovered;
	}
	if (!sourceJsonl) { json({ error: "source transcript missing or empty" }, 404); return; }
	if (!ps.sandboxed) {
		try {
			const st = fs.statSync(sourceJsonl);
			if (!st.isFile() || st.size === 0) { json({ error: "source transcript missing or empty" }, 404); return; }
		} catch {
			json({ error: "source transcript missing or empty" }, 404);
			return;
		}
	}

	const projCwd = projectRegistry.get(projectId)!.rootPath;
	// Worktree choice:
	//  • newWorktree=true  → create a fresh worktree/branch off the project repo
	//    (or a plain project-root session when the project isn't a git repo),
	//    matching the Continue-Archived flow.
	//  • newWorktree=false → reuse the source's existing worktree directly. Two
	//    live sessions intentionally share the tree, so we deliberately do NOT
	//    register worktree metadata on the fork — terminating either session
	//    must never tear down the shared worktree/branch.
	let sessionCwd: string;
	let worktreeOpts: { repoPath: string } | undefined;
	if (newWorktree) {
		sessionCwd = projCwd;
		try {
			if (await isGitRepo(projCwd)) worktreeOpts = { repoPath: await getRepoRoot(projCwd) };
		} catch { /* not a git repo — plain project-root session */ }
	} else {
		// Prefer the source's own cwd when it has no worktree so a standalone
		// non-worktree session keeps its working directory instead of landing
		// in the project root.
		sessionCwd = ps.worktreePath || ps.cwd || projCwd;
		worktreeOpts = undefined;
	}

	const forkId = randomUUID();
	// Use the project root for the cloned `.jsonl` slug (same as /continue);
	// worktree-backed sessions rotate to the final cwd-derived file after the
	// worktree is ready, adopting this clone via switch_session.
	const destJsonl = formatAgentSessionFilePath(projCwd, Date.now(), forkId);

	const srcCtx = sessionFsContextForAgentFile(ps, sourceJsonl);
	const dstCtx = sessionFsContextForAgentFile({ sandboxed: !!ps.sandboxed, projectId }, destJsonl);
	try {
		await sessionFileCopy(srcCtx, sourceJsonl, dstCtx, destJsonl, sandboxManager ?? null);
	} catch (err) {
		if (err instanceof CrossRealmCopyError) { json({ error: "cross-realm fork not supported" }, 422); return; }
		cleanupFailedContinue(destJsonl, forkId, bobbitStateDir());
		jsonError(500, err, { error: `failed to clone session file: ${err instanceof Error ? err.message : String(err)}` });
		return;
	}
	try { copyToolContentDirIfPresent(sourceId, forkId, bobbitStateDir()); } catch (err) {
		console.warn(`[fork] tool-content copy failed (non-fatal): ${err}`);
	}
	try { copyProposalDirIfPresent(sourceId, forkId, bobbitStateDir()); } catch (err) {
		console.warn(`[fork] proposal-dir copy failed (non-fatal): ${err}`);
	}

	const oldTranscriptCwds = Array.from(new Set([ps.cwd, ps.worktreePath, source.cwd]
		.filter((v): v is string => typeof v === "string" && v.length > 0)));
	const createOpts: any = {
		sessionId: forkId,
		projectId,
		sandboxed: !!ps.sandboxed,
		worktreeOpts,
		preExistingAgentSessionFile: destJsonl,
		preExistingAgentSessionOldCwds: oldTranscriptCwds,
		taskId: ps.taskId,
		reattemptGoalId: ps.reattemptGoalId,
		staffId: ps.staffId,
		allowedTools: ps.allowedTools,
	};
	if (ps.modelProvider && ps.modelId) createOpts.initialModel = `${ps.modelProvider}/${ps.modelId}`;
	if (ps.sandboxed && !worktreeOpts && !ps.goalId && !ps.assistantType) {
		createOpts.sandboxBranch = `session/${forkId.slice(0, 8)}`;
	}

	const staff = ps.staffId ? staffManager.getStaff(ps.staffId) : undefined;
	if (staff) {
		createOpts.rolePrompt = buildStaffSystemPrompt(staff, roleManager, resolveRoleForProject);
		createOpts.roleName = staff.roleId;
		createOpts.accessory = staff.accessory;
		createOpts.env = { BOBBIT_STAFF_ID: ps.staffId };
	} else {
		const role = ps.role ? resolveRoleForProject(ps.role, projectId) : undefined;
		if (role) {
			const opts = roleCreateOptions(role);
			if (createOpts.initialModel) delete opts.initialModel;
			Object.assign(createOpts, opts);
		} else if (ps.role) {
			createOpts.role = ps.role;
			createOpts.roleName = ps.role;
			if (ps.accessory) createOpts.accessory = ps.accessory;
		} else if (ps.accessory) {
			createOpts.accessory = ps.accessory;
		}
	}

	try {
		const fork = await sessionManager.createSession(sessionCwd, undefined, ps.goalId, ps.assistantType, createOpts);
		const baseTitle = (ps.title || source.title || "session").trim() || "session";
		const title = `Fork: ${baseTitle}`;
		sessionManager.setTitle(fork.id, title, { markGenerated: true });
		if (ps.staffId) fork.staffId = ps.staffId;

		json({
			id: fork.id,
			cwd: fork.cwd,
			status: fork.status,
			projectId,
			goalId: ps.goalId,
			title,
		}, 201);
	} catch (err) {
		cleanupFailedContinue(destJsonl, forkId, bobbitStateDir());
		jsonError(500, err, { error: `failed to fork session: ${err instanceof Error ? err.message : String(err)}` });
	}
	return;
}

// ── SUB-GOAL B SEAM (orchestration-core §6.1) ──────────────────────────────
// GET /api/sessions/:id/children-count — child agents that would be
// cascade-archived if this (non-goal) session is archived. Enumerated with
// the SAME predicate AND the SAME source set `cascadeReapOwner` uses: ALL
// live persisted sessions across projects (`getAllLiveSessions()`), NOT just
// in-memory ones — so DORMANT persisted children (e.g. delegate children
// deferred on boot, archived by the cascade only at runtime) are included in
// the count and the listed names. The modal lists these before the user
// confirms. The goal-archival path enumerates affected sessions separately
// and is untouched.
function handleChildrenCount(ctx: CoreRouteCtx, params: Record<string, string>): void {
	const { json, projectContextManager, sessionManager } = ctx;
	const id = decodeURIComponent(params.id);
	// Prefer the cross-project persisted source (mirrors cascadeReapOwner's
	// `getAllLiveSessions()` enumeration, which includes dormant children);
	// fall back to in-memory sessions when no project context is available.
	const source = projectContextManager
		? projectContextManager.getAllLiveSessions()
		: sessionManager.listSessions();
	const seen = new Set<string>();
	const children: Array<{ id: string; title: string; childKind?: string }> = [];
	for (const s of source) {
		if (s.id === id || seen.has(s.id)) continue;
		if (s.delegateOf === id || (!!s.childKind && s.parentSessionId === id)) {
			seen.add(s.id);
			children.push({ id: s.id, title: s.title, childKind: s.childKind });
		}
	}
	json({ count: children.length, children });
	return;
}
// ───────────────────────────────────────────────────────────────────────────

// POST /api/sessions/:archivedId/continue — Continue-Archived (lossless)
//
// Clones the archived session's `.jsonl` into a fresh slot, registers it
// as the new session's `agentSessionFile`, and lets the agent CLI rehydrate
// from it via `switch_session` — same mechanism the restart-resume path
// uses for live sessions. No transcript stringification, no system-prompt
// seeding, no byte budget.
async function handleContinueSession(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const {
		json,
		jsonError,
		projectContextManager,
		projectRegistry,
		readBody,
		req,
		resolveRoleForProject,
		roleCreateOptions,
		sandboxManager,
		sessionManager,
	} = ctx;
	const archivedId = params.id;
	// Body is read for parity but no fields are required — the legacy `mode`
	// parameter is ignored.
	await readBody(req).catch(() => ({}));

	// Resolve the archived session across all project contexts.
	const ps = sessionManager.getPersistedSession(archivedId);
	if (!ps) { json({ error: "session not found" }, 404); return; }
	if (!ps.archived) { json({ error: "source not archived" }, 409); return; }
	if (ps.goalId || ps.delegateOf || ps.teamGoalId) {
		json({ error: "goal, delegate, or team sessions cannot be continued" }, 422);
		return;
	}
	if (!ps.projectId || !projectRegistry.get(ps.projectId)) {
		json({ error: "source project no longer registered" }, 410);
		return;
	}

	// Resolve source `.jsonl` path — fall back to the recovery scan for legacy
	// sessions whose persisted `agentSessionFile` was never populated.
	const { sessionFileCopy, CrossRealmCopyError } = await import("../agent/session-fs.js");
	const { formatAgentSessionFilePath } = await import("../agent/agent-session-path.js");
	const { copyToolContentDirIfPresent, copyProposalDirIfPresent, cleanupFailedContinue } = await import("../agent/continue-archived.js");
	const nodeFs = await import("node:fs");
	const { randomUUID } = await import("node:crypto");

	let sourceJsonl = ps.agentSessionFile;
	if (!sourceJsonl) {
		const recovered = sessionManager.recoverSessionFile(ps);
		if (recovered) sourceJsonl = recovered;
	}
	if (!sourceJsonl) {
		json({ error: "archived transcript missing or empty" }, 404);
		return;
	}

	// Verify the source file actually exists and is non-empty. For non-sandboxed
	// sessions a quick host-side stat suffices; sandboxed sessions defer to the
	// copy step (which surfaces the failure as a 500). Empty / missing → 404.
	if (!ps.sandboxed) {
		try {
			const st = nodeFs.statSync(sourceJsonl);
			if (!st.isFile() || st.size === 0) {
				json({ error: "archived transcript missing or empty" }, 404);
				return;
			}
		} catch {
			json({ error: "archived transcript missing or empty" }, 404);
			return;
		}
	}

	const proj = projectRegistry.get(ps.projectId)!;
	const projCwd = proj.rootPath;
	const wantWorktree = !!ps.worktreePath;
	let worktreeOpts: { repoPath: string } | undefined;
	if (wantWorktree) {
		const projCtx = projectContextManager.getOrCreate(ps.projectId);
		const components = projCtx?.projectConfigStore.getComponents() ?? [];
		const configuredBaseRef = projCtx?.projectConfigStore.get("base_ref") || undefined;
		const support = await resolveWorktreeSupport(components, proj.rootPath, projCwd, undefined, { configuredBaseRef });
		if (!support.supported || !support.repoPath) {
			json({
				error: "failed to resolve current project repository for fresh continue worktree creation: project does not currently support git worktrees",
			}, 500);
			return;
		}
		worktreeOpts = { repoPath: support.repoPath };
	}

	// Pre-compute the cloned `.jsonl` path. We use the project root cwd here;
	// for worktree-backed sessions the agent CLI will rotate to a new file
	// once the worktree cwd is final, but the cloned file we hand it via
	// `switch_session` is what gets adopted.
	const newSessionId = randomUUID();
	const destJsonl = formatAgentSessionFilePath(projCwd, Date.now(), newSessionId);

	// Copy the source `.jsonl`. Cross-realm → 422; any other failure → 500.
	const srcCtx = sessionFsContextForAgentFile(ps, sourceJsonl);
	const dstCtx = sessionFsContextForAgentFile(ps, destJsonl);
	try {
		await sessionFileCopy(srcCtx, sourceJsonl, dstCtx, destJsonl, sandboxManager ?? null);
	} catch (err) {
		if (err instanceof CrossRealmCopyError) {
			json({ error: "cross-realm continue not supported" }, 422);
			return;
		}
		cleanupFailedContinue(destJsonl, newSessionId, bobbitStateDir());
		jsonError(500, err, { error: `failed to clone session file: ${err instanceof Error ? err.message : String(err)}` });
		return;
	}

	// Defensive forward-compat: copy the lazy tool-content cache if present.
	try {
		copyToolContentDirIfPresent(archivedId, newSessionId, bobbitStateDir());
	} catch (err) {
		console.warn(`[continue-archived] tool-content copy failed (non-fatal): ${err}`);
	}

	// Clone the proposal-draft directory (live file + history snapshots).
	// Schema-agnostic recursive copy — see `proposal-files.ts` for layout.
	// On WS auth the rehydrate broadcast iterates the new session's dir and
	// feeds the panel automatically; no extra wiring needed here.
	try {
		copyProposalDirIfPresent(archivedId, newSessionId, bobbitStateDir());
	} catch (err) {
		console.warn(`[continue-archived] proposal-dir copy failed (non-fatal): ${err}`);
	}

	const role = ps.role ? resolveRoleForProject(ps.role, ps.projectId) : undefined;
	const oldTranscriptCwds = Array.from(new Set([ps.cwd, ps.worktreePath]
		.filter((v): v is string => typeof v === "string" && v.length > 0)));
	const createOpts: any = {
		sessionId: newSessionId,
		projectId: ps.projectId,
		sandboxed: !!ps.sandboxed,
		worktreeOpts,
		preExistingAgentSessionFile: destJsonl,
		preExistingAgentSessionOldCwds: oldTranscriptCwds,
		// Continue must surface fresh worktree/base-ref setup failures synchronously;
		// the archived source worktree/branch remain provenance only. Non-sandboxed
		// continues use the normal project worktree-pool claim/fallback path; sandboxed
		// continues keep bypassing the host-side pool because container worktrees are isolated.
		awaitWorktreeSetup: !!worktreeOpts,
		bypassWorktreePool: !!worktreeOpts && !!ps.sandboxed,
	};
	// Pin the persisted model at spawn time so pi-coding-agent doesn't emit a
	// redundant initial `model_change` event with its hardcoded default.
	if (ps.modelProvider && ps.modelId) {
		createOpts.initialModel = `${ps.modelProvider}/${ps.modelId}`;
	}
	if (role) {
		const opts = roleCreateOptions(role);
		if (createOpts.initialModel) delete opts.initialModel;
		Object.assign(createOpts, opts);
	} else if (ps.role) {
		// Persisted role name without a registered Role definition (e.g. the
		// generic "assistant" role assigned to assistant sessions). Propagate
		// it + the persisted accessory so the new session inherits its identity.
		createOpts.role = ps.role;
		createOpts.roleName = ps.role;
		if (ps.accessory) createOpts.accessory = ps.accessory;
	} else if (ps.accessory) {
		createOpts.accessory = ps.accessory;
	}

	let newSession;
	try {
		newSession = await sessionManager.createSession(
			projCwd, undefined, undefined, ps.assistantType, createOpts,
		);
	} catch (err) {
		const failedRecord = sessionManager.getPersistedSession(newSessionId);
		cleanupFailedContinue(failedRecord?.agentSessionFile || destJsonl, newSessionId, bobbitStateDir());
		if (failedRecord?.agentSessionFile && failedRecord.agentSessionFile !== destJsonl) {
			cleanupFailedContinue(destJsonl, newSessionId, bobbitStateDir());
		}
		jsonError(500, err, { error: `failed to create session: ${err instanceof Error ? err.message : String(err)}` });
		return;
	}

	const baseTitle = (ps.title || "session").trim() || "session";
	const continuedTitle = `Continued: ${baseTitle}`;
	// markGenerated: prevents the first-message auto-titler from overwriting
	// "Continued: …" once the user sends their first prompt in the new session.
	sessionManager.setTitle(newSession.id, continuedTitle, { markGenerated: true });

	json({
		id: newSession.id,
		cwd: newSession.cwd,
		status: newSession.status,
		title: continuedTitle,
		assistantType: ps.assistantType,
	}, 201);
	return;
}

// GET /api/sessions/:id/output — get final assistant output
async function handleSessionOutput(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager } = ctx;
	const id = params.id;
	try {
		const output = await sessionManager.getSessionOutput(id);
		json({ output });
	} catch {
		json({ error: "Failed to get output" }, 500);
	}
	return;
}

// PATCH /api/sessions/:id — update session properties (title, colorIndex, etc.)
async function handlePatchSession(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { broadcastToAll, colorStore, json, jsonError, readBody, req, resolveRoleForProject, sessionManager } = ctx;
	const id = params.id;
	const body = await readBody(req);
	if (!body || typeof body !== "object") {
		json({ error: "Invalid body" }, 400);
		return;
	}

	if (typeof body.title === "string") {
		const ok = sessionManager.setTitle(id, body.title);
		if (!ok) { json({ error: "Session not found" }, 404); return; }
	}

	if (typeof body.colorIndex === "number") {
		if (body.colorIndex < 0 || body.colorIndex > 13) {
			json({ error: "colorIndex must be 0-13" }, 400);
			return;
		}
		colorStore.set(id, body.colorIndex);
	}

	if (typeof body.projectId === "string") {
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const oldProjectId = session.projectId;
		const newProjectId = body.projectId || undefined;
		session.projectId = newProjectId;
		// Update in both old and new project stores to ensure consistency
		sessionManager.getSessionStore(oldProjectId).update(id, { projectId: newProjectId });
		if (newProjectId !== oldProjectId) {
			sessionManager.getSessionStore(newProjectId).update(id, { projectId: newProjectId });
		}
	}

	if (typeof body.preview === "boolean") {
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		session.preview = body.preview;
		sessionManager.persistSessionMetadata(session).catch(() => {});
		broadcastToAll({ type: "preview_changed", sessionId: id, preview: body.preview });
	}

	if (typeof body.roleId === "string" && body.roleId !== "") {
		const session = sessionManager.getSession(id);
		const ps = sessionManager.getPersistedSession(id);
		const role = resolveRoleForProject(body.roleId, session?.projectId ?? ps?.projectId);
		if (!role) { json({ error: `Role "${body.roleId}" not found` }, 404); return; }
		try {
			const ok = await sessionManager.assignRole(id, role);
			if (!ok) { json({ error: "Session not found" }, 404); return; }
		} catch (err) {
			jsonError(400, err);
			return;
		}
	} else if (typeof body.roleId === "string" && body.roleId === "") {
		// Clear role assignment
		const session = sessionManager.getSession(id);
		if (session) {
			session.role = undefined;
			session.accessory = undefined;
			sessionManager.persistSessionMetadata(session).catch(() => {});
		}
	}

	if (typeof body.assistantType === "string" || typeof body.goalAssistant === "boolean" || typeof body.goalId === "string") {
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (typeof body.assistantType === "string") session.assistantType = body.assistantType || undefined;
		else if (typeof body.goalAssistant === "boolean") session.assistantType = body.goalAssistant ? "goal" : undefined;
		if (typeof body.goalId === "string") session.goalId = body.goalId;
		sessionManager.persistSessionMetadata(session).catch(() => {});
	}

	if (typeof body.accessory === "string") {
		const session = sessionManager.getSession(id);
		if (session) {
			session.accessory = body.accessory || undefined;
			sessionManager.persistSessionMetadata(session).catch(() => {});
		}
	}

	if (typeof body.delegateOf === "string") {
		const session = sessionManager.getSession(id);
		if (session) {
			session.delegateOf = body.delegateOf || undefined;
			sessionManager.updateSessionMeta(id, { delegateOf: body.delegateOf || undefined });
		} else {
			sessionManager.updateSessionMeta(id, { delegateOf: body.delegateOf || undefined });
		}
	}


	if (typeof body.teamLeadSessionId === "string") {
		// Update teamLeadSessionId — works for both live and archived sessions
		const session = sessionManager.getSession(id);
		if (session) {
			sessionManager.updateSessionMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
		} else {
			// Try archived session — update store directly
			const archived = sessionManager.getArchivedSession(id);
			if (archived) {
				sessionManager.updateArchivedMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
			} else {
				json({ error: "Session not found" }, 404); return;
			}
		}
	}

	if (body.archived === true) {
		// Try to terminate live session first (which archives it)
		const session = sessionManager.getSession(id);
		if (session) {
			try { await sessionManager.terminateSession(id); } catch {}
		} else {
			// Dormant/store-only session — archive directly in the store
			await sessionManager.storeArchive(id);
		}
	}

	json({ ok: true });
	return;
}

// POST /api/sessions/:id/mark-read — record that the user viewed this session
function handleMarkRead(ctx: CoreRouteCtx, params: Record<string, string>): void {
	const { json, sessionManager } = ctx;
	const id = params.id;
	const ok = sessionManager.markSessionRead(id);
	if (!ok) { json({ error: "session not found" }, 404); return; }
	json({ ok: true });
	return;
}

// POST /api/sessions/:id/generate-title — auto-generate a title from chat history.
// Works for live sessions (calls SessionManager.autoGenerateTitle) and archived
// sessions (parses .jsonl). Used by the rename dialog when the session is not
// the currently focused one (no live WebSocket).
async function handleGenerateTitle(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, sessionManager } = ctx;
	const id = params.id;
	try {
		const title = await sessionManager.generateTitleForAnySession(id);
		if (!title) {
			json({ error: "Could not generate title (session not found or no messages)" }, 404);
			return;
		}
		json({ title });
	} catch (err) {
		json({ error: String((err as Error)?.message ?? err) }, 500);
	}
	return;
}

// PUT /api/sessions/:id/title — legacy rename endpoint
async function handlePutTitle(ctx: CoreRouteCtx, params: Record<string, string>): Promise<void> {
	const { json, readBody, req, sessionManager } = ctx;
	const id = params.id;
	const body = await readBody(req);
	const title = body?.title;
	if (!title || typeof title !== "string") {
		json({ error: "Missing title" }, 400);
		return;
	}
	const ok = sessionManager.setTitle(id, title);
	if (!ok) {
		json({ error: "Session not found" }, 404);
		return;
	}
	json({ ok: true });
	return;
}

export function registerSessionMutationRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("DELETE", "/api/sessions/:id", handleDeleteSession);
	table.register("POST", "/api/sessions/:id/fork", handleForkSession);
	table.register("GET", "/api/sessions/:id/children-count", handleChildrenCount);
	table.register("POST", "/api/sessions/:id/continue", handleContinueSession);
	table.register("GET", "/api/sessions/:id/output", handleSessionOutput);
	table.register("PATCH", "/api/sessions/:id", handlePatchSession);
	table.register("POST", "/api/sessions/:id/mark-read", handleMarkRead);
	table.register("POST", "/api/sessions/:id/generate-title", handleGenerateTitle);
	table.register("PUT", "/api/sessions/:id/title", handlePutTitle);
}
