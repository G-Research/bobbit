import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitStateDir, bobbitConfigDir } from "./bobbit-dir.js";
import { WebSocketServer } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { PrStatusStore } from "./agent/pr-status-store.js";
import { SessionManager } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { validateToken } from "./auth/token.js";
import { oauthComplete, oauthStart, oauthStatus } from "./auth/oauth.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import { discoverSlashSkills } from "./skills/slash-skills.js";
import { TeamManager, GateDependencyError } from "./agent/team-manager.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolManager } from "./agent/tool-manager.js";
import { PersonalityStore } from "./agent/personality-store.js";
import { PersonalityManager } from "./agent/personality-manager.js";

import type { TaskState } from "./agent/task-store.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";
import { GateStore } from "./agent/gate-store.js";
import { WorkflowStore } from "./agent/workflow-store.js";
import { WorkflowManager } from "./agent/workflow-manager.js";
import { VerificationHarness } from "./agent/verification-harness.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore } from "./agent/project-config-store.js";
import { configureAigw, removeAigw, getAigwUrl, getAigwModels, discoverAigwModels, proxyRequest, startupAigwCheck } from "./agent/aigw-manager.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

const execAsync = promisify(exec);

// ── PR status cache (avoids blocking event loop with gh CLI every poll) ──
const _prCache = new Map<string, { data: any; ts: number; ttl: number }>();
const PR_NULL_CACHE_TTL_MS = 300_000; // 5 minutes for null (no-PR) results
const _prInFlight = new Map<string, Promise<any | null>>();

// Cache viewer permission per repo (rarely changes, long TTL)
const _repoPermCache = new Map<string, { perm: string; ts: number }>();
const REPO_PERM_CACHE_TTL_MS = 300_000; // 5 minutes

async function getViewerIsAdmin(cwd: string): Promise<boolean> {
	const cached = _repoPermCache.get(cwd);
	if (cached && Date.now() - cached.ts < REPO_PERM_CACHE_TTL_MS) return cached.perm === "ADMIN";
	try {
		const { stdout } = await execAsync("gh repo view --json viewerPermission", {
			cwd, encoding: "utf-8", timeout: 10000,
		});
		const perm = JSON.parse(stdout).viewerPermission ?? "";
		_repoPermCache.set(cwd, { perm, ts: Date.now() });
		return perm === "ADMIN";
	} catch {
		_repoPermCache.set(cwd, { perm: "", ts: Date.now() });
		return false;
	}
}

async function _fetchPrStatus(cwd: string): Promise<any | null> {
	try {
		const { stdout } = await execAsync("gh pr view --json state,url,number,title,mergeable,headRefName,reviewDecision", {
			cwd,
			encoding: "utf-8",
			timeout: 10000,
		});
		const pr = JSON.parse(stdout);
		const viewerIsAdmin = await getViewerIsAdmin(cwd);
		const data = { number: pr.number, url: pr.url, title: pr.title, state: pr.state, mergeable: pr.mergeable, headRefName: pr.headRefName, reviewDecision: pr.reviewDecision || null, viewerIsAdmin };
		const ttl = pr.state === "OPEN" ? 10_000 : 900_000; // OPEN: 10s, CLOSED/MERGED: 15min
		_prCache.set(cwd, { data, ts: Date.now(), ttl });
		return data;
	} catch {
		_prCache.set(cwd, { data: null, ts: Date.now(), ttl: PR_NULL_CACHE_TTL_MS });
		return null;
	}
}

async function getCachedPrStatus(cwd: string): Promise<any | null> {
	const cached = _prCache.get(cwd);
	if (cached && Date.now() - cached.ts < cached.ttl) return cached.data;

	const existing = _prInFlight.get(cwd);
	if (existing) return existing;

	const p = _fetchPrStatus(cwd);
	_prInFlight.set(cwd, p);
	try { return await p; } finally { _prInFlight.delete(cwd); }
}

// ── Async git helpers (avoid blocking event loop) ──
async function execGit(cmd: string, cwd: string, timeout = 5000): Promise<string> {
	const { stdout } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}
async function execGitSafe(cmd: string, cwd: string, fallback = ""): Promise<string> {
	try { return await execGit(cmd, cwd); } catch { return fallback; }
}

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
	const colorStore = new ColorStore();
	const prStatusStore = new PrStatusStore();
	const preferencesStore = new PreferencesStore();
	const projectConfigStore = new ProjectConfigStore();
	const savedCwd = preferencesStore.get("defaultCwd");
	if (savedCwd && typeof savedCwd === "string") {
		config.defaultCwd = savedCwd;
	}
	const personalityStore = new PersonalityStore();
	const personalityManager = new PersonalityManager(personalityStore);
	fs.mkdirSync(bobbitStateDir(), { recursive: true });
	const roleStore = new RoleStore();
	const roleManager = new RoleManager(roleStore);
	const toolManager = new ToolManager();
	const gateStore = new GateStore();
	const workflowStore = new WorkflowStore();
	const sessionManager = new SessionManager({
		agentCliPath: config.agentCliPath,
		systemPromptPath: config.systemPromptPath,
		colorStore,
		personalityManager,
		roleManager,
		toolManager,
		workflowStore,
		preferencesStore,
	});
	const protocol = config.tls ? "https" : "http";
	let gatewayUrl = `${protocol}://${config.host}:${config.port}`;
	const workflowManager = new WorkflowManager(workflowStore);
	const staffManager = new StaffManager();
	const triggerEngine = new TriggerEngine(staffManager, sessionManager);
	triggerEngine.start();
	const teamManager = new TeamManager(sessionManager, {
		colorStore,
		taskManager: sessionManager.taskManager,
		roleStore,
		gateStore,
		personalityManager,
	});
	const bgProcessManager = new BgProcessManager((sessionId: string) => {
		const session = sessionManager.getSession(sessionId);
		return session?.clients;
	});
	// Expose bg process manager for API routes and session cleanup
	(sessionManager as any).bgProcessManager = bgProcessManager;
	const rateLimiter = new RateLimiter();
	const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60_000);

	// Verification harness — assigned after wss is created (closure captures the reference)
	let verificationHarness: VerificationHarness;

	const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);

		// API routes
		if (url.pathname.startsWith("/api/")) {
			const isLocalhostMode = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

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

			// Auth check — skipped in localhost mode (only local processes can connect)
			if (!isLocalhostMode) {
				const authHeader = req.headers.authorization;
				const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7)
					: url.searchParams.get("token"); // Allow token in query param for links opened in new tabs
				const ip = req.socket.remoteAddress || "unknown";

				if (rateLimiter.isRateLimited(ip)) {
					res.writeHead(429);
					res.end();
					return;
				}

				if (!token || !validateToken(token, config.authToken)) {
					if (token) rateLimiter.recordFailure(ip);
					res.writeHead(401, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Unauthorized" }));
					return;
				}
			}

			await handleApiRoute(url, req, res, sessionManager, config, colorStore, prStatusStore, teamManager, roleManager, toolManager, gateStore, personalityManager, bgProcessManager, staffManager, workflowManager, verificationHarness, preferencesStore, projectConfigStore, broadcastToGoal, broadcastToAll);

			return;
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

	// WebSocket server (noServer mode — we handle upgrade manually)
	const wss = new WebSocketServer({ noServer: true });

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
				}
				// Fallback: if we can't determine goal association, still send
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
	teamManager.setBroadcastToGoal(broadcastToGoal);
	verificationHarness = new VerificationHarness(gateStore, broadcastToGoal, roleStore, preferencesStore, sessionManager, teamManager, projectConfigStore);
	verificationHarness.setTeamLeadNotifier((goalId, message) => {
		const team = teamManager.getTeamState(goalId);
		if (!team?.teamLeadSessionId) return;
		const teamLeadSession = sessionManager.getSession(team.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;
		try {
			if (teamLeadSession.status === "streaming") {
				teamLeadSession.rpcClient.steer(message);
			} else {
				sessionManager.enqueuePrompt(team.teamLeadSessionId, message, { isSteered: true });
			}
			console.log(`[verification] Notified team lead for goal ${goalId}: ${message}`);
		} catch (err) {
			console.error(`[verification] Failed to notify team lead for goal ${goalId}:`, err);
		}
	});

	const isLocalhostServer = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url || "/", `http://${req.headers.host}`);
		const match = url.pathname.match(/^\/ws\/([^/]+)$/);

		if (!match) {
			socket.destroy();
			return;
		}

		const ip = req.socket.remoteAddress || "unknown";
		if (!isLocalhostServer && rateLimiter.isRateLimited(ip)) {
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			handleWebSocketConnection(ws, match[1], req, sessionManager, config.authToken, rateLimiter, isLocalhostServer);
		});
	});

	return {
		server,
		sessionManager,
		async start(): Promise<number> {
			// Check internet and auto-configure AI Gateway if offline
			// Runs before session restore so models.json is written before
			// any agent subprocesses start.
			await startupAigwCheck(preferencesStore);

			// Restore persisted sessions before accepting connections
			await sessionManager.restoreSessions();
			sessionManager.startPurgeSchedule();
			// Now that sessions are live, re-subscribe to team events
			// (must happen after restoreSessions so session objects exist)
			teamManager.resubscribeTeamEvents();

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
					// Update the closure gatewayUrl with the actual bound port
					if (port !== config.port) {
						gatewayUrl = `${protocol}://${config.host}:${port}`;
						console.log(`Port ${config.port} in use, using port ${port}`);
					}
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
			await sessionManager.shutdown();
			server.close();
		},
	};
}

/** Check if project setup has been completed (sentinel exists or system-prompt.md has been customized). */
function isSetupComplete(): boolean {
	// Check sentinel file
	const sentinelPath = path.join(bobbitStateDir(), "setup-complete");
	if (fs.existsSync(sentinelPath)) return true;

	// Check if system-prompt.md has been customized beyond the default template
	const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
	if (!fs.existsSync(systemPromptPath)) return false;

	// Compare with default template — if the file differs, setup is considered done
	const defaultTemplatePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "defaults", "system-prompt.md");
	if (!fs.existsSync(defaultTemplatePath)) {
		// Can't find default template; if the file exists at all, assume customized
		return true;
	}
	try {
		const current = fs.readFileSync(systemPromptPath, "utf-8");
		const defaultContent = fs.readFileSync(defaultTemplatePath, "utf-8");
		return current.trim() !== defaultContent.trim();
	} catch {
		return false;
	}
}

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
	gateStore: GateStore,
	personalityManager: PersonalityManager,
	bgProcessManager: BgProcessManager,
	staffManager: StaffManager,
	workflowManager: WorkflowManager,
	verificationHarness: VerificationHarness,
	preferencesStore: PreferencesStore,
	projectConfigStore: ProjectConfigStore,
	broadcastToGoal: (goalId: string, event: any) => void,
	broadcastToAll: (event: any) => void,
) {
	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	};

	// GET /api/health — unauthenticated so the client can probe localhost mode
	if (url.pathname === "/api/health" && req.method === "GET") {
		const isLocalhost = !config.forceAuth && (config.host === "localhost" || config.host === "127.0.0.1" || config.host === "::1");
		json({ status: "ok", sessions: sessionManager.listSessions().length, localhost: isLocalhost, aigw: !!getAigwUrl(preferencesStore), setupComplete: isSetupComplete() });
		return;
	}

	// GET /api/setup-status — check if project setup has been completed
	if (url.pathname === "/api/setup-status" && req.method === "GET") {
		json({ complete: isSetupComplete() });
		return;
	}

	// POST /api/setup-status/dismiss — mark setup as dismissed (writes sentinel file)
	if (url.pathname === "/api/setup-status/dismiss" && req.method === "POST") {
		const stateDir = bobbitStateDir();
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "setup-complete"), "dismissed\n");
		json({ ok: true });
		return;
	}

	// POST /api/shutdown — graceful shutdown (used by coverage teardown to flush V8 coverage)
	if (url.pathname === "/api/shutdown" && req.method === "POST") {
		json({ status: "shutting down" });
		// Defer exit to allow the response to be sent
		setTimeout(() => process.exit(0), 500);
		return;
	}

	// GET /api/ca-cert — download the Bobbit CA certificate for device trust
	if (url.pathname === "/api/ca-cert" && req.method === "GET") {
		const caCertPath = config.tls?.caCert;
		if (!caCertPath || !fs.existsSync(caCertPath)) {
			json({ error: "No CA certificate available. Server is using a self-signed certificate." }, 404);
			return;
		}
		const certData = fs.readFileSync(caCertPath);
		res.writeHead(200, {
			"Content-Type": "application/x-pem-file",
			"Content-Disposition": "attachment; filename=\"bobbit-ca.crt\"",
			"Content-Length": certData.length,
		});
		res.end(certData);
		return;
	}

	// GET /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "GET") {
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
			json({ sessions: [...sessions, ...archived] });
		} else {
			json({ sessions });
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
					archived: true,
					archivedAt: archived.archivedAt,
				});
				return;
			}
			res.writeHead(404);
			res.end(JSON.stringify({ error: "Session not found" }));
			return;
		}
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
			taskId: session.taskId,
			staffId: session.staffId,
			colorIndex: colorStore.get(session.id),
			preview: session.preview,
			personalities: session.personalities,
		});
		return;
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
				json({
					id: session.id,
					cwd: session.cwd,
					status: session.status,
					delegateOf: session.delegateOf,
				}, 201);
			} catch (err) {
				json({ error: String(err) }, 500);
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
				json({ error: `Role "${roleId}" not found` }, 404);
				return;
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
				json({ error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
				return;
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

		try {
			const session = await sessionManager.createSession(cwd, args, goalId, assistantType, createOpts);

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
				personalities: session.personalities,
			}, 201);
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// ── Goal endpoints ─────────────────────────────────────────────

	// GET /api/goals
	if (url.pathname === "/api/goals" && req.method === "GET") {
		json({ goals: sessionManager.goalManager.listGoals() });
		return;
	}

	// POST /api/goals
	if (url.pathname === "/api/goals" && req.method === "POST") {
		const body = await readBody(req);
		const title = body?.title;
		const cwd = body?.cwd || config.defaultCwd;
		const spec = body?.spec || "";
		const team = true; // Always-on team mode
		const worktree = true; // Always create worktree
		const workflowId = (body?.workflowId && typeof body.workflowId === "string") ? body.workflowId : "general";
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		try {
			const goal = await sessionManager.goalManager.createGoal(title, cwd, {
				spec,
				workflowId,
				workflowStore: workflowManager.store,
			});
			// Initialize gate states for the workflow
			if (goal.workflow) {
				gateStore.initGatesForGoal(goal.id, goal.workflow.gates.map(g => g.id));
			}
			json(goal, 201);

			// Fire-and-forget async worktree setup
			if (goal.setupStatus === "preparing") {
				sessionManager.goalManager.setupWorktree(goal.id).then(() => {
					broadcastToAll({ type: "goal_setup_complete", goalId: goal.id });
				}).catch((err) => {
					broadcastToAll({ type: "goal_setup_error", goalId: goal.id, error: String(err) });
				});
			}
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/retry-setup � retry worktree setup for a goal in error state
	const retrySetupMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/retry-setup$/);
	if (retrySetupMatch && req.method === "POST") {
		const goalId = retrySetupMatch[1];
		const ok = sessionManager.goalManager.retrySetup(goalId);
		if (!ok) {
			json({ error: "Goal not found or not in error state" }, 400);
			return;
		}
		json({ ok: true });
		// Fire-and-forget async worktree setup
		sessionManager.goalManager.setupWorktree(goalId).then(() => {
			broadcastToAll({ type: "goal_setup_complete", goalId });
		}).catch((err) => {
			broadcastToAll({ type: "goal_setup_error", goalId, error: String(err) });
		});
		return;
	}

	// Routes with goal :id parameter
	const goalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)$/);
	if (goalMatch) {
		const id = goalMatch[1];

		if (req.method === "GET") {
			const goal = sessionManager.goalManager.getGoal(id);
			if (!goal) { json({ error: "Goal not found" }, 404); return; }
			json(goal);
			return;
		}

		if (req.method === "PUT") {
			const putGoal = sessionManager.goalManager.getGoal(id);
			if (putGoal?.archived) { json({ error: "Goal is archived" }, 409); return; }
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = await sessionManager.goalManager.updateGoal(id, {
				title: body.title,
				cwd: body.cwd,
				state: body.state,
				spec: body.spec,
				team: true, // Always-on team mode
				repoPath: body.repoPath,
				branch: body.branch,
				prUrl: body.prUrl,
			});
			if (!ok) { json({ error: "Goal not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
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
			await sessionManager.goalManager.archiveGoal(id);
			prStatusStore.remove(id);
			json({ ok: true });
			return;
		}
	}

	// ── Role endpoints ─────────────────────────────────────────────

	// GET /api/tools — list available agent tools
	if (url.pathname === "/api/tools" && req.method === "GET") {
		json({ tools: toolManager.getAvailableTools() });
		return;
	}

	// Routes with tool :name parameter
	const toolMatch = url.pathname.match(/^\/api\/tools\/([^/]+)$/);
	if (toolMatch) {
		const name = decodeURIComponent(toolMatch[1]);

		if (req.method === "GET") {
			const tool = toolManager.getToolByName(name);
			if (!tool) { json({ error: "Tool not found" }, 404); return; }
			json(tool);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = toolManager.updateToolMetadata(name, {
				description: body.description,
				group: body.group,
				docs: body.docs,
			});
			if (!ok) { json({ error: "Tool not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// ── Config: default cwd ──

	// GET /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "GET") {
		json({ cwd: config.defaultCwd });
		return;
	}

	// PUT /api/config/cwd
	if (url.pathname === "/api/config/cwd" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body?.cwd || typeof body.cwd !== "string") {
			json({ error: "Missing or invalid cwd" }, 400);
			return;
		}
		config.defaultCwd = body.cwd;
		preferencesStore.set("defaultCwd", body.cwd);
		json({ cwd: config.defaultCwd });
		return;
	}

	// ── Preferences ──

	// GET /api/preferences — return all preferences
	if (url.pathname === "/api/preferences" && req.method === "GET") {
		json(preferencesStore.getAll());
		return;
	}

	// PUT /api/preferences — merge preferences
	if (url.pathname === "/api/preferences" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		for (const [key, value] of Object.entries(body)) {
			if (value === null || value === undefined) {
				preferencesStore.remove(key);
			} else {
				preferencesStore.set(key, value);
			}
		}
		json({ ok: true });
		broadcastToAll({ type: "preferences_changed", preferences: preferencesStore.getAll() });
		return;
	}

	// GET /api/project-config — return project settings
	if (url.pathname === "/api/project-config" && req.method === "GET") {
		json(projectConfigStore.getWithDefaults());
		return;
	}

	// GET /api/project-config/defaults — return just the defaults
	if (url.pathname === "/api/project-config/defaults" && req.method === "GET") {
		json(projectConfigStore.getDefaults());
		return;
	}

	// PUT /api/project-config — update project config fields
	if (url.pathname === "/api/project-config" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
		for (const [key, value] of Object.entries(body)) {
			if (key.includes(".")) {
				json({ error: `Config key "${key}" must not contain dots` }, 400);
				return;
			}
			if (value === null || value === "") {
				projectConfigStore.remove(key);
			} else if (typeof value === "string") {
				projectConfigStore.set(key, value);
			}
		}
		json({ ok: true });
		return;
	}

	// ── AI Gateway ──

	// GET /api/aigw/status — check if aigw is configured and return models
	if (url.pathname === "/api/aigw/status" && req.method === "GET") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ configured: false });
		} else {
			json({ configured: true, url: aigwUrl, models: getAigwModels(preferencesStore) || [] });
		}
		return;
	}

	// POST /api/aigw/configure — set aigw URL, discover models, write models.json
	if (url.pathname === "/api/aigw/configure" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json({ error: "Missing 'url' field" }, 400);
			return;
		}
		try {
			const models = await configureAigw(body.url, preferencesStore);
			broadcastToAll({ type: "preferences_changed", preferences: preferencesStore.getAll() });
			json({ ok: true, models });
		} catch (err: any) {
			json({ error: `Failed to configure AI Gateway: ${err.message}` }, 502);
		}
		return;
	}

	// DELETE /api/aigw/configure — remove aigw config
	if (url.pathname === "/api/aigw/configure" && req.method === "DELETE") {
		removeAigw(preferencesStore);
		broadcastToAll({ type: "preferences_changed", preferences: preferencesStore.getAll() });
		json({ ok: true });
		return;
	}

	// POST /api/aigw/test — test connection to a URL without saving
	if (url.pathname === "/api/aigw/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.url || typeof body.url !== "string") {
			json({ error: "Missing 'url' field" }, 400);
			return;
		}
		try {
			const models = await discoverAigwModels(body.url);
			json({ ok: true, models });
		} catch (err: any) {
			json({ error: err.message }, 502);
		}
		return;
	}

	// POST /api/aigw/refresh — re-discover models from the configured gateway
	if (url.pathname === "/api/aigw/refresh" && req.method === "POST") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ error: "No AI Gateway configured" }, 400);
			return;
		}
		try {
			const models = await configureAigw(aigwUrl, preferencesStore);
			broadcastToAll({ type: "preferences_changed", preferences: preferencesStore.getAll() });
			json({ models });
		} catch (err: any) {
			json({ error: err.message || "Refresh failed" }, 502);
		}
		return;
	}

	// Proxy: /api/aigw/v1/* → forward to configured aigw URL
	if (url.pathname.startsWith("/api/aigw/v1/") && getAigwUrl(preferencesStore)) {
		const aigwUrl = getAigwUrl(preferencesStore)!;
		const subPath = url.pathname.replace("/api/aigw/v1/", "/v1/");
		const targetUrl = `${aigwUrl}${subPath}${url.search}`;
		proxyRequest(targetUrl, req, res);
		return;
	}

	// GET /api/roles/assistant/prompts — must come before :name route
	if (url.pathname === "/api/roles/assistant/prompts" && req.method === "GET") {
		const { ASSISTANT_REGISTRY } = await import("./agent/assistant-registry.js");
		const prompts = Object.values(ASSISTANT_REGISTRY).map((def) => ({
			type: def.type,
			title: def.title,
			promptTitle: def.promptTitle,
			prompt: def.prompt,
		}));
		json({ prompts });
		return;
	}

	// PUT /api/roles/assistant/prompts/:type
	if (url.pathname.startsWith("/api/roles/assistant/prompts/") && req.method === "PUT") {
		const type = url.pathname.slice("/api/roles/assistant/prompts/".length);
		if (!type) {
			json({ error: "Missing type parameter" }, 400);
			return;
		}
		const body = await readBody(req);
		const { updateAssistantDef } = await import("./agent/assistant-registry.js");
		const updated = updateAssistantDef(type, {
			prompt: body?.prompt,
			title: body?.title,
			promptTitle: body?.promptTitle,
		});
		if (!updated) {
			json({ error: `Unknown assistant type: ${type}` }, 404);
			return;
		}
		json(updated);
		return;
	}

	// GET /api/roles
	if (url.pathname === "/api/roles" && req.method === "GET") {
		json({ roles: roleManager.listRoles() });
		return;
	}

	// POST /api/roles
	if (url.pathname === "/api/roles" && req.method === "POST") {
		const body = await readBody(req);
		try {
			const role = roleManager.createRole({
				name: body?.name,
				label: body?.label,
				promptTemplate: body?.promptTemplate || "",
				allowedTools: body?.allowedTools,
				accessory: body?.accessory,
			});
			json(role, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// Routes with role :name parameter
	const roleMatch = url.pathname.match(/^\/api\/roles\/([^/]+)$/);
	if (roleMatch) {
		const name = decodeURIComponent(roleMatch[1]);

		if (req.method === "GET") {
			const role = roleManager.getRole(name);
			if (!role) { json({ error: "Role not found" }, 404); return; }
			json(role);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = roleManager.updateRole(name, {
				label: body.label,
				promptTemplate: body.promptTemplate,
				allowedTools: body.allowedTools,
				accessory: body.accessory,
			});
			if (!ok) { json({ error: "Role not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			const ok = roleManager.deleteRole(name);
			if (!ok) { json({ error: "Role not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// ── Personality endpoints ──────────────────────────────────────

	// GET /api/personalities
	if (url.pathname === "/api/personalities" && req.method === "GET") {
		json({ personalities: personalityManager.listPersonalities() });
		return;
	}

	// POST /api/personalities
	if (url.pathname === "/api/personalities" && req.method === "POST") {
		const body = await readBody(req);
		try {
			const personality = personalityManager.createPersonality({
				name: body?.name,
				label: body?.label,
				description: body?.description || "",
				promptFragment: body?.promptFragment || "",
			});
			json(personality, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// Routes with personality :name parameter
	const personalityMatch = url.pathname.match(/^\/api\/personalities\/([^/]+)$/);
	if (personalityMatch) {
		const name = decodeURIComponent(personalityMatch[1]);

		if (req.method === "GET") {
			const personality = personalityManager.getPersonality(name);
			if (!personality) { json({ error: "Personality not found" }, 404); return; }
			json(personality);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = personalityManager.updatePersonality(name, {
				label: body.label,
				description: body.description,
				promptFragment: body.promptFragment,
			});
			if (!ok) { json({ error: "Personality not found" }, 404); return; }
			json({ ok: true });
			return;
		}

		if (req.method === "DELETE") {
			const ok = personalityManager.deletePersonality(name);
			if (!ok) { json({ error: "Personality not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// ── Task endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/tasks — list tasks for a goal
	const goalTasksMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/tasks$/);
	if (goalTasksMatch && req.method === "GET") {
		const tasks = sessionManager.taskManager.getTasksForGoal(goalTasksMatch[1]);
		json({ tasks });
		return;
	}

	// POST /api/goals/:goalId/tasks — create a task
	if (goalTasksMatch && req.method === "POST") {
		const goalId = goalTasksMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }

		const body = await readBody(req);
		const title = body?.title;
		const type = body?.type;
		if (!title || typeof title !== "string") {
			json({ error: "Missing title" }, 400);
			return;
		}
		if (!type || typeof type !== "string") {
			json({ error: "Missing type" }, 400);
			return;
		}
		try {
			const task = sessionManager.taskManager.createTask(goalId, title, type, {
				parentTaskId: body.parentTaskId,
				spec: body.spec,
				dependsOn: body.dependsOn,
				workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
				inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
			});
			json(task, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// ── Gate endpoints ─────────────────────────────────────────────

	// GET /api/goals/:goalId/gates — list gates for a goal
	const goalGatesMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates$/);
	if (goalGatesMatch && req.method === "GET") {
		const goalId = goalGatesMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const gates = gateStore.getGatesForGoal(goalId);
		// Enrich with workflow gate definitions
		const enriched = gates.map(g => {
			const def = goal.workflow?.gates.find(wg => wg.id === g.gateId);
			return { ...g, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream, metadata: def?.metadata || g.currentMetadata, signalCount: g.signals.length };
		});
		json({ gates: enriched });
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId — gate detail
	const gateDetailMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)$/);
	if (gateDetailMatch && req.method === "GET") {
		const [, goalId, gateId] = gateDetailMatch;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		const goal = sessionManager.goalManager.getGoal(goalId);
		const def = goal?.workflow?.gates.find(wg => wg.id === gateId);
		json({ ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });
		return;
	}

	// POST /api/goals/:goalId/gates/:gateId/signal — signal a gate
	const gateSignalMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signal$/);
	if (gateSignalMatch && req.method === "POST") {
		const [, goalId, gateId] = gateSignalMatch;
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (goal.archived) { json({ error: "Goal is archived" }, 409); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 400); return; }
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

		// Fire-and-forget verification
		verificationHarness.verifyGateSignal(
			signal, gateDef, goal.cwd, goal.branch, "master", allGateStates, goal.spec,
		).catch(err => console.error("[verification] Gate signal error:", err));

		const verifySteps = (gateDef.verify || []).map((s: any) => ({ name: s.name, type: s.type }));
		json({ signal: { id: signal.id, gateId, goalId, status: "running", steps: verifySteps } }, 201);
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/signals — signal history
	const gateSignalsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/signals$/);
	if (gateSignalsMatch && req.method === "GET") {
		const [, goalId, gateId] = gateSignalsMatch;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		json({ signals: gate.signals });
		return;
	}

	// GET /api/goals/:goalId/verifications/active — get in-flight verification state
	const activeVerifMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/verifications\/active$/);
	if (activeVerifMatch && req.method === "GET") {
		const [, goalId] = activeVerifMatch;
		const active = verificationHarness.getActiveVerifications(goalId);
		json({ verifications: active });
		return;
	}

	// GET /api/goals/:goalId/gates/:gateId/content — gate content
	const gateContentMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/gates\/([^/]+)\/content$/);
	if (gateContentMatch && req.method === "GET") {
		const [, goalId, gateId] = gateContentMatch;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		json({ content: gate.currentContent, version: gate.currentContentVersion });
		return;
	}

	// GET /api/goals/:goalId/workflow-context/:gateId — get dependency context for a gate
	const workflowContextMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/workflow-context\/([^/]+)$/);
	if (workflowContextMatch && req.method === "GET") {
		const goalId = workflowContextMatch[1];
		const gateId = workflowContextMatch[2];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		if (!goal.workflow) { json({ error: "Goal has no workflow" }, 404); return; }
		const gateDef = goal.workflow.gates.find(g => g.id === gateId);
		if (!gateDef) { json({ error: "Gate not found" }, 404); return; }

		const context = teamManager.buildDependencyContext(goalId, gateId);
		json({ context, gate: gateDef });
		return;
	}

	// Routes with task :id parameter
	const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
	if (taskMatch) {
		const id = taskMatch[1];

		// GET /api/tasks/:id
		if (req.method === "GET") {
			const task = sessionManager.taskManager.getTask(id);
			if (!task) { json({ error: "Task not found" }, 404); return; }
			json(task);
			return;
		}

		// PUT /api/tasks/:id
		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			try {
				const task = sessionManager.taskManager.getTask(id);
				const prevState = task?.state;
				const ok = sessionManager.taskManager.updateTask(id, {
					title: body.title,
					spec: body.spec,
					state: body.state,
					assignedSessionId: body.assignedSessionId,
					dependsOn: body.dependsOn,
					workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
					inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
				});
				if (!ok) { json({ error: "Task not found" }, 404); return; }

				// Notify team lead when state transitions to terminal or blocked via PUT
				if (body.state && body.state !== prevState && (body.state === "complete" || body.state === "skipped" || body.state === "blocked") && task?.goalId) {
					teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, body.state);
				}

				json({ ok: true });
			} catch (err: any) {
				json({ error: err.message }, 400);
			}
			return;
		}

		// DELETE /api/tasks/:id
		if (req.method === "DELETE") {
			const ok = sessionManager.taskManager.deleteTask(id);
			if (!ok) { json({ error: "Task not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// POST /api/tasks/:id/assign — assign task to session
	const taskAssignMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/assign$/);
	if (taskAssignMatch && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = body?.sessionId;
		if (!sessionId || typeof sessionId !== "string") {
			json({ error: "Missing sessionId" }, 400);
			return;
		}
		try {
			const ok = sessionManager.taskManager.assignTask(taskAssignMatch[1], sessionId);
			if (!ok) { json({ error: "Task not found" }, 400); return; }
			json({ ok: true });
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// POST /api/tasks/:id/transition — state transition
	const taskTransitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
	if (taskTransitionMatch && req.method === "POST") {
		const body = await readBody(req);
		const state = body?.state;
		if (!state || typeof state !== "string") {
			json({ error: "Missing state" }, 400);
			return;
		}
		if (!VALID_TASK_STATES.has(state)) {
			json({ error: `Invalid task state: ${state}` }, 400);
			return;
		}
		try {
			const taskId = taskTransitionMatch[1];
			const task = sessionManager.taskManager.getTask(taskId);
			const ok = sessionManager.taskManager.transitionTask(taskId, state as TaskState);
			if (!ok) { json({ error: "Task not found" }, 400); return; }

			// Notify team lead when a task reaches a terminal or blocked state
			if ((state === "complete" || state === "skipped" || state === "blocked") && task?.goalId) {
				teamManager.notifyTeamLeadOfTaskCompletion(task.goalId, task.title, state);
			}

			json({ ok: true });
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
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
			json({ error: String(err) }, 400);
		}
		return;
	}

	// POST /api/goals/:id/team/spawn — spawn a role agent
	const teamSpawnMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/(?:team|swarm)\/spawn$/);
	if (teamSpawnMatch && req.method === "POST") {
		const goalId = teamSpawnMatch[1];
		// Guard: reject spawn if goal is archived
		const spawnGoal = sessionManager.goalManager.getGoal(goalId);
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
			const spawnOpts: { personalities?: string[]; workflowGateId?: string; inputGateIds?: string[] } = {};
			if (Array.isArray(body.personalities)) spawnOpts.personalities = body.personalities as string[];
			if (typeof body.workflowGateId === "string") spawnOpts.workflowGateId = body.workflowGateId;
			if (Array.isArray(body.inputGateIds)) spawnOpts.inputGateIds = body.inputGateIds as string[];
			const result = await teamManager.spawnRole(goalId, body.role, body.task, spawnOpts);
			json(result, 201);
		} catch (err) {
			if (err instanceof GateDependencyError) {
				json({ error: String(err.message) }, 409);
			} else {
				json({ error: String(err) }, 400);
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
			json({ error: String(err) }, 400);
		}
		return;
	}

	// GET /api/goals/:id/commits — get commit history for goal branch
	const commitsMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/commits$/);
	if (commitsMatch && req.method === "GET") {
		const goalId = commitsMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
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
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		if (url.searchParams.get('fetch') === 'true') {
			try { await execAsync('git fetch --quiet', { cwd, encoding: 'utf-8', timeout: 15000 }); } catch { /* best-effort */ }
		}
		try {
			let branch = "";
			try { branch = await execGit("git rev-parse --abbrev-ref HEAD", cwd); }
			catch { json({ error: "Not a git repository" }, 400); return; }
			let primaryBranch = "master";
			try {
				const remoteHead = await execGit("git symbolic-ref refs/remotes/origin/HEAD", cwd);
				primaryBranch = remoteHead.replace("refs/remotes/origin/", "");
			} catch {
				try { await execGit("git rev-parse --verify refs/heads/master", cwd); primaryBranch = "master"; }
				catch { try { await execGit("git rev-parse --verify refs/heads/main", cwd); primaryBranch = "main"; } catch { /* keep default */ } }
			}
			const isOnPrimary = branch === primaryBranch;
			let aheadOfPrimary = 0, behindPrimary = 0, mergedIntoPrimary = false;
			if (!isOnPrimary) {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				aheadOfPrimary = parseInt(await execGitSafe(`git rev-list --count ${primaryRef}..HEAD`, cwd, "0"), 10) || 0;
				behindPrimary = parseInt(await execGitSafe(`git rev-list --count HEAD..${primaryRef}`, cwd, "0"), 10) || 0;
				mergedIntoPrimary = aheadOfPrimary === 0;
			}
			const statusRaw = await execGitSafe("git status --porcelain", cwd);
			const clean = !statusRaw.trim();
			json({ branch, primaryBranch, isOnPrimary, clean, aheadOfPrimary, behindPrimary, mergedIntoPrimary });
		} catch (err) {
			json({ error: String(err) }, 500);
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
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const cwd = goal.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const pr = await getCachedPrStatus(cwd);
		if (pr) { prStatusStore.set(goalId, pr); json(pr); } else { json({ error: "No PR found" }, 404); }
		return;
	}

	// POST /api/goals/:id/pr-merge — merge PR for goal branch
	const goalPrMergeMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/pr-merge$/);
	if (goalPrMergeMatch && req.method === "POST") {
		const goalId = goalPrMergeMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
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
		try {
			await execAsync(`gh pr merge --${method}${goalAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
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
		if (session.nonInteractive) {
			json({ error: "Cannot steer a non-interactive (automated review) session" }, 400);
			return;
		}
		if (session.status !== "streaming") {
			json({ error: "Agent is not currently streaming — use team/prompt instead" }, 409);
			return;
		}
		try {
			await session.rpcClient.steer(body.message);
			json({ ok: true, dispatched: true });
		} catch (err) {
			json({ error: String(err) }, 500);
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
			json({ error: String(err) }, 500);
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
			const goal = sessionManager.goalManager.getGoal(goalId);
			if (goal?.workflow && gateStore) {
				const wfGate = goal.workflow.gates.find((g: any) => g.id === wfGateId);
				if (wfGate?.dependsOn?.length) {
					const gateStates = gateStore.getGatesForGoal(goalId);
					const passedIds = new Set(gateStates.filter((g: any) => g.status === "passed").map((g: any) => g.gateId));
					const notPassed = wfGate.dependsOn.filter((depId: string) => !passedIds.has(depId));
					if (notPassed.length > 0) {
						const names = notPassed.map((id: string) => {
							const def = goal.workflow!.gates.find((g: any) => g.id === id);
							return def ? `${def.name} (${id})` : id;
						});
						json({ error: `Upstream gate(s) not passed: ${names.join(", ")}. Cannot prompt for gate "${wfGateId}" until dependencies are met.` }, 409);
						return;
					}
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
			json({ error: String(err) }, 500);
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
			json({ error: String(err) }, 400);
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
			json({ error: String(err) }, 400);
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
			// Check if it's an archived session — purge immediately
			const archivedSession = sessionManager.getArchivedSession(id);
			if (archivedSession) {
				await sessionManager.purgeArchivedSession(id);
				json({ ok: true });
				return;
			}
			const terminated = await sessionManager.terminateSession(id);
			if (!terminated) {
				json({ error: "Session not found" }, 404);
				return;
			}
			json({ ok: true });
			return;
		}
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
			json({
				status: session?.status || "idle",
				output,
			});
		} catch (err) {
			json({ error: String(err) }, 408); // Request Timeout
		}
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

		if (typeof body.preview === "boolean") {
			const session = sessionManager.getSession(id);
			if (!session) { json({ error: "Session not found" }, 404); return; }
			session.preview = body.preview;
			sessionManager.persistSessionMetadata(session).catch(() => {});
			broadcastToAll({ type: "preview_changed", sessionId: id, preview: body.preview });
		}

		// Track whether roleId handling already took care of personalities
		let roleHandledPersonalities = false;

		if (typeof body.roleId === "string" && body.roleId !== "") {
			const role = roleManager.getRole(body.roleId);
			if (!role) { json({ error: `Role "${body.roleId}" not found` }, 404); return; }
			// If personalities are also present, validate and pass them to assignRole to avoid double restart
			let assignOpts: { personalities?: string[] } | undefined;
			if (Array.isArray(body.personalities)) {
				const newPersonalities = body.personalities as string[];
				const invalid = newPersonalities.filter((t: string) => !personalityManager.getPersonality(t));
				if (invalid.length > 0) {
					json({ error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
					return;
				}
				assignOpts = { personalities: newPersonalities };
				roleHandledPersonalities = true;
			}
			try {
				const ok = await sessionManager.assignRole(id, role, assignOpts);
				if (!ok) { json({ error: "Session not found" }, 404); return; }
			} catch (err) {
				json({ error: String(err) }, 400);
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

		if (Array.isArray(body.personalities) && !roleHandledPersonalities) {
			const newPersonalities = body.personalities as string[];
			// Validate personality names
			const invalid = newPersonalities.filter((t: string) => !personalityManager.getPersonality(t));
			if (invalid.length > 0) {
				json({ error: `Unknown personalities: ${invalid.join(", ")}` }, 400);
				return;
			}
			try {
				const ok = await sessionManager.updatePersonalities(id, newPersonalities);
				if (!ok) { json({ error: "Session not found" }, 404); return; }
			} catch (err) {
				json({ error: String(err) }, 400);
				return;
			}
		}

		json({ ok: true });
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

	// GET /api/connection-info — LAN addresses for multi-device access
	if (url.pathname === "/api/connection-info" && req.method === "GET") {
		const interfaces = await import("node:os").then((os) => os.networkInterfaces());
		const addresses: { ip: string; name: string }[] = [];
		for (const [name, addrs] of Object.entries(interfaces)) {
			if (!addrs) continue;
			for (const addr of addrs) {
				if (addr.family === "IPv4" && !addr.internal) {
					addresses.push({ ip: addr.address, name });
				}
			}
		}
		json({ addresses, port: config.port });
		return;
	}

	// GET /api/oauth/status
	if (url.pathname === "/api/oauth/status" && req.method === "GET") {
		json(oauthStatus());
		return;
	}

	// POST /api/oauth/start — begin OAuth flow, returns auth URL
	if (url.pathname === "/api/oauth/start" && req.method === "POST") {
		try {
			const result = await oauthStart();
			json(result);
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}

	// POST /api/oauth/complete — exchange code for tokens
	if (url.pathname === "/api/oauth/complete" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.flowId || !body?.code) {
			json({ error: "Missing flowId or code" }, 400);
			return;
		}
		try {
			const result = await oauthComplete(body.flowId, body.code);
			json(result, result.success ? 200 : 400);
		} catch (err) {
			json({ error: String(err) }, 500);
		}
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

		// Optional: run git fetch first when ?fetch=true is passed
		if (url.searchParams.get('fetch') === 'true') {
			try { await execAsync('git fetch --quiet', { cwd, encoding: 'utf-8', timeout: 15000 }); } catch { /* best-effort */ }
		}

		try {
			let branch = '';
			try { branch = await execGit('git rev-parse --abbrev-ref HEAD', cwd); }
			catch { json({ error: "Not a git repository" }, 400); return; }

			let primaryBranch = 'master';
			try {
				const remoteHead = await execGit('git symbolic-ref refs/remotes/origin/HEAD', cwd);
				primaryBranch = remoteHead.replace('refs/remotes/origin/', '');
			} catch {
				try { await execGit('git rev-parse --verify refs/heads/master', cwd); primaryBranch = 'master'; }
				catch { try { await execGit('git rev-parse --verify refs/heads/main', cwd); primaryBranch = 'main'; } catch { /* keep default */ } }
			}

			const isOnPrimary = branch === primaryBranch;
			// Don't use execGit here — its trim() strips the leading space from
			// porcelain status lines like " M file.txt", corrupting the first filename.
			let statusRaw = "";
			try {
				const { stdout } = await execAsync('git status --porcelain', { cwd, encoding: "utf-8", timeout: 5000 });
				statusRaw = stdout.replace(/\s+$/, '');
			} catch {}
			const statusLines = statusRaw ? statusRaw.split("\n") : [];
			const status = statusLines.map(line => {
				const l = line.endsWith("\r") ? line.slice(0, -1) : line;
				return { file: l.substring(3), status: l.substring(0, 2).trim() };
			});

			let hasUpstream = false;
			try { await execGit(`git rev-parse --abbrev-ref ${branch}@{u}`, cwd); hasUpstream = true; } catch { /* no upstream */ }

			let ahead = 0, behind = 0;
			if (hasUpstream) {
				ahead = parseInt(await execGitSafe('git rev-list --count @{u}..HEAD', cwd, '0'), 10) || 0;
				behind = parseInt(await execGitSafe('git rev-list --count HEAD..@{u}', cwd, '0'), 10) || 0;
			}

			let aheadOfPrimary = 0, behindPrimary = 0, mergedIntoPrimary = false;
			if (!isOnPrimary) {
				let primaryRef = primaryBranch;
				try { await execGit(`git rev-parse --verify origin/${primaryBranch}`, cwd); primaryRef = `origin/${primaryBranch}`; } catch { /* use local */ }
				aheadOfPrimary = parseInt(await execGitSafe(`git rev-list --count ${primaryRef}..HEAD`, cwd, '0'), 10) || 0;
				behindPrimary = parseInt(await execGitSafe(`git rev-list --count HEAD..${primaryRef}`, cwd, '0'), 10) || 0;
				mergedIntoPrimary = aheadOfPrimary === 0;
			}

			const clean = statusLines.length === 0;
			let summary = 'clean';
			if (!clean) {
				const counts: Record<string, number> = {};
				for (const line of statusLines) {
					const code = line.substring(0, 2).trim();
					let key: string;
					if (code.includes('?')) key = '?';
					else if (code.includes('M')) key = 'M';
					else if (code.includes('A')) key = 'A';
					else if (code.includes('D')) key = 'D';
					else if (code.includes('R')) key = 'R';
					else if (code.includes('U')) key = 'U';
					else key = code;
					counts[key] = (counts[key] || 0) + 1;
				}
				summary = Object.entries(counts).map(([k, v]) => `${v}${k}`).join(' ');
			}

			json({
				branch, primaryBranch, isOnPrimary, status, hasUpstream,
				ahead, behind, aheadOfPrimary, behindPrimary, mergedIntoPrimary,
				clean, summary, unpushed: hasUpstream ? ahead > 0 : !mergedIntoPrimary,
			});
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
	}
	// GET /api/sessions/:id/pr-status — PR status for session's branch
	if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/pr-status')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const pr = await getCachedPrStatus(cwd);
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
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const { stdout } = await execAsync('git pull', { cwd, encoding: "utf-8", timeout: 30000 });
			json({ ok: true, output: stdout.trim() });
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
		if (!fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		const body = await readBody(req);
		const method = body?.method ?? "squash";
		if (!["merge", "squash", "rebase"].includes(method)) {
			json({ error: "Invalid merge method. Must be merge, squash, or rebase." }, 400);
			return;
		}
		const sessAdminFlag = body?.admin ? " --admin" : "";
		try {
			await execAsync(`gh pr merge --${method}${sessAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
			json({ ok: true });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// GET /api/slash-skills — discover .claude/skills/ SKILL.md files for autocomplete
	if (url.pathname === "/api/slash-skills" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || process.cwd();
		const skills = discoverSlashSkills(cwd);
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint, source: s.source })) });
		return;
	}

	// GET /api/slash-skills/details — full slash skill details including content and file paths
	if (url.pathname === "/api/slash-skills/details" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || process.cwd();
		const skills = discoverSlashSkills(cwd);
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath, content: s.content })) });
		return;
	}

	// ── Workflow endpoints ──────────────────────────────────────────

	// POST /api/workflows/:id/clone (must be checked BEFORE single-workflow route)
	const workflowCloneMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)\/clone$/);
	if (workflowCloneMatch && req.method === "POST") {
		const id = decodeURIComponent(workflowCloneMatch[1]);
		try {
			const cloned = workflowManager.cloneWorkflow(id);
			json(cloned, 201);
		} catch (err: any) {
			json({ error: err.message }, 404);
		}
		return;
	}

	// GET /api/workflows
	const workflowsMatch = url.pathname === "/api/workflows";
	if (workflowsMatch && req.method === "GET") {
		json({ workflows: workflowManager.listWorkflows() });
		return;
	}

	// POST /api/workflows
	if (workflowsMatch && req.method === "POST") {
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		try {
			const workflow = workflowManager.createWorkflow({
				id: body.id,
				name: body.name,
				description: body.description,
				gates: body.gates || [],
			});
			json(workflow, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// GET /api/workflows/:id
	const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
	if (workflowMatch && req.method === "GET") {
		const wf = workflowManager.getWorkflow(decodeURIComponent(workflowMatch[1]));
		if (!wf) { json({ error: "Workflow not found" }, 404); return; }
		json(wf);
		return;
	}

	// PUT /api/workflows/:id
	if (workflowMatch && req.method === "PUT") {
		const id = decodeURIComponent(workflowMatch[1]);
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		try {
			const ok = workflowManager.updateWorkflow(id, body);
			if (!ok) { json({ error: "Workflow not found" }, 404); return; }
			const updated = workflowManager.getWorkflow(id);
			json(updated);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// DELETE /api/workflows/:id
	if (workflowMatch && req.method === "DELETE") {
		const id = decodeURIComponent(workflowMatch[1]);
		const wf = workflowManager.getWorkflow(id);
		if (!wf) { json({ error: "Workflow not found" }, 404); return; }
		// Check if any active goal references this workflow
		const allGoals = sessionManager.goalManager.listGoals();
		if (allGoals.some((g: any) => g.workflowId === id && g.state !== "complete")) {
			json({ error: "Cannot delete: workflow is in use by active goals" }, 409);
			return;
		}
		workflowManager.deleteWorkflow(id);
		res.writeHead(204);
		res.end();
		return;
	}

	// ── Cost endpoints ─────────────────────────────────────────────

	// GET /api/sessions/:id/cost — cost for a single session
	const sessionCostMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost$/);
	if (sessionCostMatch && req.method === "GET") {
		const id = sessionCostMatch[1];
		const cost = sessionManager.getCostTracker().getSessionCost(id);
		if (!cost) {
			json({ error: "No cost data for this session" }, 404);
			return;
		}
		json(cost);
		return;
	}

	// GET /api/goals/:goalId/cost — aggregate cost across all sessions linked to a goal
	const goalCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost$/);
	if (goalCostMatch && req.method === "GET") {
		const goalId = goalCostMatch[1];
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const cost = sessionManager.getCostTracker().getGoalCost(goalId, sessionIds);
		json(cost);
		return;
	}

	// GET /api/tasks/:id/cost — cost for the session(s) assigned to a task
	const taskCostMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cost$/);
	if (taskCostMatch && req.method === "GET") {
		const taskId = taskCostMatch[1];
		const task = sessionManager.taskManager.getTask(taskId);
		if (!task) {
			json({ error: "Task not found" }, 404);
			return;
		}
		if (!task.assignedSessionId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const cost = sessionManager.getCostTracker().getSessionCost(task.assignedSessionId);
		json(cost ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
		return;
	}

	// GET /api/preview?sessionId=xxx — get preview HTML for a session
	if (url.pathname === "/api/preview" && req.method === "GET") {
		const sessionId = url.searchParams.get("sessionId");
		const previewPath = sessionId
			? path.join(bobbitStateDir(), `preview-${sessionId}.html`)
			: path.join(bobbitStateDir(), "preview.html");
		try {
			const content = fs.readFileSync(previewPath, "utf-8");
			const stat = fs.statSync(previewPath);
			json({ html: content, mtime: stat.mtimeMs });
		} catch {
			json({ html: "", mtime: 0 });
		}
		return;
	}

	// POST /api/preview?sessionId=xxx — set preview HTML for a session
	if (url.pathname === "/api/preview" && req.method === "POST") {
		const body = await readBody(req);
		const sessionId = url.searchParams.get("sessionId");
		const previewPath = sessionId
			? path.join(bobbitStateDir(), `preview-${sessionId}.html`)
			: path.join(bobbitStateDir(), "preview.html");
		fs.writeFileSync(previewPath, body?.html || "", "utf-8");
		json({ ok: true });
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
		const info = bgProcessManager.create(id, body.command, session.cwd);
		json(info, 201);
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

	// PUT /api/sessions/:id/draft — upsert a draft
	const draftPutMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/draft$/);
	if (draftPutMatch && req.method === "PUT") {
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

	// ── Staff endpoints ────────────────────────────────────────────

	// GET /api/staff
	if (url.pathname === "/api/staff" && req.method === "GET") {
		json({ staff: staffManager.listStaff() });
		return;
	}

	// POST /api/staff
	if (url.pathname === "/api/staff" && req.method === "POST") {
		const body = await readBody(req);
		if (!body?.name || typeof body.name !== "string") {
			json({ error: "Missing name" }, 400);
			return;
		}
		if (!body?.systemPrompt || typeof body.systemPrompt !== "string") {
			json({ error: "Missing systemPrompt" }, 400);
			return;
		}
		const cwd = body.cwd || config.defaultCwd;
		try {
			const staff = await staffManager.createStaff(
				body.name,
				body.description || "",
				body.systemPrompt,
				cwd,
				sessionManager,
				{ triggers: body.triggers, roleId: body.roleId },
			);
			json(staff, 201);
		} catch (err: any) {
			console.error("[server] Failed to create staff agent:", err);
			json({ error: err?.message || "Failed to create staff agent" }, 500);
		}
		return;
	}

	// Routes with staff :id parameter
	const staffMatch = url.pathname.match(/^\/api\/staff\/([^/]+)$/);
	if (staffMatch) {
		const id = staffMatch[1];

		if (req.method === "GET") {
			const staff = staffManager.getStaff(id);
			if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
			json(staff);
			return;
		}

		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			const ok = staffManager.updateStaff(id, {
				name: body.name,
				description: body.description,
				systemPrompt: body.systemPrompt,
				cwd: body.cwd,
				state: body.state,
				triggers: body.triggers,
				memory: body.memory,
				roleId: body.roleId,
			});
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			json(staffManager.getStaff(id));
			return;
		}

		if (req.method === "DELETE") {
			const ok = await staffManager.deleteStaff(id, sessionManager);
			if (!ok) { json({ error: "Staff agent not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// POST /api/staff/:id/wake — manually trigger a wake cycle
	const staffWakeMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/wake$/);
	if (staffWakeMatch && req.method === "POST") {
		const id = staffWakeMatch[1];
		const staff = staffManager.getStaff(id);
		if (!staff) { json({ error: "Staff agent not found" }, 404); return; }
		const body = await readBody(req);
		try {
			const sessionId = await staffManager.wake(id, body?.prompt, sessionManager);
			json({ sessionId }, 201);
		} catch (err) {
			json({ error: String(err) }, 400);
		}
		return;
	}

	// GET /api/staff/:id/sessions — DEPRECATED (staff agents have a single permanent session)
	const staffSessionsMatch = url.pathname.match(/^\/api\/staff\/([^/]+)\/sessions$/);
	if (staffSessionsMatch && req.method === "GET") {
		json({ error: "Deprecated. Staff agents have a single permanent session. Use GET /api/staff/:id." }, 410);
		return;
	}

	json({ error: "Not found" }, 404);
}

/** Check if gateId transitively depends on targetId in the workflow DAG */
function hasTransitiveDep(workflow: import("./agent/workflow-store.js").Workflow, gateId: string, targetId: string, visited = new Set<string>()): boolean {
	if (visited.has(gateId)) return false;
	visited.add(gateId);
	const gate = workflow.gates.find(g => g.id === gateId);
	if (!gate) return false;
	for (const dep of gate.dependsOn) {
		if (dep === targetId) return true;
		if (hasTransitiveDep(workflow, dep, targetId, visited)) return true;
	}
	return false;
}

function readBody(req: http.IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch {
				resolve(null);
			}
		});
	});
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
};

function serveStatic(pathname: string, staticDir: string, res: http.ServerResponse) {
	const resolvedStaticDir = path.resolve(staticDir);
	let filePath = path.resolve(staticDir, pathname === "/" ? "index.html" : pathname.slice(1));

	// Prevent directory traversal
	if (!filePath.startsWith(resolvedStaticDir)) {
		res.writeHead(403);
		res.end();
		return;
	}

	try {
		if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
			// SPA fallback — serve index.html for unmatched routes
			filePath = path.join(resolvedStaticDir, "index.html");
			if (!fs.existsSync(filePath)) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
		}

		const ext = path.extname(filePath).toLowerCase();
		const contentType = MIME_TYPES[ext] || "application/octet-stream";
		const content = fs.readFileSync(filePath);

		res.writeHead(200, { "Content-Type": contentType });
		res.end(content);
	} catch {
		res.writeHead(500);
		res.end("Internal server error");
	}
}
