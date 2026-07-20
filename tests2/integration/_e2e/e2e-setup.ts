/**
 * Compatibility shim: reproduces the tests/e2e/e2e-setup.ts helper surface on
 * top of the Test Suite v2 fork-scoped gateway fixture (tests2/harness/gateway.ts).
 *
 * Migrated v2-integration specs import this instead of ../e2e-setup.js so their
 * bodies stay byte-for-byte identical (same apiFetch/createSession/connectWs/…
 * semantics), while the underlying server is the single per-fork gateway booted
 * with GatewayDeps (manual clock, fenced runner, fenced fetch, mock bridge)
 * rather than the Playwright per-worker in-process harness.
 *
 * Auth/base/token are resolved from the live gateway fixture; the orchestrate /
 * team-lead secret injection reads directly off gw.sessionManager /
 * gw.teamManager (no separate registration step). Fencing (no GitHub / no
 * non-loopback host) is enforced structurally by the injected CommandRunner /
 * fetch — this shim never re-enables a remote.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import WebSocket from "ws";
import { performance } from "node:perf_hooks";
import { recordProfiledApiCall } from "../../harness/gateway.js";
import { copyGitTemplate } from "../../harness/git-template.js";
import { currentScope, ensureGateway, gatewaySync } from "./runtime.js";

export { ensureGateway };
const gw = gatewaySync;

export function base(): string { return gw().baseURL; }
export function wsBase(): string { return gw().wsBase; }
export function bobbitDir(): string { return gw().bobbitDir; }
export function readE2EToken(): string { return gw().token; }
export async function readE2ETokenAsync(): Promise<string> { return (await ensureGateway()).token; }
function token(): string { return gw().token; }

export function harnessDefaultProjectRoot(): string {
	// The v2 gateway fixture registers its default project at <bobbitDir>/default-project
	// (see tests2/harness/gateway.ts). nonGitCwd()/gitCwd() live UNDER that root so
	// goal/session cwds pass the server's CWD_OUTSIDE_PROJECT containment check.
	const root = join(bobbitDir(), "default-project");
	mkdirSync(root, { recursive: true });
	try { return realpathSync(root); } catch { return root; }
}

export function projectStateDirForRoot(rootPath: string): string {
	return join(rootPath, ".bobbit", "state");
}

// ---------------------------------------------------------------------------
// Non-git / git working directories under the gateway's temp bobbitDir.
// bobbitDir is outside any git repo, so subdirs are non-git by construction.
// ---------------------------------------------------------------------------
const _nonGitCwd: Record<string, string> = {};
export function nonGitCwd(): string {
	const root = harnessDefaultProjectRoot();
	if (!_nonGitCwd[root]) {
		const cwd = join(root, ".e2e-workspaces", "non-git");
		mkdirSync(cwd, { recursive: true });
		try { _nonGitCwd[root] = realpathSync(cwd); } catch { _nonGitCwd[root] = cwd; }
	}
	return _nonGitCwd[root];
}

const _gitCwd: Record<string, string> = {};
export function gitCwd(): string {
	const root = harnessDefaultProjectRoot();
	if (!_gitCwd[root]) {
		const cwd = join(root, ".e2e-workspaces", `git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		_gitCwd[root] = copyGitTemplate(cwd);
	}
	return _gitCwd[root];
}

// ---------------------------------------------------------------------------
// REST helpers (ported injection logic from tests/e2e/e2e-setup.ts).
// ---------------------------------------------------------------------------
const PROJECT_INJECT_ROUTES = /^\/api\/(sessions|goals|staff)(\?|$)/;
const WORKFLOWS_BODY_INJECT = /^\/api\/workflows(\?|$)/;
const WORKFLOWS_QUERY_INJECT = /^\/api\/workflows\/[^/]+(\/customize|\/override)?(\?|$)/;
const PROJECTS_POST = /^\/api\/projects(\?|$)/;
const CHILDREN_MUTATION_PATH = /^\/api\/goals\/[^/]+\/(pause|resume|policy|mutation\/[^/]+\/decision)$/;
const ORCHESTRATE_PATH = /^\/api\/sessions\/([^/]+)\/orchestrate\//;
const TEAM_OWNCHILD_PATH = /^\/api\/goals\/([^/]+)\/(?:team|swarm)\/(?:prompt|steer|abort|dismiss)$/;

export interface WsMsg { type: string; [key: string]: any }

function canonicalPathForMatch(p: string): string {
	try { return realpathSync(p); } catch { return resolve(p); }
}
function pathContains(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

type ProjectSummary = { id?: string; name?: string; rootPath?: string; hidden?: boolean };

async function listProjects(): Promise<ProjectSummary[]> {
	const resp = await fetch(`${base()}/api/projects`, { headers: { Authorization: `Bearer ${token()}` } });
	if (!resp.ok) return [];
	const body = await resp.json().catch(() => []);
	return Array.isArray(body) ? body : (body?.projects ?? []);
}

export async function defaultProjectId(): Promise<string | undefined> {
	const projects = (await listProjects()).filter(p => !p.hidden);
	const match = projects.find(p => p.name === "default" && p.id);
	if (match?.id) return match.id;
	// Self-heal the default project if a prior test drained it.
	await gw().restoreDefaultProject();
	const healed = (await listProjects()).filter(p => !p.hidden).find(p => p.name === "default" && p.id);
	return healed?.id ?? gw().defaultProjectId;
}

export async function defaultProject(): Promise<{ id: string; rootPath: string; name?: string }> {
	const id = await defaultProjectId();
	if (!id) throw new Error("[tests2/e2e-compat] defaultProject failed to resolve id");
	const project = (await listProjects()).find(p => p.id === id && !p.hidden);
	if (!project?.rootPath) throw new Error(`[tests2/e2e-compat] defaultProject ${id} missing rootPath`);
	return { id, rootPath: project.rootPath, name: project.name };
}
export async function defaultProjectRootPath(): Promise<string> { return (await defaultProject()).rootPath; }
export async function defaultProjectStateDir(): Promise<string> { return projectStateDirForRoot(await defaultProjectRootPath()); }

async function projectRootForId(projectId: string): Promise<string | undefined> {
	return (await listProjects()).find(p => p.id === projectId && !p.hidden)?.rootPath;
}

async function projectIdForRequestCwd(cwdValue: unknown): Promise<string | undefined> {
	if (typeof cwdValue !== "string" || !cwdValue.trim()) return undefined;
	const cwd = canonicalPathForMatch(cwdValue);
	let best: { id: string; root: string } | undefined;
	for (const p of await listProjects()) {
		if (p.hidden || !p.id || !p.rootPath) continue;
		const root = canonicalPathForMatch(p.rootPath);
		if (!pathContains(root, cwd)) continue;
		if (!best || root.length > best.root.length) best = { id: p.id, root };
	}
	return best?.id;
}

async function defaultExecutionCwdForProject(projectId: string | undefined): Promise<string> {
	if (projectId) {
		const rootPath = await projectRootForId(projectId);
		if (rootPath) {
			const canonicalRoot = canonicalPathForMatch(rootPath);
			const canonicalDefaultRoot = canonicalPathForMatch(harnessDefaultProjectRoot());
			return canonicalRoot === canonicalDefaultRoot ? nonGitCwd() : rootPath;
		}
	}
	return nonGitCwd();
}

export async function injectDefaultProjectId(body: unknown): Promise<unknown> {
	if (body == null) {
		const pid = await defaultProjectId();
		return pid ? JSON.stringify({ projectId: pid }) : body;
	}
	let parsed: Record<string, unknown> | undefined;
	if (typeof body === "string") {
		try { parsed = JSON.parse(body); } catch { return body; }
	} else if (typeof body === "object") {
		parsed = body as Record<string, unknown>;
	} else { return body; }
	if (!parsed || typeof parsed !== "object") return body;
	if (typeof parsed.projectId === "string" && parsed.projectId) {
		return typeof body === "string" ? body : JSON.stringify(parsed);
	}
	const pid = (await projectIdForRequestCwd(parsed.cwd)) ?? (await defaultProjectId());
	if (!pid) return typeof body === "string" ? body : JSON.stringify(parsed);
	return JSON.stringify({ ...parsed, projectId: pid });
}

async function maybeInjectProjectId(path: string, opts: RequestInit): Promise<RequestInit> {
	const method = (opts.method || "GET").toUpperCase();
	if (method === "POST" && PROJECTS_POST.test(path)) {
		let body = opts.body;
		if (typeof body === "string") {
			try {
				const parsed = JSON.parse(body) as Record<string, unknown>;
				if (parsed && typeof parsed === "object" && parsed.acceptCanonical === undefined) {
					body = JSON.stringify({ ...parsed, acceptCanonical: true });
				}
			} catch { /* not JSON */ }
		}
		if (body !== opts.body) return { ...opts, body: body as BodyInit };
	}
	if (method === "POST" && (PROJECT_INJECT_ROUTES.test(path) || WORKFLOWS_BODY_INJECT.test(path))) {
		const newBody = await injectDefaultProjectId(opts.body as unknown);
		if (newBody === opts.body) return opts;
		return { ...opts, body: newBody as BodyInit };
	}
	if (method === "POST" && path === "/api/projects" && typeof opts.body === "string") {
		try {
			const parsed = JSON.parse(opts.body) as Record<string, unknown>;
			if (typeof parsed === "object" && parsed !== null && typeof parsed.rootPath === "string") {
				let rp = parsed.rootPath;
				try { rp = realpathSync(rp); } catch { /* may not exist */ }
				if (rp !== parsed.rootPath) return { ...opts, body: JSON.stringify({ ...parsed, rootPath: rp }) };
			}
		} catch { /* not JSON */ }
	}
	return opts;
}

function maybeInjectAcceptCanonical(path: string, opts: RequestInit): RequestInit {
	const method = (opts.method || "GET").toUpperCase();
	if (method !== "POST" || path !== "/api/projects") return opts;
	const body = opts.body as unknown;
	let parsed: Record<string, unknown> | undefined;
	if (typeof body === "string") {
		try { parsed = JSON.parse(body); } catch { return opts; }
	} else if (body && typeof body === "object") {
		parsed = body as Record<string, unknown>;
	} else { return opts; }
	if (!parsed || typeof parsed !== "object") return opts;
	if (parsed.__e2e_no_accept_canonical) return opts;
	const patch: Record<string, unknown> = {};
	if (typeof parsed.rootPath === "string" && parsed.rootPath) {
		try { const canonical = realpathSync(parsed.rootPath); if (canonical !== parsed.rootPath) patch.rootPath = canonical; } catch { /* */ }
	}
	if (parsed.acceptCanonical === undefined) patch.acceptCanonical = true;
	if (Object.keys(patch).length === 0) return opts;
	return { ...opts, body: JSON.stringify({ ...parsed, ...patch }) };
}

function needsHeadquartersConfigProjectId(path: string, method: string): boolean {
	const bare = path.split("?")[0];
	if (method === "GET" && /^\/api\/(tools|roles|sandbox-status)(\?|$)/.test(path)) return true;
	if (method === "POST" && /^\/api\/sandbox-image\/build(\?|$)/.test(path)) return true;
	if ((method === "GET" || method === "PUT") && /^\/api\/tools\/[^/]+$/.test(bare)) return true;
	if (method === "GET" && /^\/api\/tools\/[^/]+\/renderer$/.test(bare)) return true;
	if (method === "GET" && bare === "/api/ext/contributions") return true;
	if (method === "GET" && /^\/api\/ext\/packs\/[^/]+\/panels\/[^/]+$/.test(bare)) return true;
	if ((method === "POST" || method === "DELETE") && /^\/api\/tools\/[^/]+\/(customize|override)$/.test(bare)) return true;
	if (method === "POST" && bare === "/api/roles") return true;
	if ((method === "GET" || method === "PUT" || method === "DELETE") && /^\/api\/roles\/(?!assistant\/prompts(?:\/|$))[^/]+$/.test(bare)) return true;
	if ((method === "POST" || method === "DELETE") && /^\/api\/roles\/[^/]+\/(customize|override)$/.test(bare)) return true;
	if (method === "GET" && bare === "/api/tool-group-policies") return true;
	if (method === "PUT" && /^\/api\/tool-group-policies\/[^/]+$/.test(bare)) return true;
	return false;
}

async function maybeInjectProjectIdQuery(path: string, method: string): Promise<string> {
	const rootGet = method === "GET" && WORKFLOWS_BODY_INJECT.test(path);
	const idRoute = WORKFLOWS_QUERY_INJECT.test(path) && ["GET", "POST", "PUT", "DELETE"].includes(method);
	const hqDiscoveryRoute = needsHeadquartersConfigProjectId(path, method);
	if (!rootGet && !idRoute && !hqDiscoveryRoute) return path;
	if (/[?&]projectId=/.test(path)) return path;
	if (hqDiscoveryRoute) return path + (path.includes("?") ? "&" : "?") + "projectId=headquarters";
	const pid = await defaultProjectId();
	if (!pid) return path;
	return path + (path.includes("?") ? "&" : "?") + "projectId=" + encodeURIComponent(pid);
}

async function maybeAutoSeedWorkflows(path: string, method: string, requestBody: unknown, response: Response): Promise<void> {
	if (method !== "POST" || path !== "/api/projects") return;
	if (!response.ok) return;
	let parsed: Record<string, unknown> | undefined;
	if (typeof requestBody === "string") { try { parsed = JSON.parse(requestBody); } catch { /* */ } }
	else if (requestBody && typeof requestBody === "object") parsed = requestBody as Record<string, unknown>;
	if (parsed?.workflows) return;
	if (parsed?.__e2e_seed_skip__) return;
	let projectId: string | undefined;
	try { projectId = ((await response.clone().json()) as { id?: string })?.id; } catch { return; }
	if (!projectId) return;
	try {
		const { testWorkflows } = await import("../../../tests/e2e/seed-workflows.js");
		await fetch(`${base()}/api/projects/${projectId}/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
			body: JSON.stringify({ workflows: testWorkflows() }),
		});
	} catch { /* best-effort */ }
}

// --- authz secret / cookie injection (reads directly off the gateway) --------
function orchestrateSecretStore(): { getOrCreateSecret(id: string): string } | undefined {
	const store = gw().sessionManager?.sessionSecretStore;
	return store && typeof store.getOrCreateSecret === "function" ? store : undefined;
}
function maybeInjectOrchestrateSecret(path: string, headers: Record<string, string>): Record<string, string> {
	const m = ORCHESTRATE_PATH.exec(path.split("?")[0]);
	const store = orchestrateSecretStore();
	if (!m || !store) return headers;
	if (Object.keys(headers).some(k => k.toLowerCase() === "x-bobbit-session-secret")) return headers;
	return { ...headers, "X-Bobbit-Session-Secret": store.getOrCreateSecret(decodeURIComponent(m[1])) };
}
function maybeInjectTeamLeadSecret(path: string, headers: Record<string, string>): Record<string, string> {
	const m = TEAM_OWNCHILD_PATH.exec(path.split("?")[0]);
	const store = orchestrateSecretStore();
	const teamManager = gw().teamManager;
	if (!m || !store || !teamManager?.getTeamState) return headers;
	if (Object.keys(headers).some(k => k.toLowerCase() === "x-bobbit-session-secret")) return headers;
	const lead = teamManager.getTeamState(decodeURIComponent(m[1]))?.teamLeadSessionId;
	if (!lead) return headers;
	return { ...headers, "X-Bobbit-Session-Secret": store.getOrCreateSecret(lead) };
}

/** Bootstrap and cache the signed human/operator cookie via a browser-signaled request. */
const _humanCookieCache: Record<string, string> = {};
async function humanSessionCookie(): Promise<string> {
	const key = base();
	if (_humanCookieCache[key]) return _humanCookieCache[key];
	try {
		const resp = await fetch(`${base()}/api/goals`, {
			headers: {
				Authorization: `Bearer ${token()}`,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			},
		});
		const setCookies = (resp.headers as any).getSetCookie?.() as string[] | undefined
			?? (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie") as string] : []);
		const cookie = setCookies.map(c => c.split(";")[0]).find(c => c.startsWith("bobbit_session=")) ?? "";
		if (cookie) _humanCookieCache[key] = cookie;
		return cookie;
	} catch { return ""; }
}
async function withChildrenAuthzCookie(path: string, method: string, headers: Record<string, string>): Promise<Record<string, string>> {
	const bare = path.split("?")[0];
	const isChildCreate = method.toUpperCase() === "POST" && bare === "/api/goals";
	if (!CHILDREN_MUTATION_PATH.test(bare) && !isChildCreate) return headers;
	const hasExplicitAuth = Object.keys(headers).some(k => {
		const lk = k.toLowerCase();
		if ((lk === "x-bobbit-spawning-session" || lk === "x-bobbit-session-id") && headers[k]) return true;
		if (lk === "cookie" && /bobbit_session=/.test(headers[k] || "")) return true;
		return false;
	});
	if (hasExplicitAuth) return headers;
	const cookie = await humanSessionCookie();
	return cookie ? { ...headers, Cookie: cookie } : headers;
}

export function seedTeamLeadHeader(gateway: any, goalId: string, sessionId?: string): Record<string, string> {
	const teamManager = gateway?.teamManager ?? gateway ?? gw().teamManager;
	const secretStore = gateway?.sessionManager?.sessionSecretStore ?? gateway?.sessionSecretStore ?? orchestrateSecretStore();
	const existing = teamManager?.getTeamState?.(goalId)?.teamLeadSessionId;
	const tl = (typeof existing === "string" && existing.trim())
		? existing.trim()
		: (sessionId && sessionId.trim() ? sessionId.trim() : `e2e-teamlead-${goalId}`);
	if (!existing) {
		teamManager?.teams?.set?.(goalId, { goalId, teamLeadSessionId: tl, agents: [], maxConcurrent: 12 });
	}
	const headers: Record<string, string> = { "X-Bobbit-Spawning-Session": tl };
	if (secretStore?.getOrCreateSecret) headers["X-Bobbit-Session-Secret"] = secretStore.getOrCreateSecret(tl);
	return headers;
}

export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	await ensureGateway();
	const injected = maybeInjectAcceptCanonical(path, await maybeInjectProjectId(path, opts));
	const method = (injected.method || opts.method || "GET").toUpperCase();
	const finalPath = await maybeInjectProjectIdQuery(path, method);
	const authedHeaders = maybeInjectTeamLeadSecret(finalPath, maybeInjectOrchestrateSecret(finalPath, await withChildrenAuthzCookie(finalPath, method, {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token()}`,
		...(injected.headers as Record<string, string> || {}),
	})));
	const maxRetries = 4;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		const startedAt = performance.now();
		try {
			const resp = await fetch(`${base()}${finalPath}`, { ...injected, headers: authedHeaders });
			recordProfiledApiCall(method, finalPath, resp.status, performance.now() - startedAt);
			await maybeAutoSeedWorkflows(path, method, injected.body as unknown, resp);
			return resp;
		} catch (err: unknown) {
			recordProfiledApiCall(method, finalPath, 0, performance.now() - startedAt);
			const msg = err instanceof Error
				? [err.message, (err as any).cause?.message, (err as any).cause?.code].filter(Boolean).join(" ")
				: String(err);
			const isTransient = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR_SOCKET|fetch failed/i.test(msg);
			if (!isTransient || attempt === maxRetries - 1) throw err;
			await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
		}
	}
	throw new Error("apiFetch: unreachable");
}

export async function rawApiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	await ensureGateway();
	const method = (opts.method || "GET").toUpperCase();
	const startedAt = performance.now();
	try {
		const resp = await fetch(`${base()}${path}`, {
			...opts,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}`, ...(opts.headers as Record<string, string> || {}) },
		});
		recordProfiledApiCall(method, path, resp.status, performance.now() - startedAt);
		await maybeAutoSeedWorkflows(path, method, opts.body as unknown, resp);
		return resp;
	} catch (error) {
		recordProfiledApiCall(method, path, 0, performance.now() - startedAt);
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Entity helpers (auto-track into the active per-test scope for leak safety).
// ---------------------------------------------------------------------------
async function responseText(resp: Response): Promise<string> {
	try { return (await resp.text()) || "<empty>"; } catch (err) { return `<failed to read body: ${err instanceof Error ? err.message : String(err)}>`; }
}

export async function createSession(opts?: { cwd?: string; goalId?: string; projectId?: string }): Promise<string> {
	const projectId = opts?.projectId || (await defaultProjectId());
	const body: Record<string, unknown> = {
		cwd: opts?.cwd || await defaultExecutionCwdForProject(projectId),
		goalId: opts?.goalId,
	};
	if (projectId) body.projectId = projectId;
	let resp: Response | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		resp = await apiFetch("/api/sessions", { method: "POST", body: JSON.stringify(body) });
		if (resp.status !== 500 || attempt === 4) break;
		await responseText(resp).catch(() => "<ignored>");
		try { mkdirSync(join(bobbitDir(), "state", "session-prompts"), { recursive: true }); } catch { /* */ }
		await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
	}
	if (resp!.status !== 201) {
		throw new Error(`createSession expected 201, got ${resp!.status}. body=${await responseText(resp!)}`);
	}
	const id = (await resp!.json()).id;
	currentScope()?.trackSession(id);
	return id;
}

export async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

export async function createGoal(opts: {
	title: string; cwd?: string; spec?: string; team?: boolean; worktree?: boolean;
	workflowId?: string; autoStartTeam?: boolean; projectId?: string;
	subgoalsAllowed?: boolean; maxNestingDepth?: number;
}): Promise<{ id: string; [k: string]: unknown }> {
	const defaultSpec = "E2E harness goal — spec autopopulated by createGoal() helper for tests that do not exercise spec content.";
	const body: Record<string, unknown> = { worktree: false, spec: defaultSpec, ...opts };
	if (!body.projectId) body.projectId = await defaultProjectId();
	if (!body.cwd) body.cwd = await defaultExecutionCwdForProject(typeof body.projectId === "string" ? body.projectId : undefined);
	const resp = await apiFetch("/api/goals", { method: "POST", body: JSON.stringify(body) });
	if (resp.status !== 201) throw new Error(`createGoal expected 201, got ${resp.status}. body=${await responseText(resp)}`);
	const goal = await resp.json();
	const id = goal?.id ?? goal?.goalId ?? goal?.session?.goalId;
	if (id) currentScope()?.trackGoal(id);
	return goal;
}

export async function deleteGoal(id: string, cascade = true): Promise<void> {
	await apiFetch(`/api/goals/${id}?cascade=${cascade ? "true" : "false"}`, { method: "DELETE" }).catch(() => {});
}

export async function startTeam(goalId: string): Promise<string> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/start`, { method: "POST" });
	const data = await resp.json();
	if (resp.status >= 300) throw new Error(`startTeam failed (${resp.status}): ${JSON.stringify(data)}`);
	return data.sessionId;
}

export async function teardownTeam(goalId: string, cascade = true): Promise<void> {
	await apiFetch(`/api/goals/${goalId}/team/teardown?cascade=${cascade ? "true" : "false"}`, { method: "POST" }).catch(() => {});
}

export async function registerProject(opts: {
	name: string; rootPath: string; components?: Array<Record<string, unknown>>; workflows?: unknown;
	upsert?: boolean; config?: Record<string, unknown>; seedWorkflows?: boolean; extra?: Record<string, unknown>;
}): Promise<{ id: string; rootPath: string; [k: string]: unknown }> {
	const body: Record<string, unknown> = { name: opts.name, rootPath: opts.rootPath };
	if (opts.components) body.components = opts.components;
	if (opts.workflows !== undefined) body.workflows = opts.workflows;
	if (opts.upsert) body.upsert = true;
	if (opts.config) Object.assign(body, opts.config);
	if (opts.extra) Object.assign(body, opts.extra);
	if (opts.seedWorkflows === false) body.__e2e_seed_skip__ = true;
	const resp = await apiFetch("/api/projects", { method: "POST", body: JSON.stringify(body) });
	if (resp.status < 200 || resp.status >= 300) throw new Error(`registerProject(${opts.name}) failed: ${resp.status} ${await responseText(resp)}`);
	const project = await resp.json();
	if (project?.id) currentScope()?.trackProject(project.id);
	return project;
}

// ---------------------------------------------------------------------------
// WebSocket helpers (identical semantics to tests/e2e/e2e-setup.ts).
// ---------------------------------------------------------------------------
export interface WsConnection {
	ws: WebSocket;
	messages: WsMsg[];
	waitFor: (pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	waitForFrom: (fromIndex: number, pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	messageCount: () => number;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}

export function connectWs(sessionId: string): Promise<WsConnection> {
	return new Promise((resolvePromise, reject) => {
		const ws = new WebSocket(`${wsBase()}/ws/${sessionId}`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void }> = [];
		ws.on("message", (raw) => {
			const msg: WsMsg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) { waiters[i].res(msg); waiters.splice(i, 1); }
			}
		});
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: token() })));
		ws.on("error", reject);
		const iv = setInterval(() => {
			if (messages.some((m) => m.type === "auth_ok")) {
				clearInterval(iv);
				resolvePromise({
					ws, messages,
					waitFor(pred, timeoutMs = 15_000) {
						const existing = messages.find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(() => rej(new Error(`WS waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
							waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, rej });
						});
					},
					waitForFrom(fromIndex, pred, timeoutMs = 15_000) {
						const existing = messages.slice(fromIndex).find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(() => rej(new Error(`WS waitForFrom timed out (${timeoutMs}ms)`)), timeoutMs);
							waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, rej });
						});
					},
					messageCount: () => messages.length,
					send: (m) => ws.send(JSON.stringify(m)),
					close: () => ws.close(),
				});
			}
		}, 50);
		setTimeout(() => { clearInterval(iv); reject(new Error("WS auth timeout")); }, 10_000);
	});
}

export function toolStartPredicate(toolName: string): (m: WsMsg) => boolean {
	const lower = toolName.toLowerCase();
	return (m) => m.type === "event" && m.data?.type === "tool_execution_start" && (m.data?.toolName || "").toLowerCase() === lower;
}
export function agentEndPredicate(): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "agent_end";
}
export function statusPredicate(status: string): (m: WsMsg) => boolean {
	return (m) => m.type === "session_status" && m.status === status;
}
export function queueLenPredicate(len: number): (m: WsMsg) => boolean {
	return (m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === len;
}
export function messageEndPredicate(role: string): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === role;
}

export async function signalAndWaitForGate(
	conn: WsConnection, goalId: string, gateId: string, body: Record<string, unknown>,
	targetStatus: string | string[], timeoutMs = 15_000,
): Promise<WsMsg> {
	const statuses = Array.isArray(targetStatus) ? targetStatus : [targetStatus];
	const cursor = conn.messageCount();
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`signal ${gateId} failed: ${res.status} ${await res.text()}`);
	return conn.waitForFrom(
		cursor,
		(m) => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === gateId && statuses.includes(m.status),
		timeoutMs,
	);
}

// ---------------------------------------------------------------------------
// Polling helpers.
// ---------------------------------------------------------------------------
export async function waitForHealth(timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try { const resp = await fetch(`${base()}/api/health`, { headers: { Authorization: `Bearer ${token()}` } }); if (resp.ok) return; } catch { /* */ }
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

export async function waitForCondition(
	probe: () => boolean,
	opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
	const { timeoutMs = 5_000, intervalMs = 25, message = "condition" } = opts;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) { if (probe()) return; await new Promise(r => setTimeout(r, intervalMs)); }
	if (!probe()) throw new Error(`Timed out (${timeoutMs}ms) waiting for ${message}`);
}

export async function assertStaysFalse(
	probe: () => boolean, opts: { durationMs: number; intervalMs?: number; message?: string },
): Promise<void> {
	const { durationMs, intervalMs = 25, message = "condition" } = opts;
	const end = Date.now() + durationMs;
	while (Date.now() < end) { if (probe()) throw new Error(`Unexpected: ${message} became true within ${durationMs}ms`); await new Promise(r => setTimeout(r, intervalMs)); }
}

export async function waitForSessionStatus(sessionId: string, targetStatus: string, timeoutMs = 15_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (resp.ok) { const data = await resp.json(); if (data.status === targetStatus) return; }
		} catch { /* */ }
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`Session ${sessionId} did not reach "${targetStatus}" within ${timeoutMs}ms`);
}
