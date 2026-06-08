/**
 * Real-LLM manual-integration test for context compaction via the explicit
 * `/compact` command (the user-initiated counterpart to the auto-compaction
 * path covered by `compaction-pressure.spec.ts`).
 *
 * Runs under the manual-integration config (real LLM, ~5 min wall):
 *
 *   npm run test:manual -- --grep "compaction —"
 *
 * Unlike its previous life under a config-level `webServer`, this spec
 * bootstraps its own isolated gateway in `beforeAll`/`afterAll` (same pattern
 * as `compaction-pressure.spec.ts`) so it is collected by
 * `playwright-manual.config.ts` with no shared web server. The gateway serves
 * the built UI so the browser can drive the real `/compact` flow.
 *
 * Flow:
 *   1. Knock down the default model's contextWindow so the session faces a
 *      tiny cap (cheap, reliable pressure).
 *   2. Create a project + two sessions via REST against the isolated gateway.
 *   3. Drive prompts via the UI to fill the context near the cap.
 *   4. Submit `/compact`.
 *   5. Assert the bobbit blob enters compact-shake / compacting state, then
 *      the rich compaction-summary card appears in the transcript.
 *   6. Persistence across session-nav and page-reload.
 *
 * See docs/design/compaction-e2e-rich-summary.md §3.1.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync,
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

async function startGW(dir: string, agentDir: string, port: number): Promise<GW> {
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
}

function cleanDir(dir: string) {
	for (let i = 0; i < 3; i++) {
		try { rmSync(dir, { recursive: true, force: true }); break; } catch {}
	}
}

/** Lower the contextWindow override for the given model in the isolated agent dir. */
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

async function sendPrompt(page: Page, text: string) {
	const textarea = page.locator("textarea").first();
	await textarea.waitFor({ state: "visible", timeout: 15_000 });
	await textarea.fill(text);
	await textarea.press("Enter");
}

test.describe.configure({ mode: "serial" });

test("compaction — real LLM @real", async ({ page }) => {
	test.setTimeout(360_000);

	const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
	const port = await freePort();
	const dir = join(tmp, `.bobbit-compact-manual-${port}`);
	const agentDir = join(tmp, `.bobbit-compact-manual-${port}-agent`);
	cleanDir(dir); cleanDir(agentDir);
	initRepo(dir);
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

	// Seed real agent creds into the isolated agentDir so the agent can call
	// the LLM, and pin a default session model so a model is auto-selected.
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

	let gw = await startGW(dir, agentDir, port);
	try {
		// Register project.
		const regRes = await api(gw, "/api/projects", {
			method: "POST",
			body: JSON.stringify({ name: "compaction-manual", rootPath: dir }),
		});
		expect(regRes.status).toBe(201);
		gw.defaultProjectId = (await regRes.json() as any).id;

		// Create a session to learn the default model.
		const sRes = await api(gw, "/api/sessions", { method: "POST", body: "{}" });
		expect(sRes.status).toBe(201);
		const sessionId = (await sRes.json() as any).id;
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

		// 16k window — small enough that 2 filler prompts push past the soft
		// cap on most models, but generous enough that prompts are accepted.
		writeContextWindowOverride(agentDir, modelId, providerId, 16_000);
		await stopGW(gw);
		gw = await startGW(dir, agentDir, port);
		gw.defaultProjectId = (await (await api(gw, "/api/projects")).json() as any).projects?.[0]?.id || gw.defaultProjectId;

		const otherRes = await api(gw, "/api/sessions", { method: "POST", body: "{}" });
		expect(otherRes.status).toBe(201);
		const otherSessionId = (await otherRes.json() as any).id;
		await pollIdle(gw, sessionId);
		await pollIdle(gw, otherSessionId);

		const consoleErrors: string[] = [];
		page.on("console", (m) => {
			if (m.type() === "error") consoleErrors.push(m.text());
		});

		await page.goto(`${gw.base}/?token=${gw.token}#/session/${sessionId}`);
		await page.waitForSelector("textarea", { timeout: 30_000 });

		// Two large prompts to push context up. Real model — keep payload bounded.
		const FILLER = "Please remember the following inert filler block exactly: "
			+ "x".repeat(2000);
		await sendPrompt(page, FILLER + "\n\nWhat does Bobbit do?");
		await pollIdle(gw, sessionId, 120_000);
		await sendPrompt(page, FILLER + "\n\nSummarise your previous answer in one sentence.");
		await pollIdle(gw, sessionId, 120_000);

		// Trigger /compact.
		await sendPrompt(page, "/compact");

		// Blob enters compact-shake then compacting. StreamingMessageContainer
		// sets these classes; either is acceptable evidence of the animation.
		await expect(
			page.locator(".bobbit-blob--compact-shake, .bobbit-blob--compacting"),
		).toBeVisible({ timeout: 30_000 });

		// Rich card renders.
		const card = page.locator("[data-testid='compaction-summary-card']").first();
		await expect(card).toBeVisible({ timeout: 120_000 });
		await expect(card.getByText("Context compacted")).toBeVisible();
		await expect(card).toHaveAttribute("data-state", /complete|error/);

		// No error indicators in the transcript.
		await expect(
			page.locator("[data-testid='error-details-message']"),
		).toHaveCount(0);
		expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);

		// Persistence across session navigation.
		await page.goto(`${gw.base}/?token=${gw.token}#/session/${otherSessionId}`);
		await page.waitForSelector("textarea", { timeout: 30_000 });
		await page.goto(`${gw.base}/?token=${gw.token}#/session/${sessionId}`);
		await expect(card).toBeVisible({ timeout: 30_000 });

		// Persistence across reload. Reload-path materialises a rich synthetic
		// from the server's plain-text marker; `tokens-before` must be present.
		await page.reload();
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.locator("[data-test='tokens-before']")).toContainText(/tok/);
	} finally {
		await stopGW(gw);
		cleanDir(dir);
		cleanDir(agentDir);
	}
});
