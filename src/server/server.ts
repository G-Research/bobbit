import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { WebSocketServer } from "ws";
import { bobbitStateDir } from "./bobbit-dir.js";
import { ColorStore } from "./agent/color-store.js";
import { PrStatusStore } from "./agent/pr-status-store.js";
import { SessionManager } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { validateToken } from "./auth/token.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import { TeamManager } from "./agent/team-manager.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolManager } from "./agent/tool-manager.js";
import { PersonalityStore } from "./agent/personality-store.js";
import { PersonalityManager } from "./agent/personality-manager.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";
import { GateStore } from "./agent/gate-store.js";
import { WorkflowStore } from "./agent/workflow-store.js";
import { WorkflowManager } from "./agent/workflow-manager.js";
import { VerificationHarness } from "./agent/verification-harness.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore } from "./agent/project-config-store.js";
import { startupAigwCheck, writeContextWindowOverrides } from "./agent/aigw-manager.js";
import { bustPrCache } from "./services/github-service.js";
import { routeApiRequest } from "./routes/index.js";
import type { AppContext } from "./app-context.js";

export type { GatewayConfig, TlsConfig } from "./app-context.js";
import type { GatewayConfig } from "./app-context.js";

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
	const rateLimiter = new RateLimiter();
	const cleanupInterval = setInterval(() => rateLimiter.cleanup(), 60_000);

	// Verification harness — assigned after wss is created (closure captures the reference)
	let verificationHarness: VerificationHarness;

	// Mutable ctx — broadcastToGoal/broadcastToAll are set after WSS creation
	const ctx: AppContext = {
		config,
		sessionManager,
		teamManager,
		gateStore,
		roleManager,
		toolManager,
		colorStore,
		prStatusStore,
		personalityManager,
		bgProcessManager,
		staffManager,
		workflowManager,
		get verificationHarness() { return verificationHarness; },
		preferencesStore,
		projectConfigStore,
		broadcastToGoal: () => {},  // replaced after WSS creation
		broadcastToAll: () => {},   // replaced after WSS creation
	};

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

			await routeApiRequest(ctx, url, req, res);
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

	// Wire up broadcast functions on the ctx
	ctx.broadcastToGoal = broadcastToGoal;
	ctx.broadcastToAll = broadcastToAll;

	teamManager.setBroadcastToGoal(broadcastToGoal);
	sessionManager.setOnPrCreationDetected((session) => {
		const goalId = session.goalId || session.teamGoalId;
		if (!goalId) return;
		const goal = sessionManager.goalManager.getGoal(goalId);
		if (!goal) return;
		bustPrCache(goal.cwd, goal.branch);
		broadcastToAll({ type: "pr_status_changed", goalId });
	});
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
			handleWebSocketConnection(ws, match[1], req, sessionManager, config.authToken, rateLimiter, projectConfigStore, isLocalhostServer);
		});
	});

	return {
		server,
		sessionManager,
		async start(): Promise<number> {
			// Check internet and auto-configure AI Gateway if offline
			await startupAigwCheck(preferencesStore);
			writeContextWindowOverrides();

			// Initialize MCP servers
			try {
				await sessionManager.initMcp(process.cwd());
			} catch (err) {
				console.error('[mcp] MCP init failed:', (err as Error).message);
			}

			// Restore persisted sessions before accepting connections
			await sessionManager.restoreSessions();
			sessionManager.startPurgeSchedule();
			// Now that sessions are live, re-subscribe to team events
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
					if (port !== config.port) {
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

// ── Static file serving ──

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
