import { exec, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { fileURLToPath } from "node:url";
import { bobbitStateDir, bobbitConfigDir, getProjectRoot } from "./bobbit-dir.js";
import { WebSocketServer } from "ws";
import { ColorStore } from "./agent/color-store.js";
import { PrStatusStore } from "./agent/pr-status-store.js";
import { SessionManager } from "./agent/session-manager.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { validateToken } from "./auth/token.js";
import { oauthComplete, oauthStart, oauthStatus } from "./auth/oauth.js";
import { handleWebSocketConnection } from "./ws/handler.js";
import { discoverSlashSkills, getSkillDirectories } from "./skills/slash-skills.js";
import { TeamManager, GateDependencyError } from "./agent/team-manager.js";
import { RoleStore } from "./agent/role-store.js";
import { RoleManager } from "./agent/role-manager.js";
import { ToolManager } from "./agent/tool-manager.js";
import { PersonalityStore } from "./agent/personality-store.js";
import { PersonalityManager } from "./agent/personality-manager.js";

import { getPromptSections, initPromptDirs } from "./agent/system-prompt.js";
import type { TaskState } from "./agent/task-store.js";
import { TaskManager } from "./agent/task-manager.js";
import { BgProcessManager } from "./agent/bg-process-manager.js";

import { WorkflowStore } from "./agent/workflow-store.js";
import { WorkflowManager } from "./agent/workflow-manager.js";
import { isGitRepo, getRepoRoot } from "./skills/git.js";
import { VerificationHarness } from "./agent/verification-harness.js";
import { StaffManager } from "./agent/staff-manager.js";
import { TriggerEngine } from "./agent/staff-trigger-engine.js";
import { PreferencesStore } from "./agent/preferences-store.js";
import { ProjectConfigStore } from "./agent/project-config-store.js";
import { ToolGroupPolicyStore } from "./agent/tool-group-policy-store.js";
import { getAllConfigDirectories, removeBuiltinDirectory, resetConfigDirectories } from "./agent/config-directories.js";
import { checkDockerAvailability, buildSandboxImage, isBuildingImage, ensureImageAgentVersion } from "./agent/sandbox-status.js";
import { SandboxManager } from "./agent/sandbox-manager.js";
import { validateSandboxMounts } from "./agent/sandbox-mounts.js";
import { SandboxTokenStore, type SandboxScope } from "./auth/sandbox-token.js";
import { isSandboxAllowed } from "./auth/sandbox-guard.js";
import { configureAigw, removeAigw, getAigwUrl, discoverAigwModels, proxyRequest, startupAigwCheck, writeContextWindowOverrides } from "./agent/aigw-manager.js";
import { getAvailableModels, discoverModelsForConfig } from "./agent/model-registry.js";
import type { CustomProviderConfig } from "./agent/model-registry.js";
import { ProjectRegistry } from "./agent/project-registry.js";
import { ProjectContextManager } from "./agent/project-context-manager.js";
import { GoalManager } from "./agent/goal-manager.js";
import type { PersistedGoal } from "./agent/goal-store.js";
import { migrateToPerProjectState, recoverPreMigrationData } from "./agent/state-migration.js";
import { resolveScalarConfig } from "./agent/config-resolver.js";

import { initAssistantRegistry } from "./agent/assistant-registry.js";

const VALID_TASK_STATES = new Set<string>(["todo", "in-progress", "blocked", "complete", "skipped"]);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFileCb);

/** Cached Docker availability result to avoid running `docker info` per session creation */
let _dockerAvailCache: { available: boolean; error?: string; ts: number } | null = null;

// ── PR status cache (avoids blocking event loop with gh CLI every poll) ──
const _prCache = new Map<string, { data: any; ts: number; ttl: number }>();
const PR_NULL_CACHE_TTL_MS = 30_000; // 30 seconds for null (no-PR) results
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

async function _fetchPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const ghFields = "--json state,url,number,title,mergeable,headRefName,reviewDecision";
	const branchArg = branch ? ` ${branch}` : "";
	const cmd = `gh pr view${branchArg} ${ghFields}`;

	// Try cwd first, then fallback (e.g. main repo when worktree git link is broken)
	const cwdsToTry = [cwd, ...(fallbackCwd && fallbackCwd !== cwd ? [fallbackCwd] : [])];
	for (const dir of cwdsToTry) {
		try {
			const { stdout } = await execAsync(cmd, { cwd: dir, encoding: "utf-8", timeout: 10000 });
			const pr = JSON.parse(stdout);
			const viewerIsAdmin = await getViewerIsAdmin(dir);
			const data = { number: pr.number, url: pr.url, title: pr.title, state: pr.state, mergeable: pr.mergeable, headRefName: pr.headRefName, reviewDecision: pr.reviewDecision || null, viewerIsAdmin };
			const ttl = pr.state === "OPEN" ? 10_000 : 900_000; // OPEN: 10s, CLOSED/MERGED: 15min
			_prCache.set(cacheKey, { data, ts: Date.now(), ttl });
			return data;
		} catch {
			// Try next cwd
		}
	}
	_prCache.set(cacheKey, { data: null, ts: Date.now(), ttl: PR_NULL_CACHE_TTL_MS });
	return null;
}

async function getCachedPrStatus(cwd: string, branch?: string, fallbackCwd?: string): Promise<any | null> {
	const cacheKey = branch ? `${cwd}::${branch}` : cwd;
	const cached = _prCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < cached.ttl) return cached.data;

	const existing = _prInFlight.get(cacheKey);
	if (existing) return existing;

	const p = _fetchPrStatus(cwd, branch, fallbackCwd);
	_prInFlight.set(cacheKey, p);
	try { return await p; } finally { _prInFlight.delete(cacheKey); }
}

// ── Async git helpers (avoid blocking event loop) ──
async function execGit(cmd: string, cwd: string, timeout = 5000, containerId?: string): Promise<string> {
	if (containerId) {
		// Run inside Docker container
		const { stdout } = await execFileAsync("docker", [
			"exec", "-w", cwd, containerId, "/bin/sh", "-c", cmd,
		], { encoding: "utf-8", timeout, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		return stdout.trim();
	}
	const { stdout } = await execAsync(cmd, { cwd, encoding: "utf-8", timeout });
	return stdout.trim();
}
async function execGitSafe(cmd: string, cwd: string, fallback = "", containerId?: string): Promise<string> {
	try { return await execGit(cmd, cwd, 5000, containerId); } catch { return fallback; }
}

/** Batched git status — runs all queries in a single shell invocation.
 *  Returns null if not a git repository. */
async function batchGitStatus(cwd: string, containerId?: string): Promise<{
	branch: string; primaryBranch: string; isOnPrimary: boolean;
	status: { file: string; status: string }[];
	hasUpstream: boolean; ahead: number; behind: number;
	aheadOfPrimary: number; behindPrimary: number; mergedIntoPrimary: boolean;
	clean: boolean; summary: string; unpushed: boolean;
} | null> {
	// Single script with NUL-delimited sections — avoids spawning 6-8 processes.
	const batchScript = [
		'git rev-parse --abbrev-ref HEAD 2>/dev/null || echo __FAIL__',
		'printf "\\0"',
		'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo __FAIL__',
		'printf "\\0"',
		'git rev-parse --verify refs/heads/master 2>/dev/null && echo yes || echo no',
		'printf "\\0"',
		'git rev-parse --verify refs/heads/main 2>/dev/null && echo yes || echo no',
		'printf "\\0"',
		'git -c core.filemode=false status --porcelain 2>/dev/null',
		'printf "\\0"',
		'BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)',
		'git rev-parse --abbrev-ref "$BRANCH@{u}" 2>/dev/null || echo __FAIL__',
		'printf "\\0"',
		'git rev-list --count @{u}..HEAD 2>/dev/null || echo 0',
		'printf "\\0"',
		'git rev-list --count HEAD..@{u} 2>/dev/null || echo 0',
		'printf "\\0"',
		'PRIMARY=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s|refs/remotes/origin/||")',
		'if [ -z "$PRIMARY" ]; then PRIMARY=master; fi',
		'if git rev-parse --verify "origin/$PRIMARY" >/dev/null 2>&1; then PREF="origin/$PRIMARY"; else PREF="$PRIMARY"; fi',
		'git rev-list --count "$PREF..HEAD" 2>/dev/null || echo 0',
		'printf "\\0"',
		'git rev-list --count "HEAD..$PREF" 2>/dev/null || echo 0',
	].join('\n');

	let rawOutput: string;
	if (containerId) {
		const { stdout } = await execFileAsync("docker", [
			"exec", "-w", cwd, containerId, "/bin/sh", "-c", batchScript,
		], { encoding: "utf-8", timeout: 10000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
		rawOutput = stdout;
	} else {
		const { stdout } = await execAsync(batchScript, { cwd, encoding: "utf-8", timeout: 10000, shell: process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/sh" });
		rawOutput = stdout;
	}

	const sections = rawOutput.split('\0').map(s => s.trim());

	const branchRaw = sections[0] || '';
	if (branchRaw === '__FAIL__' || !branchRaw) return null;
	const branch = branchRaw;

	let primaryBranch = 'master';
	const remoteHeadRaw = sections[1] || '';
	if (remoteHeadRaw !== '__FAIL__' && remoteHeadRaw) {
		primaryBranch = remoteHeadRaw.replace('refs/remotes/origin/', '');
	} else {
		const masterExists = (sections[2] || '').startsWith('yes');
		const mainExists = (sections[3] || '').startsWith('yes');
		if (!masterExists && mainExists) primaryBranch = 'main';
	}

	const isOnPrimary = branch === primaryBranch;

	// Parse porcelain status — preserve leading spaces in status codes
	const statusRaw = sections[4] || '';
	const statusLines = statusRaw ? statusRaw.split("\n") : [];
	const status = statusLines.map(line => {
		const l = line.endsWith("\r") ? line.slice(0, -1) : line;
		return { file: l.substring(3), status: l.substring(0, 2).trim() };
	});

	const upstreamRaw = sections[5] || '';
	const hasUpstream = upstreamRaw !== '__FAIL__' && upstreamRaw !== '';

	let ahead = 0, behind = 0;
	if (hasUpstream) {
		ahead = parseInt(sections[6] || '0', 10) || 0;
		behind = parseInt(sections[7] || '0', 10) || 0;
	}

	let aheadOfPrimary = 0, behindPrimary = 0, mergedIntoPrimary = false;
	if (!isOnPrimary) {
		aheadOfPrimary = parseInt(sections[8] || '0', 10) || 0;
		behindPrimary = parseInt(sections[9] || '0', 10) || 0;
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

	return {
		branch, primaryBranch, isOnPrimary, status, hasUpstream,
		ahead, behind, aheadOfPrimary, behindPrimary, mergedIntoPrimary,
		clean, summary, unpushed: hasUpstream ? ahead > 0 : !mergedIntoPrimary,
	};
}

// ── Git diff helper (shared between session and goal endpoints) ──
const DIFF_MAX_BYTES = 500 * 1024; // 500KB

async function getGitDiff(cwd: string, file?: string, containerId?: string): Promise<string> {
	const opts = { cwd, encoding: "utf-8" as const, timeout: 5000 };
	let hasHead = true;
	try { await execGit("git rev-parse --verify HEAD", cwd, 5000, containerId); } catch { hasHead = false; }

	let diff = "";
	if (file) {
		// Sanitize: reject path traversal, absolute paths, drive letters
		if (file.includes("..") || path.isAbsolute(file) || /^[a-zA-Z]:/.test(file)) {
			throw new Error("INVALID_PATH");
		}
		if (containerId) {
			// Run git diff inside container
			if (hasHead) {
				diff = await execGitSafe(`git diff HEAD -- ${file}`, cwd, "", containerId);
			} else {
				diff = await execGitSafe(`git diff --cached -- ${file}`, cwd, "", containerId)
					+ await execGitSafe(`git diff -- ${file}`, cwd, "", containerId);
			}
			if (!diff.trim()) {
				diff = await execGitSafe(`git diff --no-index /dev/null -- ${file}`, cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD", "--", file], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached", "--", file], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff", "--", file], opts);
			diff = s1 + s2;
		}
		// Try untracked if empty (host path only — container path handled above)
		if (!diff.trim() && !containerId) {
			try {
				const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
				const { stdout } = await execFileAsync("git", ["diff", "--no-index", devNull, "--", file], opts);
				diff = stdout;
			} catch (e: any) {
				// git diff --no-index exits 1 when there are differences
				if (e.stdout) diff = e.stdout;
			}
		}
	} else {
		if (containerId) {
			if (hasHead) {
				diff = await execGitSafe("git diff HEAD", cwd, "", containerId);
			} else {
				diff = await execGitSafe("git diff --cached", cwd, "", containerId)
					+ await execGitSafe("git diff", cwd, "", containerId);
			}
		} else if (hasHead) {
			const { stdout } = await execFileAsync("git", ["diff", "HEAD"], opts);
			diff = stdout;
		} else {
			const { stdout: s1 } = await execFileAsync("git", ["diff", "--cached"], opts);
			const { stdout: s2 } = await execFileAsync("git", ["diff"], opts);
			diff = s1 + s2;
		}
	}

	if (!diff.trim()) throw new Error("NO_DIFF");

	if (Buffer.byteLength(diff, "utf-8") > DIFF_MAX_BYTES) {
		diff = diff.slice(0, DIFF_MAX_BYTES) + "\n\n--- Diff truncated (exceeded 500KB) ---";
	}
	return diff;
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
	const stateDir = bobbitStateDir();
	const configDir = bobbitConfigDir();
	fs.mkdirSync(stateDir, { recursive: true });

	// Initialize module-level caches for parameterized modules
	initPromptDirs(stateDir);
	initAssistantRegistry(configDir);

	// Project registry — persisted at server level
	const projectRegistry = new ProjectRegistry(stateDir);
	projectRegistry.ensureDefaultProject(getProjectRoot());

	// Run one-time migration from centralized to per-project state
	migrateToPerProjectState(stateDir, projectRegistry, getProjectRoot());

	// Recover data lost by the original migration bug (unconditional rename
	// when central dir == default project dir). Must run before stores load.
	recoverPreMigrationData(stateDir);

	// Initialize per-project contexts
	const projectContextManager = new ProjectContextManager(projectRegistry);
	projectContextManager.initAll();

	const colorStore = new ColorStore(stateDir);
	const prStatusStore = new PrStatusStore(stateDir);
	const preferencesStore = new PreferencesStore(stateDir);
	const projectConfigStore = new ProjectConfigStore(configDir);
	const savedCwd = preferencesStore.get("defaultCwd");
	if (savedCwd && typeof savedCwd === "string") {
		config.defaultCwd = savedCwd;
	}
	const personalityStore = new PersonalityStore(configDir);
	const personalityManager = new PersonalityManager(personalityStore);
	const roleStore = new RoleStore(configDir);
	const roleManager = new RoleManager(roleStore);
	const toolManager = new ToolManager(configDir);
	const groupPolicyStore = new ToolGroupPolicyStore(configDir);
	const workflowStore = new WorkflowStore(configDir);
	const sandboxTokenStore = new SandboxTokenStore();
	const sessionManager = new SessionManager({
		agentCliPath: config.agentCliPath,
		systemPromptPath: config.systemPromptPath,
		colorStore,
		personalityManager,
		roleManager,
		toolManager,
		workflowStore,
		preferencesStore,
		projectConfigStore,
		groupPolicyStore,
		projectContextManager,
	});
	sessionManager.sandboxTokenStore = sandboxTokenStore;
	// Wire gate status changes to bump goal generation for all project contexts
	for (const ctx of projectContextManager.all()) {
		ctx.gateStore.onStatusChange = () => {
			ctx.goalStore.bumpGeneration();
		};
	}
	const workflowManager = new WorkflowManager(workflowStore);
	const staffManager = new StaffManager(projectContextManager);
	const triggerEngine = new TriggerEngine(staffManager, sessionManager);
	triggerEngine.start();
	const teamManager = new TeamManager(sessionManager, {
		colorStore,
		taskManager: new TaskManager(projectContextManager.getDefault().taskStore),
		roleStore,
		personalityManager,
		projectContextManager,
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
			let sandboxScope: SandboxScope | undefined;
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
				}
			}

			// Enforce sandbox route guard
			if (sandboxScope && !isSandboxAllowed(url.pathname, req.method || "GET", sandboxScope)) {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Forbidden: sandbox token cannot access this endpoint" }));
				return;
			}

			await handleApiRoute(url, req, res, sessionManager, config, colorStore, prStatusStore, teamManager, roleManager, toolManager, projectContextManager, personalityManager, bgProcessManager, staffManager, workflowManager, verificationHarness, preferencesStore, projectConfigStore, groupPolicyStore, broadcastToGoal, broadcastToAll, sandboxManager, projectRegistry, sandboxScope, sandboxTokenStore);

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

	// Long-polling endpoints (e.g. /api/sessions/:id/wait) can block for 10+ minutes.
	// Node >= 19 defaults requestTimeout to 300s which would kill those requests.
	// Disable the server-level timeout; individual endpoints manage their own.
	server.requestTimeout = 0;
	server.headersTimeout = 0;

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
	teamManager.setBroadcastToGoal(broadcastToGoal);
	sessionManager.setOnPrCreationDetected((session) => {
		const goalId = session.goalId || session.teamGoalId;
		if (!goalId) return;
		const goalCtx = projectContextManager.getContextForGoal(goalId);
		const goal = goalCtx?.goalStore.get(goalId);
		if (!goal) return;
		_prCache.delete(goal.cwd);
		if (goal.branch) _prCache.delete(`${goal.cwd}::${goal.branch}`);
		broadcastToAll({ type: "pr_status_changed", goalId });
	});
	verificationHarness = new VerificationHarness(stateDir, undefined, broadcastToGoal, roleStore, preferencesStore, sessionManager, teamManager, projectConfigStore, projectContextManager);
	teamManager.setVerificationHarness(verificationHarness);
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
		async start(): Promise<number> {
			// Check internet and auto-configure AI Gateway if offline
			// Runs before session restore so models.json is written before
			// any agent subprocesses start.
			await startupAigwCheck(preferencesStore);
			writeContextWindowOverrides();

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

			// ── Sandbox initialization (per-project container) ──
			const sandboxCfg = projectConfigStore.get("sandbox") || "none";
			if (sandboxCfg === "docker") {
				try {
					const imageName = projectConfigStore.get("sandbox_image") || "bobbit-agent";

					// Auto-build or rebuild image if missing or stale
					const imageStatus = await checkDockerAvailability(imageName);
					if (imageStatus.imageExists === false && imageStatus.dockerfileExists === true) {
						const buildResult = await buildSandboxImage(imageName, config.defaultCwd);
						if (!buildResult.success) {
							console.error(`[sandbox] Auto-build failed, continuing without sandbox`);
						}
					} else if (imageStatus.imageExists === true) {
						// Ensure baked-in pi-coding-agent version matches host
						await ensureImageAgentVersion(imageName, config.defaultCwd);
					}

					const { getRepoRoot, isGitRepo: isGitRepoFn } = await import("./skills/git.js");
					const isRepo = await isGitRepoFn(config.defaultCwd);
					if (isRepo) {
						const repoPath = await getRepoRoot(config.defaultCwd);

						// Get repo URL for cloning inside the container
						let repoUrl: string;
						try {
							const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoPath, timeout: 5000 });
							repoUrl = stdout.trim();
						} catch {
							repoUrl = repoPath; // fallback to local path
						}

						// Parse mounts/credentials for the sandbox container
						let poolMounts: string[] = [];
						try {
							const mountsRaw = projectConfigStore.get("sandbox_mounts") || "";
							poolMounts = mountsRaw ? validateSandboxMounts(JSON.parse(mountsRaw), "[sandbox]") : [];
						} catch (err) { console.warn(`[sandbox] Invalid sandbox_mounts JSON, ignoring: ${err}`); }

						let poolCredentials: Record<string, string> = {};
						try {
							const credsRaw = projectConfigStore.get("sandbox_credentials") || "";
							poolCredentials = credsRaw ? JSON.parse(credsRaw) : {};
						} catch (err) { console.warn(`[sandbox] Invalid sandbox_credentials JSON, ignoring: ${err}`); }

						// Ensure the restricted Docker network exists
						let sandboxNetwork: string | undefined;
						try {
							sandboxNetwork = await sessionManager.ensureSandboxNetwork();
						} catch (err) {
							console.error("[sandbox] Cannot create sandbox network — sandbox disabled:", err);
						}

						if (sandboxNetwork) {
							const defaultProjectId = projectContextManager.getDefaultProjectId();

							// Resolve GitHub token for git push inside container
							const githubTokenEnabled = projectConfigStore.get("sandbox_github_token") !== "false";
							let githubToken: string | undefined;
							if (githubTokenEnabled) {
								githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
							}

							sandboxManager = new SandboxManager();
							await sandboxManager.initForProject(defaultProjectId, {
								projectId: defaultProjectId,
								projectDir: config.defaultCwd,
								repoUrl,
								image: imageName,
								sandboxNetwork,
								sandboxMounts: poolMounts,
								sandboxCredentials: poolCredentials,
								githubToken,
							});
							console.log(`[sandbox] Initialized per-project sandbox for default project`);
						}
					} else {
						console.log("[sandbox] Not a git repo — sandbox disabled (worktrees require git)");
					}
				} catch (err) {
					console.error("[sandbox] Failed to initialize:", err);
					sandboxManager = null;
				}
			}
			sessionManager.setSandboxManager(sandboxManager);

			// Restore persisted sessions before accepting connections
			await sessionManager.restoreSessions();

			// NOTE: Orphaned worktree cleanup and non-interactive session cleanup
			// are no longer automatic on startup. Use the Settings → Maintenance UI
			// or the /api/maintenance/* endpoints to preview and clean up manually.

			sessionManager.startPurgeSchedule();

			// Initialize worktree pool for the default project's repo
			// (pre-creates worktrees in the background so new sessions start instantly)
			try {
				const defaultCtx = projectContextManager.getDefault();
				const defaultRepoPath = defaultCtx.project.rootPath;
				if (await isGitRepo(defaultRepoPath)) {
					const setupCmd = defaultCtx.projectConfigStore.get("worktree_setup_command") || undefined;
					const poolSize = parseInt(defaultCtx.projectConfigStore.get("worktree_pool_size") || "2", 10) || 2;
					sessionManager.initWorktreePool(defaultRepoPath, setupCmd, poolSize);
				}
			} catch { /* best-effort */ }

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
			await sessionManager.getWorktreePool()?.drain();
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
	projectContextManager: ProjectContextManager,
	personalityManager: PersonalityManager,
	bgProcessManager: BgProcessManager,
	staffManager: StaffManager,
	workflowManager: WorkflowManager,
	verificationHarness: VerificationHarness,
	preferencesStore: PreferencesStore,
	projectConfigStore: ProjectConfigStore,
	groupPolicyStore: ToolGroupPolicyStore,
	broadcastToGoal: (goalId: string, event: any) => void,
	broadcastToAll: (event: any) => void,
	sandboxManager: SandboxManager | null,
	projectRegistry: ProjectRegistry,
	sandboxScope?: SandboxScope,
	sandboxTokenStore?: SandboxTokenStore,
) {
	const json = (data: unknown, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
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

	/** Resolve per-project config store, falling back to the default. */
	function resolveProjectConfigStore(pid: string | null): ProjectConfigStore {
		if (pid && projectContextManager) {
			const ctx = projectContextManager.getOrCreate(pid);
			if (ctx) return ctx.projectConfigStore;
		}
		return projectConfigStore;
	}

	/** Get a GoalManager for the project that owns the given goal. Throws if not found. */
	function getGoalManagerForGoal(goalId: string): GoalManager {
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
		return ctx.goalManager;
	}

	/** Get a TaskManager for the project that owns the given goal. Throws if not found. */
	const taskManagerCache = new Map<string, TaskManager>();
	function getTaskManagerForGoal(goalId: string): TaskManager {
		const ctx = projectContextManager.getContextForGoal(goalId);
		if (!ctx) throw new Error(`Goal "${goalId}" not found in any project`);
		const projectId = ctx.project.id;
		let tm = taskManagerCache.get(projectId);
		if (!tm) {
			tm = new TaskManager(ctx.taskStore);
			taskManagerCache.set(projectId, tm);
		}
		return tm;
	}

	/** Get a TaskManager for a task by looking up which goal it belongs to. Throws if not found. */
	function getTaskManagerForTask(taskId: string): TaskManager {
		// Search all project contexts for the task
		for (const ctx of projectContextManager.all()) {
			const task = ctx.taskStore.get(taskId);
			if (task) return getTaskManagerForGoal(task.goalId);
		}
		throw new Error(`Task "${taskId}" not found in any project`);
	}

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

	// GET /api/system-prompt-context — read the project context section from system-prompt.md
	if (url.pathname === "/api/system-prompt-context" && req.method === "GET") {
		const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
		if (!fs.existsSync(systemPromptPath)) { json({ context: "" }); return; }
		try {
			const content = fs.readFileSync(systemPromptPath, "utf-8");
			// Extract everything after the last "# Project Context" heading, or return empty
			const marker = "# Project Context";
			const idx = content.lastIndexOf(marker);
			if (idx === -1) { json({ context: "" }); return; }
			const context = content.slice(idx + marker.length).trim();
			json({ context });
		} catch { json({ context: "" }); }
		return;
	}

	// PUT /api/system-prompt-context — append/replace the project context section in system-prompt.md
	if (url.pathname === "/api/system-prompt-context" && req.method === "PUT") {
		const body = await readBody(req);
		if (!body || typeof body.context !== "string") { json({ error: "Missing context" }, 400); return; }
		const systemPromptPath = path.join(bobbitConfigDir(), "system-prompt.md");
		try {
			let existing = "";
			if (fs.existsSync(systemPromptPath)) {
				existing = fs.readFileSync(systemPromptPath, "utf-8");
			}
			const marker = "# Project Context";
			const idx = existing.lastIndexOf(marker);
			const base = idx !== -1 ? existing.slice(0, idx).trimEnd() : existing.trimEnd();
			const newContent = base + "\n\n" + marker + "\n\n" + body.context.trim() + "\n";
			fs.mkdirSync(path.dirname(systemPromptPath), { recursive: true });
			fs.writeFileSync(systemPromptPath, newContent);
			json({ ok: true });
		} catch (err: any) {
			json({ error: err.message }, 500);
		}
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

	// GET /api/sandbox-pool
	if (url.pathname === "/api/sandbox-pool" && req.method === "GET") {
		if (sandboxManager) {
			const stats = sandboxManager.getStats();
			json({ ...stats, type: "sandbox" });
		} else {
			json({ enabled: false });
		}
		return;
	}

	// GET /api/sandbox-status
	if (url.pathname === "/api/sandbox-status" && req.method === "GET") {
		const sandboxConfig = projectConfigStore.get("sandbox") || "none";
		const imageName = projectConfigStore.get("sandbox_image") || "bobbit-agent";
		const configured = sandboxConfig === "docker";
		const status = await checkDockerAvailability(configured ? imageName : undefined);
		json({ ...status, configured });
		return;
	}

	// POST /api/sandbox-image/build
	if (url.pathname === "/api/sandbox-image/build" && req.method === "POST") {
		const imageName = projectConfigStore.get("sandbox_image") || "bobbit-agent";
		if (!fs.existsSync(path.join(config.defaultCwd, "docker", "Dockerfile"))) {
			json({ error: "Dockerfile not found at docker/Dockerfile" }, 404);
			return;
		}
		if (isBuildingImage()) {
			json({ error: "Build already in progress" }, 409);
			return;
		}
		const result = await buildSandboxImage(imageName, config.defaultCwd);
		if (result.success) {
			json({ success: true });
		} else {
			json({ success: false, error: result.error }, 500);
		}
		return;
	}

	// ── Project Detection & Browse ────────────────────────────────────

	// POST /api/projects/detect
	if (url.pathname === "/api/projects/detect" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || typeof body.path !== "string") {
			json({ error: "Missing path" }, 400);
			return;
		}
		const dirPath = path.resolve(body.path);
		const exists = fs.existsSync(dirPath);
		let hasBobbit = false;
		let isEmpty = true;
		let hasPackageJson = false;
		let hasCargoToml = false;
		let hasGoMod = false;
		let name = path.basename(dirPath);

		if (exists) {
			try {
				const stat = fs.statSync(dirPath);
				if (stat.isDirectory()) {
					const entries = fs.readdirSync(dirPath);
					isEmpty = entries.length === 0;
					hasBobbit = entries.includes(".bobbit");
					hasPackageJson = entries.includes("package.json");
					hasCargoToml = entries.includes("Cargo.toml");
					hasGoMod = entries.includes("go.mod");

					// Try to read name from package.json
					if (hasPackageJson) {
						try {
							const pkg = JSON.parse(fs.readFileSync(path.join(dirPath, "package.json"), "utf-8"));
							if (typeof pkg.name === "string" && pkg.name) {
								name = pkg.name;
							}
						} catch {
							// Ignore parse errors — fall back to directory basename
						}
					}
				} else {
					// Path exists but is not a directory
					json({ error: "Path is not a directory" }, 400);
					return;
				}
			} catch {
				// stat failed — treat as non-existent
				json({ exists: false, hasBobbit: false, isEmpty: true, hasPackageJson: false, hasCargoToml: false, hasGoMod: false, name });
				return;
			}
		}

		json({ exists, hasBobbit, isEmpty, hasPackageJson, hasCargoToml, hasGoMod, name });
		return;
	}

	// GET /api/browse-directory
	if (url.pathname === "/api/browse-directory" && req.method === "GET") {
		const rawPath = url.searchParams.get("path");
		const dirPath = rawPath ? path.resolve(rawPath) : config.defaultCwd;

		if (!fs.existsSync(dirPath)) {
			json({ error: "Directory not found" }, 404);
			return;
		}

		try {
			const stat = fs.statSync(dirPath);
			if (!stat.isDirectory()) {
				json({ error: "Path is not a directory" }, 400);
				return;
			}
		} catch {
			json({ error: "Cannot access path" }, 400);
			return;
		}

		const entries: Array<{ name: string; path: string }> = [];
		try {
			const items = fs.readdirSync(dirPath);
			for (const item of items) {
				// Skip hidden directories and node_modules
				if (item.startsWith(".") || item === "node_modules") continue;
				const fullPath = path.join(dirPath, item);
				try {
					const stat = fs.lstatSync(fullPath);
					if (stat.isDirectory() && !stat.isSymbolicLink()) {
						entries.push({ name: item, path: fullPath });
					}
				} catch {
					// Skip entries we can't stat
				}
			}
		} catch {
			json({ error: "Cannot read directory" }, 500);
			return;
		}

		entries.sort((a, b) => a.name.localeCompare(b.name));

		const parsed = path.parse(dirPath);
		const parent = parsed.root === dirPath ? null : path.dirname(dirPath);

		json({ current: dirPath, parent, entries });
		return;
	}

	// ── Project CRUD ──────────────────────────────────────────────────

	// GET /api/projects
	if (url.pathname === "/api/projects" && req.method === "GET") {
		json(projectRegistry.list());
		return;
	}

	// POST /api/projects
	if (url.pathname === "/api/projects" && req.method === "POST") {
		const body = await readBody(req);
		if (typeof body?.name !== "string" || typeof body?.rootPath !== "string") {
			json({ error: "Missing name or rootPath" }, 400);
			return;
		}
		try {
			const color = typeof body.color === "string" ? body.color : undefined;
			const palette = typeof body.palette === "string" ? body.palette : undefined;
			const colorLight = typeof body.colorLight === "string" ? body.colorLight : undefined;
			const colorDark = typeof body.colorDark === "string" ? body.colorDark : undefined;
			const project = projectRegistry.register(body.name, body.rootPath, { color, palette, colorLight, colorDark });
			// Initialize project context for the new project
			const newCtx = projectContextManager.getOrCreate(project.id);
			if (newCtx) {
				newCtx.gateStore.onStatusChange = () => {
					newCtx.goalStore.bumpGeneration();
				};
			}
			json(project, 201);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// GET /api/projects/:id
	const projectGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
	if (projectGetMatch && req.method === "GET") {
		const project = projectRegistry.get(projectGetMatch[1]);
		if (!project) { json({ error: "Project not found" }, 404); return; }
		json(project);
		return;
	}

	// PUT /api/projects/:id
	if (projectGetMatch && req.method === "PUT") {
		const body = await readBody(req);
		const updates: { name?: string; color?: string; rootPath?: string; palette?: string; colorLight?: string; colorDark?: string } = {};
		if (typeof body?.name === "string") updates.name = body.name;
		if (typeof body?.color === "string") updates.color = body.color;
		if (typeof body?.rootPath === "string") updates.rootPath = body.rootPath;
		if (typeof body?.palette === "string" || body?.palette === null || body?.palette === "") updates.palette = body.palette ?? "";
		if (typeof body?.colorLight === "string") updates.colorLight = body.colorLight;
		if (typeof body?.colorDark === "string") updates.colorDark = body.colorDark;
		try {
			const updated = projectRegistry.update(projectGetMatch[1], updates);
			json(updated);
		} catch (err: any) {
			json({ error: err.message }, 400);
		}
		return;
	}

	// DELETE /api/projects/:id
	if (projectGetMatch && req.method === "DELETE") {
		const projectId = projectGetMatch[1];
		const project = projectRegistry.get(projectId);
		if (project && project.rootPath === getProjectRoot()) {
			json({ error: "Cannot delete the default project" }, 400);
			return;
		}
		try {
			// Terminate all live sessions belonging to the removed project
			const liveSessions = sessionManager.listSessions().filter(s => s.projectId === projectId);
			for (const s of liveSessions) {
				try { await sessionManager.terminateSession(s.id); } catch {}
			}
			projectContextManager.remove(projectId);
			projectRegistry.remove(projectId);
			json({ ok: true });
		} catch (err: any) {
			json({ error: err.message }, 400);
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
			json(ctx.projectConfigStore.getAll());
			return;
		}
		if (req.method === "GET" && suffix === "defaults") {
			json(ctx.projectConfigStore.getDefaults());
			return;
		}
		if (req.method === "GET" && suffix === "resolved") {
			const defaults = ctx.projectConfigStore.getDefaults();
			const result: Record<string, { value: string; source: string }> = {};
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
			json(result);
			return;
		}
		if (req.method === "PUT" && !suffix) {
			const body = await readBody(req);
			if (!body || typeof body !== "object") { json({ error: "Missing body" }, 400); return; }
			for (const [key, value] of Object.entries(body)) {
				if (key.includes(".")) {
					json({ error: `Config key "${key}" must not contain dots` }, 400);
					return;
				}
				if (value === null || value === "") {
					ctx.projectConfigStore.remove(key);
				} else if (typeof value === "string") {
					ctx.projectConfigStore.set(key, value);
				}
			}
			json({ ok: true });
			return;
		}
	}

	// GET /api/projects/:id/qa-testing-config
	const evConfigMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/qa-testing-config$/);
	if (evConfigMatch && req.method === "GET") {
		const ctx = projectContextManager.getOrCreate(evConfigMatch[1]);
		if (!ctx) { json({ error: "Project not found" }, 404); return; }
		const config = ctx.projectConfigStore.getQaTestingConfig();
		json({ config });
		return;
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
			const results = projectContextManager.searchAll(q, { type, limit, offset, projectId, projectNames });
			json(results);
		} catch (err) {
			json({ error: `Search failed: ${err}` }, 500);
		}
		return;
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
				json({ generation: currentGen, sessions: [...sessions, ...sliced], total, hasMore, nextCursor });
			} else {
				// Backward compatible: return all archived sessions
				json({ generation: currentGen, sessions: [...sessions, ...filteredArchived] });
			}
		} else {
			json({ generation: currentGen, sessions });
		}
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
			json({ error: err.message }, 500);
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
					reattemptGoalId: archived.reattemptGoalId,
					archived: true,
					archivedAt: archived.archivedAt,
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
			taskId: session.taskId,
			staffId: session.staffId,
			colorIndex: colorStore.get(session.id),
			preview: session.preview,
			personalities: session.personalities,
			reattemptGoalId: sessionPs?.reattemptGoalId,
			projectId: sessionPs?.projectId || session.projectId,
		});
		return;
	}

	// POST /api/sessions
	if (url.pathname === "/api/sessions" && req.method === "POST") {
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
		let createOpts: { rolePrompt?: string; roleName?: string; role?: string; accessory?: string; personalities?: Array<{ label: string; promptFragment: string }>; personalityNames?: string[] } | undefined;

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
		} else if (createOpts?.roleName) {
			// Use role's default personalities if no explicit personalities provided
			const role = roleManager.getRole(createOpts.roleName);
			if (role?.defaultPersonalities && role.defaultPersonalities.length > 0) {
				personalityNames = role.defaultPersonalities;
			}
		}

		if (personalityNames && personalityNames.length > 0) {
			const resolved = personalityManager.resolvePersonalities(personalityNames);
			createOpts = { ...createOpts, personalities: resolved, personalityNames };
		}

		// ── Worktree support ──
		// Non-assistant, non-goal sessions get a worktree by default unless explicitly opted out.
		// Goal sessions have their own worktree logic via goalManager.setupWorktreeAndStartTeam().
		let worktreeOpts: { repoPath: string } | undefined;
		const wantWorktree = body?.worktree !== undefined ? !!body.worktree : (!assistantType && !goalId);
		if (wantWorktree && !assistantType) {
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

		// Auto-detect projectId from cwd if not explicitly provided
		let resolvedProjectId = body?.projectId as string | undefined;

		// If re-attempting a goal, inherit cwd and projectId from the original goal
		if (reattemptGoalId && !body?.cwd) {
			const origGoal = getGoalAcrossProjects(reattemptGoalId);
			if (origGoal) {
				cwd = origGoal.cwd || cwd;
				if (!resolvedProjectId && origGoal.projectId) resolvedProjectId = origGoal.projectId;
			}
		}

		if (!resolvedProjectId && cwd) {
			const matched = projectRegistry.findByCwd(cwd);
			if (matched) resolvedProjectId = matched.id;
		}
		// Default to the server's own project when no project could be resolved from CWD or explicit param.
		// This is the correct API contract: sessions created without a project context belong to the default project.
		if (!resolvedProjectId) resolvedProjectId = projectContextManager.getDefaultProjectId();

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

			// Store projectId on the session if resolved (explicit or auto-detected)
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
				personalities: session.personalities,
				reattemptGoalId,
			}, 201);
		} catch (err) {
			json({ error: String(err) }, 500);
		}
		return;
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
			json({ goals: page, total, hasMore, nextCursor });
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
			// Resolve target project context for goal creation (explicit > cwd-match > default)
			let targetProjectId = (body.projectId && typeof body.projectId === "string") ? body.projectId : undefined;
			if (!targetProjectId && cwd) {
				const matched = projectRegistry.findByCwd(cwd);
				if (matched) targetProjectId = matched.id;
			}
			// Default to the server's own project when no project could be resolved.
			// This is the correct API contract: goals created without explicit project belong to the default project.
			if (!targetProjectId) targetProjectId = projectContextManager.getDefaultProjectId();
			const targetCtx = projectContextManager.getOrCreate(targetProjectId);
			if (!targetCtx) {
				json({ error: "Invalid project" }, 400);
				return;
			}
			const targetGoalManager = targetCtx.goalManager;
			const goal = await targetGoalManager.createGoal(title, cwd, {
				spec,
				workflowId,
				workflowStore: workflowManager.store,
				sandboxed,
				enabledOptionalSteps,
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
			json({ error: String(err) }, 400);
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
				prUrl: body.prUrl,
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
				detail_docs: body.detail_docs,
				grantPolicy: body.grantPolicy,
			});
			if (!ok) { json({ error: "Tool not found" }, 404); return; }
			json({ ok: true });
			return;
		}
	}

	// ── Tool group policies ──

	// GET /api/tool-group-policies
	if (url.pathname === "/api/tool-group-policies" && req.method === "GET") {
		json(groupPolicyStore.getAll());
		return;
	}

	// PUT /api/tool-group-policies/:group
	const groupPolicyMatch = url.pathname.match(/^\/api\/tool-group-policies\/(.+)$/);
	if (groupPolicyMatch && req.method === "PUT") {
		const group = decodeURIComponent(groupPolicyMatch[1]);
		const body = await readBody(req);
		if (!body) { json({ error: "Missing body" }, 400); return; }
		const validPolicies = ['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask'];
		if (body.policy && !validPolicies.includes(body.policy)) {
			json({ error: `Invalid policy. Must be one of: allow, ask, never` }, 400);
			return;
		}
		groupPolicyStore.setGroupPolicy(group, body.policy || null);
		json({ ok: true });
		return;
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

	/** Return preferences with sensitive keys (providerKey.*) filtered out. */
	function getSafePreferences(): Record<string, unknown> {
		const all = preferencesStore.getAll();
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(all)) {
			if (!key.startsWith("providerKey.")) {
				filtered[key] = value;
			}
		}
		return filtered;
	}

	/** Broadcast preferences_changed with sensitive keys filtered out. */
	function broadcastPreferencesChanged(): void {
		broadcastToAll({ type: "preferences_changed", preferences: getSafePreferences() });
	}

	// GET /api/preferences — return all preferences (filter sensitive keys)
	if (url.pathname === "/api/preferences" && req.method === "GET") {
		json(getSafePreferences());
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
		broadcastPreferencesChanged();
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

	// GET /api/config-directories — return all scanned config directories
	if (url.pathname === "/api/config-directories" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId");
		const resolvedStore = resolveProjectConfigStore(projectId);
		const resolvedCwd = projectId && projectContextManager
			? projectContextManager.getOrCreate(projectId)?.project.rootPath ?? config.defaultCwd
			: config.defaultCwd;
		json(getAllConfigDirectories(resolvedCwd, resolvedStore));
		return;
	}

	// DELETE /api/config-directories — remove a built-in directory from scanning
	if (url.pathname === "/api/config-directories" && req.method === "DELETE") {
		const body = await readBody(req);
		if (!body || typeof body !== "object" || typeof (body as any).path !== "string") {
			json({ error: "Missing 'path' in body" }, 400);
			return;
		}
		const projectId = (body as any).projectId as string | null ?? null;
		const resolvedStore = resolveProjectConfigStore(projectId);
		removeBuiltinDirectory(resolvedStore, (body as any).path);
		json({ ok: true });
		return;
	}

	// POST /api/config-directories/reset — reset all config dirs to defaults
	if (url.pathname === "/api/config-directories/reset" && req.method === "POST") {
		const body = await readBody(req);
		const projectId = body && typeof body === "object" ? ((body as any).projectId as string | null ?? null) : null;
		const resolvedStore = resolveProjectConfigStore(projectId);
		resetConfigDirectories(resolvedStore);
		json({ ok: true });
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

	// ── Unified Model Registry ──

	// GET /api/models — unified model list from all sources
	if (url.pathname === "/api/models" && req.method === "GET") {
		try {
			const models = await getAvailableModels(preferencesStore);
			json(models);
		} catch (err: any) {
			json({ error: `Failed to load models: ${err.message}` }, 500);
		}
		return;
	}

	// ── Custom Providers ──

	// GET /api/custom-providers — list all custom provider configs
	if (url.pathname === "/api/custom-providers" && req.method === "GET") {
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		json(configs);
		return;
	}

	// POST /api/custom-providers/test — discover models without persisting
	if (url.pathname === "/api/custom-providers/test" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.type || !body.baseUrl) {
			json({ error: "Missing required fields: type, baseUrl" }, 400);
			return;
		}
		const config: CustomProviderConfig = {
			id: body.id || "test-" + Date.now(),
			name: body.name || body.type,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
		};
		try {
			const models = await discoverModelsForConfig(config);
			json({ models });
		} catch (err: any) {
			json({ error: err?.message || "Discovery failed" }, 500);
		}
		return;
	}

	// POST /api/custom-providers — add or update a custom provider config
	if (url.pathname === "/api/custom-providers" && req.method === "POST") {
		const body = await readBody(req);
		if (!body || !body.id || !body.type || !body.baseUrl) {
			json({ error: "Missing required fields: id, type, baseUrl" }, 400);
			return;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const existing = configs.findIndex((c: CustomProviderConfig) => c.id === body.id);
		const config: CustomProviderConfig = {
			id: body.id,
			name: body.name || body.id,
			type: body.type,
			baseUrl: body.baseUrl,
			...(body.apiKey ? { apiKey: body.apiKey } : {}),
			...(body.models ? { models: body.models } : {}),
		};
		if (existing >= 0) {
			configs[existing] = config;
		} else {
			configs.push(config);
		}
		preferencesStore.set("customProviders", configs);
		json({ ok: true, config });
		return;
	}

	// DELETE /api/custom-providers/:id — remove a custom provider config
	if (url.pathname.startsWith("/api/custom-providers/") && req.method === "DELETE") {
		const providerId = decodeURIComponent(url.pathname.slice("/api/custom-providers/".length));
		if (!providerId) {
			json({ error: "Missing provider id" }, 400);
			return;
		}
		const configs = (preferencesStore.get("customProviders") as CustomProviderConfig[] | undefined) || [];
		const filtered = configs.filter((c: CustomProviderConfig) => c.id !== providerId);
		preferencesStore.set("customProviders", filtered);
		json({ ok: true });
		return;
	}

	// ── Provider Keys ──

	// GET /api/provider-keys — list providers that have keys set (no key values)
	if (url.pathname === "/api/provider-keys" && req.method === "GET") {
		const all = preferencesStore.getAll();
		const providers = Object.keys(all)
			.filter(k => k.startsWith("providerKey.") && all[k])
			.map(k => k.slice("providerKey.".length));
		json({ providers });
		return;
	}

	// POST /api/provider-keys/:provider — store a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "POST") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json({ error: "Missing provider name" }, 400);
			return;
		}
		const body = await readBody(req);
		if (!body?.key || typeof body.key !== "string") {
			json({ error: "Missing 'key' field" }, 400);
			return;
		}
		preferencesStore.set(`providerKey.${provider}`, body.key);
		json({ ok: true });
		return;
	}

	// DELETE /api/provider-keys/:provider — remove a provider API key
	if (url.pathname.startsWith("/api/provider-keys/") && req.method === "DELETE") {
		const provider = decodeURIComponent(url.pathname.slice("/api/provider-keys/".length));
		if (!provider) {
			json({ error: "Missing provider name" }, 400);
			return;
		}
		preferencesStore.remove(`providerKey.${provider}`);
		json({ ok: true });
		return;
	}

	// ── AI Gateway ──

	// GET /api/aigw/status — check if aigw is configured
	if (url.pathname === "/api/aigw/status" && req.method === "GET") {
		const aigwUrl = getAigwUrl(preferencesStore);
		if (!aigwUrl) {
			json({ configured: false });
		} else {
			// Discover fresh models instead of reading from preferences cache
			try {
				const models = await discoverAigwModels(aigwUrl);
				json({ configured: true, url: aigwUrl, models });
			} catch {
				json({ configured: true, url: aigwUrl, models: [] });
			}
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
			broadcastPreferencesChanged();
			json({ ok: true, models });
		} catch (err: any) {
			json({ error: `Failed to configure AI Gateway: ${err.message}` }, 502);
		}
		return;
	}

	// DELETE /api/aigw/configure — remove aigw config
	if (url.pathname === "/api/aigw/configure" && req.method === "DELETE") {
		removeAigw(preferencesStore);
		broadcastPreferencesChanged();
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
			broadcastPreferencesChanged();
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
				accessory: body?.accessory,
				toolPolicies: body?.toolPolicies,
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
				accessory: body.accessory,
				toolPolicies: body.toolPolicies !== undefined ? (() => {
					// Validate toolPolicies values
					const validPolicies = new Set(['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask']);
					const cleaned: Record<string, import("./agent/role-store.js").GrantPolicy> = {};
					if (body.toolPolicies && typeof body.toolPolicies === 'object') {
						for (const [k, v] of Object.entries(body.toolPolicies)) {
							if (typeof v === 'string' && validPolicies.has(v)) cleaned[k] = v as import("./agent/role-store.js").GrantPolicy;
						}
					}
					return cleaned;
				})() : undefined,
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
		const tasks = getTaskManagerForGoal(goalTasksMatch[1]).getTasksForGoal(goalTasksMatch[1]);
		json({ tasks });
		return;
	}

	// POST /api/goals/:goalId/tasks — create a task
	if (goalTasksMatch && req.method === "POST") {
		const goalId = goalTasksMatch[1];
		const goal = getGoalAcrossProjects(goalId);
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
			const task = getTaskManagerForGoal(goalId).createTask(goalId, title, type, {
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
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) { json({ error: "Goal not found" }, 404); return; }
		const gateCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateCtx.gateStore;
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
		const gateDetailCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateDetailCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateDetailCtx.gateStore;
		const gate = gateStore.getGate(goalId, gateId);
		if (!gate) { json({ error: "Gate not found" }, 404); return; }
		const goal = getGoalAcrossProjects(goalId);
		const def = goal?.workflow?.gates.find(wg => wg.id === gateId);
		json({ ...gate, name: def?.name, dependsOn: def?.dependsOn, content: def?.content, injectDownstream: def?.injectDownstream });
		return;
	}

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
				json({ error: "Verification already in progress for this commit", existingSignalId: runningDup.signalId }, 409);
				return;
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
		const gateSignalsCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateSignalsCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateSignalsCtx.gateStore;
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
		const gateContentCtx = projectContextManager.getContextForGoal(goalId);
		if (!gateContentCtx) { json({ error: "Goal not found in any project" }, 404); return; }
		const gateStore = gateContentCtx.gateStore;
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
		const goal = getGoalAcrossProjects(goalId);
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
			try {
				const task = getTaskManagerForTask(id).getTask(id);
				if (!task) { json({ error: "Task not found" }, 404); return; }
				json(task);
			} catch {
				json({ error: "Task not found" }, 404);
			}
			return;
		}

		// PUT /api/tasks/:id
		if (req.method === "PUT") {
			const body = await readBody(req);
			if (!body) { json({ error: "Missing body" }, 400); return; }
			try {
				const tm = getTaskManagerForTask(id);
				const task = tm.getTask(id);
				const prevState = task?.state;
				const ok = tm.updateTask(id, {
					title: body.title,
					spec: body.spec,
					state: body.state,
					assignedSessionId: body.assignedSessionId,
					dependsOn: body.dependsOn,
					workflowGateId: typeof body.workflowGateId === "string" ? body.workflowGateId : undefined,
					inputGateIds: Array.isArray(body.inputGateIds) ? body.inputGateIds as string[] : undefined,
					headSha: typeof body.headSha === "string" ? body.headSha : undefined,
					baseSha: typeof body.baseSha === "string" ? body.baseSha : undefined,
					branch: typeof body.branch === "string" ? body.branch : undefined,
					resultSummary: typeof body.resultSummary === "string" ? body.resultSummary : undefined,
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
			try {
				const ok = getTaskManagerForTask(id).deleteTask(id);
				if (!ok) { json({ error: "Task not found" }, 404); return; }
				json({ ok: true });
			} catch {
				json({ error: "Task not found" }, 404);
			}
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
			const taskId = taskAssignMatch[1];
			const tm = getTaskManagerForTask(taskId);
			const ok = tm.assignTask(taskId, sessionId);
			if (!ok) { json({ error: "Task not found" }, 400); return; }

			// Auto-populate baseSha and branch from TeamAgent record
			const agent = teamManager.findAgentBySessionId(sessionId);
			if (agent) {
				const task = tm.getTask(taskId);
				if (task) {
					const fields: Record<string, string> = {};
					if (agent.baseSha && !task.baseSha) fields.baseSha = agent.baseSha;
					if (agent.branch && !task.branch) fields.branch = agent.branch;
					if (Object.keys(fields).length) {
						tm.updateTask(taskId, fields);
					}
				}
			}

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
			const tm = getTaskManagerForTask(taskId);
			const task = tm.getTask(taskId);
			const ok = tm.transitionTask(taskId, state as TaskState);
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
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
		}
		try {
			const result = await batchGitStatus(cwd, cid);
			if (!result) { json({ error: "Not a git repository" }, 400); return; }
			json(result);
		} catch (err) {
			json({ error: String(err) }, 500);
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
		try {
			const diff = await getGitDiff(cwd, file, cid);
			json({ diff });
		} catch (err: any) {
			if (err.message === "INVALID_PATH") { json({ error: "Invalid file path" }, 400); return; }
			if (err.message === "NO_DIFF") { json({ error: "No diff found" }, 404); return; }
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
		_prCache.delete(cwd);
		if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
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
		try {
			await execAsync(`gh pr merge --${method}${goalAdminFlag}`, { cwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
			if (goal.branch) _prCache.delete(`${cwd}::${goal.branch}`);
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
			const goal = getGoalAcrossProjects(goalId);
			const goalGateCtx = projectContextManager.getContextForGoal(goalId);
			const goalGateStore = goalGateCtx?.gateStore;
			if (goal?.workflow && goalGateStore) {
				const wfGate = goal.workflow.gates.find((g: any) => g.id === wfGateId);
				if (wfGate?.dependsOn?.length) {
					const gateStates = goalGateStore.getGatesForGoal(goalId);
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
		const cid = session.sandboxed ? session.containerId : undefined;

		// Optional: run git fetch first when ?fetch=true is passed
		if (url.searchParams.get('fetch') === 'true') {
			try { await execGit('git fetch --quiet', cwd, 15000, cid); } catch { /* best-effort */ }
		}

		try {
			const result = await batchGitStatus(cwd, cid);
			if (!result) { json({ error: "Not a git repository" }, 400); return; }

			json(result);

			// Auto-push: for feature branches with unpushed commits, push in background
			if (!result.isOnPrimary && result.ahead > 0 && result.hasUpstream) {
				execAsync('git push', { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
			} else if (!result.isOnPrimary && !result.hasUpstream && result.branch && /^session\//.test(result.branch)) {
				// Session branches without upstream: set up tracking and push
				execAsync(`git push -u origin ${result.branch}`, { cwd, encoding: "utf-8", timeout: 30000 }).catch(() => {});
			}
		} catch (err) {
			json({ error: String(err) }, 500);
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
			json({ error: String(err) }, 500);
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
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-push — push local commits to remote
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-push')) {
		const id = url.pathname.split('/')[3];
		const session = sessionManager.getSession(id);
		if (!session) { json({ error: "Session not found" }, 404); return; }
		const cwd = session.cwd;
		const cid = session.sandboxed ? session.containerId : undefined;
		if (!cid && !fs.existsSync(cwd)) { json({ error: "Working directory not found" }, 404); return; }
		try {
			const output = await execGit('git push', cwd, 30000, cid);
			json({ ok: true, output });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			json({ error: msg }, 500);
		}
		return;
	}

	// POST /api/sessions/:id/git-squash-push — squash all branch commits and push directly to master
	if (req.method === 'POST' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/git-squash-push')) {
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
					json({ ok: true, output: `Rebased and reset ${aheadAfter} orphaned commit(s) from squash merge` });
					return;
				}
			}

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
		const sessMergeBranch = session.goalId ? getGoalAcrossProjects(session.goalId)?.branch : undefined;
		try {
			// PR merge uses `gh` CLI — for sandboxed sessions, run on host worktree
			const mergeCwd = cid ? (session.worktreePath || cwd) : cwd;
			await execAsync(`gh pr merge --${method}${sessAdminFlag}`, { cwd: mergeCwd, encoding: "utf-8", timeout: 30000 });
			_prCache.delete(cwd);
			if (sessMergeBranch) _prCache.delete(`${cwd}::${sessMergeBranch}`);
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
		const projectId = url.searchParams.get("projectId");
		const resolvedStore = resolveProjectConfigStore(projectId);
		const skills = discoverSlashSkills(cwd, resolvedStore);
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, argumentHint: s.argumentHint, source: s.source })) });
		return;
	}

	// GET /api/slash-skills/details — full slash skill details including content and file paths
	if (url.pathname === "/api/slash-skills/details" && req.method === "GET") {
		const cwd = url.searchParams.get("cwd") || process.cwd();
		const projectId = url.searchParams.get("projectId");
		const resolvedStore = resolveProjectConfigStore(projectId);
		const skills = discoverSlashSkills(cwd, resolvedStore);
		const directories = getSkillDirectories(cwd, resolvedStore);
		json({ skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source, filePath: s.filePath, content: s.content })), directories });
		return;
	}

	// ── Workflow endpoints ──────────────────────────────────────────

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
		const allGoals = projectContextManager.getAllLiveGoals();
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

	// GET /api/sessions/:id/cost/breakdown — cost breakdown including delegates
	const sessionCostBreakdownMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost\/breakdown$/);
	if (sessionCostBreakdownMatch && req.method === "GET") {
		const sessionId = sessionCostBreakdownMatch[1];
		const live = sessionManager.getSession(sessionId);
		const sessionForCost = live ?? sessionManager.getPersistedSession(sessionId);
		if (!sessionForCost?.projectId) {
			json({ error: "Session not found or has no project" }, 404);
			return;
		}
		const costTracker = sessionManager.getCostTracker(sessionForCost.projectId);
		const allCosts = costTracker.getAllCosts();
		const sessionCost = allCosts.get(sessionId);
		if (!sessionCost) {
			json({ error: "No cost data" }, 404);
			return;
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

		json({
			session: { sessionId, ...sessionCost },
			delegates,
		});
		return;
	}

	// GET /api/sessions/:id/cost — cost for a single session
	const sessionCostMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cost$/);
	if (sessionCostMatch && req.method === "GET") {
		const id = sessionCostMatch[1];
		const liveSession = sessionManager.getSession(id);
		const sessionForCost = liveSession ?? sessionManager.getPersistedSession(id);
		if (!sessionForCost?.projectId) {
			json({ error: "Session not found or has no project" }, 404);
			return;
		}
		const cost = sessionManager.getCostTracker(sessionForCost.projectId).getSessionCost(id);
		if (!cost) {
			json({ error: "No cost data for this session" }, 404);
			return;
		}
		json(cost);
		return;
	}

	// GET /api/goals/:goalId/cost/breakdown — per-session cost breakdown for a goal
	const goalCostBreakdownMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost\/breakdown$/);
	if (goalCostBreakdownMatch && req.method === "GET") {
		const goalId = goalCostBreakdownMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		if (!goal.projectId) {
			json({ aggregate: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 }, sessions: [] });
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const costTracker = sessionManager.getCostTracker(goal.projectId);
		const allCosts = costTracker.getAllCosts();

		// Build per-session breakdown with metadata
		const sessions: any[] = [];
		for (const sid of sessionIds) {
			const cost = allCosts.get(sid);
			if (!cost || cost.totalCost === 0) continue;

			// Get session metadata from live sessions or store
			const live = sessionManager.listSessions().find(s => s.id === sid);
			const archived = !live ? sessionManager.listArchivedSessions().find(s => s.id === sid) : null;
			const meta = live || archived;

			sessions.push({
				sessionId: sid,
				title: (meta as any)?.title || sid.slice(0, 8),
				role: (meta as any)?.role || null,
				delegateOf: (meta as any)?.delegateOf || null,
				assistantType: (meta as any)?.assistantType || null,
				taskId: (meta as any)?.taskId || null,
				...cost,
			});
		}

		// Sort by cost descending
		sessions.sort((a, b) => b.totalCost - a.totalCost);

		// Compute aggregate
		const aggregate = costTracker.getGoalCost(goalId, sessionIds);

		json({ aggregate, sessions });
		return;
	}

	// GET /api/goals/:goalId/cost — aggregate cost across all sessions linked to a goal
	const goalCostMatch = url.pathname.match(/^\/api\/goals\/([^/]+)\/cost$/);
	if (goalCostMatch && req.method === "GET") {
		const goalId = goalCostMatch[1];
		const goal = getGoalAcrossProjects(goalId);
		if (!goal) {
			json({ error: "Goal not found" }, 404);
			return;
		}
		if (!goal.projectId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const sessionIds = sessionManager.getAllSessionIdsForGoal(goalId);
		const cost = sessionManager.getCostTracker(goal.projectId).getGoalCost(goalId, sessionIds);
		json(cost);
		return;
	}

	// GET /api/tasks/:id/cost — cost for the session(s) assigned to a task
	const taskCostMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cost$/);
	if (taskCostMatch && req.method === "GET") {
		const taskId = taskCostMatch[1];
		const task = getTaskManagerForTask(taskId).getTask(taskId);
		if (!task) {
			json({ error: "Task not found" }, 404);
			return;
		}
		if (!task.assignedSessionId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const taskSessionLive = sessionManager.getSession(task.assignedSessionId);
		const taskSession = taskSessionLive ?? sessionManager.getPersistedSession(task.assignedSessionId);
		if (!taskSession?.projectId) {
			json({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
			return;
		}
		const cost = sessionManager.getCostTracker(taskSession.projectId).getSessionCost(task.assignedSessionId);
		json(cost ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0 });
		return;
	}

	// GET /api/preview?sessionId=xxx — get preview HTML for a session
	const VALID_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
	if (url.pathname === "/api/preview" && req.method === "GET") {
		const sessionId = url.searchParams.get("sessionId");
		if (sessionId && !VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
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
		if (sessionId && !VALID_SESSION_ID.test(sessionId)) {
			json({ error: "Invalid sessionId" }, 400);
			return;
		}
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
		const result = await bgProcessManager.waitForExit(sessionId, processId, timeout * 1000);
		if (!result) { json({ error: "Process not found" }, 404); return; }
		json(result);
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
		const parts = sessionManager.getPromptParts(id);
		if (!parts) { json({ error: "Session not found or no prompt data" }, 404); return; }

		// Ensure tool docs are populated (they may have been injected at assemblePrompt time,
		// but re-inject if missing to handle edge cases)
		if (!parts.toolDocs && toolManager) {
			parts.toolDocs = toolManager.getToolDocsForPrompt(parts.allowedTools);
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

	// ── Staff endpoints ────────────────────────────────────────────

	// GET /api/staff
	if (url.pathname === "/api/staff" && req.method === "GET") {
		const projectId = url.searchParams.get("projectId") || undefined;
		json({ staff: staffManager.listStaff(projectId) });
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
		const projectId = (typeof body.projectId === "string") ? body.projectId : projectContextManager.getDefaultProjectId();
		try {
			const staff = await staffManager.createStaff(
				body.name,
				body.description || "",
				body.systemPrompt,
				cwd,
				sessionManager,
				{ triggers: body.triggers, roleId: body.roleId, projectId },
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

	// GET /api/mcp-servers
	if (url.pathname === "/api/mcp-servers" && req.method === "GET") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json([]);
			return;
		}
		const statuses = mcpManager.getServerStatuses();
		const toolInfos = mcpManager.getToolInfos();
		const result = statuses.map(s => ({
			...s,
			tools: toolInfos.filter(t => t.serverName === s.name).map(t => ({ name: t.name, description: t.description })),
		}));
		json(result);
		return;
	}

	// POST /api/mcp-servers/:name/restart
	const mcpRestartMatch = url.pathname.match(/^\/api\/mcp-servers\/([^/]+)\/restart$/);
	if (mcpRestartMatch && req.method === "POST") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json({ error: "MCP not initialized" }, 500);
			return;
		}
		const serverName = decodeURIComponent(mcpRestartMatch[1]);
		let statuses = mcpManager.getServerStatuses();
		let existing = statuses.find(s => s.name === serverName);
		if (!existing || !existing.config) {
			// Re-discover servers in case config was added after startup
			const discovered = mcpManager.discoverServers();
			if (!discovered[serverName]) {
				json({ error: `MCP server "${serverName}" not found` }, 404);
				return;
			}
			// Connect the newly discovered server
			await mcpManager.connectServer(serverName, discovered[serverName]);
		} else {
			await mcpManager.disconnectServer(serverName);
			// Re-discover to pick up any config changes from disk
			const refreshed = mcpManager.discoverServers();
			const config = refreshed[serverName] || existing.config;
			await mcpManager.connectServer(serverName, config);
		}
		// Re-register MCP tools with ToolManager
		if (toolManager) {
			toolManager.removeExternalTools("mcp__");
			const infos = mcpManager.getToolInfos();
			toolManager.registerExternalTools(infos.map(info => ({
				name: info.name,
				description: info.description,
				summary: info.description,
				group: info.group,
				docs: info.docs,
				provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
			})));
		}
		const updated = mcpManager.getServerStatuses().find(s => s.name === serverName);
		json({ ok: true, ...updated });
		return;
	}

	// POST /api/internal/mcp-call
	if (url.pathname === "/api/internal/mcp-call" && req.method === "POST") {
		const mcpManager = sessionManager.getMcpManager();
		if (!mcpManager) {
			json({ error: "MCP not initialized" }, 500);
			return;
		}
		try {
			const body = await new Promise<string>((resolve) => {
				let data = "";
				req.on("data", (chunk: Buffer) => data += chunk.toString());
				req.on("end", () => resolve(data));
			});
			const { tool, args } = JSON.parse(body);
			if (!tool) {
				json({ error: "Missing 'tool' field" }, 400);
				return;
			}

			// Enforce allowedTools for the calling session.
			// This endpoint is internal — only MCP proxy extensions should call it.
			// Require session ID header to prevent direct curl bypass.
			const mcpSessionId = req.headers["x-bobbit-session-id"] as string | undefined;
			if (!mcpSessionId) {
				json({ error: "Missing X-Bobbit-Session-Id header" }, 403);
				return;
			}
			// Verify the session exists (live or persisted).
			const mcpSession = sessionManager.getSession(mcpSessionId);
			const persistedSession = mcpSession ? null : (
				// Search across all project stores for persisted session
				projectContextManager.getContextForSession(mcpSessionId)?.sessionStore.get(mcpSessionId)
				?? null
			);
			if (!mcpSession && !persistedSession) {
				json({ error: `Session "${mcpSessionId}" not found` }, 403);
				return;
			}
			// Enforce allowedTools for non-MCP tools on live sessions.
			// MCP tools (mcp__*) are dynamically discovered and governed by the
			// grant policy system — they may not appear in the session's static
			// allowedTools list, so we skip the check for them.
			const toolStr = tool as string;
			if (!toolStr.startsWith("mcp__") && mcpSession?.allowedTools && mcpSession.allowedTools.length > 0) {
				if (!mcpSession.allowedTools.some((t: string) => t.toLowerCase() === toolStr.toLowerCase())) {
					json({ error: `Tool "${tool}" is not allowed for this session` }, 403);
					return;
				}
			}

			const result = await mcpManager.callTool(tool, args || {});
			json(result);
		} catch (err) {
			const e = err as Error;
			console.error(`[mcp] Tool call failed:`, e.stack || e);
			json({ error: e.message, stack: e.stack }, 500);
		}
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
		resolver({
			verdict: body.verdict === "pass",
			summary: body.summary,
			reportHtml,
		});
		json({ ok: true });
		return;
	}

	// ─── Maintenance endpoints ──────────────────────────────────────────
	// These replace the old automatic cleanup-on-startup behavior.
	// Users can preview orphaned resources and choose to clean them up.

	// GET /api/maintenance/orphaned-worktrees
	if (url.pathname === "/api/maintenance/orphaned-worktrees" && req.method === "GET") {
		const allOrphans: Array<{ path: string; branch: string; repoPath: string }> = [];
		for (const ctx of projectContextManager.all()) {
			try {
				const repoPath = ctx.project.rootPath;
				if (await isGitRepo(repoPath)) {
					const orphans = await sessionManager.listOrphanedSessionWorktrees(repoPath);
					for (const o of orphans) {
						allOrphans.push({ ...o, repoPath });
					}
				}
			} catch { /* best-effort */ }
		}
		json({ worktrees: allOrphans });
		return;
	}

	// POST /api/maintenance/cleanup-worktrees
	if (url.pathname === "/api/maintenance/cleanup-worktrees" && req.method === "POST") {
		const body = await readBody(req);
		let cleaned = 0;
		if (body?.worktrees && Array.isArray(body.worktrees)) {
			// Clean specific worktrees — validate each against registered projects and orphan list
			const validRepoPaths = new Set([...projectContextManager.all()].map(ctx => ctx.project.rootPath));
			for (const wt of body.worktrees) {
				if (wt.path && wt.branch && wt.repoPath) {
					// Validate repoPath is a registered project
					if (!validRepoPaths.has(wt.repoPath)) continue;
					// Validate this worktree is actually orphaned
					try {
						const orphans = await sessionManager.listOrphanedSessionWorktrees(wt.repoPath);
						const isOrphan = orphans.some(o => o.path === wt.path && o.branch === wt.branch);
						if (!isOrphan) continue;
					} catch { continue; }
					try {
						const { cleanupWorktree } = await import("./skills/git.js");
						await cleanupWorktree(wt.repoPath, wt.path, wt.branch, true);
						cleaned++;
					} catch { /* best-effort */ }
				}
			}
		} else {
			// Clean all orphans across all projects
			for (const ctx of projectContextManager.all()) {
				try {
					const repoPath = ctx.project.rootPath;
					if (await isGitRepo(repoPath)) {
						await sessionManager.cleanupOrphanedSessionWorktrees(repoPath);
						cleaned++; // count projects cleaned, not individual worktrees
					}
				} catch { /* best-effort */ }
			}
		}
		json({ cleaned });
		return;
	}

	// GET /api/maintenance/orphaned-sessions
	if (url.pathname === "/api/maintenance/orphaned-sessions" && req.method === "GET") {
		const sessions = await sessionManager.listOrphanedNonInteractiveSessions();
		json({ sessions });
		return;
	}

	// POST /api/maintenance/cleanup-sessions
	if (url.pathname === "/api/maintenance/cleanup-sessions" && req.method === "POST") {
		const body = await readBody(req);
		const orphans = await sessionManager.listOrphanedNonInteractiveSessions();
		const orphanIds = new Set(orphans.map(o => o.id));
		const idsToTerminate = (body?.sessionIds && Array.isArray(body.sessionIds))
			? (body.sessionIds as string[]).filter(id => orphanIds.has(id))
			: orphans.map(o => o.id);
		const terminated = await sessionManager.terminateOrphanedSessions(idsToTerminate);
		json({ terminated });
		return;
	}

	// GET /api/maintenance/expired-archives
	if (url.pathname === "/api/maintenance/expired-archives" && req.method === "GET") {
		const stats = await sessionManager.getExpiredArchiveStats();
		json(stats);
		return;
	}

	// POST /api/maintenance/purge-archives
	if (url.pathname === "/api/maintenance/purge-archives" && req.method === "POST") {
		await sessionManager.purgeExpiredArchives();
		const stats = await sessionManager.getExpiredArchiveStats();
		json({ purged: true, remaining: stats });
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
