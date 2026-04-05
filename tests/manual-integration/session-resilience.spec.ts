/**
 * Full-stack session resilience integration tests.
 *
 * Uses real agents — no mocks. Run manually:
 *
 *   npm run test:manual                  # API-only, no browser
 *   SCREENSHOTS=1 npm run test:manual    # also capture browser screenshots + HTML report
 *
 * Prerequisites:
 *   - `npm run build`
 *   - Agent CLI in PATH (claude, etc.)
 *   - Docker running (for sandbox tests; skipped if unavailable)
 *
 * 6 variations tested:
 *   1. Plain          (no worktree, no sandbox)
 *   2. Worktree       (worktree, no sandbox)
 *   3. Worktree + interrupt (kill mid-tool-call)
 *   4. Sandbox plain  (sandboxed, no worktree)
 *   5. Sandbox worktree
 *   6. Sandbox worktree + interrupt
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
const RESULTS_DIR = join(PROJECT_ROOT, "test-results", "manual-integration");
const WANT_SCREENSHOTS = !!process.env.SCREENSHOTS;

// ---------------------------------------------------------------------------
// Docker detection
// ---------------------------------------------------------------------------
function isDockerAvailable(): boolean {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
		return true;
	} catch { return false; }
}
const HAS_DOCKER = isDockerAvailable();

// ---------------------------------------------------------------------------
// Gateway lifecycle
// ---------------------------------------------------------------------------
interface GW {
	proc: ChildProcess; port: number; dir: string;
	token: string; base: string; wsUrl: string;
}

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
	proc.stdout!.on("data", () => {});

	const deadline = Date.now() + 120_000; // sandbox init can be slow
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`Gateway exited (${proc.exitCode}):\n${stderr}`);
		try {
			const tp = join(dir, ".bobbit", "state", "token");
			if (existsSync(tp)) {
				const t = readFileSync(tp, "utf-8").trim();
				const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { Authorization: `Bearer ${t}` } });
				if (r.ok) break;
			}
		} catch {}
		await new Promise(r => setTimeout(r, 300));
	}
	if (Date.now() >= deadline) { proc.kill(); throw new Error(`Gateway not healthy:\n${stderr}`); }
	const token = readFileSync(join(dir, ".bobbit", "state", "token"), "utf-8").trim();
	return { proc, port, dir, token, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
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
	await new Promise(r => setTimeout(r, 1_500));
}

// ---------------------------------------------------------------------------
// API / WS helpers
// ---------------------------------------------------------------------------
function api(gw: GW, path: string, opts: RequestInit = {}) {
	return fetch(`${gw.base}${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}`, ...(opts.headers as Record<string, string> || {}) } });
}

async function pollStatus(gw: GW, id: string, target: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let res: Response;
		try { res = await api(gw, `/api/sessions/${id}`); } catch { await new Promise(r => setTimeout(r, 1_000)); continue; }
		if (res.status === 404) { await new Promise(r => setTimeout(r, 1_000)); continue; }
		const s = await res.json();
		if (s.status === target) return s;
		if (["error", "terminated", "archived"].includes(s.status)) throw new Error(`Session ${id} is ${s.status}, wanted ${target}`);
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} did not reach ${target} in ${ms}ms`);
}

async function getStatus(gw: GW, id: string): Promise<string> { return (await (await api(gw, `/api/sessions/${id}`)).json()).status; }

interface Conn { send(m: any): void; close(): void; }
function wsConnect(gw: GW, id: string): Promise<Conn> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${gw.wsUrl}/ws/${id}`);
		const msgs: any[] = [];
		ws.on("message", r => msgs.push(JSON.parse(r.toString())));
		ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: gw.token })));
		ws.on("error", reject);
		const iv = setInterval(() => { if (msgs.some(m => m.type === "auth_ok")) { clearInterval(iv); resolve({ send(m: any) { ws.send(JSON.stringify(m)); }, close() { ws.close(); } }); } }, 50);
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
// Screenshot + result recording
// ---------------------------------------------------------------------------
async function screenshot(page: Page | undefined, gw: GW, id: string, name: string) {
	if (!WANT_SCREENSHOTS || !page) return;
	await page.goto(`${gw.base}/?token=${gw.token}#/session/${id}`);
	await page.waitForSelector("textarea", { timeout: 15_000 });
	await page.waitForTimeout(2_500);
	mkdirSync(RESULTS_DIR, { recursive: true });
	await page.screenshot({ path: join(RESULTS_DIR, name), fullPage: true });
	console.log(`    Screenshot: ${name}`);
}

interface TestResult {
	name: string;
	sandboxed: boolean;
	worktree: boolean;
	interrupt: boolean;
	createMs: number;
	idleMs: number;
	queueMs: number;
	responseMs: number;
	restartMs: number;
	cwd: string;
	branch: string;
	restoredAsIdle: boolean;
	screenshot?: string;
}

function record(r: TestResult) {
	mkdirSync(RESULTS_DIR, { recursive: true });
	const slug = r.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	writeFileSync(join(RESULTS_DIR, `result-${slug}.json`), JSON.stringify(r, null, 2));
}

// ---------------------------------------------------------------------------
// Shared setup helpers
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

function initRepoWithRemote(dir: string) {
	initRepo(dir);
	try {
		const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
		execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir, stdio: "ignore" });
	} catch { console.log("  Could not add origin remote"); }
}

function tmpDir(label: string, port: number) {
	const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	return join(tmp, `.bobbit-manual-${label}-${port}`);
}

function cleanDirs(dir: string) {
	const parent = resolve(dir, "..");
	const base = dir.split(/[\\/]/).pop()!;
	const dirs = [dir];
	try { for (const e of readdirSync(parent)) if (e.startsWith(base) && e.includes("-wt")) dirs.push(join(parent, e)); } catch {}
	for (const d of dirs) { for (let i = 0; i < 3; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch {} } }
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

// ---------------------------------------------------------------------------
// Generic test runner — called for each variation
// ---------------------------------------------------------------------------
function defineVariation(opts: {
	name: string; label: string; worktree: boolean; sandboxed: boolean; interrupt: boolean;
}) {
	test.describe.serial(opts.name, () => {
		test.setTimeout(300_000);
		let gw: GW, dir: string, port: number;
		let sessionId: string, sessionCwd: string, sessionBranch: string;
		const timing: Partial<TestResult> = {};

		test.beforeAll(async ({}, ti) => {
			ti.setTimeout(180_000);
			if (opts.sandboxed) test.skip(!HAS_DOCKER, "Docker not available");

			port = await freePort();
			dir = tmpDir(opts.label, port);
			rmSync(dir, { recursive: true, force: true });

			if (opts.sandboxed) {
				initRepoWithRemote(dir);
				mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
				writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), "sandbox: docker\n");
			} else {
				initRepo(dir);
			}

			gw = await startGW(dir, port);
			console.log(`  Gateway :${port}, cwd=${dir}`);

			if (opts.sandboxed) {
				const sr = await api(gw, "/api/sandbox-status");
				const ss = await sr.json();
				console.log(`  Sandbox: configured=${ss.configured} available=${ss.available}`);
				if (!ss.available) test.skip(true, "Sandbox not available");
			}
		});

		test.afterAll(async ({}, ti) => {
			ti.setTimeout(30_000);
			if (gw) await stopGW(gw);
			cleanDirs(dir);
		});

		test("create, send message, measure timing", async () => {
			const t0 = performance.now();
			const res = await api(gw, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ worktree: opts.worktree, sandboxed: opts.sandboxed }),
			});
			expect(res.status).toBe(201);
			sessionId = (await res.json()).id;
			timing.createMs = Math.round(performance.now() - t0);

			await pollStatus(gw, sessionId, "idle", opts.sandboxed ? 180_000 : 120_000);
			timing.idleMs = Math.round(performance.now() - t0);

			const c = await wsConnect(gw, sessionId);
			const tQ0 = performance.now();
			c.send({ type: "send_message", text: "Reply with exactly: PONG" });
			timing.queueMs = Math.round(performance.now() - tQ0);
			await new Promise(r => setTimeout(r, 200));
			await pollStatus(gw, sessionId, "idle");
			timing.responseMs = Math.round(performance.now() - tQ0);
			c.close();

			const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
			sessionCwd = info.cwd;

			// Verify cwd
			if (!opts.sandboxed) {
				if (opts.worktree) {
					expect(normalize(sessionCwd)).not.toBe(normalize(dir));
					expect(existsSync(sessionCwd)).toBe(true);
					sessionBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: sessionCwd, encoding: "utf-8" }).trim();
					expect(sessionBranch).not.toBe("master");
				} else {
					expect(normalize(sessionCwd)).toBe(normalize(dir));
					sessionBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: sessionCwd, encoding: "utf-8" }).trim();
					expect(sessionBranch).toBe("master");
				}
			} else {
				expect(sessionCwd).toBeTruthy();
				sessionBranch = "(sandbox)";
			}

			console.log(`\n  Create: ${timing.createMs}ms  Idle: ${timing.idleMs}ms  Queue: ${timing.queueMs}ms  Resp: ${timing.responseMs}ms\n  cwd: ${sessionCwd}  branch: ${sessionBranch}`);
		});

		test(`restart${opts.interrupt ? " (interrupt)" : ""} — verify recovery`, async ({ page }) => {
			expect(sessionId).toBeTruthy();

			// Send a real message for chat history
			await sendAndWait(gw, sessionId, "Run `pwd` and `git status` and show me the output");
			await waitForSessionFile(gw, sessionId);

			// If interrupt variant, send a blocking command
			if (opts.interrupt) {
				const c = await wsConnect(gw, sessionId);
				c.send({ type: "send_message",
					text: "Run this exact bash command with the bash tool (not background): sleep 120 && echo done" });
				await new Promise(r => setTimeout(r, 5_000));
				const st = await getStatus(gw, sessionId);
				console.log(`  Status during tool call: ${st}`);
				c.close();
			}

			// Hard kill
			const tRestart0 = performance.now();
			await stopGW(gw);

			// Verify state persisted
			if (!opts.sandboxed) {
				expect(existsSync(join(dir, ".bobbit", "state", "sessions.json"))).toBe(true);
				if (opts.worktree) expect(existsSync(sessionCwd)).toBe(true);
			}

			// Restart
			port = await freePort();
			gw = await startGW(dir, port);

			// Check session state
			const info = await (await api(gw, `/api/sessions/${sessionId}`)).json();
			const restored = info.status !== "archived";
			timing.restartMs = Math.round(performance.now() - tRestart0);
			console.log(`  Restarted :${port} in ${timing.restartMs}ms — status: ${info.status}`);

			// Verify cwd preserved
			expect(normalize(info.cwd)).toBe(normalize(sessionCwd));
			console.log(`  cwd preserved: ✓`);

			let screenshotId = sessionId;
			if (restored) {
				// Verify git state (non-sandbox)
				if (!opts.sandboxed && opts.worktree && existsSync(sessionCwd)) {
					const br = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: sessionCwd, encoding: "utf-8" }).trim();
					expect(br).not.toBe("master");
					console.log(`  Git valid: ✓ (branch=${br})`);
				}
				await pollStatus(gw, sessionId, "idle", 120_000);
				await sendAndWait(gw, sessionId, "Run `pwd` again to confirm same directory");
				console.log(`  Session responds after restart: ✓`);
			} else {
				console.log(`  Session archived — creating new session`);
				const r = await api(gw, "/api/sessions", {
					method: "POST",
					body: JSON.stringify({ worktree: opts.worktree, sandboxed: opts.sandboxed }),
				});
				const ns = (await r.json()).id;
				await pollStatus(gw, ns, "idle", opts.sandboxed ? 180_000 : 120_000);
				await sendAndWait(gw, ns, "Run `pwd` and `git status` and show me the output");
				screenshotId = ns;
				console.log(`  New session responds: ✓`);
			}

			const ssName = `${opts.label}-after-restart.png`;
			await screenshot(page, gw, screenshotId, ssName);

			// Record results
			record({
				name: opts.name,
				sandboxed: opts.sandboxed,
				worktree: opts.worktree,
				interrupt: opts.interrupt,
				createMs: timing.createMs || 0,
				idleMs: timing.idleMs || 0,
				queueMs: timing.queueMs || 0,
				responseMs: timing.responseMs || 0,
				restartMs: timing.restartMs || 0,
				cwd: sessionCwd,
				branch: sessionBranch,
				restoredAsIdle: restored,
				screenshot: WANT_SCREENSHOTS ? ssName : undefined,
			});
		});
	});
}

// ===================================================================
// Define all 6 variations
// ===================================================================

defineVariation({ name: "Plain (no worktree)",            label: "plain",     worktree: false, sandboxed: false, interrupt: false });
defineVariation({ name: "Worktree",                       label: "wt",        worktree: true,  sandboxed: false, interrupt: false });
defineVariation({ name: "Worktree + interrupt",           label: "wt-int",    worktree: true,  sandboxed: false, interrupt: true  });
defineVariation({ name: "Sandbox plain",                  label: "sbx",       worktree: false, sandboxed: true,  interrupt: false });
defineVariation({ name: "Sandbox worktree",               label: "sbx-wt",    worktree: true,  sandboxed: true,  interrupt: false });
defineVariation({ name: "Sandbox worktree + interrupt",   label: "sbx-wt-int",worktree: true,  sandboxed: true,  interrupt: true  });

// ===================================================================
// HTML report generation
// ===================================================================

test("generate HTML report", async () => {
	if (!existsSync(RESULTS_DIR)) { console.log("  No results to report"); return; }

	const files = readdirSync(RESULTS_DIR).filter(f => f.startsWith("result-") && f.endsWith(".json"));
	if (files.length === 0) { console.log("  No result files found"); return; }

	const results: TestResult[] = files.map(f => JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf-8")));

	// Build screenshot img tags
	const imgTag = (r: TestResult) => {
		if (!r.screenshot || !existsSync(join(RESULTS_DIR, r.screenshot))) return "";
		const b64 = readFileSync(join(RESULTS_DIR, r.screenshot)).toString("base64");
		return `<img src="data:image/png;base64,${b64}" alt="${r.name}" style="width:100%;border-radius:6px;border:1px solid #333;margin-top:8px">`;
	};

	const bar = (val: number, max: number, color: string) => {
		const w = max > 0 ? Math.max(2, Math.round((val / max) * 120)) : 2;
		return `<div style="display:inline-block;height:14px;width:${w}px;background:${color};border-radius:2px;vertical-align:middle"></div>`;
	};

	const maxIdle = Math.max(...results.map(r => r.idleMs));
	const maxResp = Math.max(...results.map(r => r.responseMs));
	const maxRestart = Math.max(...results.map(r => r.restartMs));

	const colors: Record<string, string> = {};
	const palette = ["#5b9bd5", "#ed7d31", "#70ad47", "#ffc000", "#9b59b6", "#e74c3c"];
	results.forEach((r, i) => { colors[r.name] = palette[i % palette.length]; });

	const timingRows = results.map(r => `
		<tr>
			<td><span style="display:inline-block;width:10px;height:10px;background:${colors[r.name]};border-radius:2px;margin-right:6px"></span>${r.name}</td>
			<td class="r">${r.createMs}</td>
			<td class="r">${r.idleMs} ${bar(r.idleMs, maxIdle, colors[r.name])}</td>
			<td class="r">${r.responseMs} ${bar(r.responseMs, maxResp, colors[r.name])}</td>
			<td class="r">${r.restartMs} ${bar(r.restartMs, maxRestart, colors[r.name])}</td>
		</tr>`).join("\n");

	const checkRows = results.map(r => `
		<tr>
			<td>${r.name}</td>
			<td class="r">${r.restoredAsIdle ? '<span class="ck">✓ idle</span>' : '<span style="color:#e74c3c">archived</span>'}</td>
			<td class="r"><span class="ck">✓</span></td>
			<td class="r">${r.branch}</td>
		</tr>`).join("\n");

	const screenshotSections = results.map(r => {
		const img = imgTag(r);
		if (!img) return "";
		return `
		<div style="margin-bottom:24px">
			<div style="font-size:13px;color:#a0d0a0;font-weight:600;margin-bottom:4px">${r.name}</div>
			<div style="font-size:12px;color:#888;margin-bottom:6px">cwd: <code>${r.cwd}</code> &bull; branch: <code>${r.branch}</code> &bull; restored: ${r.restoredAsIdle ? "✓" : "archived"}</div>
			${img}
		</div>`;
	}).filter(Boolean).join("\n");

	const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Session Resilience Report</title>
<style>
*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:920px;margin:40px auto;background:#1a1a2e;color:#e0e0e0;padding:0 20px}
h1{color:#a0d0a0;font-size:22px;margin-bottom:4px}h2{color:#a0d0a0;font-size:16px;margin:28px 0 12px}
.sub{color:#888;font-size:13px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;margin-bottom:24px}
th{text-align:left;padding:8px 12px;border-bottom:2px solid #444;color:#a0d0a0;font-size:12px}
td{padding:6px 12px;border-bottom:1px solid #333;font-size:13px}
.r{text-align:right;font-variant-numeric:tabular-nums}th.r{text-align:right}
.ck{color:#6d6}code{background:#333;padding:1px 5px;border-radius:3px;font-size:11px}
hr{border:none;border-top:1px solid #333;margin:32px 0}
.note{font-size:12px;color:#777;line-height:1.6;margin-top:16px}
</style></head><body>
<h1>Session Resilience Report</h1>
<p class="sub">${results.length} variations &bull; real agents, no mocks &bull; ${new Date().toISOString().split("T")[0]}</p>

<h2>Timing (ms)</h2>
<table>
<tr><th>Variation</th><th class="r">Create</th><th class="r">Create→Idle</th><th class="r">Msg Response</th><th class="r">Restart</th></tr>
${timingRows}
</table>

<h2>Post-crash verification</h2>
<table>
<tr><th>Variation</th><th class="r">Restored</th><th class="r">cwd preserved</th><th class="r">Branch</th></tr>
${checkRows}
</table>

${screenshotSections ? `<hr><h2>Screenshots — after restart</h2>${screenshotSections}` : ""}

<p class="note">
Tests run with <code>npm run test:manual</code>. Each variation creates an isolated git repo,
starts a gateway, creates a session, exchanges messages, hard-kills the gateway, restarts on a
fresh port, and verifies the session survives with cwd and git state intact.
Sandbox variations run inside Docker containers.
${WANT_SCREENSHOTS ? "Screenshots captured with <code>SCREENSHOTS=1</code>." : "Run with <code>SCREENSHOTS=1</code> for screenshots."}
</p>
</body></html>`;

	writeFileSync(join(RESULTS_DIR, "report.html"), html);
	console.log(`  Report: ${join(RESULTS_DIR, "report.html")} (${results.length} variations)`);
});
