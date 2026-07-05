/**
 * API E2E tests for the QA seed script.
 *
 * Verifies that a gateway started with seeded state correctly loads
 * and serves all fixture data via REST APIs.
 *
 * Uses a custom gateway fixture that seeds Headquarters registry state and
 * normal project stores before starting the gateway.
 */
import { test as base, expect } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const MOCK_AGENT = resolve(__dirname, "mock-agent.mjs");
const SEED_SCRIPT = resolve(PROJECT_ROOT, "scripts", "qa-seed", "seed.mjs");

interface SeededGateway {
	port: number;
	baseURL: string;
	headquartersDir: string;
	token: string;
}

/**
 * Custom fixture that seeds split Headquarters and normal project stores
 * BEFORE starting the gateway, so stores load the seeded state on startup.
 */
const test = base.extend<{}, { seededGateway: SeededGateway }>({
	seededGateway: [async ({}, use, workerInfo) => {
		// The seed script expects a normal project workDir. The gateway is started
		// with BOBBIT_DIR = <workDir>/.bobbit/headquarters so ProjectRegistry reads
		// the seeded server registry while project stores load from <workDir>/.bobbit/state.
		const workDir = join(PROJECT_ROOT, `.e2e-inproc-seed-${workerInfo.workerIndex}`);
		const headquartersDir = join(workDir, ".bobbit", "headquarters");

		// Clean slate
		rmSync(workDir, { recursive: true, force: true });

		// Run the seed script BEFORE starting the gateway. Seed expects workDir
		// (the project root); it creates split Headquarters and normal project state.
		const secretsDir = join(workDir, ".bobbit", "secrets");
		execFileSync("node", [SEED_SCRIPT, workDir], {
			stdio: "pipe",
			env: { ...process.env, BOBBIT_DIR: headquartersDir, BOBBIT_PI_DIR: "", BOBBIT_SECRETS_DIR: secretsDir },
		});
		mkdirSync(join(headquartersDir, "state"), { recursive: true });
		writeFileSync(join(headquartersDir, "state", "setup-complete"), "e2e\n");

		// Set env BEFORE importing server modules
		process.env.BOBBIT_DIR = headquartersDir;
		// Isolate live server secrets so they never land in the real OS home dir.
		process.env.BOBBIT_SECRETS_DIR = secretsDir;
		delete process.env.BOBBIT_PI_DIR;
		process.env.NODE_ENV = "test";
		process.env.BOBBIT_SKIP_MCP = "1";
		process.env.BOBBIT_SKIP_NPM_CI = "1";
		process.env.BOBBIT_TEST_NO_PUSH = "1";
		process.env.BOBBIT_TEST_NO_REMOTE = "1";
		process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
		process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
		process.env.BOBBIT_NO_OPEN = "1";

		const { setProjectRoot } = await import("../../dist/server/bobbit-dir.js");
		const { scaffoldBobbitDir } = await import("../../dist/server/scaffold.js");
		const { loadOrCreateToken } = await import("../../dist/server/auth/token.js");
		const { createGateway } = await import("../../dist/server/server.js");

		setProjectRoot(workDir);
		scaffoldBobbitDir(workDir);
		const token = loadOrCreateToken();

		const gw = createGateway({
			host: "127.0.0.1",
			port: 0,
			portExplicit: true,
			authToken: token,
			defaultCwd: workDir,
			forceAuth: true,
			agentCliPath: MOCK_AGENT,
		});

		const port = await gw.start();

		const info: SeededGateway = {
			port,
			baseURL: `http://127.0.0.1:${port}`,
			headquartersDir,
			token,
		};

		await use(info);

		await gw.shutdown();
		try { rmSync(workDir, { recursive: true, force: true }); } catch {}
	}, { scope: "worker", auto: true, timeout: 30_000 }],
});

function headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

async function apiFetch(gw: SeededGateway, path: string): Promise<Response> {
	return fetch(`${gw.baseURL}${path}`, { headers: headers(gw.token) });
}

// ── Tests ───────────────────────────────────────────────────────────

test.describe("QA Seed — API E2E", () => {
	test("GET /api/projects returns Headquarters and the QA Seed normal project", async ({ seededGateway }) => {
		const resp = await apiFetch(seededGateway, "/api/projects");
		expect(resp.status).toBe(200);
		const projects = await resp.json();
		expect(projects.map((p: any) => p.id)).toContain("headquarters");
		const qaProject = projects.find((p: any) => p.id === "qa-seed-proj-0001-0001-0001-000000000001");
		expect(qaProject).toBeTruthy();
		expect(qaProject.name).toBe("QA Seed Project");
		expect(qaProject.rootPath).not.toBe(seededGateway.headquartersDir);
	});

	test("GET /api/sessions?include=archived returns sessions endpoint successfully", async ({ seededGateway }) => {
		// Note: The seeded sessions use old timestamps (Nov 2023) and may get
		// purged by the 7-day archive expiry on startup. We verify the endpoint
		// works and that ANY seeded sessions present are properly archived.
		// The raw state files are validated thoroughly by the unit test.
		const resp = await apiFetch(seededGateway, "/api/sessions?include=archived");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		expect(data.sessions).toBeDefined();
		expect(Array.isArray(data.sessions)).toBe(true);
		// If sessions survived purge, verify they're archived
		const seeded = data.sessions.filter((s: any) => s.id?.startsWith("qa-seed-sess-"));
		for (const s of seeded) {
			expect(s.archived).toBe(true);
		}
	});

	test("GET /api/goals returns 1 goal in in-progress state with workflow", async ({ seededGateway }) => {
		const resp = await apiFetch(seededGateway, "/api/goals");
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const goals = data.goals;
		const seeded = goals.filter((g: any) => g.id?.startsWith("qa-seed-goal-"));
		expect(seeded).toHaveLength(1);
		expect(seeded[0].state).toBe("in-progress");
		expect(seeded[0].workflowId).toBeTruthy();
	});

	test("GET /api/goals/:id/gates returns correct gate statuses", async ({ seededGateway }) => {
		const goalId = "qa-seed-goal-0001-0001-0001-000000000001";
		const resp = await apiFetch(seededGateway, `/api/goals/${goalId}/gates`);
		expect(resp.status).toBe(200);
		const { gates } = await resp.json();

		expect(gates.length).toBeGreaterThanOrEqual(4);
		const byId: Record<string, any> = {};
		for (const g of gates) byId[g.gateId] = g;

		expect(byId["design-doc"].status).toBe("passed");
		expect(byId["implementation"].status).toBe("passed");
		expect(byId["documentation"].status).toBe("pending");
		expect(byId["ready-to-merge"].status).toBe("pending");
	});

	test("GET /api/goals/:id/tasks returns 3 complete tasks", async ({ seededGateway }) => {
		const goalId = "qa-seed-goal-0001-0001-0001-000000000001";
		const resp = await apiFetch(seededGateway, `/api/goals/${goalId}/tasks`);
		expect(resp.status).toBe(200);
		const { tasks } = await resp.json();

		const seeded = tasks.filter((t: any) => t.id?.startsWith("qa-seed-task-"));
		expect(seeded).toHaveLength(3);
		for (const t of seeded) {
			expect(t.state).toBe("complete");
		}
	});

	test("GET /api/goals/:id/team returns team state (post zombie-agent sweep)", async ({ seededGateway }) => {
		const goalId = "qa-seed-goal-0001-0001-0001-000000000001";
		const resp = await apiFetch(seededGateway, `/api/goals/${goalId}/team`);
		expect(resp.status).toBe(200);
		const team = await resp.json();
		// Restart cleanup unregisters stale reviewers and reaps stale workers whose
		// backing sessions are missing/terminated. The QA seed marks all sessions
		// terminated, so no role agents should survive boot cleanup.
		expect(team.agents).toEqual([]);
	});
});
