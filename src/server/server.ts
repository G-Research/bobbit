import { execFile as execFileCb } from "node:child_process";
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
import { TeamManager } from "./agent/team-manager.js";
import { shouldCreateWorktree } from "./agent/worktree-decision.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolManager } from "./agent/tool-manager.js";

import { initPromptDirs } from "./agent/system-prompt.js";
import { recordElapsed } from "./agent/profiling.js";

import { initSkillSidecarDir } from "./skills/skill-sidecar.js";
import { TaskManager } from "./agent/task-manager.js";
import { TaskStore } from "./agent/task-store.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";

import { isGitRepo, getRepoRoot, stripTokenFromGitUrl } from "./skills/git.js";
import { VerificationHarness } from "./agent/verification-harness.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore, validateComponentsConfig, LEGACY_QA_TOP_LEVEL_KEYS } from "./agent/project-config-store.js";
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
import { startupAigwCheck, writeContextWindowOverrides } from "./agent/aigw-manager.js";
import { writeOpenAIModelAdditions } from "./agent/openai-model-additions.js";
import { ReviewAnnotationStore } from "./review-annotation-store.js";

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

const execFileAsync = promisify(execFileCb);

// ── Git helpers, status cache, PR cache, goal-branch deletion ──
// All extracted to ./git/* — re-exported from this file so test hooks remain
// importable from "./server.js" (see tests/e2e/git-status-caching.spec.ts).
import { clearPrStatusCache } from "./git/pr-status.js";
// Re-export git-status test hooks so existing imports from "./server.js" keep
// working (see tests/e2e/git-status-caching.spec.ts).
export type { GitStatusResult } from "./git/git-status.js";
export {
	invalidateGitStatusCache,
	__getGitStatusInvocationCount,
	__resetGitStatusInvocationCount,
	__setGitStatusFake,
	__clearGitStatusFake,
	__forceGitStatusCacheExpiry,
} from "./git/git-status.js";

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
	_colorStore: ColorStore,
	_prStatusStore: PrStatusStore,
	_teamManager: TeamManager,
	roleManager: RoleManager,
	_toolManager: ToolManager,
	projectContextManager: ProjectContextManager,
	_bgProcessManager: BgProcessManager,
	_staffManager: StaffManager,
	_verificationHarness: VerificationHarness,
	_preferencesStore: PreferencesStore,
	projectConfigStore: ProjectConfigStore,
	_groupPolicyStore: ToolGroupPolicyStore,
	_broadcastToGoal: (goalId: string, event: any) => void,
	_broadcastToAll: (event: any) => void,
	_sandboxManager: SandboxManager | null,
	projectRegistry: ProjectRegistry,
	_configCascade: ConfigCascade,
	sandboxScope?: SandboxScope,
	sandboxTokenStore?: SandboxTokenStore,
	_reviewAnnotationStore?: ReviewAnnotationStore,
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

	// ── Role endpoints ─────────────────────────────────────────────

	// ── Config: default cwd ──

	// ── Unified Model Registry ──

	// ── Task endpoints ─────────────────────────────────────────────

	// ── Team endpoints ─────────────────────────────────────────────
	// Routes accept both /team/ and legacy /swarm/ paths

	json({ error: "Not found" }, 404);
}


