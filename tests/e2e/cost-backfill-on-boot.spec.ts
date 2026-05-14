/**
 * E2E — boot-time legacy cost `goalId` backfill.
 *
 * Pins the design contract from "legacy cost goalId backfill + unattributable
 * surface":
 *
 *   1. After `sessionManager.restoreSessions()` the gateway walks the
 *      project's `session-costs.json`, and for every entry missing `goalId`:
 *        - reads `sessionManager.getPersistedSession(sid)?.goalId ?? .teamGoalId`,
 *        - else reads the session sidecar at the persisted record's
 *          `agentSessionFile` path (`readSessionSidecar` → `teamGoalId`),
 *        - else leaves the entry unstamped.
 *      The stamp is persisted back to disk in-place — idempotent across boots.
 *   2. Entries that still lack a `goalId` after backfill are surfaced by
 *      `GET /api/goals/:goalId/tree-cost` under an `unattributableLegacy`
 *      bucket. The bucket is informational — it MUST NOT roll into the
 *      tree's `totalCostUsd`.
 *
 * Pattern follows tests/e2e/session-recovery.spec.ts — own gateway per test,
 * two boots against the same BOBBIT_DIR. Between boots we seed
 * `session-costs.json` + a sidecar pair so backfill has work to do.
 */
import { test as base, expect } from "@playwright/test";
import {
	existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
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

const E2E_TEMP_ROOT_RAW = existsSync("/.dockerenv")
	? "/tmp"
	: process.platform === "win32"
		? (process.env.BOBBIT_E2E_TMP_ROOT || "C:\\bobbit-e2e")
		: join(tmpdir(), "bobbit-e2e");
mkdirSync(E2E_TEMP_ROOT_RAW, { recursive: true });
const E2E_TEMP_ROOT = (() => {
	try { return realpathSync(E2E_TEMP_ROOT_RAW); } catch { return E2E_TEMP_ROOT_RAW; }
})();

interface StartedGateway {
	port: number;
	baseURL: string;
	bobbitDir: string;
	token: string;
	consoleLogs: string[];
	shutdown: () => Promise<void>;
}

async function bootGateway(bobbitDir: string, opts: { freshDir: boolean }): Promise<StartedGateway> {
	mkdirSync(E2E_TEMP_ROOT, { recursive: true });
	if (opts.freshDir) {
		rmSync(bobbitDir, { recursive: true, force: true });
		mkdirSync(join(bobbitDir, "state"), { recursive: true });
		writeFileSync(join(bobbitDir, "state", "projects.json"), "[]");
		writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");
		writeFileSync(
			join(bobbitDir, "state", "preferences.json"),
			JSON.stringify({ subgoalsEnabled: true }, null, 2),
		);
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

	// Capture console.log output so the test can assert the
	// "[cost-backfill] stamped goalId on N entries; M still unattributable"
	// boot-time summary line specified in the design.
	const consoleLogs: string[] = [];
	const origLog = console.log;
	console.log = (...args: unknown[]) => {
		try { consoleLogs.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); }
		catch { /* best-effort */ }
		origLog.apply(console, args as Parameters<typeof console.log>);
	};

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
		consoleLogs,
		shutdown: async () => {
			console.log = origLog;
			await gw.shutdown();
		},
	};
}

/** Resolve the default project's state dir on disk. */
function projectStateDir(bobbitDir: string): string {
	return join(bobbitDir, ".bobbit", "state");
}

/** Write a v2-shape sessions.json with the supplied PersistedSession-like rows. */
function writeSessionsJson(bobbitDir: string, rows: Array<Record<string, unknown>>): void {
	const stateDir = projectStateDir(bobbitDir);
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(
		join(stateDir, "sessions.json"),
		JSON.stringify({ version: 2, epoch: rows.length, sessions: rows }, null, 2),
		"utf-8",
	);
}

/** Write a `session-costs.json` shaped as `{ [sessionId]: SessionCost }`. */
function writeSessionCosts(bobbitDir: string, costs: Record<string, Record<string, unknown>>): void {
	const stateDir = projectStateDir(bobbitDir);
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "session-costs.json"), JSON.stringify(costs, null, 2), "utf-8");
}

function readSessionCosts(bobbitDir: string): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(join(projectStateDir(bobbitDir), "session-costs.json"), "utf-8"));
}

/** Write a .jsonl + sidecar `.bobbit.json` pair pointing at the given goalId. */
function writeSidecarPair(bobbitDir: string, sessionId: string, teamGoalId: string): string {
	const dir = join(projectStateDir(bobbitDir), "seeded-sessions");
	mkdirSync(dir, { recursive: true });
	const jsonlPath = join(dir, `${sessionId}.jsonl`);
	writeFileSync(jsonlPath, "", "utf-8");
	const sidecarPath = join(dir, `${sessionId}.bobbit.json`);
	writeFileSync(sidecarPath, JSON.stringify({
		version: 1,
		bobbitSessionId: sessionId,
		agentSessionId: `agent-${sessionId}`,
		role: "coder",
		teamGoalId,
		title: `seeded session ${sessionId}`,
		createdAt: Date.now(),
	}, null, 2), "utf-8");
	return jsonlPath;
}

const test = base;
test.describe.configure({ mode: "serial" });

test.describe("cost backfill at gateway boot (E2E)", () => {
	test("stamps mappable legacy entries; unmapped ones surface as unattributableLegacy", async () => {
		const bobbitDir = join(
			E2E_TEMP_ROOT,
			`.e2e-cost-backfill-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);

		// ── Boot 1 — register the default project + create goalA ─────────
		let gw = await bootGateway(bobbitDir, { freshDir: true });
		let goalAId: string;
		try {
			// Find the default project id (auto-assigned).
			const projResp = await fetch(`${gw.baseURL}/api/projects`, {
				headers: { Authorization: `Bearer ${gw.token}` },
			});
			const projects = await projResp.json() as Array<{ id: string; name: string }>;
			const projectId = (projects.find(p => p.name === "default") ?? projects[0])?.id;
			expect(projectId, "default project must exist after boot 1").toBeTruthy();

			// Create goalA. We deliberately bypass the e2e-setup createGoal
			// helper to keep this spec self-contained (no shared harness fixture).
			const cwd = join(tmpdir(), `bobbit-cost-backfill-${gw.port}-${Date.now()}`);
			mkdirSync(cwd, { recursive: true });
			const goalResp = await fetch(`${gw.baseURL}/api/goals`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}` },
				body: JSON.stringify({
					projectId, cwd, worktree: false, title: "Goal A — backfill target",
					spec: "Seed goal for the cost-backfill-on-boot E2E. Acts as the destination goalId that the sidecar mapping points to so the backfill helper can resolve s-side onto goalA.",
				}),
			});
			expect(goalResp.status, `POST /api/goals: ${await goalResp.clone().text()}`).toBe(201);
			goalAId = (await goalResp.json()).id as string;
		} finally {
			await gw.shutdown();
		}

		// ── Between boots — seed the cost+sidecar state ──────────────────
		// Two unstamped cost entries:
		//   * s-side  — has a persisted session record pointing at a sidecar
		//               whose `teamGoalId === goalAId`. Helper must use the
		//               sidecar fallback (record has no goalId/teamGoalId).
		//   * s-ghost — no record anywhere. Stays unattributable.
		const sideJsonl = writeSidecarPair(bobbitDir, "s-side", goalAId!);

		// PersistedSession row for s-side. Fields chosen to satisfy the
		// session-store loader without claiming a goal stamp.
		writeSessionsJson(bobbitDir, [
			{
				id: "s-side",
				title: "seeded session (sidecar-mappable)",
				cwd: tmpdir(),
				agentSessionFile: sideJsonl,
				createdAt: Date.now() - 60_000,
				lastActivity: Date.now() - 60_000,
				// Deliberately no goalId / teamGoalId — forces the helper to
				// fall through to the sidecar at agentSessionFile.
			},
		]);

		writeSessionCosts(bobbitDir, {
			"s-side":  { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.012345 },
			"s-ghost": { inputTokens: 200, outputTokens: 75, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.067890 },
		});

		// ── Boot 2 — backfill must run; disk + endpoint must reflect it ──
		gw = await bootGateway(bobbitDir, { freshDir: false });
		try {
			// Disk assertion — s-side stamped, s-ghost untouched.
			const onDisk = readSessionCosts(bobbitDir);
			expect(onDisk["s-side"]?.goalId, `s-side must be stamped with goalA on disk after boot`).toBe(goalAId!);
			expect(onDisk["s-ghost"]?.goalId, `s-ghost must remain unstamped (no recoverable mapping)`).toBeUndefined();

			// Boot-time log line — pinned by the design ("log exactly:
			// `[cost-backfill] stamped goalId on N entries; M still unattributable`").
			const summary = gw.consoleLogs.find((l) => l.includes("[cost-backfill] stamped goalId on "));
			expect(summary, `expected boot log line from cost-backfill helper; got logs:\n${gw.consoleLogs.join("\n")}`).toBeTruthy();
			// Numbers must match: 1 stamped, 1 unattributable.
			expect(summary).toMatch(/stamped goalId on\s+1\s+entries/);
			expect(summary).toMatch(/1\s+still unattributable/);

			// Endpoint assertion — tree-cost surfaces the ghost under
			// `unattributableLegacy`, and the bucket is NOT folded into
			// `totalCostUsd` (which only covers actual subtree goals).
			const tcResp = await fetch(`${gw.baseURL}/api/goals/${goalAId!}/tree-cost`, {
				headers: { Authorization: `Bearer ${gw.token}` },
			});
			expect(tcResp.status, `GET /tree-cost: ${await tcResp.clone().text()}`).toBe(200);
			const tc = await tcResp.json() as {
				rootGoalId: string;
				totalCostUsd: number;
				totalTokensIn: number;
				totalTokensOut: number;
				breakdown: Array<{ goalId: string; costUsd: number; tokensIn: number; tokensOut: number }>;
				unattributableLegacy?: { goalId: string; title: string; costUsd: number; tokensIn: number; tokensOut: number };
			};

			// goalA appears in the breakdown with s-side's cost.
			const goalRow = tc.breakdown.find((r) => r.goalId === goalAId);
			expect(goalRow, "goalA must appear in the rollup breakdown").toBeTruthy();
			expect(goalRow!.costUsd).toBeCloseTo(0.012345, 6);
			expect(goalRow!.tokensIn).toBe(100);
			expect(goalRow!.tokensOut).toBe(50);

			// Unattributable bucket carries the ghost.
			expect(tc.unattributableLegacy, "unattributableLegacy bucket must be present when residual cost exists").toBeTruthy();
			expect(tc.unattributableLegacy!.goalId).toMatch(/^__.+__$/);
			expect(tc.unattributableLegacy!.title).toMatch(/^Unattributable/i);
			expect(tc.unattributableLegacy!.costUsd).toBeCloseTo(0.067890, 6);
			expect(tc.unattributableLegacy!.tokensIn).toBe(200);
			expect(tc.unattributableLegacy!.tokensOut).toBe(75);

			// Crucial — the residual MUST NOT be double-counted into the
			// rollup total. Tree total reflects only the goal subtree.
			expect(tc.totalCostUsd).toBeCloseTo(0.012345, 6);
			expect(tc.totalCostUsd).not.toBeCloseTo(0.012345 + 0.067890, 6);
		} finally {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});

	test("clean store — boot logs zero stamps and emits no unattributableLegacy bucket", async () => {
		const bobbitDir = join(
			E2E_TEMP_ROOT,
			`.e2e-cost-backfill-clean-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);

		let gw = await bootGateway(bobbitDir, { freshDir: true });
		let goalAId: string;
		try {
			const projResp = await fetch(`${gw.baseURL}/api/projects`, { headers: { Authorization: `Bearer ${gw.token}` } });
			const projects = await projResp.json() as Array<{ id: string; name: string }>;
			const projectId = (projects.find(p => p.name === "default") ?? projects[0])?.id;
			const cwd = join(tmpdir(), `bobbit-cost-backfill-clean-${gw.port}-${Date.now()}`);
			mkdirSync(cwd, { recursive: true });
			const goalResp = await fetch(`${gw.baseURL}/api/goals`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${gw.token}` },
				body: JSON.stringify({
					projectId, cwd, worktree: false, title: "Goal A — clean",
					spec: "Seed goal for the clean-store cost-backfill E2E. Verifies idempotent zero-work boots emit no unattributable bucket and a 0/0 summary line.",
				}),
			});
			expect(goalResp.status).toBe(201);
			goalAId = (await goalResp.json()).id as string;
		} finally {
			await gw.shutdown();
		}

		// Second boot — no costs file at all.
		gw = await bootGateway(bobbitDir, { freshDir: false });
		try {
			// If the helper logs a summary, it must report 0/0.
			const summary = gw.consoleLogs.find((l) => l.includes("[cost-backfill] stamped goalId on "));
			if (summary) {
				expect(summary).toMatch(/stamped goalId on\s+0\s+entries/);
				expect(summary).toMatch(/0\s+still unattributable/);
			}

			const tcResp = await fetch(`${gw.baseURL}/api/goals/${goalAId!}/tree-cost`, {
				headers: { Authorization: `Bearer ${gw.token}` },
			});
			expect(tcResp.status).toBe(200);
			const tc = await tcResp.json() as { unattributableLegacy?: unknown; totalCostUsd: number };
			expect(tc.unattributableLegacy, "no residual → bucket must be omitted (or zeroed)").toBeFalsy();
			expect(tc.totalCostUsd).toBe(0);
		} finally {
			await gw.shutdown();
			try { rmSync(bobbitDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	});
});
