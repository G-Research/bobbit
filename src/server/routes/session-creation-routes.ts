// src/server/routes/session-creation-routes.ts
//
// STR-01 cohort 22: POST /api/sessions creation route migrated out of
// handleApiRoute's legacy if/else chain into the core route registry. See
// docs/design/route-registry.md.
//
// Mechanical extraction — handler body below preserves the legacy behavior,
// with only handleApiRoute locals destructured from ctx.
//
// LEGACY FALL-THROUGH PARITY: no unhandled-method shim needed. The legacy
// block gated on path and method in the same `if` condition; RouteTable's
// method-scoped matching preserves that by leaving other methods unregistered.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { bobbitDir } from "../bobbit-dir.js";
import { recordElapsed } from "../agent/profiling.js";
import { HEADQUARTERS_PROJECT_ID, SYSTEM_PROJECT_ID, type RegisteredProject } from "../agent/project-registry.js";
import { resolveProjectForRequest, validateExecutionCwd, type CwdOwnershipSource } from "../agent/resolve-project.js";
import type { PersistedGoal } from "../agent/goal-store.js";
import { checkDockerAvailability } from "../agent/sandbox-status.js";
import { shouldCreateWorktree } from "../agent/worktree-decision.js";
import { resolveWorktreeSupport } from "../agent/worktree-support.js";
import type { CoreRouteCtx } from "./core-route-ctx.js";
import type { RouteTable } from "./route-table.js";

let _dockerAvailCache: { available: boolean; error?: string; ts: number } | null = null;

/**
 * Normalize a client-posted `model` field (POST /api/sessions) into a
 * canonical `provider/id` string. Accepts either the shorthand string form
 * (`"claude-code/local-claude-sonnet-4-6"`) or the structured
 * `{ provider, id }` object form the Claude Code runtime API uses. Returns
 * `undefined` for anything that doesn't cleanly resolve to a provider/id
 * pair — the caller must treat "`body.model` was present but didn't
 * normalize" as a hard 400, never a silent default (see the check right
 * after this function's call site).
 *
 * Only the FIRST `/` is the provider/id delimiter, matching the
 * `indexOf("/")` convention used everywhere this canonical string is split
 * downstream (e.g. `clampRoleThinking`, `SessionManager.resolveInitialModel`).
 * The model id itself MAY contain further slashes — custom-provider model
 * ids (PR #144) commonly look like `"z-ai/glm-5.2"`, so both
 * `"<provider>/z-ai/glm-5.2"` and `{ provider, id: "z-ai/glm-5.2" }` must
 * resolve. Only the provider segment must stay slash-free (it ends at the
 * first `/` by construction).
 */
function normalizePostedSessionModel(raw: unknown): string | undefined {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed || /\s/.test(trimmed)) return undefined;
		const slash = trimmed.indexOf("/");
		if (slash <= 0 || slash === trimmed.length - 1) return undefined;
		return trimmed;
	}
	if (raw && typeof raw === "object") {
		const provider = typeof (raw as any).provider === "string" ? (raw as any).provider.trim() : "";
		const id = typeof (raw as any).id === "string" ? (raw as any).id.trim() : "";
		if (provider && id && !provider.includes("/") && !/\s/.test(provider) && !/\s/.test(id)) {
			return `${provider}/${id}`;
		}
	}
	return undefined;
}


// POST /api/sessions
async function handlePostSession(ctx: CoreRouteCtx): Promise<void> {
	const {
		defaultCwd,
		getGoalAcrossProjects,
		getGoalManagerForGoal,
		json,
		jsonError,
		projectContextManager,
		projectRegistry,
		readBody,
		req,
		resolveRoleForProject,
		roleCreateOptions,
		sandboxScope,
		sandboxTokenStore,
		sessionManager,
		wireGoalManagerResolvers,
		writeCwdValidationError,
		writeProjectResolutionError,
		writeSpecialProjectMutationError,
	} = ctx;
	const __t0 = performance.now();
	try {
	const body = await readBody(req);

	// ── Delegate session creation ──
	if (body?.delegateOf && body?.instructions) {
		const parentId = typeof body.delegateOf === "string" ? body.delegateOf.trim() : "";
		if (!parentId) {
			json({ error: "delegateOf must reference a parent session" }, 400);
			return;
		}
		// Sandbox guard: delegate parent must be own session or registered child
		if (sandboxScope) {
			if (!sandboxScope.sessionIds.has(parentId)) {
				json({ error: "Forbidden: delegate parent must be own session" }, 403);
				return;
			}
		}
		const parentSession = sessionManager.getSession(parentId);
		const parentPersisted = parentSession ? undefined : sessionManager.getPersistedSession(parentId);
		if (!parentSession && !parentPersisted) {
			json({ error: "Delegate parent session not found" }, 404);
			return;
		}
		const parentProjectId = parentSession?.projectId ?? parentPersisted?.projectId;
		if (!parentProjectId) {
			json({ error: "Delegate parent session is missing projectId", code: "PROJECT_ID_REQUIRED" }, 422);
			return;
		}
		const explicitDelegateProjectId = typeof body?.projectId === "string" && body.projectId.trim().length > 0
			? body.projectId.trim()
			: undefined;
		if (explicitDelegateProjectId && explicitDelegateProjectId !== parentProjectId) {
			json({ error: "projectId must match the delegate parent session's projectId", code: "PROJECT_ID_MISMATCH" }, 422);
			return;
		}
		const parentProject = resolveProjectForRequest(projectRegistry, { projectId: parentProjectId }, {
			allowSystem: parentProjectId === SYSTEM_PROJECT_ID,
		});
		if (!parentProject.ok) { writeProjectResolutionError(parentProject); return; }
		const requestedCwd = typeof body.cwd === "string" && body.cwd.trim().length > 0
			? body.cwd.trim()
			: undefined;
		const cwd = requestedCwd ?? parentSession?.cwd ?? parentPersisted?.cwd ?? parentProject.project.rootPath;
		const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, parentProjectId, cwd, { kind: "session", sessionId: parentId });
		if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
		try {
			const session = await sessionManager.createDelegateSession(parentId, {
				instructions: body.instructions,
				cwd,
				title: body.title,
				context: body.context,
			});
			// Register delegate as child in parent's sandbox scope
			if (sandboxScope && sandboxTokenStore) {
				sandboxTokenStore.addSession(sandboxScope.projectId, session.id);
			}
			json({
				id: session.id,
				cwd: session.cwd,
				status: session.status,
				projectId: session.projectId,
				delegateOf: session.delegateOf,
			}, 201);
		} catch (err) {
			jsonError(500, err);
		}
		return;
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

	const explicitCwd = typeof body?.cwd === "string" && body.cwd.trim().length > 0
		? body.cwd.trim()
		: undefined;
	const explicitProjectId = typeof body?.projectId === "string" && body.projectId.trim().length > 0
		? body.projectId.trim()
		: undefined;

	// If creating under a goal, use the goal's cwd/project as the default.
	// NOTE: the goal's auto-transition to in-progress is deferred until AFTER
	// the sandbox ownership check below — a sandbox-scoped token must not be
	// able to mutate another project's goal state before we've verified the
	// goal is inside its scope.
	let cwd = explicitCwd || defaultCwd;
	let goalForSession: PersistedGoal | undefined;
	if (goalId) {
		goalForSession = getGoalAcrossProjects(goalId);
		if (goalForSession) {
			cwd = explicitCwd || goalForSession.cwd;
		}
	}

	const args = body?.args;

	// Claude Code runtime session API: a caller may request the local Claude
	// Code CLI runtime explicitly (`runtime: "claude-code"`) or implicitly via
	// a `claude-code/<alias>` model string. Accepted here (rather than only at
	// respawn/restore time) so a freshly created session spawns with the right
	// CLI + alias instead of silently falling back to the `pi` runtime.
	const requestedModel = normalizePostedSessionModel(body?.model);
	// `body.model` present but unparseable must be a loud 400, NEVER a
	// silent fallback to the default model — a caller that asked for a
	// specific model (e.g. a custom-provider slash id) and got a different
	// one back with no error is exactly the footgun this guards against.
	if (body?.model !== undefined && !requestedModel) {
		json({
			error: `Invalid model: ${JSON.stringify(body.model)} — expected a "provider/id" string (the id may itself contain "/", e.g. "custom/z-ai/glm-5.2") or a { provider, id } object`,
			code: "INVALID_MODEL",
		}, 400);
		return;
	}
	const requestedRuntime = body?.runtime === "claude-code" || requestedModel?.startsWith("claude-code/")
		? "claude-code"
		: body?.runtime === "pi"
			? "pi"
			: undefined;

	// If a roleId is provided, resolve/apply it after resolvedProjectId is known.
	const roleId = body?.roleId;
	let createOpts: ReturnType<CoreRouteCtx["roleCreateOptions"]> | undefined;

	// ── Worktree support ──
	// Non-assistant, non-goal sessions get a worktree by default unless explicitly opted out.
	// Goal sessions have their own worktree logic via goalManager.setupWorktreeAndStartTeam().
	// Resolution of `worktreeOpts` is deferred until after `resolvedProjectId` is
	// finalised below — multi-repo (poly-repo) projects need the project's container
	// rootPath as repoPath, not `getRepoRoot(cwd)` (which fails for non-git containers).
	let worktreeOpts: { repoPath: string } | undefined;
	const wantWorktree = shouldCreateWorktree({ worktree: body?.worktree, assistantType, goalId }, true);

	// ── Re-attempt support ──
	const reattemptGoalId = body?.reattemptGoalId as string | undefined;

	// ── Sandbox request flag ──
	// Sandbox-scoped tokens MUST create sandboxed sessions — prevent escape.
	// Config/Docker preflight is deferred until after projectId resolution so it
	// uses the selected ProjectContext, not server/Headquarters config.
	let sandboxed = body?.sandboxed === true;
	if (sandboxScope) sandboxed = true;

	const isProjectAssistant = assistantType === "project" || assistantType === "project-scaffolding";
	// Role/Tool assistants can deliberately use the hidden system project when
	// no projectId is supplied. All normal user/work sessions need an explicit
	// projectId or a persisted goal/reattempt source project.
	const isServerScopeAssistant = assistantType === "role" || assistantType === "tool";

	// ── Sandbox scope ownership enforcement ──
	// Authorized delegate creation (body.delegateOf + instructions) is handled
	// and returned earlier. Any OTHER session creation reaching here under a
	// sandbox-scoped token must stay strictly inside that token's project/goal
	// scope. Enforce this BEFORE resolving the project or mutating any goal so a
	// compromised container cannot escape its scope, promote assistant/server
	// scope, or flip another project's goal to in-progress. Violations are 403.
	if (sandboxScope) {
		if (assistantType) {
			json({ error: "Forbidden: sandbox tokens cannot create assistant or server-scope sessions", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
			return;
		}
		if (!explicitProjectId || explicitProjectId !== sandboxScope.projectId) {
			json({ error: "Forbidden: sandbox session projectId must match the sandbox scope", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
			return;
		}
		if (goalId && !sandboxScope.goalIds.has(goalId)) {
			json({ error: "Forbidden: goal is outside the sandbox scope", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
			return;
		}
		if (reattemptGoalId && !sandboxScope.goalIds.has(reattemptGoalId)) {
			json({ error: "Forbidden: reattempt goal is outside the sandbox scope", code: "SANDBOX_SCOPE_VIOLATION" }, 403);
			return;
		}
	}

	let resolvedProjectId = explicitProjectId;
	let resolvedProject: RegisteredProject | undefined;
	let provisionalProjectId: string | undefined;
	let cwdSource: CwdOwnershipSource = { kind: "user-input" };

	const goalProjectId = goalForSession?.projectId
		?? (goalId ? projectContextManager.getContextForGoal(goalId)?.project.id : undefined);
	if (goalProjectId) {
		if (resolvedProjectId && resolvedProjectId !== goalProjectId) {
			json({ error: "projectId must match the goal's projectId", code: "PROJECT_ID_MISMATCH" }, 422);
			return;
		}
		resolvedProjectId = goalProjectId;
		if (!explicitCwd) cwdSource = { kind: "goal", goalId };
	}

	// If re-attempting a goal, inherit cwd and projectId from the original goal.
	if (reattemptGoalId) {
		const origGoal = getGoalAcrossProjects(reattemptGoalId);
		if (origGoal) {
			if (!explicitCwd) cwd = origGoal.cwd || cwd;
			const origProjectId = origGoal.projectId ?? projectContextManager.getContextForGoal(reattemptGoalId)?.project.id;
			if (origProjectId) {
				if (resolvedProjectId && resolvedProjectId !== origProjectId) {
					json({ error: "projectId must match the reattempt goal's projectId", code: "PROJECT_ID_MISMATCH" }, 422);
					return;
				}
				resolvedProjectId = origProjectId;
				if (!explicitCwd) cwdSource = { kind: "goal", goalId: reattemptGoalId };
			}
		}
	}

	// For project assistants, register a provisional project at the target cwd.
	if (isProjectAssistant && cwd && !resolvedProjectId) {
		let provisionalProject: RegisteredProject;
		try {
			provisionalProject = projectRegistry.registerProvisional(path.basename(cwd), cwd);
		} catch (err) {
			if (writeSpecialProjectMutationError(err)) return;
			throw err;
		}
		provisionalProjectId = provisionalProject.id;
		resolvedProjectId = provisionalProject.id;
		// Ensure a ProjectContext exists for the provisional project
		const provCtx = projectContextManager.getOrCreate(provisionalProject.id);
		if (provCtx) {
			provCtx.gateStore.onStatusChange = () => {
				provCtx.goalStore.bumpGeneration();
			};
			wireGoalManagerResolvers(provCtx, { sessionManager, projectContextManager, projectRegistry });
		}
	}

	if (!resolvedProjectId && isServerScopeAssistant) {
		resolvedProjectId = SYSTEM_PROJECT_ID;
	}
	if (!resolvedProjectId) {
		const missing = resolveProjectForRequest(projectRegistry, { projectId: undefined });
		if (!missing.ok) writeProjectResolutionError(missing);
		return;
	}
	const resolved = resolveProjectForRequest(projectRegistry, { projectId: resolvedProjectId }, {
		allowSystem: isServerScopeAssistant && resolvedProjectId === SYSTEM_PROJECT_ID,
	});
	if (!resolved.ok) { writeProjectResolutionError(resolved); return; }
	resolvedProjectId = resolved.projectId;
	resolvedProject = resolved.project;
	const resolvedProjectContext = projectContextManager.getOrCreate(resolvedProjectId);

	// Server-scope assistants (role/tool) resolve to the hidden `system`
	// project, which has no user-facing root. They must operate strictly
	// under the Headquarters workspace directory (bobbitDir()), which is a
	// distinct location from the server run dir / system project rootPath.
	const isSystemScopeAssistant = isServerScopeAssistant && resolvedProjectId === SYSTEM_PROJECT_ID;
	if (!explicitCwd && !goalForSession && !reattemptGoalId && !isSystemScopeAssistant) {
		cwd = resolvedProject.rootPath;
	} else if (isSystemScopeAssistant && !goalForSession && !reattemptGoalId) {
		// Server-scope assistants (role/tool) must always create successfully
		// regardless of the caller-supplied cwd — they operate strictly under
		// the Headquarters workspace directory (bobbitDir()). Coerce the cwd:
		// honor an explicit cwd only when it is inside the Headquarters
		// directory (validated against the Headquarters project scope, whose
		// rootPath IS bobbitDir()); otherwise force it to the Headquarters
		// directory. Never reject a server-scope assistant over its cwd.
		const hqDir = bobbitDir();
		if (explicitCwd) {
			const hqCwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, HEADQUARTERS_PROJECT_ID, explicitCwd, { kind: "user-input" });
			cwd = hqCwdValidation.ok ? explicitCwd : hqDir;
		} else {
			cwd = hqDir;
		}
	}

	// System-scope assistants were already constrained to the Headquarters
	// directory above; all other scopes must validate the resolved cwd
	// against the resolved project scope (never bypassed).
	const shouldValidateCwd = !isSystemScopeAssistant;
	if (shouldValidateCwd) {
		const cwdValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProjectId, cwd, cwdSource);
		if (!cwdValidation.ok) { writeCwdValidationError(cwdValidation); return; }
	}

	// Guard against stale cwd (e.g. re-attempting a goal whose worktree was deleted).
	// Only server-selected/persisted cwd values may fall back; explicit user cwd
	// must fail rather than being silently replaced with the project root.
	if (cwd && !fs.existsSync(cwd)) {
		const staleCwd = cwd;
		if (explicitCwd) {
			json({ error: `Working directory does not exist: ${staleCwd}` }, 400);
			return;
		}
		let fallback: string | undefined;
		if (fs.existsSync(resolvedProject.rootPath)) fallback = resolvedProject.rootPath;
			if (!fallback && fs.existsSync(defaultCwd)) fallback = defaultCwd;
		if (fallback) {
			console.warn(`[POST /api/sessions] cwd ${staleCwd} does not exist — falling back to ${fallback}`);
			cwd = fallback;
			if (shouldValidateCwd) {
				const fallbackValidation = validateExecutionCwd(projectRegistry, projectContextManager, resolvedProjectId, cwd, cwdSource);
				if (!fallbackValidation.ok) { writeCwdValidationError(fallbackValidation); return; }
			}
		} else {
			json({ error: `Working directory does not exist: ${staleCwd}` }, 400);
			return;
		}
	}

	// ── Sandbox validation ──
	if (sandboxed) {
		const sandboxConfig = resolvedProjectContext?.projectConfigStore.get("sandbox") || "none";
		if (sandboxConfig !== "docker") {
			json({ error: "Docker sandbox is not configured. Set sandbox: \"docker\" in project settings." }, 400);
			return;
		}
		// Skip Docker check if sandbox manager has ready containers.
		// Otherwise use a cached result to avoid running `docker info` on every session creation.
		const hasReadyContainer = sessionManager.getSandboxManager()?.getStats().containers.some(c => c.status === "ready") ?? false;
		if (!hasReadyContainer) {
			if (!_dockerAvailCache || Date.now() - _dockerAvailCache.ts > 60_000) {
				const dockerStatus = await checkDockerAvailability();
				_dockerAvailCache = { available: dockerStatus.available, error: dockerStatus.error, ts: Date.now() };
			}
			if (!_dockerAvailCache.available) {
				json({ error: `Docker is not available: ${_dockerAvailCache.error || "Docker not detected"}` }, 503);
				return;
			}
		}
	}

	if (roleId && typeof roleId === "string") {
		const role = resolveRoleForProject(roleId, resolvedProjectId);
		if (!role) {
			json({ error: `Role "${roleId}" not found` }, 404);
			return;
		}
		createOpts = roleCreateOptions(role);
	}

	// Now that `resolvedProjectId` is known, resolve `worktreeOpts`.
	// Multi-repo (poly-repo) short-circuit mirrors goal-manager.ts::createGoal:
	// if any component has repo !== ".", the project's rootPath IS the repoPath
	// even though it isn't itself a git repo. Without this, the `isGitRepo(cwd)`
	// check below returns false for the container directory and sessions would
	// run with no worktree at all.
	// Headquarters is no-worktree: skip the git probe entirely so no worktree
	// is ever resolved for HQ sessions (worktreeOpts stays undefined).
	if (wantWorktree && resolvedProjectId !== HEADQUARTERS_PROJECT_ID) {
		try {
			const projCtx = resolvedProjectId ? projectContextManager.getOrCreate(resolvedProjectId) : undefined;
			const proj = resolvedProjectId ? projectRegistry.get(resolvedProjectId) : undefined;
			// Single source of truth shared with the staff path
			// (staff-manager.ts) and goal path (goal-manager.ts).
			const components = projCtx?.projectConfigStore.getComponents() ?? [];
			const configuredBaseRef = projCtx?.projectConfigStore.get("base_ref") || undefined;
			const support = await resolveWorktreeSupport(components, proj?.rootPath, cwd, undefined, { configuredBaseRef });
			if (support.supported && support.repoPath) {
				worktreeOpts = { repoPath: support.repoPath };
			}
		} catch {
			// Not a git repo or git not available — silently ignore
		}
	}

	// ── Sandbox auto-branch ──
	// For sandboxed non-goal, non-assistant sessions, generate a branch so they get
	// a container worktree instead of defaulting to /workspace.
	let autoSandboxBranch: string | undefined;
	if (sandboxed && !goalId && !assistantType) {
		const shortId = randomUUID().slice(0, 8);
		autoSandboxBranch = `session/s-${shortId}`;
	}

	// Auto-transition the goal to in-progress only after all request
	// validation has passed and immediately before creating the session.
	if (goalId && goalForSession && goalForSession.state === "todo") {
		await getGoalManagerForGoal(goalId).updateGoal(goalId, { state: "in-progress" });
	}

	try {
		const session = await sessionManager.createSession(cwd, args, goalId, assistantType, {
			...createOpts,
			worktreeOpts,
			reattemptGoalId,
			sandboxed,
			projectId: resolvedProjectId,
			...(requestedModel ? { initialModel: requestedModel } : {}),
			...(requestedRuntime ? { runtime: requestedRuntime } : {}),
			...(autoSandboxBranch ? { sandboxBranch: autoSandboxBranch } : {}),
			parentSessionId: typeof body?.parentSessionId === "string" ? body.parentSessionId : undefined,
			childKind: typeof body?.childKind === "string" ? body.childKind : undefined,
			readOnly: typeof body?.readOnly === "boolean" ? body.readOnly : undefined,
		});

		// Set assistant role metadata if no explicit role was provided
		if (!createOpts?.role && assistantType) {
			sessionManager.updateSessionMeta(session.id, { role: "assistant", accessory: "wand" });
			session.role = "assistant";
			session.accessory = "wand";
		}

		// Store reattemptGoalId on the session if provided
		if (reattemptGoalId) {
			sessionManager.getSessionStore(session.projectId).update(session.id, { reattemptGoalId });
		}

		// Store projectId on the session if resolved from an explicit or persisted scope.
		// Project assistant sessions keep their provisional projectId so they
		// persist under the provisional project's store and appear in the sidebar.
		if (resolvedProjectId) {
			sessionManager.getSessionStore(session.projectId).update(session.id, { projectId: resolvedProjectId });
		}

		json({
			id: session.id,
			cwd: session.cwd,
			status: session.status,
			projectId: session.projectId ?? resolvedProjectId,
			goalId: session.goalId,
			assistantType: session.assistantType,
			// Legacy boolean fields for backward compat
			goalAssistant: session.assistantType === "goal",
			roleAssistant: session.assistantType === "role",
			toolAssistant: session.assistantType === "tool",
			role: session.role,
			accessory: session.accessory,
			parentSessionId: session.parentSessionId,
			childKind: session.childKind,
			readOnly: session.readOnly,
			runtime: sessionManager.getPersistedSession(session.id)?.runtime,
			claudeCodeSessionId: sessionManager.getPersistedSession(session.id)?.claudeCodeSessionId,
			claudeCodeExecutable: sessionManager.getPersistedSession(session.id)?.claudeCodeExecutable,
			claudeCodePermissionMode: sessionManager.getPersistedSession(session.id)?.claudeCodePermissionMode,
			claudeCodeModelAlias: sessionManager.getPersistedSession(session.id)?.claudeCodeModelAlias,
			reattemptGoalId,
			...(provisionalProjectId ? { provisionalProjectId } : {}),
		}, 201);
	} catch (err) {
		// Log full error context server-side so that flaky 500s in tests
		// (e.g. resilience suite under FS contention) leave a usable trail.
		// `String(err)` alone drops the stack and any error.cause chain.
		const e = err as Error & { code?: string; cause?: unknown };
		console.error(
			`[POST /api/sessions] failed cwd=${cwd ?? "(none)"} project=${resolvedProjectId ?? "(none)"} ` +
			`goal=${goalId ?? "(none)"} assistant=${assistantType ?? "(none)"} sandbox=${sandboxed ? "yes" : "no"}: ` +
			`${e.message ?? String(err)}\n${e.stack ?? ""}`,
		);
		if (e.cause) console.error("  caused by:", e.cause);
		json({
			error: String(err),
			message: e.message,
			code: e.code,
			cause: e.cause ? String(e.cause) : undefined,
		}, 500);
	}
	return;
	} finally {
		recordElapsed("POST /api/sessions", performance.now() - __t0);
	}
}

export function registerSessionCreationRoutes(table: RouteTable<CoreRouteCtx>): void {
	table.register("POST", "/api/sessions", handlePostSession);
}
