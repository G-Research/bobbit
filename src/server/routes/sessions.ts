import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../app-context.js";
import { readBody, json } from "./utils.js";
import { isGitRepo, getRepoRoot } from "../skills/git.js";
import { getPromptSections } from "../agent/system-prompt.js";
import fs from "node:fs";
import path from "node:path";
import { bobbitStateDir } from "../bobbit-dir.js";

export async function handle(
	ctx: AppContext,
	url: URL,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<boolean> {
	const { sessionManager, config, colorStore, roleManager, personalityManager, broadcastToAll } = ctx;

	// GET /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "GET") {
		const currentGen = sessionManager.getSessionStore().getGeneration();
		const sinceParam = url.searchParams.get("since");
		if (sinceParam !== null) {
			const since = parseInt(sinceParam, 10);
			if (!isNaN(since) && since === currentGen) {
				json(res, { generation: currentGen, changed: false });
				return true;
			}
		}
		const sessions = sessionManager.listSessions().map((s) => ({
			...s,
			colorIndex: colorStore.get(s.id),
		}));
		// Support ?include=archived to return archived sessions too
		if (url.searchParams.get("include") === "archived") {
			const archived = sessionManager.listArchivedSessions().map((s) => ({
				...s,
				colorIndex: colorStore.get(s.id),
			}));
			json(res, { generation: currentGen, sessions: [...sessions, ...archived] });
		} else {
			json(res, { generation: currentGen, sessions });
		}
		return true;
	}

	// GET /api/sessions/:id (exact match — not /api/sessions/:id/output etc.)
	const singleSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (singleSessionMatch && req.method === "GET") {
		const id = singleSessionMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) {
			// Check if it's an archived session
			const archived = sessionManager.getArchivedSession(id);
			if (archived) {
				json(res, {
					id: archived.id,
					title: archived.title,
					cwd: archived.cwd,
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
					personalities: archived.personalities,
					reattemptGoalId: archived.reattemptGoalId,
					archived: true,
					archivedAt: archived.archivedAt,
				});
				return true;
			}
			res.writeHead(404);
			res.end(JSON.stringify({ error: "Session not found" }));
			return true;
		}
		const sessionPs = sessionManager.getSessionStore().get(session.id);
		json(res, {
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
			// Legacy boolean fields for backward compat
			goalAssistant: session.assistantType === "goal",
			roleAssistant: session.assistantType === "role",
			toolAssistant: session.assistantType === "tool",
			delegateOf: session.delegateOf,
			role: session.role,
			teamGoalId: session.teamGoalId,
			teamLeadSessionId: session.teamLeadSessionId,
			worktreePath: session.worktreePath,
			taskId: session.taskId,
			staffId: session.staffId,
			colorIndex: colorStore.get(session.id),
			preview: session.preview,
			personalities: session.personalities,
			reattemptGoalId: sessionPs?.reattemptGoalId,
		});
		return true;
	}

	// POST /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const body = await readBody(req);

		// ── Delegate session creation ──
		if (body?.delegateOf && body?.instructions) {
			try {
				const cwd = body.cwd || config.defaultCwd;
				const session = await sessionManager.createDelegateSession(body.delegateOf, {
					instructions: body.instructions,
					cwd,
					title: body.title,
					context: body.context,
				});
				json(res, {
					id: session.id,
					cwd: session.cwd,
					status: session.status,
					delegateOf: session.delegateOf,
				}, 201);
			} catch (err) {
				json(res, { error: String(err) }, 500);
			}
			return true;
		}

		// ── Normal session creation ──
		const goalId = body?.goalId;

		// Accept both new assistantType and legacy boolean fields
		let assistantType = body?.assistantType as string | undefined;
		if (!assistantType) {
			if (body?.goalAssistant) assistantType = "goal";
			else if (body?.roleAssistant) assistantType = "role";
			else if (body?.toolAssistant) assistantType = "tool";
		}

		// If creating under a goal, use the goal's cwd as default
		let cwd = body?.cwd || config.defaultCwd;
		if (goalId) {
			const goal = sessionManager.goalManager.getGoal(goalId);
			if (goal) {
				cwd = body?.cwd || goal.cwd;
				// Auto-transition goal to in-progress when first session starts
				if (goal.state === "todo") {
					await sessionManager.goalManager.updateGoal(goalId, { state: "in-progress" });
				}
			}
		}

		const args = body?.args;

		// If a roleId is provided, look up the role and pass its prompt/tools/accessory
		const roleId = body?.roleId;
		let createOpts: { rolePrompt?: string; allowedTools?: string[]; personalities?: Array<{ label: string; promptFragment: string }>; personalityNames?: string[] } | undefined;
		let roleForMeta: { name: string; accessory: string } | undefined;

		if (roleId && typeof roleId === "string") {
			const role = roleManager.getRole(roleId);
			if (!role) {
				json(res, { error: `Role "${roleId}" not found` }, 404);
				return true;
			}
			createOpts = {
				rolePrompt: role.promptTemplate,
				allowedTools: role.allowedTools,
			};
			roleForMeta = { name: role.name, accessory: role.accessory };
		}

		// Resolve personalities
		const bodyPersonalities = Array.isArray(body?.personalities) ? body.personalities as string[] : undefined;
		let personalityNames: string[] | undefined;
		if (bodyPersonalities && bodyPersonalities.length > 0) {
			// Validate personality names
			const invalid = bodyPersonalities.filter(t => !personalityManager.getPersonality(t));
			if (invalid.length > 0) {
				json(res, { error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
				return true;
			}
			personalityNames = bodyPersonalities;
		} else if (roleForMeta) {
			// Use role's default personalities if no explicit personalities provided
			const role = roleManager.getRole(roleForMeta.name);
			if (role?.defaultPersonalities && role.defaultPersonalities.length > 0) {
				personalityNames = role.defaultPersonalities;
			}
		}

		if (personalityNames && personalityNames.length > 0) {
			const resolved = personalityManager.resolvePersonalities(personalityNames);
			createOpts = { ...createOpts, personalities: resolved, personalityNames };
		}

		// ── Worktree support ──
		let worktreeOpts: { repoPath: string } | undefined;
		if (body?.worktree && !assistantType) {
			try {
				if (await isGitRepo(cwd)) {
					const repoPath = await getRepoRoot(cwd);
					worktreeOpts = { repoPath };
				}
			} catch {
				// Not a git repo or git not available — silently ignore
			}
		}

		// ── Re-attempt support ──
		const reattemptGoalId = body?.reattemptGoalId as string | undefined;

		try {
			const session = await sessionManager.createSession(cwd, args, goalId, assistantType, { ...createOpts, worktreeOpts, reattemptGoalId });

			// Set role metadata if a role was specified
			if (roleForMeta) {
				sessionManager.updateSessionMeta(session.id, { role: roleForMeta.name, accessory: roleForMeta.accessory });
				session.role = roleForMeta.name;
				session.accessory = roleForMeta.accessory;
			} else if (assistantType) {
				sessionManager.updateSessionMeta(session.id, { role: "assistant", accessory: "wand" });
				session.role = "assistant";
				session.accessory = "wand";
			}

			// Store reattemptGoalId on the session if provided
			if (reattemptGoalId) {
				sessionManager.getSessionStore().update(session.id, { reattemptGoalId });
			}

			json(res, {
				id: session.id,
				cwd: session.cwd,
				status: session.status,
				goalId: session.goalId,
				assistantType: session.assistantType,
				// Legacy boolean fields for backward compat
				goalAssistant: session.assistantType === "goal",
				roleAssistant: session.assistantType === "role",
				toolAssistant: session.assistantType === "tool",
				role: session.role,
				accessory: session.accessory,
				personalities: session.personalities,
				reattemptGoalId,
			}, 201);
		} catch (err) {
			json(res, { error: String(err) }, 500);
		}
		return true;
	}

	// PATCH /api/sessions/:id — update session properties (title, colorIndex, etc.)
	const patchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (patchMatch && req.method === "PATCH") {
		const id = patchMatch[1];
		const body = await readBody(req);
		if (!body || typeof body !== "object") {
			json(res, { error: "Invalid body" }, 400);
			return true;
		}

		if (typeof body.title === "string") {
			const ok = sessionManager.setTitle(id, body.title);
			if (!ok) { json(res, { error: "Session not found" }, 404); return true; }
		}

		if (typeof body.colorIndex === "number") {
			if (body.colorIndex < 0 || body.colorIndex > 13) {
				json(res, { error: "colorIndex must be 0-13" }, 400);
				return true;
			}
			colorStore.set(id, body.colorIndex);
		}

		if (typeof body.preview === "boolean") {
			const session = sessionManager.getSession(id);
			if (!session) { json(res, { error: "Session not found" }, 404); return true; }
			session.preview = body.preview;
			sessionManager.persistSessionMetadata(session).catch(() => {});
			broadcastToAll({ type: "preview_changed", sessionId: id, preview: body.preview });
		}

		// Track whether roleId handling already took care of personalities
		let roleHandledPersonalities = false;

		if (typeof body.roleId === "string" && body.roleId !== "") {
			const role = roleManager.getRole(body.roleId);
			if (!role) { json(res, { error: `Role "${body.roleId}" not found` }, 404); return true; }
			// If personalities are also present, validate and pass them to assignRole to avoid double restart
			let assignOpts: { personalities?: string[] } | undefined;
			if (Array.isArray(body.personalities)) {
				const newPersonalities = body.personalities as string[];
				const invalid = newPersonalities.filter((t: string) => !personalityManager.getPersonality(t));
				if (invalid.length > 0) {
					json(res, { error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
					return true;
				}
				assignOpts = { personalities: newPersonalities };
				roleHandledPersonalities = true;
			}
			try {
				const ok = await sessionManager.assignRole(id, role, assignOpts);
				if (!ok) { json(res, { error: "Session not found" }, 404); return true; }
			} catch (err) {
				json(res, { error: String(err) }, 400);
				return true;
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
			if (!session) { json(res, { error: "Session not found" }, 404); return true; }
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
					json(res, { error: "Session not found" }, 404); return true;
				}
			}
		}

		if (Array.isArray(body.personalities) && !roleHandledPersonalities) {
			const newPersonalities = body.personalities as string[];
			// Validate personality names
			const invalid = newPersonalities.filter((t: string) => !personalityManager.getPersonality(t));
			if (invalid.length > 0) {
				json(res, { error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
				return true;
			}
			try {
				const ok = await sessionManager.updatePersonalities(id, newPersonalities);
				if (!ok) { json(res, { error: "Session not found" }, 404); return true; }
			} catch (err) {
				json(res, { error: String(err) }, 400);
				return true;
			}
		}

		json(res, { ok: true });
		return true;
	}

	// DELETE /api/sessions/:id
	if (singleSessionMatch && req.method === "DELETE") {
		const id = singleSessionMatch[1];
		// Check if it's an archived session — purge immediately
		const archivedSession = sessionManager.getArchivedSession(id);
		if (archivedSession) {
			await sessionManager.purgeArchivedSession(id);
			json(res, { ok: true });
			return true;
		}
		const terminated = await sessionManager.terminateSession(id);
		if (!terminated) {
			json(res, { error: "Session not found" }, 404);
			return true;
		}
		json(res, { ok: true });
		return true;
	}

	// POST /api/sessions/:id/wait — block until session becomes idle
	const waitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/wait$/);
	if (waitMatch && req.method === "POST") {
		const id = waitMatch[1];
		const body = await readBody(req);
		const timeoutMs = body?.timeout_ms ?? 600_000;
		try {
			await sessionManager.waitForIdle(id, timeoutMs);
			// Session is idle — return the output
			const output = await sessionManager.getSessionOutput(id);
			const session = sessionManager.getSession(id);
			json(res, {
				status: session?.status || "idle",
				output,
			});
		} catch (err) {
			json(res, { error: String(err) }, 408); // Request Timeout
		}
		return true;
	}

	// GET /api/sessions/:id/output — get final assistant output
	const outputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/output$/);
	if (outputMatch && req.method === "GET") {
		const id = outputMatch[1];
		try {
			const output = await sessionManager.getSessionOutput(id);
			json(res, { output });
		} catch {
			json(res, { error: "Failed to get output" }, 500);
		}
		return true;
	}

	// PUT /api/sessions/:id/title — legacy rename endpoint
	const titleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/title$/);
	if (titleMatch && req.method === "PUT") {
		const id = titleMatch[1];
		const body = await readBody(req);
		const title = body?.title;
		if (!title || typeof title !== "string") {
			json(res, { error: "Missing title" }, 400);
			return true;
		}
		const ok = sessionManager.setTitle(id, title);
		if (!ok) {
			json(res, { error: "Session not found" }, 404);
			return true;
		}
		json(res, { ok: true });
		return true;
	}

	// GET /api/sessions/:id/cost/breakdown — cost breakdown including delegates
	const sessionCostBreakdownMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost\/breakdown$/);
	if (sessionCostBreakdownMatch && req.method === "GET") {
		const sessionId = sessionCostBreakdownMatch[1];
		const costTracker = sessionManager.getCostTracker();
		const allCosts = costTracker.getAllCosts();
		const sessionCost = allCosts.get(sessionId);
		if (!sessionCost) {
			json(res, { error: "No cost data" }, 404);
			return true;
		}

		// Find delegate sessions
		const delegates: any[] = [];
		const allSessions = [...sessionManager.listSessions(), ...sessionManager.listArchivedSessions()];
		for (const s of allSessions) {
			if ((s as any).delegateOf === sessionId) {
				const dCost = allCosts.get(s.id);
				if (dCost && dCost.totalCost > 0) {
					delegates.push({
						sessionId: s.id,
						title: (s as any).title || s.id.slice(0, 8),
						...dCost,
					});
				}
			}
		}
		delegates.sort((a, b) => b.totalCost - a.totalCost);

		json(res, {
			session: { sessionId, ...sessionCost },
			delegates,
		});
		return true;
	}

	// GET /api/sessions/:id/cost — cost for a single session
	const sessionCostMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost$/);
	if (sessionCostMatch && req.method === "GET") {
		const id = sessionCostMatch[1];
		const cost = sessionManager.getCostTracker().getSessionCost(id);
		if (!cost) {
			json(res, { error: "No cost data for this session" }, 404);
			return true;
		}
		json(res, cost);
		return true;
	}

	// GET /api/sessions/:id/file-content — read a file from session cwd
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/file-content")) {
		const id = url.pathname.split("/")[3];
		const session = sessionManager.getSession(id);
		if (!session) { json(res, { error: "Session not found" }, 404); return true; }

		const filePath = url.searchParams.get("path");
		if (!filePath) { json(res, { error: "Missing path parameter" }, 400); return true; }

		const snapshotId = url.searchParams.get("snapshotId");
		const snapshotDir = path.join(bobbitStateDir(), "html-snapshots");
		const snapshotFile = snapshotId ? path.join(snapshotDir, `${snapshotId.replace(/[^a-zA-Z0-9_-]/g, "")}.html`) : null;

		if (snapshotFile && fs.existsSync(snapshotFile)) {
			try {
				const content = fs.readFileSync(snapshotFile, "utf-8");
				json(res, { content });
			} catch {
				json(res, { error: "Snapshot read failed" }, 500);
			}
			return true;
		}

		const resolved = path.isAbsolute(filePath)
			? path.resolve(filePath)
			: path.resolve(session.cwd, filePath);

		try {
			const stat = fs.statSync(resolved);
			if (stat.isDirectory() || stat.size > 512 * 1024) {
				json(res, { error: "File too large or is a directory" }, 400);
				return true;
			}
			const content = fs.readFileSync(resolved, "utf-8");
			if (snapshotFile) {
				try {
					fs.mkdirSync(snapshotDir, { recursive: true });
					fs.writeFileSync(snapshotFile, content, "utf-8");
				} catch { /* best-effort */ }
			}
			json(res, { content });
		} catch {
			json(res, { error: "File not found" }, 404);
		}
		return true;
	}

	// POST /api/sessions/:id/bg-processes — create background process
	const bgCreateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes$/);
	if (bgCreateMatch && req.method === "POST") {
		const id = bgCreateMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json(res, { error: "Session not found" }, 404); return true; }
		const body = await readBody(req);
		if (!body?.command) { json(res, { error: "command is required" }, 400); return true; }
		const info = ctx.bgProcessManager.create(id, body.command, session.cwd);
		json(res, info, 201);
		return true;
	}

	// GET /api/sessions/:id/bg-processes — list background processes
	if (bgCreateMatch && req.method === "GET") {
		const id = bgCreateMatch[1];
		json(res, { processes: ctx.bgProcessManager.list(id) });
		return true;
	}

	// GET /api/sessions/:id/bg-processes/:pid/logs — get logs
	const bgLogsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/logs$/);
	if (bgLogsMatch && req.method === "GET") {
		const [, sessionId, processId] = bgLogsMatch;
		const logs = ctx.bgProcessManager.getLogs(sessionId, processId);
		if (!logs) { json(res, { error: "Process not found" }, 404); return true; }
		const tail = parseInt(url.searchParams.get("tail") || "200", 10);
		json(res, {
			log: logs.log.slice(-tail),
			stdout: logs.stdout.slice(-tail),
			stderr: logs.stderr.slice(-tail),
		});
		return true;
	}

	// DELETE /api/sessions/:id/bg-processes/:pid — kill or remove a background process
	const bgKillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)$/);
	if (bgKillMatch && req.method === "DELETE") {
		const [, sessionId, processId] = bgKillMatch;
		const killed = ctx.bgProcessManager.kill(sessionId, processId);
		if (!killed) {
			const removed = ctx.bgProcessManager.remove(sessionId, processId);
			if (!removed) { json(res, { error: "Process not found" }, 404); return true; }
		}
		json(res, { ok: true });
		return true;
	}

	// PUT /api/sessions/:id/draft — upsert a draft
	const draftMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftMatch && req.method === "PUT") {
		const id = draftMatch[1];
		const body = await readBody(req);
		if (!body || typeof body.type !== "string") {
			json(res, { error: "Missing type" }, 400);
			return true;
		}
		const ok = sessionManager.setDraft(id, body.type, body.data);
		if (!ok) { json(res, { error: "Session not found" }, 404); return true; }
		json(res, { ok: true });
		return true;
	}

	// GET /api/sessions/:id/prompt-sections — return system prompt broken into labeled sections
	const promptSectionsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt-sections$/);
	if (promptSectionsMatch && req.method === "GET") {
		const id = promptSectionsMatch[1];
		const parts = sessionManager.getPromptParts(id);
		if (!parts) { json(res, { error: "Session not found or no prompt data" }, 404); return true; }
		if (!parts.toolDocs && ctx.toolManager) {
			parts.toolDocs = ctx.toolManager.getToolDocsForPrompt(parts.allowedTools);
		}
		const sections = getPromptSections(parts);
		json(res, { sections });
		return true;
	}

	// GET /api/sessions/:id/draft?type=prompt — retrieve a draft
	if (draftMatch && req.method === "GET") {
		const id = draftMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json(res, { error: "Missing type query param" }, 400); return true; }
		const data = sessionManager.getDraft(id, type);
		if (data === undefined) {
			const session = sessionManager.getSession(id);
			if (!session) { json(res, { error: "Session not found" }, 404); return true; }
			json(res, { error: "Draft not found" }, 404);
			return true;
		}
		json(res, { type, data });
		return true;
	}

	// DELETE /api/sessions/:id/draft?type=prompt — clear a draft
	if (draftMatch && req.method === "DELETE") {
		const id = draftMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json(res, { error: "Missing type query param" }, 400); return true; }
		const session = sessionManager.getSession(id);
		if (!session) { json(res, { error: "Session not found" }, 404); return true; }
		sessionManager.deleteDraft(id, type);
		json(res, { ok: true });
		return true;
	}

	return false;
}
