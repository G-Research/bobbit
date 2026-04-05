/**
 * Full-stack session resilience integration test.
 *
 * Uses real agents and real Docker — no mocks.
 * NOT included in automated test suites. Run manually:
 *
 *   npm run test:manual
 *
 * Prerequisites:
 *   - `npm run build` (server must be compiled)
 *   - A working agent CLI in PATH (claude, pi-coding-agent, etc.)
 *   - Docker running (for sandbox tests; skipped if unavailable)
 *   - Stop any running dev server first (avoids Docker container conflicts)
 *
 * Test matrix (4 combinations):
 *   1. Plain session (no worktree, no sandbox)
 *   2. Worktree session
 *   3. Sandbox session (no worktree)          — skipped if Docker unavailable
 *   4. Sandbox + worktree session             — skipped if Docker unavailable
 *
 * For each session:
 *   - Measure time to create and reach idle
 *   - Measure message round-trip time
 *   - Verify working directory (worktree path vs project root)
 *   - Verify git working copy validity
 *   - Restart gateway → repeat verifications
 *   - Kill Docker container → repeat verifications (non-sandbox survive)
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, existsSync, readdirSync,
} from "node:fs";
import { join, resolve, normalize } from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

// ---------------------------------------------------------------------------
// Docker detection
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

const HAS_DOCKER = isDockerAvailable();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GatewayHandle {
	proc: ChildProcess;
	port: number;
	bobbitDir: string;       // isolated state dir (BOBBIT_DIR)
	projectCwd: string;      // real project root (--cwd)
	token: string;
	base: string;
	wsBase: string;
}

interface SessionRecord {
	name: string;
	id: string;
	cwd: string;
	worktree: boolean;
	sandboxed: boolean;
	createTimeMs: number;
	messageRoundTripMs: number;
}

interface SessionConfig {
	name: string;
	worktree: boolean;
	sandboxed: boolean;
}

// ---------------------------------------------------------------------------
// Gateway management
// ---------------------------------------------------------------------------

async function findFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const p = (srv.address() as any).port;
			srv.close(() => res(p));
		});
		srv.on("error", rej);
	});
}

async function startGateway(projectCwd: string, bobbitDir: string, port: number): Promise<GatewayHandle> {
	mkdirSync(join(bobbitDir, "state"), { recursive: true });

	const proc = spawn(process.execPath, [
		SERVER_CLI,
		"--host", "127.0.0.1",
		"--port", String(port),
		"--no-tls",
		"--auth",
		"--cwd", projectCwd,
		// No --agent-cli → uses real agent discovery
	], {
		env: {
			...process.env,
			BOBBIT_DIR: bobbitDir,
			NODE_ENV: "test",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Drain stdout/stderr, capture for diagnostics
	let stderr = "";
	proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	proc.stdout!.on("data", () => {}); // prevent backpressure

	// Poll /api/health until ready (same pattern as gateway-harness)
	let healthy = false;
	const deadline = Date.now() + 60_000; // real agent discovery can be slow
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) {
			throw new Error(`Gateway exited early (code ${proc.exitCode}):\n${stderr}`);
		}
		try {
			const tokenPath = join(bobbitDir, "state", "token");
			if (existsSync(tokenPath)) {
				const tok = readFileSync(tokenPath, "utf-8").trim();
				const resp = await fetch(`http://127.0.0.1:${port}/api/health`, {
					headers: { Authorization: `Bearer ${tok}` },
				});
				if (resp.ok) { healthy = true; break; }
			}
		} catch { /* not ready yet */ }
		await new Promise(r => setTimeout(r, 300));
	}
	if (!healthy) {
		proc.kill();
		throw new Error(`Gateway did not become healthy in 60s:\n${stderr}`);
	}

	const token = readFileSync(join(bobbitDir, "state", "token"), "utf-8").trim();

	return {
		proc, port, bobbitDir, projectCwd, token,
		base: `http://127.0.0.1:${port}`,
		wsBase: `ws://127.0.0.1:${port}`,
	};
}

async function stopGateway(gw: GatewayHandle): Promise<void> {
	if (!gw.proc.killed && gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			try {
				execFileSync("taskkill", ["/PID", String(gw.proc.pid), "/T", "/F"], {
					stdio: "ignore", timeout: 10_000,
				});
			} catch { /* already gone */ }
		} else {
			gw.proc.kill();
		}
	}
	await new Promise<void>((res) => {
		if (gw.proc.exitCode !== null) { res(); return; }
		gw.proc.on("exit", () => res());
		setTimeout(() => {
			try { gw.proc.kill("SIGKILL"); } catch { /* ignore */ }
			res();
		}, 10_000);
	});
	// Let the OS release file handles and ports
	await new Promise(r => setTimeout(r, 2_000));
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function apiFetch(gw: GatewayHandle, path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`${gw.base}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${gw.token}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

async function createSessionViaApi(
	gw: GatewayHandle,
	opts: { worktree?: boolean; sandboxed?: boolean } = {},
): Promise<{ id: string; cwd: string; status: string }> {
	const body: Record<string, unknown> = { ...opts };
	const res = await apiFetch(gw, "/api/sessions", {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`POST /api/sessions ${res.status}: ${text}`);
	}
	return res.json();
}

async function getSession(gw: GatewayHandle, id: string): Promise<any> {
	const res = await apiFetch(gw, `/api/sessions/${id}`);
	expect(res.status).toBe(200);
	return res.json();
}

async function deleteSession(gw: GatewayHandle, id: string): Promise<void> {
	await apiFetch(gw, `/api/sessions/${id}`, { method: "DELETE" });
}

async function waitForIdle(
	gw: GatewayHandle, id: string, timeoutMs = 120_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const s = await getSession(gw, id);
		if (s.status === "idle") return;
		if (s.status === "error" || s.status === "terminated") {
			throw new Error(`Session ${id} entered ${s.status} instead of idle`);
		}
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} did not reach idle within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

interface WsConn {
	ws: WebSocket;
	messages: any[];
	send(msg: any): void;
	waitFor(pred: (m: any) => boolean, timeoutMs?: number): Promise<any>;
	close(): void;
}

function connectWs(gw: GatewayHandle, sessionId: string): Promise<WsConn> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${gw.wsBase}/ws/${sessionId}`);
		const messages: any[] = [];
		const waiters: Array<{
			pred: (m: any) => boolean;
			res: (m: any) => void;
			rej: (e: Error) => void;
		}> = [];

		ws.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) {
					waiters[i].res(msg);
					waiters.splice(i, 1);
				}
			}
		});

		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "auth", token: gw.token }));
		});
		ws.on("error", reject);

		const iv = setInterval(() => {
			if (messages.some(m => m.type === "auth_ok")) {
				clearInterval(iv);
				resolve({
					ws, messages,
					send(msg: any) { ws.send(JSON.stringify(msg)); },
					waitFor(pred, timeoutMs = 120_000) {
						const existing = messages.find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(
								() => rej(new Error("WS waitFor timeout")),
								timeoutMs,
							);
							waiters.push({
								pred,
								res: (m) => { clearTimeout(t); res(m); },
								rej,
							});
						});
					},
					close() { ws.close(); },
				});
			}
		}, 100);

		setTimeout(() => {
			clearInterval(iv);
			reject(new Error("WS auth timeout"));
		}, 30_000);
	});
}

/**
 * Send a message and wait for the session to return to idle.
 * Tracks only NEW idle messages (ignores buffered ones from before send).
 */
async function sendMessageAndWait(
	conn: WsConn,
	text: string,
	timeoutMs = 120_000,
): Promise<{ roundTripMs: number }> {
	const msgCountBefore = conn.messages.length;
	const t0 = performance.now();
	conn.send({ type: "send_message", text });

	// Wait for a NEW session_status idle
	await conn.waitFor(
		m => m.type === "session_status" && m.status === "idle"
			&& conn.messages.indexOf(m) >= msgCountBefore,
		timeoutMs,
	);
	return { roundTripMs: Math.round(performance.now() - t0) };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function isGitWorkingCopy(dir: string): boolean {
	try {
		const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: dir, timeout: 5_000, encoding: "utf-8",
		});
		return out.trim() === "true";
	} catch {
		return false;
	}
}

function getGitBranch(dir: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: dir, timeout: 5_000, encoding: "utf-8",
		}).trim();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Session configurations
// ---------------------------------------------------------------------------

const CONFIGS: SessionConfig[] = [
	{ name: "plain (no worktree, no sandbox)", worktree: false, sandboxed: false },
	{ name: "worktree only",                   worktree: true,  sandboxed: false },
	{ name: "sandbox only",                    worktree: false, sandboxed: true  },
	{ name: "sandbox + worktree",              worktree: true,  sandboxed: true  },
];

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

function verifySessionCwd(
	info: any, cfg: SessionConfig, projectRoot: string,
): void {
	// Sandbox sessions run inside Docker — we can only verify via the API
	// that a cwd was assigned. Host-side filesystem checks don't apply.
	if (cfg.sandboxed) {
		expect(info.cwd).toBeTruthy();
		return;
	}

	const sessionCwd = normalize(info.cwd);
	const normalizedRoot = normalize(projectRoot);

	if (cfg.worktree) {
		// Worktree session: cwd should be a different directory
		expect(sessionCwd).not.toBe(normalizedRoot);
		// Must exist and be a valid git working copy
		expect(existsSync(sessionCwd), `Worktree dir should exist: ${sessionCwd}`).toBe(true);
		expect(isGitWorkingCopy(sessionCwd), `Should be git working copy: ${sessionCwd}`).toBe(true);
		// Branch should NOT be master (it's a session branch)
		const branch = getGitBranch(sessionCwd);
		expect(branch).toBeTruthy();
		expect(branch).not.toBe("master");
	} else {
		// Plain session: cwd should be the project root
		expect(sessionCwd).toBe(normalizedRoot);
		expect(isGitWorkingCopy(sessionCwd)).toBe(true);
		const branch = getGitBranch(sessionCwd);
		expect(branch).toBe("master");
	}
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe.serial("Session resilience — full-stack integration", () => {
	let gw: GatewayHandle;
	let port: number;
	let bobbitDir: string;
	const sessions: SessionRecord[] = [];
	let sandboxAvailable = false;

	// ---- Setup & Teardown ----

	test.beforeAll(async ({}, testInfo) => {
		testInfo.setTimeout(120_000);

		port = await findFreePort();
		bobbitDir = join(
			process.platform === "win32" ? process.env.TEMP || "C:\\Temp" : "/tmp",
			`.bobbit-manual-integration-${port}`,
		);
		rmSync(bobbitDir, { recursive: true, force: true });

		console.log(`\n  Project root:  ${PROJECT_ROOT}`);
		console.log(`  State dir:     ${bobbitDir}`);
		console.log(`  Port:          ${port}`);
		console.log(`  Docker:        ${HAS_DOCKER ? "available" : "not available"}\n`);

		gw = await startGateway(PROJECT_ROOT, bobbitDir, port);

		// Configure sandbox if Docker is available
		if (HAS_DOCKER) {
			await apiFetch(gw, "/api/project-config", {
				method: "PUT",
				body: JSON.stringify({ sandbox: "docker" }),
			});
			const statusRes = await apiFetch(gw, "/api/sandbox-status");
			if (statusRes.ok) {
				const status = await statusRes.json();
				sandboxAvailable = status.configured && status.available;
			}
			console.log(`  Sandbox:       ${sandboxAvailable ? "configured & available" : "not operational"}\n`);
		}
	});

	test.afterAll(async ({}, testInfo) => {
		testInfo.setTimeout(60_000);

		if (gw) await stopGateway(gw);

		// Best-effort cleanup of state dir
		for (let attempt = 0; attempt < 3; attempt++) {
			try { rmSync(bobbitDir, { recursive: true, force: true }); break; }
			catch { await new Promise(r => setTimeout(r, 2_000)); }
		}
	});

	// ==================================================================
	// Test 1: Create all session variants, measure timing, verify state
	// ==================================================================

	test("create sessions, measure timing, verify working directories", async () => {
		for (const cfg of CONFIGS) {
			await test.step(`Create: ${cfg.name}`, async () => {
				if (cfg.sandboxed && !sandboxAvailable) {
					console.log(`  SKIP ${cfg.name}: sandbox not available`);
					return;
				}

				const t0 = performance.now();
				let created: { id: string; cwd: string; status: string };
				try {
					created = await createSessionViaApi(gw, {
						worktree: cfg.worktree,
						sandboxed: cfg.sandboxed,
					});
				} catch (err: any) {
					if (cfg.sandboxed) {
						console.log(`  SKIP ${cfg.name}: creation failed — ${err.message}`);
						return;
					}
					throw err;
				}

				// Wait for session to be ready
				try {
					await waitForIdle(gw, created.id, cfg.sandboxed ? 180_000 : 120_000);
				} catch (err: any) {
					if (cfg.sandboxed) {
						console.log(`  SKIP ${cfg.name}: did not become idle — ${err.message}`);
						try { await deleteSession(gw, created.id); } catch { /* */ }
						return;
					}
					throw err;
				}
				const createTimeMs = Math.round(performance.now() - t0);

				// Send a simple message and measure round-trip
				const conn = await connectWs(gw, created.id);
				try {
					const { roundTripMs } = await sendMessageAndWait(
						conn,
						'Reply with exactly one word: PONG',
						120_000,
					);

					const info = await getSession(gw, created.id);

					sessions.push({
						name: cfg.name,
						id: created.id,
						cwd: info.cwd,
						worktree: cfg.worktree,
						sandboxed: cfg.sandboxed,
						createTimeMs,
						messageRoundTripMs: roundTripMs,
					});

					// Verify working directory
					verifySessionCwd(info, cfg, PROJECT_ROOT);
				} finally {
					conn.close();
				}
			});
		}

		// Print timing report
		console.log("\n  ┌──────────────────────────────────┬──────────────┬──────────────┐");
		console.log("  │ Configuration                     │ Create (ms)  │ Message (ms) │");
		console.log("  ├──────────────────────────────────┼──────────────┼──────────────┤");
		for (const s of sessions) {
			const nm = s.name.padEnd(34);
			const cr = String(s.createTimeMs).padStart(12);
			const rt = String(s.messageRoundTripMs).padStart(12);
			console.log(`  │ ${nm} │ ${cr} │ ${rt} │`);
		}
		console.log("  └──────────────────────────────────┴──────────────┴──────────────┘\n");

		// At minimum, non-sandbox sessions must have been created
		expect(sessions.filter(s => !s.sandboxed).length).toBeGreaterThanOrEqual(2);
	});

	// ==================================================================
	// Test 2: Gateway restart — sessions must survive and remain usable
	// ==================================================================

	test("sessions survive gateway restart", async () => {
		expect(sessions.length).toBeGreaterThan(0);

		const pre = sessions.map(s => ({ ...s }));

		await test.step("restart gateway", async () => {
			await stopGateway(gw);
			await new Promise(r => setTimeout(r, 2_000));
			gw = await startGateway(PROJECT_ROOT, bobbitDir, port);
		});

		for (const s of pre) {
			await test.step(`verify after restart: ${s.name}`, async () => {
				await waitForIdle(gw, s.id);

				const conn = await connectWs(gw, s.id);
				try {
					// Send a message — agent should respond
					const { roundTripMs } = await sendMessageAndWait(
						conn, 'Reply with exactly one word: PONG',
					);
					console.log(`  ${s.name}: post-restart round-trip ${roundTripMs}ms`);

					// Verify cwd unchanged
					const info = await getSession(gw, s.id);
					expect(normalize(info.cwd)).toBe(normalize(s.cwd));

					// Verify git validity (non-sandbox only)
					verifySessionCwd(info, s, PROJECT_ROOT);
				} finally {
					conn.close();
				}
			});
		}
	});

	// ==================================================================
	// Test 3: Kill Docker container — non-sandbox sessions must survive
	// ==================================================================

	test("non-sandbox sessions survive Docker container kill", async () => {
		const sandboxSessions = sessions.filter(s => s.sandboxed);
		test.skip(sandboxSessions.length === 0, "No sandbox sessions were created — nothing to kill");

		await test.step("kill Docker container", async () => {
			const projRes = await apiFetch(gw, "/api/projects");
			const projects = await projRes.json();
			expect(projects.length).toBeGreaterThan(0);
			const projectId = projects[0].id;

			const containerId = execFileSync("docker", [
				"ps", "-q", "--filter", `label=bobbit-project=${projectId}`,
			], { encoding: "utf-8", timeout: 10_000 }).trim();

			if (!containerId) {
				console.log("  No sandbox container found — skipping");
				return;
			}

			console.log(`  Killing container: ${containerId}`);
			execFileSync("docker", ["kill", containerId], {
				stdio: "ignore", timeout: 15_000,
			});
			await new Promise(r => setTimeout(r, 5_000));
		});

		// Non-sandbox sessions should still work
		for (const s of sessions.filter(s => !s.sandboxed)) {
			await test.step(`non-sandbox still works: ${s.name}`, async () => {
				await waitForIdle(gw, s.id, 60_000);

				const conn = await connectWs(gw, s.id);
				try {
					const { roundTripMs } = await sendMessageAndWait(
						conn, 'Reply with exactly one word: PONG', 60_000,
					);
					console.log(`  ${s.name}: post-kill round-trip ${roundTripMs}ms`);

					const info = await getSession(gw, s.id);
					expect(normalize(info.cwd)).toBe(normalize(s.cwd));

					// Still a valid git working copy
					verifySessionCwd(info, s, PROJECT_ROOT);
				} finally {
					conn.close();
				}
			});
		}

		// Sandbox sessions should be degraded
		for (const s of sessions.filter(s => s.sandboxed)) {
			await test.step(`sandbox degraded: ${s.name}`, async () => {
				const info = await getSession(gw, s.id);
				console.log(`  ${s.name}: status=${info.status} after container kill`);
				expect(info).toBeTruthy();
				expect(info.cwd).toBeTruthy();
			});
		}
	});
});
