/**
 * Agent tool-use canary — proves end-to-end tool calls really work.
 *
 * This is the regression net for upstream `@earendil-works/pi-*` upgrades. A
 * previous upgrade silently broke all agent tool use; no existing test
 * exercised a real LLM-driven agent calling tools end-to-end. This file
 * closes that gap.
 *
 * Seven scenarios, each in its own fresh sandboxed session:
 *   1. bash         — builtin shell, command echo produces sentinel HELLO_<nonce>
 *   2. edit         — defaults/tools/filesystem/edit on a pre-created file, sentinel DONE
 *   3. find         — defaults/tools/filesystem/find on pre-created files, sentinel COUNT=3
 *   4. interrupt    — long-running bash, then steer to PIVOT_ACK
 *   5. error        — edit on missing file, sentinel EDIT_FAILED:
 *   6. web_fetch    — Bobbit extension tool, fetches gateway /api/health, sentinel HEALTH_OK_<nonce>
 *   7. mcp_describe — MCP meta-tool, describes playwright MCP server, sentinel MCP_OPS_<nonce>=<n>
 *
 * Assertions are tool-name-specific (not substring-of-any-card): every
 * tool-card wrapper in the UI carries `data-tool-name="<name>"`, and
 * `countToolCardsByName` / `assertNoOtherToolCards` enforce that the LLM
 * actually invoked the named tool — not a substitute that happened to
 * produce the same visible side-effect. This is the regression the prior
 * version of this spec missed (see design doc: Harden tool-use canary).

 *
 * Helpers (`startGW`, `stopGW`, `api`, `pollIdle`, `browserSend`,
 * `interruptAndSend`, `initRepo`, `projectRegistrationBody`, `getSession`,
 * `freePort`, `appUrl`, `sessionUrl`, `takeScreenshot`,
 * `RESULTS_DIR`/`WANT_SCREENSHOTS`) are copied verbatim from
 * `session-resilience.spec.ts`. Per the design doc, helper extraction is out
 * of scope for this PR — every existing manual spec inlines these.
 *
 *   npm run test:manual                  # headless browser
 *   SCREENSHOTS=1 npm run test:manual    # + screenshots
 *
 * Prerequisites: `npm run build`, agent CLI in PATH, Docker for sandbox.
 */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildDefaultWorkflows } from "../../src/server/state-migration/seed-default-workflows.ts";

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
// Project registration body
// ---------------------------------------------------------------------------
function projectRegistrationBody(name: string, rootPath: string, opts: { upsert?: boolean } = {}) {
	const components = [{
		name,
		repo: ".",
		commands: {
			build: "echo build ok",
			check: "echo check ok",
			unit: "echo unit ok",
			e2e: "echo e2e ok",
		},
	}];
	const workflows = buildDefaultWorkflows(name);
	return { name, rootPath, components, workflows, ...opts };
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------
interface GW {
	proc: ChildProcess; port: number; dir: string;
	token: string; base: string;
	defaultProjectId?: string;
}

const PROJECT_REQUIRED_POST = new Set(["/api/sessions", "/api/goals", "/api/staff"]);

async function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); });
		s.on("error", rej);
	});
}

async function startGW(dir: string, port: number): Promise<GW> {
	mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
	// Bind to 0.0.0.0 so sandboxed containers can reach the gateway via
	// host.docker.internal (which is --add-host'd into every sandbox by
	// docker-args.ts). Without this, scenarios that exercise gateway-callback
	// tools (mcp_describe, and any extension that reads BOBBIT_GATEWAY_URL)
	// would fail because the container's loopback isn't the host's loopback.
	const proc = spawn(process.execPath, [
		SERVER_CLI, "--host", "0.0.0.0", "--port", String(port),
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
	// Overwrite gateway-url so sandboxed sessions get an address that resolves
	// from inside the container. cli.ts wrote `http://127.0.0.1:<port>` which
	// only works for host-side callers; sandboxed agents need host.docker.internal.
	writeFileSync(
		join(dir, ".bobbit", "state", "gateway-url"),
		`http://host.docker.internal:${port}`,
		"utf-8",
	);
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
// API helpers
// ---------------------------------------------------------------------------
function api(gw: GW, path: string, opts: RequestInit = {}) {
	if ((opts.method || "GET").toUpperCase() === "POST" && PROJECT_REQUIRED_POST.has(path) && gw.defaultProjectId) {
		try {
			const body = typeof opts.body === "string" && opts.body ? JSON.parse(opts.body) : {};
			if (body && typeof body === "object" && !body.projectId) {
				body.projectId = gw.defaultProjectId;
				opts = { ...opts, body: JSON.stringify(body) };
			}
		} catch {}
	}
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
		if (s.status === "error" || s.status === "terminated") {
			const extra = s.restoreError ? `\n  restoreError: ${s.restoreError}` : "";
			throw new Error(`Session ${id} ${s.status}${extra}`);
		}
		await new Promise(r => setTimeout(r, 1_000));
	}
	throw new Error(`Session ${id} not idle in ${ms}ms`);
}

async function getSession(gw: GW, id: string) { return (await api(gw, `/api/sessions/${id}`)).json(); }

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
function appUrl(gw: GW) { return `${gw.base}/?token=${gw.token}`; }
function sessionUrl(gw: GW, id: string) { return `${gw.base}/?token=${gw.token}#/session/${id}`; }

async function interruptAndSend(page: Page, gw: GW, id: string, text: string, idleTimeoutMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 30_000 });
	const sessInfo = await getSession(gw, id);
	if (sessInfo.status === "streaming") {
		const stopBtn = page.locator('button[title="Stop streaming"]');
		await stopBtn.waitFor({ state: "visible", timeout: 10_000 });
		await stopBtn.click();
		await pollIdle(gw, id, 15_000);
	}
	await page.fill("textarea", text);
	await page.press("textarea", "Enter");
	await page.waitForTimeout(1_500);
	await pollIdle(gw, id, idleTimeoutMs);
	await page.waitForTimeout(2_000);
}

async function browserSend(page: Page, gw: GW, id: string, text: string, idleMs = 120_000) {
	await page.goto(sessionUrl(gw, id));
	await page.waitForSelector("textarea", { timeout: 30_000 });
	try { await page.waitForSelector('[class*="tool"], [class*="Tool"], details, pre', { timeout: 8_000 }); } catch {}
	await page.waitForTimeout(500);
	await page.fill("textarea", text);
	await page.press("textarea", "Enter");
	await page.waitForTimeout(1_500);
	await pollIdle(gw, id, idleMs);
	await page.waitForTimeout(2_000);
}

async function takeScreenshot(page: Page, name: string) {
	if (!WANT_SCREENSHOTS) return;
	mkdirSync(RESULTS_DIR, { recursive: true });
	await page.screenshot({ path: join(RESULTS_DIR, name), fullPage: true });
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
	writeFileSync(join(dir, "README.md"), "# Test project\n");
	writeFileSync(join(dir, "package.json"), JSON.stringify({
		name: "test-project", version: "1.0.0",
		scripts: { check: "echo ok", "test:unit": "echo ok" },
	}, null, 2));
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
	try {
		const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: PROJECT_ROOT, encoding: "utf-8", timeout: 5_000 }).trim();
		execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir, stdio: "ignore" });
	} catch {}
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
	try {
		const ids = execFileSync("docker", [
			"ps", "-aq", "--filter", "label=bobbit-project",
		], { encoding: "utf-8", timeout: 10_000 }).trim();
		if (!ids) return;
		for (const id of ids.split(/\s+/).filter(Boolean)) {
			try {
				const binds = execFileSync("docker", [
					"inspect", "--format", "{{json .HostConfig.Binds}}", id,
				], { encoding: "utf-8", timeout: 5_000 }).trim();
				if (/\.bobbit-manual|\.e2e-resilience/.test(binds)) {
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

// ---------------------------------------------------------------------------
// Test-specific helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh sandboxed session and wait for it to be idle.
 * Returns the session id.
 */
async function createFreshSession(gw: GW): Promise<string> {
	const res = await api(gw, "/api/sessions", {
		method: "POST",
		body: JSON.stringify({ worktree: true, sandboxed: true }),
	});
	expect(res.status).toBe(201);
	const id = ((await res.json()) as any).id;
	await pollIdle(gw, id, 180_000);
	return id;
}

/**
 * Count rendered tool-call cards whose tool name matches `name` AND whose
 * innerText contains every supplied substring.
 *
 * Tool cards in the UI are wrapped by `src/ui/components/Messages.ts` with
 * `<div data-tool-name="<name>" class="... bg-card ...">`. The marker is
 * authoritative — substring matching alone (the previous helper) can be
 * fooled by a substitute tool whose body happens to mention the same
 * filename/sentinel, which is exactly the regression that motivated this
 * spec rewrite.
 *
 * Uses `textContent` (not `innerText`) so collapsed renderers (e.g. the
 * bash card, which renders with `max-h-0 overflow-hidden` after the
 * command finishes — see `src/ui/tools/renderers/BashRenderer.ts`) are
 * still matched. `innerText` excludes hidden content but the header's
 * `summarizeCommand` summary keeps it non-empty, so the `|| textContent`
 * fallback never fires. We want content-based matching, not
 * visibility-based — intent is "did this tool card carry this string".
 */
async function countToolCardsByName(page: Page, name: string, ...substrings: string[]): Promise<number> {
	return page.evaluate(({ name, substrings }: { name: string; substrings: string[] }) => {
		const cards = Array.from(document.querySelectorAll<HTMLElement>(`div[data-tool-name="${name}"]`));
		return cards.filter(c => {
			const t = c.textContent || "";
			return substrings.every(s => t.includes(s));
		}).length;
	}, { name, substrings });
}

/**
 * Assert no tool card OTHER than `exceptName` matches every supplied
 * substring. This is the negative half of the regression net: if `bash` is
 * stripped from allowlist and the LLM substitutes `write`/`read` to
 * achieve the same effect, those substitute cards still mention the same
 * filenames and sentinels — without this assertion the positive
 * substring check alone would pass on a broken pi.
 *
 * Choose substrings that uniquely identify the target invocation, not
 * setup/cross-check operations on the same artefacts (otherwise this will
 * flag legitimate setup-bash cards as offenders).
 */
async function assertNoOtherToolCards(page: Page, exceptName: string, ...substrings: string[]): Promise<void> {
	const offenders = await page.evaluate(({ exceptName, substrings }: { exceptName: string; substrings: string[] }) => {
		const cards = Array.from(document.querySelectorAll<HTMLElement>("div[data-tool-name]"));
		return cards
			.filter(c => c.getAttribute("data-tool-name") !== exceptName)
			.filter(c => {
				// textContent (not innerText) — see countToolCardsByName for rationale.
				const t = c.textContent || "";
				return substrings.every(s => t.includes(s));
			})
			.map(c => c.getAttribute("data-tool-name") || "<unknown>");
	}, { exceptName, substrings });
	expect(
		offenders,
		`expected only ${exceptName} for substrings [${substrings.join(", ")}], also saw: ${offenders.join(", ")}`,
	).toHaveLength(0);
}

// ===================================================================
// Test suite
// ===================================================================
test.describe.serial("Agent tool use", () => {
	test.setTimeout(420_000); // 7 minutes per individual test — covers cold-start LLM latency.
		// (Headline budget for the spec as a whole is ~5 min when warm; this ceiling
		// just absorbs first-test cold-start variability without introducing flakes.)
	test.skip(!HAS_DOCKER, "requires Docker — sandboxed sessions only");

	let gw: GW;
	let dir: string;
	let port: number;
	let sandboxAvailable = false;

	test.beforeAll(async ({}, ti) => {
		ti.setTimeout(180_000);
		port = await freePort();
		const tmp = process.platform === "win32" ? (process.env.TEMP || "C:\\Temp") : "/tmp";
		dir = join(tmp, `.bobbit-manual-${port}`);
		rmSync(dir, { recursive: true, force: true });
		initRepo(dir);

		mkdirSync(join(dir, ".bobbit", "config"), { recursive: true });
		mkdirSync(join(dir, ".bobbit", "state"), { recursive: true });
		const yaml = [
			'worktree_pool_size: "6"',
			'sandbox: "docker"',
		].join("\n") + "\n";
		writeFileSync(join(dir, ".bobbit", "config", "project.yaml"), yaml);
		writeFileSync(join(dir, ".bobbit", "state", "projects.json"), "[]");

		// Register a `playwright` MCP server so scenario 7 (mcp_describe) has
		// something to describe. mcp_describe queries the gateway's MCP
		// manager; the manager need only know the server is configured to
		// produce a tools-list response — even if the server fails to start
		// (e.g. npx cold-start), the rendered tool card still carries the
		// `playwright` argument substring which is what the assertion checks.
		writeFileSync(
			join(dir, ".bobbit", "config", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					playwright: {
						command: "npx",
						args: ["@playwright/mcp@latest", "--headless", "--isolated"],
					},
				},
			}, null, 2),
		);

		gw = await startGW(dir, port);
		console.log(`  Gateway :${port}  cwd=${dir}`);

		const regRes = await api(gw, "/api/projects", {
			method: "POST",
			body: JSON.stringify(projectRegistrationBody("default", dir, { upsert: true })),
		});
		if (regRes.status !== 201 && regRes.status !== 200) {
			throw new Error(`Failed to register default project: ${regRes.status}`);
		}
		gw.defaultProjectId = (await regRes.json()).id;

		// Wait for sandbox to be available
		const ss0 = await (await api(gw, "/api/sandbox-status")).json();
		sandboxAvailable = ss0.configured && ss0.available;
		if (ss0.configured && !ss0.available) {
			const deadline = Date.now() + 180_000;
			while (Date.now() < deadline) {
				const r = await (await api(gw, "/api/sandbox-status")).json();
				if (r.available) { sandboxAvailable = true; break; }
				await new Promise(r => setTimeout(r, 3_000));
			}
		}
		console.log(`  Sandbox available: ${sandboxAvailable}`);
		if (!sandboxAvailable) throw new Error("Sandbox unavailable — sandboxed sessions are required by this spec");
	});

	test.afterAll(async ({}, ti) => {
		ti.setTimeout(120_000);
		if (gw) await stopGW(gw);
		cleanTestDockerContainers();
		cleanDirs(dir);
	});

	// ---------------------------------------------------------------
	// 1. Builtin shell — bash
	// ---------------------------------------------------------------
	test("1. bash tool — echo to marker.txt", async ({ page }) => {
		const id = await createFreshSession(gw);
		const nonce = Math.random().toString(36).slice(2, 10).toUpperCase();
		const sentinel = `HELLO_${nonce}`;

		await browserSend(page, gw, id,
			`Run the bash tool exactly once with the command: echo ${sentinel} > marker.txt && cat marker.txt`,
			240_000);
		await takeScreenshot(page, `tooluse-1-bash-${nonce}.png`);

		// Positive: bash card with the command text + sentinel.
		const bashCardCount = await countToolCardsByName(page, "bash", "marker.txt", sentinel);
		expect(bashCardCount, "expected bash tool card with marker.txt + sentinel").toBeGreaterThan(0);

		// Negative: no OTHER tool (write/read/edit/...) achieved the same effect.
		// This is the regression net — if `bash` is stripped from allowlist the
		// LLM substitutes write+read, those cards mention marker.txt + sentinel
		// too, and the prior substring-only check passed on the broken pi.
		await assertNoOtherToolCards(page, "bash", "marker.txt", sentinel);

		// Full transcript text contains the sentinel (from the cat'd output)
		const body = await page.locator("body").innerText();
		expect(body).toContain(sentinel);
	});

	// ---------------------------------------------------------------
	// 2. Filesystem builtin — edit
	// ---------------------------------------------------------------
	test("2. edit tool — exact-text replace", async ({ page }) => {
		const id = await createFreshSession(gw);

		// Setup: create target.txt with content "before" via the bash tool.
		// We do this in a separate user turn so the second prompt is solely
		// about exercising the edit tool.
		await browserSend(page, gw, id,
			`Use the bash tool to run: printf 'before' > target.txt && cat target.txt`,
			240_000);

		// Exercise: invoke the edit tool by name with explicit parameters.
		await browserSend(page, gw, id,
			`Use the "edit" tool with these exact parameters: path="target.txt", oldText="before", newText="after". Do not use any other tool. After the edit succeeds, reply with the single word DONE on its own line.`,
			240_000);
		await takeScreenshot(page, "tooluse-2-edit.png");

		// Positive: edit card carrying target.txt + both old/new payloads.
		// The combined substrings (target.txt + before + after) uniquely
		// identify the edit invocation — the setup bash card has
		// (target.txt, before) but not "after" yet.
		const editCardCount = await countToolCardsByName(page, "edit", "target.txt", "before", "after");
		expect(editCardCount, "expected edit tool card with target.txt + before/after payload").toBeGreaterThan(0);

		// Negative: no other tool (write/bash via sed/etc.) produced a card
		// with the same triple. ASSERT BEFORE the cross-check bash turn so the
		// cross-check bash (which prints "after") doesn't pollute the check.
		await assertNoOtherToolCards(page, "edit", "target.txt", "before", "after");

		// Assistant final message contains DONE
		const body = await page.locator("body").innerText();
		expect(body).toContain("DONE");

		// Cross-check: a subsequent cat should show "after". Use bash to peek
		// inside the container — this gives us a filesystem-level assertion
		// even though we can't reach into the container directly from the host.
		await browserSend(page, gw, id,
			`Use the bash tool to run: cat target.txt`,
			240_000);
		const body2 = await page.locator("body").innerText();
		expect(body2).toContain("after");
	});

	// ---------------------------------------------------------------
	// 3. Filesystem builtin — find
	// ---------------------------------------------------------------
	test("3. find tool — glob pattern", async ({ page }) => {
		const id = await createFreshSession(gw);
		const nonce = Math.random().toString(36).slice(2, 10).toLowerCase();

		// Setup: create three sentinel files under findme/
		await browserSend(page, gw, id,
			`Use the bash tool to run: mkdir -p findme && touch findme/a_${nonce}.txt findme/b_${nonce}.txt findme/c_${nonce}.txt && ls findme`,
			240_000);

		// Exercise: invoke find by name with explicit args
		await browserSend(page, gw, id,
			`Use the "find" tool with these exact parameters: pattern="*_${nonce}.txt", path="findme". After it returns, reply with a single line: COUNT=<n> where <n> is the number of files found by the tool.`,
			240_000);
		await takeScreenshot(page, `tooluse-3-find-${nonce}.png`);

		// Positive: find card with the glob pattern. The asterisk-prefixed
		// pattern `*_<nonce>` only appears in the find tool's arguments —
		// the setup bash card uses literal paths `findme/a_<nonce>.txt` etc.
		const findCardCount = await countToolCardsByName(page, "find", "findme", `*_${nonce}`);
		expect(findCardCount, "expected find tool card with glob pattern").toBeGreaterThan(0);

		// Negative: no other tool produced a card with the glob pattern.
		await assertNoOtherToolCards(page, "find", "findme", `*_${nonce}`);

		// Assistant final message contains COUNT=3
		const body = await page.locator("body").innerText();
		expect(body).toContain("COUNT=3");
	});

	// ---------------------------------------------------------------
	// 4. Steering / interrupt mid tool-use
	// ---------------------------------------------------------------
	test("4. interrupt mid tool-use — pivot", async ({ page }) => {
		const id = await createFreshSession(gw);

		// Kick off a long-running bash command. Use a portable node one-liner
		// to avoid POSIX/Windows shell quoting traps inside the prompt.
		await page.goto(sessionUrl(gw, id));
		await page.waitForSelector("textarea", { timeout: 30_000 });
		await page.waitForTimeout(500);
		// Unique sentinel so the negative tool-name check can target ONLY the
		// long-running bash invocation (not any prior or later card).
		const loopTag = `LOOPTAG_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
		const longPrompt =
			`Use the bash tool exactly once to run this command (do not modify it):\n` +
			`bash -c 'node -e "let i=0;setInterval(()=>{require(\\"fs\\").writeFileSync(\\"step.txt\\",String(++i));console.log(\\"${loopTag}\\",i)},1000)"'\n` +
			`Do not reply or summarise until the command finishes.`;
		await page.fill("textarea", longPrompt);
		await page.press("textarea", "Enter");

		// Wait until the bash tool card with our loop sentinel actually appears
		// in the DOM. `streaming` status alone is not sufficient — the agent
		// could be generating text without ever calling bash, which is the
		// regression mode we want to detect HERE (loudly, before the pivot)
		// rather than 90s later as an opaque "expected card, got 0".
		const toolDeadline = Date.now() + 90_000;
		let sawBashCard = false;
		while (Date.now() < toolDeadline) {
			const found = await page.evaluate((tag: string) => {
				return Array.from(document.querySelectorAll<HTMLElement>('div[data-tool-name="bash"]'))
					.some(c => (c.textContent || "").includes(tag));
			}, loopTag);
			if (found) { sawBashCard = true; break; }
			await new Promise(r => setTimeout(r, 500));
		}
		if (!sawBashCard) {
			// Diagnostic: dump current session status + every tool card so we
			// can tell whether the agent (a) invoked nothing, (b) invoked the
			// wrong tool, or (c) invoked bash with a modified command that
			// stripped the loopTag.
			const s = await getSession(gw, id);
			const cards = await page.evaluate(() => {
				return Array.from(document.querySelectorAll<HTMLElement>("div[data-tool-name]"))
					.map(c => ({
						name: c.getAttribute("data-tool-name") || "?",
						text: (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
					}));
			});
			console.log(`[tooluse-4] pre-interrupt: status=${s.status} loopTag=${loopTag} cards=${cards.length}`);
			for (const c of cards) console.log(`  [${c.name}] ${c.text}`);
		}
		expect(sawBashCard, "agent never invoked bash with the loop sentinel within 90s — prompt-following or tool-activation broken").toBe(true);

		// Pivot via the stop-and-resend flow.
		await interruptAndSend(page, gw, id,
			`Forget that previous command. Reply with the literal token PIVOT_ACK on its own line and nothing else.`,
			240_000);
		await takeScreenshot(page, "tooluse-4-interrupt.png");

		// Positive: bash card carrying the loop sentinel.
		const bashCardCount = await countToolCardsByName(page, "bash", loopTag);
		if (bashCardCount === 0) {
			// Diagnostic: dump every tool card on the page so we can see whether
			// the agent invoked bash with a modified command, substituted a
			// different tool, or never invoked anything at all.
			const cards = await page.evaluate(() => {
				const out: { name: string; text: string }[] = [];
				for (const c of Array.from(document.querySelectorAll<HTMLElement>("div[data-tool-name]"))) {
					out.push({
						name: c.getAttribute("data-tool-name") || "?",
						text: (c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
					});
				}
				return out;
			});
			console.log(`[tooluse-4] loopTag=${loopTag} cards=${cards.length}`);
			for (const c of cards) console.log(`  [${c.name}] ${c.text}`);
		}
		expect(bashCardCount, "expected bash tool card with long-running loop sentinel").toBeGreaterThan(0);

		// Negative: no other tool was substituted for the bash invocation
		// (substitute attempt would render `loopTag` in its card body).
		await assertNoOtherToolCards(page, "bash", loopTag);

		// PIVOT_ACK must appear in the page text — proof the agent honoured
		// the pivot rather than continuing the previous tool call.
		const body = await page.locator("body").innerText();
		expect(body).toContain("PIVOT_ACK");
	});

	// ---------------------------------------------------------------
	// 5. Tool error path — edit a missing file
	// ---------------------------------------------------------------
	test("5. edit error — missing file surfaces error", async ({ page }) => {
		const id = await createFreshSession(gw);
		const nonce = Math.random().toString(36).slice(2, 10).toLowerCase();

		await browserSend(page, gw, id,
			`Use the "edit" tool with these exact parameters: path="nonexistent_${nonce}.txt", oldText="x", newText="y". After the tool returns an error, do NOT retry. Reply with a single line starting EDIT_FAILED: followed by a short reason describing the error.`,
			240_000);
		await takeScreenshot(page, `tooluse-5-edit-error-${nonce}.png`);

		// Session must remain healthy — not crashed.
		const info = await getSession(gw, id);
		expect(info.status).toBe("idle");

		// Positive: edit card referencing the bogus path.
		const editCardCount = await countToolCardsByName(page, "edit", `nonexistent_${nonce}.txt`);
		expect(editCardCount, "expected edit tool card with nonexistent path").toBeGreaterThan(0);

		// Negative: no other tool invented a card referencing the bogus path.
		await assertNoOtherToolCards(page, "edit", `nonexistent_${nonce}.txt`);

		// Assistant final message includes EDIT_FAILED:
		const body = await page.locator("body").innerText();
		expect(body).toContain("EDIT_FAILED:");

		// Edit tool body contains some evidence of failure. The exact wording
		// is produced by Bobbit's tool harness; accept a small set of variants.
		const bodyLower = body.toLowerCase();
		const failureEvidence = [
			"enoent",
			"no such file",
			"not found",
			"does not exist",
			"could not find",
		];
		const sawFailure = failureEvidence.some(e => bodyLower.includes(e));
		expect(sawFailure, `expected one of ${failureEvidence.join(", ")} in transcript`).toBe(true);
	});

	// ---------------------------------------------------------------
	// 6. Bobbit extension tool — web_fetch (non-pi-builtin)
	// ---------------------------------------------------------------
	test("6. web_fetch tool — fetch gateway /api/health", async ({ page }) => {
		const id = await createFreshSession(gw);
		const nonce = Math.random().toString(36).slice(2, 10).toUpperCase();
		const sentinel = `HEALTH_OK_${nonce}`;

		// Sandboxed containers reach the host gateway via host.docker.internal
		// (added unconditionally by docker-args.ts); the test gateway binds
		// 0.0.0.0 (see startGW) so the host port is exposed to the container's
		// network. /api/health is unauthenticated by design.
		const healthUrl = `http://host.docker.internal:${gw.port}/api/health`;

		await browserSend(page, gw, id,
			`Use the "web_fetch" tool with url="${healthUrl}". Do not use bash, curl, or browser_navigate. ` +
			`After the response comes back, reply with a single line: ${sentinel} followed by the value of the "status" field from the JSON response. Example reply: "${sentinel} ok".`,
			240_000);
		await takeScreenshot(page, `tooluse-6-web-fetch-${nonce}.png`);

		// Positive: web_fetch card carrying the gateway URL.
		const webFetchCount = await countToolCardsByName(page, "web_fetch", "/api/health");
		expect(webFetchCount, "expected web_fetch tool card with /api/health URL").toBeGreaterThan(0);

		// Negative: no bash/browser_navigate/etc. substituted for web_fetch.
		await assertNoOtherToolCards(page, "web_fetch", "/api/health");

		// Sentinel reply present.
		const body = await page.locator("body").innerText();
		expect(body).toContain(sentinel);
	});

	// ---------------------------------------------------------------
	// 7. MCP meta-tool — mcp_describe
	// ---------------------------------------------------------------
	test("7. mcp_describe tool — describe playwright MCP server", async ({ page }) => {
		const id = await createFreshSession(gw);
		const nonce = Math.random().toString(36).slice(2, 10).toUpperCase();
		const sentinel = `MCP_OPS_${nonce}`;

		await browserSend(page, gw, id,
			`Use the "mcp_describe" tool with server="playwright" (no operation argument). ` +
			`After it returns, reply with a single line: ${sentinel}=<n> where <n> is your best estimate of the number of operations listed in the response. If the response is an error, reply ${sentinel}=ERROR instead. Do not use any other tool.`,
			240_000);
		await takeScreenshot(page, `tooluse-7-mcp-describe-${nonce}.png`);

		// Positive: mcp_describe card with the server name.
		const mcpCount = await countToolCardsByName(page, "mcp_describe", "playwright");
		expect(mcpCount, "expected mcp_describe tool card with playwright server").toBeGreaterThan(0);

		// Negative: no other tool was substituted to describe the MCP server.
		await assertNoOtherToolCards(page, "mcp_describe", "playwright");

		// Sentinel reply present (count or ERROR — either proves the tool
		// was actually called and the agent observed the result).
		const body = await page.locator("body").innerText();
		expect(body).toMatch(new RegExp(`${sentinel}=(\\d+|ERROR)`));
	});
});
