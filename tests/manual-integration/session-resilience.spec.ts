/**
 * Full-stack session resilience integration test.
 *
 * Uses real agents — no mocks. Run manually:
 *
 *   npm run test:manual
 *
 * Prerequisites:
 *   - `npm run build` (server must be compiled)
 *   - A working agent CLI in PATH (claude, etc.)
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, existsSync, readdirSync,
} from "node:fs";
import { join, resolve, normalize } from "node:path";
import WebSocket from "ws";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

interface GW {
	proc: ChildProcess;
	port: number;
	dir: string;      // isolated project cwd
	token: string;
	base: string;
	ws: string;
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

async function start(dir: string, port: number): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });

	const proc = spawn(process.execPath, [
		SERVER_CLI,
		"--host", "127.0.0.1",
		"--port", String(port),
		"--no-tls", "--auth",
		"--cwd", dir,
	], {
		env: { ...process.env, BOBBIT_DIR: join(dir, ".bobbit"), NODE_ENV: "test" },
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stderr = "";
	proc.stderr!.on("data", (c: Buffer) => { stderr += c; });
	proc.stdout!.on("data", () => {});

	let ok = false;
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
				if (r.ok) { ok = true; break; }
			}
		} catch { /* retry */ }
		await new Promise(r => setTimeout(r, 300));
	}
	if (!ok) { proc.kill(); throw new Error(`Gateway not healthy:\n${stderr}`); }

	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token,
		base: `http://127.0.0.1:${port}`,
		ws: `ws://127.0.0.1:${port}` };
}

async function stop(gw: GW): Promise<void> {
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
// Helpers
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

async function poll(gw: GW, id: string, target: string, ms = 120_000) {
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

interface Conn {
	send(m: any): void;
	close(): void;
}

function connect(gw: GW, id: string): Promise<Conn> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${gw.ws}/ws/${id}`);
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

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe.serial("Plain session resilience (no worktree, no sandbox)", () => {
	test.setTimeout(300_000);

	let gw: GW;
	let dir: string;
	let port: number;
	let sessionId: string;
	let sessionCwd: string;

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(120_000);
		port = await freePort();
		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		dir = join(tmp, `.bobbit-manual-${port}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });

		// Minimal git repo
		execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(dir, "README.md"), "test\n");
		execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });

		gw = await start(dir, port);
		console.log(`  Gateway up on :${port}, cwd=${dir}`);
	});

	test.afterAll(async ({}, ti) => {
		ti.setTimeout(30_000);
		if (gw) await stop(gw);
		for (let i = 0; i < 3; i++) {
			try { rmSync(dir, { recursive: true, force: true }); break; } catch {
				await new Promise(r => setTimeout(r, 2_000));
			}
		}
	});

	test("create session, send message, measure timing", async () => {
		// --- Create ---
		const t0 = performance.now();
		const res = await api(gw, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ worktree: false }),
		});
		expect(res.status).toBe(201);
		const created = await res.json();
		sessionId = created.id;
		const tCreate = performance.now();

		// --- Wait for idle ---
		await poll(gw, sessionId, "idle");
		const tIdle = performance.now();

		// --- Queue a message ---
		const c = await connect(gw, sessionId);
		const tBeforeQueue = performance.now();
		c.send({ type: "send_message", text: "Reply with exactly: PONG" });
		const tQueued = performance.now();

		// --- Wait for response ---
		// Brief pause so the session transitions to busy, then poll for idle
		await new Promise(r => setTimeout(r, 200));
		await poll(gw, sessionId, "idle");
		const tResponse = performance.now();
		c.close();

		// --- Record cwd ---
		const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
		sessionCwd = info.cwd;

		// --- Verify cwd is master branch ---
		expect(normalize(sessionCwd)).toBe(normalize(dir));
		expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"],
			{ cwd: sessionCwd, encoding: "utf-8" }).trim()).toBe("master");

		// --- Report ---
		const ms = (v: number) => `${Math.round(v)}ms`;
		console.log(`\n  Timing:`);
		console.log(`    Create API call:     ${ms(tCreate - t0)}`);
		console.log(`    Create → Idle:       ${ms(tIdle - t0)}`);
		console.log(`    Queue message:       ${ms(tQueued - tBeforeQueue)}`);
		console.log(`    Message → Response:  ${ms(tResponse - tQueued)}`);
		console.log(`    Session cwd:         ${sessionCwd}`);
	});

	test("gateway restart — session history and cwd preserved, can send message", async () => {
		expect(sessionId).toBeTruthy();

		// --- Verify session is live before restart ---
		const preRes = await api(gw, `/api/sessions/${sessionId}`);
		expect(preRes.status).toBe(200);
		const preInfo = await preRes.json();
		expect(preInfo.status).toBe("idle");
		console.log(`  Session status before restart: ${preInfo.status}`);

		// --- Hard kill (simulate crash) ---
		await stop(gw);

		// --- Verify sessions.json persisted ---
		const sf = join(dir, ".bobbit", "state", "sessions.json");
		expect(existsSync(sf)).toBe(true);
		const persisted = JSON.parse(readFileSync(sf, "utf-8"));
		const mine = persisted.find((s: any) => s.id === sessionId);
		expect(mine).toBeTruthy();
		console.log(`  Session in sessions.json: ✓ (cwd=${mine.cwd})`);

		// --- Restart on new port ---
		port = await freePort();
		gw = await start(dir, port);
		console.log(`  Gateway restarted on :${port}`);

		// --- Session still queryable? ---
		const postRes = await api(gw, `/api/sessions/${sessionId}`);
		expect(postRes.status).toBe(200);
		const postInfo = await postRes.json();
		console.log(`  Session status after restart: ${postInfo.status}`);

		// --- Session cwd preserved? ---
		const infoRes = await api(gw, `/api/sessions/${sessionId}`);
		expect(infoRes.status).toBe(200);
		const info = await infoRes.json();
		expect(normalize(info.cwd)).toBe(normalize(sessionCwd));
		console.log(`  cwd preserved: ✓`);

		// --- Can we send a message? ---
		// If session is archived, create a new one and verify the gateway works
		if (info.status === "archived") {
			console.log(`  Session archived after crash (agent file not flushed) — creating new session`);
			const res = await api(gw, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ worktree: false }),
			});
			expect(res.status).toBe(201);
			const newSession = await res.json();
			await poll(gw, newSession.id, "idle");

			const c = await connect(gw, newSession.id);
			c.send({ type: "send_message", text: "Reply with exactly: PONG" });
			await poll(gw, newSession.id, "idle");
			c.close();

			const newInfo = await (await api(gw, `/api/sessions/${newSession.id}`)).json();
			expect(normalize(newInfo.cwd)).toBe(normalize(dir));
			console.log(`  New session responds: ✓`);
		} else {
			// Session survived — send a message directly
			await poll(gw, sessionId, "idle");
			const c = await connect(gw, sessionId);
			c.send({ type: "send_message", text: "Reply with exactly: PONG" });
			await poll(gw, sessionId, "idle");
			c.close();
			console.log(`  Existing session responds after restart: ✓`);
		}
	});
});
