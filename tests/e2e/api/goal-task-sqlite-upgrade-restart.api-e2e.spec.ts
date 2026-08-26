import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importBuiltServerModule } from "../_helpers/import-built-server-module.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MOCK_AGENT = resolve(__dirname, "..", "_helpers", "mock-agent.mjs");
const PROJECT_ID = "goal-task-sqlite-upgrade";
const KEEP_GOAL_ID = "legacy-goal-keep";
const ARCHIVE_GOAL_ID = "legacy-goal-archive";
const KEEP_TASK_ID = "legacy-task-keep";
const DELETE_TASK_ID = "legacy-task-delete";

interface GatewayInstance {
	baseURL: string;
	shutdown(): Promise<void>;
}

interface Fixture {
	root: string;
	bobbitDir: string;
	projectRoot: string;
	stateDir: string;
	token: string;
	goalsSource: Buffer;
	tasksSource: Buffer;
	legacyGoals: Array<Record<string, unknown>>;
	legacyTasks: Array<Record<string, unknown>>;
	boot(): Promise<GatewayInstance>;
	cleanup(): Promise<void>;
}

function fixtureRoot(): string {
	const parent = process.env.BOBBIT_E2E_TMP_ROOT
		|| (process.platform === "win32" ? "C:\\bobbit-e2e" : join(tmpdir(), "bobbit-e2e"));
	mkdirSync(parent, { recursive: true });
	const root = join(parent, `goal-task-sqlite-upgrade-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(root, { recursive: true });
	try { return realpathSync(root); } catch { return root; }
}

async function prepareFixture(): Promise<Fixture> {
	const root = fixtureRoot();
	const bobbitDir = join(root, "server");
	const projectRoot = join(root, "project");
	const stateDir = join(projectRoot, ".bobbit", "state");
	const agentDir = join(bobbitDir, "agent");
	const envKeys = [
		"BOBBIT_DIR",
		"BOBBIT_SECRETS_DIR",
		"NODE_ENV",
		"BOBBIT_AGENT_DIR",
		"BOBBIT_SKIP_MCP",
		"BOBBIT_SKIP_NPM_CI",
		"BOBBIT_TEST_NO_PUSH",
		"BOBBIT_TEST_NO_REMOTE",
		"BOBBIT_TEST_NO_EXTERNAL",
		"BOBBIT_E2E",
		"BOBBIT_LLM_REVIEW_SKIP",
		"BOBBIT_NO_OPEN",
		"BOBBIT_SKIP_AIGW_DISCOVERY",
		"BOBBIT_SKIP_TITLE_GEN",
		"BOBBIT_SKIP_WORKTREE_POOL",
	] as const;
	const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]])) as Record<(typeof envKeys)[number], string | undefined>;

	mkdirSync(join(bobbitDir, "state", "session-prompts"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	process.env.BOBBIT_DIR = bobbitDir;
	process.env.BOBBIT_SECRETS_DIR = join(bobbitDir, ".secrets");
	process.env.BOBBIT_AGENT_DIR = agentDir;
	process.env.NODE_ENV = "test";
	process.env.BOBBIT_SKIP_MCP = "1";
	process.env.BOBBIT_SKIP_NPM_CI = "1";
	process.env.BOBBIT_TEST_NO_PUSH = "1";
	process.env.BOBBIT_TEST_NO_REMOTE = "1";
	process.env.BOBBIT_TEST_NO_EXTERNAL = "1";
	process.env.BOBBIT_E2E = "1";
	process.env.BOBBIT_LLM_REVIEW_SKIP = "1";
	process.env.BOBBIT_NO_OPEN = "1";
	process.env.BOBBIT_SKIP_AIGW_DISCOVERY = "1";
	process.env.BOBBIT_SKIP_TITLE_GEN = "1";
	process.env.BOBBIT_SKIP_WORKTREE_POOL = "1";

	const bobbitDirModule = await importBuiltServerModule<typeof import("../../../src/server/bobbit-dir.js")>("../../../dist/server/bobbit-dir.js");
	const previousProjectRoot = bobbitDirModule.getProjectRoot?.();
	const { scaffoldBobbitDir } = await importBuiltServerModule<typeof import("../../../src/server/scaffold.js")>("../../../dist/server/scaffold.js");
	const { loadOrCreateToken } = await importBuiltServerModule<typeof import("../../../src/server/auth/token.js")>("../../../dist/server/auth/token.js");
	const { createGateway } = await importBuiltServerModule<typeof import("../../../src/server/server.js")>("../../../dist/server/server.js");
	const { registerRpcBridgeFactory } = await importBuiltServerModule<typeof import("../../../src/server/agent/rpc-bridge.js")>("../../../dist/server/agent/rpc-bridge.js");
	const { InProcessMockBridge, shouldUseInProcessMock } = await import("../_helpers/in-process-mock-bridge.mjs");

	bobbitDirModule.setProjectRoot(bobbitDir);
	scaffoldBobbitDir(bobbitDir);
	writeFileSync(join(bobbitDir, "state", "setup-complete"), "e2e\n");
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		anthropic: { type: "oauth", expires: Date.now() + 86_400_000 },
	}));

	const { testWorkflows, TEST_DEFAULT_COMPONENT } = await import("../_helpers/seed-workflows.js");
	const projectConfig = JSON.stringify({
		name: "SQLite upgrade fixture",
		components: [TEST_DEFAULT_COMPONENT],
		workflows: testWorkflows(),
	}, null, 2);
	mkdirSync(join(bobbitDir, "config"), { recursive: true });
	mkdirSync(join(projectRoot, ".bobbit", "config"), { recursive: true });
	writeFileSync(join(bobbitDir, "config", "project.yaml"), projectConfig);
	writeFileSync(join(projectRoot, ".bobbit", "config", "project.yaml"), projectConfig);

	writeFileSync(join(bobbitDir, "state", "projects.json"), JSON.stringify([{
		id: PROJECT_ID,
		name: "SQLite upgrade fixture",
		rootPath: projectRoot,
		position: 0,
		createdAt: 1_700_000_000_000,
		colorLight: "#2563eb",
		colorDark: "#60a5fa",
	}], null, 2));
	writeFileSync(join(bobbitDir, "state", "preferences.json"), JSON.stringify({ subgoalsEnabled: true }, null, 2));

	const legacyGoals = [
		{
			id: KEEP_GOAL_ID,
			title: "Legacy goal ✓",
			cwd: projectRoot,
			state: "in-progress",
			spec: "Legacy goal payload retained exactly.",
			createdAt: 1_700_000_000_100,
			updatedAt: 1_700_000_000_200,
			projectId: PROJECT_ID,
			team: false,
			setupStatus: "ready",
			metadata: { source: "legacy-json", unicode: "雪" },
			upgradeExtension: { nested: ["preserve", 7] },
		},
		{
			id: ARCHIVE_GOAL_ID,
			title: "Legacy goal to archive",
			cwd: projectRoot,
			state: "todo",
			spec: "This record proves retired JSON cannot resurrect pre-archive state.",
			createdAt: 1_700_000_000_300,
			updatedAt: 1_700_000_000_400,
			projectId: PROJECT_ID,
			team: false,
			setupStatus: "ready",
		},
	];
	const legacyTasks = [
		{
			id: KEEP_TASK_ID,
			goalId: KEEP_GOAL_ID,
			title: "Legacy task ✓",
			type: "testing",
			state: "todo",
			spec: "Legacy task payload retained exactly.",
			createdAt: 1_700_000_001_100,
			updatedAt: 1_700_000_001_200,
			dependsOn: [],
			upgradeExtension: { unicode: "λ", value: 9 },
		},
		{
			id: DELETE_TASK_ID,
			goalId: ARCHIVE_GOAL_ID,
			title: "Legacy task to delete",
			type: "testing",
			state: "todo",
			createdAt: 1_700_000_001_300,
			updatedAt: 1_700_000_001_400,
		},
	];
	const goalsSource = Buffer.from(JSON.stringify(legacyGoals));
	const tasksSource = Buffer.from(JSON.stringify(legacyTasks));
	writeFileSync(join(stateDir, "goals.json"), goalsSource);
	writeFileSync(join(stateDir, "tasks.json"), tasksSource);
	writeFileSync(join(stateDir, "goals.json.sqlite-retired"), "occupied-goal-backup\n");
	writeFileSync(join(stateDir, "tasks.json.sqlite-retired"), "occupied-task-backup\n");

	registerRpcBridgeFactory((options: any) => {
		if (shouldUseInProcessMock(options.cliPath)) return new InProcessMockBridge(options);
		return null;
	});
	const token = loadOrCreateToken();

	return {
		root,
		bobbitDir,
		projectRoot,
		stateDir,
		token,
		goalsSource,
		tasksSource,
		legacyGoals,
		legacyTasks,
		async boot() {
			const gateway = createGateway({
				host: "127.0.0.1",
				port: 0,
				portExplicit: true,
				authToken: token,
				defaultCwd: bobbitDir,
				forceAuth: true,
				agentCliPath: MOCK_AGENT,
			});
			const port = await gateway.start();
			return {
				baseURL: `http://127.0.0.1:${port}`,
				shutdown: () => gateway.shutdown(),
			};
		},
		async cleanup() {
			for (const key of envKeys) {
				const value = previousEnv[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (previousProjectRoot) bobbitDirModule.setProjectRoot(previousProjectRoot);
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		},
	};
}

async function api(gateway: GatewayInstance, token: string, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${gateway.baseURL}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
}

async function expectJson(gateway: GatewayInstance, token: string, path: string, init: RequestInit = {}, status = 200): Promise<any> {
	const response = await api(gateway, token, path, init);
	const text = await response.text();
	expect(response.status, `${init.method ?? "GET"} ${path}: ${text}`).toBe(status);
	return text ? JSON.parse(text) : undefined;
}

function sqliteRows(file: string, table: "goal_records" | "task_records"): Array<{ id: string; payload: string }> {
	const db = new Database(file, { readonly: true, fileMustExist: true });
	try {
		return db.prepare(`SELECT id, payload FROM ${table} ORDER BY id`).all() as Array<{ id: string; payload: string }>;
	} finally {
		db.close();
	}
}

test.describe.serial("GoalStore and TaskStore SQLite upgrade restart", () => {
	test("migrates legacy JSON, retires it collision-safely, and preserves API mutations across restart", async () => {
		test.setTimeout(120_000);
		const fixture = await prepareFixture();
		let gateway: GatewayInstance | undefined;
		try {
			gateway = await fixture.boot();

			const initialGoals = await expectJson(gateway, fixture.token, `/api/goals?projectId=${PROJECT_ID}`);
			expect(initialGoals.goals.map((goal: any) => goal.id).sort()).toEqual([ARCHIVE_GOAL_ID, KEEP_GOAL_ID].sort());
			expect(await expectJson(gateway, fixture.token, `/api/goals/${KEEP_GOAL_ID}`)).toEqual(fixture.legacyGoals[0]);
			expect(await expectJson(gateway, fixture.token, `/api/goals/${ARCHIVE_GOAL_ID}`)).toEqual(fixture.legacyGoals[1]);
			const keepTasks = await expectJson(gateway, fixture.token, `/api/goals/${KEEP_GOAL_ID}/tasks`);
			const archiveTasks = await expectJson(gateway, fixture.token, `/api/goals/${ARCHIVE_GOAL_ID}/tasks`);
			expect([...keepTasks.tasks, ...archiveTasks.tasks].sort((a: any, b: any) => a.id.localeCompare(b.id)))
				.toEqual([...fixture.legacyTasks].sort((a: any, b: any) => String(a.id).localeCompare(String(b.id))));

			expect(existsSync(join(fixture.stateDir, "goals.sqlite"))).toBe(true);
			expect(existsSync(join(fixture.stateDir, "tasks.sqlite"))).toBe(true);
			expect(existsSync(join(fixture.stateDir, "goals.json"))).toBe(false);
			expect(existsSync(join(fixture.stateDir, "tasks.json"))).toBe(false);
			expect(readFileSync(join(fixture.stateDir, "goals.json.sqlite-retired"), "utf8")).toBe("occupied-goal-backup\n");
			expect(readFileSync(join(fixture.stateDir, "tasks.json.sqlite-retired"), "utf8")).toBe("occupied-task-backup\n");
			expect(readFileSync(join(fixture.stateDir, "goals.json.sqlite-retired.1"))).toEqual(fixture.goalsSource);
			expect(readFileSync(join(fixture.stateDir, "tasks.json.sqlite-retired.1"))).toEqual(fixture.tasksSource);

			await expectJson(gateway, fixture.token, `/api/goals/${KEEP_GOAL_ID}`, {
				method: "PUT",
				body: JSON.stringify({
					title: "Durable goal mutation ✓",
					state: "blocked",
					spec: "Mutated through the supported goal API before restart.",
				}),
			});
			await expectJson(gateway, fixture.token, `/api/tasks/${KEEP_TASK_ID}`, {
				method: "PUT",
				body: JSON.stringify({
					title: "Durable task mutation ✓",
					state: "in-progress",
					spec: "Mutated through the supported task API before restart.",
					resultSummary: "Durable task result.",
				}),
			});
			await expectJson(gateway, fixture.token, `/api/tasks/${DELETE_TASK_ID}`, { method: "DELETE" });
			// Goal DELETE is intentionally an archive API (there is no supported hard-delete
			// route); task DELETE supplies the hard-deletion/no-resurrection assertion while
			// the archived goal proves authoritative SQLite wins over its unarchived backup.
			await expectJson(gateway, fixture.token, `/api/goals/${ARCHIVE_GOAL_ID}?cascade=false`, { method: "DELETE" });

			const beforeRestartGoal = await expectJson(gateway, fixture.token, `/api/goals/${KEEP_GOAL_ID}`);
			const beforeRestartTask = await expectJson(gateway, fixture.token, `/api/tasks/${KEEP_TASK_ID}`);
			const beforeRestartArchived = await expectJson(gateway, fixture.token, `/api/goals/${ARCHIVE_GOAL_ID}`);
			expect(beforeRestartArchived.archived).toBe(true);
			expect((await api(gateway, fixture.token, `/api/tasks/${DELETE_TASK_ID}`)).status).toBe(404);

			await gateway.shutdown();
			gateway = undefined;

			gateway = await fixture.boot();
			const restartedGoals = await expectJson(gateway, fixture.token, `/api/goals?projectId=${PROJECT_ID}`);
			expect(restartedGoals.goals.map((goal: any) => goal.id)).toEqual([KEEP_GOAL_ID]);
			const restartedGoal = await expectJson(gateway, fixture.token, `/api/goals/${KEEP_GOAL_ID}`);
			const restartedTask = await expectJson(gateway, fixture.token, `/api/tasks/${KEEP_TASK_ID}`);
			const restartedArchived = await expectJson(gateway, fixture.token, `/api/goals/${ARCHIVE_GOAL_ID}`);
			expect(restartedGoal).toEqual(beforeRestartGoal);
			expect(restartedTask).toEqual(beforeRestartTask);
			expect(restartedArchived).toEqual(beforeRestartArchived);
			expect(restartedArchived.archived).toBe(true);
			expect((await api(gateway, fixture.token, `/api/tasks/${DELETE_TASK_ID}`)).status).toBe(404);
			const archivedPage = await expectJson(gateway, fixture.token, `/api/goals?archived=true&projectId=${PROJECT_ID}`);
			expect(archivedPage.goals.map((goal: any) => goal.id)).toContain(ARCHIVE_GOAL_ID);

			await gateway.shutdown();
			gateway = undefined;

			// Read authoritative rows only after graceful shutdown has released both native handles.
			const goalRows = sqliteRows(join(fixture.stateDir, "goals.sqlite"), "goal_records");
			const taskRows = sqliteRows(join(fixture.stateDir, "tasks.sqlite"), "task_records");
			expect(goalRows.map(row => row.id)).toEqual([ARCHIVE_GOAL_ID, KEEP_GOAL_ID].sort());
			expect(taskRows.map(row => row.id)).toEqual([KEEP_TASK_ID]);
			for (const row of [...goalRows, ...taskRows]) expect(JSON.parse(row.payload).id).toBe(row.id);
			expect(JSON.parse(goalRows.find(row => row.id === KEEP_GOAL_ID)!.payload)).toEqual(restartedGoal);
			expect(JSON.parse(goalRows.find(row => row.id === ARCHIVE_GOAL_ID)!.payload)).toEqual(restartedArchived);
			expect(JSON.parse(taskRows[0].payload)).toEqual(restartedTask);
		} finally {
			if (gateway) await gateway.shutdown().catch(() => undefined);
			await fixture.cleanup();
		}
	});
});
