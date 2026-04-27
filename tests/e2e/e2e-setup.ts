/**
 * Shared E2E test helpers.
 *
 * The E2E test server runs with BOBBIT_DIR pointing to an isolated temp
 * directory so it doesn't pollute the real dev-server state under .bobbit/.
 *
 * Port and bobbit dir are set dynamically per-worker by the gateway fixture
 * in gateway-harness.ts. All values are read from process.env at call time
 * (not import time) so each worker gets the right server.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "@playwright/test";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Dynamic env-backed values — read at call time, not import time.
// This lets each Playwright worker point at its own gateway instance.
// ---------------------------------------------------------------------------

function port(): string { return process.env.E2E_PORT || "3099"; }
export function base(): string { return `http://127.0.0.1:${port()}`; }
export function wsBase(): string { return `ws://127.0.0.1:${port()}`; }
export function bobbitDir(): string {
	return process.env.BOBBIT_DIR
		|| join(import.meta.dirname, "..", "..", ".e2e-bobbit");
}

/**
 * Backward-compatible exports. These are getters so existing code like
 *   fetch(`${BASE}/api/sessions`)
 * resolves the current worker's server on each access.
 */
export let E2E_PORT: string;
export let BASE: string;
export let WS_BASE: string;
export let E2E_BOBBIT_DIR: string;
export let E2E_PI_DIR: string; // legacy alias

// Re-define as getters on the module object. The `export let` declarations
// above create the binding slots; Object.defineProperty replaces them with
// getters that read process.env each time.
const _thisModule: Record<string, unknown> = { E2E_PORT, BASE, WS_BASE, E2E_BOBBIT_DIR, E2E_PI_DIR };
Object.defineProperty(_thisModule, "E2E_PORT", { get: port, enumerable: true });
Object.defineProperty(_thisModule, "BASE", { get: base, enumerable: true });
Object.defineProperty(_thisModule, "WS_BASE", { get: wsBase, enumerable: true });
Object.defineProperty(_thisModule, "E2E_BOBBIT_DIR", { get: bobbitDir, enumerable: true });
Object.defineProperty(_thisModule, "E2E_PI_DIR", { get: bobbitDir, enumerable: true });

// Re-export as mutable bindings that stay in sync via a refresh trick.
// NOTE: ES module live bindings don't support external reassignment, so
// we use a different approach — the helpers below always call the functions.
// For direct `BASE` usage in tests, we set them once at import time and
// the gateway-harness sets process.env BEFORE the test files are imported.

// Set initial values from env (the gateway harness sets env before tests load)
E2E_PORT = port();
BASE = base();
WS_BASE = wsBase();
E2E_BOBBIT_DIR = bobbitDir();
E2E_PI_DIR = bobbitDir();

/**
 * A cwd that is NOT inside a git repository.
 * Used by tests to prevent worktree creation on goal/session create.
 * This avoids creating real git worktrees (slow, leaky, conflicts between
 * parallel test runs that share the same repo).
 */
let _nonGitCwd: string | undefined;
export function nonGitCwd(): string {
	if (!_nonGitCwd) {
		_nonGitCwd = join(tmpdir(), `bobbit-e2e-${port()}-${Date.now()}`);
		mkdirSync(_nonGitCwd, { recursive: true });
	}
	return _nonGitCwd;
}

/**
 * A cwd that IS a git repository (minimal, no package-lock.json).
 * Used by tests that need worktree creation (e.g. staff agents).
 */
let _gitCwd: string | undefined;
export function gitCwd(): string {
	if (!_gitCwd) {
		_gitCwd = join(tmpdir(), `bobbit-e2e-git-${port()}-${Date.now()}`);
		mkdirSync(_gitCwd, { recursive: true });
		writeFileSync(join(_gitCwd, "README.md"), "# E2E test repo\n");
		execFileSync("git", ["init"], { cwd: _gitCwd, stdio: "pipe" });
		execFileSync("git", ["add", "."], { cwd: _gitCwd, stdio: "pipe" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: _gitCwd, stdio: "pipe" });
	}
	return _gitCwd;
}

/**
 * Read the auth token that the test server auto-created on startup.
 *
 * Retries briefly on ENOENT because Windows filesystem under heavy parallel
 * load occasionally returns ENOENT for files that exist — the token is
 * written once per worker by the gateway fixture and then never removed
 * until worker teardown, so any ENOENT mid-run is spurious.
 */
export function readE2EToken(): string {
	const p = join(bobbitDir(), "state", "token");
	let lastErr: unknown;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			return readFileSync(p, "utf-8").trim();
		} catch (err: any) {
			lastErr = err;
			if (err?.code !== "ENOENT") throw err;
			// Busy-wait briefly — 10×50ms = 500ms worst case.
			const until = Date.now() + 50;
			while (Date.now() < until) { /* spin */ }
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// Shared REST helpers
// ---------------------------------------------------------------------------

const _tokenCache: Record<string, string> = {};

/** Lazily read and cache the E2E auth token (per-port to handle worker isolation). */
function token(): string {
	const p = port();
	if (!_tokenCache[p]) _tokenCache[p] = readE2EToken();
	return _tokenCache[p];
}

/**
 * Routes where POST must carry a registered projectId (or a cwd matching one).
 * The E2E harness registers a "default" project at startup; tests that omit
 * projectId get it injected automatically so they don't need to know about
 * the underlying server requirement. Tests that deliberately exercise the
 * 400-path bypass this helper by calling `fetch(...)` directly.
 */
const PROJECT_INJECT_ROUTES = /^\/api\/(sessions|goals|staff)(\?|$|\/)/;

/**
 * Parse a JSON body (string or already-object), inject projectId when missing,
 * and return a string suitable for a fetch body. Returns the original body
 * unchanged if it's not a JSON object we can read.
 */
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
	} else {
		return body;
	}
	if (!parsed || typeof parsed !== "object") return body;
	if (typeof parsed.projectId === "string" && parsed.projectId) {
		return typeof body === "string" ? body : JSON.stringify(parsed);
	}
	const pid = await defaultProjectId();
	if (!pid) return typeof body === "string" ? body : JSON.stringify(parsed);
	return JSON.stringify({ ...parsed, projectId: pid });
}

async function maybeInjectProjectId(path: string, opts: RequestInit): Promise<RequestInit> {
	const method = (opts.method || "GET").toUpperCase();
	if (method !== "POST") return opts;
	if (!PROJECT_INJECT_ROUTES.test(path)) return opts;
	const newBody = await injectDefaultProjectId(opts.body as unknown);
	if (newBody === opts.body) return opts;
	return { ...opts, body: newBody as BodyInit };
}

/**
 * Raw authenticated fetch — identical auth to `apiFetch` but does NOT auto-inject
 * the harness default projectId. Use this for tests that deliberately exercise
 * the 400-projectId-required path.
 */
export async function rawApiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

/** Authenticated REST fetch against the E2E gateway. Retries on transient TCP errors. */
export async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	const injected = await maybeInjectProjectId(path, opts);
	const maxRetries = 4;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return await fetch(`${base()}${path}`, {
				...injected,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token()}`,
					...(injected.headers as Record<string, string> || {}),
				},
			});
		} catch (err: unknown) {
			const msg = err instanceof Error
				? [err.message, (err as any).cause?.message, (err as any).cause?.code].filter(Boolean).join(" ")
				: String(err);
			const isTransient = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR_SOCKET|fetch failed/i.test(msg);
			if (!isTransient || attempt === maxRetries - 1) throw err;
			// Increasing back-off: 250ms, 500ms, 1000ms
			await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
		}
	}
	throw new Error("apiFetch: unreachable");
}

/**
 * Look up the harness-registered "default" project id.
 *
 * The gateway harness (see gateway-harness.ts / in-process-harness.ts) registers
 * a single project named "default" at the server CWD after startup. The server
 * no longer auto-resolves a default, so API callers that omit projectId must
 * pass one explicitly. This helper fetches and caches the id per-port.
 *
 * NOTE on cache invalidation: tests like stories-goal-routing run
 * `forceDeleteAllProjects()` to exercise the zero-project path. Anything
 * cached here would then point at a deleted project and the next
 * `createSession()` would 500 with "Cannot resolve session store". To stay
 * robust under shared-worker harness reuse, every call re-checks the live
 * project list and re-derives the cache from it; the caller still gets
 * O(1)-ish behaviour because /api/projects is in-memory and dirt cheap.
 */
const _defaultProjectIdCache: Record<string, string> = {};
export async function defaultProjectId(): Promise<string | undefined> {
	const p = port();
	try {
		const resp = await apiFetch("/api/projects");
		if (!resp.ok) {
			delete _defaultProjectIdCache[p];
			return undefined;
		}
		const list = await resp.json() as Array<{ id: string; name: string }>;
		if (!Array.isArray(list)) {
			delete _defaultProjectIdCache[p];
			return undefined;
		}
		// If a previously-cached id still exists in the live list, keep using
		// it (stable across calls). Otherwise pick the "default" project, or
		// fall back to the first registered project.
		const cachedId = _defaultProjectIdCache[p];
		if (cachedId && list.some(pr => pr.id === cachedId)) return cachedId;
		const match = list.find(pr => pr.name === "default") ?? list[0];
		if (match?.id) {
			_defaultProjectIdCache[p] = match.id;
			return match.id;
		}
		delete _defaultProjectIdCache[p];
	} catch { /* zero-project harnesses are a valid state (see GR-09) */ }
	return undefined;
}

/**
 * Create a session via REST, return its ID. Defaults cwd to a non-git temp dir.
 *
 * Retries once on 500 to absorb a known Windows-only race where the server's
 * session-prompts directory briefly appears missing under heavy parallel
 * load even though the harness + scaffolder both created it. Real product
 * failures still surface via the second attempt.
 */
export async function createSession(opts?: { cwd?: string; goalId?: string; projectId?: string }): Promise<string> {
	const body: Record<string, unknown> = {
		cwd: opts?.cwd || nonGitCwd(),
		goalId: opts?.goalId,
	};
	if (opts?.projectId) {
		body.projectId = opts.projectId;
	} else {
		// Server requires an explicit project (or cwd matching a registered
		// project). Auto-inject the harness default projectId whenever the
		// caller didn't specify one — safe because the server prefers
		// projectId over cwd. Tests that deliberately exercise the 400 path
		// call apiFetch("/api/sessions", ...) directly and bypass this helper.
		const pid = await defaultProjectId();
		if (pid) body.projectId = pid;
	}
	// Retry on transient server 500s. Under heavy parallel test load the
	// server occasionally fails session creation with a 500 (e.g. worktree
	// setup contention, disk latency, or the Windows FS race where the
	// session-prompts state dir hasn't been created yet). The request is a
	// clean POST with no side effect on 500, so retry is safe.
	//
	// Bumped from 3 to 5 attempts with backoff to absorb persistent FS
	// contention under heavy parallel browser load, and we now capture and
	// surface the server's error body so a failed retry tells us *why*
	// instead of just "got 500".
	let resp: Response | undefined;
	let lastBody: string | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		resp = await apiFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (resp.status !== 500) break;
		try { lastBody = await resp.clone().text(); } catch { /* ignore */ }
		if (attempt === 4) break;
		try {
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(bobbitDir(), "state", "session-prompts"), { recursive: true });
		} catch { /* best-effort */ }
		await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
	}
	if (resp!.status !== 201) {
		// Surface the server-side error body in the assertion message so flaky
		// 500s can be diagnosed without a separate log dive.
		throw new Error(
			`createSession expected 201, got ${resp!.status}. body=${lastBody ?? "<empty>"}`,
		);
	}
	return (await resp!.json()).id;
}

/** Delete a session (best-effort, for cleanup). */
export async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Create a goal via REST, return the full goal object. Defaults cwd to a non-git temp dir. */
export async function createGoal(opts: {
	title: string;
	cwd?: string;
	spec?: string;
	team?: boolean;
	worktree?: boolean;
	workflowId?: string;
	autoStartTeam?: boolean;
	projectId?: string;
}): Promise<{ id: string; [k: string]: unknown }> {
	const body: Record<string, unknown> = { cwd: nonGitCwd(), worktree: false, ...opts };
	if (!body.projectId) {
		// Auto-inject harness default projectId when caller didn't specify one.
		// Server prefers projectId over cwd. Tests that exercise the 400 path
		// call apiFetch("/api/goals", ...) directly and bypass this helper.
		const pid = await defaultProjectId();
		if (pid) body.projectId = pid;
	}
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify(body),
	});
	expect(resp.status).toBe(201);
	return resp.json();
}

/** Delete a goal (best-effort, for cleanup). */
export async function deleteGoal(id: string): Promise<void> {
	await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Start a team for a goal, returns the team lead session ID. */
export async function startTeam(goalId: string): Promise<string> {
	const resp = await apiFetch(`/api/goals/${goalId}/team/start`, { method: "POST" });
	const data = await resp.json();
	if (resp.status >= 300) {
		throw new Error(`startTeam failed (${resp.status}): ${JSON.stringify(data)}`);
	}
	return data.sessionId;
}

/** Teardown a team (best-effort, for cleanup). */
export async function teardownTeam(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}/team/teardown`, { method: "POST" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Shared WebSocket helpers
// ---------------------------------------------------------------------------

export interface WsMsg { type: string; [key: string]: any }

export interface WsConnection {
	ws: WebSocket;
	messages: WsMsg[];
	/** Wait for a message matching predicate. Checks already-received messages first. */
	waitFor: (pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	/**
	 * Wait for a message matching predicate at or after `fromIndex`.
	 * Pattern: `const idx = ws.messageCount(); await doAction(); await ws.waitForFrom(idx, pred);`
	 * This is race-safe: if the event fires before the waiter registers, it's still matched.
	 */
	waitForFrom: (fromIndex: number, pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	/** Current message count — use as cursor for waitForFrom. */
	messageCount: () => number;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}

/** Connect & authenticate a WebSocket to a session. */
export function connectWs(sessionId: string): Promise<WsConnection> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase()}/ws/${sessionId}`);
		const messages: WsMsg[] = [];
		const waiters: Array<{ pred: (m: WsMsg) => boolean; res: (m: WsMsg) => void; rej: (e: Error) => void }> = [];

		ws.on("message", (raw) => {
			const msg: WsMsg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) {
					waiters[i].res(msg);
					waiters.splice(i, 1);
				}
			}
		});

		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: token() })));
		ws.on("error", reject);

		const iv = setInterval(() => {
			if (messages.some((m) => m.type === "auth_ok")) {
				clearInterval(iv);
				resolve({
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
						// Match messages at or after fromIndex. Use messageCount() to
						// capture the index BEFORE triggering an async action, then
						// waitForFrom(idx, ...) to wait for the resulting event.
						// Safe against race where event arrives before waiter registers.
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

/** Predicate: wait for a tool_execution_start event with the given tool name. */
export function toolStartPredicate(toolName: string): (m: WsMsg) => boolean {
	const lower = toolName.toLowerCase();
	return (m) =>
		m.type === "event" &&
		m.data?.type === "tool_execution_start" &&
		(m.data?.toolName || "").toLowerCase() === lower;
}

/** Predicate: wait for agent_end (turn finished). */
export function agentEndPredicate(): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "agent_end";
}

/** Predicate: wait for session_status with a specific status. */
export function statusPredicate(status: string): (m: WsMsg) => boolean {
	return (m) => m.type === "session_status" && m.status === status;
}

/** Predicate: wait for a queue_update with a specific queue length. */
export function queueLenPredicate(len: number): (m: WsMsg) => boolean {
	return (m) => m.type === "queue_update" && m.queue !== undefined && m.queue.length === len;
}

/** Predicate: wait for event > message_end with a specific role. */
export function messageEndPredicate(role: string): (m: WsMsg) => boolean {
	return (m) => m.type === "event" && m.data?.type === "message_end" && m.data?.message?.role === role;
}

// ---------------------------------------------------------------------------
// WebSocket gate helpers — faster than REST polling for gate status changes
// ---------------------------------------------------------------------------

/**
 * Signal a gate via REST and wait for it to reach the target status via WebSocket.
 *
 * Race-safe: captures the WS message cursor BEFORE the signal, so re-signals
 * correctly wait for the NEW event instead of matching a stale one in the buffer.
 *
 * Usage:
 *   await signalAndWaitForGate(ws, goalId, "design-doc", { content: "..." }, "passed");
 */
export async function signalAndWaitForGate(
	conn: WsConnection,
	goalId: string,
	gateId: string,
	body: Record<string, unknown>,
	targetStatus: string | string[],
	timeoutMs = 15_000,
): Promise<WsMsg> {
	const statuses = Array.isArray(targetStatus) ? targetStatus : [targetStatus];
	const cursor = conn.messageCount();
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`signal ${gateId} failed: ${res.status} ${text}`);
	}
	return conn.waitForFrom(
		cursor,
		(m) => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === gateId && statuses.includes(m.status),
		timeoutMs,
	);
}

// ---------------------------------------------------------------------------
// Polling helpers (Category 1: infrastructure readiness)
// ---------------------------------------------------------------------------

/**
 * Poll the health endpoint until the server is ready.
 * Replaces fixed `setTimeout` startup sleeps.
 */
export async function waitForHealth(timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await fetch(`${base()}/api/health`, {
				headers: { Authorization: `Bearer ${token()}` },
			});
			if (resp.ok) return;
		} catch {
			// Server not yet listening
		}
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Server did not become healthy within ${timeoutMs}ms`);
}

/**
 * Poll a session's status until it matches the target.
 * Replaces fixed `setTimeout` waits and manual poll loops.
 */
export async function waitForSessionStatus(
	sessionId: string,
	targetStatus: string,
	timeoutMs = 15_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const resp = await apiFetch(`/api/sessions/${sessionId}`);
			if (resp.ok) {
				const data = await resp.json();
				if (data.status === targetStatus) return;
			}
		} catch {
			// Session may not exist yet
		}
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`Session ${sessionId} did not reach "${targetStatus}" within ${timeoutMs}ms`);
}
