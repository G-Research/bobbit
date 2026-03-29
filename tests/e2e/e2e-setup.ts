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

/** Read the auth token that the test server auto-created on startup. */
export function readE2EToken(): string {
	return readFileSync(join(bobbitDir(), "state", "token"), "utf-8").trim();
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

/** Authenticated REST fetch against the E2E gateway. */
export function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${base()}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

/** Create a session via REST, return its ID. Defaults cwd to a non-git temp dir. */
export async function createSession(opts?: { cwd?: string; goalId?: string }): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: opts?.cwd || nonGitCwd(), goalId: opts?.goalId }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
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
}): Promise<{ id: string; [k: string]: unknown }> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), worktree: false, ...opts }),
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
