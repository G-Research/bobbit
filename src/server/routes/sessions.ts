/**
 * Sessions core routes — list, single GET (with archived branch), simple GET
 * (live-only), DELETE, PATCH, /wait, /activate-skill, /tool-grant-request.
 * Plus /api/search.
 *
 * Extracted from server.ts (commit: split server.ts).
 *
 * The POST /api/sessions creation handler and POST /:archivedId/continue stay
 * in server.ts for now — both are tightly coupled to delegate-spawn / lossless-
 * resume plumbing worth a dedicated follow-up commit.
 */
import { getSlashSkill, buildSlashSkillPrompt } from "../skills/slash-skills.js";
import { buildActivationHeader } from "../skills/skill-manifest.js";
import { isGitRepo, getRepoRoot } from "../skills/git.js";
import { bobbitStateDir } from "../bobbit-dir.js";
import type { Route } from "./types.js";

// BFS helper: walk delegateOf, teamLeadSessionId, teamGoalId, and goalId chains
// from seed IDs through an archived session pool.
function bfsEnrichArchived(seedIds: string[], allArchived: any[]): any[] {
	const result: any[] = [];
	const seen = new Set<string>();
	const queue = [...seedIds];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		for (const s of allArchived) {
			if (!seen.has(s.id) && (
				s.delegateOf === parentId ||
				s.teamLeadSessionId === parentId ||
				s.teamGoalId === parentId ||
				s.goalId === parentId
			)) {
				seen.add(s.id);
				result.push(s);
				queue.push(s.id);
			}
		}
	}
	return result;
}

export const sessionsRoutes: Route[] = [
	{
		method: "GET",
		pattern: "/api/search",
		handler: async ({ deps, url, json }) => {
			const q = url.searchParams.get("q");
			if (!q) {
				json({ error: "Missing query parameter 'q'" }, 400);
				return;
			}
			const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10) || 20), 100);
			const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
			const typeParam = url.searchParams.get("type") || "all";
			const validTypes = new Set(["all", "goals", "sessions", "messages", "staff"]);
			const type = validTypes.has(typeParam) ? typeParam as "all" | "goals" | "sessions" | "messages" | "staff" : "all";
			try {
				const projectId = url.searchParams.get("projectId") || undefined;
				const projectNames = new Map(deps.projectRegistry.list().map(p => [p.id, p.name]));
				const results = await deps.projectContextManager.searchAll(q, { type, limit, offset, projectId, projectNames });
				json(results);
			} catch (err) {
				json({ error: `Search failed: ${err}` }, 500);
			}
		},
	},
	{
		method: "GET",
		pattern: "/api/sessions",
		handler: ({ deps, url, json }) => {
			const { projectContextManager, projectRegistry, sessionManager, colorStore } = deps;
			const currentGen = projectContextManager.getSessionGeneration();
			const sinceParam = url.searchParams.get("since");
			if (sinceParam !== null) {
				const since = parseInt(sinceParam, 10);
				if (!isNaN(since) && since === currentGen) {
					json({ generation: currentGen, changed: false });
					return;
				}
			}
			const filterProjectId = url.searchParams.get("projectId") || undefined;
			const registeredProjectIds = new Set(projectRegistry.list().map(p => p.id));
			let sessions = sessionManager.listSessions().map((s) => ({
				...s,
				colorIndex: colorStore.get(s.id),
			})).filter(s => !s.projectId || registeredProjectIds.has(s.projectId));
			if (filterProjectId) {
				sessions = sessions.filter(s => s.projectId === filterProjectId);
			}
			if (url.searchParams.get("include") === "archived") {
				const allArchived: typeof sessions = [];
				for (const ctx of projectContextManager.all()) {
					const store = ctx.sessionStore;
					for (const s of store.getArchived()) {
						allArchived.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" } as any);
					}
				}
				allArchived.sort((a: any, b: any) => ((b as any).archivedAt ?? 0) - ((a as any).archivedAt ?? 0));
				const filteredArchived = filterProjectId
					? allArchived.filter((s: any) => s.projectId === filterProjectId)
					: allArchived;

				const allArchivedForBfs: typeof sessions = [];
				for (const ctx of projectContextManager.all()) {
					for (const s of ctx.sessionStore.getArchived()) {
						allArchivedForBfs.push({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any);
					}
				}
				const liveGoalIds: string[] = [];
				for (const ctx of projectContextManager.all()) {
					for (const g of ctx.goalStore.getLive()) {
						if (!g.archived) liveGoalIds.push(g.id);
					}
				}

				const limitParam = url.searchParams.get("limit");
				const afterParam = url.searchParams.get("after");
				if (limitParam) {
					const limit = Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 200);
					const afterCursor = afterParam ? parseInt(afterParam, 10) : undefined;
					let page = filteredArchived;
					if (afterCursor !== undefined) {
						page = page.filter((s: any) => ((s as any).archivedAt ?? 0) < afterCursor);
					}
					const total = filteredArchived.length;
					const hasMore = page.length > limit;
					const sliced = page.slice(0, limit);
					const nextCursor = sliced.length > 0 ? (sliced[sliced.length - 1] as any).archivedAt : undefined;

					const liveIdSet = new Set(sessions.map(s => s.id));
					const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

					json({ generation: currentGen, sessions: [...sessions, ...sliced], total, hasMore, nextCursor, archivedDelegates: archivedDelegatesOfLive });
				} else {
					const liveIdSet = new Set(sessions.map(s => s.id));
					const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

					json({ generation: currentGen, sessions: [...sessions, ...filteredArchived], archivedDelegates: archivedDelegatesOfLive });
				}
			} else {
				const liveIdSet = new Set(sessions.map(s => s.id));
				const allArchivedForBfsNonPaginated: typeof sessions = [];
				for (const ctx of projectContextManager.all()) {
					for (const s of ctx.sessionStore.getArchived()) {
						allArchivedForBfsNonPaginated.push({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any);
					}
				}
				const liveGoalIdsNonPaginated: string[] = [];
				for (const ctx of projectContextManager.all()) {
					for (const g of ctx.goalStore.getLive()) {
						if (!g.archived) liveGoalIdsNonPaginated.push(g.id);
					}
				}
				const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIdsNonPaginated], allArchivedForBfsNonPaginated);
				json({ generation: currentGen, sessions, archivedDelegates: archivedDelegatesOfLive });
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/activate-skill$/,
		handler: async ({ deps, params, readBody, json }) => {
			const sessionId = params[1];
			const session = deps.sessionManager.getSession(sessionId);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			const body = await readBody();
			const skillName = typeof body?.name === "string" ? body.name : "";
			const skillArgs = typeof body?.args === "string" ? body.args : "";
			if (!skillName) {
				json({ error: "name is required" }, 400);
				return;
			}
			let resolvedConfigStore: { get(key: string): string | undefined } | undefined = deps.projectConfigStore;
			let skillCwd = session.cwd;
			if (session.projectId) {
				const ctx = deps.projectContextManager.getOrCreate(session.projectId);
				if (ctx) {
					resolvedConfigStore = ctx.projectConfigStore;
					if (session.sandboxed) skillCwd = ctx.project.rootPath;
				}
			}
			const skill = getSlashSkill(skillCwd, skillName, resolvedConfigStore);
			if (!skill) {
				json({ error: `Skill "${skillName}" not found` }, 404);
				return;
			}
			if (skill.disableModelInvocation === true) {
				json({ error: `Skill "${skillName}" has disable-model-invocation: true and cannot be activated by the model` }, 403);
				return;
			}
			const pathRewrite = session.sandboxed
				? (hostPath: string): string | null => {
					const projectRoot = (session.projectId
						? deps.projectContextManager.getOrCreate(session.projectId)?.project.rootPath
						: undefined);
					const normHost = hostPath.replace(/\\/g, "/");
					const normProj = projectRoot ? projectRoot.replace(/\\/g, "/") : null;
					const sessionCwdNorm = session.cwd.replace(/\\/g, "/");
					for (const candidate of [normProj, sessionCwdNorm]) {
						if (candidate && (normHost === candidate || normHost.startsWith(candidate + "/"))) {
							const rel = normHost.slice(candidate.length).replace(/^\/+/, "");
							return "/workspace" + (rel ? "/" + rel : "");
						}
					}
					return null;
				}
				: undefined;
			const skillBody = buildSlashSkillPrompt(skill, skillArgs);
			const expanded = buildActivationHeader(skill, pathRewrite) + skillBody;
			json({ ok: true, expanded, source: skill.source, filePath: skill.filePath });
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/tool-grant-request$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const sessionId = params[1];
			const body = await readBody();
			if (!body || !body.toolName || !body.toolGroup) {
				json({ error: "toolName and toolGroup required" }, 400);
				return;
			}
			try {
				const result = await deps.sessionManager.requestToolGrant(sessionId, body.toolName, body.toolGroup);
				json(result);
			} catch (err: any) {
				jsonError(500, err);
			}
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/continue$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const { sessionManager, projectRegistry, sandboxManager, roleManager } = deps;
			const archivedId = params[1];
			await readBody().catch(() => ({}));

			const ps = sessionManager.getPersistedSession(archivedId);
			if (!ps) { json({ error: "session not found" }, 404); return; }
			if (!ps.archived) { json({ error: "source not archived" }, 409); return; }
			if (ps.goalId || ps.delegateOf || ps.teamGoalId || ps.assistantType) {
				json({ error: "goal, delegate, team, or assistant sessions cannot be continued" }, 422);
				return;
			}
			if (!ps.projectId || !projectRegistry.get(ps.projectId)) {
				json({ error: "source project no longer registered" }, 410);
				return;
			}

			const { sessionFileCopy, CrossRealmCopyError } = await import("../agent/session-fs.js");
			const { formatAgentSessionFilePath } = await import("../agent/agent-session-path.js");
			const { copyToolContentDirIfPresent, cleanupFailedContinue } = await import("../agent/continue-archived.js");
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
				try {
					if (await isGitRepo(projCwd)) {
						worktreeOpts = { repoPath: await getRepoRoot(projCwd) };
					}
				} catch { /* ignore */ }
			}

			const newSessionId = randomUUID();
			const destJsonl = formatAgentSessionFilePath(projCwd, Date.now(), newSessionId);

			const srcCtx = { sandboxed: !!ps.sandboxed, projectId: ps.projectId };
			const dstCtx = { sandboxed: !!ps.sandboxed, projectId: ps.projectId };
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

			try {
				copyToolContentDirIfPresent(archivedId, newSessionId, bobbitStateDir());
			} catch (err) {
				console.warn(`[continue-archived] tool-content copy failed (non-fatal): ${err}`);
			}

			const role = ps.role ? roleManager.getRole(ps.role) : undefined;
			const createOpts: any = {
				sessionId: newSessionId,
				projectId: ps.projectId,
				sandboxed: !!ps.sandboxed,
				worktreeOpts,
				preExistingAgentSessionFile: destJsonl,
				skipAutoModel: !!(ps.modelProvider && ps.modelId),
			};
			if (ps.modelProvider && ps.modelId) {
				createOpts.initialModel = `${ps.modelProvider}/${ps.modelId}`;
			}
			if (role) {
				createOpts.rolePrompt = role.promptTemplate;
				createOpts.roleName = role.name;
				createOpts.role = role.name;
				createOpts.accessory = role.accessory;
			}

			let newSession;
			try {
				newSession = await sessionManager.createSession(
					projCwd, undefined, undefined, undefined, createOpts,
				);
			} catch (err) {
				cleanupFailedContinue(destJsonl, newSessionId, bobbitStateDir());
				jsonError(500, err, { error: `failed to create session: ${err instanceof Error ? err.message : String(err)}` });
				return;
			}

			const baseTitle = (ps.title || "session").trim() || "session";
			const continuedTitle = `Continued: ${baseTitle}`;
			sessionManager.setTitle(newSession.id, continuedTitle, { markGenerated: true });

			if (ps.modelProvider && ps.modelId) {
				sessionManager.persistSessionModel(newSession.id, ps.modelProvider, ps.modelId);
			}

			json({
				id: newSession.id,
				cwd: newSession.cwd,
				status: newSession.status,
				title: continuedTitle,
			}, 201);
		},
	},
	{
		method: "POST",
		pattern: /^\/api\/sessions\/([^/]+)\/wait$/,
		handler: async ({ deps, params, readBody, res }) => {
			const id = params[1];
			const body = await readBody();
			const timeoutMs = body?.timeout_ms ?? 600_000;

			res.writeHead(200, {
				"Content-Type": "application/json",
				"Transfer-Encoding": "chunked",
				"Cache-Control": "no-cache",
			});

			const heartbeat = setInterval(() => {
				try { res.write("\n"); } catch { /* connection gone */ }
			}, 60_000);

			try {
				await deps.sessionManager.waitForIdle(id, timeoutMs);
				const output = await deps.sessionManager.getSessionOutput(id);
				const session = deps.sessionManager.getSession(id);
				res.end(JSON.stringify({
					status: session?.status || "idle",
					output,
				}));
			} catch (err) {
				res.end(JSON.stringify({ error: String(err) }));
			} finally {
				clearInterval(heartbeat);
			}
		},
	},
	// GET /api/sessions/:id — verbose payload (live or archived). Comes BEFORE
	// the simpler GET handler in registration order so it wins. Both share the
	// same regex pattern but the verbose one returns more fields; the simpler
	// one was the first handler to match this URL in legacy server.ts.
	{
		method: "GET",
		pattern: /^\/api\/sessions\/([^/]+)$/,
		handler: ({ deps, params, res, json }) => {
			const id = params[1];
			const { sessionManager, colorStore } = deps;
			const session = sessionManager.getSession(id);
			if (!session) {
				const archived = sessionManager.getArchivedSession(id);
				if (archived) {
					json({
						id: archived.id,
						title: archived.title,
						cwd: archived.cwd,
						projectId: archived.projectId,
						status: "archived",
						createdAt: archived.createdAt,
						lastActivity: archived.lastActivity,
						clientCount: 0,
						isCompacting: false,
						goalId: archived.goalId,
						assistantType: archived.assistantType,
						delegateOf: archived.delegateOf,
						role: archived.role,
						teamGoalId: archived.teamGoalId,
						teamLeadSessionId: archived.teamLeadSessionId,
						worktreePath: archived.worktreePath,
						taskId: archived.taskId,
						staffId: archived.staffId,
						colorIndex: colorStore.get(archived.id),
						preview: archived.preview,
						reattemptGoalId: archived.reattemptGoalId,
						archived: true,
						archivedAt: archived.archivedAt,
						imageGenerationModel: sessionManager.getImageModelForSession(archived.id),
					});
					return;
				}
				res.writeHead(404);
				res.end(JSON.stringify({ error: "Session not found" }));
				return;
			}
			const sessionPs = sessionManager.getSessionStore(session.projectId).get(session.id);
			json({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				status: session.status,
				createdAt: session.createdAt,
				lastActivity: session.lastActivity,
				clientCount: session.clients.size,
				isCompacting: session.isCompacting,
				goalId: session.goalId,
				assistantType: session.assistantType,
				goalAssistant: session.assistantType === "goal",
				roleAssistant: session.assistantType === "role",
				toolAssistant: session.assistantType === "tool",
				delegateOf: session.delegateOf,
				role: session.role,
				teamGoalId: session.teamGoalId,
				teamLeadSessionId: session.teamLeadSessionId,
				worktreePath: session.worktreePath,
				branch: session.branch ?? sessionPs?.branch,
				taskId: session.taskId,
				staffId: session.staffId,
				colorIndex: colorStore.get(session.id),
				preview: session.preview,
				reattemptGoalId: sessionPs?.reattemptGoalId,
				projectId: sessionPs?.projectId || session.projectId,
				modelProvider: sessionPs?.modelProvider,
				modelId: sessionPs?.modelId,
				restoreError: session.restoreError,
				lastTurnErrored: session.lastTurnErrored ?? false,
				consecutiveErrorTurns: session.consecutiveErrorTurns ?? 0,
				completedTurnCount: session.completedTurnCount ?? 0,
				imageGenerationModel: sessionManager.getImageModelForSession(session.id),
			});
		},
	},
	{
		method: "DELETE",
		pattern: /^\/api\/sessions\/([^/]+)$/,
		handler: async ({ deps, params, url, json }) => {
			const id = params[1];
			const purge = url.searchParams.get("purge") === "true";
			const archivedSession = deps.sessionManager.getArchivedSession(id);
			if (archivedSession) {
				await deps.sessionManager.purgeArchivedSession(id);
				json({ ok: true });
				return;
			}
			const terminated = await deps.sessionManager.terminateSession(id);
			if (!terminated) {
				if (purge) {
					deps.sessionManager.storeArchive(id);
					const purged = await deps.sessionManager.purgeArchivedSession(id);
					if (purged) {
						json({ ok: true });
						return;
					}
				}
				json({ error: "Session not found" }, 404);
				return;
			}
			if (purge) {
				await deps.sessionManager.purgeArchivedSession(id);
			}
			json({ ok: true });
		},
	},
	{
		method: "PATCH",
		pattern: /^\/api\/sessions\/([^/]+)$/,
		handler: async ({ deps, params, readBody, json, jsonError }) => {
			const { sessionManager, colorStore, roleManager, broadcastToAll } = deps;
			const id = params[1];
			const body = await readBody();
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
				const role = roleManager.getRole(body.roleId);
				if (!role) { json({ error: `Role "${body.roleId}" not found` }, 404); return; }
				try {
					const ok = await sessionManager.assignRole(id, role);
					if (!ok) { json({ error: "Session not found" }, 404); return; }
				} catch (err) {
					jsonError(400, err);
					return;
				}
			} else if (typeof body.roleId === "string" && body.roleId === "") {
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
				const session = sessionManager.getSession(id);
				if (session) {
					sessionManager.updateSessionMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
				} else {
					const archived = sessionManager.getArchivedSession(id);
					if (archived) {
						sessionManager.updateArchivedMeta(id, { teamLeadSessionId: body.teamLeadSessionId });
					} else {
						json({ error: "Session not found" }, 404); return;
					}
				}
			}

			if (body.archived === true) {
				const session = sessionManager.getSession(id);
				if (session) {
					try { await sessionManager.terminateSession(id); } catch {}
				} else {
					sessionManager.storeArchive(id);
				}
			}

			json({ ok: true });
		},
	},
];
