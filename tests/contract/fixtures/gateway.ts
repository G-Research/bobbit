/**
 * Tier 2 "contract" test fixture — fresh in-process gateway per test.
 *
 * Each call to createTestGateway() spins up a gateway in ~35ms. Tests get
 * direct access to sessionManager, stores, and HTTP/WS helpers. Cleanup via
 * `await using`.
 *
 * Design principles:
 *   - Each test gets its own gateway instance (isolation)
 *   - Imports are lazy-loaded once per process (amortised startup)
 *   - No spawning (no child processes, no browsers)
 *   - Minimal state: temp dir gets a fresh BOBBIT_DIR
 *   - Cheap: ~35ms setup + ~60ms shutdown
 *
 * For tests that need HTTP/WS (most do), pass { startHttp: true }.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

let serverModules: any = null;
async function getServerModules() {
	if (serverModules) return serverModules;
	const [bd, sc, tok, srv] = await Promise.all([
		import("../../../dist/server/bobbit-dir.js"),
		import("../../../dist/server/scaffold.js"),
		import("../../../dist/server/auth/token.js"),
		import("../../../dist/server/server.js"),
	]);
	serverModules = {
		setProjectRoot: bd.setProjectRoot,
		scaffoldBobbitDir: sc.scaffoldBobbitDir,
		loadOrCreateToken: tok.loadOrCreateToken,
		createGateway: srv.createGateway,
	};
	return serverModules;
}

export interface WsMsg { type: string; [key: string]: any }

export interface WsHandle {
	messages: WsMsg[];
	waitFor: (pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	waitForFrom: (fromIndex: number, pred: (m: WsMsg) => boolean, timeoutMs?: number) => Promise<WsMsg>;
	messageCount: () => number;
	send: (msg: Record<string, unknown>) => void;
	close: () => void;
}

export interface TestGateway {
	gw: any;
	dir: string;
	sessionManager: any;
	token: string;
	/** HTTP base URL — only set if startHttp was true. */
	baseURL: string;

	// ── Convenience helpers that call HTTP APIs on this gateway ──

	/** Raw authenticated fetch against this gateway. */
	fetch(path: string, opts?: { method?: string; body?: any }): Promise<{ status: number; body: any }>;
	/** Create a goal. */
	createGoal(opts: {
		title: string;
		cwd?: string;
		spec?: string;
		team?: boolean;
		worktree?: boolean;
		workflowId?: string;
		autoStartTeam?: boolean;
	}): Promise<{ id: string; [k: string]: any }>;
	/** Delete a goal (best-effort). */
	deleteGoal(id: string): Promise<void>;
	/** Create a session. */
	createSession(opts?: { cwd?: string; goalId?: string }): Promise<string>;
	/** Delete a session (best-effort). */
	deleteSession(id: string): Promise<void>;
	/** Signal a gate with optional content/metadata. */
	signalGate(goalId: string, gateId: string, body?: { content?: string; metadata?: Record<string, string>; [k: string]: any }): Promise<{ status: number; body: any }>;
	/** Get the current status of a gate. */
	getGate(goalId: string, gateId: string): Promise<any>;
	/** Wait for a gate to reach a target status. */
	waitForGateStatus(goalId: string, gateId: string, status: string | string[], timeoutMs?: number): Promise<any>;
	/** Open a WebSocket connection authenticated as this gateway's session. */
	connectWs(sessionId: string): Promise<WsHandle>;

	[Symbol.asyncDispose]: () => Promise<void>;
}

/** Create a fresh in-process gateway for a single test. */
export async function createTestGateway(opts?: {
	startHttp?: boolean;
	agentCliPath?: string;
}): Promise<TestGateway> {
	const startHttp = opts?.startHttp ?? true;
	const dir = join(tmpdir(), `tier2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(dir, "state"), { recursive: true });
	writeFileSync(join(dir, "state", "projects.json"), "[]");
	writeFileSync(join(dir, "state", "setup-complete"), "tier2\n");

	process.env.BOBBIT_DIR = dir;
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";

	const { setProjectRoot, scaffoldBobbitDir, loadOrCreateToken, createGateway } = await getServerModules();

	setProjectRoot(dir);
	scaffoldBobbitDir(dir);
	const token = loadOrCreateToken();

	const defaultAgent = join(process.cwd(), "tests", "e2e", "mock-agent.mjs");
	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: dir,
		forceAuth: true,
		agentCliPath: opts?.agentCliPath ?? defaultAgent,
	});

	let baseURL = "";
	let wsBase = "";
	if (startHttp) {
		const port = await gw.start();
		baseURL = `http://127.0.0.1:${port}`;
		wsBase = `ws://127.0.0.1:${port}`;
	}

	async function doFetch(path: string, opts: { method?: string; body?: any } = {}): Promise<{ status: number; body: any }> {
		const res = await fetch(`${baseURL}${path}`, {
			method: opts.method || "GET",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : null };
	}

	async function connectWs(sessionId: string): Promise<WsHandle> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`${wsBase}/ws/${sessionId}`);
			const messages: WsMsg[] = [];
			const waiters: Array<{ pred: (m: WsMsg) => boolean; fromIndex: number; res: (m: WsMsg) => void; rej: (e: Error) => void }> = [];

			ws.on("message", (raw) => {
				const msg: WsMsg = JSON.parse(raw.toString());
				messages.push(msg);
				for (let i = waiters.length - 1; i >= 0; i--) {
					const w = waiters[i];
					if (w.pred(msg)) {
						w.res(msg);
						waiters.splice(i, 1);
					}
				}
			});
			ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
			ws.on("error", reject);

			const iv = setInterval(() => {
				if (messages.some((m) => m.type === "auth_ok")) {
					clearInterval(iv);
					resolve({
						messages,
						messageCount: () => messages.length,
						waitFor(pred, timeoutMs = 10_000) {
							const existing = messages.find(pred);
							if (existing) return Promise.resolve(existing);
							return new Promise((res, rej) => {
								const t = setTimeout(() => rej(new Error(`WS waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
								waiters.push({ pred, fromIndex: 0, res: (m) => { clearTimeout(t); res(m); }, rej });
							});
						},
						waitForFrom(fromIndex, pred, timeoutMs = 10_000) {
							const existing = messages.slice(fromIndex).find(pred);
							if (existing) return Promise.resolve(existing);
							return new Promise((res, rej) => {
								const t = setTimeout(() => rej(new Error(`WS waitForFrom timed out (${timeoutMs}ms)`)), timeoutMs);
								waiters.push({ pred, fromIndex, res: (m) => { clearTimeout(t); res(m); }, rej });
							});
						},
						send: (m) => ws.send(JSON.stringify(m)),
						close: () => ws.close(),
					});
				}
			}, 10);

			setTimeout(() => { clearInterval(iv); reject(new Error("WS auth timeout")); }, 5_000);
		});
	}

	const tg: TestGateway = {
		gw,
		dir,
		sessionManager: gw.sessionManager,
		token,
		baseURL,
		fetch: doFetch,

		async createGoal(opts) {
			const res = await doFetch("/api/goals", {
				method: "POST",
				body: { cwd: dir, worktree: false, ...opts },
			});
			if (res.status !== 201) throw new Error(`createGoal failed (${res.status}): ${JSON.stringify(res.body)}`);
			return res.body;
		},

		async deleteGoal(id) {
			await doFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
		},

		async createSession(opts) {
			const res = await doFetch("/api/sessions", {
				method: "POST",
				body: { cwd: opts?.cwd ?? dir, goalId: opts?.goalId },
			});
			if (res.status !== 201) throw new Error(`createSession failed (${res.status}): ${JSON.stringify(res.body)}`);
			return res.body.id;
		},

		async deleteSession(id) {
			await doFetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
		},

		async signalGate(goalId, gateId, body = {}) {
			return doFetch(`/api/goals/${goalId}/gates/${gateId}/signal`, {
				method: "POST",
				body,
			});
		},

		async getGate(goalId, gateId) {
			const res = await doFetch(`/api/goals/${goalId}/gates/${gateId}`);
			return res.body;
		},

		async waitForGateStatus(goalId, gateId, status, timeoutMs = 5_000) {
			const targets = Array.isArray(status) ? status : [status];
			const start = Date.now();
			while (Date.now() - start < timeoutMs) {
				const gate = await tg.getGate(goalId, gateId);
				if (gate?.status && targets.includes(gate.status)) return gate;
				await new Promise(r => setTimeout(r, 20));
			}
			const final = await tg.getGate(goalId, gateId);
			throw new Error(`Gate ${gateId} did not reach ${targets.join("|")} in ${timeoutMs}ms (last: ${final?.status})`);
		},

		connectWs,

		async [Symbol.asyncDispose]() {
			try { await gw.shutdown(); } catch { /* best-effort */ }
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
		},
	};

	return tg;
}
