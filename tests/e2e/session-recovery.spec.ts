/**
 * API E2E tests for sessions persistence crash-safety.
 *
 * Covers two recovery scenarios for `<project>/.bobbit/state/sessions.json`:
 *
 *   1. Happy-path restart — create N sessions, hard-stop the gateway,
 *      re-create against the same state dir, all sessions resurface and
 *      the on-disk file is the v2 `{ version, epoch, sessions[] }` shape
 *      with `epoch >= N`.
 *
 *   2. Corrupted-primary recovery — create N sessions, truncate
 *      `sessions.json` to garbage, restart, all sessions are recovered
 *      from `sessions.json.bak.1` (the rotation written by the previous
 *      `saveNow()` cycle).
 *
 * Pattern follows tests/e2e/aigw-startup-refresh.spec.ts: each test owns
 * its own gateway (so we can shut it down and restart against the same
 * BOBBIT_DIR within a single test). The standard in-process-harness
 * fixture is worker-scoped and not suited for restart cycles.
 */
import { test as base, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Per-worker V8 compile cache (mirrors in-process-harness.ts).
{
	const cacheRoot = process.env.BOBBIT_E2E_V8CACHE_ROOT || join(tmpdir(), "bobbit-e2e-v8cache");
	const workerCacheDir = join(cacheRoot, `w-${process.pid}`);
	try { mkdirSync(workerCacheDir, { recursive: true }); } catch { /* best-effort */ }
	try { module.enableCompileCache?.(workerCacheDir); } catch { /* Node < 22.8 */ }
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");

const E2E_TEMP_ROOT = existsSync("/.dockerenv")
	? "/tmp"
	: process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(realpathSync(tmpdir()), "bobbit-e2e");

interface StartedGateway {
	port: number;
	baseURL: string;
	bobbitDir: string;
	token: string;
	shutdown: () => Promise<void>;
}

/**
 * Boot an in-process gateway anchored at `bobbitDir`. Reusing the same
 * `bobbitDir` across two boots emulates a process restart: the second
 * `SessionStore` instance loads the on-disk file the first one wrote.
 */
async function bootGateway(bobbitDir: string, opts: { freshDir: boolean }): Promise<StartedGateway> {
	mkdirSync(E2E_TEMP_ROOT, { recursive: true });
	if (opts.freshDir) {
		rmSync(bobbitDir, { recursive: true, force: true });
		mkdirSync(join(bobbitDir, "state"), { recursive: true });
		writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
		writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");
	}

	process.env.BOBBIT_DIR = bobbitDir;
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";

	mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });

	const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
	const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
	const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
	const { createGateway } = await import("../../dist/server/server.js");
	const { registerRpcBridgeFactory } = await import("../../dist/server/agent/rpc-bridge.js");
	const { InProcessMockBridge, shouldUseInProcessMock } = await import("./in-process-mock-bridge.mjs");
	registerRpcBridgeFactory((rpcOpts: any) => {
		if (shouldUseInProcessMock(rpcOpts.cliPath)) return new InProcessMockBridge(rpcOpts);
		return null;
	});

	setProjectRoot(bobbitDir);
	scaffoldBobbitDir(bobbitDir);
	const token = loadOrCreateToken();

	const gw = createGateway({
		host: "127.0.0.1",
		port: 0,
		portExplicit: true,
		authToken: token,
		defaultCwd: bobbitDir,
		forceAuth: true,
		agentCliPath: MOCK_AGENT,
	});

	const port = await gw.start();
	writeFileSync(join(bobbitDir, "state", "gateway-url"), `http://127.0.0.1:${port}`, "utf-8");

	const baseURL = `http://127.0.0.1:${port}`;

	if (opts.freshDir) {
		// Register the default project at the bobbitDir, mirroring the in-process
		// harness. The session-store under test lives at
		// `<rootPath>/.bobbit/state/sessions.json`.
		// acceptCanonical:true handles the macOS /var → /private/var tmpdir symlink
		// (bobbitDir lives under tmpdir()). Without it the server rejects with 400
		// symlink_root and the rest of this fixture has nothing to register against.
		const resp = await fetch(`${baseURL}/api/projects`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ name: "default", rootPath: bobbitDir, upsert: true, acceptCanonical: true }),
		});
		if (!resp.ok) {
			throw new Error(`project register failed: ${resp.status} ${await resp.text()}`);
		}
	}

	return {
		port,
		baseURL,
		bobbitDir,
		token,
		shutdown: () => gw.shutdown(),
	};
}

async function listSessionIds(gw: StartedGateway): Promise<string[]> {
	const resp = await fetch(`${gw.baseURL}/api/sessions`, {
		headers: { Authorization: `Bearer ${gw.token}` },
	});
	expect(resp.ok, `GET /api/sessions: ${resp.status}`).toBe(true);
	const data = await resp.json() as { sessions: Array<{ id: string }> };
	return data.sessions.map(s => s.id).sort();
}

async function createNonGitSession(gw: StartedGateway, label: string): Promise<string> {
	const cwd = join(tmpdir(), `bobbit-recovery-${gw.port}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(cwd, { recursive: true });

	// Resolve default projectId from the live registry (the in-process server
	// requires an explicit projectId on POST /api/sessions).
	const projResp = await fetch(`${gw.baseURL}/api/projects`, {
		headers: { Authorization: `Bearer ${gw.token}` },
	});
	const projects = await projResp.json() as Array<{ id: string; name: string }>;
	const projectId = (projects.find(p => p.name === "default") ?? projects[0])?.id;
	expect(projectId, "default project must exist").toBeTruthy();

	const resp = await fetch(`${gw.baseURL}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}` },
		body: JSON.stringify({ cwd, projectId }),
	});
	expect(resp.status, `POST /api/sessions: ${await resp.clone().text()}`).toBe(201);
	const { id } = await resp.json();
	return id;
}

/**
 * Resolve the sessions.json path for the registered "default" project.
 * The in-process harness anchors the project at `bobbitDir` itself, so the
 * project's state dir is `<bobbitDir>/.bobbit/state/`.
 */
function sessionsJsonPath(bobbitDir: string): string {
	return join(bobbitDir, ".bobbit", "state", "sessions.json");
}

function bakPath(bobbitDir: string, n: number): string {
	return `${sessionsJsonPath(bobbitDir)}.bak.${n}`;
}

// Tests run sequentially: they share singleton server.ts module-level state
// across repeated createGateway() calls within this worker.
const test = base;
test.describe.configure({ mode: "serial" });

test.describe("session-store crash-safety (E2E)", () => {
	test("v2 shape on first boot: create 5 sessions, restart, all 5 survive with epoch >= 5", async () => {
		const bobbitDir = join(
			E2E_TEMP_ROOT,
			`.e2e-session-recovery-v2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);

		// ── Boot 1 ───────────────────────────────────────────────────────
		let gw = await bootGateway(bobbitDir, { freshDir: true });
		try {
			const created: string[] = [];
			for (let i = 0; i < 5; i++) {
				created.push(await createNonGitSession(gw, `s${i}`));
			}
			created.sort();

			const before = await listSessionIds(gw);
			// The sidebar listing may include synthesized assistant sessions; we
			// only require that each of our 5 created IDs is present.
			for (const id of created) {
				expect(before).toContain(id);
			}

			// Snapshot the on-disk file. It must be the v2 object shape; epoch
			// must reflect at least the 5 saveNow() calls our puts triggered.
			const sjPath = sessionsJsonPath(bobbitDir);
			expect(existsSync(sjPath), `sessions.json must exist at ${sjPath}`).toBe(true);
			const snapshot = JSON.parse(readFileSync(sjPath, "utf-8"));
			expect(Array.isArray(snapshot), "v2 shape is an object, not an array").toBe(false);
			expect(snapshot.version).toBe(2);
			expect(typeof snapshot.epoch).toBe("number");
			expect(snapshot.epoch).toBeGreaterThanOrEqual(5);
			expect(Array.isArray(snapshot.sessions)).toBe(true);
			const sessionIdsOnDisk = (snapshot.sessions as Array<{ id: string }>).map(s => s.id).sort();
			for (const id of created) {
				expect(sessionIdsOnDisk).toContain(id);
			}

			await gw.shutdown();

			// ── Boot 2 — same state dir ─────────────────────────────────
			gw = await bootGateway(bobbitDir, { freshDir: false });

			const after = await listSessionIds(gw);
			for (const id of created) {
				expect(after, `session ${id} must survive restart`).toContain(id);
			}

			// File still v2; epoch monotonic (non-decreasing).
			const reloaded = JSON.parse(readFileSync(sjPath, "utf-8"));
			expect(reloaded.version).toBe(2);
			expect(reloaded.epoch).toBeGreaterThanOrEqual(snapshot.epoch);
		} finally {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	test("recovery from .bak.1 when sessions.json is corrupted (truncated) before restart", async () => {
		const bobbitDir = join(
			E2E_TEMP_ROOT,
			`.e2e-session-recovery-bak-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);

		// ── Boot 1 ───────────────────────────────────────────────────────
		let gw = await bootGateway(bobbitDir, { freshDir: true });
		try {
			const created: string[] = [];
			// Create at least 3 sessions. Each `put()` triggers a saveNow(),
			// which rotates the previous primary into `.bak.1`. After ≥ 2 saves
			// the .bak chain is populated; after the 3rd we are well past the
			// minimum needed for the recovery path.
			for (let i = 0; i < 3; i++) {
				created.push(await createNonGitSession(gw, `b${i}`));
			}
			created.sort();

			const sjPath = sessionsJsonPath(bobbitDir);
			expect(existsSync(sjPath)).toBe(true);
			const bak1 = bakPath(bobbitDir, 1);
			expect(existsSync(bak1), `.bak.1 must exist after multiple saves: ${bak1}`).toBe(true);

			// .bak.1 must contain a parseable snapshot listing all 3 sessions.
			// (It is a copy of the previous `sessions.json` taken just before
			// the most recent saveNow() rotation, so it should hold N-1 of N
			// sessions OR all N depending on save ordering. To make the test
			// robust against rotation timing, copy the *current* primary into
			// .bak.1 after the last save — this models the real recovery
			// scenario where the primary is fresh and we then corrupt it.)
			const fullSnapshot = readFileSync(sjPath, "utf-8");
			writeFileSync(bak1, fullSnapshot, "utf-8");

			await gw.shutdown();

			// ── Corrupt sessions.json ─────────────────────────────────────
			// Truncate to the first 50 bytes — guaranteed-invalid JSON for the
			// v2 object shape, which forces the loader to fall through to .bak.1.
			expect(statSync(sjPath).size).toBeGreaterThan(50);
			truncateSync(sjPath, 50);
			// Sanity: the truncated file must not parse as JSON.
			let parseFailed = false;
			try { JSON.parse(readFileSync(sjPath, "utf-8")); } catch { parseFailed = true; }
			expect(parseFailed, "truncated sessions.json must be unparseable").toBe(true);

			// ── Boot 2 — same state dir, corrupted primary, healthy .bak.1 ──
			gw = await bootGateway(bobbitDir, { freshDir: false });

			const after = await listSessionIds(gw);
			for (const id of created) {
				expect(after, `session ${id} must be recovered from .bak.1`).toContain(id);
			}
		} finally {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
