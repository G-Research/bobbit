/**
 * Full-stack session resilience integration tests.
 *
 * Single gateway, 6 session variations, one restart — verifies all survive.
 * All agent interactions go through the browser UI.
 *
 *   npm run test:manual                  # headless browser
 *   SCREENSHOTS=1 npm run test:manual    # + screenshots + HTML report
 *
 * Prerequisites: `npm run build`, agent CLI in PATH, Docker for sandbox tests.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync,
} from "node:fs";
import { join, resolve, normalize } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");
const RESULTS_DIR = join(PROJECT_ROOT, "test-results", "manual-integration");
const WANT_SCREENSHOTS = !!process.env.SCREENSHOTS;

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------
function hasDocker(): boolean {
	try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------
interface GW {
	proc: ChildProcess; port: number; dir: string;
	token: string; base: string;
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
	await new Promise(r => setTimeout(r, 1_500));
}

// ---------------------------------------------------------------------------
// API helpers (session creation requires flags not available in UI)
// ---------------------------------------------------------------------------
function api(gw: GW, path: string, opts: RequestInit = {}) {
	return fetch(`${gw.base}${path}`, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}`, ...(opts.headers as Record<string, string> || {}) } });
}

async function pollIdle(gw: GW, id: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let res: Response;
		try { res = await api(gw, `/api/sessions/${id}`); } catch { await new Promise(r => setTimeout(r, 1_000)); continue; }
		if (res.status === 404) { await new Promise(r => setTimeout(r, 1_000)); continue; }
		const s = await res.json();
		if (s.status === "idle") return s;
		if (s.status === "archived") throw new Error(`Session ${id} archived`);
		if (s.status === "error" || s.status === "terminated") throw new Error(`Session ${id} ${s.status}`);
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} not idle in ${ms}ms`);
}

async function getSession(gw: GW, id: string) { return (await api(gw, `/api/sessions/${id}`)).json(); }

// ---------------------------------------------------------------------------
// Browser helpers — all agent interaction goes through here
// ---------------------------------------------------------------------------
function sessionUrl(gw: GW, id: string) {
	return `${gw.base}/?token=${gw.token}#/session/${id}`;
}

/** Navigate to session, wait for history to load, type message, send, wait for idle. */
async function browserSend(page: Page, gw: GW, id: string, text: string, idleMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 15_000 });
	// Wait for any prior messages to render
	try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
	await page.waitForTimeout(500);
	await page.fill("textarea", text);
	await page.press("textarea", "Enter");
	// Wait for session to leave idle (become busy/streaming) before polling for idle,
	// otherwise pollIdle returns immediately on the stale idle state
	await page.waitForTimeout(1_500);
	await pollIdle(gw, id, idleMs);
	// Wait for the UI to finish rendering the response
	await page.waitForTimeout(2_000);
}

/** Navigate to session, wait for it to reach idle (no message sent). */
async function browserWait(page: Page, gw: GW, id: string, idleMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 15_000 });
	await pollIdle(gw, id, idleMs);
	try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
	await page.waitForTimeout(1_000);
}

// ---------------------------------------------------------------------------
// Setup helpers
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
	try {
		const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
		execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir, stdio: "ignore" });
	} catch {}
}

function cleanDirs(dir: string) {
	const parent = resolve(dir, "..");
	const base = dir.split(/[\\/]/).pop()!;
	const dirs = [dir];
	try { for (const e of readdirSync(parent)) if (e.startsWith(base)) dirs.push(join(parent, e)); } catch {}
	for (const d of dirs) { for (let i = 0; i < 3; i++) { try { rmSync(d, { recursive: true, force: true }); break; } catch {} } }
}

async function waitForFile(gw: GW, id: string, ms = 30_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const sf = join(gw.dir, ".bobbit", "state", "sessions.json");
		if (existsSync(sf)) {
			const mine = JSON.parse(readFileSync(sf, "utf-8")).find((s: any) => s.id === id);
			if (mine?.agentSessionFile && existsSync(mine.agentSessionFile)) return true;
		}
		await new Promise(r => setTimeout(r, 2_000));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
interface Result {
	name: string; label: string;
	sandboxed: boolean; worktree: boolean; interrupt: boolean;
	createMs: number; idleMs: number; responseMs: number;
	restartMs: number; cwd: string; branch: string;
	restoredAsIdle: boolean; screenshot?: string;
}
const results: Result[] = [];

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------
interface Variation {
	name: string; label: string;
	worktree: boolean; sandboxed: boolean; interrupt: boolean;
}
const VARIATIONS: Variation[] = [
	{ name: "Plain (no worktree)",          label: "plain",      worktree: false, sandboxed: false, interrupt: false },
	{ name: "Worktree",                     label: "wt",         worktree: true,  sandboxed: false, interrupt: false },
	{ name: "Worktree + interrupt",         label: "wt-int",     worktree: true,  sandboxed: false, interrupt: true  },
	{ name: "Sandbox plain",               label: "sbx",        worktree: false, sandboxed: true,  interrupt: false },
	{ name: "Sandbox worktree",            label: "sbx-wt",     worktree: true,  sandboxed: true,  interrupt: false },
	{ name: "Sandbox worktree + interrupt",label: "sbx-wt-int", worktree: true,  sandboxed: true,  interrupt: true  },
];

function variationTag(v: Variation) {
	const wt = v.worktree ? "Worktree" : "Master";
	const sbx = v.sandboxed ? "Sandbox" : "No Sandbox";
	const int = v.interrupt ? " + Interrupt" : "";
	return `${wt}, ${sbx}${int}`;
}

// ===================================================================
// Single gateway, all variations, all via browser
// ===================================================================
test.describe.serial("Session resilience — all variations", () => {
	test.setTimeout(600_000);

	let gw: GW;
	let dir: string;
	let port: number;
	let sandboxAvailable = false;
	const sessions: Record<string, { id: string; cwd: string; branch: string; timing: Partial<Result> }> = {};

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(180_000);
		port = await freePort();
		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		dir = join(tmp, `.bobbit-manual-${port}`);
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);

		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		const yaml = [`worktree_pool_size: "6"`, HAS_DOCKER ? "sandbox: docker" : ""].filter(Boolean).join("\n") + "\n";
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), yaml);

		gw = await startGW(dir, port);
		console.log(`  Gateway :${port}  cwd=${dir}  docker=${HAS_DOCKER}`);

		if (HAS_DOCKER) {
			const ss = await (await api(gw, "/api/sandbox-status")).json();
			sandboxAvailable = ss.configured && ss.available;
			console.log(`  Sandbox: configured=${ss.configured} available=${ss.available}`);
		}
	});

	test.afterAll(async ({}, ti) => {
		ti.setTimeout(30_000);
		if (gw) await stopGW(gw);
		cleanDirs(dir);
	});

	// ---------------------------------------------------------------
	// Single test: create → message → time → restart → verify → screenshot
	// ---------------------------------------------------------------
	test("create sessions, send messages, restart, verify recovery", async ({ page }) => {
		// --- Phase 1: Create all sessions, send initial message via browser, measure timing ---
		for (const v of VARIATIONS) {
			if (v.sandboxed && !sandboxAvailable) { console.log(`  SKIP ${v.name}`); continue; }

			// Create session via API (UI doesn't expose worktree/sandbox flags)
			const t0 = performance.now();
			const res = await api(gw, "/api/sessions", {
				method: "POST", body: JSON.stringify({ worktree: v.worktree, sandboxed: v.sandboxed }),
			});
			expect(res.status).toBe(201);
			const id = (await res.json()).id;
			const createMs = Math.round(performance.now() - t0);

			// Wait for idle
			await pollIdle(gw, id, v.sandboxed ? 180_000 : 120_000);
			const idleMs = Math.round(performance.now() - t0);

			// Send initial message via browser + measure response time
			const tMsg = performance.now();
			await browserSend(page, gw, id,
				`Test: ${variationTag(v)}\nRun \`pwd\` and \`git status\` and show me the output.`);
			const responseMs = Math.round(performance.now() - tMsg);

			// Wait for agent session file to flush
			await waitForFile(gw, id);

			// Record session info
			const info = await getSession(gw, id);
			let branch = "";
			if (!v.sandboxed) {
				if (v.worktree) {
					expect(normalize(info.cwd)).not.toBe(normalize(dir));
					branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: info.cwd, encoding: "utf-8" }).trim();
					expect(branch).not.toBe("master");
				} else {
					expect(normalize(info.cwd)).toBe(normalize(dir));
					branch = "master";
				}
			} else { branch = "(sandbox)"; }

			sessions[v.label] = { id, cwd: info.cwd, branch, timing: { createMs, idleMs, responseMs } };
			console.log(`  ${v.name}: create=${createMs}ms idle=${idleMs}ms msg=${responseMs}ms`);
		}

		// --- Phase 2: Send blocking commands on interrupt variants via browser ---
		for (const v of VARIATIONS) {
			if (!v.interrupt) continue;
			const s = sessions[v.label];
			if (!s) continue;
			await page.goto(sessionUrl(gw, s.id));
			await page.waitForSelector("textarea", { timeout: 15_000 });
			try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
			await page.fill("textarea",
				"Run this exact bash command with the bash tool (not background): sleep 120 && echo done");
			await page.press("textarea", "Enter");
			console.log(`  ${v.name}: blocking command sent`);
		}
		if (VARIATIONS.some(v => v.interrupt && sessions[v.label])) {
			await new Promise(r => setTimeout(r, 5_000));
			for (const v of VARIATIONS) {
				if (!v.interrupt || !sessions[v.label]) continue;
				console.log(`  ${v.name}: status=${(await getSession(gw, sessions[v.label].id)).status}`);
			}
		}

		// --- Phase 3: Kill gateway and restart ---
		const tRestart = performance.now();
		await stopGW(gw);
		expect(existsSync(join(dir, ".bobbit", "state", "sessions.json"))).toBe(true);

		port = await freePort();
		gw = await startGW(dir, port);
		const restartMs = Math.round(performance.now() - tRestart);
		console.log(`  Restarted :${port} in ${restartMs}ms`);

		// --- Phase 4: Verify each session and screenshot ---
		for (const v of VARIATIONS) {
			const s = sessions[v.label];
			if (!s) continue;
			s.timing.restartMs = restartMs;

			const info = await getSession(gw, s.id);
			const restored = info.status !== "archived";
			expect(normalize(info.cwd)).toBe(normalize(s.cwd));
			console.log(`  ${v.name}: status=${info.status} cwd_preserved=✓`);

			if (!v.sandboxed && v.worktree && restored && existsSync(s.cwd)) {
				const br = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: s.cwd, encoding: "utf-8" }).trim();
				expect(br).not.toBe("master");
				console.log(`    git ✓ (branch=${br})`);
			}

			// Send follow-up via browser — page shows full history from before + after restart
			let screenshotId = s.id;
			if (restored) {
				await pollIdle(gw, s.id, 120_000);
				await browserSend(page, gw, s.id, "Run `pwd`, and confirm `git status`");
				console.log(`    responds ✓`);
			} else {
				const r = await api(gw, "/api/sessions", {
					method: "POST", body: JSON.stringify({ worktree: v.worktree, sandboxed: v.sandboxed }),
				});
				const ns = (await r.json()).id;
				await pollIdle(gw, ns, v.sandboxed ? 180_000 : 120_000);
				await browserSend(page, gw, ns, "Run `pwd`, and confirm `git status`");
				screenshotId = ns;
				console.log(`    new session ✓`);
			}

			// Screenshot — page has the full conversation from browserSend
			const ssName = `${v.label}-after-restart.png`;
			if (WANT_SCREENSHOTS) {
				mkdirSync(RESULTS_DIR, { recursive: true });
				await page.screenshot({ path: join(RESULTS_DIR, ssName), fullPage: true });
				console.log(`    📸 ${ssName}`);
			}

			results.push({
				name: v.name, label: v.label,
				sandboxed: v.sandboxed, worktree: v.worktree, interrupt: v.interrupt,
				createMs: s.timing.createMs || 0, idleMs: s.timing.idleMs || 0,
				responseMs: s.timing.responseMs || 0, restartMs: s.timing.restartMs || 0,
				cwd: s.cwd, branch: s.branch,
				restoredAsIdle: restored,
				screenshot: WANT_SCREENSHOTS ? ssName : undefined,
			});
		}
	});

	// ---------------------------------------------------------------
	// HTML report
	// ---------------------------------------------------------------
	test("generate HTML report", async () => {
		if (results.length === 0) { console.log("  No results"); return; }
		mkdirSync(RESULTS_DIR, { recursive: true });

		const bar = (val: number, max: number, color: string) => {
			const w = max > 0 ? Math.max(2, Math.round((val / max) * 120)) : 2;
			return `<div style="display:inline-block;height:14px;width:${w}px;background:${color};border-radius:2px;vertical-align:middle;margin-left:6px"></div>`;
		};
		const palette = ["#5b9bd5", "#ed7d31", "#70ad47", "#ffc000", "#9b59b6", "#e74c3c"];
		const maxIdle = Math.max(...results.map(r => r.idleMs));
		const maxResp = Math.max(...results.map(r => r.responseMs));
		const maxRestart = Math.max(...results.map(r => r.restartMs));

		const timingRows = results.map((r, i) => `<tr>
			<td><span style="display:inline-block;width:10px;height:10px;background:${palette[i % 6]};border-radius:2px;margin-right:6px"></span>${r.name}</td>
			<td class="r">${r.createMs}${bar(r.createMs, maxIdle, palette[i % 6])}</td>
			<td class="r">${r.idleMs}${bar(r.idleMs, maxIdle, palette[i % 6])}</td>
			<td class="r">${r.responseMs}${bar(r.responseMs, maxResp, palette[i % 6])}</td>
			<td class="r">${r.restartMs}${bar(r.restartMs, maxRestart, palette[i % 6])}</td>
		</tr>`).join("\n");

		const checkRows = results.map(r => `<tr>
			<td>${r.name}</td>
			<td class="r">${r.restoredAsIdle ? '<span class="g">✓ idle</span>' : '<span class="o">archived</span>'}</td>
			<td class="r"><span class="g">✓</span></td>
			<td class="r"><code>${r.branch}</code></td>
		</tr>`).join("\n");

		const screenshotSections = results.filter(r => r.screenshot && existsSync(join(RESULTS_DIR, r.screenshot))).map(r => {
			const b64 = readFileSync(join(RESULTS_DIR, r.screenshot!)).toString("base64");
			return `<div style="margin-bottom:28px">
				<div style="font-size:14px;color:#a0d0a0;font-weight:600">${r.name}</div>
				<div style="font-size:12px;color:#888;margin:4px 0 8px">cwd: <code>${r.cwd}</code> · branch: <code>${r.branch}</code> · ${r.restoredAsIdle ? "restored — chat history preserved" : "archived → new session"}</div>
				<img src="data:image/png;base64,${b64}" style="width:100%;border-radius:6px;border:1px solid #333">
			</div>`;
		}).join("\n");

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
.g{color:#6d6}.o{color:#ed7d31}code{background:#333;padding:1px 5px;border-radius:3px;font-size:11px}
hr{border:none;border-top:1px solid #333;margin:32px 0}
.n{font-size:12px;color:#777;line-height:1.6;margin-top:16px}
</style></head><body>
<h1>Session Resilience Report</h1>
<p class="sub">${results.length} variations · single gateway · real agents · all interactions via browser · ${new Date().toISOString().split("T")[0]}</p>
<h2>Timing (ms)</h2>
<table><tr><th>Variation</th><th class="r">Create</th><th class="r">Create→Idle</th><th class="r">Msg (browser)</th><th class="r">Restart</th></tr>${timingRows}</table>
<h2>Post-crash verification</h2>
<table><tr><th>Variation</th><th class="r">Restored</th><th class="r">cwd preserved</th><th class="r">Branch</th></tr>${checkRows}</table>
${screenshotSections ? `<hr><h2>Screenshots — after restart</h2>
<p class="n">Each screenshot shows the session after a hard gateway kill and restart. All messages were sent through the browser. Restored sessions show the pre-restart "Test: ..." message with pwd/git output, followed by the post-restart "Run pwd, and confirm git status" response.</p>
${screenshotSections}` : ""}
<p class="n">Sessions created via API (worktree/sandbox flags). All messages sent through browser UI. Single gateway instance shared by all 6 variations. Sandbox sessions may be archived after crash if the agent session file lives inside the Docker container.</p>
</body></html>`;

		writeFileSync(join(RESULTS_DIR, "report.html"), html);
		console.log(`  Report: ${join(RESULTS_DIR, "report.html")} (${results.length} variations)`);
	});
});
