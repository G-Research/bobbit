/**
 * Manual-integration test for the sandbox-recovery dropped-events fix.
 *
 * Pins the regression behind the goal "Fix sandbox-recovery dropped events":
 * after a sandboxed session's project container is force-removed, the server
 * recovers by respawning the agent in place (`SessionManager.recoverSandboxSessions`).
 * That respawn rebuilds `SessionInfo` + `EventBuffer` while the client's WebSocket
 * stays open. Without seeding the new buffers from the old high-water marks,
 * every post-recovery `event` and `session_status` frame would arrive at
 * `seq=1` / `statusVersion=1` and be silently dropped by the client's monotonic
 * dedup gates.
 *
 * The fix routes `recoverSandboxSessions` through `_respawnAgentInPlace`, which
 * snapshots `EventBuffer.lastSeq` + `SessionInfo.statusVersion` BEFORE the
 * respawn and seeds the fresh buffers from those values. This test is the
 * end-to-end regression guard.
 *
 * Test flow (Docker-only — auto-skips otherwise):
 *   1. Boot a gateway, register a project, create a sandboxed session.
 *   2. Open a WebSocket and capture the highest `seq` and `statusVersion`
 *      observed during the initial turn(s). Assert both > 0.
 *   3. `docker rm -f` the project container (matches E-4's mechanism).
 *   4. Poll sandbox-status until it reports available again.
 *   5. Drive ONE more user turn AFTER recovery — over the SAME WebSocket.
 *   6. Assert: the WS received `event` frames with seq > preKillMaxSeq AND
 *      a `session_status` frame with statusVersion > preKillMaxStatusVersion.
 *      Without the fix, the client would receive frames stamped seq=1+,
 *      statusVersion=1+, and although they would arrive on the wire, the
 *      *server-side* counters would be stale relative to the old high-water
 *      mark — so the regression manifests as the post-recovery frames'
 *      seq/version values being LOWER THAN OR EQUAL TO the pre-kill values.
 *
 *   npm run test:manual -- --grep "sandbox-recovery-frame-continuity"
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync,
	cpSync,
} from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { seedManualTestModelPreferences } from "./manual-test-model-seeding.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

function hasDocker(): boolean {
	try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

interface GW { proc: ChildProcess; port: number; dir: string; token: string; base: string; defaultProjectId?: string; }

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); });
		s.on("error", rej);
	});
}

async function startGW(dir: string, port: number): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	seedManualTestModelPreferences(dir);
	const proc = spawn(process.execPath, [
		SERVER_CLI, "--host", "127.0.0.1", "--port", String(port),
		"--no-tls", "--auth", "--cwd", dir,
	], {
		env: { ...process.env, BOBBIT_DIR: join(dir, ".bobbit"), NODE_ENV: "test" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	proc.stderr!.on("data", (c: Buffer) => { stderr += c; });
	proc.stdout!.on("data", () => { /* discard */ });
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`Gateway exited (${proc.exitCode}):\n${stderr}`);
		try {
			const tp = join(dir, ".bobbit", "state", "token");
			if (existsSync(tp)) {
				const t = readFileSync(tp, "utf-8").trim();
				if ((await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${t}` } })).ok) break;
			}
		} catch {}
		await new Promise(r => setTimeout(r, 300));
	}
	if (Date.now() >= deadline) { proc.kill(); throw new Error(`Not healthy:\n${stderr}`); }
	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token, base: `http://127.0.0.1:${port}` };
}

async function stopGW(gw: GW): Promise<void> {
	if (gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			try { execFileSync("taskkill", ["/PID", String(gw.proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 10_000 }); } catch {}
		} else { gw.proc.kill(); }
	}
	await new Promise<void>(r => {
		if (gw.proc.exitCode !== null) return r();
		gw.proc.on("exit", () => r());
		setTimeout(() => { try { gw.proc.kill("SIGKILL"); } catch {} r(); }, 5_000);
	});
	await new Promise(r => setTimeout(r, 1_000));
}

function api(gw: GW, path: string, opts: RequestInit = {}) {
	if ((opts.method || "GET").toUpperCase() === "POST" && path === "/api/sessions" && gw.defaultProjectId) {
		try {
			const body = typeof opts.body === "string" && opts.body ? JSON.parse(opts.body) : {};
			if (body && typeof body === "object" && !body.projectId) {
				body.projectId = gw.defaultProjectId;
				opts = { ...opts, body: JSON.stringify(body) };
			}
		} catch {}
	}
	return fetch(`${gw.base}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}`, ...(opts.headers as Record<string, string> || {}) },
	});
}

/**
 * Poll until the session reports `idle`.
 *
 * `tolerateTransientTermination` is the load-bearing knob for the
 * post-recovery wait. After `docker rm -f` kills the project container, the
 * agent subprocess exits (code 137) and the session legitimately transitions
 * to `terminated`. `recoverSandboxSessions` then recreates the container
 * (~10-15s: container create + repo clone) and respawns the agent in place,
 * bringing the session back to `idle`. During that window `terminated` is the
 * EXPECTED state, not a failure — so callers waiting for recovery must keep
 * polling through it and only give up on the overall timeout (or a hard
 * `error`/`archived`). The pre-kill calls leave this off so a session that
 * dies before we even start is still caught immediately.
 */
async function pollIdle(gw: GW, id: string, ms = 180_000, opts: { tolerateTransientTermination?: boolean } = {}) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(gw, `/api/sessions/${id}`);
		if (res.status === 404) { await new Promise(r => setTimeout(r, 500)); continue; }
		const s = await res.json();
		if (s.status === "idle") return s;
		if (s.status === "archived") throw new Error(`Session ${id} archived`);
		if (s.status === "error") throw new Error(`Session ${id} error${s.restoreError ? `: ${s.restoreError}` : ""}`);
		if (s.status === "terminated" && !opts.tolerateTransientTermination) {
			throw new Error(`Session ${id} terminated${s.restoreError ? `: ${s.restoreError}` : ""}`);
		}
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} not idle in ${ms}ms`);
}

function initRepo(dir: string) {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
	writeFileSync(join(dir, "README.md"), "# Test\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }, null, 2));
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
	// Deliberately leave this repo WITHOUT an `origin` remote. With no origin the
	// sandbox bind-mounts the project repo read-only at `/workspace-src` and
	// clones it via `file://` — exercising the working mounted-clone path on
	// every OS (no scp/ssh misparse of a host path, no unreachable host path).
	const srcConfig = join(PROJECT_ROOT, ".bobbit", "config");
	const dstConfig = join(dir, ".bobbit", "config");
	if (existsSync(srcConfig)) {
		cpSync(srcConfig, dstConfig, { recursive: true, filter: (src) => !src.endsWith("project.yaml") });
	}
}

function cleanDirs(dir: string) {
	const parent = resolve(dir, "..");
	const base = dir.split(/[\\/]/).pop()!;
	const dirs = [dir];
	try { for (const e of readdirSync(parent)) if (e.startsWith(base)) dirs.push(join(parent, e)); } catch {}
	for (const d of dirs) { for (let i = 0; i < 3; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch {} } }
}

function cleanTestDockerContainers() {
	if (!HAS_DOCKER) return;
	try {
		const ids = execFileSync("docker", ["ps", "-aq", "--filter", "label=bobbit-project"], {
			encoding: "utf-8", timeout: 10_000,
		}).trim();
		if (!ids) return;
		for (const id of ids.split(/\s+/).filter(Boolean)) {
			try {
				const binds = execFileSync("docker", [
					"inspect", "--format", "{{json .HostConfig.Binds}}", id,
				], { encoding: "utf-8", timeout: 5_000 }).trim();
				if (/\.bobbit-recovery-frame/.test(binds)) {
					const projectId = execFileSync("docker", [
						"inspect", "--format", '{{index .Config.Labels "bobbit-project"}}', id,
					], { encoding: "utf-8", timeout: 5_000 }).trim();
					execFileSync("docker", ["rm", "-f", id], { timeout: 15_000, stdio: "ignore" });
					if (projectId) {
						for (const prefix of ["bobbit-workspace-", "bobbit-worktrees-"]) {
							try {
								execFileSync("docker", ["volume", "rm", "-f", `${prefix}${projectId}`], {
									timeout: 10_000, stdio: "ignore",
								});
							} catch {}
						}
					}
				}
			} catch {}
		}
	} catch {}
}

interface WsClient {
	ws: WebSocket;
	messages: any[];
	maxEventSeq: () => number;
	maxStatusVersion: () => number;
	send: (m: any) => void;
	waitFor: (pred: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
	close: () => void;
}

async function connectWs(gw: GW, sessionId: string): Promise<WsClient> {
	return new Promise((resolve, reject) => {
		const wsUrl = gw.base.replace(/^http/, "ws") + `/ws/${sessionId}`;
		const ws = new WebSocket(wsUrl);
		const messages: any[] = [];
		const waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void }> = [];

		ws.on("message", (raw) => {
			let msg: any;
			try { msg = JSON.parse(raw.toString()); } catch { return; }
			messages.push(msg);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i].pred(msg)) { waiters[i].res(msg); waiters.splice(i, 1); }
			}
		});
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: gw.token })));
		ws.on("error", reject);

		const iv = setInterval(() => {
			if (messages.some(m => m.type === "auth_ok")) {
				clearInterval(iv);
				resolve({
					ws, messages,
					maxEventSeq: () => messages.reduce(
						(mx, m) => (m.type === "event" && typeof m.seq === "number" && m.seq > mx ? m.seq : mx), 0),
					maxStatusVersion: () => messages.reduce(
						(mx, m) => (m.type === "session_status" && typeof m.statusVersion === "number" && m.statusVersion > mx ? m.statusVersion : mx), 0),
					send: (m) => ws.send(JSON.stringify(m)),
					waitFor: (pred, timeoutMs = 60_000) => {
						const existing = messages.find(pred);
						if (existing) return Promise.resolve(existing);
						return new Promise((res, rej) => {
							const t = setTimeout(() => rej(new Error(`waitFor timed out (${timeoutMs}ms)`)), timeoutMs);
							waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); } });
						});
					},
					close: () => { try { ws.close(); } catch {} },
				});
			}
		}, 50);
		setTimeout(() => { clearInterval(iv); reject(new Error("WS auth timeout")); }, 15_000);
	});
}

/** Send a prompt over WS and wait for the turn to settle (session_status idle with bumped version). */
async function wsPromptAndWaitIdle(client: WsClient, text: string, timeoutMs = 240_000) {
	// Capture the current statusVersion floor before sending — we need to wait
	// for a session_status:idle frame STRICTLY GREATER than this.
	const versionBefore = client.maxStatusVersion();
	client.send({ type: "prompt", text });
	// Wait for an idle status with version > versionBefore (post-turn settle).
	await client.waitFor(
		(m) => m.type === "session_status" && m.status === "idle"
			&& typeof m.statusVersion === "number" && m.statusVersion > versionBefore,
		timeoutMs,
	);
}

test.describe.configure({ mode: "serial" });

test("sandbox-recovery preserves WS frame continuity (seq + statusVersion carry over)", async () => {
	test.skip(!HAS_DOCKER, "Docker not available");
	test.setTimeout(600_000); // 10 min — sandbox boot + recovery + 3 LLM turns

	const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	const port = await freePort();
	const dir = join(tmp, `.bobbit-recovery-frame-${port}`);
	cleanDirs(dir);
	initRepo(dir);

	mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	writeFileSync(join(dir, ".bobbit", "config", "project.yaml"),
		'worktree_pool_size: "2"\nsandbox: "docker"\n');
	writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

	const gw = await startGW(dir, port);
	console.log(`  Gateway :${port} cwd=${dir}`);

	// Auto-skip if the sandbox isn't actually available even with Docker installed
	let sandboxAvailable = false;
	{
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			const r = await (await api(gw, "/api/sandbox-status")).json();
			if (r.configured && r.available) { sandboxAvailable = true; break; }
			await new Promise(r => setTimeout(r, 2_000));
		}
	}
	if (!sandboxAvailable) {
		console.log("  Sandbox not available — skipping");
		await stopGW(gw);
		cleanDirs(dir);
		test.skip(true, "Sandbox not available");
		return;
	}

	let client: WsClient | null = null;
	let sessionId: string | null = null;

	try {
		// 1. Register the project
		const regRes = await api(gw, "/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "Recovery Frame", rootPath: dir }),
		});
		expect(regRes.status).toBe(201);
		gw.defaultProjectId = ((await regRes.json()) as any).id;

		// 2. Create a sandboxed session
		const sessRes = await api(gw, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ sandboxed: true }),
		});
		expect(sessRes.status).toBe(201);
		sessionId = ((await sessRes.json()) as any).id as string;
		console.log(`  Sandboxed session: ${sessionId}`);

		await pollIdle(gw, sessionId, 240_000);
		console.log("  Session idle ✓");

		// 3. Open a WS and keep it open across the whole test
		client = await connectWs(gw, sessionId);
		console.log("  WebSocket connected + authenticated ✓");

		// 4. Drive two user turns to advance seq + statusVersion
		await wsPromptAndWaitIdle(client, "Reply with exactly the text: turn-one-ack");
		console.log(`  Turn 1 done. maxSeq=${client.maxEventSeq()} maxStatusVersion=${client.maxStatusVersion()}`);
		await wsPromptAndWaitIdle(client, "Reply with exactly the text: turn-two-ack");
		const preKillSeq = client.maxEventSeq();
		const preKillStatusVersion = client.maxStatusVersion();
		console.log(`  Turn 2 done. preKillSeq=${preKillSeq} preKillStatusVersion=${preKillStatusVersion}`);

		// Both must be > 0 — proves the WS actually saw real frames pre-kill.
		expect(preKillSeq).toBeGreaterThan(0);
		expect(preKillStatusVersion).toBeGreaterThan(0);

		// 5. Find and force-remove the project container
		const containerId = execFileSync("docker", [
			"ps", "-q", "--filter", "label=bobbit-project",
		], { encoding: "utf-8", timeout: 10_000 }).trim();
		expect(containerId).toBeTruthy();
		console.log(`  Killing container ${containerId.substring(0, 12)} …`);
		execFileSync("docker", ["rm", "-f", containerId], { timeout: 15_000, stdio: "ignore" });

		// 6. Confirm Docker itself is still healthy. NOTE: /api/sandbox-status
		//    only reflects the Docker daemon + agent image — NOT whether THIS
		//    project's container has been recreated or its sessions respawned.
		//    Because `docker rm -f` only removes the project container (the daemon
		//    stays up), this flips back to `available` almost immediately and is
		//    therefore NOT a recovery signal — step 7 owns the real wait.
		{
			const t0 = Date.now();
			let dockerHealthy = false;
			while (Date.now() - t0 < 180_000) {
				try {
					const r = await (await api(gw, "/api/sandbox-status")).json();
					if (r.available) { dockerHealthy = true; break; }
				} catch {}
				await new Promise(r => setTimeout(r, 2_000));
			}
			expect(dockerHealthy).toBe(true);
			console.log(`  Docker healthy after kill in ${Math.round((Date.now() - t0))}ms`);
		}

		// 7. Wait for the session to come back to idle. After the kill the agent
		//    subprocess exits (code 137) and the session legitimately sits in
		//    `terminated` for ~10-15s while recoverSandboxSessions recreates the
		//    container (create + repo clone) and respawns the agent in place,
		//    broadcasting a fresh "idle" status — EXACTLY the frame the bug used to
		//    drop. Tolerate the transient `terminated` here; the overall timeout
		//    (not the first terminated sample) is the real failure condition.
		await pollIdle(gw, sessionId, 180_000, { tolerateTransientTermination: true });
		console.log("  Session API status: idle (post-recovery) ✓");

		// Brief settle so any post-recovery status frames have a chance to arrive.
		await new Promise(r => setTimeout(r, 2_000));

		// 8. Drive ONE more user turn AFTER recovery — over the SAME WebSocket.
		//    Critical: this is what the regression silently dropped.
		await wsPromptAndWaitIdle(client, "Reply with exactly the text: post-recovery-ack");
		const postRecoverySeq = client.maxEventSeq();
		const postRecoveryStatusVersion = client.maxStatusVersion();
		console.log(`  Post-recovery turn done. seq=${postRecoverySeq} statusVersion=${postRecoveryStatusVersion}`);

		// 9. The fix asserts: post-recovery seq AND statusVersion must
		//    monotonically advance past the pre-kill high-water marks. Without
		//    the fix, the server's fresh EventBuffer would emit seq=1.. and
		//    fresh SessionInfo would emit statusVersion=1.. — both <= the
		//    pre-kill values — and the client's monotonic dedup gates would
		//    drop them. (Here we observe what the server actually wrote on the
		//    wire; the seedNextSeq / statusVersion carry-over makes the
		//    server-emitted values strictly greater.)
		expect(postRecoverySeq).toBeGreaterThan(preKillSeq);
		expect(postRecoveryStatusVersion).toBeGreaterThan(preKillStatusVersion);

		// 10. Sanity: there should be at least one `event` frame stamped with a
		//     seq strictly greater than preKillSeq, AND at least one
		//     `session_status` frame with statusVersion strictly greater than
		//     preKillStatusVersion. (Implied by step 9, but assert explicitly
		//     to catch the case where one path advances and the other doesn't.)
		const newEvents = client.messages.filter(m =>
			m.type === "event" && typeof m.seq === "number" && m.seq > preKillSeq);
		const newStatuses = client.messages.filter(m =>
			m.type === "session_status" && typeof m.statusVersion === "number"
			&& m.statusVersion > preKillStatusVersion);
		expect(newEvents.length).toBeGreaterThan(0);
		expect(newStatuses.length).toBeGreaterThan(0);
		console.log(`  Post-recovery: ${newEvents.length} new event frames, ${newStatuses.length} new session_status frames ✓`);
	} finally {
		try { client?.close(); } catch {}
		await stopGW(gw);
		cleanTestDockerContainers();
		cleanDirs(dir);
	}
});
