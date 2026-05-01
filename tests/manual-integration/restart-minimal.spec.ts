/**
 * Minimal restart-resilience test — fastest reproducer of "agents lost on restart".
 *
 * Creates one plain session and one worktree session, sends a prompt to each,
 * hard-kills the gateway, restarts on a new port, and verifies both sessions
 * survive (status reachable via API + browser can navigate to them).
 *
 * Use BOBBIT_TEST_GW_LOG=/path/to/log to capture full server logs across both
 * gateway lifetimes — the file is appended to by both processes.
 *
 *   npm run build && npx playwright test --config playwright-manual.config.ts \
 *     --grep "restart-minimal"
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, openSync, writeSync,
	cpSync,
} from "node:fs";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

interface GW { proc: ChildProcess; port: number; dir: string; token: string; base: string; defaultProjectId?: string; }

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); });
		s.on("error", rej);
	});
}

async function startGW(dir: string, port: number, label: string): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	const proc = spawn(process.execPath, [
		SERVER_CLI, "--host", "127.0.0.1", "--port", String(port),
		"--no-tls", "--auth", "--cwd", dir,
	], {
		env: { ...process.env, BOBBIT_DIR: join(dir, ".bobbit"), NODE_ENV: "test" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	const logTap = process.env.BOBBIT_TEST_GW_LOG;
	let logFh: number | null = null;
	if (logTap) {
		try { logFh = openSync(logTap, "a"); writeSync(logFh, `\n=== ${label} :${port} ===\n`); } catch {}
	}
	proc.stderr!.on("data", (c: Buffer) => { stderr += c; if (logFh !== null) { try { writeSync(logFh, c); } catch {} } });
	proc.stdout!.on("data", (c: Buffer) => { if (logFh !== null) { try { writeSync(logFh, c); } catch {} } });
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`Gateway exited (${proc.exitCode}):\n${stderr}`);
		try {
			const tp = join(dir, ".bobbit", "state", "token");
			if (existsSync(tp)) {
				const t = readFileSync(tp, "utf-8").trim();
				if ((await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${t}` } })).ok) break;
			}
		} catch {}
		await new Promise(r => setTimeout(r, 200));
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
	if ((opts.method || "GET").toUpperCase() === "POST" &&
		(path === "/api/sessions" || path === "/api/goals") && gw.defaultProjectId) {
		try {
			const body = typeof opts.body === "string" && opts.body ? JSON.parse(opts.body) : {};
			if (body && typeof body === "object" && !body.projectId) {
				body.projectId = gw.defaultProjectId;
				opts = { ...opts, body: JSON.stringify(body) };
			}
		} catch { /* leave alone */ }
	}
	return fetch(`${gw.base}${path}`, {
		...opts,
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}`, ...(opts.headers as Record<string, string> || {}) },
	});
}

async function pollIdle(gw: GW, id: string, ms = 60_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(gw, `/api/sessions/${id}`);
		if (res.status === 404) { await new Promise(r => setTimeout(r, 500)); continue; }
		const s = await res.json();
		if (s.status === "idle") return s;
		if (s.status === "archived") throw new Error(`Session ${id} archived`);
		if (s.status === "error" || s.status === "terminated") {
			throw new Error(`Session ${id} ${s.status}${s.restoreError ? `\n  restoreError: ${s.restoreError}` : ""}`);
		}
		await new Promise(r => setTimeout(r, 500));
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
	for (const d of dirs) {
		for (let i = 0; i < 3; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch {} }
	}
}

test.describe.configure({ mode: "serial" });

test("restart-minimal: plain + worktree session both survive a restart", async () => {
	test.setTimeout(180_000);

	const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	const port1 = await freePort();
	const dir = join(tmp, `.bobbit-restart-min-${port1}`);
	cleanDirs(dir);
	initRepo(dir);
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

	let gw = await startGW(dir, port1, "BOOT");
	console.log(`  [boot] gateway :${port1} cwd=${dir}`);

	// Register the project
	const regRes = await api(gw, "/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "Restart Min", rootPath: dir }),
	});
	expect(regRes.status).toBe(201);
	const reg = await regRes.json() as any;
	gw.defaultProjectId = reg.id;
	console.log(`  [boot] project ${reg.id}`);

	// Create plain session (no git repo — by passing a non-git cwd)
	// Actually: a session in a git repo auto-gets a worktree. To get "plain",
	// we use a sibling non-git tmp dir.
	const plainCwd = join(tmp, `.bobbit-restart-min-plain-${port1}`);
	mkdirSync(plainCwd, { recursive: true });
	const plainRes = await api(gw, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId: reg.id, cwd: plainCwd }),
	});
	expect(plainRes.status).toBe(201);
	const plainId = (await plainRes.json() as any).id;
	console.log(`  [boot] plain session ${plainId} cwd=${plainCwd}`);

	// Create worktree session (cwd inside the registered git project root)
	const wtRes = await api(gw, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ projectId: reg.id }),
	});
	expect(wtRes.status).toBe(201);
	const wtId = (await wtRes.json() as any).id;
	console.log(`  [boot] worktree session ${wtId}`);

	// Wait both idle
	const plainPre = await pollIdle(gw, plainId);
	const wtPre = await pollIdle(gw, wtId);
	console.log(`  [boot] plain idle. cwd=${plainPre.cwd} branch=${plainPre.branch ?? "(none)"}`);
	console.log(`  [boot] wt idle.    cwd=${wtPre.cwd}    branch=${wtPre.branch ?? "(none)"}`);

	// Setting a title is metadata-only post-rename-removal: the worktree session
	// already has its final `session/<id8>` branch from claim time and must not
	// rename when the title changes. Verify the branch is byte-stable across
	// the title update — and that this stable session still survives restart.
	const wtPreTitle = await (await api(gw, `/api/sessions/${wtId}`)).json() as any;
	const branchBeforeTitle = wtPreTitle.branch;
	expect(branchBeforeTitle).toMatch(/^session\/[a-f0-9]{8}$/);
	const titleRes = await api(gw, `/api/sessions/${wtId}`, {
		method: "PATCH",
		body: JSON.stringify({ title: "Renamed Pool Worktree" }),
	});
	expect(titleRes.status).toBe(200);
	// Give any (unwanted) async work a moment to land before re-asserting.
	await new Promise(r => setTimeout(r, 1_500));
	const wtAfterRename = await (await api(gw, `/api/sessions/${wtId}`)).json() as any;
	console.log(`  [boot] wt post-title. cwd=${wtAfterRename.cwd} branch=${wtAfterRename.branch}`);
	expect(wtAfterRename.branch).toBe(branchBeforeTitle);
	expect(wtAfterRename.branch).not.toMatch(/^pool\//);

	// No artificial wait — the gateway must guarantee that any session it
	// reports as `idle` over the API has already had its recovery-critical
	// metadata flushed to disk synchronously. This is the regression guard:
	// previously we had to wait several seconds for a debounced save before
	// it was safe to hard-kill the gateway. See spawnAgent / executeWorktreeAsync.
	await api(gw, "/api/sessions");

	// Read sessions.json snapshot for diagnosis
	const sfPath = join(dir, ".bobbit", "state", "sessions.json");
	const before = JSON.parse(readFileSync(sfPath, "utf-8")) as any[];
	console.log(`  [boot] sessions.json has ${before.length} entries`);
	for (const s of before) {
		console.log(`         id=${s.id} title="${s.title}" branch=${s.branch} archived=${!!s.archived} agentSessionFile=${s.agentSessionFile ? "yes" : "MISSING"}`);
	}

	// Restart
	console.log("  [restart] killing gateway");
	await stopGW(gw);
	const port2 = await freePort();
	gw = await startGW(dir, port2, "RESTART");
	gw.defaultProjectId = reg.id;
	console.log(`  [restart] gateway :${port2}`);

	// Wait a bit for restore-on-boot to catch up
	await new Promise(r => setTimeout(r, 5_000));

	// List all sessions and inspect
	const listRes = await api(gw, "/api/sessions");
	expect(listRes.status).toBe(200);
	const list = await listRes.json() as any;
	console.log(`  [restart] /api/sessions reports ${list.sessions?.length ?? 0} entries`);
	for (const s of list.sessions || []) {
		console.log(`         id=${s.id} status=${s.status} archived=${!!s.archived} cwd=${s.cwd}`);
	}

	const findInList = (id: string) => list.sessions?.find((s: any) => s.id === id);
	const plainAfter = findInList(plainId);
	const wtAfter = findInList(wtId);

	const failures: string[] = [];
	if (!plainAfter) failures.push(`plain session ${plainId} missing from /api/sessions after restart`);
	else if (plainAfter.archived) failures.push(`plain session ${plainId} archived after restart (was idle before)`);
	if (!wtAfter) failures.push(`worktree session ${wtId} missing from /api/sessions after restart`);
	else if (wtAfter.archived) failures.push(`worktree session ${wtId} archived after restart (was idle before)`);

	if (failures.length === 0) {
		// Both still listed — try to bring them back to idle
		try { await pollIdle(gw, plainId, 60_000); console.log(`  [restart] plain idle ✓`); }
		catch (err) { failures.push(`plain ${plainId} not idle after restart: ${(err as Error).message}`); }
		try { await pollIdle(gw, wtId, 60_000); console.log(`  [restart] wt idle ✓`); }
		catch (err) { failures.push(`worktree ${wtId} not idle after restart: ${(err as Error).message}`); }
	}

	// Read the post-restart sessions.json for diagnosis
	const after = JSON.parse(readFileSync(sfPath, "utf-8")) as any[];
	console.log(`  [restart] sessions.json now has ${after.length} entries (${after.filter(s => s.archived).length} archived)`);

	await stopGW(gw);
	cleanDirs(dir);
	cleanDirs(plainCwd);

	if (failures.length) {
		throw new Error(`Restart-minimal failures:\n  - ${failures.join("\n  - ")}`);
	}
});
