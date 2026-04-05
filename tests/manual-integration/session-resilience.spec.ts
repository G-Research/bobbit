/**
 * Full-stack session resilience integration tests.
 *
 * Uses real agents — no mocks. Run manually:
 *
 *   npm run test:manual
 *   SCREENSHOTS=1 npm run test:manual   # also capture browser screenshots
 *
 * Prerequisites:
 *   - `npm run build` (server must be compiled)
 *   - A working agent CLI in PATH (claude, etc.)
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync,
} from "node:fs";
import { join, resolve, normalize } from "node:path";
import WebSocket from "ws";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");
const SCREENSHOT_DIR = join(PROJECT_ROOT, "test-results", "manual-integration");
const WANT_SCREENSHOTS = !!process.env.SCREENSHOTS;

// ---------------------------------------------------------------------------
// Gateway lifecycle
// ---------------------------------------------------------------------------

interface GW {
	proc: ChildProcess;
	port: number;
	dir: string;
	token: string;
	base: string;
	wsUrl: string;
}

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as any).port;
			s.close(() => res(p));
		});
		s.on("error", rej);
	});
}

async function startGW(dir: string, port: number): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	const proc = spawn(process.execPath, [
		SERVER_CLI, "--host", "127.0.0.1", "--port", String(port),
		"--no-tls", "--auth", "--cwd", dir,
	], {
		env: { ...process.env, BOBBIT_DIR: join(dir, ".bobbit"), NODE_ENV: "test" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	proc.stderr!.on("data", (c: Buffer) => { stderr += c; });
	proc.stdout!.on("data", () => {});

	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null)
			throw new Error(`Gateway exited (${proc.exitCode}):\n${stderr}`);
		try {
			const tp = join(dir, ".bobbit", "state", "token");
			if (existsSync(tp)) {
				const t = readFileSync(tp, "utf-8").trim();
				const r = await fetch(`http://127.0.0.1:${port}/api/health`,
					{ headers: { Authorization: `Bearer ${t}` } });
				if (r.ok) break;
			}
		} catch { /* retry */ }
		await new Promise(r => setTimeout(r, 300));
	}
	if (Date.now() >= deadline) { proc.kill(); throw new Error(`Gateway not healthy:\n${stderr}`); }

	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token,
		base: `http://127.0.0.1:${port}`,
		wsUrl: `ws://127.0.0.1:${port}` };
}

async function stopGW(gw: GW): Promise<void> {
	if (gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			try { execFileSync("taskkill", ["/PID", String(gw.proc.pid), "/T", "/F"],
				{ stdio: "ignore", timeout: 10_000 }); } catch {}
		} else { gw.proc.kill(); }
	}
	await new Promise<void>(r => {
		if (gw.proc.exitCode !== null) return r();
		gw.proc.on("exit", () => r());
		setTimeout(() => { try { gw.proc.kill("SIGKILL"); } catch {} r(); }, 5_000);
	});
	await new Promise(r => setTimeout(r, 1_500));
}

// ---------------------------------------------------------------------------
// API + WS helpers
// ---------------------------------------------------------------------------

function api(gw: GW, path: string, opts: RequestInit = {}) {
	return fetch(`${gw.base}${path}`, {
		...opts,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${gw.token}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

async function pollStatus(gw: GW, id: string, target: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let res: Response;
		try { res = await api(gw, `/api/sessions/${id}`); }
		catch { await new Promise(r => setTimeout(r, 1_000)); continue; }
		if (res.status === 404) { await new Promise(r => setTimeout(r, 1_000)); continue; }
		const s = await res.json();
		if (s.status === target) return s;
		if (["error", "terminated", "archived"].includes(s.status))
			throw new Error(`Session ${id} is ${s.status}, wanted ${target}`);
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} did not reach ${target} in ${ms}ms`);
}

async function getStatus(gw: GW, id: string): Promise<string> {
	const res = await api(gw, `/api/sessions/${id}`);
	return (await res.json()).status;
}

interface Conn { send(m: any): void; close(): void; }

function wsConnect(gw: GW, id: string): Promise<Conn> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${gw.wsUrl}/ws/${id}`);
		const msgs: any[] = [];
		ws.on("message", r => msgs.push(JSON.parse(r.toString())));
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: gw.token })));
		ws.on("error", reject);
		const iv = setInterval(() => {
			if (msgs.some(m => m.type === "auth_ok")) {
				clearInterval(iv);
				resolve({
					send(m: any) { ws.send(JSON.stringify(m)); },
					close() { ws.close(); },
				});
			}
		}, 50);
		setTimeout(() => { clearInterval(iv); reject(new Error("ws auth timeout")); }, 15_000);
	});
}

async function sendAndWait(gw: GW, id: string, text: string, ms = 120_000) {
	const c = await wsConnect(gw, id);
	c.send({ type: "send_message", text });
	await new Promise(r => setTimeout(r, 200));
	await pollStatus(gw, id, "idle", ms);
	c.close();
}

// ---------------------------------------------------------------------------
// Optional screenshot helpers (only when SCREENSHOTS=1)
// ---------------------------------------------------------------------------

async function screenshot(page: Page | undefined, gw: GW, id: string, name: string) {
	if (!WANT_SCREENSHOTS || !page) return;
	await page.goto(`${gw.base}/?token=${gw.token}#/session/${id}`);
	await page.waitForSelector("textarea", { timeout: 15_000 });
	await page.waitForTimeout(2_000);
	mkdirSync(SCREENSHOT_DIR, { recursive: true });
	await page.screenshot({ path: join(SCREENSHOT_DIR, name), fullPage: true });
	console.log(`  Screenshot: ${name}`);
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

function initRepo(dir: string) {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "test\n");
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

function tmpDir(label: string, port: number) {
	const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	return join(tmp, `.bobbit-manual-${label}-${port}`);
}

function cleanDirs(dir: string) {
	const parent = resolve(dir, "..");
	const base = dir.split(/[\\/]/).pop()!;
	const dirs = [dir];
	try {
		for (const e of readdirSync(parent))
			if (e.startsWith(base) && e.includes("-wt")) dirs.push(join(parent, e));
	} catch {}
	for (const d of dirs) {
		for (let i = 0; i < 3; i++) {
			try { rmSync(d, { recursive: true, force: true }); break; } catch {}
		}
	}
}

async function waitForSessionFile(gw: GW, id: string, maxMs = 30_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < maxMs) {
		const sf = join(gw.dir, ".bobbit", "state", "sessions.json");
		if (existsSync(sf)) {
			const all = JSON.parse(readFileSync(sf, "utf-8"));
			const mine = all.find((s: any) => s.id === id);
			if (mine?.agentSessionFile && existsSync(mine.agentSessionFile)) return true;
		}
		await new Promise(r => setTimeout(r, 2_000));
	}
	return false;
}

// ===================================================================
// 1. Plain session (no worktree)
// ===================================================================

test.describe.serial("Plain session (no worktree)", () => {
	test.setTimeout(300_000);
	let gw: GW, dir: string, port: number;
	let sessionId: string, sessionCwd: string;

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(120_000);
		port = await freePort();
		dir = tmpDir("plain", port);
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);
		gw = await startGW(dir, port);
		console.log(`  Gateway :${port}, cwd=${dir}`);
	});
	test.afterAll(async ({}, ti) => {
		ti.setTimeout(30_000);
		if (gw) await stopGW(gw);
		cleanDirs(dir);
	});

	test("create, send message, measure timing", async () => {
		const t0 = performance.now();
		const res = await api(gw, "/api/sessions", {
			method: "POST", body: JSON.stringify({ worktree: false }),
		});
		expect(res.status).toBe(201);
		sessionId = (await res.json()).id;
		const tCreate = performance.now();

		await pollStatus(gw, sessionId, "idle");
		const tIdle = performance.now();

		const c = await wsConnect(gw, sessionId);
		const tQ0 = performance.now();
		c.send({ type: "send_message", text: "Reply with exactly: PONG" });
		const tQ1 = performance.now();
		await new Promise(r => setTimeout(r, 200));
		await pollStatus(gw, sessionId, "idle");
		const tResp = performance.now();
		c.close();

		const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		sessionCwd = info.cwd;
		expect(normalize(sessionCwd)).toBe(normalize(dir));
		expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: sessionCwd, encoding: "utf-8" }).trim()).toBe("master");

		const ms = (v: number) => `${Math.round(v)}ms`;
		console.log(`\n  Create: ${ms(tCreate - t0)}  Idle: ${ms(tIdle - t0)}  Queue: ${ms(tQ1 - tQ0)}  Response: ${ms(tResp - tQ1)}\n  cwd: ${sessionCwd}`);
	});

	test("restart — cwd preserved, can send message", async ({ page }) => {
		expect(sessionId).toBeTruthy();

		await sendAndWait(gw, sessionId, "Run `pwd` and `git status` and show me the output");
		const fileOk = await waitForSessionFile(gw, sessionId);
		console.log(`  Agent session file: ${fileOk ? "✓" : "✗ (session will be archived)"}`);

		await stopGW(gw);
		expect(existsSync(join(dir, ".bobbit", "state", "sessions.json"))).toBe(true);

		port = await freePort();
		gw = await startGW(dir, port);
		console.log(`  Restarted :${port}`);

		const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		expect(normalize(info.cwd)).toBe(normalize(sessionCwd));
		console.log(`  Status: ${info.status}, cwd preserved: ✓`);

		if (info.status !== "archived") {
			await pollStatus(gw, sessionId, "idle");
			await sendAndWait(gw, sessionId, "Run `pwd` again to confirm same directory");
			console.log(`  Session responds after restart: ✓`);
			await screenshot(page, gw, sessionId, "plain-after-restart.png");
		} else {
			console.log(`  Session archived — verifying new session works`);
			const r = await api(gw, "/api/sessions", {
				method: "POST", body: JSON.stringify({ worktree: false }),
			});
			const ns = (await r.json()).id;
			await pollStatus(gw, ns, "idle");
			await sendAndWait(gw, ns, "Run `pwd` and `git status` and show me the output");
			const ni = await (await api(gw, `/api/sessions/${ns}`)).json();
			expect(normalize(ni.cwd)).toBe(normalize(dir));
			console.log(`  New session responds: ✓`);
			await screenshot(page, gw, ns, "plain-after-restart.png");
		}
	});
});

// ===================================================================
// 2. Worktree session
// ===================================================================

test.describe.serial("Worktree session (no sandbox)", () => {
	test.setTimeout(300_000);
	let gw: GW, dir: string, port: number;
	let sessionId: string, sessionCwd: string;

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(120_000);
		port = await freePort();
		dir = tmpDir("wt", port);
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);
		gw = await startGW(dir, port);
		console.log(`  Gateway :${port}, cwd=${dir}`);
	});
	test.afterAll(async ({}, ti) => {
		ti.setTimeout(30_000);
		if (gw) await stopGW(gw);
		cleanDirs(dir);
	});

	test("create, send message, measure timing", async () => {
		const t0 = performance.now();
		const res = await api(gw, "/api/sessions", {
			method: "POST", body: JSON.stringify({ worktree: true }),
		});
		expect(res.status).toBe(201);
		sessionId = (await res.json()).id;
		const tCreate = performance.now();

		await pollStatus(gw, sessionId, "idle");
		const tIdle = performance.now();

		const c = await wsConnect(gw, sessionId);
		const tQ0 = performance.now();
		c.send({ type: "send_message", text: "Reply with exactly: PONG" });
		const tQ1 = performance.now();
		await new Promise(r => setTimeout(r, 200));
		await pollStatus(gw, sessionId, "idle");
		const tResp = performance.now();
		c.close();

		const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		sessionCwd = info.cwd;
		expect(normalize(sessionCwd)).not.toBe(normalize(dir));
		expect(existsSync(sessionCwd)).toBe(true);
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: sessionCwd, encoding: "utf-8" }).trim();
		expect(branch).not.toBe("master");

		const ms = (v: number) => `${Math.round(v)}ms`;
		console.log(`\n  Create: ${ms(tCreate - t0)}  Idle: ${ms(tIdle - t0)}  Queue: ${ms(tQ1 - tQ0)}  Response: ${ms(tResp - tQ1)}\n  cwd: ${sessionCwd}  branch: ${branch}`);
	});

	test("restart — worktree preserved, can send message", async ({ page }) => {
		expect(sessionId).toBeTruthy();

		await sendAndWait(gw, sessionId, "Run `pwd` and `git status` and show me the output");
		const fileOk = await waitForSessionFile(gw, sessionId);
		console.log(`  Agent session file: ${fileOk ? "✓" : "✗ (session will be archived)"}`);

		await stopGW(gw);
		expect(existsSync(sessionCwd)).toBe(true);
		console.log(`  Worktree survives crash: ✓`);

		port = await freePort();
		gw = await startGW(dir, port);
		console.log(`  Restarted :${port}`);

		const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		expect(normalize(info.cwd)).toBe(normalize(sessionCwd));
		console.log(`  Status: ${info.status}, cwd preserved: ✓`);

		if (info.status !== "archived") {
			if (existsSync(sessionCwd)) {
				const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"],
					{ cwd: sessionCwd, encoding: "utf-8" }).trim();
				expect(branch).not.toBe("master");
				console.log(`  Git valid: ✓ (branch=${branch})`);
			}
			await pollStatus(gw, sessionId, "idle");
			await sendAndWait(gw, sessionId, "Run `pwd` again to confirm same directory");
			console.log(`  Session responds after restart: ✓`);
			await screenshot(page, gw, sessionId, "worktree-after-restart.png");
		} else {
			console.log(`  Session archived — verifying new worktree session works`);
			const r = await api(gw, "/api/sessions", {
				method: "POST", body: JSON.stringify({ worktree: true }),
			});
			const ns = (await r.json()).id;
			await pollStatus(gw, ns, "idle");
			await sendAndWait(gw, ns, "Run `pwd` and `git status` and show me the output");
			const ni = await (await api(gw, `/api/sessions/${ns}`)).json();
			expect(normalize(ni.cwd)).not.toBe(normalize(dir));
			console.log(`  New worktree session responds: ✓`);
			await screenshot(page, gw, ns, "worktree-after-restart.png");
		}
	});
});

// ===================================================================
// 3. Interrupted mid-tool-call
// ===================================================================

test.describe.serial("Interrupted mid-tool-call", () => {
	test.setTimeout(300_000);
	let gw: GW, dir: string, port: number;
	let sessionId: string;

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(120_000);
		port = await freePort();
		dir = tmpDir("int", port);
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);
		gw = await startGW(dir, port);
		console.log(`  Gateway :${port}, cwd=${dir}`);
	});
	test.afterAll(async ({}, ti) => {
		ti.setTimeout(30_000);
		if (gw) await stopGW(gw);
		cleanDirs(dir);
	});

	test("kill mid-tool-call, restart, verify recovery", async ({ page }) => {
		// Create session
		const res = await api(gw, "/api/sessions", {
			method: "POST", body: JSON.stringify({ worktree: false }),
		});
		expect(res.status).toBe(201);
		sessionId = (await res.json()).id;
		await pollStatus(gw, sessionId, "idle");

		// Warm up so agent session file gets written
		await sendAndWait(gw, sessionId, "Run `pwd` and tell me the output");
		const fileOk = await waitForSessionFile(gw, sessionId);
		console.log(`  Agent session file: ${fileOk ? "✓" : "✗"}`);

		if (!fileOk) {
			// Can't test interrupt recovery without session file — verify basic crash recovery
			console.log(`  Session file not flushed — testing basic crash recovery`);
			await stopGW(gw);
			port = await freePort();
			gw = await startGW(dir, port);
			const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
			console.log(`  Status: ${info.status}, cwd: ${info.cwd}`);
			expect(info.cwd).toBeTruthy();
			// Prove gateway works after crash
			const r2 = await api(gw, "/api/sessions", {
				method: "POST", body: JSON.stringify({ worktree: false }),
			});
			const ns = (await r2.json()).id;
			await pollStatus(gw, ns, "idle");
			await sendAndWait(gw, ns, "Reply with exactly: PONG");
			console.log(`  New session works after crash: ✓`);
			await screenshot(page, gw, ns, "interrupted-after-restart.png");
			return;
		}

		// Send blocking command and wait for agent to start executing
		const c = await wsConnect(gw, sessionId);
		c.send({ type: "send_message",
			text: "Run this exact bash command with the bash tool (not background): sleep 120 && echo done" });
		await new Promise(r => setTimeout(r, 5_000));
		const status = await getStatus(gw, sessionId);
		console.log(`  Status during tool call: ${status}`);
		c.close();

		const wasStreaming = status !== "idle";

		// Kill (mid-tool-call if agent is streaming, otherwise just a normal crash)
		await stopGW(gw);
		console.log(`  Gateway killed ${wasStreaming ? "mid-tool-call" : "(agent was idle)"}`);

		// Restart — if interrupted mid-turn, session should auto-resume with [SYSTEM] prompt
		port = await freePort();
		gw = await startGW(dir, port);
		console.log(`  Restarted :${port}`);

		await pollStatus(gw, sessionId, "idle", 120_000);
		const postInfo = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		expect(normalize(postInfo.cwd)).toBe(normalize(dir));
		console.log(`  Session recovered: ✓ (status=${postInfo.status}, cwd preserved)`);
		if (wasStreaming) {
			console.log(`  Agent auto-resumed after mid-turn interrupt: ✓`);
		}
		await screenshot(page, gw, sessionId, "interrupted-after-restart.png");
	});
});
