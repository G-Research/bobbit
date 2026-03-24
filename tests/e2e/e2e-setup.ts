/**
 * Shared E2E test helpers.
 *
 * The E2E test server runs with BOBBIT_DIR pointing to an isolated temp
 * directory so it doesn't pollute the real dev-server state under .bobbit/.
 *
 * Port and bobbit dir are set dynamically by playwright-e2e.config.ts via
 * process.env so parallel test runs on the same machine never collide.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import WebSocket from "ws";

/** Port the isolated E2E gateway is listening on (set by config via env). */
export const E2E_PORT = process.env.E2E_PORT || "3099";

/** HTTP base URL for the isolated E2E gateway. */
export const BASE = `http://127.0.0.1:${E2E_PORT}`;

/** WebSocket base URL for the isolated E2E gateway. */
export const WS_BASE = `ws://127.0.0.1:${E2E_PORT}`;

/** The isolated .bobbit directory used by the E2E test server. */
export const E2E_BOBBIT_DIR = process.env.BOBBIT_DIR
	|| join(import.meta.dirname, "..", "..", ".e2e-bobbit");

// Legacy alias for tests that still reference E2E_PI_DIR
export const E2E_PI_DIR = E2E_BOBBIT_DIR;

/** Read the auth token that the test server auto-created on startup. */
export function readE2EToken(): string {
	return readFileSync(join(E2E_BOBBIT_DIR, "state", "token"), "utf-8").trim();
}

// ---------------------------------------------------------------------------
// Shared REST helpers
// ---------------------------------------------------------------------------

let _token: string | undefined;

/** Lazily read and cache the E2E auth token. */
function token(): string {
	if (!_token) _token = readE2EToken();
	return _token;
}

/** Authenticated REST fetch against the E2E gateway. */
export function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

/** Create a session via REST, return its ID. */
export async function createSession(opts?: { cwd?: string; goalId?: string }): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: opts?.cwd || process.cwd(), goalId: opts?.goalId }),
	});
	expect(resp.status).toBe(201);
	return (await resp.json()).id;
}

/** Delete a session (best-effort, for cleanup). */
export async function deleteSession(id: string): Promise<void> {
	await apiFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
}

/** Create a goal via REST, return the full goal object. */
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
		body: JSON.stringify({ cwd: process.cwd(), worktree: false, ...opts }),
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
		const ws = new WebSocket(`${WS_BASE}/ws/${sessionId}`);
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
			const resp = await fetch(`${BASE}/api/health`, {
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
