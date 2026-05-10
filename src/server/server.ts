import { exec, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { bobbitStateDir, bobbitConfigDir, getProjectRoot } from "./bobbit-dir.js";
import { isSetupComplete } from "./setup-status.js";
export { isSetupComplete };
import { WebSocketServer } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { PrStatusStore } from "./agent/pr-status-store.js";
import { SessionManager } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { validateToken } from "./auth/token.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import { getSlashSkill, buildSlashSkillPrompt } from "./skills/slash-skills.js";
import { TeamManager, GateDependencyError } from "./agent/team-manager.js";
import { checkGateDependencies } from "./agent/gate-dependency-check.js";
import { shouldCreateWorktree } from "./agent/worktree-decision.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolManager } from "./agent/tool-manager.js";

import { getPromptSections, initPromptDirs, loadPersistedPromptSections } from "./agent/system-prompt.js";
import { recordElapsed } from "./agent/profiling.js";

import { initSkillSidecarDir } from "./skills/skill-sidecar.js";
import { buildActivationHeader } from "./skills/skill-manifest.js";
import { TaskManager } from "./agent/task-manager.js";
import { TaskStore } from "./agent/task-store.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";
import { sessionFileRead, type SessionFsContext } from "./agent/session-fs.js";
import { readTranscript, TranscriptReaderError } from "./agent/transcript-reader.js";

import { isGitRepo, getRepoRoot, shouldSkipRemotePush, stripTokenFromGitUrl, detectPrimaryBranch } from "./skills/git.js";
import { VerificationHarness } from "./agent/verification-harness.js";
import { validateAnswers, crossValidate, type UserQuestion } from "./agent/ask-user-choices-validation.js";
import { buildAskResponseEnvelope, findAskResponseAnswers } from "../shared/ask-envelope.js";

// In-memory dedup guard for ask_user_choices /submit. Keyed by
// `${sessionId}::${toolUseId}`. Populated synchronously before enqueuing the
// response envelope so a concurrent duplicate /submit returns alreadySubmitted
// even when the transcript hasn't yet reflected the first envelope.
// Entries are also refilled from the transcript check, so survive process
// restarts via the transcript fallback in findAskResponseAnswers.
const askSubmittedToolUseIds = new Set<string>();
import { inlineFileImages } from "./agent/inline-file-images.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore, validateComponentsConfig, LEGACY_QA_TOP_LEVEL_KEYS } from "./agent/project-config-store.js";
import { hasTransitiveDep } from "./agent/gate-deps.js";
import { loadManifest, serveStatic } from "./static.js";
import { readBody } from "./routes/route-helpers.js";
import { dispatch as dispatchRoute } from "./routes/dispatcher.js";
import type { RouteDeps } from "./routes/route-deps.js";
import { ToolGroupPolicyStore } from "./agent/tool-group-policy-store.js";
import { checkDockerAvailability, buildSandboxImage, ensureImageAgentVersion } from "./agent/sandbox-status.js";
import { SandboxManager, type SandboxBootstrap } from "./agent/sandbox-manager.js";
import { validateSandboxMounts } from "./agent/sandbox-mounts.js";
import { SandboxTokenStore, type SandboxScope } from "./auth/sandbox-token.js";
import { CookieStore, issueIfMissing as issueCookieIfMissing, tryAuth as cookieTryAuth } from "./auth/cookie.js";
import { handlePreviewRequest } from "./preview/content-route.js";
import { progressBus as searchProgressBus } from "./search/progress-bus.js";
import { isSandboxAllowed } from "./auth/sandbox-guard.js";
import * as previewMount from "./preview/mount.js";
import { broadcastPreviewChanged, subscribePreviewChanged } from "./preview/events.js";
import { startupAigwCheck, writeContextWindowOverrides } from "./agent/aigw-manager.js";
import { writeOpenAIModelAdditions } from "./agent/openai-model-additions.js";
import { ReviewAnnotationStore, type ReviewAnnotation } from "./review-annotation-store.js";

import { ProjectRegistry, SymlinkProjectRootError } from "./agent/project-registry.js";
import { ProjectContextManager } from "./agent/project-context-manager.js";
import { resolveProjectForRequest } from "./agent/resolve-project.js";
import { GoalManager } from "./agent/goal-manager.js";
import { resolveHostTokenValue } from "./agent/host-tokens.js";
import type { PersistedGoal } from "./agent/goal-store.js";
import { migrateToPerProjectState, recoverPreMigrationData } from "./agent/state-migration.js";
import { migrateAllProjects as migrateAllProjectYaml } from "./state-migration/migrate-project-yaml.js";
import { resolveScalarConfig } from "./agent/config-resolver.js";
import { BuiltinConfigProvider } from "./agent/builtin-config.js";
import { ConfigCascade } from "./agent/config-cascade.js";

import { initAssistantRegistry } from "./agent/assistant-registry.js";
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
} from "./proposals/proposal-files.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFileCb);

// ── Git helpers, status cache, PR cache, goal-branch deletion ──
// All extracted to ./git/* — re-exported from this file so test hooks remain
// importable from "./server.js" (see tests/e2e/git-status-caching.spec.ts).
import { execGit, execGitSafe } from "./git/git-exec.js";
import { getGitDiff } from "./git/git-diff.js";
import { getCachedPrStatus } from "./git/pr-status.js";
import { deleteRemoteGoalBranches } from "./git/goal-branches.js";
import { clearPrStatusCache } from "./git/pr-status.js";
import {
	batchGitStatus,
	invalidateGitStatusCache,
	__getGitStatusInvocationCount,
	__resetGitStatusInvocationCount,
	__setGitStatusFake,
	__clearGitStatusFake,
	__forceGitStatusCacheExpiry,
	type GitStatusResult,
} from "./git/git-status.js";
export type { GitStatusResult };
export {
	invalidateGitStatusCache,
	__getGitStatusInvocationCount,
	__resetGitStatusInvocationCount,
	__setGitStatusFake,
	__clearGitStatusFake,
	__forceGitStatusCacheExpiry,
};

/** Cached Docker availability result to avoid running `docker info` per session creation */
let _dockerAvailCache: { available: boolean; error?: string; ts: number } | null = null;

export interface TlsConfig {
	cert: string;  // path to PEM certificate
	key: string;   // path to PEM private key
	caCert?: string;  // path to CA certificate (for mkcert-based certs)
}

export interface GatewayConfig {
	host: string;
	port: number;
	portExplicit?: boolean;
	authToken: string;
	defaultCwd: string;
	staticDir?: string;
	agentCliPath?: string;
	systemPromptPath?: string;
	tls?: TlsConfig;
	/** Force auth even on localhost (used by E2E tests). */
	forceAuth?: boolean;
}

export function createGateway(config: GatewayConfig) {
	const stateDir = bobbitStateDir();
	const configDir = bobbitConfigDir();
	fs.mkdirSync(stateDir, { recursive: true });

	// Initialize module-level caches for parameterized modules
	initPromptDirs(stateDir);
	initSkillSidecarDir(stateDir);
	initAssistantRegistry(configDir);

	// Project registry — persisted at server level.
	// Zero projects is a valid state: a fresh install has no projects.json and the
	// UI forces the user through "Add Project" before any goal/session work. Bobbit
	// never registers a project implicitly.
	const projectRegistry = new ProjectRegistry(stateDir);

	// Register the synthetic "system" project so system-scope tool-assistant
	// sessions have a valid persistence anchor without forcing the user to
	// register a real project. Idempotent — hidden from UI listings via the
	// `hidden: true` filter on GET /api/projects.
	//
	// Anchor at a dedicated subdir under bobbitDir so the ProjectContext's
	// derived stateDir (`<rootPath>/.bobbit/state`) cannot collide with any
	// user project rooted at the install dir or with the global stateDir —
	// otherwise the system context would load the same goals.json/sessions.json
	// as a user project rooted at getProjectRoot() (e.g. test fixtures).
	try {
		const systemRoot = path.join(stateDir, "system-project");
		fs.mkdirSync(systemRoot, { recursive: true });
		projectRegistry.registerSystemProject(systemRoot);
	} catch (err) {
		console.warn(`[startup] Failed to register system project: ${err}`);
	}

	// Run one-time migration from centralized to per-project state
	migrateToPerProjectState(stateDir, projectRegistry, getProjectRoot());

	// Recover data lost by the original migration bug (unconditional rename
	// when central dir == default project dir). Must run before stores load.
	recoverPreMigrationData(stateDir);

	// One-shot project.yaml migration: synthesize components[] for legacy
	// single-repo projects. Idempotent. Must run BEFORE ProjectContext
	// instantiation so ProjectConfigStore.load() picks up the new shape,
	// and BEFORE the worktree pool fills.
	migrateAllProjectYaml(
		projectRegistry.list().map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
	);

	// Initialize per-project contexts
	const projectContextManager = new ProjectContextManager(projectRegistry);
	projectContextManager.initAll();

	// Migrate inline token values from project.yaml → secrets.json (one-time)
	for (const p of projectRegistry.list()) {
		const ctx = projectContextManager.getOrCreate(p.id);
		if (!ctx) continue;
		const tokens = ctx.projectConfigStore.getSandboxTokens();
		// getSandboxTokens() never includes `value` (typed accessor strips it).
		// We need the raw values, which are still on the in-memory side-table
		// after load() but only accessible via the back-compat flat get().
		const tokensRaw = ctx.projectConfigStore.get("sandbox_tokens");
		if (!tokensRaw) continue;
		try {
			const arr = JSON.parse(tokensRaw);
			if (!Array.isArray(arr)) continue;
			const hasValues = arr.some((e: any) => e.value);
			if (!hasValues) {
				// No inline values to migrate, but if the on-disk format is legacy
				// JSON-string we still want to rewrite to native YAML on next save.
				// setSandboxTokens() triggers save() which performs the rewrite.
				ctx.projectConfigStore.setSandboxTokens(tokens);
				continue;
			}
			// Move values to secrets store
			const secretUpdates: Record<string, string> = {};
			for (const e of arr) {
				if (e.value) secretUpdates[e.key] = e.value;
			}
			ctx.secretsStore.update(secretUpdates);
			// Strip values from config (write structured form, no JSON-encoded string).
			ctx.projectConfigStore.setSandboxTokens(
				arr.map((e: any) => ({ key: e.key, enabled: e.enabled !== false })),
			);
			console.log(`[migration] Moved ${Object.keys(secretUpdates).length} token secret(s) to secrets.json for project ${ctx.project.id}`);
		} catch { /* ignore parse errors */ }
	}

	const colorStore = new ColorStore(stateDir);
	const prStatusStore = new PrStatusStore(stateDir);
	const preferencesStore = new PreferencesStore(stateDir);
	const reviewAnnotationStore = new ReviewAnnotationStore(stateDir);
	const projectConfigStore = new ProjectConfigStore(configDir);
	const savedCwd = preferencesStore.get("defaultCwd");
	if (savedCwd && typeof savedCwd === "string") {
		config.defaultCwd = savedCwd;
	}
	const roleStore = new RoleStore(configDir);
	const roleManager = new RoleManager(roleStore);
	const toolManager = new ToolManager(configDir);
	toolManager.generateDetailDocs(stateDir);
	const groupPolicyStore = new ToolGroupPolicyStore(configDir);
	const sandboxTokenStore = new SandboxTokenStore();
	const cookieStore = new CookieStore(stateDir);
	const sessionManager = new SessionManager({
		agentCliPath: config.agentCliPath,
		systemPromptPath: config.systemPromptPath,
		colorStore,
		roleManager,
		toolManager,
		preferencesStore,
		projectConfigStore,
		groupPolicyStore,
		projectContextManager,
		prStatusStore,
	});
	sessionManager.sandboxTokenStore = sandboxTokenStore;
	// Wire sessionManager into the project context manager so the search
	// orphan filter can resolve sessions across projects (live, dormant,
	// archived). The registry is already passed via the constructor.
	projectContextManager.setDependencies({ sessionManager });
	// Wire gate status changes to bump goal generation for all project contexts
	for (const ctx of projectContextManager.all()) {
		ctx.gateStore.onStatusChange = () => {
			ctx.goalStore.bumpGeneration();
		};
	}
	const builtinConfigProvider = new BuiltinConfigProvider();
	// Wire builtin defaults into stores (in-memory only, no disk writes).
	// Direct store lookups (roleStore.get()) transparently fall back to
	// builtins, so no seeding to disk is needed. Workflows are project-
	// scoped only — no system layer, no builtin layer.
	roleStore.setBuiltins(builtinConfigProvider.getRoles());
	groupPolicyStore.setBuiltins(builtinConfigProvider.getToolGroupPolicies());

	const configCascade = new ConfigCascade(builtinConfigProvider, {
		getRoles: () => roleStore.getAllLocal(),
		getTools: () => toolManager.getLocalTools(),
		getToolGroupPolicies: () => groupPolicyStore.getAll(),
	}, projectContextManager);
	sessionManager.configCascade = configCascade;

	const staffManager = new StaffManager(projectContextManager);
	const triggerEngine = new TriggerEngine(staffManager, sessionManager);
	triggerEngine.start();
	// Placeholder task store for TeamManager construction. Real goal/task operations
	// route through the per-project context (see TeamManager.getTasksForSession). The
	// first registered project's store is used when available, otherwise a server-
	// scoped store is instantiated solely so construction doesn't require a project.
	const firstCtxForInit = projectContextManager.all().next().value as import("./agent/project-context.js").ProjectContext | undefined;
	const taskStore = firstCtxForInit ? firstCtxForInit.taskStore : new TaskStore(stateDir);
	const teamManager = new TeamManager(sessionManager, {
		colorStore,
		taskManager: new TaskManager(taskStore),
		roleStore,
		projectContextManager,
		toolManager,
	});
	const bgProcessManager = new BgProcessManager((sessionId: string) => {
		const session = sessionManager.getSession(sessionId);
		return session?.clients;
	});
	// Expose bg process manager for API routes and session cleanup
	(sessionManager as any).bgProcessManager = bgProcessManager;
	const rateLimiter = new RateLimiter();

	const cleanupInterval = setInterval(() => {
		rateLimiter.cleanup();
	}, 60_000);

	// Verification harness — assigned after wss is created (closure captures the reference)
	let verificationHarness: VerificationHarness;

	// Sandbox manager — assigned in start() when sandbox=docker
	let sandboxManager: SandboxManager | null = null;

	const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const isLocalhostMode = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

		// Content-origin preview route — served before API auth so iframe loads
		// can authenticate via the bobbit_session cookie instead of the bearer
		// token (iframes cannot set Authorization headers).
		if (url.pathname.startsWith("/preview/")) {
			await handlePreviewRequest(req, res, url.pathname, {
				cookieStore,
				isLocalhost: isLocalhostMode,
				adminBearerToken: config.authToken,
			});
			return;
		}

		// API routes
		if (url.pathname.startsWith("/api/")) {

			// When serving the UI (same-origin), reflect the request origin; otherwise allow any
			const corsOrigin = config.staticDir ? (req.headers.origin || "*") : "*";
			res.setHeader("Access-Control-Allow-Origin", corsOrigin);
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

			if (req.method === "OPTIONS") {
				res.writeHead(204);
				res.end();
				return;
			}

			// Public endpoints — no auth required (CA cert is inherently public).
			const isPublicEndpoint = url.pathname === "/api/ca-cert" && req.method === "GET";

			// Cookie auth short-circuit — if the browser presents a known
			// bobbit_session cookie, treat the request as admin-authenticated
			// and skip the bearer-token check below.
			const hasValidCookie = cookieTryAuth(req, cookieStore);

			// Auth check — skipped in localhost mode (only local processes can connect)
			let sandboxScope: SandboxScope | undefined;
			if (!isLocalhostMode && !isPublicEndpoint && !hasValidCookie) {
				const authHeader = req.headers.authorization;
				const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7)
					: url.searchParams.get("token"); // Allow token in query param for links opened in new tabs
				const ip = req.socket.remoteAddress || "unknown";

				if (rateLimiter.isRateLimited(ip)) {
					res.writeHead(429);
					res.end();
					return;
				}

				if (!token) {
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Unauthorized" }));
					return;
				}

				// Admin token first, then sandbox token
				if (!validateToken(token, config.authToken)) {
					const scope = sandboxTokenStore.lookup(token);
					if (!scope) {
						rateLimiter.recordFailure(ip);
						res.writeHead(401, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "Unauthorized" }));
						return;
					}
					sandboxScope = scope;
				} else {
					// Successful admin Bearer auth — mint session cookie if absent
					// so subsequent requests (including iframe content origin) can
					// authenticate without the Bearer token leaking into URLs.
					issueCookieIfMissing(req, res, cookieStore, { localhost: isLocalhostMode });
				}
			} else if (!isPublicEndpoint && isLocalhostMode) {
				// Localhost mode: skip auth check, still mint the cookie so the
				// browser can use the same cookie auth path on non-localhost
				// deployments later (and the SSE endpoint below remains uniform).
				issueCookieIfMissing(req, res, cookieStore, { localhost: true });
			}

			// Enforce sandbox route guard
			if (sandboxScope && !isSandboxAllowed(url.pathname, req.method || "GET", sandboxScope)) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Forbidden: sandbox token cannot access this endpoint" }));
				return;
			}

			// Optional per-request timing for performance profiling.
			// Enable via BOBBIT_TIMING_LOG=1 to print "[timing] METHOD path ms" for each API call.
			const _timingEnabled = process.env.BOBBIT_TIMING_LOG === "1";
			const _timingStart = _timingEnabled ? performance.now() : 0;
			const handled = await dispatchRoute(url, req, res, routeDeps, sandboxScope);
			if (!handled) {
				await handleApiRoute(url, req, res, sessionManager, config, colorStore, prStatusStore, teamManager, roleManager, toolManager, projectContextManager, bgProcessManager, staffManager, verificationHarness, preferencesStore, projectConfigStore, groupPolicyStore, broadcastToGoal, broadcastToAll, sandboxManager, projectRegistry, configCascade, sandboxScope, sandboxTokenStore, reviewAnnotationStore, broadcastToSession, roleStore);
			}
			if (_timingEnabled) {
				const dur = performance.now() - _timingStart;
				if (dur >= 100) console.log(`[timing] ${req.method} ${url.pathname}${url.search} ${dur.toFixed(1)}ms`);
			}

			return;
		}

		// Dynamic PWA manifest — when launched from a tokenized URL, bake the token
		// into start_url so the PWA can relaunch authenticated.
		// Only does so for a *valid* token; invalid tokens fall through to a plain
		// manifest (no token baked in). Works in both dev mode (Vite proxies
		// /manifest.json to us) and prod (staticDir serves public/).
		if (url.pathname === "/manifest.json" && req.method === "GET") {
			try {
				const manifest = loadManifest(config.staticDir);
				const providedToken = url.searchParams.get("token");
				if (providedToken && validateToken(providedToken, config.authToken)) {
					manifest.start_url = `/?token=${encodeURIComponent(providedToken)}`;
				}
				res.writeHead(200, {
					"Content-Type": "application/manifest+json",
					// Don't let the manifest be cached — token-validity may change.
					"Cache-Control": "no-store",
					// Prevent token leakage via Referer when the PWA makes cross-origin requests.
					"Referrer-Policy": "no-referrer",
				});
				res.end(JSON.stringify(manifest));
				return;
			} catch {
				// Fall through to static serving on any error.
			}
		}

		// Static file serving
		if (config.staticDir) {
			serveStatic(url.pathname, config.staticDir, res);
			return;
		}

		res.writeHead(404);
		res.end("Not found");
	};

	const server: http.Server | https.Server = config.tls
		? https.createServer(
			{
				cert: fs.readFileSync(config.tls.cert),
				key: fs.readFileSync(config.tls.key),
			},
			requestHandler,
		)
		: http.createServer(requestHandler);

	// Long-polling endpoints (e.g. /api/sessions/:id/wait) can block for 10+ minutes.
	// Node >= 19 defaults requestTimeout to 300s which would kill those requests.
	// Disable the server-level timeout; individual endpoints manage their own.
	server.requestTimeout = 0;
	server.headersTimeout = 0;

	// WebSocket server (noServer mode — we handle upgrade manually).
	//
	// `perMessageDeflate: false` disables per-message compression. The `ws`
	// library's default enables it, which on loopback (where bandwidth is
	// not the bottleneck) can stall the server's WS write loop under bursty
	// JSON event traffic — zlib serialises sends through a single thread,
	// and during a streaming turn we emit dozens of small frames per second.
	// Empirically this contributed to a 'Reconnecting to server…' E2E flake
	// cluster (RP-18, CT-01-d, S-02) where the WS would briefly disconnect
	// during high-volume mock-agent event bursts. Loopback never benefits
	// from compression in production either, so this is a strict win.
	const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

	// Broadcast a message to WebSocket clients belonging to a specific goal
	function broadcastToGoal(goalId: string, event: any): void {
		const data = JSON.stringify(event);
		for (const ws of wss.clients) {
			if ((ws as any).authenticated && ws.readyState === 1 /* OPEN */) {
				const sid = (ws as any).sessionId as string | undefined;
				if (sid) {
					const session = sessionManager.getSession(sid);
					if (session?.teamGoalId === goalId || session?.goalId === goalId) {
						ws.send(data);
						continue;
					}
					// Session is associated with a different goal — skip it
					if (session?.teamGoalId || session?.goalId) continue;
				}
				// Fallback: send to clients with no goal association
				// (e.g. the user's browser session viewing the goal dashboard)
				ws.send(data);
			}
		}
	}

	/** Broadcast to ALL authenticated WebSocket clients (regardless of session/goal). */
	function broadcastToAll(event: any): void {
		const data = JSON.stringify(event);
		for (const ws of wss.clients) {
			if ((ws as any).authenticated && ws.readyState === 1 /* OPEN */) {
				ws.send(data);
			}
		}
	}
	/**
	 * Broadcast to all authenticated WebSocket clients whose active session
	 * belongs to the given project. Clients with no session association (e.g.
	 * the user viewing the dashboard) also receive the event so the UI can
	 * surface index status in project-agnostic chrome.
	 */
	function broadcastToProject(projectId: string, event: any): void {
		const data = JSON.stringify(event);
		for (const ws of wss.clients) {
			if (!(ws as any).authenticated || ws.readyState !== 1 /* OPEN */) continue;
			const sid = (ws as any).sessionId as string | undefined;
			if (sid) {
				const session = sessionManager.getSession(sid);
				if (!session) continue;
				if (session.projectId && session.projectId !== projectId) continue;
			}
			ws.send(data);
		}
	}

	// Bridge search index progress bus → WS. Progress events are debounced
	// to 500ms per-project (design §9). Complete + error events pass through.
	{
		const progressDebounce = new Map<string, { timer: NodeJS.Timeout; latest: any }>();
		const flushProgress = (projectId: string) => {
			const entry = progressDebounce.get(projectId);
			if (!entry) return;
			progressDebounce.delete(projectId);
			clearTimeout(entry.timer);
			broadcastToProject(projectId, entry.latest);
		};
		searchProgressBus.on("index:progress", (ev) => {
			const event = { type: "index:progress" as const, ...ev };
			const existing = progressDebounce.get(ev.projectId);
			if (existing) {
				existing.latest = event;
				return;
			}
			const timer = setTimeout(() => flushProgress(ev.projectId), 500);
			timer.unref();
			progressDebounce.set(ev.projectId, { timer, latest: event });
		});
		searchProgressBus.on("index:complete", (ev) => {
			flushProgress(ev.projectId);
			broadcastToProject(ev.projectId, { type: "index:complete" as const, ...ev });
		});
		searchProgressBus.on("index:error", (ev) => {
			broadcastToProject(ev.projectId, { type: "index:error" as const, ...ev });
		});
	}

	teamManager.setBroadcastToGoal(broadcastToGoal);
	// Push a session_removed broadcast to ALL clients on terminate/archive/purge
	// so sidebars and dashboards update instantly. Replaces a 5s polling tick
	// for a documented class of races (e.g. clicking a stale sidebar entry just
	// after another tab archived the session).
	sessionManager.addTerminationListener((sessionId, info) => {
		try {
			broadcastToAll({ type: "session_removed", sessionId, projectId: info.projectId, reason: info.reason });
		} catch (err) {
			console.error(`[broadcast] session_removed failed for ${sessionId}:`, err);
		}
	});

	sessionManager.setOnPrCreationDetected((session) => {
		const goalId = session.goalId || session.teamGoalId;
		if (!goalId) return;
		const goalCtx = projectContextManager.getContextForGoal(goalId);
		const goal = goalCtx?.goalStore.get(goalId);
		if (!goal) return;
		clearPrStatusCache(goal.cwd, goal.branch);
		broadcastToAll({ type: "pr_status_changed", goalId });
	});
	// Broadcast a message to all WebSocket clients subscribed to a specific session.
	function broadcastToSession(sessionId: string, event: any): void {
		const session = sessionManager.getSession(sessionId);
		if (!session) return;
		const data = JSON.stringify(event);
		for (const ws of session.clients) {
			if ((ws as any).readyState === 1 /* OPEN */) ws.send(data);
		}
	}

	verificationHarness = new VerificationHarness(stateDir, undefined, broadcastToGoal, roleStore, preferencesStore, sessionManager, teamManager, projectConfigStore, projectContextManager, configCascade);
	teamManager.setVerificationHarness(verificationHarness);
	verificationHarness.setTeamLeadNotifier((goalId, message) => {
		const team = teamManager.getTeamState(goalId);
		if (!team?.teamLeadSessionId) return;
		const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;
		try {
			if (teamLeadSession.status === "streaming") {
				sessionManager.deliverLiveSteer(team.teamLeadSessionId, message);
			} else {
				sessionManager.enqueuePrompt(team.teamLeadSessionId, message, { isSteered: true });
			}
			console.log(`[verification] Notified team lead for goal ${goalId}: ${message}`);
		} catch (err) {
			console.error(`[verification] Failed to notify team lead for goal ${goalId}:`, err);
		}
	});

	// Single bag of dependencies for the per-domain route handlers in routes/.
	// Constructed once after all stores + broadcasters are wired. Note that
	// `sandboxManager` is bound late (after Docker availability is checked
	// further down) — we read it via a getter so the deps bag captures the
	// current value at call time, not the initial null.
	const routeDeps: RouteDeps = {
		config,
		sessionManager,
		teamManager,
		roleManager,
		roleStore,
		toolManager,
		groupPolicyStore,
		preferencesStore,
		projectConfigStore,
		projectRegistry,
		projectContextManager,
		colorStore,
		prStatusStore,
		reviewAnnotationStore,
		bgProcessManager,
		staffManager,
		verificationHarness,
		get sandboxManager() { return sandboxManager; },
		sandboxTokenStore,
		configCascade,
		broadcastToGoal,
		broadcastToAll,
		broadcastToSession,
	} as RouteDeps;

	const isLocalhostServer = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const viewerMatch = url.pathname === "/ws/viewer";
		const match = viewerMatch ? null : url.pathname.match(/^\/ws\/([^/]+)$/);

		if (!match && !viewerMatch) {
			socket.destroy();
			return;
		}

		const sessionId = viewerMatch ? "__viewer__" : match![1];

		const ip = req.socket.remoteAddress || "unknown";
		if (!isLocalhostServer && rateLimiter.isRateLimited(ip)) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			handleWebSocketConnection(ws, sessionId, req, sessionManager, config.authToken, rateLimiter, projectConfigStore, isLocalhostServer, sandboxTokenStore, projectContextManager);
		});
	});

	return {
		server,
		sessionManager,
		bgProcessManager,
		projectContextManager,
		async start(): Promise<number> {
			// Check internet and auto-configure AI Gateway if offline
			// Runs before session restore so models.json is written before
			// any agent subprocesses start.
			await startupAigwCheck(preferencesStore);
			writeContextWindowOverrides();
			writeOpenAIModelAdditions();

			// Initialize MCP servers (skip in test environments)
			if (!process.env.BOBBIT_SKIP_MCP) {
				try {
					await sessionManager.initMcp(process.cwd());
				} catch (err) {
					console.error('[mcp] MCP init failed:', (err as Error).message);
				}
			}

			// Wire verification harness before session restore so orphan cleanup can skip resuming sessions
			sessionManager.setVerificationHarness(verificationHarness);

			// ── Sandbox manager ──
			// Sandboxes are initialized lazily per-project on first sandbox use
			// (see SandboxManager.ensureForProject). The bootstrap closure below
			// runs the host-side plumbing (image build/version check, mounts,
			// credentials, sandbox network, GitHub token) the first time each
			// project's sandbox is requested by session/goal/staff creation.
			const sandboxBootstrap: SandboxBootstrap = async (projectId) => {
				const project = projectRegistry.get(projectId);
				if (!project) {
					throw new Error(`[sandbox] bootstrap: project ${projectId} not registered`);
				}
				const ctx = projectContextManager.getOrCreate(projectId);
				if (!ctx) {
					throw new Error(`[sandbox] bootstrap: cannot resolve context for project ${projectId}`);
				}
				const cfg = ctx.projectConfigStore;
				const sandboxCfg = cfg.get("sandbox") || "none";
				if (sandboxCfg !== "docker") return null;

				const projectDir = project.rootPath;
				const imageName = cfg.get("sandbox_image") || "bobbit-agent";

				// Auto-build or rebuild image if missing or stale. Images are
				// shared across projects (Docker image tags) so the first project
				// to request a sandbox pays the build cost.
				const imageStatus = await checkDockerAvailability(imageName);
				if (imageStatus.imageExists === false && imageStatus.dockerfileExists === true) {
					const buildResult = await buildSandboxImage(imageName, projectDir);
					if (!buildResult.success) {
						console.error(`[sandbox] Auto-build failed for project ${projectId}; proceeding will likely error`);
					}
				} else if (imageStatus.imageExists === true) {
					await ensureImageAgentVersion(imageName, projectDir);
				}

				const isRepo = await isGitRepo(projectDir);
				if (!isRepo) {
					console.log(`[sandbox] Project ${projectId} is not a git repo — sandbox disabled (worktrees require git)`);
					return null;
				}
				const repoPath = await getRepoRoot(projectDir);

				// Repo URL for cloning inside the container. Strip embedded tokens so
				// they don't leak into .git/config; the container's credential helper
				// reads GITHUB_TOKEN from env instead.
				let repoUrl: string;
				try {
					const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoPath, timeout: 5000 });
					repoUrl = stripTokenFromGitUrl(stdout.trim());
				} catch {
					repoUrl = repoPath;
				}

				let poolMounts: string[] = [];
				try {
					const mountsRaw = cfg.get("sandbox_mounts") || "";
					poolMounts = mountsRaw ? validateSandboxMounts(JSON.parse(mountsRaw), "[sandbox]") : [];
				} catch (err) { console.warn(`[sandbox] Invalid sandbox_mounts JSON for project ${projectId}, ignoring: ${err}`); }

				let poolCredentials: Record<string, string> = {};
				try {
					const credsRaw = cfg.get("sandbox_credentials") || "";
					poolCredentials = credsRaw ? JSON.parse(credsRaw) : {};
				} catch (err) { console.warn(`[sandbox] Invalid sandbox_credentials JSON for project ${projectId}, ignoring: ${err}`); }

				const sandboxNetwork = await sessionManager.ensureSandboxNetwork();

				const githubTokenEnabled = cfg.get("sandbox_github_token") !== "false";
				const githubToken = githubTokenEnabled ? resolveHostTokenValue("GITHUB_TOKEN") : undefined;

				const components = ctx.projectConfigStore.getComponents();
				// Multi-repo: try to resolve each repo's clone URL from `<rootPath>/<repo>/.git/config`.
				// Falls back to the project's primary `repoUrl` for any repo without
				// a remote configured (the bootstrap will then clone the same repo
				// into multiple paths — only useful as a defensive default).
				let repoUrlByName: Record<string, string> | undefined;
				if (components.some(c => c.repo !== ".")) {
					repoUrlByName = {};
					const seen = new Set<string>();
					for (const c of components) {
						if (c.repo === "." || seen.has(c.repo)) continue;
						seen.add(c.repo);
						const rp = path.join(projectDir, c.repo);
						try {
							const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: rp, timeout: 5000 });
							repoUrlByName[c.repo] = stripTokenFromGitUrl(stdout.trim());
						} catch {
							repoUrlByName[c.repo] = repoUrl;
						}
					}
				}

				return {
					projectId,
					projectDir,
					repoUrl,
					image: imageName,
					sandboxNetwork,
					sandboxMounts: poolMounts,
					sandboxCredentials: poolCredentials,
					githubToken,
					toolManager: ctx.toolManager,
					components,
					repoUrlByName,
				};
			};
			sandboxManager = new SandboxManager({ bootstrap: sandboxBootstrap });
			sessionManager.setSandboxManager(sandboxManager);
			sessionManager.subscribeSandboxRecovery();

			// Restore persisted sessions before accepting connections
			await sessionManager.restoreSessions();

			// NOTE: Orphaned worktree cleanup and non-interactive session cleanup
			// are no longer automatic on startup. Use the Settings → Maintenance UI
			// or the /api/maintenance/* endpoints to preview and clean up manually.

			sessionManager.startPurgeSchedule();

			// Initialize worktree pools for all git-repo projects
			// (pre-creates worktrees in the background so new sessions start instantly).
			// E2E / CI can skip this entirely via BOBBIT_SKIP_WORKTREE_POOL=1 — the
			// pool fills worktrees aggressively at boot and replenishes on every
			// claim, which costs real CPU on tests that don't need git at all.
			//
			// Boot sweeper + pool fill run AFTER `server.listen()` as a background
			// chain — the sweeper shells out to `git worktree list/repair` per repo
			// with 10–15s timeouts, and the pool readiness check awaits `isGitRepo`
			// per project. Doing them before listen used to leave the gateway
			// unreachable for many seconds on installs with stale worktrees.
			//
			// Concurrency note: the sweeper and the pool init operate on DISJOINT
			// branch sets — `worktree-sweeper.ts` explicitly skips pool branches
			// (`isPoolBranch`), and `WorktreePool.reclaimOrphaned` only inspects
			// pool branches. So the two phases are run concurrently via
			// `Promise.all`, and project-level pool init is also parallelised
			// across projects (each project's pool is independent). This avoids
			// the previous serial chain that left the pool empty for minutes on
			// installs with many stale worktrees, forcing every new session
			// through the cold path (full createWorktree + npm ci).
			const runBootBackgroundTasks = async (): Promise<void> => {
				const t0 = Date.now();

				const sweeperTask = (async () => {
					const tStart = Date.now();
					try {
						const { sweepOrphanedWorktrees } = await import("./agent/worktree-sweeper.js");
						const sweepProjects: Array<{ id: string; rootPath: string; repos?: string[] }> = [];
						const sweepGoals: Array<{ id: string; branch?: string; worktreePath?: string; archived?: boolean; repoWorktrees?: Record<string, string> }> = [];
						const sweepSessions: Array<{ id: string; branch?: string; worktreePath?: string; archived?: boolean; repoWorktrees?: Record<string, string> }> = [];
						const sweepStaff: Array<{ id: string; branch?: string; worktreePath?: string }> = [];
						for (const ctx of projectContextManager.all()) {
							const repoNames = ctx.projectConfigStore.repoNames();
							sweepProjects.push({
								id: ctx.project.id,
								rootPath: ctx.project.rootPath,
								repos: repoNames.length > 0 ? repoNames : undefined,
							});
							for (const g of ctx.goalStore.getAll()) {
								sweepGoals.push({
									id: g.id, branch: g.branch, worktreePath: g.worktreePath, archived: !!g.archived,
									repoWorktrees: (g as { repoWorktrees?: Record<string, string> }).repoWorktrees,
								});
							}
							for (const s of ctx.sessionStore.getAll()) {
								sweepSessions.push({
									id: s.id, branch: s.branch, worktreePath: s.worktreePath, archived: !!s.archived,
									repoWorktrees: s.repoWorktrees,
								});
							}
							for (const st of ctx.staffStore.getAll()) {
								sweepStaff.push({ id: st.id, branch: (st as any).branch, worktreePath: (st as any).worktreePath });
							}
						}
						console.log(`[boot] sweeper start (${sweepProjects.length} projects)`);
						const result = await sweepOrphanedWorktrees({
							projects: sweepProjects,
							goals: sweepGoals,
							sessions: sweepSessions,
							staff: sweepStaff,
						});
						console.log(`[boot] sweeper done in ${Date.now() - tStart}ms (reclaimed=${result.reclaimed} cleaned=${result.cleaned} repaired=${result.repaired})`);
					} catch (err) {
						console.warn(`[boot] sweeper failed in ${Date.now() - tStart}ms (non-fatal):`, err);
					}
				})();

				const poolInitTask = (async () => {
					if (process.env.BOBBIT_SKIP_WORKTREE_POOL) return;
					const contexts = Array.from(projectContextManager.all());
					console.log(`[boot] pool init start (${contexts.length} projects)`);
					await Promise.all(contexts.map(async (ctx) => {
						const tStart = Date.now();
						try {
							const repoPath = ctx.project.rootPath;
							const components = ctx.projectConfigStore.getComponents();
							const isMulti = components.some(c => c.repo !== ".");
							let poolReady = false;
							if (isMulti) {
								const seen = new Set<string>();
								poolReady = true;
								for (const c of components) {
									if (c.repo === "." || seen.has(c.repo)) continue;
									seen.add(c.repo);
									if (!(await isGitRepo(path.join(repoPath, c.repo)))) { poolReady = false; break; }
								}
							} else {
								poolReady = await isGitRepo(repoPath);
							}
							if (poolReady) {
								const poolSize = parseInt(ctx.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
								const wtRoot = ctx.projectConfigStore.get("worktree_root") || undefined;
								const pcs = ctx.projectConfigStore;
								// Single-repo: resolve nested rootPath to the actual git toplevel so
								// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
								const poolRepoPath = isMulti ? repoPath : await getRepoRoot(repoPath);
								sessionManager.initWorktreePoolForProject(ctx.project.id, poolRepoPath, () => pcs.getComponents(), poolSize, wtRoot);
								console.log(`[boot] pool ready: project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							} else {
								console.log(`[boot] pool skipped (not a git repo): project=${ctx.project.id} in ${Date.now() - tStart}ms`);
							}
						} catch (err) {
							console.warn(`[boot] pool init failed: project=${ctx.project.id} in ${Date.now() - tStart}ms (non-fatal):`, err);
						}
					}));
				})();

				await Promise.all([sweeperTask, poolInitTask]);
				console.log(`[boot] background tasks complete in ${Date.now() - t0}ms`);
			};

			// Wire goal-manager resolvers so goals claim through the pool first and
			// resolve components / project root for multi-repo goal creation.
			for (const ctx of projectContextManager.all()) {
				const projectId = ctx.project.id;
				ctx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(projectId));
				ctx.goalManager.setComponentsResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c ? c.projectConfigStore.getComponents() : [];
				});
				ctx.goalManager.setProjectRootResolver((pid: string) => {
					return projectRegistry.get(pid)?.rootPath;
				});
				ctx.goalManager.setWorktreeRootResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c?.projectConfigStore.get("worktree_root") || undefined;
				});
			}

			// Now that sessions are live, re-subscribe to team events
			// (must happen after restoreSessions so session objects exist)
			teamManager.resubscribeTeamEvents();

			// Resume any verifications that were interrupted by a server restart (fire-and-forget)
			verificationHarness.resumeInterruptedVerifications().catch(err => {
				console.error("[verification] Error resuming interrupted verifications:", err);
			});

			// Port 0 = let OS assign a free port; skip the auto-increment loop
			if (config.port === 0) {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, config.host, () => {
						server.removeListener("error", reject);
						resolve();
					});
				});
				const addr = server.address() as import("node:net").AddressInfo;
				void runBootBackgroundTasks();
				return addr.port;
			}

			const maxPort = config.portExplicit !== false ? config.port : config.port + 9;
			let port = config.port;

			while (port <= maxPort) {
				try {
					await new Promise<void>((resolve, reject) => {
						server.once("error", reject);
						server.listen(port, config.host, () => {
							server.removeListener("error", reject);
							resolve();
						});
					});
					if (port !== config.port) {
						console.log(`Port ${config.port} in use, using port ${port}`);
					}
					void runBootBackgroundTasks();
					return port;
				} catch (err: any) {
					if (err.code === "EADDRINUSE" && port < maxPort) {
						console.log(`Port ${port} in use, trying ${port + 1}...`);
						port++;
						continue;
					}
					throw err;
				}
			}
			throw new Error(`All ports ${config.port}-${maxPort} in use`);
		},
		async shutdown() {
			clearInterval(cleanupInterval);
			triggerEngine.stop();
			wss.close();
			for (const pool of sessionManager.getAllWorktreePools().values()) {
				await pool.drain();
			}
			await sessionManager.shutdown();
			projectContextManager.closeAll();
			if (sandboxManager) {
				await sandboxManager.shutdownAll();
			}
			await sessionManager.cleanupSandboxNetwork();
			server.close();
		},
	};
}

// isSetupComplete now lives in ./setup-status.ts (re-exported at top of file).

import {
	redactSandboxSecrets,
	redactSandboxSecretsResolved,
	mergeSecretsIntoTokens,
	mergeSandboxTokensStructured,
	mergeSandboxSecrets,
} from "./agent/sandbox-secrets.js";

async function handleApiRoute(
	url: URL,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	sessionManager: SessionManager,
	config: GatewayConfig,
	colorStore: ColorStore,
	prStatusStore: PrStatusStore,
	teamManager: TeamManager,
	roleManager: RoleManager,
	toolManager: ToolManager,
	projectContextManager: ProjectContextManager,
	bgProcessManager: BgProcessManager,
	_staffManager: StaffManager,
	verificationHarness: VerificationHarness,
	_preferencesStore: PreferencesStore,
	projectConfigStore: ProjectConfigStore,
	_groupPolicyStore: ToolGroupPolicyStore,
	broadcastToGoal: (goalId: string, event: any) => void,
	broadcastToAll: (event: any) => void,
	sandboxManager: SandboxManager | null,
	projectRegistry: ProjectRegistry,
	configCascade: ConfigCascade,
	sandboxScope?: SandboxScope,
	sandboxTokenStore?: SandboxTokenStore,
	reviewAnnotationStore?: ReviewAnnotationStore,
	_broadcastToSession?: (sessionId: string, event: any) => void,
	roleStore?: RoleStore,
) {
	// These are always wired by the sole caller; the optional markers are only to avoid
	// touching every existing signature site.
	void roleStore;
	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};
	const jsonError = (status: number, err: unknown, extra?: Record<string, unknown>) => {
		const e = err instanceof Error ? err : new Error(String(err));
		json({ error: e.message, stack: e.stack, ...extra }, status);
	};

	// ── Cross-project helper functions ─────────────────────────────

	/** Retrieve a goal from any project context. */
	function getGoalAcrossProjects(goalId: string): PersistedGoal | undefined {
		const ctx = projectContextManager.getContextForGoal(goalId);
		return ctx?.goalStore.get(goalId);
	}

	/** List live goals across all projects, optionally filtered by projectId. */
	function listGoalsAcrossProjects(opts?: { projectId?: string }): PersistedGoal[] {
		if (opts?.projectId) {
			const ctx = projectContextManager.getOrCreate(opts.projectId);
			return ctx ? ctx.goalStore.getLive() : [];
		}
		return projectContextManager.getAllLiveGoals();
	}

	/** Get a GoalManager for the project that owns the given goal. Throws if not found. */
	function getGoalManagerForGoal(goalId: string): GoalManager {
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
		return ctx.goalManager;
	}

	// ── Project Detection & Browse ────────────────────────────────────

	// ── Project CRUD ──────────────────────────────────────────────────

	// POST /api/projects
	if (url.pathname === "/api/projects" && req.method === "POST") {
		const body = await readBody(req);
		if (typeof body?.name !== "string" || typeof body?.rootPath !== "string") {
			json({ error: "Missing name or rootPath" }, 400);
			return;
		}
		// Validate components[].config eagerly (mirrors propose_project tool).
		{
			const err = validateComponentsConfig((body as Record<string, unknown>).components);
			if (err) { json({ error: err }, 400); return; }
		}
		try {
			const upsert = body.upsert === true;
			const color = typeof body.color === "string" ? body.color : undefined;
			const palette = typeof body.palette === "string" ? body.palette : undefined;
			const colorLight = typeof body.colorLight === "string" ? body.colorLight : undefined;
			const colorDark = typeof body.colorDark === "string" ? body.colorDark : undefined;

			// Upsert: if a project already exists at this path, return it
			if (upsert) {
				const existing = projectRegistry.getByPath(body.rootPath);
				if (existing) {
					// Ensure context is initialized
					const ctx = projectContextManager.getOrCreate(existing.id);
					if (ctx) {
						ctx.gateStore.onStatusChange = () => {
							ctx.goalStore.bumpGeneration();
						};
						ctx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(existing.id));
						ctx.goalManager.setComponentsResolver((pid: string) => {
							const c = projectContextManager.getOrCreate(pid);
							return c ? c.projectConfigStore.getComponents() : [];
						});
						ctx.goalManager.setProjectRootResolver((pid: string) => projectRegistry.get(pid)?.rootPath);
						ctx.goalManager.setWorktreeRootResolver((pid: string) => {
							const c = projectContextManager.getOrCreate(pid);
							return c?.projectConfigStore.get("worktree_root") || undefined;
						});
					}
					json(existing, 200);
					return;
				}
			}

			const acceptCanonical = body.acceptCanonical === true;
			let project;
			try {
				project = projectRegistry.register(body.name, body.rootPath, { color, palette, colorLight, colorDark, acceptCanonical });
			} catch (regErr: any) {
				if (regErr instanceof SymlinkProjectRootError) {
					json({
						error: "Project root is a symlink",
						code: "symlink_root",
						rootPath: regErr.rootPath,
						canonical: regErr.canonical,
					}, 400);
					return;
				}
				throw regErr;
			}
			// Initialize project context for the new project
			const newCtx = projectContextManager.getOrCreate(project.id);
			if (newCtx) {
				newCtx.gateStore.onStatusChange = () => {
					newCtx.goalStore.bumpGeneration();
				};
			}

			// Multi-repo: accept optional components / workflows in the create body.
			// Single-repo without components → fill default `[{name: <project name>, repo: "."}]`.
			const createComponents = (body as Record<string, unknown>).components;
			const createWorkflows = (body as Record<string, unknown>).workflows;
			if (newCtx) {
				if (Array.isArray(createComponents) && createComponents.length > 0) {
					if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
						try {
							const { validateAllWorkflows } = await import("./agent/workflow-validator.js");
							const errors = validateAllWorkflows(
								createWorkflows as Parameters<typeof validateAllWorkflows>[0],
								createComponents as Parameters<typeof validateAllWorkflows>[1],
							);
							if (errors.length > 0) {
								projectRegistry.remove(project.id);
								json({ error: "Workflow validation failed", details: errors }, 400);
								return;
							}
						} catch { /* best-effort */ }
					}
					const normalized = (createComponents as Array<Record<string, unknown>>).map(c => ({
						name: String(c.name ?? ""),
						repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
						relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
						worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
						commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
						config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
					}));
					newCtx.projectConfigStore.setComponents(normalized);
					if (createWorkflows && typeof createWorkflows === "object" && !Array.isArray(createWorkflows)) {
						newCtx.projectConfigStore.setWorkflows(createWorkflows as Record<string, import("./agent/project-config-store.js").InlineWorkflowDef>);
					}
				} else {
					// Default single-repo component named after the project.
					if (newCtx.projectConfigStore.getComponents().length === 0) {
						newCtx.projectConfigStore.setComponents([{ name: project.name, repo: "." }]);
					}
				}
				// No default-workflow seeding. Workflows must be designed by the
				// project assistant; a project may legitimately have zero workflows.
			}
			// Initialize worktree pool if the new project is a git repo.
			// Respect BOBBIT_SKIP_WORKTREE_POOL for E2E/CI.
			if (!process.env.BOBBIT_SKIP_WORKTREE_POOL) {
				try {
					// Multi-repo: rootPath is a container dir, individual repos sit
					// under <rootPath>/<repo>/. We treat that case as "git-ready" if
					// every declared repo subdir is a git repo.
					const components = newCtx?.projectConfigStore.getComponents() ?? [];
					const isMulti = components.some(c => c.repo !== ".");
					let poolReady = false;
					if (isMulti) {
						const seen = new Set<string>();
						poolReady = true;
						for (const c of components) {
							if (c.repo === "." || seen.has(c.repo)) continue;
							seen.add(c.repo);
							if (!(await isGitRepo(path.join(body.rootPath, c.repo)))) { poolReady = false; break; }
						}
					} else {
						poolReady = await isGitRepo(body.rootPath);
					}
					if (poolReady) {
						const poolSize = parseInt(newCtx?.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
						const wtRoot = newCtx?.projectConfigStore.get("worktree_root") || undefined;
						const pcs = newCtx?.projectConfigStore;
						// Single-repo: resolve nested rootPath to the actual git toplevel so
						// pool entries land under <gitRoot>-wt/, not <projectDir>-wt/.
						const poolRepoPath = isMulti ? body.rootPath : await getRepoRoot(body.rootPath);
						sessionManager.initWorktreePoolForProject(project.id, poolRepoPath, pcs ? () => pcs.getComponents() : undefined, poolSize, wtRoot);
					}
				} catch { /* best-effort */ }
			}
			// Wire the goal-manager pool resolver for the new project (Phase 3 — goals via pool).
			if (newCtx) {
				newCtx.goalManager.setPoolResolver(() => sessionManager.getWorktreePool(project.id));
				newCtx.goalManager.setComponentsResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c ? c.projectConfigStore.getComponents() : [];
				});
				newCtx.goalManager.setProjectRootResolver((pid: string) => projectRegistry.get(pid)?.rootPath);
				newCtx.goalManager.setWorktreeRootResolver((pid: string) => {
					const c = projectContextManager.getOrCreate(pid);
					return c?.projectConfigStore.get("worktree_root") || undefined;
				});
			}
			json(project, 201);
		} catch (err: any) {
			jsonError(400, err);
		}
		return;
	}

	// GET/PUT /api/projects/:id/config, GET /api/projects/:id/config/defaults, GET /api/projects/:id/config/resolved
	const projectConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/config(?:\/(defaults|resolved))?$/);
	if (projectConfigMatch) {
		const ctx = projectContextManager.getOrCreate(projectConfigMatch[1]);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		const suffix = projectConfigMatch[2]; // undefined | "defaults" | "resolved"

		if (req.method === "GET" && !suffix) {
			const flat = ctx.projectConfigStore.getAll();
			// Upgrade migrated keys to native structured form for the wire response.
			const config: Record<string, unknown> = { ...flat };
			config.config_directories = ctx.projectConfigStore.getConfigDirectories();
			config.sandbox_tokens = ctx.projectConfigStore.getSandboxTokens();
			// Defence in depth: legacy top-level qa_* keys must never appear on
			// the wire. Migration removes them on boot; strip again here in case
			// a stale on-disk value slipped through.
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete config[k];
			mergeSecretsIntoTokens(config, ctx.secretsStore);
			json(redactSandboxSecrets(config));
			return;
		}
		if (req.method === "GET" && suffix === "defaults") {
			json(ctx.projectConfigStore.getDefaults());
			return;
		}
		if (req.method === "GET" && suffix === "resolved") {
			const defaults = ctx.projectConfigStore.getDefaults();
			const result: Record<string, { value: unknown; source: string }> = {};
			// Include all default keys
			for (const key of Object.keys(defaults)) {
				result[key] = resolveScalarConfig(key, ctx.projectConfigStore, projectConfigStore, null, defaults);
			}
			// Also include custom keys from the project's own config that aren't in defaults
			const rawConfig = ctx.projectConfigStore.getAll();
			for (const key of Object.keys(rawConfig)) {
				if (!(key in result)) {
					result[key] = { value: rawConfig[key], source: "project" };
				}
			}
			// Include custom keys from the server-level config that aren't already covered
			const serverRaw = projectConfigStore.getAll();
			for (const key of Object.keys(serverRaw)) {
				if (!(key in result)) {
					result[key] = { value: serverRaw[key], source: "server" };
				}
			}
			// Override migrated fields with structured values (resolveScalarConfig returns flat strings).
			const migratedSource = (key: string): string => {
				return (rawConfig[key] !== undefined && rawConfig[key] !== "") ? "project"
					: (serverRaw[key] !== undefined && serverRaw[key] !== "") ? "server"
					: "default";
			};
			result.config_directories = { value: ctx.projectConfigStore.getConfigDirectories(), source: migratedSource("config_directories") };
			result.sandbox_tokens = { value: ctx.projectConfigStore.getSandboxTokens(), source: migratedSource("sandbox_tokens") };
			// Defence in depth: strip legacy top-level qa_* keys.
			for (const k of LEGACY_QA_TOP_LEVEL_KEYS) delete result[k];
			// Merge secrets into sandbox_tokens (structured) for the resolved response.
			if (Array.isArray(result.sandbox_tokens.value)) {
				const tempConfig: Record<string, unknown> = { sandbox_tokens: result.sandbox_tokens.value };
				mergeSecretsIntoTokens(tempConfig, ctx.secretsStore);
				result.sandbox_tokens = { value: tempConfig.sandbox_tokens, source: result.sandbox_tokens.source };
			}
			json(redactSandboxSecretsResolved(result));
			return;
		}
		if (req.method === "PUT" && !suffix) {
			const body = await readBody(req);
			if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }

			// Reject legacy top-level qa_* keys — they have moved into
			// `components[<name>].config`. Done before any other parsing so the
			// error is fast and unambiguous.
			for (const key of LEGACY_QA_TOP_LEVEL_KEYS) {
				if (key in (body as Record<string, unknown>)) {
					json({ error: `${key} settings have moved to components[].config[]; set components[<name>].config.${key} instead` }, 400);
					return;
				}
			}

			// Validate components[].config eagerly (mirrors propose_project tool).
			{
				const err = validateComponentsConfig((body as Record<string, unknown>).components);
				if (err) { json({ error: err }, 400); return; }
			}

			// Extract structured fields (components / workflows) before flat-key validation.
			let components = (body as Record<string, unknown>).components;
			const workflows = (body as Record<string, unknown>).workflows;
			delete (body as Record<string, unknown>).components;
			delete (body as Record<string, unknown>).workflows;

			// Back-compat: legacy top-level *_command fields (build_command, test_command, etc.)
			// are folded into components[0].commands when no `components` field was supplied.
			// This keeps the propose_project tool, the project assistant, and the provisional
			// promotion path working after Follow-up A removed the legacy schema. Existing
			// components stored on disk are not modified — callers who want to update components
			// must pass a fresh `components` array. See multi-repo follow-up Issue 2 / Issue 5.
			if (!Array.isArray(components)) {
				const LEGACY_KEY_MAP: Record<string, string> = {
					build_command: "build",
					test_command: "test",
					typecheck_command: "check",
					test_unit_command: "unit",
					test_e2e_command: "e2e",
				};
				const legacyCmds: Record<string, string> = {};
				for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
					const v = (body as Record<string, unknown>)[legacyKey];
					if (typeof v === "string" && v.trim().length > 0) legacyCmds[newKey] = v.trim();
				}
				const legacyHook = (body as Record<string, unknown>).worktree_setup_command;
				const hasAnyLegacy = Object.keys(legacyCmds).length > 0
					|| (typeof legacyHook === "string" && legacyHook.trim().length > 0);
				if (hasAnyLegacy) {
					const existing = ctx.projectConfigStore.getComponents();
					const defaultName = existing[0]?.name || ctx.project.name || "default";
					const defaultRepo = existing[0]?.repo || ".";
					const mergedCommands = { ...(existing[0]?.commands ?? {}), ...legacyCmds };
					const defaultComponent: Record<string, unknown> = {
						name: defaultName,
						repo: defaultRepo,
						commands: mergedCommands,
					};
					if (existing[0]?.relativePath) defaultComponent.relative_path = existing[0].relativePath;
					const hookValue = (typeof legacyHook === "string" && legacyHook.trim().length > 0)
						? legacyHook.trim()
						: existing[0]?.worktreeSetupCommand;
					if (hookValue) defaultComponent.worktree_setup_command = hookValue;
					// Preserve existing per-component config (qa_* keys etc.) — the legacy
					// flat-key write path must not silently wipe it.
					if (existing[0]?.config && Object.keys(existing[0].config).length > 0) {
						defaultComponent.config = { ...existing[0].config };
					}
					// Replace the first component but preserve any additional components on disk.
					const remaining = existing.slice(1).map(c => {
						const entry: Record<string, unknown> = { name: c.name, repo: c.repo };
						if (c.relativePath) entry.relative_path = c.relativePath;
						if (c.worktreeSetupCommand) entry.worktree_setup_command = c.worktreeSetupCommand;
						if (c.commands) entry.commands = c.commands;
						if (c.config && Object.keys(c.config).length > 0) entry.config = { ...c.config };
						return entry;
					});
					components = [defaultComponent, ...remaining];
				}
				// Legacy flat keys remain in `body` so they are ALSO written as legacy
				// flat-config entries (preserves GET round-trip for existing API clients
				// that only know the legacy schema). The structural components mirror is
				// the source of truth for workflow steps and the Components UI.
			}

			// Validate ALL flat keys before writing ANY (atomic: all-or-nothing)
			for (const [key] of Object.entries(body)) {
				if (key.includes(".")) {
					json({ error: `Config key "${key}" must not contain dots` }, 400);
					return;
				}
			}

			// Validate workflows structurally if both components and workflows are present.
			if (components && workflows && Array.isArray(components) && typeof workflows === "object") {
				try {
					const { validateAllWorkflows } = await import("./agent/workflow-validator.js");
					const errors = validateAllWorkflows(
						workflows as Parameters<typeof validateAllWorkflows>[0],
						components as Parameters<typeof validateAllWorkflows>[1],
					);
					if (errors.length > 0) {
						json({ error: "Workflow validation failed", details: errors }, 400);
						return;
					}
				} catch (err) {
					console.warn("[server] workflow validation skipped:", err);
				}
			}

			// Native-YAML migrated fields: reject legacy string payloads (must be structured
			// types or null/empty to clear). For sandbox_tokens we still need to merge
			// redacted values via mergeSandboxSecrets; the merge helper now operates on
			// structured arrays.
			const migratedExtracted: Record<string, unknown> = {};
			const MIGRATED_FIELDS = [
				{ key: "config_directories", expect: "array" as const },
				{ key: "sandbox_tokens", expect: "array" as const },
			];
			for (const { key, expect } of MIGRATED_FIELDS) {
				if (!(key in body)) continue;
				const v = (body as Record<string, unknown>)[key];
				if (v === null || v === "") {
					migratedExtracted[key] = null;
					delete (body as Record<string, unknown>)[key];
					continue;
				}
				if (typeof v === "string") {
					json({ error: `Field "${key}" must be sent as a structured ${expect}, not a JSON-encoded string` }, 400);
					return;
				}
				if (expect === "array" && !Array.isArray(v)) {
					json({ error: `Field "${key}" must be an array` }, 400);
					return;
				}
				migratedExtracted[key] = v;
				delete (body as Record<string, unknown>)[key];
			}

			// Merge secrets for migrated structured sandbox_tokens, and for any legacy
			// keys that still carry inline credentials (sandbox_credentials).
			if (Array.isArray(migratedExtracted.sandbox_tokens)) {
				migratedExtracted.sandbox_tokens = mergeSandboxTokensStructured(
					migratedExtracted.sandbox_tokens as Array<{ key: string; enabled?: boolean; value?: string }>,
					ctx.secretsStore,
				);
			}
			mergeSandboxSecrets(body as Record<string, string>, ctx.projectConfigStore, ctx.secretsStore);

			// Write legacy flat keys.
			for (const [key, value] of Object.entries(body)) {
				if (value === null || value === "") {
					ctx.projectConfigStore.remove(key);
				} else if (typeof value === "string") {
					ctx.projectConfigStore.set(key, value);
				}
			}

			// Apply migrated structured fields via typed setters.
			if ("config_directories" in migratedExtracted) {
				const v = migratedExtracted.config_directories;
				if (v === null) {
					ctx.projectConfigStore.remove("config_directories");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setConfigDirectories(
						v.filter((e: any) => e && typeof e === "object" && typeof e.path === "string").map((e: any) => ({
							path: String(e.path),
							types: Array.isArray(e.types) ? e.types.filter((t: unknown): t is string => typeof t === "string") : [],
						})),
					);
				}
			}
			if ("sandbox_tokens" in migratedExtracted) {
				const v = migratedExtracted.sandbox_tokens;
				if (v === null) {
					ctx.projectConfigStore.remove("sandbox_tokens");
				} else if (Array.isArray(v)) {
					ctx.projectConfigStore.setSandboxTokens(
						v.filter((e: any) => e && typeof e === "object" && typeof e.key === "string").map((e: any) => ({
							key: String(e.key),
							enabled: e.enabled !== false,
						})),
					);
				}
			}

			// Persist structured fields if provided.
			if (Array.isArray(components)) {
				const normalized = (components as Array<Record<string, unknown>>).map(c => ({
					name: String(c.name ?? ""),
					repo: typeof c.repo === "string" && c.repo ? c.repo : ".",
					relativePath: typeof c.relative_path === "string" ? c.relative_path : (typeof c.relativePath === "string" ? c.relativePath as string : undefined),
					worktreeSetupCommand: typeof c.worktree_setup_command === "string" ? c.worktree_setup_command : (typeof c.worktreeSetupCommand === "string" ? c.worktreeSetupCommand as string : undefined),
					commands: c.commands && typeof c.commands === "object" && !Array.isArray(c.commands) ? c.commands as Record<string, string> : undefined,
					config: c.config && typeof c.config === "object" && !Array.isArray(c.config) ? c.config as Record<string, string> : undefined,
				}));
				ctx.projectConfigStore.setComponents(normalized);
			}
			if (workflows && typeof workflows === "object" && !Array.isArray(workflows)) {
				ctx.projectConfigStore.setWorkflows(workflows as Record<string, import("./agent/project-config-store.js").InlineWorkflowDef>);
			}

			json({ ok: true });
			return;
		}
	}

	// GET /api/search
	if (url.pathname === "/api/search" && req.method === "GET") {
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
			const projectNames = new Map(projectRegistry.list().map(p => [p.id, p.name]));
			const results = await projectContextManager.searchAll(q, { type, limit, offset, projectId, projectNames });
			json(results);
		} catch (err) {
			json({ error: `Search failed: ${err}` }, 500);
		}
		return;
	}

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

	// GET /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "GET") {
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
		// Support ?include=archived to return archived sessions too
		if (url.searchParams.get("include") === "archived") {
			// Collect archived sessions across all project contexts
			const allArchived: typeof sessions = [];
			for (const ctx of projectContextManager.all()) {
				const store = ctx.sessionStore;
				for (const s of store.getArchived()) {
					allArchived.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" } as any);
				}
			}
			// Sort by archivedAt descending
			allArchived.sort((a: any, b: any) => ((b as any).archivedAt ?? 0) - ((a as any).archivedAt ?? 0));
			// Apply projectId filter if present
			const filteredArchived = filterProjectId
				? allArchived.filter((s: any) => s.projectId === filterProjectId)
				: allArchived;

			// Collect ALL archived sessions for BFS enrichment (not just delegates)
			const allArchivedForBfs: typeof sessions = [];
			for (const ctx of projectContextManager.all()) {
				for (const s of ctx.sessionStore.getArchived()) {
					allArchivedForBfs.push({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any);
				}
			}
			// Build live goal IDs for BFS seeding
			const liveGoalIds: string[] = [];
			for (const ctx of projectContextManager.all()) {
				for (const g of ctx.goalStore.getLive()) {
					if (!g.archived) liveGoalIds.push(g.id);
				}
			}

			const limitParam = url.searchParams.get("limit");
			const afterParam = url.searchParams.get("after");
			if (limitParam) {
				// Paginated archived sessions
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

				// BFS: collect archived children reachable from live sessions and goals
				const liveIdSet = new Set(sessions.map(s => s.id));
				const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

				json({ generation: currentGen, sessions: [...sessions, ...sliced], total, hasMore, nextCursor, archivedDelegates: archivedDelegatesOfLive });
			} else {
				// BFS: collect archived children reachable from live sessions and goals
				const liveIdSet = new Set(sessions.map(s => s.id));
				const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIds], allArchivedForBfs);

				// Backward compatible: return all archived sessions
				json({ generation: currentGen, sessions: [...sessions, ...filteredArchived], archivedDelegates: archivedDelegatesOfLive });
			}
		} else {
			// Always include archived children of live sessions/goals so the sidebar
			// can render chevrons/nesting without a separate fetch.
			const liveIdSet = new Set(sessions.map(s => s.id));
			const allArchivedForBfsNonPaginated: typeof sessions = [];
			for (const ctx of projectContextManager.all()) {
				for (const s of ctx.sessionStore.getArchived()) {
					allArchivedForBfsNonPaginated.push({ ...s, colorIndex: colorStore.get(s.id), archived: true } as any);
				}
			}
			// Build live goal IDs for BFS seeding
			const liveGoalIdsNonPaginated: string[] = [];
			for (const ctx of projectContextManager.all()) {
				for (const g of ctx.goalStore.getLive()) {
					if (!g.archived) liveGoalIdsNonPaginated.push(g.id);
				}
			}
			// BFS: live parents/goals → their archived children → children of those, etc.
			const archivedDelegatesOfLive = bfsEnrichArchived([...liveIdSet, ...liveGoalIdsNonPaginated], allArchivedForBfsNonPaginated);
			json({ generation: currentGen, sessions, archivedDelegates: archivedDelegatesOfLive });
		}
		return;
	}

	// POST /api/sessions/:id/activate-skill — autonomous skill activation
	const activateSkillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/activate-skill$/);
	if (activateSkillMatch && req.method === "POST") {
		const sessionId = activateSkillMatch[1];
		const session = sessionManager.getSession(sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const body = await readBody(req);
		const skillName = typeof body?.name === "string" ? body.name : "";
		const skillArgs = typeof body?.args === "string" ? body.args : "";
		if (!skillName) {
			json({ error: "name is required" }, 400);
			return;
		}
		// Resolve skill discovery context: host-side cwd + per-project store.
		let resolvedConfigStore: { get(key: string): string | undefined } | undefined = projectConfigStore;
		let skillCwd = session.cwd;
		if (session.projectId) {
			const pcm = (sessionManager as any).projectContextManager as import("./agent/project-context-manager.js").ProjectContextManager | undefined;
			const ctx = pcm?.getOrCreate(session.projectId);
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
		// Inject the activation header so autonomous activation is byte-equal
		// to user `/<name>` invocation.
		const pathRewrite = session.sandboxed
			? (hostPath: string): string | null => {
				// Project worktree mounts at /workspace; rewrite when the host
				// path lives under it. Built-in / personal skills aren't mounted.
				const projectRoot = (session.projectId
					? ((sessionManager as any).projectContextManager as import("./agent/project-context-manager.js").ProjectContextManager | undefined)?.getOrCreate(session.projectId)?.project.rootPath
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
		return;
	}

	// POST /api/sessions/:id/tool-grant-request — long-polling endpoint called by guard extension
	const toolGrantMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/tool-grant-request$/);
	if (toolGrantMatch && req.method === "POST") {

		const sessionId = toolGrantMatch[1];
		const body = await readBody(req);
		if (!body || !body.toolName || !body.toolGroup) {
			json({ error: "toolName and toolGroup required" }, 400);
			return;
		}
		try {
			const result = await sessionManager.requestToolGrant(sessionId, body.toolName, body.toolGroup);
			json(result);
		} catch (err: any) {
			jsonError(500, err);
		}
		return;
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
			// Legacy boolean fields for backward compat
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
			// Persisted model selection (provider+id). Surfaces the result of
			// the WS `set_model` handler's `persistSessionModel` call so clients
			// (and tests) can verify the selection round-tripped to disk without
			// reaching into the WS state stream.
			modelProvider: sessionPs?.modelProvider,
			modelId: sessionPs?.modelId,
			restoreError: session.restoreError,
			lastTurnErrored: session.lastTurnErrored ?? false,
			consecutiveErrorTurns: session.consecutiveErrorTurns ?? 0,
			completedTurnCount: session.completedTurnCount ?? 0,
			imageGenerationModel: sessionManager.getImageModelForSession(session.id),
		});
		return;
	}

	// POST /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "POST") {
		const __t0 = performance.now();
		try {
		const body = await readBody(req);

		// ── Delegate session creation ──
		if (body?.delegateOf && body?.instructions) {
			// Sandbox guard: delegate parent must be own session or registered child
			if (sandboxScope) {
				const parentId = body.delegateOf;
				if (!sandboxScope.sessionIds.has(parentId)) {
					json({ error: "Forbidden: delegate parent must be own session" }, 403);
					return;
				}
			}
			try {
				const cwd = body.cwd || config.defaultCwd;
				const session = await sessionManager.createDelegateSession(body.delegateOf, {
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

		// If creating under a goal, use the goal's cwd as default
		let cwd = body?.cwd || config.defaultCwd;
		// If a projectId is provided and no explicit cwd, use the project's rootPath
		if (!body?.cwd && body?.projectId && typeof body.projectId === "string") {
			const proj = projectRegistry.get(body.projectId);
			if (proj) cwd = proj.rootPath;
		}
		if (goalId) {
			const goal = getGoalAcrossProjects(goalId);
			if (goal) {
				cwd = body?.cwd || goal.cwd;
				// Auto-transition goal to in-progress when first session starts
				if (goal.state === "todo") {
					await getGoalManagerForGoal(goalId).updateGoal(goalId, { state: "in-progress" });
				}
			}
		}

		const args = body?.args;

		// If a roleId is provided, look up the role and pass its prompt/tools/accessory
		const roleId = body?.roleId;
		let createOpts: { rolePrompt?: string; roleName?: string; role?: string; accessory?: string } | undefined;

		if (roleId && typeof roleId === "string") {
			const role = roleManager.getRole(roleId);
			if (!role) {
				json({ error: `Role "${roleId}" not found` }, 404);
				return;
			}
			createOpts = {
				rolePrompt: role.promptTemplate,
				roleName: role.name,
				role: role.name,
				accessory: role.accessory,
			};
		}

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

		// ── Sandbox validation ──
		// Sandbox-scoped tokens MUST create sandboxed sessions — prevent escape
		let sandboxed = body?.sandboxed === true;
		if (sandboxScope) sandboxed = true;
		if (sandboxed) {
			const sandboxConfig = projectConfigStore.get("sandbox") || "none";
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

		// Auto-detect projectId from cwd if not explicitly provided.
		// Project assistant sessions (assistantType "project" or "project-scaffolding") are
		// setting up a NEW project — they get a provisional project registration so sessions
		// persist under their own project context (survives page refresh).
		const isProjectAssistant = assistantType === "project" || assistantType === "project-scaffolding";
		let resolvedProjectId = body?.projectId as string | undefined;
		let provisionalProjectId: string | undefined;

		// If re-attempting a goal, inherit cwd and projectId from the original goal
		if (reattemptGoalId && !body?.cwd) {
			const origGoal = getGoalAcrossProjects(reattemptGoalId);
			if (origGoal) {
				cwd = origGoal.cwd || cwd;
				if (!resolvedProjectId && origGoal.projectId) resolvedProjectId = origGoal.projectId;
			}
		}

		// Guard against stale cwd (e.g. re-attempting a goal whose worktree was deleted,
		// or a project whose rootPath is gone). spawn("node", { cwd }) on Windows
		// reports a missing cwd as ENOENT, masquerading as if the `node` binary was missing.
		// Fall back to the project rootPath when we have a resolved project to anchor the
		// fallback. If no project is resolved yet, leave cwd alone — the resolver below
		// will reject a bogus cwd with the canonical 400 rather than silently rewriting
		// it to defaultCwd (which would mask user error and match an unrelated project).
		if (cwd && !fs.existsSync(cwd) && resolvedProjectId) {
			const staleCwd = cwd;
			const proj = projectRegistry.get(resolvedProjectId);
			let fallback: string | undefined;
			if (proj && fs.existsSync(proj.rootPath)) fallback = proj.rootPath;
			if (!fallback && fs.existsSync(config.defaultCwd)) fallback = config.defaultCwd;
			if (fallback) {
				console.warn(`[POST /api/sessions] cwd ${staleCwd} does not exist — falling back to ${fallback}`);
				cwd = fallback;
			} else {
				json({ error: `Working directory does not exist: ${staleCwd}` }, 400);
				return;
			}
		}

		// For project assistants, register a provisional project at the target cwd
		if (isProjectAssistant && cwd && !resolvedProjectId) {
			const provisionalProject = projectRegistry.registerProvisional(path.basename(cwd), cwd);
			provisionalProjectId = provisionalProject.id;
			resolvedProjectId = provisionalProject.id;
			// Ensure a ProjectContext exists for the provisional project
			const provCtx = projectContextManager.getOrCreate(provisionalProject.id);
			if (provCtx) {
				provCtx.gateStore.onStatusChange = () => {
					provCtx.goalStore.bumpGeneration();
				};
			}
		}

		// Project must be resolvable explicitly or from cwd — no silent default fallback.
		// (Provisional-project handling above may already have set resolvedProjectId;
		// if so, skip the resolver.)
		if (!resolvedProjectId) {
			const resolved = resolveProjectForRequest(projectRegistry, projectContextManager, { projectId: body?.projectId, cwd });
			if (!resolved.ok) { json({ error: resolved.error }, resolved.status); return; }
			resolvedProjectId = resolved.projectId;
		}

		// Now that `resolvedProjectId` is known, resolve `worktreeOpts`.
		// Multi-repo (poly-repo) short-circuit mirrors goal-manager.ts::createGoal:
		// if any component has repo !== ".", the project's rootPath IS the repoPath
		// even though it isn't itself a git repo. Without this, the `isGitRepo(cwd)`
		// check below returns false for the container directory and sessions would
		// run with no worktree at all.
		if (wantWorktree) {
			try {
				const projCtx = resolvedProjectId ? projectContextManager.getOrCreate(resolvedProjectId) : undefined;
				const proj = resolvedProjectId ? projectRegistry.get(resolvedProjectId) : undefined;
				const isMulti = !!projCtx?.projectConfigStore.isMultiRepo();
				if (isMulti && proj?.rootPath) {
					worktreeOpts = { repoPath: proj.rootPath };
				} else if (await isGitRepo(cwd)) {
					const repoPath = await getRepoRoot(cwd);
					worktreeOpts = { repoPath };
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

		try {
			const session = await sessionManager.createSession(cwd, args, goalId, assistantType, { ...createOpts, worktreeOpts, reattemptGoalId, sandboxed, projectId: resolvedProjectId, ...(autoSandboxBranch ? { sandboxBranch: autoSandboxBranch } : {}) });

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

			// Store projectId on the session if resolved (explicit or auto-detected).
			// Project assistant sessions keep their provisional projectId so they
			// persist under the provisional project's store and appear in the sidebar.
			if (resolvedProjectId) {
				sessionManager.getSessionStore(session.projectId).update(session.id, { projectId: resolvedProjectId });
			}

			json({
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

	// ── Goal endpoints ─────────────────────────────────────────────

	// GET /api/goals
	if (url.pathname === "/api/goals" && req.method === "GET") {
		// Paginated archived goals — aggregate across all projects
		if (url.searchParams.get("archived") === "true") {
			const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50), 200);
			const afterParam = url.searchParams.get("after");
			const afterCursor = afterParam ? parseInt(afterParam, 10) : undefined;
			const filterProjectId = url.searchParams.get("projectId") || undefined;
			// Aggregate archived goals across all project contexts
			let allArchived: PersistedGoal[] = [];
			for (const ctx of projectContextManager.all()) {
				if (filterProjectId && ctx.project.id !== filterProjectId) continue;
				allArchived.push(...ctx.goalStore.getArchived());
			}
			allArchived.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
			const total = allArchived.length;
			if (afterCursor !== undefined) {
				allArchived = allArchived.filter(g => (g.archivedAt ?? 0) < afterCursor);
			}
			const page = allArchived.slice(0, limit);
			const hasMore = allArchived.length > limit;
			const nextCursor = page.length > 0 ? page[page.length - 1].archivedAt : undefined;

			// Collect archived sessions affiliated with goals in this page
			const goalIdsInPage = new Set(page.map((g: any) => g.id));
			const affiliatedSessions: any[] = [];
			const seenSessionIds = new Set<string>();
			for (const ctx of projectContextManager.all()) {
				for (const s of ctx.sessionStore.getArchived()) {
					if (!seenSessionIds.has(s.id) && (goalIdsInPage.has((s as any).teamGoalId) || goalIdsInPage.has((s as any).goalId))) {
						seenSessionIds.add(s.id);
						affiliatedSessions.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
					}
				}
			}
			// BFS walk delegate/team chains from affiliated sessions
			const allArchivedForGoalsBfs: any[] = [];
			for (const ctx of projectContextManager.all()) {
				for (const s of ctx.sessionStore.getArchived()) {
					allArchivedForGoalsBfs.push({ ...s, colorIndex: colorStore.get(s.id), status: "archived" });
				}
			}
			const delegateEnriched = bfsEnrichArchived(affiliatedSessions.map(s => s.id), allArchivedForGoalsBfs);
			for (const s of delegateEnriched) {
				if (!seenSessionIds.has(s.id)) {
					seenSessionIds.add(s.id);
					affiliatedSessions.push(s);
				}
			}

			json({ goals: page, total, hasMore, nextCursor, archivedSessions: affiliatedSessions });
			return;
		}

		const currentGen = projectContextManager.getGoalGeneration();
		const sinceParam = url.searchParams.get("since");
		if (sinceParam !== null) {
			const since = parseInt(sinceParam, 10);
			if (!isNaN(since) && since === currentGen) {
				json({ generation: currentGen, changed: false });
				return;
			}
		}
		const filterProjectId = url.searchParams.get("projectId") || undefined;
		const goals = listGoalsAcrossProjects({ projectId: filterProjectId });
		json({ generation: currentGen, goals });
		return;
	}

	// POST /api/goals
	if (url.pathname === "/api/goals" && req.method === "POST") {
		const body = await readBody(req);
		const title = body?.title;
		let cwd = body?.cwd || config.defaultCwd;
		// If a projectId is provided and no explicit cwd, use the project's rootPath
		if (!body?.cwd && body?.projectId && typeof body.projectId === "string") {
			const proj = projectRegistry.get(body.projectId);
			if (proj) cwd = proj.rootPath;
		}
		const spec = body?.spec || "";
		const workflowId = (body?.workflowId && typeof body.workflowId === "string") ? body.workflowId : "general";
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		try {
			const sandboxed = body.sandboxed === true;
			const autoStartTeam = body.autoStartTeam !== false; // default true
			let enabledOptionalSteps: string[] | undefined;
			if (Array.isArray(body.enabledOptionalSteps) && body.enabledOptionalSteps.every((s: unknown) => typeof s === "string")) {
				enabledOptionalSteps = body.enabledOptionalSteps;
			}
			// Resolve target project — explicit projectId or cwd-match. No fallback.
			const resolved = resolveProjectForRequest(projectRegistry, projectContextManager, { projectId: body.projectId, cwd });
			if (!resolved.ok) { json({ error: resolved.error }, resolved.status); return; }
			const targetProjectId = resolved.projectId;
			// If caller passed a projectId but no cwd, use the project's rootPath.
			if (!body?.cwd) cwd = resolved.project.rootPath;
			const targetCtx = projectContextManager.getOrCreate(targetProjectId);
			if (!targetCtx) {
				json({ error: "Invalid project" }, 400);
				return;
			}
			// Lazy per-project sandbox init — idempotent, deduped by SandboxManager.
			if (sandboxed && sandboxManager) {
				try {
					await sandboxManager.ensureForProject(targetProjectId);
				} catch (err) {
					jsonError(500, err, { error: `Sandbox init failed: ${(err as Error).message || err}` });
					return;
				}
			}
			const targetGoalManager = targetCtx.goalManager;
			// Resolve workflow through the config cascade (builtin → server → project)
			const cascadeWorkflows = configCascade.resolveWorkflows(targetProjectId);
			const resolvedWorkflow = cascadeWorkflows.find(r => r.item.id === workflowId)?.item;
			const goal = await targetGoalManager.createGoal(title, cwd, {
				spec,
				workflowId,
				workflowStore: targetCtx.workflowStore,
				resolvedWorkflow,
				sandboxed,
				enabledOptionalSteps,
				projectId: targetProjectId,
			});
			// Set projectId (explicit or auto-detected from cwd)
			if (targetProjectId) {
				targetGoalManager.updateGoal(goal.id, { projectId: targetProjectId });
				goal.projectId = targetProjectId;
			}
			// Set reattemptOf if provided
			if (body.reattemptOf && typeof body.reattemptOf === "string") {
				targetGoalManager.updateGoal(goal.id, { reattemptOf: body.reattemptOf });
				goal.reattemptOf = body.reattemptOf;
			}
			// Persist autoStartTeam flag
			targetGoalManager.updateGoal(goal.id, { autoStartTeam });
			goal.autoStartTeam = autoStartTeam;
			// Initialize gate states for the workflow
			if (goal.workflow) {
				targetCtx.gateStore.initGatesForGoal(goal.id, goal.workflow.gates.map(g => g.id));
			}
			json(goal, 201);

			// Fire-and-forget async worktree setup (and optionally start team)
			if (goal.setupStatus === "preparing") {
				if (goal.autoStartTeam) {
					targetGoalManager.setupWorktreeAndStartTeam(goal.id, () => teamManager.startTeam(goal.id)).then(() => {
						broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
					}).catch((err) => {
						const g = targetGoalManager.getGoal(goal.id);
						if (g?.setupStatus === "ready") {
							broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
							console.error("[goal] Auto-start team failed (worktree ready):", err);
						} else {
							broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
						}
					});
				} else {
					targetGoalManager.setupWorktree(goal.id).then(() => {
						broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
					}).catch((err) => {
						broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
					});
				}
			}
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/retry-setup � retry worktree setup for a goal in error state
	const retrySetupMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/retry-setup$/);
	if (retrySetupMatch && req.method === "POST") {
		const goalId = retrySetupMatch[1];
		const retryGoalManager = getGoalManagerForGoal(goalId);
		const ok = retryGoalManager.retrySetup(goalId);
		if (!ok) {
			json({ error: "Goal not found or not in error state" }, 400);
			return;
		}
		json({ ok: true });
		// Fire-and-forget async worktree setup (and optionally start team)
		const retryGoal = retryGoalManager.getGoal(goalId);
		if (retryGoal?.autoStartTeam) {
			retryGoalManager.setupWorktreeAndStartTeam(goalId, () => teamManager.startTeam(goalId)).then(() => {
				broadcastToAll({ type: "goal_setup_complete", goalId });
			}).catch((err) => {
				const g = retryGoalManager.getGoal(goalId);
				if (g?.setupStatus === "ready") {
					broadcastToAll({ type: "goal_setup_complete", goalId });
					console.error("[goal] Auto-start team failed on retry (worktree ready):", err);
				} else {
					broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
				}
			});
		} else {
			retryGoalManager.setupWorktree(goalId).then(() => {
				broadcastToAll({ type: "goal_setup_complete", goalId });
			}).catch((err) => {
				broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
			});
		}
		return;
	}

	// Routes with goal :id parameter
	const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
	if (goalMatch) {
		const id = goalMatch[1];

		if (req.method === "GET") {
			const goal = getGoalAcrossProjects(id);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			json(goal);
			return;
		}

		if (req.method === "PUT") {
			const putGoal = getGoalAcrossProjects(id);
			if (putGoal?.archived) { json({ error: "Goal is archived" }, 409); return; }
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const goalMgr = getGoalManagerForGoal(id);
			const ok = await goalMgr.updateGoal(id, {
				title: body.title,
				cwd: body.cwd,
				state: body.state,
				spec: body.spec,
				team: true, // Always-on team mode
				repoPath: body.repoPath,
				branch: body.branch,
				reattemptOf: body.reattemptOf,
			});
			if (!ok) { json({ error: "Goal not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			// Cancel any in-flight gate verifications (terminates reviewer sessions)
			for (const active of verificationHarness.getActiveVerifications(id)) {
				try {
					await verificationHarness.cancelStaleVerifications(id, active.gateId);
				} catch (err) {
					console.error(`[api] Error cancelling verification for gate ${active.gateId}:`, err);
				}
			}
			// Capture agent branches BEFORE teardown erases the team store entry.
			// Bug 1 (docs/design/orphan-remote-branch-cleanup.md): teardownTeam
			// mutates teamEntry.agents in place via dismissRole(), so we must
			// snapshot the branch names into a fresh string[] now — reading
			// teamEntry.agents after teardown returns an empty array.
			const goalProjectCtx = projectContextManager.getContextForGoal(id);
			const teamEntry = goalProjectCtx?.teamStore.get(id);
			const agentBranches: string[] = [];
			if (teamEntry?.agents) {
				for (const a of teamEntry.agents) {
					if (a.branch) agentBranches.push(a.branch);
				}
			}
			// Include the team-lead's own session branch if it differs from goal.branch.
			if (teamEntry?.teamLeadSessionId) {
				const tl = goalProjectCtx?.sessionStore.get(teamEntry.teamLeadSessionId);
				if (tl?.branch) agentBranches.push(tl.branch);
			}

			// Tear down any active team first (dismisses agents, cleans up their worktrees)
			const teamState = teamManager.getTeamState(id);
			if (teamState) {
				try {
					await teamManager.teardownTeam(id);
				} catch (err) {
					console.error(`[api] Error tearing down team for goal ${id}:`, err);
				}
			}
			// Archive instead of hard-delete — tasks, gates, team state remain intact
			const deleteGoalMgr = getGoalManagerForGoal(id);
			await deleteGoalMgr.archiveGoal(id);

			// Fire-and-forget: clean up remote branches for this goal
			const archivedGoal = deleteGoalMgr.getGoal(id);
			if (archivedGoal?.repoPath) {
				deleteRemoteGoalBranches(archivedGoal, agentBranches, archivedGoal.repoPath).catch(err => {
					console.warn(`[api] Remote branch cleanup failed for goal ${id}:`, err);
				});
			}

			prStatusStore.remove(id);
			json({ ok: true });
			return;
		}
	}

	// ── Role endpoints ─────────────────────────────────────────────

	// ── Config: default cwd ──

	// ── Unified Model Registry ──

	// ── Task endpoints ─────────────────────────────────────────────

	// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate
	const gateSignalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signal$/);
	if (gateSignalMatch && req.method === "POST") {
		const [, goalId, gateId] = gateSignalMatch;
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }
		const gateSignalCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateSignalCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateSignalCtx.gateStore;
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json({ error: `Unknown gate: ${gateId}` }, 404); return; }

		const body = await readBody(req);
		const signalSessionId = body?.sessionId || "unknown";

		// Validate dependencies are met
		for (const depId of gateDef.dependsOn) {
			const depGate = gateStore.getGate(goalId, depId);
			if (!depGate || depGate.status !== "passed") {
				const depDef = goal.workflow.gates.find(g => g.id === depId);
				json({ error: `Upstream gate "${depDef?.name || depId}" has not passed yet` }, 409);
				return;
			}
		}

		// Validate metadata against gate's schema
		if (gateDef.metadata && body?.metadata) {
			for (const key of Object.keys(gateDef.metadata)) {
				if (!(key in body.metadata)) {
					json({ error: `Missing required metadata field: ${key}` }, 400);
					return;
				}
			}
		} else if (gateDef.metadata && !body?.metadata) {
			const required = Object.keys(gateDef.metadata);
			if (required.length > 0) {
				json({ error: `Missing required metadata fields: ${required.join(", ")}` }, 400);
				return;
			}
		}

		// Get commit SHA
		let commitSha = "unknown";
		try {
			commitSha = await execGitSafe("git rev-parse HEAD", goal.cwd, "unknown");
		} catch { /* ignore */ }

		// Reject if verification is already running for this gate+commit
		if (commitSha !== "unknown") {
			const activeVers = verificationHarness.getActiveVerifications(goalId);
			const runningDup = activeVers.find(v => {
				if (v.gateId !== gateId || v.overallStatus !== "running") return false;
				const gs = gateStore.getGate(goalId, gateId);
				const s = gs?.signals.find(s => s.id === v.signalId);
				return s?.commitSha === commitSha;
			});
			if (runningDup) {
				// Check if sessions are actually alive — auto-cancel zombies
				const alive = verificationHarness.areVerificationSessionsAlive(runningDup.signalId);
				if (!alive) {
					console.log(`[api] Auto-cancelling zombie verification ${runningDup.signalId} for gate ${gateId}`);
					await verificationHarness.cancelStaleVerifications(goalId, gateId);
					// Fall through to create new signal
				} else {
					json({ error: "Verification already in progress for this commit", existingSignalId: runningDup.signalId }, 409);
					return;
				}
			}
		}

		// Auto-pass if a prior signal for the same commit already fully passed
		if (commitSha !== "unknown") {
			const existingGateForCache = gateStore.getGate(goalId, gateId);
			if (existingGateForCache) {
				const priorPassed = existingGateForCache.signals.find(s =>
					s.commitSha === commitSha && s.verification?.status === "passed"
				);
				if (priorPassed?.verification) {
					// Create a signal record with cached results
					const cachedSignal = {
						id: randomUUID(),
						gateId,
						goalId,
						sessionId: body?.sessionId || "unknown",
						timestamp: Date.now(),
						commitSha,
						metadata: body?.metadata,
						content: body?.content,
						contentVersion: body?.content ? (existingGateForCache.currentContentVersion || 0) + 1 : undefined,
						verification: {
							status: "passed" as const,
							steps: priorPassed.verification.steps.map(s => ({ ...s, output: `[cached from prior signal] ${s.output}` })),
						},
					};
					gateStore.recordSignal(cachedSignal);
					if (body?.content && cachedSignal.contentVersion) {
						gateStore.updateGateContent(goalId, gateId, body.content, cachedSignal.contentVersion);
					}
					if (body?.metadata) {
						gateStore.updateGateMetadata(goalId, gateId, body.metadata);
					}
					gateStore.updateGateStatus(goalId, gateId, "passed");
					broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: cachedSignal.id });
					broadcastToGoal(goalId, { type: "gate_verification_complete", goalId, gateId, signalId: cachedSignal.id, status: "passed" });
					broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId, status: "passed" });
					const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
					json({ signal: { id: cachedSignal.id, gateId, goalId, status: "passed", steps: verifySteps, cached: true } }, 201);
					return;
				}
			}
		}

		// Compute content version
		const existingGate = gateStore.getGate(goalId, gateId);
		const contentVersion = body?.content ? (existingGate?.currentContentVersion || 0) + 1 : undefined;

		// Check if this is a re-signal of a passed gate — cascade reset
		if (existingGate && existingGate.status === "passed") {
			gateStore.cascadeReset(goalId, gateId, goal.workflow);
			// Broadcast resets for downstream gates
			for (const g of goal.workflow.gates) {
				if (g.dependsOn.includes(gateId) || hasTransitiveDep(goal.workflow, g.id, gateId)) {
					const downstream = gateStore.getGate(goalId, g.id);
					if (downstream) {
						broadcastToGoal(goalId, { type: "gate_status_changed", goalId, gateId: g.id, status: downstream.status });
					}
				}
			}
		}

		// Create signal record
		const signal = {
			id: randomUUID(),
			gateId,
			goalId,
			sessionId: signalSessionId,
			timestamp: Date.now(),
			commitSha,
			metadata: body?.metadata,
			content: body?.content,
			contentVersion,
			verification: { status: "running" as const, steps: [] },
		};

		gateStore.recordSignal(signal);

		// Update gate content/metadata if provided
		if (body?.content && contentVersion) {
			gateStore.updateGateContent(goalId, gateId, body.content, contentVersion);
		}
		if (body?.metadata) {
			gateStore.updateGateMetadata(goalId, gateId, body.metadata);
		}

		// Broadcast signal received
		broadcastToGoal(goalId, { type: "gate_signal_received", goalId, gateId, signalId: signal.id });

		// Build gate state map for metadata variable resolution + LLM reviewer context
		const allGateStates = new Map<string, { metadata?: Record<string, string>; content?: string; status?: string; injectDownstream?: boolean }>();
		for (const gs of gateStore.getGatesForGoal(goalId)) {
			const def = goal.workflow?.gates?.find((g: any) => g.id === gs.gateId);
			allGateStates.set(gs.gateId, {
				metadata: gs.currentMetadata,
				content: gs.currentContent,
				status: gs.status,
				injectDownstream: def?.injectDownstream,
			});
		}

		// Cancel any in-flight verifications for the same gate before starting new ones
		await verificationHarness.cancelStaleVerifications(goalId, gateId);

		// Fire-and-forget verification — resolve primary branch dynamically so
		// diff baselines use the repo's actual primary (origin/HEAD), not a stale
		// hardcoded "master". See docs/goals-workflows-tasks.md — Gate baselines.
		const primary = await detectPrimaryBranch(goal.cwd).catch(() => "master");
		verificationHarness.verifyGateSignal(
			signal, gateDef, goal.cwd, goal.branch, primary, allGateStates, goal.spec,
		).catch(err => console.error("[verification] Gate signal error:", err));

		const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
		json({ signal: { id: signal.id, gateId, goalId, status: "running", steps: verifySteps } }, 201);
		return;
	}

	// ── Team endpoints ─────────────────────────────────────────────
	// Routes accept both /team/ and legacy /swarm/ paths

	// POST /api/goals/:id/team/start — start a team for a goal
	const teamStartMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/start$/);
	if (teamStartMatch && req.method === "POST") {
		const goalId = teamStartMatch[1];
		try {
			const session = await teamManager.startTeam(goalId);
			json({ sessionId: session.id, title: session.title }, 201);
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/team/spawn — spawn a role agent
	const teamSpawnMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/spawn$/);
	if (teamSpawnMatch && req.method === "POST") {
		const goalId = teamSpawnMatch[1];
		// Guard: reject spawn if goal is archived
		const spawnGoal = getGoalAcrossProjects(goalId);
		if (spawnGoal?.archived) {
			json({ error: "Goal is archived" }, 409);
			return;
		}
		// Guard: reject spawn if goal worktree is not ready
		if (spawnGoal && spawnGoal.setupStatus !== "ready") {
			json({ error: "Goal setup not complete" }, 409);
			return;
		}
		const body = await readBody(req);
		if (!body?.role || !body?.task) {
			json({ error: "Missing role or task" }, 400);
			return;
		}
		try {
			const spawnOpts: { workflowGateId?: string; inputGateIds?: string[] } = {};
			if (typeof body.workflowGateId === "string") spawnOpts.workflowGateId = body.workflowGateId;
			if (Array.isArray(body.inputGateIds)) spawnOpts.inputGateIds = body.inputGateIds as string[];
			const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
			json(result, 201);
		} catch (err) {
			if (err instanceof GateDependencyError) {
				jsonError(409, err);
			} else {
				jsonError(400, err);
			}
		}
		return;
	}

	// POST /api/goals/:id/team/dismiss — dismiss a role agent
	const teamDismissMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/dismiss$/);
	if (teamDismissMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const ok = await teamManager.dismissRole(body.sessionId);
			json({ ok });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// GET /api/goals/:id/commits — get commit history for goal branch
	const commitsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/commits$/);
	if (commitsMatch && req.method === "GET") {
		const goalId = commitsMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!fs.existsSync(goal.cwd)) { json({ commits: [] }); return; }
		const branch = goal.branch || "HEAD";
		// Validate branch name to prevent injection
		if (!/^[a-zA-Z0-9/_.\-]+$/.test(branch)) { json({ error: "Invalid branch name" }, 400); return; }
		const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 100);
		try {
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", goal.cwd);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", goal.cwd); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", goal.cwd); primaryBranch = "main"; } catch { /* keep default */ } }
			}

			let rangeSpec = `-${limit} ${branch}`;
			if (branch !== primaryBranch && branch !== "HEAD") {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, goal.cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				try { await execGit(`git rev-parse ${primaryRef}`, goal.cwd); rangeSpec = `-${limit} ${primaryRef}..${branch}`; } catch { /* fall back */ }
			}

			const out = await execGit(`git log --format="%H|%h|%s|%an|%aI" ${rangeSpec}`, goal.cwd);
			const commits = out.trim().split("\n").filter(Boolean).map((line: string) => {
				const [sha, shortSha, message, author, timestamp] = line.split("|");
				return { sha, shortSha, message, author, timestamp };
			});
			json({ commits });
		} catch (e: any) {
			json({ error: "Failed to read git log", detail: e.message }, 500);
		}
		return;
	}

	// GET /api/goals/:id/git-status — git status for goal worktree (async)
	const goalGitMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-status$/);
	if (goalGitMatch && req.method === "GET") {
		const goalId = goalGitMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;

		// Resolve container ID for sandboxed goals
		let cid: string | undefined;
		if (goal.sandboxed) {
			try {
				const goalCtx = projectContextManager.getContextForGoal(goalId);
				const sandbox = goalCtx ? sessionManager.getSandboxManager()?.get(goalCtx.project.id) : undefined;
				cid = sandbox ? await sandbox.getContainerId() : undefined;
			} catch { /* container unavailable — fall through */ }
		}

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const goalUntracked = url.searchParams.get('untracked') === '1';
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
			invalidateGitStatusCache(cwd, cid);
		}
		try {
			const result = await batchGitStatus(cwd, cid, { untracked: goalUntracked });
			if (!result) { json({ error: "Not a git repository" }, 400); return; }

			// Multi-repo aware envelope: include `repos` map + `aggregate` for back-compat.
			const repoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
			if (repoWorktrees && Object.keys(repoWorktrees).length > 0) {
				const repos: Record<string, typeof result> = {};
				for (const [repoName, repoPath] of Object.entries(repoWorktrees)) {
					try {
						if (cid || fs.existsSync(repoPath)) {
							const r = await batchGitStatus(repoPath, cid, { untracked: goalUntracked });
							if (r) repos[repoName] = r;
						}
					} catch { /* per-repo failure non-fatal */ }
				}
				json({ ...result, aggregate: result, repos });
			} else {
				// Single-repo: include `repos: { ".": result }, aggregate: result` for back-compat.
				json({ ...result, aggregate: result, repos: { ".": result } });
			}
		} catch (err: any) {
			jsonError(500, err, { error: err.stderr?.trim() || err.message || "git status failed" });
		}
		return;
	}

	// GET /api/goals/:id/git-diff — unified diff for goal worktree
	const goalDiffMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/git-diff$/);
	if (goalDiffMatch && req.method === "GET") {
		const goalId = goalDiffMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;

		// Resolve container ID for sandboxed goals
		let cid: string | undefined;
		if (goal.sandboxed) {
			try {
				const goalCtx = projectContextManager.getContextForGoal(goalId);
				const sandbox = goalCtx ? sessionManager.getSandboxManager()?.get(goalCtx.project.id) : undefined;
				cid = sandbox ? await sandbox.getContainerId() : undefined;
			} catch { /* container unavailable */ }
		}

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const file = url.searchParams.get("file") || undefined;
		const repoParam = url.searchParams.get("repo") || undefined;
		const goalRepoWorktrees = (goal as { repoWorktrees?: Record<string, string> }).repoWorktrees;
		let diffCwd = cwd;
		if (repoParam && goalRepoWorktrees && goalRepoWorktrees[repoParam]) {
			diffCwd = goalRepoWorktrees[repoParam];
		}
		try {
			const diff = await getGitDiff(diffCwd, file, cid);
			json({ diff });
		} catch (err: any) {
			if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
			if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
			jsonError(500, err);
		}
		return;
	}

	// GET /api/pr-status-cache — bulk PR status from disk cache (startup hydration)
	if (req.method === "GET" && url.pathname === "/api/pr-status-cache") {
		json(prStatusStore.getAll());
		return;
	}

	// GET /api/goals/:id/pr-status — PR status for goal branch (async + cached)
	const goalPrStatusMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-status$/);
	if (goalPrStatusMatch && req.method === "GET") {
		const goalId = goalPrStatusMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		// Pass process.cwd() as fallback — if the goal's worktree has a broken git link
		// (e.g. pruned worktree), gh can still query by branch name from the main repo.
		const pr = await getCachedPrStatus(cwd, goal.branch, process.cwd());
		if (pr) { prStatusStore.set(goalId, pr); json(pr); } else { json({ error: "No PR found" }, 404); }
		return;
	}

	// POST /api/goals/:id/pr-cache-bust — invalidate PR cache for a goal
	const goalPrCacheBustMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-cache-bust$/);
	if (req.method === 'POST' && goalPrCacheBustMatch) {
		const goalId = goalPrCacheBustMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		clearPrStatusCache(cwd, goal.branch);
		broadcastToAll({ type: "pr_status_changed", goalId });
		json({ ok: true });
		return;
	}

	// POST /api/goals/:id/pr-merge — merge PR for goal branch
	const goalPrMergeMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-merge$/);
	if (goalPrMergeMatch && req.method === "POST") {
		const goalId = goalPrMergeMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return;
		}
		const goalAdminFlag = body?.admin ? " --admin" : "";
		const clientGoalBranch = typeof body?.branch === "string" ? body.branch : undefined;
		const resolvedGoalBranch = clientGoalBranch || goal.branch;
		const goalMergeBranch = resolvedGoalBranch ? ` ${resolvedGoalBranch}` : "";
		try {
			await execAsync(`gh pr merge${goalMergeBranch} --${method}${goalAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
			clearPrStatusCache(cwd, goal.branch);
			json({ ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// GET /api/goals/:id/team — get team state
	const teamStateMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)$/);
	if (teamStateMatch && req.method === "GET") {
		const goalId = teamStateMatch[1];
		const state = teamManager.getTeamState(goalId);
		if (!state) {
			json({ error: "No active team for this goal" }, 404);
			return;
		}
		json(state);
		return;
	}

	// POST /api/goals/:id/team/steer — steer a team agent mid-turn
	const teamSteerMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/steer$/);
	if (teamSteerMatch && req.method === "POST") {
		const goalId = teamSteerMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		// Allow steering non-interactive sessions (e.g. verification reviewers)
		// so the user can redirect them mid-run
		if (session.status !== "streaming") {
			json({ error: "Agent is not currently streaming — use team/prompt instead" }, 409);
			return;
		}
		try {
			await sessionManager.deliverLiveSteer(session.id, body.message);
			json({ ok: true, dispatched: true });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/goals/:id/team/abort — force-abort a stuck team agent
	const teamAbortMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/abort$/);
	if (teamAbortMatch && req.method === "POST") {
		const goalId = teamAbortMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId) {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		try {
			await sessionManager.forceAbort(body.sessionId);
			const afterSession = sessionManager.getSession(body.sessionId);
			json({ ok: true, status: afterSession?.status || "idle" });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// POST /api/goals/:id/team/prompt — send a prompt to a team agent (queued or immediate)
	const teamPromptMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/prompt$/);
	if (teamPromptMatch && req.method === "POST") {
		const goalId = teamPromptMatch[1];
		const body = await readBody(req);
		if (!body?.sessionId || !body?.message) {
			json({ error: "Missing sessionId or message" }, 400);
			return;
		}
		// Validate target is a team agent
		const agents = teamManager.listAgents(goalId);
		if (!agents.find(a => a.sessionId === body.sessionId)) {
			json({ error: "Session is not a member of this team" }, 403);
			return;
		}
		const session = sessionManager.getSession(body.sessionId);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		if (session.nonInteractive) {
			json({ error: "Cannot prompt a non-interactive (automated review) session" }, 400);
			return;
		}
		// Enforce gate dependency check for team/prompt
		const wfGateId = typeof body.workflowGateId === "string" ? body.workflowGateId : undefined;
		const inputIds = Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined;
		if (wfGateId) {
			const goal = getGoalAcrossProjects(goalId);
			const goalGateCtx = projectContextManager.getContextForGoal(goalId);
			const goalGateStore = goalGateCtx?.gateStore;
			if (goal?.workflow && goalGateStore) {
				const gateStates = goalGateStore.getGatesForGoal(goalId);
				const depError = checkGateDependencies(wfGateId, goal.workflow.gates, gateStates);
				if (depError) {
					json({ error: depError }, 409);
					return;
				}
			}
		}
		try {
			// Resolve workflow gate context and prepend to message if provided
			let message = body.message as string;
			if (wfGateId || inputIds?.length) {
				const ctx = teamManager.buildDependencyContext(goalId, wfGateId, inputIds);
				if (ctx) {
					message = ctx + "\n\n---\n\n" + message;
				}
			}
			await sessionManager.enqueuePrompt(body.sessionId, message);
			json({ ok: true, status: session.status === "idle" ? "dispatched" : "queued" });
		} catch (err) {
			jsonError(500, err);
		}
		return;
	}

	// GET /api/goals/:id/team/agents — list agents for a team goal
	const teamAgentsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/agents$/);
	if (teamAgentsMatch && req.method === "GET") {
		const goalId = teamAgentsMatch[1];
		const agents = teamManager.listAgents(goalId);

		// Include archived (dismissed) agents when ?include=archived is set
		const includeArchived = url.searchParams.get("include") === "archived";
		let archivedAgents: unknown[] = [];
		if (includeArchived) {
			const liveSessionIds = new Set(agents.map((a: any) => a.sessionId));
			archivedAgents = sessionManager.listArchivedSessions()
				.filter(s => s.teamGoalId === goalId && !liveSessionIds.has(s.id))
				.map(s => ({
					sessionId: s.id,
					role: s.role || "unknown",
					status: "archived",
					worktreePath: s.worktreePath || "",
					branch: "",
					task: "",
					createdAt: s.createdAt,
					archivedAt: s.archivedAt,
					title: s.title,
					accessory: s.accessory,
					taskId: s.taskId,
					teamLeadSessionId: s.teamLeadSessionId,
					teamGoalId: s.teamGoalId,
					delegateOf: s.delegateOf,
				}));
		}

		json({ agents: [...agents, ...archivedAgents] });
		return;
	}

	// POST /api/goals/:id/team/complete — complete a team (dismiss agents, keep team lead)
	const teamCompleteMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/complete$/);
	if (teamCompleteMatch && req.method === "POST") {
		const goalId = teamCompleteMatch[1];
		try {
			await teamManager.completeTeam(goalId);
			json({ ok: true });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// POST /api/goals/:id/team/teardown — fully tear down a team (dismiss agents + terminate team lead)
	const teamTeardownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/teardown$/);
	if (teamTeardownMatch && req.method === "POST") {
		const goalId = teamTeardownMatch[1];
		try {
			await teamManager.teardownTeam(goalId);
			json({ ok: true });
		} catch (err) {
			jsonError(400, err);
		}
		return;
	}

	// Routes with :id parameter
	const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (sessionMatch) {
		const id = sessionMatch[1];

		if (req.method === "GET") {
			const session = sessionManager.getSession(id);
			if (!session) {
				json({ error: "Session not found" }, 404);
				return;
			}
			json({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				status: session.status,
				createdAt: session.createdAt,
				clientCount: session.clients.size,
			});
			return;
		}

		if (req.method === "DELETE") {
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
				// Session not in memory — check if it's a dormant store entry (e.g. completed delegate)
				if (purge) {
					// Archive it first so purge can find it, then purge
					sessionManager.storeArchive(id);
					const purged = await sessionManager.purgeArchivedSession(id);
					if (purged) {
						json({ ok: true });
						return;
					}
				}
				json({ error: "Session not found" }, 404);
				return;
			}
			// If purge requested, also purge the now-archived session immediately
			if (purge) {
				await sessionManager.purgeArchivedSession(id);
			}
			json({ ok: true });
			return;
		}
	}

	// POST /api/sessions/:id/wait — block until session becomes idle
	// Uses chunked transfer with periodic heartbeat newlines to prevent
	// HTTP client body-timeout (undici defaults to 300s between chunks).
	const waitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/wait$/);
	if (waitMatch && req.method === "POST") {
		const id = waitMatch[1];
		const body = await readBody(req);
		const timeoutMs = body?.timeout_ms ?? 600_000;

		// Stream chunked response with heartbeat to keep connection alive
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Transfer-Encoding": "chunked",
			"Cache-Control": "no-cache",
		});

		// Send a heartbeat newline every 60s to prevent client body-timeout
		const heartbeat = setInterval(() => {
			try { res.write("\n"); } catch { /* connection gone */ }
		}, 60_000);

		try {
			await sessionManager.waitForIdle(id, timeoutMs);
			const output = await sessionManager.getSessionOutput(id);
			const session = sessionManager.getSession(id);
			res.end(JSON.stringify({
				status: session?.status || "idle",
				output,
			}));
		} catch (err) {
			res.end(JSON.stringify({ error: String(err) }));
		} finally {
			clearInterval(heartbeat);
		}
		return;
	}

	// POST /api/sessions/:archivedId/continue — Continue-Archived (lossless)
	//
	// Clones the archived session's `.jsonl` into a fresh slot, registers it
	// as the new session's `agentSessionFile`, and lets the agent CLI rehydrate
	// from it via `switch_session` — same mechanism the restart-resume path
	// uses for live sessions. No transcript stringification, no system-prompt
	// seeding, no byte budget.
	const continueMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/continue$/);
	if (continueMatch && req.method === "POST") {
		const archivedId = continueMatch[1];
		// Body is read for parity but no fields are required — the legacy `mode`
		// parameter is ignored.
		await readBody(req).catch(() => ({}));

		// Resolve the archived session across all project contexts.
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

		// Resolve source `.jsonl` path — fall back to the recovery scan for legacy
		// sessions whose persisted `agentSessionFile` was never populated.
		const { sessionFileCopy, CrossRealmCopyError } = await import("./agent/session-fs.js");
		const { formatAgentSessionFilePath } = await import("./agent/agent-session-path.js");
		const { copyToolContentDirIfPresent, cleanupFailedContinue } = await import("./agent/continue-archived.js");
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
			try {
				if (await isGitRepo(projCwd)) {
					worktreeOpts = { repoPath: await getRepoRoot(projCwd) };
				}
			} catch { /* ignore — no worktree */ }
		}

		// Pre-compute the cloned `.jsonl` path. We use the project root cwd here;
		// for worktree-backed sessions the agent CLI will rotate to a new file
		// once the worktree cwd is final, but the cloned file we hand it via
		// `switch_session` is what gets adopted.
		const newSessionId = randomUUID();
		const destJsonl = formatAgentSessionFilePath(projCwd, Date.now(), newSessionId);

		// Copy the source `.jsonl`. Cross-realm → 422; any other failure → 500.
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

		// Defensive forward-compat: copy the lazy tool-content cache if present.
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
			// We'll set the model explicitly below; skip the auto-selection fire-and-forget.
			skipAutoModel: !!(ps.modelProvider && ps.modelId),
		};
		// Pin the persisted model at spawn time so pi-coding-agent doesn't emit a
		// redundant initial `model_change` event with its hardcoded default.
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
		// markGenerated: prevents the first-message auto-titler from overwriting
		// "Continued: …" once the user sends their first prompt in the new session.
		sessionManager.setTitle(newSession.id, continuedTitle, { markGenerated: true });

		if (ps.modelProvider && ps.modelId) {
			// Model is pinned at spawn via createOpts.initialModel above; just
			// persist the choice so a later restore picks it up. No redundant
			// post-spawn setModel — that's the whole point of spawn-time pinning.
			sessionManager.persistSessionModel(newSession.id, ps.modelProvider, ps.modelId);
		}

		json({
			id: newSession.id,
			cwd: newSession.cwd,
			status: newSession.status,
			title: continuedTitle,
		}, 201);
		return;
	}

	// GET /api/sessions/:id/output — get final assistant output
	const outputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/output$/);
	if (outputMatch && req.method === "GET") {
		const id = outputMatch[1];
		try {
			const output = await sessionManager.getSessionOutput(id);
			json({ output });
		} catch {
			json({ error: "Failed to get output" }, 500);
		}
		return;
	}

	// PATCH /api/sessions/:id — update session properties (title, colorIndex, etc.)
	const patchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (patchMatch && req.method === "PATCH") {
		const id = patchMatch[1];
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
				sessionManager.storeArchive(id);
			}
		}

		json({ ok: true });
		return;
	}

	// POST /api/sessions/:id/mark-read — record that the user viewed this session
	const markReadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mark-read$/);
	if (markReadMatch && req.method === "POST") {
		const id = markReadMatch[1];
		const ok = sessionManager.markSessionRead(id);
		if (!ok) { json({ error: "session not found" }, 404); return; }
		json({ ok: true });
		return;
	}

	// ── Editable proposals (file-on-disk source of truth) ──────────────
	// docs/design/editable-proposals.md §6.4
	const proposalRouteMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/proposal\/([^/]+)(\/edit|\/seed|\/restore)?$/);
	if (proposalRouteMatch) {
		const sessionId = proposalRouteMatch[1];
		const typeStr = proposalRouteMatch[2];
		const suffix = proposalRouteMatch[3] || "";
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

		// DELETE /api/sessions/:id/proposal/:type
		if (suffix === "" && req.method === "DELETE") {
			try {
				await deleteProposalFile(proposalStateDir, sessionId, proposalType);
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, { type: "proposal_cleared", sessionId, proposalType });
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
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
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
			try {
				const writeRes = await writeProposalFile(proposalStateDir, sessionId, proposalType, args as Record<string, unknown>);
				const parsed = await parseProposalFile(proposalStateDir, sessionId, proposalType);
				if (!parsed.ok) {
					json(parsed, 400);
					return;
				}
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
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
				if (_broadcastToSession) {
					_broadcastToSession(sessionId, {
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
	}

	// GET /api/sessions/:id/proposals — list all parsed proposal drafts for the session.
	//
	// Mirrors the WS-auth `proposal_update {source:"rehydrate"}` broadcast in
	// `ws/handler.ts` but as a one-shot REST call. Used by the client's fast-path
	// session switch-back (no fresh WS auth fires, so the broadcast doesn't run
	// and the client's in-memory proposal slot would otherwise stay stale).
	const proposalsListMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/proposals$/);
	if (proposalsListMatch && req.method === "GET") {
		const sessionId = proposalsListMatch[1];
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

	// POST /api/sessions/:id/generate-title — auto-generate a title from chat history.
	// Works for live sessions (calls SessionManager.autoGenerateTitle) and archived
	// sessions (parses .jsonl). Used by the rename dialog when the session is not
	// the currently focused one (no live WebSocket).
	const genTitleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/generate-title$/);
	if (genTitleMatch && req.method === "POST") {
		const id = genTitleMatch[1];
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
	const titleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/title$/);
	if (titleMatch && req.method === "PUT") {
		const id = titleMatch[1];
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

	// GET /api/sessions/:id/file-content?path=<relative-or-absolute>&snapshotId=<id>
	// Reads a text file for inline preview. When snapshotId is provided:
	//   - If a snapshot exists on disk, returns the snapshot (historical state)
	//   - Otherwise reads the live file and saves a snapshot for future refreshes
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/file-content")) {
		const id = url.pathname.split("/")[3];
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

	// GET /api/sessions/:id/git-status — get git status for session's working directory (async)
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) {
			json({ error: "Session not found" }, 404);
			return;
		}
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;

		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }

		// Optional: run git fetch first when ?fetch=true is passed
		const sessUntracked = url.searchParams.get('untracked') === '1';
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
			invalidateGitStatusCache(cwd, cid);
		}

		// Single attempt — native parallel execFile is fast (50–150 ms p50 on
		// Windows) and errors are not cached, so the client retry loop in
		// `git-status-refresh.ts` (4 attempts × 0/500/2000/5000 ms backoff) is
		// the resilience layer for transient failures.
		let result: Awaited<ReturnType<typeof batchGitStatus>> | undefined;
		try {
			result = await batchGitStatus(cwd, cid, { untracked: sessUntracked });
		} catch (err: any) {
			console.error("[git-status handler] error for session", id, "cwd=", cwd, "code=", err?.code, "signal=", err?.signal, "killed=", err?.killed, "stderr=", err?.stderr, "message=", err?.message);
			jsonError(500, err, { error: err?.stderr?.trim() || err?.message || "git status failed" });
			return;
		}
		if (!result) { json({ error: "Not a git repository" }, 400); return; }

		json(result);

		// Auto-push: for feature branches with unpushed commits, push in background
		if (!shouldSkipRemotePush()) {
			if (!result.isOnPrimary && result.ahead > 0 && result.hasUpstream) {
				execAsync('git push', { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
			} else if (!result.isOnPrimary && !result.hasUpstream && result.branch && /^session\//.test(result.branch)) {
				// Session branches without upstream: set up tracking and push
				execAsync(`git push -u origin ${result.branch}`, { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
			}
		}
		return;
	}
	// GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex — lazy-load full tool input content
	const toolContentMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/tool-content\/(\d+)\/(\d+)$/);
	if (toolContentMatch && req.method === "GET") {
		const [, id, msgIdxStr, blkIdxStr] = toolContentMatch;
		const messageIndex = parseInt(msgIdxStr, 10);
		const blockIndex = parseInt(blkIdxStr, 10);
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
	const transcriptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
	if (transcriptMatch && req.method === "GET") {
		const [, targetId] = transcriptMatch;
		// Resolve target session (live or persisted).
		const targetPs = sessionManager.getPersistedSession(targetId);
		if (!targetPs) { json({ error: "session_not_found" }, 404); return; }
		if (!targetPs.agentSessionFile) { json({ error: "transcript_unavailable" }, 404); return; }

		// Authorization: caller must belong to the same project as the target.
		// Caller session id is propagated via `x-bobbit-session-id` header by the
		// extension; if missing, fall back to allow (e.g. UI-initiated calls go
		// through Bearer auth which already gates by project).
		const callerSid = req.headers["x-bobbit-session-id"];
		const callerSidStr = Array.isArray(callerSid) ? callerSid[0] : callerSid;
		if (callerSidStr) {
			const callerPs = sessionManager.getPersistedSession(callerSidStr);
			if (callerPs && targetPs.projectId && callerPs.projectId && callerPs.projectId !== targetPs.projectId) {
				json({ error: "permission_denied" }, 403); return;
			}
		}

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
		try {
			const params = {
				offset: parseIntParam("offset"),
				limit: parseIntParam("limit"),
				pattern: qp.get("pattern") ?? undefined,
				caseSensitive: qp.get("case_sensitive") === "1" || qp.get("case_sensitive") === "true",
				context: parseIntParam("context"),
				verbose: qp.get("verbose") === "1" || qp.get("verbose") === "true",
			};
			const ctx: SessionFsContext = { sandboxed: targetPs.sandboxed, projectId: targetPs.projectId };
			const envelope = await readTranscript(params, {
				readContent: () => sessionFileRead(ctx, targetPs.agentSessionFile, sandboxManager),
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

	// GET /api/sessions/:id/git-diff — unified diff for session working directory
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-diff')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const file = url.searchParams.get("file") || undefined;
		try {
			const diff = await getGitDiff(cwd, file, cid);
			json({ diff });
		} catch (err: any) {
			if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
			if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
			jsonError(500, err);
		}
		return;
	}
	// GET /api/sessions/:id/commits — unpushed commits for session
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/commits')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: 'Session not found' }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ commits: [] }); return; }
		try {
			let branch = '';
			try { branch = await execGit('git rev-parse --abbrev-ref HEAD', cwd, 5000, cid); }
			catch { json({ commits: [] }); return; }

			let hasUpstream = false;
			try { await execGit(`git rev-parse --abbrev-ref ${branch}@{u}`, cwd, 5000, cid); hasUpstream = true; } catch {}

			const limit = 50;
			const direction = url.searchParams.get('direction'); // 'behind' to show incoming commits
			const vs = url.searchParams.get('vs'); // 'primary' to compare vs origin/master
			let rangeSpec: string;
			if (vs === 'primary') {
				// Compare against origin/<primary>
				let primaryBranch = 'master';
				try {
					const remoteHead = await execGit('git symbolic-ref refs/remotes/origin/HEAD', cwd, 5000, cid);
					primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
				} catch {
					try { await execGit('git rev-parse --verify refs/heads/master', cwd, 5000, cid); primaryBranch = 'master'; }
					catch { try { await execGit('git rev-parse --verify refs/heads/main', cwd, 5000, cid); primaryBranch = 'main'; } catch {} }
				}
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd, 5000, cid); primaryRef = `origin/${primaryBranch}`; } catch {}
				rangeSpec = direction === 'behind' ? `HEAD..${primaryRef}` : `${primaryRef}..HEAD`;
			} else {
				rangeSpec = direction === 'behind' && hasUpstream
					? 'HEAD..@{u}'
					: hasUpstream ? '@{u}..HEAD' : `-${limit} HEAD`;
			}

			const out = await execGit(`git log --format="%H|%h|%s|%an|%aI" --shortstat ${rangeSpec}`, cwd, 10000, cid);
			const lines = out.split('\n');
			const commits: Array<{sha: string; shortSha: string; message: string; author: string; timestamp: string; filesChanged: number; insertions: number; deletions: number}> = [];

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line.includes('|')) continue;
				const parts = line.split('|');
				if (parts.length < 5) continue;
				const [sha, shortSha, message, author, timestamp] = parts;
				// Next non-empty line should be the shortstat
				let filesChanged = 0, insertions = 0, deletions = 0;
				for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
					const statLine = lines[j].trim();
					if (statLine.includes('file') && statLine.includes('changed')) {
						const fm = statLine.match(/(\d+) file/);
						const im = statLine.match(/(\d+) insertion/);
						const dm = statLine.match(/(\d+) deletion/);
						if (fm) filesChanged = parseInt(fm[1], 10);
						if (im) insertions = parseInt(im[1], 10);
						if (dm) deletions = parseInt(dm[1], 10);
						break;
					}
				}
				commits.push({ sha, shortSha, message, author, timestamp, filesChanged, insertions, deletions });
			}

			json({ commits });
		} catch (e: any) {
			json({ error: 'Failed to read git log', detail: e.message }, 500);
		}
		return;
	}
	// GET /api/sessions/:id/pr-status — PR status for session's branch
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		// Use goal branch if available so we find the right PR even if the worktree HEAD diverged.
		// For non-goal sessions, fall back to the session's persisted branch — needed for sandbox
		// sessions where the host worktree may not have the right branch checked out.
		const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
		let sessionBranch = goalBranch || sessionManager.getPersistedSession(id)?.branch;
		// For sandboxed sessions, the persisted branch may not match the actual container branch
		// (e.g. gateway assigns a different worktree name). Detect the real branch from the container.
		if (cid && cwd) {
			try {
				const actualBranch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
				if (actualBranch && actualBranch !== "HEAD") sessionBranch = actualBranch;
			} catch { /* fall back to persisted branch */ }
		}
		// PR status uses `gh` CLI which needs host filesystem — use worktreePath for sandboxed sessions
		const prCwd = cid ? (session.worktreePath || process.cwd()) : cwd;
		const pr = await getCachedPrStatus(prCwd, sessionBranch, process.cwd());
		if (pr) {
			const goalId = session.goalId;
			if (goalId) prStatusStore.set(goalId, pr);
			json(pr);
		} else { json({ error: "No PR found" }, 404); }
		return;
	}

	// POST /api/sessions/:id/git-pull — pull latest from remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-pull')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const output = await execGit('git pull', cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-push — push local commits to remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-push')) {
		if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const output = await execGit('git push', cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-squash-push — squash all branch commits and push directly to master
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-squash-push')) {
		if (shouldSkipRemotePush()) { json({ ok: true, output: "skipped (test mode)" }); return; }
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			// Detect primary branch
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { /* keep default */ } }
			}

			// Fetch latest master
			await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
			const primaryRef = `origin/${primaryBranch}`;

			// Check we have commits ahead
			const aheadCount = parseInt(await execGit(`git rev-list --count ${primaryRef}..HEAD`, cwd, 5000, cid), 10) || 0;
			if (aheadCount === 0) { json({ error: "No commits ahead of master" }, 400); return; }

			// Build commit message from branch commits
			const logOutput = await execGit(`git log --format="%s" ${primaryRef}..HEAD`, cwd, 5000, cid);
			const commitMessages = logOutput.trim().split("\n").filter(Boolean);
			const branch = await execGit("git rev-parse --abbrev-ref HEAD", cwd, 5000, cid);
			const summary = commitMessages.length === 1
				? commitMessages[0]
				: `Squash ${branch} (${commitMessages.length} commits)`;
			const body = commitMessages.length > 1
				? commitMessages.map(m => `- ${m}`).join("\n")
				: "";
			const fullMessage = body ? `${summary}\n\n${body}` : summary;

			// Create squash commit on top of origin/master using plumbing (no checkout needed)
			// 1. Create a tree that represents the merge result
			const mergeTree = await execGit(`git merge-tree --write-tree ${primaryRef} HEAD`, cwd, 5000, cid);
			// 2. Create a commit object with that tree, parented on origin/master
			// For sandboxed sessions, write temp file inside container
			const msgFile = cid ? `/tmp/SQUASH_MSG_${Date.now()}` : path.join(cwd, ".git", "SQUASH_MSG");
			if (cid) {
				await execFileAsync("docker", [
					"exec", "-w", cwd, cid, "/bin/sh", "-c", `cat > ${msgFile} << 'BOBBIT_EOF'\n${fullMessage}\nBOBBIT_EOF`,
				], { encoding: "utf-8", timeout: 5000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
			} else {
				fs.writeFileSync(msgFile, fullMessage, "utf-8");
			}
			const squashCommit = await execGit(`git commit-tree ${mergeTree} -p ${primaryRef} -F "${msgFile}"`, cwd, 5000, cid);
			if (cid) {
				await execGit(`rm -f ${msgFile}`, cwd, 5000, cid).catch(() => {});
			} else {
				fs.unlinkSync(msgFile);
			}
			// 3. Push that commit to master
			await execGit(`git push origin ${squashCommit}:refs/heads/${primaryBranch}`, cwd, 30000, cid);
			invalidateGitStatusCache(cwd, cid);

			json({ ok: true, output: `Squash pushed ${aheadCount} commit${aheadCount > 1 ? "s" : ""} to ${primaryBranch}` });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// Check for merge conflicts from merge-tree
			if (msg.includes("CONFLICT") || msg.includes("merge-tree")) {
				json({ error: "Merge conflicts with master. Use 'Merge master' first to resolve." }, 409);
			} else {
				json({ error: msg }, 500);
			}
		}
		return;
	}

	// POST /api/sessions/:id/git-merge-primary — merge origin/master into current branch
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-merge-primary')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			// Detect primary branch
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd, 5000, cid);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd, 5000, cid); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd, 5000, cid); primaryBranch = "main"; } catch { /* keep default */ } }
			}
			await execGit(`git fetch origin ${primaryBranch}`, cwd, 30000, cid);
			const output = await execGit(`git rebase origin/${primaryBranch}`, cwd, 30000, cid);

			// After rebase, check if orphaned commits remain (common after squash-merge PRs).
			// If the tree is identical to origin/primary (no diff), the commits are redundant —
			// reset to origin/primary to clean them up.
			const aheadAfter = parseInt(await execGitSafe(`git rev-list --count origin/${primaryBranch}..HEAD`, cwd, "0", cid), 10) || 0;
			if (aheadAfter > 0) {
				const diff = await execGitSafe(`git diff origin/${primaryBranch}..HEAD`, cwd, "", cid);
				if (diff.trim() === "") {
					// Tree is identical — these are orphaned commits from a squash merge
					await execGit(`git reset --hard origin/${primaryBranch}`, cwd, 10000, cid);
					invalidateGitStatusCache(cwd, cid);
					json({ ok: true, output: `Rebased and reset ${aheadAfter} orphaned commit(s) from squash merge` });
					return;
				}
			}
			invalidateGitStatusCache(cwd, cid);

			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/pr-merge — merge PR for session's branch
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-merge')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return;
		}
		const sessAdminFlag = body?.admin ? " --admin" : "";
		// Prefer the client-provided branch (headRefName from PR status) so the merge
		// targets the exact PR the widget displayed — avoids mismatches when the session's
		// persisted branch differs from the PR's head ref (e.g. staff/team agent worktrees).
		const clientBranch = typeof body?.branch === "string" ? body.branch : undefined;
		const goalBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
		const sessMergeBranch = clientBranch || goalBranch || sessionManager.getPersistedSession(id)?.branch;
		const sessMergeBranchArg = sessMergeBranch ? ` ${sessMergeBranch}` : "";
		try {
			// PR merge uses `gh` CLI — for sandboxed sessions, run on host worktree
			const mergeCwd = cid ? (session.worktreePath || cwd) : cwd;
			await execAsync(`gh pr merge${sessMergeBranchArg} --${method}${sessAdminFlag}`, { cwd: mergeCwd, encoding: "utf-8", timeout: 30000 });
			clearPrStatusCache(cwd, sessMergeBranch);
			json({ ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// ── Preview mount endpoints ──────────────────────────────────────
	const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

	// POST /api/preview/mount?sessionId=<sid> — v3 per-session preview mount.
	// Accepts {html} (with optional {entry}) or {file: absolutePath}. Returns
	// {url, path, entry, mtime}. See docs/design/embedded-html-preview-rewrite.md §6.
	if (url.pathname === "/api/preview/mount" && req.method === "POST") {
		const sessionId = url.searchParams.get("sessionId") || "";
		if (!VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
			json({ error: "Forbidden: session out of scope" }, 403);
			return;
		}
		const body = await readBody(req).catch(() => ({}));
		const hasHtml = typeof body?.html === "string";
		const hasFile = typeof body?.file === "string" && body.file.length > 0;
		const hasAssets = Array.isArray(body?.assets);
		const hasManifest = typeof body?.manifest === "string" && body.manifest.length > 0;
		if (!hasHtml && !hasFile) {
			json({ error: "Body must contain one of 'html' or 'file'" }, 400);
			return;
		}
		if (hasHtml && (hasAssets || hasManifest)) {
			json({ error: "`assets`/`manifest` only valid with `file`" }, 400);
			return;
		}
		try {
			let result: previewMount.MountResult | previewMount.MountFileResult;
			if (hasHtml) {
				// `html` wins over `file` when both are provided.
				let entry: string | undefined;
				if (typeof body.entry === "string" && body.entry.length > 0) {
					const e = body.entry;
					if (e.includes("/") || e.includes("\\") || e.includes("..") || e.includes("\0")) {
						json({ error: "Invalid entry name" }, 400);
						return;
					}
					entry = e;
				}
				result = previewMount.writeInline(sessionId, body.html as string, entry);
			} else {
				const filePath = body.file as string;
				if (!path.isAbsolute(filePath)) {
					json({ error: "file path must be absolute" }, 400);
					return;
				}
				if (!fs.existsSync(filePath)) {
					json({ error: "file not found" }, 404);
					return;
				}
				let stat: fs.Stats;
				try { stat = fs.statSync(filePath); } catch {
					json({ error: "file not found" }, 404);
					return;
				}
				if (!stat.isFile()) {
					json({ error: "path is not a regular file" }, 404);
					return;
				}
				const base = path.basename(filePath).toLowerCase();
				if (!base.endsWith(".html") && !base.endsWith(".htm")) {
					json({ error: "file must end in .html or .htm" }, 400);
					return;
				}
				// Collect assets from inline `assets[]` and optional `manifest` JSON.
				const declared: string[] = [];
				if (hasAssets) {
					for (const a of body.assets as unknown[]) {
						if (typeof a !== "string") {
							json({ error: "`assets[]` entries must be strings" }, 400);
							return;
						}
						declared.push(a);
					}
				}
				if (hasManifest) {
					const manifestRel = body.manifest as string;
					if (path.isAbsolute(manifestRel) || manifestRel.includes("\0") ||
						manifestRel.includes("\\") || manifestRel.split("/").some(s => s === "..")) {
						json({ error: "Invalid manifest path" }, 400);
						return;
					}
					const manifestAbs = path.resolve(path.dirname(filePath), manifestRel);
					if (!fs.existsSync(manifestAbs)) {
						json({ error: `Manifest '${manifestRel}' not found` }, 404);
						return;
					}
					let manifestParsed: any;
					try {
						manifestParsed = JSON.parse(fs.readFileSync(manifestAbs, "utf-8"));
					} catch (err: any) {
						jsonError(400, err, { error: `Manifest JSON parse error: ${err?.message ?? err}` });
						return;
					}
					if (!manifestParsed || !Array.isArray(manifestParsed.assets)) {
						json({ error: "Manifest must be an object with an `assets[]` array" }, 400);
						return;
					}
					for (const a of manifestParsed.assets) {
						if (typeof a !== "string") {
							json({ error: "Manifest `assets[]` entries must be strings" }, 400);
							return;
						}
						declared.push(a);
					}
				}
				// De-duplicate while preserving order.
				const seen = new Set<string>();
				const dedup: string[] = [];
				for (const a of declared) {
					const k = a.trim();
					if (seen.has(k)) continue;
					seen.add(k);
					dedup.push(a);
				}
				result = previewMount.mountFile(sessionId, filePath, dedup);
			}
			broadcastPreviewChanged(sessionId, {
				entry: result.entry,
				mtime: result.mtime,
				url: result.url,
				path: result.path,
			});
			json(result);
			return;
		} catch (err: any) {
			if (err && err instanceof previewMount.PreviewMountError) {
				jsonError(err.statusCode, err);
				return;
			}
			jsonError(500, err, { error: `preview mount failed: ${err?.message ?? String(err)}` });
			return;
		}
	}

	// GET /api/preview/mount?sessionId=<sid> — bootstrap the preview panel after
	// session select. Returns the current entry/mtime/url/path for the mount,
	// or 404 if the mount is empty / nonexistent. Same auth as the POST.
	if (url.pathname === "/api/preview/mount" && req.method === "GET") {
		const sessionId = url.searchParams.get("sessionId") || "";
		if (!VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope && !sandboxScope.sessionIds.has(sessionId)) {
			json({ error: "Forbidden: session out of scope" }, 403);
			return;
		}
		try {
			const { pickEntry } = await import("./preview/content-route.js");
			const dir = previewMount.mountDir(sessionId);
			const entry = pickEntry(dir);
			if (!entry) {
				json({ error: "no preview mount" }, 404);
				return;
			}
			const entryPath = path.join(dir, entry);
			let stat: fs.Stats;
			try { stat = fs.statSync(entryPath); } catch {
				json({ error: "no preview mount" }, 404);
				return;
			}
			json({
				url: `/preview/${sessionId}/${entry}`,
				path: entryPath,
				entry,
				mtime: Math.floor(stat.mtimeMs),
			});
			return;
		} catch (err: any) {
			if (err && err instanceof previewMount.PreviewMountError) {
				jsonError(err.statusCode, err);
				return;
			}
			jsonError(500, err, { error: `preview mount lookup failed: ${err?.message ?? String(err)}` });
			return;
		}
	}

	// GET /api/sessions/:sid/preview-events — SSE stream of preview-changed events
	// for the per-session preview mount. Cookie auth (or admin bearer) only;
	// sandbox tokens are not permitted (handled by the route-guard above).
	const previewEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/preview-events$/);
	if (previewEventsMatch && req.method === "GET") {
		const sid = previewEventsMatch[1];
		if (!VALID_SESSION_ID.test(sid)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
		if (sandboxScope) {
			json({ error: "Forbidden" }, 403);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no",
		});
		try { (res as { flushHeaders?: () => void }).flushHeaders?.(); } catch { /* ok */ }
		// Initial hello so the client knows the stream is live.
		res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

		// Subscribe to the in-process preview-changed channel populated by the
		// mount POST endpoint. Payload shape `{entry, mtime, url, path}` is
		// forwarded verbatim — the client reads `entry` to seed the iframe.
		const unsubscribe = subscribePreviewChanged(sid, payload => {
			try {
				res.write(`event: preview-changed\ndata: ${JSON.stringify(payload)}\n\n`);
			} catch { /* socket closed */ }
		});
		// Bootstrap: if a mount already exists for this session, emit the
		// current state synchronously so the just-connected client doesn't
		// wait for the next agent write. Avoids a race where
		// broadcastPreviewChanged fires between EventSource open and the
		// subscription being registered. Payload shape `{entry, mtime, url,
		// path}` matches broadcastPreviewChanged so the client doesn't need
		// to distinguish bootstrap from live events.
		try {
			const { pickEntry } = await import("./preview/content-route.js");
			const dir = previewMount.mountDir(sid);
			if (fs.existsSync(dir)) {
				const entry = pickEntry(dir);
				if (entry) {
					const entryPath = path.join(dir, entry);
					const stat = fs.statSync(entryPath);
					res.write(`event: preview-changed\ndata: ${JSON.stringify({
						entry,
						mtime: Math.floor(stat.mtimeMs),
						url: `/preview/${sid}/${entry}`,
						path: entryPath,
					})}\n\n`);
				}
			}
		} catch { /* ok — bootstrap is best-effort */ }
		const keepalive = setInterval(() => {
			try { res.write(":keepalive\n\n"); } catch { /* ok */ }
		}, 25_000);
		if (typeof keepalive.unref === "function") keepalive.unref();
		const cleanup = () => {
			clearInterval(keepalive);
			try { unsubscribe(); } catch { /* ok */ }
		};
		req.on("close", cleanup);
		req.on("error", cleanup);
		return;
	}

	// ── Background process endpoints ──────────────────────────────

	// POST /api/sessions/:id/bg-processes — create a background process
	const bgCreateMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes$/);
	if (bgCreateMatch && req.method === "POST") {
		const id = bgCreateMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const body = await readBody(req);
		if (!body?.command) { json({ error: "command is required" }, 400); return; }
		try {
			const info = bgProcessManager.create(id, body.command, session.cwd, session.containerId, session.sandboxed, body.name);
			json(info, 201);
		} catch (err: any) {
			if (err?.message?.includes("Sandboxed session without containerId")) {
				json({ error: "Sandboxed session cannot run host processes" }, 403);
			} else {
				throw err;
			}
		}
		return;
	}

	// GET /api/sessions/:id/bg-processes — list background processes
	if (bgCreateMatch && req.method === "GET") {
		const id = bgCreateMatch[1];
		json({ processes: bgProcessManager.list(id) });
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/logs — get logs
	const bgLogsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/logs$/);
	if (bgLogsMatch && req.method === "GET") {
		const [, sessionId, processId] = bgLogsMatch;
		const logs = bgProcessManager.getLogs(sessionId, processId);
		if (!logs) { json({ error: "Process not found" }, 404); return; }
		const tail = parseInt(url.searchParams.get("tail") || "200", 10);
		json({
			log: logs.log.slice(-tail),
			stdout: logs.stdout.slice(-tail),
			stderr: logs.stderr.slice(-tail),
		});
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/grep — search logs
	const bgGrepMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/grep$/);
	if (bgGrepMatch && req.method === "GET") {
		const [, sessionId, processId] = bgGrepMatch;
		const pattern = url.searchParams.get("pattern") || "";
		if (!pattern) { json({ error: "pattern is required" }, 400); return; }
		const context = parseInt(url.searchParams.get("context") || "0", 10);
		const maxResults = parseInt(url.searchParams.get("max") || "50", 10);
		const result = bgProcessManager.grepLogs(sessionId, processId, pattern, context, maxResults);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/head — first N lines
	const bgHeadMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/head$/);
	if (bgHeadMatch && req.method === "GET") {
		const [, sessionId, processId] = bgHeadMatch;
		const lines = parseInt(url.searchParams.get("lines") || "50", 10);
		const result = bgProcessManager.headLogs(sessionId, processId, lines);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/slice — line range (1-indexed)
	const bgSliceMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/slice$/);
	if (bgSliceMatch && req.method === "GET") {
		const [, sessionId, processId] = bgSliceMatch;
		const from = parseInt(url.searchParams.get("from") || "1", 10);
		const to = parseInt(url.searchParams.get("to") || "50", 10);
		const result = bgProcessManager.sliceLogs(sessionId, processId, from, to);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
		return;
	}

	// GET /api/sessions/:id/bg-processes/:pid/wait — block until exit or timeout
	const bgWaitMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)\/wait$/);
	if (bgWaitMatch && req.method === "GET") {
		const [, sessionId, processId] = bgWaitMatch;
		const timeout = parseInt(url.searchParams.get("timeout") || "300", 10);
		const controller = new AbortController();
		bgProcessManager.registerWait(sessionId, controller);
		try {
			const result = await bgProcessManager.waitForExit(sessionId, processId, timeout * 1000, controller.signal);
			if (!result) { json({ error: "Process not found" }, 404); return; }
			json(result);
		} finally {
			bgProcessManager.unregisterWait(sessionId, controller);
		}
		return;
	}

	// DELETE /api/sessions/:id/bg-processes/:pid — kill or remove a background process
	const bgKillMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/bg-processes\/([^/]+)$/);
	if (bgKillMatch && req.method === "DELETE") {
		const [, sessionId, processId] = bgKillMatch;
		// Try kill first (running), then remove (exited)
		const killed = bgProcessManager.kill(sessionId, processId);
		if (!killed) {
			const removed = bgProcessManager.remove(sessionId, processId);
			if (!removed) { json({ error: "Process not found" }, 404); return; }
		}
		json({ ok: true });
		return;
	}
	// ── Draft endpoints ─────────────────────────────────────────────

	// PUT|POST /api/sessions/:id/draft — upsert a draft
	// POST is accepted alongside PUT because navigator.sendBeacon (used for
	// beforeunload draft flush) always sends POST requests.
	const draftPutMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftPutMatch && (req.method === "PUT" || req.method === "POST")) {
		const id = draftPutMatch[1];
		const body = await readBody(req);
		if (!body || typeof body.type !== "string") {
			json({ error: "Missing type" }, 400);
			return;
		}
		const ok = sessionManager.setDraft(id, body.type, body.data);
		if (!ok) { json({ error: "Session not found" }, 404); return; }
		json({ ok: true });
		return;
	}

	// POST /api/sessions/:id/abort — force-abort a streaming session (graceful + force-kill)
	const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
	if (abortMatch && req.method === "POST") {
		const id = abortMatch[1];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		if (session.status !== "streaming") { json({ ok: true, status: session.status }); return; }
		await sessionManager.forceAbort(id);
		json({ ok: true, status: "idle" });
		return;
	}

	// GET /api/sessions/:id/prompt-sections — return system prompt broken into labeled sections
	const promptSectionsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/prompt-sections$/);
	if (promptSectionsMatch && req.method === "GET") {
		const id = promptSectionsMatch[1];

		// Try persisted snapshot first (captures the actual prompt at creation time)
		const persisted = loadPersistedPromptSections(id);
		if (persisted) {
			json(persisted);
			return;
		}

		// Fallback: reconstruct for legacy sessions without a persisted snapshot
		const parts = sessionManager.getPromptParts(id);
		if (!parts) { json({ error: "Session not found or no prompt data" }, 404); return; }

		// Ensure tool docs are populated (they may have been injected at assemblePrompt time,
		// but re-inject if missing to handle edge cases)
		if (!parts.toolDocs && toolManager) {
			parts.toolDocs = toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
		}

		const sections = getPromptSections(parts);
		const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
		json({ sections, totalTokens });
		return;
	}

	// GET /api/sessions/:id/draft?type=prompt — retrieve a draft
	const draftGetMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftGetMatch && req.method === "GET") {
		const id = draftGetMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json({ error: "Missing type query param" }, 400); return; }
		const data = sessionManager.getDraft(id, type);
		if (data === undefined) {
			// Check if session exists at all
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			json({ error: "Draft not found" }, 404);
			return;
		}
		json({ type, data });
		return;
	}

	// DELETE /api/sessions/:id/draft?type=prompt — clear a draft
	const draftDelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftDelMatch && req.method === "DELETE") {
		const id = draftDelMatch[1];
		const type = url.searchParams.get("type");
		if (!type) { json({ error: "Missing type query param" }, 400); return; }
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		sessionManager.deleteDraft(id, type);
		json({ ok: true });
		return;
	}

	// ── Review annotation endpoints ────────────────────────────────

	// POST /api/sessions/:id/review/annotations/bulk — bulk save all annotations + submitted flag (used by sendBeacon on page unload)
	if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations/bulk")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Invalid body" }, 400); return; }
		const annotations: Record<string, ReviewAnnotation[]> = {};
		if (body.annotations && typeof body.annotations === "object") {
			for (const [docTitle, anns] of Object.entries(body.annotations)) {
				if (Array.isArray(anns)) {
					annotations[docTitle] = anns as ReviewAnnotation[];
				}
			}
		}
		// If `submitted` is omitted (or non-boolean), preserve whatever is
		// already on disk. This is critical: the page-unload beacon historically
		// sent `submitted: false` whenever the local cache hadn't observed a
		// `true`, which clobbered out-of-band PUT(submitted=true) calls (other
		// tabs, REST clients, the test harness) on the next page reload (RP-09).
		// The client now omits the field unless it positively wants to write
		// `true`; the legacy clear path still goes through the dedicated
		// /review/submitted PUT.
		const submitted = typeof body.submitted === "boolean"
			? body.submitted
			: reviewAnnotationStore.isSubmitted(sessionId);
		reviewAnnotationStore.writeAll(sessionId, annotations, submitted);
		json({ ok: true });
		return;
	}

	// GET /api/sessions/:id/review/annotations
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const data = reviewAnnotationStore.getAll(sessionId);
		json(data);
		return;
	}

	// POST /api/sessions/:id/review/annotations
	if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/annotations")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		if (!body?.docTitle || !body?.annotation) {
			json({ error: "docTitle and annotation required" }, 400);
			return;
		}
		reviewAnnotationStore.addAnnotation(sessionId, body.docTitle, body.annotation);
		json({ ok: true });
		return;
	}

	// DELETE /api/sessions/:id/review/annotations[/:annotationId]
	if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/") && url.pathname.includes("/review/annotations")) {
		const parts = url.pathname.split("/");
		const sessionId = parts[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		if (parts.length >= 7 && parts[6]) {
			// DELETE /api/sessions/:id/review/annotations/:annotationId
			const annotationId = decodeURIComponent(parts[6]);
			const docTitle = url.searchParams.get("docTitle");
			if (!docTitle) { json({ error: "docTitle query parameter is required" }, 400); return; }
			reviewAnnotationStore.removeAnnotation(sessionId, docTitle, annotationId);
			json({ ok: true });
		} else {
			// DELETE /api/sessions/:id/review/annotations — clear all or by docTitle
			const body = await readBody(req);
			const docTitle = body?.docTitle;
			if (docTitle) {
				reviewAnnotationStore.clearAnnotations(sessionId, docTitle);
			} else {
				reviewAnnotationStore.clearAll(sessionId);
			}
			json({ ok: true });
		}
		return;
	}

	// GET /api/sessions/:id/review/submitted
	if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/submitted")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		json({ submitted: reviewAnnotationStore.isSubmitted(sessionId) });
		return;
	}

	// PUT /api/sessions/:id/review/submitted
	if (req.method === "PUT" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/review/submitted")) {
		const sessionId = url.pathname.split("/")[3];
		if (!sessionManager.getSession(sessionId)) { json({ error: "Session not found" }, 404); return; }
		if (!reviewAnnotationStore) { json({ error: "Review annotation store not available" }, 500); return; }
		const body = await readBody(req);
		reviewAnnotationStore.setSubmitted(sessionId, !!body?.submitted);
		json({ ok: true });
		return;
	}

	// POST /api/internal/verification-result
	if (url.pathname === "/api/internal/verification-result" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.sessionId || !body?.verdict || !body?.summary || typeof body.sessionId !== "string" || typeof body.verdict !== "string" || typeof body.summary !== "string") {
			json({ error: "Missing required fields: sessionId, verdict, summary" }, 400);
			return;
		}
		const resolver = verificationHarness.pendingResults.get(body.sessionId);
		if (!resolver) {
			json({ error: "No pending verification for this session" }, 404);
			return;
		}
		// Support report_html_file: server reads file directly (avoids tool output limits for large reports)
		if (typeof body.report_html === "string" && typeof body.report_html_file === "string") {
			json({ error: "Provide either report_html or report_html_file, not both" }, 400);
			return;
		}
		let reportHtml: string | undefined = typeof body.report_html === "string" ? body.report_html : undefined;
		if (!reportHtml && typeof body.report_html_file === "string") {
			try {
				let filePath = body.report_html_file;
				// Resolve relative paths against the session's CWD
				if (!path.isAbsolute(filePath)) {
					const session = sessionManager.getSession(body.sessionId);
					if (session) filePath = path.resolve(session.cwd, filePath);
				}
				// On Windows, POSIX paths from Git Bash (/tmp/...) resolve to C:\tmp\... which doesn't exist.
				// Fall back to the system TEMP directory for /tmp/ paths.
				if (process.platform === "win32" && !fs.existsSync(filePath) && body.report_html_file.startsWith("/tmp/")) {
					const tempDir = process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
					const tempResolved = path.join(tempDir, body.report_html_file.slice(5));
					if (fs.existsSync(tempResolved)) filePath = tempResolved;
				}
				const stat = fs.statSync(filePath);
				const MAX_REPORT_SIZE = 10 * 1024 * 1024; // 10 MB
				if (stat.size > MAX_REPORT_SIZE) {
					json({ error: `Report file too large (${stat.size} bytes, max ${MAX_REPORT_SIZE})` }, 400);
					return;
				}
				reportHtml = fs.readFileSync(filePath, "utf-8");
			} catch (e: any) {
				json({ error: `Failed to read report file: ${e.message}` }, 400);
				return;
			}
		}
		// Inline any <img src="file://..."> references so the report renders from
		// the browser's blob origin (cross-origin file:// loads are blocked).
		if (reportHtml) {
			const session = sessionManager.getSession(body.sessionId);
			if (session?.cwd) {
				try {
					reportHtml = inlineFileImages(reportHtml, session.cwd, {
						logger: (msg) => console.warn(msg),
					});
				} catch (err: any) {
					console.warn(`[verification] inlineFileImages failed: ${err?.message || err}`);
				}
			}
		}
		resolver({
			verdict: body.verdict === "pass",
			summary: body.summary,
			reportHtml,
		});
		json({ ok: true });
		return;
	}

	// POST /api/internal/user-question/submit  — called by the UI widget with answers.
	// Non-blocking model: appends a tagged user message to the session transcript
	// via `enqueuePrompt` (the normal user-prompt path), which persists to .jsonl,
	// broadcasts, and wakes the agent. Idempotent: duplicate submits for the same
	// tool_use_id are a no-op (the second tab's submit is swallowed).
	// See src/shared/ask-envelope.ts for the envelope format.
	if (url.pathname === "/api/internal/user-question/submit" && req.method === "POST") {
		const body = await readBody(req);
		const { sessionId, toolUseId, answers } = body || {};
		if (typeof sessionId !== "string" || typeof toolUseId !== "string" || !Array.isArray(answers)) {
			json({ error: "Missing required fields: sessionId, toolUseId, answers" }, 400);
			return;
		}
		const answerErr = validateAnswers(answers);
		if (answerErr) { json({ error: answerErr }, 400); return; }
		const session = sessionManager.getSession(sessionId);
		if (!session) { json({ error: "Unknown session" }, 404); return; }

		// Pull the transcript to locate the original tool_use (for cross-validation)
		// and to detect duplicate submits (multi-tab / network retry).
		let messages: any[] = [];
		try {
			const msgsResp = await session.rpcClient.getMessages();
			const raw = msgsResp?.data?.messages || msgsResp?.data;
			if (Array.isArray(raw)) messages = raw;
		} catch (e: any) {
			json({ error: `Could not load transcript: ${e?.message || String(e)}` }, 500);
			return;
		}

		// Idempotency: if a response envelope for this toolUseId already exists,
		// return success without appending again. Check in-memory guard first
		// (covers the race where a duplicate /submit arrives before the first
		// envelope has propagated into the transcript), then the transcript
		// (covers process restart / external writers).
		const dedupKey = `${sessionId}::${toolUseId}`;
		if (askSubmittedToolUseIds.has(dedupKey)) {
			json({ ok: true, alreadySubmitted: true });
			return;
		}
		const existing = findAskResponseAnswers(messages, toolUseId);
		if (existing) {
			askSubmittedToolUseIds.add(dedupKey);
			json({ ok: true, alreadySubmitted: true });
			return;
		}

		// Locate the ask_user_choices tool_use block; use its input to cross-validate.
		let matchedQuestions: UserQuestion[] | null = null;
		for (const m of messages) {
			if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
			for (const b of m.content) {
				if (!b) continue;
				const isToolUse = b.type === "toolCall" || b.type === "tool_use";
				if (!isToolUse) continue;
				if (b.name !== "ask_user_choices") continue;
				if (b.id !== toolUseId) continue;
				const args = b.arguments ?? b.input;
				if (args && Array.isArray(args.questions)) {
					matchedQuestions = args.questions as UserQuestion[];
				}
				break;
			}
			if (matchedQuestions) break;
		}
		if (!matchedQuestions) {
			json({ error: "No matching ask_user_choices tool call in transcript" }, 404);
			return;
		}
		const crossErr = crossValidate(matchedQuestions, answers);
		if (crossErr) { json({ error: crossErr }, 400); return; }

		const envelope = buildAskResponseEnvelope(toolUseId, answers);
		// Mark as submitted BEFORE awaiting enqueuePrompt so a concurrent
		// duplicate /submit is rejected deterministically.
		askSubmittedToolUseIds.add(dedupKey);
		try {
			await sessionManager.enqueuePrompt(sessionId, envelope);
		} catch (e: any) {
			// Roll back the dedup flag so the caller can retry.
			askSubmittedToolUseIds.delete(dedupKey);
			json({ error: `Failed to enqueue response: ${e?.message || String(e)}` }, 500);
			return;
		}
		json({ ok: true });
		return;
	}

	json({ error: "Not found" }, 404);
}


