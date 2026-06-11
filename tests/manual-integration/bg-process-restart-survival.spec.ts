/**
 * Manual-integration acceptance for "Windows bash_bg survives a dev-harness
 * restart" (goal: Fix Windows bg-process restart). Drives a REAL gateway with
 * REAL detached `bash_bg` wrappers (POSIX wrapper on Windows+Git Bash, /bin/sh
 * elsewhere) across a restart and asserts the documented restore contract
 * (`docs/bg-process-persistence.md`):
 *
 *   (1) a STILL-RUNNING bg process re-attaches and KEEPS STREAMING after the
 *       restart — record stays `running`, its log keeps growing, it is NOT
 *       resolved to `unrecoverable`;
 *   (2) a SHORT-LIVED bg process that FINISHES DURING DOWNTIME comes back with
 *       its REAL exit code (`terminalReason="normal"`, exitCode = the real code).
 *
 * The restart kills ONLY the gateway PID — mirroring the production fix in
 * `harness.ts`/`harness-kill.ts` (no `taskkill /T` tree-kill on Windows; a
 * single SIGTERM to the gateway PID, not its group, elsewhere). The detached +
 * unref'd bg wrappers therefore survive the gateway's death, keep writing their
 * spools while it is down, and write `.status` on natural exit, so the next boot
 * re-attaches (alive) or reads the real exit code (finished-during-downtime).
 *
 *   npm run test:manual    (or: npx playwright test --config playwright-manual.config.ts \
 *     --grep "bg-process-restart-survival")
 *
 * This suite is gate-exempt — it is NOT run by the implementation gate.
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { windowsGatewayKillArgs } from "../../src/server/harness-kill.ts";

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
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`Gateway exited (${proc.exitCode}):\n${stderr}`);
		try {
			const tp = join(dir, ".bobbit", "state", "token");
			if (existsSync(tp)) {
				const t = readFileSync(tp, "utf-8").trim();
				if ((await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${t}` } })).ok) break;
			}
		} catch { /* not up yet */ }
		await new Promise(r => setTimeout(r, 200));
	}
	if (Date.now() >= deadline) { proc.kill(); throw new Error(`Not healthy:\n${stderr}`); }
	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token, base: `http://127.0.0.1:${port}` };
}

/**
 * Restart-harness-faithful kill: force-kill ONLY the gateway PID, never its
 * descendant tree. On Windows this uses the SAME argv the production harness now
 * uses ({@link windowsGatewayKillArgs} — no `/T`); elsewhere a single SIGTERM to
 * the gateway PID (not the process group). This is the whole point of the fix:
 * the detached bg wrappers must outlive the gateway. Using `taskkill /T` here
 * would euthanize them and reproduce the bug.
 */
async function stopGatewayOnly(gw: GW): Promise<void> {
	if (gw.proc.exitCode === null) {
		if (process.platform === "win32") {
			const argv = windowsGatewayKillArgs(gw.proc.pid!);
			try { execFileSync(argv[0], argv.slice(1), { stdio: "ignore", timeout: 10_000 }); } catch { /* fall through */ }
		} else {
			try { gw.proc.kill("SIGTERM"); } catch { /* ignore */ }
		}
	}
	await new Promise<void>(r => {
		if (gw.proc.exitCode !== null) return r();
		gw.proc.on("exit", () => r());
		setTimeout(() => { try { gw.proc.kill("SIGKILL"); } catch { /* ignore */ } r(); }, 5_000);
	});
	await new Promise(r => setTimeout(r, 1_000));
}

function api(gw: GW, path: string, opts: RequestInit = {}) {
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
		const s = await res.json() as any;
		if (s.status === "idle") return s;
		if (s.status === "error" || s.status === "terminated" || s.status === "archived") {
			throw new Error(`Session ${id} ${s.status}${s.restoreError ? `\n  restoreError: ${s.restoreError}` : ""}`);
		}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error(`Session ${id} not idle in ${ms}ms`);
}

async function listBg(gw: GW, sessionId: string): Promise<any[]> {
	const res = await api(gw, `/api/sessions/${sessionId}/bg-processes`);
	if (!res.ok) return [];
	return (await res.json() as any).processes ?? [];
}

async function bgLog(gw: GW, sessionId: string, pid: string, tail = 200): Promise<string[]> {
	const res = await api(gw, `/api/sessions/${sessionId}/bg-processes/${pid}/logs?tail=${tail}`);
	if (!res.ok) return [];
	const j = await res.json() as any;
	return (j.log ?? []).map((e: any) => e.text as string);
}

/** Highest `tick N` integer currently in the ticker's log (−1 if none seen). */
function maxTick(lines: string[]): number {
	let max = -1;
	for (const l of lines) {
		const m = /tick (\d+)/.exec(l);
		if (m) max = Math.max(max, parseInt(m[1], 10));
	}
	return max;
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
}

function cleanDirs(dir: string) {
	const parent = resolve(dir, "..");
	const base = dir.split(/[\\/]/).pop()!;
	const dirs = [dir];
	try { for (const e of readdirSync(parent)) if (e.startsWith(base)) dirs.push(join(parent, e)); } catch { /* ignore */ }
	for (const d of dirs) {
		for (let i = 0; i < 3; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch { /* retry */ } }
	}
}

test.describe.configure({ mode: "serial" });

test("bg-process-restart-survival: running re-attaches & keeps streaming; finished-during-downtime reports real exit code", async () => {
	test.setTimeout(240_000);

	const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	const port1 = await freePort();
	const dir = join(tmp, `.bobbit-bgrestart-${port1}`);
	cleanDirs(dir);
	initRepo(dir);
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

	let gw = await startGW(dir, port1);
	console.log(`  [boot] gateway :${port1} cwd=${dir}`);

	// Register the project.
	const regRes = await api(gw, "/api/projects", { method: "POST", body: JSON.stringify({ name: "BG Restart", rootPath: dir }) });
	expect(regRes.status).toBe(201);
	const reg = await regRes.json() as any;
	gw.defaultProjectId = reg.id;

	// Plain (non-worktree) session: bash_bg runs in this cwd.
	const sessCwd = join(tmp, `.bobbit-bgrestart-cwd-${port1}`);
	mkdirSync(sessCwd, { recursive: true });
	const sRes = await api(gw, "/api/sessions", { method: "POST", body: JSON.stringify({ projectId: reg.id, cwd: sessCwd }) });
	expect(sRes.status).toBe(201);
	const sessionId = (await sRes.json() as any).id;
	await pollIdle(gw, sessionId);
	console.log(`  [boot] session ${sessionId} idle, cwd=${sessCwd}`);

	// (1) Long-running ticker — must survive the restart and keep streaming.
	const tickRes = await api(gw, `/api/sessions/${sessionId}/bg-processes`, {
		method: "POST",
		body: JSON.stringify({ name: "ticker", command: "i=0; while [ $i -lt 100000 ]; do echo tick $i; i=$((i+1)); sleep 1; done" }),
	});
	expect(tickRes.status).toBe(201);
	const tickId = (await tickRes.json() as any).id;

	// (2) Short-lived process — finishes DURING downtime with a distinctive exit code.
	const SHORT_EXIT = 7;
	const shortRes = await api(gw, `/api/sessions/${sessionId}/bg-processes`, {
		method: "POST",
		body: JSON.stringify({ name: "short", command: `echo short-start; sleep 4; echo short-done; exit ${SHORT_EXIT}` }),
	});
	expect(shortRes.status).toBe(201);
	const shortId = (await shortRes.json() as any).id;
	console.log(`  [boot] ticker=${tickId} short=${shortId}`);

	// Confirm the ticker streams + persists before the restart.
	let preTick = -1;
	{
		const t0 = Date.now();
		while (Date.now() - t0 < 30_000) {
			preTick = maxTick(await bgLog(gw, sessionId, tickId));
			if (preTick >= 2) break;
			await new Promise(r => setTimeout(r, 500));
		}
	}
	expect(preTick, "ticker must stream at least a few ticks pre-restart").toBeGreaterThanOrEqual(2);
	// Persistence sanity: the durable store + spool exist on disk.
	const bgJson = join(dir, ".bobbit", "state", "bg-processes.json");
	expect(existsSync(bgJson), "bg-processes.json must be written").toBe(true);
	console.log(`  [boot] ticker streamed to tick ${preTick}; store persisted`);

	// Restart: kill ONLY the gateway PID (harness-faithful — bg wrappers survive),
	// then wait long enough that the SHORT process finishes during downtime.
	console.log("  [restart] killing gateway (gateway-PID only, no tree-kill)");
	await stopGatewayOnly(gw);
	await new Promise(r => setTimeout(r, 6_000)); // > short's 4s sleep → it exits + writes .status while down

	const port2 = await freePort();
	gw = await startGW(dir, port2);
	gw.defaultProjectId = reg.id;
	console.log(`  [restart] gateway :${port2}`);

	// Let restore-on-boot re-attach the session + its bg processes.
	await pollIdle(gw, sessionId, 90_000);
	await new Promise(r => setTimeout(r, 3_000));

	const failures: string[] = [];

	// --- Assertion (1): ticker re-attached, running, NOT unrecoverable, streaming. ---
	let ticker: any;
	{
		const t0 = Date.now();
		while (Date.now() - t0 < 30_000) {
			ticker = (await listBg(gw, sessionId)).find(p => p.id === tickId);
			if (ticker) break;
			await new Promise(r => setTimeout(r, 500));
		}
	}
	if (!ticker) {
		failures.push(`ticker ${tickId} missing from bg-processes after restart`);
	} else {
		console.log(`  [restart] ticker status=${ticker.status} terminalReason=${ticker.terminalReason}`);
		if (ticker.status === "unrecoverable" || ticker.terminalReason === "unrecoverable") {
			failures.push(`ticker resolved to UNRECOVERABLE after restart — the regression. status=${ticker.status} terminalReason=${ticker.terminalReason}`);
		} else if (ticker.status !== "running") {
			failures.push(`ticker expected status=running after restart, got ${ticker.status} (terminalReason=${ticker.terminalReason})`);
		} else {
			// Keeps streaming: the surviving wrapper kept writing while down + after; the
			// re-attached tailer must observe the tick count climb past the pre-restart max.
			const reTick = maxTick(await bgLog(gw, sessionId, tickId));
			let grown = reTick;
			const t0 = Date.now();
			while (Date.now() - t0 < 20_000 && grown <= preTick) {
				await new Promise(r => setTimeout(r, 1_000));
				grown = maxTick(await bgLog(gw, sessionId, tickId));
			}
			console.log(`  [restart] ticker re-attached: preTick=${preTick} postTick=${grown}`);
			if (grown <= preTick) {
				failures.push(`ticker did not keep streaming after restart: preTick=${preTick} postTick=${grown} (spool froze)`);
			}
		}
	}

	// --- Assertion (2): short process finished during downtime → real exit code. ---
	let short: any;
	{
		const t0 = Date.now();
		while (Date.now() - t0 < 30_000) {
			short = (await listBg(gw, sessionId)).find(p => p.id === shortId);
			if (short && short.status !== "running") break;
			await new Promise(r => setTimeout(r, 500));
		}
	}
	if (!short) {
		failures.push(`short ${shortId} missing from bg-processes after restart`);
	} else {
		console.log(`  [restart] short status=${short.status} terminalReason=${short.terminalReason} exitCode=${short.exitCode}`);
		if (short.terminalReason !== "normal") {
			failures.push(`short process expected terminalReason="normal" (real exit read from .status), got "${short.terminalReason}" (status=${short.status}, exitCode=${short.exitCode})`);
		}
		if (short.exitCode !== SHORT_EXIT) {
			failures.push(`short process expected real exitCode=${SHORT_EXIT}, got ${short.exitCode}`);
		}
	}

	// Cleanup: dismiss the still-running ticker (force) so no orphan survives the test.
	try { await api(gw, `/api/sessions/${sessionId}/bg-processes/${tickId}?action=kill`, { method: "DELETE" }); } catch { /* ignore */ }
	await stopGatewayOnly(gw);
	cleanDirs(dir);
	cleanDirs(sessCwd);

	if (failures.length) {
		throw new Error(`bg-process-restart-survival failures:\n  - ${failures.join("\n  - ")}`);
	}
});
