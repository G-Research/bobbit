/**
 * Manual-integration test: push a session close to its context limit so the
 * auto-compaction path fires, then verify (a) the rich compaction-summary
 * card renders with trigger="auto" and (b) the agent can keep working
 * post-compaction. Real LLM, ~5 min wall.
 *
 *   npm run build && npx playwright test --config playwright-manual.config.ts \
 *     --grep "compaction-pressure"
 *
 * The contextWindow knock-down trick is documented in
 * `tests/e2e/context-window-overrides.spec.ts` (it points at
 * `~/.bobbit/agent/models.json` overrides). We do not hardcode a model id —
 * we just lower the override for whatever model the gateway picks at boot.
 *
 * See docs/design/compaction-e2e-rich-summary.md §3.2.
 */
import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, openSync, writeSync,
	cpSync, copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_CLI = join(PROJECT_ROOT, "dist", "server", "cli.js");

interface GW {
	proc: ChildProcess; port: number; dir: string; agentDir: string;
	token: string; base: string; defaultProjectId?: string;
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

async function startGW(dir: string, agentDir: string, port: number, label: string): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const proc = spawn(process.execPath, [
		SERVER_CLI, "--host", "127.0.0.1", "--port", String(port),
		"--no-tls", "--auth", "--cwd", dir,
	], {
		env: {
			...process.env,
			BOBBIT_DIR: join(dir, ".bobbit"),
			BOBBIT_AGENT_DIR: agentDir,
			NODE_ENV: "test",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	const logTap = process.env.BOBBIT_TEST_GW_LOG;
	let logFh: number | null = null;
	if (logTap) {
		try { logFh = openSync(logTap, "a"); writeSync(logFh, `\n=== ${label} :${port} ===\n`); } catch {}
	}
	proc.stderr!.on("data", (c: Buffer) => { stderr += c; if (logFh !== null) try { writeSync(logFh, c); } catch {} });
	proc.stdout!.on("data", (c: Buffer) => { if (logFh !== null) try { writeSync(logFh, c); } catch {} });
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
	return { proc, port, dir, agentDir, token, base: `http://127.0.0.1:${port}` };
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
}

function api(gw: GW, path: string, opts: RequestInit = {}) {
	if ((opts.method || "GET").toUpperCase() === "POST"
		&& (path === "/api/sessions" || path === "/api/goals")
		&& gw.defaultProjectId) {
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

async function pollIdle(gw: GW, id: string, ms = 120_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const res = await api(gw, `/api/sessions/${id}`);
		if (res.ok) {
			const s = await res.json();
			if (s.status === "idle") return s;
			if (s.status === "error" || s.status === "archived" || s.status === "terminated") {
				throw new Error(`session ${id} ${s.status}`);
			}
		}
		await new Promise(r => setTimeout(r, 500));
	}
	throw new Error(`session ${id} not idle in ${ms}ms`);
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

function cleanDir(dir: string) {
	for (let i = 0; i < 3; i++) {
		try { rmSync(dir, { recursive: true, force: true }); break; } catch {}
	}
}

/**
 * After the gateway boots and resolves a default model, write a tiny
 * `contextWindow` override into the isolated agent dir's models.json so the
 * next session faces a small cap. The gateway re-reads overrides per-session.
 */
function writeContextWindowOverride(agentDir: string, modelId: string, providerId: string, contextWindow: number) {
	const path = join(agentDir, "models.json");
	let data: any = { providers: {} };
	try { data = JSON.parse(readFileSync(path, "utf-8")); } catch {}
	data.providers = data.providers || {};
	data.providers[providerId] = data.providers[providerId] || {};
	data.providers[providerId].modelOverrides = data.providers[providerId].modelOverrides || {};
	data.providers[providerId].modelOverrides[modelId] = {
		...(data.providers[providerId].modelOverrides[modelId] || {}),
		contextWindow,
	};
	writeFileSync(path, JSON.stringify(data, null, 2));
}

test.describe.configure({ mode: "serial" });

test("compaction-pressure: auto-compaction triggers and agent recovers", async ({ page }) => {
	test.setTimeout(360_000);

	const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	const port = await freePort();
	const dir = join(tmp, `.bobbit-compact-${port}`);
	const agentDir = join(tmp, `.bobbit-compact-${port}-agent`);
	cleanDir(dir); cleanDir(agentDir);
	initRepo(dir);
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

	// The fresh BOBBIT_DIR has no preferences and the fresh BOBBIT_AGENT_DIR
	// has no auth/settings — so the gateway would never auto-select a default
	// model (no aigw URL, no default.sessionModel preference). Seed both:
	//   1. Copy the user's real ~/.bobbit/agent/{auth,settings,models}.json
	//      into the isolated agentDir so the agent can actually call the LLM.
	//   2. Write default.sessionModel into the test's preferences.json so
	//      tryAutoSelectModel() pins a real model on each session.
	// The test then overlays its own contextWindow override on top of the
	// copied models.json — leaving the user's real config untouched.
	const realAgentDir = process.env.BOBBIT_AGENT_DIR_REAL || join(homedir(), ".bobbit", "agent");
	mkdirSync(agentDir, { recursive: true });
	for (const f of ["auth.json", "settings.json", "models.json"]) {
		const src = join(realAgentDir, f);
		if (existsSync(src)) {
			try { copyFileSync(src, join(agentDir, f)); } catch {}
		}
	}
	if (!existsSync(join(agentDir, "auth.json"))) {
		test.skip(true, `No agent auth found at ${realAgentDir}/auth.json — set BOBBIT_AGENT_DIR_REAL or sign in first`);
	}
	const defaultSessionModel = process.env.COMPACTION_TEST_MODEL || "anthropic/claude-haiku-4-5";
	writeFileSync(join(dir, ".bobbit", "state", "preferences.json"), JSON.stringify({
		"default.sessionModel": defaultSessionModel,
	}, null, 2));

	let gw = await startGW(dir, agentDir, port, "BOOT");
	try {
		// Register project
		const regRes = await api(gw, "/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "compact", rootPath: dir }),
		});
		expect(regRes.status).toBe(201);
		gw.defaultProjectId = (await regRes.json() as any).id;

		// Create session to learn the default model
		const sRes = await api(gw, "/api/sessions", { method: "POST", body: "{}" });
		expect(sRes.status).toBe(201);
		const sessionId = (await sRes.json() as any).id;
		// Wait for the session to be idle AND for the default model to be
		// auto-selected and persisted (modelProvider/modelId on the session
		// store). Default-model resolution happens asynchronously after the
		// session spawns, so the first idle poll can race ahead of it.
		let session: any;
		let modelId: string | undefined;
		let providerId: string | undefined;
		const modelDeadline = Date.now() + 60_000;
		while (Date.now() < modelDeadline) {
			session = await pollIdle(gw, sessionId);
			modelId = session.modelId || session.model?.id || session.model;
			providerId = session.modelProvider || session.model?.provider || session.provider;
			if (modelId && providerId) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		if (!modelId || !providerId) {
			throw new Error(`no default model in session: ${JSON.stringify(session)}`);
		}

		// Knock the context window down hard, restart so the override is picked up.
		writeContextWindowOverride(agentDir, modelId, providerId, 8_000);
		await stopGW(gw);
		gw = await startGW(dir, agentDir, port, "RESTART");
		gw.defaultProjectId = (await (await api(gw, "/api/projects")).json() as any).projects?.[0]?.id || gw.defaultProjectId;

		// Reuse same session
		await pollIdle(gw, sessionId);

		// Open the UI and watch WebSocket for auto_compaction_end / compaction_end.
		const wsFrames: any[] = [];
		page.on("websocket", (ws) => {
			ws.on("framereceived", (f) => {
				try {
					const data = JSON.parse(f.payload as string);
					if (data?.data?.type?.includes("compaction")) wsFrames.push(data.data);
				} catch {}
			});
		});

		await page.goto(`${gw.base}/?token=${gw.token}#/session/${sessionId}`);
		await page.waitForSelector("textarea", { timeout: 30_000 });

		// Push past 90% fill — large pasted prompts.
		const filler = "Filler. " + "x".repeat(3000);
		for (let i = 0; i < 4; i++) {
			const textarea = page.locator("textarea").first();
			await textarea.fill(filler + `\n\nNumber ${i}: please acknowledge with the digit ${i}.`);
			await textarea.press("Enter");
			await pollIdle(gw, sessionId, 180_000);
		}

		// One more — should force auto_compaction_*.
		const trigger = page.locator("textarea").first();
		await trigger.fill(filler + "\n\nNow summarise everything.");
		await trigger.press("Enter");

		// Card renders and reaches the complete state. After the
		// `Smooth, single-row compaction card` refactor (commit f772976e) the
		// renderer collapsed the success body to a single header row — the
		// before/after token badges and reduction bar were removed because
		// `tokensAfter` was structurally unreliable at compaction_end. The
		// only stable DOM hooks on the success path are the card root
		// (`data-state`) and the verdict pill (`data-verdict`). Hard
		// compaction failures surface via the assistant error path, not the
		// card, so a missing verdict is itself a regression.
		const card = page.locator("[data-testid='compaction-summary-card']").first();
		await expect(card).toBeVisible({ timeout: 180_000 });
		await expect(card).toHaveAttribute("data-state", "complete");
		await expect(card.locator("[data-test='verdict']")).toHaveAttribute("data-verdict", "ok");

		// Post-compact turn succeeds.
		await pollIdle(gw, sessionId, 240_000);
		const postTextarea = page.locator("textarea").first();
		await postTextarea.fill("Reply with exactly the word OK.");
		await postTextarea.press("Enter");
		await expect(page.getByText(/\bOK\b/).last()).toBeVisible({ timeout: 90_000 });

		expect(wsFrames.some((f) => f.type === "auto_compaction_start" || f.type === "compaction_start")).toBeTruthy();
	} finally {
		await stopGW(gw);
		cleanDir(dir);
		cleanDir(agentDir);
	}
});
